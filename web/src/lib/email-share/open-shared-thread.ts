/**
 * Opening a mail thread a teammate shared with you by an @-mention (migration
 * 673, decision 1), read-only. A grantee's email_thread chip (open-mention.ts)
 * asks for this; the viewer is mounted once in the dashboard shell and listens
 * for the event (src/components/email/shared-thread-dialog.tsx). Client-safe.
 */
export const OPEN_SHARED_EMAIL_EVENT = 'ni:open-shared-email'

export interface OpenSharedEmailDetail {
  threadIndexId: string
}

/** Ask the mounted viewer to open the shared thread for this email_thread index row. */
export function openSharedEmailThread(threadIndexId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(OPEN_SHARED_EMAIL_EVENT, { detail: { threadIndexId } }))
}
