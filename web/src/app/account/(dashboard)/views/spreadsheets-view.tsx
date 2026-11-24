'use client'

/**
 * Spreadsheets (migration 675): the workspace's workbooks. The list is a views
 * list, as Docs is (docs/plans/views-everywhere.md): saved views and their
 * tabs, the filters (creator, last edited by, visibility, status, dates), the
 * display settings, search, the shared rows (the sheet glyph, a private eye,
 * how many sheets, its sharing, creator, when it changed) and J/K/Enter. A
 * row's right-click is the one entity actions menu (Copy link, Rename, Make a
 * task, Archive). New spreadsheet opens the Create composer; one workbook
 * open is its editor (src/components/spreadsheets/spreadsheet-editor.tsx).
 */
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SpreadsheetEditor } from '@/components/spreadsheets/spreadsheet-editor'
import { CardHeaderSlot } from '@/components/chat-cards/card-header-slot'
import { CARD_HEADER_PILL_BUTTON } from '@/components/chat-cards/card-header-button'
import { UnifiedViewLayout } from '@/components/views/unified-view-layout'
import { openCreateDialog } from '@/lib/create/open-create'
import { ViewHeader } from './view-header'

/** A chat card's hold on the page: which spreadsheet is open, and how opening one moves the card. */
export interface SpreadsheetsCardState {
  openId: string | null
  onOpen: (id: string | null, name?: string) => void
}

export function SpreadsheetsView({ card }: { card?: SpreadsheetsCardState } = {}) {
  const [ownOpenId, setOwnOpenId] = useState<string | null>(null)
  const openId = card ? card.openId : ownOpenId
  const setOpenId = (id: string | null, name?: string) => {
    if (card) card.onOpen(id, name)
    else setOwnOpenId(id)
  }

  // New spreadsheet opens the one Create composer on Spreadsheet (a name first;
  // docs/plans/create-everything.md); the list reads again on what is made there.
  const create = () => openCreateDialog({ type: 'spreadsheet' })

  if (openId) {
    return (
      <SpreadsheetEditor
        key={openId}
        spreadsheetId={openId}
        onBack={() => setOpenId(null)}
        onOpen={(id, name) => setOpenId(id, name)}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      {card ? (
        // In a card its header already names the page (Liam, 11-22: "remove
        // the duplicate title on the spreadsheets page"): New spreadsheet goes
        // there, beside the list's search, on the header's glass.
        <CardHeaderSlot side="right">
          <button type="button" onClick={create} data-new-spreadsheet="" className={CARD_HEADER_PILL_BUTTON}>
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
      <div className="min-h-0 flex-1" data-spreadsheet-list="">
        <UnifiedViewLayout entityType="spreadsheet" onItemSelect={(id, title) => setOpenId(id, title)} />
      </div>
    </div>
  )
}
