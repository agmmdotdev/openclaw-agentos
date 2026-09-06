import { coreMemoryEnvironment } from './core-runtime-profile.mjs';

const args = process.argv.slice(2);
if (!args.length) throw new Error('Usage: node scripts/run-core-memory.mjs [node options] entry.mjs [arguments]');
if (typeof process.execve !== 'function') throw new Error('The memory launcher requires Node with process.execve support');
// Replace the launcher so the memory profile retains no extra Node process.
process.execve(process.execPath, [process.execPath, ...args], coreMemoryEnvironment());
