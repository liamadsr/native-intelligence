'use client'

/** Bottom left: zoom out, the zoom (a menu of everything about the view), zoom in; undo and redo beside it. */
import * as React from 'react'
import { Minus, Plus, Redo2, Undo2 } from 'lucide-react'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ZOOM_PRESETS } from '@/lib/canvas/engine/camera'
import type { GridSnap } from '@/lib/canvas/engine/snap'
import { cn } from '@/lib/utils'
import { useCanvas, useCanvasStore, useZoomPercent } from './use-canvas'

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

function IconButton({ label, hint, disabled, onClick, children }: { label: string; hint?: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        {label}
        {hint ? <span className="ml-2 text-muted-foreground">{hint}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}

export function ZoomBar() {
  const store = useCanvasStore()
  const percent = useZoomPercent()
  const prefs = useCanvas((s) => s.prefs)
  const toolLock = useCanvas((s) => s.toolLock)
  const canUndo = useCanvas((s) => s.history.past.length > 0)
  const canRedo = useCanvas((s) => s.history.future.length > 0)
  const hasSelection = useCanvas((s) => s.selection.length > 0)
  const readOnly = useCanvas((s) => s.readOnly)

  return (
    <div data-canvas-chrome data-canvas-zoom className="absolute bottom-4 left-4 z-20 flex items-center gap-2">
      <div className={cn(FLOATING_CARD_CLASS, 'flex h-10 items-center gap-0.5 px-1.5')}>
        <IconButton label="Zoom out" hint={`${MOD}−`} onClick={store.zoomOut}>
          <Minus className="h-3.5 w-3.5" />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Zoom and view options" className="h-7 min-w-[3.25rem] rounded-md px-1.5 text-center text-xs tabular-nums text-foreground hover:bg-foreground/[0.06]">
              {percent}%
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={10} className="w-56">
            <DropdownMenuItem onSelect={store.zoomIn}>
              Zoom in<DropdownMenuShortcut>{MOD}+</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={store.zoomOut}>
              Zoom out<DropdownMenuShortcut>{MOD}−</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => store.zoomToFit(false)}>
              Zoom to fit<DropdownMenuShortcut>.</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!hasSelection} onSelect={() => store.zoomToFit(true)}>
              Zoom to selection
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {ZOOM_PRESETS.map((z) => (
              <DropdownMenuItem key={z} onSelect={() => store.zoomTo(z)}>
                {z * 100}%
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={prefs.grid} onCheckedChange={(v) => store.setPrefs({ grid: !!v })}>
              Dot grid
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={prefs.snapObjects} onCheckedChange={(v) => store.setPrefs({ snapObjects: !!v })}>
              Snap to objects
            </DropdownMenuCheckboxItem>
            {readOnly ? null : (
              <DropdownMenuCheckboxItem checked={toolLock} onCheckedChange={(v) => store.setToolLock(!!v)}>
                Keep tool after drawing
              </DropdownMenuCheckboxItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Grid snapping</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={prefs.gridSnap} onValueChange={(v) => store.setPrefs({ gridSnap: v as GridSnap })}>
              <DropdownMenuRadioItem value="none">No grid snapping</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="pixel">Snap to px</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="auto">Auto snapping</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton label="Zoom in" hint={`${MOD}+`} onClick={store.zoomIn}>
          <Plus className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {readOnly || (!canUndo && !canRedo) ? null : (
        <div className={cn(FLOATING_CARD_CLASS, 'flex h-10 items-center gap-0.5 px-1.5')}>
          <IconButton label="Undo" hint={`${MOD}Z`} disabled={!canUndo} onClick={store.undo}>
            <Undo2 className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Redo" hint={`⇧${MOD}Z`} disabled={!canRedo} onClick={store.redo}>
            <Redo2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}
    </div>
  )
}
