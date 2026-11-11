/**
 * The booking link tools (../booking-links.ts): what each does through the
 * real link code (src/lib/booking-links/links.ts) on the store in memory, and
 * what the model reads back: the address to share, the person's handle, who
 * may edit; a change by someone who may not is refused; delete turns a link
 * off. Their gates are the registry's (attended only, the list a read): see
 * src/lib/ai/__tests__/attended-only-tools.test.ts. Made-up people.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => state.db }))
vi.mock('@/lib/twilio/config', () => ({ appOrigin: () => 'https://app.example' }))

import { bookingDb } from '@/test/booking-db'
import { ATTENDED_ONLY_TOOL_NAMES, getToolSideEffect } from '@/lib/ai/tool-registry'
import { createBookingLinkTools } from '../booking-links'

type Row = Record<string, unknown>
const WS = 'ws-fernhill'
const AVA = 'a0000000-0000-4000-8000-00000000000a'
const BEN = 'b0000000-0000-4000-8000-00000000000b'
let tables: Record<string, Row[]>

const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })

beforeEach(() => {
  tables = {
    workspace: [{ id: WS, name: 'Fernhill Studio' }],
    member: [
      { id: 'm-ava', workspace_id: WS, user_id: AVA, display_name: 'Ava Lin', role: 'owner', availability_sharing: 'busy_only' },
      { id: 'm-ben', workspace_id: WS, user_id: BEN, display_name: 'Ben Ruiz', role: 'member', availability_sharing: 'busy_only' },
    ],
    booking_profile: [],
    booking_link: [],
    booking_link_host: [],
  }
  state.db = bookingDb(tables) as SupabaseClient
})

describe('the booking link tools', () => {
  it('create_booking_link makes the person’s link and hands back the address to share', async () => {
    const out = await call(createBookingLinkTools(AVA, WS), 'create_booking_link', { title: 'Intro call', duration_minutes: 20, ask_first: true })
    expect(out).toMatchObject({ success: true, link: { url: 'https://app.example/book/ava-lin/intro-call', duration_minutes: 20, ask_first: true, hosts: [AVA], host_names: ['Ava Lin'] } })
    expect(out.message).toBe('Made "Intro call". Its address: https://app.example/book/ava-lin/intro-call. Anyone with it can book a time, which waits for a yes.')
  })

  it('list_booking_links shows the workspace’s links that are on, the person’s handle, and which are theirs to edit', async () => {
    const tools = createBookingLinkTools(AVA, WS)
    await call(tools, 'create_booking_link', { title: 'Intro call' })
    await call(createBookingLinkTools(BEN, WS), 'create_booking_link', { title: 'Office hours' })
    const listed = await call(createBookingLinkTools(BEN, WS), 'list_booking_links', {})
    expect(listed.your_handle).toBe('ben-ruiz')
    expect((listed.links as Array<{ host_names: string[] }>).map((l) => l.host_names)).toEqual([['Ava Lin'], ['Ben Ruiz']])
    expect((listed.links as Array<{ title: string; yours: boolean; can_edit: boolean }>).map((l) => [l.title, l.yours, l.can_edit])).toEqual([
      ['Intro call', false, false],
      ['Office hours', true, true],
    ])
    const empty = await call(createBookingLinkTools(AVA, 'ws-empty'), 'list_booking_links', {})
    expect(empty).toMatchObject({ success: true, links: [] })
  })

  it('update_booking_link changes a link, or turns it off and on; someone who may not edit it is refused', async () => {
    const made = await call(createBookingLinkTools(AVA, WS), 'create_booking_link', { title: 'Intro call' })
    const id = (made.link as { id: string }).id
    expect(await call(createBookingLinkTools(BEN, WS), 'update_booking_link', { link_id: id, duration_minutes: 45 })).toMatchObject({ success: false, code: 'NOT_ALLOWED' })
    expect(await call(createBookingLinkTools(AVA, WS), 'update_booking_link', { link_id: id, active: false })).toMatchObject({ success: true, link: { active: false }, message: 'Intro call is off: its page takes no bookings.' })
    expect((await call(createBookingLinkTools(AVA, WS), 'list_booking_links', {})).links).toEqual([])
    expect(await call(createBookingLinkTools(AVA, WS), 'update_booking_link', { link_id: id, active: true })).toMatchObject({ success: true, link: { active: true } })
  })

  it('delete_booking_link turns it off; its row and bookings stay', async () => {
    const made = await call(createBookingLinkTools(AVA, WS), 'create_booking_link', { title: 'Intro call' })
    const out = await call(createBookingLinkTools(AVA, WS), 'delete_booking_link', { link_id: (made.link as { id: string }).id })
    expect(out).toMatchObject({ success: true, link: { active: false } })
    expect(tables.booking_link).toHaveLength(1)
  })

  it('no workspace, no link; and the gates are the registry’s', async () => {
    expect(await call(createBookingLinkTools(AVA), 'create_booking_link', { title: 'X' })).toEqual({ success: false, error: 'No workspace is active.' })
    for (const name of ['create_booking_link', 'update_booking_link', 'delete_booking_link']) expect(ATTENDED_ONLY_TOOL_NAMES.has(name), name).toBe(true)
    expect(getToolSideEffect('list_booking_links')).toBe('read')
  })
})
