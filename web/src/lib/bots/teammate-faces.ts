/**
 * The bot character each AI teammate starts with (`ai_team_member.bot_character`,
 * migration 294; docs/plans/bot-characters.md, "Step 3").
 *
 * The database hands the starting faces out: `default_bot_character` for the
 * system and role teammates, `free_bot_character` for the rest, called by the
 * seeds, the insert default (a trigger filling any new row's empty face) and
 * the backfill. This is the app's copy of those two, held to the migration by
 * teammate-faces-parity.test.ts.
 *
 * They are where a teammate starts, not rules. Any character can go on
 * any teammate and be changed at any time; two teammates of a workspace may
 * wear the same one (the app warns, the database allows it).
 *
 *   - System and role teammates start on the same face in every workspace, so
 *     you learn who's who.
 *   - Email (the envelope) starts as the one email face: the Correspondent's, or the Mail
 *     area face's in a workspace with no Correspondent.
 *   - Any other teammate starts on the first face in the crew's order that
 *     nobody in its workspace wears yet, past the reserved ones
 *     (RESERVED_BOT_CHARACTERS: the Assistant's `chat`, bots-v4.md decision 7,
 *     and the area faces' own, migration 318).
 *
 * Only the package's types, through bot-characters.ts, so server code can read
 * it without the canvas renderer.
 */
import { BOT_CHARACTERS, isBuiltBotId, type BotCharacterType } from '@/lib/bots/bot-faces'
import type { WorkRole } from '@/lib/work/roles'
import type { SystemTeammateKey } from '@/lib/work/system-teammates'
import { AGENT_FACE, withoutAreaFaces, type AgentFaceFacts } from './agent-face'

/**
 * The face each system teammate starts with (migration 318's
 * default_bot_character): the area faces, and the Assistant. Captures keeps
 * Triage's face, which it took over in place.
 */
export const SYSTEM_TEAMMATE_FACES: Readonly<Record<SystemTeammateKey, BotCharacterType>> = {
  captures: 'triage',
  mail: 'mail',
  prospecting: 'scout',
  evals: 'coach',
  crm: 'deals',
  assistant: AGENT_FACE,
}

/** The face each role's default teammate (its oldest holder) starts with. */
export const ROLE_TEAMMATE_FACES: Readonly<Record<WorkRole, BotCharacterType>> = {
  researcher: 'research',
  writer: 'writer',
  correspondent: 'mail',
  developer: 'dev',
}

/** Every character, in the crew's order (the order the crew stands in, and the column's CHECK). */
export const BOT_CHARACTER_ORDER: readonly BotCharacterType[] = BOT_CHARACTERS.map((c) => c.type)

/**
 * Faces no teammate starts on but the one they're kept for (bots-v4.md
 * decision 7, migration 318): `chat`, the catalogue's Assistant, is the
 * Assistant system teammate's (migration 310), and the area faces' own are
 * theirs (Captures, Prospecting, Evals, CRM). Mail's envelope is not
 * reserved: it is the one email face, which a Correspondent wears too. Anyone
 * may still put a reserved face on a teammate by hand; no default hands it
 * out. The face picker never offers `chat` to anyone (one face: it is the
 * agent's alone, agent-face.ts) but a teammate already wearing it.
 */
export const RESERVED_BOT_CHARACTERS: ReadonlySet<BotCharacterType> = new Set<BotCharacterType>([
  SYSTEM_TEAMMATE_FACES.assistant,
  SYSTEM_TEAMMATE_FACES.captures,
  SYSTEM_TEAMMATE_FACES.prospecting,
  SYSTEM_TEAMMATE_FACES.evals,
  SYSTEM_TEAMMATE_FACES.crm,
])

/** The order a free face is picked in: the crew's order, past the reserved faces (`free_bot_character`). */
export const FREE_BOT_CHARACTER_ORDER: readonly BotCharacterType[] = BOT_CHARACTER_ORDER.filter((type) => !RESERVED_BOT_CHARACTERS.has(type))

const TYPES: ReadonlySet<string> = new Set(BOT_CHARACTER_ORDER)

/**
 * Faces in the order the crew stands in: the characters among them in the
 * crew's order, then any built bots, by id (so everything that orders a cast,
 * here and in the desktop's overlay, agrees). Each once.
 */
export function inCrewOrder(faces: Iterable<BotCharacterType>): BotCharacterType[] {
  const on = new Set(faces)
  const characters = BOT_CHARACTER_ORDER.filter((type) => on.delete(type))
  return [...characters, ...[...on].sort()]
}

/** Whether `value` names something a teammate can wear: one of the characters, or a bot built from parts (a column value is only a string). */
export function isBotCharacterType(value: unknown): value is BotCharacterType {
  return typeof value === 'string' && (TYPES.has(value) || isBuiltBotId(value))
}

/** A stored face as the app draws it: the character, or null for none (or a value it doesn't know). */
export function asBotCharacter(value: unknown): BotCharacterType | null {
  return isBotCharacterType(value) ? value : null
}

/** What drawnBots reads of a roster entry. */
export type FacedRosterEntry = { reachable?: boolean | null } & AgentFaceFacts

/**
 * The bots the crew, the roamers and the desktop's cast draw
 * (teammate-bots.ts teammateFaces): the reachable ones, and the ones the reach
 * read couldn't say of (`null`: it failed). One you may not talk to (`false`,
 * a private team's an owner or admin sees) or a roster read without a user
 * (absent) isn't drawn. Drawing an unknown one is the soft side of a failed
 * read: its bubble's chat is refused at the mint, rather than every custom and
 * work bot vanishing until the next read (review of #650). One face
 * (agent-face.ts): no area face is drawn while its workspace's Assistant is, and every Assistant wears the
 * agent's one look whatever its row says.
 */
export function drawnBots<T extends FacedRosterEntry>(roster: readonly T[]): T[] {
  return withoutAreaFaces(roster).filter((t) => t.reachable === true || t.reachable === null)
}

/** The face a system or role teammate starts with; the system key wins. Null for any other teammate. */
export function defaultBotCharacter(
  systemKey: string | null | undefined,
  role: string | null | undefined,
): BotCharacterType | null {
  if (systemKey && Object.hasOwn(SYSTEM_TEAMMATE_FACES, systemKey)) {
    return SYSTEM_TEAMMATE_FACES[systemKey as SystemTeammateKey]
  }
  if (role && Object.hasOwn(ROLE_TEAMMATE_FACES, role)) return ROLE_TEAMMATE_FACES[role as WorkRole]
  return null
}

/**
 * The face any other teammate starts with, given the faces its workspace's
 * teammates wear: the first in the free order (the crew's, past the reserved
 * faces) not among them, or null once every one is (`free_bot_character`).
 */
export function firstFreeBotCharacter(worn: readonly (string | null | undefined)[]): BotCharacterType | null {
  const taken = new Set(worn)
  return FREE_BOT_CHARACTER_ORDER.find((type) => !taken.has(type)) ?? null
}
