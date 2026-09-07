import { SdkError, rejectUnknown, type FileOperationOptions, type FileReadOptions } from './contracts.js';

export function checkFileOptions(options: FileOperationOptions, allowed: string[] = []) {
 rejectUnknown(options, ['signal', ...allowed], 'filesystem');
 options.signal?.throwIfAborted();
}

export function readLimit(options: FileReadOptions, ceiling: number) {
 checkFileOptions(options, ['maxBytes']);
 if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)) {
  throw new SdkError('INVALID_OPTION', 'maxBytes must be a non-negative safe integer');
 }
 return Math.min(options.maxBytes ?? ceiling, ceiling);
}
