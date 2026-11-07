/**
 * helper_strong — a quick helper on Claude Sonnet 5.5, the `sonnet` key of
 * the helper roster (HELPER_MODELS in src/lib/ai/models.ts): the declared
 * `helper` (../helper/agent.ts) in every slot but the model and its identity
 * line (lib/helper-models.ts).
 *
 * The `helpers` tool (../../tools/helpers.ts) starts it for a task the main
 * agent sent to `sonnet`, or that the rules sent to Strong when it named no
 * model (code, a repo, a diff, SQL or a stack trace; synthesis across ten or
 * more sources; a cross-document comparison ending in a recommendation; or
 * "use the best model"), within the plan and the person's daily cap
 * (/api/internal/chat/helper-tiers).
 *
 * Every slot mirrors the helper's, each a re-export so they can't drift
 * (lib/__tests__/helper-subagent.test.ts): the root's instructions.md copied
 * byte for byte and its persona (with this model's identity line in place of
 * the thread's: instructions/persona.ts), the helper-role workspace tools, web search
 * and fetch, the same disabled defaults, and the usage gate and meter. NO
 * sandbox, for the same reason as the helper.
 */
import { defineAgent } from 'eve'
import { helperModelFor } from '../../lib/helper-models.js'

export default defineAgent({
  description:
    'Works one self-contained task for the main chat agent on Claude Sonnet 5.5 (coding or complex-analysis work): ' +
    'reads workspace data and the web, may write drafts, and returns its findings as text.',
  tool: false,
  model: helperModelFor('sonnet'),
})
