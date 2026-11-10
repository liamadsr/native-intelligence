/**
 * The entity registry is the ONE declaration of the knowledge-graph vocabulary.
 * These tests defend the two properties that make it worth having:
 *
 *   1. self-consistency — every descriptor is internally coherent and every
 *      derived constant really is a projection of the registry, not a copy that
 *      happens to agree today;
 *   2. one-entry addition — registering a new type widens every derived
 *      vocabulary with no second edit. That is the acceptance test for this
 *      slice, so it is asserted mechanically (against a copy of the registry)
 *      rather than trusted.
 *
 * The two things the registry CANNOT reach live in Postgres (migration 264):
 * the `claim_source.source_type` CHECK list and `claim_neighborhood`'s label
 * CASE. A test here can't execute SQL, so the migration file is read as text
 * and checked for the values it must carry — the only automated guard against
 * the drift that made `SOURCE_TYPES` narrower than the live constraint.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { latestDefinition } from '@/test/migration-sql'
import {
  ANCHOR_ENTITY_TYPES,
  CITABLE_SOURCE_TYPES,
  ENTITY_REGISTRY,
  ENTITY_REGISTRY_BY_ID,
  LABEL_TABLE,
  LINKABLE_ENTITY_TYPES,
  NON_ENTITY_SOURCE_TYPES,
  REALTIME_ENTITY_TABLES,
  RELATIONS,
  SOURCE_ENTITY_TYPES,
  SOURCE_TYPES,
  WORKSPACE_SCOPED_TABLE,
  anchorDescriptor,
  entityDescriptor,
  type EntityTypeDescriptor,
} from '../entity-registry'
import { PRIVATE_GRAPH_KINDS } from '../entity-fences'

// `ENTITY_REGISTRY` is `as const satisfies` so each entry keeps its exact
// literal type — which means an entry without `anchor` has no such key at all.
// These assertions iterate the registry as the interface, where `anchor` is the
// declared optional it is meant to be.
const ENTRIES: readonly EntityTypeDescriptor[] = ENTITY_REGISTRY

describe('registry self-consistency', () => {
  it('has no duplicate ids', () => {
    const ids = ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every type a label renderer and a label table', () => {
    for (const e of ENTRIES) {
      expect(e.label.columns, e.id).toBeTruthy()
      expect(typeof e.label.render, e.id).toBe('function')
      // The label table is normally the entity's own table. No exception today;
      // if one is ever needed it should be justified where it is declared.
      expect(e.label.table, e.id).toBe(e.table)
    }
  })

  it('label renderers tolerate an empty row', () => {
    for (const e of ENTRIES) {
      expect(() => e.label.render({}), e.id).not.toThrow()
      expect(typeof e.label.render({}), e.id).toBe('string')
    }
  })

  it('keeps sourceable a subset of citable', () => {
    // A type accepted in create_claim's sources[] must also mirror into the
    // graph; the reverse is deliberately false (project/contact/action are
    // citable via links[] only).
    for (const e of ENTRIES) {
      if (e.sourceable) expect(e.citable, e.id).toBe(true)
    }
  })

  it('only links types that are linkable', () => {
    // citable/sourceable/anchor all presuppose a graph endpoint, so none may be
    // set on a non-linkable type.
    for (const e of ENTRIES) {
      if (e.citable || e.sourceable || e.anchor) expect(e.linkable, e.id).toBe(true)
    }
  })

  it('gives every anchor sane thresholds and a pure embedText', () => {
    for (const e of ENTRIES) {
      if (!e.anchor) continue
      const { autoThreshold, floorThreshold, embedText, embedTextColumns } = e.anchor
      expect(floorThreshold, e.id).toBeGreaterThan(0)
      expect(autoThreshold, e.id).toBeLessThanOrEqual(1)
      expect(autoThreshold, e.id).toBeGreaterThan(floorThreshold)
      expect(embedTextColumns.length, e.id).toBeGreaterThan(0)
      expect(embedText({}), e.id).toBe('')
    }
  })

  it("company's anchor text carries name, domain, industry, description and the enrichment blob", () => {
    const anchor = anchorDescriptor('company')!
    const text = anchor.embedText({
      name: 'Acme Corp',
      domain: 'acme.com',
      industry: 'Widgets',
      description: 'Makes widgets.',
      metadata: { enrichment: { summary: 'Founded 1994 in Ohio.', funding: ['Series B'] } },
    })
    expect(text).toContain('Acme Corp')
    expect(text).toContain('acme.com')
    expect(text).toContain('Widgets')
    expect(text).toContain('Makes widgets.')
    expect(text).toContain('Founded 1994 in Ohio.')
    expect(text).toContain('Series B')
  })

  it('ignores a metadata blob with no enrichment key', () => {
    const anchor = anchorDescriptor('company')!
    expect(anchor.embedText({ name: 'Acme', metadata: { hubspot_id: '42' } })).toBe('Acme')
  })

  it('indexes by id', () => {
    for (const e of ENTITY_REGISTRY) expect(ENTITY_REGISTRY_BY_ID[e.id]).toBe(e)
    expect(entityDescriptor('company')?.table).toBe('company')
    expect(entityDescriptor('nope')).toBeUndefined()
    expect(anchorDescriptor('nope')).toBeUndefined()
  })

  it('registers company, milestone and campaign', () => {
    expect(LINKABLE_ENTITY_TYPES).toContain('company')
    expect(LINKABLE_ENTITY_TYPES).toContain('milestone')
    // campaign arrived with slice 2b (its table is migration 267).
    expect(LINKABLE_ENTITY_TYPES).toContain('campaign')
  })

  it('links the kinds the shared entity layer added, then the tables, after every older one', () => {
    const added = ['deal', 'flow', 'calendar_event', 'decision', 'team_chat_channel', 'team_chat_message', 'data_table', 'data_row']
    expect(LINKABLE_ENTITY_TYPES.slice(-added.length)).toEqual(added)
    // None is citable: the claim_source CHECK (264) does not list them.
    for (const id of added) expect(entityDescriptor(id)!.citable, id).toBe(false)
  })

  it('links a private kind only once its fence exists (entity-fences.ts)', () => {
    // Private to a person or a channel, or without a workspace_id: the graph's
    // workspace_id fence alone would leak them (see the registry comment), so
    // every linkable private kind must be one entity-fences.ts fences.
    for (const id of ['calendar_event', 'team_chat_channel', 'team_chat_message', 'decision', 'data_table', 'data_row']) {
      expect(LINKABLE_ENTITY_TYPES as readonly string[], id).toContain(id)
      expect(PRIVATE_GRAPH_KINDS as readonly string[], id).toContain(id)
    }
    // decision has no workspace_id: entityInWorkspace must not filter on one.
    expect((WORKSPACE_SCOPED_TABLE as Record<string, string>).decision).toBeUndefined()
    expect(WORKSPACE_SCOPED_TABLE.calendar_event).toBe('local_calendar_event')
  })

  it('keeps kinds outside the graph out of every graph vocabulary', () => {
    const outside = ENTRIES.filter((e) => !e.linkable).map((e) => e.id)
    expect(outside).toContain('comment')
    expect(outside).toContain('eval_run')
    for (const id of outside) {
      expect(LINKABLE_ENTITY_TYPES as readonly string[], id).not.toContain(id)
      expect(CITABLE_SOURCE_TYPES.has(id), id).toBe(false)
    }
  })

  it("campaign's anchor text carries name, objective, description and channels", () => {
    const anchor = anchorDescriptor('campaign')!
    const text = anchor.embedText({
      name: 'Spring Launch',
      objective: 'Drive 200 demo requests',
      description: 'Three-week push around the 2.0 release.',
      channels: ['email', 'linkedin'],
    })
    expect(text).toContain('Spring Launch')
    expect(text).toContain('Drive 200 demo requests')
    expect(text).toContain('Three-week push around the 2.0 release.')
    expect(text).toContain('email, linkedin')
  })

  it("tolerates a campaign whose channels column is empty or not an array", () => {
    const anchor = anchorDescriptor('campaign')!
    expect(anchor.embedText({ name: 'Q3', channels: [] })).toBe('Q3')
    expect(anchor.embedText({ name: 'Q3', channels: null })).toBe('Q3')
    expect(anchor.embedText({ name: 'Q3', channels: 'email' })).toBe('Q3')
  })

  it('campaign is never minted by automation — it is citable but not sourceable', () => {
    // Extraction may CITE a campaign (a claim about one links to it), but
    // `create_claim` cannot declare a campaign as a raw source, and nothing
    // auto-creates the entity itself (editions/manifest.ts keeps
    // autoCreateEntities empty for the campaigns feature).
    const campaign = entityDescriptor('campaign')!
    expect(campaign.citable).toBe(true)
    expect(campaign.sourceable).toBe(false)
  })
})

describe('derived constants are projections of the registry', () => {
  it('LINKABLE_ENTITY_TYPES is exactly the linkable ids, in registry order', () => {
    expect([...LINKABLE_ENTITY_TYPES]).toEqual(
      ENTRIES.filter((e) => e.linkable).map((e) => e.id),
    )
  })

  it('CITABLE_SOURCE_TYPES is exactly the citable ids', () => {
    expect([...CITABLE_SOURCE_TYPES].sort()).toEqual(
      ENTRIES.filter((e) => e.citable)
        .map((e) => e.id)
        .sort(),
    )
  })

  it('SOURCE_TYPES is the sourceable entities plus external_url/manual', () => {
    expect([...SOURCE_TYPES]).toEqual([...SOURCE_ENTITY_TYPES, ...NON_ENTITY_SOURCE_TYPES])
    // The pre-registry vocabulary minus 'email': widening create_claim's
    // accepted sources[] is a tool-surface behavior change, not a refactor, and
    // Native Intelligence doesn't learn from mail (migration 341), so a claim can't cite one.
    expect([...SOURCE_TYPES].sort()).toEqual(
      ['capture', 'attachment', 'document', 'external_url', 'manual', 'conversation'].sort(),
    )
  })

  it('WORKSPACE_SCOPED_TABLE holds exactly the column-scoped linkable types', () => {
    const expected = Object.fromEntries(
      ENTRIES.filter((e) => e.linkable && e.workspaceScoped.kind === 'column').map((e) => [
        e.id,
        e.table,
      ]),
    )
    expect(WORKSPACE_SCOPED_TABLE).toEqual(expected)
    // cycle (team-fenced) and milestone (project-fenced) have no workspace_id
    // column, so entityInWorkspace must NOT try to verify them.
    expect(WORKSPACE_SCOPED_TABLE.cycle).toBeUndefined()
    expect(WORKSPACE_SCOPED_TABLE.milestone).toBeUndefined()
    expect(WORKSPACE_SCOPED_TABLE.company).toBe('company')
    // A kind outside the graph is never an edge endpoint, so it has no fence.
    expect((WORKSPACE_SCOPED_TABLE as Record<string, string>).label).toBeUndefined()
  })

  it('REALTIME_ENTITY_TABLES is every realtime kind, filtered exactly when column-scoped', () => {
    expect(REALTIME_ENTITY_TABLES).toEqual(
      ENTRIES.filter((e) => e.realtime).map((e) => ({
        table: e.table,
        entityType: e.id,
        filtered: e.workspaceScoped.kind === 'column',
      })),
    )
    const byTable = Object.fromEntries(REALTIME_ENTITY_TABLES.map((t) => [t.table, t]))
    expect(byTable.local_calendar_event).toEqual({ table: 'local_calendar_event', entityType: 'calendar_event', filtered: true })
    expect(byTable.decision.filtered).toBe(false)
    // Too churny for the shared channel; email-layout.tsx runs its own.
    expect(byTable.email_thread_index).toBeUndefined()
    // Team chat runs its own channel.
    expect(byTable.team_chat_message).toBeUndefined()
  })

  it('LABEL_TABLE covers every registered type', () => {
    expect(Object.keys(LABEL_TABLE).sort()).toEqual(ENTRIES.map((e) => e.id).sort())
    expect(LABEL_TABLE.company.label({ name: 'Acme' })).toBe('Acme')
    expect(LABEL_TABLE.claim.label({ text: 'x'.repeat(400) })).toHaveLength(140)
  })

  it('RELATIONS is the full 10-relation vocabulary (entity-links.ts had 8)', () => {
    expect([...RELATIONS]).toEqual([
      'mentions',
      'depends_on',
      'supersedes',
      'authored_by',
      'cites',
      'about',
      'related_to',
      'contradicts',
      'owns',
      'committed_to',
    ])
  })

  it('ANCHOR_ENTITY_TYPES is exactly the types carrying an anchor descriptor', () => {
    expect([...ANCHOR_ENTITY_TYPES]).toEqual(
      ENTRIES.filter((e) => e.anchor).map((e) => e.id),
    )
    expect(ANCHOR_ENTITY_TYPES).toContain('project')
    expect(ANCHOR_ENTITY_TYPES).toContain('company')
    expect(ANCHOR_ENTITY_TYPES).toContain('contact')
    expect(ANCHOR_ENTITY_TYPES).toContain('campaign')
  })

  it('every derived tuple is non-empty (z.enum would throw otherwise)', () => {
    for (const t of [LINKABLE_ENTITY_TYPES, SOURCE_TYPES, SOURCE_ENTITY_TYPES, ANCHOR_ENTITY_TYPES, RELATIONS]) {
      expect(t.length).toBeGreaterThan(0)
    }
  })
})

/**
 * The acceptance property for this slice: adding a type is ONE entry. Re-running
 * the same projections over a registry + one fake entry must widen every
 * vocabulary, with no other edit anywhere.
 */
