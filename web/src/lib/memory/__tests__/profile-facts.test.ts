/**
 * Facts about you (migration 328): the writer every path goes through. It runs
 * on the service role for the tool and the memory route, so it applies the
 * rules itself: the person's own rows only, dedupe, a learned fact is live at
 * once (Liam, 2026-10-17: learning on by default) and restating a proposal
 * accepts it, the caps (100 active, about 4,000 characters, 20 of them
 * learned, 20 proposals), and no secrets or contact details. The loader ranks
 * by importance, then the newest, within the caps.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import {
  PROFILE_FACTS_MAX_ACTIVE,
  PROFILE_FACTS_MAX_CHARS,
  PROFILE_LEARNED_MAX,
  PROFILE_PROPOSALS_MAX,
  acceptProfileFact,
  clampImportance,
  deleteProfileFact,
  editProfileFact,
  loadProfileFacts,
  profileFactProblem,
  saveProfileFact,
  selectProfileFacts,
  supersedeProfileFact,
} from '../profile-facts'

const ME = 'user-me'
const OTHER = 'user-other'

function setup() {
  const db = makeFakeSupabase({ project: true, defaults: { profile_fact: { updated_at: '2026-10-14T00:00:00Z', superseded_by: null } } })
  return { db, sb: db as unknown as SupabaseClient }
}
const facts = (db: FakeSupabase) => db.rows('profile_fact')
const seed = (db: FakeSupabase, n: number, over: Record<string, unknown> = {}) =>
  db.seed(
    'profile_fact',
    Array.from({ length: n }, (_, i) => ({
      id: `f${i}`,
      user_id: ME,
      text: `fact ${i}`,
      status: 'active',
      source: 'told',
      importance: 3,
      superseded_by: null,
      updated_at: '2026-10-01T00:00:00Z',
      ...over,
    })),
  )

describe('profileFactProblem', () => {
  it('refuses empty, too long, secrets and contact details, naming the fix', () => {
    expect(profileFactProblem('')).toMatch(/the fact itself/)
    expect(profileFactProblem('x'.repeat(301))).toMatch(/300/)
    expect(profileFactProblem('My api key is sk-abcdefabcdefabcdef')).toMatch(/Never save secrets/)
    expect(profileFactProblem('Email me at liam@example.com')).toMatch(/email address, link or phone number/)
    expect(profileFactProblem('Call me on +1 415 555 0101')).toMatch(/phone number/)
    expect(profileFactProblem('Keep answers short')).toBeNull()
  })

  it('clamps importance to 1..5, defaulting to 3', () => {
    expect([clampImportance(undefined), clampImportance(0), clampImportance(9), clampImportance(4.4)]).toEqual([3, 1, 5, 4])
  })
})

describe('saveProfileFact', () => {
  it('saves a told fact as the person’s, active at once, normalized, with where it was said', async () => {
    const { db, sb } = setup()
    const out = await saveProfileFact(sb, { userId: ME, text: '  Keep answers\nshort ', source: 'told', sourceWorkspaceId: 'ws-1', importance: 5 })
    expect(out).toMatchObject({ ok: true, already: false, fact: { text: 'Keep answers short', status: 'active', source: 'told', importance: 5 } })
    expect(facts(db)[0]).toMatchObject({ user_id: ME, source_workspace_id: 'ws-1' })
  })

  it('saves the same fact once (any case), and never reads another person’s', async () => {
    const { db, sb } = setup()
    db.seed('profile_fact', [{ id: 'theirs', user_id: OTHER, text: 'Keep answers short', status: 'active', source: 'told', importance: 3, superseded_by: null }])
    expect((await saveProfileFact(sb, { userId: ME, text: 'Keep answers short', source: 'told' })).ok).toBe(true)
    const again = await saveProfileFact(sb, { userId: ME, text: 'keep ANSWERS short', source: 'told' })
    expect(again).toMatchObject({ ok: true, already: true })
    expect(facts(db).filter((f) => f.user_id === ME)).toHaveLength(1)
  })

  it('a learned fact is live at once and stays learned (so the editor marks it); saving it again changes nothing', async () => {
    const { db, sb } = setup()
    const learned = await saveProfileFact(sb, { userId: ME, text: 'Works early mornings', source: 'learned' })
    expect(learned).toMatchObject({ ok: true, already: false, fact: { status: 'active', source: 'learned' } })
    expect(await saveProfileFact(sb, { userId: ME, text: 'Works early mornings', source: 'learned' })).toMatchObject({ already: true })
    expect(await saveProfileFact(sb, { userId: ME, text: 'works early mornings', source: 'told' })).toMatchObject({ ok: true, already: true })
    expect(facts(db)).toHaveLength(1)
    expect(facts(db)[0]).toMatchObject({ status: 'active', source: 'learned' })
  })

  it('a proposal (proposeOnly) is still accepted by restating it', async () => {
    const { db, sb } = setup()
    expect(await saveProfileFact(sb, { userId: ME, text: 'Works late', source: 'learned', proposeOnly: true })).toMatchObject({ fact: { status: 'proposed' } })
    expect(await saveProfileFact(sb, { userId: ME, text: 'works late', source: 'told' })).toMatchObject({ ok: true, already: false, fact: { status: 'active', source: 'told' } })
    expect(facts(db)).toHaveLength(1)
  })

  it('a superseded fact is retired: it neither dedupes nor counts', async () => {
    const { db, sb } = setup()
    db.seed('profile_fact', [{ id: 'old', user_id: ME, text: 'Keep answers short', status: 'active', source: 'told', importance: 3, superseded_by: 'newer', retired_at: '2026-10-10T00:00:00Z' }])
    expect(await saveProfileFact(sb, { userId: ME, text: 'Keep answers short', source: 'told' })).toMatchObject({ ok: true, already: false })
  })

  it('holds the caps: 100 active facts, about 4,000 characters, 20 learned, 20 proposals', async () => {
    const a = setup()
    seed(a.db, PROFILE_FACTS_MAX_ACTIVE)
    const full = await saveProfileFact(a.sb, { userId: ME, text: 'one more', source: 'told' })
    expect(full).toMatchObject({ ok: false, code: 'PROFILE_FULL' })
    expect(!full.ok && full.error).toMatch(/About you/)

    const b = setup()
    seed(b.db, 14, { text: 'y'.repeat(285) }) // 3,990 characters
    expect(await saveProfileFact(b.sb, { userId: ME, text: 'a fact over the line', source: 'told' })).toMatchObject({ ok: false, code: 'PROFILE_FULL' })
    expect(PROFILE_FACTS_MAX_CHARS).toBe(4000)

    const c = setup()
    seed(c.db, PROFILE_PROPOSALS_MAX, { status: 'proposed', source: 'learned' })
    expect(await saveProfileFact(c.sb, { userId: ME, text: 'another guess', source: 'learned', proposeOnly: true })).toMatchObject({ ok: false, code: 'TOO_MANY_PROPOSALS' })
    // Proposals never block what the person says.
    expect(await saveProfileFact(c.sb, { userId: ME, text: 'Keep answers short', source: 'told' })).toMatchObject({ ok: true })

    // What Dial8 noticed, live: at most 20, and never in the way of what the person says.
    const d = setup()
    seed(d.db, PROFILE_LEARNED_MAX, { source: 'learned' })
    const over = await saveProfileFact(d.sb, { userId: ME, text: 'one more guess', source: 'learned' })
    expect(over).toMatchObject({ ok: false, code: 'PROFILE_FULL' })
    expect(!over.ok && over.error).toMatch(/Dial8 noticed/)
    expect(await saveProfileFact(d.sb, { userId: ME, text: 'Keep answers short', source: 'told' })).toMatchObject({ ok: true, fact: { status: 'active' } })
  })

  it('refuses a secret or contact details before touching the database', async () => {
    const { db, sb } = setup()
    expect(await saveProfileFact(sb, { userId: ME, text: 'Text me on 415 555 0101', source: 'told' })).toMatchObject({ ok: false, code: 'INPUT_INVALID' })
    expect(db.calls).toHaveLength(0)
  })
})

describe('edit, accept, delete', () => {
  it('edits text (becoming edited) and importance, only the person’s own fact', async () => {
    const { db, sb } = setup()
    seed(db, 1)
    db.seed('profile_fact', [{ id: 'theirs', user_id: OTHER, text: 'x', status: 'active', source: 'told', importance: 3, superseded_by: null }])
    expect(await editProfileFact(sb, { userId: ME, id: 'f0', text: 'Keep it brief', importance: 4 })).toMatchObject({ ok: true })
    expect(facts(db)[0]).toMatchObject({ text: 'Keep it brief', source: 'edited', importance: 4 })
    expect(await editProfileFact(sb, { userId: ME, id: 'theirs', text: 'mine now' })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await editProfileFact(sb, { userId: ME, id: 'f0', text: 'see https://x.com' })).toMatchObject({ ok: false, code: 'INPUT_INVALID' })
  })

  it('accepts a proposal within the caps, and only a proposal', async () => {
    const { db, sb } = setup()
    db.seed('profile_fact', [{ id: 'p', user_id: ME, text: 'Works early', status: 'proposed', source: 'learned', importance: 3, superseded_by: null }])
    expect(await acceptProfileFact(sb, { userId: ME, id: 'p' })).toMatchObject({ ok: true, fact: { status: 'active' } })
    expect(await acceptProfileFact(sb, { userId: ME, id: 'p' })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('deletes the person’s own fact; dismiss deletes only a proposal', async () => {
    const { db, sb } = setup()
    seed(db, 1)
    db.seed('profile_fact', [{ id: 'theirs', user_id: OTHER, text: 'x', status: 'active', source: 'told', importance: 3, superseded_by: null }])
    expect(await deleteProfileFact(sb, { userId: ME, id: 'f0', onlyProposed: true })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await deleteProfileFact(sb, { userId: ME, id: 'theirs' })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await deleteProfileFact(sb, { userId: ME, id: 'f0' })).toEqual({ ok: true })
    expect(facts(db).map((f) => f.id)).toEqual(['theirs'])
  })
})

describe('loading', () => {
  it('ranks by importance then the newest, skipping what does not fit the caps', () => {
    const picked = selectProfileFacts([
      { id: 'a', text: 'low new', importance: 1, updated_at: '2026-10-10' },
      { id: 'b', text: 'high old', importance: 5, updated_at: '2026-01-01' },
      { id: 'c', text: 'mid new', importance: 3, updated_at: '2026-10-10' },
      { id: 'd', text: 'mid old', importance: 3, updated_at: '2026-01-01' },
      { id: 'big', text: 'z'.repeat(3990), importance: 4, updated_at: '2026-10-10' },
    ])
    // The 3,990-character fact ranks second but takes the room: shorter ones after it still fit only while room lasts.
    expect(picked.map((f) => f.id)).toEqual(['b', 'big'])
    const many = selectProfileFacts(Array.from({ length: 120 }, (_, i) => ({ id: `f${i}`, text: 'x', importance: 3, updated_at: '2026-10-01' })))
    expect(many).toHaveLength(PROFILE_FACTS_MAX_ACTIVE)
  })

  it('loads only the person’s active, unsuperseded facts', async () => {
    const { db, sb } = setup()
    db.seed('profile_fact', [
      { id: 'a', user_id: ME, text: 'Keep answers short', status: 'active', importance: 3, superseded_by: null, updated_at: '2026-10-01' },
      { id: 'p', user_id: ME, text: 'guess', status: 'proposed', importance: 5, superseded_by: null, updated_at: '2026-10-01' },
      { id: 's', user_id: ME, text: 'old', status: 'active', importance: 5, superseded_by: 'a', retired_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-01' },
      { id: 'o', user_id: OTHER, text: 'theirs', status: 'active', importance: 5, superseded_by: null, updated_at: '2026-10-01' },
    ])
    expect(await loadProfileFacts(sb, ME)).toEqual([{ id: 'a', text: 'Keep answers short' }])
  })
})

describe('retirement, races and proposals (A2a review)', () => {
  it('supersede retires the old fact twice over: superseded_by and retired_at', async () => {
    const { db, sb } = setup()
    seed(db, 1, { text: 'Keep answers short', importance: 4 })
    const out = await supersedeProfileFact(sb, { userId: ME, id: 'f0', text: 'Keep answers to three lines', source: 'told' })
    expect(out).toMatchObject({ ok: true, already: false, fact: { text: 'Keep answers to three lines', status: 'active', importance: 4 } })
    const old = facts(db).find((f) => f.id === 'f0')!
    expect(old.superseded_by).toBe(out.ok && out.fact.id)
    expect(typeof old.retired_at).toBe('string')
  })

  it('a retired fact stays retired when its newer fact is deleted (superseded_by cleared by the FK)', async () => {
    const { db, sb } = setup()
    db.seed('profile_fact', [{ id: 'old', user_id: ME, text: 'Keep answers short', status: 'active', source: 'told', importance: 3, superseded_by: null, retired_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-01' }])
    expect(await loadProfileFacts(sb, ME)).toEqual([])
    expect(await saveProfileFact(sb, { userId: ME, text: 'Keep answers short', source: 'told' })).toMatchObject({ ok: true, already: false })
  })

  it('two saves of one text racing: the loser’s unique violation comes back as the winner (already)', async () => {
    const { db, sb } = setup()
    // Between the writer's read and its insert, another save lands the same text.
    const racing = {
      from: (table: string) => {
        const builder = db.from(table) as Record<string, (...a: unknown[]) => unknown>
        if (table !== 'profile_fact') return builder
        const insert = builder.insert
        builder.insert = (row: unknown) => {
          db.seed('profile_fact', [{ id: 'winner', user_id: ME, text: 'Prefers bullets', status: 'active', source: 'told', importance: 3, superseded_by: null, updated_at: '2026-10-14' }])
          db.failNextInsert('profile_fact', { code: '23505', message: 'duplicate key value violates unique constraint "profile_fact_live_text_key"' })
          return insert(row)
        }
        return builder
      },
    } as unknown as SupabaseClient
    const out = await saveProfileFact(racing, { userId: ME, text: 'Prefers bullets', source: 'told' })
    expect(out).toMatchObject({ ok: true, already: true, fact: { id: 'winner' } })
  })

  it('an edit onto another live fact’s text is a duplicate, never a second copy', async () => {
    const { db, sb } = setup()
    seed(db, 2)
    expect(await editProfileFact(sb, { userId: ME, id: 'f0', text: 'FACT 1' })).toMatchObject({ ok: false, code: 'DUPLICATE' })
  })

  it('proposeOnly saves a proposal whatever the source, and restating one never accepts it', async () => {
    const { db, sb } = setup()
    expect(await saveProfileFact(sb, { userId: ME, text: 'Sign as the CEO', source: 'told', proposeOnly: true })).toMatchObject({ ok: true, fact: { status: 'proposed', source: 'told' } })
    expect(await saveProfileFact(sb, { userId: ME, text: 'sign as the ceo', source: 'told', proposeOnly: true })).toMatchObject({ ok: true, already: true })
    expect(facts(db)[0].status).toBe('proposed')
  })
})

describe('supersede onto a proposal, and never two live versions (A2 review)', () => {
  it('replacing an active fact with the text of a waiting proposal accepts the proposal', async () => {
    const { db, sb } = setup()
    seed(db, 1, { text: 'Keep answers short' })
    db.seed('profile_fact', [{ id: 'p', user_id: ME, text: 'Keep answers to three lines', status: 'proposed', source: 'learned', importance: 3, superseded_by: null, updated_at: '2026-10-02' }])
    const out = await supersedeProfileFact(sb, { userId: ME, id: 'f0', text: 'keep answers to three lines', source: 'told' })
    // Accepted on the person's verified words: told now, no longer learned.
    expect(out).toMatchObject({ ok: true, already: false, fact: { id: 'p', status: 'active', source: 'told' } })
    expect(facts(db).find((f) => f.id === 'f0')).toMatchObject({ superseded_by: 'p' })
    expect(facts(db)).toHaveLength(2)
  })

  it('when the old fact cannot retire, the new row is removed again', async () => {
    const { db, sb } = setup()
    seed(db, 1, { text: 'Keep answers short' })
    const failing = {
      from: (table: string) => {
        const builder = db.from(table) as Record<string, (...a: unknown[]) => unknown>
        const update = builder.update
        builder.update = (patch: unknown) => {
          if (patch && typeof patch === 'object' && 'superseded_by' in (patch as object)) {
            const chain: Record<string, unknown> = {}
            for (const m of ['eq', 'is']) chain[m] = () => chain
            chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'retire failed' } }).then(resolve)
            return chain
          }
          return update(patch)
        }
        return builder
      },
    } as unknown as SupabaseClient
    const out = await supersedeProfileFact(failing, { userId: ME, id: 'f0', text: 'Keep answers to three lines', source: 'told' })
    expect(out).toMatchObject({ ok: false, code: 'SAVE_FAILED' })
    expect(facts(db).map((f) => f.text)).toEqual(['Keep answers short'])
    expect(sb).toBeTruthy()
  })
})

describe('a retire that committed but reported an error (A2 review)', () => {
  it('keeps the new fact: the old one did retire onto it', async () => {
    const { db, sb } = setup()
    seed(db, 1, { text: 'Keep answers short' })
    const flaky = {
      from: (table: string) => {
        const builder = db.from(table) as Record<string, (...a: unknown[]) => unknown>
        const update = builder.update
        builder.update = (patch: unknown) => {
          if (patch && typeof patch === 'object' && 'superseded_by' in (patch as object)) {
            // The write lands, the answer is an error.
            const chain = update(patch) as Record<string, (...a: unknown[]) => unknown>
            const wrap: Record<string, unknown> = {}
            for (const m of ['eq', 'is']) wrap[m] = (...a: unknown[]) => (chain[m](...a), wrap)
            wrap.then = (resolve: (v: unknown) => unknown) =>
              Promise.resolve(chain as unknown as PromiseLike<unknown>).then(() => resolve({ data: null, error: { message: 'connection reset' } }))
            return wrap
          }
          return update(patch)
        }
        return builder
      },
    } as unknown as SupabaseClient
    const out = await supersedeProfileFact(flaky, { userId: ME, id: 'f0', text: 'Keep answers to three lines', source: 'told' })
    expect(out).toMatchObject({ ok: true, fact: { text: 'Keep answers to three lines' } })
    expect(facts(db).map((f) => f.text).sort()).toEqual(['Keep answers short', 'Keep answers to three lines'])
    expect(facts(db).find((f) => f.id === 'f0')?.superseded_by).toBe(out.ok && out.fact.id)
    expect(sb).toBeTruthy()
  })

  it('a restated proposal accepted through a save becomes the saver’s (told)', async () => {
    const { db, sb } = setup()
    db.seed('profile_fact', [{ id: 'p', user_id: ME, text: 'Works early mornings', status: 'proposed', source: 'learned', importance: 3, superseded_by: null, updated_at: '2026-10-02' }])
    expect(await saveProfileFact(sb, { userId: ME, text: 'works early mornings', source: 'told' })).toMatchObject({ ok: true, fact: { status: 'active', source: 'told' } })
    expect(facts(db)[0]).toMatchObject({ status: 'active', source: 'told' })
  })
})

