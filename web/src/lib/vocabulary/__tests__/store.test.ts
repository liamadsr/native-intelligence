import { beforeEach, describe, expect, it } from 'vitest'
import { tableColumns } from '@/test/member-schema'
import {
  addVocabularyTerm,
  automaticVocabulary,
  compileVocabulary,
  deleteVocabularyTerm,
  listVocabulary,
  normalizeSoundsLike,
  normalizeTerm,
  updateVocabularyTerm,
} from '../store'
import { ME, OTHER, OTHER_WS, WS, termRow, vocabularyDb, type VocabularyDb } from './helpers/vocabulary-db'

let db: VocabularyDb
const ctx = { workspaceId: WS, userId: ME }

beforeEach(() => {
  db = vocabularyDb()
})

describe('the columns the store reads exist (per the migrations)', () => {
  it.each([
    ['vocabulary_term', ['id', 'workspace_id', 'user_id', 'term', 'sounds_like', 'status', 'source', 'evidence', 'created_by', 'created_at', 'updated_at']],
    ['member', ['id', 'user_id', 'display_name', 'workspace_id']],
    // `projects` predates the migrations folder (its CREATE is not in it), so it can't be checked
    // here; src/lib/ai/tools/projects.ts reads the same name / is_archived columns.
    ['contact', ['full_name', 'company_id', 'workspace_id', 'merged_into_contact_id', 'visibility', 'created_by_member_id', 'last_interaction_at']],
    ['company', ['name']],
  ])('%s', (table, columns) => {
    const have = tableColumns(table)
    for (const c of columns) expect(have.has(c), `${table}.${c}`).toBe(true)
  })
})

describe('normalizeTerm / normalizeSoundsLike', () => {
  it('trims, collapses spaces and bounds the length', () => {
    expect(normalizeTerm('  Post   Hog ')).toEqual({ ok: true, term: 'Post Hog' })
    expect(normalizeTerm('')).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeTerm('!!!')).toEqual({ ok: false, reason: 'no_letters' })
    expect(normalizeTerm('x'.repeat(61))).toEqual({ ok: false, reason: 'too_long' })
    expect(normalizeTerm(3)).toEqual({ ok: false, reason: 'not_text' })
  })

  it('dedupes by letters, drops the term itself, takes a comma list', () => {
    expect(normalizeSoundsLike('Superbase, super base, supabase, Soupabase', 'Supabase')).toEqual(['Superbase', 'Soupabase'])
    expect(normalizeSoundsLike(['  route eight ', 7, ''], 'Route8')).toEqual(['route eight'])
  })
})

describe('listVocabulary', () => {
  it("returns the workspace's words and mine, never another person's or workspace's", async () => {
    db = vocabularyDb({
      vocabulary_term: [
        termRow({ term: 'Supabase' }),
        termRow({ term: 'Tauri', user_id: ME }),
        termRow({ term: 'Secret', user_id: OTHER }),
        termRow({ term: 'Elsewhere', workspace_id: OTHER_WS }),
      ],
    })
    const terms = await listVocabulary(db.client, ctx)
    expect(terms.map((t) => [t.term, t.scope])).toEqual([['Supabase', 'workspace'], ['Tauri', 'personal']])
  })
})

