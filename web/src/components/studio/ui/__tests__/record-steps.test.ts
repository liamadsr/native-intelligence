/**
 * The Record dialog's words: the worker's steps said plainly, the one line about where a take is while it records,
 * and how long a saved take is.
 */
import { describe, expect, it } from 'vitest'
import { plainStep } from '../record-steps'
import { lengthWords, savedLine } from '../RecordDialog'
import type { LiveTrackStatus } from '../../record'

const track = (over: Partial<LiveTrackStatus>): LiveTrackStatus => ({ role: 'screen', label: 'Screen', state: 'live', recordedBytes: 10, uploadedBytes: 10, unsavedSeconds: 0, ...over })

describe('plainStep', () => {
  it('says the worker’s log lines in plain words, and keeps the app’s own sentences', () => {
    expect(plainStep('Conforming the recording to a constant 30 fps (H.264/AAC)')).toBe('Preparing the video')
    expect(plainStep('Downloading Screen recording.webm')).toBe('Preparing the screen recording')
    expect(plainStep('Downloading Camera.webm')).toBe('Preparing the camera')
    expect(plainStep('Downloading Microphone.webm')).toBe('Preparing the sound')
    expect(plainStep('Microphone.webm has sound and no picture: importing it as audio, encoded as AAC into an .m4a')).toBe('Preparing the sound')
    expect(plainStep('Storing assets/abc.mp4 (12.3 MB)')).toBe('Almost done')
    expect(plainStep('Waiting for the Studio worker')).toBe('Waiting for the Studio to start')
    expect(plainStep('Putting your recording together')).toBe('Putting your recording together')
    expect(plainStep('ffmpeg exited with code 0 after 41 frames')).toBe('Preparing your recording')
    expect(plainStep(undefined)).toBe('Preparing your recording')
  })
})

describe('savedLine', () => {
  it('is one calm line while all is well, and says what is wrong only when it is', () => {
    expect(savedLine([])).toBeNull()
    expect(savedLine([track({}), track({ role: 'camera', label: 'Camera', state: 'done' })])).toEqual({ tone: 'ok', text: 'Saved as you record' })
    expect(savedLine([track({ state: 'connecting' })])?.tone).toBe('quiet')
    expect(savedLine([track({ state: 'local' })])).toEqual({ tone: 'quiet', text: 'Kept on this computer. It uploads after Stop.' })
    expect(savedLine([track({}), track({ role: 'camera', label: 'Camera', state: 'retrying', unsavedSeconds: 12.4 })])).toEqual({ tone: 'warn', text: 'Connection dropped. Kept here (12 s so far), and it goes up when the connection is back.' })
    expect(savedLine([track({ state: 'retrying' }), track({ role: 'microphone', label: 'Microphone', state: 'failed', error: 'There is no room left on the Studio.' })]))
      .toEqual({ tone: 'warn', text: 'The Studio stopped taking the microphone: there is no room left on the Studio. What reached it is kept.' })
  })
})

describe('lengthWords', () => {
  it('says a length in words', () => {
    expect(lengthWords(1)).toBe('1 second')
    expect(lengthWords(42.4)).toBe('42 seconds')
    expect(lengthWords(120)).toBe('2 minutes')
    expect(lengthWords(192)).toBe('3 minutes 12 seconds')
  })
})
