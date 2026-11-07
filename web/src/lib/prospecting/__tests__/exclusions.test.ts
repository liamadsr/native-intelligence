/**
 * The exclusion engine — §15 calls these "the highest-value tests in the
 * feature", and the reason is that every failure mode here is SILENT. A rule
 * that quietly stops firing does not throw; it produces a run that re-surfaces
 * 40 accounts the user already owns, or worse, re-surfaces someone who opted
 * out. So these tests assert on the QUERIES as much as on the results: the
 * recording fake proves every read carried an explicit `workspace_id` filter,
 * because this module runs under the service-role client in the Inngest lane
 * where RLS is not a boundary at all.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase, hasWorkspaceFilter, type Captured, type FakeResult } from './fake-supabase'
import {
  admitCandidates,
  buildExclusionSet,
  companyAdmission,
  emptyRunCounts,
  exclusionSnapshot,
  isNoiseHost,
  suppressedDomainHints,
  type ExclusionSet,
} from '../exclusions'
import { PROSPECT_SUPPRESSION_SOURCES } from '../types'

const WS = 'ws-1'
const LIST = 'list-1'

/** Everything the seven sources read, defaulted to empty. A test names only
 *  the table it cares about, so a rule firing off the wrong table shows up as
 *  a failure rather than as an accidental pass. */
interface World {
  lists?: Array<{ id: string; status?: string }>
  entries?: Array<{
    id: string
    list_id: string
    candidate_key: string
    stage?: string
    dismissed_reason?: string | null
  }>
  companies?: Array<{ id: string; domain: string | null }>
  contacts?: Array<{
    id: string
    email?: string | null
    secondary_emails?: string[] | null
    linkedin_url?: string | null
    company?: { domain: string | null } | null
  }>
  enrollments?: Array<{
    id: string
    contact_id?: string | null
    contact_email?: string | null
    status?: string
  }>
  suppressions?: Array<{ id: string; email: string }>
}

function world(w: World) {
  return makeFakeSupabase((q: Captured): FakeResult => {
    switch (q.table) {
      case 'prospect_list':
        return { data: (w.lists ?? [{ id: LIST, status: 'active' }]).filter((l) => (l.status ?? 'active') === 'active') }
      case 'prospect_list_entry':
        return {
          data: (w.entries ?? []).map((e) => ({
            stage: 'discovered',
            dismissed_reason: null,
            ...e,
          })),
        }
      case 'company':
        return { data: (w.companies ?? []).filter((c) => c.domain !== null) }
      case 'contact':
        return { data: w.contacts ?? [] }
      case 'sequence_enrollment':
        return {
          data: (w.enrollments ?? []).map((e) => ({
            contact_id: null,
            contact_email: null,
            status: 'active',
            ...e,
          })),
        }
      case 'outreach_suppression':
        return { data: w.suppressions ?? [] }
      default:
        throw new Error(`unexpected table ${q.table}`)
    }
  })
}

const OPTIONS = {
  all_off: { exclude_crm: false, exclude_other_lists: false, exclude_contacted: 'off' as const },
  crm_on: { exclude_crm: true, exclude_other_lists: false, exclude_contacted: 'off' as const },
}

async function build(w: World, args: Parameters<typeof buildExclusionSet>[1]) {
  const { client, queries } = world(w)
  const set = await buildExclusionSet(client, args)
  return { set, queries }
}

// ---------------------------------------------------------------------------
// Workspace scoping — the invariant behind every other test here
// ---------------------------------------------------------------------------

describe('workspace scoping', () => {
  it('carries an explicit workspace_id filter on every read', async () => {
    const { queries } = await build(
      {
        entries: [{ id: 'e1', list_id: LIST, candidate_key: 'a.com' }],
        contacts: [{ id: 'c1', email: 'x@a.com' }],
        enrollments: [{ id: 'en1', contact_id: 'c1', contact_email: 'x@a.com' }],
      },
      {
        workspaceId: WS,
        listId: LIST,
        options: { exclude_crm: true, exclude_other_lists: true, exclude_contacted: 'ever' },
      },
    )

    // Every source fired, and every one of them was scoped.
    const tables = queries.map((q) => q.table)
    expect(new Set(tables)).toEqual(
      new Set([
        'prospect_list',
        'prospect_list_entry',
        'company',
        'contact',
        'sequence_enrollment',
        'outreach_suppression',
      ]),
    )
    for (const q of queries) {
      expect(hasWorkspaceFilter(q, WS), `${q.table} missing workspace filter`).toBe(true)
    }
  })

  it('throws rather than returning a partial set when a read fails', async () => {
    // A half-built set is worse than no run: it looks like a successful search
    // that happened to re-discover everything the user already owns.
    const { client } = makeFakeSupabase((q) =>
      q.table === 'company'
        ? { error: { message: 'boom' } }
        : { data: q.table === 'prospect_list' ? [{ id: LIST }] : [] },
    )
    // The message names the LABEL of the read that failed, not a fixed
    // sentence about the exclusion set — `readAll` is shared with lists.ts and
    // telemetry.ts, so a hardcoded "failed to build exclusion set" would send
    // the next reader of a list-entries failure to the wrong file.
    await expect(
      buildExclusionSet(client, { workspaceId: WS, listId: LIST, options: OPTIONS.crm_on }),
    ).rejects.toThrow(/crm companies/i)
  })
})

