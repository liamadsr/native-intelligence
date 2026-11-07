import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { isDisabledToolSentinel } from 'eve/tools'
import askUser, { CHANNEL_TURN_ASK_USER_RESULT, SERVER_TURN_ASK_USER_RESULT, TEAMMATE_ASK_USER_RESULT, UNATTENDED_ASK_USER_RESULT } from '../../tools/ask_user'

/**
 * The custom `ask_user` tool (resolved decision: keep Dial8's rich picker, do
 * NOT adopt eve's flat native ask_question). Invariants:
 *   1. its `approval` policy parks EVERY call (input.requested — how the
 *      transport surfaces the picker) EXCEPT on the device_ask surface, which
 *      has nobody to answer and gets a text refusal instead (tests below);
 *   2. its rich schema (1–4 questions, 2–4 options, header, multiSelect) is
 *      preserved — the twin of the cloud ask_user;
 *   3. it is a real tool (NOT a disableTool sentinel), so it owns the `ask_user`
 *      slot the workspace-tool proxy deliberately skips.
 */

describe('chat-agent ask_user — custom HITL tool', () => {
  it('is a real tool, not a disabled sentinel', () => {
    expect(isDisabledToolSentinel(askUser)).toBe(false)
  })

  it('approval is a request policy function (surface-aware; see the device-surface tests below)', () => {
    expect(typeof (askUser as { approval?: unknown }).approval).toBe('function')
  })

  it('preserves the rich schema: 1–4 questions with 2–4 options each', () => {
    const schema = (
      askUser as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }
    ).inputSchema

    // A valid batched, multi-select-with-descriptions payload parses.
    const ok = schema.safeParse({
      questions: [
        {
          question: 'Which environment?',
          header: 'Env',
          options: [
            { label: 'Staging', description: 'safe' },
            { label: 'Prod', description: 'careful' },
          ],
          multiSelect: false,
        },
      ],
    })
    expect(ok.success).toBe(true)

    // Fewer than 2 options is rejected (the rich shape is enforced).
    const tooFew = schema.safeParse({
      questions: [
        { question: 'Q', header: 'H', options: [{ label: 'only-one' }], multiSelect: false },
      ],
    })
    expect(tooFew.success).toBe(false)

    // Zero questions is rejected (min 1).
    const noQuestions = schema.safeParse({ questions: [] })
    expect(noQuestions.success).toBe(false)
  })

  it('execute acknowledges the asked questions (runs after the answer resumes)', async () => {
    const out = await (
      askUser as unknown as { execute: (i: unknown, c?: unknown) => unknown }
    ).execute(
      { questions: [{ question: 'Ship now?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }] },
      {},
    )
    expect(out).toMatchObject({ asked: ['Ship now?'] })
  })

  it('execute tells the model a typed answer (not one of its options) still counts, so it does not re-ask', async () => {
    const out = (await (
      askUser as unknown as { execute: (i: unknown, c?: unknown) => unknown }
    ).execute(
      { questions: [{ question: 'Which day?', header: 'Day', options: [{ label: 'Mon' }, { label: 'Tue' }], multiSelect: false }] },
      {},
    )) as { note: string }
    expect(out.note).toMatch(/their own words instead of one of your options/)
    expect(out.note).toMatch(/do not ask the same question again/)
  })
})

// ── The device surface (/api/device/ask) never parks on ask_user ─────────────
// A run token's payload is base64url JSON + '.' + signature; surfaceFromRunToken
// reads the payload unverified (the internal routes verify), so an unsigned
// test token is enough to drive the gate.
const token = (claims: Record<string, unknown>) =>
  `${Buffer.from(JSON.stringify({ conversationId: 'c', workspaceId: 'w', userId: 'u', exp: Date.now() + 60_000, ...claims }), 'utf8').toString('base64url')}.sig`
const sessionFor = (chatRunToken: string | undefined) => ({
  id: 'sess-1',
  auth: { current: { attributes: chatRunToken === undefined ? {} : { chatRunToken } }, initiator: null },
})
type Approval = (ctx: unknown) => unknown
type Execute = (i: unknown, c: unknown) => unknown
const approval = (askUser as unknown as { approval: Approval }).approval
const execute = (askUser as unknown as { execute: Execute }).execute
const QUESTIONS = { questions: [{ question: 'Which list?', header: 'List', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] }

describe('chat-agent ask_user — the device surface never fails closed on it', () => {
  it('a device-ask session is NOT parked: the approval policy answers not-applicable', async () => {
    expect(await approval({ session: sessionFor(token({ surface: 'device_ask' })), toolName: 'ask_user', toolInput: QUESTIONS })).toBe('not-applicable')
  })

  it('…and the call is answered with a refusal the model can act on (never an ack of an answer that will not come)', async () => {
    const out = await execute(QUESTIONS, { session: sessionFor(token({ surface: 'device_ask' })) })
    expect(out).toEqual(UNATTENDED_ASK_USER_RESULT)
    expect(UNATTENDED_ASK_USER_RESULT.asked).toBe(false)
    expect(UNATTENDED_ASK_USER_RESULT.note).toMatch(/Do not ask again/)
  })

  it('a browser chat (token without a surface), or no token at all, still parks for the picker on EVERY call', async () => {
    for (const t of [token({}), undefined, 'garbage']) {
      expect(await approval({ session: sessionFor(t), toolName: 'ask_user', toolInput: QUESTIONS, approvedTools: new Set(['ask_user']) })).toBe('user-approval')
      expect(await execute(QUESTIONS, { session: sessionFor(t) })).toMatchObject({ asked: ['Which list?'] })
    }
  })

  it('eve 0.79.1 consumes a function-valued approval AS the request policy (the seam the gate relies on)', () => {
    const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))
    const definition = readFileSync(join(eveRoot, 'dist/src/approval/definition.js'), 'utf8')
    expect(definition).toContain('function resolveApprovalPolicy(e){return typeof e==`function`?e:e.request}')
    // …and a 'not-applicable' status means no approval request (no park): the
    // harness hands the policy's status straight to the AI SDK's tool approval.
    const tools = readFileSync(join(eveRoot, 'dist/src/harness/tools.js'), 'utf8')
    expect(tools).toContain('return typeof r==`boolean`?r?`user-approval`:`not-applicable`:r')
    // …and the policy is called with the callback context, whose `session`
    // carries `auth` — the chatRunToken attribute the device gate reads. If eve
    // stopped passing it, the policy would see no surface and park device asks.
    expect(tools).toContain('n={...buildCallbackContext(),abortSignal:')
    expect(tools).toContain('resolveApprovalPolicy(e.approval)(t.recheck?markApprovalRecheck(n):n)')
    const callbackCtx = readFileSync(join(eveRoot, 'dist/src/context/build-callback-context.js'), 'utf8')
    expect(callbackCtx).toContain('session:{id:t.sessionId,auth:t.auth')
  })
})

// ── A teammate chat (bots v2) has no picker: ask_user answers, never parks ────
describe('chat-agent ask_user — a teammate chat answers instead of parking', () => {
  it('a token carrying teammateId is NOT parked, and the call gets the plain-text note', async () => {
    const t = token({ teammateId: 'tm-1' })
    expect(await approval({ session: sessionFor(t), toolName: 'ask_user', toolInput: QUESTIONS })).toBe('not-applicable')
    expect(await execute(QUESTIONS, { session: sessionFor(t) })).toEqual(TEAMMATE_ASK_USER_RESULT)
    expect(TEAMMATE_ASK_USER_RESULT.asked).toBe(false)
    expect(TEAMMATE_ASK_USER_RESULT.note).toMatch(/plain text/)
  })

  it('an empty or non-string teammateId reads as an ordinary chat (still parks)', async () => {
    for (const t of [token({ teammateId: '' }), token({ teammateId: 42 })]) {
      expect(await approval({ session: sessionFor(t), toolName: 'ask_user', toolInput: QUESTIONS })).toBe('user-approval')
    }
  })
})

// ── A server-started home turn (A4 slice 5): nobody to answer, never parks ────
describe('chat-agent ask_user — a server-started turn answers not applicable', () => {
  it('a token carrying server is NOT parked, and the call says why', async () => {
    const t = token({ server: 'home_turn' })
    expect(await approval({ session: sessionFor(t), toolName: 'ask_user', toolInput: QUESTIONS })).toBe('not-applicable')
    expect(await execute(QUESTIONS, { session: sessionFor(t) })).toEqual(SERVER_TURN_ASK_USER_RESULT)
    expect(SERVER_TURN_ASK_USER_RESULT.asked).toBe(false)
    expect(SERVER_TURN_ASK_USER_RESULT.note).toMatch(/Not applicable/)
  })

  it('a text turn (the person texting the Dial8 number) is NOT parked: its own note says to ask in the reply', async () => {
    const t = token({ server: 'channel_turn', surface: 'sms' })
    expect(await approval({ session: sessionFor(t), toolName: 'ask_user', toolInput: QUESTIONS })).toBe('not-applicable')
    expect(await execute(QUESTIONS, { session: sessionFor(t) })).toEqual(CHANNEL_TURN_ASK_USER_RESULT)
  })

  it('an empty or non-string server claim reads as an ordinary chat (still parks)', async () => {
    for (const t of [token({ server: '' }), token({ server: 7 })]) {
      expect(await approval({ session: sessionFor(t), toolName: 'ask_user', toolInput: QUESTIONS })).toBe('user-approval')
    }
  })
})

// ── A channel turn (a Slack DM from the person): no picker there, ask in the reply ──
describe('chat-agent ask_user — a channel turn asks in its reply', () => {
  it('is NOT parked, and the note says to put the options in the reply', async () => {
    const t = token({ server: 'channel_turn', surface: 'slack' })
    expect(await approval({ session: sessionFor(t), toolName: 'ask_user', toolInput: QUESTIONS })).toBe('not-applicable')
    expect(await execute(QUESTIONS, { session: sessionFor(t) })).toEqual(CHANNEL_TURN_ASK_USER_RESULT)
    expect(CHANNEL_TURN_ASK_USER_RESULT.asked).toBe(false)
    expect(CHANNEL_TURN_ASK_USER_RESULT.note).toMatch(/ask one short question in your reply/)
  })
})
