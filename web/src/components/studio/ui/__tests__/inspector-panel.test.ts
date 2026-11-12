import { describe, expect, it } from 'vitest';
import {
  inspectorOpenKey, pressRailTab, railTabActive, railTabs, rememberInspectorOpen, rememberedInspectorOpen,
  selectInspectorTab, showInspectorTab, sidePanelToClose,
} from '../inspector-panel';

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
}

describe('the inspector panel', () => {
  it('is remembered under a key the sign-out wipe clears', () => {
    expect(inspectorOpenKey.startsWith('ni:studio:')).toBe(true);
  });

  it('starts closed when nothing is remembered, or storage fails', () => {
    expect(rememberedInspectorOpen(memory())).toBe(false);
    expect(rememberedInspectorOpen(undefined)).toBe(false);
    expect(rememberedInspectorOpen({ getItem: () => { throw new Error('blocked'); } })).toBe(false);
    expect(rememberedInspectorOpen(memory({ [inspectorOpenKey]: 'false' }))).toBe(false);
  });

  it('remembers open and closed', () => {
    const storage = memory();
    rememberInspectorOpen(storage, true);
    expect(rememberedInspectorOpen(storage)).toBe(true);
    rememberInspectorOpen(storage, false);
    expect(rememberedInspectorOpen(storage)).toBe(false);
    expect(() => rememberInspectorOpen({ setItem: () => { throw new Error('full'); } }, true)).not.toThrow();
  });

  it('has no Cursor icon on its strip', () => {
    expect(railTabs).not.toContain('cursor');
  });

  it('opens on an icon, and closes on the icon of the tab already showing', () => {
    expect(pressRailTab({ open: false, tab: 'background' }, 'clip')).toEqual({ open: true, tab: 'clip' });
    expect(pressRailTab({ open: false, tab: 'clip' }, 'clip')).toEqual({ open: true, tab: 'clip' });
    expect(pressRailTab({ open: true, tab: 'clip' }, 'clip')).toEqual({ open: false, tab: 'clip' });
    expect(pressRailTab({ open: true, tab: 'clip' }, 'audio')).toEqual({ open: true, tab: 'audio' });
    expect(pressRailTab({ open: true, tab: 'cursor' }, 'background')).toEqual({ open: true, tab: 'background' });
    // A picked layer fills the panel: its tab's icon shows the tab instead of closing the panel.
    expect(pressRailTab({ open: true, tab: 'clip' }, 'clip', false)).toEqual({ open: true, tab: 'clip' });
  });

  it('lets a selection choose the tab without opening a closed panel', () => {
    expect(selectInspectorTab({ open: false, tab: 'background' }, 'zoom')).toEqual({ open: false, tab: 'zoom' });
    expect(selectInspectorTab({ open: true, tab: 'background' }, 'motion')).toEqual({ open: true, tab: 'motion' });
  });

  it('opens when the person asks for a tab', () => {
    expect(showInspectorTab({ open: false, tab: 'clip' }, 'cursor')).toEqual({ open: true, tab: 'cursor' });
    expect(showInspectorTab({ open: true, tab: 'cursor' }, 'cursor')).toEqual({ open: true, tab: 'cursor' });
    expect(showInspectorTab({ open: false, tab: 'audio' })).toEqual({ open: true, tab: 'audio' });
  });

  it('shows an icon pressed only while the panel is open on its tab', () => {
    expect(railTabActive({ open: true, tab: 'clip' }, 'clip')).toBe(true);
    expect(railTabActive({ open: false, tab: 'clip' }, 'clip')).toBe(false);
    expect(railTabActive({ open: true, tab: 'cursor' }, 'background')).toBe(false);
    expect(railTabActive({ open: true, tab: 'clip' }, 'clip', false)).toBe(false);
  });

  it('closes the side panel opened earlier only when both are open and they do not fit', () => {
    expect(sidePanelToClose({ browser: true, inspector: true }, false, 'inspector')).toBe(null);
    expect(sidePanelToClose({ browser: true, inspector: false }, true, 'browser')).toBe(null);
    expect(sidePanelToClose({ browser: false, inspector: true }, true, 'inspector')).toBe(null);
    expect(sidePanelToClose({ browser: true, inspector: true }, true, 'inspector')).toBe('browser');
    expect(sidePanelToClose({ browser: true, inspector: true }, true, 'browser')).toBe('inspector');
    expect(sidePanelToClose({ browser: true, inspector: true }, true, null)).toBe('browser');
  });
});
