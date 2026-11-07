// @vitest-environment jsdom
/**
 * eve's session-limit prompt in the chat (session-limit-card.tsx): what it
 * reads off the prompt's input, Continue / Stop through the chat panel's
 * answer, the line an answered prompt leaves, and its place in the tool
 * renderers (in every state, so it never sits as a "Running…" chip).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'
import {
  OpenSessionLimitContext,
  SESSION_LIMIT_TOOL_NAME,
  SessionLimitCard,
  openSessionLimitCallId,
  openSessionLimitOf,
  continuesOnItsOwn,
  sessionLimitBudget,
  sessionLimitChoiceOf,
  sessionLimitFromInput,
} from '../session-limit-card'
import { MessageInteractionsContext, type MessageInteractions } from '../message-interactions'
import { rendererFor, type ToolRenderContext } from '../tool-renderers'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const INPUT = { kind: 'input', limit: 40_000_000, usedTokens: 40_044_247 }

describe('reading the prompt', () => {
  it('reads a token budget and a spend budget off the input, and nothing off anything else', () => {
    expect(sessionLimitFromInput(INPUT)).toEqual({ kind: 'input', limit: 40_000_000, used: 40_044_247 })
    expect(sessionLimitFromInput({ kind: 'output', limit: 150_000, usedTokens: 151_000 })).toEqual({ kind: 'output', limit: 150_000, used: 151_000 })
    expect(sessionLimitFromInput({ kind: 'token-cost', limitUsd: 5, usedCostUsd: 5.2 })).toEqual({ kind: 'token-cost', limitUsd: 5, usedUsd: 5.2 })
    expect(sessionLimitFromInput({ kind: 'input', limit: '40M' })).toBeNull()
    expect(sessionLimitFromInput(null)).toBeNull()
  })

  it('names the budget', () => {
    expect(sessionLimitBudget({ kind: 'input', limit: 40_000_000, used: 1 })).toBe('40M input tokens')
    expect(sessionLimitBudget({ kind: 'output', limit: 150_000, used: 1 })).toBe('150k output tokens')
    expect(sessionLimitBudget({ kind: 'token-cost', limitUsd: 5, usedUsd: 1 })).toBe('$5.00 of model spend')
  })

  it('an answered part is a Stop when it records a dismissal, else a Continue', () => {
    expect(sessionLimitChoiceOf({ response: 'stop' })).toBe('stop')
    expect(sessionLimitChoiceOf({ answers: {} })).toBe('continue')
    expect(sessionLimitChoiceOf(undefined)).toBe('continue')
  })
})

describe('openSessionLimitCallId: only the prompt still holding the session can be answered', () => {
  const prompt = (id: string, state = 'input-available') => ({ type: 'dynamic-tool', toolName: SESSION_LIMIT_TOOL_NAME, toolCallId: id, state })
  const text = { type: 'text' }
  const reply = (id: string, ...parts: Array<{ type: string }>) => ({ id, role: 'assistant', parts: parts.length ? parts : [text] })
  const asked = (id: string) => ({ id, role: 'user', parts: [text] })

  it('finds the waiting prompt, with the person’s queued messages after it', () => {
    expect(openSessionLimitCallId([asked('u1'), reply('eve-msg-1', text, prompt('p1'))])).toBe('p1')
    expect(openSessionLimitCallId([reply('eve-msg-1', prompt('p1')), asked('u2'), asked('u3')])).toBe('p1')
  })

  it('PROD 10-27: agents’ reports written into the thread after it don’t hide it', () => {
    const thread = [
      reply('eve-msg-1', prompt('p1')),
      asked('u1'),
      reply('teammate-report-abc', text, { type: 'data-teammate-report' }),
      asked('u2'),
      reply('guest-answer:ask-1'),
      reply('teammate-report-def', text, { type: 'data-teammate-report' }),
    ]
    expect(openSessionLimitCallId(thread)).toBe('p1')
  })

  it('a reply from a later turn (the chat’s, or a home turn’s) means it was answered', () => {
    expect(openSessionLimitCallId([reply('eve-msg-1', prompt('p1')), asked('u1'), reply('eve-msg-2')])).toBeNull()
    expect(openSessionLimitCallId([reply('eve-msg-1', prompt('p1')), reply('home-turn:row-9')])).toBeNull()
  })

  it('only the newest prompt: an older one, an answered one, or none at all is not open', () => {
    expect(openSessionLimitCallId([reply('eve-msg-1', prompt('p1')), asked('u1'), reply('eve-msg-2', prompt('p2'))])).toBe('p2')
    expect(openSessionLimitCallId([reply('eve-msg-1', prompt('p1', 'output-available')), asked('u1')])).toBeNull()
    expect(openSessionLimitCallId([reply('eve-msg-1', prompt('p1')), reply('eve-msg-2', prompt('p2', 'output-available'))])).toBeNull()
    expect(openSessionLimitCallId([asked('u1')])).toBeNull()
    expect(openSessionLimitCallId([])).toBeNull()
  })

  it('says which budget the open prompt hit; only eve’s input budget continues on its own', () => {
    const withInput = (input: unknown) => [reply('eve-msg-1', { ...prompt('p1'), input } as never)]
    const open = openSessionLimitOf(withInput({ kind: 'input', limit: 40_000_000, usedTokens: 40_000_100 }))
    expect(open).toEqual({ toolCallId: 'p1', limit: { kind: 'input', limit: 40_000_000, used: 40_000_100 } })
    expect(continuesOnItsOwn(open!.limit)).toBe(true)
    expect(continuesOnItsOwn(openSessionLimitOf(withInput({ kind: 'output', limit: 150_000, usedTokens: 150_100 }))!.limit)).toBe(false)
    expect(continuesOnItsOwn(openSessionLimitOf(withInput({ kind: 'token-cost', limitUsd: 5, usedCostUsd: 5.1 }))!.limit)).toBe(false)
    expect(continuesOnItsOwn(null)).toBe(false)
  })

  it('the prefixes it reads are the ones the writers use', async () => {
    const { HOME_TURN_ID_PREFIX, homeTurnMessageId } = await import('@/lib/chat/home-turn')
    const { EVE_REPLY_ID_PREFIX } = await import('@/lib/chat/eve-turn-parts')
    expect(homeTurnMessageId('row-9').startsWith(HOME_TURN_ID_PREFIX)).toBe(true)
    expect(EVE_REPLY_ID_PREFIX).toBe('eve-msg-')
  })
})

describe('SessionLimitCard', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function withPanel(node: ReactNode, answerSessionLimit?: MessageInteractions['answerSessionLimit'], openId: string | null = 'call-1', continuing = false) {
    const value: MessageInteractions = { reply: () => {}, react: () => {}, reactions: null, answerSessionLimit }
    return h(MessageInteractionsContext.Provider, { value }, h(OpenSessionLimitContext.Provider, { value: openId ? { toolCallId: openId, continuing } : null }, node))
  }
  const button = (action: string) => container.querySelector<HTMLButtonElement>(`[data-session-limit-action="${action}"]`)

  it('the open prompt offers Continue and Stop, answered through the chat panel, and waits while it goes', async () => {
    let settle: (taken: boolean) => void = () => {}
    const answer = vi.fn(() => new Promise<boolean>((r) => { settle = r }))
    const card = h(SessionLimitCard, { toolCallId: 'call-1', limit: sessionLimitFromInput(INPUT), answered: null })
    act(() => root.render(withPanel(card, answer)))
    expect(container.textContent).toContain('Paused at 40M input tokens')
    act(() => button('continue')!.click())
    expect(answer.mock.calls).toEqual([['call-1', 'continue']])
    expect(button('continue')!.textContent).toBe('Continuing…')
    expect(button('stop')!.disabled).toBe(true)
    act(() => button('stop')!.click())
    expect(answer).toHaveBeenCalledTimes(1)
    // It didn't go (a failed respond, a usage block): the buttons come back.
    await act(async () => settle(false))
    expect(button('continue')!.textContent).toBe('Continue')
    act(() => button('stop')!.click())
    expect(answer.mock.calls[1]).toEqual(['call-1', 'stop'])
  })

  it('while the chat continues it on its own: one line, no buttons to race it', () => {
    const card = h(SessionLimitCard, { toolCallId: 'call-1', limit: sessionLimitFromInput(INPUT), answered: null })
    act(() => root.render(withPanel(card, vi.fn(async () => true), 'call-1', true)))
    expect(container.textContent).toBe('Continuing past 40M input tokens…')
    expect(button('continue')).toBeNull()
    expect(button('stop')).toBeNull()
  })

  it('a prompt that is not the newest reply’s is history: no buttons, so nothing stray reaches the agent', () => {
    const card = h(SessionLimitCard, { toolCallId: 'call-1', limit: sessionLimitFromInput(INPUT), answered: null })
    act(() => root.render(withPanel(card, vi.fn(async () => true), 'another-call')))
    expect(container.textContent).toBe('Paused at 40M input tokens')
    expect(button('continue')).toBeNull()
  })

  it('a host that cannot answer says what to type instead, with no buttons', () => {
    act(() => root.render(h(SessionLimitCard, { toolCallId: 'call-1', limit: null, answered: null })))
    expect(container.textContent).toContain('Send “continue”')
    expect(button('continue')).toBeNull()
  })

  it('an answered prompt leaves one line saying which', () => {
    const limit = sessionLimitFromInput(INPUT)
    act(() => root.render(withPanel(h(SessionLimitCard, { toolCallId: 'c', limit, answered: 'continue' }), vi.fn(async () => true), 'c')))
    expect(container.textContent).toBe('Continued past 40M input tokens')
    act(() => root.render(withPanel(h(SessionLimitCard, { toolCallId: 'c', limit, answered: 'stop' }), vi.fn(async () => true), 'c')))
    expect(container.textContent).toBe('Stopped at 40M input tokens')
    expect(button('continue')).toBeNull()
  })
})

describe('the chat renders it for session_limit_continuation', () => {
  const ctx = (state: ToolRenderContext['state'], part: Record<string, unknown>) =>
    ({ part: { type: 'dynamic-tool', toolName: SESSION_LIMIT_TOOL_NAME, toolCallId: 'c', input: INPUT, ...part }, toolName: SESSION_LIMIT_TOOL_NAME, toolCallId: 'c', state }) as unknown as ToolRenderContext

  it('draws the card while the prompt waits and once answered; a failed turn falls through to the generic chip', () => {
    const entry = rendererFor(SESSION_LIMIT_TOOL_NAME)
    expect(entry).toBeDefined()
    expect(entry!.render(ctx('call', { state: 'input-available' }))).toBeTruthy()
    expect(entry!.render(ctx('result', { state: 'output-available', output: { response: 'stop' } }))).toBeTruthy()
    expect(entry!.render(ctx('error', { state: 'output-error', errorText: 'x' }))).toBeUndefined()
  })
})
