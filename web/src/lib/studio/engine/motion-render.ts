import type { CSSProperties } from 'react';
import type { MotionVisual } from './motion-contracts';

export type PixelRect = { x: number; y: number; width: number; height: number };
export const previewVideoFrameWidth = 1280;

export function outputRect(visual: MotionVisual, width: number, height: number): PixelRect {
  return { x: visual.rect.x * width, y: visual.rect.y * height, width: visual.rect.width * width, height: visual.rect.height * height };
}

/** Neutral motion leaves the existing fitted screen and presentation unchanged. */
export function primaryRect(legacy: PixelRect, visual: MotionVisual, width: number, height: number): PixelRect {
  return { x: visual.rect.x * width + legacy.x * visual.rect.width,
    y: visual.rect.y * height + legacy.y * visual.rect.height,
    width: legacy.width * visual.rect.width, height: legacy.height * visual.rect.height };
}

/** Cover the selected immutable source crop without stretching its pixels. */
export function sourceCropRect(sourceWidth: number, sourceHeight: number, crop: MotionVisual['crop'], width: number, height: number): PixelRect {
  const fit = Math.max(width / (sourceWidth * crop.width), height / (sourceHeight * crop.height));
  const scaledWidth = sourceWidth * fit, scaledHeight = sourceHeight * fit;
  return { x: -crop.x * scaledWidth - (scaledWidth * crop.width - width) / 2,
    y: -crop.y * scaledHeight - (scaledHeight * crop.height - height) / 2,
    width: scaledWidth, height: scaledHeight };
}

export function motionWindowStyle(rect: PixelRect, visual: MotionVisual, outputHeight: number, zIndex = 0): CSSProperties {
  const transformed = visual.scale !== 1 || visual.tiltX !== 0 || visual.tiltY !== 0 || visual.rotateZ !== 0;
  return { position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex,
    opacity: visual.opacity, transformOrigin: '50% 50%', backfaceVisibility: 'hidden',
    ...(transformed ? { transform: `perspective(${outputHeight * 1.2}px) rotateX(${visual.tiltX}deg) rotateY(${visual.tiltY}deg) rotateZ(${visual.rotateZ}deg) scale(${visual.scale})` } : {}) };
}

export function overlayPlayback(sourceStartFrame: number, sourceFrames: number, sourceFps: number, projectFps: number, durationFrames: number, playbackRate=1) {
  const playbackFrames = Math.min(durationFrames, Math.max(1, Math.ceil((sourceFrames - sourceStartFrame) / sourceFps * projectFps / playbackRate - 1e-8)));
  return { trimBefore: sourceStartFrame / sourceFps * projectFps, playbackFrames, holdFrames: durationFrames - playbackFrames,
    lastFrameTrimBefore: (sourceFrames - 1) / sourceFps * projectFps };
}
