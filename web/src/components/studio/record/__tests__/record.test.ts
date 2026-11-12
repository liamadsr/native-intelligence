// The recorder's pure parts: which backend records, which container a browser records into, how far apart a take's
// sources started, what the desktop bridge's answers become, the sentences shown for refused devices, and the
// POST /recordings body.
import { describe, expect, it } from 'vitest'
import { BROWSER_CANNOT_RECORD, NEWER_APP_NEEDED, chooseRecorder } from '../choose'
import { normalizePermissions, normalizeStop, normalizeTargets } from '../desktop'
import { mediaErrorSentence } from '../errors'
import { recordingRequest, uploadOrder } from '../finish'
import { AUDIO_TYPES, VIDEO_TYPES, clockLabel, extensionFor, levelFrom, pickType, sourceOffsets, takeFileName, withAudio } from '../media'
import type { FinishedTake } from '../types'

describe('choosing the recorder', () => {
  const env = { nativeRecorder: false, desktopShell: false, displayMedia: true, mediaRecorder: true }
  it('uses the Mac app recorder whenever it answers', () => {
    expect(chooseRecorder({ ...env, nativeRecorder: true, desktopShell: true })).toEqual({ kind: 'desktop' })
    expect(chooseRecorder({ ...env, nativeRecorder: true, displayMedia: false })).toEqual({ kind: 'desktop' })
  })
  it('falls back to the browser share, also inside an older app that can share', () => {
    expect(chooseRecorder(env)).toEqual({ kind: 'browser' })
    expect(chooseRecorder({ ...env, desktopShell: true })).toEqual({ kind: 'browser' })
  })
  it('says the newer app is needed when an older app cannot share, and a browser that cannot record says so', () => {
    expect(chooseRecorder({ ...env, desktopShell: true, displayMedia: false })).toEqual({ kind: 'unavailable', reason: NEWER_APP_NEEDED })
    expect(chooseRecorder({ ...env, mediaRecorder: false })).toEqual({ kind: 'unavailable', reason: BROWSER_CANNOT_RECORD })
  })
})

describe('containers', () => {
  it('prefers MP4/H.264, then WebM VP9, VP8', () => {
    expect(pickType(VIDEO_TYPES, (t) => t === 'video/mp4;codecs=avc1' || t.startsWith('video/webm'))).toBe('video/mp4;codecs=avc1')
    expect(pickType(VIDEO_TYPES, (t) => t === 'video/webm;codecs=vp8' || t === 'video/webm;codecs=vp9')).toBe('video/webm;codecs=vp9')
    expect(pickType(VIDEO_TYPES, () => false)).toBeNull()
    expect(pickType(VIDEO_TYPES, () => { throw new Error('nope') })).toBeNull()
    expect(pickType(AUDIO_TYPES, (t) => t === 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus')
  })
  it('adds an audio codec when the screen carries sound, if the browser takes the pair', () => {
    expect(withAudio('video/webm;codecs=vp9', () => true)).toBe('video/webm;codecs=vp9,opus')
    expect(withAudio('video/mp4;codecs=avc1', () => true)).toBe('video/mp4;codecs=avc1,mp4a.40.2')
    expect(withAudio('video/webm;codecs=vp9', () => false)).toBe('video/webm;codecs=vp9')
    expect(withAudio(null, () => true)).toBeNull()
  })
  it('names files by role, time and container', () => {
    expect(extensionFor('video/webm;codecs=vp9,opus')).toBe('webm')
    expect(extensionFor('video/mp4;codecs=avc1')).toBe('mp4')
    expect(extensionFor('audio/mp4')).toBe('m4a')
    const name = takeFileName('screen', 'webm', new Date(2026, 10, 12, 9, 41))
    expect(name).toMatch(/^Screen recording 12 Nov.*09.41\.webm$/)
    expect(name).not.toMatch(/[/:]/)
  })
})

describe('source offsets', () => {
  it('places each source on the screen clock', () => {
    expect(sourceOffsets({ screen: 1000, camera: 1250, microphone: 990 })).toEqual({ screen: 0, camera: 0.25, microphone: -0.01 })
    expect(sourceOffsets({ screen: 12.5, camera: 12.75 }, 's')).toEqual({ screen: 0, camera: 0.25 })
  })
  it('leaves out sources that never started, and everything when the screen did not', () => {
    expect(sourceOffsets({ screen: 1000, camera: null, microphone: undefined })).toEqual({ screen: 0 })
    expect(sourceOffsets({ camera: 1250 })).toEqual({})
  })
})

describe('levels and the clock', () => {
  it('reads silence as 0 and a loud signal as near 1', () => {
    expect(levelFrom(new Uint8Array(64).fill(128))).toBe(0)
    expect(levelFrom(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 228 : 28)))).toBe(1)
    expect(levelFrom([])).toBe(0)
  })
  it('shows m:ss', () => {
    expect(clockLabel(0)).toBe('0:00')
    expect(clockLabel(65_400)).toBe('1:05')
    expect(clockLabel(-5)).toBe('0:00')
  })
})

