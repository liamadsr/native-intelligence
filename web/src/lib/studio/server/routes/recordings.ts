// Routes for recordings: a finished take's uploaded files become a video (or go into the video they were recorded
// for), and a storyboard beat can switch back to one of its earlier takes. A take is uploaded while it is recorded,
// in pieces (live-takes.ts), so a crash loses only its last seconds and Stop has nothing big left to send.
//
//   POST   /recordings[?wait=1]           the take (recordings.ts says what it holds) -> {recording, project?, projectDigest?}
//   GET    /recordings                    the person's recordings of the last day, those being prepared with their progress
//   GET    /recordings/:id                where it stands, building the video once its imports are done
//   POST   /projects/:id/beats/:beat/take {sessionId} -> {project, projectDigest}
//
//   POST   /live-takes                    {recorder, tracks:[{role, name}]} -> {take: {id, keys, pieceMaxBytes}}
//   GET    /live-takes                    the person's takes that stopped before they were finished -> {takes}
//   GET    /live-takes/:id                where one of the person's takes stands, track by track -> {take}
//   POST   /live-takes/:id/pieces         {role, index, bytes, seconds?, offsetSeconds?} -> {index, url, headers}
//   POST   /live-takes/:id/recover[?wait=1] {projectId?, sha256?} one of those made a video from what arrived -> {recording, project?, projectDigest?}
//   POST   /live-takes/:id/whole          {role, uploadKey} a track the Studio stopped taking pieces of, uploaded whole, bound to the take
//   POST   /recordings/:id/tracks         {role, uploadKey, sha256?} a track the recording lost, sent again -> {recording}
//   POST   /recordings/:id/words          {words} the words the Mac heard, arriving after the take -> {recording}
//   DELETE /live-takes/:id                throw a take away
import { bindWholeUpload, discardLiveTake, livePiece, liveTakeState, savedTakes, startLiveTake } from '../live-takes'
import { addRecordingWords, advanceRecording, attachTrack, listRecordings, recoverTake, startRecording, switchBeatTake } from '../recordings'
import { isUuid } from '../context'
import { route, type StudioRoute } from '../router'

const waits = (url: URL) => url.searchParams.get('wait') === '1' || url.searchParams.get('wait') === 'true'

export const recordingRoutes: StudioRoute[] = [
  // With ?wait=1 the answer waits up to ~100 s for the imports; otherwise it answers at once and the client polls.
  route('POST', 'recordings', async ({ ctx, body, url }) => startRecording(ctx, await body(), waits(url) ? 100_000 : 0)),
  route('GET', 'recordings', async ({ ctx }) => listRecordings(ctx)),
  route('GET', 'recordings/:id', async ({ ctx, params }) => advanceRecording(ctx, params.id!)),
  route('POST', 'projects/:id/beats/:beat/take', async ({ ctx, params, body }) => {
    const saved = await switchBeatTake(ctx, params.id!, params.beat!, (await body()).sessionId)
    return { project: saved.project, projectDigest: saved.projectDigest }
  }),
  route('POST', 'live-takes', async ({ ctx, body }) => startLiveTake(ctx, await body())),
  route('GET', 'live-takes', async ({ ctx }) => savedTakes(ctx)),
  route('GET', 'live-takes/:id', async ({ ctx, params }) => liveTakeState(ctx, params.id!)),
  route('POST', 'live-takes/:id/pieces', async ({ ctx, params, body }) => livePiece(ctx, params.id!, await body())),
  route('POST', 'live-takes/:id/recover', async ({ ctx, params, url, body }) => {
    // The Mac app names the video its draft of the take already opened as (recordings.ts RecordingInput.projectId), and
    // its own hash of each file it sent whole (only ever a refusal).
    const asked = ((await body().catch(() => ({}))) ?? {}) as { projectId?: unknown; sha256?: unknown }
    const projectId = typeof asked.projectId === 'string' && isUuid(asked.projectId) ? asked.projectId : undefined
    const sha256 = Object.fromEntries(Object.entries(asked.sha256 && typeof asked.sha256 === 'object' ? asked.sha256 : {})
      .filter(([role, value]) => ['screen', 'camera', 'microphone', 'systemAudio'].includes(role) && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))
    return recoverTake(ctx, params.id!, waits(url) ? 100_000 : 0, Date.now(), projectId, sha256)
  }),
  route('POST', 'live-takes/:id/whole', async ({ ctx, params, body }) => bindWholeUpload(ctx, params.id!, await body())),
  route('POST', 'recordings/:id/tracks', async ({ ctx, params, body }) => attachTrack(ctx, params.id!, await body())),
  route('POST', 'recordings/:id/words', async ({ ctx, params, body }) => addRecordingWords(ctx, params.id!, await body())),
  route('DELETE', 'live-takes/:id', async ({ ctx, params }) => discardLiveTake(ctx, params.id!)),
]
