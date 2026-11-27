/**
 * The words of Settings › Autonomy's "What the agent has earned" rows
 * (docs/plans/earned-autonomy.md §6). Pure, so the list says what the rules
 * say and the tests read the same sentences.
 */
import type { KindSummary } from './records'

export const LEVEL_WORDS = { ask: 'Asks first', tell: 'Does it and tells you', quiet: 'Does it quietly' } as const

function n(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "12 approved as shown, 1 after edits, 2 dismissed". Neutral ones (expired, failed) are left out. */
export function recordLine(kind: Pick<KindSummary, 'counts'>): string {
  const c = kind.counts
  const parts = [
    c.approved ? `${c.approved} approved as shown` : '',
    c.approved_edited ? `${c.approved_edited} after edits` : '',
    c.dismissed ? `${c.dismissed} dismissed` : '',
    c.ran ? `${c.ran} done on its own` : '',
    c.undone ? `${c.undone} undone` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'Nothing settled yet'
}

/** What it still needs before the agent may offer to take it over, or why it never will. */
export function needsLine(kind: Pick<KindSummary, 'alwaysAsks' | 'eligible' | 'blocked' | 'needs' | 'level'>): string {
  if (kind.alwaysAsks) return kind.alwaysAsks.words
  if (kind.eligible) return 'Ready: the agent can offer to take this over'
  switch (kind.blocked) {
    case 'pinned':
      return 'You said always ask'
    case 'at_top':
      return 'Fully handed over'
    case 'recent_no':
      return 'Waiting: you said no to one recently'
    case 'demotion_cooldown':
      return 'Waiting: back to asking after an undo'
    case 'declined_cooldown':
      return 'Waiting: you said not now'
    case 'distinct_days':
      return 'Needs approvals on a few more different days'
    default: {
      const parts = [kind.needs.more ? n(kind.needs.more, 'more clean approval', 'more clean approvals') : '', kind.needs.days ? n(kind.needs.days, 'more day', 'more days') : ''].filter(Boolean)
      return parts.length ? `Needs ${parts.join(' over ')}` : 'Building a record'
    }
  }
}
