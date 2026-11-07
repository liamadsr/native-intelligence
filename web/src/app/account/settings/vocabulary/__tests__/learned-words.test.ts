import { describe, expect, it } from 'vitest'
import { learnedWords } from '../vocabulary-settings-view'
import type { VocabularyTerm } from '@/lib/vocabulary/store'

const row = (over: Partial<VocabularyTerm>): VocabularyTerm => ({
  id: over.term ?? 'x',
  workspaceId: 'ws',
  scope: 'workspace',
  term: 'x',
  soundsLike: [],
  status: 'active',
  source: 'manual',
  evidence: {},
  createdBy: null,
  createdAt: '',
  updatedAt: '',
  ...over,
})

describe('learnedWords', () => {
  it('lists added words, then learned ones, then known names, once each, without the ones removed', () => {
    const words = learnedWords({
      terms: [
        row({ term: 'pgvector', source: 'workspace' }),
        row({ term: 'Supabase', source: 'manual' }),
        row({ term: 'Tauri', source: 'agent' }),
        row({ term: 'Inngest', status: 'dismissed', source: 'manual' }),
        row({ term: 'Pinecone', status: 'dismissed', source: 'auto', scope: 'personal' }),
        row({ term: 'shadcn', source: 'workspace' }),
        row({ term: 'shadcn', status: 'dismissed', source: 'auto', scope: 'personal' }),
      ],
      automatic: [
        { term: 'Liam Alizadeh', kind: 'teammate' },
        { term: 'Pinecone', kind: 'company' },
        { term: 'supabase', kind: 'project' },
        { term: 'Dial8 Desktop', kind: 'project' },
      ],
    })
    expect(words.map((w) => [w.term, w.label, !!w.added])).toEqual([
      ['Supabase', '', true],
      ['Tauri', '', true],
      ['pgvector', '', false],
      ['Liam Alizadeh', 'Person', false],
      ['Dial8 Desktop', 'Project', false],
    ])
  })
})
