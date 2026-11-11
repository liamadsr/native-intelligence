/**
 * Making and changing booking links (../links.ts, through the account API's
 * handlers in ../account.ts): a person's link under their own handle (made
 * from their name the first time), a team link under the workspace's
 * (owners and admins); who may edit (the link's owner, or an owner or
 * admin); who may host (members; someone who doesn't share their
 * availability only by adding themselves); a business's job link keeps its
 * shape; delete turns a link off; handles are unique. Over the real store in
 * memory; the studio is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bookingDb } from '@/test/booking-db'
import { handleCreateLink, handleDeleteLink, handleGetHandles, handleGetLink, handleListLinks, handlePatchLink, handlePutHandle, handleSetHosts, type AccountDeps } from '../account'
import { freeSlug, handleFromName, mayEdit } from '../links'
import { WS } from './fixtures'

type Row = Record<string, unknown>
// Hosts are named by user id (a uuid), as the API takes them.
const AVA = 'a0000000-0000-4000-8000-00000000000a'
const BEN = 'b0000000-0000-4000-8000-00000000000b'
const CARA = 'c0000000-0000-4000-8000-00000000000c'
const OUTSIDER = 'd0000000-0000-4000-8000-00000000000d'

let tables: Record<string, Row[]>
let deps: AccountDeps

beforeEach(() => {
  tables = {
    workspace: [{ id: WS, name: 'Fernhill Studio' }],
    member: [
      { id: 'm-ava', workspace_id: WS, user_id: AVA, display_name: 'Ava Lin', role: 'owner', availability_sharing: 'busy_only' },
      { id: 'm-ben', workspace_id: WS, user_id: BEN, display_name: 'Ben Ruiz', role: 'member', availability_sharing: 'none' },
      { id: 'm-cara', workspace_id: WS, user_id: CARA, display_name: 'Cara Moss', role: 'admin', availability_sharing: 'busy_only' },
    ],
    booking_profile: [],
    booking_link: [],
    booking_link_host: [],
  }
  deps = {
    supabase: bookingDb(tables, {
      booking_profile: (a, b) => a.handle === b.handle || (a.workspace_id === b.workspace_id && (a.user_id ?? null) === (b.user_id ?? null)),
      booking_link: (a, b) => (!!a.profile_id && a.profile_id === b.profile_id && a.slug === b.slug) || (a.purpose === 'job' && b.purpose === 'job' && a.workspace_id === b.workspace_id),
    }),
    origin: 'https://app.example',
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const as = (userId: string) => ({ workspaceId: WS, userId })
const req = (body: unknown) => new Request('https://app.example/api/account/booking-links', { method: 'POST', body: JSON.stringify(body) })
const json = async (res: Response) => ({ status: res.status, body: await res.json() })

describe('making a link', () => {
  it('under the person’s own handle, made from their name; its slug from its title; the person its one host; the defaults', async () => {
    const { status, body } = await json(await handleCreateLink(req({ title: 'Intro call' }), as(AVA), deps))
    expect(status).toBe(201)
    expect(body.link).toMatchObject({
      url: 'https://app.example/book/ava-lin/intro-call',
      profile: 'ava-lin',
      slug: 'intro-call',
      purpose: 'meeting',
      duration_minutes: 30,
      notice_minutes: 240,
      window_days: 30,
      video: true,
      ask_first: false,
      host_mode: 'one',
      hosts: [AVA],
      owner_user_id: AVA,
      active: true,
      can_edit: true,
    })
    expect(tables.booking_profile).toEqual([expect.objectContaining({ workspace_id: WS, user_id: AVA, handle: 'ava-lin' })])
    // The same title again gets the next free slug under the same handle.
    const again = await json(await handleCreateLink(req({ title: 'Intro call', questions: [{ label: 'Company name', required: true }, { label: 'Company name' }] }), as(AVA), deps))
    expect(again.body.link.slug).toBe('intro-call-2')
    expect(again.body.link.questions).toEqual([
      { id: 'company-name', label: 'Company name', required: true, kind: 'text' },
      { id: 'company-name-2', label: 'Company name', required: false, kind: 'text' },
    ])
    expect(tables.booking_profile).toHaveLength(1)
  })

  it('a team link goes under the workspace’s handle, by an owner or admin only', async () => {
    expect((await handleCreateLink(req({ title: 'Studio tour', team: true }), as(BEN), deps)).status).toBe(403)
    const made = await json(await handleCreateLink(req({ title: 'Studio tour', team: true, host_mode: 'any', hosts: [AVA, CARA] }), as(CARA), deps))
    expect(made.status).toBe(201)
    expect(made.body.link).toMatchObject({ profile: 'fernhill-studio', host_mode: 'any', hosts: [AVA, CARA] })
  })

  it('hosts are members; one who doesn’t share their availability only adds themself', async () => {
    const forBen = await json(await handleCreateLink(req({ title: 'Pairing', host_mode: 'all', hosts: [AVA, BEN] }), as(AVA), deps))
    expect(forBen.status).toBe(403)
    expect(forBen.body.error).toContain("Ben Ruiz doesn't share their availability")
    expect((await handleCreateLink(req({ title: 'Office hours' }), as(BEN), deps)).status).toBe(201)
    expect((await handleCreateLink(req({ title: 'Pairing', host_mode: 'all', hosts: [AVA, OUTSIDER] }), as(AVA), deps)).status).toBe(400)
    expect((await handleCreateLink(req({ title: 'Pairing', host_mode: 'one', hosts: [AVA, CARA] }), as(AVA), deps)).status).toBe(400)
  })

  it('a value outside the table’s ranges is refused before anything is written', async () => {
    for (const body of [{ title: '' }, { title: 'X', duration_minutes: 2 }, { title: 'X', slug: 'Has Spaces' }, { title: 'X', weekly_hours: [[{ start: '10:00', end: '09:00' }], [], [], [], [], [], []] }, { title: 'X', time_zone: 'Mars/Olympus' }]) {
      expect((await handleCreateLink(req(body), as(AVA), deps)).status, JSON.stringify(body)).toBe(400)
    }
    expect(tables.booking_link).toHaveLength(0)
    expect((await handleCreateLink(new Request('https://app.example/x', { method: 'POST', body: '[]' }), as(AVA), deps)).status).toBe(400)
  })

  it('the helpers: a handle from a name, the first free slug', () => {
    expect(handleFromName('Dana Wu-Reyes')).toBe('dana-wu-reyes')
    expect(handleFromName('李')).toBe('book-me')
    expect(freeSlug('intro', new Set(['intro', 'intro-2']))).toBe('intro-3')
    expect(freeSlug('intro', new Set())).toBe('intro')
  })
})

describe('changing a link', () => {
  async function avasLink() {
    const { body } = await json(await handleCreateLink(req({ title: 'Intro call' }), as(AVA), deps))
    return body.link.id as string
  }
  const patch = (id: string, body: unknown, who: string) => handlePatchLink(new Request('https://app.example/x', { method: 'PATCH', body: JSON.stringify(body) }), id, as(who), deps)

  it('its owner, or an owner or admin of the workspace; not another member', async () => {
    const id = await avasLink()
    expect((await patch(id, { duration_minutes: 45 }, BEN)).status).toBe(403)
    const byAdmin = await json(await patch(id, { duration_minutes: 45, ask_first: true, buffer_after_minutes: 10 }, CARA))
    expect(byAdmin.body.link).toMatchObject({ duration_minutes: 45, ask_first: true, buffer_after_minutes: 10 })
    expect((await patch(id, { title: 'Intro chat' }, AVA)).status).toBe(200)
    expect((await patch('00000000-0000-4000-8000-000000000000', { title: 'x' }, AVA)).status).toBe(404)
    expect(mayEdit({ ownerUserId: BEN, purpose: 'meeting' }, { userId: BEN }, 'member')).toBe(true)
    expect(mayEdit({ ownerUserId: BEN, purpose: 'meeting' }, { userId: BEN }, null)).toBe(false)
  })

  it('its hosts, with the same rules; a slug another link of the handle has is a 409', async () => {
    const id = await avasLink()
    const hosts = (body: unknown, who = AVA) => handleSetHosts(new Request('https://app.example/x', { method: 'PUT', body: JSON.stringify(body) }), id, as(who), deps)
    expect((await hosts({ hosts: [AVA, CARA], host_mode: 'all' })).status).toBe(200)
    expect(tables.booking_link_host.map((h) => [h.user_id, h.position])).toEqual([[AVA, 0], [CARA, 1]])
    expect((await hosts({ hosts: [AVA, BEN], host_mode: 'all' })).status).toBe(403)
    expect((await hosts({})).status).toBe(400)
    await json(await handleCreateLink(req({ title: 'Deep dive' }), as(AVA), deps))
    const clash = await json(await patch(id, { slug: 'deep-dive' }, AVA))
    expect(clash).toMatchObject({ status: 409, body: { code: 'SLUG_TAKEN' } })
  })

  it('delete turns it off: it stays listed, and comes back on', async () => {
    const id = await avasLink()
    const off = await json(await handleDeleteLink(id, as(AVA), deps))
    expect(off.body.link.active).toBe(false)
    expect(tables.booking_link).toHaveLength(1)
    expect((await json(await handleGetLink(id, as(AVA), deps))).body.link.active).toBe(false)
    expect((await json(await patch(id, { active: true }, AVA))).body.link.active).toBe(true)
    expect((await handleDeleteLink(id, as(BEN), deps)).status).toBe(403)
  })

  it('a business’s job link keeps its shape: its hours, length, notice, window, description and on/off change, by an owner or admin', async () => {
    tables.booking_link.push({
      id: 'f0000000-0000-4000-8000-000000000001', workspace_id: WS, owner_user_id: AVA, profile_id: null, slug: 'book', purpose: 'job', title: 'Pickup', description: null,
      duration_minutes: 60, buffer_before_minutes: 0, buffer_after_minutes: 0, notice_minutes: 1440, window_days: 14, step_minutes: 60, daily_cap: null,
      questions: [{ id: 'address', label: 'Address', required: false, kind: 'text' }], video: false, location: null, ask_first: true, host_mode: 'one',
      weekly_hours: null, time_zone: null, job_kind: 'pickup', active: true, created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z',
    })
    tables.booking_link_host.push({ link_id: 'f0000000-0000-4000-8000-000000000001', user_id: AVA, workspace_id: WS, position: 0 })
    const id = 'f0000000-0000-4000-8000-000000000001'
    expect((await patch(id, { host_mode: 'any' }, AVA)).status).toBe(400)
    expect((await patch(id, { ask_first: false }, AVA)).status).toBe(400)
    expect((await patch(id, { duration_minutes: 90 }, BEN)).status).toBe(403)
    const changed = await json(await patch(id, { duration_minutes: 90 }, CARA))
    expect(changed.body.link).toMatchObject({ duration_minutes: 90, step_minutes: 90, ask_first: true, host_mode: 'one' })
  })
})

describe('the list and the handles', () => {
  it('every link of the workspace, each saying whether the caller may edit it; the handles; whether they manage it', async () => {
    await handleCreateLink(req({ title: 'Intro call' }), as(AVA), deps)
    await handleCreateLink(req({ title: 'Office hours' }), as(BEN), deps)
    const seen = await json(await handleListLinks(as(BEN), deps))
    expect(seen.body.links.map((l: { title: string; can_edit: boolean }) => [l.title, l.can_edit])).toEqual([['Intro call', false], ['Office hours', true]])
    expect(seen.body).toMatchObject({ handles: { me: 'ben-ruiz', workspace: null }, can_manage: false })
    expect((await json(await handleListLinks(as(CARA), deps))).body.can_manage).toBe(true)
  })

  it('a handle is the person’s to set (the workspace’s for owners and admins), unique, and of its shape', async () => {
    const put = (body: unknown, who: string) => handlePutHandle(new Request('https://app.example/x', { method: 'PUT', body: JSON.stringify(body) }), as(who), deps)
    expect((await json(await put({ handle: 'ava' }, AVA))).body.handles).toEqual({ me: 'ava', workspace: null })
    expect((await json(await put({ handle: 'ava' }, BEN)))).toMatchObject({ status: 409, body: { code: 'HANDLE_TAKEN' } })
    expect((await put({ handle: 'A!' }, BEN)).status).toBe(400)
    expect((await put({ handle: 'fernhill', scope: 'workspace' }, BEN)).status).toBe(403)
    expect((await json(await put({ handle: 'fernhill', scope: 'workspace' }, CARA))).body.handles).toEqual({ me: null, workspace: 'fernhill' })
    expect((await json(await handleGetHandles(as(AVA), deps))).body.handles).toEqual({ me: 'ava', workspace: 'fernhill' })
  })
})
