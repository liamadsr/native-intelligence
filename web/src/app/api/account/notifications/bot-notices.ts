/**
 * A bot's notices, as the notification routes read them (bots-v4 Phase 4c,
 * decision 8: a bot's notices live with the bot). A notice whose row names a
 * teammate (`metadata.teammate_id`, bot-notice.ts) is the bot's: the plain
 * notices the shell holds leave it out, and the bot's Notices (its bubble, its
 * page) list it.
 *
 * Kept beside the routes (as scope.ts is), not in them: a route module may
 * export only its handlers.
 */

/**
 * The columns a bot's notice is read with: the table's own, no embeds. A bot
 * has no actor (its notices are written by the run, `actor_id` null), and the
 * Notices part is already its bot's, so neither the actor nor the workspace
 * is joined.
 */
export const BOT_NOTICE_COLUMNS =
  'id, workspace_id, recipient_id, type, title, body, actor_id, target_type, target_id, context_type, context_id, is_read, read_at, is_archived, group_key, metadata, created_at'

/**
 * How many of the bots' newest notices the shell's first page carries beside
 * the plain ones (`include_bots=1`): what the shell holds of them for the peeks'
 * sentences and for reading an item's late notice when it's opened again
 * (notification-context.tsx `botNotices`). Not a list anyone draws.
 */
export const BOT_NOTICES_HELD = 50

/**
 * And every unread one, up to this many, whatever its age: an unread failed
 * run lights its bot's dot until it's read (bots-v4 Phase 4c), and the desktop
 * overlay's bubble lists a bot's unread notices off what the window holds.
 */
export const BOT_UNREAD_HELD = 100

/** A notice row as the client's `Notification` has it: no actor to name. */
export function asBotNotice<T extends Record<string, unknown>>(row: T): T & { actor_name: null; actor_avatar: null } {
  return { ...row, actor_name: null, actor_avatar: null }
}
