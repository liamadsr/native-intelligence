'use client'

/** The canvas's right-click menu. The press has already selected what was under the pointer. */
import * as React from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { menuCopy, menuPaste } from './clipboard'
import { useCanvas, useCanvasStore } from './use-canvas'

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

export function CanvasContextMenu({ children }: { children: React.ReactNode }) {
  const store = useCanvasStore()
  const selection = useCanvas((s) => s.selection)
  const scene = useCanvas((s) => s.scene)
  const readOnly = useCanvas((s) => s.readOnly)
  const has = selection.length > 0
  const hasGroup = selection.some((id) => scene.items[id]?.kind === 'group')
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56" data-canvas-chrome>
        {readOnly ? null : (
          <ContextMenuItem
            disabled={!has}
            onSelect={() => {
              void menuCopy(store).then((ok) => ok && store.deleteSelection())
            }}
          >
            Cut<ContextMenuShortcut>{MOD}X</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuItem disabled={!has} onSelect={() => void menuCopy(store)}>
          Copy<ContextMenuShortcut>{MOD}C</ContextMenuShortcut>
        </ContextMenuItem>
        {readOnly ? null : (
          <>
            <ContextMenuItem onSelect={() => void menuPaste(store, false)}>
              Paste<ContextMenuShortcut>{MOD}V</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void menuPaste(store, true)}>
              Paste in place<ContextMenuShortcut>⇧{MOD}V</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem disabled={!has} onSelect={store.duplicateSelection}>
              Duplicate<ContextMenuShortcut>{MOD}D</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={selection.length < 2} onSelect={store.group}>
              Group<ContextMenuShortcut>{MOD}G</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem disabled={!hasGroup} onSelect={store.ungroup}>
              Ungroup<ContextMenuShortcut>⇧{MOD}G</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={!has}>Arrange</ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-48">
                <ContextMenuItem onSelect={() => store.reorder('front')}>
                  Bring to front<ContextMenuShortcut>]</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => store.reorder('forward')}>
                  Bring forward<ContextMenuShortcut>⌥]</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => store.reorder('backward')}>
                  Send backward<ContextMenuShortcut>⌥[</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => store.reorder('back')}>
                  Send to back<ContextMenuShortcut>[</ContextMenuShortcut>
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={store.selectAll}>
          Select all<ContextMenuShortcut>{MOD}A</ContextMenuShortcut>
        </ContextMenuItem>
        {readOnly ? null : (
          <ContextMenuItem disabled={!has} onSelect={store.deleteSelection}>
            Delete<ContextMenuShortcut>⌫</ContextMenuShortcut>
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
