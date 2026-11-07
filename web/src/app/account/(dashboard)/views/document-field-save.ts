/**
 * The document panel's field saves (document-detail-panel.tsx saveField): an
 * optional optimistic change shown at once, the PATCH, and on a refusal (a 403
 * since migration 359, e.g. a member moving a shared page into a project) or
 * any other failure the optimistic change rolled back and the server's error
 * shown. Pure helpers plus one fetch, so the rollback is testable without the
 * panel.
 */

/** The values `patch`'s keys hold in `row` now (what a rollback restores). */
export function snapshotKeys<T extends object>(row: T, patch: Partial<T>): Partial<T> {
  const out: Partial<T> = {}
  for (const key of Object.keys(patch) as Array<keyof T>) out[key] = row[key]
  return out
}

/**
 * Undo an optimistic `patch`: each key goes back to `before`, unless it no
 * longer holds the optimistic value (a later change won; leave it).
 */
export function rollbackPatch<T extends object>(current: T, before: Partial<T>, patch: Partial<T>): T {
  const next = { ...current }
  for (const key of Object.keys(patch) as Array<keyof T>) {
    if (Object.is(current[key], patch[key])) next[key] = before[key] as T[keyof T]
  }
  return next
}

export type FieldSaveResult =
  | { ok: true; document: Record<string, unknown> | null }
  | { ok: false; status: number; error: string; code?: string; details?: Record<string, unknown> }

