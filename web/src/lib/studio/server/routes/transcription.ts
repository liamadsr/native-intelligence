// Routes for transcription (../transcription.ts). Transcription is a server job: there is nothing to set up, no
// model to download and no runtime to point at.
//
//   GET  transcription/config               -> { config: null, ready: true, serviceFee: 0 }
//   POST transcripts/transcribe {assetId, retry?} -> { job } | { transcript } | { outcome: 'no-speech' | 'no-audio' }
//        At most one job per asset at a time; none after "no speech" or "no audio" unless `retry` (the person asked).
import { route, type StudioRoute } from '../router'
import { requestTranscription, TRANSCRIPTION_INFO } from '../transcription'

export const transcriptionRoutes: StudioRoute[] = [
  route('GET', 'transcription/config', async () => TRANSCRIPTION_INFO),
  route('POST', 'transcripts/transcribe', async ({ ctx, body }) => {
    const b = await body()
    return requestTranscription(ctx, b.assetId, { retry: b.retry === true })
  }),
]
