/**
 * Reconcile a capture summary's proposal markers with the real proposals.
 *
 * The live agent embeds `<!-- proposal:ID -->` markers in the summary markdown
 * to anchor each proposed change to a bullet. In a batch run (the whole
 * transcript processed in one many-step turn) the model sometimes emits markers
 * whose IDs don't match the real DB-generated proposal ids — a predicted/stale
 * id, or a marker for a proposal it never actually staged. The renderer drops a
 * marker that doesn't resolve, and if the marker was the only content on a
 * bullet, the bullet renders EMPTY. Conversely a real proposal with no marker is
 * never anchored.
 *
 * This pure function rewrites the summary so its markers exactly match the set
 * of real proposal ids:
 *   1. Lines whose only content is a (stale or bare) marker are removed.
 *   2. Stale inline markers (real text + bad id) are stripped, text kept.
 *   3. A valid id that's already been anchored once has its REPEAT markers
 *      collapsed — a marker-only repeat line is dropped, an inline repeat is
 *      stripped to text. (The model isn't guaranteed to emit each id exactly
 *      once across its write_summary/update_summary calls, and a repeated marker
 *      renders a duplicate proposal card.)
 *   4. Real proposals never referenced get appended under "## Next Steps".
 *
 * Pure + deterministic so it can be unit-tested; the route persists the result.
 */

const MARKER_GLOBAL = /<!--\s*proposal:([^\s>]+)\s*-->/g
const MARKER_SINGLE = /<!--\s*proposal:([^\s>]+)\s*-->/

export interface RealProposal {
  id: string
  display_text: string | null
}

export function reconcileSummaryMarkers(
  summary: string,
  proposals: RealProposal[],
): string {
  if (!summary) return summary

  const validIds = new Set(proposals.map((p) => p.id))

  // 1) Which valid proposal ids does the summary already reference?
  const referenced = new Set<string>()
  let m: RegExpExecArray | null
  MARKER_GLOBAL.lastIndex = 0
  while ((m = MARKER_GLOBAL.exec(summary)) !== null) {
    if (validIds.has(m[1])) referenced.add(m[1])
  }

  // 2) Clean up lines that contain markers. The normal format the model is told
  //    to use is the marker on its OWN line right after the bullet:
  //        - Do the thing
  //        <!-- proposal:real-1 -->
  //    So a marker-only line is fine WHEN its id is valid AND it's the FIRST
  //    time we've seen that id. We remove a line when:
  //      * its marker is STALE (points at no real proposal) and the line has no
  //        other real text — the "empty bullet" case; or
  //      * its marker is a valid id we've ALREADY kept — a duplicate that would
  //        render a second identical card, and the line has no other real text.
  //    Lines with real text keep their text; stale/duplicate inline markers are
  //    stripped below but the text stays.
  const keptValidIds = new Set<string>()
  let out = summary
    .split('\n')
    .filter((line) => {
      const m = line.match(MARKER_SINGLE)
      if (!m) return true
      const id = m[1]
      const idValid = validIds.has(id)
      if (idValid) {
        if (!keptValidIds.has(id)) {
          keptValidIds.add(id)
          return true // keep the first valid marker (incl. marker-only lines)
        }
        // Duplicate valid marker: drop a marker-only line, keep one with text.
        const textOnly = line.replace(MARKER_GLOBAL, '').replace(/^\s*[-*]\s*/, '').trim()
        return textOnly.length > 0
      }
      // Stale marker: keep the line only if it still has real (non-bullet) text.
      const textOnly = line.replace(MARKER_GLOBAL, '').replace(/^\s*[-*]\s*/, '').trim()
      return textOnly.length > 0
    })
    .join('\n')
    // Strip stale inline markers AND any second+ occurrence of a valid id,
    // leaving the surrounding text. The FIRST valid marker for an id survives;
    // later ones are removed so each proposal anchors exactly one card.
    .replace(MARKER_GLOBAL, ((seen: Set<string>) => (full: string, id: string) => {
      if (!validIds.has(id)) return '' // stale — strip
      if (seen.has(id)) return '' // duplicate valid — strip the marker, keep text
      seen.add(id)
      return full // first valid occurrence — keep
    })(new Set<string>()))

  // 3) Append real proposals the summary never referenced so every proposal is
  //    anchored and shows as a card.
  const orphans = proposals.filter((p) => !referenced.has(p.id))
  if (orphans.length > 0) {
    const lines = orphans
      .map((p) => `- ${p.display_text || 'Proposed change'}\n<!-- proposal:${p.id} -->`)
      .join('\n')
    if (/^##\s+Next Steps\s*$/im.test(out)) {
      out = out.replace(/(^##\s+Next Steps\s*$)/im, `$1\n${lines}`)
    } else {
      out = out.trimEnd() + `\n\n## Next Steps\n\n${lines}`
    }
  }

  return out
}
