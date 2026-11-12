// Routes for fonts (../fonts.ts).
//
//   GET  fonts[?q=][&families=A|B]  -> { installed, faces, results? }
//        `q` searches Fontshare and Google Fonts (the shelf first). `families` names the families the open video
//        uses: any not installed yet (and the five defaults) start installing in the background, and the editor
//        polls until their faces are listed.
//   POST fonts/install {family}     -> { font, faces }
//
// A face's `file` is its key in the workspace's storage (the player reads it through the asset base, the workspace's
// file route); `src` is that address in full.
import { ensureFontsInBackground, facesOf, installFont, installedFonts, parseFamilies, searchFonts, servedFaces } from '../fonts'
import { route, type StudioRoute } from '../router'

export const fontRoutes: StudioRoute[] = [
  route('GET', 'fonts', async ({ ctx, url }) => {
    const q = url.searchParams.get('q')
    const families = parseFamilies(url.searchParams.get('families'))
    const installed = await installedFonts(ctx)
    if (url.searchParams.has('families')) ensureFontsInBackground(ctx, families)
    return {
      installed,
      faces: servedFaces(ctx.workspaceId, facesOf(installed)),
      ...(q !== null ? { results: await searchFonts(q.slice(0, 200)) } : {}),
    }
  }),
  route('POST', 'fonts/install', async ({ ctx, body }) => {
    const font = await installFont(ctx, (await body()).family)
    return { font, faces: servedFaces(ctx.workspaceId, facesOf(await installedFonts(ctx))) }
  }),
]
