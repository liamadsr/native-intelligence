/**
 * Open a surface that is not a card (the standalone agent-run page, a settings
 * route) in a SPECIFIC workspace: a hard navigation. The destination renders on
 * the server, which reads the active workspace from the httpOnly cookie, so
 * for another workspace the cookie is written, and awaited, BEFORE leaving
 * (navigating anyway would render it under the old workspace and look like a
 * missing record). Everything that is a page opens as a card instead
 * (lib/chat-cards/open-card.ts).
 */
import { toast } from 'sonner'
import { setClientWorkspaceId } from '@/lib/workspace-fetch'

export async function openHrefInWorkspace(targetWorkspaceId: string, href: string, currentWorkspaceId: string | null): Promise<void> {
  if (!targetWorkspaceId || targetWorkspaceId === currentWorkspaceId) {
    window.location.assign(href)
    return
  }
  let ok = false
  try {
    const res = await fetch('/api/account/workspace/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-workspace-id': targetWorkspaceId },
      body: JSON.stringify({ workspace_id: targetWorkspaceId }),
    })
    ok = res.ok
  } catch {
    ok = false
  }
  if (!ok) {
    toast.error("Couldn't switch workspace")
    return
  }
  // This window's fetch interceptor follows the cookie, for the requests the
  // destination fires before its own workspace cache has loaded.
  setClientWorkspaceId(targetWorkspaceId)
  window.location.assign(href)
}
