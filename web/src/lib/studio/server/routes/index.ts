// Every Studio route, in matching order (the first pattern that fits a path wins; literal paths come before the
// patterns that would also take them).
import type { StudioRoute } from '../router'
import { adsRoutes } from './ads'
import { blueprintRoutes } from './blueprint'
import { checkRoutes } from './checks'
import { fontRoutes } from './fonts'
import { libraryRoutes } from './library'
import { mediaRoutes } from './media'
import { costRoutes } from './costs'
import { generationRoutes } from './generation'
import { notYetRoutes } from './not-yet'
import { productRoutes } from './products'
import { projectRoutes } from './projects'
import { recordingRoutes } from './recordings'
import { sceneRoutes } from './scenes'
import { scriptRoutes } from './scripts'
import { soundRoutes } from './sound'
import { transcriptionRoutes } from './transcription'
import { videoRoutes } from './videos'
import { visionRoutes } from './vision'
import { voiceoverRoutes } from './voiceover'

// transcriptionRoutes holds `transcripts/transcribe` (one job per asset, none after "no speech"); mediaRoutes holds
// the other transcript routes. recordingRoutes comes before notYetRoutes: its `projects/:id/beats/:beat/take` answers.
export const studioRoutes: StudioRoute[] = [...videoRoutes, ...projectRoutes, ...scriptRoutes, ...fontRoutes, ...libraryRoutes, ...transcriptionRoutes, ...mediaRoutes, ...recordingRoutes, ...voiceoverRoutes, ...generationRoutes, ...costRoutes, ...visionRoutes, ...soundRoutes, ...checkRoutes, ...blueprintRoutes, ...sceneRoutes, ...adsRoutes, ...productRoutes, ...notYetRoutes]