describe('addVocabularyTerm', () => {
  it('adds a workspace word with its sounds-like forms', async () => {
    const r = await addVocabularyTerm(db.client, { ...ctx, scope: 'workspace', term: 'Supabase', soundsLike: ['Superbase'], source: 'manual' })
    expect(r).toMatchObject({ ok: true, created: true, term: { term: 'Supabase', scope: 'workspace', soundsLike: ['Superbase'], status: 'active' } })
    expect(db.tables.vocabulary_term[0]).toMatchObject({ user_id: null, created_by: ME })
  })

  it('a personal word is owned by the caller', async () => {
    await addVocabularyTerm(db.client, { ...ctx, scope: 'personal', term: 'Kowalczyk', source: 'manual' })
    expect(db.tables.vocabulary_term[0]).toMatchObject({ user_id: ME })
  })

  it('folds into the same word (any case) and merges sounds-like forms', async () => {
    db = vocabularyDb({ vocabulary_term: [termRow({ term: 'Supabase', sounds_like: ['Superbase'] })] })
    const r = await addVocabularyTerm(db.client, { ...ctx, scope: 'workspace', term: 'supabase', soundsLike: ['Soupabase'], source: 'agent' })
    expect(r).toMatchObject({ ok: true, created: false, term: { soundsLike: ['Superbase', 'Soupabase'] } })
    expect(db.tables.vocabulary_term).toHaveLength(1)
  })

  it('an active add turns a dismissed word back on; a personal "turn off" never switches off a word that is on', async () => {
    db = vocabularyDb({
      vocabulary_term: [
        termRow({ term: 'Inngest', status: 'dismissed', source: 'manual' }),
        termRow({ term: 'Tauri', status: 'active', user_id: ME }),
      ],
    })
    expect(await addVocabularyTerm(db.client, { ...ctx, scope: 'workspace', term: 'Inngest', source: 'agent' })).toMatchObject({ ok: true, term: { status: 'active', source: 'agent' } })
    expect(await addVocabularyTerm(db.client, { ...ctx, scope: 'personal', term: 'Tauri', source: 'auto', status: 'dismissed' })).toMatchObject({ ok: true, note: 'already_active', term: { status: 'active' } })
  })

  it('a person adding a harvested word makes it theirs, so the harvest no longer removes it', async () => {
    db = vocabularyDb({ vocabulary_term: [termRow({ term: 'pgvector', source: 'workspace', created_by: null })] })
    const r = await addVocabularyTerm(db.client, { ...ctx, scope: 'workspace', term: 'pgvector', source: 'manual' })
    expect(r).toMatchObject({ ok: true, created: false, term: { source: 'manual', status: 'active' } })
  })

  it('rejects a bad word with a 400', async () => {
    expect(await addVocabularyTerm(db.client, { ...ctx, scope: 'workspace', term: '   ', source: 'manual' })).toMatchObject({ ok: false, status: 400 })
  })
})

describe('updateVocabularyTerm / deleteVocabularyTerm', () => {
  it('turns a word off, edits its forms and moves it between workspace and personal', async () => {
    const row = termRow({ term: 'Inngest' })
    db = vocabularyDb({ vocabulary_term: [row] })
    const r = await updateVocabularyTerm(db.client, { ...ctx, id: row.id as string, status: 'dismissed', soundsLike: 'Ingest', scope: 'personal' })
    expect(r).toMatchObject({ ok: true, term: { status: 'dismissed', soundsLike: ['Ingest'], scope: 'personal' } })
  })

  it("is a 404 for another person's word, and a 400 for a bad status", async () => {
    const theirs = termRow({ user_id: OTHER })
    const ours = termRow({ term: 'Tauri' })
    db = vocabularyDb({ vocabulary_term: [theirs, ours] })
    expect(await updateVocabularyTerm(db.client, { ...ctx, id: theirs.id as string, status: 'active' })).toMatchObject({ ok: false, status: 404 })
    expect(await updateVocabularyTerm(db.client, { ...ctx, id: ours.id as string, status: 'on' })).toMatchObject({ ok: false, status: 400 })
    expect(await deleteVocabularyTerm(db.client, { ...ctx, id: theirs.id as string })).toEqual({ ok: true, deleted: false })
    expect(await deleteVocabularyTerm(db.client, { ...ctx, id: ours.id as string })).toEqual({ ok: true, deleted: true })
  })

  it('renaming onto an existing word is a 409', async () => {
    const a = termRow({ term: 'Supabase' })
    const b = termRow({ term: 'Superbase' })
    db = vocabularyDb({ vocabulary_term: [a, b] })
    expect(await updateVocabularyTerm(db.client, { ...ctx, id: b.id as string, term: 'supabase' })).toMatchObject({ ok: false, status: 409 })
  })
})

