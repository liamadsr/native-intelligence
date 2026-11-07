// @vitest-environment jsdom
/**
 * A card's history (card-history.tsx): the steps Back and Forward walk inside
 * one card. A navigation drops Forward, the steps are capped like a window's
 * (50), one event's moves are one step, and each channel a page reads (its
 * place, the mail folder and thread, a record over it) follows the cursor and
 * is kept with the card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'

const mail = vi.hoisted(() => ({ card: null as null | Record<string, unknown> }))
vi.mock('@/components/email/email-layout', () => ({
  EmailLayout: ({ card }: { card: Record<string, unknown> }) => {
    mail.card = card
    return null
  },
}))
vi.mock('../card-body', () => ({
  CardRecordPanel: ({ record }: { record: { type: string; id: string } }) => React.createElement('div', { 'data-record-panel': `${record.type}:${record.id}` }),
}))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceEdition: () => ({ views: [], extraAllowedViews: [] }), useWorkspaceId: () => 'ws-1' }))

import { CardHistory, CardHistoryProvider, MAX_CARD_HISTORY } from '../card-history'
import { usePagePlace } from '../pages/page-card'
import { RecordOverlay } from '../pages/record-overlay'
import MailCardBody from '../mail-card-body'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import type { MailCardSpec } from '@/lib/chat-cards/kinds'
import type { MailCardState } from '@/components/email/email-layout'

/** Lets the same-event merge window close (a later click is a step of its own). */
const nextTask = () => new Promise((r) => setTimeout(r, 0))

describe('CardHistory', () => {
  it('walks back and forward, and a new step drops Forward', async () => {
    const history = new CardHistory()
    expect(history.read('open', () => null)).toBeNull()
    history.push('open', 'a')
    await nextTask()
    history.push('open', 'b')
    await nextTask()
    expect([history.canGoBack, history.canGoForward]).toEqual([true, false])
    history.go(-1)
    expect(history.read('open', () => null)).toBe('a')
    history.go(-1)
    expect(history.read('open', () => null)).toBeNull()
    expect(history.go(-1)).toBe(false)
    history.go(1)
    expect(history.read('open', () => null)).toBe('a')
    expect(history.canGoForward).toBe(true)
    history.push('open', 'c')
    expect(history.canGoForward).toBe(false)
    expect(history.length).toBe(3)
  })

  it('makes one step of one event’s moves, and none of a move to where it is', async () => {
    const history = new CardHistory()
    history.read('place', () => ({ at: null }))
    history.read('suite', () => null)
    history.push('suite', 's1')
    history.push('place', { at: 's1' })
    await nextTask()
    expect(history.length).toBe(2)
    history.push('place', { at: 's1' })
    expect(history.length).toBe(2)
    history.go(-1)
    expect([history.read('suite', () => 'x'), history.read('place', () => 'x')]).toEqual([null, { at: null }])
  })

  it('seeds a channel read late with its first value in the steps before it', async () => {
    const history = new CardHistory()
    history.push('open', 'a')
    await nextTask()
    expect(history.read('tab', () => 'agents')).toBe('agents')
    history.go(-1)
    expect(history.read('tab', () => 'never')).toBe('agents')
  })

  it('keeps the newest 50 steps', async () => {
    const history = new CardHistory()
    history.read('open', () => 0)
    for (let i = 1; i <= MAX_CARD_HISTORY + 10; i++) {
      history.push('open', i)
      await nextTask()
    }
    expect(history.length).toBe(MAX_CARD_HISTORY)
    let steps = 0
    while (history.go(-1)) steps++
    expect(steps).toBe(MAX_CARD_HISTORY - 1)
    expect(history.read('open', () => -1)).toBe(11)
  })
})

const pageSpec = { kind: 'sequences', title: 'Sequences' } as PageCardSpec

