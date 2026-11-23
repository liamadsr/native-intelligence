/**
 * GET /api/account/imports
 * The caller's recent imports in this workspace (task CSV, Linear, Notion;
 * docs/plans/imports.md), the teams they can import tasks into, and whether
 * they can import from the workspace's Linear connection.
 */
import { NextResponse } from 'next/server'
import { serverError } from '@/lib/api-errors'
import { listTeams } from '@/lib/imports/context'
import { listImports } from '@/lib/imports/journal'
import { importSummaryView } from '@/lib/imports/preview'
import { requireImporter } from '@/lib/imports/route-auth'
import { loadLinearSyncState } from '@/lib/tasks/linear-config'

export async function GET() {
  const who = await requireImporter()
  if (who instanceof Response) return who
  try {
    // Before migration 704 is applied the journal isn't there: the page still works, with no past imports.
    const safeImports = listImports(who.svc, who).catch((e: Error) => {
      if (/work_import|PGRST205|42P01/.test(e.message)) return []
      throw e
    })
    const [imports, teams, linear] = await Promise.all([safeImports, listTeams(who.db, who.workspaceId, who.memberId), loadLinearSyncState(who.workspaceId)])
    return NextResponse.json({
      imports: imports.map(importSummaryView),
      teams,
      linear: { connected: !!linear, mine: !!linear && linear.userId === who.userId },
    })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not read your imports')
  }
}
