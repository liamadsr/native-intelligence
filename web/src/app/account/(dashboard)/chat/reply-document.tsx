'use client'

/**
 * The long part of a reply, folded (lib/chat/split-long-reply.ts): its title
 * and the first lines fading out, a block the person opens to read. Open, it
 * takes the whole window over the same soft backdrop as a full-screen card,
 * the text on one white page (Liam's reference: a story told in a block you
 * open, not a wall of text in the chat).
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Minimize2, MoreHorizontal } from 'lucide-react'
import { MessageContent } from '@/components/ui/message'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { isOutsideCardPress } from '@/components/chat-cards/outside-card-press'
import { hasTrafficLights } from '@/lib/platform'
import { cn } from '@/lib/utils'

/** The reader's round buttons: light, over the soft backdrop. */
const ROUND_BUTTON =
  'inline-flex size-11 items-center justify-center rounded-full bg-background/80 text-foreground shadow-md shadow-black/10 backdrop-blur-sm transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function ReplyDocument({ title, body }: { title: string | null; body: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      {/* A div acting as the button: the preview's markdown draws buttons of
          its own (entity chips), and a <button> can't hold another. */}
      <div
        role="button"
        tabIndex={0}
        data-reply-document=""
        // The talk after it rides its foot (tailwind.css, data-chat-panel).
        data-chat-panel="document"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          setOpen(true)
        }}
        aria-label={title ? `Open “${title}”` : 'Open the full reply'}
        className="group w-full cursor-pointer self-start rounded-[28px] border border-border/60 bg-black/[0.04] p-2 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-white/10 dark:bg-white/[0.06]"
      >
        {title && <div className="px-3 pb-2 pt-2.5 font-serif text-[22px] font-medium leading-tight text-foreground">{title}</div>}
        {/* A preview only: nothing in it takes a click or the focus. */}
        <div aria-hidden inert className="pointer-events-none relative max-h-[9.5rem] overflow-hidden rounded-[20px] bg-background px-4 py-3">
          <MessageContent markdown className="max-w-none bg-transparent p-0 text-[15px]">
            {body}
          </MessageContent>
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-background" />
        </div>
      </div>
      {open && <ReplyReader title={title} body={body} onClose={() => setOpen(false)} />}
    </>
  )
}

function ReplyReader({ title, body, onClose }: { title: string | null; body: string; onClose: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const pageRef = React.useRef<HTMLElement>(null)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    ref.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      // A menu open in the reader closes first.
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="menu"][data-state="open"]')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(title ? `# ${title}\n\n${body}` : body)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // The clipboard said no (no permission): nothing to undo.
    }
  }

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={title ?? 'Reply'}
      tabIndex={-1}
      data-reply-reader=""
      className="card-focus-backdrop fixed inset-0 z-50 flex flex-col items-center px-4 pb-6 pt-20 outline-none"
      // A press anywhere off the page (and off its buttons) closes it, as a
      // full-screen card's does: the same rule (isOutsideCardPress).
      onPointerDown={(e) => {
        if (!isOutsideCardPress(e, pageRef.current)) return
        e.preventDefault()
        onClose()
      }}
    >
      {/* Clear of the macOS traffic lights in the Mac app. */}
      <div className={cn('absolute', hasTrafficLights() ? 'left-[84px] top-3' : 'left-4 top-4')}>
        <button type="button" onClick={onClose} aria-label="Back into the chat" title="Back into the chat" className={ROUND_BUTTON}>
          <Minimize2 className="size-4" strokeWidth={2} />
        </button>
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-6 truncate px-32 text-center text-[15px] font-medium text-foreground/80">
        {title ?? 'Reply'}
      </div>
      <div className="absolute right-4 top-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="More" title="More" className={ROUND_BUTTON}>
              <MoreHorizontal className="size-4" strokeWidth={2} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={() => void copy()}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <article ref={pageRef} className="min-h-0 w-full max-w-[760px] flex-1 select-text overflow-y-auto rounded-[28px] bg-background px-6 py-8 shadow-2xl sm:px-10 sm:py-10">
        {title && <h1 className="mb-6 font-serif text-[30px] font-medium leading-tight text-foreground sm:text-[34px]">{title}</h1>}
        <MessageContent markdown className="max-w-none bg-transparent p-0 text-[15px] leading-relaxed">
          {body}
        </MessageContent>
      </article>
    </div>,
    document.body,
  )
}
