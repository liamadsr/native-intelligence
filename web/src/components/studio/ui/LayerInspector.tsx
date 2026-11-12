import { studioCan } from '../studio-env';
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { request } from './client';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { FontPicker } from './FontPicker';
import { weightNumber, animationPresets, ParticleFormSchema, layerKindInfo, layerParamInfo, setLayerLane, textLooks, type AnimationPreset, type EditorLayer, type LayerStyle, type TextLook } from '@/lib/studio/engine/layers';
import { Slider, StudioSelect } from './controls';
import { layerTitle, layerTone } from './LayerLanes';

const presetLabels: Record<AnimationPreset, string> = { none: 'None', fade: 'Fade', pop: 'Pop', 'slide-up': 'Slide up', 'slide-down': 'Slide down', 'slide-left': 'Slide from right', 'slide-right': 'Slide from left',
  zoom: 'Zoom', blur: 'Blur', wipe: 'Wipe', typewriter: 'Typewriter', words: 'Word by word', draw: 'Draw on',
  'blur-in': 'Blur in (words)', chars: 'Letters', streak: 'Streak (motion blur)', scatter: 'Scatter', 'zoom-blur': 'Zoom blur', drop: 'Drop in', 'weight-in': 'Weight (thin → bold)', 'track-in': 'Tracking (wide → tight)' };
const perUnit = ['typewriter', 'words', 'chars', 'streak', 'scatter'];
const presetsFor = (kind: EditorLayer['kind'], side: 'enter' | 'exit') => animationPresets.filter(preset =>
  (kind === 'text' || !perUnit.includes(preset)) && (kind === 'arrow' || preset !== 'draw') && (side === 'enter' || !['typewriter', 'words', 'draw', 'chars', 'scatter'].includes(preset)));
const lookLabels: Record<TextLook, string> = { impact: 'Impact', title: 'Title', caption: 'Caption', label: 'Label', pill: 'Pill', subtitle: 'Subtitle', hero: 'Hero', gradient: 'Gradient', statement: 'Statement', editorial: 'Editorial', neon: 'Neon', kicker: 'Kicker' };
const list = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean).slice(0, 12);

