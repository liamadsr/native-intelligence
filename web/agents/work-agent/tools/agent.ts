// Structural lockdown of eve's built-in root-copy `agent` tool (a default on
// every root session).
//
// In eve 0.79 every subagent call is a task: the call returns a receipt, the
// copy works while the root's turn stays open (`turn.waiting` on tasks), its
// reply arrives as the task's result in that same turn, and its usage counts
// toward the root's session (eve 0.69). The original reason for this lockdown
// (eve 0.66: the result came back in a later task-triggered turn that nothing
// here consumed, so the result and its usage were lost) no longer holds.
//
// Why it stays off: a copy inherits the root's whole tool set, auth and
// sandbox, starts with fresh history, and gets only the brief the model writes.
// A headless run stays one agent so its token budget and tool ceiling stay
// one thing to reason about; restore it only as a deliberate design. Removed
// structurally, never left to prose.
import { disableTool } from 'eve/tools'

export default disableTool()
