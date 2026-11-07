/**
 * The Prospecting → chat handoff.
 *
 * The "Learn about my company" buttons on the Prospecting page don't own a chat
 * — the docked chat strip beside the page does (Liam's decision 2: Scout shares
 * the tab the user is already on, no separate tab). So the page DISPATCHES a
 * window event and the shell's listener (dashboard-shell.tsx) forwards it to the
 * active tab's ChatPanel, exactly like `dial8:chat-about-proposal`,
 * `dial8:trigger-skill` and the other four pairs.
 *
 * Keeping the name, the detail shape and the dispatcher in one module means the
 * UI package imports a function rather than hand-rolling a CustomEvent — the two
 * sides can't drift on the string or the payload.
 */

/** Window event name. Listened for in dashboard-shell.tsx. */
export const PROSPECTING_START_EVENT = 'dial8:prospecting-start'

export interface ProspectingStartDetail {
  /** The company domain we already know (from the signed-in email or the typed
   *  form). `null` when we don't — Scout then asks for it with ask_user. */
  domain: string | null
  /** Whether the workspace already has a source company row. `false` → Scout
   *  establishes it (spending on research_my_company); `true` → it can resolve
   *  the existing profile without spending. */
  sourceEstablished: boolean
  /** An existing list to continue, when the entry point knows one. */
  listId?: string
}

/**
 * Fire the handoff. Safe to call during SSR (no-ops without a window).
 */
export function startProspectingChat(detail: ProspectingStartDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<ProspectingStartDetail>(PROSPECTING_START_EVENT, { detail }),
  )
}

/**
 * The seeded first turn Scout receives. Deterministic, so both the panel and its
 * test read the same string — and so the wording (which the skill prompt keys
 * off: "Learn about my company", the domain, whether a source already exists)
 * can't drift between the two.
 *
 * The domain is normalised to a bare host: the form accepts what the user types
 * and the signed-in email suggestion arrives bare, so a pasted URL shouldn't
 * reach the model as `https://acme.com/pricing`.
 */
export function buildProspectingSeedText(detail: ProspectingStartDetail): string {
  const domain = normalizeSeedDomain(detail.domain)
  const lines = [
    'Learn about my company.',
    `Domain: ${domain ?? 'unknown'}.`,
    `Source company established: ${detail.sourceEstablished ? 'yes' : 'no'}.`,
  ]
  if (detail.listId) lines.push(`Continue prospect list: ${detail.listId}.`)
  return lines.join(' ')
}

