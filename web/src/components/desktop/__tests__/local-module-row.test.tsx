// @vitest-environment jsdom
/**
 * LocalModuleRow + useLocalModule — the Settings → Recording row for the
 * desktop's on-device transcription module (local-stt).
 *
 * Contract pinned here:
 *  - Capability probe: nothing renders in a browser or on a desktop build
 *    whose modules_list is missing ([]) or lacks the module.
 *  - The row mirrors the desktop's state machine, driven live by
 *    module://status: Waiting → Downloading x% → Verifying → Setting up →
 *    Ready; a failure in plain words with Try again (module_enable).
 *  - The model is not a choice (it downloads and is used on its own,
 *    local-modules-keeper.ts): no switch, no Cancel, no Remove.
 *  - An optional attribution line renders last; its LocalModuleLinks open in
 *    the OS browser (openExternalUrl), since the desktop webview swallows
 *    target="_blank".
 *
 * The bridge is mocked with an in-memory module://status emitter; the real
 * hook drives the real row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { LocalModuleInfo } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  desktop: true,
  modulesList: vi.fn<() => Promise<unknown[]>>(),
  moduleEnable: vi.fn<(id: string) => Promise<unknown>>(),
  moduleDisable: vi.fn<(id: string) => Promise<unknown>>(),
  moduleRemoveAssets: vi.fn<(id: string) => Promise<unknown>>(),
  statusListeners: new Set<(info: unknown) => void>(),
  openExternalUrl: vi.fn<(url: string) => Promise<void>>(),
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => bridge.desktop }))
vi.mock('@/lib/open-external', () => ({ openExternalUrl: (url: string) => bridge.openExternalUrl(url) }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    modulesList: () => bridge.modulesList(),
    moduleEnable: (id: string) => bridge.moduleEnable(id),
    moduleDisable: (id: string) => bridge.moduleDisable(id),
    moduleRemoveAssets: (id: string) => bridge.moduleRemoveAssets(id),
    onModuleStatus: async (cb: (info: unknown) => void) => {
      bridge.statusListeners.add(cb)
      return () => { bridge.statusListeners.delete(cb) }
    },
  },
}))

import { useLocalModule } from '@/hooks/use-local-module'
import { LocalModuleLink, LocalModuleRow, type LocalModuleRowProps } from '../local-module-row'

const base: LocalModuleInfo = {
  id: 'local-stt',
  version: '97a15af',
  enabled: false,
  state: 'off',
  progress: null,
  downloadBytes: 807_000_000,
  assetsPresent: false,
  error: null,
}

function Harness({ attribution }: Pick<LocalModuleRowProps, 'attribution'>) {
  const mod = useLocalModule('local-stt')
  return h(LocalModuleRow, {
    module: mod,
    testId: 'row',
    title: 'Local transcription',
    badge: 'Beta',
    description: 'Transcribe and identify speakers on this Mac.',
    pendingNote: 'Until it is ready, meetings are transcribed in the cloud.',
    hint: 'Recommended for Macs with 16 GB+ memory.',
    attribution,
  })
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  bridge.desktop = true
  bridge.modulesList.mockReset().mockResolvedValue([base])
  bridge.moduleEnable.mockReset().mockImplementation(async () => ({ ...base, enabled: true, state: 'downloading', progress: 0 }))
  bridge.moduleDisable.mockReset().mockImplementation(async () => ({ ...base, enabled: false, state: 'off' }))
  bridge.moduleRemoveAssets.mockReset().mockImplementation(async () => ({ ...base, enabled: false, state: 'off', assetsPresent: false }))
  bridge.statusListeners.clear()
  bridge.openExternalUrl.mockReset().mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

async function mount(props: Pick<LocalModuleRowProps, 'attribution'> = {}) {
  await act(async () => { root.render(h(Harness, props)) })
  await flush()
}

async function emitStatus(info: Partial<LocalModuleInfo>) {
  await act(async () => {
    for (const cb of bridge.statusListeners) cb({ ...base, ...info })
  })
}

const row = () => host.querySelector('[data-testid="row"]') as HTMLElement | null
const button = (label: RegExp) =>
  [...row()!.querySelectorAll('button')].find((b) => label.test(b.textContent || '')) as HTMLButtonElement | undefined

describe('LocalModuleRow — capability probe', () => {
  it('renders nothing in a browser (and never asks the bridge)', async () => {
    bridge.desktop = false
    await mount()
    expect(row()).toBeNull()
    expect(host.textContent).toBe('')
    expect(bridge.modulesList).not.toHaveBeenCalled()
  })

  it('renders nothing on a desktop build without Local Modules (modules_list → [])', async () => {
    bridge.modulesList.mockResolvedValue([])
    await mount()
    expect(row()).toBeNull()
  })

  it('renders nothing when the desktop has modules but not this one', async () => {
    bridge.modulesList.mockResolvedValue([{ ...base, id: 'local-tts' }])
    await mount()
    expect(row()).toBeNull()
  })
})

describe('LocalModuleRow — states', () => {
  it('waiting (not turned on yet): title, Beta, description with the size it will download, hint; no controls to choose with', async () => {
    await mount()
    const text = row()!.textContent || ''
    expect(text).toContain('Local transcription')
    expect(text).toContain('Beta')
    expect(text).toContain('Transcribe and identify speakers on this Mac. Downloads automatically (~800 MB).')
    expect(text).toContain('Waiting to download')
    expect(text).toContain('Until it is ready, meetings are transcribed in the cloud.')
    expect(text).toContain('Recommended for Macs with 16 GB+ memory.')
    expect(row()!.querySelector('[role="switch"]')).toBeNull()
    expect(row()!.querySelectorAll('button')).toHaveLength(0)
    // No attribution passed: no credit line, no links.
    expect(row()!.querySelector('a')).toBeNull()
  })

  it('attribution: a credit line after the hint whose links open in the OS browser', async () => {
    const license = 'https://example.com/model-license/'
    await mount({
      attribution: h('span', null, 'Models by Example (', h(LocalModuleLink, { href: license, children: 'Example License' }), ')'),
    })
    const credit = [...row()!.querySelectorAll('p')].find((p) => p.textContent === 'Models by Example (Example License)')
    expect(credit).toBeDefined()
    // Last line of the text block: after the description and the hint.
    expect(credit!.previousElementSibling?.textContent).toBe('Recommended for Macs with 16 GB+ memory.')
    expect(credit!.className).toContain('text-muted-foreground')

    const link = credit!.querySelector('a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(license)
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { link.dispatchEvent(click) })
    // Handed to the opener, not left to the webview's (swallowed) navigation.
    expect(click.defaultPrevented).toBe(true)
    expect(bridge.openExternalUrl).toHaveBeenCalledWith(license)
  })

  it('follows module://status from waiting to Ready', async () => {
    await mount()
    await emitStatus({ enabled: true, state: 'downloading', progress: 0.42 })
    expect(row()!.textContent).toContain('Downloading 42%')
    expect(row()!.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42')
    // The size shows as progress, with what happens meanwhile.
    expect(row()!.textContent).not.toContain('Downloads automatically')
    expect(row()!.textContent).toContain('Until it is ready, meetings are transcribed in the cloud.')

    // A file verifying mid-set is still the one download (no flicker).
    await emitStatus({ enabled: true, state: 'verifying', progress: 0.87 })
    expect(row()!.textContent).toContain('Downloading 87%')
    expect(row()!.textContent).not.toContain('Verifying')

    await emitStatus({ enabled: true, state: 'verifying', progress: null, assetsPresent: false })
    expect(row()!.textContent).toContain('Verifying')

    await emitStatus({ enabled: true, state: 'warming', assetsPresent: true })
    expect(row()!.textContent).toContain('Setting up')

    await emitStatus({ enabled: true, state: 'ready', assetsPresent: true })
    expect(row()!.textContent).toContain('Ready')
    expect(row()!.querySelector('[role="progressbar"]')).toBeNull()
    expect(row()!.querySelector('[data-local-module-pending]')).toBeNull()
    expect(row()!.querySelectorAll('button')).toHaveLength(0)
  })

  it('a download shows how far it is in MB, with nothing to cancel', async () => {
    bridge.modulesList.mockResolvedValue([{ ...base, enabled: true, state: 'downloading', progress: 0.5 }])
    await mount()
    expect(row()!.textContent).toContain('400 MB of 800 MB')
    expect(row()!.querySelectorAll('button')).toHaveLength(0)
  })

  it('error: says what went wrong in plain words, with Try again (re-enable)', async () => {
    const raw = 'nemotron.gguf failed its checksum — the download was discarded'
    bridge.modulesList.mockResolvedValue([{ ...base, enabled: true, state: 'error', assetsPresent: true, error: raw }])
    await mount()
    const text = row()!.textContent || ''
    expect(text).toContain('Didn’t finish')
    expect(text).toContain('The download came through damaged. Try again to download it fresh.')
    // The keeper retries a failed download on its own; the desktop's wording stays on hover.
    expect(text).toContain('Dial8 also keeps trying in the background.')
    expect(row()!.querySelector(`[title="${raw}"]`)).not.toBeNull()
    expect(button(/Remove downloaded files/)).toBeUndefined()

    await act(async () => { button(/Try again/)!.click() })
    await flush()
    expect(bridge.moduleEnable).toHaveBeenCalledWith('local-stt')
  })

  it('a Try again the desktop rejects keeps the last state and says why', async () => {
    bridge.modulesList.mockResolvedValue([{ ...base, enabled: true, state: 'error', error: 'download of asr.gguf failed: HTTP 503' }])
    bridge.moduleEnable.mockRejectedValue(new Error('Not enough disk space (needs 1.8 GB)'))
    await mount()
    await act(async () => { button(/Try again/)!.click() })
    await flush()
    expect(row()!.textContent).toContain('Not enough disk space. Free up some space, then try again.')
    // A command that failed is the user's to retry: no background promise.
    expect(row()!.textContent).not.toContain('keeps trying')
  })

  it('unavailable (sidecar missing from this build): says so, nothing to press', async () => {
    bridge.modulesList.mockResolvedValue([{ ...base, state: 'unavailable' }])
    await mount()
    expect(row()!.textContent).toContain('Not in this version')
    expect(row()!.textContent).not.toContain('Waiting to download')
    expect(row()!.querySelectorAll('button')).toHaveLength(0)
  })

  it('ignores status events for other modules', async () => {
    await mount()
    await act(async () => {
      for (const cb of bridge.statusListeners) cb({ ...base, id: 'local-tts', enabled: true, state: 'ready' })
    })
    expect(row()!.textContent).toContain('Waiting to download')
    expect(row()!.textContent).not.toContain('Ready')
  })
})
