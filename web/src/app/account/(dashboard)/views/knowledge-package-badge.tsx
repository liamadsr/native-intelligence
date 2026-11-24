/**
 * A knowledge package's visibility chip (Private, Team, Workspace): the
 * Library's package panel and the package rows of the shared list
 * (EntityRow's `package_visibility` cell) draw the same one.
 */
import type { ReactNode } from 'react'
import { Boxes, Lock, Users } from 'lucide-react'

export type PackageVisibility = 'personal' | 'team' | 'workspace'

const VISIBILITY_META: Record<PackageVisibility, { label: string; icon: ReactNode }> = {
  personal: { label: 'Private', icon: <Lock className="h-3 w-3" /> },
  team: { label: 'Team', icon: <Users className="h-3 w-3" /> },
  workspace: { label: 'Workspace', icon: <Boxes className="h-3 w-3" /> },
}

export function PackageVisibilityBadge({ visibility }: { visibility: PackageVisibility }) {
  const meta = VISIBILITY_META[visibility] ?? VISIBILITY_META.workspace
  return (
    <span className="border-border text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]">
      {meta.icon}
      {meta.label}
    </span>
  )
}
