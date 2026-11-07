// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { lazyComponent } from '../lazy-component'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Greeting({ name }: { name: string }) {
  return h('p', { 'data-testid': 'greeting' }, `hi ${name}`)
}

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
})

const text = () => container.textContent

describe('lazyComponent', () => {
  it('renders nothing until the module arrives, then the component with its props', async () => {
    let resolve!: (c: typeof Greeting) => void
    const load = vi.fn(() => new Promise<typeof Greeting>((r) => (resolve = r)))
    const Lazy = lazyComponent(load)

    await act(async () => root.render(h('div', null, h(Lazy, { name: 'a' }), h(Lazy, { name: 'b' }))))
    expect(text()).toBe('')
    expect(load).toHaveBeenCalledTimes(1) // two mounts, one fetch

    await act(async () => resolve(Greeting))
    expect(text()).toBe('hi ahi b')
  })

  it('once loaded, later mounts render in the same commit and never refetch', async () => {
    const load = vi.fn(() => Promise.resolve(Greeting))
    const Lazy = lazyComponent(load)
    await act(async () => root.render(h(Lazy, { name: 'first' })))
    expect(text()).toBe('hi first')
    act(() => root.render(null))

    // Synchronous act: nothing is awaited, so only a same-commit render passes.
    act(() => root.render(h(Lazy, { name: 'again' })))
    expect(text()).toBe('hi again')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when the fetch fails, and the next mount retries it', async () => {
    const load = vi
      .fn<() => Promise<typeof Greeting>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce(Greeting)
    const Lazy = lazyComponent(load)

    await act(async () => root.render(h(Lazy, { name: 'x' })))
    expect(text()).toBe('')
    act(() => root.render(null))

    await act(async () => root.render(h(Lazy, { name: 'y' })))
    expect(text()).toBe('hi y')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('tells onError of a failed fetch while a mount waits on it, and not once it has gone', async () => {
    const onError = vi.fn()
    let reject!: (e: Error) => void
    const load = vi.fn(() => new Promise<typeof Greeting>((_, r) => (reject = r)))
    const Lazy = lazyComponent(load, { onError })

    await act(async () => root.render(h(Lazy, { name: 'x' })))
    await act(async () => reject(new Error('chunk failed')))
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as Error).message).toBe('chunk failed')

    // Unmounted before it fails: nobody's waiting, nothing to give up.
    act(() => root.render(null))
    await act(async () => root.render(h(Lazy, { name: 'y' })))
    act(() => root.render(null))
    await act(async () => reject(new Error('again')))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shows `failed` with current props, and its retry fetches again', async () => {
    const load = vi
      .fn<() => Promise<typeof Greeting>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce(Greeting)
    const onError = vi.fn()
    const Lazy = lazyComponent(load, {
      onError,
      failed: (retry, props) => h('button', { 'data-testid': 'retry', onClick: retry }, `Couldn’t load for ${props.name}. Retry`),
    })

    await act(async () => root.render(h(Lazy, { name: 'x' })))
    expect(text()).toBe('Couldn’t load for x. Retry')
    expect(onError).toHaveBeenCalledTimes(1)

    await act(async () => root.render(h(Lazy, { name: 'y' })))
    expect(text()).toBe('Couldn’t load for y. Retry')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="retry"]')!.click())
    expect(text()).toBe('hi y')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
