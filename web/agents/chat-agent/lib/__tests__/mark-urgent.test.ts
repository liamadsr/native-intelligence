import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import markUrgentTool, {
  MARK_URGENT_BAD_TIME,
  MARK_URGENT_DESCRIPTION,
  MARK_URGENT_PAST,
  MARK_URGENT_REFUSED,
  MARK_URGENT_TOOL_NAME,
  isUrgentBy,
  markUrgent,
  mayMarkUrgent,
  type MarkUrgentOutput,
} from '../../tools/mark_urgent'

/**
 * tools/mark_urgent.ts (docs/plans/reach-follows-you.md §4, part D): a
 * background update marks its message urgent with a deadline, and the router
 * may then take it through quiet hours. Static (advertised on every turn so
 * the home thread's prompt cache holds), gated in `execute` like no_reply:
 * only a home turn's server token marks; `by` must carry its UTC offset.
 */
type Tool = {
  description: string
  availableInSubagents?: boolean
  endsTurn?: unknown
  inputSchema: { safeParse: (v: unknown) => { success: boolean } }
  execute: (input: unknown, ctx?: { session?: { auth?: unknown } }) => MarkUrgentOutput
  events?: unknown
}
const tool = markUrgentTool as unknown as Tool

const token = (claims: object) => `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
const authWith = (runToken: string | undefined) => ({ current: { attributes: runToken === undefined ? {} : { chatRunToken: runToken } } })
const HOME = authWith(token({ conversationId: 'c', server: 'home_turn' }))
const NOW = Date.parse('2026-10-31T21:07:00-04:00')

describe('mark_urgent: static, so every turn advertises the same tool list', () => {
  it('a plain defineTool named mark_urgent, kept off delegated copies, that never ends the turn', () => {
    expect(tool.events).toBeUndefined()
    expect(typeof tool.execute).toBe('function')
    expect(tool.endsTurn).toBeUndefined()
    expect(tool.availableInSubagents).toBe(false)
    expect(tool.description).toBe(MARK_URGENT_DESCRIPTION)
    expect(MARK_URGENT_TOOL_NAME).toBe('mark_urgent')
  })

  it('its description and every note fit OpenAI’s 1024 characters together', () => {
    const notes = [MARK_URGENT_REFUSED, MARK_URGENT_BAD_TIME, MARK_URGENT_PAST].map((o) => ('note' in o ? o.note : ''))
    expect(MARK_URGENT_DESCRIPTION.length + notes.reduce((n, s) => n + s.length, 0)).toBeLessThanOrEqual(1024)
    // It never lets the agent pick a channel: Dial8 decides where it goes.
    expect(MARK_URGENT_DESCRIPTION).toMatch(/Dial8 decides where it goes/)
    expect(MARK_URGENT_DESCRIPTION).toMatch(/10 am tomorrow/)
  })

  it('the quick helpers never get it (their own tools/ has no mark_urgent)', () => {
    const subagents = resolve(__dirname, '../../subagents')
    const helpers = readdirSync(subagents).filter((d) => !d.startsWith('.'))
    expect(helpers.length).toBeGreaterThan(0)
    for (const helper of helpers) expect(existsSync(join(subagents, helper, 'tools', 'mark_urgent.ts'))).toBe(false)
  })

  it('takes a by and an optional why', () => {
    expect(tool.inputSchema.safeParse({ by: '2026-11-01T09:00:00-04:00', why: 'the call moved' }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ by: '2026-11-01T09:00:00-04:00' }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ why: 'x' }).success).toBe(false)
  })
})

describe('mark_urgent: only a home turn marks, with an offset, ahead', () => {
  it('a home turn with a time ahead: marked, `by` as given', () => {
    expect(markUrgent({ by: '2026-11-01T09:00:00-05:00' }, HOME, NOW)).toEqual({ marked: true, by: '2026-11-01T09:00:00-05:00' })
    expect(markUrgent({ by: '2026-11-01T14:00:00Z' }, HOME, NOW)).toEqual({ marked: true, by: '2026-11-01T14:00:00Z' })
    expect(tool.execute({ by: '2099-01-01T09:00:00+01:00' }, { session: { auth: HOME } })).toEqual({ marked: true, by: '2099-01-01T09:00:00+01:00' })
  })

  it.each([
    ['the person’s own chat turn', token({ conversationId: 'c' })],
    ['a text or Slack turn', token({ conversationId: 'c', server: 'channel_turn', surface: 'sms' })],
    ['an idle compaction', token({ conversationId: 'c', server: 'idle_compaction' })],
    ['a garbled token', 'not-a-token'],
    ['no token', undefined],
  ])('%s: refused, with a note', (_label, runToken) => {
    expect(markUrgent({ by: '2026-11-01T09:00:00-05:00' }, authWith(runToken), NOW)).toEqual(MARK_URGENT_REFUSED)
    expect(mayMarkUrgent(authWith(runToken))).toBe(false)
  })

  it('refuses a by without its offset, or not a time; and one already past', () => {
    for (const by of ['2026-11-01T09:00:00', '2026-11-01', '9am tomorrow', '', 42, undefined]) {
      expect(markUrgent({ by }, HOME, NOW)).toEqual(MARK_URGENT_BAD_TIME)
      expect(isUrgentBy(by)).toBe(false)
    }
    expect(markUrgent({ by: '2026-10-31T21:00:00-04:00' }, HOME, NOW)).toEqual(MARK_URGENT_PAST)
  })

  it('an odd auth or context reads as a person’s turn, never throws', () => {
    for (const auth of [undefined, null, {}, { current: null }]) expect(markUrgent({ by: '2026-11-01T09:00:00-05:00' }, auth, NOW)).toEqual(MARK_URGENT_REFUSED)
    expect(tool.execute({ by: '2026-11-01T09:00:00-05:00' }, undefined)).toEqual(MARK_URGENT_REFUSED)
  })
})
