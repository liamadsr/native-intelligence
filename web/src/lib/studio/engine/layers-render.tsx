import React, { useId } from 'react';
import { MediaVideo, useCheapEffects } from './media-video';
import { AbsoluteFill, Img, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { EditorProject } from './contracts';
import { automationValue } from './automation';
import { particleFrame, ease as easeCurve, type ParticleForm } from './particles';
import { markup, iconTimes, evaluateLayer, expoOut, kineticUnit, unitMotion, unitProgress, wordProgress, type EditorLayer, type LayerState, type LayerStyle, countProgress, typedLength, layerValue, weightNumber } from './layers';
import { fontStack } from './font-faces';
import { CodeLayer } from './scene-layer';
import { useAudioData, visualizeAudio } from '@remotion/media-utils';

/** Crisp type: real kerning, geometric rendering, no faux bold (every weight is a real one from the font). */
const typeQuality: React.CSSProperties = { fontKerning: 'normal', textRendering: 'geometricPrecision', WebkitFontSmoothing: 'antialiased', fontOpticalSizing: 'auto', fontSynthesis: 'none' } as React.CSSProperties;
/** Default letter spacing: display type a touch tight, big text tighter, small text untouched. */
const defaultTracking = (font: string | undefined, size: number, unit: number) => font === 'heavy' ? -0.02 : font === 'display' || size > 70 * unit ? -0.03 : size > 40 * unit ? -0.015 : 0;
/** Text shadows that read as light, not as a 2010 drop shadow. */
function textShadow(kind: LayerStyle['shadow'], unit: number, glowColor: string) {
  if (!kind) return undefined;
  if (kind === 'hard') return `0 ${4 * unit}px ${18 * unit}px rgba(0,0,0,.45)`;
  if (kind === 'lifted') return `0 ${2 * unit}px ${4 * unit}px rgba(0,0,0,.18), 0 ${14 * unit}px ${42 * unit}px rgba(0,0,0,.30)`;
  if (kind === 'glow') return `0 0 ${10 * unit}px ${glowColor}cc, 0 0 ${32 * unit}px ${glowColor}88, 0 0 ${80 * unit}px ${glowColor}55`;
  return `0 ${1 * unit}px ${2 * unit}px rgba(0,0,0,.10), 0 ${8 * unit}px ${28 * unit}px rgba(0,0,0,.16)`;
}
const featureSettings = (features?: string[]) => features?.length ? features.map(f => { const [tag, on] = f.split(' '); return `"${tag}" ${on ?? 1}`; }).join(', ') : undefined;
const variationSettings = (axes?: Record<string, number>) => axes && Object.keys(axes).length ? Object.entries(axes).map(([k, v]) => `"${k}" ${v}`).join(', ') : undefined;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Directional blur (px along x and y). CSS blur() is round; motion blur needs a streak along the direction of travel,
 * so this renders a tiny SVG filter and returns the CSS to use it. Zero blur returns nothing.
 */
function useStreak(x: number, y: number): [React.ReactNode, string | undefined] {
  const id = `streak-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`, cheap = useCheapEffects();
  if (x < 0.3 && y < 0.3) return [null, undefined];
  if (cheap) return [null, `blur(${(Math.max(x, y) * 0.4).toFixed(1)}px)`];
  return [<svg key={id} width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true"><filter id={id} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={`${x.toFixed(2)} ${y.toFixed(2)}`} /></filter></svg>, `url(#${id})`];
}
const joinFilters = (...items: (string | undefined | false)[]) => items.filter(Boolean).join(' ') || undefined;

/** Every timeline layer, drawn above the picture and camera, below captions. Backgrounds go first. Shared by the Player and the export. */
/** pass 'behind' = only layers under the subject cut-out; 'front' = the rest (default). */
export function LayerStack({ project, assetPath, pass = 'front' }: { project: EditorProject; assetPath: (file: string) => string; pass?: 'behind' | 'front' }) {
  const frame = useCurrentFrame(), { width, height, fps } = useVideoConfig();
  const cut = !!project.cutouts?.length && !!project.layers?.some(layer => layer.behind), layers = (project.layers ?? []).filter(layer => (pass === 'behind') === (cut && !!layer.behind));
  if (!layers.length) return null;
  const view = (layer: EditorLayer) => { const state = evaluateLayer(layer, frame, fps);
    return state.visible ? <LayerView key={layer.id} layer={layer} state={state} previous={evaluateLayer(layer, frame - 1, fps)} frame={frame} width={width} height={height} fps={fps} project={project} assetPath={assetPath} /> : null; };
  // The graphics camera (camZoom / camX / camY / camRotate lanes) moves every graphic layer together; backgrounds and captions stay put.
  const cam = { zoom: automationValue(project, 'camZoom', frame), x: automationValue(project, 'camX', frame), y: automationValue(project, 'camY', frame), roll: automationValue(project, 'camRotate', frame) };
  const moved = cam.zoom !== 1 || cam.x !== 0 || cam.y !== 0 || cam.roll !== 0, fixed = (layer: EditorLayer) => layer.kind === 'background' || layer.track === 'captions';
  // Above the webcam bubble (z 1001): title cards cover it and callouts can sit on it. Behind-layers sit under the cut-out pass.
  return <AbsoluteFill style={{ pointerEvents: 'none', overflow: 'hidden', zIndex: pass === 'behind' ? 1002 : 1004 }}>
    {layers.filter(layer => layer.kind === 'background').map(view)}
    <AbsoluteFill style={moved ? { transform: `translate(${cam.x * width}px, ${cam.y * height}px) rotate(${cam.roll}deg) scale(${cam.zoom})`, transformOrigin: '50% 50%' } : undefined}>
      {layers.filter(layer => !fixed(layer)).map(view)}
    </AbsoluteFill>
    {layers.filter(layer => layer.kind !== 'background' && layer.track === 'captions').map(view)}
  </AbsoluteFill>;
}

function LayerView({ layer, state, previous, frame, width, height, fps, project, assetPath }: { layer: EditorLayer; state: LayerState; previous: LayerState; frame: number; width: number; height: number; fps: number; project: EditorProject; assetPath: (file: string) => string }) {
  const unit = height / 1080, s = layer.style;
  const cx = (state.x + state.dx) * width, cy = (state.y + state.dy) * height;
  // Motion blur: how far the layer travelled since the last frame, smeared along that direction.
  const strength = s.motionBlur ?? 1, moved = previous.visible;
  const vx = moved ? Math.abs(cx - (previous.x + previous.dx) * width) : 0, vy = moved ? Math.abs(cy - (previous.y + previous.dy) * height) : 0;
  const [streakDef, streak] = useStreak(Math.min(80, vx * 0.45 * strength), Math.min(80, vy * 0.45 * strength));
  const boxW = layer.width * width, boxH = layer.height * height;
  const filter = joinFilters(streak, state.blur > 0.2 && `blur(${state.blur * unit}px)`, s.shadow && layer.kind !== 'text' && layer.kind !== 'background' && `drop-shadow(0 ${10 * unit}px ${28 * unit}px rgba(0,0,0,.28))`);
  const transform = `translate(-50%,-50%) rotate(${state.rotate}deg) scale(${Math.max(0, state.scale)})`;
  const common: React.CSSProperties = { position: 'absolute', left: cx, top: cy, transform, opacity: state.opacity, filter };
  let body: React.ReactNode;
  if (layer.kind === 'background') body = <Background layer={layer} state={state} frame={frame} fps={fps} width={width} height={height} project={project} assetPath={assetPath} filter={joinFilters(state.blur > 0.2 && `blur(${state.blur * unit}px)`)} />;
  else if (layer.kind === 'spotlight') body = <div style={{ ...common, width: boxW, height: boxH, borderRadius: (s.radius ?? 24) * unit, boxShadow: `0 0 0 ${Math.max(width, height) * 2}px rgba(0,0,0,${(s.dim ?? 0.65)})` }} />;
  else if (layer.kind === 'box' || layer.kind === 'highlight') {
    const wipe = state.wipe < 1 ? `inset(0 ${(1 - state.wipe) * 100}% 0 0 round ${(s.radius ?? 12) * unit}px)` : undefined;
    body = <div style={{ ...common, width: boxW, height: boxH, borderRadius: (s.radius ?? 12) * unit, boxSizing: 'border-box',
      border: s.stroke && (s.strokeWidth ?? 0) > 0 ? `${(s.strokeWidth ?? 4) * unit}px solid ${s.stroke}` : undefined,
      background: layer.kind === 'highlight' ? (s.background ?? '#ffd84d55') : s.background, clipPath: wipe,
      boxShadow: layer.kind === 'highlight' ? `0 0 ${24 * unit}px ${s.stroke ?? '#ffd84d'}66` : undefined }} />;
  }
  else if (layer.kind === 'arrow') body = <Arrow layer={layer} state={state} width={width} height={height} unit={unit} />;
  else if (layer.kind === 'notification') body = <Notification layer={layer} frame={frame} fps={fps} unit={unit} width={boxW} common={common} />;
  else if (layer.kind === 'card') body = <Card layer={layer} frame={frame} fps={fps} unit={unit} width={boxW} common={common} project={project} assetPath={assetPath} />;
  else if (layer.kind === 'chips') body = <Chips layer={layer} frame={frame} unit={unit} width={boxW} common={common} />;
  else if (layer.kind === 'waveform') body = <WaveformLayer layer={layer} state={state} frame={frame} fps={fps} w={boxW} h={boxH} unit={unit} common={common} project={project} assetPath={assetPath} />;
  else if (layer.kind === 'icons') body = <IconRow layer={layer} frame={frame} fps={fps} w={boxW} h={boxH} common={common} />;
  else if (layer.kind === 'code') body = layer.style.scene ? <CodeLayer layer={layer} project={project} assetPath={assetPath} common={common} width={width} height={height} fps={fps} /> : null;
  else if (layer.kind === 'particles') body = <Particles layer={layer} frame={frame} fps={fps} width={width} height={height} common={common} />;
  else if (layer.kind === 'ring') body = <Ring layer={layer} state={state} frame={frame} fps={fps} w={boxW} h={boxH} unit={unit} common={common} />;
  else if (layer.kind === 'image') { const asset = project.assets.find(item => item.id === layer.assetId);
    // A video asset (a captured product component, a clip) plays from the layer's start; transparent captures keep their alpha.
    const fit: React.CSSProperties = { width: '100%', height: '100%', objectFit: s.fill === 'image' ? 'cover' : asset?.kind === 'video' ? 'contain' : 'cover' };
    body = asset ? <div style={{ ...common, width: boxW, height: boxH, borderRadius: asset.kind === 'video' ? 0 : (s.radius ?? 20) * unit, overflow: asset.kind === 'video' ? 'visible' : 'hidden' }}>
      {asset.kind === 'video' ? <Sequence from={layer.startFrame} layout="none"><MediaVideo src={assetPath(asset.file)} muted style={fit} /></Sequence> : <Img src={assetPath(asset.file)} style={fit} />}</div> : null; }
  else body = <TextLayer layer={layer} state={state} frame={frame} width={width} unit={unit} fps={fps} common={common} />;
  return <>{streakDef}{body}</>;
}

/** Full-frame fills for title beats: soft gradient mesh, dark glow, gradient, colour or a (blurred) photo. */
/** A colour (#rgb, #rrggbb or #rrggbbaa) at a fraction of its alpha, for gradient stops. */
function fade(color: string, k: number) {
  const hex = color.replace('#', ''), full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
  const a = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
  return `#${full.slice(0, 6)}${Math.round(Math.max(0, Math.min(1, a * k)) * 255).toString(16).padStart(2, '0')}`;
}

function Background({ layer, state, frame, fps, width, height, project, assetPath, filter }: { layer: EditorLayer; state: LayerState; frame: number; fps: number; width: number; height: number; project: EditorProject; assetPath: (file: string) => string; filter?: string }) {
  const s = layer.style, c1 = s.color ?? '#d9f2c8', c2 = s.color2 ?? '#bfe3ff', t = (frame - layer.startFrame) / fps;
  const blob = (color: string, x: number, y: number, size: number, phase: number) => <div style={{ position: 'absolute', left: `${x + Math.sin(t * 0.5 + phase) * 6}%`, top: `${y + Math.cos(t * 0.4 + phase) * 6}%`,
    width: size * Math.min(width, height) * 1.5, height: size * Math.min(width, height) * 1.5, transform: 'translate(-50%,-50%)',
    // A soft glow as a radial gradient, not a 300 px blur filter: same look, and no per-frame full-resolution blur
    // (which Safari's WebKit computes on the CPU — seconds per frame at 4K — and which slowed exports too).
    background: `radial-gradient(closest-side, ${color} 0%, ${color} 30%, ${fade(color, 0.55)} 55%, ${fade(color, 0.18)} 78%, transparent 100%)`, opacity: 0.85 }} />;
  const fill = s.fill ?? 'mesh', asset = s.fill === 'image' ? project.assets.find(item => item.id === layer.assetId) : undefined;
  return <AbsoluteFill style={{ opacity: state.opacity, filter, overflow: 'hidden', background: fill === 'solid' ? c1 : fill === 'gradient' ? `linear-gradient(135deg, ${c1}, ${c2})` : fill === 'glow' ? '#04060c' : fill === 'image' ? '#000' : '#fbfcfa' }}>
    {fill === 'mesh' ? <>{blob(c1, 22, 30, 0.9, 0)}{blob(c2, 78, 70, 0.95, 2)}{blob(`${c1}aa`, 70, 18, 0.6, 4)}</> : null}
    {fill === 'glow' ? blob(c1, 50, 50, 0.75, 1) : null}
    {asset ? <Img src={assetPath(asset.file)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${1.04 + t * 0.01})`, filter: s.blur ? `blur(${s.blur * height / 1080}px)` : undefined }} /> : null}
  </AbsoluteFill>;
}

function Arrow({ layer, state, width, height, unit }: { layer: EditorLayer; state: LayerState; width: number; height: number; unit: number }) {
  const s = layer.style, tipX = (state.x + state.dx) * width, tipY = (state.y + state.dy) * height;
  const fromX = (s.fromX ?? state.x - 0.2) * width, fromY = (s.fromY ?? state.y - 0.2) * height;
  const dx = tipX - fromX, dy = tipY - fromY, length = Math.hypot(dx, dy) || 1, bend = (s.curve ?? 0.2) * length * 0.35;
  const cX = (fromX + tipX) / 2 - dy / length * bend, cY = (fromY + tipY) / 2 + dx / length * bend;
  const stroke = s.stroke ?? '#ffd84d', w = (s.strokeWidth ?? 10) * unit, head = Math.max(18 * unit, w * 2.6);
  const angle = Math.atan2(tipY - cY, tipX - cX);
  const headPath = `M${tipX - Math.cos(angle - 0.5) * head},${tipY - Math.sin(angle - 0.5) * head} L${tipX},${tipY} L${tipX - Math.cos(angle + 0.5) * head},${tipY - Math.sin(angle + 0.5) * head}`;
  const pathLength = length * 1.15;
  return <svg width={width} height={height} style={{ position: 'absolute', inset: 0, opacity: state.opacity, overflow: 'visible',
    filter: joinFilters(s.shadow && `drop-shadow(0 ${4 * unit}px ${10 * unit}px rgba(0,0,0,.45))`, state.blur > 0.2 && `blur(${state.blur * unit}px)`),
    transform: state.scale !== 1 || state.rotate ? `rotate(${state.rotate}deg) scale(${state.scale})` : undefined, transformOrigin: `${tipX}px ${tipY}px` }}>
    <path d={`M${fromX},${fromY} Q${cX},${cY} ${tipX},${tipY}`} fill="none" stroke={stroke} strokeWidth={w} strokeLinecap="round" strokeDasharray={pathLength} strokeDashoffset={pathLength * (1 - state.draw)} />
    {state.draw > 0.85 ? <path d={headPath} fill="none" stroke={stroke} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" opacity={(state.draw - 0.85) / 0.15} /> : null}
  </svg>;
}

const glass = (unit: number, dark = false): React.CSSProperties => ({ background: dark ? 'rgba(28,28,32,.62)' : 'rgba(246,246,248,.74)', backdropFilter: `blur(${34 * unit}px) saturate(180%)`, WebkitBackdropFilter: `blur(${34 * unit}px) saturate(180%)`,
  border: `${1 * unit}px solid rgba(255,255,255,.55)`, boxShadow: `0 ${14 * unit}px ${40 * unit}px rgba(0,0,0,.18)` });
/** How much of a message has typed in by now (starts once the card has mostly landed). */
const typed = (text: string, layer: EditorLayer, frame: number, fps: number) => text.slice(0, typedLength(text.length, layer, frame, fps));

function Notification({ layer, frame, fps, unit, width, common }: { layer: EditorLayer; frame: number; fps: number; unit: number; width: number; common: React.CSSProperties }) {
  const s = layer.style, size = (s.size ?? 0.022) * 1080 * unit;
  return <div style={{ ...common, width, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: size * 0.8, padding: `${size * 0.75}px ${size * 0.9}px`, borderRadius: size * 1.1,
    fontFamily: fontStack(s.font ?? 'sans'), ...typeQuality, fontSize: size, lineHeight: 1.25, letterSpacing: '-0.005em', color: '#111', ...(s.glass === false ? { background: s.background ?? '#fff' } : glass(unit)) }}>
    <div style={{ flex: 'none', width: size * 2.3, height: size * 2.3, borderRadius: size * 0.55, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 1.35,
      background: s.background ?? 'linear-gradient(180deg,#fff,#e9e9ee)', boxShadow: `0 ${unit * 2}px ${unit * 6}px rgba(0,0,0,.15)` }}>{s.icon ?? '🔔'}</div>
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ fontWeight: 600 }}>{s.app ?? 'Notification'}</div>
      {s.title ? <div style={{ fontWeight: 500 }}>{s.title}</div> : null}
      <div style={{ opacity: 0.86, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{typed(s.text ?? '', layer, frame, fps)}&#8203;</div>
    </div>
  </div>;
}

function Card({ layer, frame, fps, unit, width, common, project, assetPath }: { layer: EditorLayer; frame: number; fps: number; unit: number; width: number; common: React.CSSProperties; project: EditorProject; assetPath: (file: string) => string }) {
  const s = layer.style, size = (s.size ?? 0.034) * 1080 * unit, avatar = project.assets.find(item => item.id === layer.assetId);
  const bar = (w: string) => <div style={{ height: size * 0.32, width: w, borderRadius: size, background: 'rgba(0,0,0,.09)', marginTop: size * 0.45 }} />;
  return <div style={{ ...common, width, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: size * 0.9, padding: `${size * 1.1}px ${size * 1.2}px`, borderRadius: size * 1.3,
    fontFamily: fontStack(s.font ?? 'display'), ...typeQuality, fontSize: size, letterSpacing: '-0.02em', color: s.color ?? '#15161a', ...(s.glass === false ? { background: s.background ?? '#fff', boxShadow: `0 ${14 * unit}px ${40 * unit}px rgba(0,0,0,.14)` } : glass(unit)) }}>
    {avatar || s.icon ? <div style={{ flex: 'none', width: size * 2.6, height: size * 2.6, borderRadius: '50%', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 1.5, background: '#eee' }}>
      {avatar ? <Img src={assetPath(avatar.file)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : s.icon}</div> : null}
    <div style={{ minWidth: 0, flex: 1 }}>
      {s.title ? <div style={{ fontSize: size * 0.6, opacity: 0.6, marginBottom: size * 0.2 }}>{s.title}</div> : null}
      <div style={{ fontWeight: weightNumber(s.weight ?? 'medium'), whiteSpace: 'nowrap', overflow: 'hidden' }}>{typed(s.text ?? '', layer, frame, fps)}&#8203;</div>
      {bar('82%')}{bar('58%')}
    </div>
  </div>;
}

function Chips({ layer, frame, unit, width, common }: { layer: EditorLayer; frame: number; unit: number; width: number; common: React.CSSProperties }) {
  const s = layer.style, size = (s.size ?? 0.026) * 1080 * unit, local = frame - layer.startFrame, stagger = s.stagger ?? 9;
  return <div style={{ ...common, width, display: 'flex', flexDirection: 'column', alignItems: s.align === 'right' ? 'flex-end' : s.align === 'center' ? 'center' : 'flex-start', gap: size * 0.55, fontFamily: fontStack(s.font ?? 'sans'), ...typeQuality, fontSize: size }}>
    {(s.items ?? []).map((item, index) => { const t = clamp01((local + 1 - index * stagger) / Math.max(1, layer.enter.frames)), e = expoOut(t);
      if (t <= 0) return <div key={index} style={{ height: size * 2.1 }} />;
      return <div key={index} style={{ display: 'flex', alignItems: 'center', gap: size * 0.5, padding: `${size * 0.5}px ${size * 0.95}px ${size * 0.5}px ${size * 0.6}px`, borderRadius: size * 2,
        background: s.background ?? '#f08c2e', color: s.color ?? '#fff', fontWeight: 500, whiteSpace: 'nowrap', boxShadow: `0 ${6 * unit}px ${18 * unit}px rgba(0,0,0,.18)`,
        transform: `translateX(${(1 - e) * 1.4}em) scale(${0.9 + 0.1 * e})`, opacity: Math.min(1, e * 1.6), filter: e < 0.98 ? `blur(${(1 - e) * size * 0.5}px)` : undefined }}>
        <span style={{ width: size * 1.05, height: size * 1.05, borderRadius: '50%', border: `${Math.max(1, size * 0.09)}px solid currentColor`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.68 }}>✓</span>{item}</div>; })}
  </div>;
}

/** Numbers in the text count up during the in-animation, formatted like the target ("$30,000", "4.5×"). */
function counted(text: string, layer: EditorLayer, frame: number): string {
  if (layer.style.countFrom === undefined) return text;
  const progress = countProgress(layer, frame);
  return text.replace(/\d[\d,]*(?:\.\d+)?/, match => { const target = Number(match.replace(/,/g, '')), decimals = match.split('.')[1]?.length ?? 0;
    const value = layer.style.countFrom! + (target - layer.style.countFrom!) * progress;
    return match.includes(',') ? value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : value.toFixed(decimals); });
}

/** One word or letter of kinetic text, with its own motion and (when sliding) its own streak. */
function Unit({ text, motion, size, gradient }: { text: string; motion: ReturnType<typeof unitMotion>; size: number; gradient?: React.CSSProperties }) {
  const [def, streak] = useStreak(motion.blurX * size, 0);
  return <>{def}<span style={{ display: 'inline-block', whiteSpace: 'pre', opacity: motion.opacity, ...gradient,
    transform: motion.x || motion.y || motion.scale !== 1 || motion.rotate ? `translate(${motion.x}em,${motion.y}em) rotate(${motion.rotate}deg) scale(${motion.scale})` : undefined,
    filter: joinFilters(streak, motion.blur > 0.005 && `blur(${motion.blur * size}px)`) }}>{text}</span></>;
}

function TextLayer({ layer, state, frame, width, unit, fps, common }: { layer: EditorLayer; state: LayerState; frame: number; width: number; unit: number; fps: number; common: React.CSSProperties }) {
  const s = layer.style;
  const marks = markup(counted(s.text ?? '', layer, frame));
  let text = marks.plain;
  const accentAt = (i: number) => marks.marked.has(i) ? (s.accent ?? '#3355dd') : undefined;
  if (s.uppercase) text = text.toUpperCase();
  if (s.stack) text = text.trim().split(/\s+/).join('\n');
  // fit: the longest line (a word, when stacked) is never wider than the layer — heavy caps run ≈0.7 em per letter.
  const longest = Math.max(1, ...(s.stack ? text.split(/\s+/) : text.split('\n')).map(line => line.length));
  const size = Math.min((s.size ?? 0.06) * 1080 * unit, s.fit ? layer.width * width / (longest * (s.font === 'heavy' ? 0.72 : 0.62)) : Infinity);
  const gradient: React.CSSProperties | undefined = s.color2 ? { backgroundImage: `linear-gradient(90deg, ${s.color ?? '#ffffff'}, ${s.color2})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' } : undefined;
  const stroke = s.stroke && (s.strokeWidth ?? 0) > 0 ? { WebkitTextStroke: `${(s.strokeWidth ?? 4) * unit}px ${s.stroke}`, paintOrder: 'stroke fill' } as React.CSSProperties : {};
  // Weight and letter spacing: keyframed lanes when there are any, else the style; the variable-font entrances move them.
  const lanes = new Set(layer.automation.map(lane => lane.param)), local = frame - layer.startFrame;
  let weight = lanes.has('weight') ? layerValue(layer, 'weight', frame) : weightNumber(s.weight);
  let tracking = lanes.has('tracking') ? layerValue(layer, 'tracking', frame) : s.tracking ?? defaultTracking(s.font, size, unit);
  const enterT = clamp01((local + 1) / Math.max(1, layer.enter.frames)), enterE = layer.enter.ease ? easeCurve(layer.enter.ease, enterT, layer.enter.frames / fps) : expoOut(enterT);
  if (layer.enter.preset === 'weight-in') weight = 100 + (weight - 100) * enterE;
  if (layer.enter.preset === 'track-in') tracking = tracking + 0.45 * (1 - enterE);
  const style: React.CSSProperties = { ...common, width: layer.width * width, textAlign: s.align ?? 'center', fontFamily: fontStack(s.font), ...typeQuality, fontWeight: Math.round(weight),
    fontStyle: s.italic ? 'italic' : undefined, fontFeatureSettings: featureSettings(s.features), fontVariationSettings: variationSettings(s.axes),
    fontSize: size, lineHeight: s.leading ?? (s.font === 'heavy' ? 0.9 : size > 60 * unit ? 1.04 : 1.15), letterSpacing: `${tracking}em`, color: s.color ?? '#ffffff',
    textShadow: !gradient ? textShadow(s.shadow, unit, s.accent ?? s.color ?? '#ffffff') : undefined, ...stroke,
    clipPath: state.wipe < 1 ? `inset(0 ${(1 - state.wipe) * 100}% 0 0)` : undefined, overflowWrap: 'break-word', whiteSpace: s.stack ? 'pre-line' : undefined };
  const pill = s.background ? { background: s.background, borderRadius: Math.min((s.radius ?? 12) * unit, size), padding: `${0.22 * size}px ${0.5 * size}px`, boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' } as React.CSSProperties : null;
  const swap = s.swapWords?.length ? <SwapWord layer={layer} frame={frame} fps={fps} size={size} gradient={gradient} /> : null;
  if (layer.enter.preset === 'words') {
    const found = [...text.matchAll(/\S+/g)], words = found.map(m => m[0]);
    return <div style={style}><span style={pill ?? undefined}>{words.map((word, i) => { const t = wordProgress(layer, i, frame, fps);
      if (t <= 0) return null;
      const pop = t >= 1 ? 1 : 0.55 + 0.45 * (1 - Math.pow(1 - t, 3)) + Math.sin(t * Math.PI) * 0.12;
      return <React.Fragment key={i}>{i ? (s.stack ? <br /> : ' ') : ''}<span style={{ display: 'inline-block', transform: `scale(${pop}) translateY(${(1 - Math.min(1, t)) * 0.2}em)`, opacity: Math.min(1, t * 2),
        color: accentAt(found[i]!.index ?? 0) ?? (i === state.activeWord && s.accent ? s.accent : undefined) }}>{word}</span></React.Fragment>; })}</span>{swap}</div>;
  }
  const units = kineticUnit(layer.enter.preset) ?? kineticUnit(layer.exit.preset);
  if (units) {
    // Split into words (keeping the spaces) or letters; each animates on its own clock.
    const parts = units === 'words' ? text.split(/(\s+)/).filter(part => part.length) : Array.from(text);
    const animated = parts.map((part, index) => ({ part, index })).filter(item => item.part.trim().length);
    const offsets = parts.reduce<number[]>((acc, part, i) => { acc.push(i ? acc[i - 1]! + parts[i - 1]!.length : 0); return acc; }, []);
    return <div style={style}><span style={pill ?? undefined}>{parts.map((part, index) => { if (!part.trim().length) return <span key={index} style={{ whiteSpace: 'pre' }}>{part}</span>;
      const order = animated.findIndex(item => item.index === index), progress = unitProgress(layer, frame, order, animated.length, units);
      const motion = progress.exit < 1 ? unitMotion(layer.exit.preset, progress.exit, order, false, layer.exit.ease, layer.exit.frames / fps) : unitMotion(layer.enter.preset, progress.enter, order, true, layer.enter.ease, layer.enter.frames / fps);
      const tint = accentAt(offsets[index]!);
      const unit = <Unit key={index} text={part} motion={motion} size={size} gradient={tint ? undefined : gradient} />;
      return tint ? <span key={index} style={{ color: tint }}>{unit}</span> : unit; })}</span>{swap}</div>;
  }
  const shown = Number.isFinite(state.charsShown) ? text.slice(0, state.charsShown) : text, typing = Number.isFinite(state.charsShown) && state.charsShown < text.length;
  // accent runs: consecutive characters with the same colour become one span
  const runs: { text: string; color?: string }[] = [];
  Array.from(shown).forEach((ch, i) => { const color = accentAt(i), last = runs[runs.length - 1]; if (last && last.color === color) last.text += ch; else runs.push({ text: ch, color }); });
  const body = runs.map((run, i) => run.color ? <span key={i} style={{ color: run.color, ...(gradient ? { WebkitTextFillColor: run.color } : {}) }}>{run.text}</span> : <React.Fragment key={i}>{run.text}</React.Fragment>);
  const blink = Math.floor(frame / Math.max(1, fps / 2.4)) % 2 === 0;
  const caret = s.caret === 'line'
    ? (typing || blink ? <span style={{ display: 'inline-block', width: Math.max(2, size * 0.055), height: size * 0.95, marginLeft: size * 0.05, verticalAlign: '-0.12em', borderRadius: size, background: s.accent ?? '#3355dd' }} /> : <span style={{ display: 'inline-block', width: Math.max(2, size * 0.055), marginLeft: size * 0.05 }} />)
    : typing ? <span style={{ opacity: Math.floor(frame / Math.max(1, fps / 4)) % 2 ? 1 : 0 }}>▍</span> : null;
  return <div style={style}>{pill ? <span style={pill}>{body}</span> : <span style={gradient}>{body}</span>}{caret}{swap}</div>;
}

/** "Over 98% of ⟨Restaurants⟩ → ⟨Salons⟩ → ⟨Gyms⟩": the word after the text changes on a beat, rising in with blur. */
function SwapWord({ layer, frame, fps, size, gradient }: { layer: EditorLayer; frame: number; fps: number; size: number; gradient?: React.CSSProperties }) {
  const words = layer.style.swapWords!, every = layer.style.swapEvery ?? Math.round(fps * 0.6), local = Math.max(0, frame - layer.startFrame);
  const index = Math.floor(local / every) % words.length, t = clamp01((local % every + 1) / Math.max(2, Math.round(fps * 0.22))), e = expoOut(t);
  return <>{' '}<span style={{ display: 'inline-block', whiteSpace: 'pre', color: layer.style.accent, ...(layer.style.accent ? {} : gradient), transform: `translateY(${(1 - e) * 0.5}em)`, opacity: Math.min(1, e * 1.4),
    filter: e < 0.98 ? `blur(${(1 - e) * size * 0.3}px)` : undefined }}>{words[index]}</span></>;
}


/** A colour between two #rrggbb colours. */
function mixHex(a: string, b: string, f: number) { const p = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); const x = p(a), y = p(b); return `rgb(${x.map((v, i) => Math.round(v + (y[i]! - v) * f)).join(',')})`; }
/** Smooth 1-D value noise in 0…1: organic movement instead of a repeating sine pattern. */
function noise1(x: number, seed: number) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f), h = (n: number) => { const v = Math.sin((n + seed * 57.31) * 127.1) * 43758.5453; return v - Math.floor(v); };
  return h(i) * (1 - u) + h(i + 1) * u;
}
/** Waveform levels (0…1, one per bar) with no audio: a centre-weighted swell that moves like a voice. */
function syntheticLevels(n: number, t: number, speed: number, seed: number) {
  return Array.from({ length: n }, (_, i) => {
    const c = n > 1 ? (i - (n - 1) / 2) / ((n - 1) / 2) : 0, bell = Math.exp(-c * c * 1.7);
    const talk = 0.55 + 0.45 * noise1(t * speed * 1.3, seed + 11);                       // phrases: louder and softer stretches
    const v = 0.6 * noise1(t * speed * 2.4 + i * 0.37, seed) + 0.4 * noise1(t * speed * 6.1 + i * 0.93, seed + 3);
    return Math.min(1, 0.08 + 0.92 * bell * talk * v * 1.25);
  });
}
/** Levels from the audio playing at this frame (low frequencies in the middle, as a voice looks). */
function audioLevels(spectrum: number[], n: number, amp: number) {
  const usable = Math.max(4, Math.floor(spectrum.length * 0.55));
  return Array.from({ length: n }, (_, i) => {
    const c = n > 1 ? Math.abs((i - (n - 1) / 2) / ((n - 1) / 2)) : 0, bin = Math.min(usable - 1, Math.floor(Math.pow(c, 1.4) * usable));
    return Math.min(1, Math.sqrt(Math.max(0, spectrum[bin] ?? 0)) * 1.9 * amp * (1 - c * 0.25));
  });
}
/** The audio a waveform listens to at this frame: the voice-over (or music, or anything) playing now. */
function waveAudio(project: EditorProject, source: string, frame: number, assetPath: (file: string) => string) {
  if (source === 'synthetic') return null;
  const tracks = project.audioTracks.filter(track => !track.muted && (source === 'all' || track.role === (source === 'music' ? 'music' : 'voiceover')));
  for (const track of tracks) for (const seg of track.segments) {
    const length = (seg.trimEndSeconds - seg.trimStartSeconds) * project.output.fps;
    if (frame >= seg.startFrame && frame < seg.startFrame + length) { const asset = project.assets.find(a => a.id === seg.assetId); if (asset) return { src: assetPath(asset.file), mediaFrame: Math.round(frame - seg.startFrame + seg.trimStartSeconds * project.output.fps) }; }
  }
  return source === 'voice' || source === 'music' || source === 'all' ? { src: '', mediaFrame: 0 } : null;
}
type WaveProps = { layer: EditorLayer; state: LayerState; frame: number; fps: number; w: number; h: number; unit: number; common: React.CSSProperties; project: EditorProject; assetPath: (file: string) => string };
/** Waveform: bars (rounded capsules), dots, line (layered flowing curves), radial (around a circle) or mirror (with a soft
 *  reflection) — in a colour→colour2 gradient with an optional glow, driven by the film's own voice-over or music when
 *  `source` says so, else by a smooth voice-like swell. Grows in from the centre. */
function WaveformLayer(props: WaveProps) {
  const { layer, frame, project, assetPath } = props, s = layer.style;
  const audio = waveAudio(project, s.source ?? 'synthetic', frame, assetPath);
  if (audio?.src) return <AudioWave {...props} src={audio.src} mediaFrame={audio.mediaFrame} key={audio.src} />;
  const t = (frame - layer.startFrame) / props.fps, n = s.count ?? 48;
  // Listening to a track that's silent right now: resting bars that barely move.
  const levels = audio ? syntheticLevels(n, t, 0.4, layer.id.length).map(v => v * 0.12) : syntheticLevels(n, t, s.speed ?? 1, layer.id.length).map(v => Math.min(1, v * (s.amp ?? 1)));
  return <WaveDraw {...props} levels={levels} />;
}
function AudioWave(props: WaveProps & { src: string; mediaFrame: number }) {
  const data = useAudioData(props.src), s = props.layer.style, n = s.count ?? 48;
  const levels = data ? audioLevels(visualizeAudio({ fps: props.fps, frame: props.mediaFrame, audioData: data, numberOfSamples: 64, smoothing: true }), n, s.amp ?? 1) : new Array(n).fill(0.05);
  return <WaveDraw {...props} levels={levels} />;
}
function WaveDraw({ layer, frame, fps, w, h, unit, common, levels }: WaveProps & { levels: number[] }) {
  const s = layer.style, n = levels.length, local = frame - layer.startFrame, t = local / fps, variant = s.variant ?? 'bars', id = useId().replace(/:/g, '');
  const color = s.color ?? '#6366f1', color2 = s.color2 ?? color, glow = s.glow ?? 0;
  const grow = expoOut(clamp01(local / Math.max(1, layer.enter.frames * 1.6)));
  const reach = (i: number) => { const c = n > 1 ? Math.abs((i - (n - 1) / 2) / ((n - 1) / 2)) : 0; return clamp01(grow * 1.6 - c * 0.6); };   // the centre grows first
  const gap = s.gap ?? 0.45, round = s.roundness ?? 1;
  const defs = <defs>
    <linearGradient id={`g${id}`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={w} y2="0"><stop offset="0" stopColor={color} /><stop offset="1" stopColor={color2} /></linearGradient>
    <linearGradient id={`v${id}`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={h}><stop offset="0" stopColor={color2} /><stop offset="0.5" stopColor={color} /><stop offset="1" stopColor={color2} /></linearGradient>
    {glow > 0 ? <filter id={`f${id}`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={glow * 9 * unit} result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter> : null}
  </defs>;
  const fill = s.color2 ? `url(#g${id})` : color, filter = glow > 0 ? `url(#f${id})` : undefined;
  const svg = (children: React.ReactNode, size?: { w: number; h: number }) => <svg width={size?.w ?? w} height={size?.h ?? h} style={{ ...common, width: size?.w ?? w, height: size?.h ?? h, overflow: 'visible' }}>{defs}<g filter={filter}>{children}</g></svg>;

  if (variant === 'line') {
    // Three layered curves, each a travelling wave under the level envelope, tapering to the ends.
    const m = 72, env = (x: number) => { const p = x * (n - 1), i = Math.floor(p), f = p - i; return ((levels[i] ?? 0) * (1 - f) + (levels[i + 1] ?? levels[i] ?? 0) * f) * reach(Math.round(p)); };
    const path = (k: number) => { const pts = Array.from({ length: m + 1 }, (_, j) => { const x = j / m, taper = Math.pow(Math.sin(Math.PI * x), 1.4);
      return [x * w, h / 2 + Math.sin(x * (7 + k * 2.3) * Math.PI - t * (s.speed ?? 1) * (3.2 + k * 1.1) + k * 1.7) * env(x) * taper * h * 0.48 * (1 - k * 0.22)] as const; });
      return pts.reduce((d, [x, y], j) => { if (!j) return `M${x} ${y}`; const [px, py] = pts[j - 1]!; const mx = (px + x) / 2, my = (py + y) / 2; return `${d} Q${px} ${py} ${mx} ${my}`; }, '') + ` L${w} ${h / 2}`; };
    return svg([0, 1, 2].map(k => <path key={k} d={path(k)} fill="none" stroke={fill} strokeWidth={(s.strokeWidth ?? 3) * unit * (1 - k * 0.25)} strokeLinecap="round" opacity={[1, 0.6, 0.35][k]} />));
  }
  if (variant === 'radial') {
    const d = Math.min(w, h), R = d * 0.3, slot = (2 * Math.PI * R) / n, thick = Math.max(1, slot * (1 - gap));
    return svg(levels.map((v, i) => { const a = (i / n) * Math.PI * 2 - Math.PI / 2, len = thick + v * reach(i) * d * 0.2;
      return <line key={i} x1={w / 2 + Math.cos(a) * R} y1={h / 2 + Math.sin(a) * R} x2={w / 2 + Math.cos(a) * (R + len)} y2={h / 2 + Math.sin(a) * (R + len)} stroke={s.color2 ? mixHex(color, color2, (1 - Math.cos((i / n) * Math.PI * 2)) / 2) : color}
        strokeWidth={thick} strokeLinecap={round > 0.5 ? 'round' : 'butt'} opacity={0.55 + 0.45 * v} />; }));
  }
  const step = w / n, bar = Math.max(1, step * (1 - gap)), rx = (bar / 2) * round;
  const spikeAt = s.spike ? Math.floor(((t * 0.32) % 1) * n) : -1;
  if (variant === 'dots') {
    const dot = bar, pitch = dot * 1.35;
    return svg(levels.map((v, i) => { const height = Math.max(dot, v * reach(i) * h), count = Math.max(1, Math.round(height / pitch)), x = i * step + step / 2;
      return <g key={i}>{Array.from({ length: count }, (_, k) => <circle key={k} cx={x} cy={h / 2 + (k - (count - 1) / 2) * pitch} r={dot / 2} fill={fill} opacity={1 - Math.abs(k - (count - 1) / 2) / count * 0.6} />)}</g>; }));
  }
  const mirror = variant === 'mirror';
  const bars = (height: (i: number, v: number) => number, y: (hh: number) => number, opacity = 1, key = 'b') => levels.map((v, i) => { const hh = height(i, v);
    return <rect key={`${key}${i}`} x={i * step + (step - bar) / 2} y={y(hh)} width={bar} height={hh} rx={Math.min(rx, hh / 2)} fill={i === spikeAt ? color2 : fill} opacity={opacity} />; });
  const height = (i: number, v: number) => i === spikeAt && grow > 0.9 ? h * (mirror ? 0.56 : 1.1) : Math.max(bar, bar + (v * (mirror ? h * 0.5 : h) - bar) * reach(i));
  if (mirror) return svg(<>{bars(height, hh => h / 2 - hh)}{bars(height, () => h / 2 + bar * 0.6, 0.22, 'r')}</>);
  return svg(bars(height, hh => (h - hh) / 2));
}

/** Icons in a row, popping in one by one; the newest takes the accent colour. A toggle switches on (a cursor clicks it),
 *  bubbles burst, a dash flies off — each about 0.6 s after it appears (actAt). */
function IconRow({ layer, frame, fps, w, h, common }: { layer: EditorLayer; frame: number; fps: number; w: number; h: number; common: React.CSSProperties }) {
  const s = layer.style, items = s.items ?? [], size = Math.min(h, w / Math.max(1, items.length) * 0.7), gap = items.length > 1 ? (w - size * items.length) / (items.length - 1) : 0;
  const shown = items.filter((_, i) => frame >= iconTimes(layer, i, fps).appear).length;
  return <div style={{ ...common, width: w, height: h }}>
    {items.map((name, i) => { const { appear, act } = iconTimes(layer, i, fps), t = clamp01((frame - appear + 1) / Math.max(1, layer.enter.frames)); if (t <= 0) return null;
      const e = expoOut(t), raw = (frame - appear + 1) / Math.max(1, layer.enter.frames), sp = layer.enter.ease ? easeCurve(layer.enter.ease, Math.min(raw, 1.8), layer.enter.frames / fps) : 0, pop = layer.enter.ease ? Math.max(0, sp) : t >= 1 ? 1 : 0.6 + 0.4 * e + Math.sin(t * Math.PI) * 0.18, a = clamp01((frame - act) / Math.max(1, fps * 0.25));
      const newest = i === shown - 1, color = newest && name === 'note' ? (s.accent ?? '#3355dd') : (s.color ?? '#111118');
      return <div key={i} style={{ position: 'absolute', left: i * (size + gap), top: (h - size) / 2, width: size, height: size, transform: `scale(${pop}) translateY(${(1 - e) * 0.25 * size}px)`, opacity: Math.min(1, e * 1.8),
        filter: e < 0.97 ? `blur(${(1 - e) * size * 0.08}px)` : undefined }}>
        <Icon name={name} size={size} color={color} accent={s.accent ?? '#3355dd'} act={a} frame={frame} act0={act} fps={fps} /></div>; })}
  </div>;
}
function Icon({ name, size, color, accent, act, frame, act0, fps }: { name: string; size: number; color: string; accent: string; act: number; frame: number; act0: number; fps: number }) {
  const e = expoOut(act);
  switch (name) {
    case 'note': return <svg viewBox="0 0 24 24" width={size} height={size}><ellipse cx="8.5" cy="18" rx="4" ry="3" transform="rotate(-20 8.5 18)" fill={color} /><path d="M12 17.5V3.5c3 1.2 6 3 6 6.5" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" /></svg>;
    case 'key': return <svg viewBox="0 0 24 24" width={size} height={size}><rect x="2.5" y="2.5" width="19" height="19" rx="4.5" fill="#26272c" transform={act > 0 && act < 1 ? `translate(0 ${Math.sin(act * Math.PI) * 1.2})` : undefined} /><rect x="5" y="4.5" width="14" height="12" rx="3" fill="#3a3b42" /></svg>;
    case 'toggle': { const cursorIn = clamp01((frame - (act0 - fps * 0.45)) / (fps * 0.35)), knob = 6 + e * 12;
      return <svg viewBox="0 0 36 24" width={size * 1.5} height={size} style={{ marginLeft: -size * 0.25, overflow: 'visible' }}>
        <rect x="1" y="5" width="34" height="14" rx="7" fill={act > 0 ? accent : '#d9dbe3'} opacity={act > 0 ? 0.35 + 0.65 * e : 1} />
        <circle cx={knob + 5} cy="12" r="5.5" fill="#fff" stroke="#c9ccd6" strokeWidth="0.6" />
        {cursorIn > 0 && act < 1 ? <path d={`M${knob + 4 + (1 - expoOut(cursorIn)) * 10} ${15 + (1 - expoOut(cursorIn)) * 8} l0 9 l2.4 -2.2 l1.7 3.6 l1.6 -0.8 l-1.7 -3.5 l3.2 -0.3 z`} fill="#111" stroke="#fff" strokeWidth="0.7" opacity={1 - clamp01((frame - act0 - fps * 0.4) / (fps * 0.2))} /> : null}</svg>; }
    case 'bubbles': return act >= 1 ? <svg viewBox="0 0 24 24" width={size} height={size} /> : <svg viewBox="0 0 24 24" width={size} height={size} style={{ overflow: 'visible' }}>
        <g transform={`translate(12 12) scale(${1 + e * 0.5}) translate(-12 -12)`} opacity={1 - e}><circle cx="9" cy="14" r="5.5" stroke={color} strokeWidth="1.4" fill="none" /><circle cx="16" cy="8" r="3.8" stroke={color} strokeWidth="1.4" fill="none" /></g>
        {act > 0 ? [0, 1, 2, 3, 4, 5].map(k => <circle key={k} cx={12 + Math.cos(k * 1.05) * (4 + e * 10)} cy={12 + Math.sin(k * 1.05) * (4 + e * 10)} r={1.1 * (1 - e)} fill={accent} />) : null}</svg>;
    case 'dash': return <svg viewBox="0 0 24 24" width={size} height={size} style={{ overflow: 'visible' }}><rect x={3 + e * 60} y="10.5" width={18 * (1 - e * 0.6)} height="3" rx="1.5" fill={accent} opacity={1 - clamp01((act - 0.6) / 0.4)} style={{ filter: act > 0 && act < 1 ? `blur(${1.5 * Math.sin(act * Math.PI)}px)` : undefined }} /></svg>;
    case 'check': return <svg viewBox="0 0 24 24" width={size} height={size}><circle cx="12" cy="12" r="10" fill={accent} /><path d="M7 12.5l3.2 3.2L17 9" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case 'spark': return <svg viewBox="0 0 24 24" width={size} height={size}><path d="M12 2c.8 5.2 4.8 9.2 10 10-5.2.8-9.2 4.8-10 10-.8-5.2-4.8-9.2-10-10 5.2-.8 9.2-4.8 10-10z" fill={accent} /></svg>;
    case 'play': return <svg viewBox="0 0 24 24" width={size} height={size}><circle cx="12" cy="12" r="10.5" fill={color} /><path d="M10 8l6 4-6 4z" fill="#fff" /></svg>;
    case 'film': return <svg viewBox="0 0 24 24" width={size} height={size}><rect x="2.5" y="5" width="19" height="14" rx="3" fill="none" stroke={color} strokeWidth="1.8" /><path d="M10 9.5l4.5 2.5-4.5 2.5z" fill={accent} /></svg>;
    case 'cursor': return <svg viewBox="0 0 24 24" width={size} height={size}><path d="M5 3v15l4-3.6 2.8 5.8 2.6-1.2-2.8-5.7 5.4-.4z" fill={color} stroke="#fff" strokeWidth="1" /></svg>;
    case 'mark': return <ContentMark size={size} color={color} accent={accent} />;
    default: return <svg viewBox="0 0 24 24" width={size} height={size}><circle cx="12" cy="12" r="5" fill={color} /></svg>;
  }
}
/** The Studio's mark (an original, not anyone else's logo): a frame with a play head and three level bars. */
export function ContentMark({ size, color, accent }: { size: number; color: string; accent: string }) {
  return <svg viewBox="0 0 24 24" width={size} height={size}><rect x="2.2" y="3.2" width="19.6" height="17.6" rx="5.5" fill="none" stroke={color} strokeWidth="2.2" />
    <path d="M8 8.6v6.8l5.4-3.4z" fill={color} /><rect x="15" y="10" width="1.6" height="4" rx=".8" fill={accent} /><rect x="17.6" y="8.6" width="1.6" height="6.8" rx=".8" fill={accent} /></svg>;
}

/** A dashed circle that draws itself and turns, with an accent arc sweeping ahead — the reveal around a logo. */
function Ring({ layer, state, frame, fps, w, h, unit, common }: { layer: EditorLayer; state: LayerState; frame: number; fps: number; w: number; h: number; unit: number; common: React.CSSProperties }) {
  const s = layer.style, d = Math.min(w, h), r = d / 2 - (s.strokeWidth ?? 4) * unit, c = 2 * Math.PI * r, t = (frame - layer.startFrame) / fps, draw = clamp01(state.draw);
  const spin = expoOut(clamp01(t / 1.4)) * 300 + t * 20;
  return <svg width={d} height={d} style={{ ...common, width: d, height: d, overflow: 'visible' }}>
    <g transform={`rotate(${spin - 90} ${d / 2} ${d / 2})`}>
      <circle cx={d / 2} cy={d / 2} r={r} fill="none" stroke={s.color ?? '#3355dd'} strokeOpacity={0.55} strokeWidth={(s.strokeWidth ?? 4) * unit} strokeLinecap="round" strokeDasharray={`${c * 0.012} ${c * 0.038}`}
        opacity={draw > 0 ? Math.min(1, draw * 3) : 0} />
      <circle cx={d / 2} cy={d / 2} r={r} fill="none" stroke={s.color ?? '#3355dd'} strokeWidth={(s.strokeWidth ?? 4) * unit * 1.4} strokeLinecap="round" strokeDasharray={`${c * 0.16} ${c}`} strokeDashoffset={-c * draw * 0.84} />
    </g>
  </svg>;
}


/** Dots travelling between shapes (motion.ts). Each dot is drawn stretched along its velocity — fast dots become streaks,
 *  dots on a spinning ring become dashes — which is the motion blur. Coordinates are the whole frame. */
function Particles({ layer, frame, fps, width, height, common }: { layer: EditorLayer; frame: number; fps: number; width: number; height: number; common: React.CSSProperties }) {
  const forms = (layer.style.forms ?? []) as ParticleForm[], n = layer.style.count ?? 40, blur = layer.style.motionBlur ?? 1;
  const dots = particleFrame(forms, n, (frame - layer.startFrame) / fps, fps, width / height);
  return <svg width={width} height={height} style={{ ...common, width, height, overflow: 'visible' }}>
    {dots.map((d, i) => { if (d.opacity <= 0.005 || (d.w <= 0 && d.h <= 0)) return null;
      const cx = d.x * width, cy = d.y * height, w = d.w * height, h = d.h * height;
      const vx = d.vx * width / fps, vy = d.vy * height / fps, speed = Math.hypot(vx, vy), stretch = Math.min(speed * 0.9 * blur, height * 0.12);
      if (stretch < Math.max(0.6, 0.15 * Math.min(w, h))) return <rect key={i} x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={Math.min(w, h) / 2} fill={d.color} opacity={Math.min(1, d.opacity)} />;
      const thick = Math.min(w, h), len = Math.max(w, h) + stretch, angle = Math.atan2(vy, vx) * 180 / Math.PI;
      // trail behind the dot: the streak ends at the dot's position
      return <rect key={i} x={-len + thick / 2} y={-thick / 2} width={len} height={thick} rx={thick / 2} fill={d.color} opacity={Math.min(1, d.opacity) * (0.55 + 0.45 * Math.min(1, thick * 2 / len))}
        transform={`translate(${cx} ${cy}) rotate(${angle})`} />; })}
  </svg>;
}
