/**
 * helper — the main chat's quick in-turn helper (A4 slice 3,
 * docs/plans/always-on-agent.md §4, docs/plans/helpers-spike.md "Fallback").
 *
 * The blocking `helpers` tool (../../tools/helpers.ts) starts 1–4 of these in
 * parallel with `ctx.agent('helper').send(task)`, waits for them (bounded by
 * a deadline), and hands their results back to the main agent in the same
 * turn. `tool: false`: the parent model never sees a `helper` tool, only
 * `helpers`.
 *
 * A declared subagent inherits nothing from the root (eve docs/subagents "The
 * isolation boundary"), so every slot it needs is authored here, each one a
 * re-export of the root's so the two can't drift:
 *   - instructions.md: a byte-identical copy of the root's (a .md can't be
 *     re-exported; lib/__tests__/helper-subagent.test.ts keeps them equal), and
 *     instructions/persona.ts, the conversation's own stable prompt with this
 *     helper's model in its identity line; the helper's role rides its task
 *     message, never extra system text;
 *   - tools/workspace_tools.ts: the root's resolver in the helper role (read
 *     plus drafts only: lib/helper-role.ts), web_search and web_fetch, and
 *     every disable file the root has except `agent` (eve's root-only default:
 *     a helper never has one to disable);
 *   - hooks/usage-meter.ts and hooks/usage-limit-gate.ts: each helper turn is
 *     gated and billed on its own (its own session id), with `helper_of`.
 * Left out on purpose: the person-messages hook (the task text is the main
 * agent's, never the person's words), profile memory, the turn-context and
 * expertise instructions, and ask_user (no one answers a helper).
 *
 * NO sandbox: no `sandbox.ts`, and NEVER `sandbox: 'parent'`. A declared node
 * whose sandbox isn't `parent` makes eve's dispatch skip opening the parent's
 * sandbox (the spike's no-go), and nothing in the helper calls `get()` on its
 * own (its sandbox tools are disabled, its messages are text, it declares no
 * eve skills). The one cost is a sandbox template eve prewarms at build time.
 * lib/__tests__/helpers-spike.test.ts pins both on eve's compiled code.
 *
 * The model is the root's resolver in the helper role (lib/chat-model.ts
 * helperChatModel): the helper roster's `flash` (DeepSeek V4 Flash, thinking
 * off), the default when the main agent names no model and the rules see
 * nothing heavier; on the person's ChatGPT plan, the plan's lighter model.
 * Every other roster model runs in its own declared helper (../helper_*,
 * lib/helpers.ts HELPER_AGENT_BY_MODEL). A static declared subagent may carry
 * a dynamic model; a `defineDynamic` subagent may not, so this stays a plain
 * defineAgent.
 */
import { defineAgent } from 'eve'
import { helperChatModel } from '../../lib/chat-model.js'

export default defineAgent({
  description:
    'Works one self-contained task for the main chat agent on DeepSeek V4 Flash, in parallel with other helpers: ' +
    'reads workspace data and the web, may write drafts, and returns its findings as text.',
  tool: false,
  model: helperChatModel,
})
