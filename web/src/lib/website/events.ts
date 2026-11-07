/**
 * The website flow's Inngest events (roadmap track E), named here so the
 * senders and src/lib/inngest/website-functions.ts share one spelling.
 * Each send carries an event id, so a re-send of the same step is dropped
 * (Inngest dedupes ids for a day) while a new head gets its own wait.
 */

/** A change's pull request opened (or its head moved): wait for its preview, then raise the merge card. */
export const WEBSITE_PR_OPENED = 'website/change.pr_opened' as const
/** A change merged: watch the host's deploy, then check it live and tell the owner. */
export const WEBSITE_CHANGE_MERGED = 'website/change.merged' as const

export interface WebsiteEventData {
  workspaceId: string
  changeId: string
}

/** One preview wait per change and head ("first" before a head is known). */
export function prOpenedEventId(changeId: string, head: string | null): string {
  return `website-pr:${changeId}:${head ?? 'first'}`
}

/** One deploy watch per change. */
export function mergedEventId(changeId: string): string {
  return `website-merged:${changeId}`
}
