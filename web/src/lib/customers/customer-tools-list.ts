/**
 * What a business's customer's agent may do (roadmap B2, the Customer
 * preset): this fixed list and nothing else, whatever their agent_guest row
 * says. None of them is a registry tool, so no other runtime grants them,
 * and none reaches past the one customer:
 *
 *   get_my_quotes      their own quotes (sent from their number, or linked to
 *                      their contact), never anyone else's;
 *   find_open_slots    when a job can be booked: open times only, from the
 *                      owner's calendar and the business's booking hours,
 *                      never what the owner is doing;
 *   request_booking    ask for one open slot: the slot is held and the owner
 *                      gets a text to approve; nothing is booked before their
 *                      yes, and the customer is texted when it is;
 *   confirm_appointment  their yes to a reminder the business texted them
 *                      (./reminder-replies.ts): recorded, the owner sees it;
 *   move_appointment   a booked job they were reminded of, to another open
 *                      slot they picked: moved on the owner's calendar, the
 *                      owner told (a meeting goes to the owner instead);
 *   message_owner      pass the owner a note (the guest tool, ./reach-owner.ts);
 *   remember_about_guest  keep one thing they said about themselves.
 *
 * Never: money (no payment, deposit or card), sending to anyone else,
 * deleting anything, or reading other customers', the calendar's or the
 * workspace's data. ask_owner_agent is NOT here: the owner's own agent
 * reaches everything, and a customer's question never runs as it.
 *
 * Pure and client-safe.
 */

export const CUSTOMER_TOOLS = ['get_my_quotes', 'find_open_slots', 'request_booking', 'confirm_appointment', 'move_appointment', 'message_owner', 'remember_about_guest'] as const
export type CustomerToolName = (typeof CUSTOMER_TOOLS)[number]

const CUSTOMER_TOOL_SET: ReadonlySet<string> = new Set(CUSTOMER_TOOLS)

export function isCustomerTool(name: string): name is CustomerToolName {
  return CUSTOMER_TOOL_SET.has(name)
}

/** The customer-only tools' descriptions, as the customer's agent reads them. */
export const CUSTOMER_TOOL_DESCRIPTIONS: Record<'get_my_quotes' | 'find_open_slots' | 'request_booking' | 'confirm_appointment' | 'move_appointment', string> = {
  get_my_quotes:
    "This customer's own quotes: what they asked for, the sizes, the price and where it stands. Only theirs (sent from this number or linked to them). Use it before you answer about their quote",
  find_open_slots:
    'The open times a job can be booked, from the business’s booking hours and calendar. Open times only. Offer two or three of them, never the whole list',
  request_booking:
    "Ask for one open slot the customer picked (its exact start from find_open_slots). It holds the slot and asks the owner by text: nothing is booked until the owner says yes, and the customer gets a confirmation text when it is. Call it once per slot",
  confirm_appointment:
    'The customer confirms the job or meeting a reminder we texted them is for (its reminder id from their bookings section). Call it when they say yes to it',
  move_appointment:
    'Move a booked job they were reminded of to another open time they picked (its exact start from find_open_slots). It moves at once on the owner’s calendar and the owner is told. Not for a meeting: pass their times to the owner with message_owner',
}

/** Their inputs as plain JSON Schema, for the customer spec's proxies. */
export const CUSTOMER_TOOL_INPUT_JSON_SCHEMAS = {
  get_my_quotes: { type: 'object', properties: {}, additionalProperties: false },
  find_open_slots: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'First day to look at, an ISO date (2026-11-03). Default: the first bookable day' },
      days: { type: 'integer', minimum: 1, maximum: 14, description: 'How many days to look at from there. Default 7' },
    },
    additionalProperties: false,
  },
  request_booking: {
    type: 'object',
    properties: {
      start: { type: 'string', description: "The slot's exact start, as find_open_slots gave it (ISO date-time)" },
      name: { type: 'string', description: "The customer's name, as they gave it" },
      address: { type: 'string', description: 'Where the job is (the pickup address), as they gave it' },
      quote_id: { type: 'string', description: 'Their quote this booking is for, when they have one (from get_my_quotes)' },
      note: { type: 'string', description: 'Anything the owner should know for this job, in a line' },
    },
    required: ['start', 'name'],
    additionalProperties: false,
  },
  confirm_appointment: {
    type: 'object',
    properties: {
      reminder_id: { type: 'string', description: 'The reminder they are answering, from their bookings section' },
    },
    required: ['reminder_id'],
    additionalProperties: false,
  },
  move_appointment: {
    type: 'object',
    properties: {
      reminder_id: { type: 'string', description: 'The reminder of the booking to move, from their bookings section' },
      start: { type: 'string', description: "The new slot's exact start, as find_open_slots gave it (ISO date-time)" },
    },
    required: ['reminder_id', 'start'],
    additionalProperties: false,
  },
} as const
