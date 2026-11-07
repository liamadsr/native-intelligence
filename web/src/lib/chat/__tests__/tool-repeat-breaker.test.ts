/**
 * The repeat-failure breaker (../tool-repeat-breaker.ts): an identical chat
 * tool call that failed the same way 3 times in one eve turn is not run a 4th
 * time. A PROD chat on deepseek-v4-flash sent one failing settle_card 31 times
 * in one turn (2026-10-08). The route wiring is in
 * src/app/api/internal/chat/tool/__tests__/route.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  REPEAT_BREAKER_MAX_ENTRIES,
  REPEAT_WINDOW_MS,
  REPEATED_FAILURE_ERROR,
  canonicalJson,
  failureFingerprint,
  recordCallOutcome,
  repeatBreakerSize,
  repeatKey,
  repeatedFailureOutput,
  resetRepeatBreaker,
} from '../tool-repeat-breaker'

const PROD_INPUT = { action: 'accept', target_entity_id: 'c4000000-0000-4000-8000-000000000001' }
const PROD_FAILURE = { success: false, code: 'INPUT_INVALID', error: 'Give exactly one of card_id or proposal_id.' }
const turn = { sessionId: 'wrun_session-1', turnId: 'turn-1' }

/** One call through the breaker, as the route makes it: refused, or run and recorded. */
function call(scope: { sessionId?: unknown; turnId?: unknown }, input: unknown, output: unknown, tool = 'settle_card') {
  const key = repeatKey(scope, tool, input)
  const refused = repeatedFailureOutput(key)
  if (refused) return { ran: false, output: refused }
  recordCallOutcome(key, failureFingerprint(output))
  return { ran: true, output }
}

beforeEach(() => resetRepeatBreaker())

