/**
 * A document's history as editing sessions (docs/plans/doc-editor-extras.md,
 * phase 4): the versions of one author with less than SESSION_GAP_MS between
 * one change and the next are one session. Worked out from the history rows
 * the list already has; nothing is stored. Client-safe and pure.
 */
import type { RevisionSummary } from './revision-format'

/** A gap this long between two changes starts a new session. */
export const SESSION_GAP_MS = 30 * 60 * 1000

export interface RevisionSession {
  /** The newest version's number: stable while the session grows. */
  key: string
  /** Newest first, as the list shows them. */
  revisions: RevisionSummary[]
  author_kind: string | null
  author_name: string | null
  /** When the session's first change began, and its last one ended. */
  started_at: string
  ended_at: string
}

function authorOf(r: RevisionSummary): string {
  return `${r.author_kind ?? 'baseline'}:${r.author_id ?? r.author_name ?? ''}`
}

const time = (iso: string) => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/** Group a newest-first history into sessions, newest first. */
export function groupRevisionSessions(revisions: readonly RevisionSummary[], gapMs = SESSION_GAP_MS): RevisionSession[] {
  const out: RevisionSession[] = []
  let current: RevisionSession | null = null
  for (const r of revisions) {
    const last: RevisionSummary | undefined = current?.revisions[current.revisions.length - 1]
    // The older change (r) ended before the newer one (last) began.
    const sameSession =
      current !== null &&
      last !== undefined &&
      authorOf(last) === authorOf(r) &&
      // A baseline (the text before history began) is always its own.
      r.author_kind !== null &&
      time(last.created_at) - time(r.updated_at) < gapMs
    if (sameSession && current) {
      current.revisions.push(r)
      current.started_at = r.created_at
    } else {
      current = {
        key: String(r.revision_number),
        revisions: [r],
        author_kind: r.author_kind,
        author_name: r.author_name,
        started_at: r.created_at,
        ended_at: r.updated_at,
      }
      out.push(current)
    }
  }
  return out
}

/** A fork's name: "<title> (version N)". */
export function forkTitle(title: string | null | undefined, revisionNumber: number): string {
  const base = (title ?? '').trim() || 'Untitled document'
  return `${base} (version ${revisionNumber})`.slice(0, 500)
}

/** A file name for a document's markdown: its title, made safe for any file system. */
export function markdownFileName(title: string | null | undefined): string {
  const base = (title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
  return `${base || 'Untitled document'}.md`
}

/** The markdown a document downloads as: its title as a heading, then its body. */
export function documentMarkdown(title: string | null | undefined, body: string | null | undefined): string {
  const heading = (title ?? '').trim()
  const text = (body ?? '').replace(/\s+$/, '')
  // A body that already opens with the title as a heading isn't given it twice.
  if (!heading || new RegExp(`^#\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\n|$)`).test(text)) return `${text}\n`
  return `# ${heading}\n\n${text}\n`
}
