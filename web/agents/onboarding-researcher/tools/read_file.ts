// Default-harness lockdown: the research agent's work is web research
// (web_search/web_fetch, which stay ENABLED) plus the authored save_*/finish
// tools — it has no sandbox filesystem in its designed surface. `read_file`
// is one of eve's sandbox-backed default tools; disabling it removes it
// structurally (not advisory). Disabling every sandbox-backed tool (bash/
// read_file/write_file) is also what keeps a sandbox from ever being
// provisioned for this agent — eve provisions one by default otherwise.
//
// glob/grep are NOT default tools any more (eve dropped them from the default
// agent set in 0.39.0), so there is deliberately no file at those slugs — adding
// one would opt the tool back IN. The lockdown test asserts their absence.
import { disableTool } from 'eve/tools'

export default disableTool()
