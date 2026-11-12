// Interaction scripts for product components: a short list of steps — type into the chat, click Send, hover a row,
// scroll a list, drag a card — played on the stage with a visible cursor. One engine, two drivers:
//  - a capture asks it, frame by frame on the paused clock, what input happens by time t and performs that input for
//    real (mouse and keyboard through the browser), so hover styles, focus and typing behave exactly as in the app;
//  - the gallery preview runs it live and performs the same input with DOM events.
// Steps run one after another (or at an absolute `at`, in seconds). Targets: "text=Send", "placeholder=Ask",
// "label=Close" (aria-label or title), "role=button[name=Send]", "@0.5,0.8" (a point in the component, as fractions),
// or any CSS selector; add " >> nth=1" for the second match.

export type ScriptStep = {
  at?: number; duration?: number;
  wait?: number;
  move?: string; hover?: string; click?: string;
  type?: string; into?: string; cps?: number;
  press?: string;
  scroll?: number; in?: string;
  drag?: string; to?: string;
};
export type InputOp = { kind: 'move'; x: number; y: number } | { kind: 'down' } | { kind: 'up' } | { kind: 'type'; text: string } | { kind: 'key'; key: string };

type Phase = { start: number; end: number; step: ScriptStep; kind: 'wait' | 'move' | 'hover' | 'click' | 'type' | 'press' | 'scroll' | 'drag'; target?: string; chars?: number[] };
const TRAVEL = 520, PRESS = 90, SETTLE = 70;

/** Character times for typing: human rhythm, a little longer after spaces and punctuation, the same every time. */
function typingTimes(text: string, cps: number): number[] {
  const out: number[] = []; let t = 0;
  for (let i = 0; i < text.length; i++) {
    const jitter = 0.65 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.7;
    t += (1000 / cps) * jitter * (/[ ,.!?]/.test(text[i - 1] ?? '') ? 1.6 : 1);
    out.push(t);
  }
  return out;
}

/** Steps → phases on one timeline (ms from the start of the capture). */
export function compileScript(steps: ScriptStep[]): { phases: Phase[]; end: number } {
  const phases: Phase[] = []; let cursor = 0;
  const add = (p: Omit<Phase, 'start' | 'end'>, length: number, at?: number) => { const start = at !== undefined ? at * 1000 : cursor; phases.push({ ...p, start, end: start + length }); cursor = start + length; };
  for (const s of steps) {
    const at = s.at, travel = s.duration !== undefined && (s.move || s.hover) ? s.duration * 1000 : TRAVEL;
    if (s.wait !== undefined) add({ step: s, kind: 'wait' }, s.wait * 1000, at);
    else if (s.move) add({ step: s, kind: 'move', target: s.move }, travel, at);
    else if (s.hover) add({ step: s, kind: 'hover', target: s.hover }, travel + (s.duration === undefined ? 450 : 0), at);
    else if (s.click) add({ step: s, kind: 'click', target: s.click }, TRAVEL + SETTLE + PRESS * 2 + 80, at);
    else if (s.type !== undefined) {
      if (s.into) add({ step: { click: s.into }, kind: 'click', target: s.into }, TRAVEL + SETTLE + PRESS * 2 + 120, at);
      const chars = typingTimes(s.type, s.cps ?? 22);
      add({ step: s, kind: 'type', chars }, (chars.at(-1) ?? 0) + 160, s.into ? undefined : at);
    }
    else if (s.press) add({ step: s, kind: 'press' }, 180, at);
    else if (s.scroll !== undefined) add({ step: s, kind: 'scroll', target: s.in }, (s.duration ?? 0.7) * 1000 + 120, at);
    else if (s.drag) add({ step: s, kind: 'drag', target: s.drag }, TRAVEL + SETTLE + PRESS + (s.duration ?? 0.8) * 1000 + PRESS + 120, at);
  }
  return { phases, end: phases.reduce((m, p) => Math.max(m, p.end), 0) };
}

// ------------------------------------------------------------------------------------------------------------ targets
const CLICKABLE = 'button, a, input, textarea, select, label, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [contenteditable=""], [contenteditable=true], [tabindex]';
const visible = (el: Element) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
const IMPLICIT: Record<string, string> = { button: 'button', link: 'a[href]', textbox: 'input:not([type]), input[type=text], input[type=search], input[type=email], textarea, [contenteditable=true], [contenteditable=""]', checkbox: 'input[type=checkbox]', tab: '[role=tab]', menuitem: '[role=menuitem]' };

