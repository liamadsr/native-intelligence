/**
 * The coding run's reviewer (P10; eve-templates-lessons.md F6, Foreman's
 * reviewer station; eve-alignment.md §6 decision 13).
 *
 * After the coder calls finish_run and before its pull request is opened,
 * the outcome route asks this module whether to open it:
 *
 *   - The reviewer reads the REAL diff and the branch's commits (count and
 *     subject lines), from GitHub's compare of the run's base and head (never
 *     the coder's summary or PR body), plus the work item and its acceptance
 *     criteria written before coding (precheck.ts, migration 392). All of it
 *     is fenced as data.
 *   - It runs on the utility agent as `code_review`, always on another
 *     vendor than the coder (pickReviewerModel; the spec route refuses a
 *     token that breaks the rule).
 *   - It answers approve | request_changes | reject, each criterion pass,
 *     fail or cannot_judge, with its kind (content, files or commits) and
 *     evidence. A pass must rest on the evidence its kind allows (an added
 *     line, a listed path, a listed commit's subject), or it counts as a fail
 *     (normalizeCodeReview); the PR shows each pass's kind beside it. A criterion it
 *     cannot judge from the change neither blocks nor passes: the PR opens as
 *     a draft listing it, and a review that judged nothing counts as one
 *     that could not run.
 *   - request_changes sends the coder back with the review (finish_run's
 *     answer), at most MAX_REVIEW_LOOPS times. After that it stops and
 *     reports instead of opening the PR. reject reports and opens nothing.
 *   - The diff it reads is bounded (MAX_REVIEW_DIFF_CHARS), cut with a note.
 *   - Every review is an entry on agent_run.review_trail (migration 393),
 *     the loop's only memory. A finish_run with no new commit reuses the last
 *     entry rather than reviewing the same diff again.
 *
 * A review that can't run (GitHub, the model, a database without 393):
 * a person's run opens its PR marked "not reviewed"; an unattended run
 * opens nothing (its ceiling is a reviewed draft, unattended.ts).
 */
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { runUtilityTask, type UtilityObjectResult, type UtilityUsageReport } from '@/lib/eve/utility/run-utility'
import { logRunUsage } from '@/lib/writing/review'
import { differentVendors, pickCodeReviewerModel } from '@/lib/ai/reviewer-model'
import { surfaceModel } from '@/lib/ai/model-defaults'
import { MAX_ISSUE_DESCRIPTION_CHARS } from '@/lib/ai/agent-run-context'
import { normalizeCriteria } from './precheck'

/** How many times request_changes sends the coder back before the run stops. */
export const MAX_REVIEW_LOOPS = 2
/** Most diff characters the reviewer reads; the rest is cut with a note. */
export const MAX_REVIEW_DIFF_CHARS = 60_000
/** What a criterion-less run is checked against. */
export const FALLBACK_CRITERION = 'The change does what the work item asks, and nothing it does not ask.'

const EVIDENCE_MAX_CHARS = 300
const SUMMARY_MAX_CHARS = 400
const MAX_CHANGES = 8
/** Most commit subjects the reviewer is shown (the newest); the earlier ones are counted, not listed. */
export const MAX_REVIEW_COMMITS = 20
const COMMIT_SUBJECT_MAX_CHARS = 120

export const CodeReviewSchema = z.object({
  verdict: z.enum(['approve', 'request_changes', 'reject']),
  summary: z.string(),
  criteria: z.array(
    z.object({
      index: z.number(),
      result: z.enum(['pass', 'fail', 'cannot_judge']),
      /** What the criterion is about, which says what evidence a pass may rest on. */
      kind: z.enum(['content', 'files', 'commits']),
      evidence: z.string(),
    }),
  ),
  changes: z.array(z.object({ file: z.string(), issue: z.string(), fix: z.string() })),
})
export type CodeReviewAnswer = z.infer<typeof CodeReviewSchema>

export type ReviewVerdict = CodeReviewAnswer['verdict']

/**
 * What a criterion is about, as the reviewer states it: what the change's
 * lines do (`content`), which files are or are not changed (`files`), or the
 * branch's commits (`commits`). Each kind accepts one kind of evidence.
 */
export type CriterionKind = CodeReviewAnswer['criteria'][number]['kind']

export interface CriterionResult {
  criterion: string
  /** Met, on evidence from what the reviewer was shown. False for a fail AND for a criterion it could not judge. */
  pass: boolean
  /**
   * True when the reviewer could not judge it from the change (not in the
   * diff, the file list or the commits): neither a pass nor a fail. Absent on
   * entries stored before it existed, which read as before.
   */
  unjudgeable?: boolean
  /** What the reviewer said the criterion is about. Absent on entries stored before it existed. */
  kind?: CriterionKind
  /** The evidence of a pass or a fail; the reviewer's reason when unjudgeable. */
  evidence: string
}

