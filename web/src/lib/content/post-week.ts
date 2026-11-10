/**
 * The week's material for the weekly post pass (content C1, P9;
 * content-skill-set.md §4 "The always-on loop", eve-alignment.md §5b and §6
 * decisions 2 and 3). The weekly `schedule` flow runs the `weekly-posts`
 * skill with `deliver_to: post_drafts`; before it runs, the server reads, in
 * a few bounded queries and no model call:
 *
 *   moments   the person's own post-worthy moments from their calls, kept by
 *             the content lens on Triage's ONE read of each call (lens_finding,
 *             status 'new', the last MOMENT_DAYS). Never a re-read of a call:
 *             only the lens's screened lines;
 *   shipped   the workspace's actions completed this week, and pull requests
 *             merged;
 *   docs      documents published this week: shared, ordinary documents (not
 *             a loop's report, a meeting prep, a canon document, or one whose
 *             text came from outside);
 *   brief     the person's own `content-brief:<surface>` canon document, when
 *             they keep one (themes, voice, never-post list).
 *
 * The block rides the run's message (never the cached system prompt). Each
 * moment gets a short key (m1, m2…), and a post names the keys it used, so
 * the moments it drew on are marked used and never drafted twice.
 *
 * Never an empty week (decision 3): a week with no material is a SLOW week,
 * and the run brings ideas instead: from the brief's themes, a lesson in the
 * person's voice, a past post revisited, or a question for their audience. Every post of a slow week is an idea,
 * whatever the run says (output-connectors.ts parsePosts), and its card says
 * so. On a week with material, a slot the material can't fill may be an idea
 * too, marked as one.
 *
 * The cadence budget (decision 3's defaults, changeable by asking): `slots`
 * posts a run (default 3), and never more than that many cards waiting at
 * once (insert_post_draft_card's cap). Two weekly runs in a row whose cards
 * all went unused halve it (at least one), and the run says so once.
 *
 * The public-safe names: the outside names of the person's recent calls,
 * private ones included (recent-call-names.ts), the workspace's CRM names
 * (post-sources.ts crmNames) and the brief's never-post list are screened
 * out of every draft, and a draft that names one is
 * refused, never carded.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCanonDocument } from '@/lib/documents/canon-doc'
import { findSection, parseOutline, splitLines } from '@/lib/documents/markdown-structure'
import { blockedPhrases } from './public-safe'
import { recentCallNames } from './recent-call-names'
import { resolveVisibilityFence } from '@/lib/views/visibility-fence'
import { crmNames } from './post-sources'
import { POST_SURFACE_NAME, type PostSurface } from './post-draft'

/** Default posts a week (decision 3). */
export const DEFAULT_POST_SLOTS = 3
/** The most a person can ask for in one run. */
export const MAX_POST_SLOTS = 5
/** How far back moments are read: a moment unused for two weeks has had its chance. */
export const MOMENT_DAYS = 14
/** The window for shipped work and published documents. */
export const WEEK_DAYS = 7
/** The most of each kind the block carries. */
export const MAX_MOMENTS = 10
export const MAX_SHIPPED = 12
export const MAX_DOCS = 8
/** The most of the brief the block carries. */
const MAX_BRIEF_CHARS = 2_000

const DAY_MS = 24 * 60 * 60 * 1000

export interface WeekMoment {
  /** Its key in the block: m1, m2… */
  key: string
  /** The lens_finding row. */
  id: string
  text: string
  theme: string | null
  captureTitle: string | null
}

export interface WeekShipped {
  identifier: string | null
  title: string
  /** 'action' completed, or 'pr' merged. */
  kind: 'action' | 'pr'
}

export interface WeekDoc {
  id: string
  title: string
}

