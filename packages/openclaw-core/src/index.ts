import '../upstream/src/worker/worker-deploy-runtime.js';
import { runWorkerEmbeddedTurn, type RunWorkerEmbeddedTurnParams } from '../upstream/src/worker/embedded-agent.runtime.js';
import { withProcessSupervisor, type ProcessSupervisor } from '../upstream/src/process/supervisor/index.js';

export type CoreTurnParams = RunWorkerEmbeddedTurnParams & {
  toolRuntime?: NonNullable<RunWorkerEmbeddedTurnParams['toolRuntime']> & {
    supervisor: ProcessSupervisor;
  };
};

export function runOpenClawCoreTurn(params: CoreTurnParams): Promise<void> {
  return params.toolRuntime
    ? withProcessSupervisor(params.toolRuntime.supervisor, () => runWorkerEmbeddedTurn(params))
    : runWorkerEmbeddedTurn(params);
}
