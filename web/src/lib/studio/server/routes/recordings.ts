// Routes for recordings: a finished take's uploaded files become a video (or go into the video they were recorded
// for), and a storyboard beat can switch back to one of its earlier takes.
//
//   POST /recordings[?wait=1]           the take (recordings.ts says what it holds) -> {recording, project?, projectDigest?}
//   GET  /recordings/:id                where it stands, building the video once its imports are done
//   POST /projects/:id/beats/:beat/take {sessionId} -> {project, projectDigest}
import { advanceRecording, startRecording, switchBeatTake } from '../recordings'
import { route, type StudioRoute } from '../router'

const waits = (url: URL) => url.searchParams.get('wait') === '1' || url.searchParams.get('wait') === 'true'

export const recordingRoutes: StudioRoute[] = [
  // With ?wait=1 the answer waits up to ~100 s for the imports; otherwise it answers at once and the client polls.
  route('POST', 'recordings', async ({ ctx, body, url }) => startRecording(ctx, await body(), waits(url) ? 100_000 : 0)),
  route('GET', 'recordings/:id', async ({ ctx, params }) => advanceRecording(ctx, params.id!)),
  route('POST', 'projects/:id/beats/:beat/take', async ({ ctx, params, body }) => {
    const saved = await switchBeatTake(ctx, params.id!, params.beat!, (await body()).sessionId)
    return { project: saved.project, projectDigest: saved.projectDigest }
  }),
]
