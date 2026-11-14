// The "Static ads" section of a Studio project's overview page: its batches newest first, each ad's images by size
// (click to open full size, download), the brand check's findings per ad (errors first), the report and the contact
// sheet; then reels made from the brand's footage (the video, its strip). Hidden when the project has none. Motion ads
// are videos: they sit in the Ads grid above.
import React, { useCallback, useEffect, useState } from 'react'
import { request } from './client'
import { saveExport } from './save-export'

type Finding = { level: 'error' | 'warn' | 'info'; rule: string; message: string }
type Image = { size: string; assetId: string; file: string; width: number; height: number; url: string; findings: Finding[] }
type Ad = { id: string; pattern: string; template: string; title?: string; notes?: string; flags: string[]; photo: Finding[]; people: boolean; images: Image[]; errors: number }
type Reel = { reelId: string; title: string; createdAt: string; seconds: number; notes: string[]; links: { reel: string; strip: string; notes: string } }
type Batch = { batchId: string; title?: string; createdAt: string; errors: number; ads: Ad[]; links: { report: string; reportJson: string; contactSheet: string }; withoutPeople: string[]; notes: string[] }

const SIZE_LABEL: Record<string, string> = { square: '1:1', portrait: '4:5', story: '9:16', landscape: '1.91:1' }
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
/**
 * Download, the same way a finished export is saved (./save-export.ts): a plain link does nothing in the desktop app,
 * whose web view drops downloads.
 */
function Download({ url, name }: { url: string; name: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [opened, setOpened] = useState(false)
  const save = () => {
    if (busy) return
    setBusy(true); setError(null)
    void saveExport({ url: `${url}?download=${encodeURIComponent(name)}`, fileName: name }).then((result) => setOpened(result.kind === 'browser')).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false))
  }
  return <>
    <button type="button" className="project-link static-download" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Download'}</button>
    {error ? <span className="static-download-error" role="alert">{error}</span> : null}
    {opened ? <span className="static-download-note" role="status">Opened in your browser: it downloads there if you are signed in.</span> : null}
  </>
}

/** An ad's findings, errors first, each said once (sizes share most of them). */
function findingsOf(ad: Ad): Finding[] {
  const order = { error: 0, warn: 1, info: 2 }
  const seen = new Set<string>()
  return [...ad.images.flatMap((i) => i.findings), ...ad.photo]
    .filter((f) => { const k = `${f.rule}|${f.message}`; if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => order[a.level] - order[b.level])
}

export function StaticAdsSection({ projectId, refreshKey }: { projectId: string; refreshKey: string }) {
  const [batches, setBatches] = useState<Batch[]>([])
  const [reels, setReels] = useState<Reel[]>([])
  const load = useCallback(async () => {
    try {
      const made = await request<{ batches: Batch[]; reels?: Reel[] }>(`/api/account/studio/campaigns/${encodeURIComponent(projectId)}/ad-batches`)
      setBatches(made.batches)
      setReels(made.reels ?? [])
    } catch {
      setBatches([])
      setReels([])
    }
  }, [projectId])
  useEffect(() => { void load() }, [load, refreshKey])
  useEffect(() => { const again = () => void load(); window.addEventListener('focus', again); return () => window.removeEventListener('focus', again) }, [load])
  if (!batches.length && !reels.length) return null

  return (
    <section className="project-section static-ads">
      {batches.length ? <div className="project-section-head"><h2>Static ads</h2></div> : null}
      {batches.map((b) => (
        <div key={b.batchId} className="static-batch">
          <div className="static-batch-head">
            <strong>{b.title ?? b.batchId}</strong>
            <span>{when(b.createdAt)} · {b.ads.length} ad{b.ads.length === 1 ? '' : 's'} · {b.errors ? <em className="static-errors">{b.errors} brand-check error{b.errors === 1 ? '' : 's'}</em> : 'brand check passes'}</span>
            <a className="project-link" href={b.links.contactSheet} target="_blank" rel="noreferrer">Contact sheet</a>
            <a className="project-link" href={b.links.report} target="_blank" rel="noreferrer">Report</a>
          </div>
          {b.notes.length ? <ul className="static-notes">{b.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
          {b.ads.map((ad) => {
            const findings = findingsOf(ad)
            return (
              <div key={ad.id} className="static-ad">
                <div className="static-ad-head">
                  <strong>{ad.id}</strong>
                  <span>{ad.pattern ? `${ad.pattern} · ` : ''}{ad.title ?? ad.template}</span>
                  {ad.errors ? <em className="static-errors">{ad.errors} error{ad.errors === 1 ? '' : 's'}</em> : <em className="static-ok">passes</em>}
                </div>
                <div className="static-ad-images">
                  {ad.images.map((i) => (
                    <figure key={i.size}>
                      <a href={i.url} target="_blank" rel="noreferrer" title={`Open the ${SIZE_LABEL[i.size] ?? i.size} full size`}>
                        <img loading="lazy" src={i.url} alt={`${ad.id} ${i.size}`} style={{ aspectRatio: `${i.width} / ${i.height}` }} />
                      </a>
                      <figcaption>{SIZE_LABEL[i.size] ?? i.size} <Download url={i.url} name={`${b.batchId}-${ad.id}-${i.size}-${i.width}x${i.height}.png`} /></figcaption>
                    </figure>
                  ))}
                </div>
                {findings.length || ad.flags.length ? (
                  <ul className="static-findings">
                    {findings.map((f) => <li key={`${f.rule}${f.message}`} className={f.level}><code>{f.rule}</code> {f.message}</li>)}
                    {ad.flags.map((f) => <li key={f} className="flag">Confirm before running: {f}</li>)}
                  </ul>
                ) : null}
              </div>
            )
          })}
        </div>
      ))}
      {reels.length ? <div className="project-section-head"><h2>Reels</h2></div> : null}
      {reels.map((r) => (
        <div key={r.reelId} className="static-batch">
          <div className="static-batch-head">
            <strong>{r.title}</strong>
            <span>{when(r.createdAt)} · {r.seconds.toFixed(1)} s · silent</span>
            <a className="project-link" href={r.links.reel} target="_blank" rel="noreferrer">Play</a>
            <Download url={r.links.reel} name={`${r.reelId}.mp4`} />
          </div>
          <a href={r.links.reel} target="_blank" rel="noreferrer"><img className="static-strip" loading="lazy" src={r.links.strip} alt={`${r.title}, stills`} /></a>
          {r.notes.length ? <ul className="static-notes">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
        </div>
      ))}
    </section>
  )
}
