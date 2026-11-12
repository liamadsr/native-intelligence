import { studioKeys } from '../studio-env';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { request } from './client';
import type { CostEntry, CostSummary } from '@/lib/studio/engine/server-types';

// The header's cost chip: what this video has cost so far through the Studio (its narration and generated shots; the
// server's ledger, costs.ts). Opens a breakdown by provider and model, every charge (with a way to move strays out),
// charges no video owns yet, and the rates.
const money = (v: number) => v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
const PROVIDER: Record<string, string> = { higgsfield: 'Higgsfield', elevenlabs: 'ElevenLabs', claude: 'Claude agent' };
const when = (at: string) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const creditsLabel = (e: Pick<CostEntry, 'provider' | 'credits'>) => e.provider === 'claude' ? '' : `${Math.round(e.credits * 100) / 100} cr`;

export function CostChip({ projectId }: { projectId: string }) {
  const [data, setData] = useState<CostSummary | null>(null), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'charges' | 'unassigned' | 'rates'>('charges'), wrap = useRef<HTMLDivElement>(null);
  const load = useCallback(async (sync = false) => { setBusy(true); setError(null);
    try { setData(await request<CostSummary>(`/api/account/studio/projects/${encodeURIComponent(projectId)}/costs${sync ? '?sync=1' : ''}`)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }, [projectId]);
  useEffect(() => { setData(null); void load(); const t = setInterval(() => void load(), 5 * 60_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (!open) return; const close = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close); studioKeys.addEventListener('keydown', esc); return () => { window.removeEventListener('pointerdown', close); studioKeys.removeEventListener('keydown', esc); }; }, [open]);
  const move = async (ids: string[], to: string | null) => { setBusy(true); try { await request('/api/account/studio/costs/assign', { ids, projectId: to }); await load(); } catch (e) { setError((e as Error).message); setBusy(false); } };
  const saveRate = async (provider: 'higgsfield' | 'elevenlabs', value: string) => { const v = Number(value); if (!Number.isFinite(v) || v < 0) return;
    try { await request('/api/account/studio/costs/rates', { [provider]: { usdPerCredit: v } }); await load(); } catch (e) { setError((e as Error).message); } };
  const rows = (list: CostEntry[], action: (e: CostEntry) => ReactNode) => list.length ? <ul className="cost-rows">{list.map(e =>
    <li key={e.id} title={e.detail ?? undefined}><span className="cost-when">{when(e.at)}</span><span className="cost-what"><strong>{e.model}</strong><small>{e.kind === 'refund' ? 'Refund' : e.detail ?? e.kind}</small></span>
      <span className="cost-num">{creditsLabel(e)}<b>{e.usd < 0 ? `−${money(-e.usd)}` : money(e.usd)}</b></span>{action(e)}</li>)}</ul> : <p className="cost-empty">Nothing here.</p>;
  return <div className="cost-wrap" ref={wrap}>
    <button className={`cost-chip${open ? ' on' : ''}`} onClick={() => { setOpen(o => !o); if (!open) void load(); }} title="What this video has cost so far" aria-expanded={open}>
      <span className="cost-dot" aria-hidden="true"/>{data ? money(data.usd) : busy ? '…' : '$—'}</button>
    {open ? <div className="cost-pop" role="dialog" aria-label="Video cost">
      <div className="cost-head"><div><small>This video so far</small><strong>{data ? money(data.usd) : '…'}</strong></div>
        <button className="subtle-button" disabled={busy} onClick={() => void load(true)}>{busy ? 'Loading…' : 'Refresh'}</button></div>
      {data ? <>
        <div className="cost-providers">{data.providers.length ? data.providers.map(p => <div key={p.provider}><span>{PROVIDER[p.provider]}</span><b>{money(p.usd)}</b>
          <small>{p.provider === 'claude' ? `${p.count} session${p.count === 1 ? '' : 's'}` : `${Math.round(p.credits * 100) / 100} credits · ${p.count}`}</small></div>) : <p className="cost-empty">No charges found for this video yet.</p>}</div>
        {data.models.length ? <table className="cost-models"><tbody>{data.models.slice(0, 8).map(m => <tr key={`${m.provider}${m.model}${m.kind}`}><td>{m.model}<small>{m.kind}</small></td><td>×{m.count}</td><td>{money(m.usd)}</td></tr>)}</tbody></table> : null}
        <div className="segmented cost-tabs">{(['charges', 'unassigned', 'rates'] as const).map(t => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
          {t === 'charges' ? `Charges (${data.entries.length})` : t === 'unassigned' ? `Unassigned (${data.unassigned.length})` : 'Rates'}</button>)}</div>
        {tab === 'charges' ? rows(data.entries, e => e.provider === 'claude' ? null : <button className="cost-act" title="Not part of this video" onClick={() => void move([e.id], null)}>Remove</button>)
          : tab === 'unassigned' ? <>{data.unassigned.length ? <button className="full-button" disabled={busy} onClick={() => void move(data.unassigned.map(e => e.id), projectId)}>Add all {data.unassigned.length} to this video ({money(data.unassigned.reduce((s, e) => s + e.usd, 0))})</button> : null}
            {rows(data.unassigned, e => <button className="cost-act" onClick={() => void move([e.id], projectId)}>Add</button>)}</>
          : <div className="cost-rates">{(['higgsfield', 'elevenlabs'] as const).map(p => <label key={p}><span>{PROVIDER[p]}<small>{data.rates[p].plan}</small></span>
              <span className="cost-rate-input">$<input type="number" step="0.0001" min="0" defaultValue={data.rates[p].usdPerCredit.toFixed(5)} onBlur={e => void saveRate(p, e.target.value)}/>/credit</span></label>)}
            <p className="hint">Dollars are credits times your plan's price per credit (ElevenLabs counts characters as credits). Only what the Studio spent is counted.</p></div>}
        <p className="cost-foot">{data.syncedAt ? `Synced ${when(data.syncedAt)}` : null}{data.warnings.map(w => <span key={w} className="cost-warn">{w}</span>)}</p>
      </> : null}
      {error ? <p className="cost-warn">{error}</p> : null}
    </div> : null}
  </div>;
}
