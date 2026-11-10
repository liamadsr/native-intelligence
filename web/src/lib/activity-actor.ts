/**
 * How a server request names an agent for the activity log (migration 488,
 * entity_activity_actor): a service-role request has no auth.uid(), so the
 * log would credit what it changes to "the system". A client built with
 * these headers (the eve tool routes, the MCP connector) says the change is
 * an agent's, working for `userId`. A signed-in request is always its own
 * member whatever it sends, so only server code (which holds the service
 * key) can use them.
 */
export function agentActivityHeaders(userId: string): Record<string, string> {
  return { 'x-activity-actor': 'agent', 'x-activity-user': userId }
}
