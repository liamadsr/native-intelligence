/**
 * Migration 519: a guest's or a linked agent's turn reads no grant on a
 * contact or a company, and none at the far end of a graph edge.
 *
 * Proven on DEV inside a rolled-back transaction: a private contact (and its
 * company) hidden from a plain member, shared with them by a member grant.
 *
 *                                         2-arg / 4-arg / 5-arg list   new form, grants   new form, no grants
 *   contact_visible_to                    true                         true               false (null: false)
 *   company_visible_to                    true                         true               false
 *   list_companies_with_stats (listed)    1                            -                  0
 *   entity_visible_to (contact)           true                         true               false
 *   entity_refs_hidden (contact, company) 0 hidden                     -                  2 hidden
 *
 * And over the workspace's 120 company x member pairs: the 3-arg with grants
 * never differs from the 2-arg, and without grants it is never wider (one pair
 * narrower: the granted one). One list_companies_with_stats overload remains.
 *
 * These pin the shape that made it so: every re-created body is its previous
 * one plus ONLY the grant switch, every existing form is left alone, and the
 * ungranted twins the 3-arg forms lean on are still the 2-arg bodies less
 * their grant arm.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const FILE = '519_guest_turns_skip_contact_grants.sql'
const SQL = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
const flat = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
const BODY = flat(SQL)
const BEFORE = migrationsInOrder().filter((m) => m.num < 519)

/** The body's opening dollar quote (`as $$`, `AS $function$`) after `from`. */
function quoteAfter(text: string, from: number): { open: number; tag: string } {
  const m = /\bas\s+(\$[a-z_]*\$)/gi
  m.lastIndex = from
  const hit = m.exec(text)
  if (!hit) return { open: -1, tag: '$$' }
  return { open: hit.index + hit[0].length - hit[1].length, tag: hit[1] }
}

/** Every `create or replace function public.<fn>(` block (any case), through its statement's semicolon. */
function blocks(text: string, fn: string): string[] {
  const out: string[] = []
  const re = new RegExp(`create or replace function public\\.${fn}\\(`, 'gi')
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const { open, tag } = quoteAfter(text, m.index)
    const close = text.indexOf(tag, open + tag.length)
    out.push(text.slice(m.index, text.indexOf(';', close + tag.length) + 1))
  }
  return out
}

/** The block of `fn` whose argument list has `args` arguments. */
const withArity = (list: string[], args: number) =>
  list.filter((b) => b.slice(b.indexOf('(') + 1, b.indexOf(')')).split(',').length === args)

/** The newest definition before 519 of `fn` with `args` arguments. */
function prior(fn: string, args: number): string {
  for (let i = BEFORE.length - 1; i >= 0; i--) {
    const found = withArity(blocks(BEFORE[i].sql, fn), args)
    if (found.length > 0) return found[0]
  }
  return ''
}

/** The function body between its dollar quotes. */
function bodyOf(block: string): string {
  const { open, tag } = quoteAfter(block, 0)
  const close = block.indexOf(tag, open + tag.length)
  expect(close).toBeGreaterThan(open)
  return flat(block.slice(open + tag.length, close))
}

function only519(fn: string, args: number): string {
  const found = withArity(blocks(SQL, fn), args)
  expect(found, `${fn}/${args}`).toHaveLength(1)
  return found[0]
}

/** Take each fragment out of `text` exactly `times` times. */
function without(text: string, fragments: Array<[string, number]>): string {
  let out = text
  for (const [frag, times] of fragments) {
    expect(out.split(frag).length - 1, frag).toBe(times)
    out = out.split(frag).join('')
  }
  return out
}

