/**
 * The vocabulary harvest jobs (no model call, nothing to approve), via the
 * createFunction-capture pattern. Pins: the workspace job runs after every
 * processed meeting and on request, debounced per workspace; the personal job
 * runs on request, debounced per person, for a current member only; both keep
 * the harvested rows in step with what was written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'
import { ME, OTHER, WS, vocabularyDb, type VocabularyDb } from '@/lib/vocabulary/__tests__/helpers/vocabulary-db'

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: StepMock }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  configs: {} as Record<string, Record<string, unknown>>,
  db: null as unknown as { client: unknown },
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.configs[config.id as string] = config
      hoisted.handlers[config.id as string] = fn
      return { id: config.id }
    },
    send: vi.fn(),
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.db.client }))

import { VOCABULARY_HARVEST_EVENT } from '../vocabulary-harvest'

let db: VocabularyDb
const run = (id: string, data: Record<string, unknown>) => hoisted.handlers[id]({ event: { data }, step: createStepMock() })
const doc = (content: string, over: Record<string, unknown> = {}) => ({ workspace_id: WS, title: 'Doc', content, visibility: 'workspace', outside_derived: false, created_by: OTHER, updated_at: '1', ...over })

beforeEach(() => {
  db = vocabularyDb({
    member: [{ id: 'm1', workspace_id: WS, user_id: ME, display_name: 'Liam' }],
    document: [
      doc('Supabase and Supabase again. Tauri, Tauri. The APAM gateway, APAM again.'),
      doc('My Kowalczyk notes, Kowalczyk.', { visibility: 'private', created_by: 'm1' }),
    ],
    projects: [{ name: 'APIM (Azure API Management)', workspace_id: WS, is_archived: false }],
    chat_messages: [
      { workspace_id: WS, user_id: ME, role: 'user', ui_message: { parts: [{ type: 'text', text: 'Ping Prabhjot' }] }, created_at: '1' },
      { workspace_id: WS, user_id: ME, role: 'user', ui_message: { parts: [{ type: 'text', text: 'Prabhjot said yes' }] }, created_at: '2' },
    ],
  })
  hoisted.db = db
})

describe('vocabulary-harvest-workspace', () => {
  it('runs after every processed meeting and on request, debounced per workspace', () => {
    expect(hoisted.configs['vocabulary-harvest-workspace']).toMatchObject({
      triggers: [{ event: 'flow/capture.processed' }, { event: VOCABULARY_HARVEST_EVENT }],
      debounce: { key: 'event.data.workspace_id', period: '2m', timeout: '30m' },
      concurrency: [{ limit: 1, key: 'event.data.workspace_id' }],
    })
  })

  it("adds the workspace's written words live, from workspace documents only, without mishearings of known names", async () => {
    // "APAM" sounds like APIM, a word of the project's name: a mishearing, not a word.
    expect(await run('vocabulary-harvest-workspace', { workspace_id: WS, capture_id: 'c1' })).toMatchObject({ status: 'ok', added: 2, removed: 0, mishearings: 1 })
    expect(db.tables.vocabulary_term.map((t) => [t.term, t.user_id, t.status, t.source]).sort()).toEqual([
      ['Supabase', null, 'active', 'workspace'],
      ['Tauri', null, 'active', 'workspace'],
    ])
  })
})

describe('vocabulary-harvest-personal', () => {
  it('runs on request, debounced per person', () => {
    expect(hoisted.configs['vocabulary-harvest-personal']).toMatchObject({
      triggers: [{ event: VOCABULARY_HARVEST_EVENT }],
      debounce: { key: 'event.data.harvest_key', period: '2m', timeout: '30m' },
    })
  })

  it("adds the person's own words (their private documents, never their chat messages) as theirs", async () => {
    expect(await run('vocabulary-harvest-personal', { workspace_id: WS, user_id: ME, harvest_key: `${WS}:${ME}` })).toMatchObject({ status: 'ok', added: 1 })
    expect(db.tables.vocabulary_term.map((t) => [t.term, t.user_id]).sort()).toEqual([['Kowalczyk', ME]])
  })

  it('skips someone who is not a member, and an event without a person', async () => {
    expect(await run('vocabulary-harvest-personal', { workspace_id: WS, user_id: OTHER, harvest_key: 'x' })).toEqual({ status: 'skipped', reason: 'not_a_member' })
    expect(await run('vocabulary-harvest-personal', { workspace_id: WS })).toEqual({ status: 'skipped', reason: 'no_person' })
    expect(db.tables.vocabulary_term).toHaveLength(0)
  })
})
