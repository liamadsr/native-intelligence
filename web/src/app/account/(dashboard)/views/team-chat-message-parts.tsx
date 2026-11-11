'use client'

/**
 * The pieces of a team chat message beyond its words (migrations 555-557),
 * for team-chat-view.tsx: its files and images, its link's preview, its
 * reactions as chips (and the button that opens the picker), the bar under a
 * thread's root, and the avatars they show. Each draws nothing when it has
 * nothing to show (no "0 reactions", no empty thread bar).
 */
import { useEffect, useState } from 'react'
import { Bot, FileText, SmilePlus } from 'lucide-react'
import { Avatar as AvatarRoot, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { PopoverAnchor } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { ReactionPickerPopover } from '@/app/account/(dashboard)/chat/reaction-picker'
import { formatFileSize, isInlineImage } from '@/lib/team-chat/files'
import { cachedTeamChatFileUrl, teamChatFileUrl } from '@/lib/team-chat/upload-client'
import { lastReplyLabel, replyCountLabel, type ReactionGroup } from '@/lib/team-chat/compose'
import type { TeamChatAttachment, TeamChatLinkPreview, TeamChatThreadSummary } from '@/lib/team-chat/types'

export interface Member {
  id: string
  user_id?: string
  display_name: string | null
  avatar_url?: string | null
}

export function memberName(m: Member | undefined): string {
  return m?.display_name?.trim() || 'Teammate'
}

/** A name's initials for its avatar: the first and last words' ("Rosa Lind": RL). */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0].charAt(0)
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : ''
  return (first + last).toUpperCase()
}

const AVATAR_SIZES = {
  xs: { box: 'h-5 w-5 text-[9px]', icon: 'h-3 w-3' },
  sm: { box: 'h-6 w-6 text-[10px]', icon: 'h-3.5 w-3.5' },
  md: { box: 'h-9 w-9 text-xs', icon: 'h-4 w-4' },
} as const

/** A round avatar: the person's photo when known, else their initials; an agent's, its own (violet, a bot). */
export function Avatar({
  name,
  url,
  agent = false,
  size = 'md',
  className,
}: {
  name: string
  url?: string | null
  agent?: boolean
  size?: keyof typeof AVATAR_SIZES
  className?: string
}) {
  const { box, icon } = AVATAR_SIZES[size]
  if (agent) {
    return (
      <span className={cn('flex shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-violet-600 dark:text-violet-300', box, className)} aria-hidden>
        <Bot className={icon} />
      </span>
    )
  }
  return (
    <AvatarRoot className={cn(box, className)} aria-hidden>
      {url && <AvatarImage src={url} alt="" className="object-cover" />}
      <AvatarFallback className="bg-muted font-semibold text-muted-foreground">{initials(name)}</AvatarFallback>
    </AvatarRoot>
  )
}

// ── Files ───────────────────────────────────────────────────────────────────

/** A link to a file the person may read: the cached one at once, else signed (null until then, or when they may not). */
function useFileUrl(path: string): string | null {
  const [url, setUrl] = useState<string | null>(() => cachedTeamChatFileUrl(path))
  useEffect(() => {
    if (url) return
    let alive = true
    void teamChatFileUrl(path).then((signed) => {
      if (alive) setUrl(signed)
    })
    return () => {
      alive = false
    }
  }, [path, url])
  return url
}

/** The tallest and widest an inline image is drawn, px. */
const IMAGE_MAX = { width: 320, height: 240 }

