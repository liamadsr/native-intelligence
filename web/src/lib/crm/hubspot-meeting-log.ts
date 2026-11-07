/**
 * Whether a workspace logs its finished meetings to HubSpot
 * (`workspace.settings.log_meetings_to_hubspot`).
 *
 * ON BY DEFAULT (Liam, 2026-10-17: opinionated platform, no configuration
 * fatigue): a workspace that connected HubSpot wants its meetings there, so a
 * missing key means on. Only an explicit `false`, written by the toggle on the
 * HubSpot integration page, turns it off. The flag alone logs nothing: the
 * hubspot-log-capture function still needs a connected HubSpot account, a
 * workspace-visible capture and a participant with a HubSpot id.
 *
 * Leaf module on purpose: the settings route and the Inngest function both
 * read it without pulling either one in.
 */
export function logsMeetingsToHubspot(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return true
  return (settings as Record<string, unknown>).log_meetings_to_hubspot !== false
}
