/**
 * The PERSON half of promotion (spec §8) — `createProspectContact`, the
 * purpose-derived `relationship_type`, the path chooser, and the contact blob
 * merge.
 *
 * Everything runs against the recording fake, so the tests assert on the
 * QUERIES as much as the results: the emailless dedup is a QUERY (never a
 * unique index), and the only way to prove it fires — scoped to the workspace,
 * excluding merge tombstones — is to look at what was actually sent.
 *
 * `findOrCreateContact` is mocked. It holds the service client itself and has
 * its own tests; what matters here is that the WITH-EMAIL path calls it rather
 * than growing a second implementation of the secondary-email OR-filter and
 * the tombstone exclusion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, filterArgs, hasWorkspaceFilter, type Captured } from './fake-supabase'

const hoisted = vi.hoisted(() => ({ findOrCreateContact: vi.fn() }))

vi.mock('@/lib/crm/contacts', () => ({ findOrCreateContact: hoisted.findOrCreateContact }))

const {
  RELATIONSHIP_TYPE_BY_PURPOSE,
  createProspectContact,
  mergeProspectingMetadata,
  mergeResearchIntoContact,
  promotePerson,
  relationshipTypeForPurpose,
  splitName,
} = await import('../promote')

const WS = 'ws-1'

beforeEach(() => {
  hoisted.findOrCreateContact.mockReset()
})

// ---------------------------------------------------------------------------
// RELATIONSHIP_TYPE_BY_PURPOSE (decision 2)
// ---------------------------------------------------------------------------

describe('RELATIONSHIP_TYPE_BY_PURPOSE', () => {
  it('maps every list purpose to a relationship_type the CHECK accepts', () => {
    expect(RELATIONSHIP_TYPE_BY_PURPOSE).toEqual({
      buyers: 'lead',
      investors: 'partner',
      partners: 'partner',
      // 'candidate' since migration 266 — a talent list IS a candidate pipeline.
      talent: 'candidate',
      custom: 'contact',
    })
  })

  it('is a subset of contact_relationship_type_check (033, widened by 266)', () => {
    // The DB CHECK. A value outside this list is a 23514 at insert time, and
    // the only place that would surface is production.
    const allowed = new Set([
      'contact', 'lead', 'customer', 'partner', 'vendor', 'internal', 'candidate',
    ])
    for (const value of Object.values(RELATIONSHIP_TYPE_BY_PURPOSE)) {
      expect(allowed.has(value)).toBe(true)
    }
  })

  it('degrades an unrecognised purpose to the neutral contact, never to NULL', () => {
    expect(relationshipTypeForPurpose('buyers')).toBe('lead')
    expect(relationshipTypeForPurpose('nonsense')).toBe('contact')
    expect(relationshipTypeForPurpose(undefined)).toBe('contact')
  })
})

// ---------------------------------------------------------------------------
// splitName
// ---------------------------------------------------------------------------

describe('splitName', () => {
  it('splits on the LAST space so a multi-token surname survives intact', () => {
    expect(splitName('Ada Byron King')).toEqual({ firstName: 'Ada Byron', lastName: 'King' })
    expect(splitName('Sarah van der Berg')).toEqual({
      firstName: 'Sarah van der',
      lastName: 'Berg',
    })
  })

  it('gives a single-token name no last name rather than duplicating it', () => {
    expect(splitName('Cher')).toEqual({ firstName: 'Cher', lastName: null })
    expect(splitName('   ')).toEqual({ firstName: null, lastName: null })
  })
})

// ---------------------------------------------------------------------------
// createProspectContact — the emailless person
// ---------------------------------------------------------------------------

describe('createProspectContact', () => {
  function world(opts: { existing?: unknown; insertError?: { message: string } } = {}) {
    const writes: Captured[] = []
    const fake = makeFakeSupabase((q) => {
      if (q.table !== 'contact') return { data: null }
      if (q.op === 'insert') {
        writes.push(q)
        return opts.insertError
          ? { data: null, error: opts.insertError }
          : { data: { id: 'contact-new' } }
      }
      return { data: opts.existing ?? null }
    })
    return { ...fake, writes }
  }

  const INPUT = {
    workspaceId: WS,
    fullName: 'Devin Marsh',
    linkedinUrl: 'https://www.LinkedIn.com/in/DevinMarsh/',
    jobTitle: 'CEO',
    companyId: 'co-parent',
    relationshipType: 'lead' as const,
    createdByMemberId: 'member-1',
  }

  it('inserts with email NULL, source prospecting, the normalized linkedin_url and the parent company', async () => {
    const { client, writes } = world()
    const out = await createProspectContact(client, INPUT)
    expect(out).toEqual({ ok: true, contactId: 'contact-new', created: true })

    expect(writes).toHaveLength(1)
    expect(writes[0].payload).toEqual({
      workspace_id: WS,
      // Explicitly NULL, not omitted. An invented address here costs a real
      // person a cold email.
      email: null,
      full_name: 'Devin Marsh',
      first_name: 'Devin',
      last_name: 'Marsh',
      job_title: 'CEO',
      // Normalized — scheme, www, casing and the trailing slash are gone, so
      // the dedup query on the SECOND discovery can actually match.
      linkedin_url: 'linkedin.com/in/devinmarsh',
      company_id: 'co-parent',
      source: 'prospecting',
      relationship_type: 'lead',
      // 058: the column default is 'private' and SELECT is gated on
      // `can_view_contact`. Without these two, the row this member just saved
      // is invisible to them — the insert's RETURNING comes back empty and
      // promotion reports `error` on a row that actually exists.
      visibility: 'workspace',
      created_by_member_id: 'member-1',
    })
  })

  it('never inserts a contact without an owner or a visibility (058 would hide it)', async () => {
    const { client, writes } = world()
    await createProspectContact(client, INPUT)
    const payload = writes[0].payload as Record<string, unknown>
    expect(payload.created_by_member_id).toBe('member-1')
    expect(payload.visibility).toBe('workspace')
  })

  it('dedupes a second discovery of the same LinkedIn URL to the existing contact', async () => {
    const { client, queries, writes } = world({ existing: { id: 'contact-1' } })
    const out = await createProspectContact(client, {
      ...INPUT,
      // A different surface form of the SAME profile.
      linkedinUrl: 'linkedin.com/in/devinmarsh?trk=nav',
    })
    expect(out).toEqual({ ok: true, contactId: 'contact-1', created: false })
    // No insert at all — the whole point of the dedup query.
    expect(writes).toHaveLength(0)

    const read = queries.find((q) => q.table === 'contact' && q.op === 'select') as Captured
    expect(hasWorkspaceFilter(read, WS)).toBe(true)
    expect(filterArgs(read, 'eq')).toContainEqual(['linkedin_url', 'linkedin.com/in/devinmarsh'])
    // A merge tombstone must never be resurrected as a "match".
    expect(filterArgs(read, 'is')).toContainEqual(['merged_into_contact_id', null])
  })

  it('matches a contact whose linkedin_url is the RAW form every other writer stores', async () => {
    // `enrichContact` writes Exa's value verbatim (`https://www.linkedin.com/
    // in/<slug>`), so an exact-equality probe against the normalized form
    // misses every already-enriched contact and inserts a duplicate.
    const writes: Captured[] = []
    const probes: Captured[] = []
    const { client } = makeFakeSupabase((q) => {
      if (q.table !== 'contact') return { data: null }
      if (q.op === 'insert') {
        writes.push(q)
        return { data: { id: 'contact-new' } }
      }
      probes.push(q)
      // The exact probe misses; only the slug probe finds the enriched row.
      const isExact = filterArgs(q, 'eq').some(([col]) => col === 'linkedin_url')
      return { data: isExact ? null : { id: 'contact-enriched' } }
    })

    const out = await createProspectContact(client, INPUT)
    expect(out).toEqual({ ok: true, contactId: 'contact-enriched', created: false })
    expect(writes).toHaveLength(0)

    const slugProbe = probes[1]
    expect(hasWorkspaceFilter(slugProbe, WS)).toBe(true)
    expect(filterArgs(slugProbe, 'is')).toContainEqual(['merged_into_contact_id', null])
    // Slug-ANCHORED: an open `%devinmarsh%` would let `/in/devinmarsh` match
    // an unrelated `/in/devinmarsh2`.
    expect(filterArgs(slugProbe, 'ilike')).toContainEqual([
      'linkedin_url',
      '%/in/devinmarsh',
    ])
  })

  it('inserts without a dedup read when there is no LinkedIn URL', async () => {
    const { client, queries } = world()
    const out = await createProspectContact(client, { ...INPUT, linkedinUrl: null })
    expect(out).toMatchObject({ ok: true, created: true })
    expect(queries.filter((q) => q.op === 'select')).toHaveLength(0)
  })

  it('refuses a person with neither a LinkedIn URL nor a name — nothing to dedupe on', async () => {
    const { client, queries } = world()
    const out = await createProspectContact(client, { ...INPUT, fullName: '  ', linkedinUrl: null })
    expect(out).toEqual({ ok: false, reason: 'no_identity' })
    expect(queries).toHaveLength(0)
  })

  it('reports an insert failure rather than claiming a contact id', async () => {
    const { client } = world({ insertError: { message: '23514 relationship_type' } })
    const out = await createProspectContact(client, INPUT)
    expect(out).toMatchObject({ ok: false, reason: 'error' })
  })
})

// ---------------------------------------------------------------------------
// promotePerson — the path chooser
// ---------------------------------------------------------------------------

describe('promotePerson', () => {
  function world(
    opts: {
      /** The pre-create existence probe AND the post-create stamp read. */
      existingContact?: unknown
      stampRow?: unknown
    } = {},
  ) {
    const writes: Captured[] = []
    let selects = 0
    const fake = makeFakeSupabase((q) => {
      if (q.table !== 'contact') return { data: null }
      if (q.op === 'insert') {
        writes.push(q)
        return { data: { id: 'contact-new' } }
      }
      if (q.op === 'update') {
        writes.push(q)
        return { data: null }
      }
      selects += 1
      // First select is the pre-create probe; the second (if any) is the
      // stamp's read of the freshly created row.
      if (selects === 1) return { data: opts.existingContact ?? null }
      return { data: opts.stampRow ?? { linkedin_url: null, company_id: null } }
    })
    return { ...fake, writes }
  }

  const PERSON = {
    name: 'Ada Lovelace',
    title: 'VP Engineering',
    linkedin_url: 'https://linkedin.com/in/adalovelace',
    domain: 'acme.test',
    company_name: 'Acme',
  }

  it('routes a person WITH an email through findOrCreateContact, with source prospecting', async () => {
    hoisted.findOrCreateContact.mockResolvedValue({ id: 'contact-9' })
    const { client, writes } = world()
    const out = await promotePerson(client, {
      workspaceId: WS,
      candidate: { ...PERSON, email: 'Ada@Acme.test' },
      companyId: 'co-parent',
      purpose: 'buyers',
      createdByMemberId: 'member-1',
    })
    expect(out).toEqual({ ok: true, contactId: 'contact-9', email: 'ada@acme.test' })
    expect(hoisted.findOrCreateContact).toHaveBeenCalledWith(WS, {
      email: 'ada@acme.test',
      fullName: 'Ada Lovelace',
      jobTitle: 'VP Engineering',
      companyName: 'Acme',
      source: 'prospecting',
      // Same 058 reasoning as the emailless path: a row this call creates must
      // be owned by, and visible to, the member who saved it.
      created_by_member_id: 'member-1',
      visibility: 'workspace',
    })
    // The emailless path must not have run.
    expect(writes.filter((w) => w.op === 'insert')).toHaveLength(0)
  })

  it('stamps relationship_type on a contact that call CREATED', async () => {
    hoisted.findOrCreateContact.mockResolvedValue({ id: 'contact-9' })
    const { client, writes } = world({ existingContact: null })
    await promotePerson(client, {
      workspaceId: WS,
      candidate: { ...PERSON, email: 'ada@acme.test' },
      companyId: 'co-parent',
      purpose: 'investors',
    })
    const stamp = writes.find((w) => w.op === 'update') as Captured
    expect(stamp.payload).toEqual({
      relationship_type: 'partner',
      linkedin_url: 'linkedin.com/in/adalovelace',
      company_id: 'co-parent',
    })
    expect(hasWorkspaceFilter(stamp, WS)).toBe(true)
  })

  it('leaves an EXISTING contact’s relationship_type alone', async () => {
    hoisted.findOrCreateContact.mockResolvedValue({ id: 'contact-1' })
    // The probe finds the contact — so `findOrCreateContact` returned an
    // existing row, and nothing about it is ours to rewrite.
    const { client, writes } = world({ existingContact: { id: 'contact-1' } })
    const out = await promotePerson(client, {
      workspaceId: WS,
      candidate: { ...PERSON, email: 'ada@acme.test' },
      companyId: 'co-parent',
      purpose: 'buyers',
    })
    expect(out).toMatchObject({ ok: true, contactId: 'contact-1' })
    expect(writes.filter((w) => w.op === 'update')).toHaveLength(0)
  })

  it('never overwrites a populated linkedin_url or company_id on the stamp', async () => {
    hoisted.findOrCreateContact.mockResolvedValue({ id: 'contact-9' })
    const { client, writes } = world({
      stampRow: { linkedin_url: 'linkedin.com/in/someone-else', company_id: 'co-autolinked' },
    })
    await promotePerson(client, {
      workspaceId: WS,
      candidate: { ...PERSON, email: 'ada@acme.test' },
      companyId: 'co-parent',
      purpose: 'buyers',
    })
    // Only the relationship_type — the autolink trigger's company and an
    // existing profile URL are both stronger signals than the parent entry.
    expect((writes.find((w) => w.op === 'update') as Captured).payload).toEqual({
      relationship_type: 'lead',
    })
  })

  it('routes a person WITHOUT an email through createProspectContact', async () => {
    const { client, writes } = world()
    const out = await promotePerson(client, {
      workspaceId: WS,
      candidate: { ...PERSON, email: null },
      companyId: 'co-parent',
      purpose: 'talent',
    })
    expect(out).toEqual({ ok: true, contactId: 'contact-new', email: null })
    expect(hoisted.findOrCreateContact).not.toHaveBeenCalled()
    expect((writes.find((w) => w.op === 'insert') as Captured).payload).toMatchObject({
      email: null,
      source: 'prospecting',
      // purpose 'talent' → 'candidate' since migration 266.
      relationship_type: 'candidate',
      company_id: 'co-parent',
    })
  })

  it('treats a display label with no @ as emailless rather than storing it', async () => {
    // "Sarah Hale (ext)" is exactly what findOrCreateContact's guard exists to
    // refuse. Promotion must not hand it over in the first place.
    const { client, writes } = world()
    const out = await promotePerson(client, {
      workspaceId: WS,
      candidate: { ...PERSON, email: 'Sarah Hale (ext)' },
      companyId: null,
      purpose: 'buyers',
    })
    expect(out).toMatchObject({ ok: true, email: null })
    expect(hoisted.findOrCreateContact).not.toHaveBeenCalled()
    expect((writes.find((w) => w.op === 'insert') as Captured).payload).toMatchObject({
      email: null,
    })
  })

  it("reports findOrCreateContact's noise-filter refusal as no_identity", async () => {
    hoisted.findOrCreateContact.mockResolvedValue(null)
    const { client } = world()
    const out = await promotePerson(client, {
      workspaceId: WS,
      candidate: { ...PERSON, email: 'noreply@acme.test' },
      companyId: 'co-parent',
      purpose: 'buyers',
    })
    expect(out).toEqual({ ok: false, reason: 'no_identity' })
  })

  it('never lets a candidate email reach PostgREST filter grammar unescaped', async () => {
    // The candidate blob is untrusted model output, and `.or()` takes FILTER
    // SYNTAX, not a bound parameter: `,` and `)` are its delimiters. An
    // injected clause would widen the existence probe to an unrelated row and
    // make promotion report "already existed", skipping the stamp on a
    // genuinely new contact.
    hoisted.findOrCreateContact.mockResolvedValue({ id: 'contact-9' })
    const { client, queries, writes } = world()
    await promotePerson(client, {
      workspaceId: WS,
      candidate: { ...PERSON, email: 'a@b.com,id.gt.0' },
      companyId: 'co-parent',
      purpose: 'buyers',
      createdByMemberId: 'member-1',
    })
    const orArgs = queries.flatMap((q) => filterArgs(q, 'or')).flat()
    expect(orArgs.some((a) => String(a).includes('id.gt.0'))).toBe(false)
    // And it degrades the SAFE way: assume the contact existed, so a real
    // person's relationship_type is never rewritten on a guess.
    expect(writes.filter((w) => w.op === 'update')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// mergeResearchIntoContact — the same discipline as the company path
// ---------------------------------------------------------------------------

describe('mergeResearchIntoContact', () => {
  function world(contact: Record<string, unknown>) {
    const writes: Captured[] = []
    const fake = makeFakeSupabase((q) => {
      if (q.table !== 'contact') return { data: null }
      if (q.op === 'update') {
        writes.push(q)
        return { data: null }
      }
      return { data: contact }
    })
    return { ...fake, writes }
  }

  const ARGS = { workspaceId: WS, contactId: 'contact-1', listId: 'list-1', entryId: 'e1' }

  it('fills EMPTY columns at high/medium and never overwrites a populated one', async () => {
    const { client, writes } = world({
      id: 'contact-1',
      job_title: 'Head of Sales', // already populated — untouchable
      department: null,
      linkedin_url: null,
      metadata: null,
    })
    const ok = await mergeResearchIntoContact(client, {
      ...ARGS,
      research: {
        job_title: { value: 'VP Sales', confidence: 'high' },
        department: { value: 'Revenue', confidence: 'medium' },
        // 'low' is exactly what the identity gate demotes a namesake's field
        // to. It reaches the BLOB but must never reach a column.
        linkedin_url: { value: 'linkedin.com/in/someone', confidence: 'low' },
      },
      sources: [],
    })
    expect(ok).toBe(true)
    const payload = writes[0].payload as Record<string, unknown>
    expect(payload.department).toBe('Revenue')
    expect(payload).not.toHaveProperty('job_title')
    expect(payload).not.toHaveProperty('linkedin_url')
  })

  it('merges research ADDITIVELY into metadata.enrichment and stamps prospecting', async () => {
    const { client, writes } = world({
      id: 'contact-1',
      job_title: null,
      department: null,
      linkedin_url: null,
      metadata: {
        // Two sibling keys that must survive — mig 232 writes the first and
        // hubspot-push-contact the second.
        company_autolinked: true,
        enrichment: {
          fields: {
            // A CRM-verified fact. mergeBlobFields is confidence-ranked, so a
            // lower-confidence prospecting guess cannot displace it.
            job_title: { value: 'Head of Sales', confidence: 'high' },
            bio: { value: 'Existing bio', confidence: 'medium' },
          },
        },
      },
    })
    const ok = await mergeResearchIntoContact(client, {
      ...ARGS,
      research: {
        job_title: { value: 'Intern', confidence: 'low' },
        department: { value: 'Revenue', confidence: 'high' },
      },
      sources: [{ url: 'https://acme.test/team' }],
    })
    expect(ok).toBe(true)

    const metadata = (writes[0].payload as Record<string, unknown>).metadata as Record<string, unknown>
    expect(metadata.company_autolinked).toBe(true)
    const fields = (metadata.enrichment as Record<string, unknown>).fields as Record<
      string,
      Record<string, unknown>
    >
    // Kept: the high-confidence CRM fact wins over the low-confidence guess.
    expect(fields.job_title).toMatchObject({ value: 'Head of Sales' })
    // Untouched sibling field.
    expect(fields.bio).toMatchObject({ value: 'Existing bio' })
    // Added.
    expect(fields.department).toMatchObject({ value: 'Revenue', confidence: 'high' })

    const stamp = metadata.prospecting as Record<string, unknown>
    expect(stamp).toMatchObject({ list_id: 'list-1', entry_id: 'e1' })
    expect(typeof stamp.first_seen_at).toBe('string')
  })

  it('leaves an existing prospecting stamp alone — first_seen_at means the first time', async () => {
    const { client, writes } = world({
      id: 'contact-1',
      job_title: null,
      department: null,
      linkedin_url: null,
      metadata: { prospecting: { list_id: 'older', entry_id: 'e0', first_seen_at: 'then' } },
    })
    await mergeResearchIntoContact(client, { ...ARGS, research: {}, sources: [] })
    const metadata = (writes[0].payload as Record<string, unknown>).metadata as Record<string, unknown>
    expect(metadata.prospecting).toEqual({ list_id: 'older', entry_id: 'e0', first_seen_at: 'then' })
  })

  it('succeeds with no research at all — the stamp is worth writing on its own', async () => {
    const { client, writes } = world({
      id: 'contact-1',
      job_title: null,
      department: null,
      linkedin_url: null,
      metadata: null,
    })
    expect(
      await mergeResearchIntoContact(client, { ...ARGS, research: null, sources: null }),
    ).toBe(true)
    const metadata = (writes[0].payload as Record<string, unknown>).metadata as Record<string, unknown>
    expect(metadata.prospecting).toMatchObject({ list_id: 'list-1', entry_id: 'e1' })
    // No blob was written, because there was nothing to write.
    expect(metadata.enrichment).toBeUndefined()
  })

  it('scopes both the read and the write to the workspace', async () => {
    const { client, queries } = world({
      id: 'contact-1',
      job_title: null,
      department: null,
      linkedin_url: null,
      metadata: null,
    })
    await mergeResearchIntoContact(client, { ...ARGS, research: {}, sources: [] })
    for (const q of queries.filter((q) => q.table === 'contact')) {
      expect(hasWorkspaceFilter(q, WS)).toBe(true)
    }
  })

  it('reports a load failure rather than claiming the merge happened', async () => {
    const fake = makeFakeSupabase(() => ({ data: null }))
    expect(
      await mergeResearchIntoContact(fake.client, { ...ARGS, research: {}, sources: [] }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// mergeProspectingMetadata — shared by both promotion paths
// ---------------------------------------------------------------------------

describe('mergeProspectingMetadata', () => {
  it('dedupes sources by URL, this run first, capped at 40', () => {
    const out = mergeProspectingMetadata({
      existing: { enrichment: { sources: [{ url: 'https://old.test' }, { url: 'https://dup.test' }] } },
      research: { name: { value: 'Acme', confidence: 'high' } },
      sources: [{ url: 'https://new.test' }, { url: 'https://dup.test' }],
      stamp: { list_id: 'list-1' },
      now: 'NOW',
    })
    expect((out.enrichment as Record<string, unknown>).sources).toEqual([
      { url: 'https://new.test' },
      { url: 'https://dup.test' },
      { url: 'https://old.test' },
    ])
  })

  it('tolerates a non-object metadata value without losing the stamp', () => {
    const out = mergeProspectingMetadata({
      existing: 'not an object',
      research: {},
      sources: null,
      stamp: { list_id: 'list-1' },
      now: 'NOW',
    })
    expect(out.prospecting).toEqual({ list_id: 'list-1', first_seen_at: 'NOW' })
  })
})
