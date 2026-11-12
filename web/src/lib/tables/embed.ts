/**
 * A table in a doc (Tables, phase 6): a doc embeds one table's saved view as
 * a read-only compact grid (src/components/editor/table-embed-extension.tsx).
 * In the doc's markdown it is the view's link on a line of its own,
 *
 *   https://nativeintelligence.dev/account?data_table=<table id>&view=<view id>
 *
 * so anything that reads the markdown without the editor (a published page,
 * the agent, an export) still has a working link, and pasting that link on
 * an empty line embeds it. What it shows is read for the reader: a table
 * they can't open is a locked placeholder (the embed route answers 404).
 *
 * Client-safe and pure.
 */
import { appUrl, isAppPageHost } from '@/lib/app-url'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The query parameters a table link carries. */
export const TABLE_LINK_PARAM = 'data_table'
export const VIEW_LINK_PARAM = 'view'

/** The most rows an embed shows; the rest are behind Open. */
export const EMBED_ROWS = 8

export interface TableRef {
  tableId: string
  viewId: string | null
}

/** A table's link (its view's, when given), on the app's address. */
export function tableLink(ref: TableRef, origin: string = appUrl()): string {
  const params = new URLSearchParams({ [TABLE_LINK_PARAM]: ref.tableId.toLowerCase() })
  if (ref.viewId) params.set(VIEW_LINK_PARAM, ref.viewId.toLowerCase())
  return `${origin.replace(/\/+$/, '')}/account?${params.toString()}`
}

/** A host a table link may be on: the app's, or this machine's (a local build). */
function ownHost(host: string): boolean {
  const h = host.toLowerCase()
  if (isAppPageHost(h) || h === 'localhost' || h === '127.0.0.1') return true
  try {
    return h === new URL(appUrl()).hostname.toLowerCase()
  } catch {
    return false
  }
}

/** The table (and view) a pasted or stored link names, or null for any other text. */
export function parseTableLink(text: string): TableRef | null {
  const s = text.trim()
  if (!s || /\s/.test(s) || s.length > 400) return null
  let url: URL
  try {
    url = new URL(s)
  } catch {
    return null
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !ownHost(url.hostname)) return null
  if (url.pathname.replace(/\/+$/, '') !== '/account') return null
  const tableId = url.searchParams.get(TABLE_LINK_PARAM)
  if (!tableId || !UUID_RE.test(tableId)) return null
  const view = url.searchParams.get(VIEW_LINK_PARAM)
  return { tableId: tableId.toLowerCase(), viewId: view && UUID_RE.test(view) ? view.toLowerCase() : null }
}
