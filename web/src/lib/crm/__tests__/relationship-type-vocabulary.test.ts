/**
 * `contact.relationship_type` has ONE source of truth — the
 * `contact_relationship_type_check` constraint (widened by migration 266) — and
 * four hand-maintained copies of it in the app. They had already drifted before
 * this test existed: `RELATIONSHIP_TYPES` in the AI tools was missing
 * `internal`, so `list_contacts` could never filter for teammates.
 *
 * This reads the migration text and holds every copy against it, so the next
 * value added to the CHECK fails here instead of shipping as a column the API
 * writes and the UI cannot render.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FILTERABLE_FIELDS } from '@/lib/views/types'
import { RELATIONSHIP_TYPE_BY_PURPOSE, relationshipTypeForPurpose } from '@/lib/prospecting/promote'

const MIGRATION = join(
  process.cwd(),
  'supabase/migrations/266_contact_candidate_relationship.sql',
)

/** The value list from the migration's re-added CHECK constraint. */
function checkValues(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8')
  const match = sql.match(/relationship_type IN \(([\s\S]*?)\)\s*\)/)
  if (!match) throw new Error('could not parse the relationship_type CHECK list')
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('migration 266', () => {
  it('adds candidate while keeping every pre-existing value', () => {
    expect(checkValues()).toEqual([
      'contact',
      'lead',
      'customer',
      'partner',
      'vendor',
      'internal',
      'candidate',
    ])
  })

  it('finds the constraint BY DEFINITION, not by a hardcoded name', () => {
    // 033 created the CHECK inline on the column, so Postgres named it — a
    // hardcoded name would silently no-op on a database where it differs.
    const sql = readFileSync(MIGRATION, 'utf8')
    expect(sql).toContain('pg_get_constraintdef')
    expect(sql).toContain("ILIKE '%relationship_type %IN%'")
  })
})

describe('consumers stay in lockstep with the CHECK', () => {
  it('the view property-editor enum offers every value', () => {
    const field = FILTERABLE_FIELDS.contact.find((f) => f.field === 'relationship_type')!
    expect(field.options).toEqual(checkValues())
  })

  it('the list_contacts filter enum offers every value', async () => {
    // contacts.ts keeps RELATIONSHIP_TYPES private; read it through the zod
    // schema the tool actually exposes, which is what a caller is bound by.
    const { createContactTools } = await import('@/lib/ai/tools/contacts')
    const tools = createContactTools('u-1', { from: () => ({}) } as never, 'ws-1')
    const schema = tools.list_contacts.inputSchema as unknown as {
      shape: { relationship_type: { unwrap: () => { options: string[] } } }
    }
    expect(schema.shape.relationship_type.unwrap().options.sort()).toEqual(checkValues().sort())
  })

  it('the CRM detail panel has a human label for every value', async () => {
    // TYPE_CONFIG is module-private; assert against the rendered source so a
    // new value without a label is caught (the select would show a raw value).
    const panel = readFileSync(
      join(process.cwd(), 'src/app/account/(dashboard)/views/contact-detail-panel.tsx'),
      'utf8',
    )
    const block = panel.match(/const TYPE_CONFIG[\s\S]*?\n\}/)![0]
    for (const value of checkValues()) {
      expect(block).toContain(`${value}:`)
    }
  })
})

describe('prospecting purpose → relationship_type', () => {
  it('promotes a talent list to `candidate` now that the value exists', () => {
    expect(RELATIONSHIP_TYPE_BY_PURPOSE.talent).toBe('candidate')
    expect(relationshipTypeForPurpose('talent')).toBe('candidate')
  })

  it('leaves the other purposes alone', () => {
    expect(relationshipTypeForPurpose('buyers')).toBe('lead')
    expect(relationshipTypeForPurpose('investors')).toBe('partner')
    expect(relationshipTypeForPurpose('partners')).toBe('partner')
    expect(relationshipTypeForPurpose('custom')).toBe('contact')
  })

  it('only ever emits values the CHECK accepts', () => {
    const allowed = new Set(checkValues())
    for (const value of Object.values(RELATIONSHIP_TYPE_BY_PURPOSE)) {
      expect(allowed.has(value)).toBe(true)
    }
    // …including the unrecognised-purpose fallback.
    expect(allowed.has(relationshipTypeForPurpose('nonsense'))).toBe(true)
  })
})
