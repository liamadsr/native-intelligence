/**
 * Native Intelligence doesn't learn from mail (2026-10-15, migration 341). A claim with ANY
 * email source is shown to no one: not the workspace, not the person whose
 * mail it came from. These tests pin the app's copy of the rule
 * (src/lib/knowledge/claim-visibility.ts) and the SQL file that closes the
 * leak, read as text (the repo idiom for properties that live in Postgres).
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  filterClaimsVisibleToNobody,
  isMailSourceType,
  mailSourcedClaimIds,
  mailSourcedClaimIdsInWorkspace,
} from '../claim-visibility'
import { latestDefinition } from '@/test/migration-sql'

type SourceRow = { claim_id: string; source_type: string; source_id?: string | null; workspace_id?: string | null }

/**
 * A claim_source double. It honours `.in('claim_id')` and `.range()` but, on
 * purpose, IGNORES `.eq('source_type')` and `.or()`: the helpers must check the
 * source type of every row they get back, never trust the filter alone.
 */
function makeSupabase(rows: SourceRow[], opts: { error?: boolean } = {}) {
  const calls: Array<{ ins?: string[]; range?: [number, number] }> = []
  const from = vi.fn((table: string) => {
    expect(table).toBe('claim_source')
    const state: { ins?: string[]; range?: [number, number]; limit?: number } = {}
    const run = () => {
      calls.push({ ins: state.ins, range: state.range })
      if (opts.error) return { data: null, error: { message: 'boom' } }
      let out = state.ins ? rows.filter((r) => state.ins!.includes(r.claim_id)) : rows
      if (state.range) out = out.slice(state.range[0], state.range[1] + 1)
      if (state.limit !== undefined) out = out.slice(0, state.limit)
      return { data: out, error: null }
    }
    const api: Record<string, unknown> = {
      select: () => api,
      in: (col: string, vals: string[]) => {
        if (col === 'claim_id') state.ins = vals
        return api
      },
      eq: () => api,
      or: () => api,
      order: () => api,
      range: (a: number, b: number) => {
        state.range = [a, b]
        return api
      },
      limit: (n: number) => {
        state.limit = n
        return api
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    }
    return api
  })
  return { client: { from } as never, calls, from }
}

describe('isMailSourceType', () => {
  it('is true for email only', () => {
    expect(isMailSourceType('email')).toBe(true)
    for (const t of ['capture', 'document', 'attachment', 'conversation', 'external_url', 'manual', null, undefined, '']) {
      expect(isMailSourceType(t)).toBe(false)
    }
  })
})

describe('filterClaimsVisibleToNobody (weaver, briefs, decision reconcile)', () => {
  const claims = [{ id: 'meeting' }, { id: 'mail' }, { id: 'both' }, { id: 'none' }]
  const sources = [
    { claim_id: 'meeting', source_type: 'capture', source_id: 'cap-1' },
    { claim_id: 'mail', source_type: 'email', source_id: 'msg-1' },
    { claim_id: 'both', source_type: 'capture', source_id: 'cap-1' },
    { claim_id: 'both', source_type: 'email', source_id: 'msg-2' },
  ]

  it('hides a claim with ANY mail source, even beside a visible capture', () => {
    const shown = filterClaimsVisibleToNobody(claims, sources, new Set(['cap-1']))
    expect(shown.map((c) => c.id)).toEqual(['meeting', 'none'])
  })
})

describe('mailSourcedClaimIds', () => {
  it('returns only the claims with a mail source, checking each row type itself', async () => {
    const { client } = makeSupabase([
      { claim_id: 'a', source_type: 'email' },
      { claim_id: 'b', source_type: 'capture' },
      { claim_id: 'c', source_type: 'document' },
    ])
    const ids = await mailSourcedClaimIds(client, ['a', 'b', 'c'])
    expect(ids && [...ids]).toEqual(['a'])
  })

  it('reads nothing for no claims', async () => {
    const { client, from } = makeSupabase([])
    expect([...((await mailSourcedClaimIds(client, [])) ?? ['x'])]).toEqual([])
    expect(from).not.toHaveBeenCalled()
  })

  it('chunks long id lists so each request stays bounded', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `c${i}`)
    const { client, calls } = makeSupabase([{ claim_id: 'c249', source_type: 'email' }])
    const hidden = await mailSourcedClaimIds(client, ids)
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => (c.ins?.length ?? 0) <= 100)).toBe(true)
    expect(hidden && [...hidden]).toEqual(['c249'])
  })

  it('fails closed: null when a read fails', async () => {
    const { client } = makeSupabase([], { error: true })
    expect(await mailSourcedClaimIds(client, ['a'])).toBeNull()
  })

  it('treats a chunk whose answer hit the row cap as all hidden (it may be truncated)', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ claim_id: i < 500 ? 'a' : 'b', source_type: 'email' }))
    const { client } = makeSupabase(rows)
    const hidden = await mailSourcedClaimIds(client, ['a', 'b', 'c'])
    expect(hidden && [...hidden].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('mailSourcedClaimIdsInWorkspace', () => {
  it('pages until a short page and checks each row type itself', async () => {
    const rows: SourceRow[] = [
      ...Array.from({ length: 1000 }, (_, i) => ({ claim_id: `m${i}`, source_type: 'email' })),
      { claim_id: 'last', source_type: 'email' },
      { claim_id: 'not-mail', source_type: 'capture' },
    ]
    const { client, calls } = makeSupabase(rows)
    const ids = await mailSourcedClaimIdsInWorkspace(client, 'ws-1')
    expect(calls).toHaveLength(2)
    expect(ids?.has('m0')).toBe(true)
    expect(ids?.has('last')).toBe(true)
    expect(ids?.has('not-mail')).toBe(false)
  })

  it('fails closed: null when a read fails', async () => {
    const { client } = makeSupabase([], { error: true })
    expect(await mailSourcedClaimIdsInWorkspace(client, 'ws-1')).toBeNull()
  })
})

describe('migration 341: a claim is readable only when one of its sources is', () => {
  const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/341_hide_mail_claims.sql'), 'utf8')
  const code = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')

  it('holds no backslash anywhere (the MCP transport decodes escapes)', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
  })

  it('deletes no data: the only write is the guarded knowledge-playbook text', () => {
    expect(code).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|INSERT\s+INTO)\b/i)
    expect(code.match(/\bUPDATE\s+public\.\w+/gi)).toEqual(['UPDATE public.recipe'])
  })

  it('is the latest definition of each function it defines, or 353 is, carrying its body forward', () => {
    // 353 (chats are their owner's) redefines all three on 341's bodies, and
    // 365 (documents phase 1) hybrid_search on 353's, changing only its
    // document branch; the assertions below read the latest definition, so
    // 341's rules stay pinned. 369 (private documents) redefines all three on
    // those bodies, adding only a document arm (migration-369.test.ts). 503
    // (one name for mail) redefines claim_neighborhood on 369's, changing
    // only its two mail checks to name `email_thread` too (migration-503.test.ts).
    // 506 (the agent reads shared records) redefines hybrid_search on 369's,
    // adding only a grant arm to its capture and document predicates
    // (migration-506.test.ts); its claim arms are untouched. 568 (call notes
    // follow their conversation) redefines claim_visible_to and hybrid_search on
    // those bodies, changing only their capture owner arms (migration-566.test.ts).
    for (const fn of ['claim_visible_to', 'hybrid_search', 'claim_neighborhood']) {
      expect(
        [
          '341_hide_mail_claims.sql',
          '353_learn_by_default.sql',
          ...(fn === 'hybrid_search' ? ['365_document_search_everywhere.sql', '506_agent_reads_shared_records.sql'] : []),
          ...(fn !== 'claim_neighborhood' ? ['568_team_call_notes_owner_reads.sql'] : []),
          '369_document_visibility.sql',
          ...(fn === 'claim_neighborhood' ? ['503_one_name_for_mail.sql'] : []),
        ],
        fn,
      ).toContain(latestDefinition(fn).file)
    }
  })

  it('claim_visible_to: a claim with any mail source is visible to no one', () => {
    const [body] = latestDefinition('claim_visible_to').blocks
    expect(body).toContain("AND cs.source_type = 'email'")
    expect(body).toContain("WHEN 'email' THEN FALSE")
    // The earlier rules travel whole: eval captures, private captures, attachments.
    expect(body).toContain('NOT c.is_eval')
    expect(body).toContain("c.visibility = 'workspace'")
    expect(body).toContain("WHEN 'attachment' THEN EXISTS")
    expect(body).toContain('SECURITY DEFINER STABLE SET search_path = public, pg_temp')
  })

  it('hybrid_search and claim_neighborhood never read email_message', () => {
    for (const fn of ['hybrid_search', 'claim_neighborhood']) {
      const { blocks } = latestDefinition(fn)
      expect(blocks.length, fn).toBe(1)
      expect(blocks[0], fn).not.toContain('email_message')
      expect(blocks[0], fn).not.toContain('em.subject')
      // The requester guard from 275 stays.
      expect(blocks[0], fn).toContain('public._resolve_visibility_requester(p_requesting_user_id)')
      expect(blocks[0], fn).toContain('public._is_member_of(v_requester')
    }
    const [hybrid] = latestDefinition('hybrid_search').blocks
    expect(hybrid).toContain("WHEN 'email' THEN FALSE")
    const [hood] = latestDefinition('claim_neighborhood').blocks
    // Mail under either name: the graph's retired `email` and `email_thread` (503).
    expect(hood).toContain("IF p_entity_type IN ('email', 'email_thread')")
    expect(hood).toContain("AND nxt.node_type NOT IN ('email', 'email_thread')")
  })

  /** One `CREATE OR REPLACE FUNCTION private.<fn>()` statement, through its closing semicolon. */
  const privateFn = (fn: string) => {
    const start = code.indexOf(`CREATE OR REPLACE FUNCTION private.${fn}()`)
    expect(start, fn).toBeGreaterThan(-1)
    const close = code.indexOf('$$', code.indexOf('$$', start) + 2)
    return code.slice(start, code.indexOf(';', close) + 1)
  }

  it('puts the hidden sets in the private schema, out of PostgREST, usable by authenticated only', () => {
    expect(code).toContain('CREATE SCHEMA IF NOT EXISTS private;')
    expect(code).toContain('REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;')
    expect(code).toContain('GRANT USAGE ON SCHEMA private TO authenticated, service_role;')
    expect(code).not.toMatch(/FUNCTION public\.(claims_hidden_from_me|claim_sources_hidden_from_me)/)
  })

  it('the hidden sets read the caller from auth.uid(), stay in their workspaces, and recheck candidates exactly', () => {
    const sources = privateFn('claim_sources_hidden_from_me')
    expect(sources).toContain('WHERE m.user_id = auth.uid()')
    expect(sources).toContain('WHERE c.is_eval')
    expect(sources).toContain("WHERE c.visibility = 'private'")
    expect(sources).toContain('c.user_id IS DISTINCT FROM auth.uid()')
    // Mail: by the source's own workspace, and through the claim for rows without one.
    expect(sources).toContain("FROM ws JOIN public.claim_source cs ON cs.workspace_id = ws.workspace_id\n  WHERE cs.source_type = 'email'")
    expect(sources).toContain('AND cs.workspace_id IS NULL\n    AND cl.workspace_id IN (SELECT workspace_id FROM ws)')
    expect(sources).toContain("ON cs.source_type = 'capture' AND cs.source_id = hc.id")
    // Attachments: from the hidden captures, never a scan of every attachment source.
    expect(sources).toContain("JOIN public.attachments a ON a.note_id = hc.id\n  JOIN public.claim_source cs\n    ON cs.source_type = 'attachment' AND cs.source_id = a.id;")
    const claims = privateFn('claims_hidden_from_me')
    expect(claims).toContain('WHERE cs.id IN (SELECT private.claim_sources_hidden_from_me())')
    expect(claims).toContain('OR NOT public.claim_visible_to(cs.claim_id, auth.uid())')
    for (const body of [sources, claims]) {
      expect(body).toContain('SECURITY DEFINER STABLE ROWS 50 SET search_path = public, pg_temp')
    }
  })

  it('indexes what the hidden sets start from', () => {
    expect(code).toContain("CREATE INDEX IF NOT EXISTS idx_claim_source_mail\n  ON public.claim_source (workspace_id, claim_id)\n  WHERE source_type = 'email';")
    expect(code).toContain('CREATE INDEX IF NOT EXISTS idx_attachments_note_id\n  ON public.attachments (note_id)\n  WHERE note_id IS NOT NULL;')
    expect(code).toContain("CREATE INDEX IF NOT EXISTS idx_captures_private_workspace\n  ON public.captures (workspace_id)\n  WHERE visibility = 'private';")
  })

  it('keeps or sets the grants: execute for authenticated and service_role only', () => {
    for (const sig of [
      'claim_visible_to(UUID, UUID)',
      'hybrid_search(UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, UUID)',
      'claim_neighborhood(TEXT, TEXT, TEXT, INTEGER, INTEGER, UUID)',
    ]) {
      expect(sql, sig).toContain(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM PUBLIC, anon;`)
      expect(sql, sig).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated, service_role;`)
    }
    for (const fn of ['claim_sources_hidden_from_me()', 'claims_hidden_from_me()']) {
      expect(sql, fn).toContain(`REVOKE EXECUTE ON FUNCTION private.${fn} FROM PUBLIC, anon;`)
      expect(sql, fn).toContain(`GRANT EXECUTE ON FUNCTION private.${fn} TO authenticated, service_role;`)
    }
  })

  it('one restrictive SELECT policy per table, each an uncorrelated NOT IN (one hashed set per statement)', () => {
    // TO authenticated: anon matches no permissive policy and gets nothing, never a 42501.
    expect(code).toContain('ON public.claim AS RESTRICTIVE FOR SELECT TO authenticated\n  USING (id NOT IN (SELECT private.claims_hidden_from_me()));')
    expect(code).toContain('ON public.claim_source AS RESTRICTIVE FOR SELECT TO authenticated\n  USING (id NOT IN (SELECT private.claim_sources_hidden_from_me()));')
    expect(code).toContain('ON public.claim_chunks AS RESTRICTIVE FOR SELECT TO authenticated\n  USING (claim_id NOT IN (SELECT private.claims_hidden_from_me()));')
    expect(code.match(/AS RESTRICTIVE/g)).toHaveLength(3)
    // Idempotent: each policy is dropped first.
    expect(code.match(/DROP POLICY IF EXISTS/g)).toHaveLength(3)
    // Never the per-row function call.
    expect(code).not.toMatch(/USING \(public\.claim_visible_to/)
  })
})

