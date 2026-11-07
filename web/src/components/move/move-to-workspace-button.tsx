'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

import { useState } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useWorkspaces } from '@/app/account/workspace-switcher'
import { MoveWorkspaceDialog, type MoveEntityType } from './move-workspace-dialog'

interface MoveToWorkspaceButtonProps {
  entityType: MoveEntityType
  /** The entity's UUID. */
  id: string
  /** Human name of the entity, shown in the dialog title. */
  entityLabel?: string
  /** Fired after a successful move — hosts usually close the detail panel. */
  onMoved?: () => void
}

/**
 * Toolbar button that opens the shared move-to-workspace dialog for a single
 * entity. Renders nothing when the user belongs to fewer than two workspaces —
 * there'd be no destination to pick.
 */
export function MoveToWorkspaceButton({
  entityType,
  id,
  entityLabel,
  onMoved,
}: MoveToWorkspaceButtonProps) {
  const { workspaces } = useWorkspaces()
  const [open, setOpen] = useState(false)

  if (workspaces.length < 2) return null

  return (
    <>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PreferenceActionButton label="Move to workspace"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(true)}
              aria-label={`Move ${entityType} to another workspace`}
            >
              <ArrowRightLeft className="h-3.5 w-3.5" />
            </PreferenceActionButton>
          </TooltipTrigger>
          <TooltipContent side="bottom">Move to workspace…</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <MoveWorkspaceDialog
        entityType={entityType}
        entityIds={[id]}
        entityLabel={entityLabel}
        open={open}
        onOpenChange={setOpen}
        onMoved={() => onMoved?.()}
      />
    </>
  )
}
