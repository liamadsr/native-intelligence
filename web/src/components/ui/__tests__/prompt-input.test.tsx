// @vitest-environment jsdom
/**
 * PromptInput's render cost, without changing what it does.
 *
 *  • The context value is memoized: a PromptInput re-render with unchanged
 *    inputs must not re-render its consumers (the textarea) through context.
 *  • The textarea's callback ref is stable, but the autosize re-measure still
 *    runs on EVERY render of the textarea (as the old inline ref's re-attach
 *    did), so a re-render after the field re-wrapped (a width change, no value
 *    change) still corrects its height.
 *  • A keystroke measures the field once (the layout effect), not three times:
 *    each measure settles every pending style and layout change in the page.
 *  • Where the browser sizes the field itself (`field-sizing: content`), it is
 *    never measured: no inline height, the cap as a CSS max-height.
 *  • Enter mid IME composition picks the candidate: it never sends.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, memo, Profiler } from 'react'
import { PromptInput, PromptInputTextarea } from '../prompt-input'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight
})

describe('PromptInput context value', () => {
  // Memoized with no props, so after mount the textarea inside can only
  // re-render through the PromptInput context.
  let textareaCommits = 0
  const ContextOnlyTextarea = memo(function ContextOnlyTextarea() {
    return h(
      Profiler,
      { id: 'textarea', onRender: () => void textareaCommits++ },
      h(PromptInputTextarea, { placeholder: 'Ask' }),
    )
  })

  beforeEach(() => {
    textareaCommits = 0
  })

  it('keeps its identity across a re-render with unchanged inputs (controlled)', () => {
    const onValueChange = () => {}
    const onSubmit = () => {}
    const render = (value: string, className: string) =>
      act(() => {
        root.render(h(PromptInput, { value, onValueChange, onSubmit, className, children: h(ContextOnlyTextarea) }))
      })

    render('hi', 'a')
    // Mount commits (incl. the textarea's own placeholder-width effect, which
    // flips in jsdom's zero-width layout) — the baseline, not under test.
    const mounted = textareaCommits

    // PromptInput re-renders (its className changed) — nothing the context
    // carries did, so the textarea is left alone.
    render('hi', 'b')
    expect(textareaCommits).toBe(mounted)

    // A real context change still reaches it.
    render('hi there', 'b')
    expect(textareaCommits).toBe(mounted + 1)
    expect(container.querySelector('textarea')!.value).toBe('hi there')
  })

  it('keeps its identity across a re-render with unchanged inputs (uncontrolled)', () => {
    const render = (className: string) =>
      act(() => {
        root.render(h(PromptInput, { className, children: h(ContextOnlyTextarea) }))
      })

    render('a')
    const mounted = textareaCommits
    render('b')
    expect(textareaCommits).toBe(mounted)
  })
})

describe('PromptInputTextarea autosize', () => {
  it('re-measures on every render, not only when the value changes', () => {
    let scrollHeight = 40
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    const render = (className: string) =>
      act(() => {
        root.render(
          h(PromptInput, { value: 'a long draft', onValueChange: () => {}, children: h(PromptInputTextarea, { className }) }),
        )
      })

    render('a')
    const textarea = container.querySelector('textarea')!
    expect(textarea.style.height).toBe('40px')

    // The field re-wrapped (e.g. the panel got narrower) with no value change;
    // the next render of the textarea picks the new height up.
    scrollHeight = 64
    render('b')
    expect(textarea.style.height).toBe('64px')

    // Capped at maxHeight (240 by default), as before.
    scrollHeight = 500
    render('c')
    expect(textarea.style.height).toBe('240px')
  })

  it('keeps the textarea ref attached, so a click on the box focuses the field', () => {
    act(() => {
      root.render(h(PromptInput, { value: '', onValueChange: () => {}, children: h(PromptInputTextarea) }))
    })
    // A re-render must not leave the ref detached.
    act(() => {
      root.render(
        h(PromptInput, { value: '', onValueChange: () => {}, className: 'x', children: h(PromptInputTextarea) }),
      )
    })
    const textarea = container.querySelector('textarea')!
    const box = textarea.closest('div.x') as HTMLDivElement
    act(() => {
      box.click()
    })
    expect(document.activeElement).toBe(textarea)
  })
})

describe('PromptInputTextarea measures once a keystroke', () => {
  let reads = 0
  beforeEach(() => {
    reads = 0
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => {
        reads++
        return 40
      },
    })
  })

  it('a value change (controlled) reads scrollHeight once', () => {
    const render = (value: string) =>
      act(() => {
        root.render(h(PromptInput, { value, onValueChange: () => {}, children: h(PromptInputTextarea) }))
      })
    render('a')
    reads = 0
    render('ab')
    expect(reads).toBe(1)
    expect(container.querySelector('textarea')!.style.height).toBe('40px')
  })

  it('typing (uncontrolled, through the change handler) reads scrollHeight once a key', () => {
    act(() => {
      root.render(h(PromptInput, { children: h(PromptInputTextarea) }))
    })
    const textarea = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    reads = 0
    act(() => {
      setter.call(textarea, 'h')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(textarea.value).toBe('h')
    expect(reads).toBe(1)
  })
})

describe('PromptInputTextarea where the browser sizes the field', () => {
  const realCSS = (globalThis as { CSS?: unknown }).CSS
  let reads = 0
  beforeEach(() => {
    reads = 0
    ;(globalThis as { CSS?: unknown }).CSS = { supports: (p: string, v: string) => p === 'field-sizing' && v === 'content' }
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => {
        reads++
        return 40
      },
    })
  })
  afterEach(() => {
    ;(globalThis as { CSS?: unknown }).CSS = realCSS
  })

  it('never measures: no inline height, the cap as a CSS max-height', () => {
    const render = (value: string) =>
      act(() => {
        root.render(h(PromptInput, { value, onValueChange: () => {}, children: h(PromptInputTextarea) }))
      })
    render('a')
    render('a longer draft')
    const textarea = container.querySelector('textarea')!
    expect(reads).toBe(0)
    expect(textarea.style.height).toBe('')
    expect(textarea.hasAttribute('data-autosize')).toBe(true)
    expect(textarea.style.maxHeight).toBe('240px')
  })

  it('clears a height a measure left (a string maxHeight passes through)', () => {
    act(() => {
      root.render(h(PromptInput, { value: 'a', onValueChange: () => {}, maxHeight: '40vh', children: h(PromptInputTextarea) }))
    })
    const textarea = container.querySelector('textarea')!
    textarea.style.height = '64px'
    act(() => {
      root.render(h(PromptInput, { value: 'ab', onValueChange: () => {}, maxHeight: '40vh', children: h(PromptInputTextarea) }))
    })
    expect(textarea.style.height).toBe('')
    expect(textarea.style.maxHeight).toBe('40vh')
  })

  it('leaves a field with autosize off alone', () => {
    act(() => {
      root.render(h(PromptInput, { value: 'a', onValueChange: () => {}, children: h(PromptInputTextarea, { disableAutosize: true }) }))
    })
    const textarea = container.querySelector('textarea')!
    expect(textarea.hasAttribute('data-autosize')).toBe(false)
    expect(textarea.style.maxHeight).toBe('')
  })
})

describe('Enter mid IME composition', () => {
  // Enter picks the IME's candidate: it must never send the half-typed text.
  function keydown(init: KeyboardEventInit, keyCode?: number) {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
    if (keyCode !== undefined) Object.defineProperty(ev, 'keyCode', { value: keyCode })
    act(() => {
      container.querySelector('textarea')!.dispatchEvent(ev)
    })
  }

  it('sends on a plain Enter, never while composing (isComposing, or keyCode 229)', () => {
    let sent = 0
    act(() => {
      root.render(h(PromptInput, { value: 'にほ', onValueChange: () => {}, onSubmit: () => void sent++, children: h(PromptInputTextarea) }))
    })
    keydown({ isComposing: true })
    keydown({}, 229)
    expect(sent).toBe(0)
    keydown({})
    expect(sent).toBe(1)
  })
})
