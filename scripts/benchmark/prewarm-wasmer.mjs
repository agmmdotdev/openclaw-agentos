// Download registry packages outside timed trials. Execution/compilation remains measured.
import { Wasmer } from '@wasmer/sdk/node';
const wasmer = new Wasmer({ parallelism: 2, cache: { directory: process.env.WASMER_CACHE_DIR ?? '/tmp/openclaw-wasmer-cache' } });
try {
  const pkg = await wasmer.packages.load('wasmer/edgejs@0.2.0');
  console.log(`Cached ${pkg.id}; ${pkg.commands.length} commands available`);
} finally { await wasmer.close(); }
