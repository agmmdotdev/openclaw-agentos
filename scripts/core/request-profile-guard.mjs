// Runs before the core entry. Keep internal V8 flags pinned to the tested host.
export function assertRequestRuntime({ version, platform, arch }) {
  if (version !== 'v24.19.0' || platform !== 'linux' || arch !== 'x64') {
    throw new Error('The request profile requires revalidation outside Node 24.19.0 / Linux x64');
  }
}
assertRequestRuntime(process);
