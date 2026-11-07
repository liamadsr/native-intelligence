/**
 * The packs the main chat may load, as the chat spec carries them
 * (`spec.packs`, on the `?skills=1` variant the chat-agent fetches once per
 * turn).
 *
 * The chat-agent decides WHEN a pack loads (agents/chat-agent/lib/expertise.ts:
 * a search revealing one of its tools, the first call of one, a card of its
 * kind, or load_skill of its playbook). It can't import the registry, so each
 * pack arrives with everything that decision needs: its tool names, its card
 * kinds, the load_skill name of its playbook, and its whole body, rendered
 * here. Only areas whose edition feature is on in the workspace are listed,
 * and only packs with something to say: the area gate is this list.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isFeatureEnabled, resolveWorkspaceEdition } from '@/lib/editions'
import { AREA_KEYS, PACKS, isAreaKey, playbookSlug, toolNamesForArea, type AreaKey } from './registry'
import { packHasContent, renderPackBody, type PackSkillLine } from './render'
import { loadPackMemory } from './memory'
import { AREA_GUIDES } from './area-guides'
import { TOOL_FAMILIES, toolFamilyPack, type ToolFamilyKey } from './tool-families'

/** One loadable pack on the chat spec wire. Mirrored in agents/chat-agent/lib/expertise.ts. */
export interface ChatPack {
  /** The area, or the tool family (tool-families.ts) for the main agent's own tools of no area. */
  area: AreaKey | ToolFamilyKey
  name: string
  /** The load_skill name of the area's playbook, when it has one: loading it loads the pack. */
  playbookSkill: string | null
  /** The area's registry tools: a search revealing one, or the first call of one, loads the pack. */
  toolNames: string[]
  /** The area's card kinds (`kind` or `kind:entity_type`), for the `show` trigger. */
  cardKinds: string[]
  /** The pack body: playbook, skill lines, memory. The chat-agent fences it. */
  markdown: string
}

/**
 * The version of the packs' code-defined text (the area guides and the tool
 * families): a 32-bit FNV-1a of it, as the chat spec carries it
 * (`spec.packsVersion`). A session that loaded a pack under another version
 * forgets its packs (agents/chat-agent/lib/expertise.ts resetPacksOnNewVersion),
 * so a deploy that changes the text reaches a long-lived home thread at its
 * next step, not only after its next summary. A playbook or memory edit is
 * not versioned here: it reaches the next conversation or summary, as before.
 */
export const PACKS_VERSION: string = (() => {
  const text = JSON.stringify({ areas: AREA_GUIDES, families: TOOL_FAMILIES.map((f) => [f.key, f.toolNames, f.guide]) })
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`
})()

/** A loadable skill as the chat spec has it, as far as packs read it. */
export interface PackSourceSkill {
  name: string
  description: string
  markdown: string
  area?: string | null
  /** Only a system skill can be a playbook: a member's skill named like one is an ordinary skill. */
  isSystem?: boolean
}

/**
 * Group the caller's loadable skills into packs. Pure: `enabled` is the area
 * gate, `memory` the S2 notes and `guides` how each area's tools work. The SYSTEM skill whose name is its area's
 * playbook slug is the playbook; every other skill tagged with the area is a
 * line in its skill list. A member's skill can never be the playbook: the
 * chat tells the model to follow a pack over its own habits, so who writes it
 * matters (background.ts reads only system rows for the same reason).
 */
export function buildChatPacks(args: {
  skills: readonly PackSourceSkill[]
  enabled: (area: AreaKey) => boolean
  memory?: ReadonlyMap<AreaKey, string>
  /** How each area's tools work (AREA_GUIDES); the spec passes them, a bare call has none. */
  guides?: Readonly<Partial<Record<AreaKey, string>>>
}): ChatPack[] {
  const packs: ChatPack[] = []
  for (const area of AREA_KEYS) {
    if (!args.enabled(area)) continue
    const tagged = args.skills.filter((s) => isAreaKey(s.area) && s.area === area)
    const playbook = tagged.find((s) => s.isSystem === true && s.name === playbookSlug(area)) ?? null
    const skills: PackSkillLine[] = tagged
      .filter((s) => s !== playbook)
      .map((s) => ({ name: s.name, description: s.description }))
    const memory = args.memory?.get(area) ?? ''
    const parts = { area, playbook: playbook?.markdown ?? '', skills, memory, guide: args.guides?.[area] ?? '' }
    if (!packHasContent(parts)) continue
    packs.push({
      area,
      name: PACKS[area].name,
      playbookSkill: playbook?.name ?? null,
      toolNames: toolNamesForArea(area),
      cardKinds: [...PACKS[area].cardKinds],
      markdown: renderPackBody(parts),
    })
  }
  return packs
}

/** The areas whose edition feature is on in a resolved workspace. */
export function enabledAreaGate(resolved: Parameters<typeof isFeatureEnabled>[0]): (area: AreaKey) => boolean {
  return (area) => isFeatureEnabled(resolved, PACKS[area].feature)
}

/**
 * The chat spec's packs for one caller: the edition gate read from the
 * workspace (the caller's settings read when it has one), the S2 memory, and
 * the skills the spec already loaded; then the tool families (the main
 * agent's own tools of no area). Never throws: a pack miss degrades to the
 * families alone, never a failed spec.
 */
export async function rebuildChatPacks(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string },
  skills: readonly PackSourceSkill[],
  workspaceSettings?: unknown,
): Promise<ChatPack[]> {
  // The tool families need no read: they ride even when the area packs fail.
  const families = TOOL_FAMILIES.map(toolFamilyPack)
  try {
    const resolved = await resolveWorkspaceEdition(supabase, scope.workspaceId, workspaceSettings)
    const enabled = enabledAreaGate(resolved)
    const memory = await loadPackMemory(supabase, { ...scope, areas: AREA_KEYS.filter(enabled) })
    return [...buildChatPacks({ skills, enabled, memory, guides: AREA_GUIDES }), ...families]
  } catch (err) {
    console.error(`[packs] chat packs skipped: ${err instanceof Error ? err.message : String(err)}`)
    return families
  }
}