describe('a page card’s place in the card’s history', () => {
  let mount: ReturnType<typeof mountRoot>
  beforeEach(() => {
    window.localStorage.clear()
    mount = mountRoot()
  })
  afterEach(() => mount.unmount())

  it('steps back and forward through places and tabs, kept with the card, and a new place drops Forward', async () => {
    const store = makeStore('p1', pageSpec)
    const history = new CardHistory()
    const probe: { place: ReturnType<typeof usePagePlace> | null } = { place: null }
    function Probe() {
      const place = usePagePlace({ toolCallId: 'p1', spec: pageSpec, store, fullScreen: false })
      React.useEffect(() => {
        probe.place = place
      })
      return null
    }
    await mount.render(React.createElement(CardHistoryProvider, { value: history }, React.createElement(Probe)))
    const at = () => probe.place!.at?.id ?? null
    await act(async () => probe.place!.go({ type: 'sequence', id: 'seq-1', label: 'Onboarding' }))
    await act(nextTask)
    await act(async () => probe.place!.go({ type: 'sequence', id: 'seq-2', label: 'Renewals' }))
    await act(nextTask)
    await act(async () => probe.place!.setTab('steps'))
    await act(nextTask)
    expect([at(), probe.place!.tab]).toEqual(['seq-2', 'steps'])

    await act(async () => void history.go(-1))
    expect([at(), probe.place!.tab]).toEqual(['seq-2', undefined])
    await act(async () => void history.go(-1))
    expect(at()).toBe('seq-1')
    expect(store.state('p1').at).toMatchObject({ id: 'seq-1' })
    await act(async () => void history.go(-1))
    expect(at()).toBeNull()
    expect(store.state('p1').at).toBeNull()
    await act(async () => void history.go(1))
    expect(at()).toBe('seq-1')

    await act(async () => probe.place!.go({ type: 'sequence', id: 'seq-3' }))
    expect(history.canGoForward).toBe(false)
    await act(async () => void history.go(-1))
    expect(at()).toBe('seq-1')
  })

  it('a place written into the store from outside is a step of its own', async () => {
    const store = makeStore('p1', pageSpec)
    const history = new CardHistory()
    const probe: { place: ReturnType<typeof usePagePlace> | null } = { place: null }
    function Probe() {
      const place = usePagePlace({ toolCallId: 'p1', spec: pageSpec, store, fullScreen: false })
      React.useEffect(() => {
        probe.place = place
      })
      return null
    }
    await mount.render(React.createElement(CardHistoryProvider, { value: history }, React.createElement(Probe)))
    // As chat-panel openCardHere does: the seed, then the card brought full screen.
    await act(async () => {
      store.update('p1', { at: { type: 'sequence', id: 'seq-9' } }, { touch: true })
      store.enterFullScreen('p1')
    })
    expect(probe.place!.at?.id).toBe('seq-9')
    await act(async () => void history.go(-1))
    expect(probe.place!.at).toBeNull()
  })

  it('draws no Back row over a record opened on the page', async () => {
    const store = makeStore('p1', pageSpec)
    const records = { current: { type: 'project' as const, id: 'pr-1', label: 'Launch' }, open: () => {}, close: () => {} }
    await mount.render(React.createElement(RecordOverlay, { records, page: { toolCallId: 'p1', spec: pageSpec, store, fullScreen: false } }))
    expect(mount.container.querySelector('[data-record-panel]')?.getAttribute('data-record-panel')).toBe('project:pr-1')
    expect(mount.container.textContent).not.toMatch(/Back/)
    expect(mount.container.querySelectorAll('button')).toHaveLength(0)
  })
})

describe('a mail card’s folder and thread in the card’s history', () => {
  let mount: ReturnType<typeof mountRoot>
  beforeEach(() => {
    window.localStorage.clear()
    mount = mountRoot()
  })
  afterEach(() => mount.unmount())

  it('steps back through a thread and a folder, the layout told where to go', async () => {
    const spec = { kind: 'mail', title: 'Inbox', mail: { folder: 'inbox' } } as MailCardSpec
    const store = makeStore('m1', spec)
    const history = new CardHistory()
    await mount.render(
      React.createElement(CardHistoryProvider, { value: history }, React.createElement(MailCardBody, { toolCallId: 'm1', spec, store, fullScreen: false })),
    )
    const report = (state: Partial<MailCardState>) =>
      (mail.card!.onStateChange as (s: MailCardState) => void)({ folder: 'inbox', search: '', accounts: null, threadId: null, ...state })
    expect(mail.card!.place).toEqual({ folder: 'inbox', threadId: null })
    await act(async () => report({ folder: 'sent' }))
    await act(nextTask)
    await act(async () => report({ folder: 'sent', threadId: 't-1', threadFrom: 'Sarah' }))
    await act(nextTask)
    // A search is not a step.
    await act(async () => report({ folder: 'sent', threadId: 't-1', search: 'pricing' }))
    await act(nextTask)
    expect(history.length).toBe(3)

    await act(async () => void history.go(-1))
    expect(mail.card!.place).toEqual({ folder: 'sent', threadId: null })
    await act(async () => void history.go(-1))
    expect(mail.card!.place).toEqual({ folder: 'inbox', threadId: null })
    await act(async () => void history.go(1))
    await act(async () => void history.go(1))
    expect(mail.card!.place).toEqual({ folder: 'sent', threadId: 't-1' })
  })
})
