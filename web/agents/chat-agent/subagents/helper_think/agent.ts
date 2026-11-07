/**
 * helper_think — a quick helper on DeepSeek V4 Flash with thinking on, the `flash-thinking` key of the helper roster
 * (HELPER_MODELS in src/lib/ai/models.ts): the declared `helper`
 * (../helper/agent.ts) in every slot but the model and its identity line
 * (lib/helper-models.ts).
 *
 * The `helpers` tool (../../tools/helpers.ts) starts it for a task the main
 * agent sent to `flash-thinking`.
 *
 * Every slot mirrors the helper's, each a re-export so they can't drift
 * (lib/__tests__/helper-subagent.test.ts): the root's instructions.md copied
 * byte for byte, the conversation's persona with this model's identity line
 * (instructions/persona.ts), the helper-role workspace tools, web search and
 * fetch, the same disabled defaults, and the usage gate and meter. NO
 * sandbox, for the same reason as the helper.
 */
import { defineAgent } from 'eve'
import { helperModelFor } from '../../lib/helper-models.js'

export default defineAgent({
  description:
    'Works one self-contained task for the main chat agent on DeepSeek V4 Flash with thinking on (multi-step research or tool work on a budget): ' +
    'reads workspace data and the web, may write drafts, and returns its findings as text.',
  tool: false,
  model: helperModelFor('flash-thinking'),
})
