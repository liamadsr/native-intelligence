// @vitest-environment jsdom
/**
 * The shared destination-picker plumbing, tested where the three provider
 * suites CAN'T reach it.
 *
 * asana/jira/linear-destination.test.tsx exercise this hook through the real
 * component, and they are the parity proof for the extraction — but each of
 * them only ever sees ONE configuration of it. The two options that make the
 * hook shared rather than generic (`adoptResponseConfig`,
 * `reconnectOnSaveFailure`) are ON for exactly one provider and OFF for two, so
 * nothing in those suites pins that they are OPTIONS at all: a future edit that
 * hard-wired either behaviour on for everyone would leave all three green while
 * silently widening Asana's and Jira's save paths.
 *
 * That is what these tests exist for — the option matrix, and the cancelled
 * guard that no rendered suite can observe.
 *
 * Rendered standalone with createRoot/act (no @testing-library in this repo).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { useDestinationPicker } from '../use-destination-picker'
import { TASK_DESTINATIONS_CHANGED } from '@/lib/tasks/destinations-events'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface TestConfig {
  team_id?: string
  team_name?: string
  derived?: string
  [key: string]: unknown
}

type Picker = ReturnType<typeof useDestinationPicker<TestConfig, Record<string, unknown>>>

const SETTINGS_URL = '/api/account/workspace/test-settings'
const PICKER_URL = '/api/account/test/options'

let container: HTMLDivElement
let root: Root
/** The most recent render's hook value — the handle every test drives. */
let latest: Picker
/** Bodies of every PATCH the hook sent. */
let patches: Array<Record<string, unknown>>
/** Whatever the first-picker `onLoad` was handed. */
let loaded: Array<Record<string, unknown>>

function Probe({
  options,
}: {
  options?: Partial<Parameters<typeof useDestinationPicker<TestConfig, Record<string, unknown>>>[0]>
}) {
  const picker = useDestinationPicker<TestConfig, Record<string, unknown>>({
    enabled: true,
    settingsUrl: SETTINGS_URL,
    settingsLabel: 'your test settings',
    saveErrorMessage: 'Failed to save test settings',
    firstPicker: {
      url: PICKER_URL,
      label: 'your test options',
      // Stable by construction: it only pushes into a module-scoped array.
      onLoad: onFirstPickerLoad,
      ...(options?.firstPicker ?? {}),
    },
    ...options,
  })
  latest = picker
  return null
}

function onFirstPickerLoad(data: Record<string, unknown>) {
  loaded.push(data)
}

interface FetchPlan {
  /** Body of the settings GET. */
  config?: Record<string, unknown>
  /** Non-ok response for the settings GET. */
  failSettings?: { status: number; body: Record<string, unknown> }
  /** Non-ok response for the first-picker GET. */
  failPicker?: { status: number; body: Record<string, unknown> }
  /** Non-ok response for the PATCH. */
  failPatch?: { status: number; body: Record<string, unknown> }
  /** `config` the successful PATCH echoes back. */
  patchConfig?: Record<string, unknown>
}

function installFetch(plan: FetchPlan = {}) {
  patches = []
  loaded = []
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(SETTINGS_URL)) {
        if (init?.method === 'PATCH') {
          patches.push(JSON.parse(String(init.body)))
          if (plan.failPatch) {
            return { ok: false, status: plan.failPatch.status, json: async () => plan.failPatch!.body }
          }
          return json({ config: plan.patchConfig ?? {} })
        }
        if (plan.failSettings) {
          return {
            ok: false,
            status: plan.failSettings.status,
            json: async () => plan.failSettings!.body,
          }
        }
        return json({ config: plan.config ?? {} })
      }
      if (url.startsWith(PICKER_URL)) {
        if (plan.failPicker) {
          return { ok: false, status: plan.failPicker.status, json: async () => plan.failPicker!.body }
        }
        return json({ options: [{ id: 'o-1' }] })
      }
      return json({})
    }) as unknown as typeof fetch,
  )
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

