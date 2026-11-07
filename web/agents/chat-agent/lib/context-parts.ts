/**
 * What the chat-agent itself puts in each model call's input, measured per
 * turn: the parts the side panel's Context card shows beside the conversation
 * (src/app/account/(dashboard)/side-panels/context-section.tsx). A model call
 * reports one number, its whole input (step.completed usage.inputTokens);
 * these split out the agent's own share of it:
 *   system   the static instructions (../instructions.md,
 *            STATIC_INSTRUCTIONS_TOKENS) and the persona's system prompt
 *            (../instructions/persona.ts), less
 *   skills   its "Available skills" section
 *   tools    the workspace tools advertised to the turn's latest model call
 *            (../tools/workspace_tools.ts): name, description, input schema;
 *            and the static tools (STATIC_TOOLS_TOKENS)
 *   memory   the profile facts recalled (../memory/profile.ts)
 * The rest of the input (the conversation, the turn context, tool results,
 * eve's own tools and notes) is the conversation's: the app reads it as the
 * remainder (src/lib/chat/context-usage.ts). Each part is an estimate at four
 * characters a token (card-context-size.ts's rule); the total is the
 * provider's.
 *
 * The usage meter (../hooks/usage-meter.ts) adds the turn's parts to its
 * usage report, so they land in the usage row's metadata (`context_parts`).
 *
 * Durable per-session state, as card-context-size.ts: the meter settles at the
 * turn's end, often in another process. The prompt and the tools are keyed by
 * the turn they were measured for, so a figure from an earlier turn is never
 * reported for this one. The memory is the session's latest recall: eve keeps
 * the latest of each recalled record in the history, between turns too.
 * Three states, not one: the resolvers that write them run side by side.
 */
import { defineState } from 'eve/context'

/** The agent's own parts of a turn's context, in tokens. */
export interface ContextParts {
  system: number
  skills: number
  tools: number
  memory: number
}

interface PromptSize {
  turnId: string | null
  system: number
  skills: number
}

interface ToolsSize {
  turnId: string | null
  tokens: number
}

const prompt = defineState<PromptSize>('chat-agent.context-parts.prompt', () => ({ turnId: null, system: 0, skills: 0 }))
const tools = defineState<ToolsSize>('chat-agent.context-parts.tools', () => ({ turnId: null, tokens: 0 }))
const memory = defineState<{ tokens: number }>('chat-agent.context-parts.memory', () => ({ tokens: 0 }))

/**
 * The static instructions (../instructions.md, a system message on every
 * call), in tokens: a measured constant, since the bundle carries no file to
 * read. lib/__tests__/context-parts.test.ts measures the file and holds this
 * within 10% of it: update it when the instructions grow or shrink.
 */
export const STATIC_INSTRUCTIONS_TOKENS = 7_450

/**
 * The static tools' definitions (../tools/*.ts as the cloud has them: ask_user,
 * helpers, mark_urgent, no_reply, update_plan, web_fetch, web_search; the file
 * tools are the Mac's), in tokens, measured and pinned the same way.
 */
export const STATIC_TOOLS_TOKENS = 1_780

/** Tokens in `text`, at four characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** The skills section's heading (src/lib/chat/chat-run-rebuild.ts buildSkillsPromptSection). */
const SKILLS_HEADING = '\n\n## Available skills\n'

/**
 * A system prompt's tokens, its "Available skills" section apart: from the
 * section's heading to the next `## ` heading, or the prompt's end.
 */
export function promptParts(systemPrompt: string): { system: number; skills: number } {
  const start = systemPrompt.indexOf(SKILLS_HEADING)
  if (start < 0) return { system: estimateTokens(systemPrompt), skills: 0 }
  const next = systemPrompt.indexOf('\n\n## ', start + SKILLS_HEADING.length)
  const end = next < 0 ? systemPrompt.length : next
  const skills = estimateTokens(systemPrompt.slice(start, end))
  return { system: estimateTokens(systemPrompt.slice(0, start) + systemPrompt.slice(end)), skills }
}

/**
 * The tokens a set of advertised tools costs the model: each one's name,
 * description and input schema. A schema that is a validator object (a
 * Standard Schema, `~standard`) and not plain JSON is left out.
 */
export function toolDefinitionTokens(entries: Readonly<Record<string, unknown>>): number {
  let chars = 0
  for (const [name, entry] of Object.entries(entries)) {
    chars += name.length
    if (!entry || typeof entry !== 'object') continue
    const { description, inputSchema } = entry as { description?: unknown; inputSchema?: unknown }
    if (typeof description === 'string') chars += description.length
    if (inputSchema && typeof inputSchema === 'object' && !('~standard' in inputSchema)) {
      try {
        chars += JSON.stringify(inputSchema).length
      } catch {
        /* a schema that won't serialize is not counted */
      }
    }
  }
  return Math.ceil(chars / 4)
}

/** Record the system prompt sent for `turnId`. Never throws: a measurement must not break a turn. */
export function recordPromptSize(turnId: string | null, systemPrompt: string): void {
  try {
    const parts = promptParts(systemPrompt)
    prompt.update(() => ({ turnId, ...parts }))
  } catch {
    /* no eve context (a test, a replay without state): nothing to record */
  }
}

/** Record the tools advertised to `turnId`'s latest model call. Never throws. */
export function recordToolsSize(turnId: string | null, tokens: number): void {
  try {
    tools.update(() => ({ turnId, tokens }))
  } catch {
    /* no eve context: nothing to record */
  }
}

/** Record the session's latest memory recall. Never throws. */
export function recordMemorySize(tokens: number): void {
  try {
    memory.update(() => ({ tokens }))
  } catch {
    /* no eve context: nothing to record */
  }
}

/** The tokens a memory recall's messages add. */
export function recallTokens(recall: unknown): number {
  const messages = (recall as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return 0
  let chars = 0
  for (const m of messages) {
    const content = (m as { content?: unknown } | null)?.content
    if (typeof content === 'string') chars += content.length
  }
  return Math.ceil(chars / 4)
}

/**
 * The agent's parts of `turnId`'s context, or null when its prompt was not
 * measured for this turn (a turn whose persona failed, or a runtime that does
 * not measure). Workspace tools measured for another turn count 0; the static
 * instructions and tools always count.
 */
export function contextPartsFor(turnId: string): ContextParts | null {
  try {
    const p = prompt.get()
    if (!p || p.turnId !== turnId) return null
    const t = tools.get()
    const m = memory.get()
    return {
      system: STATIC_INSTRUCTIONS_TOKENS + count(p.system),
      skills: count(p.skills),
      tools: STATIC_TOOLS_TOKENS + (t && t.turnId === turnId ? count(t.tokens) : 0),
      memory: count(m?.tokens),
    }
  } catch {
    return null
  }
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}
