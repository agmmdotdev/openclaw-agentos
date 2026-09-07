import { open, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getSystemErrorName } from 'node:util';
import { resolve, posix } from 'node:path';
import type { NativeFileApi, FileOperationOptions } from './contracts.js';
import { SdkError, positive, rejectUnknown } from './contracts.js';
import { checkFileOptions, readLimit } from './file-options.js';

const helper = fileURLToPath(new URL('./linux-file-access', import.meta.url));
// A bounded SDK transport for the native file primitive, not a process sandbox.
// No fallback to the ordinary Node filesystem is permitted on this selection.
export class LinuxFileAccess {
  readonly api: NativeFileApi;
  #active = new Map<ChildProcess, Promise<Buffer>>();
  #closed = false;
  #disposal?: Promise<void>;
  private constructor(private root: FileHandle, private maxBytes: number, private workspace: string) {
    const readFile: NativeFileApi['readFile'] = async (path, options = {}) => this.#run('read', path, undefined, undefined, options, readLimit(options, maxBytes));
    const write = async (path: string, content: string | Uint8Array, options: FileOperationOptions = {}, exclusive = false) => {
      checkFileOptions(options);
      this.#assertOpen();
      if (typeof content !== 'string' && !(content instanceof Uint8Array)) throw new SdkError('INVALID_INPUT', 'Expected text or bytes');
      const length = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
      if (length > maxBytes) throw new SdkError('FILE_SIZE_LIMIT', `Write exceeds maxFileBytes=${maxBytes}`);
      await this.#run(exclusive ? 'write-exclusive' : 'write', path, Buffer.from(content), undefined, options);
    };
    const stat: NativeFileApi['stat'] = async (path, options = {}) => {
      checkFileOptions(options);
      const s = JSON.parse((await this.#run('stat', path, undefined, undefined, options)).toString());
      return { ...s, sizeExact: BigInt(s.sizeExact), inoExact: BigInt(s.inoExact), nlinkExact: BigInt(s.nlinkExact) };
    };
    const entries = async (path: string) => {
      const raw = (await this.#run('list', path)).toString();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      return raw ? raw.trimEnd().split('\n').map(line => {
        const [hex, kind, size] = line.split('\t');
        let name: string;
        try { name = decoder.decode(Buffer.from(hex, 'hex')); }
        catch { throw new SdkError('UNSUPPORTED_FILENAME', 'Directory contains a non-UTF-8 filename'); }
        return { name, isDirectory: kind === 'd', isSymbolicLink: kind === 'l', size: Number(size) };
      }) : [];
    };
    this.api = {
      readFile, writeFile: write, createFileExclusive: (path, content, options) => write(path, content, options, true), stat,
      mkdir: async (path, options = {}) => { checkFileOptions(options, ['recursive']); await this.#run(options.recursive ? 'mkdir-recursive' : 'mkdir', path, undefined, undefined, options); },
      move: async (from, to, options = {}) => { checkFileOptions(options); this.#validatePath(to); await this.#run('move', from, undefined, to, options); },
      remove: async (path, options = {}) => { checkFileOptions(options, ['recursive']); await this.#run(options.recursive ? 'remove-recursive' : 'remove', path, undefined, undefined, options); },
      readdir: async path => (await entries(path)).map(e => e.name),
      readdirEntries: async path => (await entries(path)).map(({ size, ...entry }) => entry),
      readdirRecursive: async (path, options = {}) => {
        rejectUnknown(options, ['maxDepth', 'exclude'], 'readdirRecursive');
        const maxDepth = options.maxDepth ?? 32;
        if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 64) throw new SdkError('INVALID_OPTION', 'maxDepth must be 0..64');
        if (options.exclude && (!Array.isArray(options.exclude) || options.exclude.some(x => typeof x !== 'string'))) throw new SdkError('INVALID_OPTION', 'exclude must contain names');
        const result: Awaited<ReturnType<NativeFileApi['readdirRecursive']>> = [];
        const walk = async (directory: string, depth: number) => {
          for (const entry of await entries(directory)) {
            if (options.exclude?.includes(entry.name)) continue;
            const child = posix.join(directory, entry.name);
            result.push({ path: resolve(this.workspace, child), type: entry.isDirectory ? 'directory' : entry.isSymbolicLink ? 'symlink' : 'file', size: entry.size });
            if (result.length > 10000) throw new SdkError('DIRECTORY_LIMIT', 'At most 10000 entries per walk');
            if (entry.isDirectory && depth < maxDepth) await walk(child, depth + 1);
          }
        };
        await walk(path, 0); return result;
      },
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
          try { await write(entry.path, entry.content); result.push({ path: entry.path, success: true }); }
          catch (e) { result.push({ path: entry.path, success: false, error: String(e) }); }
        }
        return result;
      },
    };
  }
  static async create(path: string, maxBytes: number) {
    positive(maxBytes, 'maxFileBytes');
    if (maxBytes > 16777216) throw new SdkError('INVALID_OPTION', 'linux-openat2 maxFileBytes must be <=16 MiB');
    const root = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const access = new LinuxFileAccess(root, maxBytes, path);
    try { await access.api.stat('.'); return access; }
    catch (e) { await access.dispose(); throw e; }
  }
  #assertOpen() { if (this.#closed) throw new SdkError('DISPOSED', 'Filesystem handle is disposed'); }
  #validatePath(path: string) {
    if (typeof path !== 'string' || !path || path.includes('\0') || path.startsWith('/') || Buffer.from(path).toString() !== path) throw new SdkError('INVALID_PATH', 'linux-openat2 requires a nonempty relative UTF-8 path');
  }
  #run(operation: 'read' | 'write' | 'write-exclusive' | 'stat' | 'list' | 'mkdir' | 'mkdir-recursive' | 'move' | 'remove' | 'remove-recursive', path: string, input?: Buffer, target?: string, options: FileOperationOptions = {}, limit = this.maxBytes): Promise<Buffer> {
    try {
      this.#assertOpen();
      options.signal?.throwIfAborted();
      this.#validatePath(path);
      if (this.#active.size >= 4) throw new SdkError('FILE_OPERATION_LIMIT', 'At most four active native file operations');
    } catch (e) { return Promise.reject(e); }
    const child = spawn(helper, [operation, path, String(limit), ...(target === undefined ? [] : [target])], { env: {}, stdio: ['pipe', 'pipe', 'pipe', this.root.fd] });
    let complete!: (value: Buffer) => void, reject!: (reason: unknown) => void;
    const done = new Promise<Buffer>((ok, no) => { complete = ok; reject = no; });
    this.#active.set(child, done);
    let failure: unknown, size = 0, errorSize = 0;
    const output: Buffer[] = [], errors: Buffer[] = [];
    let stopped = false;
    const stop = (error: unknown) => { if (!stopped) failure = error; stopped = true; child.kill('SIGKILL'); };
    const abort = () => stop(options.signal!.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => stop(new SdkError('FILE_OPERATION_TIMEOUT', 'Native file operation exceeded 5 seconds')), 5000);
    child.on('error', e => { if (!stopped) failure ??= e; });
    child.stdin!.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE') stop(e); });
    child.stdout!.on('data', (b: Buffer) => {
      size += b.length;
      if (size > (operation === 'stat' ? 4096 : operation === 'list' ? 1048576 : limit)) stop(new SdkError('FILE_HELPER_OUTPUT_LIMIT', 'File helper exceeded output bound'));
      else output.push(b);
    });
    child.stderr!.on('data', (b: Buffer) => {
      errorSize += b.length;
      if (errorSize > 4096) stop(new SdkError('FILE_HELPER_OUTPUT_LIMIT', 'File helper exceeded diagnostic bound'));
      else errors.push(b);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort); this.#active.delete(child);
      if (this.#closed && !stopped) failure ??= new SdkError('DISPOSED', 'Filesystem disposed during operation');
      if (!stopped && !failure && code !== 0) {
        try {
          const error = JSON.parse(Buffer.concat(errors).toString());
          const name = getSystemErrorName(-error.errno);
          failure = new SdkError(name === 'EFBIG' ? 'FILE_SIZE_LIMIT' : name, `Native file operation failed at ${error.stage}`, error);
        } catch { failure = new SdkError('FILE_HELPER_FAILED', `Native file helper failed (${code ?? signal})`); }
      }
      if (stopped || failure) reject(failure); else complete(Buffer.concat(output, size));
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
