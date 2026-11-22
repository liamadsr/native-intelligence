'use client'

/**
 * Spreadsheets (migration 675): the workspace's workbooks. The list, a way to
 * make one, and one workbook open in its editor
 * (src/components/spreadsheets/spreadsheet-editor.tsx). It owns its fetches
 * against /api/account/spreadsheets, as the Tables page does.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Lock, Plus, Sheet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SpreadsheetEditor } from '@/components/spreadsheets/spreadsheet-editor'
import { CardHeaderSlot } from '@/components/chat-cards/card-header-slot'
import { CARD_HEADER_PILL_BUTTON } from '@/components/chat-cards/card-header-button'
import { EntityContextMenu } from '@/components/entities/entity-actions-menu'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import { relativeTime } from '@/lib/work/presentation'
import { cn } from '@/lib/utils'
import type { SpreadsheetSummary } from '@/lib/spreadsheets/types'
import type { ListSharing } from '@/lib/entity-access/store'

/** A list row's word on sharing (688): shared with you, or shared with how many (its maker's). */
export function listSharingText(sharing: ListSharing | undefined): string | null {
  if (!sharing) return null
  if (sharing.shared_with_me) return 'Shared with you'
  return sharing.shared_count > 0 ? `Shared · ${sharing.shared_count}` : null
}
import { openCreateDialog } from '@/lib/create/open-create'
import { ViewHeader } from './view-header'

async function readJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(json.error || 'Something went wrong')
  return json
}

/** A chat card's hold on the page: which spreadsheet is open, and how opening one moves the card. */
export interface SpreadsheetsCardState {
  openId: string | null
  onOpen: (id: string | null, name?: string) => void
}

export function SpreadsheetsView({ onCount, card }: { onCount?: (count: number) => void; card?: SpreadsheetsCardState } = {}) {
  const [sheets, setSheets] = useState<SpreadsheetSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ownOpenId, setOwnOpenId] = useState<string | null>(null)
  const openId = card ? card.openId : ownOpenId
  const setOpenId = (id: string | null, name?: string) => {
    if (card) card.onOpen(id, name ?? sheets?.find((s) => s.id === id)?.title)
    else setOwnOpenId(id)
  }
  const onCountRef = useRef(onCount)
  onCountRef.current = onCount
  useEffect(() => {
    if (sheets) onCountRef.current?.(sheets.length)
  }, [sheets])

  const load = useCallback(async () => {
    try {
      const json = await readJson<{ spreadsheets: SpreadsheetSummary[] }>(await fetch('/api/account/spreadsheets'))
      setSheets(Array.isArray(json.spreadsheets) ? json.spreadsheets : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load spreadsheets')
      setSheets([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // A rename, archive or restore from a row's menu (the one entity actions
  // menu) changes the list: read it again so an archived one leaves and a
  // rename shows.
  useEntityListSync(['spreadsheet'], () => void load())

  // New spreadsheet opens the one Create composer on Spreadsheet (a name first;
  // docs/plans/create-everything.md); the list takes in what is made there.
  const create = () => openCreateDialog({ type: 'spreadsheet' })
  useEffect(() => {
    const onCreated = (e: Event) => {
      if ((e as CustomEvent<{ entityType?: string }>).detail?.entityType === 'spreadsheet') void load()
    }
    window.addEventListener('ni:entity-created', onCreated)
    return () => window.removeEventListener('ni:entity-created', onCreated)
  }, [load])

  if (openId) {
    return (
      <SpreadsheetEditor
        key={openId}
        spreadsheetId={openId}
        onBack={() => {
          setOpenId(null)
          void load()
        }}
        onOpen={(id, name) => {
          void load()
          setOpenId(id, name)
        }}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      {card ? (
        // In a card its header already names the page (Liam, 11-22: "remove
        // the duplicate title on the spreadsheets page"): New spreadsheet goes
        // there, on the header's glass like the layout switcher's capsule.
        <CardHeaderSlot side="right">
          <button
            type="button"
            onClick={create}
            data-new-spreadsheet=""
            className={CARD_HEADER_PILL_BUTTON}
          >
            <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
            New spreadsheet
          </button>
        </CardHeaderSlot>
      ) : (
        <ViewHeader
          title="Spreadsheets"
          actions={
            <Button size="sm" onClick={create}>
              <Plus className="h-3.5 w-3.5" />
              New spreadsheet
            </Button>
          }
        />
      )}
      {/* In a card, a row's icon and name stand under the header's icon and
          title: 19px and 41px from the page's edge (show-tool-card.tsx, the island). */}
      <div className={cn('min-h-0 flex-1 overflow-y-auto pb-6', card ? 'pl-[18px] pr-5 pt-2' : 'px-5')}>
        {sheets === null ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="py-10 text-center text-sm text-destructive">{error}</p>
        ) : sheets.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <Sheet className="h-7 w-7 text-muted-foreground/60" />
            <div>
              <p className="text-sm font-medium text-foreground">No spreadsheets yet</p>
              <p className="mt-1 text-sm text-muted-foreground">A spreadsheet is a grid of cells with formulas: a budget, a forecast, a model.</p>
            </div>
            <Button size="sm" variant="outline" onClick={create}>
              <Plus className="h-3.5 w-3.5" />
              New spreadsheet
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {sheets.map((s) => (
              <li key={s.id}>
                {/* Right-click a row for its own actions (Copy link, Rename, Make a task, Archive): the one entity actions menu. */}
                <EntityContextMenu entity={{ type: 'spreadsheet', id: s.id, label: s.title }} state={{ archived: s.status === 'archived' }} from="spreadsheet_list">
                  <button type="button" onClick={() => setOpenId(s.id, s.title)} className={cn('flex w-full items-center py-2.5 text-left hover:bg-muted/40', card ? 'gap-2' : 'gap-3')}>
                    <Sheet className={cn('shrink-0 text-muted-foreground', card ? 'size-3.5' : 'h-4 w-4')} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{s.title}</span>
                    {s.sheet_names.length > 1 && <span className="shrink-0 text-xs text-muted-foreground">{s.sheet_names.length} sheets</span>}
                    {s.visibility === 'private' && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />}
                    {listSharingText((s as SpreadsheetSummary & { sharing?: ListSharing }).sharing) && (
                      <span data-spreadsheet-row-sharing="" className="shrink-0 text-xs text-muted-foreground">{listSharingText((s as SpreadsheetSummary & { sharing?: ListSharing }).sharing)}</span>
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(s.updated_at)}</span>
                  </button>
                </EntityContextMenu>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
