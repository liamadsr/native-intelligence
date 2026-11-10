/**
 * Deep links into the Sequences UI.
 *
 * The dashboard is a single route (`/account`) whose pages are cards in the
 * chat; outbound references encode the target entity as a query param,
 * matching the established shape for actions (`/account?action=<id>`, see
 * src/lib/tasks/linear-push.ts and src/lib/flows/template.ts). The param is
 * consumed by MainChatProvider's boot (main-chat/main-chat-context.tsx deepLinkCard), after
 * the stored chat is read, which strips it from the URL and opens the
 * sequence's card in the chat on screen.
 */

import { appUrl } from '@/lib/app-url'

/** App origin for deep links. Mirrors appBaseUrl in src/lib/tasks/linear-push.ts. */
function appBaseUrl(): string {
  return appUrl()
}

/** Absolute deep link to a sequence's detail page (agent tools hand this out). */
export function getSequenceUrl(sequenceId: string): string {
  return `${appBaseUrl()}/account?sequence=${sequenceId}`
}
