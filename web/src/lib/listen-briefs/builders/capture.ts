import { ownAddresses, rows, type BriefContext, type Result } from '../context'
import { Speech, clause, count, listOf, nameFromEmail, notesSummary, one, type OneOrMany } from '../speech'
import { describeWhen, type Clock } from '../when'
import { OWNER_EMBEDS, actionItem, sayActionItems, type ItemRow } from './action-items'

/**
 * A capture (a meeting or voice note recorded in Dial8): what it was and who
 * was in it, then the summary at the top of its own notes, read as written
 * (Liam, 2026-09-28: "captures usually start with a summary section at the
 * top, we should read that"), then the action items accepted from it (Liam:
 * "can it also read any action items that were accepted") and how many more
 * wait for review.
 *
 *   "Pricing sync, on Tuesday, with Jessa Lin and Jordan Lee from Acme. We
 *    agreed to hold the price at $99 … Two action items were accepted from
 *    it. Send the revised deck, assigned to you, due on Friday. Book the
 *    security review, assigned to Jessa Lin."
 *
 * Read on the user's own client, with the capture detail route's fences
 * (workspace, private → only its creator), evaluation captures left out.
 */
export async function captureSpeech(ctx: BriefContext, id: string): Promise<Speech | null> {
  const { supabase, workspaceId, userId } = ctx

  const [captureRes, participantsRes, actionsRes, proposalsRes, ownEmails] = await Promise.all([
    supabase
      .from('captures')
      .select('id, title, summary, ai_summary, ai_processed, started_at, recorded_at, created_at, participants, is_eval')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .or(`visibility.eq.workspace,user_id.eq.${userId}`)
      .maybeSingle(),
    supabase
      .from('capture_participant')
      .select(
        'member_id, external_name, external_email, company, member:member!member_id(display_name), contact:contact!contact_id(full_name, company:company_id(name))',
      )
      .eq('capture_id', id)
      .limit(25),
    supabase
      .from('actions')
      .select(`title, due_at, confirmation, context_data, workflow_state:workflow_state!status_id(category), ${OWNER_EMBEDS}`)
      .eq('source_capture_id', id)
      .eq('workspace_id', workspaceId)
      .neq('confirmation', 'dismissed')
      .order('created_at', { ascending: true })
      .limit(50),
    supabase
      .from('proposed_change')
      .select('id')
      .eq('capture_id', id)
      .eq('workspace_id', workspaceId)
      .eq('status', 'pending')
      .eq('change_type', 'create')
      .eq('entity_type', 'action')
      .limit(50),
    ownAddresses(ctx),
  ])

  if (captureRes.error) {
    console.warn('[listen-brief] capture failed:', captureRes.error.message)
    return null
  }
  const capture = captureRes.data as CaptureRow | null
  if (!capture || capture.is_eval === true) return null

  return captureWords(
    {
      capture,
      participants: rows('participants', participantsRes as Result<ParticipantRow>),
      actions: rows('actions', actionsRes as Result<ActionRow>),
      suggested: rows('proposals', proposalsRes as Result<{ id: string }>).length,
      ownEmails,
    },
    ctx,
  )
}

