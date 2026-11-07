/**
 * Apply-engine handlers for the four combos that reached prod with NO handler,
 * so their one-click Accept could only ever fail "Unsupported change: …":
 *
 *   update:decision  — target-less "updates" that confirm/refine an earlier
 *                      decision → normalized to create:decision.
 *   create:contact   — a new CRM contact, dedup-guarded (email, then unique name).
 *   update:contact   — enrichment folded into the contact's notes; entity_id or a
 *                      unique-name resolution, else CONTACT_TARGET_UNRESOLVED.
 *   delete:milestone — conservative: entity_id or an exact unique title, else
 *                      MILESTONE_TARGET_UNRESOLVED. Never fuzzy-deletes.
 *
 * Each handler is exercised for the happy path, workspace-fence rejection, and
 * its no-target path (normalization / unresolved code / unique-name success).
 * Names are invented, not real people.
 */
import { describe, it, expect, vi } from 'vitest'
import { applyChange } from '../apply-engine'
import type { ProposedChange } from '../types'

// emitDecisionClaim is fire-and-forget inside createDecision/updateDecision.
// Stub the embeddings import it lazy-loads so the test never touches the network.
vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => [0, 0, 0]) }))

type Call = { table: string; op: string; payload?: unknown; eqs: Record<string, unknown> }

interface StubConfig {
  /** Rows the `contact` list/select query returns (name-resolution + fences). */
  contacts?: Array<Record<string, unknown>>
  /** Rows the `milestone` list query returns (title-resolution). */
  milestones?: Array<Record<string, unknown>>
  /** The single decision row a fenced update reads (with its capture join). */
  decision?: Record<string, unknown> | null
  /** The single milestone row a fenced delete reads (with its project join). */
  milestoneById?: Record<string, unknown> | null
}

/**
 * Chainable Supabase stub. Reads resolve from the configured rows; every mutation
 * is recorded with its payload + eq filters. Terminal shapes covered: `.single()`
 * (inserts return a fixed id), `.maybeSingle()` (fenced single-row reads), and
 * awaiting the builder directly (list selects + fire-and-forget writes).
 */
function makeStub(cfg: StubConfig = {}) {
  const calls: Call[] = []

  function builder(table: string, op: string, payload?: unknown) {
    const eqs: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {}
    const record = () => calls.push({ table, op, payload, eqs })
    chain.eq = (col: string, val: unknown) => {
      eqs[col] = val
      return chain
    }
    chain.is = () => chain
    chain.or = () => chain
    chain.order = () => chain
    chain.limit = () => chain
    chain.range = () => chain
    chain.select = () => chain
    chain.single = async () => {
      if (op === 'insert') {
        record()
        const id = table === 'contact' ? 'new-contact-1' : `new-${table}-1`
        return { data: { id }, error: null }
      }
      return { data: null, error: null }
    }
    chain.maybeSingle = async () => {
      if (op === 'select' && table === 'decision') {
        return { data: cfg.decision ?? null, error: null }
      }
      if (op === 'select' && table === 'milestone') {
        return { data: cfg.milestoneById ?? null, error: null }
      }
      if (op === 'select' && table === 'contact') {
        // Fences (createContact email lookup, applyContactEnrichment fence).
        // A configured contact whose id matches the filter is returned.
        const row = (cfg.contacts ?? []).find((r) => r.id === eqs.id || r.email === eqs.email)
        return { data: row ?? null, error: null }
      }
      return { data: null, error: null }
    }
    chain.then = (resolve: (v: unknown) => unknown) => {
      record()
      if (op === 'select' && table === 'contact') {
        return resolve({ data: cfg.contacts ?? [], error: null })
      }
      if (op === 'select' && table === 'milestone') {
        return resolve({ data: cfg.milestones ?? [], error: null })
      }
      return resolve({ data: null, error: null })
    }
    return chain
  }

  const supabase = {
    from: (table: string) => ({
      select: (columns?: string) => builder(table, 'select', columns),
      insert: (payload: unknown) => builder(table, 'insert', payload),
      update: (payload: unknown) => builder(table, 'update', payload),
      delete: () => builder(table, 'delete'),
    }),
  }
  return { supabase: supabase as never, calls }
}

