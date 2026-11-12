import React, { useEffect, useState } from 'react';
import { Icon } from './icons';
import { request } from './client';

type Palette = { background: string; surface: string; ink: string; muted: string; border: string; primary: string; primaryInk: string; backdrop?: string; wash?: string[] };
type Brand = { kit: string; title: string; derivedAt: string; site?: string; source?: { ref: string; sha?: string }; vibe: string; notes?: string; light: Palette; dark?: Palette;
  accents: { hex: string; share: number }[]; status: Record<'success' | 'warning' | 'danger' | 'info', string>; fonts: { sans: string; heading: string; mono?: string };
  type: { headlineWeight?: number; headlineTracking?: string }; shape: { radius: number; buttons: string }; swatches: { hex: string; share: number; role: string }[];
  screenshots: string[]; warnings?: string[]; corrected: string[]; assistantCorrected?: string[] };
const ROLES: [keyof Palette, string][] = [['background', 'Background'], ['surface', 'Surface'], ['ink', 'Ink'], ['muted', 'Secondary text'], ['border', 'Lines'], ['primary', 'Button'], ['primaryInk', 'Button text']];

/** The product's style guide: what the Studio read from its site and code, and the person's corrections (which win).
 *  Films and the assistant's scenes use these colours and fonts. */
export function StyleGuide({ kit, fail }: { kit: string; fail: (e: unknown) => void }) {
  const [brand, setBrand] = useState<Brand | null | undefined>(undefined), [busy, setBusy] = useState(false), [vibe, setVibe] = useState(''), [notes, setNotes] = useState(''), [site, setSite] = useState('');
  const take = (b: Brand | null) => { setBrand(b); setVibe(b?.vibe ?? ''); setNotes(b?.notes ?? ''); setSite(b?.site ?? ''); };
  const derive = async () => { setBusy(true); try { take((await request<{ brand: Brand }>(`/api/account/studio/kits/${kit}/brand/derive`, {})).brand); } catch (e) { fail(e); } finally { setBusy(false); } };
  useEffect(() => { let live = true; setBrand(undefined); void request<{ brand: Brand | null }>(`/api/account/studio/kits/${kit}/brand`).then(r => { if (!live) return; take(r.brand); if (!r.brand) void derive(); }).catch(fail); return () => { live = false; }; }, [kit]);
  const correct = async (patch: Record<string, unknown>) => { try { take((await request<{ brand: Brand }>(`/api/account/studio/kits/${kit}/brand`, patch)).brand); } catch (e) { fail(e); } };
  if (brand === undefined || (busy && !brand)) return <div className="sg"><p className="cg-busy">Reading {kit}'s site and code for its look…</p></div>;
  if (!brand) return <div className="sg"><p>No style guide yet.</p><button onClick={() => void derive()} disabled={busy}>Read it from the product</button></div>;
  const pal = (scheme: 'light' | 'dark', p: Palette) => <div className="sg-pal">
    <div className="sg-sample" style={{ background: p.backdrop ?? p.background, color: p.ink, fontFamily: `"${brand.fonts.sans}", Inter, sans-serif` }}>
      <div style={{ fontFamily: `"${brand.fonts.heading}", Inter, sans-serif`, fontWeight: brand.type.headlineWeight ?? 600, letterSpacing: brand.type.headlineTracking, fontSize: 26, lineHeight: 1.1 }}>{brand.title}, in every video</div>
      <div style={{ color: p.muted, fontSize: 13, marginTop: 6 }}>Secondary text in the product's own voice.</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <span style={{ background: p.primary, color: p.primaryInk, borderRadius: brand.shape.buttons === 'pill' ? 999 : brand.shape.radius, padding: '6px 14px', fontSize: 12, fontWeight: 600 }}>Primary</span>
        <span style={{ background: p.surface, color: p.ink, border: `1px solid ${p.border}`, borderRadius: brand.shape.radius, padding: '6px 14px', fontSize: 12 }}>Card</span></div></div>
    <div className="sg-swatches">{ROLES.map(([key, label]) => <label key={key} title={`${label}: click to correct`}>
      <input type="color" value={(p[key] as string) ?? '#000000'} onChange={e => void correct({ [scheme]: { [key]: e.target.value } })} />
      <span>{label}<small>{p[key] as string}</small></span></label>)}</div>
  </div>;
  return <div className="sg">
    <div className="sg-head"><b>{brand.title} style guide</b>
      <small>Read from {brand.site ?? 'the code'}{brand.source ? ` and ${brand.source.ref}${brand.source.sha ? ` @ ${brand.source.sha.slice(0, 7)}` : ''}` : ''}{brand.corrected.length ? ` · your corrections: ${brand.corrected.join(', ')}` : ''}{brand.assistantCorrected?.length ? ` · the agent corrected: ${brand.assistantCorrected.join(', ')} (yours win)` : ''}</small>
      <button onClick={() => void derive()} disabled={busy}><Icon name="refresh" size={14}/>{busy ? 'Reading…' : 'Read again'}</button>
      {brand.corrected.length ? <button onClick={async () => { if (!confirm('Drop your corrections and use only what was read from the product?')) return; await correct({ vibe: '', notes: '', light: null, dark: null, accents: null, fonts: null }); }}>Reset corrections</button> : null}</div>
    {brand.warnings?.length ? <p className="warn">{brand.warnings.join(' · ')}</p> : null}
    <label className="sg-vibe"><span>The look, in words <small>what the agent designs from; edit it to steer every video</small></span>
      <textarea rows={4} value={vibe} onChange={e => setVibe(e.target.value)} onBlur={() => { if (vibe.trim() !== brand.vibe) void correct({ vibe: vibe.trim() }); }} /></label>
    <div className="sg-pals"><div><h4>Light</h4>{pal('light', brand.light)}</div>{brand.dark ? <div><h4>Dark</h4>{pal('dark', brand.dark)}</div> : null}</div>
    <div className="sg-row"><div><h4>Accents <small>colors the look actually uses, by screen area</small></h4>
      <div className="sg-chips">{brand.accents.length ? brand.accents.map(a => <span key={a.hex}><i style={{ background: a.hex }} />{a.hex} <small>{(a.share * 100).toFixed(1)}%</small></span>) : <small>None: a monochrome look.</small>}</div></div>
      <div><h4>For meaning only <small>a done check, an error: never decoration</small></h4>
      <div className="sg-chips">{Object.entries(brand.status).map(([k, v]) => <span key={k}><i style={{ background: v }} />{k}</span>)}</div></div>
      <div><h4>Type and shape</h4><small>Headlines {brand.fonts.heading}{brand.type.headlineWeight ? ` ${brand.type.headlineWeight}` : ''}{brand.type.headlineTracking ? `, ${brand.type.headlineTracking}` : ''} · text {brand.fonts.sans} · {brand.shape.buttons} buttons · {brand.shape.radius}px corners</small></div></div>
    <div className="sg-measured"><h4>What the screen is made of</h4><div className="sg-bar">{brand.swatches.filter(s => s.share > 0.004).map(s => <i key={s.hex} title={`${s.hex} · ${s.role} · ${(s.share * 100).toFixed(1)}%`} style={{ background: s.hex, flexGrow: s.share }} />)}</div></div>
    {brand.screenshots.length ? <div className="sg-shots">{brand.screenshots.filter(f => /-1\.png$/.test(f)).map(f => { const name = f.split('/').at(-1)!; return <img key={name} alt={name} src={`/api/account/studio/kits/${kit}/brand/shot/${name}`} />; })}</div> : null}
    <label className="sg-vibe"><span>Notes for the agent <small>anything the site doesn't say ("never use gradients", "the accent is our sky blue")</small></span>
      <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} onBlur={() => { if (notes.trim() !== (brand.notes ?? '')) void correct({ notes: notes.trim() }); }} /></label>
    <label className="sg-site"><span>Read the look from</span><input value={site} placeholder="https://your-site.com" onChange={e => setSite(e.target.value)} onBlur={() => { if (site.trim() && site.trim() !== brand.site) void correct({ site: site.trim() }).then(() => derive()); }} /></label>
  </div>;
}
