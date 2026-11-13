import { assetHref } from './asset-base';
import React from 'react';
import { Audio } from '@remotion/media';
import { MediaVideo, useCheapEffects } from './media-video';
import { AbsoluteFill, Img, Sequence, staticFile, useCurrentFrame, useRemotionEnvironment, useVideoConfig } from 'remotion';
import type { EditorProject } from './contracts';
import { scheduleProject, sourceTimeSeconds, type ScheduledClip } from './timeline';
import { transcriptWords } from './transcript';
import { deliveredProject } from './formats';
import { zoomAmount } from './zoom';
import { evaluateMotionAtFrame } from './motion';
import { motionWindowStyle, previewVideoFrameWidth, primaryRect, sourceCropRect } from './motion-render';
import { MotionLayers, PrimaryClipMedia } from './motion-layers';
import { PresenterLayer } from './presenter';
import { clipView, fitRect, isCameraSource, layoutTiles, slideForClipFrame, syncedTake, type Rect, type ShotSource } from './shots';
import { cutVideoPlan, dipOpacity, dipPlan, type Dip } from './cuts';
import { soundLayers } from './sound-layers';
import { automationValue } from './automation';
import { LayerStack } from './layers-render';
import { CodeScenesContext, type CodeScenes } from './scene-layer';
import { loadFaces, type FontFace } from './font-faces';
import { CutoutPass, gradeFilter, passAsset, useCutoutPass } from './cutout-pass';
import type { EditorAsset, EditorClip } from './contracts';

