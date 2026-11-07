// @vitest-environment jsdom
/**
 * THE PROVIDER MUST NOT WIPE THE WORKSPACE SEED ON ITS FIRST COMMIT.
 *
 * `lib/workspace-fetch` seeds the active workspace id at MODULE LOAD — from
 * localStorage['dial8-workspace-id'], or from a `?switch_to=<uuid>` URL param
 * on a freshly-opened desktop workspace window. The patched `window.fetch`
 * attaches that id as `x-workspace-id` on every `/api/` request.
 *
 * WorkspaceCacheProvider's `currentId` starts as null, and its effects run in
 * declaration order: the sync effect fires BEFORE the load effect's first GET.
 * So an unguarded `setClientWorkspaceId(currentId)` wiped the seed — memory AND
 * localStorage — a tick before the first /api/account/workspace GET went out.
 * That GET then carried no header, the server resolved the workspace from the
 * cookie and fell back to the user's OLDEST membership (lib/workspace.ts
 * getCurrentWorkspaceId), and the window booted into the wrong workspace.
 *
 * These specs run against the REAL interceptor — a mocked workspace-fetch would
 * assert the call and miss the localStorage wipe and the missing header, which
 * are the two things that actually hurt. The base fetch is installed BEFORE the
 * module loads so `patchFetch()` wraps it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => false }))
vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => null }))
vi.mock('../workspace-transition', () => ({
  useWorkspaceTransition: () => ({
    beginTransition: (_target: unknown, commit: () => void) => commit(),
  }),
}))
vi.mock('../(dashboard)/settings-overlay', () => ({ useOptionalSettingsOverlay: () => null }))
vi.mock('../create-workspace-wizard', () => ({ CreateWorkspaceWizard: () => null }))
// The interceptor lazily imports the Supabase browser client to attach a Bearer
// token. Signed-out stub: this suite is about the workspace header, not auth.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}))

const STORAGE_KEY = 'dial8-workspace-id'
const SEED_ID = '11111111-2222-3333-4444-555555555555'
/** list + workspace + profile — the provider's whole boot burst. */
const BOOT_CALLS = 3
/** How long the burst may take to land: real time, not a tick count (see mountFresh). */
const BURST_DEADLINE_MS = 3_000

/** One recorded `/api/` call: the URL, and the header the interceptor put on it
 *  (which is exactly what the server reads to resolve the workspace). */
interface Recorded {
  url: string
  workspaceHeader: string | null
}

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

describe('WorkspaceCacheProvider — boot seed survives the first commit', () => {
  let container: HTMLDivElement
  let root: Root
  let removeItemSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    localStorage.clear()
    window.history.replaceState({}, '', '/account')
    removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem')
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /**
   * Install the base fetch, then load a FRESH copy of the module graph so
   * workspace-fetch re-runs its module-load seed restore against the
   * localStorage / URL state the test just set, and `patchFetch()` wraps this
   * stub rather than a previous test's.
   *
   * The recorder array is created per mount, NOT shared across the suite: the
   * boot burst is three concurrent requests and the interceptor adds its own
   * await (the Bearer token) before each one, so stragglers from the previous
   * test would otherwise land in this one's recorder and read as its own calls.
   */
  async function mountFresh(): Promise<Recorded[]> {
    const calls: Recorded[] = []
    const baseFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input)
      calls.push({ url, workspaceHeader: new Headers(init?.headers).get('x-workspace-id') })
      if (url === '/api/account/workspace/list') {
        return jsonRes({
          workspaces: [
            { id: SEED_ID, name: 'Seeded', slug: 'seeded', logo_url: null, plan: 'pro', role: 'owner' },
          ],
        })
      }
      if (url === '/api/account/workspace') {
        return jsonRes({
          workspace: { id: SEED_ID },
          currentMemberId: 'm-1',
          members: [{ id: 'm-1', user_id: 'u-1', email: 'liam@dial8.ai', display_name: 'Liam', avatar_url: null }],
        })
      }
      if (url === '/api/account/profile') return jsonRes({ avatar_url: null })
      return jsonRes({})
    })
    vi.stubGlobal('fetch', baseFetch)

    vi.resetModules()
    // Each /api/ call awaits the interceptor's lazy import of the Supabase client before it
    // reaches fetch. After resetModules that import goes back through the module loader, whose
    // latency is the machine's load, not a number of ticks: under the Vercel build's suite only
    // 1 of the 3 calls had landed after 50 ticks. Loading it here puts it in the fresh registry.
    await import('@/lib/supabase/client')
    const { WorkspaceCacheProvider } = await import('../workspace-switcher')
    await act(async () => {
      root.render(h(WorkspaceCacheProvider, null, null))
    })
    // Let the whole burst land before anything is asserted about it.
    const deadline = Date.now() + BURST_DEADLINE_MS
    while (calls.length < BOOT_CALLS && Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    return calls
  }

  /** The header on the FIRST active-workspace GET — the one the wipe used to beat. */
  function workspaceGetHeader(calls: Recorded[]) {
    return calls.find((c) => c.url === '/api/account/workspace')?.workspaceHeader
  }

  it('keeps a localStorage-seeded id and sends it on the first workspace GET', async () => {
    localStorage.setItem(STORAGE_KEY, SEED_ID)

    const calls = await mountFresh()

    // The wipe, both halves: the persisted seed is intact...
    expect(removeItemSpy).not.toHaveBeenCalledWith(STORAGE_KEY)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(SEED_ID)
    // ...and the in-memory one reached the very first GET as a header, so the
    // server never had to fall back to cookie → oldest membership.
    expect(workspaceGetHeader(calls)).toBe(SEED_ID)
  })

  it('keeps a `?switch_to=` seed too — the freshly-opened desktop window case', async () => {
    // No localStorage at all: a new Tauri workspace window has its own
    // data_directory, so the URL param is the ONLY thing pointing at the right
    // workspace when it boots.
    window.history.replaceState({}, '', `/account?switch_to=${SEED_ID}`)

    const calls = await mountFresh()

    expect(removeItemSpy).not.toHaveBeenCalledWith(STORAGE_KEY)
    expect(workspaceGetHeader(calls)).toBe(SEED_ID)
  })

  it('every /api/ call in the boot burst carries the seed, not just the first', async () => {
    localStorage.setItem(STORAGE_KEY, SEED_ID)

    const calls = await mountFresh()

    expect(calls).toHaveLength(BOOT_CALLS)
    expect(calls.every((c) => c.workspaceHeader === SEED_ID)).toBe(true)
  })

  it('warns in dev when the first GET really does go out header-less', async () => {
    // No seed anywhere — the genuine cookie/oldest-membership path. The warning
    // is the whole diagnostic: a desktop repro of the wrong-workspace window
    // shows up in the console instead of having to be inferred from the nav.
    const calls = await mountFresh()

    expect(workspaceGetHeader(calls)).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('without x-workspace-id'))
  })

  it('stays quiet when the seed is present', async () => {
    localStorage.setItem(STORAGE_KEY, SEED_ID)

    await mountFresh()

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('without x-workspace-id'))
  })
})
