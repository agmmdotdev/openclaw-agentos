import process from 'node:process';
import { TextDecoder } from './text-decoder.mjs';
globalThis.TextDecoder = TextDecoder;
// Node documents 0 when OS-imposed memory constraints cannot be determined.
// This is not the guest V8 heap cap, which is configured separately.
if (typeof process.constrainedMemory !== 'function') process.constrainedMemory = () => 0;