function SourceClip({ scheduled, project, assetPath, extend = 0, fadeIn = 0, playOn = false }: { scheduled: ScheduledClip; project: EditorProject; assetPath: (file: string) => string; extend?: number; fadeIn?: number; playOn?: boolean }) {
  // Past the cut (extend) the picture holds its last kept frame while the next clip dissolves over it — never deleted footage.
  const rawFrame = useCurrentFrame(), frame = Math.min(rawFrame, scheduled.durationFrames - 1), { fps, width, height } = useVideoConfig();
  const playbackFrames = scheduled.durationFrames - scheduled.clip.holdEndFrames;
  // A chosen dissolve plays real footage past the cut (playOn); otherwise the last kept frame holds.
  const mediaClip = extend > 0 ? (playOn ? { ...scheduled.clip, trimEndSourceFrame: scheduled.clip.trimEndSourceFrame + Math.ceil(extend * scheduled.asset.sourceFps! / project.output.fps * (scheduled.clip.playbackRate ?? 1)) }
    : { ...scheduled.clip, holdEndFrames: scheduled.clip.holdEndFrames + extend }) : scheduled.clip;
  const { clip, asset } = scheduled, p = project.presentation, view = clipView(clip);
  const cutPass = useCutoutPass(), shown = passAsset(project, asset, cutPass);
  const slide = view.main === 'slides' ? slideForClipFrame(project, scheduled, frame) : null;
  const slideAsset = slide ? project.assets.find((a) => a.id === slide.assetId) : undefined;
  // Screen, slides and camera share one frame (the recording's shape) so switching shots never changes the window size.
  const contentW = asset.width!, contentH = asset.height!;
  const padding = Math.min(p.padding + p.inset, Math.min(width, height) * 0.45);
  const availableW = width - padding * 2, availableH = height - padding * 2;
  // Footage (no pointer trace) in a film fills the frame and centres on the face (view.focus) when the shapes differ.
  const cover = !!p.cameraFill && view.main === 'screen' && !view.layout && !asset.trace?.cursor?.length && !/^Blank canvas/.test(asset.name);
  const fit = cover ? Math.max(availableW / contentW, availableH / contentH) : Math.min(availableW / contentW, availableH / contentH);
  const legacyW = contentW * fit, legacyH = contentH * fit, aim = cover ? view.focus ?? { x: 0.5, y: 0.5 } : { x: 0.5, y: 0.5 };
  const originX = cover ? Math.max(width - legacyW, Math.min(0, width / 2 - aim.x * legacyW)) : (width - legacyW) / 2;
  const originY = cover ? Math.max(height - legacyH, Math.min(0, height / 2 - aim.y * legacyH)) : (height - legacyH) / 2;
  const visual = evaluateMotionAtFrame(clip, frame).primary;
  const pane = primaryRect({ x: originX, y: originY, width: legacyW, height: legacyH }, visual, width, height);
  const crop = sourceCropRect(contentW, contentH, visual.crop, pane.width, pane.height);
  const paneW = crop.width, paneH = crop.height;
  const zoom = clip.zooms.find((z) => frame >= z.startClipFrame && frame < z.endClipFrame);
  const amount = zoomAmount(zoom, frame);
  // Timeline automation zooms/pans whatever is in front; a clip's own zoom (older edits) multiplies on top.
  const timelineFrame = scheduled.startFrame + rawFrame;
  const clipScale = 1 + ((zoom?.scale ?? 1) - 1) * amount, scale = clipScale * automationValue(project, 'zoom', timelineFrame);
  const focusX = zoom && amount > 0 ? zoom.x : automationValue(project, 'panX', timelineFrame), focusY = zoom && amount > 0 ? zoom.y : automationValue(project, 'panY', timelineFrame);
  const x = Math.max(paneW * (1 - scale), Math.min(0, paneW / 2 - focusX * paneW * scale));
  const y = Math.max(paneH * (1 - scale), Math.min(0, paneH / 2 - focusY * paneH * scale));
  const angle = p.shadow.angle * Math.PI / 180;
  const trace = asset.sourceCursorHidden && view.main === 'screen' ? asset.trace : undefined;
  const ms = sourceTimeSeconds(clip, asset, frame, fps) * 1000;
  let pointer: [number, number] | null = null, pointerAt: [number, number] | null = null;
  if (trace?.cursor.length && ms >= trace.cursor[0]![0]) {
    const samples = trace.cursor; let lo = 0, hi = samples.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid]![0] <= ms) lo = mid; else hi = mid; }
    const a = samples[lo]!, b = samples[hi]!;
    const mix = b[0] === a[0] || b[0] - a[0] > 100 ? 0 : Math.max(0, Math.min(1, (ms - a[0]) / (b[0] - a[0])));
    const point = ms >= b[0] ? b : [ms, a[1] + (b[1] - a[1]) * mix, a[2] + (b[2] - a[2]) * mix];
    pointer = [point[1]! / trace.viewport.width * paneW, point[2]! / trace.viewport.height * paneH];
    pointerAt = [point[1]! / trace.viewport.width, point[2]! / trace.viewport.height];
  }
  const click = frame < playbackFrames && project.cursor.clickFeedback && trace?.actions.filter((a) => a.kind === 'click' && a.t <= ms && ms - a.t < 220).at(-1);
  const clickProgress = click ? (ms - click.t) / 220 : null;
  const size = project.cursor.size * (trace ? paneW / trace.viewport.width : 1);
  const press = click && ms - click.t < 100 ? 1 - 0.12 * Math.sin(Math.PI * (ms - click.t) / 100) : 1;
  // Main-picture automation: slide (whips), rotation, blur and opacity move the whole shot as one.
  const shiftX = automationValue(project, 'shiftX', timelineFrame), shiftY = automationValue(project, 'shiftY', timelineFrame), rotate = automationValue(project, 'rotate', timelineFrame);
  const blur = automationValue(project, 'blur', timelineFrame), opacity = automationValue(project, 'opacity', timelineFrame);
  const grade = gradeFilter(automationValue(project, 'saturation', timelineFrame), automationValue(project, 'contrast', timelineFrame));
  const tiltX = automationValue(project, 'tiltX', timelineFrame), tiltY = automationValue(project, 'tiltY', timelineFrame);
  const moved = shiftX || shiftY || rotate || tiltX || tiltY ? `${tiltX || tiltY ? `perspective(${width * 1.1}px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) ` : ''}translate(${shiftX * width}px,${shiftY * height}px) rotate(${rotate}deg)` : undefined;
  // Motion blur: when the picture slides (whips, pushes), smear it along the direction it travels this frame.
  const speedX = Math.abs(shiftX - automationValue(project, 'shiftX', timelineFrame - 1)) * width, speedY = Math.abs(shiftY - automationValue(project, 'shiftY', timelineFrame - 1)) * height;
  const cheap = useCheapEffects(), streakId = `picture-streak-${scheduled.clip.id.replace(/[^a-zA-Z0-9_-]/g, '')}`, streaking = !cheap && (speedX > 1 || speedY > 1);
  // Desktop preview: the slide's motion blur as one GPU blur instead of a CPU-rendered SVG filter (see media-video.tsx).
  const cheapStreak = cheap && (speedX > 1 || speedY > 1) ? `blur(${Math.min(40, Math.max(speedX, speedY) * 0.12).toFixed(1)}px)` : '';
  const cardStyle = (rect: Rect): React.CSSProperties => ({ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height, borderRadius: p.radius, overflow: 'hidden', background: cutPass ? 'transparent' : '#000',
    boxShadow: cutPass ? undefined : `${Math.cos(angle) * p.shadow.distance}px ${Math.sin(angle) * p.shadow.distance}px ${p.shadow.blur}px rgba(0,0,0,${p.shadow.opacity})` });
  // Several sources at once (side by side, stacked, picture-in-picture, grid), or one extra window/camera on its own.
  const area = { x: padding, y: padding, width: availableW, height: availableH }, gap = Math.min(width, height) * 0.02;
  const tiles = view.layout ? layoutTiles(view.layout, area, gap) : view.main.startsWith('src-') ? [{ source: view.main, rect: area, inset: false }] : null;
  const screenTrace = asset.sourceCursorHidden ? asset.trace : undefined;
  const cursorIn = (w: number, h: number) => {
    if (cutPass || !pointerAt || !screenTrace || project.cursor.style === 'none') return null;
    const s = project.cursor.size * w / screenTrace.viewport.width;
    return <div style={{ position: 'absolute', left: pointerAt[0] * w, top: pointerAt[1] * h, pointerEvents: 'none' }}>
      {project.cursor.style === 'glass' ? <div style={{ width: s, height: s, position: 'absolute', borderRadius: '50%', transform: `translate(-50%,-50%) scale(${press})`,
        background: 'linear-gradient(135deg,rgba(255,255,255,.38),rgba(235,242,255,.12))', border: `${s / 30}px solid rgba(255,255,255,.7)`, backdropFilter: `blur(${s / 9}px)`, boxSizing: 'border-box', boxShadow: `0 ${s / 18}px ${s / 6}px #0005`, opacity: 0.85 }} />
        : <svg width={s} height={s * 1.4} viewBox="0 0 24 32" style={{ position: 'absolute', left: -s / 8, top: -s / 16, transform: `scale(${press})`, transformOrigin: '3px 2px', filter: 'drop-shadow(0 2px 3px #0008)' }}><path d="M3 2 L3 25 L9 19 L14 29 L18 27 L13 17 L22 16 Z" fill="white" stroke="#161622" strokeWidth="1.4" strokeLinejoin="round" /></svg>}
      {clickProgress !== null && <div style={{ position: 'absolute', width: s * (1 + clickProgress * 0.8), height: s * (1 + clickProgress * 0.8), transform: 'translate(-50%,-50%)', borderRadius: '50%', border: `${s / 25}px solid rgba(255,255,255,${0.6 * (1 - clickProgress)})` }} />}
    </div>;
  };
  const renderTile = (source: ShotSource, rect: Rect, index: number) => {
    if (source === 'screen') { if (!shown) return null; const { card } = fitRect(rect, contentW, contentH, false);
      // The main tile takes the timeline zoom and pan, like the single-shot picture.
      const z = index === 0 ? scale : 1, w = card.width, h = card.height, fx = index === 0 ? focusX : 0.5, fy = index === 0 ? focusY : 0.5;
      const tx = Math.max(w * (1 - z), Math.min(0, w / 2 - fx * w * z)), ty = Math.max(h * (1 - z), Math.min(0, h / 2 - fy * h * z));
      return <div key={source} data-shot-tile="screen" style={cardStyle(card)}><div style={{ position: 'absolute', width: w, height: h, transformOrigin: '0 0', transform: `translate(${tx}px,${ty}px) scale(${z})` }}>
        <PrimaryClipMedia silent clip={mediaClip} asset={asset} fps={fps} playbackFrames={playbackFrames} src={assetPath(shown.file)} style={{ position: 'absolute', width: w, height: h }} />{cursorIn(w, h)}</div></div>; }
    if (source === 'slides') { if (cutPass) return null; const page = slideForClipFrame(project, scheduled, frame), image = page ? project.assets.find(a => a.id === page.assetId) : undefined; if (!image) return null;
      const { card } = fitRect(rect, image.width ?? 16, image.height ?? 9, false);
      return <div key={source} data-shot-tile="slides" style={cardStyle(card)}><Img src={assetPath(image.file)} style={{ position: 'absolute', width: '100%', height: '100%', objectFit: 'contain' }} /></div>; }
    return <SyncedTile key={source} project={project} scheduled={scheduled} source={source} rect={rect} assetPath={assetPath} style={cardStyle} playbackFrames={playbackFrames} />;
  };

  return <AbsoluteFill style={{ isolation: 'isolate', opacity: (fadeIn > 0 ? Math.min(1, (rawFrame + 1) / (fadeIn + 1)) : 1) * opacity, transform: moved,
    filter: [streaking ? `url(#${streakId})` : cheapStreak, blur > 0.2 ? `blur(${blur * height / 1080}px)` : '', grade].filter(Boolean).join(' ') || undefined,
    ...(cheap ? { willChange: 'transform, filter' } : {}) }}>
    {streaking ? <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true"><filter id={streakId} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation={`${Math.min(120, speedX * 0.4).toFixed(1)} ${Math.min(120, speedY * 0.4).toFixed(1)}`} /></filter></svg> : null}
    {!cutPass && clip.motion.canvas.kind !== 'inherit' && <AbsoluteFill style={{ background: clip.motion.canvas.kind === 'gradient'
      ? `linear-gradient(${clip.motion.canvas.angle}deg,${clip.motion.canvas.color},${clip.motion.canvas.color2})` : clip.motion.canvas.color }} />}
    {tiles ? tiles.map((tile, index) => renderTile(tile.source, tile.rect, index)) : null}
    {!tiles && view.main !== 'camera' && (!cutPass || (view.main === 'screen' && shown)) && <div data-motion-primary data-shot={view.main} style={{ ...motionWindowStyle(pane, visual, height),
    borderRadius: p.radius, overflow: 'hidden', boxShadow: cutPass ? undefined : `${Math.cos(angle) * p.shadow.distance}px ${Math.sin(angle) * p.shadow.distance}px ${p.shadow.blur}px rgba(0,0,0,${p.shadow.opacity})` }}>
    <div style={{ position: 'absolute', left: crop.x, top: crop.y, width: paneW, height: paneH }}>
    <div style={{ position: 'absolute', width: paneW, height: paneH, transformOrigin: '0 0', transform: `translate(${x}px,${y}px) scale(${scale})` }}>
      {view.main === 'screen' ? <PrimaryClipMedia silent clip={mediaClip} asset={asset} fps={fps} playbackFrames={playbackFrames} src={assetPath((shown ?? asset).file)}
        style={{ position: 'absolute', width: paneW, height: paneH }} />
        : slideAsset ? <><Img src={assetPath(slideAsset.file)} style={{ position: 'absolute', width: paneW, height: paneH, objectFit: 'cover', filter: `blur(${Math.round(paneW / 40)}px) brightness(0.75)`, transform: 'scale(1.12)' }} />
          <Img src={assetPath(slideAsset.file)} style={{ position: 'absolute', width: paneW, height: paneH, objectFit: 'contain' }} /></> : null}
      {!cutPass && pointer && project.cursor.style !== 'none' && <div style={{ position: 'absolute', left: pointer[0], top: pointer[1], pointerEvents: 'none' }}>
        {project.cursor.style === 'glass' ? <div style={{ width: size, height: size, position: 'absolute', borderRadius: '50%', transform: `translate(-50%,-50%) scale(${press})`,
          background: 'linear-gradient(135deg,rgba(255,255,255,.38),rgba(235,242,255,.12))', border: `${size / 30}px solid rgba(255,255,255,.7)`,
          backdropFilter: `blur(${size / 9}px)`, boxSizing: 'border-box', boxShadow: `0 ${size / 18}px ${size / 6}px #0005`, opacity: 0.85 }} />
          : <svg width={size} height={size * 1.4} viewBox="0 0 24 32" style={{ position: 'absolute', left: -size / 8, top: -size / 16, transform: `scale(${press})`, transformOrigin: '3px 2px', filter: 'drop-shadow(0 2px 3px #0008)' }}><path d="M3 2 L3 25 L9 19 L14 29 L18 27 L13 17 L22 16 Z" fill="white" stroke="#161622" strokeWidth="1.4" strokeLinejoin="round" /></svg>}
        {clickProgress !== null && <div style={{ position: 'absolute', width: size * (1 + clickProgress * 0.8), height: size * (1 + clickProgress * 0.8),
          transform: 'translate(-50%,-50%)', borderRadius: '50%', border: `${size / 25}px solid rgba(255,255,255,${0.6 * (1 - clickProgress)})` }} />}
      </div>}
    </div>
    </div>
    </div>}
    {cutPass ? null : <MotionLayers clip={clip} project={project} assetPath={assetPath} />}
  </AbsoluteFill>;
}

