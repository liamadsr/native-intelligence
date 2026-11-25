/**
 * The engine in the browser (../engine-client.ts) is loaded once per page and
 * shared by every spreadsheet opened after it: one fetch, one compile, one
 * instance. Measured on 11-25 (production build, Chromium, a 108,000-cell
 * sheet): the first open instantiates it once (9 MB of wasm memory), and the
 * second and later opens reuse it (no new instantiation, no new fetch).
 * A load that failed can be tried again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { init, made } = vi.hoisted(() => ({ init: vi.fn(async () => ({})), made: [] as string[] }))
vi.mock('@ironcalc/wasm', () => ({
  default: init,
  Model: class {
    constructor(name: string) {
      made.push(name)
    }
    static fromBytes() {
      made.push('bytes')
      return {}
    }
  },
}))

beforeEach(() => {
  vi.resetModules()
  init.mockReset()
  init.mockImplementation(async () => ({}))
  made.length = 0
})

describe('the browser engine', () => {
  it('initialises once, however many spreadsheets open after it', async () => {
    const { ENGINE_URL, loadEngine, openModel } = await import('../engine-client')
    await Promise.all([loadEngine(), loadEngine(), openModel(null, 'A')])
    await openModel(null, 'B')
    await openModel(null, 'C')
    expect(init).toHaveBeenCalledTimes(1)
    expect(init).toHaveBeenCalledWith({ module_or_path: ENGINE_URL })
    expect(made).toEqual(['A', 'B', 'C'])
  })

  it('a load that failed is tried again on the next open', async () => {
    init.mockImplementationOnce(async () => {
      throw new Error('network')
    })
    const { openModel } = await import('../engine-client')
    await expect(openModel(null, 'A')).rejects.toThrow('network')
    await openModel(null, 'B')
    expect(init).toHaveBeenCalledTimes(2)
    expect(made).toEqual(['B'])
  })
})
