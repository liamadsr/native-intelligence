// Routes for sound design (../sound.ts), in the shapes the editor's sound menu and the local product's agent used.
//
//   GET  sounds[?refresh=1]                         -> { available, version?, at?, sounds, presets }   the bank (kept a week)
//   POST projects/:id/sound-pass {preset?, from?, to?, clicks?, captions?}                            -> { job }
//   POST projects/:id/sounds {sounds: [{at, kind | sound, …}], preset?, replace?}                     -> { job }
//   POST projects/:id/sounds/import {assetId | uploadKey + name, at, align?, offsetMs?, levelDb?, label?,
//        track?: sfx | music, fadeOut?, from?}                                                         -> { job }
//   POST projects/:id/listen {checks?}                                                                 -> { job }
//   GET  listen/:job/sheet.png                     the annotated sheet a finished listen job stored
//   POST sounds/judge {action, assetIds?, sounds?, description?, alts?, targetAssetId? | targetSound?, start?, end?,
//        category?, top?}                                                                               -> { job }
//   POST sounds/make {description, kind?, count?, alts?} | {fromAssetId, description?}                   -> { job }
//
// Each job is polled at jobs/:id; when it finishes, its result is applied to the video by the app.
import { route, type StudioRoute } from '../router'
import { listenSheet, soundBank, startAddSounds, startImportSound, startListen, startSoundPass } from '../sound'
import { startJudgeSound, startMakeSound } from '../sound-judge'

export const soundRoutes: StudioRoute[] = [
  route('GET', 'sounds', async ({ ctx, url }) => soundBank(ctx, { refresh: url.searchParams.get('refresh') === '1' })),
  route('POST', 'projects/:id/sound-pass', async ({ ctx, params, body }) => startSoundPass(ctx, params.id!, await body())),
  route('POST', 'projects/:id/sounds/import', async ({ ctx, params, body }) => startImportSound(ctx, params.id!, await body())),
  route('POST', 'projects/:id/sounds', async ({ ctx, params, body }) => startAddSounds(ctx, params.id!, await body())),
  route('POST', 'projects/:id/listen', async ({ ctx, params, body }) => startListen(ctx, params.id!, await body())),
  route('GET', 'listen/:job/sheet.png', async ({ ctx, params, request }) => listenSheet(ctx, params.job!, request)),
  route('POST', 'sounds/judge', async ({ ctx, body }) => startJudgeSound(ctx, await body())),
  route('POST', 'sounds/make', async ({ ctx, body }) => startMakeSound(ctx, await body())),
]
