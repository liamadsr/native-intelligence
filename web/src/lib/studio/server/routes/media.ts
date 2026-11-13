// Routes for media: uploads, imports (file, camera recording, slide deck), the library, slide decks, transcripts
// (importing and attaching one; transcribing is routes/transcription.ts), export and jobs. `?wait=1` on an import
// waits for its job (up to about 110 s) and answers what the editor's old
// one-call import answered; otherwise, or when the job is still running, it answers {job} to poll.
import { attachTranscript, importTimedTranscript, listAssets } from '../assets'
import { videoExports } from '../jobs'
import { mintFileLink } from '../download-links'
import { importPresenter, importSlides, importUpload, jobStatus, listSlideDecks, startExport, startUpload, stopJob } from '../media'
import { route, type StudioRoute } from '../router'

const waits = (url: URL) => url.searchParams.get('wait') === '1' || url.searchParams.get('wait') === 'true'

export const mediaRoutes: StudioRoute[] = [
  route('POST', 'uploads', async ({ ctx, body }) => startUpload(ctx, await body())),
  route('POST', 'import', async ({ ctx, body, url, request }) => importUpload(ctx, await body(), { wait: waits(url), signal: request.signal })),
  route('POST', 'presenter/import', async ({ ctx, body, url, request }) => importPresenter(ctx, await body(), { wait: waits(url), signal: request.signal })),
  route('POST', 'slides/import', async ({ ctx, body, url, request }) => importSlides(ctx, await body(), { wait: waits(url), signal: request.signal })),
  route('GET', 'slides', async ({ ctx }) => ({ decks: await listSlideDecks(ctx) })),
  route('GET', 'assets', async ({ ctx }) => ({ assets: await listAssets(ctx) })),

  route('POST', 'transcripts/import', async ({ ctx, body }) => {
    const b = await body()
    return { transcript: await importTimedTranscript(ctx, b.assetId, b.document) }
  }),
  // A transcript already registered for the asset; null tells the editor there is nothing to attach.
  route('POST', 'transcripts/attach', async ({ ctx, body }) => ({ transcript: await attachTranscript(ctx, (await body()).assetId) })),

  route('POST', 'export', async ({ ctx, body }) => startExport(ctx, (await body()).project)),
  route('GET', 'jobs/:id', async ({ ctx, params }) => jobStatus(ctx, params.id!)),
  route('POST', 'jobs/:id/cancel', async ({ ctx, params }) => stopJob(ctx, params.id!)),
  // A short-lived link that downloads a stored file without a session (download-links.ts): {key, name}.
  route('POST', 'file-links', async ({ ctx, body }) => mintFileLink(ctx, await body())),
  // A video's finished exports still kept, newest first (the Export dialog's list).
  route('GET', 'projects/:id/exports', async ({ ctx, params }) => videoExports(ctx, params.id!)),
]