function InlineImage({ attachment }: { attachment: TeamChatAttachment }) {
  const url = useFileUrl(attachment.path)
  const { width = 4, height = 3 } = attachment
  // Its own shape, within the box, so it takes its room before it loads.
  const scale = Math.min(1, IMAGE_MAX.width / width, IMAGE_MAX.height / height)
  const box = { width: Math.round(width * scale), height: Math.round(height * scale) }
  const shown = attachment.width && attachment.height ? box : { width: IMAGE_MAX.width, height: IMAGE_MAX.height * 0.75 }
  return (
    <a
      href={url ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      data-team-chat-image=""
      className="block max-w-full overflow-hidden rounded-xl bg-muted"
      style={{ width: shown.width, aspectRatio: `${shown.width} / ${shown.height}` }}
      title={attachment.name}
    >
      {url && <img src={url} alt={attachment.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />}
    </a>
  )
}

function FileChip({ attachment }: { attachment: TeamChatAttachment }) {
  const url = useFileUrl(attachment.path)
  return (
    <a
      href={url ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      download={attachment.name}
      data-team-chat-file=""
      onClick={async (e) => {
        // A link signed over an hour ago has run out: sign it again first.
        if (cachedTeamChatFileUrl(attachment.path)) return
        e.preventDefault()
        const fresh = await teamChatFileUrl(attachment.path)
        if (fresh) window.open(fresh, '_blank', 'noopener')
      }}
      className="flex max-w-xs items-center gap-2.5 rounded-xl bg-muted/60 px-3 py-2 text-left hover:bg-muted"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
        <FileText className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{attachment.name}</span>
        <span className="block text-xs text-muted-foreground">{formatFileSize(attachment.size)}</span>
      </span>
    </a>
  )
}

/** A message's files: images drawn inline, the rest as chips with their name and size. Nothing without any. */
export function MessageAttachments({ attachments }: { attachments: readonly TeamChatAttachment[] | undefined }) {
  if (!attachments?.length) return null
  const images = attachments.filter(isInlineImage)
  const files = attachments.filter((a) => !isInlineImage(a))
  return (
    <div className="mt-1.5 flex flex-col gap-1.5" data-team-chat-attachments="">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((a) => (
            <InlineImage key={a.path} attachment={a} />
          ))}
        </div>
      )}
      {files.map((a) => (
        <FileChip key={a.path} attachment={a} />
      ))}
    </div>
  )
}

// ── The link's preview ──────────────────────────────────────────────────────

