/**
 * The last answer the person gave an invitation from its card, by the
 * invitation's iCalendar UID, kept in this browser.
 *
 * Why: Outlook takes a declined event off the calendar, so after a reload the
 * calendar has nothing to say about it and the card would read "not on a
 * connected calendar" for an invitation the person just answered. The card
 * remembers the answer it sent and says "You declined" instead.
 *
 * Small on purpose (the newest MAX entries, one localStorage key), this
 * browser only: an answer given in Outlook itself, or on another device, is
 * not known here. Nothing is stored on the server.
 */
export type RememberedAnswer = 'accepted' | 'declined' | 'tentative'

const KEY = 'ni:invite-answers:v1'
const MAX = 100

type Store = Record<string, { a: RememberedAnswer; at: number }>

function read(): Store {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Store) : {}
  } catch {
    return {}
  }
}

export function recallInviteAnswer(uid: string | null | undefined): RememberedAnswer | null {
  if (!uid) return null
  const hit = read()[uid]
  return hit && (hit.a === 'accepted' || hit.a === 'declined' || hit.a === 'tentative') ? hit.a : null
}

export function rememberInviteAnswer(uid: string | null | undefined, answer: RememberedAnswer, now = Date.now()): void {
  if (!uid) return
  try {
    const store = read()
    store[uid] = { a: answer, at: now }
    const kept = Object.entries(store)
      .filter(([, v]) => v && typeof v.at === 'number')
      .sort((x, y) => y[1].at - x[1].at)
      .slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // For this visit only.
  }
}
