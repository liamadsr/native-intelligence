/**
 * A coding chat's own address (docs/plans/one-home.md, "The URL"):
 * `/account?code=<session id>`, with `&workspace=<id>` when it names its
 * workspace, as the other deep links do. Read once at boot
 * (main-chat/main-chat-context.tsx), which opens the chat as Home's current
 * chat (current-chat-store.ts openCodingChat) and takes it off the address:
 * the address bar never follows the current chat as it changes. Pure.
 */

/** The link's parameter: a coding chat's session id. */
export const CODING_CHAT_DEEP_LINK = 'code'
/** The workspace it belongs to, the deep links' own parameter (main-chat-context.tsx DEEP_LINK_WORKSPACE). */
export const CODING_CHAT_LINK_WORKSPACE = 'workspace'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The coding chat a link names, ids only (a link is outside input), or null. */
export function deepLinkCodingChat(params: URLSearchParams): { sessionId: string; workspaceId: string | null } | null {
  const sessionId = params.get(CODING_CHAT_DEEP_LINK)
  if (!sessionId || !ID.test(sessionId)) return null
  const workspace = params.get(CODING_CHAT_LINK_WORKSPACE)
  return { sessionId, workspaceId: workspace && ID.test(workspace) ? workspace : null }
}

/** A coding chat's link, to copy (its details' "Copy link"): the app's own address, the chat and its workspace. */
export function codingChatLink(origin: string, sessionId: string, workspaceId: string | null): string {
  const params = new URLSearchParams({ [CODING_CHAT_DEEP_LINK]: sessionId })
  if (workspaceId) params.set(CODING_CHAT_LINK_WORKSPACE, workspaceId)
  return `${origin}/account?${params.toString()}`
}
