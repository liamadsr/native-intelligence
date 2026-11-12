import React from 'react';
import { Icon } from './icons';
import { defaultPresentation, type EditorAsset, type EditorProject } from '@/lib/studio/engine/contracts';
import { assetUrl } from '@/lib/studio/engine/api';
import { STUDIO_API } from '../studio-env';
import { request } from './client';
import { Slider } from './controls';

type Presentation = EditorProject['presentation'];
type Kind = 'image' | 'gradient' | 'color' | 'none';
const gradients = [['#161626', '#595596'], ['#292a48', '#898cc3'], ['#126996', '#3faab1'], ['#481d85', '#152448'], ['#f7a477', '#593d87'], ['#326870', '#d1aa76'],
  ['#063d36', '#99b94b'], ['#e04b68', '#e9af71'], ['#6951ba', '#efa2ba'], ['#16171b', '#484958'], ['#0f2027', '#2c5364'], ['#ff9a8b', '#ff6a88']] as const;
const colors = ['#0b0c10', '#1c1d22', '#f4f4f5', '#ffffff', '#2b3a67', '#6d4fd0', '#0f766e', '#e11d48', '#f59e0b', '#e5d3b3'];
const clamp = (value: number, max: number) => Math.round(Math.max(0, Math.min(max, value)));
/** Built-in backgrounds, drawn in code (no image files): a few of the gradients, so a new workspace has something to pick. */
const starters = [gradients[1], gradients[4], gradients[8], gradients[2], gradients[7], gradients[10]];

/** One-click starting points, sized to the export so they look the same on any recording. */
function looks(short: number): { id: string; name: string; apply: (p: Presentation) => Presentation }[] {
  const frame = (pad: number, radius: number, shadow: number, softness: number) => (p: Presentation): Presentation => ({ ...p,
    background: p.background.kind === 'none' ? { ...p.background, kind: 'gradient', color: gradients[8][0], color2: gradients[8][1], angle: 135 } : p.background,
    padding: clamp(short * pad, 500), inset: 0, radius: clamp(short * radius, 300),
    shadow: { ...p.shadow, opacity: shadow, blur: clamp(short * softness, 200), distance: clamp(short * softness / 3, 200) } });
  return [
    { id: 'clean', name: 'Clean', apply: p => ({ ...p, background: { ...p.background, kind: 'none' }, padding: 0, inset: 0, radius: 0, blur: 0, shadow: { ...p.shadow, opacity: 0 } }) },
    { id: 'framed', name: 'Framed', apply: frame(0.06, 0.012, 0.35, 0.03) },
    { id: 'floating', name: 'Floating', apply: frame(0.11, 0.02, 0.5, 0.05) },
    { id: 'bold', name: 'Bold', apply: frame(0.16, 0.03, 0.55, 0.06) },
  ];
}

/**
 * The whole look on one page: pick a background, then shape the screen on top of it (space around, corners, shadow).
 */
