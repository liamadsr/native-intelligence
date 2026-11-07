/**
 * The tools only a guest's agent holds (guest access, migration 427): what a
 * person the owner added needs that no registry tool gives them. They are
 * deliberately NOT in TOOL_CATEGORIES, like the live agent's own resolvers:
 * no other runtime grants them, and the main agent never holds them.
 *
 *   get_free_busy    the owner's calendar as busy blocks only, no titles,
 *                    places or attendees (a Colleague sees when, never what);
 *   message_owner    pass the owner a note from this person ("Sam says:"),
 *                    to their chat and, when it is urgent, a ping;
 *   ask_owner_agent  hand the owner's main agent something this agent can't
 *                    do. It runs as an unattended turn in the owner's home
 *                    thread, which answers within what this person may
 *                    know, raises a request for the owner, or declines; the
 *                    answer comes back to this person's thread;
 *   remember_about_guest  keep one thing learned about this person (how they
 *                    like things done) in agent_guest_memory: theirs, the
 *                    owner's to read, never the owner's own memory.
 *
 * Their trust is the guest class's (src/lib/safety/caller.ts): decideAction
 * runs them for a guest and denies them to every other caller.
 *
 * Pure: no imports, safe in any runtime (the client reads the labels).
 */

export interface GuestOnlyToolDefinition {
  name: string
  label: string
  description: string
}

export const GUEST_ONLY_TOOLS: readonly GuestOnlyToolDefinition[] = [
  {
    name: 'get_free_busy',
    label: 'Free/busy',
    description: "When the owner is busy in a date range, as blocks of time only: never an event's title, place, notes or who is in it",
  },
  {
    name: 'message_owner',
    label: 'Message the owner',
    description: 'Pass the owner a short note from this person, in their own words. Mark it urgent only when it is',
  },
  {
    name: 'ask_owner_agent',
    label: "Ask the owner's agent",
    description: "Ask the owner's own agent for something you can't do or don't know. It answers within what this person may know, asks the owner, or declines; its answer comes back here",
  },
  {
    name: 'remember_about_guest',
    label: 'Remember about them',
    description: 'Keep one short thing you learned about this person (a preference, or a fact about them) for your next conversations. Only what they told you, never anything of the owner\'s',
  },
]

export const GUEST_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(GUEST_ONLY_TOOLS.map((tool) => tool.name))

/** True for a tool only a guest's agent holds. */
export function isGuestOnlyTool(name: string): boolean {
  return GUEST_ONLY_TOOL_NAMES.has(name)
}

/**
 * Tools every guest's agent holds whatever the owner picked: it can always
 * reach the owner, and remember what this person likes. The People tab shows them as fixed.
 */
export const GUEST_ALWAYS_TOOLS: readonly string[] = ['message_owner', 'ask_owner_agent', 'remember_about_guest']
