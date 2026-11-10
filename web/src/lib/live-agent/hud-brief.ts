/**
 * The pre-call brief in the live agent's HUD (live sidekick plan, Phase 4):
 * a collapsible "Briefing" line (components/live-hud/hud-briefing-line.tsx)
 * with the person's goal for the meeting and their prep's top section.
 *
 * The brief is the signed-in person's own (lib/live-agent/precall-brief.ts),
 * read once per call through the capture route's `?fields=brief` variant,
 * again when the capture is edited (`ni:content-edited` for it) and when a
 * goal is saved on the page (MEETING_GOAL_CHANGED_EVENT). The web
 * HUD reads it in its own page (components/live-hud/in-page-hud-feed.tsx);
 * the desktop's HUD window hears it from the recording window's publisher
 * (components/capture/voice-id-hud-publisher.tsx):
 *   - HUD_BRIEF_EVENT (recording window → HUD, Tauri emitTo): a HudBrief
 *     whenever it changes and again when the HUD says it's listening, or
 *     `{ captureId: null }` when there is none.
 *
 * No brief, no line. Plain text only: it's shown as text, never as HTML.
 *
 * Client-safe: no server imports. Everything that crosses a window is
 * checked, not trusted.
 */

/** Recording window → the HUD (Tauri, emitTo): a HudBrief, or `{ captureId: null }`. */
export const HUD_BRIEF_EVENT = 'live-hud:brief'

/** The longest goal kept (the goal store's own cap). */
export const HUD_BRIEF_GOAL_MAX = 500
/** The longest prep top kept (the server cuts at 1200; a little slack for its ellipsis). */
export const HUD_BRIEF_PREP_MAX = 1300

/** The person's pre-call brief for the call's capture. JSON: it crosses windows. */
export interface HudBrief {
  captureId: string
  /** Their goal, in their words; null when none. */
  goal: string | null
  /** Their prep's title and top section (plain text); null when no prep. */
  prepTitle: string | null
  prepTop: string | null
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * A brief from the route's `brief` (`{ goal, prep: { title, top } }`): null
 * with neither a goal nor a prep top. Pure.
 */
export function hudBriefOf(captureId: string, brief: unknown): HudBrief | null {
  if (!captureId || !brief || typeof brief !== 'object') return null
  const b = brief as { goal?: unknown; prep?: unknown }
  const prep = b.prep && typeof b.prep === 'object' ? (b.prep as { title?: unknown; top?: unknown }) : null
  const goal = text(b.goal, HUD_BRIEF_GOAL_MAX)
  const prepTop = text(prep?.top, HUD_BRIEF_PREP_MAX)
  if (!goal && !prepTop) return null
  return { captureId, goal, prepTitle: prepTop ? text(prep?.title, 200) : null, prepTop }
}

/** `payload` as a brief, or null if it isn't one (none sends `{ captureId: null }`). */
export function readHudBrief(payload: unknown): HudBrief | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (typeof p.captureId !== 'string' || !p.captureId) return null
  return hudBriefOf(p.captureId, { goal: p.goal, prep: { title: p.prepTitle, top: p.prepTop } })
}

export function sameHudBrief(a: HudBrief | null, b: HudBrief | null): boolean {
  return (
    a === b ||
    (!!a && !!b && a.captureId === b.captureId && a.goal === b.goal && a.prepTitle === b.prepTitle && a.prepTop === b.prepTop)
  )
}

/**
 * The prep's markdown as plain reading text: bold/underline markers and
 * heading hashes dropped, list dashes as bullets. Not rendering: the result is
 * shown as text, line breaks kept. Pure.
 */
export function plainBriefText(value: string): string {
  return value
    .split('\n')
    .map((line) =>
      line
        .replace(/\*\*|__/g, '')
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^(\s*)[-*]\s+/, '$1• '),
    )
    .join('\n')
}

/** What the collapsed line says after "Briefing": the goal, else the prep's first line. Pure. */
export function hudBriefLead(brief: HudBrief): string {
  if (brief.goal) return brief.goal.replace(/\s+/g, ' ')
  const first = plainBriefText(brief.prepTop ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  return first ?? ''
}

/** The person's brief for the capture, from its route's light `brief` variant. Null when none, or on any failure. */
export async function fetchHudBrief(captureId: string, signal?: AbortSignal): Promise<HudBrief | null> {
  try {
    const res = await fetch(`/api/account/captures/${encodeURIComponent(captureId)}?fields=brief`, { signal })
    if (!res.ok) return null
    const json = (await res.json()) as { capture?: { brief?: unknown } } | null
    return hudBriefOf(captureId, json?.capture?.brief)
  } catch {
    return null
  }
}
