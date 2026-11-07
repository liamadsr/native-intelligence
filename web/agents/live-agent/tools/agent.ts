// Structural lockdown of eve's built-in root-copy `agent` tool (a default on
// every root session).
//
// In eve 0.79 a subagent call is a task that holds the root's turn open until
// the copy replies (its usage counts toward the root). The original reason
// (eve 0.66: the result came back in a later turn nothing read) is gone, but a
// live turn must answer in seconds, and the copilot/notes pairing is two
// independent top-level sessions, not subagents (LIVE-AGENT-DESIGN §7).
// Removed structurally, never left to prose.
import { disableTool } from 'eve/tools'

export default disableTool()
