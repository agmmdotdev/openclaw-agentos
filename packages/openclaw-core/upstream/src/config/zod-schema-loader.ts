import "./zod-default-locale.js";

// This source entry is bundled: esbuild turns the literal require into a cached,
// synchronous initializer. A static import would construct the full schema graph
// during every core startup, even when the turn never validates configuration.
export function getOpenClawSchema(): typeof import("./zod-schema.js").OpenClawSchema {
  const schemaModule: typeof import("./zod-schema.js") = require("./zod-schema.js");
  return schemaModule.OpenClawSchema;
}
