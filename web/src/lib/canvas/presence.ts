/**
 * A canvas's presence room (migration 682): its Realtime topic, and the one
 * thing the server says in it. The editor joins the room
 * (components/canvas/live.ts); the server speaks only to say that who may
 * open the canvas changed (a grant removed or lowered, migration 688), so
 * each editor in the room asks again whether it may still open or edit it.
 */

/** The Realtime topic of a canvas's presence room. Migration 682's policies read the canvas id back out of it. */
export function presenceTopic(canvasId: string): string {
  return `canvas-presence:${canvasId.toLowerCase()}`
}

/** Said by the server (never a person) when the canvas's sharing changed. It names nobody. */
export const ACCESS_CHANGED_EVENT = 'access_changed'
