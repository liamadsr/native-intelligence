/**
 * What Native Intelligence has learned (plan Part 3, "Memory"; migration 317): the shape of
 * one line of an area's note. Plain data, client-safe: the editor, the chip,
 * the routes, the `remember` tool and the pack loader all read it.
 *
 * A note is the lines of one area and scope:
 *   personal   one person, in one workspace (your tone, how you run projects);
 *   workspace  everyone in it (our ideal prospects, how the team triages).
 * A line is `active` (it loads with the pack) or `proposed` (it waits: a
 * workspace line, for an owner or admin). Its source says where it came from:
 * `told` in chat, `learned` by Native Intelligence (the nightly passes, the capture pass),
 * `edited` in the editor. A personal line Native Intelligence learned is active at once and
 * marked "Native Intelligence noticed this", with a one-tap remove (Liam, 2026-10-17:
 * learning on by default); a workspace line it learned still waits.
 */
import type { AreaKey } from './registry'

export const MEMORY_SCOPES = ['personal', 'workspace'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export const MEMORY_STATUSES = ['active', 'proposed'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

export const MEMORY_SOURCES = ['told', 'learned', 'edited'] as const
export type MemorySource = (typeof MEMORY_SOURCES)[number]

/** The longest line, as migration 317's CHECK holds it. One preference, not an essay. */
export const MEMORY_LINE_MAX_CHARS = 300

/**
 * The most ACTIVE lines one note (an area and scope) holds. Past it a new line
 * is refused with the fix: the loader only shows about 400 tokens anyway, and
 * a note this long has stopped being read.
 */
export const MEMORY_NOTE_MAX_LINES = 50

/**
 * The most proposals one author has waiting in a note: a member's workspace
 * proposals, or Native Intelligence's own (its lines have no author, and count as one).
 * Proposals never count toward MEMORY_NOTE_MAX_LINES, so this keeps them from
 * piling up instead.
 */
export const MEMORY_PROPOSALS_PER_AUTHOR = 10

/**
 * The most lines Native Intelligence learned (no author) one personal note holds, active or
 * waiting. They go live without anyone accepting them (2026-10-17), so this
 * keeps what Native Intelligence noticed from crowding out what the person said: the same
 * allowance its proposals had. Removing one makes room.
 */
export const MEMORY_LEARNED_PER_NOTE = MEMORY_PROPOSALS_PER_AUTHOR

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value)
}

/** One line as the editor, the chip and the routes see it. */
export interface MemoryLine {
  id: string
  area: AreaKey
  scope: MemoryScope
  status: MemoryStatus
  source: MemorySource
  text: string
  /** Who made it; null for a line Native Intelligence learned. */
  created_by: string | null
  created_at: string
  updated_at: string
}

/** The person's standing in the workspace, as far as its notes go. */
export function canManageWorkspaceMemory(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * A line as it is stored: trimmed, its whitespace (newlines included) made
 * single spaces, so one line stays one line wherever it is shown.
 */
export function normalizeMemoryText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * Why a line can't be saved, in words that name the fix, or null when it
 * can. Shared by the tool, the routes and the editor.
 */
export function memoryTextProblem(text: string): string | null {
  if (!text) return 'text is empty: pass the preference itself, in one short sentence.'
  if (text.length > MEMORY_LINE_MAX_CHARS) {
    return `text is ${text.length} characters: keep it to one preference of at most ${MEMORY_LINE_MAX_CHARS} characters.`
  }
  if (looksSensitive(text)) {
    return 'That looks like a password, key, card or account number. Never save secrets or sensitive data in memory.'
  }
  return null
}

/**
 * A rough net for secrets a line must never hold: a password or token given
 * outright, an API key's shape, or a long run of digits (a card or account
 * number). The instructions already say never; this catches the slip.
 */
function looksSensitive(text: string): boolean {
  // A secret given outright: "password: x", "my api key is x", "the password for the VPN is x".
  if (/\b(password|passcode|passwd|api[ _-]?key|secret key|access token|ssn|social security)\b[^.!?\n]{0,40}?\s(is|are)\s+\S/i.test(text)) return true
  if (/\b(password|passcode|passwd|api[ _-]?key|secret key|access token|ssn|social security)\b\s*[:=]/i.test(text)) return true
  // A key's shape: provider prefixes, an AWS access key id, a JWT.
  if (/\b(sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/.test(text)) return true
  if (/\b(AKIA|ASIA)[0-9A-Z]{16}\b/.test(text)) return true
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(text)) return true
  // A long run of digits: a card or account number.
  if (/\b(?:\d[ -]?){13,19}\b/.test(text)) return true
  return false
}

/**
 * Contact details a learned line must not carry: an email address, a link or
 * a phone number. A tone line is about style; these are always content.
 */
export function hasContactDetails(text: string): boolean {
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) return true
  if (/\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|io|ai|net|org|co|app|dev)\b/i.test(text)) return true
  if (/(?:\+?\d[\s().-]?){7,}/.test(text)) return true
  return false
}