/** PATCH /api/account/documents/:id with `updates`; never throws. */
export async function patchDocumentFields(
  documentId: string,
  updates: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<FieldSaveResult> {
  try {
    const res = await fetchImpl(`/api/account/documents/${documentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    const json = (await res.json().catch(() => null)) as
      | { document?: Record<string, unknown>; error?: unknown; code?: unknown; details?: unknown }
      | null
    if (res.ok) return { ok: true, document: json?.document ?? null }
    const error = typeof json?.error === 'string' && json.error ? json.error : `Couldn’t save (${res.status})`
    return {
      ok: false,
      status: res.status,
      error,
      ...(typeof json?.code === 'string' ? { code: json.code } : {}),
      ...(json?.details && typeof json.details === 'object' ? { details: json.details as Record<string, unknown> } : {}),
    }
  } catch {
    return { ok: false, status: 0, error: 'Couldn’t save. Check your connection and try again.' }
  }
}

/**
 * When the panel's save loses the compare-and-swap (409, migration 364), what
 * to do with the person's text: `mine` (what they have now), `base` (the text
 * at the revision they last saved or loaded) and `theirs` (the document now),
 * all three in the editor's own markdown so a formatting-only difference
 * isn't read as an edit.
 *
 *   save     `mine` already holds every change in `theirs` (the editor showed
 *            the agent's edit before they typed): save it on the new revision.
 *   combine  the two touched different lines: the merged text holds both, but
 *            the editor doesn't show theirs yet, so the person is asked.
 *   sections the same lines changed differently, but inside matching `##`
 *            sections (minimal D4, canon documents): every section only one
 *            side changed is taken as it is, and the person picks mine or
 *            theirs for each section both changed ("Dial8 updated
 *            Positioning while you were editing"). No presence, no CRDT
 *            (decision 17, GEN-334).
 *   choose   the same lines changed differently and the sections don't line
 *            up: the person picks the whole text.
 */
export type ConflictPlan =
  | { kind: 'save'; text: string }
  | { kind: 'combine'; text: string }
  | { kind: 'sections'; parts: SectionPart[] }
  | { kind: 'choose' }

/**
 * One part of a document in a section-level conflict (minimal D4, canon
 * documents): the text before the first `##` heading, or one `##` section
 * (its heading and everything under it). A part only one side changed is
 * settled (`text`); a part both changed differently carries both.
 */
export type SectionPart =
  | { heading: string | null; text: string }
  | { heading: string; mine: string; theirs: string; /** Unique within the plan (two sections may share a heading). */ key: string }

/** A document cut into its parts: the preamble, then each `##` section, raw lines kept. Pure. */
export function documentParts(markdown: string): Array<{ key: string; heading: string | null; text: string }> {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const out: Array<{ key: string; heading: string | null; lines: string[] }> = [{ key: '', heading: null, lines: [] }]
  let fence: string | null = null
  for (const line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (f) fence = fence === null ? f[1][0] : fence === f[1][0] ? null : fence
    const h = fence === null && !f ? /^\s{0,3}##[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line) : null
    if (h) out.push({ key: h[1].replace(/\s+/g, ' ').trim().toLowerCase(), heading: h[1].trim(), lines: [line] })
    else out[out.length - 1].lines.push(line)
  }
  // A document that starts with a heading has no preamble: no empty part (it
  // would add a blank first line when the parts are joined again).
  return out.filter((p, i) => i > 0 || p.lines.length > 0).map((p) => ({ key: p.key, heading: p.heading, text: p.lines.join('\n') }))
}

/**
 * The section-level plan when a line merge can't settle it (pure): every
 * version has the same `##` sections in the same order; each part one side
 * changed takes that side, and each part both changed differently is left for
 * the person. Null when the sections themselves differ (one was added,
 * removed or renamed) or the preamble conflicts.
 */
export function planSectionConflict(base: string, mine: string, theirs: string): SectionPart[] | null {
  const [b, m, t] = [documentParts(base), documentParts(mine), documentParts(theirs)]
  const keys = (parts: typeof b) => parts.map((p) => p.key).join('\u0000')
  if (keys(b) !== keys(m) || keys(b) !== keys(t)) return null
  const parts: SectionPart[] = []
  for (let i = 0; i < b.length; i++) {
    const [bb, mm, tt] = [b[i].text, m[i].text, t[i].text]
    if (mm === tt || tt === bb) parts.push({ heading: m[i].heading, text: mm })
    else if (mm === bb) parts.push({ heading: t[i].heading, text: tt })
    else if (m[i].heading === null) return null
    else parts.push({ heading: m[i].heading as string, mine: mm, theirs: tt, key: `${i}` })
  }
  return parts
}

/** The sections a plan leaves for the person, each with its own key. Pure. */
export function conflictingSections(parts: readonly SectionPart[]): Array<{ key: string; heading: string }> {
  return parts.filter((p): p is Extract<SectionPart, { mine: string }> => 'mine' in p).map((p) => ({ key: p.key, heading: p.heading }))
}

/** The document from a section plan and the person's pick per conflicting section, by its key (default: theirs). Pure. */
export function composeSectionChoice(parts: readonly SectionPart[], choices: Readonly<Record<string, 'mine' | 'theirs'>>): string {
  return parts.map((p) => ('mine' in p ? (choices[p.key] === 'mine' ? p.mine : p.theirs) : p.text)).join('\n')
}

export function planConflict(
  base: string,
  mine: string,
  theirs: string,
  merge: (base: string, mine: string, theirs: string) => { ok: true; text: string } | { ok: false },
): ConflictPlan {
  if (theirs === mine) return { kind: 'save', text: mine }
  const merged = merge(base, mine, theirs)
  if (!merged.ok) {
    // The same lines changed: settle it section by section where the
    // sections line up (minimal D4), else the person picks the whole text.
    const parts = planSectionConflict(base, mine, theirs)
    return parts && conflictingSections(parts).length > 0 ? { kind: 'sections', parts } : { kind: 'choose' }
  }
  if (merged.text === mine) return { kind: 'save', text: mine }
  return { kind: 'combine', text: merged.text }
}

/**
 * What the panel does with the person's text when it closes: nothing to keep;
 * 'draft' when a conflict is open (the body save is held, so the text is
 * kept as their draft, never dropped); 'save' when a save is still queued.
 */
export function unmountAction(state: { text: string | null; conflictOpen: boolean; saveQueued: boolean }): 'draft' | 'save' | null {
  if (state.text === null) return null
  if (state.conflictOpen) return 'draft'
  return state.saveQueued ? 'save' : null
}
