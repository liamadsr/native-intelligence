import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveEntityWorkspace } from './_shared'
import { isContactVisibleTo } from '@/lib/crm/contact-visibility'
import { emitJobCompleted, type JobType } from '@/lib/jobs/events'
import { readReviewSettings, saveReviewLink } from '@/lib/reviews/link'

/**
 * Review requests (roadmap D3): the owner's Google review link, and the
 * finished jobs that send it.
 *
 *   set_review_link  the owner sets the link once ("my review link is …", by
 *                    text). An automation write: from a text it is the
 *                    owner's card first (the link goes to their customers
 *                    from their mailbox, and a sender's number can be faked).
 *                    Google links only (src/lib/reviews/link.ts).
 *   complete_job     the owner says a job is done. It sends the job-done
 *                    event (src/lib/jobs/events.ts); the review request
 *                    follows by itself, once per customer per job, only when
 *                    the link is set (src/lib/reviews/request.ts). Bookings
 *                    (roadmap track B) send the same event when one is done.
 *                    It emails a customer, so it is an external write: from a
 *                    text it is the owner's card first (a faked number never
 *                    mails anyone). Owners and admins only (the email goes
 *                    from the link-setter's mailbox), only a person's own
 *                    turn (a run that marked jobs done on its own would email
 *                    their customers), and the job is today's or a real board
 *                    action, never an id the model made up.
 */
export interface ReviewToolsContext {
  /** Nobody at the keyboard (a work run's, a loop's or a home turn's own work). */
  unattended?: boolean
}

/** Today's date in UTC: a job with no id counts as that customer's job today. */
function todayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function createReviewTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  ctx: ReviewToolsContext = {},
) {
  return {
    set_review_link: tool({
      description:
        "Save the business's Google review link, which each customer gets once after their job is done (complete_job). Ask for it once, when the person wants review requests: it is the link from their Google Business Profile's \"Ask for reviews\" (g.page/r/…, maps.app.goo.gl/…, search.google.com/local/writereview?placeid=…). Only Google links are accepted. Owners and admins only. Replaces any link set before.",
      inputSchema: z.object({
        url: z.string().max(500).describe('The Google review link, starting with https://'),
      }),
      execute: async ({ url }) => {
        const saved = await saveReviewLink(supabase, { workspaceId, userId, url })
        if (!saved.ok) return { success: false, code: saved.code, error: saved.error }
        return {
          success: true,
          review_link: saved.link.url,
          message: 'Saved. From now on, each customer gets this link once after a job is done, by email from your mailbox.',
        }
      },
    }),

    complete_job: tool({
      description:
        "Mark a customer's job done, when the person says it is (\"the Smith rug is done\", \"finished at the Lees'\"). Once the business has a review link (set_review_link), that customer then gets ONE review request for this job, by email from the mailbox of whoever set the link; never twice for one job, never to anyone on the opt-out list. Pass the customer's CRM contact_id (list_contacts / find first). Pass job_id when the job has one (a booking); without one it counts as this customer's job today. Never call it for a job the person didn't say was done.",
      inputSchema: z.object({
        contact_id: z.string().describe('The customer: a CRM contact id'),
        action_id: z.string().optional().describe("The board action that was this job, when there is one. Omit otherwise: it counts as this customer's job today."),
      }),
      execute: async ({ contact_id, action_id }) => {
        if (ctx.unattended) {
          return {
            success: false,
            code: 'NEEDS_PERSON',
            error: 'Only the person says a job is done (their customer gets a review request from it). Leave it to them.',
          }
        }
        const resolved = await resolveEntityWorkspace(supabase, userId, 'contact', contact_id, workspaceId, strictWorkspace)
        if (!resolved || !(await isContactVisibleTo(supabase, contact_id, userId))) {
          return { success: false, error: 'Contact not found' }
        }
        const targetWs = resolved.workspaceId
        const { data: member } = await supabase.from('member').select('role').eq('workspace_id', targetWs).eq('user_id', userId).maybeSingle()
        const role = (member as { role?: string } | null)?.role
        if (role !== 'owner' && role !== 'admin') {
          return { success: false, code: 'NOT_ALLOWED', error: 'Only the workspace owner or an admin marks a job done (the review request goes from the owner\'s mailbox).' }
        }
        if (action_id) {
          const { data: action } = await supabase.from('actions').select('id').eq('id', action_id).eq('workspace_id', targetWs).maybeSingle()
          if (!action) return { success: false, error: 'action_id is not an action in this workspace' }
        }
        const now = Date.now()
        const jobRef: { type: JobType; id: string } = action_id ? { type: 'action', id: action_id } : { type: 'manual', id: todayKey(now) }

        let link: Awaited<ReturnType<typeof readReviewSettings>>['link']
        try {
          link = (await readReviewSettings(supabase, targetWs)).link
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
        const { data: existing } = await supabase
          .from('review_request')
          .select('status')
          .eq('workspace_id', targetWs)
          .eq('contact_id', contact_id)
          .eq('job_type', jobRef.type)
          .eq('job_id', jobRef.id)
          .maybeSingle()

        try {
          await emitJobCompleted({ workspaceId: targetWs, contactId: contact_id, jobRef, completedAt: new Date(now).toISOString(), reason: 'done', userId })
        } catch (err) {
          return { success: false, error: `The job was not marked done: ${err instanceof Error ? err.message : String(err)}` }
        }
        return {
          success: true,
          job: jobRef,
          review_request: existing ? 'already_asked' : link ? 'on_its_way' : 'no_review_link',
          message: existing
            ? 'Marked done. This customer already had their review request for this job, so nothing more goes out.'
            : link
              ? 'Marked done. The customer gets the review link once for this job, by email, in a moment (not if they opted out).'
              : 'Marked done. No review request goes out: no Google review link is set yet. Offer to set it (set_review_link).',
        }
      },
    }),
  }
}
