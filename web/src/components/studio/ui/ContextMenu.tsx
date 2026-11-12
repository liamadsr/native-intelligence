import { studioPortal, studioKeys } from '../studio-env';
// Right-click menus for the whole app. Anything can offer one: call useContextMenu() and pass its event and items.
// The menu opens at the pointer (or at the element, from the keyboard's menu key or Shift+F10), stays on screen, and
// works from the keyboard (arrows, Enter, Esc). An item with `confirm` asks first, inside the menu, instead of a
// browser dialog. Outside text fields the browser's own menu (Reload, Inspect…) never shows.
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type MenuItem =
  | { label: string; hint?: string; run: () => void; disabled?: boolean; danger?: boolean; confirm?: { text: string; action?: string; /** a lone item: open straight on the question */ immediate?: boolean } }
  | { separator: true };
type Opening = { x: number; y: number; items: MenuItem[]; returnFocus: HTMLElement | null };
type OpenMenu = (event: { clientX: number; clientY: number; currentTarget?: EventTarget | null; target?: EventTarget | null; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]) => void;

const Context = createContext<OpenMenu>(() => {});
/** Open a right-click menu: `openMenu(event, items)`, usually from onContextMenu. Empty item lists do nothing. */
export const useContextMenu = () => useContext(Context);
/** The keyboard way in (the menu key, or Shift+F10) for an element that has a right-click menu. */
export const isMenuKey = (event: React.KeyboardEvent) => event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');

export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<Opening | null>(null);
  const open = useCallback<OpenMenu>((event, items) => {
    const visible = items.filter((item, i, all) => !('separator' in item) || (i > 0 && i < all.length - 1 && !('separator' in all[i - 1]!)));
    if (!visible.some(item => !('separator' in item))) return;
    event.preventDefault?.(); event.stopPropagation?.();
    const el = (event.currentTarget ?? event.target) as HTMLElement | null;
    // From the keyboard there is no pointer position: open at the element instead.
    let { clientX: x, clientY: y } = event;
    if (!x && !y && el?.getBoundingClientRect) { const r = el.getBoundingClientRect(); x = r.left + Math.min(24, r.width / 2); y = r.top + Math.min(24, r.height / 2); }
    setMenu({ x, y, items: visible, returnFocus: document.activeElement as HTMLElement | null });
  }, []);
  // The browser's own menu stays for text fields (copy, paste, spelling) and nowhere else.
  useEffect(() => {
    const native = (event: MouseEvent) => { if (event.defaultPrevented) return; const t = event.target as HTMLElement | null;
      if (!t?.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')) event.preventDefault(); };
    studioKeys.addEventListener('contextmenu', native); return () => studioKeys.removeEventListener('contextmenu', native);
  }, []);
  return <Context.Provider value={open}>{children}{menu ? createPortal(<Menu menu={menu} close={() => setMenu(null)} />, studioPortal()) : null}</Context.Provider>;
}

function Menu({ menu, close }: { menu: Opening; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const lone = menu.items.length === 1 && !('separator' in menu.items[0]!) && menu.items[0]!.confirm?.immediate ? menu.items[0] as Extract<MenuItem, { run: () => void }> : null;
  const [pos, setPos] = useState({ x: menu.x, y: menu.y }), [asking, setAsking] = useState<Extract<MenuItem, { run: () => void }> | null>(lone);
  const finish = useCallback((restore = true) => { close(); if (restore) menu.returnFocus?.focus?.({ preventScroll: true }); }, [close, menu.returnFocus]);
  // Keep the whole menu on screen: flip left or up when it would run off the edge.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect(); if (!r) return;
    const x = menu.x + r.width > innerWidth - 8 ? Math.max(8, menu.x - r.width) : menu.x, y = menu.y + r.height > innerHeight - 8 ? Math.max(8, innerHeight - 8 - r.height) : menu.y;
    setPos({ x, y });
  }, [menu.x, menu.y, asking]);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true }); }, [asking]);
  useEffect(() => {
    const away = (event: Event) => { if (!ref.current?.contains(event.target as Node)) finish(false); };
    const gone = () => finish(false);
    window.addEventListener('pointerdown', away, true); window.addEventListener('wheel', gone, { passive: true }); window.addEventListener('blur', gone); window.addEventListener('resize', gone);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('wheel', gone); window.removeEventListener('blur', gone); window.removeEventListener('resize', gone); };
  }, [finish]);
  const choose = (item: Extract<MenuItem, { run: () => void }>) => { if (item.disabled) return; if (item.confirm) { setAsking(item); return; } finish(); item.run(); };
  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []), at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); if (asking && !lone) setAsking(null); else finish(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); buttons[(at + 1) % buttons.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); buttons[(at - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (event.key === 'Tab') event.preventDefault();
  };
  return <div ref={ref} className="context-menu" role="menu" style={{ left: pos.x, top: pos.y }} onKeyDown={onKeyDown} onContextMenu={event => event.preventDefault()}>
    {asking ? <>
      <p className="context-confirm">{asking.confirm!.text}</p>
      <button role="menuitem" className="danger" onClick={() => { finish(); asking.run(); }}>{asking.confirm!.action ?? asking.label.replace(/…$/, '')}</button>
      <button role="menuitem" onClick={() => lone ? finish() : setAsking(null)}>Cancel</button>
    </> : menu.items.map((item, i) => 'separator' in item ? <span key={i} className="context-sep" aria-hidden="true" />
      : <button key={i} role="menuitem" className={item.danger ? 'danger' : undefined} disabled={item.disabled} onClick={() => choose(item)}>
          <span>{item.label}</span>{item.hint ? <kbd>{item.hint}</kbd> : null}</button>)}
  </div>;
}
