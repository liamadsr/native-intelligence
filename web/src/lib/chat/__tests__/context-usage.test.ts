/**
 * How full a chat's context is (src/lib/chat/context-usage.ts): the side
 * panel's Context card. Pinned:
 *   - the window: the chat's working window (250K, eve's) on a 1M model, the
 *     model's own on a smaller one, 250K for a model chat doesn't know;
 *   - splitContext: the parts always add up to what the model read (estimates
 *     that overshoot are scaled down to fit; the conversation is the rest);
 *   - contextFromRows, over a session's newest usage rows: the newest turn
 *     that measured its size; rows that didn't are skipped; a compaction newer
 *     than it reads as compactedAt with no size and the agent's parts alone;
 *     an older one changes nothing; null when no row measured anything.
 * The twins of the agent's constants are pinned in
 * agents/chat-agent/lib/__tests__/compaction-window.test.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  CHAT_IDLE_COMPACT_TOKENS,
  CHAT_WORKING_WINDOW_TOKENS,
  CONTEXT_PART_KEYS,
  contextFromRows,
  contextPartsOf,
  modelWindowTokens,
  splitContext,
  workingWindowTokens,
  type ContextPart,
  type ContextUsageRow,
} from '../context-usage'

const PARTS = { system: 9000, skills: 1200, tools: 14_000, memory: 300 }
const sum = (parts: readonly ContextPart[]) => parts.reduce((n, p) => n + p.tokens, 0)
const byKey = (parts: readonly ContextPart[]) => Object.fromEntries(parts.map((p) => [p.key, p.tokens]))

/** A turn row as the usage meter writes it (chat-usage-meter.ts meterChatTurn). */
function turnRow(at: string, used: number | undefined, over: { model?: string | null; parts?: unknown } = {}): ContextUsageRow {
  return {
    model: over.model === undefined ? 'deepseek-v4-flash' : over.model,
    created_at: at,
    metadata: {
      eve_session_id: 'sess-1',
      ...(used === undefined ? {} : { context_last_step_input_tokens: used }),
      ...(over.parts === undefined ? { context_parts: PARTS } : over.parts === null ? {} : { context_parts: over.parts }),
    },
  }
}
/** A compaction row (on command or idle): its own usage row, no size after it. */
const compactionRow = (at: string): ContextUsageRow => ({
  model: 'deepseek-v4-flash',
  created_at: at,
  metadata: { eve_session_id: 'sess-1', compaction: true, compactionTrigger: 'manual' },
})

