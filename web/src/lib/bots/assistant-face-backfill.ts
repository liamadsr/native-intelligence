/**
 * The work bots on the Assistant's face move off it (docs/plans/bots-v4.md
 * decision 7, Phase 5; scripts/backfill-assistant-face.ts runs this).
 *
 * Migration 310 reserves `chat` (the catalogue's Assistant) for the new
 * Assistant system teammate. v3's loop back-fill dealt `chat` first, so most
 * workspaces already have a work bot on it, named "Assistant". Each such work
 * bot moves to its workspace's next free character, and is renamed to that
 * character's catalogue name, as v3's back-fill named it.
 *
 * Which face: the first free one in the free order (the crew's, past the
 * reserved faces) that is also nobody's starting face (MOVE_ORDER: not a role
 * teammate's or a system teammate's, so a Researcher or Writer seeded later
 * doesn't land on a work bot's face); only when every one of those is worn,
 * any free face at all.
 *
 * Which name: the new face's catalogue name, unless someone renamed the bot
 * (it keeps its own), or another teammate in the workspace already goes by
 * that name (it keeps its old one rather than take a name twice).
 *
 * Only work bots (`fronts_only`) move by default: they were dealt the face by
 * a default. Anyone else on `chat` (a teammate someone made, which got `chat`
 * first since migration 297) is reported and left alone, unless the caller
 * asks to include them (`includeOthers`, the script's --include-others), by
 * the same face and name rules. A teammate in a workspace where every
 * character is worn stays and is reported. Pure: the script reads the rows
 * and writes the plan.
 */
import { characterName, type BotCharacterType } from '@/lib/bots/bot-faces'
import { FREE_BOT_CHARACTER_ORDER, ROLE_TEAMMATE_FACES, SYSTEM_TEAMMATE_FACES, firstFreeBotCharacter } from './teammate-faces'

/** The reserved face the work bots leave. */
export const ASSISTANT_FACE: BotCharacterType = SYSTEM_TEAMMATE_FACES.assistant

/** Faces a teammate starts on by its job: a role's or a system teammate's. A moved bot takes one only when nothing else is free. */
const STARTING_FACES: ReadonlySet<BotCharacterType> = new Set<BotCharacterType>([
  ...Object.values(ROLE_TEAMMATE_FACES),
  ...Object.values(SYSTEM_TEAMMATE_FACES),
])

/** The order a moved bot's face is picked in first: the free order, past everyone's starting faces. */
export const MOVE_ORDER: readonly BotCharacterType[] = FREE_BOT_CHARACTER_ORDER.filter((face) => !STARTING_FACES.has(face))

/** The teammate columns the plan reads. */
export interface FaceBackfillTeammate {
  id: string
  workspace_id: string
  name: string | null
  bot_character: string | null
  fronts_only: boolean | null
  is_system: boolean | null
  created_at: string
}

/** One teammate's move. `toName` null: it keeps its own name. */
export interface FaceBackfillMove {
  id: string
  workspaceId: string
  fromName: string
  toFace: BotCharacterType
  toName: string | null
  /** A work bot (`fronts_only`); false only for a teammate moved under `includeOthers`. */
  workBot: boolean
}

export interface FaceBackfillPlan {
  moves: FaceBackfillMove[]
  /** Teammates left on the face: every character in their workspace is worn. */
  stuck: Array<{ id: string; workspaceId: string; name: string }>
  /** Other teammates on the face (not work bots, not the Assistant), left as they are (without `includeOthers`). */
  others: Array<{ id: string; workspaceId: string; name: string }>
}

const nameKey = (name: string | null | undefined) => (name ?? '').trim().toLowerCase()

/** Whether a teammate still carries the face's own name (v3's back-fill named a work bot after its face). */
function namedForFace(name: string | null | undefined): boolean {
  return nameKey(name) === nameKey(characterName(ASSISTANT_FACE))
}

/** The face a moved bot takes: the first free one in MOVE_ORDER, else any free one. */
function nextFace(worn: ReadonlySet<string>): BotCharacterType | null {
  return MOVE_ORDER.find((face) => !worn.has(face)) ?? firstFreeBotCharacter([...worn])
}

/**
 * The plan for every workspace in `teammates` (each workspace's whole roster:
 * a face is free only when nobody there wears it, and a name taken only when
 * nobody there goes by it). Teammates move oldest first (created_at, then
 * id), each taking the first free face left after the ones before it, so two
 * never land on one face.
 */
export function planAssistantFaceBackfill(
  teammates: readonly FaceBackfillTeammate[],
  opts: { includeOthers?: boolean } = {},
): FaceBackfillPlan {
  const byWorkspace = new Map<string, FaceBackfillTeammate[]>()
  for (const t of teammates) {
    const list = byWorkspace.get(t.workspace_id) ?? []
    list.push(t)
    byWorkspace.set(t.workspace_id, list)
  }
  const plan: FaceBackfillPlan = { moves: [], stuck: [], others: [] }
  for (const [workspaceId, roster] of [...byWorkspace.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const worn = new Set(roster.map((t) => t.bot_character).filter((f): f is string => !!f))
    const names = new Map(roster.map((t) => [t.id, nameKey(t.name)]))
    const onFace = roster
      .filter((t) => t.bot_character === ASSISTANT_FACE && t.is_system !== true)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    for (const t of onFace) {
      const name = t.name?.trim() || ''
      const workBot = t.fronts_only === true
      if (!workBot && !opts.includeOthers) {
        plan.others.push({ id: t.id, workspaceId, name })
        continue
      }
      const next = nextFace(worn)
      if (!next) {
        plan.stuck.push({ id: t.id, workspaceId, name })
        continue
      }
      worn.add(next)
      const faceName = characterName(next)
      const taken = [...names.entries()].some(([id, other]) => id !== t.id && other === nameKey(faceName))
      const toName = namedForFace(name) && !taken ? faceName : null
      if (toName) names.set(t.id, nameKey(toName))
      plan.moves.push({ id: t.id, workspaceId, fromName: name, toFace: next, toName, workBot })
    }
  }
  return plan
}
