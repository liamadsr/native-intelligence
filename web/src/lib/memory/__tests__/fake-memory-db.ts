/**
 * The table-keyed fake (src/lib/work/__tests__/fake-supabase.ts) with
 * migration 328's two functions done in JS over its rows, so the memory tests
 * run the real writers end to end:
 *   - chat_memory_recall_commit: store the result unless one is stored; only
 *     when this call won, upsert the epoch (same user and workspace only);
 *     returns { won, result };
 *   - workspace_entity_mentioned: the first contact, company or project name
 *     (at least 4 characters, case-insensitive) inside the text, or null.
 * `failCommit` makes the next commit fail (a 500 that stored nothing).
 */
import { makeFakeSupabase, type FakeSupabase, type FakeSupabaseOptions } from '@/lib/work/__tests__/fake-supabase'

type Row = Record<string, unknown>

export type FakeMemoryDb = FakeSupabase & { failCommit: { next: boolean } }

export function makeFakeMemoryDb(opts: Omit<FakeSupabaseOptions, 'rpc'> = {}): FakeMemoryDb {
  const failCommit = { next: false }
  let db: FakeSupabase
  const rows = (table: string) => db.rows(table)
  db = makeFakeSupabase({
    project: true,
    ...opts,
    rpc: {
      chat_memory_recall_commit: (args) => {
        if (failCommit.next) {
          failCommit.next = false
          return { data: null, error: { message: 'commit failed' } }
        }
        const memo = rows('chat_memory_op')
        const existing = memo.find((r) => r.operation_id === args.p_operation_id)
        if (existing) {
          const mine = existing.session_id === args.p_session_id && existing.user_id === args.p_user_id && existing.op === 'recall'
          return { data: { won: false, result: mine ? existing.result : null }, error: null }
        }
        memo.push({
          operation_id: args.p_operation_id,
          session_id: args.p_session_id,
          user_id: args.p_user_id,
          op: 'recall',
          phase: args.p_phase,
          result: args.p_result,
          created_at: new Date().toISOString(),
        })
        const epoch = args.p_epoch as Row | null
        if (epoch) {
          const epochs = rows('chat_memory_epoch')
          const at = epochs.find((r) => r.session_id === args.p_session_id)
          const next = {
            snapshot: epoch.snapshot ?? [],
            snapshot_hash: epoch.snapshot_hash ?? '',
            epoch_at: epoch.epoch_at ?? new Date().toISOString(),
            epoch_seq: epoch.epoch_seq ?? 0,
            live_delta_seqs: epoch.live_delta_seqs ?? [],
            facts_shown: epoch.facts_shown ?? false,
            updated_at: new Date().toISOString(),
          }
          if (!at) {
            epochs.push({
              session_id: args.p_session_id,
              user_id: args.p_user_id,
              workspace_id: args.p_workspace_id,
              conversation_id: args.p_conversation_id,
              ...next,
            })
          } else if (at.user_id === args.p_user_id && at.workspace_id === args.p_workspace_id) {
            Object.assign(at, next)
          }
        }
        return { data: { won: true, result: args.p_result }, error: null }
      },
      // Whole words, as the SQL: lower-case, non-alphanumeric runs to one
      // space, padded; names of 4+ characters, one-word contact names 5+.
      workspace_entity_mentioned: (args) => {
        const tokens = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
        const body = ` ${tokens(String(args.p_text ?? '').slice(0, 2000))} `
        const names: Array<{ kind: string; name: unknown }> = [
          ...rows('contact').filter((r) => r.workspace_id === args.p_workspace_id && !r.merged_into_contact_id).map((r) => ({ kind: 'contact', name: r.full_name })),
          ...rows('company').filter((r) => r.workspace_id === args.p_workspace_id).map((r) => ({ kind: 'company', name: r.name })),
          ...rows('projects').filter((r) => r.workspace_id === args.p_workspace_id).map((r) => ({ kind: 'project', name: r.name })),
        ]
        const hit = names.find(({ kind, name }) => {
          if (typeof name !== 'string') return false
          const core = tokens(name)
          if (core.length < 4) return false
          if (kind === 'contact' && !core.includes(' ') && core.length < 5) return false
          return body.includes(` ${core} `)
        })
        return { data: (hit?.name as string | undefined) ?? null, error: null }
      },
    },
  })
  return Object.assign(db, { failCommit })
}