export interface PostWeekMaterial {
  surface: PostSurface
  moments: WeekMoment[]
  shipped: WeekShipped[]
  docs: WeekDoc[]
  /** The person's brief for the surface, capped, or null. */
  brief: string | null
  /** Posts this run may deliver (the cadence budget, halved after two unused weeks). */
  slots: number
  /** One line when the budget changed this week, said once in the run's summary. */
  cadenceNote: string | null
  /** No material at all: every post is an idea. */
  slow: boolean
  /** Folded names no draft may carry (recent calls, the CRM, the brief's never-post list). */
  blockedPhrases: string[]
  /** One-word names matched as written (the CRM's one-word companies). */
  blockedWords: string[]
}

/** The slots a run asks for: a whole number in 1..MAX_POST_SLOTS, else the default. Pure. */
export function clampSlots(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_POST_SLOTS
  return Math.min(MAX_POST_SLOTS, Math.max(1, n))
}

/** One earlier run's cards, as the cadence rule reads them. */
export interface PastRunCards {
  runKey: string
  createdAt: string
  /** Each card's outcome: posted (accepted), skipped (dismissed), expired, or still waiting. */
  outcomes: Array<'posted' | 'skipped' | 'expired' | 'waiting'>
}

/**
 * The cadence after the history (decision 3: "two skipped weeks in a row
 * halve the cadence"): when the two most recent earlier runs each delivered
 * cards and none of them was posted or is still waiting, the slots halve
 * (rounded up, at least one). Pure.
 */
export function cadenceSlots(configured: number, history: readonly PastRunCards[]): { slots: number; note: string | null } {
  const slots = clampSlots(configured)
  const recent = [...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).filter((r) => r.outcomes.length > 0).slice(0, 2)
  const unused = (r: PastRunCards) => r.outcomes.every((o) => o === 'skipped' || o === 'expired')
  if (recent.length === 2 && recent.every(unused) && slots > 1) {
    const halved = Math.max(1, Math.ceil(slots / 2))
    return { slots: halved, note: `The last two weeks' posts went unused, so this week brings ${halved} instead of ${slots}.` }
  }
  return { slots, note: null }
}

/** The bullets of a brief's "Never post" section, as phrases to block. Pure. */
export function neverPostPhrases(brief: string | null): string[] {
  if (!brief) return []
  const found = findSection(parseOutline(brief), 'Never post')
  if (!found.ok) return []
  const lines = splitLines(brief).slice(found.entry.line, found.entry.endLine)
  const items = lines
    .map((l) => l.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, '').trim())
    .filter((l, i) => l && /^\s*(?:[-*+]|\d{1,3}[.)])\s+/.test(lines[i]))
    // A bullet is a topic or a name: keep it short enough to be a phrase.
    .filter((l) => l.split(/\s+/).length <= 4)
  return blockedPhrases({ companies: items })
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * The block the run's message carries: what the week holds, the slots, and
 * the rule for a slow week. Data, not instructions: every line is the
 * workspace's own text (the person's moments, titles), quoted. Pure.
 */
export function renderPostWeekBlock(m: PostWeekMaterial): string {
  const where = POST_SURFACE_NAME[m.surface] ?? 'X'
  const lines: string[] = ['## This week (the material for your posts)']
  if (m.moments.length) {
    lines.push('', 'Moments from their own calls (their words; keep them as themes, never a name, a company or a number from the call):')
    for (const x of m.moments) lines.push(`- [${x.key}] ${oneLine(x.text, 280)}${x.theme ? ` (theme: ${oneLine(x.theme, 60)})` : ''}`)
  }
  if (m.shipped.length) {
    lines.push('', 'Shipped:')
    for (const s of m.shipped) lines.push(`- ${s.identifier ? `${s.identifier} ` : ''}${oneLine(s.title, 160)}${s.kind === 'pr' ? ' (pull request merged)' : ''}`)
  }
  if (m.docs.length) {
    lines.push('', 'Published documents (read one with get_document before you quote it):')
    for (const d of m.docs) lines.push(`- ${oneLine(d.title, 160)} (document ${d.id})`)
  }
  if (m.brief) lines.push('', `Their ${where} brief (themes, voice, never-post list):`, m.brief)
  lines.push('')
  if (m.slow) {
    lines.push(
      `A slow week: nothing shipped, published or said on a call to post about. Never an empty week: bring ${m.slots} idea${m.slots === 1 ? '' : 's'} instead, each marked \`idea: true\`, from the brief's themes, a lesson in their voice, a past post revisited, or a question for their audience. An idea is never presented as this week's work.`,
    )
  } else {
    lines.push(
      `Draft up to ${m.slots} post${m.slots === 1 ? '' : 's'} for ${where} from this material, one idea each. Each post names the moments it used in \`uses\` (their keys). A slot the material can't fill honestly gets an idea instead, marked \`idea: true\`: never filler.`,
    )
  }
  if (m.cadenceNote) lines.push(m.cadenceNote)
  return lines.join('\n')
}

