import { z } from "zod";

// zod@4 ships "sideEffects": false, so bundlers tree-shake the classic entry's
// implicit config(en()) locale registration (zod/v4/classic/external.js) and a
// built dist renders every issue as the bare "Invalid input" fallback. Register
// the locale explicitly where the config schemas live; zod stores it on
// globalThis, so one call covers every zod parse in the process.
function installZodDefaultLocale(): void {
  z.config(z.locales.en());
}
installZodDefaultLocale();
