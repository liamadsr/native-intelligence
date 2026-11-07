import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const body = await request.json()
  const rollToNext = body.roll_to_next === true

  // Get the cycle and verify it belongs to a team in this workspace
  const { data: cycle, error: cycleErr } = await supabase
    .from('cycle')
    .select('id, team_id, end_date, status, team:team_id(workspace_id)')
    .eq('id', id)
    .single()

  const teamWs = cycle?.team as unknown as { workspace_id: string } | null
  if (cycleErr || !cycle || teamWs?.workspace_id !== workspaceId) {
    return NextResponse.json({ error: 'Cycle not found' }, { status: 404 })
  }

  if (cycle.status === 'completed') {
    return NextResponse.json({ error: 'Cycle is already completed' }, { status: 400 })
  }

  // Step 1: Mark cycle as completed
  const { data: updatedCycle, error: updateErr } = await supabase
    .from('cycle')
    .update({ status: 'completed' })
    .eq('id', id)
    .select()
    .single()

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  let nextCycle = null
  let rolledCount = 0

  if (rollToNext) {
    // Find next upcoming cycle for this team
    const { data: upcoming } = await supabase
      .from('cycle')
      .select()
      .eq('team_id', cycle.team_id)
      .eq('status', 'upcoming')
      .order('start_date', { ascending: true })
      .limit(1)

    if (upcoming && upcoming.length > 0) {
      nextCycle = upcoming[0]
    } else {
      // Auto-create a 2-week cycle starting day after this one ends
      const nextStart = new Date(cycle.end_date)
      nextStart.setDate(nextStart.getDate() + 1)
      const nextEnd = new Date(nextStart)
      nextEnd.setDate(nextEnd.getDate() + 14)

      const { data: created, error: createErr } = await supabase
        .from('cycle')
        .insert({
          team_id: cycle.team_id,
          start_date: nextStart.toISOString().split('T')[0],
          end_date: nextEnd.toISOString().split('T')[0],
          status: 'upcoming',
        })
        .select()
        .single()

      if (createErr) {
        return NextResponse.json({
          cycle: updatedCycle,
          error: `Cycle completed but failed to create next cycle: ${createErr.message}`,
        })
      }
      nextCycle = created
    }

    // Find unfinished actions in the completed cycle
    // (workflow_state category NOT completed or canceled)
    const { data: cycleActions } = await supabase
      .from('actions')
      .select('id, status_id, workflow_state:workflow_state!status_id(category)')
      .eq('cycle_id', id)
      .neq('confirmation', 'dismissed')

    const unfinishedIds = (cycleActions || [])
      .filter((a) => {
        const cat = (a.workflow_state as unknown as { category: string } | null)?.category
        return cat !== 'completed' && cat !== 'canceled'
      })
      .map((a) => a.id)

    if (unfinishedIds.length > 0 && nextCycle) {
      const { error: rollErr } = await supabase
        .from('actions')
        .update({ cycle_id: nextCycle.id })
        .in('id', unfinishedIds)

      if (!rollErr) {
        rolledCount = unfinishedIds.length
      }
    }
  }

  return NextResponse.json({
    cycle: updatedCycle,
    next_cycle: nextCycle,
    rolled_count: rolledCount,
  })
}
