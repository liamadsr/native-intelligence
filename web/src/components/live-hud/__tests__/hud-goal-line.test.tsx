// @vitest-environment jsdom
/**
 * The HUD's goal line (live sidekick plan, Phase 5): the call's goal, shown
 * and edited in place (Enter saves, Escape or leaving cancels, empty clears),
 * a quiet "Set a goal" only while the call is live, an IME's Enter left to the
 * IME, the new goal shown at once and the old one put back when the save
 * fails. And the wire (lib/live-agent/hud-goal.ts): actions and answers
 * checked, never trusted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { HudGoalLine } from '../hud-goal-line'
import {
  hudGoalAction,
  readHudGoalAction,
  readHudGoalMeeting,
  readHudGoalResult,
  runHudGoalAction,
} from '@/lib/live-agent/hud-goal'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
})

type Save = (goal: string) => Promise<boolean>
const render = (goal: string | null, live: boolean, onSave: Save) => act(async () => root.render(h(HudGoalLine, { goal, live, onSave })))
const line = () => container.querySelector('[data-hud-goal]')
const text = () => container.querySelector('[data-hud-goal-text]')?.textContent ?? null
const input = () => container.querySelector('[data-hud-goal] input') as HTMLInputElement | null
const button = () => container.querySelector('[data-hud-goal] button, button[data-hud-goal]') as HTMLButtonElement
const failed = () => container.querySelector('[data-hud-goal-failed]')

async function edit() {
  await act(async () => button().click())
}
async function type(value: string) {
  const el = input()!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function key(k: string, extra: { isComposing?: boolean; keyCode?: number } = {}) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, isComposing: extra.isComposing ?? false })
  if (extra.keyCode != null) Object.defineProperty(e, 'keyCode', { value: extra.keyCode })
  await act(async () => {
    input()!.dispatchEvent(e)
  })
  return e
}
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)) })

describe('HudGoalLine', () => {
  it('shows the goal on one line, and edits it in place: Enter saves the trimmed words', async () => {
    const onSave = vi.fn<Save>(async () => true)
    await render('Close the pilot', true, onSave)
    expect(line()!.textContent).toContain('Goal')
    expect(text()).toBe('Close the pilot')
    await edit()
    expect(input()!.value).toBe('Close the pilot')
    expect(document.activeElement).toBe(input())
    await type('  Get the SOW signed  ')
    await key('Enter')
    expect(onSave).toHaveBeenCalledWith('Get the SOW signed')
    expect(input()).toBeNull()
    // Shown at once, and kept once saved (until the host's goal moves on).
    expect(text()).toBe('Get the SOW signed')
    await settle()
    expect(text()).toBe('Get the SOW signed')
    await render('Get the SOW signed', true, onSave)
    expect(text()).toBe('Get the SOW signed')
    expect(failed()).toBeNull()
  })

  it('Escape cancels (and is its own, not the host’s); leaving the field cancels; unchanged words save nothing', async () => {
    const onSave = vi.fn<Save>(async () => true)
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    await render('Close the pilot', true, onSave)
    await edit()
    await type('Something else')
    const esc = await key('Escape')
    window.removeEventListener('keydown', onWindowKey)
    expect(esc.defaultPrevented).toBe(true)
    expect(onWindowKey).not.toHaveBeenCalled()
    expect(input()).toBeNull()
    expect(text()).toBe('Close the pilot')
    await edit()
    await type('Something else')
    await act(async () => input()!.blur())
    expect(input()).toBeNull()
    expect(text()).toBe('Close the pilot')
    await edit()
    await key('Enter')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saving it empty clears it: "Set a goal" while live', async () => {
    const onSave = vi.fn<Save>(async () => true)
    await render('Close the pilot', true, onSave)
    await edit()
    await type('   ')
    await key('Enter')
    expect(onSave).toHaveBeenCalledWith('')
    expect(container.querySelector('[data-hud-goal-set]')!.textContent).toBe('Set a goal')
    await render(null, true, onSave)
    expect(container.querySelector('[data-hud-goal-set]')).not.toBeNull()
  })

  it("an IME's Enter picks its candidate: no save while composing (or keyCode 229)", async () => {
    const onSave = vi.fn<Save>(async () => true)
    await render(null, true, onSave)
    await edit()
    await type('目標')
    await key('Enter', { isComposing: true })
    await key('Enter', { keyCode: 229 })
    expect(onSave).not.toHaveBeenCalled()
    expect(input()).not.toBeNull()
    await key('Enter')
    expect(onSave).toHaveBeenCalledWith('目標')
  })

  it('"Set a goal" only while the call is live; a goal off the call is shown, not editable', async () => {
    const onSave = vi.fn<Save>(async () => true)
    await render(null, false, onSave)
    expect(line()).toBeNull()
    expect(container.innerHTML).toBe('')
    await render(null, true, onSave)
    const set = container.querySelector('[data-hud-goal-set]') as HTMLButtonElement
    expect(set.textContent).toBe('Set a goal')
    await act(async () => set.click())
    expect(input()!.value).toBe('')
    expect(input()!.placeholder).toBe('What do you want out of this call?')
    expect(input()!.maxLength).toBe(500)
    await type('Agree the rollout date')
    await key('Enter')
    expect(onSave).toHaveBeenCalledWith('Agree the rollout date')
    expect(text()).toBe('Agree the rollout date')

    await render('Close the pilot', false, onSave)
    expect(text()).toBe('Close the pilot')
    expect(button().disabled).toBe(true)
    await edit()
    expect(input()).toBeNull()
  })

  it('a failed save puts the old goal back and says "Not saved" until the next edit (a throw too)', async () => {
    let answer: (ok: boolean) => void = () => {}
    const onSave = vi.fn<Save>(() => new Promise<boolean>((r) => { answer = r }))
    await render('Close the pilot', true, onSave)
    await edit()
    await type('Get the SOW signed')
    await key('Enter')
    expect(text()).toBe('Get the SOW signed')
    await act(async () => answer(false))
    await settle()
    expect(text()).toBe('Close the pilot')
    expect(failed()!.textContent).toBe('Not saved')
    await edit()
    expect(failed()).toBeNull()
    await key('Escape')

    // A first-time goal that throws: back to "Set a goal", not saved.
    const throwing = vi.fn<Save>(async () => {
      throw new Error('down')
    })
    await render(null, true, throwing)
    await edit()
    await type('Agree pricing')
    await key('Enter')
    await settle()
    expect(container.querySelector('[data-hud-goal-set]')!.textContent).toContain('Set a goal')
    expect(failed()).not.toBeNull()
  })

  it('plain text: markup is shown as text, never as elements', async () => {
    await render('<img src=x onerror=alert(1)> <b>win</b>', true, async () => true)
    expect(container.querySelector('img, b')).toBeNull()
    expect(text()).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('the goal on the wire', () => {
  it('an action: trimmed, empty is a clear, over-long or without a capture is none', () => {
    expect(hudGoalAction('cap-1', 'a', '  Ship  ')).toEqual({ captureId: 'cap-1', id: 'a', type: 'set', goal: 'Ship' })
    expect(hudGoalAction('cap-1', 'a', '  ')).toEqual({ captureId: 'cap-1', id: 'a', type: 'clear', goal: '' })
    expect(hudGoalAction('cap-1', 'a', 'x'.repeat(501))).toBeNull()
    expect(hudGoalAction('', 'a', 'x')).toBeNull()
  })

  it('a window payload is checked', () => {
    expect(readHudGoalAction({ captureId: 'cap-1', id: 'a', type: 'set', goal: ' Ship ' })).toEqual({ captureId: 'cap-1', id: 'a', type: 'set', goal: 'Ship' })
    expect(readHudGoalAction({ captureId: 'cap-1', id: 'a', type: 'clear', goal: 'ignored' })).toEqual({ captureId: 'cap-1', id: 'a', type: 'clear', goal: '' })
    expect(readHudGoalAction({ captureId: 'cap-1', id: 'a', type: 'set', goal: '  ' })).toBeNull()
    expect(readHudGoalAction({ captureId: 'cap-1', id: 'a', type: 'set', goal: 'x'.repeat(501) })).toBeNull()
    expect(readHudGoalAction({ captureId: 'cap-1', id: 'a', type: 'drop' })).toBeNull()
    expect(readHudGoalAction({ captureId: 'cap-1', type: 'clear' })).toBeNull()
    expect(readHudGoalAction(null)).toBeNull()
    expect(readHudGoalResult({ id: 'a', ok: true })).toEqual({ id: 'a', ok: true })
    expect(readHudGoalResult({ id: 'a', ok: 'yes' })).toBeNull()
    expect(readHudGoalMeeting({ calendarEventId: 'capture:cap-1', startsAt: '2026-10-18T11:00:00-04:00' })).toEqual({
      calendarEventId: 'capture:cap-1',
      startsAt: '2026-10-18T15:00:00.000Z',
    })
    expect(readHudGoalMeeting({ calendarEventId: '', startsAt: 'soon' })).toBeNull()
  })

  it('runs only its own capture’s action; a save that throws answers ok: false', async () => {
    const save = vi.fn<Save>(async () => true)
    expect(await runHudGoalAction({ captureId: 'cap-1', id: 'a', type: 'set', goal: 'Ship' }, 'cap-1', save)).toEqual({ id: 'a', ok: true })
    expect(save).toHaveBeenLastCalledWith('Ship')
    expect(await runHudGoalAction({ captureId: 'cap-1', id: 'b', type: 'clear' }, 'cap-1', save)).toEqual({ id: 'b', ok: true })
    expect(save).toHaveBeenLastCalledWith('')
    expect(await runHudGoalAction({ captureId: 'cap-2', id: 'c', type: 'set', goal: 'Ship' }, 'cap-1', save)).toBeNull()
    expect(save).toHaveBeenCalledTimes(2)
    const boom = vi.fn<Save>(async () => {
      throw new Error('x')
    })
    expect(await runHudGoalAction({ captureId: 'cap-1', id: 'd', type: 'set', goal: 'Ship' }, 'cap-1', boom)).toEqual({ id: 'd', ok: false })
  })
})