describe('refusals as sentences', () => {
  const err = (name: string, message = '') => Object.assign(new Error(message), { name })
  it('treats a closed screen picker as nothing to explain', () => {
    expect(mediaErrorSentence(err('NotAllowedError', 'Permission denied'), 'screen')).toBeNull()
    expect(mediaErrorSentence(err('AbortError'), 'screen')).toBeNull()
  })
  it('explains a system refusal of screen recording', () => {
    expect(mediaErrorSentence(err('NotAllowedError', 'Permission denied by system'), 'screen')).toMatch(/Screen Recording in your system settings/)
  })
  it('explains each device failure plainly', () => {
    expect(mediaErrorSentence(err('NotAllowedError'), 'camera')).toMatch(/not allowed to use the camera/)
    expect(mediaErrorSentence(err('NotFoundError'), 'microphone')).toMatch(/No microphone was found/)
    expect(mediaErrorSentence(err('NotReadableError'), 'camera')).toMatch(/busy in another app/)
    expect(mediaErrorSentence(err('OverconstrainedError'), 'camera')).toMatch(/no longer available/)
    expect(mediaErrorSentence({ name: 'NotSupportedError' }, 'recording')).toMatch(/cannot record video/)
    expect(mediaErrorSentence(new Error('Odd failure.'), 'microphone')).toBe('The microphone failed: Odd failure.')
    expect(mediaErrorSentence(undefined, 'camera')).toBe('The camera failed. Try again.')
  })
})

describe('the desktop bridge answers', () => {
  it('normalizes the five permissions', () => {
    expect(normalizePermissions({ screenRecording: 'granted', accessibility: true, inputMonitoring: 'denied', camera: 'undetermined' }))
      .toEqual({ screenRecording: 'granted', accessibility: 'granted', inputMonitoring: 'denied', camera: 'undetermined', microphone: 'undetermined', traceFull: true })
    expect(normalizePermissions({ screenRecording: 'granted', accessibility: 'denied', inputMonitoring: 'denied', camera: 'granted', microphone: 'granted', trace: { level: 'pointer', reason: 'Turn on Input Monitoring' } }).traceFull).toBe(false)
  })
  it('groups windows by app, whether they arrive grouped or flat', () => {
    const grouped = normalizeTargets({
      displays: [{ displayId: 1, name: 'Built-in Display', width: 3024, height: 1964, scale: 2 }],
      apps: [{ pid: 42, bundleId: 'com.example.notes', appName: 'Notes', windows: [{ windowId: 7, title: 'Ideas', frame: { x: 0, y: 0, width: 800, height: 600 }, displayId: 1, scale: 2 }] }],
      cameras: [{ deviceId: 'cam-1', name: 'FaceTime HD Camera', isDefault: true }],
      microphones: [{ id: 'mic-1', name: 'MacBook Pro Microphone' }],
    })
    expect(grouped.displays).toEqual([{ displayId: 1, name: 'Built-in Display', width: 3024, height: 1964, scale: 2, isMain: true }])
    expect(grouped.apps).toEqual([{ pid: 42, bundleId: 'com.example.notes', appName: 'Notes', windows: [{ windowId: 7, pid: 42, bundleId: 'com.example.notes', appName: 'Notes', title: 'Ideas', frame: { x: 0, y: 0, width: 800, height: 600 }, displayId: 1, scale: 2 }] }])
    expect(grouped.cameras).toEqual([{ id: 'cam-1', name: 'FaceTime HD Camera', isDefault: true }])
    expect(grouped.microphones).toEqual([{ id: 'mic-1', name: 'MacBook Pro Microphone', isDefault: false }])
    const flat = normalizeTargets({ windows: [{ windowId: 9, pid: 5, bundleId: 'com.example.b', appName: 'Beta', title: 'One' }, { windowId: 10, pid: 5, bundleId: 'com.example.b', appName: 'Beta', title: 'Two' }, { windowId: 11, pid: 3, appName: 'Alpha' }] })
    expect(flat.apps.map((a) => [a.appName, a.windows.map((w) => w.windowId)])).toEqual([['Alpha', [11]], ['Beta', [9, 10]]])
    expect(normalizeTargets(null)).toEqual({ displays: [], apps: [], cameras: [], microphones: [] })
  })
  it('turns a stop answer into a take on the screen clock', () => {
    const take = normalizeStop('s-1', {
      files: [
        { role: 'screen', path: '/tmp/take/screen.mov', bytes: 1000, width: 3024, height: 1964, fps: 60, firstPts: 100.5, lastPts: 110.5, durationSeconds: 10 },
        { role: 'camera', path: '/tmp/take/camera.mov', bytes: 500, firstPts: 100.75, lastPts: 110.4, durationSeconds: 9.65 },
        { role: 'microphone', path: '/tmp/take/mic.m4a', bytes: 200, firstPts: 100.4, lastPts: 110.6, durationSeconds: 10.2 },
        { role: 'unknown-extra', path: '/tmp/take/x.mov', bytes: 1 },
      ],
      trace: { viewport: { width: 1512, height: 982, scale: 2 }, cursor: [], actions: [] },
      t0: 100.5,
      transcript: { words: [{ text: 'Hello', startMs: 100, endMs: 400 }, { text: '', startMs: 500, endMs: 600 }] },
    }, new Date(2026, 10, 12, 9, 41))
    expect(take.kind).toBe('desktop')
    expect(take.files.map((f) => [f.role, f.offsetSeconds, f.contentType])).toEqual([['screen', 0, 'video/quicktime'], ['camera', 0.25, 'video/quicktime'], ['microphone', -0.1, 'audio/mp4']])
    expect(take.files[0]).toMatchObject({ width: 3024, height: 1964, bytes: 1000 })
    expect(take.sourceCursorHidden).toBe(true)
    expect(take.transcript).toEqual({ words: [{ text: 'Hello', startMs: 100, endMs: 400 }] })
    expect(take.durationSeconds).toBe(10)
  })
  it('refuses a stop answer without a screen file', () => {
    expect(() => normalizeStop('s-1', { files: [{ role: 'camera', path: '/tmp/c.mov', bytes: 1 }] }, new Date())).toThrow(/without a screen recording/)
  })
})

