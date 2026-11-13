// Takes uploaded while they are recorded. A browser take used to wait for Stop and then upload every file whole, so a
// crash or a closed window lost all of it and a long take kept the person waiting. Now each track of a take (screen,
// camera, microphone) goes to storage in pieces as the recorder makes them, a few seconds each:
//
//   POST   /live-takes                 {id?, recorder, tracks:[{role, name, frameRate?}]}  -> {take}
//   POST   /live-takes/:id/pieces      {role, index, bytes, seconds?, offsetSeconds?} -> {index, url, headers} | {index, stored}
//   GET    /live-takes                 the person's takes that stopped before they were finished (to bring back)
//   POST   /live-takes/:id/recover     one of those made a video from what arrived    -> RecordingAnswer
//   DELETE /live-takes/:id             thrown away: its pieces, its records, the space it held
//
// At Stop the take is handed to POST /recordings with its tracks as upload keys, `live/<take id>/<role>`; the track is
// sealed there (sealLiveTrack) and the worker reads it like any stored file: a link per piece, joined in order. Joined
// in order, the pieces are byte for byte what the recorder wrote (WebM from Chromium, fragmented MP4 from WebKit or
// Chromium), so a track cut short by a crash is still a file that plays up to its last piece.
//
// The fences, as for every upload: only the person who started the take reaches it (any other answer is "not
// found"); only the person's own session, never a job (ctx.userId, the routes are on the person's door only); a piece
// is at most PIECE_MAX_BYTES and a track at most TRACK_MAX_BYTES, held against the workspace's space before its link
// is signed; pieces come in order, each declared with its length. What is stored is held to that length: a link never
// replaces a stored piece (signed without upsert; storage refuses a second PUT over it), and before piece n is signed,
// piece n-1 must be in storage at its declared length, else that piece is removed and the take stops there, keeping
// what came before. So at most the last piece of a track can be stored at another length, and storage's own cap per
// object bounds it. The same piece is signed again only MAX_RESENDS times. A track is sealed only from pieces that are
// in storage at exactly their length, in an unbroken run from the first; the first piece must open as a recording
// (WebM, Matroska, MP4 or Ogg), and the worker's import then checks the whole file.
//
// A signed upload link is a token storage checks, not one it uses up: until it expires (about two hours) it can create
// its object again after the object was removed. Pieces no take points to are therefore swept (sweep.ts).
//
// No migration: a take is two kinds of studio_record (TAKES, one per take; TRACKS, one per track, written by that
// track's uploads alone), and the space a track holds is a pending write under its key (blobs.ts PENDING), which
// studio_workspace_bytes already counts. Pieces live where a blob's parts do: `<workspace>/live/<take>/<role>/<n>`.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { blobObject, type BlobRead } from './job-contract'
import { PENDING, READ_LINK_SECONDS, storageOf, workspaceByteLimit, workspaceBytes, type PendingWrite } from './blobs'
import { isUuid, must, type StudioContext } from './context'
import { conflictError, notFoundError, StudioError } from './errors'
import { allowedType, typeForName } from './media-types'
import { deleteRecord, getRecord, getRecords, putRecord } from './records'
import { removeAll } from './storage'

export const LIVE_ROLES = ['screen', 'camera', 'microphone', 'systemAudio'] as const
export type LiveRole = (typeof LIVE_ROLES)[number]

/** A live track's key: `live/<take id>/<role>`. */
export const LIVE_KEY = /^live\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(screen|camera|microphone|systemAudio)$/
export const liveKey = (takeId: string, role: LiveRole) => `live/${takeId}/${role}`
export const isLiveKey = (key: unknown): key is string => typeof key === 'string' && LIVE_KEY.test(key)
export function parseLiveKey(key: string): { takeId: string; role: LiveRole } | null {
  const match = LIVE_KEY.exec(key)
  return match ? { takeId: match[1]!, role: match[2] as LiveRole } : null
}

/** The longest piece: a few seconds of a sharp 4K screen fit easily (the recorder sends about 4 s at a time). */
export const PIECE_MAX_BYTES = 16 * 1024 ** 2
/** The most one track may hold: the Studio's upload limit (media.ts MAX_UPLOAD_BYTES). */
export const TRACK_MAX_BYTES = 2 * 1024 ** 3
/** The most pieces one track may have (two hours at one piece a second is 7,200). */
export const TRACK_MAX_PIECES = 10_000
/** How many takes one person may have recording at once (another tab, another window). */
export const MAX_RECORDING_TAKES = 3
/** A take with no new piece for this long stopped: it is offered back, never while it may still be recording. */
export const QUIET_MS = 90_000
/** Space is held for a track this much at a time, so most pieces need no extra write. */
export const RESERVE_STEP = 64 * 1024 ** 2
/** How many times a track's pieces may be signed again (an upload that failed, an answer that was lost). */
export const MAX_RESENDS = 50
/**
 * The least a piece but the last may hold. The recorder's pieces are about four seconds: a silent microphone's are
 * about 2 KB (Opus, 4 s) to 3 KB (AAC), a screen's or a camera's far more, and the recorder never cuts one smaller
 * (live.ts). It keeps piece links from being collected for next to nothing.
 */
export const PIECE_MIN_BYTES = 1024
/**
 * How long a piece's upload link may still work after it was signed: storage's signed upload links last two hours
 * (storage-js; the token is checked, not used up), plus an hour's margin. A removed piece's path could be written
 * again through its link until then, so a take's pieces are removed only once its last link is this old
 * (retireLiveTake); until then they stay, and storage refuses a PUT over a stored piece (links are signed without upsert).
 */
export const LINK_SAFE_MS = 3 * 3600_000
/**
 * The most one link could still store: the storage's own cap per object on our server (FILE_SIZE_LIMIT, 50 MB, in
 * deploy/supabase; a PUT declaring more is refused before it starts).
 */
export const LINK_WRITE_MAX = 50 * 1024 ** 2
/**
 * How many pieces of a track may be under PIECE_MIN_BYTES and still be followed by another: a recorder of an older
 * version cut pieces on time alone, and a near-silent one might; past this, the floor holds.
 */
export const SMALL_PIECES_MAX = 50

export const TAKES = 'live-takes'
export const TRACKS = 'live-tracks'

export type TakeRecord = {
  id: string
  ownerId: string
  createdAt: string
  recorder: 'browser' | 'desktop'
  /**
   * recording: pieces may still come, or it stopped before it was finished (offered back once quiet).
   * finished: handed to a recording (`recordingId`); no more pieces.
   * dropped: thrown away, or its recording made; its pieces stay until its links can no longer write (retireLiveTake).
   */
  status: 'recording' | 'finished' | 'dropped'
  /** When it was dropped. */
  droppedAt?: string
  tracks: Partial<Record<LiveRole, { name: string; frameRate?: number }>>
  recordingId?: string
  /** A recording made from it that could not be made (it was offered back): its id. */
  failedRecordingId?: string
  /** When it was offered back after that recording could not be made (the sweep keeps it a week from then). */
  reopenedAt?: string
}

