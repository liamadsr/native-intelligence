'use client'

/**
 * An email share link's page (/mail/s/<token>, migration 646): the thread for
 * its owner, or for a teammate who can read a chat it was shared in, read
 * live and read-only; for anyone else, only that it is shared in chat.
 * `ph-no-capture`: session replay never records the mail.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Mail } from 'lucide-react'
import { EMAIL_SHARE_LINK_OUTSIDE, emailShareLinkPath } from '@/lib/email-share/links'
import { EMAIL_SHARE_UNAVAILABLE_TEXT, type EmailShareThreadView } from '@/lib/email-share/types'
import { BusyLine, EmailShareMessages } from './email-share-card'

type Thread = Pick<EmailShareThreadView, 'subject' | 'messages' | 'missing' | 'blockedImages'> & { id?: string }
type ViewState =
  | { kind: 'loading' }
  | { kind: 'busy' }
  | { kind: 'outside' }
  | { kind: 'unavailable' }
  | { kind: 'owner'; revoked: boolean; thread: Thread | null; images: boolean }
  | { kind: 'shared'; thread: Thread; images: boolean }

export function EmailShareLinkView({ token }: { token: string | null }) {
  const [state, setState] = useState<ViewState>(token ? { kind: 'loading' } : { kind: 'outside' })
  const read = useCallback(
    async (images: boolean) => {
      if (!token) return
      try {
        const res = await fetch(`/api/account/email/shares/links/${encodeURIComponent(token)}${images ? '?images=1' : ''}`, { cache: 'no-store' })
        if (res.status >= 500) return setState({ kind: 'busy' })
        if (!res.ok) return setState({ kind: 'outside' })
        const data = (await res.json()) as { state?: string; revoked?: boolean; thread?: Thread | null }
        if (data.state === 'owner') return setState({ kind: 'owner', revoked: !!data.revoked, thread: data.thread ?? null, images })
        if (data.state === 'shared' && data.thread) return setState({ kind: 'shared', thread: data.thread, images })
        if (data.state === 'unavailable') return setState({ kind: 'unavailable' })
        setState({ kind: 'outside' })
      } catch {
        setState({ kind: 'busy' })
      }
    },
    [token],
  )
  useEffect(() => {
    void read(false)
  }, [read])

  const thread = state.kind === 'owner' || state.kind === 'shared' ? state.thread : null
  return (
    <main className="ph-no-capture mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 p-6" data-email-share-link-page={state.kind}>
      <header className="flex items-center gap-2 text-sm text-muted-foreground">
        <Mail className="h-4 w-4" />
        Shared email
      </header>
      {state.kind === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading…
        </p>
      ) : state.kind === 'busy' ? (
        <BusyLine
          onRetry={() => {
            setState({ kind: 'loading' })
            void read(false)
          }}
        />
      ) : state.kind === 'outside' ? (
        <div className="rounded-lg border p-6 text-center" data-email-share-link-outside="">
          <p className="text-sm font-medium">{EMAIL_SHARE_LINK_OUTSIDE}</p>
          {/* Back to this email once signed in (a member who isn't signed in yet, or in another account). */}
          <a
            href={token ? `/login?redirect=${encodeURIComponent(emailShareLinkPath(token))}` : '/login'}
            className="mt-3 inline-block text-sm text-muted-foreground underline"
            data-email-share-link-login=""
          >
            Go to the app
          </a>
        </div>
      ) : state.kind === 'unavailable' || (state.kind === 'owner' && !state.thread) ? (
        <p className="text-sm text-muted-foreground" role="status">{EMAIL_SHARE_UNAVAILABLE_TEXT}</p>
      ) : thread ? (
        <>
          <h1 className="select-text text-lg font-semibold">{thread.subject}</h1>
          <p className="text-xs text-muted-foreground" data-email-share-link-note="">
            {state.kind === 'owner'
              ? state.revoked
                ? 'Your email. This link is revoked: pasting it shares nothing.'
                : 'Your email. Only you see it here; paste the link in a chat to share it there.'
              : 'Shared from a teammate’s mailbox, read-only. Only the messages shared are shown.'}
          </p>
          <div className="space-y-3">
            <EmailShareMessages
              thread={thread}
              images={state.kind === 'owner' || state.kind === 'shared' ? state.images : false}
              onLoadImages={() => void read(true)}
              // Through the link's own route, with the page's checks, in the link's workspace (whatever one is active).
              attachmentHref={
                token
                  ? (messageId, key) =>
                      `/api/account/email/shares/links/${encodeURIComponent(token)}/attachment?message=${encodeURIComponent(messageId)}&part=${encodeURIComponent(key)}`
                  : undefined
              }
            />
          </div>
        </>
      ) : null}
    </main>
  )
}