/** Everything about one layer on one page: what it says, how it looks, where it sits, and how it comes in and out. */
export function LayerInspector({ project, layerId, change, close }: { project: EditorProject; layerId: string; change: (fn: (p: EditorProject) => EditorProject) => void; close: () => void }) {
  const layer = project.layers?.find(item => item.id === layerId);
  const [fontInfo, setFontInfo] = useState<{ weights: [number, number]; variable: boolean } | null>(null);
  if (!layer) return null;
  const fps = project.output.fps, s = layer.style;
  const set = (patch: Partial<EditorLayer>) => change(p => ({ ...p, layers: (p.layers ?? []).map(item => item.id === layerId ? { ...item, ...patch } : item) }));
  const style = (patch: Partial<LayerStyle>) => change(p => ({ ...p, layers: (p.layers ?? []).map(item => item.id === layerId ? { ...item, style: { ...item.style, ...patch } } : item) }));
  const remove = () => { change(p => ({ ...p, layers: (p.layers ?? []).filter(item => item.id !== layerId) })); close(); };
  const color = (label: string, value: string | undefined, onChange: (v: string | undefined) => void, optional = false) => <label className="layer-color">
    <span>{label}</span>{optional ? <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked ? '#111118' : undefined)} aria-label={`${label} on`} /> : null}
    <input type="color" disabled={optional && !value} value={(value ?? '#ffffff').slice(0, 7)} onChange={e => onChange(e.target.value + (value && value.length === 9 ? value.slice(7) : ''))} /></label>;
  const anim = (side: 'enter' | 'exit') => { const value = layer[side];
    return <div className="layer-anim"><label className="field-label">{side === 'enter' ? 'In' : 'Out'}</label>
      <StudioSelect aria-label={`${side === 'enter' ? 'In' : 'Out'} animation`} value={value.preset} onChange={v => set({ [side]: { ...value, preset: v as AnimationPreset } } as Partial<EditorLayer>)}>
        {presetsFor(layer.kind, side).map(preset => <option key={preset} value={preset}>{presetLabels[preset]}</option>)}</StudioSelect>
      {value.preset !== 'none' ? <StudioSelect aria-label={`${side === 'enter' ? 'In' : 'Out'} motion`} title="How it moves: Snappy (no overshoot), Spring (overshoots a little and settles), Bouncy, Smooth (ease in and out)"
        value={value.ease ?? 'expo'} onChange={v => { const { ease: _old, ...rest } = value; const next = v as NonNullable<typeof value.ease>; set({ [side]: next === 'expo' ? rest : { ...rest, ease: next } } as Partial<EditorLayer>); }}>
        <option value="expo">Snappy</option><option value="spring">Spring</option><option value="bouncy">Bouncy</option><option value="smooth">Smooth</option></StudioSelect> : null}
      {value.preset !== 'none' && !(side === 'enter' && value.preset === 'words' && s.wordFrames) ? <Slider label="Length" value={+(value.frames / fps).toFixed(2)} min={0.05} max={Math.max(0.1, Math.min(4, (layer.endFrame - layer.startFrame) / fps))} step={0.05} unit=" s"
        onChange={n => set({ [side]: { ...value, frames: Math.max(1, Math.round(n * fps)) } } as Partial<EditorLayer>)} /> : null}</div>; };
  return <div className="layer-inspector" style={{ ['--layer-tone' as string]: layerTone[layer.kind] }}>
    <div className="layer-inspector-head"><span className="th-chip" style={{ background: layerTone[layer.kind] }} /><div><strong>{layerKindInfo[layer.kind].label}</strong><small>{layerTitle(layer)}</small></div>
      <button onClick={remove} title="Delete this layer">Delete</button><button onClick={close} aria-label="Close layer settings" title="Close"><Icon name="close"/></button></div>
    {layer.kind === 'text' ? <section><h3>Text</h3>
      <textarea value={s.text ?? ''} rows={3} aria-label="Layer text" onChange={e => style({ text: e.target.value || ' ', ...(s.wordFrames && e.target.value.trim().split(/\s+/).length !== s.wordFrames.length ? { wordFrames: undefined } : {}) })} />
      <div className="layer-looks">{(Object.keys(textLooks) as TextLook[]).map(look => <button key={look} className={`look-${look}`} onClick={() => { const preset: LayerStyle = textLooks[look]; style({ ...preset, background: preset.background, stroke: preset.stroke, strokeWidth: preset.strokeWidth ?? 0, accent: preset.accent, uppercase: preset.uppercase ?? false, radius: preset.radius }); }}>{lookLabels[look]}</button>)}</div>
      <div className="layer-row"><label className="field-label">Font<FontPicker value={s.font ?? 'sans'} onPick={font => style({ font })} onInfo={setFontInfo} /></label>
        <label className="field-label">Shadow<StudioSelect aria-label="Shadow" value={s.shadow === true ? 'soft' : s.shadow || 'none'} onChange={v => style({ shadow: v === 'none' ? undefined : v as LayerStyle['shadow'] })}><option value="none">None</option><option value="soft">Soft</option><option value="lifted">Lifted</option><option value="glow">Glow</option><option value="hard">Hard</option></StudioSelect></label>
        <label className="field-label">Case<StudioSelect aria-label="Case" value={s.uppercase ? 'upper' : 'as-typed'} onChange={v => style({ uppercase: v === 'upper' })}><option value="as-typed">As typed</option><option value="upper">UPPER</option></StudioSelect></label></div>
      <Slider label="Size" value={Math.round((s.size ?? 0.06) * 1000) / 10} min={1} max={45} step={0.5} unit="%" onChange={n => style({ size: n / 100 })} />
      <Slider label="Weight" value={weightNumber(s.weight)} min={fontInfo?.weights[0] ?? 100} max={fontInfo?.weights[1] ?? 900} step={fontInfo?.variable ? 10 : 100} resetValue={700} onChange={n => style({ weight: n })} />
      <Slider label="Letter spacing" value={Math.round((s.tracking ?? 0) * 1000) / 1000} min={-0.12} max={0.5} step={0.005} unit=" em" resetValue={0} onChange={n => style({ tracking: n || undefined })} />
      <Slider label="Line height" value={s.leading ?? 1.1} min={0.7} max={2} step={0.02} unit="×" resetValue={1.1} onChange={n => style({ leading: n === 1.1 ? undefined : n })} />
      <div className="layer-row"><label className="layer-toggle"><input type="checkbox" checked={!!s.italic} onChange={e => style({ italic: e.target.checked || undefined })} /> Italic</label>
        <label className="field-label">Features<input placeholder="ss01, tnum…" value={(s.features ?? []).join(', ')} onChange={e => { const f = e.target.value.split(',').map(x => x.trim()).filter(x => /^[a-z0-9]{4}( [01])?$/.test(x)); style({ features: f.length ? f : undefined }); }} /></label></div>
      <div className="layer-row"><label className="layer-toggle"><input type="checkbox" checked={!!s.stack} onChange={e => style({ stack: e.target.checked || undefined })} /> One word per line</label>
        <label className="layer-toggle"><input type="checkbox" checked={!!s.fit} onChange={e => style({ fit: e.target.checked || undefined })} /> Fit width</label>
        <label className="layer-toggle" title="A slim blinking cursor after the text (in the accent color). Wrap words in *stars* to color them."><input type="checkbox" checked={s.caret === 'line'} onChange={e => style({ caret: e.target.checked ? 'line' : undefined })} /> Cursor</label></div>
      <div className="layer-row"><label className="field-label">Then swap to<input placeholder="word, word…" value={(s.swapWords ?? []).join(', ')} onChange={e => { const words = e.target.value.split(',').map(w => w.trim()).filter(Boolean).slice(0, 12); style({ swapWords: words.length ? words : undefined }); }} /></label>
        <label className="field-label">Count up from<input type="number" value={s.countFrom ?? ''} onChange={e => style({ countFrom: e.target.value === '' ? undefined : Number(e.target.value) })} /></label></div>
      <Slider label="Drift" value={Math.round((s.drift ?? 0) * 100)} min={-20} max={20} unit="%/s" resetValue={0} onChange={n => style({ drift: n ? n / 100 : undefined })} />
      <div className="layer-colors">{color('Text', s.color, v => style({ color: v }))}{color('Gradient to', s.color2, v => style({ color2: v }), true)}{color('Box', s.background, v => style({ background: v }), true)}{color('Outline', s.stroke, v => style({ stroke: v, strokeWidth: v ? s.strokeWidth || 5 : 0 }), true)}{color('Accent', s.accent, v => style({ accent: v }), true)}</div>
    </section> : layer.kind === 'notification' || layer.kind === 'card' || layer.kind === 'chips' ? <section><h3>Content</h3>
      {layer.kind === 'chips' ? <textarea rows={4} aria-label="One pill per line" value={(s.items ?? []).join('\n')} onChange={e => { const items = list(e.target.value); style({ items: items.length ? items : [' '] }); }} />
        : <>{layer.kind === 'notification' ? <div className="layer-row"><label className="field-label">App<input value={s.app ?? ''} onChange={e => style({ app: e.target.value || undefined })} /></label>
            <label className="field-label">Icon<input value={s.icon ?? ''} maxLength={12} onChange={e => style({ icon: e.target.value || undefined })} /></label></div> : null}
          <label className="field-label">Title<input value={s.title ?? ''} onChange={e => style({ title: e.target.value || undefined })} /></label>
          <textarea rows={2} aria-label="Message" value={s.text ?? ''} onChange={e => style({ text: e.target.value || ' ' })} /></>}
      {layer.kind === 'chips' ? <Slider label="Stagger" value={s.stagger ?? 9} max={30} unit=" fr" onChange={n => style({ stagger: n })} /> : null}
      <Slider label="Size" value={Math.round((s.size ?? 0.026) * 1000) / 10} min={1} max={10} step={0.1} unit="%" onChange={n => style({ size: n / 100 })} />
      <Slider label="Float" value={Math.round((s.float ?? 0) * 1000)} max={40} unit="" resetValue={0} onChange={n => style({ float: n ? n / 1000 : undefined })} />
      <div className="layer-colors">{layer.kind === 'chips' ? color('Pill', s.background, v => style({ background: v })) : null}{color('Text', s.color, v => style({ color: v }), true)}</div>
    </section> : layer.kind === 'particles' ? <ParticlesSection layer={layer} style={style} />
    : layer.kind === 'code' && s.scene ? <section><h3>Scene</h3>
      <small className="field-help">“{s.scene.name}” is code the agent wrote ({s.scene.id}). Ask the agent to change how it moves; its settings are below.</small>
      <textarea key={s.scene.id} rows={5} aria-label="Scene settings (JSON)" spellCheck={false} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }} defaultValue={JSON.stringify(s.scene.props ?? {}, null, 2)}
        onBlur={e => { try { const props = JSON.parse(e.target.value || '{}'); if (props && typeof props === 'object' && !Array.isArray(props)) style({ scene: { ...s.scene!, props } }); } catch { /* keep the last valid settings */ } }} />
      <label className="field-label"><input type="checkbox" checked={!!s.clip} onChange={e => style({ clip: e.target.checked || undefined })} /> Clip to its box</label></section>
    : layer.kind === 'icons' || layer.kind === 'waveform' || layer.kind === 'ring' ? <section><h3>{layerKindInfo[layer.kind].label}</h3>
      {layer.kind === 'icons' ? <><textarea rows={4} aria-label="One icon per line" value={(s.items ?? []).join('\n')} onChange={e => { const items = list(e.target.value); style({ items: items.length ? items : ['note'] }); }} />
        <small className="field-help">note · key · toggle · bubbles · dash · check · spark · play · film · cursor · mark</small>
        <Slider label="Stagger" value={s.stagger ?? 9} max={40} unit=" fr" onChange={n => style({ stagger: n })} /></> : null}
      {layer.kind === 'waveform' ? <><div className="layer-row"><label className="field-label">Look<StudioSelect aria-label="Look" value={s.variant ?? 'bars'} onChange={v => style({ variant: v as LayerStyle['variant'] })}><option value="bars">Bars</option><option value="mirror">Bars + reflection</option><option value="dots">Dots</option><option value="line">Flowing lines</option><option value="radial">Radial</option></StudioSelect></label>
          <label className="field-label">Moves with<StudioSelect aria-label="Moves with" value={s.source ?? 'synthetic'} onChange={v => style({ source: v as LayerStyle['source'] })}><option value="synthetic">A voice-like swell</option><option value="voice">The voice-over</option><option value="music">The music</option><option value="all">All audio</option></StudioSelect></label></div>
        <Slider label="Bars" value={s.count ?? 48} min={4} max={120} onChange={n => style({ count: n })} />
        <Slider label="Gap" value={Math.round((s.gap ?? 0.45) * 100)} min={0} max={90} unit="%" resetValue={45} onChange={n => style({ gap: n / 100 })} />
        <Slider label="Roundness" value={Math.round((s.roundness ?? 1) * 100)} min={0} max={100} unit="%" resetValue={100} onChange={n => style({ roundness: n / 100 })} />
        <Slider label="Height" value={Math.round((s.amp ?? 1) * 100)} min={10} max={300} unit="%" resetValue={100} onChange={n => style({ amp: n / 100 })} />
        <Slider label="Speed" value={Math.round((s.speed ?? 1) * 100)} min={0} max={500} unit="%" resetValue={100} onChange={n => style({ speed: n / 100 })} />
        <Slider label="Glow" value={Math.round((s.glow ?? 0) * 100)} min={0} max={100} unit="%" resetValue={0} onChange={n => style({ glow: n ? n / 100 : undefined })} />
        {s.variant === 'line' ? <Slider label="Line" value={s.strokeWidth ?? 3} min={1} max={14} step={0.5} onChange={n => style({ strokeWidth: n })} /> : null}
        <label className="layer-toggle"><input type="checkbox" checked={!!s.spike} onChange={e => style({ spike: e.target.checked || undefined })} /> Travelling peak</label></> : null}
      {layer.kind === 'ring' ? <Slider label="Line" value={s.strokeWidth ?? 4} min={1} max={16} onChange={n => style({ strokeWidth: n })} /> : null}
      <div className="layer-colors">{color(layer.kind === 'icons' ? 'Icons' : 'Color', s.color, v => style({ color: v }))}{layer.kind === 'icons' ? color('Accent', s.accent, v => style({ accent: v }), true) : null}{layer.kind === 'waveform' ? color('Gradient to', s.color2, v => style({ color2: v }), true) : null}</div>
    </section> : layer.kind === 'background' ? <section><h3>Fill</h3>
      <div className="layer-row"><label className="field-label">Kind<StudioSelect aria-label="Fill kind" value={s.fill ?? 'mesh'} onChange={v => style({ fill: v as LayerStyle['fill'] })}>
        {(['mesh', 'glow', 'gradient', 'solid', 'image'] as const).map(fill => <option key={fill} value={fill} disabled={fill === 'image' && !project.assets.some(a => a.kind === 'image')}>{fill[0]!.toUpperCase() + fill.slice(1)}</option>)}</StudioSelect></label>
        {s.fill === 'image' ? <label className="field-label">Picture<StudioSelect aria-label="Picture" value={layer.assetId ?? ''} onChange={v => set({ assetId: v || undefined })}><option value="">—</option>{project.assets.filter(a => a.kind === 'image').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</StudioSelect></label> : null}</div>
      <div className="layer-colors">{color('Color', s.color, v => style({ color: v }))}{color('Second', s.color2, v => style({ color2: v }), true)}</div>
      {s.fill === 'image' ? <Slider label="Blur" value={s.blur ?? 0} max={120} unit=" px" onChange={n => style({ blur: n })} /> : null}
    </section> : layer.kind === 'image' ? <section><h3>Image</h3>
      <label className="field-label">Picture<StudioSelect aria-label="Picture" value={layer.assetId ?? ''} onChange={v => set({ assetId: v || undefined })}>{project.assets.filter(a => a.kind === 'image').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</StudioSelect></label>
      <Slider label="Corners" value={s.radius ?? 0} max={500} unit=" px" onChange={n => style({ radius: n })} />
      <Slider label="Float" value={Math.round((s.float ?? 0) * 1000)} max={40} unit="" resetValue={0} onChange={n => style({ float: n ? n / 1000 : undefined })} />
    </section> : <section><h3>Look</h3>
      <div className="layer-colors">{layer.kind !== 'spotlight' ? color('Color', s.stroke, v => style({ stroke: v, ...(layer.kind === 'highlight' && v ? { background: `${v}55` } : {}) })) : null}{layer.kind === 'box' ? color('Fill', s.background, v => style({ background: v }), true) : null}</div>
      {layer.kind !== 'spotlight' ? <Slider label="Line" value={s.strokeWidth ?? 6} max={40} unit=" px" onChange={n => style({ strokeWidth: n })} /> : null}
      {layer.kind !== 'arrow' ? <Slider label="Corners" value={s.radius ?? 12} max={200} unit=" px" onChange={n => style({ radius: n })} /> : <Slider label="Bend" value={Math.round((s.curve ?? 0.2) * 100)} min={-100} max={100} unit="%" onChange={n => style({ curve: n / 100 })} />}
      {layer.kind === 'spotlight' ? <Slider label="Dim" value={Math.round((s.dim ?? 0.65) * 100)} max={100} unit="%" onChange={n => style({ dim: n / 100 })} /> : null}
    </section>}
    <section><h3>Depth</h3>
      <label className="layer-toggle"><input type="checkbox" checked={!!layer.behind} onChange={e => set({ behind: e.target.checked || undefined })} /> Behind the subject <small>words behind the speaker, a new background behind the person</small></label>
      {layer.behind && !project.cutouts?.length && studioCan('cutouts') ? <SubjectCutout projectId={project.id} /> : null}
    </section>
    <section><h3>Position</h3>
      <div className="layer-grid"><Slider label={layer.kind === 'arrow' ? 'Tip ←→' : '←→'} value={Math.round(layer.x * 100)} min={-20} max={120} unit="%" onChange={n => set({ x: n / 100 })} />
        <Slider label={layer.kind === 'arrow' ? 'Tip ↑↓' : '↑↓'} value={Math.round(layer.y * 100)} min={-20} max={120} unit="%" onChange={n => set({ y: n / 100 })} />
        {layer.kind === 'arrow' ? <><Slider label="Start ←→" value={Math.round((s.fromX ?? 0.3) * 100)} min={-20} max={120} unit="%" onChange={n => style({ fromX: n / 100 })} />
          <Slider label="Start ↑↓" value={Math.round((s.fromY ?? 0.3) * 100)} min={-20} max={120} unit="%" onChange={n => style({ fromY: n / 100 })} /></>
          : <><Slider label="Width" value={Math.round(layer.width * 100)} min={1} max={100} unit="%" onChange={n => set({ width: n / 100 })} />
            {layer.kind !== 'text' ? <Slider label="Height" value={Math.round(layer.height * 100)} min={1} max={100} unit="%" onChange={n => set({ height: n / 100 })} /> : null}</>}
        <Slider label="Rotation" value={Math.round(layer.rotate)} min={-180} max={180} unit="°" resetValue={0} onChange={n => set({ rotate: n })} />
        <Slider label="Opacity" value={Math.round(layer.opacity * 100)} max={100} unit="%" resetValue={100} onChange={n => set({ opacity: n / 100 })} /></div>
    </section>
    <section><h3>Timing &amp; animation</h3>
      <div className="layer-row"><label className="field-label">Starts<input type="number" step={0.05} min={0} value={+(layer.startFrame / fps).toFixed(2)} onChange={e => { const v = Math.round(Number(e.target.value) * fps); if (Number.isFinite(v) && v >= 0 && v < layer.endFrame) set({ startFrame: v }); }} /></label>
        <label className="field-label">Ends<input type="number" step={0.05} min={0} value={+(layer.endFrame / fps).toFixed(2)} onChange={e => { const v = Math.round(Number(e.target.value) * fps); if (Number.isFinite(v) && v > layer.startFrame) set({ endFrame: v }); }} /></label></div>
      {anim('enter')}{anim('exit')}
    </section>
    <section><h3>Automation</h3>
      {layer.automation.length ? <ul className="layer-auto-list">{layer.automation.map(lane => <li key={lane.param}><span>{layerParamInfo(layer, lane.param).label}</span><small>{lane.points.length} point{lane.points.length === 1 ? '' : 's'}</small>
        <button onClick={() => change(p => ({ ...p, layers: (p.layers ?? []).map(item => item.id === layerId ? setLayerLane(item, lane.param, []) : item) }))}>Clear</button></li>)}</ul>
        : <p className="hint">Press A (Automation), pick Position, Scale, Opacity or Rotation in this layer's track header, then draw with the pencil or click to add points.</p>}
    </section>
  </div>;
}

/** Runs macOS Vision on the project's camera footage so "behind" layers have a subject to sit behind. */
function SubjectCutout({ projectId }: { projectId: string }) {
  const [state, setState] = useState<{ progress: number; note: string; error?: string } | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const start = async (mode: 'person' | 'subject') => {
    setState({ progress: 0, note: 'Starting…' });
    try {
      const { job } = await request<{ job: { id: string } }>(`/api/account/studio/projects/${encodeURIComponent(projectId)}/cutouts`, { mode });
      for (;;) { await new Promise(done => setTimeout(done, 1000)); if (!alive.current) return;
        const { job: now } = await request<{ job: { status: string; progress: number; logs: string[]; error?: string } }>(`/api/account/studio/jobs/${job.id}`);
        if (now.status === 'completed') { setState({ progress: 1, note: 'Done. The editor reloads the video with the cut-out' }); return; }
        if (now.status !== 'running') throw new Error(now.error ?? now.status);
        setState({ progress: now.progress, note: now.logs.at(-1) ?? '' }); }
    } catch (error) { if (alive.current) setState({ progress: 0, note: '', error: error instanceof Error ? error.message : String(error) }); }
  };
  return <div className="subject-cutout">
    <p className="hint">Cuts the subject out of the camera footage on the Studio’s render worker. Takes about as long as the camera recording.</p>
    {state && !state.error ? <div className="cutout-progress"><span style={{ width: `${Math.round(state.progress * 100)}%` }} /><small>{Math.round(state.progress * 100)}% · {state.note}</small></div>
      : <div className="layer-row"><button onClick={() => void start('person')}>Isolate the person</button><button onClick={() => void start('subject')} title="Any main object, not just people">Isolate any subject</button></div>}
    {state?.error ? <p className="hint error">{state.error}</p> : null}
  </div>;
}


/** Particles: dot count, motion blur, and the shapes in order (edited as JSON — each {at, shape, x, y, …}). */
function ParticlesSection({ layer, style }: { layer: EditorLayer; style: (patch: Partial<LayerStyle>) => void }) {
  const s = layer.style, [draft, setDraft] = useState(() => JSON.stringify(s.forms ?? [], null, 1)), [error, setError] = useState('');
  useEffect(() => { setDraft(JSON.stringify(layer.style.forms ?? [], null, 1)); setError(''); }, [layer.id, layer.style.forms]);
  const commit = () => { try { const forms = ParticleFormSchema.array().max(40).parse(JSON.parse(draft)); style({ forms: [...forms].sort((a, b) => a.at - b.at) }); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message.slice(0, 200) : 'Not valid'); } };
  return <section><h3>Particles</h3>
    <Slider label="Dots" value={s.count ?? 40} min={4} max={120} onChange={n => style({ count: n })} />
    <Slider label="Motion blur" value={Math.round((s.motionBlur ?? 1) * 100)} max={300} unit="%" resetValue={100} onChange={n => style({ motionBlur: n / 100 })} />
    <label className="field-label">Shapes (in order: at = seconds from the layer start; scatter · line · wave · bars · points · ring · point)</label>
    <textarea rows={10} spellCheck={false} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }} value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} aria-label="Particle shapes" />
    {error ? <small className="field-help" role="alert">{error}</small> : <small className="field-help">{(s.forms ?? []).map(f => `${f.at}s ${f.shape}`).join(' → ')}</small>}
  </section>;
}
