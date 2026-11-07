// Structural lockdown of eve's built-in `web_fetch` for the live agent.
//
// The live agent's web surface matches what the cloud route has always given
// it, turn type for turn type: provider-executed `web_search` (Exa, through
// the Gateway) on live AND batch turns when the Gateway is on and the capture
// is not an eval — and NOTHING else. The pre-eve route never had a fetch tool,
// so reading arbitrary URLs heard in a meeting (an unattended batch run
// included) would be new reach. Removed structurally, never left to prose; the
// shared WEB_ACCESS_GUIDANCE ("If a `web_fetch` tool is listed…") stays true
// without it. Restoring it is a product decision, not a port.
import { disableTool } from 'eve/tools'

export default disableTool()
