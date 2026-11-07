/**
 * A conversation focused on an area (docs/plans/one-agent-and-chat-pages.md,
 * Part 3 "How a pack loads", Phase S3: the pack is loaded from the start, and
 * it's the same agent, focused).
 *
 * The person chats on an area face's page, and the conversation is stamped
 * with the area (`chat_conversations.focus_area`,
 * migration 318; the run token's `focusArea`). It is the MAIN agent in every
 * way: the same tools, the same gates, attended. The only difference is
 * here: the area's pack goes into the stable system prompt from the first
 * turn, instead of riding the first tool result that touches the area.
 *
 * So the focused pack leaves `spec.packs`: the chat-agent's triggers
 * (agents/chat-agent/lib/expertise.ts) never send it a second time, and its
 * compaction resend has nothing to resend (the system prompt is never
 * compacted). Every other area's pack still loads the usual way, since real
 * requests cross areas.
 */
import { PACKS, type AreaKey } from './registry'
import type { ChatPack } from './chat-packs'

/**
 * An `<expertise>` look-alike's opening bracket. The same pattern as the
 * chat-agent's FENCE_LOOKALIKE_RE (focus-drift.test.ts holds them equal): a
 * pack body quotes text a member wrote, so it can't close its own fence.
 */
export const FOCUS_FENCE_LOOKALIKE_RE = /(?:<|＜|﹤|&lt;?|&#0*60;?|&#x0*3c;?)(?=[\s\p{Cf}]*[/／]?[\s\p{Cf}]*expertise(?![a-z0-9]))/giu

/** The heading the focus section opens with. */
export const FOCUS_HEADING = '## This conversation’s focus'

/**
 * The focus section of the stable prompt: what the focus means, then the
 * area's pack, fenced as the chat-agent fences a pack (`<expertise area>`).
 * With no pack (the area has nothing to say yet), the note alone.
 */
export function renderFocusSection(area: AreaKey, pack: ChatPack | null): string {
  const name = PACKS[area].name
  const lines = [
    FOCUS_HEADING,
    `The person focused this conversation on ${name}. You are still Dial8's main agent, with every tool and the same limits: ` +
      `the focus only says where the work is. Lead with ${name}, and cross into other areas whenever the request does.`,
  ]
  if (pack) {
    lines.push(
      `${name}'s expertise is below, loaded for the whole conversation: follow it for work in ${name}. It won't come again with a tool result.`,
      `<expertise area="${area}">\n${pack.markdown.replace(FOCUS_FENCE_LOOKALIKE_RE, '‹')}\n</expertise>`,
    )
  }
  return lines.join('\n\n')
}

/**
 * The spec's packs and its focus section for a conversation focused on
 * `area`: the focused pack out of `packs` and into the section. No focus (or
 * an unknown area): the packs as they were and no section.
 */
export function applyFocus(
  packs: readonly ChatPack[],
  area: AreaKey | null | undefined,
): { packs: ChatPack[]; section: string | null } {
  if (!area || !Object.hasOwn(PACKS, area)) return { packs: [...packs], section: null }
  const pack = packs.find((p) => p.area === area) ?? null
  return { packs: packs.filter((p) => p.area !== area), section: renderFocusSection(area, pack) }
}
