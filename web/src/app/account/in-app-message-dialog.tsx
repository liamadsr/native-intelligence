'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Star, CheckCircle2, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { useInAppMessages, type InAppMessage } from './in-app-message-context'
import { messageMeta, MESSAGE_ICON_CHIP, MESSAGE_LABEL } from './in-app-message-meta'
import { Linkify } from '@/components/ui/linkify'

/**
 * The detail popup for an admin message, opened from its toast. Three variants:
 *   - announcement / tip : full title + body + optional CTA link
 *   - feedback_prompt    : the answer form (rating + text), posts to the respond route
 *
 * Driven by the in-app message context's `openMessage`.
 */
export function InAppMessageDialog() {
  const { openMessage, close, dismiss, refetch } = useInAppMessages()

  return (
    <Dialog open={!!openMessage} onOpenChange={(o) => { if (!o) close() }}>
      {openMessage && (
        <DialogContent className="sm:max-w-lg">
          {openMessage.message_type === 'feedback_prompt' ? (
            <FeedbackBody message={openMessage} onClose={close} onDismiss={dismiss} onAnswered={refetch} />
          ) : (
            <AnnouncementBody message={openMessage} onClose={close} />
          )}
        </DialogContent>
      )}
    </Dialog>
  )
}

// ─── Announcement / Tip ──────────────────────────────────────────────────────

function AnnouncementBody({ message, onClose }: { message: InAppMessage; onClose: () => void }) {
  const meta = messageMeta(message.message_type)
  const Icon = meta.icon
  const hasLink = message.cta_action === 'url' && !!message.cta_url

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <span className={cn('h-7 w-7', MESSAGE_ICON_CHIP)}>
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className={MESSAGE_LABEL}>{meta.label}</span>
        </div>
        <DialogTitle className="mt-2 text-left text-lg leading-snug">{message.message_title}</DialogTitle>
      </DialogHeader>

      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
        <Linkify text={message.message_body} />
      </p>

      <DialogFooter>
        {hasLink ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button asChild>
              <a href={message.cta_url!} target="_blank" rel="noopener noreferrer" onClick={onClose}>
                {message.cta_text?.trim() || 'Learn more'}
                <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </a>
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>{message.cta_text?.trim() || 'Got it'}</Button>
        )}
      </DialogFooter>
    </>
  )
}

// ─── Feedback prompt ─────────────────────────────────────────────────────────

function FeedbackBody({
  message,
  onClose,
  onDismiss,
  onAnswered,
}: {
  message: InAppMessage
  onClose: () => void
  onDismiss: (id: string) => void
  onAnswered: () => Promise<void>
}) {
  const meta = messageMeta('feedback_prompt')
  const Icon = meta.icon

  const existing = message.message_responses?.[0]
  const alreadyAnswered = !!existing || message.status === 'responded'

  const [rating, setRating] = useState(0)
  const [hoverRating, setHoverRating] = useState(0)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  // Reset transient form state when switching to a different message.
  useEffect(() => {
    setRating(0)
    setHoverRating(0)
    setText('')
    setSent(false)
  }, [message.id])

  async function submit() {
    if (rating === 0 && !text.trim()) {
      toast.error('Add a rating or a comment')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/account/messages/${message.id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating: rating || undefined,
          response_text: text.trim() || undefined,
        }),
      })
      if (res.ok) {
        toast.success('Thanks for your feedback!')
        setSent(true)
        await onAnswered()
      } else {
        const err = await res.json().catch(() => ({ error: 'Failed to submit' }))
        toast.error(err.error || 'Failed to submit')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const done = alreadyAnswered || sent

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <span className={cn('h-7 w-7', MESSAGE_ICON_CHIP)}>
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className={MESSAGE_LABEL}>{meta.label}</span>
        </div>
        <DialogTitle className="mt-2 text-left text-lg leading-snug">{message.message_title}</DialogTitle>
      </DialogHeader>

      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
        <Linkify text={message.message_body} />
      </p>

      {done ? (
        <div className="mt-2 rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            Response sent
          </div>
          {existing?.rating ? (
            <div className="mt-2 flex items-center gap-0.5">
              {[1, 2, 3, 4, 5].map((s) => (
                <Star
                  key={s}
                  className={cn(
                    'h-4 w-4',
                    s <= (existing.rating ?? 0) ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40',
                  )}
                />
              ))}
            </div>
          ) : null}
          {existing?.response_text && (
            <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{existing.response_text}</p>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {/* Rating */}
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              How would you rate this? <span className="font-normal lowercase">(optional)</span>
            </p>
            <div className="flex items-center gap-1" onMouseLeave={() => setHoverRating(0)}>
              {[1, 2, 3, 4, 5].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setRating(s === rating ? 0 : s)}
                  onMouseEnter={() => setHoverRating(s)}
                  className="p-0.5"
                  aria-label={`${s} star${s > 1 ? 's' : ''}`}
                >
                  <Star
                    className={cn(
                      'h-6 w-6 transition-colors',
                      s <= (hoverRating || rating)
                        ? 'fill-amber-400 text-amber-400'
                        : 'text-muted-foreground/40 hover:text-muted-foreground',
                    )}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* Text */}
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your feedback</p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              placeholder="Tell us what you think…"
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              autoFocus
            />
          </div>
        </div>
      )}

      <DialogFooter>
        {done ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onDismiss(message.id)} disabled={submitting}>
              Dismiss
            </Button>
            <Button onClick={submit} disabled={submitting || (rating === 0 && !text.trim())}>
              {submitting ? 'Sending…' : 'Send feedback'}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  )
}
