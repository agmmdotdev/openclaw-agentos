import { NativeAgentOs } from './native.js';
import type { LinuxExperimentOptions } from './linux-process-driver.js';
export type { LinuxExperimentOptions };
/** Host acceptance only. This is not a verified production sandbox. */
export const createLinuxExperiment = (options: LinuxExperimentOptions) => NativeAgentOs.createLinuxExperiment(options);