// ---------------------------------------------------------------------------
// Source: this_list
// ---------------------------------------------------------------------------

describe('this_list', () => {
  it('suppresses every entry in this list at ANY stage, dismissal included', async () => {
    const { set } = await build(
      {
        entries: [
          { id: 'e1', list_id: LIST, candidate_key: 'saved.com', stage: 'saved' },
          { id: 'e2', list_id: LIST, candidate_key: 'new.com', stage: 'discovered' },
          {
            id: 'e3',
            list_id: LIST,
            candidate_key: 'nope.com',
            stage: 'dismissed',
            dismissed_reason: 'not_icp',
          },
        ],
      },
      { workspaceId: WS, listId: LIST, options: OPTIONS.all_off },
    )
    expect(set.get('saved.com')).toEqual({ by: 'this_list', ref_id: 'e1' })
    expect(set.get('new.com')).toEqual({ by: 'this_list', ref_id: 'e2' })
    // A dismissal is data, not a deletion. It keeps suppressing forever.
    expect(set.get('nope.com')).toEqual({ by: 'this_list', ref_id: 'e3' })
  })

  it('holds for a person with no email, via the linkedin key', async () => {
    // This is why candidate_key lives on the ENTRY: the email-keyed rules
    // (contacted, opted_out) silently no-op for an emailless person, and
    // UNIQUE (workspace_id, email) treats NULLs as distinct.
    const { set } = await build(
      {
        entries: [
          { id: 'e1', list_id: LIST, candidate_key: 'linkedin.com/in/sarah-hale', stage: 'saved' },
        ],
      },
      { workspaceId: WS, listId: LIST, options: OPTIONS.all_off },
    )
    expect(set.get('linkedin.com/in/sarah-hale')?.by).toBe('this_list')
  })
})

// ---------------------------------------------------------------------------
// Source: crm
// ---------------------------------------------------------------------------

describe('crm', () => {
  it('is off when exclude_crm is off, and on when it is on', async () => {
    const w: World = {
      companies: [{ id: 'co1', domain: 'acme.com' }],
      contacts: [{ id: 'c1', email: 'sarah@acme.com' }],
    }
    const off = await build(w, { workspaceId: WS, listId: LIST, options: OPTIONS.all_off })
    expect(off.set.size).toBe(0)
    expect(off.queries.map((q) => q.table)).not.toContain('company')

    const on = await build(w, { workspaceId: WS, listId: LIST, options: OPTIONS.crm_on })
    expect(on.set.get('acme.com')).toEqual({ by: 'crm', ref_id: 'co1' })
    expect(on.set.get('sarah@acme.com')).toEqual({ by: 'crm', ref_id: 'c1' })
  })

  it('normalizes a CRM domain through the same key builder discovery uses', async () => {
    // The set difference has to be EXACT. A hand-typed "https://Acme.com/"
    // must suppress the discovered "acme.com".
    const { set } = await build(
      { companies: [{ id: 'co1', domain: 'https://WWW.Acme.com/about' }] },
      { workspaceId: WS, listId: LIST, options: OPTIONS.crm_on },
    )
    expect(set.get('acme.com')?.by).toBe('crm')
  })

  it('does NOT re-discover a merged tombstone: the email lives in secondary_emails', async () => {
    // THE test §15 names first. merge_contacts() NULLs the loser's email,
    // folds it into the survivor's secondary_emails and tombstones the loser
    // with merged_into_contact_id. Reading only `email` — which enrollContacts
    // does — makes every merged-away address re-discoverable.
    const { set, queries } = await build(
      {
        contacts: [
          {
            id: 'survivor',
            email: 'sarah@acme.com',
            secondary_emails: ['s.hale@acme.com', 'sarah.hale@acme.com'],
            linkedin_url: 'https://www.linkedin.com/in/sarah-hale/',
          },
        ],
      },
      { workspaceId: WS, listId: LIST, options: OPTIONS.crm_on },
    )
    expect(set.get('sarah@acme.com')?.ref_id).toBe('survivor')
    expect(set.get('s.hale@acme.com')?.ref_id).toBe('survivor')
    expect(set.get('sarah.hale@acme.com')?.ref_id).toBe('survivor')
    // And the emailless identity too, normalized.
    expect(set.get('linkedin.com/in/sarah-hale')?.ref_id).toBe('survivor')

    // The tombstone rows themselves are excluded at the query layer.
    const contactQuery = queries.find((q) => q.table === 'contact')!
    expect(contactQuery.filters).toContainEqual({
      method: 'is',
      args: ['merged_into_contact_id', null],
    })
  })
})

