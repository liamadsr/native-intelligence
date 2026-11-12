'use client'

import * as React from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Settings2, List, LayoutGrid, ArrowUp, ArrowDown, Share2, Table2, CalendarDays, GalleryHorizontalEnd } from 'lucide-react'
import {
  FILTERABLE_FIELDS, DISPLAY_PROPERTIES,
  type ViewEntityType, type ViewLayout,
} from '@/lib/views/types'
import type { ViewConfig } from './hooks/use-view'
import { customFieldDisplayProperties, customFieldFilterFields } from '@/lib/views/custom-field-columns'
import { useCustomFieldDefinitions } from './hooks/use-custom-field-definitions'

interface ViewSettingsPopoverProps {
  config: ViewConfig
  entityType: ViewEntityType
  onChange: (updates: Partial<ViewConfig>) => void
  /**
   * True when this instance can actually draw a graph — i.e. the page passed
   * `renderGraph` to UnifiedViewLayout. The `graph` layout is a global enum
   * value but only the Knowledge page has a picture for it, so offering the
   * toggle everywhere would let a user put the CRM into a layout that silently
   * falls back to the list.
   */
  graphAvailable?: boolean
  /**
   * Fields locked by a parent scope (Project → Actions locks `project_id`).
   * They are hidden from grouping/sub-grouping/sort pickers because grouping
   * or sorting by a field that's already fixed to a single value is a no-op.
   * Scope-only display properties are gated on them too: a `scopeOnly`
   * property is offered only when its scope field is locked here.
   */
  lockedScopeFields?: Set<string>
}

function SettingsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-foreground">{label}</span>
      {children}
    </div>
  )
}

