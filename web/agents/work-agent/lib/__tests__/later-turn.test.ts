import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EveSpec } from '../spec-client'

/**
 * Bots v3 Phase 5 (found in Phase 4): a work run's follow-up chat resolved its
 * tools ONCE, at session start, with the run's dispatch token (60-minute TTL),
 * so a chat more than an hour after the run had tools that all failed. The
 * same held for a run resumed after a long wait on its question.
 *
 * Now the tools resolver re-resolves on `turn.started` for a LATER turn's
 * token (a chat turn: `chat: true`; a resume: `resume: true`): that turn's
 * proxies carry that turn's fresh token and its spec. The run's own first turn
 * fetches nothing and returns null, so its session tools stand.
 */
const fetchEveSpec = vi.fn<(t: string) => Promise<EveSpec | null>>()
const dispatchWorkspaceTool = vi.fn<(name: string, token: string, input: unknown) => Promise<unknown>>(async () => ({ ok: true }))

vi.mock('../spec-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../spec-client')>()),
  fetchEveSpec: (t: string) => fetchEveSpec(t),
  dispatchWorkspaceTool: (name: string, token: string, input: unknown) => dispatchWorkspaceTool(name, token, input),
}))

import workspaceTools from '../../tools/workspace_tools'

type ToolFn = { execute: (i: unknown) => unknown }
type Ctx = { session: { auth: unknown } }
type Resolver<T> = { events: Record<string, (e: unknown, ctx: Ctx) => Promise<T>> }

const auth = (runToken: string): Ctx => ({ session: { auth: { current: { attributes: { runToken } } } } })
/** A token shaped as the app mints them (payload.signature); the signature is never checked here. */
const token = (claims: Record<string, unknown>) => `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.sig`
const RUN_TOKEN = token({ agentRunId: 'r-1', workspaceId: 'ws-1', userId: 'u-1', exp: 1 })
const CHAT_TOKEN = token({ agentRunId: 'r-1', workspaceId: 'ws-1', userId: 'u-1', exp: 2, chat: true })
const RESUME_TOKEN = token({ agentRunId: 'r-1', workspaceId: 'ws-1', userId: 'u-1', exp: 3, resume: true })

const spec = (names: string[]): EveSpec =>
  ({ systemPrompt: 'p', model: 'anthropic/claude-haiku-4-5', ceilingTools: names.map((name) => ({ name, description: name })) }) as unknown as EveSpec

const tools = workspaceTools as unknown as Resolver<Record<string, ToolFn> | null>

beforeEach(() => {
  fetchEveSpec.mockReset()
  dispatchWorkspaceTool.mockClear()
})

describe('work-agent tools re-resolve on a later turn', () => {
  it('declares a turn.started resolver beside session.started', () => {
    expect(typeof tools.events['session.started']).toBe('function')
    expect(typeof tools.events['turn.started']).toBe('function')
  })

  it('a follow-up chat turn’s proxies carry THAT turn’s token, and its spec (the run’s ceiling plus its bot’s grants)', async () => {
    fetchEveSpec.mockImplementation(async (t) => (t === CHAT_TOKEN ? spec(['create_email_draft', 'revise_email_draft']) : spec(['create_email_draft'])))
    const turn = await tools.events['turn.started']({}, auth(CHAT_TOKEN))
    expect(fetchEveSpec).toHaveBeenCalledWith(CHAT_TOKEN)
    expect(Object.keys(turn!).sort()).toEqual(['create_email_draft', 'revise_email_draft'])
    await turn!.create_email_draft.execute({ to: ['a@b.co'] })
    expect(dispatchWorkspaceTool).toHaveBeenCalledWith('create_email_draft', CHAT_TOKEN, { to: ['a@b.co'] })
  })

  it('a resumed run’s turn re-resolves from its fresh token too', async () => {
    fetchEveSpec.mockResolvedValue(spec(['list_actions']))
    const turn = await tools.events['turn.started']({}, auth(RESUME_TOKEN))
    await turn!.list_actions.execute({})
    expect(dispatchWorkspaceTool).toHaveBeenCalledWith('list_actions', RESUME_TOKEN, {})
  })

  it('the run’s own turn fetches nothing and keeps its session tools (null)', async () => {
    fetchEveSpec.mockResolvedValue(spec(['list_actions']))
    expect(await tools.events['turn.started']({}, auth(RUN_TOKEN))).toBeNull()
    expect(await tools.events['turn.started']({}, auth(''))).toBeNull()
    expect(await tools.events['turn.started']({}, auth(token({ chat: 'yes' })))).toBeNull()
    expect(fetchEveSpec).not.toHaveBeenCalled()
    const session = await tools.events['session.started']({}, auth(RUN_TOKEN))
    expect(fetchEveSpec).toHaveBeenCalledWith(RUN_TOKEN)
    expect(Object.keys(session!)).toEqual(['list_actions'])
  })
})

