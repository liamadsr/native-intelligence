/**
 * How full a main-chat conversation's context is: what the side panel's
 * Context card shows (src/app/account/(dashboard)/side-panels/context-section.tsx),
 * read by GET /api/account/chat/context. Liam, 10-22: the Claude app's Context
 * panel, with a way to compact on command.
 *
 * ── The numbers ─────────────────────────────────────────────────────────────
 * The size is the last model call's whole input (system prompt, tool schemas,
 * history; cached input included), as the provider reported it: the turn
 * row's `context_last_step_input_tokens` (chat-usage-meter.ts), what the next
 * turn starts from and what compaction decides on. Its parts are the agent's
 * own estimates (agents/chat-agent/lib/context-parts.ts, `context_parts`):
 * the system prompt, its skills section, the tools advertised to that call,
 * the recalled memory. The rest is the conversation's (Messages). Estimates
 * that overshoot the total are scaled down to fit it, so the parts always add
 * up to what the model read.
 *
 * ── The window ──────────────────────────────────────────────────────────────
 * Not the model's full window (1M for DeepSeek V4 Flash): a chat never gets
 * near it. The chat's working window is what the chat-agent hands eve
 * (agents/chat-agent/lib/compaction-window.ts): eve compacts inside a turn at
 * 90% of it (CHAT_MIDTURN_COMPACTION_TOKENS, 225K), and the app compacts
 * between turns once the context passes CHAT_COMPACTION_TARGET_TOKENS (150K,
 * idle-compaction.ts). So the bar's top 10% is the compaction buffer, as the
 * Claude app's "Autocompact buffer" is. These are twins of the agent's
 * constants (the Next app can't import agent code;
 * agents/chat-agent/lib/__tests__/compaction-window.test.ts pins them).
 *
 * Pure and client-safe: the side panel reads its constants and types; the
 * route (src/app/api/account/chat/context/route.ts) reads the rows.
 *
 * ── After a compaction ──────────────────────────────────────────────────────
 * A compaction (on command, idle, or eve's own in a later turn's row) writes
 * its own usage row and reports no size after it: eve's summary is measured
 * only by the next model call. So a compaction newer than the last turn reads
 * as `compactedAt`, with no size until the next message.
 */
import { CHAT_MODELS, chatModelPolicy, type ChatModelId } from '@/lib/ai/models'
import type { ChatContextParts } from '@/lib/chat/chat-usage-meter'

/**
 * Twin of the agent's CHAT_COMPACTION_TARGET_TOKENS and idle-compaction.ts's
 * IDLE_COMPACTION_MIN_INPUT_TOKENS: the app compacts between turns past this.
 * A literal, not an import: the side panel reads this module, and
 * idle-compaction.ts is server code (its test pins the pair).
 */
export const CHAT_IDLE_COMPACT_TOKENS = 150_000
/** Twin of the agent's EVE_COMPACTION_THRESHOLD_PERCENT: eve compacts at this share of the window. */
export const CHAT_COMPACT_AT_PERCENT = 0.9
/** Twin of the agent's CHAT_MIDTURN_COMPACTION_TOKENS: the target plus half again. */
export const CHAT_MIDTURN_COMPACT_TOKENS = Math.round(CHAT_IDLE_COMPACT_TOKENS * 1.5)
/** Twin of the agent's CHAT_COMPACTION_WINDOW_TOKENS: the window eve is handed (250K). */
export const CHAT_WORKING_WINDOW_TOKENS = Math.ceil(CHAT_MIDTURN_COMPACT_TOKENS / CHAT_COMPACT_AT_PERCENT)

/** The parts of a context, in the order the card lists them. */
export const CONTEXT_PART_KEYS = ['messages', 'system', 'tools', 'skills', 'memory'] as const
export type ContextPartKey = (typeof CONTEXT_PART_KEYS)[number]

export interface ContextPart {
  key: ContextPartKey
  tokens: number
}

