/**
 * The per-person card kinds a chat may show (calendar and mail, the person's
 * own data): each only when the tool it stands in for (get_calendar_events,
 * list_emails; PERSONAL_CARD_TOOLS) passes the gate a call to that tool would,
 * so a card never reads, and the cards note never carries, more than the tool
 * may. One answer for the chat tool route (show, read_card) and the turn's
 * rebuild (the cards note).
 */
import { ALL_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { PERSONAL_CARD_TOOLS, type PersonalCardKind } from '@/lib/ai/tools/show'
import { isToolExcludedForSurface } from './chat-ceiling'

const REGISTRY_TOOLS = new Set<string>([...ALL_TOOL_NAMES, 'search_tools'])

export function personalCardKindsFor(
  /** The chat's tool ceiling; null: inherit-all (every registry tool). */
  ceiling: ReadonlySet<string> | readonly string[] | null,
  surface: Parameters<typeof isToolExcludedForSurface>[1],
): PersonalCardKind[] {
  const allowed = ceiling === null ? null : new Set(ceiling)
  return (Object.keys(PERSONAL_CARD_TOOLS) as PersonalCardKind[]).filter((kind) => {
    const tool = PERSONAL_CARD_TOOLS[kind]
    return !isToolExcludedForSurface(tool, surface) && (allowed ? allowed.has(tool) : REGISTRY_TOOLS.has(tool))
  })
}

/** True for a card of a kind the chat may show: every kind but a per-person one it may not. */
export function cardKindAllowed(kind: string, personal: readonly PersonalCardKind[]): boolean {
  return !(kind in PERSONAL_CARD_TOOLS) || personal.includes(kind as PersonalCardKind)
}
