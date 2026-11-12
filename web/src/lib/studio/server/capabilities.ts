// What the Studio can do beyond editing right now, as the Studio worker says it. The worker knows what it holds (an
// ElevenLabs key, the higgsfield tool installed and signed in) and names it every time it asks for work or reports
// progress (job-contract.ts: `capabilities` on the claim and progress bodies). The app keeps the latest word of each
// worker in this process for about a minute, so a stopped worker's capabilities disappear on their own and the
// editor draws no button that would fail when pressed.
//
//   voiceover        narration in a chosen voice (ElevenLabs, with word timings)
//   generatedShots   stills and clips for storyboard beats (the higgsfield tool)
//   costs            what the Studio spent: on whenever either provider capability is
//   cutouts, faces   macOS Vision on a worker that runs on a Mac (its Swift helpers compiled and passed their
//                    self-test): subject cut-outs, and face tracks (face-aware reframing, the director pass).
//                    Reported apart (visionCapabilities), so the provider answer keeps its shape.
//   sound            sound design with earshot (installed where the worker runs, STUDIO_EARSHOT_DIR): the sound pass,
//                    single sounds, imports and listening. Reported apart too (soundCapabilities).
//   motionCheck,     the measured checks' analysis (a Python with numpy and OpenCV where the worker runs,
//   review           STUDIO_ANALYSIS_PYTHON): the motion check and the whole-video review. Reported apart
//                    (checkCapabilities). The visual check (look) needs only the renderer, so no capability.
//
// The provider capabilities (voiceover, generatedShots, and costs with them) spend from the one provider account the
// worker holds, so on a server shared by several workspaces only the workspaces STUDIO_PROVIDER_WORKSPACES lists may
// use them (providersAllowed): a comma-separated list of workspace ids, or `*`. Unset, every workspace may outside
// production (local development keeps working) and none may in production. Per-workspace provider keys do not exist yet.
import type { StudioContext } from './context'
import { StudioError } from './errors'

/** The capabilities a worker may name. Anything else it sends is ignored. */
export const WORKER_CAPABILITIES = ['voiceover', 'generatedShots', 'cutouts', 'faces', 'sound', 'motionCheck', 'review'] as const
export type WorkerCapability = (typeof WORKER_CAPABILITIES)[number]

/** How long a worker's word holds without a newer one. */
export const CAPABILITY_TTL_MS = 60_000

/** What GET /bootstrap answers as `capabilities`. */
export type StudioCapabilities = { voiceover: boolean; generatedShots: boolean; costs: boolean }

type Heard = { capabilities: ReadonlySet<WorkerCapability>; at: number }

/**
 * Each worker's latest word, by worker id. One map for the whole server process, kept on globalThis: the worker's
 * routes (which hear it) and the editor's routes (which answer with it) are built as separate bundles, and in
 * development are rebuilt apart, so a plain module-level map would be one map per bundle and the editor would hear
 * nothing. (More than one app process still means one map each: a worker's word reaches whichever process it polls.)
 */
const HEARD = Symbol.for('ni.studio.workers-heard')
const shared = globalThis as { [HEARD]?: Map<string, Heard> }
const heard: Map<string, Heard> = (shared[HEARD] ??= new Map<string, Heard>())

/** Only the capabilities this app knows, from whatever the worker sent. Pure. */
export function knownCapabilities(value: unknown): WorkerCapability[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((v): v is WorkerCapability => (WORKER_CAPABILITIES as readonly unknown[]).includes(v)))]
}

/** A worker said what it can do (on a claim or a progress report). An absent list says nothing. */
export function noteWorker(workerId: string, capabilities: unknown, now = Date.now()): void {
  if (capabilities === undefined) return
  heard.set(workerId, { capabilities: new Set(knownCapabilities(capabilities)), at: now })
  // Forget workers long gone, so the map stays as small as the fleet.
  for (const [id, entry] of heard) if (now - entry.at > CAPABILITY_TTL_MS * 10) heard.delete(id)
}

/** The capabilities that spend from the provider accounts the worker holds. */
export const PROVIDER_CAPABILITIES: readonly WorkerCapability[] = ['voiceover', 'generatedShots']

type Env = Record<string, string | undefined>

/** The workspaces STUDIO_PROVIDER_WORKSPACES lets use the providers: 'all', or a set of ids (empty: none). Pure. */
export function providerWorkspaces(env: Env = process.env): 'all' | ReadonlySet<string> {
  const raw = (env.STUDIO_PROVIDER_WORKSPACES ?? '').trim()
  if (!raw) return env.NODE_ENV === 'production' ? new Set<string>() : 'all'
  const ids = raw.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean)
  return ids.includes('*') ? 'all' : new Set(ids)
}

