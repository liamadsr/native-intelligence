/**
 * Map the desktop's chosen mic onto a WKWebView `getUserMedia` deviceId.
 *
 * Voice ID enrollment inside the desktop app records through the webview
 * (getUserMedia), not the Rust mic, so it doesn't follow the input-device
 * priority list on its own. When the list is customised or a mic is chosen
 * "for now" (the override), find the webview input whose label matches the
 * desktop's active device name.
 *
 * Every miss answers `undefined` = the webview's default mic: the browser, a
 * desktop without the list (0.2.45), a list that isn't customised with no
 * override (the desktop then uses the Mac's default too), no active
 * connected device, labels not yet exposed (no mic permission granted to the
 * webview yet), or
 * no matching label. The labels-hidden miss is flagged so the caller can
 * open the default first (which grants permission) and look again.
 */

import { isDesktopApp } from './platform'
import { tauriBridge } from './tauri-bridge'

type MediaInput = Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>

/** Pseudo-devices that alias whatever the OS default is. */
const ALIAS_IDS = new Set(['default', 'communications'])

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/** The deviceId of the audio input labelled `name`: an exact label first,
 *  then a case/space-insensitive one, then a label that wraps the name
 *  (e.g. "AirPods Pro (Bluetooth)"). Undefined when nothing matches. */
export function matchInputDeviceId(name: string, inputs: readonly MediaInput[]): string | undefined {
  const target = norm(name)
  if (!target) return undefined
  const candidates = inputs.filter(
    (d) => d.kind === 'audioinput' && d.deviceId && !ALIAS_IDS.has(d.deviceId) && d.label,
  )
  const exact = candidates.find((d) => d.label === name)
  if (exact) return exact.deviceId
  const loose = candidates.find((d) => norm(d.label) === target)
  if (loose) return loose.deviceId
  const wrapped = candidates.filter((d) => norm(d.label).includes(target))
  return wrapped.length === 1 ? wrapped[0].deviceId : undefined
}

/** The desktop's active mic mapped onto the webview. `deviceId` undefined =
 *  the default. `labelsHidden`: the lookup needed labels and WebKit hid them
 *  (no getUserMedia granted in this document yet), so a retry after the mic
 *  is open may match. */
export interface DesktopActiveMic {
  deviceId: string | undefined
  labelsHidden: boolean
}

const DEFAULT_MIC: DesktopActiveMic = { deviceId: undefined, labelsHidden: false }

/** The webview device for the desktop's active mic. Never rejects. */
export async function desktopActiveMic(): Promise<DesktopActiveMic> {
  if (!isDesktopApp()) return DEFAULT_MIC
  try {
    const snap = await tauriBridge.inputDevices.list()
    if (!snap.customised && !snap.overrideId) return DEFAULT_MIC
    const active = snap.devices.find((d) => d.active && d.available)
    if (!active) return DEFAULT_MIC
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return DEFAULT_MIC
    const inputs = await navigator.mediaDevices.enumerateDevices()
    // WebKit hides every label (and returns at most one input) until this
    // document has been granted getUserMedia; the grant resets on reload.
    const labelsHidden = !inputs.some((d) => d.kind === 'audioinput' && d.label)
    return { deviceId: matchInputDeviceId(active.name, inputs), labelsHidden }
  } catch {
    return DEFAULT_MIC
  }
}
