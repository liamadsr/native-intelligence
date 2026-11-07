/**
 * Deep links into the Prospecting UI.
 *
 * The dashboard is a single route (`/account`) whose pages are cards in the
 * chat; outbound references encode the target entity as a query param,
 * matching the established shape for sequences (`/account?sequence=<id>`, see
 * src/lib/sequences/urls.ts). The param is consumed by MainChatProvider's boot
 * (main-chat/main-chat-context.tsx deepLinkCard), after the stored chat is read,
 * which strips it from the URL and opens the list's Prospecting card in the
 * chat on screen.
 */

import type { ViewFilter } from '@/lib/views/types'

/** App origin for deep links. Mirrors appBaseUrl in src/lib/sequences/urls.ts. */
function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://dial8.ai').replace(/\/$/, '')
}

/** Absolute deep link to a prospect list's detail page. */
export function getProspectListUrl(listId: string): string {
  // Encoded even though ids are uuids today — the sequences precedent this
  // otherwise mirrors omits it, and that is the one detail not worth copying.
  return `${appBaseUrl()}/account?prospect_list=${encodeURIComponent(listId)}`
}

/**
 * The fixed filter that restricts a `prospect_list_entry` view instance to ONE
 * list. Passed to `<UnifiedViewLayout scopeFilters={…}>` by the list detail
 * page — the same mechanism Project → Actions and Contact → Sequences use, so
 * the query engine needs no new seam: `list_id` is a real column and a plain
 * `eq` filter (it is declared in FILTERABLE_FIELDS but kept out of
 * FIELD_CATEGORIES, so it never appears in the user-facing filter picker).
 *
 * Pair it with `viewScope={{ type: 'prospect_list', id }}` so saved views
 * created inside one list stay out of every other list's picker.
 */
export function prospectListScopeFilters(listId: string): ViewFilter[] {
  return [{ id: '__scope_prospect_list', field: 'list_id', operator: 'is', value: listId }]
}
