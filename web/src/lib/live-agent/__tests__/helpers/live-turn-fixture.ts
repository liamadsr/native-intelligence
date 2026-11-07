/**
 * A table-driven fake Supabase client + a fixed "meeting" fixture, shared by the
 * live-agent eve-spec parity tests.
 *
 * WHY A FAKE (not src/test/supabase-mock.ts): the parity tests drive the REAL
 * `POST /api/ai/live-agent` composition and the REAL eve spec rebuild over the
 * SAME database state, so a query must resolve by WHAT it asks for (table +
 * selected columns + filters), not by call order. The shared chain mock returns
 * one result per table; the live turn reads `captures` four different ways.
 *
 * Every builder method records itself and returns the builder; awaiting the
 * builder (or `.single()` / `.maybeSingle()`) hands the recorded query to the
 * fixture's resolver. `rpc(name, args)` resolves through the same resolver as
 * table `rpc:<name>`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface FakeQuery {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' | 'rpc'
  columns: string
  /** [method, ...args] for every filter/modifier call, in call order. */
  filters: Array<[string, ...unknown[]]>
  terminal: 'many' | 'single' | 'maybeSingle'
  /** The payload of insert/update/upsert, or the rpc args. */
  payload?: unknown
}

export type FakeResult = { data: unknown; error: { message: string } | null }
/**
 * Answers a query by what it asks for. A Promise answer holds the query open
 * until it settles — for tests that pin ORDERING (e.g. that a later read waits
 * for a write the route must land first).
 */
export type FakeResolver = (q: FakeQuery) => FakeResult | Promise<FakeResult> | undefined

const WRITE_OPS = new Set(['insert', 'update', 'delete', 'upsert'])

/** The value a `.eq(column, value)` filter was called with, if any. */
export function eqValue(q: FakeQuery, column: string): unknown {
  const f = q.filters.find(([m, c]) => m === 'eq' && c === column)
  return f ? f[2] : undefined
}

/** Whether a select's column list names `column` exactly (not as a substring). */
export function selects(q: FakeQuery, column: string): boolean {
  return q.columns.split(',').map((c) => c.trim()).includes(column)
}

export function createFakeSupabase(resolve: FakeResolver) {
  const log: FakeQuery[] = []

  function settle(q: FakeQuery): FakeResult | Promise<FakeResult> {
    log.push(q)
    const shape = (r: FakeResult | undefined): FakeResult => {
      const out = r ?? { data: null, error: null }
      if ((q.terminal === 'single' || q.terminal === 'maybeSingle') && Array.isArray(out.data)) {
        return { data: out.data[0] ?? null, error: out.error }
      }
      return out
    }
    const r = resolve(q)
    return r instanceof Promise ? r.then(shape) : shape(r)
  }

  function builder(table: string) {
    const q: FakeQuery = { table, op: 'select', columns: '', filters: [], terminal: 'many' }
    const self: Record<string, unknown> = {}
    const proxy: Record<string, unknown> = new Proxy(self, {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (onOk: (v: FakeResult) => unknown, onErr?: (e: unknown) => unknown) =>
            Promise.resolve(settle({ ...q })).then(onOk, onErr)
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => Promise.resolve(settle({ ...q, terminal: prop }))
        }
        if (prop === 'select') {
          return (columns?: string) => {
            // `.insert(x).select(...)` keeps the write op; a bare select sets it.
            if (!WRITE_OPS.has(q.op)) q.op = 'select'
            q.columns = columns ?? '*'
            return proxy
          }
        }
        if (WRITE_OPS.has(prop)) {
          return (payload?: unknown) => {
            q.op = prop as FakeQuery['op']
            q.payload = payload
            return proxy
          }
        }
        return (...args: unknown[]) => {
          q.filters.push([prop, ...args])
          return proxy
        }
      },
    })
    return proxy
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: (name: string, args?: unknown) =>
      Promise.resolve(
        settle({ table: `rpc:${name}`, op: 'rpc', columns: '', filters: [], terminal: 'many', payload: args }),
      ),
    channel: () => ({
      send: async () => 'ok',
      subscribe: () => ({}),
      unsubscribe: async () => 'ok',
    }),
    removeChannel: async () => 'ok',
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }

  return { client: client as unknown as SupabaseClient, log }
}

