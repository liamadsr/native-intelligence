'use client'

import { Star, Paperclip, Archive, Trash2, AlertCircle, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface EmailThreadLabel {
  id: string
  name: string
  color: string
}

interface EmailThread {
  id: string
  provider_thread_id: string
  subject: string | null
  snippet: string | null
  from_email: string | null
  from_name: string | null
  is_unread: boolean
  is_starred: boolean
  has_attachments: boolean
  needs_reply: boolean
  /**
   * email.trust's mark (migration 334): 'suspicious' (phishing or
   * impersonation) or 'injection' (text aimed at an AI assistant). Null or
   * absent when unmarked, which is every thread until trust is enforced.
   */
  trust?: 'suspicious' | 'injection' | null
  /** The revision the trust mark is about; the mark shows only while it is still the latest. */
  trust_message_id?: string | null
  provider_message_id?: string | null
  /** Held beside a reply draft (src/lib/email/hold.ts): its subject comes from the hold. */
  held?: boolean
  held_subject?: string | null
  /** The live header call got nothing for this row (failed, timed out, or no answer): a neutral line, not loading. */
  header_unavailable?: boolean
  /** A search result: its header came from the provider with the row (src/lib/email/search-result-rows.ts). */
  live?: boolean
  /** A search result this workspace's index has (false: older than the index, or not indexed yet). */
  indexed?: boolean
  /** The held draft is stale: a new message came after the person edited it. */
  held_stale?: boolean
  message_count: number
  last_message_at: string | null
  labels?: EmailThreadLabel[]
  account_id?: string | null
  connected_account?: {
    id: string
    account_email: string
    display_name: string | null
    color: string
  } | null
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

function formatRelativeDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return date.toLocaleDateString('en-US', { weekday: 'short' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

interface EmailThreadItemProps {
  thread: EmailThread
  isSelected: boolean
  onClick: () => void
  onToggleStar: (e: React.MouseEvent) => void
  onArchive?: (e: React.MouseEvent) => void
  onTrash?: (e: React.MouseEvent) => void
}

export function EmailThreadItem({
  thread,
  isSelected,
  onClick,
  onToggleStar,
  onArchive,
  onTrash,
}: EmailThreadItemProps) {
  const displayName = thread.from_name || thread.from_email || 'Unknown'

  return (
    <div
      onClick={onClick}
      className={cn(
        'group relative flex cursor-pointer items-start gap-3 rounded-lg mx-1 px-3 py-2.5 text-left text-sm transition-colors',
        'hover:bg-muted/50 dark:hover:bg-primary/5',
        isSelected && 'bg-muted dark:bg-primary/5',
      )}
    >
      {/* Avatar */}
      <div className="mt-0.5 shrink-0">
        <div
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium',
            'bg-muted',
          )}
        >
          {getInitials(displayName)}
        </div>
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        {/* Row 1: Sender + reply count + date/hover actions */}
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={cn(
                'truncate text-sm',
                thread.is_unread ? 'font-semibold' : 'font-medium',
              )}
            >
              {displayName}
            </span>
            {thread.is_unread && !isSelected && (
              <span className="ml-0.5 size-1.5 shrink-0 rounded-full bg-blue-500" />
            )}
            {thread.message_count > 1 && (
              <span className="shrink-0 text-xs text-muted-foreground opacity-70">
                [{thread.message_count}]
              </span>
            )}
          </div>

          {/* Right side: fixed-width container with date + hover actions stacked */}
          <div className="relative ml-auto flex h-7 w-[116px] shrink-0 items-center justify-end">
            {/* Date — fades out on hover */}
            <span className="text-xs text-muted-foreground opacity-70 transition-opacity group-hover:opacity-0">
              {formatRelativeDate(thread.last_message_at)}
            </span>

            {/* Hover actions — overlaid on top, fades in on hover */}
            <div
              className="absolute inset-0 flex items-center justify-end gap-0.5 rounded-lg border bg-background p-0.5 shadow-sm opacity-0 transition-opacity group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 [&_svg]:size-3.5"
                      onClick={onToggleStar}
                    >
                      <Star
                        className={cn(
                          thread.is_starred
                            ? 'fill-yellow-400 stroke-yellow-400'
                            : 'fill-transparent stroke-muted-foreground/60',
                        )}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {thread.is_starred ? 'Unstar' : 'Star'}
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 hover:bg-orange-100 dark:hover:bg-orange-900/40 [&_svg]:size-3.5"
                      onClick={(e) => {
                        e.stopPropagation()
                      }}
                    >
                      <AlertCircle className="stroke-muted-foreground/60" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">Mark important</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 [&_svg]:size-3.5"
                      onClick={onArchive}
                    >
                      <Archive className="stroke-muted-foreground/60" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">Archive</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 hover:bg-red-100 dark:hover:bg-red-900/30 [&_svg]:size-3.5"
                      onClick={onTrash}
                    >
                      <Trash2 className="stroke-red-500" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">Delete</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        </div>

        {/* Row 2: Subject + labels + indicators */}
        <div className="flex items-center gap-1.5 mt-0.5">
          <p
            className={cn(
              'truncate text-sm',
              thread.is_unread ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            {/* The subject comes live (no stored mail): a bar while it loads, a
                neutral line once the mailbox did not answer, never "(no subject)". */}
            {thread.subject || thread.held_subject || (thread.header_unavailable ? (
              <span data-subject-unavailable="" className="text-muted-foreground/70">Open to read</span>
            ) : (
              <span data-subject-placeholder="" aria-label="Loading subject" className="inline-block h-2.5 w-40 max-w-full rounded bg-muted align-middle" />
            ))}
          </p>
          {thread.held && (
            <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              {thread.held_stale ? 'New reply since draft' : 'Draft ready'}
            </span>
          )}
          {thread.labels && thread.labels.length > 0 && (
            <>
              {thread.labels.map((label) => (
                <Badge
                  key={label.id}
                  variant="outline"
                  className="shrink-0 gap-1 px-1.5 py-0 text-[10px]"
                >
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  {label.name}
                </Badge>
              ))}
            </>
          )}
          {currentTrustMark(thread) && <SuspiciousChip trust={currentTrustMark(thread)!} />}
          {thread.has_attachments && (
            <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          {thread.is_starred && (
            <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
          )}
        </div>

        {/* Row 3: Snippet preview */}
        {thread.snippet && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {thread.snippet}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * The thread's trust mark, only while it is about the thread's latest message
 * (trust_message_id equals provider_message_id): a newer message, which may
 * be safe, hides a stale mark until it is judged itself.
 */
export function currentTrustMark(thread: Pick<EmailThread, 'trust' | 'trust_message_id' | 'provider_message_id'>): 'suspicious' | 'injection' | null {
  if (!thread.trust) return null
  if (!thread.trust_message_id || thread.trust_message_id !== thread.provider_message_id) return null
  return thread.trust
}

/**
 * The "Suspicious" chip: Jev flagged this thread (email.trust). Shown only
 * when the thread carries a trust mark.
 */
export function SuspiciousChip({ trust }: { trust: 'suspicious' | 'injection' }) {
  const why =
    trust === 'suspicious'
      ? 'This looks like phishing or impersonation. Dial8 drafted no reply. Check the sender before you click anything.'
      : 'This email contains text aimed at an AI assistant. Dial8 treats it as data only.'
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            data-testid="suspicious-chip"
            className="shrink-0 gap-1 border-amber-500/40 px-1.5 py-0 text-[10px] text-amber-700 dark:text-amber-400"
          >
            <ShieldAlert className="h-3 w-3" />
            Suspicious
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[240px] text-xs">{why}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export type { EmailThread }