describe('a session that starts on a chat turn (a run chat reopened after its session expired)', () => {
  it('holds no session tools: each turn gets its own, from its own token, so the first turn’s never carry over', async () => {
    fetchEveSpec.mockImplementation(async () => spec(['create_email_draft', 'list_bot_work']))
    expect(await tools.events['session.started']({}, auth(CHAT_TOKEN))).toBeNull()
    expect(fetchEveSpec).not.toHaveBeenCalled()

    const turn = await tools.events['turn.started']({}, auth(CHAT_TOKEN))
    await turn!.list_bot_work.execute({})
    expect(dispatchWorkspaceTool).toHaveBeenCalledWith('list_bot_work', CHAT_TOKEN, {})
  })

  it('so does one the main agent’s relay reopened (chat and relay claims): its unattended mark never becomes the session’s', async () => {
    const RELAY_TOKEN = token({ agentRunId: 'r-1', workspaceId: 'ws-1', userId: 'u-1', exp: 4, chat: true, relay: true })
    fetchEveSpec.mockResolvedValue(spec(['create_email_draft']))
    expect(await tools.events['session.started']({}, auth(RELAY_TOKEN))).toBeNull()
    expect(fetchEveSpec).not.toHaveBeenCalled()

    // The relayed turn resolves its own, from the relay's token; the person's next turn from theirs.
    const relayed = await tools.events['turn.started']({}, auth(RELAY_TOKEN))
    await relayed!.create_email_draft.execute({})
    expect(dispatchWorkspaceTool).toHaveBeenLastCalledWith('create_email_draft', RELAY_TOKEN, {})
    const next = await tools.events['turn.started']({}, auth(CHAT_TOKEN))
    await next!.create_email_draft.execute({})
    expect(dispatchWorkspaceTool).toHaveBeenLastCalledWith('create_email_draft', CHAT_TOKEN, {})
  })

  it('a run’s own session (its dispatch token) and a resume still resolve their session tools', async () => {
    fetchEveSpec.mockResolvedValue(spec(['list_actions']))
    expect(Object.keys((await tools.events['session.started']({}, auth(RUN_TOKEN)))!)).toEqual(['list_actions'])
    expect(Object.keys((await tools.events['session.started']({}, auth(RESUME_TOKEN)))!)).toEqual(['list_actions'])
  })
})

describe('isChatTurnRunToken', () => {
  it('a literal chat claim only: a resume, a run’s own token or anything malformed is not one', async () => {
    const { isChatTurnRunToken } = await import('../spec-client')
    expect(isChatTurnRunToken(CHAT_TOKEN)).toBe(true)
    expect(isChatTurnRunToken(RESUME_TOKEN)).toBe(false)
    expect(isChatTurnRunToken(RUN_TOKEN)).toBe(false)
    expect(isChatTurnRunToken(token({ chat: 'yes' }))).toBe(false)
    expect(isChatTurnRunToken('')).toBe(false)
    expect(isChatTurnRunToken('%%%.sig')).toBe(false)
  })
})

describe('isLaterTurnRunToken', () => {
  it('reads a literal chat or resume claim off the payload, and nothing else counts', async () => {
    const { isLaterTurnRunToken } = await import('../spec-client')
    expect(isLaterTurnRunToken(CHAT_TOKEN)).toBe(true)
    expect(isLaterTurnRunToken(RESUME_TOKEN)).toBe(true)
    expect(isLaterTurnRunToken(RUN_TOKEN)).toBe(false)
    expect(isLaterTurnRunToken(token({ chat: { teammateId: 'x' } }))).toBe(false)
    expect(isLaterTurnRunToken('')).toBe(false)
    expect(isLaterTurnRunToken('%%%.sig')).toBe(false)
  })
})
