'use client'

/**
 * PLAIN WORDS WITH THEIR @-MENTIONS DRAWN (docs/plans/mentions-everywhere.md,
 * 3.6): a comment's or a message's body, whose mentions ride beside it in the
 * one format (`[{ type, id, label }]`, and the names of the people it
 * mentions). A record's `@label` is a LIVE chip that opens its card; a person's
 * is a highlight; everything else is the words, links drawn as links.
 *
 * A record chip shows the kind's icon and the stored label at once, then — once
 * the resolve answers — the record's current label and a small status word.
 * When the answer says the reader may not see it, the chip is drawn dimmed and
 * non-clickable, with a lock and the stored words. A kind nothing opens (or a
 * label no longer in the words) stays a plain highlight, so a reader who may
 * not see it learns only the words its author wrote.
 *
 * Inside a public share (`EntityRefsProvider enabled={false}`) no resolve runs:
 * the chip is drawn static, with the stored words.
 */
import { AtSign, Lock } from 'lucide-react'
import { Linkify } from '@/components/ui/linkify'
import { mentionOpens, openMention } from '@/lib/entity-links/open-mention'
import type { LabeledMentionRef } from '@/lib/entity-links/mentionable'
import { mentionSegments } from '@/lib/team-chat/compose'
import { EntityIcon } from '@/components/entities/entity-icon'
import { useEntityRefsEnabled } from './entity-refs-context'
import { useMention } from './use-mention'

const CHIP = 'rounded bg-primary/10 px-0.5 font-medium text-primary'
const ICON = 'mr-0.5 inline size-3 align-[-0.12em]'


/** `in_progress` → "In progress". */
function statusWord(status: string): string {
  const s = status.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function MentionText({
  text,
  people = [],
  records = [],
  from,
}: {
  text: string
  /** The names of the people it mentions, as its words show them. */
  people?: readonly string[]
  records?: readonly LabeledMentionRef[]
  /** Where a chip was opened from (open-card's `from`). */
  from: string
}) {
  if (!text.includes('@') || (people.length === 0 && records.length === 0)) return <Linkify text={text} />
  const byLabel = new Map(records.map((r) => [r.label.toLowerCase(), r]))
  return (
    <>
      {mentionSegments(text, [...people, ...records.map((r) => r.label)]).map((seg, i) => {
        if (!seg.mention) return <Linkify key={i} text={seg.text} />
        const record = byLabel.get(seg.text.replace(/^@/, '').toLowerCase())
        // A record a chip can open resolves live; a kind nothing opens, or a
        // person's name, stays a highlight (never read, so never leaked).
        return record && mentionOpens(record.type) ? (
          <RecordChip key={i} record={record} from={from} stored={seg.text} />
        ) : (
          <span key={i} data-person-mention="" className={CHIP}>
            {seg.text}
          </span>
        )
      })}
    </>
  )
}

/**
 * One record mention, resolved live. Shows its icon and stored words at once;
 * swaps to the current label and status when the resolve answers; locks (dimmed,
 * no click) when the answer says the reader may not see it. In a share nothing
 * resolves and the chip is static.
 */
function RecordChip({ record, from, stored }: { record: LabeledMentionRef; from: string; stored: string }) {
  const enabled = useEntityRefsEnabled()
  const state = useMention(record.type, record.id, enabled)
  const live = state.status === 'found' ? state.data : null

  // The reader may not see it: a dimmed, non-clickable chip with a lock and the stored words.
  if (state.status === 'hidden') {
    return (
      <span
        data-record-mention={record.type}
        data-mention-hidden=""
        title="You don’t have access to this"
        className={`${CHIP} cursor-default opacity-60`}
      >
        <Lock className={ICON} aria-hidden />
        {stored}
      </span>
    )
  }

  const body = (
    <>
      {/* The kind's own glyph and colour (entity-identity.ts); the words keep the chip's ink. */}
      <EntityIcon kind={record.type} fallback={AtSign} strokeWidth={2} className={ICON} />
      {live ? `@${live.label}` : stored}
      {live?.status ? (
        <span data-mention-status="" className="ml-1 text-[0.85em] font-normal opacity-70">
          {statusWord(live.status)}
        </span>
      ) : null}
    </>
  )

  // In a share (disabled) the chip is static — nothing to open, nothing fetched.
  if (!enabled) {
    return (
      <span data-record-mention={record.type} className={CHIP}>
        {body}
      </span>
    )
  }
  return (
    <button
      type="button"
      data-record-mention={record.type}
      onClick={() => void openMention(record, from)}
      className={`${CHIP} underline-offset-2 hover:underline`}
    >
      {body}
    </button>
  )
}
