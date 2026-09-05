import fs from 'node:fs';
export * from 'node:fs';
export default fs;
export const globSync = (...args) => fs.globSync(...args);
export const writev = (...args) => fs.writev(...args);
function supportMissingEntry(original) {
  return (path, options) => {
    try { return original(path, options); }
    catch (error) { if (options?.throwIfNoEntry === false && error.code === 'ENOENT') return undefined; throw error; }
  };
}
export const statSync = supportMissingEntry(fs.statSync.bind(fs));
export const lstatSync = supportMissingEntry(fs.lstatSync.bind(fs));
fs.statSync = statSync;
fs.lstatSync = lstatSync;
