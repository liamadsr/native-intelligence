import {
  gatherCompanyContext,
  type CompanyContext,
  type CompanyEmailThread,
  type CompanyPerson,
} from '@/lib/crm/company-context'
import { markdownToSpeech, splitSentencesRaw } from '@/lib/read-aloud/speech-text'
import { rows, type BriefContext, type Result } from '../context'
import { Speech, assignedTo, clause, count, firstName, listOf, nameFromEmail, numberWord, personLine } from '../speech'
import { describeWhen, type Clock } from '../when'
import { pressing, sayItemsUnder } from './action-items'

/**
 * A company in the CRM: what it is and what it does, who the user knows there
 * and when they last met them, what's open with people there, item by item
 * and whose (Liam, 2026-09-28: "now do the same for contacts and
 * companies"), and mail from them waiting on the user's reply.
 *
 *   "Acme, Logistics software, 51 to 200 people. Acme builds autonomous
 *    forklifts for mid-size warehouses. You know four people there, including
 *    Jessa Lin and Jordan Lee. Your latest meeting with them was Pricing sync,
 *    on Tuesday."
 *
 * Through gatherCompanyContext, the gate behind the chat's get_company_overview
 * (workspace, company_visible_to, each person re-fenced with
 * contact_visible_to, capture visibility, the user's own mailbox only), on the
 * service client it is written for.
 */
export async function companySpeech(ctx: BriefContext, id: string): Promise<Speech | null> {
  const { supabase, service, workspaceId, userId, memberId } = ctx
  const account = await gatherCompanyContext(service, { workspaceId, userId, companyId: id, requester: userId })
  if (!account) return null

  // What the gatherer doesn't carry, from the row it just cleared. And which of
  // the account's open actions are the user's own (their own company counts
  // them among its people): read as the user.
  const memberActionIds = account.open_actions.filter((a) => a.assigned_via === 'member').map((a) => a.id)
  const [extraRes, myActionsRes] = await Promise.all([
    service
      .from('company')
      .select('is_workspace_company, metadata')
      .eq('id', account.company.id)
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    memberActionIds.length
      ? supabase.from('actions').select('id').in('id', memberActionIds).eq('assignee_id', memberId)
      : NO_ROWS,
  ])
  if (extraRes.error) console.warn('[listen-brief] company extras failed:', extraRes.error.message)
  const mine = new Set(rows('own actions', myActionsRes as Result<IdRow>).map((r) => r.id))

  return companyWords({ account, extra: (extraRes.data ?? null) as CompanyExtra | null, mine }, ctx)
}

export interface CompanyExtra {
  is_workspace_company: boolean | null
  metadata: { enrichment?: { summary?: string | null } } | null
}

/** What the gatherer found, as words. Pure. `mine`: the ids of the account's
 *  open actions that are the user's own. */
