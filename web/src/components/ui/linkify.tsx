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
 *
 * `entityRefs`: action identifiers (GEN-297, …) in the text outside its links
 * become the live chips rendered Markdown draws (EntityRefChip: a status dot,
 * the title on hover, its details on a click), split by the Markdown's own
 * splitter (remark-entity-refs.ts). An identifier that resolves to no action
 * reads as written. For text a coding agent wrote about the actions it worked
 * on: a job's "What happened" (work-item-detail-panel.tsx).
 */

import { Fragment, useMemo, type MouseEvent } from 'react'
import { splitByUrls } from '@/lib/linkify'
import { EXTERNAL_LINK_PROPS } from '@/lib/open-external'
import { cn } from '@/lib/utils'
import { EntityRefChip } from '@/components/entity-refs/entity-ref-chip'
import { splitTextNode } from '@/components/entity-refs/remark-entity-refs'

/** Keeps the surrounding text's colour (a chat bubble's `prose` would grey it). */
export const TEXT_LINK_CLASS = 'text-inherit underline underline-offset-2 hover:opacity-80 [overflow-wrap:anywhere]'

const stopPropagation = (e: MouseEvent) => e.stopPropagation()

/** Plain text with its action identifiers as chips, else the text as it is. */
function WithEntityRefs({ text }: { text: string }) {
  const nodes = splitTextNode({ type: 'text', value: text })
  if (!nodes) return <>{text}</>
  return (
    <>
      {nodes.map((node, i) =>
        node.type === 'text' ? (
          <Fragment key={i}>{node.value}</Fragment>
        ) : (
          <EntityRefChip key={i} identifier={(node.data?.hProperties as { identifier?: string } | undefined)?.identifier} />
        ),
      )}
    </>
  )
}

export function Linkify({
  text,
  linkClassName,
  entityRefs = false,
}: {
  text: string | null | undefined
  linkClassName?: string
  /** Its action identifiers as live chips (see above). */
  entityRefs?: boolean
}) {
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
        ) : entityRefs ? (
          <WithEntityRefs key={i} text={part.text} />
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  )
}
