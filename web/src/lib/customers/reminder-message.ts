/**
 * The owner's reminder reports in their home thread (roadmap issue #11,
 * ./reminders.ts): ui_message.metadata.kind, and the flag that says whether
 * one goes on to find the owner (the reach router, src/lib/reach/route-policy.ts).
 * A move or an opt-out does; a plain yes, or the day's list of who was
 * reminded, stays in the thread. Pure and client-safe.
 */
export const CUSTOMER_REMINDER_MESSAGE_KIND = 'customer_reminder' as const

/** metadata key: true when the report should reach the owner where they are (a banner, or a text when away). */
export const CUSTOMER_REMINDER_ROUTES_KEY = 'reminder_routes' as const
