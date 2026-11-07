// @vitest-environment jsdom
/**
 * copyDeferredTextToClipboard: the clipboard write starts synchronously, in the
 * caller's click, while the text is still being built (WKWebView drops a write
 * that comes after the click's activation has lapsed), and the result is honest:
 * false whenever nothing was copied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyDeferredTextToClipboard, copyRichTextToClipboard } from '../clipboard'

class FakeClipboardItem {
  constructor(public readonly items: Record<string, Promise<Blob>>) {}
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

function setClipboard(value: Partial<Clipboard> | undefined) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
}

beforeEach(() => {
  vi.stubGlobal('ClipboardItem', FakeClipboardItem)
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard)
  else setClipboard(undefined)
})

describe('copyDeferredTextToClipboard', () => {
  it('starts the write synchronously with a promised blob, before the text exists', async () => {
    let written: FakeClipboardItem | null = null
    const write = vi.fn(async (items: FakeClipboardItem[]) => {
      written = items[0]
      await items[0].items['text/plain']
    })
    const writeText = vi.fn()
    setClipboard({ write, writeText } as unknown as Clipboard)

    const text = deferred<string>()
    const result = copyDeferredTextToClipboard(text.promise)

    // Called inside the same tick as the click, with the text still pending.
    expect(write).toHaveBeenCalledTimes(1)
    expect(written).toBeInstanceOf(FakeClipboardItem)

    text.resolve('the prompt')
    await expect(result).resolves.toBe(true)
    const blob = await written!.items['text/plain']
    expect(blob.type).toBe('text/plain')
    expect(await blob.text()).toBe('the prompt')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('falls back to writeText when ClipboardItem is missing', async () => {
    vi.stubGlobal('ClipboardItem', undefined)
    const writeText = vi.fn(async () => {})
    setClipboard({ writeText } as unknown as Clipboard)

    await expect(copyDeferredTextToClipboard(Promise.resolve('plain'))).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('plain')
  })

  it('falls back to writeText when the item write is refused', async () => {
    const write = vi.fn(async () => { throw new Error('NotAllowedError') })
    const writeText = vi.fn(async () => {})
    setClipboard({ write, writeText } as unknown as Clipboard)

    await expect(copyDeferredTextToClipboard(Promise.resolve('again'))).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('again')
  })

  it('resolves false (never rejects) when the text cannot be built', async () => {
    const write = vi.fn(async (items: FakeClipboardItem[]) => { await items[0].items['text/plain'] })
    const writeText = vi.fn(async () => {})
    setClipboard({ write, writeText } as unknown as Clipboard)

    await expect(copyDeferredTextToClipboard(Promise.reject(new Error('fetch failed')))).resolves.toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('resolves false when every path fails', async () => {
    const write = vi.fn(async () => { throw new Error('NotAllowedError') })
    const writeText = vi.fn(async () => { throw new Error('NotAllowedError') })
    setClipboard({ write, writeText } as unknown as Clipboard)
    const execCommand = vi.fn(() => false)
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })

    await expect(copyDeferredTextToClipboard(Promise.resolve('x'))).resolves.toBe(false)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })
})

describe('copyRichTextToClipboard (P9: copy a newsletter out)', () => {
  it('writes the markdown as plain text and the HTML as rich text, in one item started inside the click', async () => {
    const write = vi.fn(async (_items: unknown) => {})
    setClipboard({ write } as unknown as Clipboard)
    const html = deferred<string>()
    const done = copyRichTextToClipboard('# Hi', html.promise)
    expect(write).toHaveBeenCalledTimes(1)
    const item = (write.mock.calls[0][0] as Array<{ items: Record<string, Blob | Promise<Blob>> }>)[0]
    expect(Object.keys(item.items).sort()).toEqual(['text/html', 'text/plain'])
    html.resolve('<h1>Hi</h1>')
    expect(await done).toBe(true)
    expect(await (await item.items['text/html']).text()).toBe('<h1>Hi</h1>')
    expect(await (item.items['text/plain'] as Blob).text()).toBe('# Hi')
  })

  it('falls back to the markdown alone when a rich write is refused', async () => {
    const writeText = vi.fn(async (_t: string) => {})
    setClipboard({ write: vi.fn(async () => { throw new Error('NotAllowed') }), writeText } as unknown as Clipboard)
    expect(await copyRichTextToClipboard('plain', Promise.resolve('<p>plain</p>'))).toBe(true)
    expect(writeText).toHaveBeenCalledWith('plain')
  })
})
