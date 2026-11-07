import { describe, expect, it } from 'vitest'
import { tableColumns } from '@/test/member-schema'
import { LEXICON_WORDS } from '../lexicon-words'
import { dropMishearings, harvestWords, personalTexts, syncHarvest, trustedSpellings, workspaceTexts, type HarvestText } from '../harvest'
import { ME, OTHER, WS, termRow, vocabularyDb } from './helpers/vocabulary-db'

const lexicon = new Set(LEXICON_WORDS.split('\n').filter(Boolean))
const doc = (text: string): HarvestText => ({ text, source: 'document' })

describe('harvestWords', () => {
  it('takes repeated non-ordinary words, in the spelling the team uses most', () => {
    const words = harvestWords(
      [
        doc('We moved auth to Supabase. Supabase has RLS policies; RLS is on.'),
        doc("The supabase dashboard and Supabase's logs. Ping Kowalczyk, then Kowalczyk again."),
        { text: 'Dial8 ships Friday. Dial8 desktop too.', source: 'action' },
      ],
      lexicon,
    )
    expect(words.map((w) => [w.term, w.count])).toEqual([['Supabase', 4], ['RLS', 2], ['Kowalczyk', 2], ['Dial8', 2]])
    expect(words[0].sources).toEqual(['document'])
    expect(words.find((w) => w.term === 'Dial8')?.sources).toEqual(['action'])
  })

  it('a one-off word never qualifies; an all-lowercase one needs four sightings', () => {
    expect(harvestWords([doc('We tried Inngest once.')], lexicon)).toEqual([])
    expect(harvestWords([doc('pgvector pgvector pgvector')], lexicon)).toEqual([])
    expect(harvestWords([doc('pgvector pgvector pgvector pgvector')], lexicon).map((w) => w.term)).toEqual(['pgvector'])
  })

  it('skips ordinary words, names, places, code, ids and urls', () => {
    const noise = 'The meeting on Tuesday (Oct 3) in London with Sarah went fine. A follow-up, read-only. useEffect useEffect get_user get_user a1b2c3d4e5 a1b2c3d4e5 v2.3.1 v2.3.1 https://x.io https://x.io 12345 12345 12px LocalModuleInfo ENG-42 L0–L3'
    expect(harvestWords([doc(noise), doc(noise)], lexicon)).toEqual([])
  })

  it('learns the parts of a hyphenated word, never the compound', () => {
    const words = harvestWords(
      [{ text: 'KokoLink-specific and KokoLink-Atlas, an Ex-a16z partner and a16z-presented deck. ENG-42 ENG-43', source: 'document' }],
      lexicon,
    )
    expect(words.map((w) => w.term).sort()).toEqual(['KokoLink', 'a16z'])
  })
})

describe('where the texts come from', () => {
  it.each([
    ['document', ['title', 'content', 'visibility', 'outside_derived', 'created_by', 'updated_at', 'workspace_id']],
    ['chat_messages', ['ui_message', 'role', 'user_id', 'workspace_id', 'created_at']],
    ['actions', ['confirmation', 'workspace_id']],
  ])('%s has the columns read', (table, columns) => {
    const have = tableColumns(table)
    for (const c of columns) expect(have.has(c), `${table}.${c}`).toBe(true)
  })

  it("the workspace's texts: workspace documents (never private or web-derived) and confirmed actions not made from a call", async () => {
    const db = vocabularyDb({
      document: [
        { workspace_id: WS, title: 'Plan', content: 'Supabase', visibility: 'workspace', outside_derived: false, updated_at: '2' },
        { workspace_id: WS, title: 'Legacy', content: 'Tauri', visibility: null, outside_derived: null, updated_at: '1' },
        { workspace_id: WS, title: 'Mine', content: 'Secret', visibility: 'private', created_by: OTHER, outside_derived: false, updated_at: '3' },
        { workspace_id: WS, title: 'Web', content: 'Injected', visibility: 'workspace', outside_derived: true, updated_at: '4' },
      ],
      actions: [
        { workspace_id: WS, title: 'Ship pgvector', description: '', confirmation: 'confirmed', created_at: '1', source_type: 'user', source_capture_id: null },
        { workspace_id: WS, title: 'Fix the APAM gateway', description: '', confirmation: 'confirmed', created_at: '3', source_type: 'meeting_extraction', source_capture_id: 'c1' },
        { workspace_id: WS, title: 'Ask about APEM', description: '', confirmation: 'confirmed', created_at: '4', source_type: 'user', source_capture_id: 'c2' },
        { workspace_id: WS, title: 'From a private call', description: '', confirmation: 'suggested', created_at: '2' },
      ],
    })
    const texts = (await workspaceTexts(db.client, WS)).map((t) => t.text)
    expect(texts.join('|')).toContain('Supabase')
    expect(texts.join('|')).toContain('Tauri')
    expect(texts.join('|')).toContain('Ship pgvector')
    expect(texts.join('|')).not.toMatch(/Secret|Injected|private call|APAM|APEM/)
  })

  it("a person's texts: only their own private documents (by member id), never chat messages", async () => {
    const db = vocabularyDb({
      chat_messages: [{ workspace_id: WS, user_id: ME, role: 'user', ui_message: { parts: [{ type: 'text', text: 'my dictated APAM note' }] }, created_at: '1' }],
      document: [
        { workspace_id: WS, title: 'Mine', content: 'Siobhan', visibility: 'private', created_by: 'member-me', outside_derived: false, updated_at: '1' },
        { workspace_id: WS, title: 'Theirs', content: 'Hidden', visibility: 'private', created_by: 'member-other', outside_derived: false, updated_at: '2' },
      ],
    })
    const all = (await personalTexts(db.client, WS, 'member-me')).map((t) => t.text).join('|')
    expect(all).toContain('Siobhan')
    expect(all).not.toMatch(/APAM|Hidden/)
  })
})

