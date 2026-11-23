// @vitest-environment jsdom
/**
 * The focus after a flip (../hub-open.ts keepFocusAfterFlip; seen in the
 * browser, 11-23: a document's editor took the focus as it opened, and the
 * next J was typed into it): it stays on the row while the card takes it,
 * until the person presses somewhere themselves.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { keepFocusAfterFlip } from '../hub-open'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the focus after a flip', () => {
  it('stays on the row while the opened card takes it, until a press of the person’s own', () => {
    document.body.innerHTML = '<aside data-page-panel="home"><button id="row">row</button><button id="next">next</button></aside><div tabindex="0" id="editor"></div>'
    const row = document.getElementById('row')!
    const next = document.getElementById('next')!
    const editor = document.getElementById('editor')!
    row.focus()
    const stop = keepFocusAfterFlip(row, 10_000)
    editor.focus()
    expect(document.activeElement).toBe(row)
    // Within the panel, the focus may move (the next row).
    next.focus()
    expect(document.activeElement).toBe(next)
    window.dispatchEvent(new Event('pointerdown'))
    editor.focus()
    expect(document.activeElement).toBe(editor)
    stop()
  })
})
