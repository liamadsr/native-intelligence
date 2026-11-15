/**
 * Forms (phase 1, migration 660): a public front door on a table. A form
 * takes a submission from someone outside the workspace and writes it as ONE
 * new row of ONE table. Its link can do nothing else: it never reads, edits
 * or deletes a row, and it fills only the fields the form lists.
 *
 * Client-safe: plain types and constants only.
 */
import type { CustomFieldType } from '@/lib/crm/custom-fields'

/** A field's key when it fills the row's name (its title) and not a column. */
export const FORM_TITLE_KEY = '$title'

/**
 * A field's key when it takes files (migration 663): not a column. Each file
 * becomes an attachment of the new row (./files.ts). At most one per form,
 * and a form with it must have the bot check on.
 */
export const FORM_FILES_KEY = '$files'

/**
 * What a form's files field takes, the same for every form: the server
 * checks each (./files.ts), the page and the embed only spare a person a
 * round trip. 10 MB is under the attachments bucket's own 50 MB.
 */
export const FORM_FILE_LIMITS = {
  /** Files in one submission. */
  maxFiles: 5,
  /** One file's bytes. */
  maxBytes: 10 * 1024 * 1024,
  /** A file's name, as stored (its extension kept). */
  name: 120,
  /** Bytes of files one sender sends in an hour, across every form. */
  clientBytesPerHour: 50 * 1024 * 1024,
  /** Bytes of files one form takes in an hour. */
  formBytesPerHour: 250 * 1024 * 1024,
  /**
   * Bytes of files all of one workspace's forms take in a day: what the
   * server's disk keeps for strangers' files. 2 GB is a few hundred photos
   * and PDFs a day, far more than a real business's customers send, and
   * bounds what one workspace's forms (or someone filling them) can store
   * in a day. Counted from the try ledger (upload_bytes, 663).
   */
  workspaceBytesPerDay: 2 * 1024 * 1024 * 1024,
} as const

/** The kinds of file a form takes, by extension: images, PDFs, plain text and CSV, and Word, Excel and PowerPoint files. */
export const FORM_FILE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'pdf', 'txt', 'csv', 'docx', 'xlsx', 'pptx'] as const

/** The `accept` a file input is given: the extensions above. */
export const FORM_FILE_ACCEPT = FORM_FILE_EXTENSIONS.map((e) => `.${e}`).join(',')

/**
 * The column types a form may fill. Never a person or a relation (a stranger
 * must not pick a member or a record by id), and never a computed column.
 */
export const FORM_FIELD_TYPES = ['text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'url', 'email', 'phone', 'currency'] as const satisfies readonly CustomFieldType[]
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number]

export function isFormFieldType(v: unknown): v is FormFieldType {
  return typeof v === 'string' && (FORM_FIELD_TYPES as readonly string[]).includes(v)
}

/** A pipeline's Stage column's key (src/lib/crm/deals.ts PIPELINE_KEYS.stage; a test keeps the two equal). */
export const PIPELINE_STAGE_KEY = 'stage'

/**
 * Whether a form may fill this column: a live one of a type a stranger may
 * fill (FORM_FIELD_TYPES), and never a pipeline's own column that steers
 * the deal (migration 540's system columns): its Stage, or any other system
 * choice. A form's deal starts in the pipeline's first open stage
 * (./pipeline.ts), never one a stranger picked. A pipeline's plain system
 * values (its Value, its expected close date) may be asked. Pure.
 */
export function isFormColumn(col: { key: string; field_type: string; system?: boolean | null; deleted_at?: string | null }): boolean {
  if (col.deleted_at || !isFormFieldType(col.field_type)) return false
  if (col.system && (col.key === PIPELINE_STAGE_KEY || col.field_type === 'select' || col.field_type === 'multi_select')) return false
  return true
}

export const FORM_ACCESS = ['public', 'members', 'invited'] as const
/**
 * public: anyone holding the link. members: only a signed-in member of the
 * workspace. invited: only someone holding a personal link (migration 661),
 * one submission each.
 */
export type FormAccess = (typeof FORM_ACCESS)[number]

/** The limits the database enforces too (660). */
export const FORM_LIMITS = {
  name: 200,
  fields: 40,
  label: 60,
  thanks: 500,
  origins: 10,
  /** A row's name from a form: one line, short (it is shown wherever the row is named). */
  title: 200,
  externalId: 120,
  /** A few lines under the form's name on its page (661). */
  description: 1000,
  /** The button's words (661). */
  submitLabel: 40,
  /** Who a personal link is for, in the owner's words (661). */
  inviteLabel: 120,
  /** Personal links made in one go. */
  invitesPerCall: 50,
} as const

/** A personal link lapses after this many days unless told otherwise, and never after more than the most. */
export const FORM_INVITE_DAYS = { default: 14, max: 90 } as const

/** One thing a submission may fill. */
export interface FormField {
  /** A column's key, {@link FORM_TITLE_KEY} for the row's name, or {@link FORM_FILES_KEY} for its files. */
  key: string
  /** What the form calls it; a posted field is matched by it too. */
  label: string
  required: boolean
}

/** The form's files field, or null when it takes none. Pure. */
export function filesFieldOf(fields: readonly FormField[]): FormField | null {
  return fields.find((f) => f.key === FORM_FILES_KEY) ?? null
}

export interface DataForm {
  id: string
  workspaceId: string
  tableId: string
  name: string
  fields: FormField[]
  access: FormAccess
  allowedOrigins: string[]
  thanks: string | null
  /** A few lines the form's page shows under its name. */
  description: string | null
  /** The words on the page's button; null for the default. */
  submitLabel: string | null
  /** A submission must carry a solved challenge (./challenge.ts). */
  botCheck: boolean
  active: boolean
  /** The start of its link's secret, to tell links apart. Never the secret. */
  keyPrefix: string
  /** Who its rows are written as. */
  createdBy: string | null
  createdAt: string
  updatedAt: string
  lastSubmittedAt: string | null
}
