import React, { useState } from 'react';
import { request } from './client';

const formats = [
  { id: 'landscape', label: '16:9', help: 'YouTube, websites', width: 1920, height: 1080 },
  { id: 'portrait', label: '9:16', help: 'Reels, TikTok, Shorts', width: 1080, height: 1920 },
  { id: 'square', label: '1:1', help: 'Feed posts', width: 1080, height: 1080 },
  { id: 'feed', label: '4:5', help: 'Instagram feed', width: 1080, height: 1350 },
] as const;
const canvases = [{ color: '#f5f6fa', label: 'Light' }, { color: '#ffffff', label: 'White' }, { color: '#0e0f13', label: 'Dark' }, { color: '#000000', label: 'Black' }];

/** A new project without recording anything: a blank canvas of the chosen shape and length that layers, media and the
 *  assistant fill in. Describe the video and the assistant starts building it as soon as the project opens. */
export function NewProjectPanel({ close, created }: { close: () => void; created: (projectId: string, brief: string) => void }) {
  const [title, setTitle] = useState(''), [format, setFormat] = useState<typeof formats[number]['id']>('landscape'), [seconds, setSeconds] = useState(15);
  const [color, setColor] = useState('#f5f6fa'), [fps, setFps] = useState(60), [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const shape = formats.find(f => f.id === format)!;
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const { project } = await request<{ project: { id: string } }>('/api/account/studio/projects/blank', { title: title.trim() || (brief.trim() ? brief.trim().slice(0, 60) : 'Untitled video'),
        seconds, color, fps, width: shape.width, height: shape.height });
      created(project.id, brief.trim());
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  };
  return <div className="new-project">
    <label className="field-label">Name<input autoFocus value={title} maxLength={250} placeholder="Untitled video" onChange={e => setTitle(e.target.value)} /></label>
    <div className="field-label">Shape<div className="np-formats" role="radiogroup" aria-label="Shape">
      {formats.map(f => <button key={f.id} role="radio" aria-checked={format === f.id} className={format === f.id ? 'active' : ''} onClick={() => setFormat(f.id)}>
        <span className="np-shape" style={{ aspectRatio: `${f.width} / ${f.height}` }} /><b>{f.label}</b><small>{f.help}</small></button>)}</div></div>
    <div className="np-row">
      <label className="field-label">Length<span className="np-seconds"><input type="number" min={1} max={600} step={1} value={seconds} onChange={e => setSeconds(Math.max(1, Math.min(600, Number(e.target.value) || 1)))} /> s</span></label>
      <label className="field-label">Frame rate<select value={fps} onChange={e => setFps(Number(e.target.value))}><option value={60}>60 fps (smooth motion)</option><option value={30}>30 fps</option></select></label>
    </div>
    <div className="field-label">Canvas<div className="np-colors">
      {canvases.map(c => <button key={c.color} className={color === c.color ? 'active' : ''} onClick={() => setColor(c.color)} title={c.label}><span style={{ background: c.color }} />{c.label}</button>)}
      <label className="np-custom" title="Any colour"><input type="color" value={color} onChange={e => setColor(e.target.value)} />Custom</label></div></div>
    <label className="field-label">What should it be? <small>(optional — your agent starts building it right away)</small>
      <textarea rows={3} value={brief} maxLength={4000} placeholder="A 15-second launch film for our new feature, light and playful, in the style of the reference in my Downloads…" onChange={e => setBrief(e.target.value)} /></label>
    <p className="np-note">You can change the length later, drop in recordings or images, and add titles from the timeline.</p>
    {error ? <p className="rec-error" role="alert">{error}</p> : null}
    <div className="modal-actions"><button onClick={close} disabled={busy}>Cancel</button><button className="primary" onClick={() => void create()} disabled={busy}>{busy ? 'Creating…' : brief.trim() ? 'Create and start the assistant' : 'Create project'}</button></div>
  </div>;
}
