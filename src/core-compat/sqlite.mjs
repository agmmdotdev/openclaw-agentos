import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function encode(value) {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'bigint') return ['bigint', String(value)];
  if (value instanceof Uint8Array) return ['bytes', Buffer.from(value).toString('base64')];
  if (Array.isArray(value)) return ['array', value.map(encode)];
  if (value && typeof value === 'object') return ['object', Object.entries(value).map(([k, v]) => [k, encode(v)])];
  return ['scalar', value];
}
function decode([kind, value]) {
  if (kind === 'undefined') return undefined;
  if (kind === 'bigint') return BigInt(value);
  if (kind === 'bytes') return Buffer.from(value, 'base64');
  if (kind === 'array') return value.map(decode);
  if (kind === 'object') return Object.fromEntries(value.map(([k, v]) => [k, decode(v)]));
  if (kind === 'scalar') return value;
  throw new Error('Invalid SQLite wire value');
}
function call(request) {
  const result = spawnSync('agentos-core-sqlite', ['call', '--json', JSON.stringify({ payload: JSON.stringify(encode(request)) })], { encoding: 'utf8', timeout: 30000, maxBuffer: 9 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`SQLite binding failed: ${result.stderr || result.error || result.status}`);
  const envelope = JSON.parse(result.stdout);
  if (!envelope.ok) throw new Error('agentOS rejected the SQLite binding request');
  const response = JSON.parse(envelope.result);
  if (!response.ok) { const error = new Error(response.error.message); error.code = response.error.code; throw error; }
  return decode(JSON.parse(response.result));
}
export class DatabaseSync {
  constructor(path, options = {}) {
    if (options.open === false || options.allowExtension) throw new Error('Unsupported SQLite constructor option');
    this.handle = call({ op: 'open', path: path === ':memory:' ? path : resolve(path), options });
    this.isOpen = true;
  }
  exec(sql) { return call({ op: 'exec', handle: this.handle, sql }); }
  get isTransaction() { return call({ op: 'state', handle: this.handle }).isTransaction; }
  close() { call({ op: 'close', handle: this.handle }); this.isOpen = false; }
  prepare(sql) {
    const handle = this.handle;
    const options = {};
    const execute = (method, args) => call({ op: 'statement', handle, sql, method, args, ...options });
    return {
      get: (...args) => execute('get', args), all: (...args) => execute('all', args), run: (...args) => execute('run', args),
      columns: () => execute('columns', []), iterate: (...args) => execute('all', args)[Symbol.iterator](),
      setReadBigInts(value) { options.readBigInts = value; },
      setAllowBareNamedParameters(value) { options.allowBareNamedParameters = value; },
      setAllowUnknownNamedParameters(value) { options.allowUnknownNamedParameters = value; },
    };
  }
}
export default { DatabaseSync };