describe('one-entry addition', () => {
  const fake: EntityTypeDescriptor = {
    id: 'widget',
    table: 'widgets',
    workspaceScoped: { kind: 'column', table: 'widgets' },
    label: { table: 'widgets', columns: 'name', render: (r) => String(r.name ?? '') },
    realtime: true,
    linkable: true,
    activity: true,
    customFields: true,
    citable: true,
    sourceable: false,
    anchor: {
      embedTextColumns: ['name'],
      embedText: (r) => String(r.name ?? ''),
      autoThreshold: 0.9,
      floorThreshold: 0.4,
    },
  }
  const extended: readonly EntityTypeDescriptor[] = [...ENTRIES, fake]

  // The same projections the module applies, re-applied to the extended list.
  const linkable = extended.filter((e) => e.linkable).map((e) => e.id)
  const citable = new Set(extended.filter((e) => e.citable).map((e) => e.id))
  const scoped = Object.fromEntries(
    extended.filter((e) => e.linkable && e.workspaceScoped.kind === 'column').map((e) => [e.id, e.table]),
  )
  const labels = Object.fromEntries(extended.map((e) => [e.id, e.label]))
  const anchors = extended.filter((e) => e.anchor).map((e) => e.id)
  const customFieldKinds = extended.filter((e) => e.customFields).map((e) => e.id)

  it('widens every derived vocabulary from the single new entry', () => {
    expect(linkable).toContain('widget')
    expect(citable.has('widget')).toBe(true)
    expect(scoped.widget).toBe('widgets')
    expect(labels.widget.render({ name: 'W' })).toBe('W')
    expect(anchors).toContain('widget')
    expect(customFieldKinds).toContain('widget')
  })

  it('leaves every pre-existing entry untouched', () => {
    expect(linkable.slice(0, LINKABLE_ENTITY_TYPES.length)).toEqual([...LINKABLE_ENTITY_TYPES])
    for (const t of CITABLE_SOURCE_TYPES) expect(citable.has(t)).toBe(true)
    for (const [k, v] of Object.entries(WORKSPACE_SCOPED_TABLE)) expect(scoped[k]).toBe(v)
  })

  it('does not widen a vocabulary the new entry opted out of', () => {
    // `sourceable: false` — create_claim's sources[] enum stays as it was.
    expect(extended.filter((e) => e.sourceable).map((e) => e.id)).toEqual([
      ...SOURCE_ENTITY_TYPES,
    ])
  })
})