/** Whether this workspace may use the provider capabilities (narration, generated shots). Pure over the env. */
export function providersAllowed(workspaceId: string, env: Env = process.env): boolean {
  const allowed = providerWorkspaces(env)
  return allowed === 'all' || allowed.has(workspaceId.toLowerCase())
}

/** What the workers heard from in the last minute can do for this workspace, together. Pure over the map and the env. */
export function currentCapabilities(ctx: Pick<StudioContext, 'workspaceId'>, now = Date.now()): StudioCapabilities {
  const on = new Set<WorkerCapability>()
  for (const entry of heard.values()) if (now - entry.at <= CAPABILITY_TTL_MS) for (const c of entry.capabilities) on.add(c)
  const providers = providersAllowed(ctx.workspaceId)
  const voiceover = providers && on.has('voiceover')
  const generatedShots = providers && on.has('generatedShots')
  return { voiceover, generatedShots, costs: voiceover || generatedShots }
}

/** Whether any worker was heard from in the last minute (every worker names its capabilities when it asks for work). Pure over the map. */
export function workerHeard(now = Date.now()): boolean {
  for (const entry of heard.values()) if (now - entry.at <= CAPABILITY_TTL_MS) return true
  return false
}

/** Refuse (503) at once when no Studio worker is running: a job queued now would only wait. */
export function requireWorker(what: string, now = Date.now()): void {
  if (!workerHeard(now)) throw new StudioError(`${what} needs the Studio worker, and none is running now. Start it, then try again.`, 503, 'NOT_AVAILABLE')
}

/** What GET /bootstrap answers beside the provider capabilities: macOS Vision on a worker heard from in the last minute. */
export type VisionCapabilities = { cutouts: boolean; faces: boolean }

/** Whether a worker heard from in the last minute can do this. Pure over the map. */
export function workerCan(capability: WorkerCapability, now = Date.now()): boolean {
  for (const entry of heard.values()) if (now - entry.at <= CAPABILITY_TTL_MS && entry.capabilities.has(capability)) return true
  return false
}

/** The Vision capabilities, together. Pure over the map. */
export function visionCapabilities(now = Date.now()): VisionCapabilities {
  return { cutouts: workerCan('cutouts', now), faces: workerCan('faces', now) }
}

/** What GET /bootstrap answers for sound design: a worker heard from in the last minute runs earshot. */
export const soundCapabilities = (now = Date.now()): { sound: boolean } => ({ sound: workerCan('sound', now) })

/** What GET /bootstrap answers for the measured checks: a worker heard from in the last minute runs the analysis. */
export const checkCapabilities = (now = Date.now()): { motionCheck: boolean; review: boolean } => ({ motionCheck: workerCan('motionCheck', now), review: workerCan('review', now) })

/** Forget every worker (tests). */
export function forgetWorkers(): void {
  heard.clear()
}

const MISSING: Record<WorkerCapability, string> = {
  voiceover: 'Narration needs the Studio worker running with an ElevenLabs key (ELEVENLABS_API_KEY), and none is running now.',
  generatedShots: 'Generated shots need the Studio worker running where the higgsfield tool is installed and signed in, and none is running now.',
  cutouts: 'Cutting out the person needs the Studio worker running on a Mac (it uses macOS Vision), and none is running now.',
  faces: 'Finding faces needs the Studio worker running on a Mac (it uses macOS Vision), and none is running now.',
  sound: 'Sound design needs the Studio worker running where earshot is installed (STUDIO_EARSHOT_DIR), and none is running now.',
  motionCheck: 'The motion check needs the Studio worker running with its analysis (a Python with numpy and OpenCV, STUDIO_ANALYSIS_PYTHON), and none is running now.',
  review: 'The video review needs the Studio worker running with its analysis (a Python with numpy and OpenCV, STUDIO_ANALYSIS_PYTHON), and none is running now.',
}

const NOT_SET_UP: Partial<Record<WorkerCapability, string>> = {
  voiceover: 'Narration is not set up for this workspace.',
  generatedShots: 'Generated shots are not set up for this workspace.',
}

/**
 * Refuse when this workspace can't have this right now: a provider capability for a workspace
 * STUDIO_PROVIDER_WORKSPACES does not list (403 NOT_SET_UP), or no worker that can do it (503), unless
 * `worker: false` (a path that reads only what the workspace already holds, such as a cached narration).
 */
export function requireCapability(ctx: Pick<StudioContext, 'workspaceId'>, capability: WorkerCapability, options: { worker?: boolean; now?: number } = {}): void {
  if (PROVIDER_CAPABILITIES.includes(capability) && !providersAllowed(ctx.workspaceId)) throw new StudioError(NOT_SET_UP[capability]!, 403, 'NOT_SET_UP')
  if (options.worker !== false && !workerCan(capability, options.now)) throw new StudioError(MISSING[capability], 503, 'NOT_AVAILABLE')
}
