import type { InspectorTab } from './Inspector';

/**
 * The inspector, the side panel on the right of the preview, opens and closes like the Browser on its left: a toggle
 * in the preview's toolbar (⌥⌘0), remembered on this computer, closed until the person opens it. The strip of tab
 * icons beside it stays: an icon opens the panel on its tab, and the icon of the tab already showing closes it.
 *
 * What the person picks on the timeline or the picture still chooses which tab the panel shows, but never opens a
 * closed panel: it opens only when the person asks (the toggle, an icon, the ⋯ menu's Cursor, a layer just added).
 */

/** Where the panel's open state is kept. Under `ni:studio:`, so signing out clears it with the Studio's other keys. */
export const inspectorOpenKey = 'ni:studio:inspector.open';

/** Remembered open, or closed: a fresh browser, private mode or a storage error all start closed. */
export function rememberedInspectorOpen(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try { return storage?.getItem(inspectorOpenKey) === 'true'; } catch { return false; }
}

export function rememberInspectorOpen(storage: Pick<Storage, 'setItem'> | null | undefined, open: boolean): void {
  try { storage?.setItem(inspectorOpenKey, String(open)); } catch { /* private mode */ }
}

/** The tabs on the strip of icons, in its order. Cursor is not one: it lives in the ⋯ menu. */
export const railTabs = ['background', 'clip', 'motion', 'presenter', 'zoom', 'audio', 'transcript'] as const satisfies readonly InspectorTab[];
export type RailTab = (typeof railTabs)[number];

export interface InspectorPanel { open: boolean; tab: InspectorTab }

/**
 * An icon on the strip: opens the panel on its tab; the icon of the tab already showing closes the panel.
 * `showsTab` false: a picked layer or beat fills the panel instead of its tab, so the icon shows its tab (the editor
 * lets go of that pick) and never closes the panel.
 */
export function pressRailTab(panel: InspectorPanel, tab: RailTab, showsTab = true): InspectorPanel {
  return showsTab && panel.open && panel.tab === tab ? { open: false, tab } : { open: true, tab };
}

/** The person asked for this tab (the ⋯ menu's Cursor, a layer just added): the panel opens on it. */
export function showInspectorTab(panel: InspectorPanel, tab: InspectorTab = panel.tab): InspectorPanel {
  return { open: true, tab };
}

/** Something picked on the timeline or the picture chose this tab: the panel shows it when it is open, and stays as it is. */
export function selectInspectorTab(panel: InspectorPanel, tab: InspectorTab): InspectorPanel {
  return { open: panel.open, tab };
}

/** Whether a strip icon reads as pressed: only while the panel is open and showing its tab (not a picked layer or beat). */
export const railTabActive = (panel: InspectorPanel, tab: RailTab, showsTab = true) => showsTab && panel.open && panel.tab === tab;

/** The two side panels: the Browser on the left of the preview, the inspector on its right. */
export type SidePanel = 'browser' | 'inspector';

/**
 * Both panels are open and the editor has no room left for them and a usable preview (studio.css lets each give up
 * width first): the one opened earlier closes, so the one just asked for stays. Unknown (both remembered open from
 * an earlier visit): the Browser closes.
 */
export function sidePanelToClose(open: Record<SidePanel, boolean>, overflowing: boolean, lastOpened: SidePanel | null): SidePanel | null {
  if (!open.browser || !open.inspector || !overflowing) return null;
  return lastOpened === 'browser' ? 'inspector' : 'browser';
}
