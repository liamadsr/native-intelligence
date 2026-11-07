import { describe, expect, it } from 'vitest'
import { createVocabularyTools } from '../vocabulary'
import { ME, OTHER, WS, termRow, vocabularyDb } from '@/lib/vocabulary/__tests__/helpers/vocabulary-db'

type Exec = (args: Record<string, unknown>) => Promise<Record<string, unknown>>
const exec = (tools: ReturnType<typeof createVocabularyTools>, name: keyof ReturnType<typeof createVocabularyTools>, args: Record<string, unknown>) =>
  (tools[name] as unknown as { execute: Exec }).execute(args)

describe('vocabulary tools', () => {
  it('add_vocabulary_word adds a workspace word (source agent) and merges a repeat', async () => {
    const db = vocabularyDb()
    const tools = createVocabularyTools(ME, db.client, WS)
    const first = await exec(tools, 'add_vocabulary_word', { term: 'Supabase', sounds_like: ['Superbase'], scope: 'workspace' })
    expect(first).toMatchObject({ success: true, created: true, word: { term: 'Supabase', scope: 'workspace', source: 'agent', sounds_like: ['Superbase'] } })
    const again = await exec(tools, 'add_vocabulary_word', { term: 'supabase', scope: 'workspace' })
    expect(again).toMatchObject({ success: true, created: false })
    expect(db.tables.vocabulary_term).toHaveLength(1)
  })

  it('list_vocabulary lists active words by default; harvested ones only when asked; never turn-off rows', async () => {
    const db = vocabularyDb({
      vocabulary_term: [
        termRow({ term: 'Supabase' }),
        termRow({ term: 'pgvector', source: 'workspace', created_by: null }),
        termRow({ term: 'Pinecone', status: 'dismissed', source: 'auto', user_id: ME }),
        termRow({ term: 'Private', user_id: OTHER }),
      ],
    })
    const tools = createVocabularyTools(ME, db.client, WS)
    expect(await exec(tools, 'list_vocabulary', { status: 'active' })).toMatchObject({ success: true, count: 1, words: [{ term: 'Supabase' }] })
    expect(await exec(tools, 'list_vocabulary', { status: 'all', include_harvested: true })).toMatchObject({ count: 2 })
  })

  it("under omitPrivate: only the workspace's words, and no contact or company names", async () => {
    const db = vocabularyDb({
      vocabulary_term: [termRow({ term: 'Supabase' }), termRow({ term: 'Mine', user_id: ME })],
      member: [{ id: 'm1', user_id: ME, display_name: 'Liam Alizadeh', workspace_id: WS }],
      contact: [{ full_name: 'Siobhan Kowalczyk', company: { name: 'Acme' }, workspace_id: WS, merged_into_contact_id: null, visibility: 'workspace', created_by_member_id: 'm1', last_interaction_at: '1' }],
    })
    const tools = createVocabularyTools(ME, db.client, WS, { omitPrivate: true })
    const r = await exec(tools, 'list_vocabulary', { status: 'active', include_automatic: true })
    expect((r.words as Array<{ term: string }>).map((w) => w.term)).toEqual(['Supabase'])
    expect(r.automatic).toEqual([{ term: 'Liam Alizadeh', kind: 'teammate' }])
  })

  it('an unattended run never changes the vocabulary', async () => {
    const row = termRow({ term: 'Tauri' })
    const db = vocabularyDb({ vocabulary_term: [row] })
    const tools = createVocabularyTools(ME, db.client, WS, { unattended: true })
    expect(await exec(tools, 'add_vocabulary_word', { term: 'Supabase', scope: 'workspace' })).toMatchObject({ success: false })
    expect(await exec(tools, 'update_vocabulary_word', { id: row.id, status: 'dismissed' })).toMatchObject({ success: false })
    expect(await exec(tools, 'delete_vocabulary_word', { id: row.id })).toMatchObject({ success: false })
    expect(db.tables.vocabulary_term).toHaveLength(1)
    expect(db.tables.vocabulary_term[0]).toMatchObject({ status: 'active' })
  })

  it('update_vocabulary_word turns a word off; delete_vocabulary_word removes; other people’s words are out of reach', async () => {
    const mine = termRow({ term: 'Inngest' })
    const theirs = termRow({ term: 'Theirs', user_id: OTHER })
    const db = vocabularyDb({ vocabulary_term: [mine, theirs] })
    const tools = createVocabularyTools(ME, db.client, WS)
    expect(await exec(tools, 'update_vocabulary_word', { id: mine.id, status: 'dismissed' })).toMatchObject({ success: true, word: { status: 'dismissed' } })
    expect(await exec(tools, 'delete_vocabulary_word', { id: theirs.id })).toMatchObject({ success: false })
    expect(await exec(tools, 'delete_vocabulary_word', { id: mine.id })).toEqual({ success: true, deleted: true })
  })

  it('reports a bad word instead of throwing', async () => {
    const tools = createVocabularyTools(ME, vocabularyDb().client, WS)
    expect(await exec(tools, 'add_vocabulary_word', { term: '   ', scope: 'workspace' })).toMatchObject({ success: false })
  })
})