// ── The meeting fixture ────────────────────────────────────────────────────────

export const FIX = {
  userId: 'user-owner-1',
  userEmail: 'owner@example.com',
  workspaceId: 'ws-1',
  captureId: 'cap-1',
  memberId: 'mem-1',
  memberName: 'Liam Owner',
  teamId: 'team-1',
  projectId: 'proj-1',
} as const

export interface FixtureOptions {
  /** `captures.is_eval` on the row. */
  isEval?: boolean
  /** Package ids attached to the capture (`captures.package_ids`). */
  packageIds?: string[]
  /** Recipe rows by id (explicit recipe_id selections). */
  recipes?: Record<string, { system_prompt: string | null; agent_config: unknown; model: string | null }>
  /**
   * Recipe ids (keys of `recipes`) the CALLER may not see — another workspace's
   * shared or personal rows. The fake has no RLS, so it behaves like the
   * SERVICE-ROLE client a device token gets: an unfenced read by id still
   * returns the row; only a read carrying the recipe_select_visibility
   * predicate (`.or(...)`, resolveLiveAgentPersona's explicitRecipeVisibleTo)
   * is refused.
   */
  hiddenRecipeIds?: string[]
  /** The workspace `settings` blob. */
  settings?: unknown
  /** The batch-only transcript + user notes. */
  transcript?: string
  userNotes?: string
  /** The capture owner (defaults to FIX.userId). Also owns the capture's chat thread. */
  ownerUserId?: string
  /**
   * SYSTEM recipe rows by slug — what `loadSystemRecipeBySlug` finds for an
   * edition default / `settings.default_agents` override. Answered only for the
   * exact system-row query (slug + is_system=true + workspace_id IS NULL).
   */
  systemRecipesBySlug?: Record<
    string,
    { id: string; system_prompt: string | null; agent_config: unknown; model: string | null }
  >
  /** The caller's `member` row is gone (membership revoked after the token was minted). */
  memberRevoked?: boolean
  /**
   * `captures.visibility` (mig 223). Defaults to 'workspace', the column default.
   * `null` models a missing/unknown value (the check must fail closed on it).
   * Returned ONLY when the capture read actually selects `visibility`, so a
   * dropped column surfaces as undefined — exactly as it would in production.
   */
  visibility?: 'workspace' | 'private' | null
  /**
   * The caller's enabled `connected_mcp_server` rows. Defaults to one Jira
   * server whose only enabled tool, create_issue, is a write (so no lookups).
   */
  mcpServers?: unknown[]
  /**
   * The live agent's own say_to_user rows in the capture's thread (assistant
   * role, kind 'say_to_user'), newest first as the read asks. None by default,
   * so Block 2 carries no "already told" section and the frozen reference holds.
   */
  priorNudges?: Array<{ text: string; created_at: string }>
  /**
   * A `document` row answered only for the exact by-id, by-workspace read the
   * product doc loader runs (product-doc.ts). Pair it with a settings blob
   * whose `product_doc.document_id` names it. None by default, so Block 2
   * carries no product-facts section and the frozen reference holds.
   */
  productDoc?: {
    id: string
    content: string | null
    title?: string
    status?: string
    published_status?: string
    type?: string
    frontmatter?: Record<string, unknown>
    updated_at?: string
  }
  /** Make the product doc read fail (a failed read renders nothing). */
  productDocError?: boolean
}

