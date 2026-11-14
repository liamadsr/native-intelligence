/**
 * What this worker can do beyond media work, told to the app on every claim
 * and progress report (the app keeps the word about a minute: no worker, no
 * buttons in the editor).
 *
 *   voiceover        ELEVENLABS_API_KEY is set (narration, voice search,
 *                    re-voicing, sound effects, music beds)
 *   generatedShots   the higgsfield tool answers `account status` (installed
 *                    and signed in), checked at start and every few minutes,
 *                    never on every poll
 *
 * It also decides which jobs each slot asks for: the media slots never take
 * provider work, and one slot of its own does (provider calls and quick
 * measurements wait on the network, not the machine, and must not queue
 * behind a long export). A provider kind is asked for only while its
 * capability holds.
 */
import type { StudioJobKind } from '../../../web/src/lib/studio/server/job-contract.ts'
import type { WorkerConfig } from '../config.ts'
import { LIVE_JOB_KINDS } from '../engine.ts'
import { hf, higgsfieldPath, toolRunner, type HfRunner } from './higgsfield.ts'

export type Capability = 'voiceover' | 'generatedShots'

/** Each provider kind and what it needs. */
export const PROVIDER_KINDS: Partial<Record<StudioJobKind, Capability>> = {
  voices: 'voiceover',
  narration: 'voiceover',
  'shot-quote': 'generatedShots',
  shot: 'generatedShots',
  // More of the voice provider, on the same key (../jobs/voice-media.ts).
  'voice-search': 'voiceover',
  revoice: 'voiceover',
  'sound-effect': 'voiceover',
  music: 'voiceover',
}
/** Quick work that rides in the provider slot too (any worker with FFmpeg can do it). */
export const QUICK_KINDS: StudioJobKind[] = ['continuity']

/** How often the higgsfield tool is asked again. */
export const RECHECK_MS = 5 * 60_000

/** True when `account status` answered like a signed-in account. Pure. */
export function signedIn(answer: unknown): boolean {
  const a = answer as { credits?: unknown; subscription_plan_type?: unknown } | null
  return !!a && typeof a === 'object' && (typeof a.credits === 'number' || typeof a.subscription_plan_type === 'string')
}

/** The kinds a slot asks for, given what is configured and what holds now. Pure. */
export function kindsFor(slot: 'media' | 'provider' | 'live', configured: readonly StudioJobKind[], on: ReadonlySet<Capability>): StudioJobKind[] {
  // A recording prepared while it records holds its slot as long as the recording lasts: only a live slot takes it.
  if (slot === 'live') return configured.filter((k) => LIVE_JOB_KINDS.includes(k))
  if (slot === 'media') return configured.filter((k) => !PROVIDER_KINDS[k] && !LIVE_JOB_KINDS.includes(k))
  return configured.filter((k) => (PROVIDER_KINDS[k] ? on.has(PROVIDER_KINDS[k]!) : QUICK_KINDS.includes(k)))
}

export class WorkerCapabilities {
  private higgsfield = false
  private timer: NodeJS.Timeout | null = null
  private readonly run: HfRunner

  constructor(
    private readonly config: Pick<WorkerConfig, 'elevenLabsKey' | 'higgsfieldBin'>,
    opts: { run?: HfRunner } = {},
  ) {
    this.run = opts.run ?? toolRunner(higgsfieldPath(config.higgsfieldBin))
  }

  /** What holds now. */
  current(): Set<Capability> {
    const on = new Set<Capability>()
    if (this.config.elevenLabsKey) on.add('voiceover')
    if (this.higgsfield) on.add('generatedShots')
    return on
  }

  /** As the app is told. */
  list(): string[] {
    return [...this.current()]
  }

  /** Ask the higgsfield tool whether it is signed in (free, read-only). */
  async check(): Promise<void> {
    const before = this.higgsfield
    try {
      this.higgsfield = signedIn(await hf(this.run, ['account', 'status'], { timeout: 20_000 }))
    } catch {
      this.higgsfield = false
    }
    if (before !== this.higgsfield) console.info(`[studio-worker] generated shots ${this.higgsfield ? 'on: the higgsfield tool is signed in' : 'off: the higgsfield tool is not installed or not signed in'}`)
  }

  /** Check now and every few minutes until stopped. */
  async start(): Promise<void> {
    await this.check()
    this.timer = setInterval(() => void this.check(), RECHECK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