export type TrackRecord = {
  takeId: string
  role: LiveRole
  /** How many pieces were declared (each piece's link is signed in order: the next one is piece `n`). */
  n: number
  /** Each declared piece's length, in order. */
  pieces: number[]
  /** How many seconds the track had recorded at the end of each declared piece. */
  times?: number[]
  bytes: number
  /** The space held for this track (a pending write under its key). */
  reserved: number
  /** Seconds after the screen's first frame this track's first frame was taken (0 for the screen; null until said). */
  offsetSeconds: number | null
  /** How many seconds the track had recorded at its latest declared piece. */
  seconds: number
  /** How many times a piece of it was signed again. */
  resends?: number
  /** How many of its pieces, followed by another, were under PIECE_MIN_BYTES (SMALL_PIECES_MAX). */
  smallPieces?: number
  /** Why no more pieces are taken: a piece was not stored as it was declared. */
  stopped?: string
  updatedAt: string
  /** Set once the track is handed to a recording: the unbroken run of pieces it is made of. */
  sealed?: { count: number; bytes: number; complete: boolean; at: string }
}

const trackKey = (takeId: string, role: LiveRole) => `${takeId}:${role}`
const secondsAt = (track: TrackRecord, count: number) => (count > 0 ? (track.times?.[count - 1] ?? track.seconds) : 0)

/** The person acting: a take is only ever the signed-in person's own, never a job's. */
function person(ctx: StudioContext): string {
  if (!ctx.userId) throw new StudioError('Only the person recording can send a recording.', 403, 'FORBIDDEN')
  return ctx.userId
}

/** The take, when it is this person's; anything else is not found (nothing says whose it is). */
export async function loadTake(ctx: StudioContext, takeId: unknown): Promise<TakeRecord> {
  const who = person(ctx)
  if (!isUuid(takeId)) throw notFoundError('That recording is not here.')
  const take = await getRecord<TakeRecord>(ctx, TAKES, takeId)
  if (!take || take.ownerId !== who) throw notFoundError('That recording is not here.')
  return take
}

async function loadTrack(ctx: StudioContext, take: TakeRecord, role: LiveRole): Promise<TrackRecord> {
  if (!take.tracks[role]) throw new StudioError('That track is not part of this recording.')
  const track = await getRecord<TrackRecord>(ctx, TRACKS, trackKey(take.id, role))
  if (!track) throw notFoundError('That recording is not here.')
  return track
}

/** Write a track only if nobody moved it on since it was read (its piece count and resend count as read) and it is not sealed. */
async function moveTrack(ctx: StudioContext, before: TrackRecord, next: TrackRecord): Promise<boolean> {
  const query = ctx.supabase.from('studio_record').update({ value: next, updated_at: new Date().toISOString() })
      .eq('workspace_id', ctx.workspaceId).eq('collection', TRACKS).eq('key', trackKey(before.takeId, before.role))
      .eq('value->>n', String(before.n)).is('value->sealed', null)
  const exact = before.resends === undefined ? query.is('value->>resends', null) : query.eq('value->>resends', String(before.resends))
  const moved = must(
    await exact.select('key'),
    'save the recording',
  ) as { key: string }[] | null
  return !!moved?.length
}

const MEDIA_NAME = /\.(webm|mkv|mp4|m4a|mov|ogg)$/i