/**
 * Postgres-side parity. The registry cannot generate these, and nothing else
 * checks them — this is the guard the map flagged as missing.
 */
describe('migration 264 carries the DB-side half of the vocabulary', () => {
  const sql = readFileSync(
    path.join(
      process.cwd(),
      'supabase/migrations/264_entity_types_company_campaign.sql',
    ),
    'utf8',
  )
  const checkList = sql.slice(
    sql.indexOf('claim_source_source_type_check CHECK'),
    sql.indexOf('END $$;'),
  )

  it('lists every citable type in the claim_source.source_type CHECK', () => {
    for (const t of CITABLE_SOURCE_TYPES) {
      expect(checkList, `claim_source CHECK is missing '${t}'`).toContain(`'${t}'`)
    }
  })

  it('also lists the non-entity source types', () => {
    for (const t of NON_ENTITY_SOURCE_TYPES) expect(checkList).toContain(`'${t}'`)
  })

  it("pre-widens 'campaign' so the campaign build needs no second CHECK migration", () => {
    expect(checkList).toContain("'campaign'")
  })

  it('gives claim_neighborhood a company label branch and join', () => {
    expect(sql).toContain("WHEN 'company'      THEN comp.name")
    expect(sql).toContain("LEFT JOIN public.company  comp ON ep.node_type = 'company'")
  })

  it('deliberately omits campaign — 267 adds it once the table exists', () => {
    expect(sql).not.toContain('LEFT JOIN public.campaign')
  })
})

