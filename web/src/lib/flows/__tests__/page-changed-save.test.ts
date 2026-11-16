/**
 * The save-time checks of a page watch (page-changed-save.ts), shared by the
 * REST routes and chat's create_flow / update_flow: the per-person limit on
 * watches switched on, and one read of the page when it is saved on with a
 * new address or switched on, refused with the probe's own reason. A loop
 * saved off, an unchanged watch that stays on and every other trigger pass
 * with no query and no read. The baseline is forgotten after a save that
 * switches a watch on or points it at a new page, and a hand-over holds the
 * new owner to the limit. The probe and the reset are stand-ins: no network,
 * no database.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { pageWatchAfterHandOver, pageWatchAfterSave, pageWatchLimitProblem, pageWatchNeedsReset, pageWatchSaveProblem, type WatchPageBrowserProbe, type WatchPageProbe } from '../page-changed-save'
import { PAGE_WATCH_BROWSER_MAX_PER_PERSON, PAGE_WATCH_MAX_PER_PERSON } from '../page-watch/url'

const WS = 'ws-fernhill'
const OTHER_WS = 'ws-other'
const URL_A = 'https://example.com/pricing'
const URL_B = 'https://shop.example.com/kettle'
const page = (url: string) => ({ kind: 'page_changed', url, look_for: 'when the price drops' })

/** `n` enabled page watches of `owner` (plus noise that must never count). */
function watches(owner: string, n: number) {
  const rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < n; i++) rows.push({ id: `w-${owner}-${i}`, workspace_id: WS, created_by: owner, enabled: true, trigger_type: 'page_changed' })
  rows.push(
    { id: 'off', workspace_id: WS, created_by: owner, enabled: false, trigger_type: 'page_changed' },
    { id: 'elsewhere', workspace_id: OTHER_WS, created_by: owner, enabled: true, trigger_type: 'page_changed' },
    { id: 'schedule', workspace_id: WS, created_by: owner, enabled: true, trigger_type: 'schedule' },
    { id: 'someone-else', workspace_id: WS, created_by: 'u-cy', enabled: true, trigger_type: 'page_changed' },
  )
  return memoryDb({ flow: rows }) as SupabaseClient
}

const readable: WatchPageProbe = async () => ({ ok: true, lineCount: 40 })
const shell: WatchPageProbe = async () => ({ ok: false, reason: 'This page shows its content only in a browser. Switch on \"Read it in my browser\" to watch it there.' })

describe('the limit', () => {
  it(`lets a person keep ${PAGE_WATCH_MAX_PER_PERSON} on, and refuses the next in plain words`, async () => {
    const probe = vi.fn(readable)
    const under = await pageWatchSaveProblem(watches('u-ana', PAGE_WATCH_MAX_PER_PERSON - 1), { workspaceId: WS, ownerUserId: 'u-ana', flowId: null, next: { triggerType: 'page_changed', config: page(URL_A), enabled: true } }, { probe })
    expect(under).toBeNull()
    expect(probe).toHaveBeenCalledWith(URL_A)

    probe.mockClear()
    const over = await pageWatchSaveProblem(watches('u-ana', PAGE_WATCH_MAX_PER_PERSON), { workspaceId: WS, ownerUserId: 'u-ana', flowId: null, next: { triggerType: 'page_changed', config: page(URL_A), enabled: true } }, { probe })
    expect(over).toEqual({ code: 'PAGE_WATCH_LIMIT', field: 'enabled', message: expect.stringContaining(`You already watch ${PAGE_WATCH_MAX_PER_PERSON} pages`) })
    // Refused before the page is read.
    expect(probe).not.toHaveBeenCalled()
  })

  it('counts the owner’s own enabled watches in this workspace only, leaving out the loop being saved', async () => {
    const db = watches('u-ana', PAGE_WATCH_MAX_PER_PERSON)
    // The loop switched on is one of the counted rows (it was on, then off): left out of its own count.
    const self = await pageWatchSaveProblem(db, { workspaceId: WS, ownerUserId: 'u-ana', flowId: 'w-u-ana-0', next: { triggerType: 'page_changed', config: page(URL_A), enabled: true }, previous: { triggerType: 'page_changed', config: page(URL_A), enabled: false } }, { probe: readable })
    expect(self).toBeNull()
    // Ana's watches never limit Cy, who keeps one.
    expect(await pageWatchSaveProblem(db, { workspaceId: WS, ownerUserId: 'u-cy', flowId: null, next: { triggerType: 'page_changed', config: page(URL_A), enabled: true } }, { probe: readable })).toBeNull()
  })

  it('a watch already on is not counted again when it is edited', async () => {
    const db = watches('u-ana', PAGE_WATCH_MAX_PER_PERSON + 2)
    const edit = await pageWatchSaveProblem(db, { workspaceId: WS, ownerUserId: 'u-ana', flowId: 'w-u-ana-0', next: { triggerType: 'page_changed', config: page(URL_B), enabled: true }, previous: { triggerType: 'page_changed', config: page(URL_A), enabled: true } }, { probe: readable })
    expect(edit).toBeNull()
  })

  it('lets the save through when the count cannot be read (the cap guards cost)', async () => {
    const failing = { from: () => { throw new Error('down') } } as unknown as SupabaseClient
    expect(await pageWatchSaveProblem(failing, { workspaceId: WS, ownerUserId: 'u-ana', flowId: null, next: { triggerType: 'page_changed', config: page(URL_A), enabled: true } }, { probe: readable })).toBeNull()
  })
})

