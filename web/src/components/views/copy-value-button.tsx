'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { copyTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

const COPIED_MS = 1500

/**
 * Hover-reveal copy button for one field value.
 *
 * Drop it at the end of any row whose wrapper carries the `group/row` class:
 * the button stays invisible (but in the layout, so nothing shifts) until the
 * row is hovered or the button itself is focused, and shows unconditionally
 * on touch screens where there is no hover. Renders nothing for an empty
 * value — there is nothing to copy, and an inert icon would just be noise.
 *
 * Copies the RAW value, never a display form: a URL row copies the full URL,
 * not the scheme-stripped label. `mousedown` is swallowed so clicking the
 * button beside a focused text input doesn't blur it (a blur commits a PATCH
 * on the property rows).
 */
export function CopyValueButton({
  value,
  label,
  className,
}: {
  value: string | null | undefined
  /** What the tooltip names ("Copy email"). Falls back to "Copy". */
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null

  const title = copied ? 'Copied' : label ? `Copy ${label.toLowerCase()}` : 'Copy'

  return (
    <button
      type="button"
      data-copied={copied ? 'true' : undefined}
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={async (e) => {
        e.preventDefault()
        e.stopPropagation()
        const ok = await copyTextToClipboard(text)
        if (!ok) return
        if (timerRef.current) clearTimeout(timerRef.current)
        setCopied(true)
        timerRef.current = setTimeout(() => {
          setCopied(false)
          timerRef.current = null
        }, COPIED_MS)
      }}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity',
        'opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 data-[copied=true]:opacity-100',
        '[@media(hover:none)]:opacity-100',
        className,
      )}
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-500" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  )
}
