export * from 'node:perf_hooks';
// Never manufacture measurements. Optional OpenClaw monitoring catches this.
export function monitorEventLoopDelay() {
  const error = new Error('Event-loop histogram is unsupported by this agentOS core profile');
  error.code = 'ERR_AGENTOS_UNSUPPORTED_CAPABILITY';
  throw error;
}