/** Find what a target names, inside the component's box (or anywhere in the page, for popovers in portals). */
export function resolveTarget(target: string, root: HTMLElement): { el: Element | null; x: number; y: number } | null {
  const [spec, nthPart] = target.split(/\s*>>\s*nth=/); const nth = Number(nthPart ?? 0) || 0;
  const s = spec!.trim(), box = root.getBoundingClientRect();
  const point = /^@\s*([\d.]+)\s*,\s*([\d.]+)$/.exec(s);
  if (point) return { el: null, x: box.left + Number(point[1]) * box.width, y: box.top + Number(point[2]) * box.height };
  const all = (sel: string) => Array.from(document.querySelectorAll(sel)).filter(visible);
  let found: Element[] = [];
  const eq = /^(text|placeholder|label|role)=(.*)$/.exec(s);
  if (eq) {
    const [, kind, raw] = eq; const value = raw!.replace(/^["']|["']$/g, '').trim().toLowerCase();
    if (kind === 'text') {
      // The smallest elements whose text contains it, lifted to what you would click.
      const leaves = Array.from(document.body.querySelectorAll('*')).filter(el => visible(el) && (el.textContent ?? '').toLowerCase().includes(value)
        && !Array.from(el.children).some(c => (c.textContent ?? '').toLowerCase().includes(value)));
      found = leaves.map(el => el.closest(CLICKABLE) && el.closest(CLICKABLE)!.contains(el) && (el.closest(CLICKABLE)!.textContent ?? '').length < value.length + 80 ? el.closest(CLICKABLE)! : el);
    } else if (kind === 'placeholder') {
      found = all('input, textarea, [contenteditable], [data-placeholder], [aria-placeholder]').filter(el => ((el.getAttribute('placeholder') ?? el.getAttribute('data-placeholder') ?? el.getAttribute('aria-placeholder') ?? '')).toLowerCase().includes(value));
      if (!found.length) { // editors draw their placeholder as text inside an empty paragraph
        const hint = Array.from(document.body.querySelectorAll('*')).find(el => visible(el) && el.children.length === 0 && (el.textContent ?? '').toLowerCase().includes(value));
        const editable = hint?.closest('[contenteditable], label, form') ?? hint?.parentElement?.querySelector('[contenteditable], textarea, input');
        if (editable) found = [editable];
      }
    } else if (kind === 'label') {
      found = all('[aria-label], [title]').filter(el => ((el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '')).toLowerCase().includes(value));
    } else {
      const m = /^([a-z]+)(?:\[name=(.*)\])?$/.exec(value); const role = m?.[1] ?? value, name = m?.[2]?.replace(/^["']|["']$/g, '');
      found = all(`[role=${role}]${IMPLICIT[role] ? ', ' + IMPLICIT[role] : ''}`).filter(el => !name || ((el.getAttribute('aria-label') ?? '') + ' ' + (el.textContent ?? '')).toLowerCase().includes(name));
    }
  } else { try { found = all(s); } catch { found = []; } }
  // Prefer matches inside the component, then the rest (menus and popovers live in portals).
  found = [...found.filter(el => root.contains(el)), ...found.filter(el => !root.contains(el))];
  const el = found[nth] ?? null; if (!el) return null;
  const r = el.getBoundingClientRect();
  const isText = el.matches('input, textarea, [contenteditable], [contenteditable] *');
  return { el, x: isText ? r.left + Math.min(r.width / 2, 48) : r.left + r.width / 2, y: r.top + r.height / 2 };
}

// ------------------------------------------------------------------------------------------------------------- cursor
const CURSOR_SVG = '<svg width="26" height="26" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg"><path d="M5 3.2v17.6l4.4-4.1 2.7 6.1 3.1-1.4-2.7-6h6.2L5 3.2z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
function cursorLayer() {
  let el = document.getElementById('kit-cursor');
  if (!el) {
    el = document.createElement('div'); el.id = 'kit-cursor';
    el.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;pointer-events:none;z-index:2147483647;transform-origin:5px 3px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.28));opacity:0;will-change:transform';
    el.innerHTML = CURSOR_SVG;
    const ring = document.createElement('div'); ring.id = 'kit-cursor-ring';
    ring.style.cssText = 'position:fixed;left:0;top:0;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;background:rgba(17,17,17,.16);pointer-events:none;z-index:2147483646;opacity:0';
    document.body.append(ring, el);
  }
  return { cursor: el, ring: document.getElementById('kit-cursor-ring')! };
}
const ease = (p: number) => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
const clamp01 = (p: number) => Math.max(0, Math.min(1, p));

/** The script on this page: `at(t)` moves the cursor to where it is at t (ms) and returns the input due since the last
 *  call. Call it with increasing t. Scrolling happens here directly (it is not input). */
export function createPlayer(steps: ScriptStep[], root: HTMLElement, options: { cursor?: boolean } = {}) {
  const { phases, end } = compileScript(steps), show = options.cursor !== false;
  const layer = show ? cursorLayer() : null;
  const box = root.getBoundingClientRect();
  let pos = { x: box.right - 40, y: box.bottom + 30 }, last = -1, pressedAt = -1e9, down = false, visibleFrom = Infinity;
  const firstMove = phases.find(p => p.target && p.kind !== 'scroll');
  if (firstMove) visibleFrom = firstMove.start - 150;
  type State = { from?: { x: number; y: number }; to?: { x: number; y: number; el: Element | null } | null; typed: number; pressed: boolean; released: boolean; scroller?: Element | null; scrollFrom?: number; dropTo?: { x: number; y: number } | null; stage: number };
  const states = new Map<Phase, State>();
  const log: string[] = (((globalThis as any).__scriptLog ??= []) as string[]);

  function travel(st: State, phase: Phase, t: number, length = TRAVEL) {
    if (!st.from) { st.from = { ...pos }; st.to = phase.target ? resolveTarget(phase.target, root) : null; if (phase.target && !st.to) log.push(`not found: ${phase.target}`); }
    if (!st.to) return 1;
    const p = clamp01((t - phase.start) / length), e = ease(p);
    // A slight arc, like a hand moving a mouse.
    const dx = st.to.x - st.from.x, dy = st.to.y - st.from.y, bow = Math.sin(Math.PI * e) * Math.min(40, Math.hypot(dx, dy) * 0.08);
    pos = { x: st.from.x + dx * e - (dy / (Math.hypot(dx, dy) || 1)) * bow, y: st.from.y + dy * e + (dx / (Math.hypot(dx, dy) || 1)) * bow };
    return p;
  }

  function at(t: number): InputOp[] {
    const ops: InputOp[] = [];
    for (const phase of phases) {
      if (phase.start > t || phase.end <= last) continue;
      const st = states.get(phase) ?? { typed: 0, pressed: false, released: false, stage: 0 }; states.set(phase, st);
      const local = Math.min(t, phase.end);
      if (phase.kind === 'move' || phase.kind === 'hover') { travel(st, phase, local, phase.step.duration !== undefined && phase.kind === 'move' ? phase.step.duration * 1000 : TRAVEL); ops.push({ kind: 'move', ...pos }); }
      else if (phase.kind === 'click') {
        const p = travel(st, phase, local); ops.push({ kind: 'move', ...pos });
        const pressT = phase.start + TRAVEL + SETTLE;
        if (p >= 1 && local >= pressT && !st.pressed) { st.pressed = true; down = true; pressedAt = pressT; ops.push({ kind: 'down' }); }
        if (st.pressed && local >= pressT + PRESS && !st.released) { st.released = true; down = false; ops.push({ kind: 'up' }); }
      } else if (phase.kind === 'type') {
        const due = phase.chars!.filter(c => phase.start + c <= local).length;
        if (due > st.typed) { ops.push({ kind: 'type', text: (phase.step.type ?? '').slice(st.typed, due) }); st.typed = due; }
      } else if (phase.kind === 'press') { if (!st.pressed) { st.pressed = true; ops.push({ kind: 'key', key: phase.step.press! }); } }
      else if (phase.kind === 'scroll') {
        if (st.scroller === undefined) {
          const hit = phase.target ? resolveTarget(phase.target, root)?.el : document.elementFromPoint(pos.x, pos.y);
          let el: Element | null = hit ?? root;
          while (el && !(el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
          st.scroller = el ?? document.scrollingElement; st.scrollFrom = st.scroller?.scrollTop ?? 0;
        }
        const length = (phase.step.duration ?? 0.7) * 1000, p = ease(clamp01((local - phase.start) / length));
        if (st.scroller) st.scroller.scrollTop = (st.scrollFrom ?? 0) + (phase.step.scroll ?? 0) * p;
      } else if (phase.kind === 'drag') {
        const p = travel(st, phase, local); ops.push({ kind: 'move', ...pos });
        const pressT = phase.start + TRAVEL + SETTLE, moveStart = pressT + PRESS, moveLength = (phase.step.duration ?? 0.8) * 1000;
        if (p >= 1 && local >= pressT && !st.pressed) { st.pressed = true; down = true; pressedAt = pressT; ops.push({ kind: 'down' }); }
        if (st.pressed && local >= moveStart) {
          if (st.dropTo === undefined) { st.dropTo = phase.step.to ? resolveTarget(phase.step.to, root) : null; st.from = { ...pos }; if (phase.step.to && !st.dropTo) log.push(`not found: ${phase.step.to}`); }
          if (st.dropTo) { const e = ease(clamp01((local - moveStart) / moveLength)); pos = { x: st.from!.x + (st.dropTo.x - st.from!.x) * e, y: st.from!.y + (st.dropTo.y - st.from!.y) * e }; ops.push({ kind: 'move', ...pos }); }
        }
        if (st.pressed && local >= moveStart + moveLength + PRESS && !st.released) { st.released = true; down = false; ops.push({ kind: 'up' }); }
      }
    }
    last = t;
    if (layer) {
      const shown = clamp01((t - visibleFrom) / 180), since = t - pressedAt;
      layer.cursor.style.opacity = String(shown);
      layer.cursor.style.transform = `translate(${pos.x - 5}px, ${pos.y - 3}px) scale(${down ? 0.86 : 1})`;
      const ring = clamp01(since / 380);
      layer.ring.style.opacity = since >= 0 && since < 380 ? String((1 - ring) * 0.9) : '0';
      layer.ring.style.transform = `translate(${pos.x}px, ${pos.y}px) scale(${0.3 + ring * 0.9})`;
    }
    return ops;
  }
  return { at, end, get position() { return pos; } };
}

// ------------------------------------------------------------------------------------------------- live (DOM) driver
const pointer = (type: string, x: number, y: number, target: Element, buttons: number) => {
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, buttons, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true } as PointerEventInit;
  target.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, init) : new MouseEvent(type, init));
};
/** Perform input with DOM events (the gallery's live preview; a capture uses real input instead). */
export function createDomDriver() {
  let over: Element | null = null, buttons = 0, at = { x: 0, y: 0 };
  return (ops: InputOp[]) => {
    for (const op of ops) {
      if (op.kind === 'move') {
        at = op; const el = document.elementFromPoint(op.x, op.y) ?? document.body;
        if (el !== over) { if (over) { pointer('pointerout', op.x, op.y, over, buttons); pointer('mouseout', op.x, op.y, over, buttons); } pointer('pointerover', op.x, op.y, el, buttons); pointer('mouseover', op.x, op.y, el, buttons); over = el; }
        pointer('pointermove', op.x, op.y, el, buttons); pointer('mousemove', op.x, op.y, el, buttons);
      } else if (op.kind === 'down') {
        const el = document.elementFromPoint(at.x, at.y) ?? document.body; buttons = 1;
        pointer('pointerdown', at.x, at.y, el, 1); pointer('mousedown', at.x, at.y, el, 1);
        const focusable = el.closest('input, textarea, select, button, a, [contenteditable], [tabindex]') as HTMLElement | null; focusable?.focus();
      } else if (op.kind === 'up') {
        const el = document.elementFromPoint(at.x, at.y) ?? document.body; buttons = 0;
        pointer('pointerup', at.x, at.y, el, 0); pointer('mouseup', at.x, at.y, el, 0); (el as HTMLElement).click?.();
      } else if (op.kind === 'type') {
        const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null; if (!el) continue;
        for (const ch of op.text) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
          if ('value' in el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
            setter?.call(el, el.value + ch); el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
          } else if ((el as HTMLElement).isContentEditable) document.execCommand('insertText', false, ch);
          el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
        }
      } else if (op.kind === 'key') {
        const el = document.activeElement ?? document.body;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: op.key, code: op.key, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: op.key, code: op.key, bubbles: true }));
      }
    }
  };
}