export function companyWords(
  data: { account: CompanyContext; extra: CompanyExtra | null; mine: ReadonlySet<string> },
  who: { memberId: string; clock: Clock },
): Speech {
  const { account, extra, mine } = data
  const { memberId, clock } = who
  const c = account.company
  const speech = new Speech()
  const name = clause(c.name) || 'This company'
  // The workspace's own company: its people are the user's teammates, the user
  // among them.
  const own = extra?.is_workspace_company === true

  speech.say(
    own ? `${name}, your own company` : [name, clause(c.industry), headcount(c.employee_count_range)].filter(Boolean).join(', '),
  )
  speech.say(aboutThem(c.description, extra?.metadata?.enrichment?.summary))

  // Who the user knows there, most interactions first (the gatherer's order).
  // The user's own contact row is not one of them.
  const others = account.people.filter((p) => !(p.member_id && p.member_id === memberId))
  const known = account.people_visible - (account.people.length - others.length)
  /** Named in full already: by first name after that. */
  const named = new Set<string>()
  if (!own) {
    if (known === 1) {
      const only = others[0] ? nameOf(others[0]) : null
      if (only) named.add(only)
      const line = only ? personLine(only, others[0]?.job_title) : null
      speech.say('You know one person there', line && `: ${line}`)
    } else if (known > 1) {
      const listed = others
        .slice(0, 2)
        .map(nameOf)
        .filter((n): n is string => !!n)
      for (const n of listed) named.add(n)
      const names = listOf(listed)
      speech.say(
        `You know ${count(known, 'person', 'people')} there`,
        names && (known === listed.length ? `: ${names}` : `, including ${names}`),
      )
    } else {
      speech.say(`No one from ${name} is in your CRM yet`)
    }

    // When they last met, else were last in touch.
    const meeting = account.recent_captures[0]
    const met = meeting && [clause(meeting.title), describeWhen(meeting.started_at, clock)].filter(Boolean).join(', ')
    const touched = describeWhen(account.last_interaction_at, clock)
    if (met) speech.say(`Your latest meeting with them was ${met}`)
    else if (touched) speech.say(`You were last in touch ${touched}`)
  }

  // What's open with people there, how much of it is the user's, then each
  // item and whose it is, the most pressing first.
  const open = account.open_actions
  if (open.length) {
    // The gatherer reads OPEN_ACTIONS_READ at most: at that many, a floor.
    const floor = open.length >= OPEN_ACTIONS_READ
    const k = open.filter((a) => mine.has(a.id)).length
    const yours =
      k === 0
        ? null
        : floor
          ? `at least ${numberWord(k)} of them yours`
          : k < open.length
            ? `${numberWord(k)} of them yours`
            : 'all of them yours'
    const items = pressing(
      open.map((a) => ({
        title: a.title,
        due_at: a.due_at,
        priority: a.priority,
        done: false,
        owner: mine.has(a.id) ? 'assigned to you' : assignedTo(clause(a.assignee_name)),
      })),
      clock,
    )
    sayItemsUnder(
      speech,
      items,
      clock,
      {
        one: 'One action is open with people there:',
        many: (n) => [floor && 'at least', `${count(n, 'action')} are open with people there`, yours && `, ${yours}`].filter(Boolean).join(' '),
      },
      open.length,
      floor,
    )
  }

  // Mail waiting on the user's reply (a thread's sender is its last
  // message's). With the user among the people there (always, on their own
  // company) every thread of theirs matches, so only mail from someone there
  // counts.
  const nameByEmail = new Map<string, string>(
    others.flatMap((p): Array<[string, string]> => {
      const full = clause(p.full_name)
      return p.email && full ? [[p.email.toLowerCase(), full]] : []
    }),
  )
  const senderOf = (t: CompanyEmailThread) => (t.from_email && nameByEmail.get(t.from_email.toLowerCase())) || null
  const userThere = own || others.length < account.people.length
  const waiting = (account.recent_email_threads ?? []).filter((t) => t.needs_reply && (!userThere || senderOf(t)))
  if (waiting.length === 1) {
    const sender = senderOf(waiting[0])
    const subject = clause(waiting[0].subject)
    speech.say(
      sender ? `${(named.has(sender) && firstName(sender)) || sender}'s email` : `An email from ${name}`,
      subject && `about ${subject}`,
      'is waiting on your reply',
    )
  } else if (waiting.length > 1) {
    speech.say(`${count(waiting.length, 'email')} from ${own ? 'your teammates' : 'people there'} are waiting on your reply`)
  }
  return speech
}

type IdRow = { id: string }

const NO_ROWS: Promise<Result<IdRow>> = Promise.resolve({ data: [], error: null })

/** How many open actions gatherCompanyContext reads (its `.limit(8)`). */
const OPEN_ACTIONS_READ = 8

/** The longest first sentence of a blurb worth saying: past it, it's a
 *  paragraph's worth. */
const ABOUT_MAX = 200

/** A person's name, else their address's ("jessa.lin"). */
function nameOf(p: CompanyPerson): string | null {
  return clause(p.full_name) || nameFromEmail(p.email)
}

/** "51-200" → "51 to 200 people", "1-10" → "one to ten people", "1000+" →
 *  "over 1,000 people"; anything else as it is. */
function headcount(range: string | null | undefined): string | null {
  const raw = range?.replace(/\s+/g, ' ').trim()
  if (!raw) return null
  const span = /^(\d[\d,]*) ?[-–—] ?(\d[\d,]*)$/.exec(raw)
  if (span) return `${amount(span[1])} to ${amount(span[2])} people`
  const over = /^(\d[\d,]*) ?\+$/.exec(raw)
  if (over) return `over ${amount(over[1])} people`
  return `${raw} people`
}

/** "1000" → "1,000"; one to ten in words. */
function amount(digits: string): string {
  const n = Number(digits.replace(/,/g, ''))
  return n <= 10 ? numberWord(n) : n.toLocaleString('en-US')
}

/** What they do: the first sentence of their description, else of the web
 *  research's summary, as written, when it is short enough to say. */
function aboutThem(...blurbs: Array<string | null | undefined>): string | null {
  for (const blurb of blurbs) {
    const [lead = ''] = markdownToSpeech(blurb ?? '').split('\n')
    const [sentence] = splitSentencesRaw(lead)
    if (sentence && sentence.length <= ABOUT_MAX) return sentence
  }
  return null
}
