import type { CanvasItem, ConnectorItem, RectangleItem } from '../../types'
import { settleConnectors } from '../connectors'
import { sceneFromItems, type Scene } from '../scene'

export function rect(id: string, x: number, y: number, w: number, h: number, extra: Partial<RectangleItem> = {}): RectangleItem {
  return { id, parentId: null, sortKey: `a${id}`, kind: 'rectangle', x, y, w, h, rotation: 0, style: { fill: '#ffffff', stroke: 'theme:ink', strokeWidth: 2 }, ...extra }
}

export function connector(id: string, start: ConnectorItem['start'], end: ConnectorItem['end'], extra: Partial<ConnectorItem> = {}): ConnectorItem {
  return {
    id,
    parentId: null,
    sortKey: `z${id}`,
    kind: 'connector',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    rotation: 0,
    style: { stroke: 'theme:ink', strokeWidth: 2 },
    start,
    end,
    route: 'straight',
    startHead: 'none',
    endHead: 'arrow',
    ...extra,
  }
}

export const sceneOf = (...items: CanvasItem[]): Scene => settleConnectors(sceneFromItems(items))
