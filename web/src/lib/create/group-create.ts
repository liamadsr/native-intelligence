/**
 * A list group's + (components/views/view-list.tsx): the Create composer on
 * the list's own type, its chips already on the group's value, so what is made
 * lands in the group it was started from (docs/plans/create-everything.md).
 *
 * Group keys follow the server's (lib/views/query-engine.ts getGroupKey):
 * `__none__` for no value, the value itself for priority and foreign keys,
 * and `category::name` for a status column, whose state id is in the group's
 * metadata (or on any row in it).
 *
 * Client-safe and pure.
 */
import type { GroupedResults } from '@/lib/views/types'
import type { OpenCreateRequest } from './open-create'
import type { CreateTypeId } from './create-types'
import type { ActionPreset } from './create-context'

const NONE = '__none__'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PRIORITIES = new Set(['none', 'low', 'medium', 'high', 'urgent'])

/** What an action made from this group starts with. Empty: the group's field isn't one the composer sets. */
export function actionPresetForGroup(field: string | null | undefined, group: Pick<GroupedResults, 'key' | 'items' | 'metadata'>): ActionPreset {
  if (!field || group.key === NONE) return {}
  switch (field) {
    case 'status_id': {
      const fromMeta = typeof group.metadata?.status_id === 'string' ? (group.metadata.status_id as string) : null
      const row = (group.items ?? []).find((it) => typeof (it.workflow_state as { id?: unknown } | undefined)?.id === 'string')
      const statusId = fromMeta ?? ((row?.workflow_state as { id?: string } | undefined)?.id ?? null)
      if (!statusId) return {}
      const team = (group.items ?? []).find((it) => (it.workflow_state as { id?: string } | undefined)?.id === statusId)?.team_id
      return { statusId, ...(typeof team === 'string' ? { teamId: team } : {}) }
    }
    case 'priority':
      return PRIORITIES.has(group.key) ? { priority: group.key } : {}
    case 'project_id':
      return UUID.test(group.key) ? { projectId: group.key } : {}
    case 'assignee_id':
      return UUID.test(group.key) ? { assigneeId: group.key } : {}
    default:
      return {}
  }
}

/** The + on a group: its type's composer; an action with the group's (and any outer group's) chips. */
export function groupCreateRequest(type: CreateTypeId, preset: ActionPreset): OpenCreateRequest {
  if (type !== 'action' || Object.keys(preset).length === 0) return { type }
  return { type: 'action', context: { preset } }
}
