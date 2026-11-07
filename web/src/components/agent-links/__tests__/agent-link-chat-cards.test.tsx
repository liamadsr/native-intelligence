// @vitest-environment jsdom
/**
 * Another person's agent in the owner's chat (agent-link-chat-cards.tsx,
 * phase D):
 *
 *   • an exchange is the guest activity card, the other person's initials in
 *     its tile, and opens the two agents' conversation on it;
 *   • the line over a held card names whose agent and from where, and opens
 *     the same conversation;
 *   • both are drawn from the home thread's parts (tool-renderers.tsx).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AgentLinkActivityChip, AgentLinkLine } from '../agent-link-chat-cards'
import { dataPartRendererFor } from '@/app/account/(dashboard)/chat/tool-renderers'
import { AGENT_LINK_ACTIVITY_PART_TYPE, agentLinkActivityPartData } from '@/lib/agent-links/chat-parts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LINK = '77777777-0000-4000-8000-000000000007'
const EXCHANGE = '88888888-0000-4000-8000-000000000008'
let container: HTMLDivElement
let root: Root
async function render(node: ReturnType<typeof h>) {
  await act(async () => root.render(node))
}
async function opened(click: () => void): Promise<unknown[]> {
  const seen: unknown[] = []
  const onOpen = (e: Event) => seen.push((e as CustomEvent).detail)
  window.addEventListener('dial8:open-card', onOpen)
  await act(async () => click())
  window.removeEventListener('dial8:open-card', onOpen)
  return seen
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const activity = agentLinkActivityPartData({
  link_id: LINK,
  peer: { name: 'Dana Kim', workspace_name: 'Northwind' },
  exchange_id: EXCHANGE,
  summary: 'Told Ava you’re free Thu 2:00 and Fri 10:00',
  count: 4,
  last_at: new Date().toISOString(),
})!

describe('an exchange between the two agents', () => {
  it('is the activity card with their initials, what happened and whose agent, and opens the conversation there', async () => {
    await render(h(AgentLinkActivityChip, { data: activity }))
    const card = container.querySelector<HTMLButtonElement>(`[data-agent-link-activity="${EXCHANGE}"]`)!
    expect(card.getAttribute('data-chat-panel')).toBe('deliverable')
    expect(card.textContent).toContain('DK')
    expect(container.querySelector('[data-agent-link-activity-summary]')!.textContent).toBe(activity.summary)
    expect(container.querySelector('[data-agent-link-activity-meta]')!.textContent).toMatch(/^Dana Kim’s agent · Northwind · 4 messages · \d/)
    expect(await opened(() => card.click())).toEqual([
      expect.objectContaining({
        spec: expect.objectContaining({ kind: 'agent_link', target: { type: 'agent_link', id: LINK, label: 'Dana Kim’s agent' } }),
        seed: { at: { type: 'agent_link_exchange', id: EXCHANGE } },
        reuse: true,
      }),
    ])
  })
})

describe('the line over a held card', () => {
  it('names whose agent and from where, and opens the conversation', async () => {
    await render(h(AgentLinkLine, { link: { link_id: LINK, peer_name: 'Dana Kim', workspace_name: 'Northwind' } }))
    const line = container.querySelector<HTMLButtonElement>(`[data-agent-link-line="${LINK}"]`)!
    expect(line.textContent).toBe('DKDana Kim’s agent · Northwind')
    const seen = await opened(() => line.click())
    expect(seen).toEqual([expect.objectContaining({ spec: expect.objectContaining({ kind: 'agent_link' }), reuse: true })])
    expect((seen[0] as { seed?: unknown }).seed).toBeUndefined()
  })
})

describe('drawn from the home thread’s parts', () => {
  it('the activity part has its card, and a malformed one draws nothing', async () => {
    const entry = dataPartRendererFor(AGENT_LINK_ACTIVITY_PART_TYPE)!
    await render(h('div', null, entry.render({ type: AGENT_LINK_ACTIVITY_PART_TYPE, data: activity }, 'a'), entry.render({ type: AGENT_LINK_ACTIVITY_PART_TYPE, data: { link_id: LINK } }, 'b')))
    expect(container.querySelectorAll('[data-agent-link-activity]')).toHaveLength(1)
  })
})
