// @vitest-environment jsdom
/**
 * The agents' page-wide host (agent-infra-host.tsx), mounted once beside the
 * main chat where the bot crew was. It draws nothing, and:
 *
 *   • publishes who wears what for the notices (notice-faces.ts), off the roster;
 *   • hands the voice crew the faces the drawn teammates wear, in crew order,
 *     each once (no unreachable teammate's, no area face's), with the voices
 *     their teammates chose, and nobody once it's gone;
 *   • publishes the cards' picker lookup for the page, and takes it back on
 *     unmount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BOT_CHARACTER_ORDER } from '@/lib/bots/teammate-faces'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  roster: [] as Array<Record<string, unknown>>,
  get: vi.fn(() => null),
  wanted: [] as string[][],
}))

vi.mock('@/components/work/agent-work-provider', () => ({
  useAgentWorkShared: () => ({ work: { roster: hoisted.roster } }),
}))
vi.mock('@/hooks/use-rail-picker-data', () => ({
  useRailPickerData: (ids: string[]) => {
    hoisted.wanted.push(ids)
    return { get: hoisted.get }
  },
}))

import { AgentInfraHost, rosterFaces } from '../agent-infra-host'
import { __resetNoticeFacesForTests, noticeFaceOf } from '@/lib/bots/notice-faces'
import { __resetBotVoicesForTests, readBotVoiceChoices, readBotVoiceCrew } from '@/lib/bots/bot-voice'
import { __resetCardPickersForTests, useCardPickers, type CardPickerLookup } from '@/lib/bots/card-pickers'

const [FIRST, SECOND, THIRD] = BOT_CHARACTER_ORDER.filter((f) => f !== 'chat')

const mate = (id: string, face: string | null, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  workspace_id: 'ws-1',
  is_system: false,
  system_key: null,
  bot_character: face,
  reachable: true,
  ...over,
})

let container: HTMLDivElement
let root: Root
let lookup: CardPickerLookup | null = null

function Probe() {
  lookup = useCardPickers(['ws-1'])
  return null
}

beforeEach(() => {
  __resetNoticeFacesForTests()
  __resetBotVoicesForTests()
  __resetCardPickersForTests()
  hoisted.wanted = []
  hoisted.get.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('rosterFaces', () => {
  it('the faces the drawn teammates wear, in crew order, each once', () => {
    const roster = [
      mate('c', THIRD),
      mate('a', FIRST),
      mate('a2', FIRST, { workspace_id: 'ws-2' }),
      mate('hidden', SECOND, { reachable: false }),
      mate('faceless', null),
    ]
    expect(rosterFaces(roster)).toEqual([FIRST, THIRD])
  })
})

describe('AgentInfraHost', () => {
  it('publishes the notices’ faces and the voice crew, and the card pickers, drawing nothing', async () => {
    hoisted.roster = [mate('tm-b', SECOND, { voice: 'voice-1' }), mate('tm-a', FIRST)]
    await act(async () => root.render(h('div', null, h(AgentInfraHost), h(Probe))))
    expect(container.textContent).toBe('')
    expect(noticeFaceOf('tm-b')).toBe(SECOND)
    expect(readBotVoiceCrew()).toEqual([FIRST, SECOND])
    expect(readBotVoiceChoices().get(SECOND)).toEqual(['voice-1'])
    // A card host names its workspace; the host loads it and publishes the lookup.
    expect(hoisted.wanted.at(-1)).toEqual(['ws-1'])
    lookup!('ws-1')
    expect(hoisted.get).toHaveBeenCalledWith('ws-1')
  })

  it('gone, the crew is nobody and the pickers are taken back', async () => {
    hoisted.roster = [mate('tm-a', FIRST)]
    await act(async () => root.render(h('div', null, h(AgentInfraHost), h(Probe))))
    expect(readBotVoiceCrew()).toEqual([FIRST])
    await act(async () => root.render(h('div', null, h(Probe))))
    expect(readBotVoiceCrew()).toEqual([])
    expect(lookup!('ws-1')).toBeNull()
  })
})
