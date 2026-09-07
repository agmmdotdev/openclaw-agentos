import '../upstream/src/worker/worker-deploy-runtime.js';
import { runWorkerEmbeddedTurn, type RunWorkerEmbeddedTurnParams } from '../upstream/src/worker/embedded-agent.runtime.js';
import { withProcessSpawn, type ProcessSupervisor } from '../upstream/src/process/supervisor/index.js';

export type CoreTurnParams = RunWorkerEmbeddedTurnParams & {
  toolRuntime?: NonNullable<RunWorkerEmbeddedTurnParams['toolRuntime']> & {
    spawn: ProcessSupervisor['spawn'];
  };
};

export function runOpenClawCoreTurn(params: CoreTurnParams): Promise<void> {
  return params.toolRuntime
    ? withProcessSpawn(params.toolRuntime.spawn, () => runWorkerEmbeddedTurn(params))
    : runWorkerEmbeddedTurn(params);
}
