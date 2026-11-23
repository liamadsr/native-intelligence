/**
 * TAGS: which kinds of record take tags, and where each kind keeps them.
 *
 * A tag is a workspace label (`public.label`, migration 020) or a person's own
 * personal one (`label.owner_user_id`, migration 700). Every kind keeps its tags
 * in its own join table with a real foreign key to the record, so the record's
 * own row-level security decides who sees them (docs/plans/tags.md).
 *
 * Pure and client-safe.
 */
import type { EntityType } from '@/lib/knowledge/entity-registry'

export interface TaggableDescriptor {
  /** The record's table. */
  table: string
  /** Its join table and the column naming the record there. */
  join: string
  column: string
  /** Singular and plural nouns for the UI. */
  noun: [string, string]
}

export const TAGGABLE = {
  action: { table: 'actions', join: 'action_label', column: 'action_id', noun: ['Action', 'Actions'] },
  project: { table: 'projects', join: 'project_label', column: 'project_id', noun: ['Project', 'Projects'] },
  initiative: { table: 'initiative', join: 'initiative_label', column: 'initiative_id', noun: ['Initiative', 'Initiatives'] },
  email_thread: { table: 'email_thread_index', join: 'email_thread_label', column: 'thread_id', noun: ['Email', 'Email'] },
  capture: { table: 'captures', join: 'capture_label', column: 'capture_id', noun: ['Capture', 'Captures'] },
  document: { table: 'document', join: 'document_label', column: 'document_id', noun: ['Doc', 'Docs'] },
  data_table: { table: 'data_table', join: 'data_table_label', column: 'data_table_id', noun: ['Table', 'Tables'] },
  data_row: { table: 'data_row', join: 'data_row_label', column: 'data_row_id', noun: ['Row', 'Rows'] },
  spreadsheet: { table: 'spreadsheet', join: 'spreadsheet_label', column: 'spreadsheet_id', noun: ['Spreadsheet', 'Spreadsheets'] },
  canvas: { table: 'canvas', join: 'canvas_label', column: 'canvas_id', noun: ['Canvas', 'Canvases'] },
  contact: { table: 'contact', join: 'contact_label', column: 'contact_id', noun: ['Contact', 'Contacts'] },
  company: { table: 'company', join: 'company_label', column: 'company_id', noun: ['Company', 'Companies'] },
  attachment: { table: 'attachments', join: 'attachment_label', column: 'attachment_id', noun: ['File', 'Files'] },
  team_chat_channel: {
    table: 'team_chat_channel',
    join: 'team_chat_channel_label',
    column: 'team_chat_channel_id',
    noun: ['Channel', 'Channels'],
  },
} as const satisfies Partial<Record<EntityType, TaggableDescriptor>>

export type TagKind = keyof typeof TAGGABLE

export const TAG_KINDS = Object.keys(TAGGABLE) as TagKind[]

/** The kinds whose join table predates migration 700 (their routes and policies stay as they were). */
export const LEGACY_LABEL_KINDS = ['action', 'project', 'initiative', 'email_thread', 'capture'] as const satisfies readonly TagKind[]

export function isTagKind(value: unknown): value is TagKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TAGGABLE, value)
}
