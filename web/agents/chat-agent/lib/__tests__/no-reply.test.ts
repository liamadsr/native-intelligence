import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import noReply, { NO_REPLY_REFUSED, NO_REPLY_TOOL_NAME, mayEndTurnSilently, type NoReplyOutput } from '../../tools/no_reply'

/**
 * tools/no_reply.ts (P11, docs/plans/eve-alignment.md §4): eve's opt-in
 * `no_reply` lets a SERVER-started home turn end with no message. It is a
 * STATIC tool, advertised on every turn so the home thread's shared prompt
 * cache holds, and gated in `execute`: a person's own turn always gets an
 * answer.
 */
type Tool = {
  description: string
  availableInSubagents?: boolean
  endsTurn?: (output: NoReplyOutput) => boolean
  execute: (input: unknown, ctx?: { session?: { auth?: unknown } }) => NoReplyOutput
  events?: unknown
}
const tool = noReply as unknown as Tool

/** A chat-run token as the agent reads it: base64url claims, a dot, a signature it never checks. */
const token = (claims: object) => `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
const authWith = (runToken: string | undefined) => ({ current: { attributes: runToken === undefined ? {} : { chatRunToken: runToken } } })
const call = (auth: unknown) => tool.execute({ reason: 'routine progress' }, { session: { auth } })

describe('no_reply: static, so every turn advertises the same tool list', () => {
  it('is a plain defineTool (no dynamic resolver), named no_reply, kept off delegated copies', () => {
    expect(tool.events).toBeUndefined()
    expect(typeof tool.execute).toBe('function')
    expect(typeof tool.endsTurn).toBe('function')
    expect(tool.availableInSubagents).toBe(false)
    expect(tool.description).toMatch(/End your turn without sending a reply/)
    expect(tool.description).toMatch(/When the person writes to you, never call this/)
    expect(NO_REPLY_TOOL_NAME).toBe('no_reply')
  })

  it('the quick helpers never get it (their own tools/ has no no_reply)', () => {
    const subagents = resolve(__dirname, '../../subagents')
    const helpers = readdirSync(subagents).filter((d) => !d.startsWith('.'))
    expect(helpers).toContain('helper_opus')
    for (const helper of helpers) {
      expect(existsSync(join(subagents, helper, 'tools', 'no_reply.ts'))).toBe(false)
    }
  })
})

describe('no_reply: it ends only a home turn', () => {
  it('a home turn (server: home_turn): ended, and the call ends the turn', () => {
    const out = call(authWith(token({ conversationId: 'c', server: 'home_turn' })))
    expect(out).toEqual({ ended: true })
    expect(tool.endsTurn!(out)).toBe(true)
  })

  it.each([
    ['the person’s own chat turn', token({ conversationId: 'c' })],
    ['a device ask', token({ conversationId: 'c', surface: 'device_ask' })],
    ['a teammate chat', token({ conversationId: 'c', teammateId: 't' })],
    ['an idle compaction (another server principal)', token({ conversationId: 'c', server: 'idle_compaction' })],
    ['a garbled token', 'not-a-token'],
    ['no token', undefined],
  ])('%s: refused, the turn goes on, and the model is told to answer', (_label, runToken) => {
    const out = call(authWith(runToken))
    expect(out).toEqual(NO_REPLY_REFUSED)
    expect(out).toMatchObject({ ended: false, note: expect.stringMatching(/Answer them/) })
    expect(tool.endsTurn!(out)).toBe(false)
    expect(mayEndTurnSilently(authWith(runToken))).toBe(false)
  })

  it('a missing or odd auth or context reads as a person’s turn, never throws', () => {
    for (const auth of [undefined, null, {}, { current: null }]) {
      expect(mayEndTurnSilently(auth)).toBe(false)
      expect(call(auth)).toEqual(NO_REPLY_REFUSED)
    }
    expect(tool.execute({}, undefined)).toEqual(NO_REPLY_REFUSED)
  })
})
