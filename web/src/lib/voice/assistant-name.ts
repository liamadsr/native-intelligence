/**
 * The user's name for their assistant (Interactive mode, 2026-10-02): the
 * wake word Interactive mode listens for ("Joseph, can you look something up
 * for me?", ./wake-word) AND the name the main chat agent goes by. Each person
 * sets their own in Settings → Preferences
 * (app/account/settings/assistant-name-section.tsx).
 *
 * READ LOCALLY: the wake word reads the device's copy (./assistant-name-store,
 * localStorage), never a server. Liam, 2026-10-02: "the lookup of the name
 * should not happen on the server side… all the transcriptions are coming in
 * locally anyway… it should not be dependent on anything else." The wake word
 * is matched on the device against the device's own transcripts; the chat
 * learns the name only because each turn's systemContext carries it
 * (`assistantName`), which the prompt builder (src/lib/ai/chat-system-prompt.ts)
 * checks again here, since it comes from the client.
 *
 * SAVED ON THE ACCOUNT (11-01, Liam: switching accounts on the desktop kept
 * the last account's agent): `user_metadata.assistant_name` through the
 * profile PATCH, so each account has its own name on every device; the
 * device's copy follows it (lib/account-setting.ts). The route checks a name
 * here too. So this imports nothing.
 *
 * A name is 1 to ASSISTANT_NAME_MAX characters of letters, spaces, hyphens and
 * apostrophes, at least one of them a letter, with its spaces tidied.
 */

export const DEFAULT_ASSISTANT_NAME = 'Joseph'
export const ASSISTANT_NAME_MAX = 30
/** Where this device keeps its copy of the name (beside the other dial8:voice:* settings). */
export const ASSISTANT_NAME_STORAGE_KEY = 'dial8:voice:assistant-name'
/** Where the account keeps it: its key in `user_metadata` and in the profile GET/PATCH (api/account/profile). */
export const ASSISTANT_NAME_PROFILE_FIELD = 'assistant_name'

export type AssistantNameCheck = { ok: true; name: string } | { ok: false; error: string }

const ALLOWED = /^[\p{L}\p{M}][\p{L}\p{M} '-]*$/u

/** A typed name, checked: tidied (trimmed, single spaces, straight
 *  apostrophes), or why it can't be used. */
export function checkAssistantName(raw: string): AssistantNameCheck {
  const name = raw.replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim()
  if (!name) return { ok: false, error: 'Give your assistant a name.' }
  if ([...name].length > ASSISTANT_NAME_MAX) {
    return { ok: false, error: `Keep it to ${ASSISTANT_NAME_MAX} characters or fewer.` }
  }
  if (!ALLOWED.test(name) || !/\p{L}/u.test(name)) {
    return { ok: false, error: 'Use letters, spaces, hyphens and apostrophes only.' }
  }
  return { ok: true, name }
}

/** A stored value as a name, or null when it isn't a valid one. */
export function sanitizeAssistantName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const checked = checkAssistantName(value)
  return checked.ok ? checked.name : null
}
