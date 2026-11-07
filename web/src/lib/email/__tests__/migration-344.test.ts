/**
 * Migration 344: drop stored mail (the purge). Pins: no backslash; says it is
 * irreversible; refuses to run before 341 and 343; drops the stored-mail
 * tables, functions and index columns idempotently, in a safe order (guards,
 * then the function that still names a dropped column is redefined, then the
 * drops); deletes settled drafts and drops generation_prompt; templates the
 * derived rows; scrubs saved mail tool outputs; leaves the claims to 341/342.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/344_drop_stored_mail.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()
const pos = (s: string) => {
  const i = BODY.indexOf(s)
  expect(i, `missing: ${s}`).toBeGreaterThanOrEqual(0)
  return i
}

describe('migration 344', () => {
  it('has no backslash anywhere, and says it is irreversible', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(SQL).toMatch(/IRREVERSIBLE/)
  })

  it('refuses to run before 343 and 341, or while another function reads stored mail', () => {
    expect(BODY).toContain("if to_regclass('public.email_hold') is null then raise exception")
    expect(BODY).toContain("p.proname in ('hybrid_search', 'claim_neighborhood') and pg_get_functiondef(p.oid) ilike '%email_message%'")
    expect(BODY).toContain("raise exception '344: % still reads stored mail; redefine it first', v_name;")
    // A word match over functions, views and policies.
    expect(BODY).toContain("~* '(^|[^a-z_])(email_message|email_attachment|email_compose)([^a-z_]|$)'")
    expect(BODY).toContain('from pg_views v')
    expect(BODY).toContain('from pg_policies pol')
  })

  it('redefines reconcile_email_thread_copies without the dropped columns or email_message, same grants', () => {
    const fn = BODY.slice(pos('create or replace function public.reconcile_email_thread_copies(p_account_id uuid)'), pos('revoke execute on function public.reconcile_email_thread_copies(uuid)'))
    for (const col of ['subject', 'snippet', 'from_name', 'to_emails', 'cc_emails', 'email_message']) {
      expect(fn).not.toMatch(new RegExp(`[^a-z_]${col}[^a-z_]`))
    }
    expect(fn).toContain('security definer set search_path = public, pg_temp')
    expect(BODY).toContain('grant execute on function public.reconcile_email_thread_copies(uuid) to service_role;')
  })

  it('drops the stored-mail functions, tables and index columns idempotently, after the guards and the redefinition', () => {
    const guards = pos('raise exception')
    const reconcile = pos('create or replace function public.reconcile_email_thread_copies')
    // RESTRICT, in order: the RPCs, the tables (email_attachment first), then the trigger functions.
    const rpcs = pos("p.proname in ('search_email_messages', 'upsert_email_messages') loop execute format('drop function if exists %s restrict', v_fn);")
    const attachment = pos('drop table if exists public.email_attachment restrict;')
    const tables = pos('drop table if exists public.email_message restrict;')
    const triggers = pos("p.proname in ('email_message_search_vector_trigger', 'update_email_message_updated_at') loop execute format('drop function if exists %s restrict', v_fn);")
    const cols = pos('alter table public.email_thread_index drop column if exists subject;')
    expect(guards).toBeLessThan(reconcile)
    expect(reconcile).toBeLessThan(rpcs)
    expect(rpcs).toBeLessThan(attachment)
    expect(attachment).toBeLessThan(tables)
    expect(tables).toBeLessThan(triggers)
    expect(triggers).toBeLessThan(cols)
    expect(BODY).not.toMatch(/ cascade;|cascade', v_fn/)
    expect(BODY).toContain('drop table if exists public.email_compose restrict;')
    for (const c of ['subject', 'snippet', 'from_name', 'to_emails', 'cc_emails']) expect(BODY).toContain(`alter table public.email_thread_index drop column if exists ${c};`)
    expect(BODY).toContain('drop index if exists public.email_thread_subject_search_idx;')
  })

  it('deletes settled drafts and the generation prompt; never the person\'s own pending drafts', () => {
    expect(BODY).toContain("delete from public.email_draft where status in ('sent', 'dismissed');")
    expect(BODY).not.toMatch(/status = 'pending_review'/)
    expect(BODY).toContain('alter table public.email_draft drop column if exists generation_prompt;')
  })

  it('carries the pre-check and post-check, with the untouched-chat md5', () => {
    expect(SQL).toMatch(/-- PRE-CHECK/)
    expect(SQL).toMatch(/-- POST-CHECK/)
    expect(SQL.match(/AS untouched_chat_md5/g)).toHaveLength(2)
    expect(SQL).toMatch(/AS mail_parts_with_text_left/)
    expect(SQL).toMatch(/AS dropped_columns_left/)
  })

  it('templates the derived rows, each update fenced so a second run changes nothing', () => {
    expect(BODY).toContain("set facts = facts - 'title' where kind in ('email.drafted', 'email.needs_reply', 'email.suspicious') and facts ? 'title';")
    expect(BODY).toContain("coalesce('Email to ' || left(nullif(trim(c.full_name), ''), 120), 'Email sent')")
    expect(BODY).toContain("and ci.interaction_type = 'email_sent' and ci.title is distinct from 'Sequence email sent'")
    expect(BODY).toContain("set title = 'Email received' where interaction_type = 'email_received'")
    // The agent_log rewrite is scoped to reply-draft work lines.
    expect(BODY).toContain("and exists (select 1 from public.tracked_job t where t.id::text = l.ref_id and t.kind = 'email_drafts');")
    expect(BODY).toContain("set title = 'Reply draft for a new email' where kind = 'email_drafts' and title like 'Reply draft: %';")
    expect(BODY).toContain("x.d ->> 'label' is distinct from 'Reply draft'")
  })

  it('scrubs saved mail tool outputs to pointers, and mail rows inside other outputs, once', () => {
    expect(BODY).toContain("~ '(^|[_.])(read_email|list_emails|get_email_drafts)$'")
    expect(BODY).toContain("'scrubbed', 'mail'")
    // find / search email rows, mail card items, recent_email_threads, and v4 tool-invocation parts.
    expect(BODY).toContain("if j ->> 'result_type' = 'email' then")
    expect(BODY).toContain("if jsonb_typeof(j -> 'thread_id') = 'string' and (j ? 'subject' or j ? 'snippet') then")
    expect(BODY).toContain("if k = 'recent_email_threads'")
    expect(BODY).toContain("if p ->> 'type' = 'tool-invocation'")
    // The helpers are session-only, and the update writes only rows it changes.
    expect(BODY).toMatch(/create or replace function pg_temp\.scrub_mail_part/)
    expect(BODY).not.toMatch(/create or replace function public\.scrub/)
    expect(BODY).toContain("and (m.ui_message -> 'parts') is distinct from (")
  })

  it('leaves claims to 341 and 342', () => {
    expect(BODY).not.toMatch(/claim_source|from public\.claim /)
  })
})