/** An extra window or camera (or the main camera inside a layout), played in sync with this clip of the screen take. */
function SyncedTile({ project, scheduled, source, rect, assetPath, style, playbackFrames }: { project: EditorProject; scheduled: ScheduledClip; source: ShotSource; rect: Rect;
  assetPath: (file: string) => string; style: (rect: Rect) => React.CSSProperties; playbackFrames: number }) {
  const { fps } = useVideoConfig();
  const cutPass = useCutoutPass(), take = syncedTake(project, source, scheduled.asset.id), recorded = take && project.assets.find(a => a.id === take.assetId);
  const media = recorded ? passAsset(project, recorded, cutPass) : null;
  if (!take || !media?.sourceFrames || !media.sourceFps || !media.width || !media.height) return null;
  const rate = scheduled.clip.playbackRate, mediaSeconds = media.sourceFrames / media.sourceFps;
  let start = scheduled.clip.trimStartSourceFrame / scheduled.asset.sourceFps! - take.offsetSeconds, lead = 0;
  if (start < 0) { lead = Math.ceil(-start * fps / rate - 1e-9); start += lead * rate / fps; }
  const duration = Math.min(playbackFrames - lead, Math.floor((mediaSeconds - start) * fps / rate + 1e-9));
  const cover = isCameraSource(project, source), { card, media: fitted } = fitRect(rect, media.width, media.height, cover);
  const focus = clipView(scheduled.clip).focus, placed = cover && focus ? { ...fitted, x: Math.max(card.width - fitted.width, Math.min(0, card.width / 2 - focus.x * fitted.width)), y: Math.max(card.height - fitted.height, Math.min(0, card.height / 2 - focus.y * fitted.height)) } : fitted;
  return <div data-shot-tile={source} style={style(card)}>
    {duration >= 1 ? <Sequence from={lead} durationInFrames={duration} layout="none">
      <MediaVideo src={assetPath(media.file)} trimBefore={start * fps} playbackRate={rate} muted maxCanvasSinkFrameSize={{ width: previewVideoFrameWidth }} style={{ position: 'absolute', left: placed.x, top: placed.y, width: placed.width, height: placed.height }} />
    </Sequence> : null}
  </div>;
}

