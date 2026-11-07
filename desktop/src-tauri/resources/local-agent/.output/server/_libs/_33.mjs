import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
import { BASH_INPUT_SCHEMA, BASH_OUTPUT_SCHEMA, bash } from "./eve.mjs";
export { BASH_INPUT_SCHEMA, BASH_OUTPUT_SCHEMA, bash, bash as default };
