'use client'

import { Lightbulb, Megaphone, X, Star, Send, ExternalLink } from 'lucide-react'

interface InAppPreviewProps {
  messageType: string
  messageTitle: string
  messageBody: string
  ctaText: string
  ctaUrl: string
}

export function InAppPreview({
  messageType,
  messageTitle,
  messageBody,
  ctaText,
  ctaUrl,
}: InAppPreviewProps) {
  const title = messageTitle || 'Message title'
  const body = messageBody || 'Message body text goes here...'
  const hasUrl = ctaUrl.trim().length > 0

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-xs text-muted-foreground">
        Preview — this is how the message appears in the macOS app
      </p>

      <div className="w-[300px] rounded-xl border border-white/20 bg-white/80 p-5 shadow-xl backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/80">
        {messageType === 'tip' && (
          <TipPreview
            title={title}
            body={body}
            ctaText={ctaText}
            hasUrl={hasUrl}
          />
        )}
        {messageType === 'announcement' && (
          <AnnouncementPreview
            title={title}
            body={body}
            ctaText={ctaText}
            hasUrl={hasUrl}
          />
        )}
        {messageType === 'feedback_prompt' && (
          <FeedbackPromptPreview title={title} body={body} />
        )}
        {!['tip', 'announcement', 'feedback_prompt'].includes(messageType) && (
          <AnnouncementPreview
            title={title}
            body={body}
            ctaText={ctaText}
            hasUrl={hasUrl}
          />
        )}
      </div>
    </div>
  )
}

function CloseButton() {
  return (
    <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-black/5 dark:bg-white/10">
      <X className="h-[11px] w-[11px] text-neutral-400" />
    </div>
  )
}

function TipPreview({
  title,
  body,
  ctaText,
  hasUrl,
}: {
  title: string
  body: string
  ctaText: string
  hasUrl: boolean
}) {
  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-1.5">
          <Lightbulb className="h-3 w-3 text-yellow-500" />
          <span className="text-xs font-semibold text-neutral-500">Tip</span>
        </div>
        <CloseButton />
      </div>

      {/* Title */}
      <p className="text-sm font-semibold leading-tight text-neutral-900 dark:text-neutral-100">
        {title}
      </p>

      {/* Body */}
      <p className="text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {body}
      </p>

      {/* CTA */}
      {hasUrl && (
        <button className="flex w-full items-center justify-center gap-1 rounded-lg bg-blue-500 py-2 text-[13px] font-semibold text-white">
          {ctaText || 'Learn more'}
          <ExternalLink className="h-[9px] w-[9px]" />
        </button>
      )}
    </div>
  )
}

function AnnouncementPreview({
  title,
  body,
  ctaText,
  hasUrl,
}: {
  title: string
  body: string
  ctaText: string
  hasUrl: boolean
}) {
  return (
    <div className="space-y-3.5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-1.5">
          <Megaphone className="h-3 w-3 text-blue-500" />
          <span className="text-xs font-semibold text-neutral-500">
            Announcement
          </span>
        </div>
        <CloseButton />
      </div>

      {/* Title */}
      <p className="text-[15px] font-semibold leading-tight text-neutral-900 dark:text-neutral-100">
        {title}
      </p>

      {/* Body */}
      <p className="text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {body}
      </p>

      {/* Buttons */}
      {hasUrl ? (
        <div className="flex gap-2">
          <button className="flex-1 rounded-lg bg-black/5 py-2 text-[13px] font-medium text-neutral-500 dark:bg-white/10">
            Got it
          </button>
          <button className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-blue-500 py-2 text-[13px] font-semibold text-white">
            {ctaText || 'Learn more'}
            <ExternalLink className="h-[9px] w-[9px]" />
          </button>
        </div>
      ) : (
        <button className="w-full rounded-lg bg-blue-500 py-2 text-[13px] font-semibold text-white">
          {ctaText || 'Got it'}
        </button>
      )}
    </div>
  )
}

function FeedbackPromptPreview({
  title,
  body,
}: {
  title: string
  body: string
}) {
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <p className="text-[15px] font-semibold leading-tight text-neutral-900 dark:text-neutral-100">
          {title}
        </p>
        <CloseButton />
      </div>

      {/* Body */}
      <p className="text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {body}
      </p>

      {/* Star Rating */}
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-neutral-500">Rating</span>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((star) => (
            <Star
              key={star}
              className="h-5 w-5 text-neutral-300 dark:text-neutral-600"
            />
          ))}
        </div>
      </div>

      {/* Text Area */}
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-neutral-500">
          Your feedback
        </span>
        <div className="h-[80px] rounded-lg border border-black/10 bg-black/3 p-2 dark:border-white/10 dark:bg-white/5">
          <span className="text-[13px] text-neutral-300 dark:text-neutral-600">
            Type your feedback...
          </span>
        </div>
      </div>

      {/* Buttons */}
      <div className="flex gap-2">
        <button className="flex-1 rounded-lg bg-black/5 py-2 text-[13px] font-medium text-neutral-500 dark:bg-white/10">
          Later
        </button>
        <button className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-neutral-400 py-2 text-[13px] font-semibold text-white">
          <Send className="h-[11px] w-[11px]" />
          Send
        </button>
      </div>
    </div>
  )
}