function change(overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    id: 'pc-1',
    workspace_id: 'ws-1',
    capture_id: 'cap-1',
    change_type: 'create',
    entity_type: 'action',
    entity_id: null,
    display_text: '',
    title: null,
    description: null,
    priority: null,
    due_date: null,
    status_from: null,
    status_to: null,
    assignee_name: null,
    assignee_member_id: null,
    assignee_contact_id: null,
    team_id: null,
    project_id: null,
    labels: null,
    email_to_name: null,
    email_to_address: null,
    email_subject: null,
    email_context: null,
    extra: null,
    anchor_text: null,
    sort_order: 0,
    confidence: 0.9,
    trigger_quote: null,
    reasoning: null,
    stakes: null,
    open_questions: null,
    status: 'pending',
    applied_at: null,
    applied_by: null,
    result_entity_id: null,
    error_message: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  } as ProposedChange
}

// ─── update:decision ─────────────────────────────────────────────────────────

describe('update:decision', () => {
  it('normalizes a target-less update to create:decision and reports it', async () => {
    const { supabase, calls } = makeStub()
    const res = await applyChange(
      supabase,
      change({
        change_type: 'update',
        entity_type: 'decision',
        entity_id: null,
        display_text: 'Confirmed: the pilot will NOT track runner status',
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(res.entity_id).toBe('new-decision-1')
    // The lifecycle normalization is reported so the caller persists change_type.
    expect(res.applied_change_type).toBe('create')
    const ins = calls.find((c) => c.table === 'decision' && c.op === 'insert')
    expect(ins).toBeTruthy()
    expect(ins!.payload).toMatchObject({
      capture_id: 'cap-1',
      content: 'Confirmed: the pilot will NOT track runner status',
      confirmation: 'confirmed',
    })
  })

  it('updates the decision row when a real entity_id targets an in-workspace decision', async () => {
    const { supabase, calls } = makeStub({
      decision: { id: 'dec-9', capture_id: 'cap-1', capture: { workspace_id: 'ws-1' } },
    })
    const res = await applyChange(
      supabase,
      change({
        change_type: 'update',
        entity_type: 'decision',
        entity_id: 'dec-9',
        title: 'Refine the whitelist-attribute decision to include region',
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(res.entity_id).toBe('dec-9')
    // A targeted update is NOT normalized — it stays change_type 'update'.
    expect(res.applied_change_type).toBeUndefined()
    const upd = calls.find((c) => c.table === 'decision' && c.op === 'update')
    expect(upd!.eqs).toMatchObject({ id: 'dec-9' })
    expect(upd!.payload).toMatchObject({
      content: 'Refine the whitelist-attribute decision to include region',
      confirmation: 'confirmed',
    })
  })

  it('rejects an update whose decision belongs to another workspace', async () => {
    const { supabase, calls } = makeStub({
      decision: { id: 'dec-x', capture_id: 'cap-other', capture: { workspace_id: 'ws-OTHER' } },
    })
    const res = await applyChange(
      supabase,
      change({ change_type: 'update', entity_type: 'decision', entity_id: 'dec-x', title: 'x' }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found in this workspace/i)
    expect(calls.find((c) => c.table === 'decision' && c.op === 'update')).toBeUndefined()
  })
})

// ─── create:contact ──────────────────────────────────────────────────────────

// contact.source CHECK constraint's allowed values, verbatim from migration 091
// (which extended migration 033's set with 'member'). Hardcoded here so an
// out-of-set source value fails CI instead of failing the INSERT in prod — the
// exact dead-end-Accept class this PR exists to fix.
const CONTACT_SOURCE_ALLOWED = [
  'manual',
  'email_sync',
  'calendar_sync',
  'capture_participant',
  'csv_import',
  'member',
]

describe('create:contact', () => {
  it('inserts a new contact with the proposal note when nothing matches', async () => {
    const { supabase, calls } = makeStub({ contacts: [] })
    const res = await applyChange(
      supabase,
      change({
        change_type: 'create',
        entity_type: 'contact',
        title: 'Jordan Vale',
        description: 'Add Jordan (Okta) as a contact — met at the security review',
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(res.entity_id).toBe('new-contact-1')
    const ins = calls.find((c) => c.table === 'contact' && c.op === 'insert')
    expect(ins!.payload).toMatchObject({
      workspace_id: 'ws-1',
      full_name: 'Jordan Vale',
      first_name: 'Jordan',
      last_name: 'Vale',
      notes: 'Add Jordan (Okta) as a contact — met at the security review',
      relationship_type: 'contact',
    })
    // The inserted source must satisfy the DB CHECK constraint, or every
    // genuinely-new-contact accept 500s at the INSERT.
    const source = (ins!.payload as Record<string, unknown>).source
    expect(CONTACT_SOURCE_ALLOWED).toContain(source)
  })

  it('merges into an existing contact on a unique name match instead of duplicating', async () => {
    const { supabase, calls } = makeStub({
      contacts: [{ id: 'con-7', full_name: 'Alexa Kade' }],
    })
    const res = await applyChange(
      supabase,
      change({
        change_type: 'create',
        entity_type: 'contact',
        title: 'Alexa Kade',
        description: 'Alexa Kade — warm lead, wants a follow-up next quarter',
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(res.entity_id).toBe('con-7')
    // No duplicate insert — the enrichment note is folded onto the existing row.
    expect(calls.find((c) => c.table === 'contact' && c.op === 'insert')).toBeUndefined()
    const upd = calls.find((c) => c.table === 'contact' && c.op === 'update')
    expect(upd!.eqs).toMatchObject({ id: 'con-7', workspace_id: 'ws-1' })
    expect(upd!.payload).toMatchObject({
      notes: 'Alexa Kade — warm lead, wants a follow-up next quarter',
    })
  })

  it('merges by exact email even when the name differs', async () => {
    const { supabase, calls } = makeStub({
      contacts: [{ id: 'con-e', full_name: 'A. Kade', email: 'alexa@example.com' }],
    })
    const res = await applyChange(
      supabase,
      change({
        change_type: 'create',
        entity_type: 'contact',
        title: 'Alexa Kade',
        description: 'note',
        extra: { email: 'Alexa@example.com' },
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(res.entity_id).toBe('con-e')
    expect(calls.find((c) => c.table === 'contact' && c.op === 'insert')).toBeUndefined()
  })
})

// ─── update:contact ──────────────────────────────────────────────────────────

describe('update:contact', () => {
  it('folds the note onto a directly-targeted contact (fenced)', async () => {
    const { supabase, calls } = makeStub({
      contacts: [{ id: 'con-3', notes: 'prior note' }],
    })
    const res = await applyChange(
      supabase,
      change({
        change_type: 'update',
        entity_type: 'contact',
        entity_id: 'con-3',
        description: 'now evaluating the enterprise tier',
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(res.entity_id).toBe('con-3')
    const upd = calls.find((c) => c.table === 'contact' && c.op === 'update')
    expect(upd!.eqs).toMatchObject({ id: 'con-3', workspace_id: 'ws-1' })
    // Appends, doesn't clobber the prior context.
    expect(upd!.payload).toMatchObject({ notes: 'prior note\nnow evaluating the enterprise tier' })
  })

  it('resolves a target-less update by unique contact name', async () => {
    const { supabase, calls } = makeStub({
      contacts: [{ id: 'con-4', full_name: 'Priya Nandin', notes: null }],
    })
    const res = await applyChange(
      supabase,
      change({
        change_type: 'update',
        entity_type: 'contact',
        entity_id: null,
        title: 'Priya Nandin',
        description: 'promoted to VP Eng',
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(res.entity_id).toBe('con-4')
    // Resolution is persisted back onto the proposal row.
    const persisted = calls.find((c) => c.table === 'proposed_change' && c.op === 'update')
    expect(persisted!.payload).toMatchObject({ entity_id: 'con-4' })
    const upd = calls.find((c) => c.table === 'contact' && c.op === 'update')
    expect(upd!.payload).toMatchObject({ notes: 'promoted to VP Eng' })
  })

  it('returns CONTACT_TARGET_UNRESOLVED when no contact matches the name', async () => {
    const { supabase, calls } = makeStub({ contacts: [] })
    const res = await applyChange(
      supabase,
      change({
        change_type: 'update',
        entity_type: 'contact',
        entity_id: null,
        title: 'Nobody Here',
        description: 'x',
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(false)
    expect(res.code).toBe('CONTACT_TARGET_UNRESOLVED')
    expect(res.error).toMatch(/unique contact named "Nobody Here"/i)
    expect(calls.find((c) => c.table === 'contact' && c.op === 'update')).toBeUndefined()
  })

  it('refuses to guess between two contacts sharing a first name (ambiguous → unresolved)', async () => {
    const { supabase } = makeStub({
      contacts: [
        { id: 'c-a', full_name: 'Sam Rivera' },
        { id: 'c-b', full_name: 'Sam Delgado' },
      ],
    })
    const res = await applyChange(
      supabase,
      change({
        change_type: 'update',
        entity_type: 'contact',
        entity_id: null,
        title: 'Sam',
        description: 'x',
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(false)
    expect(res.code).toBe('CONTACT_TARGET_UNRESOLVED')
  })

  it('rejects a directly-targeted update to a contact in another workspace', async () => {
    // The fence read returns no row for this workspace.
    const { supabase, calls } = makeStub({ contacts: [] })
    const res = await applyChange(
      supabase,
      change({
        change_type: 'update',
        entity_type: 'contact',
        entity_id: 'con-other',
        description: 'x',
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found in this workspace/i)
    expect(calls.find((c) => c.table === 'contact' && c.op === 'update')).toBeUndefined()
  })
})

// ─── delete:milestone ────────────────────────────────────────────────────────

describe('delete:milestone', () => {
  it('deletes a directly-targeted milestone in this workspace', async () => {
    const { supabase, calls } = makeStub({
      milestoneById: { id: 'ms-1', project: { workspace_id: 'ws-1' } },
    })
    const res = await applyChange(
      supabase,
      change({ change_type: 'delete', entity_type: 'milestone', entity_id: 'ms-1' }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(res.entity_id).toBe('ms-1')
    const del = calls.find((c) => c.table === 'milestone' && c.op === 'delete')
    expect(del!.eqs).toMatchObject({ id: 'ms-1' })
  })

  it('rejects a directly-targeted milestone in another workspace', async () => {
    const { supabase, calls } = makeStub({
      milestoneById: { id: 'ms-x', project: { workspace_id: 'ws-OTHER' } },
    })
    const res = await applyChange(
      supabase,
      change({ change_type: 'delete', entity_type: 'milestone', entity_id: 'ms-x' }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found in this workspace/i)
    expect(calls.find((c) => c.table === 'milestone' && c.op === 'delete')).toBeUndefined()
  })

  it('deletes by exact unique title when no entity_id is given', async () => {
    const { supabase, calls } = makeStub({
      milestones: [
        { id: 'ms-a', name: 'Save Drafts', project: { workspace_id: 'ws-1' } },
        { id: 'ms-b', name: 'Ship Billing', project: { workspace_id: 'ws-1' } },
      ],
    })
    const res = await applyChange(
      supabase,
      change({
        change_type: 'delete',
        entity_type: 'milestone',
        entity_id: null,
        title: 'save drafts', // case-insensitive
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(res.entity_id).toBe('ms-a')
    const del = calls.find((c) => c.table === 'milestone' && c.op === 'delete')
    expect(del!.eqs).toMatchObject({ id: 'ms-a' })
  })

  it('returns MILESTONE_TARGET_UNRESOLVED when no title matches (never fuzzy-deletes)', async () => {
    const { supabase, calls } = makeStub({
      milestones: [{ id: 'ms-a', name: 'Save Drafts', project: { workspace_id: 'ws-1' } }],
    })
    const res = await applyChange(
      supabase,
      change({
        change_type: 'delete',
        entity_type: 'milestone',
        entity_id: null,
        title: 'Save Draft', // near but not exact
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(false)
    expect(res.code).toBe('MILESTONE_TARGET_UNRESOLVED')
    expect(calls.find((c) => c.table === 'milestone' && c.op === 'delete')).toBeUndefined()
  })

  it('refuses to delete when two milestones share the exact title', async () => {
    const { supabase, calls } = makeStub({
      milestones: [
        { id: 'ms-a', name: 'Save Drafts', project: { workspace_id: 'ws-1' } },
        { id: 'ms-b', name: 'Save Drafts', project: { workspace_id: 'ws-1' } },
      ],
    })
    const res = await applyChange(
      supabase,
      change({ change_type: 'delete', entity_type: 'milestone', entity_id: null, title: 'Save Drafts' }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(false)
    expect(res.code).toBe('MILESTONE_TARGET_UNRESOLVED')
    expect(res.error).toMatch(/more than one/i)
    expect(calls.find((c) => c.table === 'milestone' && c.op === 'delete')).toBeUndefined()
  })

  it('excludes a same-titled milestone in another workspace from the match', async () => {
    const { supabase, calls } = makeStub({
      milestones: [
        { id: 'ms-mine', name: 'Save Drafts', project: { workspace_id: 'ws-1' } },
        { id: 'ms-theirs', name: 'Save Drafts', project: { workspace_id: 'ws-OTHER' } },
      ],
    })
    const res = await applyChange(
      supabase,
      change({ change_type: 'delete', entity_type: 'milestone', entity_id: null, title: 'Save Drafts' }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    // The other workspace's milestone is filtered out, so the match is unique.
    expect(res.success).toBe(true)
    expect(res.entity_id).toBe('ms-mine')
    // ...and the title read is fenced to the workspace in SQL, not just in JS
    // (an unfenced read sees only the platform's first 1000 milestones).
    const read = calls.find((c) => c.table === 'milestone' && c.op === 'select')
    expect(read?.eqs['project.workspace_id']).toBe('ws-1')
  })
})
