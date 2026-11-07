// @vitest-environment jsdom
/**
 * The HUD's Briefing line (live sidekick plan, Phase 4): the person's
 * pre-call brief, collapsed to "Briefing" and the goal (else the prep's first
 * line), expanded to the goal and the prep's top as plain text. No brief,
 * nothing. And the brief's wire shape (lib/live-agent/hud-brief.ts): read
 * from the route and from a window, checked, never trusted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { HudBriefingLine } from '../hud-briefing-line'
import {
  fetchHudBrief,
  hudBriefLead,
  hudBriefOf,
  plainBriefText,
  readHudBrief,
  sameHudBrief,
  type HudBrief,
} from '@/lib/live-agent/hud-brief'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BRIEF: HudBrief = {
  captureId: 'cap-1',
  goal: 'Close the pilot by Friday',
  prepTitle: 'Prep — Acme',
  prepTop: "**What it's about**\n- Pilot pricing\n\n**On you**: send the SOW",
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = (brief: HudBrief | null) => act(async () => root.render(h(HudBriefingLine, { brief })))
const line = () => container.querySelector('[data-hud-briefing]')
const toggle = () => container.querySelector('[data-hud-briefing] button') as HTMLButtonElement
const body = () => container.querySelector('[data-hud-briefing-body]')

describe('HudBriefingLine', () => {
  it('collapsed by default: "Briefing" and the goal on one line', async () => {
    await render(BRIEF)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().textContent).toContain('Briefing')
    expect(container.querySelector('[data-hud-briefing-lead]')!.textContent).toBe('Close the pilot by Friday')
    expect(body()).toBeNull()
  })

  it("with no goal, the prep's first line", async () => {
    await render({ ...BRIEF, goal: null })
    expect(container.querySelector('[data-hud-briefing-lead]')!.textContent).toBe("What it's about")
  })

  it('expanded: the goal and the prep top as plain text, and collapses again', async () => {
    await render(BRIEF)
    await act(async () => toggle().click())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-hud-briefing-goal]')!.textContent).toContain('Close the pilot by Friday')
    const prep = container.querySelector('[data-hud-briefing-prep]')!
    expect(prep.textContent).toContain('Prep — Acme')
    expect(prep.querySelector('p')!.textContent).toBe("What it's about\n• Pilot pricing\n\nOn you: send the SOW")
    await act(async () => toggle().click())
    expect(body()).toBeNull()
  })

  it('plain text: markup in the brief is shown as text, never as elements', async () => {
    await render({ ...BRIEF, goal: '<img src=x onerror=alert(1)> <b>win</b>', prepTop: '<script>x()</script>\n[link](javascript:x)' })
    await act(async () => toggle().click())
    expect(container.querySelector('img, script, b, a')).toBeNull()
    expect(body()!.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(body()!.textContent).toContain('[link](javascript:x)')
  })

  it('no brief, nothing', async () => {
    await render(null)
    expect(line()).toBeNull()
    await render({ captureId: 'cap-1', goal: null, prepTitle: null, prepTop: null })
    expect(line()).toBeNull()
  })
})

describe('the brief on the wire', () => {
  it("reads the route's brief, null with neither", () => {
    expect(hudBriefOf('cap-1', { goal: ' Ship ', prep: { title: 'P', top: 'top' } })).toEqual({ captureId: 'cap-1', goal: 'Ship', prepTitle: 'P', prepTop: 'top' })
    expect(hudBriefOf('cap-1', { goal: null, prep: null })).toBeNull()
    expect(hudBriefOf('cap-1', null)).toBeNull()
    expect(hudBriefOf('', { goal: 'x' })).toBeNull()
  })

  it('a window payload is checked: none, junk and over-long text', () => {
    expect(readHudBrief(BRIEF)).toEqual(BRIEF)
    expect(readHudBrief({ captureId: null })).toBeNull()
    expect(readHudBrief({ captureId: 'cap-1', goal: 7, prepTop: {} })).toBeNull()
    expect(readHudBrief({ captureId: 'cap-1', goal: 'g'.repeat(900) })!.goal!.length).toBe(500)
    expect(sameHudBrief(BRIEF, { ...BRIEF })).toBe(true)
    expect(sameHudBrief(BRIEF, { ...BRIEF, goal: 'other' })).toBe(false)
  })

  it('plain reading text and the lead', () => {
    expect(plainBriefText('## Topics\n- **one**\n* two')).toBe('Topics\n• one\n• two')
    expect(hudBriefLead({ ...BRIEF, goal: 'a\nb' })).toBe('a b')
  })

  it("fetches the capture route's brief variant; null on failure", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ capture: { id: 'cap-1', brief: { goal: 'G', prep: null } } }) }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchHudBrief('cap-1')).toEqual({ captureId: 'cap-1', goal: 'G', prepTitle: null, prepTop: null })
    expect(fetchMock).toHaveBeenCalledWith('/api/account/captures/cap-1?fields=brief', { signal: undefined })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response))
    expect(await fetchHudBrief('cap-1')).toBeNull()
  })
})
