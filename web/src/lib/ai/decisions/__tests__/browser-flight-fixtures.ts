import { browserInputSchema } from '../tasks/browser-next'
import type { BrowserAction } from '@/lib/browser-agent/task-contract'
import reconstructed from './browser-flight-fixtures.json'

/** Public/synthetic reconstructions, never exact production snapshot replays.
 * The form case checks only the next trip-type click: New York is not JFK proof.
 * Modal cases distinguish an explicit airport from a broader city/all-airports request.
 */
export const browserFlightFixtures = reconstructed.map(fixture => ({
  ...fixture,
  input: browserInputSchema.parse(fixture.input),
  expected: fixture.expected as BrowserAction,
}))
