// Harness lockdown: a headless skill runner reaches WORKSPACE data only through
// the workspace-tool proxies (tools/workspace_tools.ts → the Next internal tool
// route). The skill's tool ceiling is that whole permitted surface, and every
// sandbox-backed default outside it (shell, filesystem) is removed structurally
// with disableTool(), never left to prose instructions. Disabling all
// sandbox-backed tools also means no sandbox is ever provisioned for these
// sessions.
//
// WEB IS NOT PART OF THIS LOCKDOWN ANY MORE. web_search/web_fetch are on by
// default and sit OUTSIDE the ceiling mechanism (which filters workspace
// proxies, not framework tools) — see tools/web_search.ts and tools/web_fetch.ts.
// The one off switch is spec.webAccess === false (the USE_GATEWAY kill switch):
// tools/workspace_tools.ts then stubs both — pinned by
// lib/__tests__/web-access-gate.test.ts.
import { disableTool } from 'eve/tools'

export default disableTool()
