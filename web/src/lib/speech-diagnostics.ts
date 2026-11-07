/**
 * Speech diagnostics: what PostHog needs to answer "why doesn't this user
 * have voice?", and "does it fail on some Macs more than others?" (Liam,
 * 2026-10-08). See docs/plans/local-modules.md, "Diagnosing a user's speech
 * models", for how to read it.
 *
 *  - desktopContext(): the Mac and the app. Registered as PostHog super
 *    properties in the desktop app (DesktopSetupMount), so EVERY event from
 *    it (onboarding's included) can be broken down by macOS version, chip,
 *    memory and app version. The user agent can't tell: WebKit freezes the
 *    macOS version it reports at 10.15.7.
 *  - snapshotProps(): both models and the desktop's voice status at launch,
 *    plus person properties ($set) so a user's profile shows where their
 *    speech models stand.
 *  - logTail(): the module's own last log lines (the desktop's module manager
 *    and the sidecar's output), attached to a failure. "Won't start on this
 *    macOS" shows up there, not in the one-line error.
 *
 * `system_info` and `module_log_tail` arrive with desktop 0.2.73. Older
 * builds report the app version only, and their fields read null.
 */

import { tauriBridge, type LocalModuleInfo, type VoiceStatus } from './tauri-bridge'

export interface DesktopContext {
  desktop_app_version: string | null
  macos_version: string | null
  mac_chip: string | null
  mac_arch: string | null
  mac_memory_gb: number | null
  mac_rosetta: boolean | null
}

let contextPromise: Promise<DesktopContext> | null = null

/** The Mac and the app, read once per page. Never rejects. */
export function desktopContext(): Promise<DesktopContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const [version, info] = await Promise.all([
        Promise.resolve()
          .then(() => tauriBridge.appVersion())
          .catch(() => null),
        Promise.resolve()
          .then(() => tauriBridge.systemInfo())
          .catch(() => null),
      ])
      return {
        desktop_app_version: typeof version === 'string' ? version : null,
        macos_version: info?.macosVersion ?? null,
        mac_chip: info?.chip ?? null,
        mac_arch: info?.arch ?? null,
        mac_memory_gb:
          typeof info?.memoryBytes === 'number' ? Math.round(info.memoryBytes / 1024 ** 3) : null,
        mac_rosetta: typeof info?.rosetta === 'boolean' ? info.rosetta : null,
      }
    })()
  }
  return contextPromise
}

/** "local-stt" → "local_stt": PostHog property names. */
export function modulePropKey(id: string): string {
  return id.replace(/-/g, '_')
}

/**
 * The launch snapshot's properties: each model's state, plus the desktop's
 * voice status. The `$set` part lands on the person, so their profile shows
 * e.g. `local_stt_state: error`, `local_stt_error: …`, `voice_dictation:
 * false` until a later event updates it.
 */
export function snapshotProps(modules: LocalModuleInfo[], voice: VoiceStatus | null): Record<string, unknown> {
  const props: Record<string, unknown> = { modules_reported: modules.length }
  const person: Record<string, unknown> = {}
  for (const m of modules) {
    const key = modulePropKey(m.id)
    props[`${key}_state`] = m.state
    props[`${key}_enabled`] = m.enabled
    props[`${key}_has_files`] = m.assetsPresent
    props[`${key}_error`] = m.error
    props[`${key}_version`] = m.version
    person[`${key}_state`] = m.state
    person[`${key}_error`] = m.error
  }
  if (voice) {
    props.voice_available = voice.available
    props.voice_dictation = voice.dictation
    props.voice_conversation = voice.conversation
    props.voice_stt = voice.stt
    props.voice_tts = voice.tts
    props.voice_reason = voice.reason ?? null
    person.voice_dictation = voice.dictation
    person.voice_conversation = voice.conversation
  }
  return { ...props, $set: person }
}

/** Longest log tail sent with one event. */
export const LOG_TAIL_MAX_CHARS = 4_000

/** The module's last log lines, newest kept when cut. Null on a desktop
 *  without `module_log_tail`, or if it doesn't answer within `timeoutMs`. */
export async function logTail(id: string, timeoutMs = 1_500): Promise<string | null> {
  const lines = await Promise.race([
    Promise.resolve()
      .then(() => tauriBridge.moduleLogTail(id))
      .catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])
  if (!Array.isArray(lines) || lines.length === 0) return null
  const text = lines.join('\n')
  return text.length <= LOG_TAIL_MAX_CHARS ? text : `…${text.slice(text.length - LOG_TAIL_MAX_CHARS + 1)}`
}

/** Tests only. */
export function __resetDesktopContextForTests(): void {
  contextPromise = null
}