// ---------------------------------------------------------------------------
// Source: other_lists / dismissed_global
// ---------------------------------------------------------------------------

describe('other lists and global dismissals', () => {
  const OTHER = 'list-2'

  it('leaves an unsaved entry in list A discoverable in list B when the toggle is off', async () => {
    // Liam's two-list example. A discovered-but-unacted-on company is not a
    // decision, and list B is allowed to find it.
    const { set } = await build(
      {
        lists: [{ id: LIST }, { id: OTHER }],
        entries: [{ id: 'e1', list_id: OTHER, candidate_key: 'acme.com', stage: 'discovered' }],
      },
      { workspaceId: WS, listId: LIST, options: OPTIONS.all_off },
    )
    expect(set.has('acme.com')).toBe(false)
  })

  it('suppresses it as other_list when the toggle is on', async () => {
    const { set } = await build(
      {
        lists: [{ id: LIST }, { id: OTHER }],
        entries: [{ id: 'e1', list_id: OTHER, candidate_key: 'acme.com', stage: 'discovered' }],
      },
      {
        workspaceId: WS,
        listId: LIST,
        options: { exclude_crm: false, exclude_other_lists: true, exclude_contacted: 'off' },
      },
    )
    expect(set.get('acme.com')).toEqual({ by: 'other_list', ref_id: 'e1' })
  })

  it('ignores ARCHIVED lists for other_list', async () => {
    // An archived list is a decision the user has put away; it must not keep
    // suppressing forever.
    const { set } = await build(
      {
        lists: [{ id: LIST }, { id: OTHER, status: 'archived' }],
        entries: [{ id: 'e1', list_id: OTHER, candidate_key: 'acme.com', stage: 'discovered' }],
      },
      {
        workspaceId: WS,
        listId: LIST,
        options: { exclude_crm: false, exclude_other_lists: true, exclude_contacted: 'off' },
      },
    )
    expect(set.has('acme.com')).toBe(false)
  })

  it('suppresses a competitor dismissed in list A while running list B, toggle or no toggle', async () => {
    // Decision 3: `competitor` / `already_customer` are verdicts about the
    // COMPANY, so they cross every list — including lists that do not exist
    // yet — and they do it with exclude_other_lists OFF.
    const { set } = await build(
      {
        lists: [{ id: LIST }, { id: OTHER }],
        entries: [
          {
            id: 'e1',
            list_id: OTHER,
            candidate_key: 'rival.com',
            stage: 'dismissed',
            dismissed_reason: 'competitor',
          },
          {
            id: 'e2',
            list_id: OTHER,
            candidate_key: 'client.com',
            stage: 'dismissed',
            dismissed_reason: 'already_customer',
          },
          {
            id: 'e3',
            list_id: OTHER,
            candidate_key: 'small.com',
            stage: 'dismissed',
            dismissed_reason: 'too_small',
          },
        ],
      },
      { workspaceId: WS, listId: LIST, options: OPTIONS.all_off },
    )
    expect(set.get('rival.com')).toEqual({ by: 'dismissed_global', ref_id: 'e1' })
    expect(set.get('client.com')).toEqual({ by: 'dismissed_global', ref_id: 'e2' })
    // `too_small` is genuinely list-relative — a company too small for the
    // enterprise list may be exactly right for the SMB list.
    expect(set.has('small.com')).toBe(false)
  })

  it('suppresses a globally-dismissed entry from an ARCHIVED list too', async () => {
    // The verdict outlives the list it was made in. This is the one place
    // archival deliberately does not clear a rule.
    const { set } = await build(
      {
        lists: [{ id: LIST }, { id: OTHER, status: 'archived' }],
        entries: [
          {
            id: 'e1',
            list_id: OTHER,
            candidate_key: 'rival.com',
            stage: 'dismissed',
            dismissed_reason: 'competitor',
          },
        ],
      },
      { workspaceId: WS, listId: LIST, options: OPTIONS.all_off },
    )
    expect(set.get('rival.com')?.by).toBe('dismissed_global')
  })
})

