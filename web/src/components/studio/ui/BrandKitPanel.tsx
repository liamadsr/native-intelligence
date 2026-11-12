// The Brand panel of a Studio project's overview page: the brand summary, and, on Edit, the project's brand kit:
// name, palette (named colour tokens), the two font roles (upload the brand's files or name a free family), the
// logos with the approved logo colour per ground, and the rest of the kit as raw JSON ("Brand rules"), where a brand
// folder's brand.json, fonts.json, rules.json or sound.json can also be pasted. Errors show where they happened.
import React, { useCallback, useEffect, useState } from 'react'
import { Icon } from './icons'
import { StudioSelect } from './controls'
import { assetHref } from '@/lib/studio/engine/asset-base'
import type { CampaignSummary } from '@/lib/studio/engine/api'
import type { EditorAsset } from '@/lib/studio/engine/contracts'
import type { BrandKit } from '@/lib/studio/server/ads-contract'
import { importFile, put, request } from './client'

type View = { projectId: string; kit: BrandKit | null; logos: { primary?: EditorAsset; mark?: EditorAsset }; needs: string[] }
type Role = 'serif' | 'sans'
const api = (id: string, rest = '') => `/api/account/studio/campaigns/${encodeURIComponent(id)}/brand-kit${rest}`
/** The kit's fields the raw JSON editor holds (everything the form above it doesn't). */
const REST_KEYS = ['roles', 'logoOnPhoto', 'rules', 'motion', 'sounds', 'shades', 'extra'] as const
const restOf = (kit: BrandKit) => Object.fromEntries(REST_KEYS.filter((k) => kit[k] !== undefined).map((k) => [k, kit[k]]))
const isStored = (file: string) => file.startsWith('brand-kits/')
const fileName = (file: string) => (file.split('/').pop() ?? file).replace(/^[a-f0-9]{8}-/, '')

/** A file's bytes as base64, in chunks (font files are small, but not tiny). */
async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** The brand summary the page has always shown (colours, logo, fonts). */
function Summary({ campaign }: { campaign: CampaignSummary }) {
  if (!campaign.brand?.colors?.length && !campaign.brand?.fonts?.length) return <p className="project-empty">No brand yet. Edit to add the brand kit that ads are made from: its colors, fonts and logo.</p>
  return (
    <>
      {campaign.brand.colors?.length ? <div className="project-swatches">{campaign.brand.colors.map((c) => <span key={c.name} title={`${c.name} ${c.hex}`} style={{ background: c.hex }} />)}</div> : null}
      {campaign.logoFile ? <span className="project-logo"><img src={`/${campaign.logoFile}`} alt={`${campaign.brand.name ?? campaign.title} logo`} /></span> : null}
      {campaign.brand.fonts?.length ? <div className="project-fonts">{campaign.brand.fonts.map((f) => <span key={f} style={{ fontFamily: `"${f}"` }}>{f}</span>)}</div> : null}
    </>
  )
}

