// Routes for scripts (one per video; its id is the video's id).
import { route, type StudioRoute } from '../router'
import { getScript, listScripts, saveScript } from '../scripts'
import { scriptFromDocument, scriptToDocument } from '../script-documents'

export const scriptRoutes: StudioRoute[] = [
  route('GET', 'scripts', async ({ ctx }) => ({ scripts: await listScripts(ctx) })),
  route('GET', 'scripts/:id', async ({ ctx, params }) => ({ script: await getScript(ctx, params.id!) })),
  route('POST', 'scripts/:id', async ({ ctx, params, body }) => ({ script: await saveScript(ctx, params.id!, await body()) })),
  // A video's script from a document the person may read ({ documentId }), and its script as a new linked document.
  route('POST', 'scripts/:id/from-document', async ({ ctx, params, body }) => scriptFromDocument(ctx, params.id!, (await body()).documentId)),
  route('POST', 'scripts/:id/to-document', async ({ ctx, params }) => scriptToDocument(ctx, params.id!)),
]
