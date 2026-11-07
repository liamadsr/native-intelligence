/**
 * The area a system teammate stands for (docs/plans/one-agent-and-chat-pages.md,
 * Part 3; migration 318): an area face's page chats focused on its area.
 *
 * Pure (no React, no server), so the page and the tests share it.
 */
import { AREA_KEYS, type AreaKey } from '@/lib/packs/registry'
import { ASSISTANT_SYSTEM_KEY } from '@/lib/work/bot-owner'

/** The system teammate's area, when it is an area face (its page chats focused on it); null for any other bot. */
export function areaOfTeammate(mate: { is_system?: boolean | null; system_key?: string | null } | null | undefined): AreaKey | null {
  if (!mate?.is_system || !mate.system_key || mate.system_key === ASSISTANT_SYSTEM_KEY) return null
  return (AREA_KEYS as readonly string[]).includes(mate.system_key) ? (mate.system_key as AreaKey) : null
}
