/**
 * The app's code the worker runs: the job contract and the engine's schemas and
 * format helpers, from web/src/lib/studio/ (the same files the app runs, never a
 * copy). Types are imported directly elsewhere; values come through here.
 *
 * Why `require`: web/ is not an ES module package, so tsx compiles its .ts files
 * as CommonJS, and Node cannot see the named exports of that output from an
 * `import`. Requiring them hands back the whole exports object.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const contract = require('../../web/src/lib/studio/server/job-contract.ts') as typeof import('../../web/src/lib/studio/server/job-contract.ts')
const contracts = require('../../web/src/lib/studio/engine/contracts.ts') as typeof import('../../web/src/lib/studio/engine/contracts.ts')
const formats = require('../../web/src/lib/studio/engine/formats.ts') as typeof import('../../web/src/lib/studio/engine/formats.ts')
const quality = require('../../web/src/lib/studio/engine/generation-quality.ts') as typeof import('../../web/src/lib/studio/engine/generation-quality.ts')
const ads = require('../../web/src/lib/studio/server/ads-contract.ts') as typeof import('../../web/src/lib/studio/server/ads-contract.ts')
const sceneBuild = require('../../web/src/lib/studio/engine/scene-frame/build.ts') as typeof import('../../web/src/lib/studio/engine/scene-frame/build.ts')

export const { STUDIO_JOB_KINDS, LIVE_JOB_KINDS, STUDIO_PART_BYTES, blobParts, ClaimBody, ProgressBody, CompleteBody, FailBody, BlobReadBody, BlobWriteBody, BlobCommitBody, LivePiecesBody } = contract
export const { EditorAssetSchema, TranscriptSchema, parseEditorProject, defaultCaptions, defaultPresentation } = contracts
export const { deliveredProject } = formats
export const { applyQualityTier } = quality
// The code scene frame's runtime, built into each render bundle (render.ts, scenes.ts).
export const { buildSceneRuntime, RUNTIME_PATH } = sceneBuild
// The ads' schemas and grammars: a kit, a batch, a brief or a reel is checked again here before anything is drawn
// (the app is not the only writer of job inputs), with the same rules the app checked it with.
export const { BrandKitSchema, StaticBatchSchema, MotionBriefSchema, ReelSpecSchema, FontFamilySchema, isPaint, parseAudioFilters, patternProblem, GRADE_NAME, FONT_FAMILY, REEL_MAX_SECONDS, reelSeconds } = ads