describe('migration 341: the knowledge-playbook text no longer says a claim comes from an email', () => {
  const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/341_hide_mail_claims.sql'), 'utf8')
  const prior = readFileSync(path.join(process.cwd(), 'supabase/migrations/338_skill_helper_lines.sql'), 'utf8')
  const key = "('e6ea5b11-b98c-4d56-a5e5-40b5e661d1dc'::uuid, $slug$knowledge-playbook$slug$, $pb$"
  const start = prior.indexOf(key) + key.length
  const text338 = prior.slice(start, prior.indexOf('$pb$', start))
  const pairs = [...sql.matchAll(/\$old\$([^$]*)\$old\$,\s*\$new\$([^$]*)\$new\$/g)].map((m) => [m[1], m[2]] as const)

  it("guards on 338's exact text (md5), id, slug and is_system", () => {
    expect(prior.includes(key)).toBe(true)
    const md5 = createHash('md5').update(text338, 'utf8').digest('hex')
    expect(sql).toContain(`AND md5(r.system_prompt) = '${md5}';`)
    // Loud when it can't apply: a WARNING unless the row already holds the new wording.
    expect(sql).toContain('GET DIAGNOSTICS v_changed = ROW_COUNT;')
    expect(sql).toContain('IF v_changed = 0 AND NOT EXISTS (')
    expect(sql).toContain("RAISE WARNING '341: knowledge-playbook")
    expect(sql).toContain("WHERE r.id = 'e6ea5b11-b98c-4d56-a5e5-40b5e661d1dc'::uuid")
    expect(sql).toContain('AND r.slug = $slug$knowledge-playbook$slug$')
    expect(sql).toContain('AND r.is_system')
  })

  it('drops "email, " from exactly the two lines, and nothing else', () => {
    expect(pairs).toHaveLength(2)
    let text = text338
    for (const [from, to] of pairs) {
      expect(text.split(from)).toHaveLength(2) // present exactly once
      expect(from.replace('email, ', '')).toBe(to)
      text = text.replace(from, to)
    }
    expect(text).toBe(text338.replace('document, email, attachment or page', 'document, attachment or page').replace('reads a capture, document, email, attachment or conversation', 'reads a capture, document, attachment or conversation'))
    expect(text).not.toContain('(the capture, document, email,')
    expect(text).not.toContain('`ingest_source` reads a capture, document, email,')
  })
})
