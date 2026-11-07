// @vitest-environment jsdom
/**
 * The bots' card picker lists (bots-v4.md Phase 3, lib/bots/card-pickers.ts):
 * loaded once for the page by the agents' host (AgentInfraHost), which holds
 * the one useRailPickerData, and read by every card host (the For you column,
 * a bot's page).
 *
 *   • a host names the workspaces its cards are in while it's mounted; the
 *     agents' host loads what's named, and a host coming back fetches nothing
 *     again;
 *   • with no agents' host, every lookup is null (the pills stay read-only);
 *   • by source: only AgentInfraHost calls useRailPickerData among the bots;
 *     the card hosts read card-pickers.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useRailPickerData } from '@/hooks/use-rail-picker-data'
import {
  __resetCardPickersForTests,
  publishCardPickers,
  useCardPickers,
  useWantedCardWorkspaces,
  type CardPickerLookup,
} from '../card-pickers'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const asked: string[] = []

beforeEach(() => {
  __resetCardPickersForTests()
  asked.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      asked.push(`${url} @${(init?.headers as Record<string, string> | undefined)?.['x-workspace-id']}`)
      const ws = (init?.headers as Record<string, string>)['x-workspace-id']
      if (url === '/api/account/workspace') return new Response(JSON.stringify({ workspace: { id: ws }, members: [], aiMembers: [] }))
      return new Response(JSON.stringify({ projects: [{ id: `${ws}-p`, name: `Project of ${ws}` }] }))
    }),
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** The agents' host's half, as AgentInfraHost has it. */
function Crew() {
  const pickers = useRailPickerData(useWantedCardWorkspaces())
  useEffect(() => publishCardPickers(pickers.get), [pickers])
  useEffect(() => () => publishCardPickers(null), [])
  return null
}
/** A card host (a bubble, a bot's page): what its lookup says for `ws`. */
const seen: Record<string, CardPickerLookup> = {}
function Host({ name, workspaces }: { name: string; workspaces: string[] }) {
  const lookup = useCardPickers(workspaces)
  useEffect(() => {
    seen[name] = lookup
  })
  return null
}
const settle = () => act(async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
})

describe('card-pickers', () => {
  it('loads a workspace once for the page, whatever hosts come and go', async () => {
    await act(async () => root.render(h('div', null, h(Crew), h(Host, { name: 'bubble', workspaces: ['w1'] }))))
    await settle()
    expect(seen.bubble('w1')).toMatchObject({ loaded: true, projects: [{ id: 'w1-p' }] })
    expect(asked.filter((a) => a.startsWith('/api/account/workspace'))).toEqual(['/api/account/workspace @w1'])
    // The bubble closes, opens again, and a bot's page shows the same cards.
    await act(async () => root.render(h('div', null, h(Crew))))
    await act(async () => root.render(h('div', null, h(Crew), h(Host, { name: 'bubble', workspaces: ['w1'] }), h(Host, { name: 'page', workspaces: ['w1', 'w1'] }))))
    await settle()
    expect(seen.page('w1')?.loaded).toBe(true)
    expect(asked.filter((a) => a.startsWith('/api/account/workspace'))).toEqual(['/api/account/workspace @w1'])
    // A card in another workspace: that one, once.
    await act(async () => root.render(h('div', null, h(Crew), h(Host, { name: 'bubble', workspaces: ['w1', 'w2'] }))))
    await settle()
    expect(seen.bubble('w2')?.loaded).toBe(true)
    expect(asked.filter((a) => a.startsWith('/api/account/workspace'))).toEqual(['/api/account/workspace @w1', '/api/account/workspace @w2'])
  })

  it('with no agents’ host on the page, every lookup is null (the pills stay read-only)', async () => {
    await act(async () => root.render(h(Host, { name: 'lonely', workspaces: ['w1'] })))
    await settle()
    expect(seen.lonely('w1')).toBeNull()
    expect(asked).toEqual([])
  })

  it('by source: the agents’ host holds the one useRailPickerData; the card hosts read card-pickers.ts', () => {
    const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8')
    expect(read('components/work/agent-infra-host.tsx')).toMatch(/useRailPickerData\(useWantedCardWorkspaces\(\)\)/)
    for (const host of ['components/attention/for-you-column-panel.tsx', 'components/bots/bot-page/for-you.tsx']) {
      const source = read(host)
      expect(source).not.toMatch(/useRailPickerData/)
      expect(source).toMatch(/useCardPickers\(/)
    }
  })
})
