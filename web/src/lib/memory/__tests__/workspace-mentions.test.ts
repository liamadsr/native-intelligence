/**
 * The workspace walls (A2 review): a name matches only as whole words, so
 * "Mark" never walls "market" and a project called "Email" never walls "keep
 * my emails short"; a one-word contact name needs 5+ characters; a company
 * named in the text walls it. The fake (fake-memory-db.ts) does in JS what
 * migration 328's workspace_entity_mentioned does in SQL; the SQL itself is
 * pinned by migration-328.test.ts.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeMemoryDb } from './fake-memory-db'
import { mentionsWorkspaceEntities } from '../workspace-mentions'

const W = 'ws-1'

function setup() {
  const db = makeFakeMemoryDb()
  db.seed('contact', [
    { id: 'c1', workspace_id: W, full_name: 'Mark', merged_into_contact_id: null },
    { id: 'c2', workspace_id: W, full_name: 'Dana Scully', merged_into_contact_id: null },
    { id: 'c3', workspace_id: W, full_name: 'Merged Person', merged_into_contact_id: 'c2' },
  ])
  db.seed('company', [{ id: 'co1', workspace_id: W, name: 'Acme Corp' }])
  db.seed('projects', [{ id: 'p1', workspace_id: W, name: 'Email' }])
  return db as unknown as SupabaseClient
}

describe('mentionsWorkspaceEntities', () => {
  it('matches whole words only: no wall for "keep my emails short" or a "market" update', async () => {
    const sb = setup()
    expect(await mentionsWorkspaceEntities(sb, 'Keep my emails short', W)).toBeNull()
    expect(await mentionsWorkspaceEntities(sb, 'Sends a weekly market update', W)).toBeNull()
  })

  it('walls a company, a full contact name and a project named as words', async () => {
    const sb = setup()
    expect(await mentionsWorkspaceEntities(sb, 'Acme Corp prefers weekly calls', W)).toBe('Acme Corp')
    expect(await mentionsWorkspaceEntities(sb, 'Copy dana scully on renewals', W)).toBe('Dana Scully')
    expect(await mentionsWorkspaceEntities(sb, 'Triage the Email project first', W)).toBe('Email')
  })

  it('skips a one-word contact name under 5 characters, and merged contacts', async () => {
    const sb = setup()
    expect(await mentionsWorkspaceEntities(sb, 'Mark likes short notes', W)).toBeNull()
    expect(await mentionsWorkspaceEntities(sb, 'merged person says hi', W)).toBeNull()
  })
})
