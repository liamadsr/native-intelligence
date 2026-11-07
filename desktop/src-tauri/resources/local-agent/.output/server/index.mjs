globalThis.__nitro_main__ = import.meta.url;
import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
//#region #eve/instrumentation-entry
await import("./_libs/_38.mjs");
var instrumentation_entry_default = (await import("./_chunks/node-server.mjs")).default;
//#endregion
export { instrumentation_entry_default as default };
