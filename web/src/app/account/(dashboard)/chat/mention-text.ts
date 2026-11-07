/**
 * Pure helpers for inline `@Label` mentions in the chat textarea.
 *
 * Mentions are plain text tokens (`@Maya Chen`, `@Weekly sync`) that pair with
 * attached entities (contacts, captures). Because labels can be prefixes of
 * one another (`@Maya` vs `@Maya Chen`) and two attached entities can share a
 * label (two contacts named "Alex"), every count/removal here works on a
 * longest-label-first, masked scan so a shorter label never matches inside a
 * longer one, and removal is by occurrence count rather than `includes()`.
 */

// Masked-out matches are overwritten with NUL so they can't re-match (NUL is
// neither `@` nor whitespace, so it never creates a new boundary either).
const MASK = '\u0000'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A mention ends at end-of-text, whitespace, or trailing punctuation. */
function mentionRegex(label: string): RegExp {
  return new RegExp(`@${escapeRegExp(label)}(?=$|\\s|[.,!?;:])`, 'g')
}

function uniqueLongestFirst(labels: string[]): string[] {
  return Array.from(new Set(labels.filter(Boolean))).sort(
    (a, b) => b.length - a.length,
  )
}

/** Display label for a contact mention: name, else email, else "contact". */
export function mentionLabel(c: {
  full_name?: string | null
  email?: string | null
}): string {
  return c.full_name?.trim() || c.email?.trim() || 'contact'
}

/**
 * Replace the `@…` token that starts at `triggerIndex` (up to the next
 * whitespace) with `@Label ` and return the new text plus the cursor position
 * just after the inserted mention.
 */
export function insertMentionAt(
  value: string,
  triggerIndex: number,
  label: string,
): { value: string; cursor: number } {
  const before = value.slice(0, triggerIndex)
  const afterAt = value.slice(triggerIndex)
  const endOfMention = afterAt.search(/\s/)
  const after = endOfMention >= 0 ? afterAt.slice(endOfMention) : ''
  const mention = `@${label}`
  const next = before + mention + (after || ' ')
  return { value: next, cursor: before.length + mention.length + 1 }
}

/**
 * Count occurrences of each `@label` in `text`. Labels are scanned
 * longest-first and each match is masked before shorter labels are counted,
 * so `@Maya` never matches inside `@Maya Chen`.
 */
export function countMentions(
  text: string,
  labels: string[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const l of labels) counts.set(l, 0)
  let masked = text
  for (const label of uniqueLongestFirst(labels)) {
    let n = 0
    masked = masked.replace(mentionRegex(label), (m) => {
      n++
      return MASK.repeat(m.length)
    })
    counts.set(label, n)
  }
  return counts
}

/**
 * Given the previous and next textarea values and the currently attached
 * entities, return the ids whose inline mention was removed. A drop of N in a
 * label's occurrence count detaches N entities with that label, most recently
 * attached first (so two contacts with the same name detach one at a time).
 */
export function diffMentionRemovals(
  prev: string,
  next: string,
  attached: Array<{ id: string; label: string }>,
): string[] {
  if (prev === next || attached.length === 0) return []
  const labels = attached.map((a) => a.label)
  const before = countMentions(prev, labels)
  const after = countMentions(next, labels)
  const removed: string[] = []
  for (const label of uniqueLongestFirst(labels)) {
    const drop = (before.get(label) ?? 0) - (after.get(label) ?? 0)
    if (drop <= 0) continue
    const holders = attached.filter((a) => a.label === label)
    // Most recently attached first.
    for (let i = holders.length - 1, k = 0; i >= 0 && k < drop; i--, k++) {
      removed.push(holders[i].id)
    }
  }
  return removed
}

/**
 * Remove the first unmasked `@label` occurrence from `text` (for the chip's
 * X button). Longer sibling labels are masked first so `@Maya` is not spliced
 * out of `@Maya Chen`. Collapses the resulting double spaces and trims.
 */
export function removeMentionOccurrence(
  text: string,
  label: string,
  allLabels: string[],
): string {
  const longer = uniqueLongestFirst(allLabels).filter(
    (l) => l !== label && l.length > label.length,
  )
  let masked = text
  for (const l of longer) {
    masked = masked.replace(mentionRegex(l), (m) => MASK.repeat(m.length))
  }
  const re = mentionRegex(label)
  const m = re.exec(masked)
  if (!m) return text
  const start = m.index
  const end = start + m[0].length
  // Also eat one following space so "a @X b" → "a b" rather than "a  b".
  const eatSpace = text[end] === ' ' ? 1 : 0
  const next = text.slice(0, start) + text.slice(end + eatSpace)
  return next.replace(/  +/g, ' ').trim()
}
