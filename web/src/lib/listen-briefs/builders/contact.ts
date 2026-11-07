import { gatherPersonContext, type PersonContext } from '@/lib/crm/person-context'
import type { BriefContext } from '../context'
import { Speech, clause, count, firstName, personLine } from '../speech'
import { describeWhen, type Clock } from '../when'
import { pressing, sayItemsUnder, type SaidItem } from './action-items'

/**
 * A person in the CRM: who they are, when the user last met or was in touch
 * with them, what's open between them one item at a time (their actions,
 * then the user's own from meetings with them; Liam, 2026-09-28: "now do the
 * same for contacts and companies"), mail from them waiting on the user's
 * reply, and a follow-up the user planned.
 *
 *   "Jessa Lin, Head of Ops at Acme. You last met on Tuesday, in Pricing sync.
 *    Jessa has two open actions. Send the signed order form, due on Friday.
 *    Share the security questionnaire. Jessa's email about Security review is
 *    waiting on your reply."
 *
 * Through gatherPersonContext, the gate behind the chat's get_contact_details
 * (workspace, merged contacts, contact_visible_to, capture visibility, the
 * user's own mailbox only), on the service client it is written for.
 */
export async function contactSpeech(ctx: BriefContext, id: string): Promise<Speech | null> {
  const { service, workspaceId, userId } = ctx
  // What the gatherer doesn't carry is read alongside it, and used only once
  // the gatherer has cleared the contact; a merged contact's is read again
  // from the row it was merged into.
  const followUp = (contactId: string) =>
    service.from('contact').select('id, next_followup_at').eq('id', contactId).eq('workspace_id', workspaceId).maybeSingle()
  const [person, first] = await Promise.all([
    gatherPersonContext(service, { workspaceId, userId, contactId: id, requester: userId }),
    followUp(id),
  ])
  if (!person) return null
  const extra = first.data?.id === person.contact.id ? first : await followUp(person.contact.id)
  if (extra.error) console.warn('[listen-brief] contact extras failed:', extra.error.message)

  return contactWords(person, (extra.data as { next_followup_at: string | null } | null)?.next_followup_at ?? null, ctx.clock)
}

/** How long after a meeting an interaction is still that meeting. */
const SAME_TOUCH_MS = 60 * 60_000

/** What the gatherer found, as words. Pure. */
export function contactWords(person: PersonContext, followUpAt: string | null, clock: Clock): Speech {
  const c = person.contact
  const speech = new Speech()
  const name = clause(c.full_name) || 'This contact'
  const first = firstName(clause(c.full_name)) || name

  speech.say(person.is_teammate ? `${personLine(name, c.job_title) ?? name}, your teammate` : (personLine(name, c.job_title, c.company?.name) ?? name))

  // When the user last met them, and was last in touch if that was later.
  const meeting = person.recent_captures[0]
  const met = meeting ? describeWhen(meeting.started_at, clock) : null
  const touched = c.last_interaction_at
  const later =
    touched && (!meeting?.started_at || Date.parse(touched) - Date.parse(meeting.started_at) > SAME_TOUCH_MS)
      ? describeWhen(touched, clock)
      : null
  if (met && later) speech.say(`You were last in touch ${later}, and last met ${met}, in ${clause(meeting?.title) || 'a meeting'}`)
  else if (met) speech.say(`You last met ${met}, in ${clause(meeting?.title) || 'a meeting'}`)
  else if (later) speech.say(`You were last in touch ${later}`)
  else speech.say(`There's no history with ${first} yet`)

  // What's open between them, item by item, the most pressing first: theirs,
  // then the user's own from their meetings. Each list's heading says whose
  // they are. The gatherer reads at most THEIR_ACTIONS_READ and
  // MY_ACTIONS_READ: at that many, "at least".
  const theirs = pressing(person.open_actions.map(openItem), clock)
  const moreOfTheirs = theirs.length >= THEIR_ACTIONS_READ
  sayItemsUnder(
    speech,
    theirs,
    clock,
    {
      one: `${first} has one open action:`,
      many: (n) => `${first} has ${moreOfTheirs ? 'at least ' : ''}${count(n, 'open action')}`,
    },
    theirs.length,
    moreOfTheirs,
  )
  const mine = pressing(person.my_open_actions_from_their_meetings.map(openItem), clock)
  const moreOfMine = mine.length >= MY_ACTIONS_READ
  sayItemsUnder(
    speech,
    mine,
    clock,
    {
      one: `You have one action open from your meetings with ${first}:`,
      many: (n) => `You have ${moreOfMine ? 'at least ' : ''}${count(n, 'action')} open from your meetings with ${first}`,
    },
    mine.length,
    moreOfMine,
  )

  // Mail from them waiting on the user.
  const waiting = (person.recent_email_threads ?? []).filter((t) => t.needs_reply)
  if (waiting.length === 1) {
    const subject = clause(waiting[0].subject)
    speech.say(`${first}'s email`, subject && `about ${subject}`, 'is waiting on your reply')
  } else if (waiting.length > 1) {
    speech.say(`${count(waiting.length, 'email')} from ${first} are waiting on your reply`)
  }

  // A follow-up the user planned.
  if (followUpAt) {
    const when = describeWhen(followUpAt, clock)
    if (when) {
      speech.say(
        Date.parse(followUpAt) < clock.now.getTime()
          ? `You meant to follow up with ${first} ${when}`
          : `You planned to follow up with ${first} ${when}`,
      )
    }
  }
  return speech
}

/** How many of their open actions, and of the user's from their meetings,
 *  gatherPersonContext reads (its `.limit(8)` and `.limit(5)`). */
export const THEIR_ACTIONS_READ = 8
export const MY_ACTIONS_READ = 5

/** An open action of either list, said without an owner: its list's heading
 *  says whose it is. */
function openItem(action: { title: string; due_at: string | null; priority?: string | null }): SaidItem {
  return { title: action.title, due_at: action.due_at, priority: action.priority ?? null, done: false, owner: null }
}
