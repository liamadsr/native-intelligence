'use client'

import { useMemo, useState } from 'react'
import { Separator } from '@/components/ui/separator'
import { ChevronRight, Clock, ScrollText, Users } from 'lucide-react'
import { Markdown } from '@/components/ui/markdown'
import { EntityRefsProvider } from '@/components/entity-refs/entity-refs-context'
import { InlineCommentProvider } from '@/components/inline-comments/inline-comment-context'
import { AnnotatedContent } from '@/components/inline-comments/annotated-content'
import { SelectionPopover } from '@/components/inline-comments/selection-popover'
import { InlineCommentPopover } from '@/components/inline-comments/inline-comment-popover'
import { CommentableEditor } from '@/components/inline-comments/commentable-editor'
import {
  createShareAPI,
  GUEST_NOOP_API,
  mapShareComments,
} from '@/components/inline-comments/adapters'
import type { CommentAPI, CommentIdentity } from '@/components/inline-comments/types'
import { ProposalNodeExtension } from '@/components/capture/proposal-node-extension'
import {
  ProposalNodeProvider,
  type ProposalNodeContextValue,
} from '@/components/capture/proposal-node-context'
import type { ProposedChange } from '@/lib/proposed-changes/types'
import type { ProposalChangeRef } from '@/app/account/(dashboard)/views/note-editor'

/**
 * Identity passed from the server into the shared view. Narrower than the
 * context's CommentIdentity so the page can build it without importing the
 * context types.
 */
export type ShareIdentity =
  | { mode: 'guest' }
  | {
      mode: 'authenticated'
      userId: string
      /** Member id if the user is a member of the share's workspace, else null. */
      memberId: string | null
      displayName: string
      avatarUrl: string | null
    }

interface SharedCaptureData {
  type: 'capture'
  share: { access_level: string; created_at: string; expires_at: string | null }
  capture: {
    title: string
    content: string | null
    transcript?: string
    participants: { name: string; role: string }[]
    started_at: string | null
    ended_at: string | null
    duration_seconds: number | null
    created_at: string
  }
  proposedChanges: ProposedChange[]
  comments: Record<string, unknown>[]
}

interface SharedDocumentData {
  type: 'document'
  share: { access_level: string; created_at: string; expires_at: string | null }
  document: {
    title: string
    content: string | null
    created_at: string
    updated_at: string
  }
  comments: Record<string, unknown>[]
}

type SharedData = SharedCaptureData | SharedDocumentData

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatDuration(seconds: number) {
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins} min`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`
}

const proposalExtensions = [ProposalNodeExtension]

const NOOP_MUTATION = async () => {}

/**
 * Translate the page-level ShareIdentity into the CommentIdentity the
 * context expects, and pick the right API adapter.
 */
function resolveCommentPlumbing(
  identity: ShareIdentity,
  token: string,
): { identity: CommentIdentity; api: CommentAPI } {
  if (identity.mode === 'guest') {
    return { identity: { mode: 'guest' }, api: GUEST_NOOP_API }
  }
  const authIdentity: CommentIdentity = {
    mode: 'authenticated',
    memberId: identity.memberId,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
  }
  return {
    identity: authIdentity,
    api: createShareAPI(token, authIdentity),
  }
}

export function SharedViewClient({
  data,
  token,
  identity,
}: {
  data: SharedData
  token: string
  identity: ShareIdentity
}) {
  const { identity: commentIdentity, api } = useMemo(
    () => resolveCommentPlumbing(identity, token),
    [identity, token],
  )
  const mappedComments = mapShareComments(data.comments)

  return (
    <InlineCommentProvider
      initialComments={mappedComments}
      identity={commentIdentity}
      api={api}
    >
      <div className="min-h-screen bg-background">
        {/* Header */}
        <header className="border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60">
          <div className="mx-auto flex h-12 items-center justify-between px-4 max-w-3xl">
            <a href="https://dial8.ai" className="text-sm font-semibold">
              Native Intelligence
            </a>
            <a
              href="https://dial8.ai"
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Try it free
            </a>
          </div>
        </header>

        {/* Content */}
        <main className="mx-auto px-4 py-8 max-w-3xl">
          {data.type === 'capture' ? (
            <SharedCaptureView data={data} />
          ) : (
            <SharedDocumentView data={data} />
          )}
        </main>

        <SelectionPopover />
        <InlineCommentPopover />
      </div>
    </InlineCommentProvider>
  )
}

