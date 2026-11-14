import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
import { finalizeInstrumentationProviders, seedInstrumentationProviders, shutdownInstrumentationProviders } from "../_libs/eve.mjs";
//#region .eve/builds/mwgvve6z-c3973908-bee4-45b4-9b35-d63fdb838b5a/host/compiled-artifacts-instrumentation.mjs
seedInstrumentationProviders();
finalizeInstrumentationProviders({ serviceName: "chat-agent" });
function installInstrumentationPlugin(nitroApp) {
	nitroApp?.hooks?.hook("close", async () => {
		await shutdownInstrumentationProviders();
	});
}
//#endregion
export { installInstrumentationPlugin };