// ------------------------------------------------------------------------------------------------------------ inspect
export type TargetInfo = { target: string; kind: string; text: string; at: [number, number]; disabled?: boolean };
export type ScrollInfo = { in: string; scrollable: number };
/** What a script can act on, as the component is now: every control with a target that is checked to find it, the
 *  text on screen, and the areas that scroll. Positions are fractions of the component's box. */
export function describeTargets(root: HTMLElement): { targets: TargetInfo[]; texts: string[]; scrollAreas: ScrollInfo[] } {
  const box = root.getBoundingClientRect();
  const inView = (r: DOMRect) => r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  const ours = (el: Element) => !!el.closest('#kit-cursor, #kit-cursor-ring');
  const short = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const hits = (target: string, el: Element) => { const r = resolveTarget(target, root)?.el; return !!r && (r === el || el.contains(r) || r.contains(el)); };
  /** A target that finds this element: the plainest one first, then its nth match. */
  const targetFor = (el: Element, candidates: string[]) => {
    for (const c of candidates) if (hits(c, el)) return c;
    for (const c of candidates) for (let n = 1; n < 12; n++) if (hits(`${c} >> nth=${n}`, el)) return `${c} >> nth=${n}`;
    return null;
  };
  const targets: TargetInfo[] = [], seen = new Set<Element>();
  for (const el of Array.from(document.querySelectorAll(CLICKABLE))) {
    if (seen.has(el) || ours(el) || !visible(el) || !inView(el.getBoundingClientRect())) continue;
    if (Array.from(seen).some(s => s.contains(el) && s.matches('button, a, [role=button], [role=tab], [role=menuitem], [role=option]'))) continue;
    // A focusable region (a list, a panel) is not something to click.
    const area = el.getBoundingClientRect(); if (el.matches('[tabindex]:not(button, a, input, textarea, select, [role])') && area.width * area.height > box.width * box.height * 0.25) continue;
    seen.add(el);
    const label = short(el.getAttribute('aria-label') ?? el.getAttribute('title'));
    const placeholder = short(el.getAttribute('placeholder') ?? el.getAttribute('aria-placeholder') ?? el.getAttribute('data-placeholder'));
    const text = short((el as HTMLElement).innerText).split(' ').slice(0, 8).join(' ').slice(0, 48);
    const role = el.getAttribute('role') ?? (el.matches('button') ? 'button' : el.matches('a[href]') ? 'link' : el.matches('input, textarea, [contenteditable]') ? 'textbox' : el.tagName.toLowerCase());
    const candidates = [label && `label=${label}`, placeholder && `placeholder=${placeholder}`, text && `text=${text}`, `role=${role}`].filter(Boolean) as string[];
    const target = targetFor(el, candidates); if (!target) continue;
    const r = el.getBoundingClientRect();
    targets.push({ target, kind: role, text: text || label || placeholder, at: [+((r.left + r.width / 2 - box.left) / box.width).toFixed(2), +((r.top + r.height / 2 - box.top) / box.height).toFixed(2)],
      ...((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}) });
    if (targets.length >= 60) break;
  }
  // Clickable things that aren't buttons (rows, cards): anything React gave a click handler or that shows a pointer,
  // named by a text inside it.
  const handles = (el: Element | null) => { if (!el) return false; const key = Object.keys(el).find(k => k.startsWith('__reactProps')); const p = key ? (el as unknown as Record<string, Record<string, unknown>>)[key] : null;
    return !!p && ['onClick', 'onMouseDown', 'onPointerDown', 'onDoubleClick'].some(h => typeof p[h] === 'function') || getComputedStyle(el).cursor === 'pointer'; };
  for (const el of Array.from(root.querySelectorAll('div, li, tr, article, section, span'))) {
    if (targets.length >= 80) break;
    if (seen.has(el) || ours(el) || !visible(el) || !handles(el) || handles(el.parentElement)) continue;
    const rect = el.getBoundingClientRect(); if (rect.width < 24 || rect.height < 14 || rect.width * rect.height > box.width * box.height * 0.6) continue;
    if (Array.from(seen).some(s => s.contains(el) && s.matches('button, a, [role=button], [role=tab], [role=menuitem], [role=option], [role=checkbox]'))) continue;
    const leaves = Array.from(el.querySelectorAll('*')).filter(c => visible(c) && c.children.length === 0 && short(c.textContent).length > 1).slice(0, 3);
    const target = targetFor(leaves[0] ?? el, leaves.map(c => `text=${short(c.textContent).slice(0, 40)}`)); if (!target || targets.some(t => t.target === target)) continue;
    seen.add(el); const r = el.getBoundingClientRect();
    targets.push({ target, kind: el.getAttribute('role') ?? 'clickable', text: short((el as HTMLElement).innerText).slice(0, 60), at: [+((r.left + r.width / 2 - box.left) / box.width).toFixed(2), +((r.top + r.height / 2 - box.top) / box.height).toFixed(2)] });
  }
  targets.sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]);
  const texts: string[] = [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (ours(el) || !visible(el) || !inView(el.getBoundingClientRect())) continue;
    const own = short(Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' '));
    if (own && own.length <= 90 && !texts.includes(own)) texts.push(own);
    if (texts.length >= 50) break;
  }
  const scrollAreas: ScrollInfo[] = [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (!(el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) || !visible(el)) continue;
    const leaf = Array.from(el.querySelectorAll('*')).find(c => visible(c) && c.children.length === 0 && short(c.textContent).length > 2);
    const target = leaf ? targetFor(leaf, [`text=${short(leaf.textContent).slice(0, 40)}`]) : null;
    if (target) scrollAreas.push({ in: target, scrollable: el.scrollHeight - el.clientHeight });
  }
  return { targets, texts, scrollAreas };
}
