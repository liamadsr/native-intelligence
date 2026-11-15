import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
import { finalizeInstrumentationProviders, seedInstrumentationProviders, shutdownInstrumentationProviders } from "../_libs/eve.mjs";
//#region .eve/builds/mwgyui7c-d5fdb7ce-d5ce-41aa-b7cb-b4dc7d614468/host/compiled-artifacts-instrumentation.mjs
seedInstrumentationProviders();
finalizeInstrumentationProviders({ serviceName: "chat-agent" });
function installInstrumentationPlugin(nitroApp) {
	nitroApp?.hooks?.hook("close", async () => {
		await shutdownInstrumentationProviders();
	});
}
//#endregion
export { installInstrumentationPlugin };
