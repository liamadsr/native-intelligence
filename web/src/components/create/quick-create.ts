/**
 * The Create dialog's quick types (lib/create/create-types.ts, mode `quick`):
 * a name and at most one more field, sent to the feature's own create route
 * (the one its page uses; no route of the dialog's own), then the new thing
 * opened as the app opens it.
 *
 *   Company         POST /api/account/companies {name, domain?}          → its record
 *   Doc             POST /api/account/documents {title, project_id?}      → its record
 *   Table           POST /api/account/tables {name?, template?}           → Tables, on it
 *   Channel         POST /api/account/team-chat/channels {name, topic?, teamId?} → Team chat, on it
 *   Knowledge pkg   POST /api/account/knowledge-packages {name}           → Knowledge, on it
 *   Studio project  POST /api/account/studio/campaigns {title}            → the Studio, on it
 *   Folder          POST /api/account/folders {name, parent_id?}          → Folders, on it
 *
 * Made in a folder (create-context.ts), a doc, table, spreadsheet or canvas
 * is then filed there: POST /api/account/folders/<id>/items {type, id}. A
 * filing that fails leaves the record made, unfiled, and says so.
 */
import { openCard, openTarget } from '@/lib/chat-cards/open-card'
import type { CreateQuickTypeId } from '@/lib/create/create-types'
import type { FolderItemType } from '@/lib/drive/folders'

export interface QuickCreateInput {
  name: string
  secondary: string
  /** A table's starter (lib/tables/templates.ts): its own name when none is typed. */
  template?: string | null
  /** A doc's project (the place it was made in: lib/create/create-context.ts). */
  projectId?: string | null
  /** A channel's team (made from a team's channel list). */
  teamId?: string | null
  /**
   * The folder it was made in (Drive folders, migration 690): a doc, table,
   * spreadsheet or canvas is filed there once made; a folder is made inside it.
   */
  folderId?: string | null
}

export interface QuickCreated {
  id: string
  title: string
  /** The thing, the way the app opens it. */
  open: () => void
  /** Made, but something after it didn't land (it couldn't be filed in its folder). */
  warning?: string
}

export interface QuickCreateDef {
  namePlaceholder: string
  /** A second, optional field (one line). */
  secondaryPlaceholder?: string
  /** True when the name may be left empty (a table from a starter takes the starter's). */
  nameOptional?: (input: Pick<QuickCreateInput, 'template'>) => boolean
  run: (input: QuickCreateInput, fetcher?: typeof fetch) => Promise<QuickCreated>
}

const FROM = 'create'

async function post(fetcher: typeof fetch, url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Could not create it')
  return data
}

function record(data: Record<string, unknown>, key: string): { id: string; [k: string]: unknown } {
  const row = data[key] as { id?: unknown } | undefined
  if (!row || typeof row.id !== 'string') throw new Error('Could not create it')
  return row as { id: string }
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback)

