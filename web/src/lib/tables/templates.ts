/**
 * Starter tables (Tables, phase 6): what "New table" offers besides a blank
 * one. Each is a set of columns (a formula where one earns its place), the
 * views that suit it (a board by stage, a calendar by date…), and two or
 * three example rows, made up, that show what goes where and can be deleted
 * like any other. Nothing to set: pick one and it is there.
 *
 * Client-safe and pure: the page lists them, the server makes one
 * (./templates-server.ts).
 */
import type { CustomFieldConfig, CustomFieldValue } from '@/lib/crm/custom-field-types'
import { customFieldPath } from '@/lib/views/custom-field-columns'
import type { FilterOperator, ViewLayout } from '@/lib/views/types'
import type { TableViewSettings } from './views'
import type { DataColumnType } from './types'

export interface TemplateColumn {
  key: string
  label: string
  field_type: DataColumnType
  options?: string[]
  config?: CustomFieldConfig
}

export interface TemplateView {
  name: string
  layout: ViewLayout
  /** A board's lanes: a column key. */
  group_by?: string
  sort?: { key: string; direction: 'asc' | 'desc' }
  filter?: { key: string; operator: FilterOperator; value: string | number | boolean }
  hidden?: string[]
  table?: TableViewSettings
}

export interface TableTemplate {
  id: TemplateId
  name: string
  icon: string
  /** One line: what it keeps. */
  description: string
  columns: TemplateColumn[]
  /**
   * A real pipeline (Tables, phase 7): made by create_pipeline, so its rows
   * are deals; the columns it already has (by key) are its own, the rest are
   * added.
   */
  pipeline?: boolean
  views: TemplateView[]
  rows: Array<{ title: string; values?: Record<string, CustomFieldValue> }>
}

export const TEMPLATE_IDS = ['list', 'pipeline', 'inventory', 'jobs', 'contacts'] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]
export const isTemplateId = (v: unknown): v is TemplateId => typeof v === 'string' && (TEMPLATE_IDS as readonly string[]).includes(v)

/** Days from now as YYYY-MM-DD, so the example rows' dates are near today. */
function day(offset: number, now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset))
  return d.toISOString().slice(0, 10)
}