describe('the window', () => {
  it('a 1M model gets the chat’s working window; a 200K model keeps its own; an unknown model the working window', () => {
    expect(CHAT_WORKING_WINDOW_TOKENS).toBe(250_000)
    expect(modelWindowTokens('deepseek-v4-flash')).toBe(1_000_000)
    expect(workingWindowTokens(modelWindowTokens('deepseek-v4-flash'))).toBe(250_000)
    expect(modelWindowTokens('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(workingWindowTokens(modelWindowTokens('claude-haiku-4-5-20251001'))).toBe(200_000)
    expect(modelWindowTokens('acme-mystery-1')).toBeNull()
    expect(modelWindowTokens(null)).toBeNull()
    expect(workingWindowTokens(null)).toBe(250_000)
  })
})

describe('splitContext', () => {
  it('the conversation is what the agent’s parts leave, in the card’s order', () => {
    const parts = splitContext(100_000, PARTS)
    expect(parts.map((p) => p.key)).toEqual([...CONTEXT_PART_KEYS])
    expect(byKey(parts)).toEqual({ messages: 75_500, ...PARTS })
    expect(sum(parts)).toBe(100_000)
  })

  it('estimates that overshoot the total are scaled down to fit it', () => {
    const parts = splitContext(10_000, { system: 9000, skills: 3000, tools: 6000, memory: 2000 })
    expect(byKey(parts)).toEqual({ messages: 0, system: 4500, skills: 1500, tools: 3000, memory: 1000 })
    expect(sum(parts)).toBe(10_000)
  })

  it.each([
    [10_001, { system: 9001, skills: 3003, tools: 6007, memory: 2011 }],
    [1, { system: 3, skills: 3, tools: 3, memory: 3 }],
    [77_777, { system: 77_777, skills: 0, tools: 0, memory: 0 }],
    [50_000, { system: 0, skills: 0, tools: 0, memory: 0 }],
    [0, PARTS],
  ])('always adds up to what the model read (%i)', (used, agent) => {
    const parts = splitContext(used, agent)
    expect(sum(parts)).toBe(used)
    for (const p of parts) expect(p.tokens, p.key).toBeGreaterThanOrEqual(0)
  })
})

describe('contextPartsOf', () => {
  it('reads the four counts off a row’s metadata, or null', () => {
    expect(contextPartsOf({ context_parts: PARTS })).toEqual(PARTS)
    expect(contextPartsOf({ context_parts: { ...PARTS, tools: 14_000.6 } })).toEqual(PARTS)
    expect(contextPartsOf({ context_parts: { ...PARTS, tools: -1 } })).toBeNull()
    expect(contextPartsOf({ context_parts: { system: 1, skills: 2, tools: 3 } })).toBeNull()
    expect(contextPartsOf({ context_parts: 'x' })).toBeNull()
    expect(contextPartsOf({})).toBeNull()
    expect(contextPartsOf(null)).toBeNull()
  })
})

describe('contextFromRows (newest first)', () => {
  it('nothing measured: null', () => {
    expect(contextFromRows([])).toBeNull()
    // Turns from before the measure, a row with no metadata, and a compaction with no turn behind it.
    expect(contextFromRows([turnRow('2026-10-22T10:05:00Z', undefined), { model: null, created_at: null, metadata: null }])).toBeNull()
    expect(contextFromRows([compactionRow('2026-10-22T10:06:00Z')])).toBeNull()
  })

  it('the newest measured turn: its size, its parts, its model’s window and lines', () => {
    const context = contextFromRows([turnRow('2026-10-22T10:05:00Z', 185_000), turnRow('2026-10-22T10:01:00Z', 120_000)])
    expect(context).toEqual({
      model: 'deepseek-v4-flash',
      usedTokens: 185_000,
      windowTokens: 250_000,
      compactAtTokens: 225_000,
      idleCompactTokens: CHAT_IDLE_COMPACT_TOKENS,
      modelWindowTokens: 1_000_000,
      parts: [
        { key: 'messages', tokens: 160_500 },
        { key: 'system', tokens: 9000 },
        { key: 'tools', tokens: 14_000 },
        { key: 'skills', tokens: 1200 },
        { key: 'memory', tokens: 300 },
      ],
      measuredAt: '2026-10-22T10:05:00Z',
      compactedAt: null,
    })
  })

  it('a 200K model’s window, and an unknown model’s', () => {
    expect(contextFromRows([turnRow('2026-10-22T10:05:00Z', 90_000, { model: 'claude-haiku-4-5-20251001' })])).toMatchObject({
      windowTokens: 200_000,
      compactAtTokens: 180_000,
      idleCompactTokens: 150_000,
      modelWindowTokens: 200_000,
    })
    expect(contextFromRows([turnRow('2026-10-22T10:05:00Z', 90_000, { model: null })])).toMatchObject({
      model: null,
      windowTokens: 250_000,
      modelWindowTokens: null,
    })
  })

  it('skips a newer row that did not measure its size', () => {
    const context = contextFromRows([turnRow('2026-10-22T10:09:00Z', undefined), turnRow('2026-10-22T10:05:00Z', 185_000)])
    expect(context).toMatchObject({ usedTokens: 185_000, measuredAt: '2026-10-22T10:05:00Z', compactedAt: null })
  })

  it('a turn whose parts were not measured (or are malformed) has a size and no parts', () => {
    expect(contextFromRows([turnRow('2026-10-22T10:05:00Z', 185_000, { parts: null })])).toMatchObject({ usedTokens: 185_000, parts: null })
    expect(contextFromRows([turnRow('2026-10-22T10:05:00Z', 185_000, { parts: { ...PARTS, memory: -4 } })])).toMatchObject({
      usedTokens: 185_000,
      parts: null,
    })
  })

  it('a compaction newer than the newest turn: no size until the next message, the agent’s parts alone', () => {
    const context = contextFromRows([
      compactionRow('2026-10-22T10:12:00Z'),
      compactionRow('2026-10-22T10:08:00Z'),
      turnRow('2026-10-22T10:05:00Z', 185_000),
    ])
    expect(context).toMatchObject({
      usedTokens: null,
      compactedAt: '2026-10-22T10:12:00Z',
      measuredAt: '2026-10-22T10:05:00Z',
      windowTokens: 250_000,
      parts: [
        { key: 'system', tokens: 9000 },
        { key: 'tools', tokens: 14_000 },
        { key: 'skills', tokens: 1200 },
        { key: 'memory', tokens: 300 },
      ],
    })
    // Unmeasured parts stay unknown after it too.
    expect(contextFromRows([compactionRow('2026-10-22T10:12:00Z'), turnRow('2026-10-22T10:05:00Z', 185_000, { parts: null })])).toMatchObject({
      usedTokens: null,
      parts: null,
      compactedAt: '2026-10-22T10:12:00Z',
    })
  })

  it('a compaction older than the newest turn changes nothing', () => {
    const context = contextFromRows([
      turnRow('2026-10-22T10:20:00Z', 61_000),
      compactionRow('2026-10-22T10:12:00Z'),
      turnRow('2026-10-22T10:05:00Z', 185_000),
    ])
    expect(context).toMatchObject({ usedTokens: 61_000, compactedAt: null, measuredAt: '2026-10-22T10:20:00Z' })
    expect(sum(context!.parts!)).toBe(61_000)
  })
})