/** What GET /api/account/chat/context answers. */
export interface ChatContextUsage {
  /** The model the last turn ran on (an app model id), null when unknown. */
  model: string | null
  /** The context's size now: the last model call's whole input. Null after a compaction, until the next message. */
  usedTokens: number | null
  /** The chat's working window (the bar's whole width). */
  windowTokens: number
  /** eve compacts inside a turn past this: the bar's top is the buffer above it. */
  compactAtTokens: number
  /** The app compacts between turns, once the chat is quiet, past this. */
  idleCompactTokens: number
  /** The model's own window, when known. */
  modelWindowTokens: number | null
  /**
   * The size by part, in CONTEXT_PART_KEYS order, adding up to usedTokens.
   * Null when the turn's parts were not measured. After a compaction, the
   * agent's parts alone (the summary's size is unknown until the next message).
   */
  parts: ContextPart[] | null
  /** When the size was measured (the turn row's time). */
  measuredAt: string | null
  /** A compaction newer than the last measured turn, when there is one. */
  compactedAt: string | null
}

/** The model's own window, or null for a model chat doesn't know. */
export function modelWindowTokens(model: string | null): number | null {
  if (!model || !CHAT_MODELS.some((m) => m.id === model)) return null
  return chatModelPolicy(model as ChatModelId, 'light').contextWindowTokens
}

/** The chat's working window for a model: the window eve is handed, never more than the model's own. */
export function workingWindowTokens(modelWindow: number | null): number {
  return modelWindow ? Math.min(modelWindow, CHAT_WORKING_WINDOW_TOKENS) : CHAT_WORKING_WINDOW_TOKENS
}

/**
 * The size by part: the agent's parts, scaled down to fit `used` when their
 * estimates overshoot it, and the conversation as the rest. Pure.
 */
export function splitContext(used: number, agent: ChatContextParts): ContextPart[] {
  const own = agent.system + agent.skills + agent.tools + agent.memory
  const scale = own > used && own > 0 ? used / own : 1
  const system = Math.floor(agent.system * scale)
  const tools = Math.floor(agent.tools * scale)
  const skills = Math.floor(agent.skills * scale)
  const memory = Math.floor(agent.memory * scale)
  const messages = Math.max(0, used - system - tools - skills - memory)
  return [
    { key: 'messages', tokens: messages },
    { key: 'system', tokens: system },
    { key: 'tools', tokens: tools },
    { key: 'skills', tokens: skills },
    { key: 'memory', tokens: memory },
  ]
}

/** The session's newest usage rows the route reads: a turn row is among them unless compactions crowd it out. */
export const CONTEXT_ROWS_READ = 8

/** A usage row as this module reads it. */
export interface ContextUsageRow {
  model: string | null
  created_at: string | null
  metadata: Record<string, unknown> | null
}

/** A count off a row's metadata: a finite, non-negative number (floored), else null. */
function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null
}

/** The `context_parts` a turn row carries, or null. */
export function contextPartsOf(metadata: Record<string, unknown> | null): ChatContextParts | null {
  const raw = metadata?.context_parts
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const system = count(p.system)
  const skills = count(p.skills)
  const tools = count(p.tools)
  const memory = count(p.memory)
  if (system === null || skills === null || tools === null || memory === null) return null
  return { system, skills, tools, memory }
}

/**
 * The context from a session's newest usage rows, newest first: the newest
 * turn row that measured its size, and a compaction row newer than it. Null
 * when no row says anything (a conversation with no measured turn yet). Pure.
 */
export function contextFromRows(rows: readonly ContextUsageRow[]): ChatContextUsage | null {
  let compactedAt: string | null = null
  for (const row of rows) {
    const metadata = row.metadata ?? {}
    if (metadata.compaction === true) {
      compactedAt ??= row.created_at
      continue
    }
    const used = count(metadata.context_last_step_input_tokens)
    if (used === null) continue
    const model = row.model
    const modelWindow = modelWindowTokens(model)
    const window = workingWindowTokens(modelWindow)
    const agent = contextPartsOf(row.metadata)
    const base = {
      model,
      windowTokens: window,
      compactAtTokens: Math.floor(window * CHAT_COMPACT_AT_PERCENT),
      idleCompactTokens: Math.min(CHAT_IDLE_COMPACT_TOKENS, Math.floor(window * CHAT_COMPACT_AT_PERCENT)),
      modelWindowTokens: modelWindow,
      measuredAt: row.created_at,
    }
    if (compactedAt) {
      return {
        ...base,
        usedTokens: null,
        parts: agent ? splitContext(agent.system + agent.skills + agent.tools + agent.memory, agent).slice(1) : null,
        compactedAt,
      }
    }
    return { ...base, usedTokens: used, parts: agent ? splitContext(used, agent) : null, compactedAt: null }
  }
  return null
}