export function ViewSettingsPopover({ config, entityType, onChange, lockedScopeFields, graphAvailable = false }: ViewSettingsPopoverProps) {
  /**
   * On a canvas, grouping / sub-grouping / ordering / display properties are
   * not "disabled" — they are MEANINGLESS, and each for its own reason.
   * Positions come from the UNFILTERED layout and never move when a filter
   * changes (that is the architecture that makes the map stable under appends),
   * so there is nothing to regroup. There is no row order on a plane. And node
   * labels are baked into the tile payload server-side, so a display-property
   * chip could not change what a node shows without a new tile format.
   * They are hidden rather than greyed out: a greyed control invites the reader
   * to wonder what would unlock it.
   */
  const isGraph = config.layout === 'graph'
  // The library keeps its existing row layout and item actions. Only ordering
  // applies there; board/group/property controls would promise new behavior.
  const isLibrary = entityType === 'agent' || entityType === 'skill'
  // A table's rows: four layouts of their own, grouped (a board) by a select
  // or person column, sorted by any column whose values order; its columns
  // are shown, hidden and ordered from the table's Fields menu instead.
  const isTable = entityType === 'data_row'
  // The workspace's own fields join the sort, group and column lists below,
  // read only while the popover is open (its content mounts only then).
  const [open, setOpen] = React.useState(false)
  const customDefs = useCustomFieldDefinitions(entityType, open)
  const customFilterFields = React.useMemo(() => customFieldFilterFields(customDefs), [customDefs])
  // 'label' is deliberately NOT groupable: the engine's getGroupKey has no
  // junction-array handling, so label groups degenerate to "[object Object]".
  // A custom field groups only when it is a select: its options are the
  // columns, and a board drag sets the field (unified-view-layout). Text,
  // number and date values are too many to be columns.
  const groupableFields = isTable
    ? customFilterFields.filter(f => (f.type === 'enum' && !f.isArray) || f.type === 'member')
    : [
        ...FILTERABLE_FIELDS[entityType].filter(f =>
          ['enum', 'member', 'project', 'team', 'cycle', 'milestone', 'company', 'boolean', 'date'].includes(f.type)
          && !(lockedScopeFields?.has(f.field)),
        ),
        ...customFilterFields.filter(f => f.type === 'enum' && !f.isArray),
      ]
  // VIRTUAL fields are filterable and groupable but NOT sortable: they live on
  // an embedded resource (flow's `last_run_status` → flow_run.status, a
  // prospect list's → prospecting_run.status), and PostgREST's `order` takes a
  // column of the QUERIED table — `order=last_run_status` is a 400. Offering
  // them here rendered a sort option that broke the page.
  const sortableFields = [
    ...FILTERABLE_FIELDS[entityType].filter(f =>
      f.type !== 'relation' && f.type !== 'label' && f.type !== 'tag' && !f.virtual && !(isTable && f.field === 'table_id'),
    ),
    // A person, a relation and a multi-select hold ids and lists: nothing to order by.
    ...customFilterFields.filter(f => f.type !== 'relation' && f.type !== 'member' && !f.isArray),
  ]
  const allowsDefaultOrder = isLibrary || isTable
  // A table's layout picks, from its columns' own types.
  const columnsOf = (types: readonly string[]) => customDefs.filter(d => types.includes(d.field_type))
  const tableSetting = (key: 'total_key' | 'date_key' | 'cover_key', v: string) =>
    onChange({ table: { ...(config.table ?? {}), [key]: v === '__none__' ? null : v } })
  // Scope-only display properties (e.g. the sequence 'enrollment' cell) are
  // only offered when the instance locks the scope field they depend on —
  // elsewhere the query route never merges their data, so toggling them on
  // could never render anything.
  const displayProps = [
    ...(DISPLAY_PROPERTIES[entityType] || []).filter(p =>
      !p.scopeOnly || lockedScopeFields?.has(p.scopeOnly),
    ),
    ...customFieldDisplayProperties(customDefs),
  ]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Settings2 className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>View settings</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-72 p-0" align="end">
        <div className="p-3 space-y-4">
          {/* Layout toggle */}
          {isTable && <ToggleGroup
            type="single"
            value={config.layout}
            onValueChange={v => v && onChange({ layout: v as ViewLayout })}
            className="grid w-full grid-cols-4 gap-1"
          >
            {([['grid', 'Table', Table2], ['board', 'Board', LayoutGrid], ['calendar', 'Calendar', CalendarDays], ['gallery', 'Gallery', GalleryHorizontalEnd]] as const).map(([value, label, Icon]) => (
              <ToggleGroupItem key={value} value={value} aria-label={label} className="h-12 flex-col gap-1 px-1 text-[11px]">
                <Icon className="h-3.5 w-3.5" /> {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>}
          {!isLibrary && !isTable && <ToggleGroup
            type="single"
            value={config.layout}
            onValueChange={v => v && onChange({ layout: v as ViewLayout })}
            className="w-full"
          >
            {graphAvailable && (
              <ToggleGroupItem value="graph" className="flex-1 gap-2 h-8 text-xs">
                <Share2 className="h-3.5 w-3.5" /> Graph
              </ToggleGroupItem>
            )}
            <ToggleGroupItem value="list" className="flex-1 gap-2 h-8 text-xs">
              <List className="h-3.5 w-3.5" /> List
            </ToggleGroupItem>
            <ToggleGroupItem value="board" className="flex-1 gap-2 h-8 text-xs">
              <LayoutGrid className="h-3.5 w-3.5" /> Board
            </ToggleGroupItem>
          </ToggleGroup>}

          {!isGraph && <>
          {/* Grouping */}
          {!isLibrary && (!isTable || config.layout === 'board') && <>
          <SettingsRow label={isTable ? 'Group by' : 'Grouping'}>
            <Select
              value={config.grouping?.field || '__none__'}
              onValueChange={v => {
                if (v === '__none__') return onChange({ grouping: null })
                const fieldDef = groupableFields.find(f => f.field === v)
                onChange({ grouping: { field: v, direction: fieldDef?.type === 'date' ? 'desc' : 'asc' } })
              }}
            >
              <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {!isTable && <SelectItem value="__none__">No grouping</SelectItem>}
                {groupableFields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingsRow>

          {/* Sub-grouping */}
          {!isTable && <SettingsRow label="Sub-grouping">
            <Select
              value={config.sub_grouping?.field || '__none__'}
              onValueChange={v => {
                if (v === '__none__') return onChange({ sub_grouping: null })
                const fieldDef = groupableFields.find(f => f.field === v)
                onChange({ sub_grouping: { field: v, direction: fieldDef?.type === 'date' ? 'desc' : 'asc' } })
              }}
            >
              <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No grouping</SelectItem>
                {groupableFields.filter(f => f.field !== config.grouping?.field).map(f =>
                  <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>,
                )}
              </SelectContent>
            </Select>
          </SettingsRow>}

          </>}
          {/* Ordering */}
          <SettingsRow label="Ordering">
            <div className="flex items-center gap-1">
              <Select
                value={config.ordering?.[0]?.field || (allowsDefaultOrder ? '__default__' : 'created_at')}
                onValueChange={v => onChange({ ordering: v === '__default__' ? [] : [{ field: v, direction: config.ordering?.[0]?.direction || (isTable ? 'asc' : 'desc') }] })}
              >
                <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {allowsDefaultOrder && <SelectItem value="__default__">{isTable ? 'Table order' : 'Default'}</SelectItem>}
                  {sortableFields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button
                variant="ghost" size="icon" className="h-7 w-7"
                disabled={allowsDefaultOrder && !config.ordering?.length}
                onClick={() => {
                  const dir = config.ordering?.[0]?.direction === 'asc' ? 'desc' : 'asc'
                  // Keep the trailing keys: eval_case's default is a two-key
                  // ordering whose second key is the tie-break that makes
                  // offset pagination stable, and flipping a direction must
                  // not silently drop it.
                  onChange({
                    ordering: [
                      { field: config.ordering?.[0]?.field || 'created_at', direction: dir },
                      ...(config.ordering?.slice(1) ?? []),
                    ],
                  })
                }}
              >
                {config.ordering?.[0]?.direction === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              </Button>
            </div>
          </SettingsRow>
          </>}

          {/* A table's layout picks */}
          {isTable && config.layout === 'board' && (
            <SettingsRow label="Totals">
              <Select value={config.table?.total_key || '__none__'} onValueChange={v => tableSetting('total_key', v)}>
                <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Count only</SelectItem>
                  {columnsOf(['number', 'currency']).map(d => <SelectItem key={d.key} value={d.key}>{d.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </SettingsRow>
          )}
          {isTable && config.layout === 'calendar' && columnsOf(['date']).length > 0 && (
            <SettingsRow label="Date">
              <Select value={config.table?.date_key || columnsOf(['date'])[0].key} onValueChange={v => tableSetting('date_key', v)}>
                <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {columnsOf(['date']).map(d => <SelectItem key={d.key} value={d.key}>{d.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </SettingsRow>
          )}
          {isTable && config.layout === 'gallery' && (
            <SettingsRow label="Cover">
              <Select value={config.table?.cover_key || '__none__'} onValueChange={v => tableSetting('cover_key', v)}>
                <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {columnsOf(['url']).map(d => <SelectItem key={d.key} value={d.key}>{d.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </SettingsRow>
          )}

          {/* Action-specific */}
          {entityType === 'action' && (
            <>
              <Separator />
              <SettingsRow label="Completed issues">
                <Select
                  value={config.completed_filter || 'all'}
                  onValueChange={v => onChange({ completed_filter: v as 'all' | 'recent' | 'none' })}
                >
                  <SelectTrigger className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="recent">Recent</SelectItem>
                    <SelectItem value="none">None</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsRow>
              <SettingsRow label="Show sub-issues">
                <Switch checked={config.show_sub_items} onCheckedChange={v => onChange({ show_sub_items: v })} />
              </SettingsRow>
            </>
          )}

          {!isGraph && !isLibrary && !isTable && <>
          {/* List options */}
          <Separator />
          <span className="text-xs font-medium text-muted-foreground">List options</span>
          {entityType === 'action' && config.show_sub_items && (
            <SettingsRow label="Nested sub-issues">
              <Switch checked={config.nested_sub_items} onCheckedChange={v => onChange({ nested_sub_items: v })} />
            </SettingsRow>
          )}
          <SettingsRow label="Show empty groups">
            <Switch checked={config.show_empty_groups} onCheckedChange={v => onChange({ show_empty_groups: v })} />
          </SettingsRow>

          {/* Display properties */}
          <Separator />
          <span className="text-xs font-medium text-muted-foreground">Display properties</span>
          <div className="flex flex-wrap gap-1.5">
            {displayProps.map(prop => {
              const active = (config.display_properties || []).includes(prop.field)
              return (
                <button
                  key={prop.field}
                  onClick={() => {
                    const current = config.display_properties || []
                    onChange({ display_properties: active ? current.filter(p => p !== prop.field) : [...current, prop.field] })
                  }}
                  className={cn(
                    'text-xs px-2.5 py-1 rounded-full border transition-colors',
                    active ? 'bg-foreground text-background border-foreground' : 'bg-background text-muted-foreground border-border hover:bg-muted',
                  )}
                >
                  {prop.label}
                </button>
              )
            })}
          </div>
          </>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
