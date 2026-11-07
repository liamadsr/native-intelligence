/**
 * The local-modules keeper: on-device speech sets itself up, and is used as
 * soon as it is ready. There is no choice to make (Liam, 2026-10-08: "the
 * user should not be given any choices to download anything"; "if the model
 * is ready ... it should automatically start using it"). The keeper turns
 * every module on and makes sure the downloads actually finish:
 *
 *  - Any module found off is turned on, including one switched off under the
 *    old Settings switch. Settings only shows how far along it is.
 *  - It goes in order. local-tts (~144 MB) goes first, so read-aloud is
 *    usually ready by the time onboarding ends. local-stt (~807 MB) starts
 *    once local-tts is no longer downloading.
 *  - It retries a failed download with backoff, and right away when the
 *    network comes back. The desktop itself only retries at the next launch.
 *    A failure that can't fix itself (a build without the module, a protocol
 *    mismatch) is never retried, and after MAX_AUTO_RETRIES in one session it
 *    waits for the next launch or a Try again in Settings.
 *  - It restarts a stalled download (no progress for STALL_MS). The desktop
 *    has no read timeout, so a dead connection would otherwise sit at
 *    "Downloading" forever. The restart is a disable + enable (enabling a
 *    module that is downloading does nothing), and the desktop resumes from
 *    the `.part` file. One cut short is finished later, like any module
 *    found off.
 *  - It starts nothing while a capture is recording in any window. A
 *    download would compete with the meeting for bandwidth, and a warm-up
 *    would compete for the GPU. A download already running carries on.
 *
 * Until a module is ready, its features fall back or hide: meetings use
 * Deepgram (local-transcription.ts); dictation, voice mode and read-aloud
 * don't show (use-voice-availability.ts, speech-output.ts). Once a module is
 * ready, the next use picks it up. Nothing is announced.
 *
 * Only one window runs the keeper (DesktopSetupMount takes a Web Lock).
 *
 * Telemetry (`deps.track`, PostHog; the mount adds the Mac's details and
 * the module's own log lines on a failure; see docs/plans/local-modules.md,
 * "Diagnosing a user's speech models"):
 *   local_module_auto_download_started  it turned a module on
 *   local_module_failed                 a module went into error (error,
 *                                       error_kind, phase, progress, attempt)
 *   local_module_unavailable            this Mac or build can't run it (reason)
 *   local_module_auto_retry             a background retry
 *   local_module_stall_restart          a stalled download restarted
 *   local_module_retries_exhausted      it stopped retrying this session
 *   local_module_ready                  ready, with how long it took
 * Every one carries `module` and `state` (the module's state after it).
 */

import type { LocalModuleInfo } from './tauri-bridge'
import { LOCAL_STT_MODULE_ID, LOCAL_TTS_MODULE_ID, moduleErrorKind } from './local-modules'

/** Set up for every desktop user, in this order. */
export const AUTO_MODULES = [LOCAL_TTS_MODULE_ID, LOCAL_STT_MODULE_ID] as const

/** Waits before each retry of a failed download. The last one repeats. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000, 600_000] as const

/** Background retries and stall restarts per module per session (a launch,
 *  or a page load). After that only the network coming back or Settings'
 *  Try again retries. */
export const MAX_AUTO_RETRIES = 8

/** No progress for this long while downloading counts as a stall. */
export const STALL_MS = 60_000

/** How often a running download is checked for a stall. */
export const STALL_CHECK_MS = 10_000

/**
 * How to retry a failure:
 *  - never: retrying can't fix it (a build without the module's binary, a
 *    macOS too old, a sidecar that speaks another protocol);
 *  - slow: only time might (out of disk, until the user frees some; a
 *    sidecar that didn't come up, which costs a model load per try);
 *  - soon: a network failure, the usual case.
 */
