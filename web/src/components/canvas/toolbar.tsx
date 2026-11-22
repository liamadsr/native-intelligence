'use client'

/** The drawing toolbar: floating at the bottom, in the middle. Each tool's tooltip shows its key. */
import * as React from 'react'
import { Circle, Eraser, Hand, Minus, MousePointer2, MoveUpRight, Pencil, Square, Type, Workflow, ChevronUp, type LucideIcon } from 'lucide-react'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ToolId } from './store'
import { useCanvas, useCanvasStore } from './use-canvas'

export const TOOL_META: Record<ToolId, { label: string; key?: string; icon: LucideIcon }> = {
  select: { label: 'Select', key: 'V', icon: MousePointer2 },
  hand: { label: 'Hand', key: 'H', icon: Hand },
  rectangle: { label: 'Rectangle', key: 'R', icon: Square },
  ellipse: { label: 'Ellipse', key: 'O', icon: Circle },
  arrow: { label: 'Arrow', key: 'A', icon: MoveUpRight },
  line: { label: 'Line', key: 'L', icon: Minus },
  connector: { label: 'Connector', icon: Workflow },
  pencil: { label: 'Pencil', key: 'P', icon: Pencil },
  eraser: { label: 'Eraser', key: 'E', icon: Eraser },
  text: { label: 'Text', key: 'T', icon: Type },
}

const LINE_TOOLS: ToolId[] = ['arrow', 'line', 'connector']

export function ToolButton({ tool, active, onPick }: { tool: ToolId; active: boolean; onPick: (tool: ToolId) => void }) {
  const meta = TOOL_META[tool]
  const Icon = meta.icon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={meta.label}
          aria-pressed={active}
          data-canvas-tool={tool}
          onClick={() => onPick(tool)}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground',
            active && 'bg-foreground/10 text-foreground hover:bg-foreground/10',
          )}
        >
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        {meta.label}
        {meta.key ? <span className="ml-2 text-muted-foreground">{meta.key}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}

export function CanvasToolbar({ extra }: { extra?: React.ReactNode }) {
  const store = useCanvasStore()
  const tool = useCanvas((s) => s.tool)
  const readOnly = useCanvas((s) => s.readOnly)
  // The line tool last used is the one the button shows.
  const [lineTool, setLineTool] = React.useState<ToolId>('arrow')
  React.useEffect(() => {
    if (LINE_TOOLS.includes(tool)) setLineTool(tool)
  }, [tool])
  const pick = React.useCallback((t: ToolId) => store.setTool(t), [store])
  const tools: ToolId[] = readOnly ? ['select', 'hand'] : ['select', 'hand', 'rectangle', 'ellipse']

  return (
    <div data-canvas-chrome data-canvas-toolbar className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-3">
      <div role="toolbar" aria-label="Canvas tools" className={cn(FLOATING_CARD_CLASS, 'pointer-events-auto flex h-10 max-w-full items-center gap-0.5 overflow-x-auto px-1')}>
        {tools.map((t) => (
          <ToolButton key={t} tool={t} active={tool === t} onPick={pick} />
        ))}
        {readOnly ? null : (
          <>
            <div className="flex items-center">
              <ToolButton tool={lineTool} active={tool === lineTool} onPick={pick} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="More line tools" className="-ml-1 flex h-8 w-3.5 items-center justify-center rounded text-muted-foreground hover:text-foreground">
                    <ChevronUp className="h-3 w-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="center" sideOffset={10} className="min-w-[10rem]">
                  {LINE_TOOLS.map((t) => {
                    const Icon = TOOL_META[t].icon
                    return (
                      <DropdownMenuItem key={t} onSelect={() => pick(t)}>
                        <Icon className="mr-2 h-4 w-4" strokeWidth={1.75} />
                        {TOOL_META[t].label}
                        {TOOL_META[t].key ? <DropdownMenuShortcut>{TOOL_META[t].key}</DropdownMenuShortcut> : null}
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {(['pencil', 'eraser', 'text'] as ToolId[]).map((t) => (
              <ToolButton key={t} tool={t} active={tool === t} onPick={pick} />
            ))}
            {extra ? (
              <>
                <div className="mx-1 h-5 w-px shrink-0 bg-border" />
                {extra}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
