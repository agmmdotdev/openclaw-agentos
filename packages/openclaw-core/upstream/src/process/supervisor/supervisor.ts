// Default host adapters share the same lifecycle owner as injected SDK adapters.
import { getShellConfig } from "../../agents/shell-utils.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { createChildAdapter } from "./adapters/child.js";
import { createPtyAdapter } from "./adapters/pty.js";
import { createProcessSupervisorWithAdapter } from "./supervisor-runtime.js";
import type { SpawnInput } from "./types.js";

async function createHostProcessAdapter(input: SpawnInput) {
  if (input.mode === "pty") {
    const { shell, args: shellArgs } = getShellConfig();
    const ptyCommand = input.ptyCommand.trim();
    if (!ptyCommand) throw new Error("PTY command cannot be empty");
    return createPtyAdapter({
      shell, args: [...shellArgs, ptyCommand], cwd: input.cwd, env: input.env,
    });
  }
  if (input.mode === "anchored-shell") {
    return createChildAdapter({ anchoredShellCommand: input.command, cwd: input.cwd, env: input.env });
  }
  return createChildAdapter({
    argv: input.argv, cwd: input.cwd, env: input.env, exactEnv: input.exactEnv,
    windowsVerbatimArguments: input.windowsVerbatimArguments, input: input.input,
    stdinMode: input.stdinMode, secretInput: input.secretInput,
  });
}

const loadSupervisorLogRuntime = createLazyRuntimeModule(() => import("./supervisor-log.runtime.js"));

export function createProcessSupervisor() {
  return createProcessSupervisorWithAdapter(createHostProcessAdapter, async (message) => {
    const { warnProcessSupervisorSpawnFailure } = await loadSupervisorLogRuntime();
    warnProcessSupervisorSpawnFailure(message);
  });
}
