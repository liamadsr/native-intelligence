// The research agent has no reason to run shell commands — its work is web
// research (web_search/web_fetch, which stay ENABLED) plus the authored
// save_*/finish tools. Disabling `bash` removes it from the tool surface
// entirely (structural, not advisory). The sibling read_file/write_file files
// disable the rest of eve's sandbox-backed defaults for the same reason: eve
// provisions a working sandbox by default (nothing to author), so those tools
// are live unless disabled — and disabling all of them is also what keeps a
// sandbox from ever being provisioned for this agent.
//
// glob/grep are NOT default tools any more (eve dropped them from the default
// agent set in 0.39.0), so there is deliberately no file at those slugs — adding
// one would opt the tool back IN. The lockdown test asserts their absence.
import { disableTool } from 'eve/tools'

export default disableTool()