/** Bare host from whatever the entry point had — `null` when there's nothing. */
export function normalizeSeedDomain(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null
  // Strip scheme, any userinfo/@, then path/query/hash and a trailing dot.
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  const host = withoutScheme.split(/[/?#]/)[0].split('@').pop() ?? ''
  const cleaned = host.replace(/\.+$/, '')
  return cleaned || null
}

/** The slug of the system skill that drives this flow: seeded as `scout` by
 *  migration 253, renamed by 322 so the model reads it as steps, not a persona. */
export const PROSPECT_LIST_SKILL_SLUG = 'build-prospect-list'

/**
 * Skills that stay ARMED across turns.
 *
 * Every other skill clears the moment its message is sent — it was a one-shot
 * mode for one turn. Building a prospect list is a conversation: the skill's
 * steps and its `preferred_tools` are what put the prospecting tools
 * in the model's ACTIVE set. Without stickiness the second turn of every Scout
 * chat went out with no skillId, the model called `list_prospect_entries` from
 * memory, the route answered NoSuchToolError ("An error occurred." in the
 * transcript), and it burned a step re-discovering the tools — seen on every
 * turn of the DEV smoke. The chip's own × still clears it explicitly.
 */
export const STICKY_SKILL_SLUGS: ReadonlySet<string> = new Set([PROSPECT_LIST_SKILL_SLUG])

export function isStickySkill(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && STICKY_SKILL_SLUGS.has(slug)
}

// ─── "Ask about this list" (B7) ────────────────────────────────────────────────────────
// A SECOND handoff, with the opposite posture to the one above.
//
// `dial8:prospecting-start` auto-sends a seeded turn: the user pressed a button
// that means one specific thing ("learn about my company"), so there is nothing
// left to ask. "Ask about this list" is the other case — the user has rows selected and a
// question of their own. Sending anything on their behalf would be a guess, and
// a wrong guess here spends money. So this event only ARMS the composer: it
// selects the prospect-list skill (so the turn runs in its tool allowlist), focuses the
// input, and drops a hint naming what's selected. The user types and sends.
//
// The selection itself does NOT ride on this event. It reaches the model
// through the per-turn system context (selection-context.ts → the tab's
// systemContext → the "## Prospecting selection" prompt block), which stays
// live for EVERY turn of the conversation — including the fourth follow-up,
// long after this event is forgotten. Duplicating the ids here would create a
// second, staler copy of the same fact.

/** Window event name. Listened for in dashboard-shell.tsx, beside the start event. */
export const PROSPECTING_ASK_EVENT = 'dial8:prospecting-ask'

export interface ProspectingAskDetail {
  /** The list the user is on — only used for the composer hint's wording. */
  listId: string
  listName: string
  /** How many rows are selected right now (0 is legal: "ask about this list"). */
  selectedCount: number
}

/**
 * Arm the composer for a question about the current selection. Safe during SSR.
 */
export function askAboutList(detail: ProspectingAskDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<ProspectingAskDetail>(PROSPECTING_ASK_EVENT, { detail }),
  )
}

/**
 * The placeholder shown in the composer once the list is asked about. Deterministic so
 * the button, the panel and the test all read the same string.
 */
export function buildAskAboutListHint(detail: ProspectingAskDetail): string {
  const n = detail.selectedCount
  if (n <= 0) return `Ask about ${detail.listName}…`
  return `Ask about the ${n} selected ${n === 1 ? 'row' : 'rows'}…`
}

// ─── "Find email" (the contact panel's email row) ────────────────────────────
// A THIRD handoff, and the only one that starts outside Prospecting.
//
// It lives here anyway because it is the same mechanism, not a new one: a
// button in a subtree that owns no chat dispatches a window event, the shell
// forwards it to the active tab's ChatPanel, and the panel arms a system skill
// by slug and auto-sends a seeded turn. Splitting it into a second module would
// duplicate that shape without separating anything — the shell already imports
// this file for the other two.
//
// Posture: AUTO-SEND, like `dial8:prospecting-start` and unlike "Ask about this list".
// The click means one specific thing ("find this person's work email"), so
// there is nothing left to ask — and the seed says the user clicked, which is
// what authorizes the skill to save without a second confirmation. Unlike
// Scout, the skill is NOT sticky: finding an email is one turn's work, and the
// user's next message in that thread is usually about something else.

/** Window event name. Listened for in dashboard-shell.tsx. */
export const FIND_CONTACT_EMAIL_EVENT = 'dial8:find-contact-email'

/** The slug of the system skill that drives this flow (migration 263). */
export const FIND_EMAIL_SKILL_SLUG = 'find-email'

export interface FindContactEmailContext {
  /** The contact to write the address onto — the seed passes it verbatim so the
   *  skill never has to guess which row it is looking at. */
  contactId: string
  contactName: string
  /** Everything below is a search anchor, and every one of them is optional
   *  because a CRM row can be as thin as a name. The seed omits what is absent
   *  rather than sending "unknown", so the model isn't told a blank is a fact. */
  jobTitle?: string | null
  companyName?: string | null
  companyDomain?: string | null
  linkedinUrl?: string | null
}

/**
 * Fire the handoff. Safe to call during SSR (no-ops without a window).
 */
export function startFindContactEmail(detail: FindContactEmailContext): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<FindContactEmailContext>(FIND_CONTACT_EMAIL_EVENT, { detail }),
  )
}

/**
 * The seeded first turn. Deterministic, so the panel and its test read the same
 * string.
 *
 * The opening clause is load-bearing: "The user clicked Find email" is what the
 * skill's prompt keys off to save the address without asking again. Reword it
 * and the skill drops back to presenting-and-offering, which is the wrong
 * behaviour for a button.
 */
export function buildFindEmailSeedText(detail: FindContactEmailContext): string {
  let who = `${detail.contactName} (contact_id ${detail.contactId})`
  if (detail.jobTitle) who += `, ${detail.jobTitle}`
  if (detail.companyName) who += ` at ${detail.companyName}`
  const domain = normalizeSeedDomain(detail.companyDomain)
  if (domain) who += ` (${domain})`
  if (detail.linkedinUrl) who += `; LinkedIn ${detail.linkedinUrl}`
  return `The user clicked Find email on the contact ${who}. Find their work email and save it to the contact.`
}