/** A message's first link, as the server read it: its site, title, description and image. Nothing without one. */
export function LinkPreviewCard({ preview }: { preview: TeamChatLinkPreview | null | undefined }) {
  const [imageFailed, setImageFailed] = useState(false)
  if (!preview || !/^https?:\/\//i.test(preview.url) || (!preview.title && !preview.description)) return null
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      data-team-chat-link-preview=""
      className="mt-1.5 flex max-w-md gap-3 rounded-xl bg-muted/50 p-3 hover:bg-muted/70"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-muted-foreground">{preview.site}</span>
        {preview.title && <span className="mt-0.5 line-clamp-2 block text-sm font-semibold text-foreground">{preview.title}</span>}
        {preview.description && <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-muted-foreground">{preview.description}</span>}
      </span>
      {preview.image && !imageFailed && (
        <img
          src={preview.image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
          className="h-16 w-16 shrink-0 rounded-lg object-cover"
        />
      )}
    </a>
  )
}

// ── Reactions ───────────────────────────────────────────────────────────────

/** The button that opens the reaction picker: in a message's hover toolbar, or after its chips. */
export function ReactButton({
  isSelected,
  onPick,
  onOpenChange,
  variant = 'toolbar',
}: {
  isSelected: (emoji: string) => boolean
  onPick: (emoji: string) => void
  /** The toolbar stays up while the picker is open. */
  onOpenChange?: (open: boolean) => void
  variant?: 'toolbar' | 'chip'
}) {
  const [open, setOpen] = useState(false)
  const change = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }
  return (
    <ReactionPickerPopover
      open={open}
      onOpenChange={change}
      isSelected={isSelected}
      onPick={(emoji) => {
        change(false)
        onPick(emoji)
      }}
    >
      <PopoverAnchor asChild>
        <button
          type="button"
          aria-label="Add a reaction"
          title="Add a reaction"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-team-chat-react=""
          onClick={() => change(!open)}
          className={
            variant === 'toolbar'
              ? 'rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground'
              : 'flex h-6 w-7 items-center justify-center rounded-full border border-border/70 text-muted-foreground hover:border-border hover:text-foreground'
          }
        >
          <SmilePlus className="h-3.5 w-3.5" />
        </button>
      </PopoverAnchor>
    </ReactionPickerPopover>
  )
}

/**
 * A message's reactions: one chip per emoji with its count, lit when the
 * person reacted with it (a press takes theirs off or adds it), then the
 * picker's button. Nothing without any.
 */
export function ReactionChips({
  groups,
  names,
  onToggle,
  canReact,
}: {
  groups: readonly ReactionGroup[]
  /** Who reacted, for each chip's title. */
  names: (memberIds: readonly string[]) => string
  onToggle: (emoji: string, on: boolean) => void
  canReact: boolean
}) {
  if (groups.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-team-chat-reactions="">
      {groups.map((g) => (
        <button
          key={g.emoji}
          type="button"
          disabled={!canReact}
          aria-pressed={g.mine}
          aria-label={`${g.emoji} ${g.count}${g.mine ? ', you reacted' : ''}`}
          title={names(g.memberIds)}
          data-team-chat-reaction={g.emoji}
          onClick={() => onToggle(g.emoji, !g.mine)}
          className={cn(
            'flex h-6 items-center gap-1 rounded-full border px-2 text-xs tabular-nums disabled:cursor-default',
            g.mine ? 'border-primary/40 bg-primary/10 font-medium text-foreground' : 'border-border/70 bg-background text-muted-foreground hover:border-border',
          )}
        >
          <span className="text-[14px] leading-none">{g.emoji}</span>
          {g.count}
        </button>
      ))}
      {canReact && <ReactButton variant="chip" isSelected={(emoji) => groups.some((g) => g.mine && g.emoji === emoji)} onPick={(emoji) => onToggle(emoji, !groups.some((g) => g.mine && g.emoji === emoji))} />}
    </div>
  )
}

// ── A thread under its root ─────────────────────────────────────────────────

/**
 * Under a thread's root: the last few people who replied, how many replies,
 * when the last was, and how many the person hasn't read. A press opens the
 * thread beside the channel. Nothing without a reply.
 */
export function ThreadBar({
  summary,
  unread,
  membersById,
  open,
  onOpen,
}: {
  summary: TeamChatThreadSummary | undefined
  unread: number
  membersById: Map<string, Member>
  /** The thread is the one open beside the channel. */
  open: boolean
  onOpen: () => void
}) {
  if (!summary || summary.reply_count <= 0) return null
  const people = summary.participant_ids.slice(0, 3)
  return (
    <button
      type="button"
      onClick={onOpen}
      data-team-chat-thread-bar=""
      aria-label={`${replyCountLabel(summary.reply_count)}${unread > 0 ? `, ${unread} new` : ''}. Open the thread`}
      className={cn('-ml-1.5 mt-1 flex max-w-full items-center gap-2 rounded-lg px-1.5 py-1 text-[13px] hover:bg-accent/60', open && 'bg-accent/60')}
    >
      {people.length > 0 && (
        <span className="flex shrink-0 -space-x-1">
          {people.map((id) => {
            const m = membersById.get(id)
            return <Avatar key={id} name={memberName(m)} url={m?.avatar_url} size="sm" className="ring-2 ring-background" />
          })}
        </span>
      )}
      <span className="shrink-0 font-semibold text-primary">{replyCountLabel(summary.reply_count)}</span>
      {unread > 0 && <span className="shrink-0 rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-[18px] text-primary-foreground">{unread} new</span>}
      {summary.last_reply_at && <span className="min-w-0 truncate text-muted-foreground">Last reply {lastReplyLabel(summary.last_reply_at)}</span>}
    </button>
  )
}
