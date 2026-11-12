// @vitest-environment jsdom
/**
 * The Studio's select (StudioSelect in ../controls.tsx): the app's Select, fed the options a system select would hold.
 * What it must keep from the system's: the value shown is the chosen option's text, a choice reaches onChange as the
 * option's value (the empty string included, which Radix itself refuses), a disabled select takes no input, and the
 * name a screen reader hears is the one given. The open list needs pointer APIs jsdom lacks, so the choice is made
 * with the trigger's own typeahead (a letter typed on the closed select picks the next option starting with it). A
 * disabled select cannot take the focus, so it is checked by its state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readChoices, StudioSelect } from '../controls'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null, host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })

function render(node: React.ReactNode) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  act(() => root!.render(node))
  return host.querySelector<HTMLButtonElement>('button[role=combobox]')!
}
const type = (trigger: HTMLElement, key: string) => act(() => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })

describe('StudioSelect', () => {
  it('shows the chosen option, and a choice reaches onChange as its value', () => {
    const onChange = vi.fn()
    const trigger = render(<StudioSelect aria-label="Shadow" value="soft" onChange={onChange}>
      <option value="none">None</option><option value="soft">Soft</option><option value="hard">Hard</option></StudioSelect>)
    expect(trigger.getAttribute('aria-label')).toBe('Shadow')
    expect(trigger.textContent).toBe('Soft')
    type(trigger, 'h')
    expect(onChange).toHaveBeenCalledWith('hard')
  })

  it('carries numbers as text, and shows the first option for a value it does not hold', () => {
    const onChange = vi.fn()
    const trigger = render(<StudioSelect aria-label="Picture" value={30} onChange={onChange}>
      <option value="">No picture</option><option value={60}>60 fps</option></StudioSelect>)
    expect(trigger.textContent).toBe('No picture')
    type(trigger, '6')
    expect(onChange).toHaveBeenLastCalledWith('60')
  })

  it('hands the empty value back as the empty string', () => {
    const onChange = vi.fn()
    const trigger = render(<StudioSelect aria-label="Picture" value={60} onChange={onChange}>
      <option value="">No picture</option><option value={60}>60 fps</option></StudioSelect>)
    expect(trigger.textContent).toBe('60 fps')
    type(trigger, 'n')
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('takes no input while disabled, and never offers a disabled option', () => {
    const onChange = vi.fn()
    const trigger = render(<StudioSelect aria-label="Voice" value="a" disabled onChange={onChange}>
      <option value="a">Ada</option><option value="b">Bram</option></StudioSelect>)
    expect(trigger.disabled).toBe(true)
    expect(trigger.hasAttribute('data-disabled')).toBe(true)
    act(() => root!.render(<StudioSelect aria-label="Voice" value="a" onChange={onChange}>
      <option value="a">Ada</option><option value="b" disabled>Bram</option><option value="c">Bo</option></StudioSelect>))
    type(trigger, 'b')
    expect(onChange).toHaveBeenCalledWith('c')
  })

  it('reads groups, fragments and the dot an option carries', () => {
    const groups = readChoices(<>
      <option value="">Choose…</option>
      <optgroup label="Windows"><option value="w1">Editor</option></optgroup>
      {[<option key="d" value="d1" data-dot="has automation">Display</option>]}
    </>)
    expect(groups).toEqual([
      { choices: [{ value: '', label: 'Choose…', text: 'Choose…', disabled: false }] },
      { label: 'Windows', choices: [{ value: 'w1', label: 'Editor', text: 'Editor', disabled: false }] },
      { choices: [{ value: 'd1', label: 'Display', text: 'Display', disabled: false, dot: 'has automation' }] },
    ])
  })
})