describe('migration 519', () => {
  it('has no backslash, takes its lock timeout, and reloads the API schema', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';")
    expect(BODY.endsWith("notify pgrst, 'reload schema';")).toBe(true)
  })

  it('is idempotent and leaves every existing form alone but the 5-arg company list', () => {
    expect(BODY).not.toMatch(/create function /)
    expect(BODY).not.toMatch(/create table /)
    expect(withArity(blocks(SQL, 'contact_visible_to'), 2)).toHaveLength(0)
    expect(withArity(blocks(SQL, 'company_visible_to'), 2)).toHaveLength(0)
    expect(withArity(blocks(SQL, 'entity_visible_to'), 4)).toHaveLength(0)
    expect(withArity(blocks(SQL, 'entity_refs_hidden'), 4)).toHaveLength(0)
    expect(blocks(SQL, 'contact_visible_to_ungranted')).toHaveLength(0)
    expect(blocks(SQL, 'company_visible_to_ungranted')).toHaveLength(0)
    // The only drop: the 5-arg list, before its 6-arg form (a defaulted extra argument beside it would be ambiguous).
    expect(BODY.match(/drop function/g)).toHaveLength(1)
    expect(BODY.indexOf('drop function if exists public.list_companies_with_stats(uuid, text, integer, integer, uuid);')).toBeLessThan(
      BODY.indexOf('create or replace function public.list_companies_with_stats('),
    )
  })

  describe('the 3-arg twins', () => {
    it('run as their owner with a pinned search path, take no default, and are granted as the 2-arg twins', () => {
      for (const fn of ['contact_visible_to', 'company_visible_to']) {
        const block = flat(only519(fn, 3))
        expect(block).toContain('security definer set search_path = public, pg_temp')
        expect(block).toContain('p_grants boolean)')
        expect(block).not.toContain('default')
        expect(BODY).toContain(`revoke all on function public.${fn}(uuid, uuid, boolean) from public, anon;`)
        expect(BODY).toContain(`grant execute on function public.${fn}(uuid, uuid, boolean) to authenticated, service_role;`)
      }
    })

    it('with grants are the 2-arg twin, without them the ungranted twin (a null counts as without)', () => {
      expect(bodyOf(only519('contact_visible_to', 3))).toBe(
        'select case when p_grants is true then public.contact_visible_to(p_contact_id, p_user_id) else public.contact_visible_to_ungranted(p_contact_id, p_user_id) end;',
      )
      // A company asked with no user keeps the 2-arg answer: that arm has no grant, and the ungranted twin says false there.
      expect(bodyOf(only519('company_visible_to', 3))).toBe(
        'select case when p_grants is true or p_user_id is null then public.company_visible_to(p_company_id, p_user_id) else public.company_visible_to_ungranted(p_company_id, p_user_id) end;',
      )
    })

    it('lean on ungranted twins that are still the 2-arg bodies less their grant arm', () => {
      const contactArm =
        " if (auth.uid() is null or auth.uid() = p_user_id) and public.entity_grant_reaches('contact', p_contact_id, v_c.workspace_id, p_user_id) then return true; end if;"
      expect(without(bodyOf(prior('contact_visible_to', 2)), [[contactArm, 1]])).toBe(bodyOf(prior('contact_visible_to_ungranted', 2)))

      // The company twin: no grant arm, and each contact asked ungranted. Its null-user arm differs (a write gate says false).
      const company = without(bodyOf(prior('company_visible_to', 2)), [
        [
          " if (auth.uid() is null or auth.uid() = p_user_id) and public.entity_grant_reaches('company', p_company_id, v_workspace_id, p_user_id) then return true; end if;",
          1,
        ],
      ])
      const ungranted = bodyOf(prior('company_visible_to_ungranted', 2))
      expect(ungranted).toContain('public.contact_visible_to_ungranted(ct.id, p_user_id)')
      expect(ungranted).not.toContain('entity_grant_reaches')
      const tail = (b: string) => b.slice(b.indexOf("if v_role in ('owner','admin') then return true; end if;"))
      expect(tail(ungranted)).toBe(tail(company).replace('public.contact_visible_to(ct.id, p_user_id)', 'public.contact_visible_to_ungranted(ct.id, p_user_id)'))
    })
  })

  it("list_companies_with_stats is 506's body plus only the grant switch, and stays the service role's", () => {
    const now = only519('list_companies_with_stats', 6)
    expect(flat(now)).toContain('p_user_id uuid default null::uuid, p_grants boolean default true)')
    expect(flat(now)).toContain('security definer set search_path = public, pg_temp')
    const switched = bodyOf(now)
    const gate = " if p_grants is true then v_granted := public.entity_grant_ids_for('company', p_workspace_id, p_user_id); end if;"
    const join =
      ' (case when p_grants is true then public.contact_visible_to(ct.id, p_user_id) else public.contact_visible_to_ungranted(ct.id, p_user_id) end)'
    expect(switched).toContain(gate)
    expect(switched).toContain(join)
    expect(
      switched
        .replace(gate, " v_granted := public.entity_grant_ids_for('company', p_workspace_id, p_user_id);")
        .replace(join, ' public.contact_visible_to(ct.id, p_user_id)'),
    ).toBe(bodyOf(prior('list_companies_with_stats', 5)))
    expect(BODY).toContain(
      'revoke execute on function public.list_companies_with_stats(uuid, text, integer, integer, uuid, boolean) from public, anon, authenticated;',
    )
    expect(BODY).toContain('grant execute on function public.list_companies_with_stats(uuid, text, integer, integer, uuid, boolean) to service_role;')
  })

  it("entity_visible_to/5 is 503's body with every grant arm gated, and entity_refs_hidden/5 passes the switch", () => {
    const now = bodyOf(only519('entity_visible_to', 5))
    expect(flat(only519('entity_visible_to', 5))).toContain('security definer set search_path = public, pg_temp')
    const back = now
      .split('return p_grants is true and public.entity_grant_reaches(')
      .join('return public.entity_grant_reaches(')
      .replace('public.contact_visible_to(p_id, p_user, p_grants is true)', 'public.contact_visible_to(p_id, p_user)')
      .replace('public.company_visible_to(p_id, p_user, p_grants is true)', 'public.company_visible_to(p_id, p_user)')
    expect(back).toBe(bodyOf(prior('entity_visible_to', 4)))
    // Every grant arm is gated: four entity_grant_reaches, two twins.
    expect(now.split('p_grants is true and public.entity_grant_reaches(').length - 1).toBe(4)
    expect(now.split('public.entity_grant_reaches(').length - 1).toBe(4)

    const refs = bodyOf(only519('entity_refs_hidden', 5))
    expect(refs).toBe(
      bodyOf(prior('entity_refs_hidden', 4)).replace(
        'coalesce(auth.uid(), p_user))',
        'coalesce(auth.uid(), p_user), p_grants is true)',
      ),
    )
    for (const sig of ['entity_visible_to(text, uuid, uuid, uuid, boolean)', 'entity_refs_hidden(uuid, uuid, text[], uuid[], boolean)']) {
      expect(BODY).toContain(`revoke all on function public.${sig} from public, anon;`)
      expect(BODY).toContain(`grant execute on function public.${sig} to authenticated, service_role;`)
    }
  })
})