const BASE: Record<CreateQuickTypeId, QuickCreateDef> = {
  company: {
    namePlaceholder: 'Company name',
    secondaryPlaceholder: 'Domain (example.com)',
    run: async ({ name, secondary }, fetcher = fetch) => {
      const company = record(await post(fetcher, '/api/account/companies', { name, ...(secondary ? { domain: secondary } : {}) }), 'company')
      const title = str(company.name, name)
      return { id: company.id, title, open: () => void openTarget({ type: 'company', id: company.id, title }, { from: FROM }) }
    },
  },
  document: {
    namePlaceholder: 'Doc title',
    run: async ({ name, projectId }, fetcher = fetch) => {
      const doc = record(await post(fetcher, '/api/account/documents', { title: name, ...(projectId ? { project_id: projectId } : {}) }), 'document')
      const title = str(doc.title, name)
      return { id: doc.id, title, open: () => void openTarget({ type: 'document', id: doc.id, title }, { from: FROM }) }
    },
  },
  table: {
    namePlaceholder: 'Table name',
    nameOptional: ({ template }) => !!template,
    run: async ({ name, template }, fetcher = fetch) => {
      const table = record(await post(fetcher, '/api/account/tables', { ...(name ? { name } : {}), ...(template ? { template } : {}) }), 'table')
      const title = str(table.name, name || 'Table')
      // No openTarget kind for a table: the Tables page's own card, on it (tables-card.tsx).
      return { id: table.id, title, open: () => void openCard({ kind: 'tables', title: 'Tables', target: { type: 'data_table', id: table.id, label: title } }, { from: FROM }) }
    },
  },
  canvas: {
    namePlaceholder: 'Canvas name',
    run: async ({ name }, fetcher = fetch) => {
      const canvas = record(await post(fetcher, '/api/account/canvases', { ...(name ? { title: name } : {}) }), 'canvas')
      const title = str(canvas.title, name || 'Untitled canvas')
      // The Canvases page's own card, open on it (canvases-card.tsx).
      return { id: canvas.id, title, open: () => void openTarget({ type: 'canvas', id: canvas.id, title }, { from: FROM }) }
    },
  },
  spreadsheet: {
    namePlaceholder: 'Spreadsheet name',
    run: async ({ name }, fetcher = fetch) => {
      const sheet = record(await post(fetcher, '/api/account/spreadsheets', { title: name }), 'spreadsheet')
      const title = str(sheet.title, name)
      return { id: sheet.id, title, open: () => void openCard({ kind: 'spreadsheets', title: 'Spreadsheets', target: { type: 'spreadsheet', id: sheet.id, label: title } }, { from: FROM }) }
    },
  },
  channel: {
    namePlaceholder: 'Channel name',
    secondaryPlaceholder: 'Topic (optional)',
    run: async ({ name, secondary, teamId }, fetcher = fetch) => {
      const data = await post(fetcher, '/api/account/team-chat/channels', { name, ...(secondary ? { topic: secondary } : {}), ...(teamId ? { teamId } : {}) })
      if (typeof data.id !== 'string') throw new Error('Could not create it')
      const id = data.id
      return { id, title: name, open: () => void openTarget({ type: 'team_chat', channelId: id }, { from: FROM }) }
    },
  },
  package: {
    namePlaceholder: 'Package name',
    run: async ({ name }, fetcher = fetch) => {
      const pkg = record(await post(fetcher, '/api/account/knowledge-packages', { name }), 'package')
      const title = str(pkg.name, name)
      return { id: pkg.id, title, open: () => void openTarget({ type: 'package', id: pkg.id, title }, { from: FROM }) }
    },
  },
  folder: {
    namePlaceholder: 'Folder name',
    run: async ({ name, folderId }, fetcher = fetch) => {
      const folder = record(await post(fetcher, '/api/account/folders', { name, ...(folderId ? { parent_id: folderId } : {}) }), 'folder')
      const title = str(folder.name, name)
      // The Folders page's own card, open on it (folders-card.tsx).
      return { id: folder.id, title, open: () => void openCard({ kind: 'folders', title: 'Folders', target: { type: 'drive_folder', id: folder.id, label: title } }, { from: FROM }) }
    },
  },
  studio_project: {
    namePlaceholder: 'Studio project title',
    run: async ({ name }, fetcher = fetch) => {
      const project = record(await post(fetcher, '/api/account/studio/campaigns', { title: name }), 'campaign')
      const title = str(project.title, name)
      return { id: project.id, title, open: () => void openTarget({ type: 'studio_project', id: project.id, title }, { from: FROM }) }
    },
  },
}

/** The quick types a folder holds, as drive_folder_item names them (lib/drive/folders.ts). */
const FILED_AS: Partial<Record<CreateQuickTypeId, FolderItemType>> = {
  document: 'document',
  table: 'data_table',
  spreadsheet: 'spreadsheet',
  canvas: 'canvas',
}

/** Made in a folder: filed there once made. A refusal leaves it made, unfiled, with a warning. */
function filedInFolder(type: CreateQuickTypeId, def: QuickCreateDef): QuickCreateDef {
  const as = FILED_AS[type]
  if (!as) return def
  return {
    ...def,
    run: async (input, fetcher = fetch) => {
      const made = await def.run(input, fetcher)
      if (!input.folderId) return made
      try {
        await post(fetcher, `/api/account/folders/${input.folderId}/items`, { type: as, id: made.id })
        return made
      } catch (e) {
        return { ...made, warning: `Made, but not put in the folder: ${e instanceof Error ? e.message : 'it was refused'}` }
      }
    },
  }
}

export const QUICK_CREATE: Record<CreateQuickTypeId, QuickCreateDef> = Object.fromEntries(
  (Object.keys(BASE) as CreateQuickTypeId[]).map((type) => [type, filedInFolder(type, BASE[type])]),
) as Record<CreateQuickTypeId, QuickCreateDef>

