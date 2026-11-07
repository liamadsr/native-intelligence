// @vitest-environment jsdom
/**
 * Customize's seam (agent-editor-seam.tsx): the one agent editor (Phase B1)
 * on a bot, in its own workspace.
 *
 *   • which kind a bot is: built on a custom agent, a loop's work bot, a
 *     system teammate, else a teammate in a role;
 *   • `open` shows the editor on the bot (`teammateId`), in the bot's own
 *     workspace even when another is on screen, for every kind of bot: there
 *     is nowhere else to go now;
 *   • closing it takes it away; nothing renders until it's opened, or before
 *     the page has loaded the bot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RosterTeammate } from '@/lib/work/agent-roster'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shared = vi.hoisted(() => ({ editors: [] as Array<Record<string, unknown>> }))
vi.mock('@/components/agents/agent-editor', () => ({
  AgentEditorDialog: (props: Record<string, unknown>) => {
    shared.editors.push(props)
    return h('div', { 'data-agent-editor': props.teammateId as string, 'data-workspace': props.workspaceId as string })
  },
}))

import { agentEditorTarget, botKind, useAgentEditor, type AgentEditorSeam, type AgentEditorTarget } from '../agent-editor-seam'

function mate(over: Partial<RosterTeammate> = {}): Pick<RosterTeammate, 'id' | 'workspace_id' | 'fronts_only' | 'is_system'> {
  return { id: 'tm-1', workspace_id: 'w1', fronts_only: false, is_system: false, ...over }
}
const NO_AGENT = { agent: null }

describe('botKind', () => {
  it('tells the four kinds apart', () => {
    expect(botKind(mate(), { id: 'a', name: 'Sales Coach' })).toBe('custom')
    // A plain member's work bot for a custom agent is a custom agent's bot.
    expect(botKind(mate({ fronts_only: true }), { id: 'a', name: 'Sales Coach' })).toBe('custom')
    expect(botKind(mate({ fronts_only: true }), null)).toBe('loop')
    expect(botKind(mate({ is_system: true }), null)).toBe('system')
    expect(botKind(mate(), null)).toBe('role')
  })
})

describe('agentEditorTarget', () => {
  it('is the bot, in its own workspace, with its kind', () => {
    expect(agentEditorTarget(mate({ workspace_id: 'w2' }), { agent: { id: 'agent-1', name: 'Sales Coach' } })).toEqual({
      teammateId: 'tm-1',
      workspaceId: 'w2',
      kind: 'custom',
    })
  })
})

describe('useAgentEditor', () => {
  let container: HTMLDivElement
  let root: Root
  let seam: AgentEditorSeam | null = null
  function Harness({ target }: { target: AgentEditorTarget | null }) {
    seam = useAgentEditor(target)
    return h('div', null, seam.editor)
  }
  const shown = () => container.querySelector<HTMLElement>('[data-agent-editor]')
  beforeEach(() => {
    shared.editors = []
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows nothing until opened, then the one editor on the bot, in its own workspace', async () => {
    await act(async () => root.render(h(Harness, { target: agentEditorTarget(mate({ workspace_id: 'w2' }), NO_AGENT) })))
    expect(seam!.editor).toBeNull()
    expect(shown()).toBeNull()
    await act(async () => seam!.open())
    // The editor loads lazily.
    await act(async () => {})
    expect(shown()!.getAttribute('data-agent-editor')).toBe('tm-1')
    expect(shared.editors.at(-1)).toMatchObject({ open: true, teammateId: 'tm-1', workspaceId: 'w2' })
  })

  it('opens the same editor for every kind of bot: there is nowhere else to go', async () => {
    const kinds: Array<[Partial<RosterTeammate>, { agent: { id: string; name: string } | null }]> = [
      [{ id: 'custom' }, { agent: { id: 'agent-1', name: 'Coach' } }],
      [{ id: 'role' }, NO_AGENT],
      [{ id: 'system', is_system: true }, NO_AGENT],
      [{ id: 'loop', fronts_only: true }, NO_AGENT],
    ]
    for (const [over, about] of kinds) {
      await act(async () => root.render(h(Harness, { key: over.id, target: agentEditorTarget(mate(over), about) })))
      await act(async () => seam!.open())
      await act(async () => {})
      expect(shown()!.getAttribute('data-agent-editor')).toBe(over.id)
    }
  })

  it('closing it takes it away', async () => {
    await act(async () => root.render(h(Harness, { target: agentEditorTarget(mate(), NO_AGENT) })))
    await act(async () => seam!.open())
    await act(async () => {})
    expect(shown()).not.toBeNull()
    await act(async () => (shared.editors.at(-1)!.onClose as () => void)())
    expect(shown()).toBeNull()
    expect(seam!.editor).toBeNull()
  })

  it('does nothing before the page has loaded the bot', async () => {
    await act(async () => root.render(h(Harness, { target: null })))
    await act(async () => seam!.open())
    await act(async () => {})
    expect(shown()).toBeNull()
    expect(shared.editors).toEqual([])
  })
})
