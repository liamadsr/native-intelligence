'use client'

/**
 * Shared meta badges for library rows — the visibility pill and the Built-in
 * lock chip. Kept in one place so the row and the detail dialog show identical
 * provenance markers.
 */

import { Badge } from '@/components/ui/badge'
import { Globe, Lock, User, Users } from 'lucide-react'
import type { LibraryVisibility } from './library-types'

export function VisibilityBadge({ visibility }: { visibility: LibraryVisibility }) {
  if (visibility === 'public') {
    return (
      <Badge variant="outline" className="gap-1 text-[10px]">
        <Globe className="h-2.5 w-2.5" /> Public
      </Badge>
    )
  }
  if (visibility === 'personal') {
    return (
      <Badge variant="outline" className="gap-1 text-[10px]">
        <User className="h-2.5 w-2.5" /> Personal
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 text-[10px]">
      <Users className="h-2.5 w-2.5" /> Workspace
    </Badge>
  )
}

/** The "Built-in" chip for is_system items — matches the system-prompt lock. */
export function BuiltInBadge() {
  return (
    <Badge variant="outline" className="gap-1 text-[10px]">
      <Lock className="h-2.5 w-2.5" /> Built-in
    </Badge>
  )
}
