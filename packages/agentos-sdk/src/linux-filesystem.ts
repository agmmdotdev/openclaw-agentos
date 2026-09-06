import { open, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getSystemErrorName } from 'node:util';
import type { FileApi } from './contracts.js';
import { SdkError, positive, unsupported } from './contracts.js';

const helper = fileURLToPath(new URL('./linux-file-access', import.meta.url));
// A bounded SDK transport for the native file primitive, not a process sandbox.
// No fallback to the ordinary Node filesystem is permitted on this selection.
export class LinuxFileAccess {
  readonly api: FileApi;
  #active = new Map<ChildProcess, Promise<Buffer>>();
  #closed = false;
  #disposal?: Promise<void>;
  private constructor(private root: FileHandle, private maxBytes: number) {
    const readFile: FileApi['readFile'] = path => this.#run('read', path);
    const writeFile: FileApi['writeFile'] = async (path, content) => {
      if (typeof content !== 'string' && !(content instanceof Uint8Array)) throw new SdkError('INVALID_INPUT', 'Expected text or bytes');
      const length = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
      if (length > maxBytes) throw new SdkError('FILE_SIZE_LIMIT', `Write exceeds maxFileBytes=${maxBytes}`);
      await this.#run('write', path, Buffer.from(content));
    };
    const stat: FileApi['stat'] = async path => {
      const s = JSON.parse((await this.#run('stat', path)).toString());
      return { ...s, sizeExact: BigInt(s.sizeExact), inoExact: BigInt(s.inoExact), nlinkExact: BigInt(s.nlinkExact) };
    };
    const supported: Pick<FileApi, 'readFile' | 'writeFile' | 'stat' | 'exists' | 'readFiles' | 'writeFiles'> = {
      readFile, writeFile, stat,
      exists: async path => { try { await stat(path); return true; } catch (e) { if ((e as SdkError).code === 'ENOENT') return false; throw e; } },
      readFiles: async paths => {
        this.#assertOpen();
        if (paths.length > 1024) throw new SdkError('BATCH_LIMIT', 'At most 1024 files per batch');
        let total = 0;
        const result = [];
        for (const path of paths) {
          try {
            const content = await readFile(path);
            if (total + content.byteLength > maxBytes) throw new SdkError('BATCH_SIZE_LIMIT', 'Batch exceeds maxFileBytes');
            total += content.byteLength; result.push({ path, content });
          } catch (e) { result.push({ path, content: null, error: String(e) }); }
        }
        return result;
      },
      writeFiles: async entries => {
        this.#assertOpen();
        if (entries.length > 1024) throw new SdkError('BATCH_LIMIT', 'At most 1024 files per batch');
        const result = [];
        for (const entry of entries) {
          try { await writeFile(entry.path, entry.content); result.push({ path: entry.path, success: true }); }
          catch (e) { result.push({ path: entry.path, success: false, error: String(e) }); }
        }
        return result;
      },
    };
    this.api = new Proxy(supported, { get: (target, key) => {
      if (typeof key !== 'string' || key === 'then') return undefined;
      if (Object.hasOwn(target, key)) return Reflect.get(target, key);
      return () => { this.#assertOpen(); return unsupported(`filesystem.${key} with linux-openat2`); };
    } }) as FileApi;
  }
  static async create(path: string, maxBytes: number) {
    positive(maxBytes, 'maxFileBytes');
    if (maxBytes > 16777216) throw new SdkError('INVALID_OPTION', 'linux-openat2 maxFileBytes must be <=16 MiB');
    const root = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const access = new LinuxFileAccess(root, maxBytes);
    try { await access.api.stat('.'); return access; }
    catch (e) { await access.dispose(); throw e; }
  }
  #assertOpen() { if (this.#closed) throw new SdkError('DISPOSED', 'Filesystem handle is disposed'); }
  #run(operation: 'read' | 'write' | 'stat', path: string, input?: Buffer): Promise<Buffer> {
    try {
      this.#assertOpen();
      if (typeof path !== 'string' || !path || path.includes('\0') || path.startsWith('/')) throw new SdkError('INVALID_PATH', 'linux-openat2 requires a nonempty relative path');
      if (this.#active.size >= 4) throw new SdkError('FILE_OPERATION_LIMIT', 'At most four active native file operations');
    } catch (e) { return Promise.reject(e); }
    const child = spawn(helper, [operation, path, String(this.maxBytes)], { env: {}, stdio: ['pipe', 'pipe', 'pipe', this.root.fd] });
    let complete!: (value: Buffer) => void, reject!: (reason: unknown) => void;
    const done = new Promise<Buffer>((ok, no) => { complete = ok; reject = no; });
    this.#active.set(child, done);
    let failure: Error | undefined, size = 0, errorSize = 0;
    const output: Buffer[] = [], errors: Buffer[] = [];
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop(new SdkError('FILE_OPERATION_TIMEOUT', 'Native file operation exceeded 5 seconds')), 5000);
    child.on('error', e => { failure ??= e; });
    child.stdin!.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE') stop(e); });
    child.stdout!.on('data', (b: Buffer) => {
      size += b.length;
      if (size > (operation === 'stat' ? 4096 : this.maxBytes)) stop(new SdkError('FILE_HELPER_OUTPUT_LIMIT', 'File helper exceeded output bound'));
      else output.push(b);
    });
    child.stderr!.on('data', (b: Buffer) => {
      errorSize += b.length;
      if (errorSize > 4096) stop(new SdkError('FILE_HELPER_OUTPUT_LIMIT', 'File helper exceeded diagnostic bound'));
      else errors.push(b);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer); this.#active.delete(child);
      if (this.#closed) failure ??= new SdkError('DISPOSED', 'Filesystem disposed during operation');
      if (!failure && code !== 0) {
        try {
          const error = JSON.parse(Buffer.concat(errors).toString());
          const name = getSystemErrorName(-error.errno);
          failure = new SdkError(name === 'EFBIG' ? 'FILE_SIZE_LIMIT' : name, `Native file operation failed at ${error.stage}`, error);
        } catch { failure = new SdkError('FILE_HELPER_FAILED', `Native file helper failed (${code ?? signal})`); }
      }
      if (failure) reject(failure); else complete(Buffer.concat(output, size));
    });
    child.stdin!.end(input);
    return done;
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#closed = true;
    this.#disposal = (async () => {
      const jobs = [...this.#active];
      for (const [child] of jobs) child.kill('SIGKILL');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled(jobs.map(([, done]) => done)), new Promise((_, no) => {
          timer = setTimeout(() => no(new SdkError('CLEANUP_TIMEOUT', 'Native file helper did not exit')), 3000);
        })]);
      } finally { clearTimeout(timer); await this.root.close(); }
    })();
    return this.#disposal;
  }
}