export function retryClass(error: string | null | undefined): 'soon' | 'slow' | 'never' {
  const e = (error ?? '').toLowerCase()
  if (
    e.includes('sidecar binary missing') ||
    e.includes('sidecar executable not found') ||
    e.includes('needs macos') ||
    e.includes('speaks protocol') ||
    e.includes('identifies as') ||
    e.includes('module protocol')
  ) {
    return 'never'
  }
  if (e.includes('not enough disk space') || e.includes('sidecar')) return 'slow'
  return 'soon'
}

export interface KeeperDeps {
  list: () => Promise<LocalModuleInfo[]>
  enable: (id: string) => Promise<LocalModuleInfo>
  disable: (id: string) => Promise<LocalModuleInfo>
  /** Subscribe to `module://status`. Returns the unsubscribe. */
  onStatus: (cb: (info: LocalModuleInfo) => void) => () => void
  /** Subscribe to the network coming back. Returns the unsubscribe. */
  onOnline?: (cb: () => void) => () => void
  now: () => number
  track?: (event: string, props: Record<string, unknown>) => void
}

interface Tracked {
  /** Failed attempts since the last success, picking the next retry delay. */
  failures: number
  /** Background retries this session (capped at MAX_AUTO_RETRIES). */
  retries: number
  retryTimer: ReturnType<typeof setTimeout> | null
  /** The last progress seen while downloading, and when it last moved. */
  progress: number | null
  progressAt: number
  /** A command for this module is in flight: don't stack another. */
  busy: boolean
  /** When this session first saw it working towards ready (downloading,
   *  verifying or warming up), and whether its files were already there. */
  startedAt: number | null
  hadFiles: boolean
  /** One-off reports already sent this session. */
  reportedUnavailable: boolean
  reportedExhausted: boolean
}

export class LocalModulesKeeper {
  private readonly deps: KeeperDeps
  private readonly infos = new Map<string, LocalModuleInfo>()
  private readonly tracked = new Map<string, Tracked>()
  private recording = false
  private stopped = false
  private unsubscribe: Array<() => void> = []
  private stallTimer: ReturnType<typeof setInterval> | null = null

  constructor(deps: KeeperDeps) {
    this.deps = deps
    for (const id of AUTO_MODULES) {
      this.tracked.set(id, {
        failures: 0,
        retries: 0,
        retryTimer: null,
        progress: null,
        progressAt: 0,
        busy: false,
        startedAt: null,
        hadFiles: false,
        reportedUnavailable: false,
        reportedExhausted: false,
      })
    }
  }

  start(): void {
    // Subscribe first: a status event is newer than any list answer.
    const seen = new Set<string>()
    this.unsubscribe.push(
      this.deps.onStatus((info) => {
        if (!info || !this.tracked.has(info.id)) return
        seen.add(info.id)
        this.update(info)
      }),
    )
    if (this.deps.onOnline) this.unsubscribe.push(this.deps.onOnline(() => this.retryNow()))
    this.stallTimer = setInterval(() => this.checkStalls(), STALL_CHECK_MS)
    void this.deps.list().then(
      (list) => {
        if (this.stopped) return
        for (const info of list) if (this.tracked.has(info.id) && !seen.has(info.id)) this.observe(info)
        this.evaluateAll()
      },
      () => {},
    )
  }

  stop(): void {
    this.stopped = true
    for (const off of this.unsubscribe) off()
    this.unsubscribe = []
    if (this.stallTimer) clearInterval(this.stallTimer)
    this.stallTimer = null
    for (const t of this.tracked.values()) {
      if (t.retryTimer) clearTimeout(t.retryTimer)
      t.retryTimer = null
    }
  }

  /** A capture started or stopped (in any window). Stopping releases
   *  anything that waited. */
  setRecording(recording: boolean): void {
    if (this.recording === recording) return
    this.recording = recording
    if (!recording) this.evaluateAll()
  }

