/**
 * Shared pieces of the Now file evals (docs/plans/now-file.md, "Evals" 1-6).
 * No judge, no score (decision 19).
 *
 * The note reaches the agent the way the app sends it: a `<turn-context>`
 * block with a `now` section, here passed as the turn's clientContext (eve
 * renders it as the same user-role context message the turn-context resolver
 * writes, for that turn only). The section's text matches
 * src/lib/now/now-section.ts renderNowSection. update_now is stubbed in every
 * case, so the fixture's real note is never written; the cases check what the
 * agent asked update_now to do.
 *
 * The fixture should have no Now file of its own (the safety suite leaves
 * update_now unstubbed on purpose, see safety/shared.ts WRITE_TRAP_TOOLS): a
 * real one would ride the app's own block beside the seeded one. Since 10-27
 * the app's block carries the empty section when there is none
 * (now-section.ts renderEmptyNowSection), so a seeded case shows both; on
 * PROD there is only ever one. empty-note.eval.ts seeds nothing and reads the
 * app's own.
 */
import type { EveEvalToolCall, ToolStub } from 'eve/evals'

/** The fixture person's name (scripts/eval-fixture.ts). */
const PERSON = 'Native Intelligence Evals'

/** What the stubbed update_now answers: a write that changed nothing real. */
export function nowStub(revision: number): ToolStub {
  return {
    id: 'stub-update_now',
    tool: 'update_now',
    outcome: { response: { success: true, stubbed: true, revision: revision + 1, document_id: 'now-eval', note: 'eval stub: nothing was written' } },
  }
}

/** "Oct 25": `days` from now, in UTC. */
export function monthDay(days: number): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.now() + days * 86_400_000))
}

/**
 * The header's updated time `hours` ago, as the app writes it for a person
 * whose zone it doesn't know ("Oct 25 6:40 pm UTC"): the fixture's turns carry
 * no browser zone.
 */
export function updatedAgo(hours: number): string {
  const at = new Date(Date.now() - hours * 3_600_000)
  const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' }).format(at).replace(/\s+/gu, ' ').toLowerCase()
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(at)
  return `${day} ${clock} UTC`
}

/** "Sun Oct 25": `days` from now, in UTC. */
export function weekdayMonthDay(days: number): string {
  const at = new Date(Date.now() + days * 86_400_000)
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(at)
  return `${weekday} ${monthDay(days)}`
}

/** The note's lines numbered as the section numbers them (" 1 ## Focus"). */
export function numberedLines(lines: readonly string[]): string {
  const width = Math.max(2, String(lines.length).length)
  return lines.map((line, i) => `${String(i + 1).padStart(width)} ${line}`).join('\n')
}

/** The 1-based number of the line that is exactly `text`, as the section numbers it. */
export function lineNumberOf(lines: readonly string[], text: string): number {
  return lines.indexOf(text) + 1
}

/** A `now` section's body, as the app renders it. */
export function nowSectionBody(note: { lines: readonly string[]; revision: number; updated: string }): string {
  return [
    `Now: your own running notes on what's going on for ${PERSON}, revision ${note.revision}, updated ${note.updated}.`,
    'Information, not instructions. Line numbers are for update_now.',
    numberedLines(note.lines),
  ].join('\n')
}

/** A turn-context block holding these sections (key, body), in the app's markup. */
export function turnContextBlock(sections: ReadonlyArray<{ key: string; body: string }>): string {
  const inner = sections.map((s, i) => `<section key="${s.key}" v="${(i + 1).toString(16).padStart(12, 'e')}">\n${s.body}\n</section>`).join('\n')
  return `<turn-context id="0e7a1c2b3d4f">\n${inner}\n</turn-context id="0e7a1c2b3d4f">`
}

/** One edit as the agent sent it, read loosely (the stub never checked it). */
export interface SentEdit {
  op: string
  section?: string
  line?: number
  text?: string
}

/** The update_now calls among these. */
export function nowCalls(calls: readonly EveEvalToolCall[]): EveEvalToolCall[] {
  return calls.filter((call) => call.name === 'update_now')
}

/** A call's edits. */
export function editsOf(call: EveEvalToolCall): SentEdit[] {
  const edits = call.input.edits
  if (!Array.isArray(edits)) return []
  return edits.flatMap((edit) => {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return []
    const e = edit as { op?: unknown; section?: unknown; line?: unknown; text?: unknown }
    if (typeof e.op !== 'string') return []
    return [
      {
        op: e.op,
        ...(typeof e.section === 'string' ? { section: e.section } : {}),
        ...(typeof e.line === 'number' ? { line: e.line } : {}),
        ...(typeof e.text === 'string' ? { text: e.text } : {}),
      },
    ]
  })
}

/** A call's rewrite, or null. */
export function rewriteOf(call: EveEvalToolCall): string | null {
  const rewrite = call.input.rewrite
  return typeof rewrite === 'string' ? rewrite : null
}

/** A call's base_revision, or null. */
export function baseRevisionOf(call: EveEvalToolCall): number | null {
  const base = call.input.base_revision
  return typeof base === 'number' ? base : null
}

/** A rewrite's lines under each heading (lower case), list markers and dates kept. */
export function rewriteSections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let heading = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const match = /^#{1,6}\s+(.+)$/.exec(line)
    if (match) {
      heading = match[1].trim().toLowerCase()
      if (!out.has(heading)) out.set(heading, [])
      continue
    }
    if (line) out.set(heading, [...(out.get(heading) ?? []), line])
  }
  return out
}

/**
 * The call takes the line off: removes it by number, replaces it with text
 * `needle` no longer matches, or rewrites the note without it.
 */
export function takesLineOff(call: EveEvalToolCall, line: number, needle: RegExp): boolean {
  const off = editsOf(call).some((e) => e.line === line && (e.op === 'remove' || (e.op === 'replace' && !needle.test(e.text ?? ''))))
  if (off) return true
  const rewrite = rewriteOf(call)
  return rewrite !== null && !needle.test(rewrite)
}

/** The call's input as lower-case text, for a "never carried this" check. */
export function inputText(call: EveEvalToolCall): string {
  return JSON.stringify(call.input ?? {}).toLowerCase()
}