/** A stored criterion's outcome. Unjudgeable is never a pass. Pure. */
export function criterionState(c: Pick<CriterionResult, 'pass' | 'unjudgeable'>): 'pass' | 'fail' | 'unjudgeable' {
  if (c.unjudgeable === true) return 'unjudgeable'
  return c.pass ? 'pass' : 'fail'
}

export interface ReviewChange {
  file: string
  issue: string
  fix: string
}

/** One entry of agent_run.review_trail (migration 393). */
export interface ReviewEntry {
  round: number
  head_sha: string | null
  verdict: ReviewVerdict | 'error'
  summary: string
  criteria: CriterionResult[]
  changes: ReviewChange[]
  model: string | null
  at: string
  /** The diff was longer than the reviewer reads. */
  diff_cut: boolean
  /** How many files the change touches and how many commits the branch has (shown beside a files or commits pass). */
  file_count?: number
  commit_count?: number
  error?: string
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

// ── The diff, from git ───────────────────────────────────────────────────────

export interface CompareFile {
  filename: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string
}

/** The branch's commits as the reviewer reads them, from GitHub's compare. */
export interface CompareCommits {
  /** How many commits the branch has over the base. */
  total: number
  /** The listed commits' subject lines (first line, cleaned, clipped): the newest MAX_REVIEW_COMMITS, oldest first. */
  subjects: string[]
}

export interface CompareDiff {
  headSha: string | null
  text: string
  files: number
  /** The paths whose `--- <path> (…)` header the reviewer was shown. */
  paths: string[]
  commits: CompareCommits
  cut: boolean
  empty: boolean
}

/**
 * The diff as the reviewer reads it: each file's header and patch, in the
 * compare's order, cut at `max` characters with a note naming what was left
 * out, and the paths whose header it shows. Pure.
 */
export function renderDiff(files: readonly CompareFile[], max = MAX_REVIEW_DIFF_CHARS): { text: string; cut: boolean; paths: string[] } {
  const parts: string[] = []
  const paths: string[] = []
  let used = 0
  let cutFiles = 0
  let cutChars = 0
  for (const f of files) {
    const header = `--- ${f.filename} (${f.status ?? 'modified'}, +${f.additions ?? 0} -${f.deletions ?? 0})`
    const body = typeof f.patch === 'string' ? f.patch : '(no text diff: a binary file, or too large for GitHub to show)'
    const chunk = `${header}\n${body}\n`
    if (used + chunk.length <= max) {
      parts.push(chunk)
      paths.push(f.filename)
      used += chunk.length
      continue
    }
    const room = max - used
    if (room > header.length + 200 && cutFiles === 0) {
      parts.push(`${chunk.slice(0, room)}\n`)
      paths.push(f.filename)
      cutChars += chunk.length - room
      used = max
    } else {
      cutChars += chunk.length
    }
    cutFiles += 1
  }
  const cut = cutFiles > 0
  if (cut) parts.push(`[diff cut: ${cutChars} more characters across ${cutFiles} file${cutFiles === 1 ? '' : 's'} were not shown to the reviewer]`)
  return { text: parts.join('\n').trimEnd(), cut, paths }
}

/**
 * A commit message's subject: its first line, control characters (a tab, a
 * carriage return, an escape) made spaces and invisible format characters
 * (bidi overrides, zero-width marks) dropped, whitespace collapsed, clipped.
 * Pure.
 */
export function commitSubject(message: unknown): string {
  if (typeof message !== 'string') return ''
  const first = (message.split('\n')[0] ?? '').replace(/\p{Cc}/gu, ' ').replace(/\p{Cf}/gu, '')
  return clip(first, COMMIT_SUBJECT_MAX_CHARS)
}

/**
 * The run's diff from GitHub's compare of base...head, with the head commit's
 * sha and the branch's commits (GitHub's count, and the newest
 * MAX_REVIEW_COMMITS subject lines: later fix rounds matter most). GitHub lists at most 300 files; a compare
 * that hit that is marked cut. Never throws: a failure is `{ error }`.
 */
export async function fetchCompareDiff(args: {
  repoFullName: string
  githubToken: string
  base: string
  head: string
  fetchImpl?: typeof fetch
}): Promise<CompareDiff | { error: string }> {
  const f = args.fetchImpl ?? fetch
  const url = `https://api.github.com/repos/${args.repoFullName}/compare/${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}`
  try {
    const res = await f(url, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${args.githubToken}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { error: `GitHub compare failed (${res.status})` }
    const data = (await res.json()) as {
      commits?: Array<{ sha?: string; commit?: { message?: string } } | null>
      total_commits?: number
      files?: CompareFile[]
    }
    const files = Array.isArray(data.files) ? data.files : []
    const commits = Array.isArray(data.commits) ? data.commits : []
    const headSha = commits.length > 0 ? (commits[commits.length - 1]?.sha ?? null) : null
    const rendered = renderDiff(files)
    // GitHub's own count; its list can be shorter (it lists at most 250).
    const total = typeof data.total_commits === 'number' && data.total_commits >= commits.length ? data.total_commits : commits.length
    const subjects = commits.slice(-MAX_REVIEW_COMMITS).map((c) => commitSubject(c?.commit?.message))
    return {
      headSha,
      text: rendered.text,
      files: files.length,
      paths: rendered.paths,
      commits: { total, subjects },
      cut: rendered.cut || files.length >= 300,
      empty: files.length === 0,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// ── The reviewer ─────────────────────────────────────────────────────────────

export interface ReviewItem {
  identifier: string
  title: string
  description: string | null
}

/** The commit list as the reviewer reads it: how many earlier ones were left out, then the newest, numbered on the branch. Pure. */
function renderCommitList(commits: CompareCommits): string {
  if (commits.subjects.length === 0) return '(GitHub listed no commits)'
  const earlier = Math.max(0, commits.total - commits.subjects.length)
  const lines = earlier > 0 ? [`[${earlier} earlier commit${earlier === 1 ? '' : 's'} not listed]`] : []
  lines.push(...commits.subjects.map((s, i) => `${earlier + i + 1}. ${s || '(no message)'}`))
  return lines.join('\n')
}

/** The reviewer's task message: the item, its criteria, the commits and the diff, each fenced. Pure. */
export function buildCodeReviewMessage(args: {
  item: ReviewItem
  criteria: readonly string[]
  diff: Pick<CompareDiff, 'text' | 'cut' | 'files' | 'commits'>
  base: string
  head: string
}): string {
  const description = (args.item.description ?? '').slice(0, MAX_ISSUE_DESCRIPTION_CHARS)
  const item = [`Title: ${args.item.title}`, description.trim() ? `Description:\n${description}` : 'Description: (none)'].join('\n')
  const criteria = (args.criteria.length > 0 ? args.criteria : [FALLBACK_CRITERION]).map((c, i) => `${i + 1}. ${c}`).join('\n')
  return [
    `## Work item ${args.item.identifier}`,
    wrapUntrusted(item, 'WORKSPACE') ?? '',
    '',
    args.criteria.length > 0
      ? '## Acceptance criteria (written before any code existed)'
      : '## Acceptance criteria (none were written: check this one)',
    wrapUntrusted(criteria, 'WORKSPACE') ?? '',
    '',
    `## The commits: ${args.diff.commits.total} on ${args.base}...${args.head}, oldest first, subject lines from GitHub`,
    wrapUntrusted(renderCommitList(args.diff.commits), 'TOOL') ?? '',
    '',
    `## The diff: ${args.base}...${args.head}, ${args.diff.files} file${args.diff.files === 1 ? '' : 's'}${args.diff.cut ? ' (cut short)' : ''}`,
    wrapUntrusted(args.diff.text, 'TOOL') ?? '',
    '',
    'Review it.',
  ].join('\n')
}

/** The shortest quote that can prove anything, after normalising. */
export const MIN_EVIDENCE_CHARS = 20

/** Text compared without diff markers, backticks and whitespace. */
function comparable(lines: readonly string[]): string {
  return lines
    .map((l) => l.replace(/^\+/, ''))
    .join(' ')
    .replace(/[`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The diff's ADDED lines only: what the change puts in, never what it removes or keeps. */
function addedLines(diff: string): string[] {
  return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
}

/**
 * Whether `quote` is really among the diff's added lines (markers, backticks
 * and whitespace aside), and long enough to prove something
 * (MIN_EVIDENCE_CHARS). A removed line or an unchanged context line is not
 * evidence the change does anything. Pure.
 */
export function quotedInDiff(quote: string, diff: string): boolean {
  const q = comparable(quote.split('\n'))
  if (q.length < MIN_EVIDENCE_CHARS) return false
  return comparable(addedLines(diff)).includes(q)
}

/**
 * The shortest WHOLE added line that grounds a `content` pass on its own,
 * after normalising, and it must hold two words. Ten characters and two words
 * keep out `}`, `});`, `return`, `break;` and `} else {`, while a one-line fix
 * that says something (`if (!rows) return`, `return rows ?? []`) is longer.
 */
export const MIN_WHOLE_LINE_CHARS = 10

/**
 * Whether `evidence` is, all of it, one of the diff's added lines (markers,
 * backticks and whitespace aside) that clears MIN_WHOLE_LINE_CHARS. Pure.
 */
export function isWholeAddedLine(evidence: string, diff: string): boolean {
  const e = comparable(evidence.split('\n'))
  if (e.length < MIN_WHOLE_LINE_CHARS || (e.match(/[A-Za-z0-9_]+/g) ?? []).length < 2) return false
  return addedLines(diff).some((l) => comparable([l]) === e)
}

/**
 * Whether `evidence` names a path from the diff's file list the way only a
 * path is written: inside backticks (`` `src/a.ts` ``) or in its header form
 * (`--- src/a.ts (`). Bare prose never names a path, so a file called `a` is
 * not named by "a careful change". Whole paths only: `` `README.md` `` does
 * not name `docs/README.md`. Pure.
 */
export function namesListedPath(evidence: string, paths: readonly string[]): boolean {
  return paths.some((p) => p.length > 0 && (evidence.includes(`\`${p}\``) || evidence.includes(`--- ${p} (`)))
}

/**
 * The shortest commit subject that can ground a pass, after normalising. A
 * subject is the coder's own text, so it grounds only that the commit says
 * so: 12 characters and two words keep out "wip", "fix", "Update", "." and
 * anything short enough to turn up in ordinary prose by chance, while any
 * subject that says what changed ("Append a line to README") is longer.
 */
export const MIN_SUBJECT_CHARS = 12

/** Whether `evidence` contains a listed commit's whole subject line (normalised as quotes are), long enough to mean something. Pure. */
export function quotesCommitSubject(evidence: string, subjects: readonly string[]): boolean {
  const e = comparable(evidence.split('\n'))
  return subjects.some((s) => {
    const q = comparable([s])
    return q.length >= MIN_SUBJECT_CHARS && /\S\s+\S/.test(q) && e.includes(q)
  })
}

/** What the reviewer was shown, which a pass's evidence must come from. */
export interface ReviewShown {
  diffText: string
  /** The paths whose header the reviewer was shown (renderDiff). */
  paths: readonly string[]
  /** The listed commits' subjects. */
  commitSubjects: readonly string[]
}

/**
 * Whether a pass's evidence is the evidence its kind allows: `content` a
 * quote of added lines (MIN_EVIDENCE_CHARS) or one whole added line
 * (MIN_WHOLE_LINE_CHARS); `files` a listed path in backticks or header form;
 * `commits` a listed commit's whole subject. No kind, no pass. Free text
 * grounds nothing. Pure.
 */
export function groundedEvidence(evidence: string, kind: CriterionKind | undefined, shown: ReviewShown): boolean {
  if (kind === 'content') return quotedInDiff(evidence, shown.diffText) || isWholeAddedLine(evidence, shown.diffText)
  if (kind === 'files') return namesListedPath(evidence, shown.paths)
  if (kind === 'commits') return quotesCommitSubject(evidence, shown.commitSubjects)
  return false
}

const NEEDS: Record<CriterionKind, string> = {
  content: 'a quote of the diff\'s added lines (at least 20 characters) or one whole added line',
  files: 'a path from the diff\'s file list, in backticks or as its header shows it',
  commits: 'a listed commit\'s subject, copied whole',
}

/** Why a pass was not taken: what its kind needs, or that it gave none. Pure. */
function downgradeNote(kind: CriterionKind | undefined, evidence: string): string {
  const quoted = clip(evidence, EVIDENCE_MAX_CHARS)
  if (!kind || !(kind in NEEDS)) return `Marked as done without saying whether it is about the change's lines, its files or its commits: ${quoted}`
  return `Marked as done, but a ${kind} criterion needs ${NEEDS[kind]}: ${quoted}`
}

/** A stored kind, only when it is one of the three. */
function kindOf(kind: unknown): { kind?: CriterionKind } {
  return kind === 'content' || kind === 'files' || kind === 'commits' ? { kind } : {}
}

/** The error a review that judged no criterion at all is stored with. */
export const NOTHING_JUDGED_ERROR = 'it could not judge any acceptance criterion from the change'

/**
 * The stored shape of an answer. Pure. Every criterion gets a result (one the
 * reviewer skipped fails; a fail in any of its entries stands); a pass whose
 * evidence is not from what it was shown fails; a criterion it cannot judge
 * neither blocks nor passes. The verdict follows the criteria: approve only
 * when none fails, and a request with nothing to change is an approve. reject
 * stands. A review that judged no criterion at all checked nothing: it is
 * stored as one that could not run (`error`).
 */
export function normalizeCodeReview(
  answer: CodeReviewAnswer,
  args: ReviewShown & {
    criteria: readonly string[]
    /** How many files the change touches and how many commits the branch has (stored for the PR section). */
    fileCount: number
    commitCount: number
    model: string
    round: number
    headSha: string | null
    diffCut: boolean
    now?: Date
  },
): ReviewEntry {
  const list = args.criteria.length > 0 ? args.criteria : [FALLBACK_CRITERION]
  const criteria: CriterionResult[] = list.map((criterion, i) => {
    const hits = answer.criteria.filter((c) => c.index === i + 1)
    if (hits.length === 0) return { criterion, pass: false, evidence: 'Not checked by the reviewer.' }
    // A fail stands: no other entry for the same criterion turns it into a pass or a cannot-judge.
    const fail = hits.find((c) => c.result !== 'pass' && c.result !== 'cannot_judge')
    if (fail) return { criterion, pass: false, ...kindOf(fail.kind), evidence: clip(fail.evidence, EVIDENCE_MAX_CHARS) }
    const cannot = hits.find((c) => c.result === 'cannot_judge')
    if (cannot) return { criterion, pass: false, unjudgeable: true, ...kindOf(cannot.kind), evidence: clip(cannot.evidence, EVIDENCE_MAX_CHARS) || 'No reason given.' }
    // A pass counts only on the evidence its own kind allows.
    const grounded = hits.find((c) => groundedEvidence(c.evidence, c.kind, args))
    if (!grounded) return { criterion, pass: false, ...kindOf(hits[0].kind), evidence: downgradeNote(hits[0].kind, hits[0].evidence) }
    return { criterion, pass: true, kind: grounded.kind, evidence: clip(grounded.evidence, EVIDENCE_MAX_CHARS) }
  })
  const changes = answer.changes
    .map((c) => ({ file: clip(c.file, 160), issue: clip(c.issue, 400), fix: clip(c.fix, 400) }))
    .filter((c) => c.issue.length > 0)
    .slice(0, MAX_CHANGES)
  const failing = criteria.filter((c) => criterionState(c) === 'fail')
  const judgedAny = criteria.some((c) => criterionState(c) !== 'unjudgeable')
  let verdict: ReviewVerdict | 'error'
  if (answer.verdict === 'reject') verdict = 'reject'
  else if (failing.length > 0) verdict = 'request_changes'
  else if (answer.verdict === 'request_changes' && changes.length > 0) verdict = 'request_changes'
  // A request with nothing to change and no failing criterion is an approve, even with
  // a criterion it could not judge: nothing to send the coder back for, and the PR opens
  // as a draft that tells the person what was not checked.
  else verdict = judgedAny ? 'approve' : 'error'
  // Every failing criterion is something to change, even when the reviewer listed none.
  const withCriteria =
    verdict === 'request_changes'
      ? [...changes, ...failing.filter((c) => !changes.some((x) => x.issue.includes(c.criterion))).map((c) => ({ file: '', issue: `Not met: ${c.criterion}`, fix: c.evidence }))].slice(0, MAX_CHANGES)
      : verdict === 'error'
        ? []
        : changes
  return {
    round: args.round,
    head_sha: args.headSha,
    verdict,
    summary: clip(answer.summary, SUMMARY_MAX_CHARS),
    criteria,
    changes: withCriteria,
    model: args.model,
    at: (args.now ?? new Date()).toISOString(),
    diff_cut: args.diffCut,
    file_count: args.fileCount,
    commit_count: args.commitCount,
    ...(verdict === 'error' ? { error: NOTHING_JUDGED_ERROR } : {}),
  }
}

/** An entry for a review that could not run. Pure. */
export function errorEntry(round: number, headSha: string | null, error: string, now = new Date()): ReviewEntry {
  return { round, head_sha: headSha, verdict: 'error', summary: '', criteria: [], changes: [], model: null, at: now.toISOString(), diff_cut: false, error: clip(error, 300) }
}

/** The model a coding run's review runs on: another vendor than the coder (decision 13). */
export function codeReviewerFor(coderModel: string): string | null {
  const reviewer = pickCodeReviewerModel(coderModel)
  return differentVendors(reviewer, coderModel) ? reviewer : null
}

/** Run the reviewer once. Throws when the call fails; usage is logged either way. */
export async function runCodeReview(args: {
  workspaceId: string
  userId: string
  coderModel: string
  message: string
  supabase?: SupabaseClient
}): Promise<{ answer: CodeReviewAnswer; model: string }> {
  const model = codeReviewerFor(args.coderModel)
  if (!model) throw new Error(`no reviewer from another vendor than ${args.coderModel}`)
  const startTime = Date.now()
  let report: UtilityUsageReport | undefined
  let result: UtilityObjectResult<CodeReviewAnswer> | undefined
  try {
    result = await runUtilityTask({
      kind: 'code_review',
      model,
      ...(args.supabase ? { supabase: args.supabase } : {}),
      workspaceId: args.workspaceId,
      userId: args.userId,
      params: { writerModel: args.coderModel },
      message: args.message,
      outputSchema: CodeReviewSchema,
      onUsage: (usage) => {
        report = usage
      },
    })
  } finally {
    await logRunUsage(args.userId, 'code_review', report, result, startTime).catch(() => {})
  }
  return { answer: result.object, model: result.model }
}

// ── The gate: open, send back, or stop ──────────────────────────────────────

export type ReviewGate =
  /**
   * Open the PR; `section` goes at the end of its body. `draft`: it opens as a
   * draft whatever the run's ceiling (a person's run whose diff was cut, or
   * whose review could not run; any run with a criterion the reviewer could
   * not judge).
   */
  | { kind: 'open'; entry: ReviewEntry | null; section: string; draft: boolean }
  /** Send the coder back with the review (finish_run's answer). */
  | { kind: 'changes'; entry: ReviewEntry; roundsLeft: number; message: string; reused: boolean }
  /** Open nothing; settle the run with `reason`. */
  | { kind: 'stop'; entry: ReviewEntry | null; reason: string }

/** request_changes entries on distinct commits, the loop's count. Pure. */
export function requestRounds(trail: readonly ReviewEntry[]): number {
  const shas = new Set<string>()
  let n = 0
  for (const e of trail) {
    if (e.verdict !== 'request_changes') continue
    const key = e.head_sha ?? `round-${e.round}`
    if (shas.has(key)) continue
    shas.add(key)
    n += 1
  }
  return n
}

/**
 * What one review means for the PR. `trail` already holds `entry` when it is
 * new. Pure.
 */
export function decideGate(
  trail: readonly ReviewEntry[],
  entry: ReviewEntry,
  args: { unattended: boolean; branch: string; reused?: boolean },
): ReviewGate {
  if (entry.verdict === 'approve') {
    if (entry.diff_cut) {
      // The reviewer saw only part of the change. An unattended run opens
      // nothing it did not fully review; a person's opens as a draft, labelled.
      if (args.unattended) {
        return {
          kind: 'stop',
          entry,
          reason: `No pull request: the change is longer than the reviewer reads in full, and a run nobody started opens nothing partly reviewed. The work is on ${args.branch}.`,
        }
      }
      return { kind: 'open', entry, section: renderReviewSection(entry, { rounds: requestRounds(trail), partial: true }), draft: true }
    }
    // A criterion it could not judge is not a pass: a person checks it, on a draft.
    const unchecked = entry.criteria.some((c) => criterionState(c) === 'unjudgeable')
    return { kind: 'open', entry, section: renderReviewSection(entry, { rounds: requestRounds(trail) }), draft: unchecked }
  }
  if (entry.verdict === 'error') {
    if (args.unattended) {
      return {
        kind: 'stop',
        entry,
        reason: `No pull request: the reviewer could not run (${entry.error ?? 'unknown error'}), and a run nobody started opens nothing unreviewed. The work is on ${args.branch}.`,
      }
    }
    // A person's run: a DRAFT marked not reviewed, never a ready PR.
    return { kind: 'open', entry, section: renderUnreviewedSection(entry.error ?? 'unknown error', entry.criteria), draft: true }
  }
  if (entry.verdict === 'reject') {
    return { kind: 'stop', entry, reason: `No pull request: the reviewer rejected the change. ${entry.summary} The work is on ${args.branch}.`.replace(/\s+/g, ' ').trim() }
  }
  const rounds = requestRounds(trail)
  if (rounds > MAX_REVIEW_LOOPS) {
    const open = entry.criteria.filter((c) => criterionState(c) === 'fail').map((c) => c.criterion)
    return {
      kind: 'stop',
      entry,
      reason: `No pull request: the reviewer still asked for changes after ${MAX_REVIEW_LOOPS} rounds of fixes.${open.length ? ` Not met: ${open.join('; ')}.` : ''} The work is on ${args.branch}.`,
    }
  }
  const roundsLeft = MAX_REVIEW_LOOPS - rounds
  return { kind: 'changes', entry, roundsLeft, message: renderReviewForCoder(entry, { roundsLeft, reused: args.reused === true }), reused: args.reused === true }
}

// ── What people and the coder read ──────────────────────────────────────────

function oneLine(text: string, max: number): string {
  return clip(text.replace(/`/g, "'"), max)
}

/**
 * Reviewer text written as markdown outside a code span: an @ can't mention
 * anyone and `](` can't open a link (the text is a model's reading of
 * untrusted material). Pure.
 */
export function inertMarkdown(text: string): string {
  return text.replace(/@/g, '&#64;').replace(/\]\(/g, ']&#40;')
}

const VERDICT_WORDS: Record<ReviewVerdict, string> = {
  approve: 'Approved',
  request_changes: 'Changes requested',
  reject: 'Rejected',
}

/** The criteria the reviewer could not judge, under their own heading, each with its reason (markdown lines). Pure. */
function uncheckedLines(criteria: readonly CriterionResult[]): string[] {
  const unchecked = criteria.filter((c) => criterionState(c) === 'unjudgeable')
  if (unchecked.length === 0) return []
  const lines = ['', '**Not checked by the reviewer**', '_It could not judge these from the diff, the files or the commits. Check them yourself before merging._']
  for (const c of unchecked) lines.push(`- ${inertMarkdown(oneLine(c.criterion, 240))}`, `  - Why: ${inertMarkdown(oneLine(c.evidence, EVIDENCE_MAX_CHARS))}`)
  return lines
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * What a pass was checked against, with the fact a person needs to judge it
 * (a "nothing else changed" pass beside five files, a "one commit" pass
 * beside three). Old entries, with no kind, say nothing. Pure.
 */
function checkedAgainst(c: CriterionResult, entry: ReviewEntry): string {
  if (!c.pass || !c.kind) return ''
  if (c.kind === 'content') return "checked against the diff's added lines"
  if (c.kind === 'files') return `checked against the file list${typeof entry.file_count === 'number' ? ` (${plural(entry.file_count, 'file')})` : ''}`
  return `checked against the commit list${typeof entry.commit_count === 'number' ? ` (${plural(entry.commit_count, 'commit')})` : ''}`
}

/** The review as the PR body's last section (markdown). Pure. */
export function renderReviewSection(entry: ReviewEntry, opts: { rounds: number; partial?: boolean }): string {
  const unchecked = entry.criteria.filter((c) => criterionState(c) === 'unjudgeable').length
  const total = entry.criteria.length
  // Lead with what was not checked: an approve with unchecked criteria is not an approval.
  const verdict =
    entry.verdict === 'error'
      ? 'Not reviewed'
      : entry.verdict === 'approve' && unchecked > 0
        ? `Not fully checked: ${unchecked} of ${total} criteri${total === 1 ? 'on' : 'a'}`
        : opts.partial
          ? 'Partially reviewed'
          : VERDICT_WORDS[entry.verdict]
  const after = opts.rounds > 0 ? ` after ${opts.rounds} round${opts.rounds === 1 ? '' : 's'} of fixes` : ''
  const sha = entry.head_sha ? ` at \`${entry.head_sha.slice(0, 12)}\`` : ''
  const lines = [
    '---',
    '### Review',
    `**${verdict}**${sha}${after} by an independent reviewer on another model (${entry.model ?? 'unknown'}). It read the diff, not the coder's summary.${
      entry.verdict === 'approve' && unchecked > 0 ? ` The other ${total - unchecked} passed.` : ''
    }`,
  ]
  if (entry.summary) lines.push('', `> ${inertMarkdown(oneLine(entry.summary, SUMMARY_MAX_CHARS))}`)
  const judged = entry.criteria.filter((c) => criterionState(c) !== 'unjudgeable')
  if (judged.length > 0) {
    lines.push('', '**Acceptance criteria**')
    for (const c of judged) {
      const against = checkedAgainst(c, entry)
      lines.push(`- ${c.pass ? '✅' : '❌'} ${inertMarkdown(oneLine(c.criterion, 240))}`, `  - Evidence${against ? `, ${against}` : ''}: \`${oneLine(c.evidence, EVIDENCE_MAX_CHARS)}\``)
    }
  }
  lines.push(...uncheckedLines(entry.criteria))
  if (entry.diff_cut) {
    lines.push('', opts.partial
      ? '_Partially reviewed: the change is longer than the reviewer reads, so it judged only the part it was shown. Read the rest yourself; it opened as a draft._'
      : '_The diff was longer than the reviewer reads; it judged the part it was shown._')
  }
  return lines.join('\n')
}

/** The heading every review section starts with (the PR body's last section). */
export const REVIEW_SECTION_START = '---\n### Review'

/** A PR body with its review section replaced by `section` (or added). Pure. */
export function withReviewSection(body: string, section: string): string {
  const at = body.lastIndexOf(REVIEW_SECTION_START)
  const kept = (at >= 0 ? body.slice(0, at) : body).trimEnd()
  return kept ? `${kept}\n\n${section}` : section
}

/** The note a PR gets when its branch moved after the review. Pure. */
export function commitsAfterReviewNote(reviewedSha: string, headSha: string | null): string {
  return `> Commits after review: the branch is at \`${(headSha ?? 'unknown').slice(0, 12)}\`, the review read \`${reviewedSha.slice(0, 12)}\`. It opened as a draft; read what changed since.\n\n`
}

/**
 * The PR body's section when the review could not run on a person's run, with
 * the criteria it could not judge when that is why. Pure.
 */
export function renderUnreviewedSection(error: string, criteria: readonly CriterionResult[] = []): string {
  return ['---', '### Review', `**Not reviewed**: the reviewer could not run (${oneLine(error, 200)}). Read the diff yourself before merging.`, ...uncheckedLines(criteria)].join('\n')
}

/** What finish_run tells the coder on request_changes. Pure. */
export function renderReviewForCoder(entry: ReviewEntry, opts: { roundsLeft: number; reused: boolean }): string {
  const lines = [
    opts.reused
      ? 'The reviewer already asked for these changes and your branch has no new commit since. Make them, commit, push, then call finish_run again.'
      : 'An independent reviewer read your diff and asked for changes before the pull request opens. Make them, commit, push, then call finish_run again with the same result.',
    opts.roundsLeft === 0
      ? 'This is the last round: if the next review still asks for changes, no pull request is opened.'
      : `After this, ${opts.roundsLeft} more round${opts.roundsLeft === 1 ? '' : 's'} of changes can be asked before the run stops without a pull request.`,
  ]
  if (entry.summary) lines.push('', `Reviewer: ${entry.summary}`)
  const failing = entry.criteria.filter((c) => criterionState(c) === 'fail')
  if (failing.length > 0) {
    lines.push('', 'Criteria not met:')
    for (const c of failing) lines.push(`- ${c.criterion} (${c.evidence})`)
  }
  if (entry.changes.length > 0) {
    lines.push('', 'Changes to make:')
    for (const c of entry.changes) lines.push(`- ${c.file ? `${c.file}: ` : ''}${c.issue}${c.fix ? ` Fix: ${c.fix}` : ''}`)
  }
  return lines.join('\n')
}

// ── The outcome route's entry point ─────────────────────────────────────────

/** Read a stored trail tolerantly (malformed entries dropped). Pure. */
export function readReviewTrail(raw: unknown): ReviewEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((e): e is ReviewEntry => !!e && typeof e === 'object' && typeof (e as { verdict?: unknown }).verdict === 'string')
}

/**
 * Review a coding run's branch before its PR opens, record the review on the
 * run and say what to do. Never throws.
 */
export async function reviewBeforePr(
  supabase: SupabaseClient,
  args: {
    agentRunId: string
    workspaceId: string
    userId: string
    repoFullName: string
    githubToken: string
    base: string
    head: string
    unattended: boolean
    coderModel?: string
    fetchImpl?: typeof fetch
  },
): Promise<ReviewGate> {
  const gateArgs = { unattended: args.unattended, branch: args.head }
  const { data: row, error } = await supabase
    .from('agent_run')
    .select('review_trail, acceptance_criteria, action_id')
    .eq('id', args.agentRunId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error || !row) {
    // No trail to keep (a database without 393): the loop could not be bounded.
    return decideGate([], errorEntry(1, null, 'the review trail could not be read'), gateArgs)
  }
  const r = row as { review_trail?: unknown; acceptance_criteria?: unknown; action_id?: string | null }
  const trail = readReviewTrail(r.review_trail)
  const criteria = Array.isArray(r.acceptance_criteria) ? normalizeCriteria(r.acceptance_criteria) : []
  const round = trail.length + 1

  let item: ReviewItem = { identifier: args.head, title: '(no work item)', description: null }
  if (r.action_id) {
    const { data: action } = await supabase
      .from('actions')
      .select('id, identifier, title, description')
      .eq('id', r.action_id)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    if (action) {
      const a = action as { id: string; identifier?: string | null; title?: string | null; description?: string | null }
      item = { identifier: a.identifier || a.id, title: a.title ?? '', description: a.description ?? null }
    }
  }

  const diff = await fetchCompareDiff({ repoFullName: args.repoFullName, githubToken: args.githubToken, base: args.base, head: args.head, ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}) })
  let entry: ReviewEntry
  if ('error' in diff) {
    entry = errorEntry(round, null, diff.error)
  } else if (diff.empty) {
    entry = { ...errorEntry(round, diff.headSha, ''), verdict: 'reject', summary: `The branch has no changes against ${args.base}.`, error: undefined }
  } else {
    const last = trail[trail.length - 1]
    if (last && last.head_sha && last.head_sha === diff.headSha && last.verdict !== 'error') {
      // Nothing new since the last review: its answer stands, no second call.
      return decideGate(trail, last, { ...gateArgs, reused: true })
    }
    const coderModel = args.coderModel ?? surfaceModel('coding_runs')
    try {
      const reviewed = await runCodeReview({
        workspaceId: args.workspaceId,
        userId: args.userId,
        coderModel,
        supabase,
        message: buildCodeReviewMessage({ item, criteria, diff, base: args.base, head: args.head }),
      })
      entry = normalizeCodeReview(reviewed.answer, {
        criteria,
        diffText: diff.text,
        paths: diff.paths,
        commitSubjects: diff.commits.subjects,
        fileCount: diff.files,
        commitCount: diff.commits.total,
        model: reviewed.model,
        round,
        headSha: diff.headSha,
        diffCut: diff.cut,
      })
    } catch (err) {
      entry = errorEntry(round, diff.headSha, err instanceof Error ? err.message : String(err))
    }
  }

  const next = [...trail, entry]
  const { data: kept, error: keepErr } = await supabase
    .from('agent_run')
    .update({ review_trail: next })
    .eq('id', args.agentRunId)
    .eq('workspace_id', args.workspaceId)
    .not('status', 'in', '(pr_open,completed,failed,canceled,canceling)')
    .select('id')
  if (keepErr || !kept || kept.length === 0) {
    // A review we could not record can't count toward the loop's bound.
    if (entry.verdict === 'request_changes') return decideGate(next, errorEntry(round, entry.head_sha, 'the review could not be recorded'), gateArgs)
  }
  return decideGate(next, entry, gateArgs)
}
