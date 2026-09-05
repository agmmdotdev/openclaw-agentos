import crypto from 'node:crypto';
export * from 'node:crypto';
export default crypto;

export function hash(algorithm, data, outputEncoding = 'hex') {
  return crypto.createHash(algorithm).update(data).digest(outputEncoding === 'buffer' ? undefined : outputEncoding);
}

// Node's 48-bit rejection-sampling range; avoids modulo bias.
export function randomInt(min, max, callback) {
  if (typeof max === 'function') { callback = max; max = undefined; }
  if (max === undefined) { max = min; min = 0; }
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max <= min || max - min >= 2 ** 48) {
    throw new RangeError('randomInt requires safe integer bounds with 0 < max - min < 2**48');
  }
  if (callback !== undefined && typeof callback !== 'function') throw new TypeError('callback must be a function');
  const range = max - min;
  const limit = 2 ** 48 - (2 ** 48 % range);
  let value;
  do { value = crypto.randomBytes(6).readUIntBE(0, 6); } while (value >= limit);
  value = min + value % range;
  if (callback) { queueMicrotask(() => callback(null, value)); return; }
  return value;
}

// Allows unrelated code to link; certificate operations remain fail-closed.
export class X509Certificate {
  constructor() {
    const error = new Error('X509Certificate is unsupported by this agentOS core profile');
    error.code = 'ERR_AGENTOS_UNSUPPORTED_CAPABILITY';
    throw error;
  }
}
