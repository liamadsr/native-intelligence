// Every way the browser can refuse a screen share, a camera or a microphone, as a sentence the Record dialog shows
// as is. The browser's own messages are written for developers ("Permission denied by system"); these are written
// for the person recording.

/** What was being asked for when it failed. */
export type MediaAsk = 'screen' | 'camera' | 'microphone' | 'recording'

const NOUN: Record<MediaAsk, string> = {
  screen: 'screen sharing',
  camera: 'the camera',
  microphone: 'the microphone',
  recording: 'recording',
}

/** The error's DOMException name, when it has one. */
function nameOf(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && typeof (error as { name: unknown }).name === 'string') return (error as { name: string }).name
  return ''
}

/** The error's own message, when it has one. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return ''
}

/**
 * A plain sentence for a failed getDisplayMedia / getUserMedia / MediaRecorder call.
 * A cancelled screen picker is not an error the person needs explained: it answers null.
 */
export function mediaErrorSentence(error: unknown, ask: MediaAsk): string | null {
  const name = nameOf(error)
  const message = messageOf(error)
  const noun = NOUN[ask]
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      // Chrome and Safari answer NotAllowedError both when the person cancels the picker and when the system refuses.
      if (ask === 'screen') {
        if (/system|denied by system/i.test(message))
          return 'Your computer is not letting this browser record the screen. Allow it under Screen Recording in your system settings, then reload this page.'
        return null
      }
      return `The browser was not allowed to use ${noun}. Allow it from the camera icon in the address bar (or your browser's site settings), then try again.`
    case 'AbortError':
      return ask === 'screen' ? null : `${capitalize(noun)} stopped before it started. Try again.`
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      if (ask === 'screen') return 'There is nothing this browser can share right now.'
      return `No ${ask === 'camera' ? 'camera' : 'microphone'} was found. Plug one in, or turn it off for this recording.`
    case 'NotReadableError':
    case 'TrackStartError':
      if (ask === 'screen') return 'The screen could not be captured. Close other apps that are recording it and try again.'
      return `${capitalize(noun)} is busy in another app (a call, another tab). Close it there, or pick another one.`
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return `That ${ask === 'camera' ? 'camera' : ask === 'microphone' ? 'microphone' : 'source'} is no longer available. Pick another one.`
    case 'SecurityError':
      return `This page is not allowed to use ${noun}. Open the Studio from its own address (not inside another site).`
    case 'TypeError':
      return `This browser cannot use ${noun} here.`
    case 'NotSupportedError':
      return ask === 'recording'
        ? 'This browser cannot record video. Use a current Chrome, Edge, Firefox or Safari, or the desktop app.'
        : `This browser cannot use ${noun}.`
    case 'InvalidStateError':
      return `${capitalize(noun)} could not start right now. Try again.`
    default:
      break
  }
  if (message) return `${capitalize(noun)} failed: ${message.replace(/\.$/, '')}.`
  return `${capitalize(noun)} failed. Try again.`
}

/** The sentence for an unknown failure anywhere in the recording flow. */
export function plainError(error: unknown): string {
  const message = messageOf(error)
  return message || 'Something went wrong while recording. Try again.'
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