describe('automaticVocabulary / compileVocabulary', () => {
  const seed = () => ({
    member: [
      { id: 'm1', user_id: ME, display_name: 'Liam Alizadeh', workspace_id: WS },
      { id: 'm2', user_id: OTHER, display_name: 'Prabhjot Singh', workspace_id: WS },
    ],
    projects: [{ name: 'Depot8 Desktop', workspace_id: WS, is_archived: false }, { name: 'Old thing', workspace_id: WS, is_archived: true }],
    contact: [
      { full_name: 'Siobhan Kowalczyk', company: { name: 'Pinecone' }, workspace_id: WS, merged_into_contact_id: null, visibility: 'workspace', created_by_member_id: 'm2', last_interaction_at: '2026-10-20' },
      { full_name: 'Ngozi Okafor', company: null, workspace_id: WS, merged_into_contact_id: null, visibility: 'private', created_by_member_id: 'm1', last_interaction_at: '2026-10-19' },
      { full_name: 'Their Secret', company: { name: 'Hidden Co' }, workspace_id: WS, merged_into_contact_id: null, visibility: 'private', created_by_member_id: 'm2', last_interaction_at: '2026-10-21' },
      { full_name: 'Team Only', company: null, workspace_id: WS, merged_into_contact_id: null, visibility: 'team', created_by_member_id: 'm2', last_interaction_at: '2026-10-21' },
      { full_name: 'Merged Away', company: null, workspace_id: WS, merged_into_contact_id: 'x', visibility: 'workspace', created_by_member_id: 'm2', last_interaction_at: '2026-10-22' },
    ],
  })

  it("teammates, live projects, and workspace-visible or own contacts with their companies — never another member's private ones", async () => {
    db = vocabularyDb(seed())
    const auto = await automaticVocabulary(db.client, ctx)
    expect(auto).toEqual([
      { term: 'Liam Alizadeh', kind: 'teammate' },
      { term: 'Prabhjot Singh', kind: 'teammate' },
      { term: 'Depot8 Desktop', kind: 'project' },
      { term: 'Siobhan Kowalczyk', kind: 'contact' },
      { term: 'Pinecone', kind: 'company' },
      { term: 'Ngozi Okafor', kind: 'contact' },
    ])
  })

  it('leaves out names nobody says and names made only of everyday words', async () => {
    db = vocabularyDb({
      member: [{ id: 'm1', user_id: ME, display_name: 'Liam Alizadeh', workspace_id: WS }],
      projects: ['__default__', 'Untitled Project', 'Daily', 'Get a dog', 'Depot8 Desktop'].map((name) => ({ name, workspace_id: WS, is_archived: false })),
      contact: ['stephanie.guerreiro.1', 'dl-d-usallfield', 'vrolland', 'Siobhan Kowalczyk'].map((full_name, i) => ({
        full_name, company: null, workspace_id: WS, merged_into_contact_id: null, visibility: 'workspace', created_by_member_id: 'm1', last_interaction_at: `2026-10-1${i}`,
      })),
    })
    const auto = await automaticVocabulary(db.client, ctx)
    expect(auto.map((a) => a.term).sort()).toEqual(['Depot8 Desktop', 'Liam Alizadeh', 'Siobhan Kowalczyk'])
  })

  it('compiles active words (with forms), harvested words and the automatic names nobody hid', async () => {
    db = vocabularyDb({
      ...seed(),
      vocabulary_term: [
        termRow({ term: 'Supabase', sounds_like: ['Superbase'] }),
        termRow({ term: 'Inngest', status: 'dismissed' }),
        termRow({ term: 'Pinecone', status: 'dismissed', source: 'auto', user_id: ME }),
        termRow({ term: 'Tauri', user_id: ME }),
        termRow({ term: 'pgvector', source: 'workspace', created_by: null }),
        termRow({ term: 'shadcn', source: 'workspace', created_by: null }),
        termRow({ term: 'shadcn', status: 'dismissed', source: 'auto', user_id: ME }),
      ],
    })
    const c = await compileVocabulary(db.client, ctx)
    // Added words first (yours, then the workspace's), then what the team writes, then the names Native Intelligence knows; each sorted.
    expect(c.entries.map((e) => e.term)).toEqual(['Tauri', 'Supabase', 'pgvector', 'Depot8 Desktop', 'Liam Alizadeh', 'Ngozi Okafor', 'Prabhjot Singh', 'Siobhan Kowalczyk'])
    expect(c.entries[1]).toEqual({ term: 'Supabase', soundsLike: ['Superbase'] })
    expect(c.counts).toEqual({ stored: 3, automatic: 5 })
    expect(c.version).toMatch(/^[0-9a-z]+$/)
    const again = await compileVocabulary(db.client, ctx)
    expect(again.version).toBe(c.version)
  })

  it('one spelling per word: an added word wins; then a capital; then how the team writes it, a name, the person\'s own', async () => {
    db = vocabularyDb({
      ...seed(),
      projects: [{ name: 'KokoLink', workspace_id: WS, is_archived: false }],
      contact: [{ full_name: 'Ana Ruiz', company: { name: 'Akqa' }, workspace_id: WS, merged_into_contact_id: null, visibility: 'workspace', created_by_member_id: 'm2', last_interaction_at: '2026-10-20' }],
      vocabulary_term: [
        termRow({ term: 'kokolink', source: 'workspace', user_id: ME, created_by: null }),
        termRow({ term: 'AKQA', source: 'workspace', created_by: null }),
        termRow({ term: 'apim', source: 'workspace', created_by: null }),
        termRow({ term: 'APIM', source: 'workspace', user_id: ME, created_by: null }),
        termRow({ term: 'a16z', source: 'workspace', created_by: null }),
        termRow({ term: 'tauri', source: 'manual', sounds_like: ['tory'] }),
        termRow({ term: 'Tauri', source: 'workspace', created_by: null }),
      ],
    })
    const c = await compileVocabulary(db.client, ctx)
    const spelled = (w: string) => c.entries.filter((e) => e.term.toLowerCase() === w).map((e) => e.term)
    expect(spelled('kokolink')).toEqual(['KokoLink'])
    expect(spelled('akqa')).toEqual(['AKQA'])
    expect(spelled('apim')).toEqual(['APIM'])
    expect(spelled('a16z')).toEqual(['a16z'])
    expect(c.entries.find((e) => e.term.toLowerCase() === 'tauri')).toEqual({ term: 'tauri', soundsLike: ['tory'] })
  })

  it('a dismissed word of any other source never hides an automatic name (only a "turn off" does)', async () => {
    db = vocabularyDb({ ...seed(), vocabulary_term: [termRow({ term: 'Pinecone', status: 'dismissed', source: 'manual' })] })
    const c = await compileVocabulary(db.client, ctx)
    expect(c.entries.map((e) => e.term)).toContain('Pinecone')
  })

  it('still compiles the stored words when the automatic sources fail', async () => {
    db = vocabularyDb({ vocabulary_term: [termRow({ term: 'Supabase' })] }, { errorTables: ['contact'] })
    const c = await compileVocabulary(db.client, ctx)
    expect(c.entries.map((e) => e.term)).toEqual(['Supabase'])
  })
})

describe('paging past the 1,000-row answer cap', () => {
  it('listVocabulary reads every page', async () => {
    const rows = Array.from({ length: 2345 }, (_, i) => termRow({ term: `Term${String(i).padStart(4, '0')}`, source: 'workspace', created_by: null }))
    db = vocabularyDb({ vocabulary_term: rows })
    expect(await listVocabulary(db.client, ctx)).toHaveLength(2345)
  })
})
