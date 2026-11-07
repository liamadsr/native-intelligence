// NO web access on the utility agent — unlike every other Dial8 agent. Its
// prompts are built from workspace data (meeting summaries, email threads,
// claims) and its answers are written straight back into the workspace, so a
// fetched page could only ever be an injection vector; no generator here needs
// the web. Removed structurally; the harness-lockdown test pins it.
import { disableTool } from 'eve/tools'

export default disableTool()
