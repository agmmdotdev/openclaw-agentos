// Render hooks are synchronous. The bundled literal require shares the terminal
// module cache with interactive consumers without initializing it for headless tools.
export function getTerminalRuntime(): typeof import("./terminal-rendering.runtime.js") {
  return require("./terminal-rendering.runtime.js");
}