/** What the rows say, as words. Pure. */
export function captureWords(
  data: {
    capture: CaptureRow
    participants: ParticipantRow[]
    /** Its action items, not dismissed, oldest first. */
    actions: ActionRow[]
    /** Action items the AI suggested from it that no one has reviewed yet. */
    suggested: number
    /** The user's own addresses: whoever was in it under one is the user. */
    ownEmails: readonly string[]
  },
  who: { memberId: string; clock: Clock },
): Speech {
  const { capture } = data
  const speech = new Speech()

  const title = clause(capture.title) || 'Untitled capture'
  const when = describeWhen(capture.started_at ?? capture.recorded_at ?? capture.created_at, who.clock)
  const people = peopleIn(data.participants, capture.participants, { memberId: who.memberId, ownEmails: data.ownEmails })
  speech.say(
    people
      ? [title, when, `with ${people}`].filter(Boolean).join(', ')
      : [title, when && `recorded ${when}`].filter(Boolean).join(', '),
  )

  // Its notes, as they were written.
  if (capture.ai_summary === STREAMING) {
    speech.say('Its notes are still being written')
  } else {
    const summary = notesSummary(capture.ai_summary || capture.summary)
    if (summary.length) speech.sayAll(summary)
    else if (!capture.ai_processed) speech.say("Its notes aren't ready yet")
  }

  // The action items accepted from it, in the order they were made, each with
  // who owns it and when it's due, or that it's done. A canceled one isn't
  // happening: left out.
  const accepted = data.actions.filter(
    (a) => a.confirmation === 'confirmed' && one(a.workflow_state)?.category !== 'canceled',
  )
  if (accepted.length === 1) {
    speech.say('One action item was accepted from it:', actionItem(accepted[0], who))
  } else if (accepted.length > 1) {
    speech.say(`${count(accepted.length, 'action item')} were accepted from it`)
    sayActionItems(speech, accepted, who)
  }

  // And what still waits on the user: suggestions no one has accepted yet.
  const unreviewed = data.suggested + data.actions.filter((a) => a.confirmation === 'suggested').length
  if (unreviewed) {
    speech.say(
      count(unreviewed, accepted.length ? 'more suggested action item' : 'suggested action item'),
      unreviewed === 1 ? 'is' : 'are',
      'waiting for your review',
    )
  }
  return speech
}

/** Who was in it, the user left out: "Jessa Lin and Jordan Lee from Acme",
 *  "Jessa Lin, Jordan Lee and three others". The linked participants, else the
 *  calendar invite's guests. Null when it was only the user. A name that is
 *  an address is said as the name in it (Speech never reads one out). */
function peopleIn(
  participants: ParticipantRow[],
  invited: CaptureRow['participants'],
  who: { memberId: string; ownEmails: readonly string[] },
): string | null {
  const own = new Set(who.ownEmails.map((e) => e.toLowerCase()))
  const isOwn = (email: string | null | undefined) => !!email && own.has(email.trim().toLowerCase())
  const people = participants.length
    ? participants
        .filter((p) => !(p.member_id && p.member_id === who.memberId))
        .filter((p) => !isOwn(p.external_email))
        .map((p) => {
          const contact = one(p.contact)
          return {
            name: contact?.full_name || one(p.member)?.display_name || p.external_name || nameFromEmail(p.external_email),
            company: one(contact?.company ?? null)?.name || p.company || null,
          }
        })
    : (Array.isArray(invited) ? invited : [])
        .filter((p) => !isOwn(p?.email))
        .map((p) => ({ name: p?.name || nameFromEmail(p?.email), company: p?.company || null }))
  const named = people.filter((p): p is { name: string; company: string | null } => !!p.name?.trim())
  const names = listOf(named.map((p) => p.name))
  if (!names) return null
  // A few people, all from one company: say it once.
  const companies = new Set(named.map((p) => p.company?.trim() || ''))
  const [company] = [...companies]
  return companies.size === 1 && company && named.length <= 3 ? `${names} from ${company}` : names
}

/** ai_summary while the summary is still streaming in (capture-detail-panel). */
const STREAMING = '{{streaming}}'

/** A capture's notes, or null while there are none or they are still being
 *  written. */
export function finishedNotes(summary: string | null | undefined): string | null {
  return summary && summary !== STREAMING ? summary : null
}

export interface CaptureRow {
  id: string
  title: string | null
  summary: string | null
  ai_summary: string | null
  ai_processed: boolean | null
  started_at: string | null
  recorded_at: string | null
  created_at: string | null
  participants: Array<{ name?: string; email?: string; company?: string; jobTitle?: string } | null> | null
  is_eval: boolean | null
}

export interface ParticipantRow {
  member_id: string | null
  external_name: string | null
  external_email: string | null
  company: string | null
  member: OneOrMany<{ display_name: string | null }>
  contact: OneOrMany<{ full_name: string | null; company: OneOrMany<{ name: string | null }> }>
}

export interface ActionRow extends ItemRow {
  /** suggested | confirmed | dismissed: accepted is confirmed. */
  confirmation: string | null
}
