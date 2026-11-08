/**
 * The tool route's answer to a business customer's own tools (roadmap B2/B4;
 * ./customer-tools-list.ts): get_my_quotes, find_open_slots,
 * request_booking, and their answers to a reminder (issue #11,
 * ./reminder-replies.ts): confirm_appointment and move_appointment.
 * guestToolCall (src/lib/guests/guest-tools.ts) has already
 * re-read the customer's row live (active, this thread, this owner) and
 * checked the tool is in their ceiling; everything here is scoped to that
 * one customer and that one business, and nothing here runs a registry tool.
 *
 * Server only.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatRunTokenClaims } from '@/lib/chat/chat-run-token'
import { toolInputIssues } from '@/lib/ai/tool-input-issues'
import type { AgentGuest } from '@/lib/guests/store'
import { requestBooking } from './booking'
import { upsertCustomerContact } from './contacts'
import { linkCustomerContact } from './customer-guests'
import { quoteForCustomerAgent } from './customer-spec'
import { confirmAppointment, moveAppointment } from './reminder-replies'
import { findOpenSlots, slotLabel } from './slots'
import { quotesForCustomer } from './store'

/** The customer-only tools this route answers (message_owner and remember_about_guest are the guest route's own). */
export const CUSTOMER_ROUTE_TOOLS: ReadonlySet<string> = new Set(['get_my_quotes', 'find_open_slots', 'request_booking', 'confirm_appointment', 'move_appointment'])

export const findOpenSlotsInputSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.number().int().min(1).max(14).optional(),
})

export const requestBookingInputSchema = z.object({
  start: z.string().min(10).max(40),
  name: z.string().min(1).max(120),
  address: z.string().max(300).optional(),
  quote_id: z.string().uuid().optional(),
  note: z.string().max(1000).optional(),
})

export const confirmAppointmentInputSchema = z.object({
  reminder_id: z.string().uuid(),
})

export const moveAppointmentInputSchema = z.object({
  reminder_id: z.string().uuid(),
  start: z.string().min(10).max(40),
})

function invalid(error: z.ZodError): Response {
  return NextResponse.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: toolInputIssues(error) }, { status: 400 })
}

/** One customer tool call (see the header). */
export async function customerToolCall(
  supabase: SupabaseClient,
  claims: Pick<ChatRunTokenClaims, 'userId' | 'workspaceId'>,
  guest: AgentGuest,
  toolName: string,
  body: { input?: unknown },
): Promise<Response> {
  const business = { workspaceId: claims.workspaceId, ownerUserId: claims.userId }
  try {
    if (toolName === 'get_my_quotes') {
      const quotes = await quotesForCustomer(supabase, business.workspaceId, guest.phone)
      return NextResponse.json({
        output: quotes.length
          ? { success: true, quotes: quotes.map(quoteForCustomerAgent) }
          : { success: true, quotes: [], note: 'No quote on file for this customer yet. If they asked for one on the website, it may be under another number or email: ask which they used, or pass it to the owner with message_owner.' },
      })
    }

    if (toolName === 'find_open_slots') {
      const input = findOpenSlotsInputSchema.safeParse(body.input ?? {})
      if (!input.success) return invalid(input.error)
      const found = await findOpenSlots(supabase, business, { fromDate: input.data.from ?? null, days: input.data.days ?? 7, max: 12 })
      return NextResponse.json({
        output: {
          success: true,
          kind: found.rules.bookingKind,
          time_zone: found.timeZone,
          slots: found.slots.map((slot) => ({ start: slot.start, end: slot.end, label: slotLabel(slot.start, found.timeZone) })),
          note: found.slots.length ? 'Offer two or three of these, by their label. Book one with request_booking and its exact start.' : 'Nothing is open in that range. Try later days, or pass it to the owner with message_owner.',
        },
      })
    }

    if (toolName === 'request_booking') {
      const input = requestBookingInputSchema.safeParse(body.input ?? {})
      if (!input.success) return invalid(input.error)
      const result = await requestBooking(supabase, {
        business,
        source: 'sms',
        guest: { id: guest.id, displayName: input.data.name.trim().slice(0, 80) || guest.displayName, contactId: guest.contactId, phone: guest.phone },
        input: { start: input.data.start, name: input.data.name, address: input.data.address ?? null, quoteId: input.data.quote_id ?? null, note: input.data.note ?? null },
      })
      if (!result.ok) return NextResponse.json({ output: { success: false, code: result.code, message: result.message } })
      // Their CRM contact, now that they gave a name: found by their number, or made (a lead).
      if (guest.phone) {
        const contact = await upsertCustomerContact(supabase, business, { name: input.data.name, email: null, phone: guest.phone, source: 'sms' }).catch(() => null)
        if (contact) await linkCustomerContact(supabase, guest, contact)
      }
      return NextResponse.json({
        output: {
          success: true,
          status: 'requested',
          booking_id: result.booking.id,
          when: result.label,
          message: `Held ${result.label} and asked the owner by text. Nothing is booked until they say yes: tell the customer that, and that they'll get a confirmation text. Don't call request_booking again for this slot.`,
        },
      })
    }

    // Their answer to a reminder: only one texted to the number they text from (the live guest row's).
    if (toolName === 'confirm_appointment' || toolName === 'move_appointment') {
      if (!guest.phone) return NextResponse.json({ output: { success: false, code: 'NOT_FOUND', message: 'No reminder went to this customer. Answer from what you know, or pass it to the owner with message_owner.' } })
      if (toolName === 'confirm_appointment') {
        const input = confirmAppointmentInputSchema.safeParse(body.input ?? {})
        if (!input.success) return invalid(input.error)
        return NextResponse.json({ output: await confirmAppointment(supabase, { ...business, phone: guest.phone, reminderId: input.data.reminder_id }) })
      }
      const input = moveAppointmentInputSchema.safeParse(body.input ?? {})
      if (!input.success) return invalid(input.error)
      return NextResponse.json({ output: await moveAppointment(supabase, { ...business, phone: guest.phone, reminderId: input.data.reminder_id, start: input.data.start }) })
    }
  } catch (err) {
    console.error(`[customer-tool] ${toolName} failed:`, err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: "That didn't work right now. Try again in a moment, or pass it to the owner with message_owner.", code: 'TOOL_EXECUTE_FAILED' }, { status: 503 })
  }
  return NextResponse.json({ error: `tool '${toolName}' is not in this conversation's ceiling`, code: 'TOOL_OUT_OF_CEILING' }, { status: 403 })
}