  private update(info: LocalModuleInfo) {
    const before = this.infos.get(info.id)
    this.observe(info)
    const t = this.tracked.get(info.id)!
    // Finished while we watched (not merely ready at launch).
    if (info.state === 'ready' && before && before.state !== 'ready') {
      this.deps.track?.('local_module_ready', {
        module: info.id,
        state: info.state,
        retries: t.failures,
        duration_ms: t.startedAt === null ? null : this.deps.now() - t.startedAt,
        downloaded: !t.hadFiles,
        bytes: info.downloadBytes,
        version: info.version,
      })
      t.startedAt = null
    }
    // Went wrong while we watched: what, and where it got to.
    if (info.state === 'error' && before?.state !== 'error') {
      this.deps.track?.('local_module_failed', {
        module: info.id,
        state: info.state,
        error: info.error,
        error_kind: info.error ? moduleErrorKind(info.error) : 'other',
        retry: retryClass(info.error),
        phase: before?.state ?? null,
        progress: before?.progress ?? null,
        attempt: t.failures,
        bytes: info.downloadBytes,
        version: info.version,
      })
    }
    if (info.state === 'ready') t.failures = 0
    this.evaluateAll()
  }

  /** Take in a module's latest info, and keep its stall clock. */
  private observe(info: LocalModuleInfo) {
    const before = this.infos.get(info.id)
    this.infos.set(info.id, info)
    const t = this.tracked.get(info.id)!
    const working = info.state === 'downloading' || info.state === 'verifying' || info.state === 'warming'
    if (working && t.startedAt === null) {
      t.startedAt = this.deps.now()
      t.hadFiles = info.assetsPresent
    }
    // This Mac or build can't run it: once a session, with why.
    if (info.state === 'unavailable' && !t.reportedUnavailable) {
      t.reportedUnavailable = true
      this.deps.track?.('local_module_unavailable', {
        module: info.id,
        state: info.state,
        reason: info.error,
        error_kind: info.error ? moduleErrorKind(info.error) : 'missing_binary',
        version: info.version,
      })
    }
    if (info.state === 'downloading' || info.state === 'verifying') {
      // A download we just learned of starts its stall clock now; after
      // that, only movement resets it.
      const fresh = before?.state !== 'downloading' && before?.state !== 'verifying'
      if (fresh || info.progress !== t.progress) {
        t.progress = info.progress
        t.progressAt = this.deps.now()
      }
    } else {
      t.progress = null
    }
  }

  private evaluateAll() {
    if (this.stopped) return
    for (const id of AUTO_MODULES) this.evaluate(id)
  }

  private evaluate(id: string) {
    const info = this.infos.get(id)
    const t = this.tracked.get(id)!
    if (!info || info.state === 'unavailable' || t.busy) return

    if (!info.enabled) {
      if (t.retryTimer || !this.mayStart(id)) return
      this.deps.track?.('local_module_auto_download_started', {
        module: id,
        state: 'downloading',
        bytes: info.downloadBytes,
        has_files: info.assetsPresent,
        version: info.version,
      })
      this.run(id, () => this.deps.enable(id))
      return
    }

    if (info.state === 'error') {
      this.scheduleRetry(id, info.error)
      return
    }
    // Enabled but idle: the desktop didn't resume it. Start it like a retry.
    if (info.state === 'off' && this.mayStart(id)) this.run(id, () => this.deps.enable(id))
  }

  /** Nothing new starts during a capture, and transcription waits for
   *  read-aloud's small download to finish first. */
  private mayStart(id: string): boolean {
    if (this.recording) return false
    if (id === LOCAL_STT_MODULE_ID && this.ttsAhead()) return false
    return true
  }

  /** local-tts is still to download, or downloading. A tts that is off
   *  will be turned on, and a command in flight is moving it along, so both
   *  count, not just what the desktop has reported so far. */
  private ttsAhead(): boolean {
    const tts = this.infos.get(LOCAL_TTS_MODULE_ID)
    const t = this.tracked.get(LOCAL_TTS_MODULE_ID)!
    if (!tts || tts.state === 'unavailable') return false
    if (t.busy || !tts.enabled) return true
    return tts.state === 'downloading' || tts.state === 'verifying'
  }

