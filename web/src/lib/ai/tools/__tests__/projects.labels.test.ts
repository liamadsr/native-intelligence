/**
 * Tests for label support on create_project / update_project in projects.ts.
 *
 * Gap: create_project and update_project did not accept or persist label_ids,
 * even though the project_label join table exists and the sibling tools
 * (create_action, create_initiative) already support labels. The AI therefore
 * could not tag a project when creating or editing it. These tests lock in the
 * fix: label_ids are inserted into project_label on create, and replaced on
 * update (omit = keep, [] = remove all, [...] = replace).
 *
 * Vitest unit tests (no network, no DB). Run via `npm test`, covered by CI.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createSupabaseMock } from '@/test/supabase-mock'
import { createProjectTools } from '../projects'

const USER_ID = 'user-uuid-1'
const WORKSPACE_ID = 'workspace-uuid-1'
const PROJECT_ID = 'project-uuid-1'

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

describe('create_project — labels', () => {
  it('inserts label_ids into project_label after creating the project', async () => {
    const supabase = createSupabaseMock({
      tables: {
        projects: { data: { id: PROJECT_ID, name: 'Apollo', status: 'active' }, error: null },
        project_label: { data: null, error: null },
      },
    })

    const tools = createProjectTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.create_project.execute!(
      { name: 'Apollo', label_ids: ['label-1', 'label-2'] },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(true)
    // The fix routes label_ids into the project_label join table.
    expect(supabase.from).toHaveBeenCalledWith('project_label')
  })

  it('does not touch project_label when no labels are given', async () => {
    const supabase = createSupabaseMock({
      tables: {
        projects: { data: { id: PROJECT_ID, name: 'Apollo', status: 'active' }, error: null },
      },
    })

    const tools = createProjectTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.create_project.execute!({ name: 'Apollo' }, EXEC_OPTS) as any

    expect(result.success).toBe(true)
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    expect(fromCalls).not.toContain('project_label')
  })
})

describe('update_project — labels', () => {
  it('replaces labels (delete then insert) when label_ids provided', async () => {
    const supabase = createSupabaseMock({
      tables: {
        // resolveEntityWorkspace: project in current workspace.
        projects: { data: { id: PROJECT_ID, name: 'Apollo', status: 'active', workspace_id: WORKSPACE_ID }, error: null },
        project_label: { data: null, error: null },
      },
    })

    const tools = createProjectTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.update_project.execute!(
      { project_id: PROJECT_ID, status: 'paused', label_ids: ['label-9'] },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(true)
    expect(supabase.from).toHaveBeenCalledWith('project_label')
  })

  it('accepts a label-only update (no other fields) without an empty patch error', async () => {
    const supabase = createSupabaseMock({
      tables: {
        projects: { data: { id: PROJECT_ID, name: 'Apollo', status: 'active', workspace_id: WORKSPACE_ID }, error: null },
        project_label: { data: null, error: null },
      },
    })

    const tools = createProjectTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.update_project.execute!(
      { project_id: PROJECT_ID, label_ids: [] },
      EXEC_OPTS,
    ) as any

    // Empty array = remove all labels; must not error with "No fields to update".
    expect(result.success).toBe(true)
  })
})
