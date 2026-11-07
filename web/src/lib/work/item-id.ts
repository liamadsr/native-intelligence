/**
 * A work item's id: a `tracked_job` row's, a uuid (migration 170). Checked
 * wherever one arrives from outside the code that read it: a saved tab's
 * card (open-card.ts), the bot page's open event
 * (teammate-chat-tab-bridge.tsx), a lookup's answer (lib/bots/item-lookup.ts).
 * No imports, so the tabs reducer can use it.
 */
const WORK_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether `value` is a work item's id. */
export function isWorkItemId(value: unknown): value is string {
  return typeof value === 'string' && WORK_ITEM_ID.test(value)
}
