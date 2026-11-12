// What the editor asks for that the Studio cannot do here yet. Each answer has the shape the editor reads, so no
// screen breaks: an empty list, "not ready", or for an action a plain sentence
// (501) the editor shows where it shows errors. Each is its own small function, named after the route it stands
// in for, to be replaced one by one as the capability arrives (the Mac recorder, product kits). The editor has no
// agent of its own: the agent in the app's chat edits videos with the Studio tools, so it has no routes here.
// Voiceover, generated shots, continuity and costs moved to voiceover.ts, generation.ts and costs.ts; cut-outs and
// the director pass to vision.ts; sound design to sound.ts; the motion check and the review to checks.ts; reference
// blueprints to blueprint.ts.
import { notYetError } from '../errors'
import { route, type StudioHandler, type StudioRoute } from '../router'

const unavailable = (what: string): StudioHandler => async () => {
  throw notYetError(what)
}

// ---- recording from this Mac (screen, camera, microphone, slides window, teleprompter) -----------------------

const RECORDING = "Recording isn't available in the web app yet. Import a recording instead."
/** GET /manual/targets: windows that could be recorded. */
const manualTargets: StudioHandler = async () => ({ native: [], desktopProfiles: [], webProfiles: [] })
/** GET /manual/devices: cameras and microphones. */
const manualDevices: StudioHandler = async () => ({ microphones: [], cameras: [], error: "Recording devices aren't available in the web app yet." })
/** GET /manual/permissions: the Mac's recording permissions. All granted, so no banner asks for them. */
const manualPermissions: StudioHandler = async () => ({ screenRecording: true, accessibility: true, camera: 'granted', microphone: 'granted' })
/** GET /manual/sessions: recordings made here. */
const manualSessions: StudioHandler = async () => ({ sessions: [] })

// ---- app profiles (apps set up for recording) -----------------------------------------------------------------

/** GET /app-profiles: saved apps. */
const appProfiles: StudioHandler = async () => ({ profiles: [] })
const APPS = "Setting up apps for recording isn't available in the web app yet."

// ---- product kits, style guides ------------------------------------------------------------------------------

/** GET /kits: attached product repositories. */
const kits: StudioHandler = async () => ({ kits: [] })
/** GET /brands: style guides read from products. */
const brands: StudioHandler = async () => ({ brands: [] })
/** GET /kits/:k/brand: a product's style guide. */
const kitBrand: StudioHandler = async () => ({ brand: null })
/** GET /kits/:k/onboard: a product's onboarding. */
const kitOnboard: StudioHandler = async () => ({ onboarding: null })
/** GET /kits/:k/source: where a product's code comes from. */
const kitSource: StudioHandler = async () => ({ source: { ref: 'main', mode: 'branch' }, branches: [] })
/** GET /kits/:k/catalog: a product's components and its stage. */
const kitCatalog: StudioHandler = async () => ({ components: [], stage: { built: false, fresh: false }, health: null, checking: false, stageUrl: null })
const KITS = "Product components aren't available in the web app yet."

// ---- generated shots, takes ----------------------------------------------------------------------------------

const TAKES = 'Recorded takes come from the Mac recorder, which isn’t available in the web app yet.'

// ---- product components on a video ----------------------------------------------------------------

/** GET /projects/:id/components/status: component layers whose product code changed. */
const componentsStatus: StudioHandler = async () => ({ stale: [] })
const COMPONENTS = "Product components aren't available in the web app yet."

// ---- playback measurements -----------------------------------------------------------------------------------------

/** POST /perf: frame pacing reports (not kept). */
const perf: StudioHandler = async () => ({ ok: true })
/** GET /perf: kept reports. */
const perfReports: StudioHandler = async () => ({ reports: [], config: { throttle: true } })
/** GET and POST /perf-config: playback switches. */
const perfConfig: StudioHandler = async () => ({ throttle: true })

export const notYetRoutes: StudioRoute[] = [
  route('GET', 'manual/targets', manualTargets),
  route('GET', 'manual/devices', manualDevices),
  route('GET', 'manual/permissions', manualPermissions),
  route('POST', 'manual/permissions', unavailable(RECORDING)),
  route('GET', 'manual/sessions', manualSessions),
  route('POST', 'manual/sessions', unavailable(RECORDING)),
  route('GET', 'manual/sessions/:id', unavailable(RECORDING)),
  route('POST', 'manual/sessions/:id/:action', unavailable(RECORDING)),

  route('GET', 'app-profiles', appProfiles),
  route('POST', 'app-profiles', unavailable(APPS)),
  route('POST', 'app-profiles/browse', unavailable(APPS)),
  route('POST', 'app-profiles/inspect', unavailable(APPS)),
  route('GET', 'app-profiles/:id', unavailable(APPS)),
  route('PUT', 'app-profiles/:id', unavailable(APPS)),
  route('POST', 'app-profiles/:id/validate', unavailable(APPS)),

  route('GET', 'kits', kits),
  route('POST', 'kits/attach', unavailable(KITS)),
  route('GET', 'brands', brands),
  route('GET', 'kits/:kit/brand', kitBrand),
  route('POST', 'kits/:kit/brand', unavailable(KITS)),
  route('POST', 'kits/:kit/brand/derive', unavailable(KITS)),
  route('GET', 'kits/:kit/brand/shot/:name', unavailable(KITS)),
  route('GET', 'kits/:kit/onboard', kitOnboard),
  route('POST', 'kits/:kit/onboard', unavailable(KITS)),
  route('GET', 'kits/:kit/source', kitSource),
  route('POST', 'kits/:kit/source', unavailable(KITS)),
  route('POST', 'kits/:kit/source/refresh', unavailable(KITS)),
  route('GET', 'kits/:kit/catalog', kitCatalog),
  route('POST', 'kits/:kit/stage', unavailable(KITS)),
  route('GET', 'kits/:kit/stage/:file', unavailable(KITS)),

  route('POST', 'projects/:id/beats/:beat/take', unavailable(TAKES)),

  route('GET', 'projects/:id/components/status', componentsStatus),
  route('POST', 'projects/:id/components', unavailable(COMPONENTS)),
  route('POST', 'projects/:id/components/refresh', unavailable(COMPONENTS)),

  route('POST', 'perf', perf),
  route('GET', 'perf', perfReports),
  route('GET', 'perf-config', perfConfig),
  route('POST', 'perf-config', perfConfig),

  route('POST', 'projects/:id/scenes', unavailable("Code scenes aren't available yet.")),
  route('GET', 'scenes/:id', unavailable("Code scenes aren't available yet.")),
  route('POST', 'projects/from-motion', unavailable("Importing motion ads isn't available yet.")),
]
