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

const spawnContext = new AsyncLocalStorage<{ spawn: ProcessSupervisor["spawn"]; active: boolean }>();

/** Keep SDK process routing scoped to this turn and revoke retained async callbacks. */
export async function withProcessSpawn<T>(spawn: ProcessSupervisor["spawn"], run: () => Promise<T>): Promise<T> {
  const context = { spawn, active: true };
  try { return await spawnContext.run(context, run); }
  finally { context.active = false; }
}

/** Return the process-wide supervisor used by runtime code that does not inject one. */
export function getProcessSupervisor(): ProcessSupervisor {
  const supervisor = holder.current ??= createProcessSupervisor();
  const context = spawnContext.getStore();
  if (!context) return supervisor;
  return { ...supervisor, spawn: (...args) => {
    if (!context.active) throw new Error("Core process runtime is closed");
    return context.spawn(...args);
  } };

}

export type { ManagedRun, ProcessSupervisor } from "./types.js";
