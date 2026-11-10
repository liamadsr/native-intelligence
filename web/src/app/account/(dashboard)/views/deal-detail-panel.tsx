'use client'

/**
 * One deal (roadmap #8): its stage, value, close date, owner, company and
 * contacts, its custom fields and notes, and its history. Every change, the
 * agent's from an email, a meeting or a text included, is listed with where it
 * came from and an Undo: apply with undo, never an accept/dismiss queue.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Building2, CircleDollarSign, Trash2, Undo2, User } from 'lucide-react'
import { toast } from 'sonner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityTitleInput } from '@/components/views/entity-title-input'
import { PropertyGroup } from '@/components/views/property-group'
import { CustomFieldsGroup } from '@/components/crm/custom-fields-group'
import { emitEntityDeleted, emitEntityUpdated } from '@/lib/entity-events'
import { describeChanges, type Deal, type DealEvent, type DealPipeline } from '@/lib/crm/deals'
import { formatDealValue } from '@/lib/crm/deal-format'
import { cn } from '@/lib/utils'
import { ReferencedIn } from '@/components/entity-links/referenced-in'
import { ContentTransition } from './transitions'

interface DealDetail {
  deal: Deal
  pipelines: DealPipeline[]
  company: { id: string; name: string | null } | null
  contacts: Array<{ id: string; name: string | null }>
  owner: { id: string; display_name: string | null } | null
  events: DealEvent[]
}

interface MemberOption {
  id: string
  display_name: string
}

const SOURCE_LABEL: Record<string, string> = {
  person: 'Changed in the app',
  agent: 'Your agent',
  email: 'From an email',
  capture: 'From a meeting',
  sms: 'From a text',
}

const fieldClass =
  'h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 text-sm hover:border-border focus:border-border focus:outline-none'

export function DealDetailPanel({
  dealId,
  onClose,
  onOpenEntity,
}: {
  dealId: string
  onClose: () => void
  /** Open the deal's company or one of its contacts. */
  onOpenEntity?: (type: string, id: string, label: string) => void
}) {
  const [detail, setDetail] = useState<DealDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [members, setMembers] = useState<MemberOption[]>([])
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [notes, setNotes] = useState('')
  const nameRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef<HTMLInputElement>(null)
  const notesRef = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async () => {
    const res = await fetch(`/api/account/deals/${dealId}`)
    if (!res.ok) {
      setDetail(null)
      setLoading(false)
      return
    }
    const json = (await res.json()) as DealDetail
    setDetail(json)
    // A reload (after any save) never overwrites what the person is typing.
    const typingIn = (el: HTMLElement | null) => !!el && el.contains(document.activeElement)
    if (!typingIn(nameRef.current)) setName(json.deal.name)
    if (!typingIn(valueRef.current)) setValue(json.deal.value === null ? '' : String(json.deal.value))
    if (!typingIn(notesRef.current)) setNotes(json.deal.notes ?? '')
    setLoading(false)
  }, [dealId])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    fetch('/api/account/workspace')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMembers(((d?.members ?? []) as MemberOption[]).map((m) => ({ id: m.id, display_name: m.display_name }))))
      .catch(() => {})
  }, [])

  const patch = async (fields: Record<string, unknown>) => {
    const res = await fetch(`/api/account/deals/${dealId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(json.error || 'Could not save the deal')
      void load()
      return
    }
    emitEntityUpdated({ entityType: 'deal', id: dealId, fields })
    void load()
  }

  const undo = async (eventId: string) => {
    const res = await fetch(`/api/account/deals/${dealId}/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: eventId }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(json.error || 'Could not undo that')
      return
    }
    toast.success(json.kept?.length ? 'Undone. Fields changed again since kept their newer value.' : 'Undone')
    emitEntityUpdated({ entityType: 'deal', id: dealId, fields: { stage_id: json.deal?.stage_id } })
    void load()
  }

  const remove = async () => {
    if (!window.confirm('Delete this deal and its history? This cannot be undone.')) return
    const res = await fetch(`/api/account/deals/${dealId}`, { method: 'DELETE' })
    if (!res.ok) {
      toast.error('Could not delete the deal')
      return
    }
    emitEntityDeleted({ entityType: 'deal', id: dealId })
    onClose()
  }

  const saveName = () => {
    const next = name.trim()
    if (detail && next && next !== detail.deal.name) void patch({ name: next })
  }

  const pipeline = useMemo(() => detail?.pipelines.find((p) => p.id === detail.deal.pipeline_id) ?? null, [detail])
  const stage = pipeline?.stages.find((s) => s.id === detail?.deal.stage_id)
  // The newest change the agent made (from the chat, an email, a meeting or a
  // text) that is still in place: shown up top with its Undo.
  const latestAuto = useMemo(() => {
    const latest = detail?.events.find((e) => e.kind !== 'undo')
    return latest && latest.kind !== 'created' && latest.source !== 'person' && !latest.undone_at ? latest : null
  }, [detail])

  return (
    <div className="relative flex h-full flex-col" data-deal-panel={dealId}>
      <div className="flex h-10 shrink-0 items-center justify-end px-3">
        <button
          type="button"
          aria-label="Delete deal"
          title="Delete deal"
          onClick={() => void remove()}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-red-500"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <ContentTransition contentKey={dealId} className="flex min-h-0 flex-1 flex-col">
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading...</div>
        ) : !detail ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Deal not found</div>
        ) : (
          <ScrollArea className="h-full">
            <div className="mx-auto max-w-[736px] space-y-5 px-8 pb-28">
              <div className="flex items-center gap-3 pt-6">
                <div
                  className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                    stage?.kind === 'won' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-primary/10 text-primary',
                  )}
                >
                  <CircleDollarSign className="h-5 w-5" />
                </div>
                <div ref={nameRef} className="min-w-0 flex-1" onBlur={saveName}>
                  <EntityTitleInput
                    className="text-lg"
                    value={name}
                    onChange={setName}
                    onCommit={saveName}
                    placeholder="Untitled deal"
                  />
                  <div className="px-0.5 text-sm text-muted-foreground">
                    {formatDealValue(detail.deal.value, detail.deal.currency) || 'No value yet'}
                    {stage ? ` · ${stage.name}` : ''}
                  </div>
                </div>
              </div>

              {pipeline && (
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Stage">
                  {pipeline.stages.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={s.id === detail.deal.stage_id}
                      onClick={() => s.id !== detail.deal.stage_id && void patch({ stage_id: s.id })}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs transition-colors',
                        s.id === detail.deal.stage_id
                          ? s.kind === 'won'
                            ? 'border-emerald-500 bg-emerald-500 text-white'
                            : s.kind === 'lost'
                              ? 'border-red-500/70 bg-red-500/70 text-white'
                              : 'border-foreground bg-foreground text-background'
                          : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}

              {latestAuto && (
                // The agent's latest change, up top with its Undo: apply with
                // undo, never a queue (Liam's rule). Gone once it is undone.
                <div className="flex items-start gap-3 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-sm" data-deal-latest-change="">
                  <div className="min-w-0 flex-1">
                    <div className="text-foreground/90">
                      {SOURCE_LABEL[latestAuto.source] ?? 'Your agent'}: {describeChanges(latestAuto.changes ?? {}, { pipelines: detail.pipelines, currency: detail.deal.currency }).join('; ')}
                    </div>
                    {latestAuto.reason && <div className="text-xs text-muted-foreground">{latestAuto.reason}</div>}
                  </div>
                  <button
                    type="button"
                    onClick={() => void undo(latestAuto.id)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Undo2 className="h-3 w-3" /> Undo
                  </button>
                </div>
              )}

              <PropertyGroup>
                <div className="grid grid-cols-[120px_1fr] items-center gap-x-2 gap-y-0.5 px-3">
                  <span className="text-xs text-muted-foreground">Value</span>
                  <div className="flex items-center gap-1">
                    <input
                      ref={valueRef}
                      className={cn(fieldClass, 'w-40 flex-none')}
                      inputMode="decimal"
                      placeholder="Empty"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      onBlur={() => {
                        const next = value.trim() === '' ? null : Number(value.replace(/[,\s$€£]/g, ''))
                        if (next !== null && !Number.isFinite(next)) return toast.error('The value is a number')
                        if (next !== detail.deal.value) void patch({ value: next })
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    />
                    <input
                      // Keyed on the saved code, so an undo or a refused save shows the real one.
                      key={detail.deal.currency}
                      className={cn(fieldClass, 'w-16 flex-none uppercase text-muted-foreground')}
                      defaultValue={detail.deal.currency}
                      maxLength={3}
                      aria-label="Currency"
                      onBlur={(e) => {
                        const c = e.target.value.trim().toUpperCase()
                        if (c && c !== detail.deal.currency) void patch({ currency: c })
                      }}
                    />
                  </div>

                  <span className="text-xs text-muted-foreground">Expected close</span>
                  <input
                    type="date"
                    className={fieldClass}
                    value={detail.deal.expected_close_date ?? ''}
                    onChange={(e) => void patch({ expected_close_date: e.target.value || null })}
                  />

                  <span className="text-xs text-muted-foreground">Owner</span>
                  <select
                    className={cn(fieldClass, 'cursor-pointer')}
                    value={detail.deal.owner_id ?? ''}
                    onChange={(e) => void patch({ owner_id: e.target.value || null })}
                  >
                    <option value="">No owner</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>{m.display_name}</option>
                    ))}
                    {detail.owner && !members.some((m) => m.id === detail.owner!.id) && (
                      <option value={detail.owner.id}>{detail.owner.display_name ?? 'Owner'}</option>
                    )}
                  </select>

                  <span className="text-xs text-muted-foreground">Company</span>
                  <div className="px-2 py-1 text-sm">
                    {detail.company ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 hover:underline"
                        onClick={() => onOpenEntity?.('company', detail.company!.id, detail.company!.name ?? 'Company')}
                      >
                        <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                        {detail.company.name ?? 'Company'}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </div>

                  <span className="self-start pt-1.5 text-xs text-muted-foreground">Contacts</span>
                  <div className="flex flex-wrap gap-1 px-2 py-1 text-sm">
                    {detail.contacts.length ? (
                      detail.contacts.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-xs hover:bg-muted"
                          onClick={() => onOpenEntity?.('contact', c.id, c.name ?? 'Contact')}
                        >
                          <User className="h-3 w-3 text-muted-foreground" />
                          {c.name ?? 'Contact'}
                        </button>
                      ))
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </div>
                </div>
              </PropertyGroup>

              <CustomFieldsGroup
                // Re-read after any change to the deal (an Undo included).
                key={detail.deal.updated_at}
                entityType="deal"
                recordId={dealId}
                showAddWhenEmpty
                onChanged={() => void load()}
              />

              <ReferencedIn entityType="deal" entityId={dealId} />

              <PropertyGroup title="History">
                <ul className="space-y-1 px-3" data-deal-history="">
                  {detail.events.map((e) => {
                    const lines = describeChanges(e.changes ?? {}, { pipelines: detail.pipelines, currency: detail.deal.currency })
                    const undoable = e.kind !== 'created' && e.kind !== 'undo' && !e.undone_at && lines.length > 0
                    return (
                      <li key={e.id} className={cn('flex items-start gap-2 rounded-md py-1.5 text-sm', e.undone_at && 'opacity-50')}>
                        <div className="min-w-0 flex-1">
                          <div className="text-foreground/90">
                            {e.kind === 'created' ? 'Created' : e.kind === 'undo' ? `Undid: ${lines.join('; ')}` : lines.join('; ')}
                          </div>
                          {e.reason && <div className="text-xs text-muted-foreground">{e.reason}</div>}
                          <div className="text-[11px] text-muted-foreground">
                            {SOURCE_LABEL[e.source] ?? e.source} · {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
                            {e.undone_at ? ' · undone' : ''}
                          </div>
                        </div>
                        {undoable && (
                          <button
                            type="button"
                            onClick={() => void undo(e.id)}
                            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <Undo2 className="h-3 w-3" /> Undo
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </PropertyGroup>

              <PropertyGroup title="Notes">
                <textarea
                  ref={notesRef}
                  className="min-h-[80px] w-full resize-y rounded-md border border-transparent bg-transparent px-3 py-2 text-sm hover:border-border focus:border-border focus:outline-none"
                  placeholder="Add notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={() => notes !== (detail.deal.notes ?? '') && void patch({ notes: notes || null })}
                />
              </PropertyGroup>
            </div>
          </ScrollArea>
        )}
      </ContentTransition>
    </div>
  )
}
