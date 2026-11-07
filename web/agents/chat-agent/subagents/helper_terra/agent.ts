/**
 * helper_terra — a quick helper on OpenAI GPT-5.6 Terra, the `gpt-terra` key of the helper roster
 * (HELPER_MODELS in src/lib/ai/models.ts): the declared `helper`
 * (../helper/agent.ts) in every slot but the model and its identity line
 * (lib/helper-models.ts).
 *
 * The `helpers` tool (../../tools/helpers.ts) starts it for a task the main
 * agent sent to `gpt-terra`, within the plan and the person's daily cap (a premium model:
 * /api/internal/chat/helper-tiers).
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
    'Works one self-contained task for the main chat agent on OpenAI GPT-5.6 Terra (strong analysis or planning from another model family): ' +
    'reads workspace data and the web, may write drafts, and returns its findings as text.',
  tool: false,
  model: helperModelFor('gpt-terra'),
})