/**
 * Migration 267 creates the campaign table and — because `claim_neighborhood`
 * is redefined WHOLESALE, never incrementally — carries 264's whole function
 * body forward plus campaign's label branch and join. If a future migration
 * redefines the function again and drops a branch, this is what catches it.
 */
describe('migration 267 carries campaign into claim_neighborhood', () => {
  const sql = readFileSync(
    path.join(process.cwd(), 'supabase/migrations/267_campaigns.sql'),
    'utf8',
  )

  it('creates the campaign table workspace-scoped with a member-only policy', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.campaign')
    expect(sql).toContain('workspace_id    uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE')
    expect(sql).toContain('ALTER TABLE public.campaign ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('public.is_workspace_member(workspace_id)')
  })

  it('gives claim_neighborhood a campaign label branch and join', () => {
    expect(sql).toContain("WHEN 'campaign'     THEN camp.name")
    expect(sql).toContain("LEFT JOIN public.campaign camp ON ep.node_type = 'campaign'")
  })

  it('keeps every label branch 264 already had', () => {
    // The function body travels whole; a redefinition that forgets a type
    // renders that node with a silent NULL label.
    for (const branch of [
      "WHEN 'claim'",
      "WHEN 'capture'",
      "WHEN 'document'",
      "WHEN 'project'",
      "WHEN 'action'",
      "WHEN 'contact'",
      "WHEN 'member'",
      "WHEN 'initiative'",
      "WHEN 'email'",
      "WHEN 'attachment'",
      "WHEN 'conversation'",
      "WHEN 'company'",
    ]) {
      expect(sql, `claim_neighborhood lost the ${branch} label`).toContain(branch)
    }
  })

  it('needs no new claim_source CHECK — 264 pre-widened it', () => {
    expect(sql).not.toContain('claim_source_source_type_check')
  })
})

