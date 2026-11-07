'use client'

/**
 * Compact bordered ROW for a library item — the page's default density (rows,
 * like knowledge-library). Layout: icon · name (+ /slug chip for skills) ·
 * one-line description · right-aligned meta (Built-in / visibility / author +
 * fork count) with hover actions (Add on Discover, Edit/Delete when owned).
 */

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Download, GitFork, Pencil, Trash2, User } from 'lucide-react'
import { LibraryItemIcon } from '@/components/library-item-icon'
import { VisibilityBadge, BuiltInBadge } from './library-badges'
import { lineageChip } from './library-types'
import type { LibraryRow as LibraryRowData, LibraryScope } from './library-types'

export interface LibraryItemProps {
  item: LibraryRowData
  scope: LibraryScope
  /** True when the current user created this item (per the mine list). */
  isMine: boolean
  onView: () => void
  onEdit: () => void
  onFork: () => void
  onDelete: () => void
  forking: boolean
}

export function LibraryRow({
  item,
  scope,
  isMine,
  onView,
  onEdit,
  onFork,
  onDelete,
  forking,
}: LibraryItemProps) {
  const isDiscover = scope === 'discover'
  // Owned actions (Edit/Delete) are available wherever the user can manage the
  // item: any non-Discover scope, or their own Discover listing.
  const canManage = !item.is_system && (!isDiscover || isMine)
  // Fork provenance — only rendered on owned rows (a fork lives in the
  // workspace, never in the Discover catalog). null when there's no resolvable
  // source (not a fork, or the source listing was deleted).
  const lineage = !isDiscover ? lineageChip(item) : null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onView}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onView()
        }
      }}
      className="group border-border bg-card hover:border-foreground/30 focus-visible:ring-ring flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 transition-colors outline-none focus-visible:ring-2"
    >
      <LibraryItemIcon color={item.color} size="sm" seed={item.id || item.name} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">{item.name}</span>
          {/* /slug chip — skills are invoked by slash command, so surface it. */}
          {item.slug && (
            <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
              /{item.slug}
            </span>
          )}
        </div>
        {item.description && (
          <p className="text-muted-foreground truncate text-xs">{item.description}</p>
        )}
        {/* Quiet fork-lineage line — "Forked from X", with a "· source has
            changed" hint when the Discover listing diverged after this copy was
            added. */}
        {lineage && (
          <p
            className="text-muted-foreground/70 mt-0.5 flex items-center gap-1 truncate text-[10px]"
            title={
              lineage.diverged
                ? 'The Discover listing was updated after you added it'
                : undefined
            }
          >
            <GitFork className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">
              Forked from {lineage.sourceName}
              {lineage.diverged && ' · source has changed'}
            </span>
          </p>
        )}
      </div>

      {/* Right meta — provenance markers, always visible. */}
      <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
        {item.is_system ? (
          <BuiltInBadge />
        ) : (
          <>
            {/* Author chip only where it's not otherwise obvious: workspace
                scope shows other people's names; own items skip it. */}
            {scope === 'workspace' && !isMine && item.author_name && (
              <Badge variant="outline" className="gap-1 text-[10px]">
                <User className="h-2.5 w-2.5" /> {item.author_name}
              </Badge>
            )}
            {isDiscover && item.author_name && (
              <span className="text-muted-foreground text-[11px]">{item.author_name}</span>
            )}
            <VisibilityBadge visibility={item.visibility} />
          </>
        )}
        {item.fork_count > 0 &&
          (isDiscover ? (
            /* On Discover the install count is a provenance/trust signal, so
               it's spelled out ("12 installs") rather than a bare number. */
            <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
              <Download className="h-3 w-3" />
              {item.fork_count} {item.fork_count === 1 ? 'install' : 'installs'}
            </span>
          ) : (
            <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
              <Download className="h-3 w-3" />
              {item.fork_count}
            </span>
          ))}
      </div>

      {/* Hover actions. */}
      <div className="flex shrink-0 items-center gap-1">
        {isDiscover && !item.is_system && !isMine && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              onFork()
            }}
            disabled={forking}
          >
            {forking ? 'Adding…' : 'Add'}
          </Button>
        )}
        {isDiscover && isMine && (
          <span className="text-muted-foreground text-[10px] italic">Your listing</span>
        )}
        {canManage && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 opacity-0 transition-opacity group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                onEdit()
              }}
              aria-label="Edit"
            >
              <Pencil className="text-muted-foreground h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 opacity-0 transition-opacity group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
              aria-label="Delete"
            >
              <Trash2 className="text-muted-foreground h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
