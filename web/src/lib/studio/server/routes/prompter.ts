// Routes for the recording prompter's script and checklist (prompter.ts): `mine` (the person's own new takes) or a
// video's id (takes recorded into it).
import { route, type StudioRoute } from '../router'
import { getPrompter, savePrompter } from '../prompter'

export const prompterRoutes: StudioRoute[] = [
  route('GET', 'prompter/:key', async ({ ctx, params }) => ({ prompter: await getPrompter(ctx, params.key!) })),
  route('PUT', 'prompter/:key', async ({ ctx, params, body }) => ({ prompter: await savePrompter(ctx, params.key!, await body()) })),
]
