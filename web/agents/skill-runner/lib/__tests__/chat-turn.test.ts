import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EveSpec } from '../spec-client'

/**
 * Bots v3 Phase 4 — a parked skill-run session carries on as a follow-up chat,
 * one turn at a time, each under a FRESH run token the chat route mints.
 *
 *   1. The tools resolver re-resolves on `turn.started` for a CHAT token only
 *      (its claims carry `chat`): the proxies a chat turn mints carry that
 *      turn's token (the run's own expired with its wall), advertise that
 *      token's spec (the bot's chat ceiling, not the run's), and shadow the
 *      run's other tools (eve keeps session tools under a turn's). A run's own
 *      turn fetches nothing and returns null, so its session tools stand: no
 *      second fetch that could fail and strip the run's tools.
 *   2. The chat-turn instructions resolver returns the spec's `chatTurn`
 *      instructions on a chat turn, and fetches nothing on a run's own turn.
 */
const fetchEveSpec = vi.fn<(t: string) => Promise<EveSpec | null>>()
const dispatchWorkspaceTool = vi.fn<(name: string, token: string, input: unknown) => Promise<unknown>>(async () => ({ ok: true }))

vi.mock('../spec-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../spec-client')>()),
  fetchEveSpec: (t: string) => fetchEveSpec(t),
  dispatchWorkspaceTool: (name: string, token: string, input: unknown) => dispatchWorkspaceTool(name, token, input),
}))

import workspaceTools from '../../tools/workspace_tools'
import chatTurn from '../../instructions/chat_turn'

type ToolFn = { execute: (i: unknown) => unknown }
type Ctx = { session: { auth: unknown } }
type Resolver<T> = { events: Record<string, (e: unknown, ctx: Ctx) => Promise<T>> }

const auth = (runToken: string): Ctx => ({ session: { auth: { current: { attributes: { runToken } } } } })
/** A token shaped as the app mints them (payload.signature); the signature is never checked here. */
const token = (claims: Record<string, unknown>) => `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.sig`
const RUN_TOKEN = token({ workspaceId: 'ws-1', skillId: 's-1', exp: 1 })
const CHAT_TOKEN = token({ workspaceId: 'ws-1', skillId: 's-1', exp: 1, chat: { teammateId: 'tm-1' } })

function spec(over: Partial<EveSpec> = {}): EveSpec {
  return {
    systemPrompt: 'p',
    model: 'anthropic/claude-haiku-4-5',
    mode: 'act',
    outputContract: 'verdict',
    ceiling: ['list_actions'],
    ceilingTools: [{ name: 'list_actions', description: 'List actions' }],
    webAccess: true,
    ...over,
  }
}

beforeEach(() => {
  fetchEveSpec.mockReset()
  dispatchWorkspaceTool.mockClear()
})

describe('tools re-resolve per turn from the current token', () => {
  const tools = workspaceTools as unknown as Resolver<Record<string, ToolFn> | null>

  it('declares a turn.started resolver beside session.started', () => {
    expect(typeof tools.events['session.started']).toBe('function')
    expect(typeof tools.events['turn.started']).toBe('function')
  })

  it('a chat turn advertises its own token’s spec, and its proxies carry that token', async () => {
    fetchEveSpec.mockImplementation(async (t) =>
      t === CHAT_TOKEN ? spec({ ceilingTools: [{ name: 'get_document', description: 'Read a document' }] }) : spec(),
    )
    const turn = await tools.events['turn.started']({}, auth(CHAT_TOKEN))
    expect(fetchEveSpec).toHaveBeenCalledWith(CHAT_TOKEN)
    expect(Object.keys(turn!)).toEqual(['get_document'])
    await turn!.get_document.execute({ id: 'd1' })
    expect(dispatchWorkspaceTool).toHaveBeenCalledWith('get_document', CHAT_TOKEN, { id: 'd1' })
  })

  it('a chat turn shadows the run’s tools it may not use with refusal stubs that dispatch nothing', async () => {
    fetchEveSpec.mockResolvedValue(
      spec({
        ceilingTools: [{ name: 'get_document', description: 'Read a document' }],
        chatTurn: { instructions: 'x', shadowTools: ['create_action', 'update_action', 'web_search'] },
      }),
    )
    const turn = await tools.events['turn.started']({}, auth(CHAT_TOKEN))
    expect(Object.keys(turn!).sort()).toEqual(['create_action', 'get_document', 'update_action'])
    expect(await turn!.create_action.execute({ title: 'x' })).toEqual({ error: 'This tool is not available in this chat.' })
    expect(dispatchWorkspaceTool).not.toHaveBeenCalled()
  })

  it('a run’s own turn fetches nothing and keeps its session tools (null)', async () => {
    fetchEveSpec.mockResolvedValue(spec())
    expect(await tools.events['turn.started']({}, auth(RUN_TOKEN))).toBeNull()
    expect(await tools.events['turn.started']({}, auth(''))).toBeNull()
    expect(await tools.events['turn.started']({}, auth('not-a-token'))).toBeNull()
    expect(fetchEveSpec).not.toHaveBeenCalled()
    // The session still resolves the run's tools from its token.
    const session = await tools.events['session.started']({}, auth(RUN_TOKEN))
    expect(fetchEveSpec).toHaveBeenCalledWith(RUN_TOKEN)
    expect(Object.keys(session!)).toEqual(['list_actions'])
  })
})

