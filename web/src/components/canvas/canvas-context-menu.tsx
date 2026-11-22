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
import { canvasMediaUrl } from '@/lib/canvas/media'
import { ARTIFACT_DEFAULT_SIZE } from '@/lib/canvas/engine/artifact'
import { makeArtifact } from '@/lib/canvas/engine/defaults'
import { frontKey, patchScene } from '@/lib/canvas/engine/scene'
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
  const only = selection.length === 1 ? scene.items[selection[0]] : undefined
  const image = only?.kind === 'image' ? only : undefined
  const record = only?.kind === 'record' ? only : undefined
  const artifact = only?.kind === 'artifact' ? only : undefined
  const imageUrl = image ? (image.path ? canvasMediaUrl(store.canvasId, image.path) : image.src) : undefined
  const copyImage = async () => {
    if (!imageUrl) return
    try {
      const blob = await (await fetch(imageUrl)).blob()
      // The clipboard takes PNG; anything else is redrawn as one first.
      let png = blob
      if (blob.type !== 'image/png') {
        const bmp = await createImageBitmap(blob)
        const cv = document.createElement('canvas')
        cv.width = bmp.width
        cv.height = bmp.height
        cv.getContext('2d')!.drawImage(bmp, 0, 0)
        png = await new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('no image'))), 'image/png'))
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      store.notify?.('Image copied.')
    } catch {
      store.notify?.('The image could not be copied.')
    }
  }
  const saveImage = () => {
    if (!imageUrl || !image) return
    const a = document.createElement('a')
    a.href = imageUrl
    a.download = image.name || 'image'
    a.click()
  }
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
            {image ? (
              <>
                <ContextMenuItem disabled={!imageUrl} onSelect={() => void copyImage()}>
                  Copy image
                </ContextMenuItem>
                <ContextMenuItem disabled={!image.path} onSelect={saveImage}>
                  Save image
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            ) : null}
            {artifact ? (
              <>
                <ContextMenuItem onSelect={() => store.present?.(artifact.id)}>Present from here</ContextMenuItem>
                <ContextMenuItem onSelect={() => store.editArtifact?.(artifact.id)}>Edit page…</ContextMenuItem>
                <ContextMenuSeparator />
              </>
            ) : null}
            {record ? (
              <>
                <ContextMenuItem onSelect={() => store.openRecord?.(record.ref)}>Open {record.ref.type.replace(/_/g, ' ')}</ContextMenuItem>
                <ContextMenuSeparator />
              </>
            ) : null}
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
        {readOnly || has ? null : (
          <ContextMenuItem
            onSelect={() => {
              // A page to write: an empty artifact in the middle of the view, with its editor open.
              const base = store.getState().base
              const c = store.viewCenter()
              const item = makeArtifact({ x: c.x - ARTIFACT_DEFAULT_SIZE.w / 2, y: c.y - ARTIFACT_DEFAULT_SIZE.h / 2, ...ARTIFACT_DEFAULT_SIZE }, frontKey(base), '')
              store.commit(patchScene(base, [item]), { selection: [item.id], tool: 'select' })
              store.editArtifact?.(item.id)
            }}
          >
            New artifact
          </ContextMenuItem>
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
