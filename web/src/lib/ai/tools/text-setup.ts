import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { connectLinkText, mintConnectLink, TEXT_CONNECT_PROVIDERS, providerLabel, type TextConnectProvider } from '@/lib/links/oauth-link'
import { finishTextSetup } from '@/lib/onboarding/text-setup'
import { saveMemoryLine } from '@/lib/packs/memory-write'
import { MEMORY_LINE_MAX_CHARS } from '@/lib/packs/memory-types'
import { linkedPhoneForUser, recordOutbound } from '@/lib/sms/store'
import { phoneServesWorkspace, sendingLine } from '@/lib/sms/workspace-line'
import { sendSms, type SendSmsResult } from '@/lib/twilio/client'
import { agentSender } from '@/lib/sms/agent-number'
import { appOrigin } from '@/lib/twilio/config'

/**
 * Setting a business up by text (roadmap tracks A2 and A3,
 * src/lib/onboarding/text-setup.ts):
 *
 *   connect_link           a single-use link (15 minutes, bound to this
 *                          account: src/lib/links/oauth-link.ts) that opens
 *                          the provider's own sign-in from the person's
 *                          phone. Only on the person's own text turn, and
 *                          the tool texts it to their verified number
 *                          itself: the model never sees the URL, so no
 *                          chat, MCP client or prompt injection can hand a
 *                          link to someone else (whoever taps a link
 *                          connects THEIR account to this one).
 *   save_business_profile  what the owner confirmed about their business,
 *                          saved as workspace lines of the knowledge memory,
 *                          the workspace renamed to the business, their name
 *                          on their member row; it ends setup by text.
 *
 * Not attended only: they run on the person's own text turn (person_remote),
 * which the attended-only tools refuse. Both refuse an unattended turn (a
 * home turn, a run): a link only goes to the person who asked, and only the
 * owner confirms their business.
 */
/** Tools only the person's own text turn holds: withheld from MCP (src/lib/mcp/tools/index.ts). */
export const TEXT_TURN_ONLY_TOOL_NAMES: readonly string[] = ['connect_link']

