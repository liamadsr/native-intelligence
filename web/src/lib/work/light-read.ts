/**
 * What the always-on light read carries beyond the counts (GET
 * /api/account/agent-work?light=1), shared by the route and the shell's hook
 * (use-agent-work.ts), so both agree.
 *
 * LIGHT_READS_BREAKERS: the light read reads each role's breaker too (on the
 * service client, as the full answer does), so the crew and
 * the bubble say "Attempts paused" with no Agents page open (bots-v4 Phase 4b:
 * "breakers, if they fit"). Measured on PROD for the heaviest user
 * (2026-10-07): ~0.15 ms a read. While it's on, the hook reloads the light
 * answer when an attempt is dismissed (a role's breaker may have tripped), as
 * full mode always has. If it goes false, every `breaker` in the light answer
 * is null again, the crew draws working and switched off, and "Attempts
 * paused" waits for the bot's page (its own `?teammate=` read).
 */
export const LIGHT_READS_BREAKERS = true
