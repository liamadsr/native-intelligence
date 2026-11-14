/**
 * An edit job's results, client-safe and pure: whether it offers "Open pull
 * request", the follow-up that asks for one, the unified diff the Mac hands
 * the Changes view (tauri-bridge.ts `local_agent_diff`) read as rows, and the
 * person's review notes on it as ONE follow-up message.
 *
 * Nothing here is stored: the diff is read from the Mac on demand, and the
 * notes live only in the view until they go to the job as a message.
 */
import type { DiffLine } from '@/lib/documents/line-diff'
import { isGithubPullRequestUrl } from './pull-request'
import type { LocalAgentStatus } from './store'

/** What "Open pull request" sends the job: the agent writes the description, and the Mac still asks before anything is pushed. */
export const OPEN_PULL_REQUEST_MESSAGE =
  'Open a pull request for this work: call finish with pull_request, with a title and a description of what changed and why.'

/** The session fields the result actions read. */
export interface ResultSession {
  status: LocalAgentStatus
  mode: 'read' | 'edit'
  branch: string | null
  prUrl?: string | null
  lastSignal: 'ask' | 'finish' | null
}

/**
 * "Open pull request" shows for a finished edit job with a branch and no pull
 * request, which can take a message: its turn ended (waiting, no question
 * open), nothing is open on the Mac (a push prompt already asks), and it
 * hasn't ended. Pure.
 */
export function offersPullRequest(s: ResultSession, opts: { promptOpen?: boolean } = {}): boolean {
  if (s.mode !== 'edit' || !s.branch) return false
  if (isGithubPullRequestUrl(s.prUrl)) return false
  if (s.status !== 'waiting' || s.lastSignal === 'ask') return false
  return !opts.promptOpen
}

// ── The diff, read ──────────────────────────────────────────────────────────

/** A row of a file's diff: a line (with its numbers on each side), or a hunk's start. */
export type PatchRow = DiffLine | { kind: 'hunk'; header: string }

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/**
 * A unified diff (one file's, as `git diff` prints it) as rows: the file
 * headers before the first hunk are skipped, `\ No newline at end of file`
 * too; every line carries its old and new line numbers. Pure.
 */
export function parseUnifiedPatch(patch: string): PatchRow[] {
  const rows: PatchRow[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const raw of patch.split('\n')) {
    const hunk = HUNK_RE.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      rows.push({ kind: 'hunk', header: raw })
      continue
    }
    if (!inHunk || raw.startsWith('\\')) continue
    const mark = raw[0]
    const text = raw.slice(1)
    if (mark === '+') rows.push({ kind: 'added', text, newLine: newLine++ })
    else if (mark === '-') rows.push({ kind: 'removed', text, oldLine: oldLine++ })
    else if (mark === ' ') rows.push({ kind: 'same', text, oldLine: oldLine++, newLine: newLine++ })
    // An empty string is the patch's trailing newline, not a line of the file.
  }
  return rows
}

/** A file with more diff lines than this opens collapsed. */
export const LARGE_FILE_LINES = 400

/** A file's diff starts collapsed: a long one, so the list stays readable. Pure. */
export function startsCollapsed(file: { additions: number; deletions: number; patch: string }): boolean {
  if (file.additions + file.deletions > LARGE_FILE_LINES) return true
  let lines = 0
  for (let i = 0; i < file.patch.length; i++) if (file.patch.charCodeAt(i) === 10 && ++lines > LARGE_FILE_LINES) return true
  return false
}

// ── Review notes ────────────────────────────────────────────────────────────

/** A note on the changes: on one line of a file, or on the whole file (`line` null). */
export interface ReviewNote {
  id: string
  path: string
  /** The line it is on: its number on the new side, or the old side for a removed line. */
  line: number | null
  side?: 'new' | 'old'
  /** The line's code, as the diff shows it (a line note only). */
  excerpt?: string
  text: string
}

/** At most this many notes go in one message, each at most NOTE_MAX characters. */
export const NOTES_MAX = 50
export const NOTE_MAX = 2000
/** A line's code in the message, at most this many characters. */
export const EXCERPT_MAX = 500
/** The message route's limit (store.ts LOCAL_AGENT_MESSAGE_MAX_BYTES), with room to spare. */
export const NOTES_MESSAGE_MAX_BYTES = 15_000

/** Control characters out (a tab kept where `keepTab`): a file name may hold a newline, git allows it. */
export function stripControl(text: string, opts: { keepTab?: boolean; keepNewline?: boolean } = {}): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    const control = c < 0x20 || (c >= 0x7f && c < 0xa0) || c === 0x2028 || c === 0x2029
    if (!control || (opts.keepTab && ch === '\t') || (opts.keepNewline && ch === '\n')) out += ch
  }
  return out
}

/** Where a note points, as the view shows it (control characters out of the path). */
export function noteWhere(n: Pick<ReviewNote, 'path' | 'line' | 'side'>): string {
  const path = stripControl(n.path)
  if (n.line === null) return `${path} (the whole file)`
  return n.side === 'old' ? `${path}, removed line ${n.line}` : `${path}, line ${n.line}`
}

/** Where a note points in the message: the path JSON-quoted, so no file name can read as the message's own text. */
function noteWhereQuoted(n: Pick<ReviewNote, 'path' | 'line' | 'side'>): string {
  const path = JSON.stringify(stripControl(n.path))
  if (n.line === null) return `File ${path} (the whole file)`
  return n.side === 'old' ? `File ${path}, removed line ${n.line}` : `File ${path}, line ${n.line}`
}

/** A code fence the text can't close: one backtick longer than its longest run, at least three. */
export function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * The person's notes as ONE follow-up message to the job: each note with its
 * file (JSON-quoted) and line, the line's code in a fence it can't close,
 * then the note, in the order the files and lines read. Control characters
 * are taken out of paths and code; a note's own lines are indented under
 * its number. Null when there is nothing to send. Pure.
 */
export function reviewNotesMessage(notes: readonly ReviewNote[]): string | null {
  const kept = notes.map((n) => ({ ...n, text: stripControl(n.text, { keepTab: true, keepNewline: true }).trim() })).filter((n) => n.text)
  if (kept.length === 0) return null
  const ordered = [...kept].sort(
    (a, b) => a.path.localeCompare(b.path) || (a.line ?? -1) - (b.line ?? -1) || (a.side === 'old' ? 0 : 1) - (b.side === 'old' ? 0 : 1),
  )
  const indent = (text: string) => text.split('\n').map((l) => `   ${l}`).join('\n')
  const items = ordered.map((n, i) => {
    const lines = [`${i + 1}. ${noteWhereQuoted(n)}:`]
    const code = n.line !== null && typeof n.excerpt === 'string' ? stripControl(n.excerpt, { keepTab: true }).slice(0, EXCERPT_MAX) : ''
    if (code.trim()) {
      const fence = fenceFor(code)
      lines.push(indent([fence, code, fence].join('\n')))
    }
    lines.push(indent(n.text))
    return lines.join('\n')
  })
  return ['Review notes on your changes. Please address each one, then tell me what you changed:', '', items.join('\n\n')].join('\n')
}

/** The notes fit in one message. */
export function notesFit(message: string): boolean {
  return new TextEncoder().encode(message).length <= NOTES_MESSAGE_MAX_BYTES
}