describe('the repeat-failure breaker', () => {
  it('trips on the 4th identical failing call in a turn, and stays tripped for it', () => {
    const runs = Array.from({ length: 6 }, () => call(turn, PROD_INPUT, PROD_FAILURE))
    expect(runs.map((r) => r.ran)).toEqual([true, true, true, false, false, false])
    expect(runs[3].output).toEqual({ success: false, code: 'REPEATED_FAILURE', error: REPEATED_FAILURE_ERROR })
    expect(REPEATED_FAILURE_ERROR).toBe(
      'This exact call failed 3 times. Stop retrying it: tell the person what failed and ask how to proceed, or change the input.',
    )
  })

  it('the same input in another key order is the same call', () => {
    for (let i = 0; i < 3; i++) call(turn, PROD_INPUT, PROD_FAILURE)
    expect(call(turn, { target_entity_id: PROD_INPUT.target_entity_id, action: 'accept' }, PROD_FAILURE).ran).toBe(false)
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe('{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}')
  })

  it('never across turns or sessions', () => {
    for (let i = 0; i < 3; i++) call(turn, PROD_INPUT, PROD_FAILURE)
    expect(call({ ...turn, turnId: 'turn-2' }, PROD_INPUT, PROD_FAILURE).ran).toBe(true)
    expect(call({ ...turn, sessionId: 'wrun_session-2' }, PROD_INPUT, PROD_FAILURE).ran).toBe(true)
  })

  it('never for a changed input, or another tool', () => {
    for (let i = 0; i < 3; i++) call(turn, PROD_INPUT, PROD_FAILURE)
    expect(call(turn, { action: 'accept', card_id: PROD_INPUT.target_entity_id }, { success: true }).ran).toBe(true)
    expect(call(turn, PROD_INPUT, PROD_FAILURE, 'settle_work_item').ran).toBe(true)
  })

  it('a success clears the count', () => {
    call(turn, PROD_INPUT, PROD_FAILURE)
    call(turn, PROD_INPUT, PROD_FAILURE)
    call(turn, PROD_INPUT, { success: true })
    expect([1, 2, 3, 4].map(() => call(turn, PROD_INPUT, PROD_FAILURE).ran)).toEqual([true, true, true, false])
  })

  it('never for a read that repeats with the same input and succeeds', () => {
    const read = { item_id: 'run:abc' }
    expect(Array.from({ length: 10 }, () => call(turn, read, { item: { cards: [] } }, 'get_bot_item').ran).every(Boolean)).toBe(true)
    expect(Array.from({ length: 10 }, () => call(turn, { run_id: 'r' }, { success: true, still_running: true }, 'wait_for_browser_command').ran).every(Boolean)).toBe(true)
    expect(repeatBreakerSize()).toBe(0)
  })

  it('only the SAME failure counts: a different failure starts the count over', () => {
    call(turn, PROD_INPUT, PROD_FAILURE)
    call(turn, PROD_INPUT, PROD_FAILURE)
    call(turn, PROD_INPUT, { success: false, code: 'NOT_FOUND', error: 'No card' })
    expect(call(turn, PROD_INPUT, PROD_FAILURE).ran).toBe(true)
    expect(call(turn, PROD_INPUT, PROD_FAILURE).ran).toBe(true)
    expect(call(turn, PROD_INPUT, PROD_FAILURE).ran).toBe(true)
    expect(call(turn, PROD_INPUT, PROD_FAILURE).ran).toBe(false)
  })

  it('never without an eve session and turn id', () => {
    for (const scope of [{}, { turnId: 'turn-1' }, { sessionId: 'wrun_session-1' }, { sessionId: '', turnId: '' }, { sessionId: 1, turnId: 2 }]) {
      expect(repeatKey(scope, 'settle_card', PROD_INPUT)).toBeNull()
      expect(Array.from({ length: 5 }, () => call(scope, PROD_INPUT, PROD_FAILURE).ran).every(Boolean)).toBe(true)
    }
    expect(repeatBreakerSize()).toBe(0)
  })

  it('tells failures apart by code, else by error text; a success or a plain result is no failure', () => {
    expect(failureFingerprint(PROD_FAILURE)).toBe('code:INPUT_INVALID')
    expect(failureFingerprint({ success: false, error: 'Unknown run_id.' })).toBe('error:Unknown run_id.')
    expect(failureFingerprint({ error: 'Workspace not found' })).toBe('error:Workspace not found')
    expect(failureFingerprint({ success: false })).toBe('failed')
    expect(failureFingerprint({ success: true, error: 'partial' })).toBeNull()
    expect(failureFingerprint({ ok: true })).toBeNull()
    expect(failureFingerprint({ error: null })).toBeNull()
    expect(failureFingerprint([{ success: false }])).toBeNull()
    expect(failureFingerprint('text')).toBeNull()
    expect(failureFingerprint(undefined)).toBeNull()
  })

  it('is bounded: the oldest calls go first', () => {
    for (let i = 0; i < REPEAT_BREAKER_MAX_ENTRIES + 50; i++) call({ ...turn, turnId: `t-${i}` }, PROD_INPUT, PROD_FAILURE)
    expect(repeatBreakerSize()).toBe(REPEAT_BREAKER_MAX_ENTRIES)
  })

  it('a paused turn resumes: an identical failure more than 90 s after the last starts the count over', () => {
    // ask_user pauses the turn and resumes the SAME turn id; the person fixed
    // what failed in between, so the identical retry must run.
    expect(REPEAT_WINDOW_MS).toBe(90_000)
    const key = repeatKey(turn, 'screenshot_browser', {})
    const t0 = 5_000_000
    for (let i = 0; i < 3; i++) recordCallOutcome(key, 'error:No desktop app picked up the command', t0 + i * 1000)
    expect(repeatedFailureOutput(key, t0 + 3000)).not.toBeNull()
    // 91 s after the last failure: it runs.
    const later = t0 + 2000 + 91_000
    expect(repeatedFailureOutput(key, later)).toBeNull()
    // And a fresh failure then counts from one: two more still run.
    recordCallOutcome(key, 'error:No desktop app picked up the command', later)
    recordCallOutcome(key, 'error:No desktop app picked up the command', later + 1000)
    expect(repeatedFailureOutput(key, later + 2000)).toBeNull()
    recordCallOutcome(key, 'error:No desktop app picked up the command', later + 2000)
    expect(repeatedFailureOutput(key, later + 3000)).not.toBeNull()
  })

  it("another tool's success does not reset this call's count", () => {
    for (let i = 0; i < 3; i++) call(turn, PROD_INPUT, PROD_FAILURE)
    call(turn, { item_id: 'run:abc' }, { success: true }, 'get_bot_item')
    expect(call(turn, PROD_INPUT, PROD_FAILURE).ran).toBe(false)
  })

  it('the user is in the key, and an input key named __proto__ is hashed like any other key', () => {
    expect(repeatKey({ ...turn, userId: 'u1' }, 'settle_card', PROD_INPUT)).not.toBe(repeatKey({ ...turn, userId: 'u2' }, 'settle_card', PROD_INPUT))
    const a = JSON.parse('{"__proto__":{"x":1},"a":1}')
    const b = JSON.parse('{"__proto__":{"x":2},"a":1}')
    expect(canonicalJson(a)).toBe('{"__proto__":{"x":1},"a":1}')
    expect(repeatKey(turn, 't', a)).not.toBe(repeatKey(turn, 't', b))
  })

  it('forgets a count after its TTL', () => {
    const key = repeatKey(turn, 'settle_card', PROD_INPUT)
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) recordCallOutcome(key, 'code:INPUT_INVALID', t0)
    expect(repeatedFailureOutput(key, t0 + 1000)).not.toBeNull()
    expect(repeatedFailureOutput(key, t0 + 2 * 60 * 60 * 1000)).toBeNull()
  })
})

describe('the chat agent is told not to resend a failing call', () => {
  it('agents/chat-agent/instructions.md: fix the input per the error after INPUT_INVALID; never an identical failing call', () => {
    const md = readFileSync(join(process.cwd(), 'agents/chat-agent/instructions.md'), 'utf8').replace(/\s+/g, ' ')
    expect(md).toContain("After an `INPUT_INVALID`, fix the input the way the error's words say")
    expect(md).toContain('Never resend an identical call that failed with `INPUT_INVALID`, or one that has failed the same way twice.')
    expect(md).toContain('A `REPEATED_FAILURE` means stop: tell the person what failed and ask how to proceed.')
  })
})
