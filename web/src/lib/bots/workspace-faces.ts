/**
 * The faces a workspace's AI teammates wear, for the face picker's warning
 * (docs/plans/bot-characters.md, "Step 3"): a face already worn by another
 * teammate of the workspace is a soft warning, never a block. With each, the
 * voice its teammate chose (`ai_team_member.voice`, migration 308; bots-v4
 * Phase B2), for the voice picker's note: two bots on one voice is allowed,
 * and the editor says who else uses it.
 *
 * Two clients, on purpose, as the Agents page roster (agent-roster.ts):
 *   - the faces are read on the SERVICE client, scoped to the caller's
 *     workspace: `ai_team_member`'s RLS hides a private team's teammates from
 *     anyone not on it, but they wear faces all the same, and the insert
 *     default (`free_bot_character`, SECURITY DEFINER) counts them. A picker
 *     that missed them would preselect a face the database wouldn't pick, and
 *     say nothing about a duplicate. Only ids and faces, never names;
 *   - the names are read on the SESSION client, so RLS decides whose the
 *     caller may see. A teammate it hides comes back with no name ("a teammate
 *     on a private team").
 *
 * A failed service read falls back to the session's rows; a failed session
 * read leaves every name out. Neither fails the caller: this is a warning.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BotCharacterType } from '@/lib/bots/bot-faces'
import { asBotCharacter } from './teammate-faces'
import { asVoiceId } from './voice-id'

export interface WorkspaceFace {
  /** The teammate (`ai_team_member.id`). */
  id: string
  /** Its name, or null when the caller can't see it (a private team it isn't on). */
  name: string | null
  bot_character: BotCharacterType
  /** The voice it chose (a desktop voice id). Absent on Automatic. */
  voice?: string
}

/** A workspace holds a handful of teammates; this only bounds a runaway read. */
const FACES_LIMIT = 500

export async function loadWorkspaceFaces(args: {
  session: SupabaseClient
  service: SupabaseClient
  workspaceId: string
}): Promise<WorkspaceFace[]> {
  const [visible, all] = await Promise.all([
    args.session
      .from('ai_team_member')
      .select('id, name, bot_character, voice')
      .eq('workspace_id', args.workspaceId)
      .limit(FACES_LIMIT),
    args.service
      .from('ai_team_member')
      .select('id, bot_character, voice')
      .eq('workspace_id', args.workspaceId)
      .not('bot_character', 'is', null)
      .limit(FACES_LIMIT),
  ])
  if (visible.error) console.error('[workspace-faces] session read failed:', visible.error.message)
  if (all.error) console.error('[workspace-faces] service read failed:', all.error.message)

  const names = new Map<string, string>()
  for (const r of (visible.data ?? []) as Array<{ id: string; name: string | null }>) {
    if (r.name) names.set(r.id, r.name)
  }
  const rows = (all.error ? visible.data : all.data) ?? []
  const faces: WorkspaceFace[] = []
  for (const r of rows as Array<{ id: string; bot_character: unknown; voice?: unknown }>) {
    const face = asBotCharacter(r.bot_character)
    const voice = asVoiceId(r.voice)
    if (face) faces.push({ id: r.id, name: names.get(r.id) ?? null, bot_character: face, ...(voice ? { voice } : {}) })
  }
  return faces
}

/**
 * "Also worn by Writer": who else wears a face, by name, two at most then "+N".
 * `names` are the other wearers' names, null for one the caller can't see.
 * Null when nobody else wears it.
 */
export function wornByLabel(names: readonly (string | null)[]): string | null {
  return alsoByLabel('worn', names)
}

/**
 * "Also used by Writer": the other teammates in `faces` that chose `voice`
 * (all but `exceptId`, the bot being edited), as wornByLabel says them. Null
 * on Automatic, or when no other teammate chose it.
 */
export function voiceUsedByLabel(
  faces: readonly Pick<WorkspaceFace, 'id' | 'name' | 'voice'>[],
  voice: string | null,
  exceptId: string | null,
): string | null {
  if (!voice) return null
  return alsoByLabel(
    'used',
    faces.filter((f) => f.voice === voice && f.id !== exceptId).map((f) => f.name),
  )
}

function alsoByLabel(verb: 'worn' | 'used', names: readonly (string | null)[]): string | null {
  if (names.length === 0) return null
  const named = names.filter((n): n is string => !!n)
  const hidden = names.length - named.length
  const parts = named.slice(0, 2)
  let covered = parts.length
  if (parts.length < 2 && hidden > 0) {
    parts.push(hidden === 1 ? 'a teammate on a private team' : `${hidden} teammates on private teams`)
    covered += hidden
  }
  const rest = names.length - covered
  const list = parts.length === 2 && rest === 0 ? `${parts[0]} and ${parts[1]}` : parts.join(', ')
  return `Also ${verb} by ${list}${rest > 0 ? ` +${rest}` : ''}`
}
