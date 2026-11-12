import React from 'react';
import { MediaVideo } from './media-video';
import { Freeze, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { EditorAsset, EditorClip, EditorProject, MotionLayer } from './contracts';
import { evaluateMotionAtFrame } from './motion';
import { motionWindowStyle, outputRect, overlayPlayback, previewVideoFrameWidth, sourceCropRect } from './motion-render';

/** The primary stream is the only visual stream allowed to own recording audio. */
export function PrimaryClipMedia({ clip, asset, fps, playbackFrames, style, src, silent = false }: {
  clip: EditorClip; asset: EditorAsset; fps: number; playbackFrames: number; style: React.CSSProperties; src: string; silent?: boolean;
}) {
  const trimBefore = clip.trimStartSourceFrame / asset.sourceFps! * fps;
  return <><Sequence durationInFrames={playbackFrames} layout="none"><MediaVideo src={src} trimBefore={trimBefore}
    durationInFrames={playbackFrames} playbackRate={clip.playbackRate} muted={silent || clip.audio.muted || clip.playbackRate>1 || !asset.hasAudio} volume={clip.audio.gain}
    maxCanvasSinkFrameSize={{ width: previewVideoFrameWidth }} style={style} /></Sequence>
    {clip.holdEndFrames > 0 && <Sequence from={playbackFrames} durationInFrames={clip.holdEndFrames} layout="none"><Freeze frame={playbackFrames - 1}>
      <MediaVideo src={src} trimBefore={trimBefore} durationInFrames={playbackFrames} playbackRate={clip.playbackRate} muted
        maxCanvasSinkFrameSize={{ width: previewVideoFrameWidth }} style={style} />
    </Freeze></Sequence>}</>;
}

export function OverlayClipMedia({ asset, sourceStartFrame, durationFrames, fps, src, style, playbackRate=1 }: {
  asset: EditorAsset; sourceStartFrame: number; durationFrames: number; fps: number; src: string; style: React.CSSProperties; playbackRate?:number;
}) {
  const plan = overlayPlayback(sourceStartFrame, asset.sourceFrames!, asset.sourceFps!, fps, durationFrames,playbackRate);
  return <><Sequence durationInFrames={plan.playbackFrames} layout="none"><MediaVideo src={src} trimBefore={plan.trimBefore}
    durationInFrames={plan.playbackFrames} playbackRate={playbackRate} muted maxCanvasSinkFrameSize={{ width: previewVideoFrameWidth }} style={style} /></Sequence>
    {plan.holdFrames > 0 && <Sequence from={plan.playbackFrames} durationInFrames={plan.holdFrames} layout="none"><Freeze frame={0}>
      <MediaVideo src={src} trimBefore={plan.lastFrameTrimBefore} durationInFrames={1} playbackRate={1} muted
        maxCanvasSinkFrameSize={{ width: previewVideoFrameWidth }} style={style} />
    </Freeze></Sequence>}</>;
}

export function StyledMotionContent({ layer }: { layer: Exclude<MotionLayer, { kind: 'video' }> }) {
  if (layer.kind === 'text') return <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center',
    justifyContent: layer.align === 'left' ? 'flex-start' : layer.align === 'right' ? 'flex-end' : 'center',
    textAlign: layer.align, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.12,
    fontFamily: layer.font === 'serif' ? 'Georgia,serif' : layer.font === 'mono' ? 'monospace' : 'Arial,sans-serif',
    fontSize: layer.fontSizePx, fontWeight: layer.weight === 'bold' ? 700 : layer.weight === 'medium' ? 500 : 400, color: layer.color }}>
    {layer.text}
  </div>;
  if (layer.kind === 'frame') return <div style={{ width: '100%', height: '100%', boxSizing: 'border-box',
    border: `${layer.strokeWidthPx}px solid ${layer.strokeColor}`, borderRadius: layer.radiusPx }} />;
  return <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', background: layer.fillColor,
    border: `2px solid ${layer.strokeColor}`, borderRadius: layer.radiusPx }} />;
}

function MotionLayerView({ layer, clip, project, assetPath }: {
  layer: MotionLayer; clip: EditorClip; project: EditorProject; assetPath: (file: string) => string;
}) {
  const localFrame = useCurrentFrame(), { width, height, fps } = useVideoConfig();
  const clipFrame = layer.startFrame + localFrame;
  const evaluated = evaluateMotionAtFrame(clip, Math.max(layer.startFrame, Math.min(layer.endFrame - 1, clipFrame)));
  const visual = evaluated.layers.find(value => value.id === layer.id)?.visual ?? layer.visual;
  const rect = outputRect(visual, width, height);
  const asset = layer.kind === 'video' ? project.assets.find(source => source.id === layer.assetId)! : null;
  const cropped = sourceCropRect(asset?.width ?? rect.width, asset?.height ?? rect.height, visual.crop, rect.width, rect.height);
  return <div data-motion-layer={layer.id} style={{ ...motionWindowStyle(rect, visual, height, layer.zIndex), overflow: 'hidden' }}>
    <div style={{ position: 'absolute', left: cropped.x, top: cropped.y, width: cropped.width, height: cropped.height }}>
      {layer.kind === 'video' && asset ? <OverlayClipMedia asset={asset} sourceStartFrame={layer.sourceStartFrame}
        durationFrames={layer.endFrame - layer.startFrame} fps={fps} src={assetPath(asset.file)} playbackRate={clip.playbackRate}
        style={{ position: 'absolute', width: cropped.width, height: cropped.height }} /> :
        layer.kind !== 'video' ? <div style={{ width: rect.width, height: rect.height, transformOrigin: '0 0',
          transform: `scale(${cropped.width / rect.width})` }}><StyledMotionContent layer={layer} /></div> : null}
    </div>
  </div>;
}

export function MotionLayers({ clip, project, assetPath }: { clip: EditorClip; project: EditorProject; assetPath: (file: string) => string }) {
  return <>{[...clip.motion.layers].sort((a, b) => a.zIndex - b.zIndex).map(layer =>
    <Sequence key={layer.id} from={layer.startFrame} durationInFrames={layer.endFrame - layer.startFrame}
      premountFor={Math.min(project.output.fps, layer.startFrame)}>
      <MotionLayerView layer={layer} clip={clip} project={project} assetPath={assetPath} />
    </Sequence>)}</>;
}
