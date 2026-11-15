/**
 * Room for form uploads in flight, in this process (./submit.ts step 4). A
 * multipart post to a form that takes files is held in memory while it is
 * read and checked, and until its files are stored, so how many such bodies
 * are held at once is what one sender (or a few) could run the web
 * container out of memory with. The try caps count posts an hour, not posts
 * at once, so they can't bound this; this does.
 *
 * Each upload takes room by its declared Content-Length before a byte of it
 * is read (./body.ts refuses one with no length, 411, rather than reserving
 * it at the most) and gives it back when its request ends, however it ends.
 * Past FORM_UPLOAD_BYTES_IN_FLIGHT across every form, a post is answered 503
 * "Try again in a moment."; past FORM_UPLOADS_PER_SENDER uploads at once from
 * one sender (./client.ts formClientKey: an address, an IPv6 one by its /64),
 * 429. The app runs as one web process on one server, so this process's
 * count is the server's.
 *
 * The number, from what one upload holds (./body.ts, ./files.ts,
 * ./file-store.ts):
 *   - its body once, in one buffer of its declared length (at most
 *     FORM_UPLOAD_BODY_MAX, about 50.1 MiB); each part is a view into that
 *     buffer, never a copy, and the same bytes are checked and stored;
 *   - a text or CSV file's check decodes it 64 KiB at a time;
 *   - storing a file hands its bytes to fetch, which copies them once while
 *     that file is sent (at most FORM_FILE_LIMITS.maxBytes, 10 MiB), one
 *     file at a time.
 * So one upload holds at most its declared length plus 10 MiB (and never
 * more than twice its declared length). 256 MiB in flight is at most five
 * bodies at their largest (5 x 50.1 MiB), about 306 MiB with their sends;
 * however the room is split, never more than 512 MiB. The web container has
 * 6 GB, and the app's own heap runs under 2 GB: this leaves well over half.
 *
 * Pure but for the counts.
 */

/** Bytes of form uploads held at once, across every form. See the header for the arithmetic. */
export const FORM_UPLOAD_BYTES_IN_FLIGHT = 256 * 1024 * 1024
/** Uploads one sender has in flight at once. A person sends one; a page that resends while the first is still going, two. */
export const FORM_UPLOADS_PER_SENDER = 2

let inFlight = 0
const bySender = new Map<string, number>()

export type UploadRoom = { ok: true; release: () => void } | { ok: false; reason: 'busy' | 'sender' }

/**
 * Take room for an upload of `bytes` from `sender` (null: the edge said
 * nothing usable, counted in the total only). Its `release` gives the room
 * back; calling it again does nothing.
 */
export function takeUploadRoom(bytes: number, sender: string | null): UploadRoom {
  const size = Math.max(0, Math.ceil(bytes))
  if (sender && (bySender.get(sender) ?? 0) >= FORM_UPLOADS_PER_SENDER) return { ok: false, reason: 'sender' }
  if (inFlight + size > FORM_UPLOAD_BYTES_IN_FLIGHT) return { ok: false, reason: 'busy' }
  inFlight += size
  if (sender) bySender.set(sender, (bySender.get(sender) ?? 0) + 1)
  let released = false
  return {
    ok: true,
    release: () => {
      if (released) return
      released = true
      inFlight -= size
      if (!sender) return
      const left = (bySender.get(sender) ?? 1) - 1
      if (left > 0) bySender.set(sender, left)
      else bySender.delete(sender)
    },
  }
}

/** Bytes of uploads held now. */
export function uploadBytesInFlight(): number {
  return inFlight
}

/** Test seam: forget every upload counted. */
export function __resetUploadRoomForTests(): void {
  inFlight = 0
  bySender.clear()
}
