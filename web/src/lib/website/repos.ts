/**
 * Which of the owner's GitHub repos is their website (roadmap track E, step
 * 1): ranked so the business's own domain, its name and site-like names come
 * first, then a numbered short list the owner answers by text. The list
 * list_website_repos returns and the one texted when a GitHub link connects
 * (src/lib/links/oauth-link.ts) are the same ranking, so "2" means the same
 * repo in both.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { listOwnerRepos, type RepoFacts } from './github'
import { siteUrlOf } from './inspect'
import { getLiveSite } from './store'

/** The repos the list shows at most. */
export const WEBSITE_REPO_CHOICES = 6

const SITEISH_NAME = /(^|[-_.])(site|website|web|www|homepage|landing|home)([-_.]|$)|\.(com|net|org|co|io|us|biz)$/i
const WEB_LANGUAGES = new Set(['HTML', 'TypeScript', 'JavaScript', 'Astro', 'Vue', 'Svelte', 'CSS', 'SCSS', 'Liquid', 'Nunjucks', 'Handlebars', 'PHP', 'MDX'])

/** The owner's repos, the likeliest to be the business's website first. Pure. */
export function rankWebsiteRepos(repos: readonly RepoFacts[], hints: { domain?: string | null; businessName?: string | null } = {}, nowMs: number = Date.now()): RepoFacts[] {
  const domain = hints.domain ? hints.domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase() : null
  const stem = domain ? domain.split('.')[0] : null
  const words = (hints.businessName ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4)
  const score = (r: RepoFacts): number => {
    const name = r.fullName.split('/')[1].toLowerCase()
    const home = siteUrlOf(r.homepage)?.replace('https://', '').replace(/^www\./, '') ?? null
    let s = 0
    if (domain && home === domain) s += 60
    if (domain && name.replace(/[-_]/g, '.').includes(domain)) s += 40
    if (stem && stem.length >= 4 && name.replace(/[-_.]/g, '').includes(stem.replace(/-/g, ''))) s += 25
    if (words.some((w) => name.includes(w))) s += 15
    if (SITEISH_NAME.test(name)) s += 10
    if (r.hasPages) s += 8
    if (home) s += 5
    if (r.language && WEB_LANGUAGES.has(r.language)) s += 5
    if (!r.fork) s += 2
    const pushed = r.pushedAt ? Date.parse(r.pushedAt) : NaN
    if (Number.isFinite(pushed)) s += Math.max(0, 5 - (nowMs - pushed) / (60 * 24 * 60 * 60 * 1000))
    return s
  }
  return repos.filter((r) => r.canPush && !r.archived).map((r) => ({ r, s: score(r) })).sort((a, b) => b.s - a.s || a.r.fullName.localeCompare(b.r.fullName)).map(({ r }) => r)
}

/** The business's domain and name: the ranking's hints. */
export async function rankingHints(supabase: SupabaseClient, workspaceId: string): Promise<{ domain: string | null; businessName: string | null }> {
  const [company, profile] = await Promise.all([
    supabase.from('company').select('domain').eq('workspace_id', workspaceId).eq('is_workspace_company', true).limit(1),
    supabase.from('business_profile').select('business_name').eq('workspace_id', workspaceId).maybeSingle(),
  ])
  return {
    domain: ((company.data as Array<{ domain?: string | null }> | null) ?? [])[0]?.domain ?? null,
    businessName: (profile.data as { business_name?: string | null } | null)?.business_name ?? null,
  }
}

/**
 * The numbered choices texted when a GitHub link connects: the top repos'
 * names, or null when there is nothing to ask (a site is already connected,
 * or GitHub can't be read). Never throws.
 */
export async function websiteRepoChoices(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<string[] | null> {
  try {
    if (await getLiveSite(supabase, workspaceId)) return null
    const token = await storedGithubToken(supabase, userId)
    if (!token) return null
    const listed = await listOwnerRepos({ token, timeoutMs: 6_000 })
    if (!listed.ok) return null
    return rankWebsiteRepos(listed.value, await rankingHints(supabase, workspaceId)).slice(0, WEBSITE_REPO_CHOICES).map((r) => r.fullName)
  } catch {
    return null
  }
}
