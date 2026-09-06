import { coreMemoryEnvironment } from './core-runtime-profile.mjs';

// For the trusted native core / hybrid experiment. This caps the host Node
// young-generation semi-space, not total process RAM or the agentOS guest heap.
const args = process.argv.slice(2);
if (!args.length) throw new Error('Usage: node scripts/run-core-node-memory.mjs [node options] entry.mjs [arguments]');
if (typeof process.execve !== 'function') throw new Error('The Node memory launcher requires process.execve support');
process.execve(process.execPath, [process.execPath, '--max-semi-space-size=8', ...args], coreMemoryEnvironment());
