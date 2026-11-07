import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
import { READ_FILE_INPUT_SCHEMA, READ_FILE_OUTPUT_SCHEMA, readFile } from "./eve.mjs";
export { READ_FILE_INPUT_SCHEMA, READ_FILE_OUTPUT_SCHEMA, readFile as default, readFile };