export function BackgroundPanel({ project, change, busy, importMedia }: {
  project: EditorProject; change: (fn: (p: EditorProject) => EditorProject) => void; busy: boolean;
  importMedia: (kind: 'image') => void;
}) {
  const p = project.presentation, bg = p.background, short = Math.min(project.output.width, project.output.height);
  const update = (fn: (p: Presentation) => Presentation) => change(s => ({ ...s, presentation: fn(s.presentation) }));
  const set = (patch: Partial<Presentation>) => update(current => ({ ...current, ...patch }));
  // Picking a background while the screen fills the frame would change nothing visible: give it room first.
  const roomy = (current: Presentation): Presentation => current.padding + current.inset > 0 ? current
    : { ...current, padding: clamp(short * 0.06, 500), radius: current.radius || clamp(short * 0.012, 300), shadow: { ...current.shadow, opacity: current.shadow.opacity || 0.35, blur: current.shadow.blur || clamp(short * 0.03, 200) } };
  const setBackground = (patch: Partial<Presentation['background']>) => update(current => roomy({ ...current, background: { ...current.background, ...patch } }));
  const wallpaperAsset = project.assets.find(a => a.id === bg.assetId);
  const kind: Kind = bg.kind === 'none' ? 'none' : bg.kind === 'solid' ? 'color' : bg.kind === 'gradient' ? 'gradient' : 'image';
  const [shown, setShown] = React.useState<Kind>(kind);
  React.useEffect(() => setShown(kind), [kind]);
  const slidePages = new Set(project.slideDeck?.pageAssetIds ?? []);
  // Your images: the workspace's Studio library (newest first), and any image this video already holds.
  const [library, setLibrary] = React.useState<EditorAsset[]>([]);
  const imageCount = project.assets.filter(a => a.kind === 'image').length;
  React.useEffect(() => { let alive = true; void request<{ assets: EditorAsset[] }>(`${STUDIO_API}/assets?kind=image`).then(r => { if (alive) setLibrary(r.assets.filter(a => a.kind === 'image').reverse()); }).catch(() => {}); return () => { alive = false; }; }, [imageCount]);
  const yourImages = [...library, ...project.assets.filter(a => a.kind === 'image' && !library.some(l => l.id === a.id))].filter(a => !a.provenance?.wallpaperId && !slidePages.has(a.id));
  /** Use a library image as the background: it joins the video's media if it isn't there yet. */
  const pickImage = (asset: EditorAsset) => change(s => ({ ...s, assets: s.assets.some(a => a.id === asset.id) ? s.assets : [...s.assets, asset],
    presentation: roomy({ ...s.presentation, background: { ...s.presentation.background, kind: 'image', assetId: asset.id } }) }));
  const presets = looks(short);
  const [more, setMore] = React.useState(false);

  return <div className="bg-panel">
    <h2>Look</h2>
    <div className="bg-looks" role="group" aria-label="Looks">
      {presets.map(look => { const preview = look.apply(p), pad = preview.padding / short, radius = preview.radius / short;
        return <button key={look.id} className="bg-look" onClick={() => update(look.apply)} aria-label={`Apply the ${look.name} look`}>
          <span className="bg-look-canvas" style={{ background: preview.background.kind === 'none' ? '#000' : preview.background.kind === 'solid' ? preview.background.color
            : preview.background.kind === 'gradient' ? `linear-gradient(${preview.background.angle}deg,${preview.background.color},${preview.background.color2})`
            : wallpaperAsset ? `center/cover url(${assetUrl(wallpaperAsset)})` : '#333' }}>
            <span className="bg-look-screen" style={{ inset: `${Math.min(30, pad * 160)}%`, borderRadius: Math.max(1, radius * 60), boxShadow: preview.shadow.opacity ? `0 3px 10px rgba(0,0,0,${preview.shadow.opacity})` : 'none' }} />
          </span>
          <span>{look.name}</span>
        </button>; })}
    </div>

    <h3>Background</h3>
    <div className="segmented bg-kinds" role="tablist" aria-label="Background type">
      {(['image', 'gradient', 'color', 'none'] as const).map(name => <button key={name} role="tab" aria-selected={shown === name} className={shown === name ? 'active' : ''}
        onClick={() => { setShown(name); if (name === 'none') set({ background: { ...bg, kind: 'none' } }); if (name === 'color') setBackground({ kind: 'solid' }); if (name === 'gradient') setBackground({ kind: 'gradient' });
          if (name === 'image' && (wallpaperAsset?.kind === 'image')) setBackground({ kind: 'image', assetId: wallpaperAsset.id }); }}>
        {name === 'image' ? 'Image' : name === 'gradient' ? 'Gradient' : name === 'color' ? 'Color' : 'None'}</button>)}
    </div>
    {shown === 'image' ? <>
      <div className="bg-own">
        <span className="field-label">Your images</span>
        <div className="palette-grid">
          {yourImages.map(a => <button key={a.id} className={`swatch ${a.id === bg.assetId && bg.kind === 'image' ? 'active' : ''}`} style={{ backgroundImage: `url(${assetUrl(a)})`, backgroundSize: 'cover' }}
            aria-label={`Use ${a.name} as background`} title={a.name} onClick={() => pickImage(a)} />)}
          <button className="swatch bg-upload" disabled={busy} onClick={() => importMedia('image')} aria-label="Upload an image" title="Upload an image"><Icon name="plus"/></button>
        </div>
        {!yourImages.length ? <p className="hint">Upload an image, or add one from the Browser. Images you add are kept in the Studio library for every video.</p> : null}
      </div>
      <div className="bg-own bg-starters">
        <span className="field-label">Built in</span>
        <div className="palette-grid">{starters.map(([a, b]) => <button key={a + b} className={`swatch ${bg.kind === 'gradient' && bg.color === a && bg.color2 === b ? 'active' : ''}`}
          aria-label={`Built-in background ${a} to ${b}`} style={{ background: `linear-gradient(135deg,${a},${b})` }} onClick={() => { setShown('gradient'); setBackground({ kind: 'gradient', color: a, color2: b, angle: 135 }); }} />)}</div>
      </div>
    </> : null}
    {shown === 'gradient' ? <><div className="palette-grid">{gradients.map(([a, b], i) => <button key={i} className={`swatch ${bg.kind === 'gradient' && bg.color === a && bg.color2 === b ? 'active' : ''}`}
      aria-label={`Gradient ${i + 1}`} style={{ background: `linear-gradient(135deg,${a},${b})` }} onClick={() => setBackground({ kind: 'gradient', color: a, color2: b, angle: 135 })} />)}</div>
      <div className="bg-inline"><input type="color" aria-label="First gradient color" value={bg.color.slice(0, 7)} onChange={e => setBackground({ kind: 'gradient', color: e.target.value })} />
        <input type="color" aria-label="Second gradient color" value={bg.color2.slice(0, 7)} onChange={e => setBackground({ kind: 'gradient', color2: e.target.value })} />
        <div className="bg-inline-slider"><Slider resetValue={135} label="Angle" value={bg.angle} max={360} unit="°" onChange={n => setBackground({ angle: n })} /></div></div></> : null}
    {shown === 'color' ? <div className="palette-grid">{colors.map(c => <button key={c} className={`swatch ${bg.kind === 'solid' && bg.color.toLowerCase() === c ? 'active' : ''}`}
      aria-label={`Color ${c}`} style={{ background: c }} onClick={() => setBackground({ kind: 'solid', color: c })} />)}
      <label className="swatch bg-custom-color" title="Custom color"><input type="color" aria-label="Custom background color" value={bg.color.slice(0, 7)} onChange={e => setBackground({ kind: 'solid', color: e.target.value })} /></label></div> : null}
    {shown === 'none' ? <p className="hint">Just the recording, edge to edge.</p> : null}
    {bg.kind === 'image' ? <Slider label="Blur" value={p.blur} max={100} unit=" px" onChange={n => set({ blur: n })} /> : null}

    <h3>Screen</h3>
    <Slider label="Space around" value={p.padding} max={500} unit=" px" resetValue={0} onChange={n => set({ padding: n })} />
    <Slider label="Corners" value={p.radius} max={300} unit=" px" resetValue={0} onChange={n => set({ radius: n })} />
    <div className="radius-presets" aria-label="Corner presets">{[0, 12, 24, 40, 64].map(radius => <button key={radius} className={p.radius === radius ? 'active' : ''} aria-pressed={p.radius === radius}
      onClick={() => set({ radius })}>{radius === 0 ? 'Square' : radius}</button>)}</div>
    <Slider label="Shadow" value={Math.round(p.shadow.opacity * 100)} max={100} unit="%" resetValue={0} onChange={n => update(current => ({ ...current, shadow: { ...current.shadow, opacity: n / 100,
      blur: current.shadow.blur || clamp(short * 0.03, 200), distance: current.shadow.distance || clamp(short * 0.01, 200) } }))} />
    <button className="bg-more" aria-expanded={more} onClick={() => setMore(value => !value)}><Icon name={more ? 'chevron' : 'chevronRight'} size={14}/>More</button>
    {more ? <div className="bg-more-body">
      <Slider resetValue={defaultPresentation.shadow.blur} label="Shadow softness" value={p.shadow.blur} max={200} unit=" px" onChange={n => set({ shadow: { ...p.shadow, blur: n } })} />
      <Slider resetValue={defaultPresentation.shadow.distance} label="Shadow distance" value={p.shadow.distance} max={200} unit=" px" onChange={n => set({ shadow: { ...p.shadow, distance: n } })} />
      <Slider resetValue={defaultPresentation.shadow.angle} label="Shadow direction" value={p.shadow.angle} max={360} unit="°" onChange={n => set({ shadow: { ...p.shadow, angle: n } })} />
      <Slider label="Extra inset" value={p.inset} max={200} unit=" px" resetValue={0} onChange={n => set({ inset: n })} />
      <button className="full-button" onClick={() => set({ ...defaultPresentation, background: { ...defaultPresentation.background }, shadow: { ...defaultPresentation.shadow } })}>Reset look</button>
    </div> : null}
  </div>;
}
