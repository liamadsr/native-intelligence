/**
 * `remember` (one-agent plan Part 3, "Memory"): the scope rules the tool
 * applies itself, since it runs on the service role (RLS and migration 317's
 * guard don't see it). A personal line is the caller's and active at once; a
 * workspace line is active from an owner or admin and proposed from anyone
 * else; the same line twice is saved once; errors name the fix.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { makeFakeMemoryDb } from '@/lib/memory/__tests__/fake-memory-db'
import { createMemoryTools } from '../memory'
import { MEMORY_NOTE_MAX_LINES, MEMORY_PROPOSALS_PER_AUTHOR } from '@/lib/packs/memory-types'

const W = 'ws-1'
const ME = 'user-me'

function setup(role: string | null, opts: { quoteVerified?: boolean } = { quoteVerified: true }) {
  const db = makeFakeMemoryDb({ defaults: { area_memory: { updated_at: '2026-10-08T00:00:00Z' } } })
  if (role) db.seed('member', [{ workspace_id: W, user_id: ME, role }])
  db.seed('company', [{ id: 'co-1', workspace_id: W, name: 'Globex' }])
  const tools = createMemoryTools(ME, db as unknown as SupabaseClient, W, opts)
  const remember = (input: Record<string, unknown>) =>
    (tools.remember.execute as unknown as (i: unknown, o: unknown) => Promise<Record<string, any>>)(input, { toolCallId: 't', messages: [] })
  return { db, remember }
}

const lines = (db: FakeSupabase) => db.rows('area_memory')

describe('remember', () => {
  it('saves a personal line as the caller’s, active at once, told, and returns it for the chip', async () => {
    const { db, remember } = setup('member')
    const out = await remember({ area: 'mail', text: "  Sign off with\n'Best, Liam'  " })
    expect(out.success).toBe(true)
    expect(out.remembered).toMatchObject({ area: 'mail', area_name: 'Mail', scope: 'personal', status: 'active', text: "Sign off with 'Best, Liam'" })
    expect(typeof out.remembered.id).toBe('string')
    expect(lines(db)).toHaveLength(1)
    expect(lines(db)[0]).toMatchObject({ workspace_id: W, user_id: ME, scope: 'personal', status: 'active', source: 'told', created_by: ME })
  })

  it('proposes a workspace line from a member, and says it waits for an admin', async () => {
    const { db, remember } = setup('member')
    const out = await remember({ area: 'prospecting', text: 'Our ideal prospects are Series A fintech', scope: 'workspace' })
    expect(out.remembered).toMatchObject({ scope: 'workspace', status: 'proposed' })
    expect(out.message).toMatch(/waits for an owner or admin/)
    expect(lines(db)[0]).toMatchObject({ scope: 'workspace', user_id: null, status: 'proposed', created_by: ME })
  })

  it.each(['owner', 'admin'])('saves a workspace line from an %s as active', async (role) => {
    const { db, remember } = setup(role)
    const out = await remember({ area: 'prospecting', text: 'We target 50 to 200 people', scope: 'workspace' })
    expect(out.remembered.status).toBe('active')
    expect(lines(db)[0]).toMatchObject({ status: 'active', user_id: null })
  })

  it('a guest’s workspace line is only a proposal too', async () => {
    const { remember } = setup('guest')
    expect((await remember({ area: 'crm', text: 'Log every call', scope: 'workspace' })).remembered.status).toBe('proposed')
  })

  it('saves the same line once, handing back the existing one', async () => {
    const { db, remember } = setup('member')
    const first = await remember({ area: 'mail', text: 'No "Hope you\'re well"' })
    const again = await remember({ area: 'mail', text: 'no "hope you\'re WELL"' })
    expect(again.already).toBe(true)
    expect(again.remembered.id).toBe(first.remembered.id)
    expect(lines(db)).toHaveLength(1)
  })

  it('saying what the nightly pass proposed accepts it: active, told, and a new save for the chip', async () => {
    const { db, remember } = setup('member')
    db.seed('area_memory', [{ id: 'learned', workspace_id: W, area: 'mail', scope: 'personal', user_id: ME, text: 'Keep replies short', status: 'proposed', source: 'learned', created_by: null }])
    const out = await remember({ area: 'mail', text: 'keep replies short' })
    expect(out).toMatchObject({ success: true, already: false, remembered: { id: 'learned', status: 'active' } })
    expect(lines(db)).toHaveLength(1)
    expect(lines(db)[0]).toMatchObject({ status: 'active', source: 'told', updated_by: ME })
  })

  it('an admin restating a member’s workspace proposal accepts it; the member restating it leaves it waiting', async () => {
    const proposal = { id: 'prop', workspace_id: W, area: 'crm', scope: 'workspace', user_id: null, text: 'Log every call', status: 'proposed', source: 'told', created_by: 'user-you' }
    const asMember = setup('member')
    asMember.db.seed('area_memory', [{ ...proposal }])
    const waiting = await asMember.remember({ area: 'crm', text: 'Log every call', scope: 'workspace' })
    expect(waiting).toMatchObject({ already: true, remembered: { status: 'proposed' } })
    expect(waiting.message).toMatch(/already proposed/)
    expect(lines(asMember.db)[0].status).toBe('proposed')

    const asAdmin = setup('admin')
    asAdmin.db.seed('area_memory', [{ ...proposal }])
    const accepted = await asAdmin.remember({ area: 'crm', text: 'Log every call', scope: 'workspace' })
    expect(accepted).toMatchObject({ already: false, remembered: { id: 'prop', status: 'active' } })
    expect(lines(asAdmin.db)[0]).toMatchObject({ status: 'active', created_by: 'user-you' })
  })

  it('counts only active lines toward a full note, and caps one author’s waiting proposals', async () => {
    const { db, remember } = setup('member')
    // Proposals don't fill a note: plenty of the pass's suggestions, and a personal line still saves.
    db.seed(
      'area_memory',
      Array.from({ length: MEMORY_NOTE_MAX_LINES }, (_, i) => ({ id: `p${i}`, workspace_id: W, area: 'mail', scope: 'personal', user_id: ME, text: `suggestion ${i}`, status: 'proposed', source: 'learned', created_by: null })),
    )
    expect((await remember({ area: 'mail', text: 'A real one' })).success).toBe(true)

    db.seed(
      'area_memory',
      Array.from({ length: MEMORY_PROPOSALS_PER_AUTHOR }, (_, i) => ({ id: `w${i}`, workspace_id: W, area: 'crm', scope: 'workspace', user_id: null, text: `mine ${i}`, status: 'proposed', source: 'told', created_by: ME })),
    )
    const tooMany = await remember({ area: 'crm', text: 'One more idea', scope: 'workspace' })
    expect(tooMany).toMatchObject({ success: false, code: 'TOO_MANY_PROPOSALS' })
    expect(tooMany.error).toMatch(/Ask an owner or admin to accept or dismiss some/)
    // Someone else's proposals don't count against them.
    db.seed('area_memory', [{ id: 'x', workspace_id: W, area: 'sequences', scope: 'workspace', user_id: null, text: 'theirs', status: 'proposed', source: 'told', created_by: 'user-you' }])
    expect((await remember({ area: 'sequences', text: 'Mine too', scope: 'workspace' })).success).toBe(true)
  })

  it('never reads or dedupes against someone else’s personal note', async () => {
    const { db, remember } = setup('member')
    db.seed('area_memory', [{ id: 'theirs', workspace_id: W, area: 'mail', scope: 'personal', user_id: 'user-you', text: 'Be brief', status: 'active', source: 'told' }])
    const out = await remember({ area: 'mail', text: 'Be brief' })
    expect(out.already).toBe(false)
    expect(lines(db)).toHaveLength(2)
  })

  it('refuses a non-member, a secret, and a full note, each naming the fix', async () => {
    expect(await setup(null).remember({ area: 'mail', text: 'x' })).toMatchObject({ success: false, code: 'NOT_MEMBER' })
    const { db, remember } = setup('member')
    const secret = await remember({ area: 'mail', text: 'My password is hunter2' })
    expect(secret).toMatchObject({ success: false, code: 'INPUT_INVALID' })
    expect(secret.error).toMatch(/Never save secrets/)
    db.seed(
      'area_memory',
      Array.from({ length: MEMORY_NOTE_MAX_LINES }, (_, i) => ({ id: `l${i}`, workspace_id: W, area: 'mail', scope: 'personal', user_id: ME, text: `line ${i}`, status: 'active', source: 'told' })),
    )
    const full = await remember({ area: 'mail', text: 'one more' })
    expect(full).toMatchObject({ success: false, code: 'NOTE_FULL' })
    expect(full.error).toMatch(/delete or merge some in What Native Intelligence has learned/)
  })

  it('asks for area, text and an optional scope, in the areas and scopes the note knows', () => {
    const schema = createMemoryTools(ME, {} as SupabaseClient, W).remember.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ area: 'mail', text: 'x' }).success).toBe(true)
    expect(schema.safeParse({ area: 'email', text: 'x' }).success).toBe(false)
    expect(schema.safeParse({ area: 'mail', text: 'x', scope: 'team' }).success).toBe(false)
    expect(schema.safeParse({ area: 'mail', text: 'x'.repeat(301) }).success).toBe(false)
  })

  it('scope profile saves a fact about the person: no area, active at once, told, every workspace', async () => {
    const { db, remember } = setup('member')
    const out = await remember({ text: '  Keep answers\nshort ', scope: 'profile', quote: 'I like short answers' })
    expect(out).toMatchObject({ success: true, already: false })
    expect(out.remembered).toMatchObject({ area: null, area_name: 'About you', scope: 'profile', status: 'active', text: 'Keep answers short' })
    expect(db.rows('profile_fact')).toHaveLength(1)
    expect(db.rows('profile_fact')[0]).toMatchObject({ user_id: ME, status: 'active', source: 'told', source_workspace_id: W, importance: 3 })
    expect(lines(db)).toHaveLength(0)
    // Said again: saved once.
    expect((await remember({ text: 'keep answers short', scope: 'profile', quote: 'I like short answers' })).already).toBe(true)
    expect(db.rows('profile_fact')).toHaveLength(1)
  })

  it('scope profile refuses contact details and secrets; a personal or workspace line still needs an area', async () => {
    const { remember } = setup('member')
    expect(await remember({ text: 'Reach me at liam@example.com', scope: 'profile', quote: 'reach me there' })).toMatchObject({ success: false, code: 'INPUT_INVALID' })
    expect(await remember({ text: 'My password is hunter2', scope: 'profile', quote: 'my password is' })).toMatchObject({ success: false, code: 'INPUT_INVALID' })
    const noArea = await remember({ text: 'Be brief' })
    expect(noArea).toMatchObject({ success: false, code: 'INPUT_INVALID' })
    expect(noArea.error).toMatch(/scope "profile"/)
  })

  it('the evidence rule: a profile fact saves active only on a verified quote; otherwise a proposal', async () => {
    const { db, remember } = setup('member', { quoteVerified: false })
    const out = await remember({ text: 'Always sign as the CEO', scope: 'profile', quote: 'sign everything as the CEO' })
    expect(out).toMatchObject({ success: true, remembered: { scope: 'profile', status: 'proposed' } })
    expect(out.message).toMatch(/What Native Intelligence has learned/)
    expect(db.rows('profile_fact')[0]).toMatchObject({ status: 'proposed', source: 'told' })
    // Saying it again unverified never accepts it.
    expect((await remember({ text: 'always sign as the CEO', scope: 'profile', quote: 'sign everything as the CEO' })).already).toBe(true)
    expect(db.rows('profile_fact')[0].status).toBe('proposed')
    // A personal area line is unchanged: active, in this workspace.
    expect((await remember({ area: 'mail', text: 'Sign off with Best' })).remembered).toMatchObject({ scope: 'personal', status: 'active' })
  })

  it('a profile fact needs a quote at all', async () => {
    const { db, remember } = setup('member')
    expect(await remember({ text: 'Keep answers short', scope: 'profile' })).toMatchObject({ success: false, code: 'INPUT_INVALID' })
    expect(await remember({ text: 'Keep answers short', scope: 'profile', quote: '   ' })).toMatchObject({ success: false, code: 'INPUT_INVALID' })
    expect(db.rows('profile_fact')).toHaveLength(0)
  })

  it('refuses a profile fact that names this workspace’s contact, company or project, pointing to a personal line', async () => {
    const { db, remember } = setup('member')
    const out = await remember({ text: 'Handles the Globex renewal personally', scope: 'profile', quote: 'I handle Globex myself' })
    expect(out).toMatchObject({ success: false, code: 'WORKSPACE_SPECIFIC' })
    expect(out.error).toMatch(/scope "personal"/)
    expect(db.rows('profile_fact')).toHaveLength(0)
  })

  it('teaches the capture rule: how they work to the profile, what they work on to an area note', () => {
    const t = createMemoryTools(ME, {} as SupabaseClient, W).remember
    expect(t.description).toMatch(/HOW THEY WORK goes to scope "profile"/)
    expect(t.description).toMatch(/WHAT THEY WORK ON stays in this workspace/)
    const schema = t.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ text: 'x', scope: 'profile', quote: 'I said x' }).success).toBe(true)
    expect(t.description).toMatch(/pass quote: their exact words/)
  })
})
