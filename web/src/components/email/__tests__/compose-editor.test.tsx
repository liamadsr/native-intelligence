// @vitest-environment jsdom
/**
 * The composer's message field (compose-editor.tsx): only web and mail links,
 * only the markup the editor writes, and the real editor mounted (tiptap)
 * taking content and bold.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, createRef } from 'react'
import { ComposeEditor, safeLinkHref, sanitizeComposeHtml, type ComposeEditorHandle } from '../compose-editor'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('safeLinkHref', () => {
  it('web and mail links only; a bare domain is https, a bare address mailto', () => {
    expect(safeLinkHref('https://harborline.example/plan')).toBe('https://harborline.example/plan')
    expect(safeLinkHref('harborline.example')).toBe('https://harborline.example/')
    expect(safeLinkHref('sam@harborline.example')).toBe('mailto:sam@harborline.example')
    expect(safeLinkHref('javascript:alert(1)')).toBeNull()
    expect(safeLinkHref('data:text/html,<b>x</b>')).toBeNull()
    expect(safeLinkHref('  ')).toBeNull()
  })
})

describe('sanitizeComposeHtml', () => {
  it('keeps what the editor writes and drops anything else', () => {
    const out = sanitizeComposeHtml(
      '<p onclick="x()">Hi <strong>there</strong> <img src=x onerror=alert(1)><script>bad()</script></p><ul><li>one</li></ul><style>p{}</style>',
    )
    expect(out).toBe('<p>Hi <strong>there</strong> </p><ul><li>one</li></ul>')
  })

  it('a link must stay a web or mail link', () => {
    expect(sanitizeComposeHtml('<a href="https://harborline.example">ok</a>')).toContain('href="https://harborline.example"')
    expect(sanitizeComposeHtml('<a href="vbscript:x">no</a>')).not.toContain('vbscript')
  })
})

describe('ComposeEditor', () => {
  let container: HTMLDivElement
  let root: Root
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('mounts the real editor with its content, and takes bold', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const ref = createRef<ComposeEditorHandle>()
    await act(async () => root.render(h(ComposeEditor, { ref, initialHtml: '<p>Kept words</p>' })))
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(container.querySelector('[role="textbox"]')?.textContent).toBe('Kept words')
    expect(ref.current!.getHTML()).toBe('<p>Kept words</p>')
    await act(async () => ref.current!.setHTML('<p>New</p>'))
    expect(ref.current!.getHTML()).toBe('<p>New</p>')
  })
})
