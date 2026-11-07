/**
 * What a teammate may do on its own, in words: Settings → Autonomy's line per
 * role, and a bot's page's About (docs/plans/bots-v4.md, "A bot's page").
 * Pure, and client-safe.
 */
export function teammateAutonomyLine(t: { autonomy: string | null; allowed_side_effects: readonly string[] }): string {
  if (t.autonomy === 'off') return 'Switched off'
  if (t.autonomy === 'attempt') {
    return t.allowed_side_effects.includes('internal-write') ? 'Makes first passes on its own' : 'Set to attempt, but may not write drafts'
  }
  return 'Suggests work only'
}