async function mount(
  options?: Partial<Parameters<typeof useDestinationPicker<TestConfig, Record<string, unknown>>>[0]>,
) {
  await act(async () => {
    root.render(h(Probe, { options }))
  })
  await flush()
  await flush()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // `installFetch` also resets these, but the tests that stub `fetch` directly
  // never call it — and `onFirstPickerLoad` pushes into `loaded` unconditionally.
  // Left undefined it throws INSIDE the load effect's `.then`, which the
  // effect's own `.catch` then reports as a first-picker load failure: harness
  // noise that looks exactly like the failure some of these tests assert about.
  patches = []
  loaded = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

// ---- the load ---------------------------------------------------------------

describe('useDestinationPicker — the settings + first-picker load', () => {
  it('adopts the saved config and hands the picker body to onLoad', async () => {
    installFetch({ config: { team_id: 't-1', team_name: 'Engineering' } })
    await mount()

    expect(latest.config).toEqual({ team_id: 't-1', team_name: 'Engineering' })
    expect(loaded).toEqual([{ options: [{ id: 'o-1' }] }])
  })

  it('reads a MISSING config as an empty object, not null', async () => {
    // `null` means "not loaded yet" and gates the attribution toggle's disabled
    // state; a connected workspace that has picked nothing must not read as
    // still-loading forever.
    installFetch({ config: undefined })
    await mount()

    expect(latest.config).toEqual({})
  })

  it('does nothing at all when disabled', async () => {
    // Three instances of this hook mount on every visit to this page; only the
    // one matching the provider being viewed may issue requests.
    installFetch()
    await mount({ enabled: false })

    expect(fetch).not.toHaveBeenCalled()
    expect(latest.config).toBeNull()
  })

  // The SETTINGS leg goes through the same classifier as the picker leg. No
  // provider suite fails this request — they all fail a picker endpoint or the
  // PATCH — so a refactor that read the settings body directly
  // (`.then(r => r.json())`) instead of routing it through `readPicker` would
  // lose classification here and stay green everywhere else.
  it('classifies a failed SETTINGS load as a retryable inline error', async () => {
    installFetch({ failSettings: { status: 500, body: {} } })
    await mount()

    expect(latest.loadError).toBe("Couldn't load your test settings.")
    // Nothing was adopted from the failed body.
    expect(latest.config).toBeNull()
  })

  it('raises the banner when the SETTINGS load returns a reconnect code', async () => {
    installFetch({
      failSettings: { status: 400, body: { code: 'reconnect_required', error: 'nope' } },
    })
    await mount()

    expect(latest.reconnectRequired).toBe(true)
    expect(latest.loadError).toBeNull()
    expect(latest.config).toBeNull()
  })

  it('reports a thrown load request rather than hanging on null forever', async () => {
    // Covers the load effect's `.catch` fallbacks: a network throw never reaches
    // readPicker, so the message comes from the effect itself. BOTH legs throw
    // here and both write `loadError`, so which of the two labels wins is a race
    // — asserting either exact string would pin resolution order rather than
    // behaviour. What the user is owed is a retryable message naming the leg,
    // and a config that stays null instead of a silent blank page.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network')
      }) as unknown as typeof fetch,
    )
    await mount()

    expect(latest.loadError).toMatch(/^Couldn't load your test (settings|options)\.$/)
    expect(latest.reconnectRequired).toBe(false)
    expect(latest.config).toBeNull()
  })
})

// ---- the classifier ---------------------------------------------------------

describe('useDestinationPicker — readPicker classifies failures', () => {
  it('raises the reconnect flag for `reconnect_required`', async () => {
    installFetch({ failPicker: { status: 400, body: { code: 'reconnect_required', error: 'nope' } } })
    await mount()

    expect(latest.reconnectRequired).toBe(true)
    // The banner REPLACES the pickers, so the inline error must stay silent —
    // two failure surfaces for one failure reads as two problems.
    expect(latest.loadError).toBeNull()
  })

  it('treats `not_connected` the same way — the user’s fix is identical', async () => {
    installFetch({ failPicker: { status: 400, body: { code: 'not_connected', error: 'nope' } } })
    await mount()

    expect(latest.reconnectRequired).toBe(true)
  })

  it('routes any OTHER failure to the retryable inline error', async () => {
    installFetch({ failPicker: { status: 500, body: { error: 'Upstream is down' } } })
    await mount()

    expect(latest.loadError).toBe('Upstream is down')
    // Reconnecting would not fix a 5xx.
    expect(latest.reconnectRequired).toBe(false)
  })

  it('falls back to a "Couldn’t load X" message when the body names no error', async () => {
    installFetch({ failPicker: { status: 500, body: {} } })
    await mount()

    expect(latest.loadError).toBe("Couldn't load your test options.")
  })

  it('ignores an unrecognised code rather than treating it as a reconnect', async () => {
    installFetch({ failPicker: { status: 400, body: { code: 'rate_limited', error: 'slow down' } } })
    await mount()

    expect(latest.reconnectRequired).toBe(false)
    expect(latest.loadError).toBe('slow down')
  })
})

