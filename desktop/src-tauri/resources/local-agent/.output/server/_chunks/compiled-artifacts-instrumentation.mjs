import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
import { finalizeInstrumentationProviders, seedInstrumentationProviders, shutdownInstrumentationProviders } from "../_libs/eve.mjs";
//#region .eve/builds/mvkebuhn-8fbec7e3-a915-4d05-86f4-464ed679df92/host/compiled-artifacts-instrumentation.mjs
seedInstrumentationProviders();
finalizeInstrumentationProviders({ serviceName: "chat-agent" });
function installInstrumentationPlugin(nitroApp) {
	nitroApp?.hooks?.hook("close", async () => {
		await shutdownInstrumentationProviders();
	});
}
//#endregion
export { installInstrumentationPlugin };
