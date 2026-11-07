/**
 * The requester-identity contract for the visibility-aware search/claims RPCs.
 *
 * These seven SECURITY DEFINER functions take the per-user visibility key as a
 * PARAMETER (`p_requesting_user_id`) and then fence rows with
 * `capture_visible_to(id, v_requester)` / `claim_visible_to(id, v_requester)`.
 * That is only safe if the function refuses to let a caller on a real user
 * session name somebody ELSE as the requester. Until migration 275 they did
 * not: they resolved `COALESCE(p_requesting_user_id, auth.uid())` and guarded
 * only workspace MEMBERSHIP, so member A could pass member B's user id and read
 * B's private ("Only me") captures and the claims derived from them.
 *
 * Why this test reads SQL text: a vitest suite cannot execute Postgres, and the
 * repo idiom is that a redefinition carries the WHOLE body forward (see
 * entity-registry.test.ts). That idiom is exactly what makes the hole easy to
 * reintroduce — copy a pre-275 body forward and the guard silently reverts.
 *
 * So this suite does NOT pin migration 275. It scans every migration, finds the
 * LATEST definition of each function by migration number, and asserts the
 * contract on that. A future migration that redefines any of them from a stale
 * body fails here, whatever its number.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  MIGRATIONS_DIR,
  latestDefinition,
  migrationsInOrder,
} from '@/test/migration-sql'

const ALL = migrationsInOrder()
const latest = (fn: string) => latestDefinition(fn, ALL)

/** The seven functions that key per-user visibility off an explicit requester. */
const VISIBILITY_RPCS = [
  'claim_neighborhood',
  'hybrid_search',
  'hybrid_search_attachments',
  'unified_search',
  'match_claims',
] as const

describe('visibility RPCs resolve the requester through the identity-checked helper', () => {
  for (const fn of VISIBILITY_RPCS) {
    describe(fn, () => {
      const { file, blocks } = latest(fn)

      it(`is latest-defined in a migration that takes p_requesting_user_id (${file})`, () => {
        expect(blocks.length, `no migration defines public.${fn}`).toBeGreaterThan(0)
        for (const b of blocks) expect(b).toContain('p_requesting_user_id')
      })

      it('never resolves the requester with the impersonable COALESCE', () => {
        expect(blocks.length).toBeGreaterThan(0)
        for (const b of blocks) {
          expect(
            b,
            `${fn} in ${file} resolves COALESCE(p_requesting_user_id, auth.uid()) — a ` +
              'caller on a live session can then assert another user as the visibility key',
          ).not.toContain('COALESCE(p_requesting_user_id, auth.uid())')
        }
      })

      it('resolves it through public._resolve_visibility_requester instead', () => {
        expect(blocks.length).toBeGreaterThan(0)
        for (const b of blocks) {
          expect(b).toContain('public._resolve_visibility_requester(p_requesting_user_id)')
        }
      })

      it('checks membership for the RESOLVED requester, not just for a present session', () => {
        expect(blocks.length).toBeGreaterThan(0)
        for (const b of blocks) {
          expect(
            b,
            `${fn} in ${file} still gates on auth.uid() being non-null, so a ` +
              'service-role call asserting an explicit requester is never membership-checked',
          ).not.toMatch(/IF auth\.uid\(\) IS NOT NULL AND NOT public\.is_workspace_member/)
          expect(b).toMatch(
            /IF v_requester IS NOT NULL AND NOT public\._is_member_of\(v_requester, [pv]_workspace_id\) THEN/,
          )
        }
      })

      it('stays SECURITY DEFINER with a pinned search_path', () => {
        expect(blocks.length).toBeGreaterThan(0)
        for (const b of blocks) {
          expect(b).toContain('SECURITY DEFINER')
          expect(b).toContain('SET search_path = public, pg_temp')
        }
      })
    })
  }
})

describe('the _resolve_visibility_requester helper', () => {
  const { file, blocks } = latest('_resolve_visibility_requester')
  const body = blocks[0] ?? ''

  it('exists', () => {
    expect(
      body,
      `no migration defines public._resolve_visibility_requester (looked through ` +
        `${ALL.length} migration files) — the visibility RPCs have nothing to ` +
        'resolve their requester through',
    ).not.toBe('')
  })

  it('refuses a live session that asserts a different user', () => {
    expect(body).toMatch(
      /IF v_session IS NOT NULL AND p_user_id IS NOT NULL AND v_session <> p_user_id THEN/,
    )
    expect(body).toContain("RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'")
  })

  /**
   * The load-bearing difference from 237's `_resolve_requester`, which RAISES on
   * NULL. Unattended runs (skill-run, work-run, flows/run-skill, eval
   * live-agent) build tools with `omitPrivateCaptures: true` on a service-role
   * client, and captureRequester() then passes NULL to mean "no requester —
   * workspace-visible rows only". A helper that raised there would 42501 every
   * unattended search. See _shared.ts and docs/design-capture-visibility.md.
   */
  it('returns NULL rather than raising when nobody is asserted', () => {
    expect(body).toContain('RETURN COALESCE(p_user_id, v_session)')
    expect(body).not.toContain("RAISE EXCEPTION 'not authenticated'")
  })

  it('is not granted to anon', () => {
    expect(blocks.length).toBeGreaterThan(0)
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION public._resolve_visibility_requester(uuid) FROM PUBLIC, anon;',
    )
  })
})