// ---- retry ------------------------------------------------------------------

describe('useDestinationPicker — retry', () => {
  it('clears BOTH failure states and re-runs the load', async () => {
    installFetch({ failPicker: { status: 500, body: { error: 'Upstream is down' } } })
    await mount()
    expect(latest.loadError).toBe('Upstream is down')

    installFetch({ config: { team_id: 't-1' } })
    await act(async () => latest.retry())
    await flush()

    expect(latest.loadError).toBeNull()
    expect(latest.reconnectRequired).toBe(false)
    expect(latest.config).toEqual({ team_id: 't-1' })
    // The first-picker fetch re-ran too — installFetch reset `loaded` before the
    // retry, so this can only be the post-retry body. Guards a future effect
    // split that leaves the first picker keyed off mount only, which would
    // reload the settings but leave the dropdown permanently empty.
    expect(loaded).toEqual([{ options: [{ id: 'o-1' }] }])
  })

  it('bumps retryKey so the caller’s cascade effects re-run too', async () => {
    // The downstream pickers (projects, sections, statuses) live in the host
    // component and list retryKey as a dependency — Retry has to move them as
    // well, or half the page stays broken.
    installFetch()
    await mount()
    const before = latest.retryKey

    await act(async () => latest.retry())
    await flush()

    expect(latest.retryKey).toBe(before + 1)
  })
})

// ---- the save funnel --------------------------------------------------------