describe('the read at setup', () => {
  const db = () => watches('u-ana', 0)

  it('refuses a page that needs a browser, with the probe’s own reason', async () => {
    const out = await pageWatchSaveProblem(db(), { workspaceId: WS, ownerUserId: 'u-ana', flowId: null, next: { triggerType: 'page_changed', config: page(URL_A), enabled: true } }, { probe: shell })
    expect(out).toEqual({ code: 'PAGE_UNREADABLE', field: 'trigger.url', message: "That page can't be watched: This page shows its content only in a browser. Switch on \"Read it in my browser\" to watch it there." })
  })

  it('a probe that throws is a page that could not be read now', async () => {
    const throwing: WatchPageProbe = async () => {
      throw new Error('socket hang up')
    }
    const out = await pageWatchSaveProblem(db(), { workspaceId: WS, ownerUserId: 'u-ana', flowId: null, next: { triggerType: 'page_changed', config: page(URL_A), enabled: true } }, { probe: throwing })
    expect(out?.code).toBe('PAGE_UNREADABLE')
    expect(out?.message).toMatch(/could not be read just now/)
  })

  it('reads a new or changed address, and a watch switched on; never an unchanged watch that stays on', async () => {
    const probe = vi.fn(readable)
    const base = { workspaceId: WS, ownerUserId: 'u-ana', flowId: 'w-1' }
    await pageWatchSaveProblem(db(), { ...base, next: { triggerType: 'page_changed', config: page(URL_B), enabled: true }, previous: { triggerType: 'page_changed', config: page(URL_A), enabled: true } }, { probe })
    await pageWatchSaveProblem(db(), { ...base, next: { triggerType: 'page_changed', config: page(URL_A), enabled: true }, previous: { triggerType: 'page_changed', config: page(URL_A), enabled: false } }, { probe })
    await pageWatchSaveProblem(db(), { ...base, next: { triggerType: 'page_changed', config: page(URL_A), enabled: true }, previous: { triggerType: 'schedule', config: {}, enabled: true } }, { probe })
    expect(probe.mock.calls.map(([u]) => u)).toEqual([URL_B, URL_A, URL_A])
    probe.mockClear()
    // Only what to look for changed, the watch on: nothing to read.
    expect(await pageWatchSaveProblem(db(), { ...base, next: { triggerType: 'page_changed', config: { ...page(URL_A), look_for: 'new colours' }, enabled: true }, previous: { triggerType: 'page_changed', config: page(URL_A), enabled: true } }, { probe })).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('what passes untouched', () => {
  it('a watch saved off, and every other trigger: no query, no read', async () => {
    const probe = vi.fn(shell)
    const from = vi.fn()
    const untouched = { from } as unknown as SupabaseClient
    expect(await pageWatchSaveProblem(untouched, { workspaceId: WS, ownerUserId: 'u-ana', flowId: null, next: { triggerType: 'page_changed', config: page(URL_A), enabled: false } }, { probe })).toBeNull()
    for (const triggerType of ['schedule', 'contact_created', 'email_received']) {
      expect(await pageWatchSaveProblem(untouched, { workspaceId: WS, ownerUserId: 'u-ana', flowId: null, next: { triggerType, config: { url: URL_A }, enabled: true } }, { probe })).toBeNull()
    }
    expect(from).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('the baseline after a save (pageWatchAfterSave)', () => {
  const on = (url = URL_A) => ({ triggerType: 'page_changed', config: page(url), enabled: true })
  const off = (url = URL_A) => ({ triggerType: 'page_changed', config: page(url), enabled: false })

  it('forgets it when a watch is switched on, becomes a page watch, or gets a new address', () => {
    expect(pageWatchNeedsReset(off(), on())).toBe(true)
    expect(pageWatchNeedsReset({ triggerType: 'schedule', config: {}, enabled: true }, on())).toBe(true)
    expect(pageWatchNeedsReset({ triggerType: 'schedule', config: {}, enabled: false }, off())).toBe(true)
    expect(pageWatchNeedsReset(on(URL_A), on(URL_B))).toBe(true)
    expect(pageWatchNeedsReset(off(URL_A), off(URL_B))).toBe(true)
    expect(pageWatchNeedsReset(null, on())).toBe(true)
    expect(pageWatchNeedsReset(on(), { ...on(), config: { ...page(URL_A), look_for: 'a new colour' } })).toBe(true)
  })

  it('keeps it for the same trigger re-saved (a rename), a switch-off, and any other trigger', () => {
    expect(pageWatchNeedsReset(on(), on())).toBe(false)
    expect(pageWatchNeedsReset(on(), off())).toBe(false)
    expect(pageWatchNeedsReset(on(), { triggerType: 'schedule', config: {}, enabled: true })).toBe(false)
  })

  it('calls the reset with the service client and the loop, only when needed', async () => {
    const reset = vi.fn(async () => {})
    const service = {} as SupabaseClient
    expect(await pageWatchAfterSave(service, { flowId: 'f-1', previous: off(), next: on() }, { reset })).toBe(true)
    expect(reset).toHaveBeenCalledWith(service, 'f-1')
    reset.mockClear()
    expect(await pageWatchAfterSave(service, { flowId: 'f-1', previous: on(), next: on() }, { reset })).toBe(false)
    expect(reset).not.toHaveBeenCalled()
  })
})

describe('the limit on a hand-over (pageWatchLimitProblem)', () => {
  const watch = { trigger_type: 'page_changed', enabled: true }

  it('refuses a watch that is on for a new owner who already keeps the most, naming them', async () => {
    const db = watches('u-dee', PAGE_WATCH_MAX_PER_PERSON)
    const out = await pageWatchLimitProblem(db, { workspaceId: WS, flowId: 'f-ana', flow: watch, newOwnerUserId: 'u-dee', who: 'Dee' })
    expect(out?.code).toBe('PAGE_WATCH_LIMIT')
    expect(out?.message).toMatch(new RegExp(`^Dee already watches ${PAGE_WATCH_MAX_PER_PERSON} pages.*did not change hands`))
    expect((await pageWatchLimitProblem(db, { workspaceId: WS, flowId: 'f-ana', flow: watch, newOwnerUserId: 'u-dee', who: 'You' }))?.message).toMatch(/^You already watch /)
  })

  it('lets it through under the limit, for a watch that is off, for any other loop, and when the count cannot be read', async () => {
    const db = watches('u-dee', PAGE_WATCH_MAX_PER_PERSON - 1)
    expect(await pageWatchLimitProblem(db, { workspaceId: WS, flowId: 'f-ana', flow: watch, newOwnerUserId: 'u-dee' })).toBeNull()
    const full = watches('u-dee', PAGE_WATCH_MAX_PER_PERSON)
    expect(await pageWatchLimitProblem(full, { workspaceId: WS, flowId: 'f-ana', flow: { ...watch, enabled: false }, newOwnerUserId: 'u-dee' })).toBeNull()
    expect(await pageWatchLimitProblem(full, { workspaceId: WS, flowId: 'f-ana', flow: { trigger_type: 'schedule', enabled: true }, newOwnerUserId: 'u-dee' })).toBeNull()
    const failing = { from: () => { throw new Error('down') } } as unknown as SupabaseClient
    expect(await pageWatchLimitProblem(failing, { workspaceId: WS, flowId: 'f-ana', flow: watch, newOwnerUserId: 'u-cy' })).toBeNull()
  })
})

describe('a page read in the person\'s browser', () => {
  const inBrowser = (url: string) => ({ ...page(url), read_with: 'browser' })
  const OWNER = { userId: 'u-ana', workspaceId: WS }

  /** `n` enabled browser-read watches of Ana, among plain ones that must not count toward the smaller limit. */
  function browserWatches(n: number) {
    const rows: Array<Record<string, unknown>> = []
    for (let i = 0; i < n; i++) rows.push({ id: `b-${i}`, workspace_id: WS, created_by: 'u-ana', enabled: true, trigger_type: 'page_changed', trigger_config: inBrowser(URL_B) })
    for (let i = 0; i < 6; i++) rows.push({ id: `p-${i}`, workspace_id: WS, created_by: 'u-ana', enabled: true, trigger_type: 'page_changed', trigger_config: page(URL_A) })
    return memoryDb({ flow: rows }) as SupabaseClient
  }

  it('is probed in the owner\'s browser, never by a fetch, and refused with the browser\'s own reason', async () => {
    const probe = vi.fn(readable)
    const browserProbe = vi.fn<WatchPageBrowserProbe>(async () => ({ ok: true, lineCount: 30 }))
    const args = { workspaceId: WS, ownerUserId: 'u-ana', flowId: null, next: { triggerType: 'page_changed', config: inBrowser(URL_A), enabled: true } }
    expect(await pageWatchSaveProblem(browserWatches(0), args, { probe, browserProbe })).toBeNull()
    expect(browserProbe).toHaveBeenCalledWith(URL_A, OWNER)
    expect(probe).not.toHaveBeenCalled()

    browserProbe.mockResolvedValueOnce({ ok: false, reason: 'The page sent your browser to a sign-in page.' })
    expect(await pageWatchSaveProblem(browserWatches(0), args, { probe, browserProbe })).toEqual({
      code: 'PAGE_UNREADABLE', field: 'trigger.url', message: "That page can't be watched: The page sent your browser to a sign-in page.",
    })
  })

  it('a read that can\'t be made now lets the save through unchecked', async () => {
    const browserProbe = vi.fn<WatchPageBrowserProbe>(async () => ({ ok: true, unchecked: true }))
    expect(await pageWatchSaveProblem(browserWatches(0), { workspaceId: WS, ownerUserId: 'u-ana', flowId: null, next: { triggerType: 'page_changed', config: inBrowser(URL_A), enabled: true } }, { browserProbe })).toBeNull()
  })

  it(`holds a person to ${PAGE_WATCH_BROWSER_MAX_PER_PERSON} of them, counted apart from their plain watches, before anything is read`, async () => {
    const browserProbe = vi.fn<WatchPageBrowserProbe>(async () => ({ ok: true, lineCount: 30 }))
    const next = { triggerType: 'page_changed', config: inBrowser(URL_A), enabled: true }
    expect(await pageWatchSaveProblem(browserWatches(PAGE_WATCH_BROWSER_MAX_PER_PERSON - 1), { workspaceId: WS, ownerUserId: 'u-ana', flowId: null, next }, { browserProbe })).toBeNull()
    browserProbe.mockClear()
    const over = await pageWatchSaveProblem(browserWatches(PAGE_WATCH_BROWSER_MAX_PER_PERSON), { workspaceId: WS, ownerUserId: 'u-ana', flowId: null, next }, { browserProbe })
    expect(over).toEqual({ code: 'PAGE_WATCH_LIMIT', field: 'enabled', message: expect.stringContaining(`You already watch ${PAGE_WATCH_BROWSER_MAX_PER_PERSON} pages in your browser`) })
    expect(browserProbe).not.toHaveBeenCalled()
    // A plain watch is not held to it.
    expect(await pageWatchSaveProblem(browserWatches(PAGE_WATCH_BROWSER_MAX_PER_PERSON), { workspaceId: WS, ownerUserId: 'u-ana', flowId: null, next: { triggerType: 'page_changed', config: page(URL_A), enabled: true } }, { probe: readable })).toBeNull()
    // One already read in the browser and re-saved is not counted against itself, or read again.
    expect(await pageWatchSaveProblem(browserWatches(PAGE_WATCH_BROWSER_MAX_PER_PERSON), { workspaceId: WS, ownerUserId: 'u-ana', flowId: 'b-0', next: { triggerType: 'page_changed', config: inBrowser(URL_B), enabled: true }, previous: { triggerType: 'page_changed', config: inBrowser(URL_B), enabled: true } }, { browserProbe })).toBeNull()
    expect(browserProbe).not.toHaveBeenCalled()
  })

  it('a watch that stays on the same page but moves to the browser (or back) is counted, read the new way, and takes a fresh baseline', async () => {
    const browserProbe = vi.fn<WatchPageBrowserProbe>(async () => ({ ok: true, lineCount: 30 }))
    const probe = vi.fn(readable)
    const plain = { triggerType: 'page_changed', config: page(URL_A), enabled: true }
    const browser = { triggerType: 'page_changed', config: inBrowser(URL_A), enabled: true }
    expect(await pageWatchSaveProblem(browserWatches(PAGE_WATCH_BROWSER_MAX_PER_PERSON), { workspaceId: WS, ownerUserId: 'u-ana', flowId: 'p-0', next: browser, previous: plain }, { probe, browserProbe }))
      .toMatchObject({ code: 'PAGE_WATCH_LIMIT' })
    expect(await pageWatchSaveProblem(browserWatches(1), { workspaceId: WS, ownerUserId: 'u-ana', flowId: 'p-0', next: browser, previous: plain }, { probe, browserProbe })).toBeNull()
    expect(browserProbe).toHaveBeenCalledTimes(1)
    expect(await pageWatchSaveProblem(browserWatches(1), { workspaceId: WS, ownerUserId: 'u-ana', flowId: 'b-0', next: plain, previous: browser }, { probe, browserProbe })).toBeNull()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(pageWatchNeedsReset(plain, browser)).toBe(true)
    expect(pageWatchNeedsReset(browser, plain)).toBe(true)
    expect(pageWatchNeedsReset(browser, { ...browser })).toBe(false)
  })

  it('a hand-over holds the new owner to the browser limit too', async () => {
    const flow = { trigger_type: 'page_changed', enabled: true, trigger_config: inBrowser(URL_A) }
    const over = await pageWatchLimitProblem(browserWatches(PAGE_WATCH_BROWSER_MAX_PER_PERSON), { workspaceId: WS, flowId: 'new', flow, newOwnerUserId: 'u-ana', who: 'Ana' })
    expect(over).toMatchObject({ code: 'PAGE_WATCH_LIMIT', message: expect.stringContaining(`Ana already watches ${PAGE_WATCH_BROWSER_MAX_PER_PERSON} pages in their browser`) })
    expect(await pageWatchLimitProblem(browserWatches(PAGE_WATCH_BROWSER_MAX_PER_PERSON - 1), { workspaceId: WS, flowId: 'new', flow, newOwnerUserId: 'u-ana', who: 'Ana' })).toBeNull()
    // A plain watch changing hands is held to the plain limit only.
    expect(await pageWatchLimitProblem(browserWatches(PAGE_WATCH_BROWSER_MAX_PER_PERSON), { workspaceId: WS, flowId: 'new', flow: { trigger_type: 'page_changed', enabled: true, trigger_config: page(URL_A) }, newOwnerUserId: 'u-ana', who: 'Ana' })).toBeNull()
  })
})

describe('what the review found', () => {
  const inBrowser = (url: string) => ({ ...page(url), read_with: 'browser' })

  it('another member\'s save never reads the owner\'s browser, or hears what it found there', async () => {
    const browserProbe = vi.fn<WatchPageBrowserProbe>(async () => ({ ok: false, reason: 'The page sent your browser to a sign-in page.' }))
    const next = { triggerType: 'page_changed', config: inBrowser(URL_A), enabled: true }
    const db = memoryDb({ flow: [] }) as SupabaseClient
    expect(await pageWatchSaveProblem(db, { workspaceId: WS, ownerUserId: 'u-ana', savedByUserId: 'u-cy', flowId: 'f', next, previous: { ...next, enabled: false } }, { browserProbe })).toBeNull()
    expect(browserProbe).not.toHaveBeenCalled()
    // The owner's own save is read.
    expect(await pageWatchSaveProblem(db, { workspaceId: WS, ownerUserId: 'u-ana', savedByUserId: 'u-ana', flowId: 'f', next, previous: { ...next, enabled: false } }, { browserProbe })).toMatchObject({ code: 'PAGE_UNREADABLE' })
  })

  it('a browser watch that changes hands forgets what it saw in the old owner\'s browser; a plain one keeps it', async () => {
    const tables = { flow_page_change: [
      { id: 'c1', flow_id: 'f-browser', workspace_id: WS, added_lines: ['Order 1041 | Packed'] },
      { id: 'c2', flow_id: 'f-plain', workspace_id: WS, added_lines: ['Pro $39'] },
      { id: 'c3', flow_id: 'f-browser', workspace_id: OTHER_WS, added_lines: ['elsewhere'] },
    ] }
    const db = memoryDb(tables) as SupabaseClient
    const reset = vi.fn(async () => {})
    expect(await pageWatchAfterHandOver(db, { workspaceId: WS, flowId: 'f-browser', flow: { trigger_type: 'page_changed', trigger_config: inBrowser(URL_A) } }, { reset })).toBe(true)
    expect(tables.flow_page_change.map((c) => c.id)).toEqual(['c2', 'c3'])
    expect(reset).toHaveBeenCalledWith(db, 'f-browser')
    expect(await pageWatchAfterHandOver(db, { workspaceId: WS, flowId: 'f-plain', flow: { trigger_type: 'page_changed', trigger_config: page(URL_A) } }, { reset })).toBe(false)
    expect(tables.flow_page_change.map((c) => c.id)).toEqual(['c2', 'c3'])
    expect(reset).toHaveBeenCalledTimes(1)
  })
})
