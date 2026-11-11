import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { createLinkInput, linkFieldsInput } from '@/lib/booking-links/input'
import { appOrigin } from '@/lib/twilio/config'

/**
 * Booking links (availability phase 4a, src/lib/booking-links/): standing
 * public pages anyone can book a time with the person (or their team) from,
 * /book/<handle>/<slug>. The answer to "send me your calendar" or "how do I
 * book time with you"; a specific person and a few times is offer_times.
 *
 *   list_booking_links   the workspace's links, each with its address.
 *   create_booking_link  a new link (title, length, buffers, notice, how far
 *                        ahead, questions, video or place, ask first, its
 *                        hosts and how they share it).
 *   update_booking_link  any of those, or turn it off (active false) or on.
 *   delete_booking_link  turn it off: its page stops taking bookings; the
 *                        bookings it made stay. update_booking_link turns it
 *                        back on.
 *
 * Making and changing a link is internal and undoable (no approval card):
 * the person can change it back or turn it off. Attended only: a page that
 * opens their calendar to anyone changes only at their word, never in an
 * unattended run (ATTENDED_ONLY_TOOL_NAMES). Who may edit, and who may host,
 * is src/lib/booking-links/links.ts's: only the person (or an owner or
 * admin) edits a link, and a teammate who doesn't share their availability
 * is never made a host by someone else.
 */
export function createBookingLinkTools(userId: string, workspaceId?: string) {
  const noWorkspace = { success: false, error: 'No workspace is active.' }
  const editor = (ws: string) => ({ workspaceId: ws, userId })
  const failed = (result: { code: string; message: string }) => ({ success: false, code: result.code, error: result.message })

  return {
    list_booking_links: tool({
      description:
        "The workspace's booking links (the person's, their teammates' and the team's), each with its address to share, length, hosts, whether it asks first, and whether it is on. Use it to hand out the person's link when someone asks for their calendar, or to find one's id before update_booking_link.",
      inputSchema: z.object({ active_only: z.boolean().optional().describe('Only links that are on (default true)') }),
      execute: async ({ active_only }) => {
        if (!workspaceId) return noWorkspace
        try {
          const { listLinks, getProfile } = await import('@/lib/booking-links/store')
          const { linkView, mayEdit } = await import('@/lib/booking-links/links')
          const supabase = getServiceClient()
          const [links, mine, role] = await Promise.all([
            listLinks(supabase, { workspaceId, activeOnly: active_only !== false }),
            getProfile(supabase, { workspaceId, userId }),
            supabase.from('member').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle<{ role: string | null }>(),
          ])
          const origin = appOrigin()
          return {
            success: true,
            your_handle: mine?.handle ?? null,
            links: links.map((l) => ({ ...linkView(l, origin), yours: l.hosts.some((h) => h.userId === userId) || l.ownerUserId === userId, can_edit: mayEdit(l, { userId }, role.data?.role ?? null) })),
            ...(links.length ? {} : { note: 'No booking links yet: create_booking_link makes one (a 30-minute one is a fine default).' }),
          }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    create_booking_link: tool({
      description:
        'Make a booking link: a standing page where anyone can book time with the person from their real availability (working hours minus everything busy, all their calendars). ' +
        "Only title is needed; it defaults to 30 minutes, a video link, 4 hours' notice, 30 days ahead, the person its one host, and books straight away. " +
        "ask_first true makes each booking wait for the person's yes. Teammates as hosts: host_mode 'all' (everyone free, everyone attends) or 'any' (whoever is free, the least booked). " +
        'It comes back with the address to share. For one specific person and two or three times, offer_times instead.',
      inputSchema: createLinkInput,
      execute: async (input) => {
        if (!workspaceId) return noWorkspace
        const { createLink, linkView } = await import('@/lib/booking-links/links')
        const result = await createLink(getServiceClient(), editor(workspaceId), input)
        if (!result.ok) return failed(result)
        const view = linkView(result.link, appOrigin())
        return { success: true, link: view, message: `Made "${view.title}". Its address: ${view.url}. Anyone with it can book${result.link.askFirst ? ' a time, which waits for a yes' : ''}.` }
      },
    }),

    update_booking_link: tool({
      description:
        "Change one of the workspace's booking links: any field create_booking_link takes, its hosts, or active false to turn it off (true turns it back on). Give only what changes. The person's own links, or any as an owner or admin.",
      inputSchema: linkFieldsInput.extend({ link_id: z.string().uuid().describe('The link (list_booking_links)') }),
      execute: async ({ link_id, ...fields }) => {
        if (!workspaceId) return noWorkspace
        const { changeLink, linkView } = await import('@/lib/booking-links/links')
        const result = await changeLink(getServiceClient(), editor(workspaceId), link_id, fields)
        if (!result.ok) return failed(result)
        const view = linkView(result.link, appOrigin())
        return { success: true, link: view, message: `${view.title} is ${view.active ? `on, at ${view.url}` : 'off: its page takes no bookings'}.` }
      },
    }),

    delete_booking_link: tool({
      description:
        'Turn a booking link off: its page stops taking bookings; the meetings already booked from it stay. update_booking_link with active true turns it back on.',
      inputSchema: z.object({ link_id: z.string().uuid().describe('The link (list_booking_links)') }),
      execute: async ({ link_id }) => {
        if (!workspaceId) return noWorkspace
        const { turnOffLink, linkView } = await import('@/lib/booking-links/links')
        const result = await turnOffLink(getServiceClient(), editor(workspaceId), link_id)
        if (!result.ok) return failed(result)
        return { success: true, link: linkView(result.link, appOrigin()), message: `${result.link.title} is off. Its bookings stay; turning it back on brings its page back.` }
      },
    }),
  }
}
