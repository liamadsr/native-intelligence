'use client'

/**
 * PLAIN WORDS WITH THEIR @-MENTIONS DRAWN (docs/plans/mentions-everywhere.md,
 * 3.6): a comment's or a message's body, whose mentions ride beside it in the
 * one format (`[{ type, id, label }]`, and the names of the people it
 * mentions). A record's `@label` is a chip that opens its card; a person's is
 * a highlight; everything else is the words, links drawn as links.
 *
 * A kind nothing opens (or a label no longer in the words) stays plain or
 * highlighted text: nothing here reads the record, so a reader who may not
 * see it learns only the words its author wrote.
 */
import { Linkify } from '@/components/ui/linkify'
import { mentionOpens, openMention } from '@/lib/entity-links/open-mention'
import type { LabeledMentionRef } from '@/lib/entity-links/mentionable'
import { mentionSegments } from '@/lib/team-chat/compose'

const CHIP = 'rounded bg-primary/10 px-0.5 font-medium text-primary'

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
        return record && mentionOpens(record.type) ? (
          <button
            key={i}
            type="button"
            data-record-mention={record.type}
            onClick={() => void openMention(record, from)}
            className={`${CHIP} underline-offset-2 hover:underline`}
          >
            {seg.text}
          </button>
        ) : (
          <span key={i} data-person-mention="" className={CHIP}>
            {seg.text}
          </span>
        )
      })}
    </>
  )
}