describe('mishearings of names and added words', () => {
  it('trusted spellings: each name whole and its words that are not ordinary English', () => {
    expect(trustedSpellings(['APIM (Azure API Management)', 'Liam Alizadeh'], lexicon).sort()).toEqual(['APIM', 'APIM (Azure API Management)', 'Alizadeh', 'Liam Alizadeh'])
  })

  it('drops a learned word that sounds close to a different trusted one, and nothing else', () => {
    const learned = ['APAM', 'APEM', 'kokolink', 'pgvector', 'Kubernetes'].map((term) => ({ term, count: 5, sources: ['document'] }))
    const kept = dropMishearings(learned, trustedSpellings(['APIM (Azure API Management)', 'KokoLink'], lexicon))
    // "kokolink" is KokoLink in another casing: kept as evidence, one spelling is picked at compile.
    expect(kept.map((w) => w.term)).toEqual(['kokolink', 'pgvector', 'Kubernetes'])
  })

  it('never drops a learned word for another learned one, however much more often it is written', () => {
    const learned = [{ term: 'APAM', count: 40, sources: ['document'] }, { term: 'APIM', count: 3, sources: ['document'] }]
    expect(dropMishearings(learned, ['Supabase']).map((w) => w.term)).toEqual(['APAM', 'APIM'])
  })
})

describe('syncHarvest', () => {
  it('adds new words live, removes stale harvested ones, never touches manual or turned-off words', async () => {
    const db = vocabularyDb({
      vocabulary_term: [
        termRow({ term: 'OldWord', source: 'workspace', created_by: null }),
        termRow({ term: 'Supabase', source: 'workspace', created_by: null }),
        termRow({ term: 'Tauri', source: 'manual' }),
        termRow({ term: 'Gone', source: 'workspace', status: 'dismissed', created_by: null }),
        termRow({ term: 'Personal', source: 'workspace', user_id: ME, created_by: null }),
      ],
    })
    const r = await syncHarvest(db.client, {
      workspaceId: WS,
      userId: null,
      words: [
        { term: 'Supabase', count: 4, sources: ['document'] },
        { term: 'Tauri', count: 2, sources: ['document'] },
        { term: 'pgvector', count: 5, sources: ['action'] },
      ],
    })
    expect(r).toEqual({ added: 1, removed: 1 })
    expect(db.tables.vocabulary_term.map((t) => [t.term, t.source, t.status, t.user_id]).sort()).toEqual(
      [
        ['Gone', 'workspace', 'dismissed', null],
        ['Personal', 'workspace', 'active', ME],
        ['Supabase', 'workspace', 'active', null],
        ['Tauri', 'manual', 'active', null],
        ['pgvector', 'workspace', 'active', null],
      ].sort(),
    )
    expect(db.tables.vocabulary_term.find((t) => t.term === 'pgvector')).toMatchObject({ evidence: { count: 5, sources: ['action'] }, created_by: null })
  })
})

describe('syncHarvest at scale', () => {
  it('sees every existing row (paged) and skips a word someone added meanwhile without losing the rest', async () => {
    const existing = Array.from({ length: 1500 }, (_, i) => termRow({ term: `Have${String(i).padStart(4, '0')}`, source: 'workspace', created_by: null }))
    const db = vocabularyDb({ vocabulary_term: existing })
    const words = [...existing.map((r) => ({ term: r.term as string, count: 2, sources: ['document'] })), { term: 'Fresh', count: 3, sources: ['document'] }]
    expect(await syncHarvest(db.client, { workspaceId: WS, userId: null, words })).toEqual({ added: 1, removed: 0 })
    expect(db.tables.vocabulary_term).toHaveLength(1501)
  })
})