/**
 * The newsletter's block (P9, decision 9): the same week, for a weekly
 * newsletter the person copies out of Native Intelligence into their own tool. Public, so
 * the same rule: themes in their words, never a name, a company, a customer,
 * a price or a deal. A slow week still gets a short issue (one lesson, one
 * question), never filler. Pure.
 */
export function renderNewsletterBlock(m: Pick<PostWeekMaterial, 'moments' | 'shipped' | 'docs' | 'slow'>): string {
  const lines: string[] = ['## This week (the material for the newsletter)']
  if (m.moments.length) {
    lines.push('', 'What they said on their calls (their words; themes only, never a name, a company or a number from the call):')
    for (const x of m.moments) lines.push(`- ${oneLine(x.text, 280)}${x.theme ? ` (theme: ${oneLine(x.theme, 60)})` : ''}`)
  }
  if (m.shipped.length) {
    lines.push('', 'Shipped:')
    for (const s of m.shipped) lines.push(`- ${s.identifier ? `${s.identifier} ` : ''}${oneLine(s.title, 160)}`)
  }
  if (m.docs.length) {
    lines.push('', 'Published documents (read one with get_document before you quote it):')
    for (const d of m.docs) lines.push(`- ${oneLine(d.title, 160)} (document ${d.id})`)
  }
  lines.push(
    '',
    m.slow
      ? 'A slow week: write a short issue anyway, one lesson in their voice and one question for their readers. Never filler, never this week\'s work that did not happen.'
      : 'Write this week\'s issue from this material.',
    'It is a document the person edits here and copies into their own newsletter tool. Native Intelligence never sends it.',
  )
  return lines.join('\n')
}

/** A moment key's row id, for the posts that used it. Pure. */
export function momentIdsUsed(material: Pick<PostWeekMaterial, 'moments'>, keys: readonly string[]): string[] {
  const byKey = new Map(material.moments.map((m) => [m.key, m.id]))
  return [...new Set(keys.map((k) => byKey.get(k.trim().toLowerCase())).filter((id): id is string => !!id))]
}

