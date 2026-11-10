/**
 * The composer's half of share-by-mention: a post's answer says which
 * records it opened to the channel (`shared`, src/lib/entity-access/share.ts),
 * and the composer toasts "Shared “Q3 plan” with #launch · Undo". Undo
 * deletes those grants (DELETE /api/account/entity-access/[id]); the message
 * itself stays.
 *
 * Client-safe. `deps` exists for tests; callers use the defaults.
 */
import { toast as sonner } from 'sonner'
import { isGrantableType, sharedToastText, type SharedRecord } from './model'

interface ToastOptions {
  action?: { label: string; onClick: () => void }
}

export interface ShareToastDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  toast: { success: (message: string, opts?: ToastOptions) => void; error: (message: string) => void }
}

export const defaultShareToastDeps: ShareToastDeps = {
  fetch: (input, init) => fetch(input, init),
  toast: {
    success: (message, opts) => void sonner.success(message, opts),
    error: (message) => void sonner.error(message),
  },
}

/** The `shared` list of a post's or an edit's answer, kept only where well formed. */
export function parseSharedRecords(json: unknown): { shared: SharedRecord[]; sharedWith: string | null } {
  const data = (json ?? {}) as { shared?: unknown; shared_with?: unknown }
  const shared = Array.isArray(data.shared)
    ? data.shared.filter(
        (s): s is SharedRecord =>
          !!s &&
          typeof s === 'object' &&
          typeof (s as SharedRecord).grant_id === 'string' &&
          typeof (s as SharedRecord).id === 'string' &&
          typeof (s as SharedRecord).label === 'string' &&
          isGrantableType((s as SharedRecord).type),
      )
    : []
  return { shared, sharedWith: typeof data.shared_with === 'string' ? data.shared_with : null }
}

/** Delete the grants a share made. True when every one is gone. `workspaceId`: the record's, when it may not be the one on screen. */
export async function undoShare(
  grantIds: readonly string[],
  deps: ShareToastDeps = defaultShareToastDeps,
  workspaceId?: string | null,
): Promise<boolean> {
  const results = await Promise.all(
    grantIds.map((id) =>
      deps
        .fetch(`/api/account/entity-access/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          ...(workspaceId ? { headers: { 'x-workspace-id': workspaceId } } : {}),
        })
        .then((r) => r.ok || r.status === 404)
        .catch(() => false),
    ),
  )
  return results.every(Boolean)
}

/**
 * Toast what a post shared, with Undo. Nothing shared: no toast (false).
 * `onUndo` runs too when Undo is pressed (Share to a channel also takes its
 * message back).
 */
export function toastSharedRecords(
  shared: readonly SharedRecord[],
  sharedWith: string | null,
  deps: ShareToastDeps = defaultShareToastDeps,
  opts: { workspaceId?: string | null; onUndo?: () => Promise<boolean> | boolean } = {},
): boolean {
  if (shared.length === 0) return false
  deps.toast.success(sharedToastText(shared, sharedWith), {
    action: {
      label: 'Undo',
      onClick: () => {
        void Promise.all([undoShare(shared.map((s) => s.grant_id), deps, opts.workspaceId), opts.onUndo ? opts.onUndo() : true]).then(
          ([grants, rest]) => {
            if (!grants || !rest) deps.toast.error("Couldn't take the share back")
          },
        )
      },
    },
  })
  return true
}