/** Draws the edit as its chosen platform format sees it (see deliveredProject); without a format, the edit itself. */
/** `codeScenes`: 'placeholder' draws code scenes as labelled boxes without loading their code (scene-layer.tsx). */
export function EditorComposition({ project: edit, fonts, codeScenes }: { project: EditorProject; fonts?: FontFace[]; codeScenes?: CodeScenes['mode'] }) {
  const project = React.useMemo(() => deliveredProject(edit), [edit]);
  const scenes = React.useMemo<CodeScenes>(() => ({ mode: codeScenes ?? 'run', fonts }), [codeScenes, fonts]);
  return <CodeScenesContext.Provider value={scenes}><EditorFrame project={project} fonts={fonts} /></CodeScenesContext.Provider>;
}

function EditorFrame({ project, fonts }: { project: EditorProject; fonts?: FontFace[] }) {
  const environment = useRemotionEnvironment();
  const assetPath = (file: string) => environment.isPlayer ? assetHref(file) : staticFile(file);
  loadFaces(fonts, assetPath);
  const bg = project.presentation.background, background = bg.kind === 'gradient' ? `linear-gradient(${bg.angle}deg,${bg.color},${bg.color2})` : bg.kind === 'solid' ? bg.color : '#000';
  const image = bg.kind === 'image' ? project.assets.find((a) => a.id === bg.assetId) : null;
  const schedule = scheduleProject(project), videoPlan = cutVideoPlan(project, schedule);
  const dips = React.useMemo(() => dipPlan(project, schedule), [project]);
  const sound = React.useMemo(() => soundLayers(project), [project]);
  return <AbsoluteFill style={{ backgroundColor: '#000' }}>
    <AbsoluteFill style={{ background, ...(image ? { backgroundImage: `url(${assetPath(image.file)})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}),
      filter: `blur(${project.presentation.blur}px)`, transform: project.presentation.blur ? 'scale(1.08)' : undefined }} />
    {schedule.map((s, index) => <Sequence key={s.clip.id} from={s.startFrame} durationInFrames={s.durationFrames + videoPlan[index]!.extend}
      premountFor={Math.min(project.output.fps, s.startFrame)}>
      <SourceClip scheduled={s} project={project} assetPath={assetPath} extend={videoPlan[index]!.extend} fadeIn={videoPlan[index]!.fadeIn} playOn={videoPlan[index]!.playOn} />
    </Sequence>)}
    {/* Clip sound lives in its own layer so every cut crossfades instead of clicking or dropping out. */}
    {/* The layers (and the audio tracks' below) come from sound-layers.ts, which the worker's FFmpeg export mixes too. */}
    {sound.filter(layer => layer.key.startsWith('audio-')).map(layer => <Sequence key={layer.key} from={layer.from} durationInFrames={layer.duration} premountFor={layer.premountFor}>
      <Audio src={assetPath(project.assets.find(a => a.id === layer.assetId)!.file)} trimBefore={layer.trimBefore} playbackRate={layer.playbackRate} volume={layer.volume} />
    </Sequence>)}
    <PresenterLayer project={project} assetPath={assetPath}/>
    {/* The cut-out pass decodes the footage a second time: only when a layer actually sits behind the subject. */}
    {project.cutouts?.length && project.layers?.some(layer => layer.behind) ? <>
      <LayerStack project={project} assetPath={assetPath} pass="behind" />
      {/* The subject again, cut out, on top of the behind-layers. */}
      <CutoutPass.Provider value={true}><AbsoluteFill style={{ zIndex: 1003, pointerEvents: 'none' }}>
        {schedule.map((s, index) => <Sequence key={`cut-${s.clip.id}`} from={s.startFrame} durationInFrames={s.durationFrames + videoPlan[index]!.extend} premountFor={Math.min(project.output.fps, s.startFrame)}>
          <SourceClip scheduled={s} project={project} assetPath={assetPath} extend={videoPlan[index]!.extend} fadeIn={videoPlan[index]!.fadeIn} playOn={videoPlan[index]!.playOn} />
        </Sequence>)}
        <PresenterLayer project={project} assetPath={assetPath}/>
      </AbsoluteFill></CutoutPass.Provider>
    </> : null}
    <LayerStack project={project} assetPath={assetPath} />
    <DipLayer dips={dips} />
    {sound.filter(layer => !layer.key.startsWith('audio-')).map(layer => <Sequence key={layer.key} from={layer.from} premountFor={layer.premountFor} durationInFrames={layer.duration}>
      <Audio src={assetPath(project.assets.find(a => a.id === layer.assetId)!.file)} trimBefore={layer.trimBefore} volume={layer.volume} />
    </Sequence>)}
    <EditorCaptions project={project} />
  </AbsoluteFill>;
}

/** Dips to black or white at cuts, and the film's fade up / fade out, over the whole picture. */
function DipLayer({ dips }: { dips: Dip[] }) {
  const frame = useCurrentFrame(), active = dips.map(d => ({ d, o: dipOpacity(d, frame) })).filter(x => x.o > 0);
  if (!active.length) return null; const top = active.reduce((a, b) => b.o > a.o ? b : a);
  return <AbsoluteFill style={{ backgroundColor: top.d.color, opacity: top.o, zIndex: 2000, pointerEvents: 'none' }} />;
}

function EditorCaptions({ project }: { project: EditorProject }) {
  const frame = useCurrentFrame(), c = project.captions;
  if (!c.enabled) return null;
  const rows = transcriptWords(project), activeIndex = rows.findIndex(w => frame >= w.startFrame && frame < w.endFrame);
  let anchor = activeIndex;
  if (anchor < 0) { anchor = rows.reduce((last, w, index) => w.endFrame <= frame ? index : last, -1); if (anchor < 0 || frame - rows[anchor]!.endFrame > project.output.fps * .5) return null; }
  const first = Math.floor(anchor / c.maxWords) * c.maxWords, group = rows.slice(first, first + c.maxWords);
  if (!group.length || frame < group[0]!.startFrame || frame >= group.at(-1)!.endFrame + project.output.fps * .5) return null;
  const spoken = group.filter(w => w.startFrame <= frame), visible = c.reveal === 'line' || c.lineGrowth === 'full' ? group : spoken;
  const dark = c.color === 'dark', align = c.lineGrowth === 'expanding' ? 'left' : 'center';
  return <div style={{ position: 'absolute', left: `${c.x * 100}%`, top: `${c.y * 100}%`, transform: 'translate(-50%,-50%)', maxWidth: '90%', width: c.lineGrowth === 'full' ? '84%' : undefined,
    textAlign: align, color: dark ? '#101014' : '#fff', fontFamily: c.font === 'serif' ? 'Georgia,serif' : c.font === 'mono' ? 'monospace' : 'Arial,sans-serif', fontSize: c.fontSize, lineHeight: 1.35, zIndex: 10 }}>
    <span style={{ display: 'inline-block', padding: '.26em .55em', borderRadius: '.22em', background: dark ? '#fffffff0' : '#101018e8' }}>
      {visible.map((w, i) => { const started = frame >= w.startFrame, progress = Math.min(1, Math.max(0, (frame - w.startFrame + 1) / 6));
        const opacity = c.reveal === 'word' && !started ? 0 : c.wordAnimation === 'fade' && started ? progress : 1;
        return <React.Fragment key={w.id}>{i ? ' ' : ''}<span style={{ display: 'inline-block', opacity, color: frame >= w.startFrame && frame < w.endFrame ? (dark ? '#5833bd' : '#c2b1ff') : undefined,
          transform: c.wordAnimation === 'slide' && started ? `translateY(${(1 - progress) * .25}em)` : undefined }}>{project.captionCorrections[w.wordId] ?? w.text}</span></React.Fragment>;
      })}
    </span>
  </div>;
}
