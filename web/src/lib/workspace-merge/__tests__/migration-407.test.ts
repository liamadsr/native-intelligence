/**
 * Migration 407 (merge workspaces, phase 2) carries what the routes need and
 * nothing else: the service role's 120 s statement_timeout (a whole-workspace
 * merge is one statement; the role inherited 8 s through PostgREST, which
 * re-reads role settings on a CONFIG reload), the private JSON-only snapshot
 * bucket with a 50 MB file limit, the `workspace_merged` notification type in
 * the CHECK, in NOTIFICATION_TYPES and in the agent event kinds, and the
 * export paged by bytes along the primary key (402's row-count OFFSET pages
 * could not hold PROD's chunk tables).
 */
import { describe, it, expect } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { NOTIFICATION_TYPES } from '@/lib/notifications'
import { NOTICE_EVENT_KIND, noticeEventKind } from '@/lib/agent-events/types'
import { SNAPSHOT_FILE_LIMIT } from '@/lib/workspace-merge/snapshot'

const MIGRATIONS = migrationsInOrder()
const FILE = MIGRATIONS.find((m) => m.file === '407_merge_workspaces_phase2.sql')!
const BODY = FILE.sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
const LOWER = BODY.toLowerCase()

/** The newest migration defining `public.<fn>`, and its body. */
function newest(fn: string): { file: string; body: string } {
  const needle = new RegExp(`create or replace function public\\.${fn}\\(`, 'i')
  for (let i = MIGRATIONS.length - 1; i >= 0; i--) {
    const { file, sql } = MIGRATIONS[i]
    if (needle.test(sql)) return { file, body: sql.replace(/\s+/g, ' ') }
  }
  throw new Error(`no migration defines ${fn}`)
}

/** The CHECK's list of types as a migration states them. */
function checkTypes(sql: string): string[] {
  const m = /notification_type_check check \(type = any \(array\[([^\]]*)\]\)\)/.exec(sql.toLowerCase())
  return m ? m[1].split(',').map((t) => t.trim().replace(/'/g, '')) : []
}

describe('migration 407: what the merge routes need', () => {
  it('exists, is numbered after everything on main, and gives the service role 120 s per statement', () => {
    expect(FILE).toBeDefined()
    expect(MIGRATIONS.filter((m) => m.num === 407)).toHaveLength(1)
    expect(LOWER).toContain("alter role service_role set statement_timeout = '120s';")
    // never the login role or every user: the API's 8 s stays
    expect(LOWER).not.toMatch(/alter role (authenticator|authenticated|anon)/)
  })

  it('creates the private, JSON-only snapshot bucket with the file limit the exporter checks against, idempotently', () => {
    expect(LOWER).toContain(
      `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('workspace-merges', 'workspace-merges', false, ${SNAPSHOT_FILE_LIMIT}, array['application/json']) on conflict (id) do update set public = false, file_size_limit = ${SNAPSHOT_FILE_LIMIT}, allowed_mime_types = array['application/json'];`,
    )
    expect(SNAPSHOT_FILE_LIMIT).toBe(52428800)
  })

  it('re-adds the notification type CHECK with every type the app had then, workspace_merged included', () => {
    expect(LOWER).toContain('alter table public.notification drop constraint if exists notification_type_check;')
    // 443 (the Now file's check-in) adds agent_check_in, 452 (the look-ahead) agent_look_ahead and 454 (the router) agent_message; their own tests pin them.
    expect(checkTypes(BODY)).toEqual(NOTIFICATION_TYPES.filter((t: string) => t !== 'agent_check_in' && t !== 'agent_look_ahead' && t !== 'agent_message' && t !== 'team_chat_message' && t !== 'meeting_waiting' && t !== 'email_send_failed'))
    expect(checkTypes(BODY)).toContain('workspace_merged')
  })

  it('the merge notice is an FYI the agent tells in chat (kind activity)', () => {
    expect(NOTICE_EVENT_KIND.workspace_merged).toBe('activity')
    expect(noticeEventKind('workspace_merged')).toBe('activity')
  })

  it('replaces the export: keyset pages cut by bytes, the primary key required, 402’s exclusions kept and widened', () => {
    expect(LOWER).toContain('drop function if exists public.export_workspace_rows(uuid, text, int, int);')
    const { file, body } = newest('export_workspace_rows')
    expect(file).toBe('407_merge_workspaces_phase2.sql')
    expect(body).toContain('export_workspace_rows(p_workspace uuid, p_table text, p_after jsonb DEFAULT NULL, p_max_bytes int DEFAULT 20971520)')
    // the page: primary-key order, after the cursor, at most 5,000 rows, cut by the running JSON size
    expect(body).toContain('WHERE i.indrelid = (\'public.\' || quote_ident(p_table))::regclass AND i.indisprimary')
    expect(body).toContain("RAISE EXCEPTION 'table % has no primary key to page by', p_table USING ERRCODE = '22023'")
    expect(body).toContain("v_after_pred := format('(%s) > (%s)', v_order, v_after_vals)")
    expect(body).toContain('ORDER BY %5$s LIMIT 5000')
    expect(body).toContain('octet_length(to_jsonb(x)::text) AS __bytes')
    expect(body).toContain('WHERE x.__running - x.__bytes < $3')
    expect(body).toContain("'done', (SELECT count(*) FROM page) < 5000 AND (SELECT count(*) FROM kept) = (SELECT count(*) FROM page)")
    // what stays out: vectors, 402's named columns, and anything named like a credential
    expect(body).toContain("c.udt_name NOT IN ('vector', 'halfvec', 'tsvector')")
    expect(body).toContain("c.table_name = 'cloud_environment' AND c.column_name = 'env_vars'")
    expect(body).toContain("c.column_name IN ('access_token_encrypted', 'refresh_token_encrypted')")
    expect(body).toContain("c.table_name = 'task_sync_state' AND c.column_name = 'webhook_secret'")
    expect(body).toContain("c.column_name !~* '(secret|password|passwd|api_key|private_key|_encrypted$|^token$|_token$|^env_vars$)'")
    // the new function is the service's alone (a new function would otherwise be EXECUTE to PUBLIC)
    expect(BODY).toContain('REVOKE ALL ON FUNCTION public.export_workspace_rows(uuid, text, jsonb, int) FROM PUBLIC, anon, authenticated;')
    expect(BODY).toContain('GRANT EXECUTE ON FUNCTION public.export_workspace_rows(uuid, text, jsonb, int) TO service_role;')
  })

  it('the credential pattern keeps out every secret-looking column on DEV and lets the harmless ones through', () => {
    const pattern = /(secret|password|passwd|api_key|private_key|_encrypted$|^token$|_token$|^env_vars$)/i
    for (const col of ['access_token_encrypted', 'refresh_token_encrypted', 'client_secret', 'token', 'share_token', 'webhook_secret', 'env_vars', 'bearer_token_encrypted']) {
      expect(pattern.test(col), col).toBe(true)
    }
    for (const col of ['token_expires_at', 'tokens_in', 'tokens_out', 'token_id', 'access_level', 'token_endpoint', 'tools_cache_refreshed_at']) {
      expect(pattern.test(col), col).toBe(false)
    }
  })

  it('reloads PostgREST’s schema (the new signature) AND its config (the role setting)', () => {
    expect(LOWER).toContain("notify pgrst, 'reload schema';")
    expect(LOWER).toContain("notify pgrst, 'reload config';")
  })
})
