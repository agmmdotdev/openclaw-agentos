import { coreEconomyEnvironment } from './core-runtime-profile.mjs';

const args = process.argv.slice(2);
if (!args.length) throw new Error('Usage: node scripts/run-core-economy.mjs [node options] entry.mjs [arguments]');
if (typeof process.execve !== 'function') throw new Error('The economy launcher requires Node with process.execve support');
// Replace the launcher instead of retaining an extra Node host. PID, signals,
// exit status and the caller's process-group ownership remain unchanged.
process.execve(process.execPath, [process.execPath, ...args], coreEconomyEnvironment());
