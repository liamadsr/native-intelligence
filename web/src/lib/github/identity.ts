/**
 * Who a person is on GitHub (github_identity, migration 694): GitHub's
 * numeric user id and login, written ONLY from what GitHub answered for the
 * person's own token (on connect: complete-connect.ts; when they open
 * Reviews: the viewer GitHub's search names), never from anything a client
 * sends. The automation (pr-automation.ts) and GitHub's notices know our
 * people by it.
 *
 * One GitHub account is one person here: if another of our users held it
 * (they connected the same GitHub account before), the newest connection
 * takes it. The row goes when the person's last GitHub connection does
 * (migration 694's trigger). Service client only. Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { LOGIN_RE } from './reviews'

export async function recordGithubIdentity(svc: SupabaseClient, userId: string, gh: { id: unknown; login: unknown }): Promise<boolean> {
  try {
    if (typeof gh.id !== 'number' || !Number.isSafeInteger(gh.id) || gh.id <= 0) return false
    if (typeof gh.login !== 'string' || gh.login === '@me' || !LOGIN_RE.test(gh.login)) return false
    await svc.from('github_identity').delete().eq('github_user_id', gh.id).neq('user_id', userId)
    const { error } = await svc
      .from('github_identity')
      // Lower case: GitHub's logins are case-insensitive, and a mention is matched against it.
      .upsert({ user_id: userId, github_user_id: gh.id, login: gh.login.toLowerCase(), updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    if (error) {
      console.warn('[github-identity] could not record:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.warn('[github-identity] could not record:', err instanceof Error ? err.message : err)
    return false
  }
}

/** GitHub's own answer for a token: `/user`'s id and login, or null. Never throws. */
export async function githubUserOf(token: string, fetchImpl: typeof fetch = fetch): Promise<{ id: number; login: string } | null> {
  try {
    const res = await fetchImpl('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { id?: unknown; login?: unknown }
    return typeof data.id === 'number' && typeof data.login === 'string' ? { id: data.id, login: data.login } : null
  } catch {
    return null
  }
}