/** Every starter, its example dates around `now`. */
export function tableTemplates(now: Date = new Date()): TableTemplate[] {
  return [
    {
      id: 'list',
      name: 'Simple list',
      icon: 'list',
      description: 'Anything you want to keep track of, with notes and a done box.',
      columns: [
        { key: 'notes', label: 'Notes', field_type: 'text' },
        { key: 'due', label: 'Due', field_type: 'date' },
        { key: 'done', label: 'Done', field_type: 'checkbox' },
      ],
      views: [{ name: 'All', layout: 'grid' }],
      rows: [
        { title: 'Book the venue', values: { notes: 'Two quotes so far', due: day(3, now) } },
        { title: 'Order name badges', values: { done: true } },
        { title: 'Send the agenda', values: { due: day(7, now) } },
      ],
    },
    {
      id: 'pipeline',
      name: 'Pipeline',
      icon: 'pipeline',
      description: 'Deals by stage, what each is worth, and when it should close.',
      // A real pipeline: its deals show on the Deals page and on their companies.
      pipeline: true,
      columns: [
        { key: 'stage', label: 'Stage', field_type: 'select', options: ['Lead', 'Qualified', 'Proposal', 'Won', 'Lost'] },
        { key: 'value', label: 'Value', field_type: 'currency', config: { currency: 'USD' } },
        { key: 'expected_close', label: 'Expected close', field_type: 'date' },
        { key: 'owner', label: 'Owner', field_type: 'person' },
        { key: 'next_step', label: 'Next step', field_type: 'text' },
        { key: 'days_left', label: 'Days left', field_type: 'formula', config: { expression: 'days_between(today(), {Expected close})' } },
      ],
      views: [
        { name: 'By stage', layout: 'board', group_by: 'stage', table: { total_key: 'value' } },
        { name: 'All deals', layout: 'grid', sort: { key: 'expected_close', direction: 'asc' } },
        { name: 'Closing', layout: 'calendar', table: { date_key: 'expected_close' } },
      ],
      rows: [
        { title: 'Bayside Bakery catering', values: { stage: 'Lead', value: { amount: 1200, currency: 'USD' }, expected_close: day(21, now), next_step: 'Send the menu' } },
        { title: 'Copper Kettle refit', values: { stage: 'Proposal', value: { amount: 8500, currency: 'USD' }, expected_close: day(10, now), next_step: 'Walk the site on Friday' } },
        { title: 'Harbor Florist website', values: { stage: 'Won', value: { amount: 3000, currency: 'USD' }, expected_close: day(-4, now) } },
      ],
    },
    {
      id: 'inventory',
      name: 'Inventory',
      icon: 'inventory',
      description: 'What you stock, what it is worth, and what to reorder.',
      columns: [
        { key: 'sku', label: 'SKU', field_type: 'text' },
        { key: 'category', label: 'Category', field_type: 'select', options: ['Supplies', 'Equipment', 'Merch'] },
        { key: 'in_stock', label: 'In stock', field_type: 'number' },
        { key: 'reorder_at', label: 'Reorder at', field_type: 'number' },
        { key: 'unit_cost', label: 'Unit cost', field_type: 'currency', config: { currency: 'USD' } },
        { key: 'stock_value', label: 'Stock value', field_type: 'formula', config: { expression: '{In stock} * {Unit cost}' } },
        { key: 'reorder', label: 'Reorder', field_type: 'formula', config: { expression: '{In stock} <= {Reorder at}' } },
      ],
      views: [
        { name: 'All items', layout: 'grid' },
        { name: 'To reorder', layout: 'grid', filter: { key: 'reorder', operator: 'is', value: true } },
        { name: 'By category', layout: 'board', group_by: 'category', table: { total_key: 'in_stock' } },
      ],
      rows: [
        { title: 'Paper cups, 12 oz', values: { sku: 'CUP-12', category: 'Supplies', in_stock: 140, reorder_at: 200, unit_cost: { amount: 0.12, currency: 'USD' } } },
        { title: 'Espresso beans, 1 kg', values: { sku: 'BEAN-1K', category: 'Supplies', in_stock: 18, reorder_at: 10, unit_cost: { amount: 21.5, currency: 'USD' } } },
        { title: 'Canvas tote bag', values: { sku: 'TOTE-01', category: 'Merch', in_stock: 35, reorder_at: 15, unit_cost: { amount: 4.8, currency: 'USD' } } },
      ],
    },
    {
      id: 'jobs',
      name: 'Job tracker',
      icon: 'jobs',
      description: 'Jobs from booked to done: who, where, when, and whether it is paid.',
      columns: [
        { key: 'status', label: 'Status', field_type: 'select', options: ['Booked', 'In progress', 'Waiting on parts', 'Done'] },
        { key: 'customer', label: 'Customer', field_type: 'text' },
        { key: 'scheduled', label: 'Scheduled', field_type: 'date' },
        { key: 'assigned_to', label: 'Assigned to', field_type: 'person' },
        { key: 'address', label: 'Address', field_type: 'text' },
        { key: 'price', label: 'Price', field_type: 'currency', config: { currency: 'USD' } },
        { key: 'paid', label: 'Paid', field_type: 'checkbox' },
      ],
      views: [
        { name: 'Board', layout: 'board', group_by: 'status', table: { total_key: 'price' } },
        { name: 'Schedule', layout: 'calendar', table: { date_key: 'scheduled' } },
        { name: 'All jobs', layout: 'grid', sort: { key: 'scheduled', direction: 'asc' } },
      ],
      rows: [
        { title: 'Replace kitchen tap', values: { status: 'Booked', customer: 'Morgan Reed', scheduled: day(2, now), address: '14 Elm Row', price: { amount: 180, currency: 'USD' } } },
        { title: 'Fix the side gate latch', values: { status: 'In progress', customer: 'Sam Okafor', scheduled: day(0, now), address: '3 Quarry Lane', price: { amount: 95, currency: 'USD' } } },
        { title: 'Boiler service', values: { status: 'Done', customer: 'Jo Lindqvist', scheduled: day(-6, now), address: '27 Harbour Street', price: { amount: 240, currency: 'USD' }, paid: true } },
      ],
    },
    {
      id: 'contacts',
      name: 'Contacts',
      icon: 'contacts',
      description: 'People you work with, how to reach them, and when you last spoke.',
      columns: [
        { key: 'company', label: 'Company', field_type: 'text' },
        { key: 'role', label: 'Role', field_type: 'text' },
        { key: 'email', label: 'Email', field_type: 'email' },
        { key: 'phone', label: 'Phone', field_type: 'phone' },
        { key: 'tags', label: 'Tags', field_type: 'multi_select', options: ['Customer', 'Supplier', 'Partner'] },
        { key: 'last_contacted', label: 'Last contacted', field_type: 'date' },
        { key: 'days_since', label: 'Days since', field_type: 'formula', config: { expression: 'days_between({Last contacted}, today())' } },
      ],
      views: [
        { name: 'Everyone', layout: 'grid', sort: { key: 'last_contacted', direction: 'asc' } },
        { name: 'Cards', layout: 'gallery' },
      ],
      rows: [
        { title: 'Robin Vale', values: { company: 'Vale Joinery', role: 'Owner', email: 'robin@valejoinery.example', phone: '+15550100123', tags: ['Supplier'], last_contacted: day(-12, now) } },
        { title: 'Priya Natarajan', values: { company: 'Northline Events', role: 'Planner', email: 'priya@northline.example', tags: ['Customer', 'Partner'], last_contacted: day(-2, now) } },
      ],
    },
  ]
}

export function tableTemplate(id: TemplateId, now?: Date): TableTemplate {
  return tableTemplates(now).find((t) => t.id === id)!
}

/** A template view as the views system stores it (`view` row fields). */
export function templateViewRow(v: TemplateView): {
  name: string
  layout: ViewLayout
  grouping: { field: string; direction: 'asc' } | null
  ordering: Array<{ field: string; direction: 'asc' | 'desc' }>
  filters: Array<{ id: string; field: string; operator: FilterOperator; value: string | number | boolean }>
  metadata: Record<string, unknown>
} {
  const table: TableViewSettings = { ...(v.table ?? {}), ...(v.hidden ? { hidden: v.hidden } : {}) }
  return {
    name: v.name,
    layout: v.layout,
    grouping: v.group_by ? { field: customFieldPath(v.group_by), direction: 'asc' } : null,
    ordering: v.sort ? [{ field: customFieldPath(v.sort.key), direction: v.sort.direction }] : [],
    filters: v.filter ? [{ id: `${v.filter.key}-filter`, field: customFieldPath(v.filter.key), operator: v.filter.operator, value: v.filter.value }] : [],
    metadata: Object.keys(table).length ? { table } : {},
  }
}
