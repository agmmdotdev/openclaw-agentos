const NativeTextDecoder = globalThis.TextDecoder;
const labels = new Set(['latin1', 'iso-8859-1', 'windows-1252', 'ascii', 'us-ascii', 'iso8859-1', 'iso_8859-1:1987', 'l1', 'cp1252']);
const replacements = [0x20ac,0x81,0x201a,0x192,0x201e,0x2026,0x2020,0x2021,0x2c6,0x2030,0x160,0x2039,0x152,0x8d,0x17d,0x8f,0x90,0x2018,0x2019,0x201c,0x201d,0x2022,0x2013,0x2014,0x2dc,0x2122,0x161,0x203a,0x153,0x9d,0x17e,0x178];
// WHATWG latin1/ascii labels mean Windows-1252, unlike Buffer's latin1.
export class TextDecoder {
  constructor(label = 'utf-8', options = {}) {
    this.singleByte = labels.has(String(label).trim().toLowerCase());
    if (!this.singleByte) this.native = new NativeTextDecoder(label, options);
    this.encoding = this.singleByte ? 'windows-1252' : this.native.encoding;
    this.fatal = Boolean(options.fatal);
    this.ignoreBOM = Boolean(options.ignoreBOM);
  }
  decode(input, options) {
    if (this.native) return this.native.decode(input, options);
    if (input === undefined) return '';
    if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) throw new TypeError('Expected a BufferSource');
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    let result = '';
    for (const byte of bytes) result += String.fromCodePoint(byte >= 0x80 && byte <= 0x9f ? replacements[byte - 0x80] : byte);
    return result;
  }
}
