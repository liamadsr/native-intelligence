// Which recorder records: the Mac app's native recorder when it is there, else the browser's own screen share.
import type { RecorderKind } from './types'

/** What the page can do, found out once when the Record dialog opens. */
export type RecorderEnvironment = {
  /** The Mac app's native recorder answered `available()` with true. */
  nativeRecorder: boolean
  /** The page runs inside the Native Intelligence desktop app (whatever its version). */
  desktopShell: boolean
  /** `navigator.mediaDevices.getDisplayMedia` exists. */
  displayMedia: boolean
  /** `MediaRecorder` exists. */
  mediaRecorder: boolean
}

export type RecorderChoice = { kind: RecorderKind } | { kind: 'unavailable'; reason: string }

export const NEWER_APP_NEEDED =
  'Screen recording needs the newer Native Intelligence app. Update the app (Native Intelligence › Check for Updates), then open the Studio again.'
export const BROWSER_CANNOT_RECORD =
  'This browser cannot record the screen. Use a current Chrome, Edge, Firefox or Safari on a computer, or the Native Intelligence app for Mac.'

/**
 * The desktop recorder when the app has it; otherwise the browser's screen share when the page can use it. Inside an
 * older desktop app whose web view cannot share the screen, the person is told to update the app.
 */
export function chooseRecorder(env: RecorderEnvironment): RecorderChoice {
  if (env.nativeRecorder) return { kind: 'desktop' }
  if (env.displayMedia && env.mediaRecorder) return { kind: 'browser' }
  if (env.desktopShell) return { kind: 'unavailable', reason: NEWER_APP_NEEDED }
  return { kind: 'unavailable', reason: BROWSER_CANNOT_RECORD }
}

/** What this page can do, read from the browser (the native recorder's answer is passed in). */
export function browserEnvironment(nativeRecorder: boolean, desktopShell: boolean): RecorderEnvironment {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  return {
    nativeRecorder,
    desktopShell,
    displayMedia: typeof nav?.mediaDevices?.getDisplayMedia === 'function',
    mediaRecorder: typeof MediaRecorder !== 'undefined',
  }
}