// ---------------------------------------------------------------------------
// Source: contacted — the tri-state
// ---------------------------------------------------------------------------

describe('contacted (tri-state)', () => {
  const ENROLLMENTS: World = {
    enrollments: [
      { id: 'live', contact_id: 'c-live', contact_email: 'Live@acme.com', status: 'active' },
      { id: 'past', contact_id: 'c-past', contact_email: 'past@old.com', status: 'exited' },
    ],
    contacts: [
      { id: 'c-live', company: { domain: 'acme.com' } },
      { id: 'c-past', company: { domain: 'old.com' } },
    ],
  }

  it("'off' reads sequence_enrollment not at all", async () => {
    const { set, queries } = await build(ENROLLMENTS, {
      workspaceId: WS,
      listId: LIST,
      options: OPTIONS.all_off,
    })
    expect(queries.map((q) => q.table)).not.toContain('sequence_enrollment')
    expect(set.size).toBe(0)
  })

  it("'active' hides only current enrollments — the re-engagement segment survives", async () => {
    // enrollContacts' own already_active check is status='active' only.
    // Hardcoding 'ever' here would permanently hide everyone who ever exited.
    const { set } = await build(ENROLLMENTS, {
      workspaceId: WS,
      listId: LIST,
      options: { exclude_crm: false, exclude_other_lists: false, exclude_contacted: 'active' },
    })
    expect(set.get('live@acme.com')?.by).toBe('contacted')
    expect(set.has('past@old.com')).toBe(false)
    expect(set.has('old.com')).toBe(false)
  })

  it("'ever' hides both, and lowercases the enrollment email", async () => {
    const { set } = await build(ENROLLMENTS, {
      workspaceId: WS,
      listId: LIST,
      options: { exclude_crm: false, exclude_other_lists: false, exclude_contacted: 'ever' },
    })
    expect(set.get('live@acme.com')).toEqual({ by: 'contacted', ref_id: 'live' })
    expect(set.get('past@old.com')).toEqual({ by: 'contacted', ref_id: 'past' })
  })

  it('suppresses the ACCOUNT via the enrolled contact’s company', async () => {
    const { set } = await build(ENROLLMENTS, {
      workspaceId: WS,
      listId: LIST,
      options: { exclude_crm: false, exclude_other_lists: false, exclude_contacted: 'ever' },
    })
    expect(set.get('acme.com')).toEqual({ by: 'contacted', ref_id: 'live' })
    expect(set.get('old.com')).toEqual({ by: 'contacted', ref_id: 'past' })
  })

  it('falls back to companyDomainFromEmail when contact_id is NULL', async () => {
    // §6 point 3: sequence_enrollment has no company_id, and the
    // enrollment → contact → company join yields NOTHING for an enrollment
    // created from a bare email. Without the fallback the account-level rule
    // is silently partial.
    const { set, queries } = await build(
      {
        enrollments: [{ id: 'bare', contact_id: null, contact_email: 'someone@bare.com' }],
      },
      {
        workspaceId: WS,
        listId: LIST,
        options: { exclude_crm: false, exclude_other_lists: false, exclude_contacted: 'ever' },
      },
    )
    expect(set.get('someone@bare.com')?.by).toBe('contacted')
    expect(set.get('bare.com')).toEqual({ by: 'contacted', ref_id: 'bare' })
    // No contact ids to resolve, so no contact read at all.
    expect(queries.map((q) => q.table)).not.toContain('contact')
  })

  it('never suppresses a webmail domain as an account', async () => {
    // A gmail.com enrollment must suppress the PERSON, never the "company".
    const { set } = await build(
      {
        enrollments: [{ id: 'g', contact_id: null, contact_email: 'someone@gmail.com' }],
      },
      {
        workspaceId: WS,
        listId: LIST,
        options: { exclude_crm: false, exclude_other_lists: false, exclude_contacted: 'ever' },
      },
    )
    expect(set.get('someone@gmail.com')?.by).toBe('contacted')
    expect(set.has('gmail.com')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Source: opted_out — always on
// ---------------------------------------------------------------------------

describe('opted_out', () => {
  it('suppresses an opted-out email with every toggle off', async () => {
    // The worst failure this feature can have. There is no switch.
    const { set } = await build(
      { suppressions: [{ id: 'sup1', email: 'Gone@acme.com' }] },
      { workspaceId: WS, listId: LIST, options: OPTIONS.all_off },
    )
    expect(set.get('gone@acme.com')).toEqual({ by: 'opted_out', ref_id: 'sup1' })
  })
})

// ---------------------------------------------------------------------------
// Source: self — always on
// ---------------------------------------------------------------------------

describe('self', () => {
  it('suppresses the source domain and every member’s employer domain', async () => {
    const { set } = await build(
      {},
      {
        workspaceId: WS,
        listId: LIST,
        options: OPTIONS.all_off,
        sourceDomain: 'https://www.Dial8.ai/',
        memberEmails: ['liam@dial8.ai', 'contractor@agency.io', 'me.personal@gmail.com', null],
      },
    )
    expect(set.get('dial8.ai')).toEqual({ by: 'self', ref_id: null })
    expect(set.get('agency.io')?.by).toBe('self')
    // A member who signed up with a personal address contributes nothing —
    // suppressing gmail.com as "our company" would be absurd.
    expect(set.has('gmail.com')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe('precedence', () => {
  it('reports the most actionable reason when several rules hit one key', async () => {
    const DOMAIN = 'rival.com'
    const { set } = await build(
      {
        lists: [{ id: LIST }, { id: 'list-2' }],
        entries: [
          {
            id: 'e-other',
            list_id: 'list-2',
            candidate_key: DOMAIN,
            stage: 'dismissed',
            dismissed_reason: 'competitor',
          },
        ],
        companies: [{ id: 'co1', domain: DOMAIN }],
        enrollments: [{ id: 'en1', contact_id: null, contact_email: `x@${DOMAIN}` }],
      },
      {
        workspaceId: WS,
        listId: LIST,
        options: { exclude_crm: true, exclude_other_lists: true, exclude_contacted: 'ever' },
        sourceDomain: DOMAIN,
      },
    )
    // dismissed_global (a human verdict) outranks self, crm, contacted and
    // other_list. Telling the user their competitor was skipped "because it is
    // in your CRM" would hide the decision they actually made.
    expect(set.get(DOMAIN)).toEqual({ by: 'dismissed_global', ref_id: 'e-other' })
  })

  it('this_list outranks everything, including a global dismissal elsewhere', async () => {
    const DOMAIN = 'rival.com'
    const { set } = await build(
      {
        lists: [{ id: LIST }, { id: 'list-2' }],
        entries: [
          {
            id: 'e-other',
            list_id: 'list-2',
            candidate_key: DOMAIN,
            stage: 'dismissed',
            dismissed_reason: 'competitor',
          },
          { id: 'e-here', list_id: LIST, candidate_key: DOMAIN, stage: 'saved' },
        ],
        companies: [{ id: 'co1', domain: DOMAIN }],
      },
      {
        workspaceId: WS,
        listId: LIST,
        options: { exclude_crm: true, exclude_other_lists: true, exclude_contacted: 'off' },
      },
    )
    expect(set.get(DOMAIN)).toEqual({ by: 'this_list', ref_id: 'e-here' })
  })

  it('opted_out outranks crm and contacted so compliance is never masked', async () => {
    const EMAIL = 'gone@acme.com'
    const { set } = await build(
      {
        contacts: [{ id: 'c1', email: EMAIL }],
        enrollments: [{ id: 'en1', contact_id: 'c1', contact_email: EMAIL }],
        suppressions: [{ id: 'sup1', email: EMAIL }],
      },
      {
        workspaceId: WS,
        listId: LIST,
        options: { exclude_crm: true, exclude_other_lists: false, exclude_contacted: 'ever' },
      },
    )
    expect(set.get(EMAIL)).toEqual({ by: 'opted_out', ref_id: 'sup1' })
  })

  it('crm outranks contacted and other_list', async () => {
    const EMAIL = 'sarah@acme.com'
    const { set } = await build(
      {
        lists: [{ id: LIST }, { id: 'list-2' }],
        entries: [{ id: 'e1', list_id: 'list-2', candidate_key: EMAIL, stage: 'discovered' }],
        contacts: [{ id: 'c1', email: EMAIL }],
        enrollments: [{ id: 'en1', contact_id: null, contact_email: EMAIL }],
      },
      {
        workspaceId: WS,
        listId: LIST,
        options: { exclude_crm: true, exclude_other_lists: true, exclude_contacted: 'ever' },
      },
    )
    expect(set.get(EMAIL)).toEqual({ by: 'crm', ref_id: 'c1' })
  })
})

// ---------------------------------------------------------------------------
// admitCandidates — the authoritative post-filter
// ---------------------------------------------------------------------------

describe('admitCandidates', () => {
  const set: ExclusionSet = new Map([
    ['known.com', { by: 'crm' as const, ref_id: 'co1' }],
    ['rival.com', { by: 'dismissed_global' as const, ref_id: 'e9' }],
  ])

  it('partitions into admitted / suppressed / invalid and drops nothing', () => {
    const candidates = [
      { identity_key: 'fresh.com', name: 'Fresh' },
      { identity_key: 'known.com', name: 'Known' },
      { identity_key: 'rival.com', name: 'Rival' },
      { identity_key: null, name: 'Nameless' },
      { identity_key: null, personal_domain: true, name: 'Gmail result host' },
    ]
    const out = admitCandidates(candidates, set)

    expect(out.admitted.map((c) => c.name)).toEqual(['Fresh'])
    expect(out.suppressed.map((s) => [s.candidate.name, s.by, s.ref_id])).toEqual([
      ['Known', 'crm', 'co1'],
      ['Rival', 'dismissed_global', 'e9'],
      ['Gmail result host', 'personal_domain', null],
    ])
    expect(out.invalid.map((c) => c.name)).toEqual(['Nameless'])
    // Nothing vanished: every candidate is accounted for exactly once. This is
    // what makes the "17 skipped" row trustworthy.
    expect(out.admitted.length + out.suppressed.length + out.invalid.length).toBe(candidates.length)
  })

  it('admits a repeated key once and reports the copy as this_list', () => {
    // The same company under two discovery angles would otherwise pass twice
    // and hit UNIQUE (list_id, candidate_key) as a surprise 23505.
    const out = admitCandidates(
      [
        { identity_key: 'dup.com', name: 'angle A' },
        { identity_key: 'dup.com', name: 'angle B' },
      ],
      new Map(),
    )
    expect(out.admitted.map((c) => c.name)).toEqual(['angle A'])
    expect(out.suppressed).toEqual([
      { candidate: { identity_key: 'dup.com', name: 'angle B' }, by: 'this_list', ref_id: null },
    ])
  })

  it('never relies on the prompt hint: a leaked domain is caught here', () => {
    // Measured leak: 2 of 30 suppressed domains come back anyway (§12). That
    // is expected, not a failure — this is the layer that makes it harmless.
    const out = admitCandidates([{ identity_key: 'known.com' }], set)
    expect(out.admitted).toEqual([])
    expect(out.suppressed[0].by).toBe('crm')
  })
})

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('pagination — PostgREST truncates silently at 1000 rows', () => {
  /** A world whose `company` table has `total` rows and honours `.range()`. */
  function bigCompanyWorld(total: number) {
    const rows = Array.from({ length: total }, (_, i) => ({
      id: `co-${i}`,
      domain: `co${i}.com`,
    }))
    return makeFakeSupabase((q: Captured): FakeResult => {
      if (q.table !== 'company') {
        return { data: q.table === 'prospect_list' ? [{ id: LIST, status: 'active' }] : [] }
      }
      const range = q.filters.find((f) => f.method === 'range')
      if (!range) return { data: rows }
      const [from, to] = range.args as [number, number]
      return { data: rows.slice(from, to + 1) }
    })
  }

  it('reads EVERY crm company, not just the first page', async () => {
    // 2500 companies is three pages. An unpaginated read would build a set of
    // 1000 and the run would re-surface 1500 accounts the user already owns —
    // with no error, which is what makes this the dangerous failure mode.
    const { client, queries } = bigCompanyWorld(2500)
    const set = await buildExclusionSet(client, {
      workspaceId: WS,
      listId: LIST,
      options: { exclude_crm: true, exclude_other_lists: false, exclude_contacted: 'off' },
    })
    expect(set.size).toBe(2500)
    expect(set.get('co0.com')?.by).toBe('crm')
    expect(set.get('co2499.com')?.by).toBe('crm')

    // Three pages, each with an explicit window and a stable order.
    const companyReads = queries.filter((q) => q.table === 'company')
    expect(companyReads).toHaveLength(3)
    expect(companyReads.map((q) => q.filters.find((f) => f.method === 'range')!.args)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
    for (const q of companyReads) {
      expect(q.filters.some((f) => f.method === 'order')).toBe(true)
      expect(hasWorkspaceFilter(q, WS)).toBe(true)
    }
  })

  it('stops after one page when the first page is short', async () => {
    const { client, queries } = bigCompanyWorld(3)
    const set = await buildExclusionSet(client, {
      workspaceId: WS,
      listId: LIST,
      options: { exclude_crm: true, exclude_other_lists: false, exclude_contacted: 'off' },
    })
    expect(set.size).toBe(3)
    expect(queries.filter((q) => q.table === 'company')).toHaveLength(1)
  })

  it('paginates every source, so no single table can silently truncate', async () => {
    const { client, queries } = world({
      lists: [{ id: LIST }],
      entries: [{ id: 'e1', list_id: LIST, candidate_key: 'a.com' }],
      companies: [{ id: 'c1', domain: 'b.com' }],
      contacts: [{ id: 'p1', email: 'x@c.com' }],
      enrollments: [{ id: 'en1', contact_email: 'y@d.com', status: 'active' }],
      suppressions: [{ id: 's1', email: 'z@e.com' }],
    })
    await buildExclusionSet(client, {
      workspaceId: WS,
      listId: LIST,
      options: { exclude_crm: true, exclude_other_lists: true, exclude_contacted: 'ever' },
    })
    for (const q of queries) {
      expect(q.filters.some((f) => f.method === 'range'), `${q.table} unpaginated`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Noise hosts (§7)
// ---------------------------------------------------------------------------

describe('noise hosts', () => {
  it('refuses linkedin.com as a candidate even though it is a parseable domain', () => {
    // The measured case: `parseDiscoveryResponse` over the recorded 25-result
    // response harvests a result whose host is `linkedin.com` (from a
    // `linkedin.com/company/...` page). `companyCandidateKey` rejects only
    // WEBMAIL, so it happily returns 'linkedin.com' — which without this rule
    // becomes a live prospect_list_entry the user cannot act on.
    expect(isNoiseHost('linkedin.com')).toBe(true)
    // `noise_host`, NOT `personal_domain`. Since migration 251 those are two
    // different facts: webmail means "this result had no company behind it",
    // a noise host means "the search drifted onto a directory".
    expect(companyAdmission('https://linkedin.com/company/b2b-saas')).toEqual({
      identity_key: null,
      personal_domain: false,
      noise_host: true,
    })
  })

  it('catches the recruiter, directory, jobs and press hosts discovery returns', () => {
    for (const host of [
      'crunchbase.com',
      'glassdoor.com',
      'indeed.com',
      'wellfound.com',
      'github.com',
      'medium.com',
      'youtube.com',
      'techcrunch.com',
      'greenhouse.io',
    ]) {
      expect(isNoiseHost(host), host).toBe(true)
      expect(companyAdmission(host).identity_key, host).toBeNull()
    }
  })

  it('matches subdomains and www, so one entry covers every spelling', () => {
    expect(isNoiseHost('www.linkedin.com')).toBe(true)
    expect(isNoiseHost('uk.linkedin.com')).toBe(true)
    expect(isNoiseHost('jobs.lever.co')).toBe(true)
  })

  it('leaves a real company alone — including one whose name merely contains a noise host', () => {
    for (const host of ['ashby.com', 'useticketry.com', 'notlinkedin.com', 'mylinkedin.com']) {
      expect(isNoiseHost(host), host).toBe(false)
    }
    expect(companyAdmission('useticketry.com')).toEqual({
      identity_key: 'useticketry.com',
      personal_domain: false,
      noise_host: false,
    })
  })

  it('is enforced by admitCandidates itself, not only by companyAdmission', () => {
    // admitCandidates is the AUTHORITATIVE post-filter. A rule it can enforce
    // only when the caller remembered to pre-apply it is not a rule.
    const out = admitCandidates(
      [{ identity_key: 'linkedin.com', name: 'LinkedIn' }, { identity_key: 'real.com', name: 'Real' }],
      new Map(),
    )
    expect(out.admitted.map((c) => c.name)).toEqual(['Real'])
    expect(out.suppressed.map((sp) => [sp.candidate.name, sp.by])).toEqual([
      ['LinkedIn', 'noise_host'],
    ])
  })

  it('reports a noise host under a suppression source the DB will accept', () => {
    // migration 251 CHECKs suppressed_by against PROSPECT_SUPPRESSION_SOURCES.
    // A value outside it is a 23514 at insert, so the source this filter picks
    // has to be in the array — the lockstep test pins the array to the SQL.
    const out = admitCandidates([{ identity_key: 'crunchbase.com' }], new Map())
    expect(out.suppressed[0].by).toBe('noise_host')
    expect(PROSPECT_SUPPRESSION_SOURCES).toContain(out.suppressed[0].by)
  })

  it('keeps a noise host DISTINCT from a webmail one in the ledger', () => {
    // The number the run summary shows. Before 251 both landed on
    // `personal_domain`, so a run that skipped six LinkedIn pages reported
    // "6 personal domains" — a lie about what the search returned.
    const out = admitCandidates(
      [
        { identity_key: null, noise_host: true, name: 'LinkedIn' },
        { identity_key: null, personal_domain: true, name: 'Gmail' },
        { identity_key: null, name: 'Unreadable' },
      ],
      new Map(),
    )
    expect(out.suppressed.map((sp) => [sp.candidate.name, sp.by])).toEqual([
      ['LinkedIn', 'noise_host'],
      ['Gmail', 'personal_domain'],
    ])
    // Neither flag set is still `invalid` — "we could read nothing at all".
    expect(out.invalid.map((c) => c.name)).toEqual(['Unreadable'])
  })

  it('prefers noise_host when a candidate somehow carries both flags', () => {
    // companyAdmission never produces both, but a hand-built candidate could.
    // Noise is the more specific statement, so it wins.
    const out = admitCandidates(
      [{ identity_key: null, noise_host: true, personal_domain: true }],
      new Map(),
    )
    expect(out.suppressed[0].by).toBe('noise_host')
  })
})

describe('companyAdmission', () => {
  it('tells a webmail rejection apart from an unreadable one', () => {
    // "We skipped gmail.com because it is a mail provider" and "this result
    // had no identity we could read" ask the user for different things.
    expect(companyAdmission('https://WWW.Acme.com/pricing')).toEqual({
      identity_key: 'acme.com',
      personal_domain: false,
      noise_host: false,
    })
    // A webmail host that turned up as a result host is a REJECTION with a
    // name, in every spelling discovery hands us.
    expect(companyAdmission('gmail.com')).toEqual({
      identity_key: null,
      personal_domain: true,
      noise_host: false,
    })
    expect(companyAdmission('https://www.Gmail.com/mail')).toEqual({
      identity_key: null,
      personal_domain: true,
      noise_host: false,
    })
    expect(companyAdmission('outlook.com')).toEqual({
      identity_key: null,
      personal_domain: true,
      noise_host: false,
    })
    expect(companyAdmission(null)).toEqual({
      identity_key: null,
      personal_domain: false,
      noise_host: false,
    })
    expect(companyAdmission('   ')).toEqual({
      identity_key: null,
      personal_domain: false,
      noise_host: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Snapshot / counts / hints
// ---------------------------------------------------------------------------

describe('exclusionSnapshot', () => {
  it('counts the whole set and tallies per source', () => {
    const set: ExclusionSet = new Map([
      ['a.com', { by: 'crm', ref_id: 'co1' }],
      ['b.com', { by: 'crm', ref_id: 'co2' }],
      ['linkedin.com/in/x', { by: 'this_list', ref_id: 'e1' }],
    ])
    // domain_count is the whole set, not just the company half: a suppressed
    // profile counts every bit as much as a suppressed domain.
    expect(exclusionSnapshot(set)).toEqual({
      domain_count: 3,
      sources: { crm: 2, this_list: 1 },
    })
  })
})

describe('emptyRunCounts', () => {
  it('has every suppression reason present as a zero', () => {
    // So the run tally never renders a hole where a reason with no hits should
    // be a 0.
    expect(emptyRunCounts()).toEqual({
      this_list: 0,
      crm: 0,
      other_list: 0,
      dismissed_global: 0,
      contacted: 0,
      opted_out: 0,
      self: 0,
      personal_domain: 0,
      // Added by 251. A missing key here is a hole in the run summary for a
      // reason that IS being recorded in prospect_run_candidate.
      over_cap: 0,
      noise_host: 0,
    })
  })
})

describe('suppressedDomainHints', () => {
  it('returns company domains only, capped', () => {
    const set: ExclusionSet = new Map([
      ['a.com', { by: 'crm', ref_id: null }],
      ['sarah@a.com', { by: 'crm', ref_id: null }],
      ['linkedin.com/in/x', { by: 'crm', ref_id: null }],
      ['b.com', { by: 'crm', ref_id: null }],
      ['c.com', { by: 'crm', ref_id: null }],
    ])
    expect(suppressedDomainHints(set)).toEqual(['a.com', 'b.com', 'c.com'])
    expect(suppressedDomainHints(set, 2)).toEqual(['a.com', 'b.com'])
  })
})