  private scheduleRetry(id: string, error: string | null) {
    const t = this.tracked.get(id)!
    if (t.retryTimer) return
    const kind = retryClass(error)
    if (kind === 'never') return
    if (t.retries >= MAX_AUTO_RETRIES) {
      if (!t.reportedExhausted) {
        t.reportedExhausted = true
        this.deps.track?.('local_module_retries_exhausted', {
          module: id,
          state: this.infos.get(id)?.state ?? null,
          error,
          error_kind: error ? moduleErrorKind(error) : 'other',
          retries: t.retries,
        })
      }
      return
    }
    const delay =
      kind === 'slow'
        ? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
        : RETRY_DELAYS_MS[Math.min(t.failures, RETRY_DELAYS_MS.length - 1)]
    t.retryTimer = setTimeout(() => {
      t.retryTimer = null
      this.retry(id)
    }, delay)
  }

  private retry(id: string) {
    if (this.stopped) return
    const info = this.infos.get(id)
    const t = this.tracked.get(id)!
    // Not a failed download (a first enable whose command failed): evaluate
    // starts it again.
    if (!info?.enabled || info.state !== 'error') {
      this.evaluate(id)
      return
    }
    if (this.recording) {
      // Try again once the capture stops (setRecording re-evaluates).
      return
    }
    t.failures += 1
    t.retries += 1
    this.deps.track?.('local_module_auto_retry', {
      module: id,
      state: info.state,
      attempt: t.failures,
      error: info.error,
      error_kind: info.error ? moduleErrorKind(info.error) : 'other',
    })
    this.run(id, () => this.deps.enable(id))
  }

  /** The network came back: retry every failed download now. */
  private retryNow() {
    for (const id of AUTO_MODULES) {
      const t = this.tracked.get(id)!
      const info = this.infos.get(id)
      if (!info?.enabled || info.state !== 'error' || retryClass(info.error) === 'never') continue
      if (t.retryTimer) clearTimeout(t.retryTimer)
      t.retryTimer = null
      this.retry(id)
    }
  }

  private checkStalls() {
    if (this.stopped) return
    const now = this.deps.now()
    for (const id of AUTO_MODULES) {
      const info = this.infos.get(id)
      const t = this.tracked.get(id)!
      if (!info?.enabled || info.state !== 'downloading' || t.busy) continue
      if (now - t.progressAt < STALL_MS) continue
      // Restarts count against the session's retries: on a connection that
      // stays dead they would otherwise run every minute, for ever.
      if (t.retries >= MAX_AUTO_RETRIES) continue
      t.retries += 1
      this.deps.track?.('local_module_stall_restart', { module: id, state: info.state, progress: info.progress })
      t.progressAt = now
      this.run(id, async () => {
        await this.deps.disable(id)
        return this.deps.enable(id)
      })
    }
  }

  /** Run one command for `id`, folding its answer into what we know. */
  private run(id: string, command: () => Promise<LocalModuleInfo>) {
    const t = this.tracked.get(id)!
    t.busy = true
    void command()
      .then(
        (info) => {
          if (info && info.id === id) this.observe(info)
        },
        () => {
          // The command itself failed (not the download): back off and try
          // again, the same as a failed download.
          t.failures += 1
          if (!this.stopped && !t.retryTimer) {
            t.retryTimer = setTimeout(() => {
              t.retryTimer = null
              this.retry(id)
            }, RETRY_DELAYS_MS[Math.min(t.failures, RETRY_DELAYS_MS.length - 1)])
          }
        },
      )
      .finally(() => {
        t.busy = false
        if (this.stopped) return
        const info = this.infos.get(id)
        if (info?.enabled && info.state === 'error') this.scheduleRetry(id, info.error)
        else this.evaluateAll()
      })
  }
}