describe('useDestinationPicker — save', () => {
  it('merges the patch optimistically, then announces on 2xx', async () => {
    installFetch({ config: { team_id: 't-1', team_name: 'Engineering' } })
    await mount()

    let announced = 0
    const onChanged = () => {
      announced++
    }
    window.addEventListener(TASK_DESTINATIONS_CHANGED, onChanged)

    await act(async () => {
      await latest.save({ team_name: 'Renamed' })
    })
    await flush()
    window.removeEventListener(TASK_DESTINATIONS_CHANGED, onChanged)

    expect(patches).toEqual([{ team_name: 'Renamed' }])
    expect(latest.config).toEqual({ team_id: 't-1', team_name: 'Renamed' })
    expect(announced).toBeGreaterThan(0)
    expect(latest.saving).toBe(false)
  })

  it('lets an explicit `optimistic` REPLACE rather than merge', async () => {
    // This is what the clear handlers rely on: a merge can only ever ADD keys,
    // and a clear REMOVES them.
    installFetch({ config: { team_id: 't-1', team_name: 'Engineering' } })
    await mount()

    await act(async () => {
      await latest.save({ team_id: null }, { derived: 'only this' })
    })
    await flush()

    expect(latest.config).toEqual({ derived: 'only this' })
  })

  it('REVERTS to the pre-save config and stays SILENT when the PATCH fails', async () => {
    // Nothing moved, so nothing downstream is stale — announcing would send the
    // push menu to re-read a destination that never changed.
    installFetch({
      config: { team_id: 't-1', team_name: 'Engineering' },
      failPatch: { status: 500, body: { error: 'Failed upstream' } },
    })
    await mount()

    let announced = 0
    const onChanged = () => {
      announced++
    }
    window.addEventListener(TASK_DESTINATIONS_CHANGED, onChanged)

    await act(async () => {
      await latest.save({ team_name: 'Renamed' })
    })
    await flush()
    window.removeEventListener(TASK_DESTINATIONS_CHANGED, onChanged)

    expect(latest.config).toEqual({ team_id: 't-1', team_name: 'Engineering' })
    expect(latest.error).toBe('Failed upstream')
    expect(announced).toBe(0)
    expect(latest.saving).toBe(false)
  })

  it('falls back to the provider’s save message when the body names no error', async () => {
    installFetch({ config: {}, failPatch: { status: 500, body: {} } })
    await mount()

    await act(async () => {
      await latest.save({ team_name: 'Renamed' })
    })
    await flush()

    expect(latest.error).toBe('Failed to save test settings')
  })

  it('reverts and reports on a thrown request too', async () => {
    installFetch({ config: { team_id: 't-1' } })
    await mount()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network')
      }) as unknown as typeof fetch,
    )

    await act(async () => {
      await latest.save({ team_name: 'Renamed' })
    })
    await flush()

    expect(latest.config).toEqual({ team_id: 't-1' })
    expect(latest.error).toBe('Failed to save test settings')
    expect(latest.saving).toBe(false)
  })

  it('raises `saving` for the duration of the PATCH and lowers it after', async () => {
    // Every provider gates its spinners and disabled states on this flag (a
    // dozen sites in integration-detail-view.tsx), so a dropped
    // `finally { setSaving(false) }` leaves the whole section stuck mid-save.
    let releasePatch!: () => void
    const gate = new Promise<void>((r) => {
      releasePatch = r
    })
    installFetch({ config: { team_id: 't-1' } })
    await mount()
    expect(latest.saving).toBe(false)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate
        return { ok: true, status: 200, json: async () => ({ config: {} }) }
      }) as unknown as typeof fetch,
    )

    // Deliberately NOT awaited: the point is to observe the in-flight state.
    let saved!: Promise<void>
    await act(async () => {
      saved = latest.save({ team_name: 'Renamed' })
    })
    await flush()
    expect(latest.saving).toBe(true)

    await act(async () => {
      releasePatch()
      await saved
    })
    await flush()

    expect(latest.saving).toBe(false)
  })

  it('clears a previous save error when a NEW save starts', async () => {
    // Otherwise a failure's message stands over a later success, telling the
    // user their saved destination did not save.
    installFetch({ config: { team_id: 't-1' }, failPatch: { status: 500, body: { error: 'Failed upstream' } } })
    await mount()

    await act(async () => {
      await latest.save({ team_name: 'First' })
    })
    await flush()
    expect(latest.error).toBe('Failed upstream')

    installFetch({ config: { team_id: 't-1' } })
    await act(async () => {
      await latest.save({ team_name: 'Second' })
    })
    await flush()

    expect(latest.error).toBeNull()
    expect(latest.config).toEqual({ team_id: 't-1', team_name: 'Second' })
  })
})

// ---- the two per-provider options -------------------------------------------

/**
 * The whole reason this is a hook with options rather than three copies or one
 * generic component. Both default OFF and are ON only for Linear; a change that
 * hard-wired either one on would pass all three provider suites.
 */
describe('useDestinationPicker — adoptResponseConfig (Linear only)', () => {
  it('OFF by default: the optimistic state survives a 2xx, the echo is ignored', async () => {
    // Asana's and Jira's routes store exactly what they were sent, so there is
    // nothing in the echo the client doesn't already know — and adopting it
    // would let an unrelated server-side shape change stomp local state.
    installFetch({ config: {}, patchConfig: { derived: 'from server' } })
    await mount()

    await act(async () => {
      await latest.save({ team_id: 't-1' })
    })
    await flush()

    expect(latest.config).toEqual({ team_id: 't-1' })
    expect(latest.config?.derived).toBeUndefined()
  })

  it('ON: the echoed config REPLACES local state, carrying the server-derived part', async () => {
    // Linear's `state_map` is derived at save time and exists in no other
    // response; ignoring the echo leaves the read-only mapping blank.
    installFetch({
      config: {},
      patchConfig: { team_id: 't-1', derived: 'from server' },
    })
    await mount({ adoptResponseConfig: true })

    await act(async () => {
      await latest.save({ team_id: 't-1' })
    })
    await flush()

    expect(latest.config).toEqual({ team_id: 't-1', derived: 'from server' })
  })

  it('ON: adopts the echo even when it is EMPTY — the server is the authority', async () => {
    // Pinning the exact guard (`if (body.config)`, not a key-count check) that
    // the Linear saver shipped with: an echoed `{}` means the server stored an
    // empty config, and the read-only state map must show that rather than the
    // optimistic value the clear was trying to remove. A `{}`-is-noise
    // "improvement" here would resurrect stale state after a clear.
    installFetch({ config: {}, patchConfig: {} })
    await mount({ adoptResponseConfig: true })

    await act(async () => {
      await latest.save({ team_id: 't-1' })
    })
    await flush()

    expect(latest.config).toEqual({})
  })

  it('ON: keeps the optimistic state when the response carries NO config key', async () => {
    installFetch({ config: {} })
    await mount({ adoptResponseConfig: true, settingsUrl: SETTINGS_URL })
    // A PATCH whose body has no `config` at all (a bare `{ok:true}`) leaves the
    // optimistic state standing rather than blanking it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as unknown as typeof fetch,
    )

    await act(async () => {
      await latest.save({ team_id: 't-1' })
    })
    await flush()

    expect(latest.config).toEqual({ team_id: 't-1' })
  })
})

