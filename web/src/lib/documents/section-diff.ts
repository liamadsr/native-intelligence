/**
 * Sections across two versions of a document (canon D2: "revert just this
 * edit"): a section's body, the one section a change touched, and a section
 * put back as it was. Pure and client-safe: the history panel decides whether
 * an edit can be reverted alone with the same rule the server applies.
 */
import { findSection, insertSectionAfter, parseOutline, removeSection, replaceSection, splitLines, type OutlineEntry } from './markdown-structure'

/** A section's body: the lines under its heading (subsections included). Pure. */
export function sectionBody(content: string, entry: Pick<OutlineEntry, 'line' | 'endLine'>): string {
  return splitLines(content).slice(entry.line, entry.endLine).join('\n').replace(/^\n+|\n+$/g, '')
}

/**
 * The one section a change touched, between two versions of a document: the
 * outermost sections whose text differs. Null when it touched none or more
 * than one (or text outside every section). Pure.
 */
export function changedSection(before: string, after: string): string | null {
  const top = (content: string) => {
    const outline = parseOutline(content)
    const min = outline.reduce((m, e) => Math.min(m, e.level), 7)
    const map = new Map<string, string>()
    for (const e of outline.filter((x) => x.level === min)) map.set(e.path.join(' > ').toLowerCase(), sectionBody(content, e))
    const firstLine = outline.length ? outline[0].line : splitLines(content).length + 1
    return { map, preamble: splitLines(content).slice(0, firstLine - 1).join('\n').trim(), headings: outline.filter((x) => x.level === min).map((x) => x.path.join(' > ')) }
  }
  const a = top(before)
  const b = top(after)
  if (a.preamble !== b.preamble) return null
  const names = new Map<string, string>()
  for (const h of [...a.headings, ...b.headings]) names.set(h.toLowerCase(), h)
  const changed = [...names.keys()].filter((k) => a.map.get(k) !== b.map.get(k))
  return changed.length === 1 ? (names.get(changed[0]) ?? null) : null
}

/**
 * `now` with `section` as it was in `before` (the version before the edit):
 * its body put back; removed when the edit added it; re-added after the
 * section it followed when the edit removed it. Null when the section is in
 * none of the versions. Pure.
 */
export function putSectionBack(now: string, before: string, edited: string, section: string): string | null {
  const nowOutline = parseOutline(now)
  const inNow = findSection(nowOutline, section)
  const beforeOutline = parseOutline(before)
  const inBefore = findSection(beforeOutline, section)
  if (inBefore.ok && inNow.ok) return replaceSection(now, inNow.entry, sectionBody(before, inBefore.entry))
  if (!inBefore.ok && inNow.ok) {
    // The edit added it: take it out again (only when it was the edit's).
    return findSection(parseOutline(edited), section).ok ? removeSection(now, inNow.entry) : now
  }
  if (inBefore.ok && !inNow.ok) {
    // Gone now, but the edit didn't remove it (still there after the edit):
    // renamed or removed later. Putting the old one back would add a stale
    // copy beside its new name, so there is nothing to put back.
    if (findSection(parseOutline(edited), section).ok) return null
    // The edit removed it: put it back after the section it followed.
    const entry = inBefore.entry
    const priorSibling = [...beforeOutline].reverse().find((e) => e.line < entry.line && e.level === entry.level && e.path.slice(0, -1).join('>') === entry.path.slice(0, -1).join('>'))
    const anchor = priorSibling ? findSection(nowOutline, priorSibling.path.join(' > ')) : null
    return insertSectionAfter(now, anchor && anchor.ok ? anchor.entry : null, entry.heading, sectionBody(before, entry), entry.level)
  }
  return null
}