/** Read the week's material for one person and one weekly flow. Never throws: a failed read is an empty part. */
export async function loadPostWeekMaterial(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; memberId: string; flowId: string | null; surface: PostSurface; slots?: unknown; now?: Date },
): Promise<PostWeekMaterial> {
  const now = args.now ?? new Date()
  const weekAgo = new Date(now.getTime() - WEEK_DAYS * DAY_MS).toISOString()
  const momentsSince = new Date(now.getTime() - MOMENT_DAYS * DAY_MS).toISOString()

  const [moments, shipped, docs, brief, history, recentNames, crm] = await Promise.all([
    readMoments(supabase, args.workspaceId, args.memberId, momentsSince),
    // Only work the person may see (P9 review S4): a private team's actions, and
    // their pull requests, never reach a post they didn't know about.
    resolveVisibilityFence(supabase, args.workspaceId, args.userId)
      .then((fence) => readShipped(supabase, args.workspaceId, weekAgo, fence.visibleTeamIds))
      .catch(() => [] as WeekShipped[]),
    readDocs(supabase, args.workspaceId, weekAgo),
    readBrief(supabase, args.workspaceId, args.userId, args.surface),
    readHistory(supabase, args.workspaceId, args.memberId, args.flowId, now),
    recentCallNames(supabase, { workspaceId: args.workspaceId, userId: args.userId, now }).catch(() => [] as string[]),
    crmNames(supabase, args.workspaceId).catch(() => ({ phrases: [] as string[], words: [] as string[] })),
  ])
  const cadence = cadenceSlots(clampSlots(args.slots), history)
  const blocked = [...new Set([...recentNames, ...neverPostPhrases(brief), ...crm.phrases])].slice(0, 1_500)
  return {
    surface: args.surface,
    moments,
    shipped,
    docs,
    brief,
    slots: cadence.slots,
    cadenceNote: cadence.note,
    slow: moments.length + shipped.length + docs.length === 0,
    blockedPhrases: blocked,
    blockedWords: crm.words,
  }
}

async function readMoments(supabase: SupabaseClient, workspaceId: string, memberId: string, since: string): Promise<WeekMoment[]> {
  try {
    const { data } = await supabase
      .from('lens_finding')
      .select('id, body, created_at')
      .eq('workspace_id', workspaceId)
      .eq('member_id', memberId)
      .eq('lens', 'content')
      .eq('status', 'new')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(MAX_MOMENTS)
    const out: WeekMoment[] = []
    for (const r of (data ?? []) as Array<{ id: string; body: { text?: unknown; theme?: unknown; capture_title?: unknown } | null }>) {
      const text = typeof r.body?.text === 'string' ? r.body.text.trim() : ''
      if (!text) continue
      out.push({
        key: `m${out.length + 1}`,
        id: r.id,
        text,
        theme: typeof r.body?.theme === 'string' && r.body.theme.trim() ? r.body.theme.trim() : null,
        captureTitle: typeof r.body?.capture_title === 'string' ? r.body.capture_title : null,
      })
    }
    return out
  } catch {
    return []
  }
}

async function readShipped(supabase: SupabaseClient, workspaceId: string, since: string, visibleTeamIds: readonly string[]): Promise<WeekShipped[]> {
  const out: WeekShipped[] = []
  if (visibleTeamIds.length === 0) return out
  try {
    const { data } = await supabase
      .from('actions')
      .select('id, identifier, title, updated_at, workflow_state:workflow_state!status_id!inner(category)')
      .eq('workspace_id', workspaceId)
      .eq('confirmation', 'confirmed')
      .eq('workflow_state.category', 'completed')
      .in('team_id', [...visibleTeamIds])
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(MAX_SHIPPED)
    for (const a of (data ?? []) as Array<{ identifier: string | null; title: string | null }>) {
      if (a.title?.trim()) out.push({ identifier: a.identifier ?? null, title: a.title.trim(), kind: 'action' })
    }
  } catch {
    /* none */
  }
  try {
    const { data } = await supabase
      .from('action_github_pr')
      .select('action_id, pr_title, repo_full_name, pr_number, pr_state, last_synced_at')
      .eq('workspace_id', workspaceId)
      .eq('pr_state', 'merged')
      .gte('last_synced_at', since)
      .order('last_synced_at', { ascending: false })
      .limit(MAX_SHIPPED)
    const prs = (data ?? []) as Array<{ action_id: string | null; pr_title: string | null; repo_full_name: string | null; pr_number: number | null }>
    // A pull request is as visible as the action it is linked to.
    const actionIds = [...new Set(prs.map((p) => p.action_id).filter((id): id is string => !!id))]
    const visible = new Set<string>()
    if (actionIds.length) {
      const { data: acts } = await supabase.from('actions').select('id, team_id').eq('workspace_id', workspaceId).in('id', actionIds)
      for (const a of (acts ?? []) as Array<{ id: string; team_id: string | null }>) if (a.team_id && visibleTeamIds.includes(a.team_id)) visible.add(a.id)
    }
    for (const p of prs) {
      if (!p.action_id || !visible.has(p.action_id)) continue
      if (out.length >= MAX_SHIPPED) break
      if (!p.pr_title?.trim()) continue
      // The same work as a completed action is said once.
      if (out.some((s) => s.title.toLowerCase() === p.pr_title!.trim().toLowerCase())) continue
      out.push({ identifier: p.repo_full_name && p.pr_number ? `${p.repo_full_name}#${p.pr_number}` : null, title: p.pr_title.trim(), kind: 'pr' })
    }
  } catch {
    /* none */
  }
  return out
}

