// @vitest-environment jsdom
/**
 * THE LIST TOOLBARS HAVE NO WORKSPACE TOGGLE ANY MORE, and which lists the
 * app's one switch reaches instead.
 *
 * "This workspace / All workspaces" used to be a segmented control in the My
 * Actions toolbar (and its own control again in the inbox and on the Agents
 * page). It is now ONE switch in the workspace menu (lib/workspace-span), so
 * no list draws a control of its own — a second one would be a second answer
 * to the same question. What survives is the rule for which lists the switch
 * can widen (spansWorkspaces), each exclusion a different flavour of wrong:
 *   - a TEAM board is one workspace's by definition;
 *   - a PROJECT → Actions embed hangs off a project that lives in one
 *     workspace, so widening the query returns the same rows;
 *   - a captures/CRM list has no cross-workspace query on the server at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { spansWorkspaces, type ViewConfig } from '../hooks/use-view'
import type { ViewEntityType } from '@/lib/views/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { ViewToolbar } from '../view-toolbar'

function makeConfig(over: Partial<ViewConfig> = {}): ViewConfig {
  return {
    filters: [],
    grouping: null,
    sub_grouping: null,
    ordering: [],
    display_properties: [],
    layout: 'list',
    board_group_by: null,
    show_completed: true,
    completed_filter: 'all',
    show_sub_items: true,
    nested_sub_items: false,
    show_empty_groups: false,
    action_scope: 'assigned',
    workspace_scope: 'workspace',
    crm_scope: 'contacts',
    capture_scope: 'all',
    ...over,
  } as ViewConfig
}

let container: HTMLDivElement
let root: Root
let onScopeReset: ReturnType<typeof vi.fn>
let onConfigChange: ReturnType<typeof vi.fn>
let onViewChange: ReturnType<typeof vi.fn>

beforeEach(() => {
  onScopeReset = vi.fn()
  onConfigChange = vi.fn()
  onViewChange = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function renderToolbar(props: {
  entityType?: ViewEntityType
  teamId?: string
  config?: ViewConfig
}) {
  await act(async () => {
    root.render(
      h(ViewToolbar, {
        entityType: props.entityType ?? 'action',
        teamId: props.teamId,
        views: [],
        activeViewId: null,
        onViewChange,
        onCreateView: vi.fn(),
        onUpdateView: vi.fn(),
        onDuplicateView: vi.fn(),
        onDeleteView: vi.fn(),
        config: props.config ?? makeConfig(),
        onConfigChange,
        onScopeReset,
        isDirty: false,
        overrides: {},
        onSaveDraft: vi.fn(),
        onDiscardDraft: vi.fn(),
      }),
    )
  })
}

/** Anything that reads as a workspace-scope control. */
const scopeControls = () => [
  ...container.querySelectorAll('[data-workspace-scope], [aria-label="Workspace scope"]'),
  ...[...container.querySelectorAll('button')].filter((b) =>
    ['This workspace', 'All workspaces'].includes(b.textContent ?? ''),
  ),
]

describe('no list toolbar draws a workspace toggle', () => {
  it('not on My Actions, in either scope', async () => {
    await renderToolbar({})
    expect(scopeControls()).toEqual([])
    await renderToolbar({ config: makeConfig({ workspace_scope: 'all' }) })
    expect(scopeControls()).toEqual([])
  })

  it('not on Projects, a team board, or any other list', async () => {
    await renderToolbar({ entityType: 'project' })
    expect(scopeControls()).toEqual([])
    await renderToolbar({ teamId: 'team-7' })
    expect(scopeControls()).toEqual([])
    await renderToolbar({ entityType: 'capture' })
    expect(scopeControls()).toEqual([])
  })
})

describe('the lists the switch reaches', () => {
  it('My Actions and Projects', () => {
    expect(spansWorkspaces('action', {})).toBe(true)
    expect(spansWorkspaces('project', {})).toBe(true)
  })

  it('never a team board', () => {
    expect(spansWorkspaces('action', { teamId: 'team-7' })).toBe(false)
  })

  it('never a parent-scoped embed (Project → Actions, Initiative → Projects)', () => {
    expect(spansWorkspaces('action', { scoped: true })).toBe(false)
    expect(spansWorkspaces('project', { scoped: true })).toBe(false)
  })

  it('never a list with no cross-workspace query on the server', () => {
    for (const entityType of ['capture', 'contact', 'company', 'document', 'initiative'] as const) {
      expect(spansWorkspaces(entityType, {})).toBe(false)
    }
  })
})
