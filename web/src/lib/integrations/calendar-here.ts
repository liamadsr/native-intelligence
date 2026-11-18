/**
 * The calendar the assistant's tools may use for work done IN a workspace.
 *
 * A demo workspace (migration 669) has none. Nothing real is connected to it,
 * and the calendar lookups go by person, not by workspace: a person's own
 * calendar, connected in another workspace, would otherwise answer here, and
 * the assistant would read it into a place others see, or write a real event
 * (and mail its attendees) from inside the demo. Everywhere else this is
 * getCalendarProvider.
 */
import { isDemoWorkspace } from '@/lib/demo/demo-mode'
import { getCalendarProvider } from './calendar'

export async function getCalendarProviderIn(
  userId: string,
  workspaceId: string | null | undefined,
): Promise<Awaited<ReturnType<typeof getCalendarProvider>>> {
  if (await isDemoWorkspace(workspaceId)) return null
  return getCalendarProvider(userId)
}