describe('useDestinationPicker — reconnectOnSaveFailure (Linear only)', () => {
  it('OFF by default: a reconnect code on a SAVE still lands in the inline error', async () => {
    // The load-bearing negative. Asana's and Jira's PATCH routes cannot emit
    // this code — only Linear's talks to the provider on save — so routing it
    // to the banner for them would be a behaviour change no route can trigger
    // and no test would catch. If a future provider's route starts deriving
    // server-side, it opts IN here rather than inheriting.
    installFetch({
      config: {},
      failPatch: { status: 400, body: { code: 'reconnect_required', error: 'Reconnect' } },
    })
    await mount()

    await act(async () => {
      await latest.save({ team_id: 't-1' })
    })
    await flush()

    expect(latest.reconnectRequired).toBe(false)
    expect(latest.error).toBe('Reconnect')
  })

  it('ON: a reconnect code on a SAVE raises the banner instead of the error', async () => {
    // Seeded non-empty so the revert is observable: the banner path is still a
    // FAILURE path, and it must behave like every other one.
    installFetch({
      config: { team_id: 't-0', team_name: 'Before' },
      failPatch: { status: 400, body: { code: 'reconnect_required', error: 'Reconnect' } },
    })
    await mount({ reconnectOnSaveFailure: true })

    let announced = 0
    const onChanged = () => {
      announced++
    }
    window.addEventListener(TASK_DESTINATIONS_CHANGED, onChanged)

    await act(async () => {
      await latest.save({ team_id: 't-1' })
    })
    await flush()
    window.removeEventListener(TASK_DESTINATIONS_CHANGED, onChanged)

    expect(latest.reconnectRequired).toBe(true)
    // The banner replaces the pickers; an inline error underneath it would be a
    // second account of one failure.
    expect(latest.error).toBeNull()
    // The route stored NOTHING, so the optimistic destination must not survive
    // behind the banner, and the push menu must not be told to re-read.
    expect(latest.config).toEqual({ team_id: 't-0', team_name: 'Before' })
    expect(announced).toBe(0)
  })

  it('ON: a NON-reconnect save failure still uses the inline error', async () => {
    installFetch({ config: {}, failPatch: { status: 500, body: { error: 'Upstream is down' } } })
    await mount({ reconnectOnSaveFailure: true })

    await act(async () => {
      await latest.save({ team_id: 't-1' })
    })
    await flush()

    expect(latest.reconnectRequired).toBe(false)
    expect(latest.error).toBe('Upstream is down')
  })
})

// ---- the cancelled guard ----------------------------------------------------

