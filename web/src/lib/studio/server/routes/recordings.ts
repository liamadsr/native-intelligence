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
//   POST   /live-takes/:id/pieces         {role, index, bytes, seconds?, offsetSeconds?} -> {index, url, headers}
//   POST   /live-takes/:id/recover[?wait=1] one of those made a video from what arrived -> {recording, project?, projectDigest?}
//   DELETE /live-takes/:id                throw a take away
import { discardLiveTake, livePiece, savedTakes, startLiveTake } from '../live-takes'
import { advanceRecording, listRecordings, recoverTake, startRecording, switchBeatTake } from '../recordings'
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
  route('POST', 'live-takes/:id/pieces', async ({ ctx, params, body }) => livePiece(ctx, params.id!, await body())),
  route('POST', 'live-takes/:id/recover', async ({ ctx, params, url }) => recoverTake(ctx, params.id!, waits(url) ? 100_000 : 0)),
  route('DELETE', 'live-takes/:id', async ({ ctx, params }) => discardLiveTake(ctx, params.id!)),
]