const StartSchema = z
  .object({
    /** The recorder's own id for the take, so a start sent again (its answer lost) is the same take. */
    id: z.string().refine(isUuid, 'Not a recording id').optional(),
    recorder: z.enum(['browser', 'desktop']).default('browser'),
    tracks: z
      .array(
        z
          .object({
            role: z.enum(LIVE_ROLES),
            name: z.string().trim().min(1).max(240).refine((name) => !/[\\/\0]/.test(name), 'A file name has no folders').refine((name) => MEDIA_NAME.test(name), 'A recording is WebM, MP4, M4A or Ogg'),
            /** The frame rate the recorder asked for or the device says it gives (getSettings().frameRate). */
            frameRate: z.number().finite().positive().max(240).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(LIVE_ROLES.length),
  })
  .strict()

/** What the recorder is told about its take. */
export type LiveTakeView = { id: string; keys: Partial<Record<LiveRole, string>>; pieceMaxBytes: number }
const takeView = (take: TakeRecord): LiveTakeView => ({
  id: take.id,
  keys: Object.fromEntries(LIVE_ROLES.filter((role) => take.tracks[role]).map((role) => [role, liveKey(take.id, role)])),
  pieceMaxBytes: PIECE_MAX_BYTES,
})

/** The person's takes with a piece (or a start) in the last QUIET_MS: those may still be recording. */
async function activeTakes(ctx: StudioContext, who: string, now: number): Promise<number> {
  const rows = must(
    await ctx.supabase.from('studio_record').select('key').eq('workspace_id', ctx.workspaceId).eq('collection', TRACKS)
      .gte('updated_at', new Date(now - QUIET_MS).toISOString()).order('updated_at', { ascending: false }).limit(500),
    'start the recording',
  ) as { key: string }[] | null
  const ids = [...new Set((rows ?? []).map((row) => row.key.split(':')[0]!))]
  const takes = await getRecords<TakeRecord>(ctx, TAKES, ids)
  return [...takes.values()].filter((take) => take.ownerId === who && take.status === 'recording').length
}

/**
 * Start a take: its record and one record per track. The recorder then sends pieces as it makes them. A start sent
 * again with the same id answers the same take.
 */
export async function startLiveTake(ctx: StudioContext, body: unknown, now = Date.now()): Promise<{ take: LiveTakeView }> {
  const who = person(ctx)
  const input = StartSchema.parse(body)
  const roles = input.tracks.map((track) => track.role)
  if (new Set(roles).size !== roles.length) throw new StudioError('Each track of a recording is sent once.')
  if (!roles.includes('screen')) throw new StudioError('A recording has a screen track.')
  if (input.id) {
    const existing = await getRecord<TakeRecord>(ctx, TAKES, input.id)
    if (existing && existing.ownerId === who) return { take: takeView(existing) }
    if (existing) throw conflictError('That recording id is taken. Start the recording again.')
  }
  if ((await activeTakes(ctx, who, now)) >= MAX_RECORDING_TAKES) throw new StudioError(`You already have ${MAX_RECORDING_TAKES} recordings going. Stop one first.`, 429, 'TOO_MANY_TAKES')
  const id = input.id ?? randomUUID()
  const at = new Date(now).toISOString()
  const take: TakeRecord = {
    id, ownerId: who, createdAt: at, recorder: input.recorder, status: 'recording',
    tracks: Object.fromEntries(input.tracks.map((track) => [track.role, { name: track.name, ...(track.frameRate ? { frameRate: track.frameRate } : {}) }])),
  }
  // The take first: a track never exists without the take it belongs to (the sweep removes pieces no take points to).
  await putRecord(ctx, TAKES, id, take)
  for (const role of roles) {
    const track: TrackRecord = { takeId: id, role, n: 0, pieces: [], times: [], bytes: 0, reserved: 0, offsetSeconds: role === 'screen' ? 0 : null, seconds: 0, resends: 0, updatedAt: at }
    await putRecord(ctx, TRACKS, trackKey(id, role), track)
  }
  return { take: takeView(take) }
}

const PieceSchema = z
  .object({
    role: z.enum(LIVE_ROLES),
    index: z.number().int().min(0),
    bytes: z.number().int().min(1),
    seconds: z.number().finite().min(0).max(24 * 3600).optional(),
    offsetSeconds: z.number().finite().min(-3600).max(3600).optional(),
  })
  .strict()

const readable = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.ceil(bytes / 1024 ** 2)} MB`)

/**
 * Hold `reserved` bytes for a track (its pending write), then check the workspace is still within its limit; past it,
 * the hold goes back to what it was and the piece is refused (413). As blobs.ts reserveSpace, two writes at once each
 * see the other. (A take thrown away between the read and this write leaves a hold with no track: the sweep removes it.)
 */
async function holdTrackSpace(ctx: StudioContext, key: string, before: number, reserved: number, contentType: string): Promise<void> {
  const pending = (bytes: number): PendingWrite & { token: string } => ({ bytes, partBytes: PIECE_MAX_BYTES, contentType, sha256: null, createdAt: new Date().toISOString(), token: 'live' })
  const write = async (bytes: number) =>
    must(await ctx.supabase.from('studio_record').upsert({ workspace_id: ctx.workspaceId, collection: PENDING, key, value: pending(bytes), updated_at: new Date().toISOString() }, { onConflict: 'workspace_id,collection,key' }), 'save the recording')
  await write(reserved)
  const limit = workspaceByteLimit()
  const used = await workspaceBytes(ctx)
  if (used <= limit) return
  await write(before)
  throw new StudioError(`This workspace's Studio holds ${readable(used - (reserved - before))} of its ${readable(limit)}, so the recording can't be saved past this point. Remove media or exports you no longer need.`, 413, 'QUOTA')
}

const MISMATCH = (index: number) => `Piece ${index + 1} of the recording was not stored as it was sent, so the recording stopped there. What came before it is kept.`

/**
 * A piece was not in storage at its declared length: its bytes are replaced by an empty object (the path stays taken,
 * so its link, still good for a while, cannot store anything there again), the track's declaration ends before it,
 * and the track takes no more pieces. Throws the conflict that stops the recorder.
 */
async function stopAt(ctx: StudioContext, track: TrackRecord, index: number, key: string): Promise<never> {
  await storageOf(ctx).upload(blobObject(ctx.workspaceId, key, index), new Uint8Array(0), 'application/octet-stream').catch(() => undefined)
  const kept = track.pieces.slice(0, index)
  const next: TrackRecord = {
    ...track,
    n: index,
    pieces: kept,
    times: (track.times ?? []).slice(0, index),
    bytes: kept.reduce((sum, bytes) => sum + bytes, 0),
    stopped: MISMATCH(index),
    updatedAt: new Date().toISOString(),
  }
  await moveTrack(ctx, track, next)
  throw conflictError(MISMATCH(index), 'PIECE_MISMATCH')
}

export type PieceLink = { index: number; url: string; headers: Record<string, string> } | { index: number; stored: true }

/**
 * A link for the next piece of a track. Pieces come in order: piece `index` must be the next one, or the last one
 * again with the same length (its upload failed, or its answer was lost: when it is in storage at its length already,
 * the answer is `stored` and nothing is to be sent). Before piece n is signed, piece n-1 must be in storage at its
 * declared length; otherwise the take stops there (PIECE_MISMATCH). Links never replace a stored piece.
 */
export async function livePiece(ctx: StudioContext, takeId: string, body: unknown): Promise<PieceLink> {
  const take = await loadTake(ctx, takeId)
  const input = PieceSchema.parse(body)
  if (take.status !== 'recording') throw conflictError('This recording is finished: nothing more can be added to it.', 'TAKE_CLOSED')
  const track = await loadTrack(ctx, take, input.role)
  if (track.sealed) throw conflictError('This recording is finished: nothing more can be added to it.', 'TAKE_CLOSED')
  if (track.stopped) throw conflictError(track.stopped, 'PIECE_MISMATCH')
  if (input.bytes > PIECE_MAX_BYTES) throw new StudioError(`A piece of a recording is at most ${readable(PIECE_MAX_BYTES)}.`, 413, 'TOO_LARGE')
  const key = liveKey(take.id, input.role)
  const storage = storageOf(ctx)
  const path = (index: number) => blobObject(ctx.workspaceId, key, index)
  const sign = async (): Promise<PieceLink> => {
    // Never upsert: a stored piece is never replaced through a link (storage refuses a PUT over it).
    const signed = await storage.signUpload(path(input.index), 'application/octet-stream', { upsert: false })
    return { index: input.index, url: signed.url, headers: signed.headers }
  }
  // The last piece again (its upload failed, or the answer was lost): the same piece, the same length.
  if (input.index === track.n - 1) {
    if (track.pieces[input.index] !== input.bytes) throw conflictError(`Piece ${input.index + 1} was sent already with another length.`, 'OUT_OF_ORDER')
    const size = await storage.size(path(input.index))
    if (size === input.bytes) return { index: input.index, stored: true }
    if (size !== null) return stopAt(ctx, track, input.index, key)
    if ((track.resends ?? 0) >= MAX_RESENDS) throw conflictError('This recording could not be sent: the same piece failed too many times.', 'TOO_MANY_RESENDS')
    if (!(await moveTrack(ctx, track, { ...track, resends: (track.resends ?? 0) + 1, updatedAt: new Date().toISOString() }))) throw conflictError('Another upload of this recording got there first. Try again.', 'BUSY')
    return sign()
  }
  if (input.index < track.n) throw conflictError(`Piece ${input.index + 1} was sent already.`, 'OUT_OF_ORDER')
  if (input.index > track.n) throw conflictError(`Piece ${track.n + 1} must be sent before piece ${input.index + 1}.`, 'OUT_OF_ORDER')
  if (track.n >= TRACK_MAX_PIECES) throw new StudioError('This recording has as many pieces as one can hold. Stop it and start another.', 413, 'TOO_LARGE')
  // A piece followed by another is not the last: it holds at least PIECE_MIN_BYTES (the recorder never cuts one smaller;
  // an older recorder might, a few times, near silence: SMALL_PIECES_MAX of those are taken).
  const small = track.n > 0 && track.pieces[track.n - 1]! < PIECE_MIN_BYTES
  if (small && (track.smallPieces ?? 0) >= SMALL_PIECES_MAX)
    throw new StudioError(`A piece of a recording, but the last, holds at least ${PIECE_MIN_BYTES} bytes.`, 400, 'TOO_SMALL')
  // The recorder asks for piece n only once piece n-1 went up: it must be in storage, at the length it was declared with.
  if (track.n > 0 && (await storage.size(path(track.n - 1))) !== track.pieces[track.n - 1]) return stopAt(ctx, track, track.n - 1, key)
  const bytes = track.bytes + input.bytes
  if (bytes > TRACK_MAX_BYTES) throw new StudioError(`A recording holds at most ${readable(TRACK_MAX_BYTES)} a track. Stop it and start another.`, 413, 'TOO_LARGE')
  let reserved = track.reserved
  if (bytes > reserved) {
    reserved = Math.min(TRACK_MAX_BYTES, Math.max(bytes, track.reserved + RESERVE_STEP))
    await holdTrackSpace(ctx, key, track.reserved, reserved, allowedType(typeForName(take.tracks[input.role]!.name)))
  }
  const seconds = Math.max(track.seconds, input.seconds ?? 0)
  const next: TrackRecord = {
    ...track,
    n: track.n + 1,
    pieces: [...track.pieces, input.bytes],
    times: [...(track.times ?? []), seconds],
    bytes,
    reserved,
    seconds,
    offsetSeconds: input.role === 'screen' ? 0 : (input.offsetSeconds ?? track.offsetSeconds),
    ...(small ? { smallPieces: (track.smallPieces ?? 0) + 1 } : {}),
    updatedAt: new Date().toISOString(),
  }
  // Only the writer that read this very count moves it on: a second request for the same piece gets a conflict.
  if (!(await moveTrack(ctx, track, next))) throw conflictError('Another upload of this recording got there first. Try again.', 'BUSY')
  return sign()
}

/** What a recording starts with: WebM or Matroska (EBML), MP4 (an ISO box, `ftyp` first) or Ogg. Pure. */
export function recordingContainer(head: Uint8Array): 'webm' | 'mp4' | 'ogg' | null {
  if (head.length < 8) return null
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm'
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to))
  if (ascii(4, 8) === 'ftyp') return 'mp4'
  if (ascii(0, 4) === 'OggS') return 'ogg'
  return null
}

export type SealedTrack = {
  key: string
  role: LiveRole
  name: string
  bytes: number
  count: number
  complete: boolean
  /** How long the sealed run of pieces is, in seconds (not the newest piece declared). */
  seconds: number
  offsetSeconds: number | null
  frameRate?: number
}

const sealedView = (key: string, take: TakeRecord, track: TrackRecord): SealedTrack => ({
  key,
  role: track.role,
  name: take.tracks[track.role]!.name,
  bytes: track.sealed!.bytes,
  count: track.sealed!.count,
  complete: track.sealed!.complete,
  seconds: secondsAt(track, track.sealed!.count),
  offsetSeconds: track.offsetSeconds,
  ...(take.tracks[track.role]!.frameRate ? { frameRate: take.tracks[track.role]!.frameRate } : {}),
})

/**
 * Seal a track for a recording: the unbroken run of pieces from the first that are in storage at their declared
 * length. With `stated` (the recorder says how many it sent, or 'all' it declared) all of them must be there (409
 * UPLOAD_INCOMPLETE otherwise, so the recorder sends the missing one again); without it (a take brought back after a
 * crash) the run that arrived is the track, and null when nothing did. `cut`: the recorder stopped sending before the
 * recording's end (the Studio refused the rest), so its last piece may end mid-frame, as a crashed take's; a track the
 * Studio stopped (PIECE_MISMATCH) is read that way whatever the recorder says. The first piece must open as a
 * recording. Sealing again answers the first seal, but never for more pieces than it holds.
 */
export async function sealLiveTrack(ctx: StudioContext, key: string, stated?: number | 'all', options: { cut?: boolean } = {}): Promise<SealedTrack | null> {
  const parsed = parseLiveKey(key)
  if (!parsed) throw new StudioError('That is not a recording track.')
  const take = await loadTake(ctx, parsed.takeId)
  if (take.status === 'dropped') throw notFoundError('That recording is not here.')
  const track = await loadTrack(ctx, take, parsed.role)
  if (track.sealed) {
    if (typeof stated === 'number' && !track.stopped && stated > track.sealed.count)
      throw conflictError(`The upload is not complete: the recording was saved with ${track.sealed.count} pieces, not ${stated}.`, 'UPLOAD_INCOMPLETE')
    return sealedView(key, take, track)
  }
  // Stopped by the Studio: what is there, read as far as it goes.
  if (track.stopped) {
    stated = undefined
    options = { cut: true }
  }
  const expected = stated === 'all' ? Math.max(1, track.n) : stated
  if (expected !== undefined && expected > track.n) throw conflictError(`The upload is not complete: piece ${track.n + 1} of ${expected} was never sent.`, 'UPLOAD_INCOMPLETE')
  const storage = storageOf(ctx)
  const listed = new Map((await storage.list(`${ctx.workspaceId}/${key}`)).map((item) => [item.name, item.size]))
  const want = expected ?? track.n
  let count = 0
  let bytes = 0
  while (count < want && listed.get(String(count)) === track.pieces[count]) bytes += track.pieces[count++]!
  if (expected !== undefined && count < expected) {
    const size = listed.get(String(count))
    throw conflictError(
      size === undefined
        ? `The upload is not complete: piece ${count + 1} of ${expected} is missing.`
        : `The upload is not complete: piece ${count + 1} of ${expected} has ${size} bytes, not ${track.pieces[count]}.`,
      'UPLOAD_INCOMPLETE',
    )
  }
  if (!count) {
    if (expected !== undefined) throw new StudioError('A recording track has at least one piece.')
    return null
  }
  const container = recordingContainer(await storage.head(blobObject(ctx.workspaceId, key, 0), 16))
  const audio = parsed.role === 'microphone' || parsed.role === 'systemAudio'
  if (!container || (container === 'ogg' && !audio)) throw new StudioError(`The ${parsed.role === 'systemAudio' ? 'system sound' : parsed.role} recording is not a video or sound file.`, 415, 'NOT_MEDIA')
  const at = new Date().toISOString()
  // Complete: the recorder said how many it sent, and it sent the whole recording (not `cut` short by a refusal).
  const sealed: TrackRecord = { ...track, sealed: { count, bytes, complete: expected !== undefined && !options.cut, at } }
  // Only over the track as it was read: a piece signed meanwhile (or another seal) makes this one try again.
  if (!(await moveTrack(ctx, track, sealed))) throw conflictError('This recording changed while it was being saved. Try again.', 'BUSY')
  // The space held shrinks to what the track is (until the recording is made and it goes).
  must(
    await ctx.supabase.from('studio_record').update({ value: { bytes, partBytes: PIECE_MAX_BYTES, contentType: allowedType(typeForName(take.tracks[parsed.role]!.name)), sha256: null, createdAt: at, token: 'live' } satisfies PendingWrite, updated_at: at })
      .eq('workspace_id', ctx.workspaceId).eq('collection', PENDING).eq('key', key),
    'save the recording',
  )
  return sealedView(key, take, sealed)
}

/**
 * The take becomes recording `recordingId`, once: only a take still recording is moved (a second request for the
 * same take finds it finished and answers the first one's recording). True when this call moved it.
 */
export async function claimLiveTake(ctx: StudioContext, take: TakeRecord, recordingId: string): Promise<boolean> {
  const next: TakeRecord = { ...take, status: 'finished', recordingId }
  const moved = must(
    await ctx.supabase.from('studio_record').update({ value: next, updated_at: new Date().toISOString() })
      .eq('workspace_id', ctx.workspaceId).eq('collection', TAKES).eq('key', take.id).eq('value->>status', 'recording')
      .select('key'),
    'save the recording',
  ) as { key: string }[] | null
  return !!moved?.length
}

/**
 * Write a take only if it is still as it was read: the same status and the same recording (none, or that one). Every
 * write that changes a take's status goes through this, so two changes at once never overwrite each other.
 */
async function moveTake(ctx: StudioContext, before: TakeRecord, next: TakeRecord): Promise<boolean> {
  const query = ctx.supabase.from('studio_record').update({ value: next, updated_at: new Date().toISOString() })
    .eq('workspace_id', ctx.workspaceId).eq('collection', TAKES).eq('key', before.id).eq('value->>status', before.status)
  const exact = before.recordingId ? query.eq('value->>recordingId', before.recordingId) : query.is('value->>recordingId', null)
  const moved = must(await exact.select('key'), 'save the recording') as { key: string }[] | null
  return !!moved?.length
}

/** Give a claimed take back (its recording could not be started): it is recording again, as it was, only from that claim. */
export async function unclaimLiveTake(ctx: StudioContext, take: TakeRecord, recordingId: string): Promise<void> {
  await moveTake(ctx, { ...take, status: 'finished', recordingId }, take)
}

/**
 * The recording made from a take could not be made: the take is offered back (recording again, quiet), with every
 * piece kept, to be brought back again (its tracks read as far as they go) or thrown away. Acts for nobody (the
 * worker's end of an import may finish it). Never throws.
 */
export async function reopenLiveTake(ctx: StudioContext, takeId: string, recordingId: string): Promise<void> {
  try {
    const take = await getRecord<TakeRecord>(ctx, TAKES, takeId)
    if (!take || take.status !== 'finished' || take.recordingId !== recordingId) return
    for (const role of LIVE_ROLES) {
      if (!take.tracks[role]) continue
      const track = await getRecord<TrackRecord>(ctx, TRACKS, trackKey(takeId, role))
      // Written again in any case: the week the sweep keeps a track starts again from being offered back.
      if (track) await putRecord(ctx, TRACKS, trackKey(takeId, role), track.sealed ? { ...track, sealed: { ...track.sealed, complete: false } } : track)
    }
    const { recordingId: _gone, ...rest } = take
    void _gone
    await moveTake(ctx, take, { ...rest, status: 'recording', failedRecordingId: recordingId, reopenedAt: new Date().toISOString() } satisfies TakeRecord)
  } catch (error) {
    console.error('[studio] offering a recording back failed:', error instanceof Error ? error.message : error)
  }
}

/** A sealed track as the worker reads it (blobs.ts readBlob): a link per piece, in order, each with its own length. */
export async function readLiveTrack(ctx: StudioContext, key: string, seconds = READ_LINK_SECONDS): Promise<BlobRead> {
  const parsed = parseLiveKey(key)
  if (!parsed) throw notFoundError('There is no file under that key.')
  const take = await getRecord<TakeRecord>(ctx, TAKES, parsed.takeId)
  const track = await getRecord<TrackRecord>(ctx, TRACKS, trackKey(parsed.takeId, parsed.role))
  if (!take || !track || !take.tracks[parsed.role]) throw notFoundError('There is no file under that key.')
  if (!track.sealed) throw conflictError('That recording is still being made.', 'NOT_SEALED')
  const { count, bytes } = track.sealed
  const paths = Array.from({ length: count }, (_, index) => blobObject(ctx.workspaceId, key, index))
  const urls: string[] = []
  for (let at = 0; at < paths.length; at += 500) urls.push(...(await storageOf(ctx).signRead(paths.slice(at, at + 500), seconds)))
  return {
    key,
    bytes,
    contentType: allowedType(typeForName(take.tracks[parsed.role]!.name)),
    sha256: null,
    parts: paths.map((_, index) => ({ index, bytes: track.pieces[index]!, url: urls[index]! })),
  }
}

/**
 * Remove a track: every piece storage lists under it and every piece its record declared (a listing can miss some),
 * then the space it held and its record; the take's record too once it has no track left. A listing that fails
 * throws before any record goes, so nothing is left in storage that no record points to. Acts for nobody in
 * particular (a finished recording, the sweep, a discard).
 */
export async function dropLiveTrack(ctx: StudioContext, key: string): Promise<void> {
  const parsed = parseLiveKey(key)
  if (!parsed) return
  const storage = storageOf(ctx)
  const track = await getRecord<TrackRecord>(ctx, TRACKS, trackKey(parsed.takeId, parsed.role))
  const names = new Set((await storage.list(`${ctx.workspaceId}/${key}`)).map((item) => item.name))
  for (let index = 0; index < (track?.n ?? 0); index++) names.add(String(index))
  await removeAll(storage, [...names].map((name) => `${ctx.workspaceId}/${key}/${name}`))
  must(await ctx.supabase.from('studio_record').delete().eq('workspace_id', ctx.workspaceId).eq('collection', PENDING).eq('key', key), 'remove the recording')
  await deleteRecord(ctx, TRACKS, trackKey(parsed.takeId, parsed.role))
  const left = must(
    await ctx.supabase.from('studio_record').select('key').eq('workspace_id', ctx.workspaceId).eq('collection', TRACKS).like('key', `${parsed.takeId}:%`).limit(1),
    'remove the recording',
  ) as { key: string }[] | null
  if (!left?.length) await deleteRecord(ctx, TAKES, parsed.takeId)
}

/** Remove every track of a take (and so the take), now. Only once no link of it can write any more (retireLiveTake). */
async function removeLiveTakeNow(ctx: StudioContext, take: Pick<TakeRecord, 'id' | 'tracks'>): Promise<void> {
  for (const role of LIVE_ROLES) if (take.tracks[role]) await dropLiveTrack(ctx, liveKey(take.id, role))
  await deleteRecord(ctx, TAKES, take.id)
}

/** When a link for a piece of this take was last signed (each signing writes its track). */
async function lastSigned(ctx: StudioContext, take: Pick<TakeRecord, 'id' | 'tracks' | 'createdAt'>): Promise<number> {
  const roles = LIVE_ROLES.filter((role) => take.tracks[role])
  const tracks = [...(await getRecords<TrackRecord>(ctx, TRACKS, roles.map((role) => trackKey(take.id, role)))).values()]
  // Each track is written when the take starts and at every signing: its newest write is the newest link.
  if (!tracks.length) return Date.parse(take.createdAt)
  return Math.max(...tracks.map((track) => Date.parse(track.updatedAt)))
}

/**
 * Throw a take's pieces away (a discard, a recording made of it, a take the sweep clears). When no link of it can
 * write any more (LINK_SAFE_MS since the last was signed), everything goes now. Otherwise the take is marked dropped:
 * no piece is signed, sealed or offered back, its space stays held and its pieces stay in storage, where a link still
 * good cannot store anything over them; the sweep removes them once the last link is LINK_SAFE_MS old.
 */
export async function retireLiveTake(ctx: StudioContext, take: TakeRecord, now = Date.now()): Promise<void> {
  // Only from the state it was read in: a take claimed for a recording meanwhile is not dropped under it.
  if (take.status !== 'dropped' && !(await moveTake(ctx, take, { ...take, status: 'dropped', droppedAt: new Date(now).toISOString() })))
    throw conflictError('This recording changed while it was being thrown away. Try again.', 'BUSY')
  if (now - (await lastSigned(ctx, take)) >= LINK_SAFE_MS) return removeLiveTakeNow(ctx, take)
  await holdOnlyWhatLinksCanWrite(ctx, take)
}

/**
 * A dropped take's held space, shrunk to what its links could still store. Links are signed without upsert, so a
 * stored piece can never grow: only a path signed and not yet written can take bytes, and the recorder signs piece n
 * only once piece n-1 is stored, so that is at most each track's last declared piece, up to LINK_WRITE_MAX. The rest
 * is released at once (the space a discard frees, or the space a recording made of it no longer needs twice).
 */
async function holdOnlyWhatLinksCanWrite(ctx: StudioContext, take: TakeRecord): Promise<void> {
  for (const role of LIVE_ROLES) {
    if (!take.tracks[role]) continue
    const track = await getRecord<TrackRecord>(ctx, TRACKS, trackKey(take.id, role))
    const key = liveKey(take.id, role)
    const open = !!track?.n && (await storageOf(ctx).size(blobObject(ctx.workspaceId, key, track.n - 1))) === null
    if (open) {
      must(
        await ctx.supabase.from('studio_record').upsert({
          workspace_id: ctx.workspaceId, collection: PENDING, key,
          value: { bytes: LINK_WRITE_MAX, partBytes: PIECE_MAX_BYTES, contentType: 'application/octet-stream', sha256: null, createdAt: new Date().toISOString(), token: 'live' } satisfies PendingWrite & { token: string },
          updated_at: new Date().toISOString(),
        }, { onConflict: 'workspace_id,collection,key' }),
        'save the recording',
      )
    } else must(await ctx.supabase.from('studio_record').delete().eq('workspace_id', ctx.workspaceId).eq('collection', PENDING).eq('key', key), 'save the recording')
  }
}

/** A take that stopped before it was finished, as the Record dialog offers it back. */
export type SavedTake = {
  id: string
  createdAt: string
  /** When its latest piece arrived. */
  savedAt: string
  /** How much of the screen was saved, in seconds. */
  seconds: number
  bytes: number
  tracks: { role: LiveRole; pieces: number; bytes: number; seconds: number }[]
}

/** How many of a track's declared pieces are surely in storage: all but the last, and the last when it is there at its length. */
async function storedRun(ctx: StudioContext, track: TrackRecord): Promise<number> {
  if (track.sealed) return track.sealed.count
  if (!track.n) return 0
  const size = await storageOf(ctx).size(blobObject(ctx.workspaceId, liveKey(track.takeId, track.role), track.n - 1)).catch(() => null)
  return size === track.pieces[track.n - 1] ? track.n : track.n - 1
}

const newestPiece = (take: TakeRecord, tracks: TrackRecord[]) => tracks.reduce((latest, track) => (track.updatedAt > latest ? track.updatedAt : latest), take.createdAt)

/**
 * The person's takes that stopped before they were finished (the window closed, the app or the machine crashed, or
 * their recording could not be made): still marked recording, with no piece for QUIET_MS, and something of the screen
 * saved. Newest first.
 */
export async function savedTakes(ctx: StudioContext, now = Date.now()): Promise<{ takes: SavedTake[] }> {
  const who = person(ctx)
  const rows = must(
    await ctx.supabase.from('studio_record').select('value').eq('workspace_id', ctx.workspaceId).eq('collection', TAKES).eq('value->>ownerId', who).eq('value->>status', 'recording')
      .order('updated_at', { ascending: false }).limit(50),
    'read your recordings',
  ) as { value: TakeRecord }[] | null
  const out: SavedTake[] = []
  for (const { value: take } of rows ?? []) {
    const roles = LIVE_ROLES.filter((role) => take.tracks[role])
    const tracks = await getRecords<TrackRecord>(ctx, TRACKS, roles.map((role) => trackKey(take.id, role)))
    const list = [...tracks.values()]
    const savedAt = newestPiece(take, list)
    if (now - Date.parse(savedAt) < QUIET_MS) continue
    const screen = tracks.get(trackKey(take.id, 'screen'))
    if (!screen?.n) continue
    const runs = await Promise.all(list.map(async (track) => ({ track, count: await storedRun(ctx, track) })))
    const screenRun = runs.find((run) => run.track.role === 'screen')!
    if (!screenRun.count) continue
    out.push({
      id: take.id,
      createdAt: take.createdAt,
      savedAt,
      seconds: Math.round(secondsAt(screen, screenRun.count) * 10) / 10,
      bytes: runs.reduce((sum, run) => sum + run.track.pieces.slice(0, run.count).reduce((a, b) => a + b, 0), 0),
      tracks: runs.map(({ track, count }) => ({ role: track.role, pieces: count, bytes: track.pieces.slice(0, count).reduce((a, b) => a + b, 0), seconds: Math.round(secondsAt(track, count) * 10) / 10 })),
    })
  }
  return { takes: out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
}

/**
 * The tracks of a take that stopped before it was finished, sealed from what arrived, ready for POST /recordings
 * (recordings.ts recoverTake builds on this). Only a take quiet for QUIET_MS (on this server's clock) is brought back:
 * one whose pieces still come is still recording somewhere. The screen is sealed first: with nothing of it, nothing
 * else is sealed (no recording can be made, and the take is left as it was). A camera or sound track that does not
 * open as a recording is left out, not the whole take.
 */
export async function sealStoppedTake(ctx: StudioContext, takeId: string, now = Date.now()): Promise<{ take: TakeRecord; tracks: SealedTrack[]; left: LiveRole[] }> {
  const take = await loadTake(ctx, takeId)
  if (take.status !== 'recording') throw conflictError('This recording was finished already.', 'TAKE_CLOSED')
  const roles = LIVE_ROLES.filter((role) => take.tracks[role])
  const records = [...(await getRecords<TrackRecord>(ctx, TRACKS, roles.map((role) => trackKey(take.id, role)))).values()]
  if (now - Date.parse(newestPiece(take, records)) < QUIET_MS)
    throw conflictError('This recording is still being made somewhere. Bring it back once it has stopped, in a minute or two.', 'STILL_RECORDING')
  const screen = await sealLiveTrack(ctx, liveKey(take.id, 'screen'))
  if (!screen) throw new StudioError('Nothing of the screen was saved, so there is no recording to bring back.')
  const tracks: SealedTrack[] = [screen]
  const left: LiveRole[] = []
  for (const role of roles) {
    if (role === 'screen') continue
    try {
      const sealed = await sealLiveTrack(ctx, liveKey(take.id, role))
      if (sealed) tracks.push(sealed)
    } catch (error) {
      if (!(error instanceof StudioError) || error.code !== 'NOT_MEDIA') throw error
      left.push(role)
    }
  }
  return { take, tracks, left }
}

/**
 * Throw a take away: every track's pieces, the space they held and the records. Only the person's own, and not while
 * its recording is being made (the worker may be reading it). A take whose recording is made has nothing left to throw.
 */
export async function discardLiveTake(ctx: StudioContext, takeId: string): Promise<{ ok: true }> {
  const take = await loadTake(ctx, takeId)
  if (take.status === 'finished') throw conflictError('This recording is being made into a video already.', 'TAKE_CLOSED')
  try {
    await retireLiveTake(ctx, take)
  } catch (error) {
    // Claimed for a recording between the read and the drop: it is being made into a video.
    if (error instanceof StudioError && error.code === 'BUSY' && (await getRecord<TakeRecord>(ctx, TAKES, take.id))?.status === 'finished')
      throw conflictError('This recording is being made into a video already.', 'TAKE_CLOSED')
    throw error
  }
  return { ok: true }
}

// ---- housekeeping (sweep.ts) ---------------------------------------------------------------------------------------

/** A workspace's context, acting for nobody (the sweep). */
const sweepContext = (base: Pick<StudioContext, 'supabase' | 'storage'>, workspaceId: string): StudioContext => ({ supabase: base.supabase, storage: base.storage, workspaceId, userId: null })

/**
 * What a take leaves behind, cleared within `budget` objects: tracks with no new piece (and no seal) for `keepMs`;
 * space held under a track that is gone; takes that stopped a day ago with nothing of the screen (nothing can be made
 * of them); and pieces in storage that no take points to (a link is good for two hours, so a PUT after a take was
 * removed stores its piece again). Answers how many tracks it removed and how much of the budget it used. A failure
 * on one is logged and skipped: the next run tries again.
 */
export async function sweepLiveTakes(base: Pick<StudioContext, 'supabase' | 'storage'>, options: { now: number; keepMs: number; budget: number }): Promise<{ removed: number; used: number }> {
  const before = (ms: number) => new Date(options.now - ms).toISOString()
  let left = options.budget
  let removed = 0
  const tryIt = async (what: string, work: () => Promise<void>) => {
    left--
    try {
      await work()
      return true
    } catch (error) {
      console.error(`[studio-sweep] couldn't remove ${what}:`, error instanceof Error ? error.message : error)
      return false
    }
  }
  // Takes dropped whose last link can no longer write: their pieces go now.
  if (left > 0) {
    const rows = must(
      await base.supabase.from('studio_record').select('workspace_id, value').eq('collection', TAKES).eq('value->>status', 'dropped').order('updated_at').limit(Math.min(left, 100)),
      'list dropped recordings',
    ) as { workspace_id: string; value: TakeRecord }[] | null
    for (const row of rows ?? []) {
      if (left <= 0) break
      const ctx = sweepContext(base, row.workspace_id)
      if (options.now - (await lastSigned(ctx, row.value).catch(() => options.now)) < LINK_SAFE_MS) continue
      if (await tryIt(`recording ${row.value.id}`, () => removeLiveTakeNow(ctx, row.value))) removed++
    }
  }
  // Takes made into a recording that ended, not yet settled (the settle after it failed, or never ran): settled now.
  // One still being made is put back an hour in the line.
  if (left > 0) {
    const rows = must(
      await base.supabase.from('studio_record').select('workspace_id, key, value').eq('collection', TAKES).eq('value->>status', 'finished').lt('updated_at', before(10 * 60_000)).order('updated_at').limit(Math.min(left, 100)),
      'list recordings being made',
    ) as { workspace_id: string; key: string; value: TakeRecord }[] | null
    for (const row of rows ?? []) {
      if (left <= 0) break
      left--
      const ctx = sweepContext(base, row.workspace_id)
      let state: 'settled' | 'waiting' = 'waiting'
      try {
        if (row.value.recordingId) state = await recordingSettled(ctx, row.value, options.now)
      } catch (error) {
        console.error(`[studio-sweep] couldn't settle recording ${row.key}:`, error instanceof Error ? error.message : error)
      }
      if (state === 'waiting')
        await base.supabase.from('studio_record').update({ updated_at: new Date(options.now).toISOString() }).eq('workspace_id', row.workspace_id).eq('collection', TAKES).eq('key', row.key)
    }
  }
  // Tracks left a week. A track whose take became a recording is settled first (made: the take is dropped; not made:
  // it is offered back), as the work after the worker's answer may have been lost: footage is never cleared while
  // its recording could still use it. A take offered back is kept a week from when it was. A track kept (or one that
  // could not be handled) is put back a day in the line, so a few that wait can never hold every other one up.
  if (left > 0) {
    const rows = must(
      await base.supabase.from('studio_record').select('workspace_id, key, value').eq('collection', TRACKS).lt('updated_at', before(options.keepMs)).order('updated_at').limit(Math.min(left, 100)),
      'list old recording tracks',
    ) as { workspace_id: string; key: string; value: TrackRecord }[] | null
    for (const row of rows ?? []) {
      if (left <= 0) break
      left--
      const ctx = sweepContext(base, row.workspace_id)
      let outcome: 'dropped' | 'kept' = 'kept'
      try {
        outcome = await oldTrack(ctx, row.value, options)
      } catch (error) {
        console.error(`[studio-sweep] couldn't remove recording track ${row.key}:`, error instanceof Error ? error.message : error)
      }
      if (outcome === 'dropped') removed++
      else
        await base.supabase.from('studio_record').update({ updated_at: new Date(options.now - options.keepMs + 24 * 3600_000).toISOString() })
          .eq('workspace_id', row.workspace_id).eq('collection', TRACKS).eq('key', row.key)
    }
  }
  // Space held for a track that is gone (a take thrown away while a piece was being signed).
  if (left > 0) {
    const rows = must(
      await base.supabase.from('studio_record').select('workspace_id, key').eq('collection', PENDING).like('key', 'live/%').lt('updated_at', before(3600_000)).order('updated_at').limit(Math.min(left, 500)),
      'list held space',
    ) as { workspace_id: string; key: string }[] | null
    for (const row of rows ?? []) {
      if (left <= 0) break
      const parsed = parseLiveKey(row.key)
      const ctx = sweepContext(base, row.workspace_id)
      await tryIt(`held space ${row.key}`, async () => {
        if (parsed && (await getRecord(ctx, TRACKS, trackKey(parsed.takeId, parsed.role)))) return
        must(await base.supabase.from('studio_record').delete().eq('workspace_id', row.workspace_id).eq('collection', PENDING).eq('key', row.key), 'remove held space')
      })
    }
  }
  // Takes that stopped a day ago with nothing of the screen: no recording can be made of them.
  if (left > 0) {
    const rows = must(
      await base.supabase.from('studio_record').select('workspace_id, value').eq('collection', TAKES).eq('value->>status', 'recording').lt('updated_at', before(24 * 3600_000)).order('updated_at').limit(Math.min(left, 100)),
      'list stopped recordings',
    ) as { workspace_id: string; value: TakeRecord }[] | null
    for (const row of rows ?? []) {
      if (left <= 0) break
      const ctx = sweepContext(base, row.workspace_id)
      const screen = await getRecord<TrackRecord>(ctx, TRACKS, trackKey(row.value.id, 'screen')).catch(() => undefined)
      if (screen === undefined || (screen && screen.n > 0) || options.now - Date.parse(screen?.updatedAt ?? row.value.createdAt) < 24 * 3600_000) continue
      if (await tryIt(`recording ${row.value.id}`, () => retireLiveTake(ctx, row.value, options.now))) removed++
    }
  }
  // Pieces no take points to: each workspace's live folders against its take records, a hundred at a time. A run
  // starts at a different workspace each hour, so all are reached however many there are; a workspace that cannot be
  // read is skipped (the next run tries again), never the rest.
  if (left > 0) {
    const storage = storageOf(sweepContext(base, ''))
    let workspaces: string[] = []
    try {
      workspaces = (await storage.folders('')).filter(isUuid).sort()
    } catch (error) {
      console.error("[studio-sweep] couldn't list the bucket:", error instanceof Error ? error.message : error)
    }
    const start = workspaces.length ? Math.floor(options.now / 3600_000) % workspaces.length : 0
    for (let i = 0; i < workspaces.length && left > 0; i++) {
      const workspaceId = workspaces[(start + i) % workspaces.length]!
      left--
      try {
        const ctx = sweepContext(base, workspaceId)
        const takeIds = (await storage.folders(`${workspaceId}/live`)).filter(isUuid)
        const orphans: string[] = []
        for (let at = 0; at < takeIds.length; at += 100) {
          const chunk = takeIds.slice(at, at + 100)
          const known = await getRecords(ctx, TAKES, chunk)
          orphans.push(...chunk.filter((id) => !known.has(id)))
        }
        for (const takeId of orphans) {
          if (left <= 0) break
          // Asked again one by one before anything goes: never a live take's pieces.
          if (await getRecord(ctx, TAKES, takeId)) continue
          const done = await tryIt(`pieces of ${takeId}`, async () => {
            for (const role of await storage.folders(`${workspaceId}/live/${takeId}`)) {
              const folder = `${workspaceId}/live/${takeId}/${role}`
              await removeAll(storage, (await storage.list(folder)).map((item) => `${folder}/${item.name}`))
            }
          })
          if (done) removed++
        }
      } catch (error) {
        console.error(`[studio-sweep] couldn't check the recordings of workspace ${workspaceId}; skipped:`, error instanceof Error ? error.message : error)
      }
    }
  }
  return { removed, used: options.budget - left }
}