describe('useDestinationPicker — the cancelled guard', () => {
  it('a slow settings GET resolving after retry does not overwrite the fresher config', async () => {
    // What the guard is actually FOR. The component stays mounted throughout and
    // every assertion reads `latest` (the live render's handle) rather than a
    // snapshot, so the stale write is observable: without the `cancelled = true`
    // cleanup the first run's settings body lands on top of the retry's.
    let releaseSettings!: () => void
    const gate = new Promise<void>((r) => {
      releaseSettings = r
    })
    let settingsCalls = 0

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input)
        if (url.startsWith(SETTINGS_URL)) {
          const first = settingsCalls++ === 0
          return {
            ok: true,
            status: 200,
            json: async () => {
              // Only the FIRST settings GET is held open; the retry's resolves
              // immediately, so the stale one lands last.
              if (first) await gate
              return { config: first ? { team_id: 'stale' } : { team_id: 'fresh' } }
            },
          }
        }
        return { ok: true, status: 200, json: async () => ({ options: [{ id: 'o-1' }] }) }
      }) as unknown as typeof fetch,
    )

    await act(async () => {
      root.render(h(Probe, {}))
    })
    await flush()
    // The first settings GET is still in flight behind the gate.
    expect(latest.config).toBeNull()

    await act(async () => latest.retry())
    await flush()
    expect(latest.config).toEqual({ team_id: 'fresh' })

    // Now the ORIGINAL, slower GET finally answers. Its effect run was cancelled
    // by the retry, so its body must be dropped on the floor.
    await act(async () => {
      releaseSettings()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    await flush()

    expect(latest.config).toEqual({ team_id: 'fresh' })
  })

  /**
   * The failure side of the same race, and the reason this is a behaviour fix
   * rather than part of the extraction.
   *
   * The guard only ever covered the SUCCESS path: the classifier's two setters
   * live inside `readPicker`, where the effect run's `cancelled` flag wasn't in
   * scope. So the retry that repaired the page could be un-repaired seconds
   * later by the request it replaced — healthy pickers on screen, and a
   * reconnect banner or inline error thrown over them by a response about a
   * state that no longer exists.
   *
   * The first two below FAIL without the threaded flag — one per arm of the
   * classifier. The third does not, and is here to say why: a thrown fetch
   * never reaches `readPicker` at all, so the effect's own `.catch` was already
   * inside the guard and always dropped its stale write correctly. It is a
   * regression guard for the arm that was right, not evidence of the bug —
   * keeping the three together is what documents that the gap was specifically
   * in the classifier and not in the effect.
   */
  /** A settings GET whose FIRST call is held open and answers `first`, and whose retry answers ok+fresh. */
  function stubSlowFirstSettings(first: () => Promise<unknown>) {
    let releaseSettings!: () => void
    const gate = new Promise<void>((r) => {
      releaseSettings = r
    })
    let settingsCalls = 0

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input)
        if (url.startsWith(SETTINGS_URL)) {
          if (settingsCalls++ === 0) {
            await gate
            return first()
          }
          return { ok: true, status: 200, json: async () => ({ config: { team_id: 'fresh' } }) }
        }
        return { ok: true, status: 200, json: async () => ({ options: [{ id: 'o-1' }] }) }
      }) as unknown as typeof fetch,
    )
    return () => releaseSettings()
  }

  /** Mount, retry into a healthy state, then let the stale first request answer. */
  async function retryThenReleaseStale(release: () => void) {
    await act(async () => {
      root.render(h(Probe, {}))
    })
    await flush()

    await act(async () => latest.retry())
    await flush()
    // The retry succeeded: this is the healthy state the stale failure threatens.
    expect(latest.config).toEqual({ team_id: 'fresh' })

    await act(async () => {
      release()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    await flush()
  }

  it('a stale RECONNECT failure resolving after a good retry does not raise the banner', async () => {
    const release = stubSlowFirstSettings(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ code: 'reconnect_required', error: 'nope' }),
    }))

    await retryThenReleaseStale(release)

    // The banner REPLACES the pickers wholesale and tells the user to reconnect
    // an account that is demonstrably working — the retry just used it.
    expect(latest.reconnectRequired).toBe(false)
    expect(latest.config).toEqual({ team_id: 'fresh' })
  })

  it('a stale 5xx resolving after a good retry does not raise the inline error', async () => {
    const release = stubSlowFirstSettings(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Upstream is down' }),
    }))

    await retryThenReleaseStale(release)

    expect(latest.loadError).toBeNull()
    expect(latest.config).toEqual({ team_id: 'fresh' })
  })

  // Already correct before the fix — see the note above.
  it('a stale THROW resolving after a good retry does not raise the catch fallback', async () => {
    const release = stubSlowFirstSettings(async () => {
      throw new Error('network')
    })

    await retryThenReleaseStale(release)

    expect(latest.loadError).toBeNull()
    expect(latest.reconnectRequired).toBe(false)
    expect(latest.config).toEqual({ team_id: 'fresh' })
  })
})
