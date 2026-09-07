// Process supervisor barrel exposes the supervised process API.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { ProcessSupervisor } from "./types.js";

const holder = resolveGlobalSingleton(
  Symbol.for("openclaw.processSupervisorHolder"),
  (): { current: ReturnType<typeof createProcessSupervisor> | null } => ({ current: null }),
  async (value) => {
    const supervisor = value.current;
    await supervisor?.shutdown();
    if (value.current === supervisor) {
      value.current = null;
    }
  },
);

const supervisorContext = new AsyncLocalStorage<ProcessSupervisor>();

/** Bind every supervisor operation to one owner and revoke retained turn callbacks. */
export async function withProcessSupervisor<T>(supervisor: ProcessSupervisor, run: () => Promise<T>): Promise<T> {
  let active = true;
  const guard = <Args extends unknown[], Result>(method: (...args: Args) => Result) =>
    (...args: Args): Result => {
      if (!active) throw new Error("Core process runtime is closed");
      return method.apply(supervisor, args);
    };
  const scoped: ProcessSupervisor = {
    spawn: guard(supervisor.spawn),
    cancel: guard(supervisor.cancel),
    cancelScope: guard(supervisor.cancelScope),
    getRecord: guard(supervisor.getRecord),
    ...(supervisor.waitForScope ? { waitForScope: guard(supervisor.waitForScope) } : {}),
  };
  try { return await supervisorContext.run(scoped, run); }
  finally { active = false; }
}

/** Resolve the current turn owner before initializing a host supervisor. */
export function getProcessSupervisor(): ProcessSupervisor {
  return supervisorContext.getStore() ?? (holder.current ??= createProcessSupervisor());
}

export type { ManagedRun, ProcessSupervisor } from "./types.js";
