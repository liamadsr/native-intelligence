/**
 * Local modules — the web side of the desktop app's on-device sidecars
 * (`local-stt`, `local-tts`; see docs/plans/local-modules.md, "Bridge
 * contract v1").
 *
 * The desktop owns everything (download, verify, warm-up, the device-local
 * enabled flag); the web only reads module state and flips the setting. Every
 * read here is guarded so a browser, or a desktop build that predates Local
 * Modules, reads as "no modules" and never shows local-module UI.
 */

import { isDesktopApp } from './platform'
import { tauriBridge, type LocalModuleInfo } from './tauri-bridge'

/** On-device speech-to-text (NeMo-Speech.cpp). */
export const LOCAL_STT_MODULE_ID = 'local-stt'

/** On-device text-to-speech for read-aloud (Kyutai Pocket TTS). */
export const LOCAL_TTS_MODULE_ID = 'local-tts'

/** Every module the desktop reports; [] in a browser, on an older desktop, or
 *  on any bridge failure. Never throws. */
export async function listLocalModules(): Promise<LocalModuleInfo[]> {
  if (!isDesktopApp()) return []
  try {
    const list = await tauriBridge.modulesList()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** One module's current info, or null when this build doesn't have it. */
export async function getLocalModule(id: string): Promise<LocalModuleInfo | null> {
  const list = await listLocalModules()
  return list.find((m) => m.id === id) ?? null
}

/** Enabled by the user AND downloaded, verified and warmed up — i.e. a
 *  recording started now may ask the desktop for it. */
export function isLocalModuleUsable(info: LocalModuleInfo | null | undefined): info is LocalModuleInfo {
  return !!info && info.enabled && info.state === 'ready'
}

/**
 * What kind of failure a module error is: a stable label for analytics
 * breakdowns (PostHog `error_kind`) and the basis of the Settings wording.
 * The desktop's messages are written for logs: "download of x.gguf failed:
 * HTTP 503", "not enough disk space: 1880 MB needed, 412 MB free", "sidecar
 * exited before it was ready".
 */
export type ModuleErrorKind =
  | 'disk'
  | 'checksum'
  | 'missing_binary'
  | 'macos_too_old'
  | 'protocol'
  | 'network'
  | 'sidecar_start'
  | 'io'
  | 'other'

export function moduleErrorKind(error: string): ModuleErrorKind {
  const e = error.toLowerCase()
  if (e.includes('not enough disk space')) return 'disk'
  if (e.includes('checksum')) return 'checksum'
  if (e.includes('sidecar binary missing') || e.includes('sidecar executable not found')) return 'missing_binary'
  if (e.includes('needs macos')) return 'macos_too_old'
  if (e.includes('speaks protocol') || e.includes('identifies as') || e.includes('module protocol')) return 'protocol'
  if (/download of .* failed|http \d{3}|expected \d+ bytes|error sending request|connection|timed out/.test(e)) {
    return 'network'
  }
  if (e.includes('sidecar')) return 'sidecar_start'
  if (e.startsWith('io:')) return 'io'
  return 'other'
}

/** A module error in words a person can act on, for the settings row.
 *  Unrecognised messages pass through unchanged. */
export function describeModuleError(error: string): string {
  switch (moduleErrorKind(error)) {
    case 'disk': {
      const disk = /not enough disk space: (\d+) mb needed, (\d+) mb free/.exec(error.toLowerCase())
      if (!disk) return 'Not enough disk space. Free up some space, then try again.'
      const short = Math.max(0, Number(disk[1]) - Number(disk[2]))
      return `Not enough disk space. Free up about ${formatDownloadSize(short * 1_000_000)?.replace('~', '') ?? 'some space'}, then try again.`
    }
    case 'checksum':
      return 'The download came through damaged. Try again to download it fresh.'
    case 'missing_binary':
    case 'protocol':
      return 'This version of Dial8 can’t run it. Update Dial8 to use it.'
    case 'macos_too_old':
      return error
    case 'network':
      return 'The download was interrupted. Check your internet connection, then try again.'
    case 'sidecar_start':
      return 'It downloaded but couldn’t start on this Mac. Try again.'
    case 'io':
      return 'Something went wrong saving it. Try again.'
    default:
      return error
  }
}

/**
 * Human download size for a settings row: "~800 MB", "~140 MB", "~1.2 GB",
 * "~45 MB". Decimal units (what Finder shows); rounded to the nearest 100 MB
 * from 500 MB up and to the nearest 10 MB from 100 MB up, since the figure is
 * an estimate. Null when the size is unknown.
 */
export function formatDownloadSize(bytes: number | null | undefined): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null
  const mb = bytes / 1_000_000
  if (mb >= 950) return `~${(Math.round(mb / 100) / 10).toFixed(1).replace(/\.0$/, '')} GB`
  if (mb >= 500) return `~${Math.round(mb / 100) * 100} MB`
  if (mb >= 100) return `~${Math.round(mb / 10) * 10} MB`
  return `~${Math.max(1, Math.round(mb))} MB`
}
