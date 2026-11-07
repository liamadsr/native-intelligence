/**
 * A bot's voice as it's stored (`ai_team_member.voice`, migration 308;
 * docs/plans/bots-v4.md, Phase B2): one of the desktop app's text-to-speech
 * voices, by id, or null for Automatic (a voice dealt from its face,
 * bot-voice.ts). Pure and client-safe: the routes check a request with it, the
 * reads normalise a stored value with it.
 *
 * The shape is the desktop's own: its catalogue spells a voice id in lowercase
 * letters, digits and hyphens, starting with a letter or digit, at most 32 long
 * (dial8-desktop, the local-tts catalogue check). Which voices there are is
 * each device's to say, so nothing here lists them; the migration's CHECK holds
 * the same shape (migration-308.test.ts holds the two together).
 */

/** A voice id, as the desktop's catalogue spells one. */
export const VOICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Whether `value` is shaped like a voice id. */
export function isVoiceId(value: unknown): value is string {
  return typeof value === 'string' && VOICE_ID_PATTERN.test(value)
}

/** A stored voice as the app reads it: a voice id, else null (Automatic). */
export function asVoiceId(value: unknown): string | null {
  return isVoiceId(value) ? value : null
}

export type VoiceChoice = { ok: true; voice: string | null } | { ok: false; error: string }

/** Why a request's `voice` was refused, in the words a 400 carries. */
export const VOICE_ERROR = 'voice must be a voice id, or null for Automatic'

/** A request's `voice`: one voice id, or null for Automatic. Anything else is refused. */
export function parseVoice(value: unknown): VoiceChoice {
  if (value === null) return { ok: true, voice: null }
  return isVoiceId(value) ? { ok: true, voice: value } : { ok: false, error: VOICE_ERROR }
}
