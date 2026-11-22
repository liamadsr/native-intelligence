/**
 * The Create dialog's quick types (lib/create/create-types.ts, mode `quick`):
 * a name and at most one more field, sent to the feature's own create route
 * (the one its page uses; no route of the dialog's own), then the new thing
 * opened as the app opens it.
 *
 *   Company         POST /api/account/companies {name, domain?}          → its record
 *   Doc             POST /api/account/documents {title}                   → its record
 *   Table           POST /api/account/tables {name}                       → Tables, on it
 *   Channel         POST /api/account/team-chat/channels {name, topic?}   → Team chat, on it
 *   Knowledge pkg   POST /api/account/knowledge-packages {name}           → Knowledge, on it
 *   Studio project  POST /api/account/studio/campaigns {title}            → the Studio, on it
 */
import { openCard, openTarget } from '@/lib/chat-cards/open-card'
import type { CreateQuickTypeId } from '@/lib/create/create-types'

export interface QuickCreateInput {
  name: string
  secondary: string
}

export interface QuickCreated {
  id: string
  title: string
  /** The thing, the way the app opens it. */
  open: () => void
}

export interface QuickCreateDef {
  namePlaceholder: string
  /** A second, optional field (one line). */
  secondaryPlaceholder?: string
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

export const QUICK_CREATE: Record<CreateQuickTypeId, QuickCreateDef> = {
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
    run: async ({ name }, fetcher = fetch) => {
      const doc = record(await post(fetcher, '/api/account/documents', { title: name }), 'document')
      const title = str(doc.title, name)
      return { id: doc.id, title, open: () => void openTarget({ type: 'document', id: doc.id, title }, { from: FROM }) }
    },
  },
  table: {
    namePlaceholder: 'Table name',
    run: async ({ name }, fetcher = fetch) => {
      const table = record(await post(fetcher, '/api/account/tables', { name }), 'table')
      const title = str(table.name, name)
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
  channel: {
    namePlaceholder: 'Channel name',
    secondaryPlaceholder: 'Topic (optional)',
    run: async ({ name, secondary }, fetcher = fetch) => {
      const data = await post(fetcher, '/api/account/team-chat/channels', { name, ...(secondary ? { topic: secondary } : {}) })
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
  studio_project: {
    namePlaceholder: 'Studio project title',
    run: async ({ name }, fetcher = fetch) => {
      const project = record(await post(fetcher, '/api/account/studio/campaigns', { title: name }), 'campaign')
      const title = str(project.title, name)
      return { id: project.id, title, open: () => void openTarget({ type: 'studio_project', id: project.id, title }, { from: FROM }) }
    },
  },
}
