// @vitest-environment jsdom
/**
 * The one rule every full-screen surface closes by: a press on its layer that
 * is off the card and off any control, with no popover open.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isOutsideCardPress, popoverLayerOpen } from '../outside-card-press'

let layer: HTMLDivElement
let frame: HTMLDivElement

beforeEach(() => {
  document.body.innerHTML = `
    <div id="layer">
      <div id="corner"><button id="x">X</button></div>
      <div data-full-screen-control id="listen"><span id="listen-inner"></span></div>
      <div id="stage"><div id="column">
        <div id="frame"><div id="header"><span id="title">Mail</span></div><div id="page">text</div></div>
        <div id="controls"><button id="min"><svg id="icon"></svg></button></div>
      </div></div>
    </div>
    <div id="portaled"></div>`
  layer = document.getElementById('layer') as HTMLDivElement
  frame = document.getElementById('frame') as HTMLDivElement
})
afterEach(() => {
  document.body.innerHTML = ''
})

const pressOn = (id: string, button = 0) => ({ button, target: document.getElementById(id), currentTarget: layer })

describe('isOutsideCardPress', () => {
  it('is outside on the empty space and every wrapper around the card', () => {
    for (const id of ['layer', 'stage', 'column', 'controls', 'corner']) expect(isOutsideCardPress(pressOn(id), frame), id).toBe(true)
  })

  it('is not on the card, its header or its page', () => {
    for (const id of ['frame', 'header', 'title', 'page']) expect(isOutsideCardPress(pressOn(id), frame), id).toBe(false)
    // A text node in the page (a target that is no element).
    const text = document.getElementById('page')!.firstChild!
    expect(isOutsideCardPress({ button: 0, target: text, currentTarget: layer }, frame)).toBe(false)
  })

  it('is not on a control, nor anything inside one', () => {
    for (const id of ['x', 'min', 'icon', 'listen', 'listen-inner']) expect(isOutsideCardPress(pressOn(id), frame), id).toBe(false)
  })

  it('is only the primary button', () => {
    expect(isOutsideCardPress(pressOn('stage', 1), frame)).toBe(false)
    expect(isOutsideCardPress(pressOn('stage', 2), frame)).toBe(false)
  })

  it('is not a press React bubbled up from a portal elsewhere (a popover out of the card)', () => {
    expect(isOutsideCardPress(pressOn('portaled'), frame)).toBe(false)
  })

  it('is not while a popover, menu or dialog is open; a tooltip does not count', () => {
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-radix-popper-content-wrapper', '')
    document.body.append(wrapper)
    expect(popoverLayerOpen()).toBe(true)
    expect(isOutsideCardPress(pressOn('stage'), frame)).toBe(false)

    wrapper.innerHTML = '<div data-state="delayed-open"><span role="tooltip">Tip</span></div>'
    expect(popoverLayerOpen()).toBe(false)
    expect(isOutsideCardPress(pressOn('stage'), frame)).toBe(true)
    wrapper.remove()

    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-state', 'open')
    document.body.append(menu)
    expect(isOutsideCardPress(pressOn('stage'), frame)).toBe(false)
    menu.setAttribute('data-state', 'closed')
    expect(isOutsideCardPress(pressOn('stage'), frame)).toBe(true)
  })

  it('ignores a popover parked in a hidden tab, and the agent’s pending question', () => {
    // A hidden tab's question: mounted, but inert and aria-hidden.
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-radix-popper-content-wrapper', '')
    wrapper.innerHTML = '<div role="dialog" data-state="open" aria-hidden="true" inert>Which account?</div>'
    document.body.append(wrapper)
    expect(popoverLayerOpen()).toBe(false)
    expect(isOutsideCardPress(pressOn('stage'), frame)).toBe(true)

    // The same question in the tab in front: it never closes on an outside press, so it never holds the card.
    wrapper.innerHTML = '<div role="dialog" data-state="open" data-full-screen-ignore>Which account?</div>'
    expect(popoverLayerOpen()).toBe(false)
    expect(isOutsideCardPress(pressOn('stage'), frame)).toBe(true)

    // Any other open popover still holds it.
    wrapper.innerHTML = '<div role="dialog" data-state="open">Model</div>'
    expect(popoverLayerOpen()).toBe(true)
    wrapper.remove()
  })

  it('treats a page’s own layer inside the card (the flow editor) as part of the card, not a popover', () => {
    const inner = document.createElement('div')
    inner.setAttribute('data-chat-card-layer', '')
    document.getElementById('page')!.append(inner)
    expect(popoverLayerOpen()).toBe(false)
    expect(isOutsideCardPress(pressOn('stage'), frame)).toBe(true)
    expect(isOutsideCardPress({ button: 0, target: inner, currentTarget: layer }, frame)).toBe(false)
  })
})
