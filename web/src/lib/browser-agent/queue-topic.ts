/**
 * The person's browser topic: a private Realtime channel per user (RLS on
 * `browser-cmd:<userId>` and its subtopics, migration 292). Its own module so a
 * client component can name it without the queue's server code. The server
 * rings the cloud browser's computer (docs/plans/cloud-browser.md, C3) on
 * `browser-cmd:<userId>:computer`; the person's windows listen:
 * `browser-show`, `browser-hide`, `computer-changed` and `driver-changed`, and
 * for the Mac exit (C4) `browser-up` / `browser-down` (the browser started or
 * stopped), each with the `workspaceId` it is about (a window on another
 * workspace ignores it).
 */
export function browserComputerTopic(userId: string): string {
  return `browser-cmd:${userId}:computer`
}

export type ComputerRing = 'browser-show' | 'browser-hide' | 'computer-changed' | 'driver-changed' | 'browser-up' | 'browser-down'
