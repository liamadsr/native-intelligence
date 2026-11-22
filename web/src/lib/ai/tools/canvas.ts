import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENT_COLOR_NAMES, AGENT_LIMITS, agentArtifactsEnabled, applyAgentOps, describeCanvas, type AgentOp } from '@/lib/canvas/agent'
import { ARTIFACT_LIMITS } from '@/lib/canvas/engine/artifact'
import { syncCanvasRecordLinks } from '@/lib/canvas/links'
import { createCanvas, listItems, writeItems } from '@/lib/canvas/store'
import { itemToRow, rowToItem, type CanvasItem } from '@/lib/canvas/types'
import { resolveCreateWorkspace, workspaceEcho, type CreateWorkspacePolicy } from './_shared'

/**
 * Canvases (docs/plans/canvas.md, phase 4): the agent reads a whiteboard as
 * data and adds to it or rearranges it with a batch of operations, through
 * the same engine the editor uses (src/lib/canvas/agent.ts).
 *
 * These may run on a service-role client (the eve tool proxies, the MCP
 * bridge), where RLS does not apply, so every canvas is fenced here first
 * with the database's own rule for the person the turn is for:
 * canvas_visible_to to read, canvas_editable_by to change (migration 676).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ref = z.union([z.string().min(1).max(64), z.object({ x: z.number(), y: z.number() })])
const ids = z.array(z.string().min(1).max(64)).min(1).max(200)
const color = z.string().max(40).optional().describe(`One of ${AGENT_COLOR_NAMES.join(', ')}; "none"; or a hex like #2563eb.`)

const operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_shape'), key: z.string().max(40).optional().describe('A name for this item that later operations in this batch can use as its id.'), shape: z.enum(['rectangle', 'ellipse']), x: z.number(), y: z.number(), w: z.number().optional(), h: z.number().optional(), text: z.string().max(AGENT_LIMITS.text).optional().describe('A label, centered. The box grows to hold it.'), fill: color, stroke: color, radius: z.number().optional() }),
  z.object({ op: z.literal('create_text'), key: z.string().max(40).optional(), x: z.number(), y: z.number(), text: z.string().min(1).max(AGENT_LIMITS.text), width: z.number().optional().describe('Wrap at this width. Leave out for one line per line break.'), font_size: z.number().optional(), color }),
  z.object({ op: z.literal('connect'), key: z.string().max(40).optional(), from: ref.describe('An item id (or a key from this batch) to tie to, or a free point { x, y }.'), to: ref, route: z.enum(['straight', 'elbow', 'smooth']).optional(), start_head: z.enum(['none', 'arrow', 'filled', 'dot', 'small-dot']).optional(), end_head: z.enum(['none', 'arrow', 'filled', 'dot', 'small-dot']).optional().describe('Default arrow.'), label: z.string().max(200).optional(), stroke: color }),
  z.object({ op: z.literal('move'), ids, dx: z.number().optional(), dy: z.number().optional(), x: z.number().optional().describe('With y: put one item (its top-left) here instead of moving by dx, dy.'), y: z.number().optional() }),
  z.object({ op: z.literal('resize'), id: z.string().min(1).max(64), w: z.number().optional(), h: z.number().optional() }),
  z.object({ op: z.literal('style'), ids, fill: color, stroke: color, stroke_width: z.number().optional(), stroke_style: z.enum(['solid', 'dashed', 'dotted']).optional(), opacity: z.number().min(0).max(1).optional(), radius: z.number().optional(), font_size: z.number().optional(), text_color: color }),
  z.object({ op: z.literal('set_text'), id: z.string().min(1).max(64), text: z.string().max(AGENT_LIMITS.text).describe('The words of a text item, or the label of a shape or connector (empty takes a label off).') }),
  z.object({ op: z.literal('group'), key: z.string().max(40).optional(), ids }),
  z.object({ op: z.literal('ungroup'), ids }),
  z.object({ op: z.literal('order'), ids, to: z.enum(['front', 'back', 'forward', 'backward']) }),
  z.object({ op: z.literal('delete'), ids }),
  z.object({ op: z.literal('create_artifact'), key: z.string().max(40).optional(), x: z.number(), y: z.number(), w: z.number().optional().describe('Default 480.'), h: z.number().optional().describe('Default 320.'), html: z.string().min(1).max(ARTIFACT_LIMITS.html).describe('The page: markup for the body, with its styles and scripts written in it.'), title: z.string().max(ARTIFACT_LIMITS.title).optional() }),
  z.object({ op: z.literal('set_artifact'), id: z.string().min(1).max(64), html: z.string().min(1).max(ARTIFACT_LIMITS.html).optional(), title: z.string().max(ARTIFACT_LIMITS.title).optional().describe('Empty takes the title off.') }),
])

export function createCanvasTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
) {
  /** The canvas, if this person may open it (and, for a write, change it). Fenced by the database's own rule. */
  async function open(canvasId: string, write: boolean): Promise<{ ok: true; canvas: { id: string; workspace_id: string; title: string; visibility: string }; canEdit: boolean } | { ok: false; error: string }> {
    if (!UUID.test(canvasId)) return { ok: false, error: 'canvas_id is the id of a canvas (find one with search).' }
    const visible = await supabase.rpc('canvas_visible_to', { p_canvas_id: canvasId, p_user_id: userId })
    if (visible.error) return { ok: false, error: visible.error.message }
    if (visible.data !== true) return { ok: false, error: 'No canvas with that id that this person can open.' }
    const { data, error } = await supabase.from('canvas').select('id, workspace_id, title, visibility, archived_at').eq('id', canvasId).maybeSingle()
    if (error) return { ok: false, error: error.message }
    const row = data as { id: string; workspace_id: string; title: string; visibility: string; archived_at: string | null } | null
    if (!row) return { ok: false, error: 'No canvas with that id that this person can open.' }
    // A turn held to one workspace reads nothing from another.
    if (strictWorkspace && row.workspace_id !== workspaceId) return { ok: false, error: 'That canvas is in another workspace.' }
    const editable = await supabase.rpc('canvas_editable_by', { p_canvas_id: canvasId, p_user_id: userId })
    const canEdit = !editable.error && editable.data === true && !row.archived_at
    if (write && !canEdit) return { ok: false, error: row.archived_at ? 'That canvas is archived.' : 'This person can view that canvas but not change it.' }
    return { ok: true, canvas: { id: row.id, workspace_id: row.workspace_id, title: row.title, visibility: row.visibility }, canEdit }
  }

  const load = async (canvasId: string): Promise<CanvasItem[]> => (await listItems(supabase, canvasId)).map(rowToItem).filter((it): it is CanvasItem => !!it)

  return {
    read_canvas: tool({
      description:
        `Read a canvas (a whiteboard): its items back to front, each with its id, kind, box (x, y, w, h in canvas units, y down), words, the group it is in, and for a connector what its ends are tied to. A big canvas returns its ${AGENT_LIMITS.read} frontmost items and says how many it left out. Use the ids with edit_canvas.`,
      inputSchema: z.object({ canvas_id: z.string().describe('The canvas to read.') }),
      execute: async ({ canvas_id }) => {
        try {
          const found = await open(canvas_id, false)
          if (!found.ok) return { success: false, error: found.error }
          const read = describeCanvas(await load(canvas_id))
          return {
            success: true,
            canvas: { id: found.canvas.id, title: found.canvas.title, visibility: found.canvas.visibility, can_edit: found.canEdit },
            item_count: read.total,
            ...(read.omitted ? { omitted: read.omitted, note: `Only the ${read.items.length} frontmost items are listed.` } : {}),
            kinds: read.kinds,
            bounds: read.bounds,
            items: read.items,
            ...workspaceEcho(found.canvas.workspace_id),
          }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : 'Could not read the canvas' }
        }
      },
    }),

    edit_canvas: tool({
      description:
        `Add to a canvas or rearrange it, with up to ${AGENT_LIMITS.ops} operations in one batch: create_shape (a rectangle or ellipse, with an optional label), create_text, connect (an arrow between two items or points), move, resize, style, set_text, group, ungroup, order, delete, and create_artifact / set_artifact. An artifact is a small self-contained page drawn on the canvas (a chart, a calculator, a slide): write its body markup with styles and scripts inline. It runs with no network and no access to the app, so images and fonts must be data: URLs and it cannot fetch anything. Several artifacts can be presented full-screen one after another, in reading order. Artifacts may be turned off for agents, in which case those two operations are refused and say so. Give a new item a "key" to use it as an id later in the same batch (make two boxes, then connect them). Units are canvas units with y down; a typical box is 320 by 80, and leave about 80 between things. Read the canvas first to place things around what is there. An operation that cannot be applied is refused with its reason and the rest still apply. People with the canvas open see the change as it lands.`,
      inputSchema: z.object({
        canvas_id: z.string().describe('The canvas to change.'),
        operations: z.array(operation).min(1).max(AGENT_LIMITS.ops),
      }),
      execute: async ({ canvas_id, operations }) => {
        try {
          const found = await open(canvas_id, true)
          if (!found.ok) return { success: false, error: found.error }
          const result = applyAgentOps(await load(canvas_id), operations as AgentOp[], { artifacts: agentArtifactsEnabled() })
          if (!result.step.length) {
            return { success: result.errors.length === 0, applied: result.done, ...(result.errors.length ? { refused: result.errors } : {}), message: 'Nothing changed.' }
          }
          const upsert = result.step.filter((ch) => ch.after).map((ch) => itemToRow(canvas_id, ch.after!))
          const remove = result.step.filter((ch) => !ch.after).map((ch) => ch.id)
          const wrote = await writeItems(supabase, found.canvas.workspace_id, canvas_id, { upsert, remove }, { userId })
          if (!wrote.ok) return { success: false, error: wrote.error }
          if (remove.length) {
            const { data: me } = await supabase.from('member').select('id').eq('workspace_id', found.canvas.workspace_id).eq('user_id', userId).maybeSingle()
            await syncCanvasRecordLinks(supabase, { workspaceId: found.canvas.workspace_id, canvasId: canvas_id, userId, memberId: (me as { id: string } | null)?.id ?? null })
          }
          return {
            success: true,
            applied: result.done,
            ...(result.errors.length ? { refused: result.errors } : {}),
            created: result.created,
            changed: upsert.length,
            removed: remove.length,
            canvas: { id: found.canvas.id, title: found.canvas.title },
            ...workspaceEcho(found.canvas.workspace_id),
          }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : 'Could not change the canvas' }
        }
      },
    }),

    create_canvas: tool({
      description: 'Make a new, empty canvas (a whiteboard) and return its id. Then draw on it with edit_canvas.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        visibility: z.enum(['workspace', 'private']).optional().describe('workspace (default): everyone in the workspace. private: only this person.'),
        workspace_id: z.string().optional().describe('The workspace to make it in, when not the current one.'),
      }),
      execute: async ({ title, visibility, workspace_id }) => {
        try {
          const target = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, { strictWorkspace, policy: createWorkspacePolicy })
          if (!target.ok) return target.error
          const { data: me } = await supabase.from('member').select('id, role').eq('workspace_id', target.workspaceId).eq('user_id', userId).maybeSingle()
          const member = me as { id: string; role: string } | null
          if (!member || member.role === 'guest') return { success: false, error: 'Only a member of the workspace can make a canvas.' }
          const made = await createCanvas(supabase, target.workspaceId, { title, ...(visibility ? { visibility } : {}) }, { userId, ownerMemberId: member.id })
          if (!made.ok) return { success: false, error: made.error }
          return { success: true, canvas: { id: made.value.id, title: made.value.title, visibility: made.value.visibility }, message: `Made the canvas "${made.value.title}".`, ...workspaceEcho(target.workspaceId, target.workspaceName) }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : 'Could not make the canvas' }
        }
      },
    }),
  }
}