describe('a session that starts on a chat turn (a loop run’s chat reopened after its session expired)', () => {
  const tools = workspaceTools as unknown as Resolver<Record<string, ToolFn> | null>
  const RELAY_TOKEN = token({ workspaceId: 'ws-1', skillId: 's-1', exp: 2, chat: { teammateId: 'tm-1', relay: true } })

  it('holds no session tools: each turn gets its own, from its own token, so the first turn’s never carry over', async () => {
    fetchEveSpec.mockImplementation(async (t) =>
      spec({ ceilingTools: [{ name: t === RELAY_TOKEN ? 'list_actions' : 'list_bot_work', description: 'x' }] }),
    )
    expect(await tools.events['session.started']({}, auth(CHAT_TOKEN))).toBeNull()
    expect(await tools.events['session.started']({}, auth(RELAY_TOKEN))).toBeNull()
    expect(fetchEveSpec).not.toHaveBeenCalled()

    // The person's turn, then one the main agent relayed: each turn's tools are its own token's.
    const person = await tools.events['turn.started']({}, auth(CHAT_TOKEN))
    await person!.list_bot_work.execute({})
    expect(dispatchWorkspaceTool).toHaveBeenLastCalledWith('list_bot_work', CHAT_TOKEN, {})
    const relayed = await tools.events['turn.started']({}, auth(RELAY_TOKEN))
    expect(Object.keys(relayed!)).toEqual(['list_actions'])
    await relayed!.list_actions.execute({})
    expect(dispatchWorkspaceTool).toHaveBeenLastCalledWith('list_actions', RELAY_TOKEN, {})
  })
})

describe('isChatRunToken', () => {
  it('reads the chat claim off the payload, and nothing else counts', async () => {
    const { isChatRunToken } = await import('../spec-client')
    expect(isChatRunToken(CHAT_TOKEN)).toBe(true)
    expect(isChatRunToken(RUN_TOKEN)).toBe(false)
    expect(isChatRunToken(token({ chat: { teammateId: '' } }))).toBe(false)
    expect(isChatRunToken(token({ chat: true }))).toBe(false)
    expect(isChatRunToken('')).toBe(false)
    expect(isChatRunToken('%%%.sig')).toBe(false)
  })
})

describe('chat-turn instructions', () => {
  const instructions = chatTurn as unknown as Resolver<unknown>

  it('only resolves on turn.started', () => {
    expect(Object.keys(instructions.events)).toEqual(['turn.started'])
  })

  it('a chat turn gets the spec’s chat instructions', async () => {
    fetchEveSpec.mockResolvedValue(spec({ chatTurn: { instructions: '## This turn is a follow-up chat' } }))
    const out = await instructions.events['turn.started']({}, auth(CHAT_TOKEN))
    expect(JSON.stringify(out)).toContain('This turn is a follow-up chat')
  })

  it('a run’s own turn fetches nothing; a chat turn with no spec contributes nothing', async () => {
    fetchEveSpec.mockResolvedValue(spec())
    expect(await instructions.events['turn.started']({}, auth(RUN_TOKEN))).toBeNull()
    expect(fetchEveSpec).not.toHaveBeenCalled()
    fetchEveSpec.mockResolvedValue(null)
    expect(await instructions.events['turn.started']({}, auth(CHAT_TOKEN))).toBeNull()
  })
})
