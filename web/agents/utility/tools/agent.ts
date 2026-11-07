// Structural lockdown of eve's built-in root-copy `agent` tool. In eve 0.79 a
// subagent call is a task that holds the turn open until the copy replies
// (the eve 0.66 problem, a result lost to a later turn, is gone), but a
// one-shot generator never delegates. Removed structurally.
import { disableTool } from 'eve/tools'

export default disableTool()
