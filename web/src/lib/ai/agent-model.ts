/**
 * The model a person's main agent runs on (roadmap #9): one setting, in
 * Settings → Preferences → Assistant beside the agent's name, kept on the
 * account (`user_metadata.agent_model`, written by /api/account/agent-model).
 *
 * Auto, the default (nothing saved), is today's behaviour: the thread runs
 * MAIN_MODEL (Claude Haiku 5.5). A pick replaces MAIN_MODEL on every turn of
 * the person's own main agent, wherever it runs: the web app, the desktop
 * app and the iPhone app (all chat-agent sessions), a Slack or text message,
 * and the server turns, relays and check-ins in their home thread
 * (src/lib/chat/chat-run-rebuild.ts reads it each turn). Nowhere else: a
 * teammate's chat is the teammate's, a guest texting the business runs its
 * own cheap model (src/lib/guests/guest-spec.ts), the device ask (the ESP32
 * hardware) keeps its fixed quick model, a phone call's turns run Auto
 * (someone is on the line, and a strong or thinking model can spend the
 * call's speaking budget alone), and the Mac body runs the relay's model.
 * Helpers keep their own: the main agent still picks each helper's model
 * from HELPER_MODELS.
 *
 * Only models the AI Gateway already serves, priced and run with the chat's
 * tools: the helper roster's (HELPER_MODELS), each a CHAT_MODELS entry with
 * an ai_model_costs row (migrations 345, 439, 245), so usage metering bills
 * a picked model like a helper on it. The roster's strong models are premium
 * here too: paid plans only. On an unpaid plan a saved premium pick runs Auto
 * (agentModelForTurn), and the setting says so; so does every premium pick
 * while the Strong kill switch is on (AUTO_MODEL_ESCALATION=off, a cost
 * incident). Premium helpers' daily cap doesn't apply: it bounds what the
 * agent starts on its own, while this is the person's own choice, which their
 * monthly allowance meters like any other turn. Credits on the default plan
 * don't make a plan paid (check_ai_usage_limit's is_paid_plan), as for
 * premium helpers.
 *
 * On the free tier (the person's own ChatGPT plan) every turn runs the plan's
 * model, never a Gateway one, so there is nothing to pick: the setting is
 * hidden there and a saved pick waits until they're on a Dial8 plan.
 *
 * Client-safe and pure.
 */
import { HELPER_MODELS, MAIN_MODEL, type ChatModelId } from './models'

/** Its key in `user_metadata` and in the setting's GET/PUT. */
export const AGENT_MODEL_FIELD = 'agent_model'

/** What the setting shows for Auto, and what the client and the route send for it. */
export const AUTO_AGENT_MODEL = 'auto'

/** The models a person may pick, strongest first. */
export const AGENT_MODEL_IDS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'deepseek-v4-flash',
] as const satisfies readonly ChatModelId[]

export type AgentModelId = (typeof AGENT_MODEL_IDS)[number]

/** What the setting saves: Auto or a model. */
export type AgentModelChoice = typeof AUTO_AGENT_MODEL | AgentModelId

export interface AgentModelOption {
  id: AgentModelId
  /** Its name for people. */
  label: string
  /** One short line on what it's good for. */
  description: string
  /** Paid plans only (the roster's strong tier). */
  premium: boolean
}

/** People's names for the models the main agent can run, Auto's included. */
const MODEL_NAMES: Record<AgentModelId | typeof MAIN_MODEL, string> = {
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
}

const DESCRIPTIONS: Record<AgentModelId, string> = {
  'claude-opus-5-5': 'The strongest, and the most expensive: it uses your allowance fastest.',
  'claude-sonnet-5-5': 'Strong at code, analysis and long writing.',
  'gpt-5.6-terra': "OpenAI's strong model.",
  'gpt-5.6-luna': "OpenAI's fast, inexpensive model.",
  'deepseek-v4-flash': 'The least expensive. It thinks before it answers, so it is a little slower.',
}

/** The name of the model a choice runs (Auto's is MAIN_MODEL's). */
export function agentModelName(model: AgentModelId | null): string {
  return MODEL_NAMES[model ?? MAIN_MODEL]
}

/** What Auto says it does, under its name. */
export const AUTO_AGENT_MODEL_DESCRIPTION = `${agentModelName(null)}: fast and inexpensive. It hands harder work to a stronger helper.`

/** Whether a model is premium: a strong model in the helper roster. */
export function isPremiumAgentModel(model: AgentModelId): boolean {
  return HELPER_MODELS.some((m) => m.model === model && m.tier === 'strong')
}

/** Every pick, for the setting, in AGENT_MODEL_IDS order. */
export const AGENT_MODEL_OPTIONS: readonly AgentModelOption[] = AGENT_MODEL_IDS.map((id) => ({
  id,
  label: agentModelName(id),
  description: DESCRIPTIONS[id],
  premium: isPremiumAgentModel(id),
}))

/** A saved or sent pick, checked: a model id, or null for Auto (nothing saved, `auto`, or anything else). */
export function parseAgentModel(raw: unknown): AgentModelId | null {
  return typeof raw === 'string' && (AGENT_MODEL_IDS as readonly string[]).includes(raw) ? (raw as AgentModelId) : null
}

/** A value the setting may save: Auto or a model; null when it is neither. */
export function parseAgentModelChoice(raw: unknown): AgentModelChoice | null {
  if (raw === AUTO_AGENT_MODEL) return AUTO_AGENT_MODEL
  return parseAgentModel(raw)
}

/**
 * The model a turn of the person's main agent runs on, from what they saved
 * and whether a premium model may run (a paid plan, and the Strong kill
 * switch off): their pick, or null (Auto, MAIN_MODEL) when they saved none or
 * saved a premium model that may not run.
 */
export function agentModelForTurn(saved: unknown, premiumAllowed: boolean): AgentModelId | null {
  const model = parseAgentModel(saved)
  if (!model) return null
  if (isPremiumAgentModel(model) && !premiumAllowed) return null
  return model
}
