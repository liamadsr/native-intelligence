/**
 * The Mac body as a teammate (docs/plans/teammate-agent.md, C4). Pure and
 * client-safe: the store, the ledger, the chat tools and the Agents panel
 * share these.
 *
 * The Mac body is the Dial8 agent running on the person's Mac. The person
 * meets it as "Dial8 on <Mac name>", with its own thread (the session's
 * transcript), and it talks back with two teammate tools that C1's tool route
 * runs on the server: message_teammate (to Dial8 in the cloud, which answers
 * from a home turn) and report_to_person (a note in its own thread).
 */

/** The Mac body's teammate tools, in the order C1's spec lists them. */
export const MAC_TEAMMATE_TOOL_NAMES = ['message_teammate', 'report_to_person'] as const
export type MacTeammateToolName = (typeof MAC_TEAMMATE_TOOL_NAMES)[number]

export function isMacTeammateTool(name: unknown): name is MacTeammateToolName {
  return typeof name === 'string' && (MAC_TEAMMATE_TOOL_NAMES as readonly string[]).includes(name)
}

/** "Dial8 on Liam's MacBook Pro"; "Dial8 on your Mac" when the Mac has no name. */
export function macTeammateName(deviceName: string | null | undefined): string {
  const name = (deviceName ?? '').replace(/\s+/g, ' ').trim()
  return name ? `Dial8 on ${name}` : 'Dial8 on your Mac'
}
