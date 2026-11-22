'use client'

/**
 * Settings › Email & CRM › Company stages (migration 679): the workspace's
 * company lifecycle stages. An owner or admin renames, reorders, adds and
 * deletes them, or resets them to Lead, Demo, Customer, Churned. Deleting a
 * stage moves its companies to No stage (the dialog says how many moved).
 * Everyone else sees the list read-only. The server and the database check
 * the role again; this only hides what would be refused.
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useWorkspaces } from '@/app/account/workspace-switcher'
import { invalidateCompanyStages, useCompanyStages } from '@/components/crm/company-crm-fields'
import { DEFAULT_COMPANY_STAGES, NO_STAGE_LABEL, type CompanyStage } from '@/lib/crm/company-stages'

async function send(url: string, init: RequestInit): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) toast.error(typeof json.error === 'string' ? json.error : 'Couldn’t save that')
  return { ok: res.ok, json }
}

export function CompanyStagesSettings() {
  const stages = useCompanyStages()
  const { workspaces, currentId } = useWorkspaces()
  const role = workspaces.find((w) => w.id === currentId)?.role
  const canEdit = role === 'owner' || role === 'admin'
  const [names, setNames] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (stages) setNames(Object.fromEntries(stages.map((s) => [s.id, s.name])))
  }, [stages])

  const refresh = (next?: CompanyStage[]) => invalidateCompanyStages(next)

  const rename = async (s: CompanyStage) => {
    const name = (names[s.id] ?? '').trim()
    if (!name || name === s.name) {
      setNames((n) => ({ ...n, [s.id]: s.name }))
      return
    }
    const r = await send(`/api/account/company-stages/${s.id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    if (r.ok) refresh()
    else setNames((n) => ({ ...n, [s.id]: s.name }))
  }

  const move = async (index: number, dir: -1 | 1) => {
    if (!stages) return
    const order = stages.map((s) => s.id)
    const j = index + dir
    if (j < 0 || j >= order.length) return
    ;[order[index], order[j]] = [order[j], order[index]]
    setBusy(true)
    const r = await send('/api/account/company-stages', { method: 'PUT', body: JSON.stringify({ order }) })
    setBusy(false)
    if (r.ok) refresh(r.json.stages as CompanyStage[])
  }

  const remove = async (s: CompanyStage) => {
    if (!window.confirm(`Delete the stage “${s.name}”? Its companies move to ${NO_STAGE_LABEL}.`)) return
    setBusy(true)
    const r = await send(`/api/account/company-stages/${s.id}`, { method: 'DELETE' })
    setBusy(false)
    if (r.ok) {
      const moved = Number(r.json.companies_moved ?? 0)
      toast(moved ? `Deleted. ${moved} ${moved === 1 ? 'company moved' : 'companies moved'} to ${NO_STAGE_LABEL}.` : 'Deleted.')
      refresh()
    }
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!adding.trim()) return
    setBusy(true)
    const r = await send('/api/account/company-stages', { method: 'POST', body: JSON.stringify({ name: adding }) })
    setBusy(false)
    if (r.ok) {
      setAdding('')
      refresh()
    }
  }

  const reset = async () => {
    if (!window.confirm(`Reset to ${DEFAULT_COMPANY_STAGES.join(', ')}? Other stages are deleted and their companies move to ${NO_STAGE_LABEL}.`)) return
    setBusy(true)
    const r = await send('/api/account/company-stages/reset', { method: 'POST' })
    setBusy(false)
    if (r.ok) refresh(r.json.stages as CompanyStage[])
  }

  return (
    <Card data-company-stages-settings="">
      <CardHeader>
        <CardTitle className="text-base">Company stages</CardTitle>
        <CardDescription>
          Where each company is in its life with you, separate from any deal. A new company starts at {NO_STAGE_LABEL}.
          {!canEdit && ' Only a workspace owner or admin changes these.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {stages === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="space-y-1">
            {stages.map((s, i) => (
              <li key={s.id} className="flex items-center gap-2">
                <Input
                  value={names[s.id] ?? s.name}
                  disabled={!canEdit || busy}
                  onChange={(e) => setNames((n) => ({ ...n, [s.id]: e.target.value }))}
                  onBlur={() => void rename(s)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  maxLength={60}
                  className="h-8 max-w-xs"
                  aria-label={`Stage ${i + 1}`}
                />
                {canEdit && (
                  <>
                    <Button size="icon" variant="ghost" className="h-7 w-7" disabled={busy || i === 0} onClick={() => void move(i, -1)} aria-label="Move up">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" disabled={busy || i === stages.length - 1} onClick={() => void move(i, 1)} aria-label="Move down">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" disabled={busy} onClick={() => void remove(s)} aria-label={`Delete ${s.name}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </li>
            ))}
            {stages.length === 0 && <li className="text-sm text-muted-foreground">No stages. Every company is at {NO_STAGE_LABEL}.</li>}
          </ul>
        )}
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <form onSubmit={add} className="flex items-center gap-2">
              <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="New stage" maxLength={60} className="h-8 w-48" aria-label="New stage" />
              <Button size="sm" type="submit" variant="outline" disabled={busy || !adding.trim()}>
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </form>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reset()}>
              <RotateCcw className="h-3.5 w-3.5" />
              Reset to defaults
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