/**
 * A track a week old: its take settled if it became a recording (recordingSettled), then the take dropped, unless its
 * recording is still being made or it was offered back less than `keepMs` ago. A track whose take is gone goes.
 */
async function oldTrack(ctx: StudioContext, track: TrackRecord, options: { now: number; keepMs: number }): Promise<'dropped' | 'kept'> {
  const take = await getRecord<TakeRecord>(ctx, TAKES, track.takeId)
  if (!take) {
    await dropLiveTrack(ctx, liveKey(track.takeId, track.role))
    return 'dropped'
  }
  if (take.status === 'finished' && take.recordingId && (await recordingSettled(ctx, take, options.now)) === 'waiting') return 'kept'
  const now = await getRecord<TakeRecord>(ctx, TAKES, track.takeId)
  if (!now) return 'dropped'
  if (now.status === 'finished') return 'kept'
  if (now.status === 'recording' && now.reopenedAt && options.now - Date.parse(now.reopenedAt) < options.keepMs) return 'kept'
  await retireLiveTake(ctx, now, options.now)
  return 'dropped'
}

/**
 * Settle a take that became a recording, after giving the recording the chance to finish (the worker's end of its
 * last import may never have been followed up): made, the take is dropped; not made (or its record never came to
 * be), the take is offered back. 'waiting' while the recording is still being made. The sweep runs this again on
 * every pass, so a settle that failed once (recordings.ts settleTake) is done here.
 */
async function recordingSettled(ctx: StudioContext, take: TakeRecord, now: number): Promise<'settled' | 'waiting'> {
  const recordings = await import('./recordings')
  const status = async () => (await getRecord<{ status: string }>(ctx, 'recordings', take.recordingId!))?.status
  let state = await status()
  if (state !== undefined && state !== 'done' && state !== 'failed') {
    await recordings.recordingImportEnded(ctx.supabase, ctx.storage, ctx.workspaceId, take.recordingId)
    state = await status()
  }
  if (state !== undefined && state !== 'done' && state !== 'failed') return 'waiting'
  const current = await getRecord<TakeRecord>(ctx, TAKES, take.id)
  if (!current || current.status !== 'finished' || current.recordingId !== take.recordingId) return 'settled'
  if (state === 'done') await retireLiveTake(ctx, current, now)
  else await reopenLiveTake(ctx, take.id, take.recordingId!)
  return 'settled'
}
