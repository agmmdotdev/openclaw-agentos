import { readFileSync } from 'node:fs';

// This environment switch is present in the published 0.2.19 sidecar, but is
// not a stable AgentOsOptions field. Revalidate it before upgrading the pin.
export function coreEconomyEnvironment(base = process.env) {
  const version = JSON.parse(readFileSync(new URL('../node_modules/@rivet-dev/agentos-core/package.json', import.meta.url), 'utf8')).version;
  if (version !== '0.2.19') throw new Error('The economy profile requires revalidation for agentOS ' + version);
  if (process.platform !== 'linux' || !process.report.getReport().header.glibcVersionRuntime) {
    throw new Error('The measured economy profile requires Linux with glibc');
  }
  if (base.AGENTOS_SIDECAR_BIN) throw new Error('The economy profile requires the pinned published sidecar');
  return { ...base, MALLOC_ARENA_MAX: '1', MALLOC_TRIM_THRESHOLD_: '65536',
    MALLOC_MMAP_THRESHOLD_: '65536', AGENTOS_V8_WARM_ISOLATES: '0' };
}
