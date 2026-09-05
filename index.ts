import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createEmbeddedAgentOsDriver } from "./src/embedded-agentos-driver.js";
import { createAgentOsWorkerProvider } from "./src/provider.js";

export default definePluginEntry({
  id: "agentos",
  name: "agentOS Worker Provider",
  description: "Runs OpenClaw worker turns inside isolated Rivet agentOS VMs",
  register(api) {
    const driver = createEmbeddedAgentOsDriver({
      warn: (message) => api.logger.warn(message),
    });
    api.registerWorkerProvider(createAgentOsWorkerProvider({ driver }));
    api.registerService({
      id: "agentos-worker-provider-cleanup",
      start() {},
      async stop() {
        await driver.dispose();
      },
    });
  },
});

export { createEmbeddedAgentOsDriver } from "./src/embedded-agentos-driver.js";
export { createAgentOsWorkerProvider } from "./src/provider.js";
export type { AgentOsDriver } from "./src/types.js";
