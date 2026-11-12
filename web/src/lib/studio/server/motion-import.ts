/**
 * Motion ads as editable videos. A motion ad's job leaves its parts (ads-contract.ts MotionParts): the background
 * without type, one audio file per sound, veil and logo images (all library assets), and where every word sits and
 * when it moves. This turns those parts into an ordinary edit: the background is the clip, each sound its own track,
 * every word a text layer in the brand's fonts, rules as boxes, veils and the logo as images, so copy, timing,
 * position and levels can be changed by hand.
 *
 * Moves the editor can't draw as layers (the knock-out pull-out) are drawn into the background by the job (`baked`),
 * since this Studio does not serve code scenes yet; any scene part left is skipped.
 *
 * Pure: the caller registers the assets and saves the edit (ads.ts).
 */
import { defaultCaptions, defaultPresentation, type EditorAsset } from '../engine/contracts'
import type { EditorLayer } from '../engine/layers'
import type { MotionPart, MotionParts } from './ads-contract'

type Anim = { preset: 'none' | 'fade' | 'wipe'; seconds: number }

/** The editor layers for a render's parts (frames at the parts' fps, geometry in fractions of the frame). */
export function motionLayers(parts: MotionParts): EditorLayer[] {
  const { width: W, height: H, fps } = parts
  const total = Math.round(parts.seconds * fps), at = (s: number) => Math.max(0, Math.round(s * fps))
  const anim = (a?: Anim) => (a && a.preset !== 'none'
    ? { preset: a.preset, frames: Math.max(1, Math.round(a.seconds * fps)), ease: a.preset === 'fade' ? ('smooth' as const) : ('expo' as const) }
    : { preset: 'none' as const, frames: 1 })
  const layers: EditorLayer[] = []
  parts.layers.forEach((part: MotionPart, i) => {
    if (part.kind === 'scene') return
    // A layer runs from its start to its end plus its exit (the exit plays in the layer's last frames).
    const startFrame = Math.min(total - 1, at(part.start))
    const endFrame = Math.max(startFrame + 1, Math.min(total, part.end == null ? total : at(part.end + (part.exit?.preset === 'none' ? 0 : part.exit?.seconds ?? 0))))
    const common = { id: `${part.kind}-${i + 1}`, name: part.name.slice(0, 100), startFrame, endFrame, rotate: 0, opacity: 1, enter: anim(part.enter), exit: anim(part.exit), automation: [] as EditorLayer['automation'] }
    const box = (left: number, top: number, w: number, h: number) => ({ x: (left + w / 2) / W, y: (top + h / 2) / H, width: w / W, height: h / H })
    if (part.kind === 'text') {
      const lineBox = part.px * part.leading
      layers.push({
        ...common,
        kind: 'text',
        ...box(part.left, part.top, part.width, lineBox),
        style: { text: part.text, font: part.family, size: part.px / H, weight: part.weight, tracking: part.tracking, leading: part.leading, color: part.color, align: part.align, ...(part.uppercase ? { uppercase: true } : {}) },
        ...(part.settle ? { automation: [{ param: 'scale' as const, points: [{ frame: startFrame, value: part.settle, curve: 'smooth' as const }, { frame: startFrame + Math.round(0.6 * fps), value: 1 }] }] } : {}),
      })
    } else if (part.kind === 'rule') {
      layers.push({ ...common, kind: 'box', ...box(part.left, part.top, part.width, part.height), opacity: part.opacity ?? 1, style: { background: part.color, radius: 0 } })
    } else if (part.kind === 'logo') {
      layers.push({ ...common, kind: 'image', assetId: part.assetId, ...box(part.left, part.top, part.width, part.height), style: { radius: 0 } })
    } else if (part.kind === 'veil') {
      layers.push({ ...common, kind: 'image', assetId: part.assetId, x: 0.5, y: 0.5, width: 1, height: 1, style: { radius: 0 } })
    }
  })
  return layers
}

/** Every library asset the parts name. */
export function partAssetIds(parts: MotionParts): string[] {
  const ids = [parts.background, ...parts.audio.map((a) => a.assetId)]
  for (const l of parts.layers) if (l.kind === 'logo' || l.kind === 'veil') ids.push(l.assetId)
  return [...new Set(ids)]
}

/**
 * The edit for a motion ad's parts. `asset` gives each part's registered library asset; `id` is the new video's id.
 * Not validated here: the save path checks it against the engine's schema and the library.
 */
export function motionProject(parts: MotionParts, options: { asset: (id: string) => EditorAsset; id: string }): Record<string, unknown> {
  if (parts.schemaVersion !== 1) throw new Error('These motion parts were made by a newer renderer')
  const fps = parts.fps, frames = Math.round(parts.seconds * fps)
  const background = options.asset(parts.background)
  const sounds = parts.audio.map((a) => ({ name: a.name, role: a.role, asset: options.asset(a.assetId) }))
  const images = new Map<string, EditorAsset>()
  for (const part of parts.layers) if ((part.kind === 'logo' || part.kind === 'veil') && !images.has(part.assetId)) images.set(part.assetId, options.asset(part.assetId))
  const assets = [...new Map([background, ...sounds.map((s) => s.asset), ...images.values()].map((a) => [a.id, a])).values()]
  return {
    schemaVersion: 4,
    id: options.id,
    title: parts.title.slice(0, 250) || parts.id,
    output: { width: parts.width, height: parts.height, fps },
    assets,
    clips: [{
      id: 'clip-1', assetId: background.id, trimStartSourceFrame: 0, trimEndSourceFrame: Math.min(background.sourceFrames ?? frames, frames),
      audio: { muted: true, gain: 1 }, holdEndFrames: 0, zooms: [], playbackRate: 1, dismissedActionIndices: [],
    }],
    presentation: structuredClone(defaultPresentation),
    cursor: { style: 'none', size: 24, clickFeedback: false },
    audioTracks: sounds.map((s, k) => ({
      id: `track-${k + 1}`, name: s.name.slice(0, 100), role: s.role, gain: 1, muted: false,
      segments: [{ id: `segment-${k + 1}`, assetId: s.asset.id, startFrame: 0, trimStartSeconds: 0, trimEndSeconds: Math.min(s.asset.durationSeconds ?? parts.seconds, parts.seconds) }],
    })),
    presenterTrack: null,
    transcripts: [],
    captions: { ...defaultCaptions },
    captionCorrections: {},
    voiceoverDraft: { text: '', targetClipIds: [] },
    layers: motionLayers(parts),
  }
}
