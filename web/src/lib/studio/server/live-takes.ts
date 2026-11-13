// Takes uploaded while they are recorded. A browser take used to wait for Stop and then upload every file whole, so a
// crash or a closed window lost all of it and a long take kept the person waiting. Now each track of a take (screen,
// camera, microphone) goes to storage in pieces as the recorder makes them, a few seconds each:
//
//   POST   /live-takes                 {recorder, tracks:[{role, name}]}            -> {take}
//   POST   /live-takes/:id/pieces      {role, index, bytes, seconds?, offsetSeconds?} -> {index, url, headers}
//   GET    /live-takes                 the person's takes that stopped before they were finished (to bring back)
//   POST   /live-takes/:id/recover     one of those made a video from what arrived    -> RecordingAnswer
//   DELETE /live-takes/:id             thrown away: its pieces, its records, the space it held
//
// At Stop the take is handed to POST /recordings with its tracks as upload keys, `live/<take id>/<role>`; the track is
// sealed there (sealLiveTrack) and the worker reads it like any stored file: a link per piece, joined in order. Joined
// in order, the pieces are byte for byte what the recorder wrote (WebM from Chromium, fragmented MP4 from WebKit), so a
// track cut short by a crash is still a file that plays up to its last piece.
//
// The fences, as for every upload: only the person who started the take reaches it (any other answer is "not
// found"); only the person's own session, never a job (ctx.userId, the routes are on the person's door only); a piece
// is at most PIECE_MAX_BYTES and a track at most TRACK_MAX_BYTES, held against the workspace's space before its link
// is signed; pieces come in order, each declared with its length, and a track is sealed only from pieces that are in
// storage at exactly that length, in an unbroken run from the first; the first piece must open as a recording (WebM,
// Matroska, MP4 or Ogg), and the worker's import then checks the whole file.
//
// No migration: a take is two kinds of studio_record (TAKES, one per take; TRACKS, one per track, written by that
// track's uploads alone), and the space a track holds is a pending write under its key (blobs.ts PENDING), which
// studio_workspace_bytes already counts. Pieces live where a blob's parts do: `<workspace>/live/<take>/<role>/<n>`.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { blobObject, type BlobRead } from './job-contract'
import { deleteBlob, PENDING, READ_LINK_SECONDS, storageOf, workspaceByteLimit, workspaceBytes, type PendingWrite } from './blobs'
import { isUuid, must, type StudioContext } from './context'
import { conflictError, notFoundError, StudioError } from './errors'
import { allowedType, typeForName } from './media-types'
import { deleteRecord, getRecord, getRecords, putRecord } from './records'

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
/** A take is only recording while it is young: past this, one still "recording" was left behind. */
export const TAKE_MAX_AGE_MS = 3 * 3600_000
/** A take with no new piece for this long stopped: it is offered back, never while it may still be recording. */
export const QUIET_MS = 90_000
/** Space is held for a track this much at a time, so most pieces need no extra write. */
export const RESERVE_STEP = 64 * 1024 ** 2

export const TAKES = 'live-takes'
export const TRACKS = 'live-tracks'

export type TakeRecord = {
  id: string
  ownerId: string
  createdAt: string
  recorder: 'browser' | 'desktop'
  /** recording: pieces may still come. finished: handed to a recording (`recordingId`); no more pieces. */
  status: 'recording' | 'finished'
  tracks: Partial<Record<LiveRole, { name: string }>>
  recordingId?: string
}

export type TrackRecord = {
  takeId: string
  role: LiveRole
  /** How many pieces were declared (each piece's link is signed in order: the next one is piece `n`). */
  n: number
  /** Each declared piece's length, in order. */
  pieces: number[]
  bytes: number
  /** The space held for this track (a pending write under its key). */
  reserved: number
  /** Seconds after the screen's first frame this track's first frame was taken (0 for the screen; null until said). */
  offsetSeconds: number | null
  /** How many seconds the track had recorded at its latest piece. */
  seconds: number
  updatedAt: string
  /** Set once the track is handed to a recording: the unbroken run of pieces it is made of. */
  sealed?: { count: number; bytes: number; complete: boolean; at: string }
}

const trackKey = (takeId: string, role: LiveRole) => `${takeId}:${role}`

/** The person acting: a take is only ever the signed-in person's own, never a job's. */
function person(ctx: StudioContext): string {
  if (!ctx.userId) throw new StudioError('Only the person recording can send a recording.', 403, 'FORBIDDEN')
  return ctx.userId
}

