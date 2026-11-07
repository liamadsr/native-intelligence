/**
 * web_search — OpenAI's own hosted search, on the person's ChatGPT plan.
 *
 * Every step runs on the plan's search model (../lib/chatgpt-plan-model.ts
 * planSearchStepSelection), a direct model eve reads as OpenAI's, so this
 * slot becomes OpenAI's web search, executed by OpenAI inside the model call:
 * nothing runs here, and nothing is billed to Dial8 (the plan proxy lets the
 * bare tool through, src/lib/chatgpt/plan-request.ts). `native` only says so
 * explicitly: the provider setting applies only to Gateway models, which
 * this agent never runs (both resolvers in ../agent.ts refuse a spec that
 * isn't a plan call for this agent).
 */
import { webSearch } from 'eve/tools/web_search'

export default webSearch({ provider: 'native' })