export function BrandKitPanel({ campaign, onChanged, notify }: { campaign: CampaignSummary; onChanged: () => void; notify: (text: string, error?: boolean) => void }) {
  const [editing, setEditing] = useState(false)
  const [view, setView] = useState<View | null>(null)
  const [kit, setKit] = useState<BrandKit | null>(null)
  const [rules, setRules] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const v = await request<View>(api(campaign.id))
      setView(v)
      setKit(v.kit)
      setRules(v.kit ? JSON.stringify(restOf(v.kit), null, 2) : '')
    } catch (e) {
      notify((e as Error).message, true)
    }
  }, [campaign.id, notify])
  useEffect(() => { if (editing) void load() }, [editing, load])

  /** Save, showing a refusal under the part it came from. */
  const save = async (where: string, work: () => Promise<View>) => {
    if (busy) return
    setBusy(true)
    try {
      const v = await work()
      setView(v)
      setKit(v.kit)
      if (where !== 'rules' && v.kit) setRules(JSON.stringify(restOf(v.kit), null, 2))
      setErrors({})
      onChanged()
    } catch (e) {
      setErrors({ [where]: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const saveKit = (where: string, next: BrandKit) => save(where, () => put<View>(api(campaign.id), { kit: next }))
  const blank = (): BrandKit => ({ schemaVersion: 1, name: campaign.brand?.name ?? campaign.title, palette: {}, fonts: { serif: { family: 'Instrument Serif', standIn: 'Instrument Serif', faces: [], weights: {} }, sans: { family: 'Inter', standIn: 'Inter', faces: [], weights: {} } } } as unknown as BrandKit)
  const k = kit ?? blank()
  const edit = (patch: Partial<BrandKit>) => setKit({ ...k, ...patch })

  const saveRules = () => {
    let value: unknown
    try {
      value = JSON.parse(rules || '{}')
    } catch {
      setErrors({ rules: 'That is not valid JSON.' })
      return
    }
    const obj = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>
    const onlyRest = Object.keys(obj).every((key) => (REST_KEYS as readonly string[]).includes(key))
    // The kit's remaining fields merge into the form's; anything else (a brand folder's files) goes to the server as pasted.
    void save('rules', () => put<View>(api(campaign.id), { kit: onlyRest ? { ...k, ...obj } : obj }))
  }
  const uploadFonts = (role: Role, files: FileList | null) => {
    if (!files?.length) return
    void save(`font-${role}`, async () => {
      let v: View | null = null
      for (const file of Array.from(files)) v = await request<View>(api(campaign.id, '/font'), { role, name: file.name, data: await base64(file) })
      return v!
    })
  }
  const uploadLogo = (slot: 'primary' | 'mark', file: File | undefined) => {
    if (!file) return
    void save(`logo-${slot}`, async () => {
      const { asset } = await importFile<{ asset: EditorAsset }>(file)
      return request<View>(api(campaign.id, '/logo'), { slot, assetId: asset.id })
    })
  }

  const err = (where: string) => (errors[where] ? <p className="brand-kit-error" role="alert">{errors[where]}</p> : null)
  const tokens = Object.keys(k.palette)
  const fontRole = (role: Role) => {
    const f = k.fonts[role]
    return (
      <div className="brand-kit-font" key={role}>
        <span className="brand-kit-label">{role === 'serif' ? 'Serif' : 'Sans'}</span>
        <input aria-label={`${role} family`} value={f.family} placeholder="Family" onChange={(e) => edit({ fonts: { ...k.fonts, [role]: { ...f, family: e.target.value } } })} />
        <input aria-label={`${role} stand-in`} value={typeof f.standIn === 'string' ? f.standIn : ''} placeholder="Free stand-in (Google Fonts, Fontshare)" title="Drawn while the brand's own files aren't uploaded"
          onChange={(e) => edit({ fonts: { ...k.fonts, [role]: { ...f, standIn: e.target.value || undefined } } })} />
        <div className="brand-kit-faces">
          {f.faces.map((x, i) => <span key={i} className={isStored(x.file) ? 'stored' : 'pending'} title={isStored(x.file) ? 'Uploaded' : 'Waiting for its file'}>{fileName(x.file)} · {x.weight}{x.style === 'italic' ? ' italic' : ''}</span>)}
          <label className="project-link">Upload files<input type="file" hidden multiple accept=".otf,.ttf,.woff,.woff2" onChange={(e) => { uploadFonts(role, e.target.files); e.target.value = '' }} /></label>
        </div>
        {err(`font-${role}`)}
      </div>
    )
  }
  const logoSlot = (slot: 'primary' | 'mark') => {
    const a = view?.logos[slot]
    return (
      <div className="brand-kit-logo" key={slot}>
        <span className="brand-kit-label">{slot === 'primary' ? 'Logo' : 'Mark'}</span>
        {a ? <span className="brand-kit-mask" role="img" aria-label={`${slot} logo`} style={{ aspectRatio: `${a.width ?? 4} / ${a.height ?? 1}`, WebkitMaskImage: `url("${assetHref(a.file)}")`, maskImage: `url("${assetHref(a.file)}")` }} /> : <span className="project-empty">PNG mask with transparency</span>}
        <label className="project-link">{a ? 'Replace' : 'Upload'}<input type="file" hidden accept="image/png" onChange={(e) => { uploadLogo(slot, e.target.files?.[0]); e.target.value = '' }} /></label>
        {err(`logo-${slot}`)}
      </div>
    )
  }

  return (
    <section className={`project-panel brand-kit${editing ? ' editing' : ''}`}>
      <div className="project-section-head"><h2>Brand</h2><button className="project-link" onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Edit'}</button></div>
      {!editing ? <Summary campaign={campaign} /> : !view ? <p className="project-empty">Loading the brand kit…</p> : (
        <div className="brand-kit-form">
          {view.needs.length ? <ul className="brand-kit-needs">{view.needs.map((n) => <li key={n}>{n}</li>)}</ul> : <p className="brand-kit-ready">Ready: static and motion ads can be made from this kit.</p>}
          <div className="brand-kit-row">
            <span className="brand-kit-label">Name</span>
            <input aria-label="Brand name" value={k.name} onChange={(e) => edit({ name: e.target.value })} />
          </div>
          <div className="brand-kit-palette">
            <span className="brand-kit-label">Palette</span>
            {tokens.map((t) => (
              <div key={t} className="brand-kit-colour">
                <input type="color" aria-label={`${t} color`} value={k.palette[t]} onChange={(e) => edit({ palette: { ...k.palette, [t]: e.target.value.toUpperCase() } })} />
                <code>{t}</code><span>{k.palette[t]}</span>
                <button aria-label={`Remove ${t}`} title={`Remove ${t}`} onClick={() => { const { [t]: _gone, ...rest } = k.palette; edit({ palette: rest }) }}><Icon name="close" size={14}/></button>
              </div>
            ))}
            <button className="project-link" onClick={() => { const t = window.prompt('Color name (a name like warmGround)')?.trim(); if (t && /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(t)) edit({ palette: { ...k.palette, [t]: '#888888' } }) }}>Add color</button>
          </div>
          <div className="brand-kit-fonts">{fontRole('serif')}{fontRole('sans')}</div>
          <div className="brand-kit-logos">
            {logoSlot('primary')}{logoSlot('mark')}
            <div className="brand-kit-logo-on">
              <span className="brand-kit-label">Logo color on each ground</span>
              {tokens.map((g) => (
                <label key={g}><code>{g}</code>
                  <StudioSelect size="normal" aria-label={`Logo color on ${g}`} value={k.logoOn[g] ?? ''} onChange={v => { const { [g]: _old, ...rest } = k.logoOn; edit({ logoOn: v ? { ...rest, [g]: v } : rest }) }}>
                    <option value="">no logo</option>
                    {tokens.filter((t) => t !== g).map((t) => <option key={t} value={t}>{t}</option>)}
                  </StudioSelect>
                </label>
              ))}
            </div>
          </div>
          <div className="brand-kit-actions"><button className="project-new" disabled={busy} onClick={() => void saveKit('form', k)}>Save brand</button>{err('form')}</div>
          <div className="brand-kit-rules">
            <span className="brand-kit-label">Brand rules (JSON)</span>
            <p className="project-empty">Template roles, the brand check&apos;s rules, the motion rules and the sound library. A brand folder&apos;s brand.json, fonts.json, rules.json or sound.json can be pasted here too (or several under their file names).</p>
            <textarea spellCheck={false} value={rules} onChange={(e) => setRules(e.target.value)} />
            <div className="brand-kit-actions"><button className="project-new" disabled={busy} onClick={saveRules}>Save rules</button>{err('rules')}</div>
          </div>
        </div>
      )}
    </section>
  )
}
