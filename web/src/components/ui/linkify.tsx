'use client'

/**
 * Plain text with its web links clickable: comments, the person's own chat
 * messages, plain-text emails, event descriptions and the other places that
 * show a string as-is. Renders a fragment, so it drops into the element that
 * already holds the text and keeps its styling (whitespace-pre-wrap included).
 *
 * Each link is a plain <a href target=_blank>: a new tab on the web, and the
 * user's own browser on desktop. A click on a link doesn't also click the row
 * or card it sits in.
 */

import { Fragment, useMemo, type MouseEvent } from 'react'
import { splitByUrls } from '@/lib/linkify'
import { EXTERNAL_LINK_PROPS } from '@/lib/open-external'
import { cn } from '@/lib/utils'

/** Keeps the surrounding text's colour (a chat bubble's `prose` would grey it). */
export const TEXT_LINK_CLASS = 'text-inherit underline underline-offset-2 hover:opacity-80 [overflow-wrap:anywhere]'

const stopPropagation = (e: MouseEvent) => e.stopPropagation()

export function Linkify({ text, linkClassName }: { text: string | null | undefined; linkClassName?: string }) {
  const parts = useMemo(() => splitByUrls(text ?? ''), [text])
  return (
    <>
      {parts.map((part, i) =>
        part.url ? (
          <a
            key={i}
            href={part.url}
            {...EXTERNAL_LINK_PROPS}
            className={cn(TEXT_LINK_CLASS, linkClassName)}
            onClick={stopPropagation}
          >
            {part.text}
          </a>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  )
}
