// The Studio's recorder: one entry point for the Record dialog. `openRecorder` finds out which recorder this page
// can use (the Mac app's native one, else the browser's screen share) and hands it back ready to record.
import { BrowserRecorder } from './browser'
import { browserEnvironment, chooseRecorder, type RecorderChoice } from './choose'
import { DesktopRecorder, bridge, insideDesktopApp, nativeRecorderAvailable } from './desktop'

export type { Recorder, FinishedTake, TakeFile, TakeOptions, TakeRole, ScreenChoice, SharedSurface, RecorderTargets, RecorderPermissions, RecorderPermissionName, PermissionState, DeviceOption, DesktopApp, DesktopDisplay, DesktopWindow, LiveStatus, LiveTrackStatus, LiveTrackState, EndReason, RecorderKind } from './types'
export { BrowserRecorder, listBrowserDevices, openCameraPreview, unlockDeviceLabels } from './browser'
export { DesktopRecorder } from './desktop'
export { chooseRecorder, NEWER_APP_NEEDED, BROWSER_CANNOT_RECORD, type RecorderChoice, type RecorderEnvironment } from './choose'
export { uploadTake, submitTake, recordingRequest, uploadOrder, recoverSavedTake, recentRecordings, type TakePlacement, type RecordingAnswer, type RecordingView, type UploadProgress } from './finish'
export { listSavedTakes, discardSavedTake, type SavedTake } from './live'
export { clockLabel } from './media'
export { mediaErrorSentence, plainError } from './errors'

export type OpenedRecorder =
  | { kind: 'desktop'; recorder: DesktopRecorder }
  | { kind: 'browser'; recorder: BrowserRecorder; desktopShell: boolean }
  | { kind: 'unavailable'; reason: string }

/** The recorder this page records with. */
export async function openRecorder(): Promise<OpenedRecorder> {
  const [native, shell] = await Promise.all([nativeRecorderAvailable(), insideDesktopApp()])
  const choice: RecorderChoice = chooseRecorder(browserEnvironment(native, shell))
  if (choice.kind === 'desktop') {
    const b = await bridge()
    if (b) return { kind: 'desktop', recorder: new DesktopRecorder(b) }
    return { kind: 'unavailable', reason: 'The native recorder stopped answering. Restart Native Intelligence and try again.' }
  }
  if (choice.kind === 'browser') return { kind: 'browser', recorder: new BrowserRecorder(), desktopShell: shell }
  return { kind: 'unavailable', reason: choice.kind === 'unavailable' ? choice.reason : 'Recording is not available here.' }
}