/** The take, when it is this person's; anything else is not found (nothing says whose it is). */
async function loadTake(ctx: StudioContext, takeId: unknown): Promise<TakeRecord> {
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

const MEDIA_NAME = /\.(webm|mkv|mp4|m4a|mov|ogg)$/i

const StartSchema = z
  .object({
    recorder: z.enum(['browser', 'desktop']).default('browser'),
    tracks: z
      .array(
        z
          .object({
            role: z.enum(LIVE_ROLES),
            name: z.string().trim().min(1).max(240).refine((name) => !/[\\/\0]/.test(name), 'A file name has no folders').refine((name) => MEDIA_NAME.test(name), 'A recording is WebM, MP4, M4A or Ogg'),
          })
          .strict(),
      )
      .min(1)
      .max(LIVE_ROLES.length),
  })
  .strict()

/** What the recorder is told about its take. */
export type LiveTakeView = { id: string; keys: Partial<Record<LiveRole, string>>; pieceMaxBytes: number }

/** Start a take: its record and one record per track. The recorder then sends pieces as it makes them. */
export async function startLiveTake(ctx: StudioContext, body: unknown, now = Date.now()): Promise<{ take: LiveTakeView }> {
  const who = person(ctx)
  const input = StartSchema.parse(body)
  const roles = input.tracks.map((track) => track.role)
  if (new Set(roles).size !== roles.length) throw new StudioError('Each track of a recording is sent once.')
  if (!roles.includes('screen')) throw new StudioError('A recording has a screen track.')
  const open = must(
    await ctx.supabase.from('studio_record').select('value').eq('workspace_id', ctx.workspaceId).eq('collection', TAKES).eq('value->>ownerId', who).eq('value->>status', 'recording').limit(50),
    'start the recording',
  ) as { value: TakeRecord }[] | null
  const young = (open ?? []).filter((row) => now - Date.parse(row.value.createdAt) < TAKE_MAX_AGE_MS)
  if (young.length >= MAX_RECORDING_TAKES) throw new StudioError(`You already have ${MAX_RECORDING_TAKES} recordings going. Stop one first.`, 429, 'TOO_MANY_TAKES')
  const id = randomUUID()
  const at = new Date(now).toISOString()
  const take: TakeRecord = { id, ownerId: who, createdAt: at, recorder: input.recorder, status: 'recording', tracks: Object.fromEntries(input.tracks.map((track) => [track.role, { name: track.name }])) }
  for (const role of roles) {
    const track: TrackRecord = { takeId: id, role, n: 0, pieces: [], bytes: 0, reserved: 0, offsetSeconds: role === 'screen' ? 0 : null, seconds: 0, updatedAt: at }
    await putRecord(ctx, TRACKS, trackKey(id, role), track)
  }
  await putRecord(ctx, TAKES, id, take)
  return { take: { id, keys: Object.fromEntries(roles.map((role) => [role, liveKey(id, role)])), pieceMaxBytes: PIECE_MAX_BYTES } }
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
 * see the other.
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

/**
 * A link for the next piece of a track. Pieces come in order: piece `index` must be the next one, or the last one
 * again with the same length (its upload failed and is sent again). Its length is declared here and checked when the
 * track is sealed.
 */
export async function livePiece(ctx: StudioContext, takeId: string, body: unknown): Promise<{ index: number; url: string; headers: Record<string, string> }> {
  const take = await loadTake(ctx, takeId)
  const input = PieceSchema.parse(body)
  if (take.status !== 'recording') throw conflictError('This recording is finished: nothing more can be added to it.', 'TAKE_CLOSED')
  const track = await loadTrack(ctx, take, input.role)
  if (track.sealed) throw conflictError('This recording is finished: nothing more can be added to it.', 'TAKE_CLOSED')
  if (input.bytes > PIECE_MAX_BYTES) throw new StudioError(`A piece of a recording is at most ${readable(PIECE_MAX_BYTES)}.`, 413, 'TOO_LARGE')
  const key = liveKey(take.id, input.role)
  const storage = storageOf(ctx)
  const sign = async () => {
    const signed = await storage.signUpload(blobObject(ctx.workspaceId, key, input.index), 'application/octet-stream')
    return { index: input.index, url: signed.url, headers: signed.headers }
  }
  // The last piece again (its upload failed, or the answer was lost): the same piece, the same length.
  if (input.index === track.n - 1) {
    if (track.pieces[input.index] !== input.bytes) throw conflictError(`Piece ${input.index + 1} was sent already with another length.`, 'OUT_OF_ORDER')
    return sign()
  }
  if (input.index < track.n) throw conflictError(`Piece ${input.index + 1} was sent already.`, 'OUT_OF_ORDER')
  if (input.index > track.n) throw conflictError(`Piece ${track.n + 1} must be sent before piece ${input.index + 1}.`, 'OUT_OF_ORDER')
  if (track.n >= TRACK_MAX_PIECES) throw new StudioError('This recording has as many pieces as one can hold. Stop it and start another.', 413, 'TOO_LARGE')
  const bytes = track.bytes + input.bytes
  if (bytes > TRACK_MAX_BYTES) throw new StudioError(`A recording holds at most ${readable(TRACK_MAX_BYTES)} a track. Stop it and start another.`, 413, 'TOO_LARGE')
  let reserved = track.reserved
  if (bytes > reserved) {
    reserved = Math.min(TRACK_MAX_BYTES, Math.max(bytes, track.reserved + RESERVE_STEP))
    await holdTrackSpace(ctx, key, track.reserved, reserved, allowedType(typeForName(take.tracks[input.role]!.name)))
  }
  const at = new Date().toISOString()
  const next: TrackRecord = {
    ...track,
    n: track.n + 1,
    pieces: [...track.pieces, input.bytes],
    bytes,
    reserved,
    seconds: Math.max(track.seconds, input.seconds ?? 0),
    offsetSeconds: input.role === 'screen' ? 0 : (input.offsetSeconds ?? track.offsetSeconds),
    updatedAt: at,
  }
  // Only the writer that read this very count moves it on: a second request for the same piece gets a conflict.
  const moved = must(
    await ctx.supabase.from('studio_record').update({ value: next, updated_at: at })
      .eq('workspace_id', ctx.workspaceId).eq('collection', TRACKS).eq('key', trackKey(take.id, input.role)).eq('value->>n', String(track.n))
      .select('key'),
    'save the recording',
  ) as { key: string }[] | null
  if (!moved?.length) throw conflictError('Another upload of this recording got there first. Try again.', 'BUSY')
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

export type SealedTrack = { key: string; role: LiveRole; name: string; bytes: number; count: number; complete: boolean; seconds: number; offsetSeconds: number | null }

const sealedView = (key: string, take: TakeRecord, track: TrackRecord): SealedTrack => ({
  key,
  role: track.role,
  name: take.tracks[track.role]!.name,
  bytes: track.sealed!.bytes,
  count: track.sealed!.count,
  complete: track.sealed!.complete,
  seconds: track.seconds,
  offsetSeconds: track.offsetSeconds,
})

/**
 * Seal a track for a recording: the unbroken run of pieces from the first that are in storage at their declared
 * length. With `stated` (the recorder says how many it sent, or 'all' it declared) all of them must be there (409 UPLOAD_INCOMPLETE
 * otherwise, so the recorder sends the missing one again); without it (a take brought back after a crash) the run
 * that arrived is the track, and null when nothing did. `cut`: the recorder stopped sending before the recording's
 * end (the Studio refused the rest), so its last piece may end mid-frame, as a crashed take's. The first piece must open as a recording. Sealing twice
 * answers the first seal.
 */
export async function sealLiveTrack(ctx: StudioContext, key: string, stated?: number | 'all', options: { cut?: boolean } = {}): Promise<SealedTrack | null> {
  const parsed = parseLiveKey(key)
  if (!parsed) throw new StudioError('That is not a recording track.')
  const take = await loadTake(ctx, parsed.takeId)
  const track = await loadTrack(ctx, take, parsed.role)
  if (track.sealed) return sealedView(key, take, track)
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
  const sealed: TrackRecord = { ...track, sealed: { count, bytes, complete: expected !== undefined && !options.cut, at }, updatedAt: at }
  await putRecord(ctx, TRACKS, trackKey(take.id, parsed.role), sealed)
  // The space held shrinks to what the track is (until the worker has imported it and it goes).
  must(
    await ctx.supabase.from('studio_record').update({ value: { bytes, partBytes: PIECE_MAX_BYTES, contentType: allowedType(typeForName(take.tracks[parsed.role]!.name)), sha256: null, createdAt: at, token: 'live' } satisfies PendingWrite, updated_at: at })
      .eq('workspace_id', ctx.workspaceId).eq('collection', PENDING).eq('key', key),
    'save the recording',
  )
  return sealedView(key, take, sealed)
}

/** The take is a recording now: no more pieces. */
export async function closeLiveTake(ctx: StudioContext, takeId: string, recordingId: string): Promise<void> {
  const take = await loadTake(ctx, takeId)
  if (take.status === 'finished' && take.recordingId === recordingId) return
  await putRecord(ctx, TAKES, take.id, { ...take, status: 'finished', recordingId } satisfies TakeRecord)
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
 * Remove a track: its pieces, the space it held and its record; the take's record too once it has no track left.
 * Missing is fine. Acts for nobody in particular (the worker's finished import, the sweep, a discard).
 */
export async function dropLiveTrack(ctx: StudioContext, key: string): Promise<void> {
  const parsed = parseLiveKey(key)
  if (!parsed) return
  await deleteBlob(ctx, key)
  await deleteRecord(ctx, TRACKS, trackKey(parsed.takeId, parsed.role))
  const left = must(
    await ctx.supabase.from('studio_record').select('key').eq('workspace_id', ctx.workspaceId).eq('collection', TRACKS).like('key', `${parsed.takeId}:%`).limit(1),
    'remove the recording',
  ) as { key: string }[] | null
  if (!left?.length) await deleteRecord(ctx, TAKES, parsed.takeId)
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

/**
 * The person's takes that stopped before they were finished (the window closed, the app or the machine crashed):
 * still marked recording, with no piece for QUIET_MS, and something of the screen saved. Newest first.
 */
export async function savedTakes(ctx: StudioContext, now = Date.now()): Promise<{ takes: SavedTake[] }> {
  const who = person(ctx)
  const rows = must(
    await ctx.supabase.from('studio_record').select('value').eq('workspace_id', ctx.workspaceId).eq('collection', TAKES).eq('value->>ownerId', who).eq('value->>status', 'recording').limit(50),
    'read your recordings',
  ) as { value: TakeRecord }[] | null
  const out: SavedTake[] = []
  for (const { value: take } of rows ?? []) {
    const roles = LIVE_ROLES.filter((role) => take.tracks[role])
    const tracks = await getRecords<TrackRecord>(ctx, TRACKS, roles.map((role) => trackKey(take.id, role)))
    const list = [...tracks.values()]
    const savedAt = list.reduce((latest, track) => (track.updatedAt > latest ? track.updatedAt : latest), take.createdAt)
    if (now - Date.parse(savedAt) < QUIET_MS) continue
    const screen = tracks.get(trackKey(take.id, 'screen'))
    if (!screen?.n) continue
    out.push({
      id: take.id,
      createdAt: take.createdAt,
      savedAt,
      seconds: Math.round(screen.seconds * 10) / 10,
      bytes: list.reduce((sum, track) => sum + track.bytes, 0),
      tracks: list.map((track) => ({ role: track.role, pieces: track.n, bytes: track.bytes, seconds: Math.round(track.seconds * 10) / 10 })),
    })
  }
  return { takes: out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
}

/**
 * The tracks of a take that stopped before it was finished, sealed from what arrived, ready for POST /recordings
 * (recordings.ts recoverTake builds on this). Throws when nothing of the screen was saved.
 */
export async function sealStoppedTake(ctx: StudioContext, takeId: string): Promise<{ take: TakeRecord; tracks: SealedTrack[] }> {
  const take = await loadTake(ctx, takeId)
  if (take.status !== 'recording') throw conflictError('This recording was finished already.', 'TAKE_CLOSED')
  const tracks: SealedTrack[] = []
  for (const role of LIVE_ROLES) {
    if (!take.tracks[role]) continue
    const sealed = await sealLiveTrack(ctx, liveKey(take.id, role))
    if (sealed) tracks.push(sealed)
  }
  if (!tracks.some((track) => track.role === 'screen')) throw new StudioError('Nothing of the screen was saved, so there is no recording to bring back.')
  return { take, tracks }
}

/** Throw a take away: every track's pieces, the space they held and the records. Only the person's own. */
export async function discardLiveTake(ctx: StudioContext, takeId: string): Promise<{ ok: true }> {
  const take = await loadTake(ctx, takeId)
  // A finished take is a recording on its way to a video: the worker may be reading it.
  if (take.status === 'finished') throw conflictError('This recording is being made into a video already.', 'TAKE_CLOSED')
  for (const role of LIVE_ROLES) if (take.tracks[role]) await dropLiveTrack(ctx, liveKey(take.id, role))
  await deleteRecord(ctx, TAKES, take.id)
  return { ok: true }
}
