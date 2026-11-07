// @vitest-environment jsdom
/**
 * "Its agent" (flow-bot-picker.tsx, bots-v3 Phase 3): your teammates' agents
 * with what each speaks for, "A new agent for this loop" with its name field
 * (named after the first free face when left empty), the read-only built-in
 * loop, the nudge when a saved loop's agent was removed, and the loop's own
 * work agent (rename, delete). No faces: every agent wears the agent mark.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SYSTEM_TEAMMATE_BLURBS } from '@/lib/work/system-teammates'
import { FlowBotChip, FlowBotPicker, botSpeaksFor } from '../flow-bot-picker'
import { emptyEditor, type EditorState, type FlowBotOptions } from '../flow-types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let latest: EditorState

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const OPTIONS: FlowBotOptions = {
  teammates: [
    { id: 'tm-triage', name: 'Captures', bot_character: 'triage', fronts_only: false, is_system: true, system_key: 'captures', fronts: [] },
    { id: 'tm-ember', name: 'Ember', bot_character: 'ember', fronts_only: true, is_system: false, system_key: null, fronts: ['Weekly brief', 'Digest', 'Recap'] },
  ],
  free_characters: ['scout', 'dew'],
  suggested: null,
}

function Harness({ initial }: { initial: EditorState }) {
  const [editor, setEditor] = useState(initial)
  latest = editor
  return (
    <>
      <FlowBotChip editor={editor} options={OPTIONS} onOpen={() => {}} />
      <FlowBotPicker editor={editor} setEditor={setEditor} options={OPTIONS} loading={false} />
    </>
  )
}

function render(initial: EditorState) {
  act(() => root.render(<Harness initial={initial} />))
}

const base = (): EditorState => ({ ...emptyEditor(), name: 'Weekly brief' })
/** What the header chip says (its agent mark is an icon, with no words). */
const chipName = () => container.querySelector('[data-flow-bot-chip]')?.textContent
const optionText = (b: Element) => b.textContent

describe('FlowBotPicker', () => {
  it('lists your teammates’ agents with what each speaks for, each with the agent mark', () => {
    render(base())
    const options = [...container.querySelectorAll('[data-bot-option]')].map(optionText)
    expect(options).toEqual([`Captures${SYSTEM_TEAMMATE_BLURBS.captures}`, 'EmberSpeaks for Weekly brief, Digest +1'])
    expect(botSpeaksFor({ is_system: false, system_key: null, fronts: [] })).toBe('Doesn’t speak for a loop yet')
    expect(container.querySelector('img, canvas')).toBeNull()
    expect(container.querySelectorAll('[data-bot-option] [data-agent-icon]')).toHaveLength(2)
  })

  it('says a custom persona’s agent speaks for its persona, not that it has no loop (bots-v3 Phase 6)', () => {
    expect(botSpeaksFor({ is_system: false, system_key: null, fronts: [], agent: 'Sales Coach' })).toBe('Speaks for Sales Coach')
    expect(botSpeaksFor({ is_system: false, system_key: null, fronts: ['Digest'], agent: 'Sales Coach' })).toBe('Speaks for Sales Coach +1')
  })

  it('picks a teammate, and the header chip shows it', () => {
    render(base())
    act(() => (container.querySelector('[data-bot-option="tm-ember"]') as HTMLButtonElement).click())
    expect(latest.bot).toEqual({ kind: 'teammate', id: 'tm-ember' })
    expect(latest.botDirty).toBe(true)
    expect(chipName()).toBe('Ember')
  })

  it('offers a new agent for the loop, never a face, with a name field that keeps what is typed', () => {
    render(base())
    expect(container.querySelector('[data-bot-face]')).toBeNull()
    act(() => (container.querySelector('[data-new-agent]') as HTMLButtonElement).click())
    expect(latest.bot).toEqual({ kind: 'new', name: '' })
    expect(container.querySelector('[data-new-agent]')!.getAttribute('aria-pressed')).toBe('true')
    // Left unnamed, the chip says a new agent, not the loop's name.
    expect(chipName()).toBe('A new agent')
    const input = container.querySelector('input') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Briefer')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(latest.bot).toEqual({ kind: 'new', name: 'Briefer' })
    expect(chipName()).toBe('Briefer')
  })

  it('keeps a built-in loop on its own teammate', () => {
    render({ ...base(), id: 'f1', seed_key: 'seed:triage', bot: { kind: 'teammate', id: 'tm-triage' } })
    expect(container.textContent).toContain('A built-in loop keeps its own teammate')
    expect(container.querySelector('[data-bot-option]')).toBeNull()
  })

  it('asks for an agent when a saved loop’s was removed', () => {
    render({ ...base(), id: 'f1', bot: null })
    expect(container.textContent).toContain('Its agent was removed')
    expect(container.querySelector('[data-flow-bot-chip]')?.textContent).toBe('Pick an agent')
    expect(container.textContent).not.toContain('Build one')
  })

  describe('the loop’s own work agent', () => {
    const saved = (): EditorState => ({ ...base(), id: 'f1', bot: { kind: 'teammate', id: 'tm-ember' } })
    afterEach(() => vi.unstubAllGlobals())

    it('shows rename and delete only for a saved work agent, and no face controls', () => {
      render(saved())
      expect(container.querySelector('[data-work-bot-manager="tm-ember"]')).not.toBeNull()
      expect(container.textContent).not.toContain('face')
      act(() => root.unmount())
      root = createRoot(container)
      render({ ...base(), id: 'f1', bot: { kind: 'teammate', id: 'tm-triage' } })
      expect(container.querySelector('[data-work-bot-manager]')).toBeNull()
    })

    it('deletes it through the work-bot route, and the loop then asks for an agent', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      vi.stubGlobal('confirm', () => true)
      render(saved())
      const del = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Delete agent'))!
      await act(async () => {
        del.click()
      })
      expect(fetchMock).toHaveBeenCalledWith('/api/account/work-bots/tm-ember', expect.objectContaining({ method: 'DELETE' }))
      expect(latest.bot).toBeNull()
      expect(container.textContent).toContain('Its agent was removed')
    })
  })
})
