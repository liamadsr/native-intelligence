// Harness lockdown (mirrors chat-agent): the work-agent has NO sandbox or
// coding surface — its workspace capability set is the ceiling-filtered
// workspace proxies + request_user_input + finish_work. Sandbox-backed defaults
// (shell, filesystem) are removed STRUCTURALLY with disableTool(), never left to
// prose. eve's ask_question (its park is NOT the request_user_input shape the
// dispatcher classifies — an ask_question park would strand the run) is no
// longer a default at all since eve 0.65: it is an opt-in tool, absent unless a
// tools/ask_question.ts file adds it — so there is deliberately no such file.
//
// WEB IS NOT PART OF THIS LOCKDOWN ANY MORE. web_fetch was disabled here only
// because this agent lacked the SSRF url-guard; the guard now lives in
// lib/url-guard.ts, so web_search/web_fetch are live — see tools/web_search.ts
// and tools/web_fetch.ts.
import { disableTool } from 'eve/tools'

export default disableTool()
