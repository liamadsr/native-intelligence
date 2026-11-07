// Harness lockdown: the live agent reaches WORKSPACE data only through the
// turn's ceiling-clamped proxies (tools/workspace_tools.ts, ask_user.ts,
// say_to_user.ts → the Next internal tool route). Every sandbox-backed default
// (shell, filesystem) is removed structurally with disableTool(), never left to
// prose instructions — which also means no sandbox is ever provisioned for a
// live turn (a task session that must answer in seconds).
//
// Web is separate: web_search is eve's provider tool (tools/web_search.ts),
// shadowed by a refusal on turns with no web access (eval captures) — see
// tools/workspace_tools.ts. web_fetch is disabled (tools/web_fetch.ts).
import { disableTool } from 'eve/tools'

export default disableTool()