export function createTextSetupTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { unattended?: boolean; textTurn?: boolean; send?: (to: string, body: string, deps?: { from?: string }) => Promise<SendSmsResult> } = {},
) {
  const unattendedRefusal = { success: false, error: 'Only on the person\'s own turn: they have to ask for this themselves.' }
  return {
    connect_link: tool({
      description:
        'Text the person a single-use link that connects one of their accounts from their phone: google (Gmail and Google Calendar), microsoft (Outlook mail and calendar), github, ' +
        'or one that holds their customers: google_contacts (Google Contacts), hubspot or brevo. A customers link imports them into the CRM once it connects (read only, nothing is sent) and they get a text when it is done. ' +
        'The tool sends the text itself, to their verified number: never write a link in your reply. It opens the provider\'s own sign-in, works once and expires in 15 minutes. ' +
        'Only when they text you; in the app, use connect (a Connect card). Never ask for a password or an API key by text.',
      inputSchema: z.object({
        provider: z.enum(['google_contacts', ...TEXT_CONNECT_PROVIDERS] as [string, ...string[]]).describe('google, microsoft, github, google_contacts, hubspot or brevo'),
      }),
      execute: async ({ provider }) => {
        if (opts.unattended || !opts.textTurn) {
          return { success: false, error: 'Only when they text you. In the app, use connect: it puts a Connect card in the chat.' }
        }
        const phone = await linkedPhoneForUser(supabase, userId).catch(() => null)
        // Linked here, or one of this workspace's own people texting its business number (./sms/workspace-line.ts);
        // a business-line phone only ever from a business number ('no_line': none to send from).
        const from = phone && !phone.optedOut && (await phoneServesWorkspace(supabase, phone, workspaceId)) ? await sendingLine(supabase, phone, workspaceId) : 'no_line'
        if (!phone || from === 'no_line') return { success: false, error: 'Their number can\'t be texted right now, so no link was sent.' }
        // Google Contacts is Google's contacts leg on its own (roadmap track G2).
        const contacts = provider === 'google_contacts'
        const target = (contacts ? 'google' : provider) as TextConnectProvider
        const link = await mintConnectLink(supabase, { userId, workspaceId, provider: target, origin: appOrigin(), ...(contacts ? { capabilities: ['contacts' as const] } : {}) })
        if (!link.ok) return { success: false, error: 'The link could not be made just now. Try again in a moment.' }
        const body = connectLinkText(target, link.url, contacts ? ['contacts'] : undefined)
        const send = opts.send ?? sendSms
        // A business's own number when the link is about that business; else their agent's own number, else Native Intelligence's.
        const sender = from ? null : await agentSender(supabase, userId)
        const sent = from ? await send(phone.phone, body, { from }) : sender ? await send(phone.phone, body, { sender }) : await send(phone.phone, body)
        if (!sent.ok) return { success: false, error: 'The link could not be texted just now. Try again in a moment.' }
        await recordOutbound(supabase, { phone: phone.phone, kind: 'reply', sid: sent.sid, userId })
        return {
          success: true,
          texted: true,
          message: `The ${contacts ? 'Google Contacts' : providerLabel(target)} link is texted to them on its own. Say so in a few words; never write or make up a link yourself.`,
        }
      },
    }),

    save_business_profile: tool({
      description:
        'Save what the owner confirmed about their business to the business memory, and end setup by text. Call it only after you texted them a summary and they said it is right. ' +
        'Each field is one short line in their words; leave out what they did not confirm.',
      inputSchema: z.object({
        confirmed_by_owner: z.boolean().describe('Set true ONLY after they said the summary you texted them is right. False, or omitted, refuses and saves nothing.'),
        business_name: z.string().min(1).max(80).optional().describe('The business\'s name, e.g. "Bright Weave". Renames the workspace'),
        owner_name: z.string().min(1).max(60).optional().describe('The owner\'s name, as they gave it'),
        website: z.string().max(200).optional().describe('Their website, e.g. "brightweave.com"'),
        services: z.string().max(MEMORY_LINE_MAX_CHARS - 20).optional().describe('What they do, e.g. "Hand-washes and repairs handmade rugs"'),
        service_area: z.string().max(MEMORY_LINE_MAX_CHARS - 20).optional().describe('Where they work, e.g. "Pasadena and 15 miles around"'),
        pickup_days: z.string().max(MEMORY_LINE_MAX_CHARS - 20).optional().describe('When they pick up, e.g. "Tuesdays and Fridays"'),
        prices: z.string().max(MEMORY_LINE_MAX_CHARS - 20).optional().describe('Their prices, e.g. "$4 per sq ft to wash; repairs quoted"'),
        other: z.array(z.string().min(1).max(MEMORY_LINE_MAX_CHARS)).max(5).optional().describe('Any other fact they confirmed, one per line'),
      }),
      execute: async (input) => {
        if (opts.unattended) return unattendedRefusal
        if (input.confirmed_by_owner !== true) return { success: false, error: 'Refused, nothing saved: text them the summary, get their yes, then call this again with confirmed_by_owner: true.' }
        const lines = [
          input.business_name && `Business: ${input.business_name}`,
          input.website && `Website: ${input.website}`,
          input.services && `Services: ${input.services}`,
          input.service_area && `Service area: ${input.service_area}`,
          input.pickup_days && `Pickup days: ${input.pickup_days}`,
          input.prices && `Prices: ${input.prices}`,
          ...(input.other ?? []),
        ].filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
        if (!lines.length && !input.owner_name) return { success: false, error: 'Nothing to save: pass what they confirmed.' }

        const saved: string[] = []
        const failed: string[] = []
        for (const text of lines) {
          const result = await saveMemoryLine(supabase, { workspaceId, userId, area: 'knowledge', scope: 'workspace', text, source: 'told' })
          if (result.ok) saved.push(text)
          else failed.push(`${text.slice(0, 40)}: ${result.error}`)
        }
        if (input.business_name) {
          const { data: member } = await supabase.from('member').select('role').eq('user_id', userId).eq('workspace_id', workspaceId).maybeSingle()
          if ((member as { role?: string } | null)?.role === 'owner') await supabase.from('workspace').update({ name: input.business_name.trim() }).eq('id', workspaceId)
        }
        if (input.owner_name) await supabase.from('member').update({ display_name: input.owner_name.trim() }).eq('user_id', userId).eq('workspace_id', workspaceId)
        const finished = failed.length === 0 ? await finishTextSetup(supabase, { workspaceId, userId }) : null
        return {
          success: failed.length === 0,
          saved,
          ...(failed.length ? { failed, error: 'Some lines were not saved; setup stays on.' } : {}),
          setup_finished: finished?.success === true && finished.ended,
          message: failed.length ? 'Tell them what was saved and what was not.' : 'Saved to the business memory. Tell them in one line, then carry on as their assistant.',
        }
      },
    }),
  }
}