/**
 * The same label guard, but pinned to the function instead of to a filename.
 *
 * The two suites above read 264 and 267 by name, and each was written as "if a
 * future migration redefines the function and drops a branch, this is what
 * catches it". That stopped being true the moment a later migration redefined
 * `claim_neighborhood` — 275 does, to close a requester-impersonation hole — and
 * it stopped being true SILENTLY, because 267's file still contains every string
 * those tests look for. They now assert history.
 *
 * This block resolves the definition the database actually ends up with and
 * asserts the label CASE there, so the guard moves with the function. Keep the
 * suites above: they still pin the migration that INTRODUCED each branch.
 */
describe('the latest claim_neighborhood definition keeps every label branch', () => {
  const { file, blocks } = latestDefinition('claim_neighborhood')

  it('resolves to a real definition', () => {
    expect(blocks.length, 'no migration defines public.claim_neighborhood').toBe(1)
  })

  /**
   * Hardcoded rather than derived from LINKABLE_ENTITY_TYPES: the CASE covers
   * the types that render as graph NODES, which is deliberately narrower than
   * the link vocabulary (cycle and milestone are fenced indirectly and carry no
   * label join). Deriving it would assert branches the function is right to
   * omit.
   */
  const LABEL_BRANCHES = [
    "WHEN 'claim'",
    "WHEN 'capture'",
    "WHEN 'document'",
    "WHEN 'project'",
    "WHEN 'action'",
    "WHEN 'contact'",
    "WHEN 'member'",
    "WHEN 'initiative'",
    "WHEN 'attachment'",
    "WHEN 'conversation'",
    "WHEN 'company'",
    "WHEN 'campaign'",
  ] as const

  it(`carries all ${LABEL_BRANCHES.length} label branches (currently ${'in ' + file})`, () => {
    for (const branch of LABEL_BRANCHES) {
      expect(
        blocks[0],
        `the latest claim_neighborhood (${file}) lost the ${branch} label — a node ` +
          'of that type renders with a silent NULL label',
      ).toContain(branch)
    }
  })

  it('still joins company and campaign, the two newest label tables', () => {
    expect(blocks[0]).toContain("LEFT JOIN public.company  comp ON ep.node_type = 'company'")
    expect(blocks[0]).toContain("LEFT JOIN public.campaign camp ON ep.node_type = 'campaign'")
  })

  /**
   * `campaign` is citable in the registry, so a campaign node can appear in a
   * neighborhood bundle. 264 had to omit the branch (no table yet) and 267 added
   * it; this asserts the pairing survives, since a label branch without its join
   * fails at CREATE time and a join without its branch renders NULL.
   */
  it('keeps campaign citable-and-labelled in step with the registry', () => {
    expect(CITABLE_SOURCE_TYPES.has('campaign')).toBe(true)
    expect(blocks[0]).toContain("WHEN 'campaign'     THEN camp.name")
  })

  /**
   * Migration 341: Native Intelligence doesn't learn from mail. A subject line is one
   * person's mail, so the neighborhood never labels an email node, never joins
   * email_message (it joined by workspace only), and never walks onto one.
   */
  it('never labels, joins or walks onto mail (341)', () => {
    expect(CITABLE_SOURCE_TYPES.has('email')).toBe(false)
    expect(blocks[0]).not.toContain("WHEN 'email'        THEN")
    expect(blocks[0]).not.toContain('email_message')
    expect(blocks[0]).toContain("AND nxt.node_type <> 'email'")
  })
})