async function readDocs(supabase: SupabaseClient, workspaceId: string, since: string): Promise<WeekDoc[]> {
  try {
    const { data } = await supabase
      .from('document')
      .select('id, title, visibility, kind, canon_key, outside_derived, status')
      .eq('workspace_id', workspaceId)
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(MAX_DOCS * 3)
    return ((data ?? []) as Array<{ id: string; title: string | null; visibility: string | null; kind: string | null; canon_key: string | null; outside_derived: boolean | null; status: string | null }>)
      .filter(
        (d) =>
          d.visibility !== 'private' &&
          (d.kind ?? 'doc') === 'doc' &&
          !d.canon_key &&
          d.outside_derived !== true &&
          (d.status ?? 'active') === 'active' &&
          !!d.title?.trim(),
      )
      .slice(0, MAX_DOCS)
      .map((d) => ({ id: d.id, title: d.title!.trim() }))
  } catch {
    return []
  }
}

async function readBrief(supabase: SupabaseClient, workspaceId: string, userId: string, surface: PostSurface): Promise<string | null> {
  try {
    const found = await resolveCanonDocument(supabase, { workspaceId, userId, key: `content-brief:${surface}` })
    if (!found.ok) return null
    const text = (found.doc.content ?? '').trim()
    if (!text) return null
    return text.length > MAX_BRIEF_CHARS ? `${text.slice(0, MAX_BRIEF_CHARS - 1)}…` : text
  } catch {
    return null
  }
}

/** The flow's last two weeks of post cards, grouped by run (the cadence rule). */
async function readHistory(supabase: SupabaseClient, workspaceId: string, memberId: string, flowId: string | null, now: Date): Promise<PastRunCards[]> {
  if (!flowId) return []
  try {
    const since = new Date(now.getTime() - 15 * DAY_MS).toISOString()
    const { data } = await supabase
      .from('attention_item')
      .select('run_key, status, created_at, expires_at, payload')
      .eq('workspace_id', workspaceId)
      .eq('member_id', memberId)
      .eq('kind', 'question')
      .eq('payload->>flow_id', flowId)
      .gte('created_at', since)
      .limit(60)
    const byRun = new Map<string, PastRunCards>()
    for (const r of (data ?? []) as Array<{ run_key: string | null; status: string; created_at: string; expires_at: string | null; payload: Record<string, unknown> | null }>) {
      if (!r.payload || !('post_draft' in r.payload)) continue
      const key = r.run_key ?? r.created_at.slice(0, 10)
      const entry = byRun.get(key) ?? { runKey: key, createdAt: r.created_at, outcomes: [] }
      const lapsed = r.status === 'pending' && !!r.expires_at && Date.parse(r.expires_at) <= now.getTime()
      entry.outcomes.push(r.status === 'accepted' ? 'posted' : r.status === 'dismissed' ? 'skipped' : r.status === 'expired' || lapsed ? 'expired' : 'waiting')
      if (r.created_at > entry.createdAt) entry.createdAt = r.created_at
      byRun.set(key, entry)
    }
    return [...byRun.values()]
  } catch {
    return []
  }
}