function SharedCaptureView({ data }: { data: SharedCaptureData }) {
  const { capture, proposedChanges } = data

  const proposalRefs = useMemo<ProposalChangeRef | undefined>(() => {
    if (proposedChanges.length === 0) return undefined
    const sorted = [...proposedChanges].sort((a, b) => a.sort_order - b.sort_order)
    const byIndex = new Map<number, string>()
    const byId = new Map<string, string>()
    const allIds: string[] = []
    sorted.forEach((change, i) => {
      byIndex.set(i, change.id)
      byId.set(change.id, change.id)
      byId.set(change.id.slice(0, 8), change.id)
      allIds.push(change.id)
    })
    return { byIndex, byId, allIds }
  }, [proposedChanges])

  // Read-only proposal context. We intentionally pass NO members / contacts /
  // projects so property pills (which don't render in readOnly anyway) can't
  // leak workspace data to a public viewer.
  const proposalNodeCtx = useMemo<ProposalNodeContextValue>(
    () => ({
      changes: proposedChanges,
      onApply: NOOP_MUTATION,
      onDismiss: NOOP_MUTATION,
      onEdit: NOOP_MUTATION,
      readOnly: true,
    }),
    [proposedChanges],
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {capture.started_at && (
            <span>{formatDate(capture.started_at)}</span>
          )}
          {capture.duration_seconds && (
            <>
              <span className="text-muted-foreground/40">&middot;</span>
              <Clock className="h-3.5 w-3.5" />
              <span>{formatDuration(capture.duration_seconds)}</span>
            </>
          )}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{capture.title}</h1>

        {capture.participants.length > 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            <span>{capture.participants.map((p) => p.name).join(', ')}</span>
          </div>
        )}
      </div>

      <Separator />

      {/* Read-only merged editor. Bubble menu renders even in read-only mode
          via a custom shouldShow override in NoteEditor so we get the same
          comment-icon-on-selection affordance the app has. */}
      <AnnotatedContent section="capture">
        <ProposalNodeProvider value={proposalNodeCtx}>
          {capture.content ? (
            <CommentableEditor
              section="capture"
              initialContent={capture.content}
              onUpdate={() => {}}
              readOnly
              extraExtensions={proposalExtensions}
              proposalRefs={proposalRefs}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No notes available.</p>
          )}
        </ProposalNodeProvider>
      </AnnotatedContent>

      {/* Transcript — optional collapsible section below the main content */}
      {capture.transcript && <TranscriptSection transcript={capture.transcript} />}
    </div>
  )
}

function TranscriptSection({ transcript }: { transcript: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-lg border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium text-muted-foreground hover:bg-muted/40"
      >
        <ChevronRight
          className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <ScrollText className="h-3.5 w-3.5" />
        Transcript
      </button>
      {open && (
        <div className="border-t px-4 py-3">
          <AnnotatedContent section="transcript">
            <div className="whitespace-pre-wrap text-sm leading-relaxed">
              {transcript}
            </div>
          </AnnotatedContent>
        </div>
      )}
    </div>
  )
}

function SharedDocumentView({ data }: { data: SharedDocumentData }) {
  const { document: doc } = data

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{doc.title}</h1>
        <p className="text-sm text-muted-foreground">
          Last updated {formatDate(doc.updated_at)}
        </p>
      </div>

      <Separator />

      <div className="prose prose-sm max-w-none dark:prose-invert">
        {doc.content ? (
          <AnnotatedContent section="document">
            {/* Public, unauthenticated surface: identifier chips are OFF so a
                share never calls the authenticated resolve endpoint. */}
            <EntityRefsProvider enabled={false}>
              <Markdown>{doc.content}</Markdown>
            </EntityRefsProvider>
          </AnnotatedContent>
        ) : (
          <p className="text-muted-foreground">No content.</p>
        )}
      </div>
    </div>
  )
}
