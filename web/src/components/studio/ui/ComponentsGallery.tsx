import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { studioPortal } from '../studio-env';
import { Icon } from './icons';
import { request } from './client';

/** A product the agent set up from a folder the desktop app shares (src/lib/studio/server/products.ts). */
type Product = { name: string; title: string; repo: string; captures: number; listedAt: string | null };
/** A component as the product's last listing on the Mac reported it. */
type Entry = { id: string; name: string; group: string; help: string; curated: boolean; file: string; width: number; height: number; status: string };
/** A capture in the library: its asset, and whether the product's code still matches it. */
type Capture = { assetId: string; component: string; name: string; kind: 'video' | 'still'; seconds: number; width: number; height: number; capturedAt: string; current: boolean };
type Catalog = { components: Entry[]; captures: Capture[]; listedAt: string | null; source: { folder: string; mac: string; commit: string | null } };

const ago = (iso?: string | null) => { if (!iso) return ''; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
/** Why a component does not render on its own, in a few words (the listing's status). */
const need = (status: string) => status === 'ok' || status === 'unchecked' ? null : status === 'blank' ? 'needs data' : /must be used within|Provider|inside/i.test(status) ? 'needs the product around it' : 'does not render on its own';

/**
 * Components: the person's own product, filmed from its code on their Mac. The agent sets a product up and films its
 * components there (a local agent job in the folder the desktop app shares); this panel shows what came back and
 * places a capture on the video at the playhead as a layer that remembers what it shows. Nothing here runs the
 * product or asks for a path on the Mac: what needs the Mac is a sentence to say to the agent.
 */
export function ComponentsGallery({ projectId, at, disabled, notify, beforeEdit, afterEdit }: { projectId: string; at: number; disabled: boolean;
  notify?: (text: string, error?: boolean) => void; beforeEdit?: () => Promise<boolean>; afterEdit?: () => void }) {
  const [open, setOpen] = useState(false), [products, setProducts] = useState<Product[] | null>(null), [kit, setKit] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null), [query, setQuery] = useState(''), [pick, setPick] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [stale, setStale] = useState(0);
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const loadProducts = useCallback(async () => { try { const { kits } = await request<{ kits: Product[] }>('/api/account/studio/kits'); setProducts(kits); setKit(k => k ?? kits[0]?.name ?? null); } catch (e) { fail(e); } }, []);
  const loadCatalog = useCallback(async (name: string) => { try { const r = await request<Catalog>(`/api/account/studio/kits/${encodeURIComponent(name)}/catalog`); if (!alive.current) return; setCatalog(r); setPick(p => p && r.components.some(e => e.id === p.id) ? p : r.components.find(e => r.captures.some(c => c.component === e.id)) ?? r.components[0] ?? null); } catch (e) { fail(e); } }, []);
  useEffect(() => { if (open) void loadProducts(); }, [open, loadProducts]);
  useEffect(() => { if (open && kit) void loadCatalog(kit); }, [open, kit, loadCatalog]);
  useEffect(() => { void request<{ stale: unknown[] }>(`/api/account/studio/projects/${encodeURIComponent(projectId)}/components/status`).then(r => setStale(r.stale.length)).catch(() => setStale(0)); }, [projectId, open]);
  const place = async (capture: Capture) => {
    if (!kit) return;
    if (beforeEdit && !await beforeEdit()) { setError('Save your edit first'); return; }
    setBusy(true); setError(null);
    try {
      await request(`/api/account/studio/projects/${encodeURIComponent(projectId)}/components`, { kit, assetId: capture.assetId, at });
      afterEdit?.(); notify?.(`${pick?.name ?? 'The component'} added at ${at.toFixed(2)} s. Ask the agent to refresh it when the product changes.`); setOpen(false);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const shown = useMemo(() => { const q = query.trim().toLowerCase(); return (catalog?.components ?? []).filter(e => !q || `${e.name} ${e.group} ${e.help}`.toLowerCase().includes(q)); }, [catalog, query]);
  const groups = useMemo(() => { const m = new Map<string, Entry[]>(); for (const e of shown) m.set(e.group, [...(m.get(e.group) ?? []), e]); return [...m]; }, [shown]);
  const captures = useMemo(() => (catalog?.captures ?? []).filter(c => c.component === pick?.id), [catalog, pick?.id]);
  const product = products?.find(p => p.name === kit) ?? null;

  return <div className="tl-menu components-gallery">
    <button disabled={disabled} onClick={() => setOpen(true)} title="Your product's real interface, filmed from its code on your Mac: add it to the video"><Icon name="components" size={14}/>Components{stale ? ` · ${stale} to update` : ''}</button>
    {/* A dialog as the Studio's others are (controls.tsx Modal): over the whole window, Escape and outside close it. */}
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}><DialogPrimitive.Portal container={typeof document === 'undefined' ? null : studioPortal()}><DialogPrimitive.Overlay className="cg-overlay">
      <DialogPrimitive.Content className="cg-panel" aria-describedby={undefined}>
        <header className="cg-head"><DialogPrimitive.Title asChild><b>Components</b></DialogPrimitive.Title>
          <div className="cg-kits">{(products ?? []).map(p => <button key={p.name} className={p.name === kit ? 'active' : ''} onClick={() => setKit(p.name)} title={p.repo}>{p.title}</button>)}</div>
          <button onClick={() => setOpen(false)} aria-label="Close" title="Close"><Icon name="close"/></button></header>
        {stale ? <p className="cg-stale">The product changed since {stale === 1 ? 'one layer was' : `${stale} layers were`} filmed. Ask the agent in the chat to refresh this video&apos;s product components: it films them again on your Mac.</p> : null}
        {product && catalog ? <div className="cg-stage"><span>From {catalog.source.folder} on {catalog.source.mac}{catalog.listedAt ? `, listed ${ago(catalog.listedAt)}` : ''}{catalog.source.commit ? ` at ${catalog.source.commit.slice(0, 7)}` : ''}. Filmed on your Mac by the desktop app, read-only.</span></div> : null}
        {products && !products.length ? <p className="cg-empty">No product yet. Share your product&apos;s folder with the desktop app on your Mac, then ask the agent in the chat to set it up for the Studio.</p> : null}
        {error ? <p className="rec-error" role="alert">{error}</p> : null}
        {kit && catalog ? <div className="cg-body">
          <aside className="cg-list"><input type="search" placeholder={`Search ${catalog.components.length} components`} value={query} onChange={e => setQuery(e.target.value)} />
            <div className="cg-groups">{groups.map(([g, list]) => <section key={g}><h4>{g}</h4>{list.map(e => <button key={e.id} className={pick?.id === e.id ? 'active' : ''} onClick={() => setPick(e)} title={e.file}>{e.name}{e.curated && e.help ? <small>{e.help}</small> : need(e.status) ? <small className="cg-need">{need(e.status)}</small> : null}</button>)}</section>)}</div></aside>
          <section className="cg-preview">{pick ? <>
            <div className="cg-meta"><b>{pick.name}</b><small>{pick.file} · {pick.width}×{pick.height}</small>{pick.help ? <p>{pick.help}</p> : null}</div>
            {captures.length ? <ul className="cg-captures">{captures.map(c => <li key={c.assetId}>
              <span>{c.kind === 'video' ? `${c.seconds.toFixed(1)} s footage` : 'Still'} · {c.width}×{c.height} · {ago(c.capturedAt)}{c.current ? '' : ' · the code changed since'}</span>
              <button className="primary" disabled={busy || disabled} onClick={() => void place(c)}>Add at {at.toFixed(1)} s</button></li>)}</ul>
              : <p className="cg-empty">Not filmed yet. Ask the agent in the chat to film {pick.name} from {product?.title ?? 'the product'}, with the data and cursor moves the video needs.</p>}
          </> : <p className="cg-empty">Pick a component.</p>}</section>
        </div> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Overlay></DialogPrimitive.Portal></DialogPrimitive.Root>
  </div>;
}