describe('the recording request', () => {
  const take: FinishedTake = {
    kind: 'browser', sessionId: 'x', trace: null, sourceCursorHidden: false, transcript: null, durationSeconds: 12.5,
    files: [
      { role: 'screen', name: 'Screen.webm', contentType: 'video/webm', bytes: 900, offsetSeconds: 0, durationSeconds: 12.5 },
      { role: 'camera', name: 'Camera.webm', contentType: 'video/webm', bytes: 400, offsetSeconds: 0.2504, durationSeconds: 12.2 },
      { role: 'microphone', name: 'Mic.webm', contentType: 'audio/webm', bytes: 100, offsetSeconds: -0.012, durationSeconds: 12.6 },
      { role: 'system-audio', name: 'Empty.webm', contentType: 'audio/webm', bytes: 0, offsetSeconds: 0, durationSeconds: 0 },
    ],
  }
  it('uploads the voice first, then the screen, then the camera, and skips empty files', () => {
    expect(uploadOrder(take.files).map((f) => f.role)).toEqual(['microphone', 'screen', 'camera'])
  })
  it('describes a new browser take', () => {
    const body = recordingRequest(take, { screen: 'uploads/s', camera: 'uploads/c', microphone: 'uploads/m' }, { kind: 'new' })
    expect(body).toEqual({
      recorder: 'browser',
      screen: { uploadKey: 'uploads/s', name: 'Screen.webm' },
      camera: { uploadKey: 'uploads/c', name: 'Camera.webm', offsetSeconds: 0.25 },
      microphone: { uploadKey: 'uploads/m', name: 'Mic.webm', offsetSeconds: -0.012 },
      sourceCursorHidden: false,
      durationSeconds: 12.5,
    })
  })
  it('carries a punch range or the beats and their marks, a trace and words', () => {
    const desktop: FinishedTake = { ...take, kind: 'desktop', trace: { viewport: { width: 1, height: 1, scale: 1 }, cursor: [], actions: [] }, sourceCursorHidden: true, transcript: { words: [{ text: 'hi', startMs: 0, endMs: 100 }] } }
    const punch = recordingRequest(desktop, { screen: 'uploads/s' }, { kind: 'punch', projectId: 'v', fromFrame: 10, toFrame: 40 }, 'Fix the intro')
    expect(punch).toMatchObject({ title: 'Fix the intro', recorder: 'desktop', sourceCursorHidden: true, punch: { projectId: 'v', fromFrame: 10, toFrame: 40 }, transcript: { words: [{ text: 'hi', startMs: 0, endMs: 100 }] } })
    expect(punch).not.toHaveProperty('camera')
    const beats = recordingRequest(take, { screen: 'uploads/s' }, { kind: 'beats', projectId: 'v', beatIds: ['b1', 'b2'], marks: [{ ms: 4000, beat: 1 }] })
    expect(beats.beats).toEqual({ projectId: 'v', beatIds: ['b1', 'b2'], marks: [{ ms: 4000, beat: 1 }] })
  })
  it('needs the screen upload', () => {
    expect(() => recordingRequest(take, { camera: 'uploads/c' }, { kind: 'new' })).toThrow(/screen recording was not uploaded/)
  })
})
