// A blank canvas: a new video whose picture is a plain full-frame colour, for films built entirely from layers
// (titles, icons, waveforms…) with nothing recorded; footage can be recorded or dropped on top later. The colour
// video is made in code (canvas-mp4.ts), stored like any import (assets/<sha256>.mp4) and registered in the library.
import { randomUUID } from 'node:crypto'
import { defaultCaptions, defaultPresentation, type EditorAsset, type EditorProject } from '../engine/contracts'
import { registerAsset } from './assets'
import { getBlob, putBlobBytes } from './blobs'
import { canvasMp4, canvasSize } from './canvas-mp4'
import type { StudioContext } from './context'
import { sha256Hex } from './stable'
import { createVideo, type SaveOptions } from './videos'

export type BlankOptions = { title?: string; seconds?: number; color?: string; width?: number; height?: number; fps?: number }

/** The blank canvas's settings, clamped as the editor's dialog allows: 1–600 s, 1–60 fps, 64–4096 px even sides. */
export function blankSettings(options: BlankOptions = {}) {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)
  const seconds = Math.min(600, Math.max(1, num(options.seconds) ?? 20))
  const fps = Math.min(60, Math.max(1, Math.round(num(options.fps) ?? 60)))
  const side = (v: number | undefined, d: number) => Math.round(Math.min(4096, Math.max(64, v ?? d)) / 2) * 2
  const width = side(num(options.width), 1920)
  const height = side(num(options.height), 1080)
  const color = /^#[\da-fA-F]{6}$/.test(options.color ?? '') ? options.color!.toLowerCase() : '#eef0f4'
  return { seconds, fps, width, height, color, title: typeof options.title === 'string' && options.title.trim() ? options.title.trim().slice(0, 250) : 'Blank canvas' }
}

/** The canvas video for these settings, stored and registered (the same settings give the same file, stored once). */
export async function canvasAsset(ctx: StudioContext, s: ReturnType<typeof blankSettings>): Promise<EditorAsset> {
  const size = canvasSize(s.width, s.height)
  const frames = Math.round(s.seconds * s.fps)
  const bytes = canvasMp4({ ...size, fps: s.fps, frames, color: s.color })
  const sha = sha256Hex(bytes)
  const file = `assets/${sha}.mp4`
  if (!(await getBlob(ctx, file))) await putBlobBytes(ctx, file, bytes, 'video/mp4', sha)
  return registerAsset(ctx, {
    id: sha,
    name: `Blank canvas ${s.width}×${s.height} ${s.color} ${s.seconds}s.mp4`,
    kind: 'video',
    file,
    sha256: sha,
    bytes: bytes.byteLength,
    width: size.width,
    height: size.height,
    sourceFps: s.fps,
    sourceFrames: frames,
    durationSeconds: frames / s.fps,
    hasAudio: false,
    sourceCursorHidden: false,
    provenance: { blank: true, color: s.color },
  })
}

/** A new blank-canvas video (title, length, colour, size, frame rate), saved. */
export async function createBlankVideo(ctx: StudioContext, options: BlankOptions = {}, saveOptions: SaveOptions = {}): Promise<EditorProject> {
  const s = blankSettings(options)
  const asset = await canvasAsset(ctx, s)
  const project = {
    schemaVersion: 4,
    id: randomUUID(),
    title: s.title,
    output: { width: s.width, height: s.height, fps: s.fps },
    assets: [asset],
    clips: [{ id: 'clip-1', assetId: asset.id, trimStartSourceFrame: 0, trimEndSourceFrame: asset.sourceFrames!, audio: { muted: true, gain: 1 }, holdEndFrames: 0, zooms: [], playbackRate: 1, dismissedActionIndices: [] }],
    presentation: structuredClone(defaultPresentation),
    cursor: { style: 'none', size: 24, clickFeedback: false },
    audioTracks: [],
    presenterTrack: null,
    transcripts: [],
    captions: { ...defaultCaptions },
    captionCorrections: {},
    voiceoverDraft: { text: '', targetClipIds: [] },
    layers: [],
  }
  return (await createVideo(ctx, project as unknown as EditorProject, saveOptions)).project
}
