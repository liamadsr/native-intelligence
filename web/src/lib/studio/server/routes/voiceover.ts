// Routes for narration (../voiceover.ts).
//
//   GET  voiceover                        -> { voice | null, voiceName, voiceId, modelId, available }
//   GET  voiceover/voices[?refresh=1]     -> { voices, at }        the account's voices (kept an hour)
//   PUT  voiceover/voice {voiceId, name?, modelId?, settings?, substitutions?} -> { voice }
//   POST voiceover/preview {text}         -> { cached, characters, requestHash, voiceName, voiceId, modelId }
//   POST voiceover/generate {text, allowPaid, projectId?} -> VoiceoverResult (the editor's staged result)
//        allowPaid false never spends: an uncached request is refused (402).
import { route, type StudioRoute } from '../router'
import { generateNarration, listVoices, previewNarration, saveVoice, voiceoverInfo } from '../voiceover'

export const voiceoverRoutes: StudioRoute[] = [
  route('GET', 'voiceover', async ({ ctx }) => voiceoverInfo(ctx)),
  route('GET', 'voiceover/voices', async ({ ctx, url }) => listVoices(ctx, { refresh: url.searchParams.get('refresh') === '1' })),
  route('PUT', 'voiceover/voice', async ({ ctx, body }) => ({ voice: await saveVoice(ctx, await body()) })),
  route('POST', 'voiceover/preview', async ({ ctx, body }) => previewNarration(ctx, (await body()).text)),
  route('POST', 'voiceover/generate', async ({ ctx, body }) => generateNarration(ctx, await body())),
]