/** A resolver over one fixed meeting, parameterized by `opts`. */
export function meetingFixture(opts: FixtureOptions = {}): FakeResolver {
  const packageIds = opts.packageIds ?? []
  return (q) => {
    if (WRITE_OPS.has(q.op)) return { data: null, error: null }
    switch (q.table) {
      case 'member':
        if (opts.memberRevoked) return { data: null, error: null }
        if (eqValue(q, 'user_id') === FIX.userId && eqValue(q, 'workspace_id') === FIX.workspaceId) {
          return { data: { id: FIX.memberId, display_name: FIX.memberName }, error: null }
        }
        return { data: null, error: null }
      case 'captures': {
        if (q.columns.includes('series_key')) {
          return { data: { series_key: 'series-1', ical_uid: null, user_id: opts.ownerUserId ?? FIX.userId }, error: null }
        }
        if (q.columns.includes('occurrence_start')) {
          return {
            data: [
              {
                id: 'cap-prev-1',
                title: 'Weekly sync (last week)',
                ai_summary: '## Summary\n- Shipped the beta',
                started_at: '2026-09-17T15:00:00Z',
                occurrence_start: '2026-09-17T15:00:00Z',
              },
            ],
            error: null,
          }
        }
        if (q.columns.includes('user_notes')) {
          return {
            data: {
              transcript: opts.transcript ?? 'Speaker 1: we will ship Friday.',
              user_notes: opts.userNotes ?? '',
              duration_seconds: 1800,
              metadata: {},
              ai_summary: '## Old summary',
              title: 'Weekly sync',
              started_at: '2026-09-24T15:00:00Z',
              ended_at: '2026-09-24T15:30:00Z',
            },
            error: null,
          }
        }
        if (q.columns.includes('is_eval')) {
          if (eqValue(q, 'workspace_id') !== FIX.workspaceId) return { data: null, error: null }
          return {
            data: {
              id: FIX.captureId,
              title: 'Weekly sync',
              ai_summary: '## Notes\n- Beta is on track',
              team_id: FIX.teamId,
              project_id: FIX.projectId,
              participants: [{ name: 'Ana Guest', email: 'ana@example.com' }],
              user_id: opts.ownerUserId ?? FIX.userId,
              package_ids: packageIds,
              is_eval: opts.isEval === true,
              ...(selects(q, 'visibility')
                ? { visibility: opts.visibility === undefined ? 'workspace' : opts.visibility }
                : {}),
            },
            error: null,
          }
        }
        return { data: null, error: null }
      }
      case 'proposed_change':
        if (q.columns.includes('reasoning')) {
          return {
            data: [
              {
                id: 'pc-1',
                change_type: 'create',
                entity_type: 'action',
                entity_id: null,
                display_text: 'Draft launch email',
                title: 'Draft launch email',
                description: 'Write the launch announcement',
                reasoning: 'Liam said he would',
                assignee_name: 'Liam Owner',
                project_id: FIX.projectId,
                status_to: null,
              },
            ],
            error: null,
          }
        }
        if (eqValue(q, 'status') === 'applied') {
          return {
            data: [
              {
                id: 'pc-0',
                change_type: 'create',
                entity_type: 'decision',
                display_text: 'Ship on Friday',
                assignee_name: null,
                status_to: null,
              },
            ],
            error: null,
          }
        }
        return { data: [], error: null }
      case 'projects':
        return { data: { name: 'Apollo' }, error: null }
      case 'capture_participant':
        return {
          data: [
            {
              id: 'cp-1',
              speaker_label: 'Speaker 1',
              member_id: FIX.memberId,
              contact_id: null,
              external_name: null,
              external_email: null,
              role: 'host',
              is_self: true,
              self_binding: 'voice',
              member: { id: FIX.memberId, display_name: FIX.memberName },
              contact: null,
            },
            {
              id: 'cp-2',
              speaker_label: 'Speaker 2',
              member_id: null,
              contact_id: null,
              external_name: null,
              external_email: null,
              role: 'guest',
              is_self: false,
              self_binding: 'none',
              member: null,
              contact: null,
            },
          ],
          error: null,
        }
      case 'workflow_state':
        return { data: [{ name: 'Todo' }, { name: 'In Progress' }, { name: 'Done' }], error: null }
      case 'chat_conversations': {
        // The capture's ONE thread belongs to the capture owner (mig 173). A
        // user filter naming anyone else finds nothing — what RLS gives a
        // user-session client, and what a service-role caller must ask for.
        const uid = eqValue(q, 'user_id')
        if (uid !== undefined && uid !== (opts.ownerUserId ?? FIX.userId)) return { data: null, error: null }
        return { data: { id: 'conv-1' }, error: null }
      }
      case 'chat_messages':
        // The live agent's own heads-ups (assistant rows) vs the user's chat
        // lines (user rows): answered by the role the read asks for.
        if (eqValue(q, 'role') === 'assistant') {
          return {
            data: (opts.priorNudges ?? []).map((n) => ({
              ui_message: { role: 'assistant', parts: [{ type: 'text', text: n.text }], metadata: { kind: 'say_to_user' } },
              created_at: n.created_at,
            })),
            error: null,
          }
        }
        return {
          data: [
            { ui_message: { parts: [{ type: 'text', text: 'skip the hiring tangent' }] }, created_at: '2026-09-24T15:10:00Z' },
            { ui_message: { parts: [{ type: 'text', text: 'focus on launch items' }] }, created_at: '2026-09-24T15:05:00Z' },
          ],
          error: null,
        }
      case 'connected_mcp_server':
        if (opts.mcpServers) return { data: opts.mcpServers, error: null }
        return {
          data: [
            {
              display_name: 'Jira',
              tools_cache: [
                { name: 'create_issue', description: 'Create a Jira issue' },
                { name: 'delete_issue', description: 'Delete an issue' },
              ],
              disabled_tools: ['delete_issue'],
              is_enabled: true,
            },
          ],
          error: null,
        }
      case 'rpc:package_visible_to':
        return { data: true, error: null }
      case 'knowledge_package':
        return {
          data: packageIds.map((id, i) => ({ id, name: `Package ${i + 1}`, description: `About package ${i + 1}` })),
          error: null,
        }
      case 'workspace':
        return { data: { settings: opts.settings ?? null }, error: null }
      case 'document': {
        const doc = opts.productDoc
        if (!doc || eqValue(q, 'id') !== doc.id || eqValue(q, 'workspace_id') !== FIX.workspaceId) {
          return { data: null, error: null }
        }
        if (opts.productDocError) return { data: null, error: { message: 'boom' } }
        return {
          data: {
            id: doc.id,
            title: doc.title ?? 'Product facts',
            content: doc.content,
            updated_at: doc.updated_at ?? '2026-09-24T12:00:00Z',
            status: doc.status ?? 'active',
            published_status: doc.published_status ?? 'published',
            type: doc.type ?? 'note',
            frontmatter: doc.frontmatter ?? {},
          },
          error: null,
        }
      }
      case 'recipe': {
        const slug = eqValue(q, 'slug')
        if (typeof slug === 'string') {
          const systemOnly =
            eqValue(q, 'is_system') === true &&
            q.filters.some(([m, c, v]) => m === 'is' && c === 'workspace_id' && v === null)
          return { data: (systemOnly && opts.systemRecipesBySlug?.[slug]) || null, error: null }
        }
        const id = eqValue(q, 'id')
        const row = typeof id === 'string' ? opts.recipes?.[id] : undefined
        const fenced = q.filters.some(([m]) => m === 'or')
        if (fenced && typeof id === 'string' && opts.hiddenRecipeIds?.includes(id)) return { data: null, error: null }
        return { data: row ?? null, error: null }
      }
      default:
        return { data: null, error: null }
    }
  }
}
