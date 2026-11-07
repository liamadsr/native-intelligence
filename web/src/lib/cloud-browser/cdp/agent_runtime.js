/**
 * agent_runtime.js — token-efficient actionable-element snapshot + driver.
 *
 * Injected into each browser tab in an isolated world. It gives an LLM agent a
 * COMPACT list of the page's actionable elements (ref-tagged) instead of the
 * full DOM/HTML, and resolves those refs back to real nodes for click/type.
 *
 * Output format (copied from Vercel agent-browser), one element per line,
 * indented by DOM structure:
 *
 *     @e12 [button type="submit"] "Log In"
 *     @e13 [input type="email"] placeholder="you@example.com"
 *     @e20 [a href="/pricing"] "Pricing"
 *
 * Design (see the plan): combine ARIA/role semantics with a heuristic pass for
 * div-as-button (cursor:pointer / onclick / tabindex / contenteditable), the
 * two things a pure-ARIA walk misses. Refs are stable within a page load: each
 * element gets a monotonic ref cached ON the element via a WeakMap, so a
 * re-snapshot after a minor re-render keeps the same ref for the same node. On
 * resolve, if the node is gone we re-query by role+name before failing.
 *
 * Engine-agnostic: uses only standard DOM/CSSOM/ARIA APIs, so it runs the same
 * in a Chromium test pane and in the shipped WKWebView. Cross-origin iframes
 * and closed shadow DOM are out of reach for any single-frame script (handled
 * later by injecting into child frames); open shadow DOM and same-origin
 * iframes are walked here.
 */
(function () {
  'use strict';

  if (window.__dial8Agent && window.__dial8Agent.__v === 1) return;

  // ── ref bookkeeping ───────────────────────────────────────────────────────
  // element -> "e<N>"; survives re-snapshots for the life of the page.
  const refOf = new WeakMap();
  // "e<N>" -> { el: WeakRef<Element>, role, name } for resolution + fallback.
  const entryOf = new Map();
  let nextRef = 1;

  function assignRef(el, role, name) {
    let ref = refOf.get(el);
    if (!ref) {
      ref = 'e' + nextRef++;
      refOf.set(el, ref);
    }
    entryOf.set(ref, { el: new WeakRef(el), role, name });
    return ref;
  }

  // ── visibility ────────────────────────────────────────────────────────────
  function isVisible(el, allowTransparent) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')
      return false;
    if (parseFloat(style.opacity) === 0 && !allowTransparent) return false;
    // getClientRects is [] for display:contents and truly-collapsed nodes but
    // non-empty for a laid-out box; cheaper + more reliable than offsetParent
    // (which is null for position:fixed).
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const r = rects[0];
    // Reject only genuinely zero-area boxes. A full-width block can report
    // width 0 in some layouts while being perfectly clickable, and a tall thin
    // or short wide control is still real — so require that NEITHER dimension is
    // usable before dropping, not that both are large.
    if (r.width < 1 && r.height < 1) return false;
    // Off-screen far away (common "hidden" pattern): drop it.
    if (r.bottom < -2000 || r.right < -2000) return false;
    return true;
  }

  // ── role / name ───────────────────────────────────────────────────────────
  const INTERACTIVE_TAGS = new Set([
    'a', 'button', 'input', 'select', 'textarea', 'summary', 'option',
  ]);

  // Native tag → ARIA-ish role for the snapshot label.
  function tagRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    return tag;
  }

  function explicitRole(el) {
    const r = el.getAttribute('role');
    return r ? r.trim().split(/\s+/)[0] : null;
  }

  // Accessible name: aria-label > aria-labelledby > text/value/placeholder/alt/title.
  function accName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();

    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const scope = idScope(el);
      const parts = labelledby
        .split(/\s+/)
        .map((id) => scope.getElementById(id))
        .filter(Boolean)
        .map((n) => flatText(n).trim())
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }

    const tag = el.tagName.toLowerCase();
    // A dropdown's text is its option list, never its name: label it like a field.
    if (tag === 'input' || tag === 'select') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return el.value || '';
      // a <label for> or wrapping label
      if (el.id) {
        const lbl = idScope(el).querySelector('label[for="' + cssEscape(el.id) + '"]');
        const text = lbl ? labelText(lbl, el) : '';
        if (text) return text;
      }
      const wrap = composedClosest(el, 'label');
      const wrapped = wrap ? labelText(wrap, el) : '';
      if (wrapped) return wrapped;
      return '';
    }
    if (tag === 'img') return (el.getAttribute('alt') || '').trim();

    const text = contentName(el).replace(/\s+/g, ' ').trim();
    if (text) return text;
    return (el.getAttribute('title') || '').trim();
  }

  // Name from content, as browsers compute it (accname 2F): a descendant's
  // aria-label or an image's alt stands in for its text, and aria-hidden
  // content is left out. Google Flights' day buttons hold
  // <div aria-label="Saturday, October 10, 2026">10</div> plus a labelled
  // price, so their raw text ("10$353") never said which month or day it was.
  const CONTENT_LABELS = '[aria-label],[aria-hidden="true"],img[alt]';
  function contentName(el) {
    if (!shadowPage && !el.querySelector(CONTENT_LABELS)) return el.textContent || '';
    const parts = [];
    let length = 0, count = 0;
    const visit = node => {
      if (length >= 2000 || ++count > 5000) return;
      if (node.nodeType === 3) { parts.push(node.data); length += node.data.length; return; }
      if (node.nodeType !== 1 || UNRENDERED_TEXT.test(node.tagName)) return;
      if (node !== el) {
        if (node.getAttribute('aria-hidden') === 'true') return;
        const label = (node.getAttribute('aria-label') || '').trim();
        if (label) { parts.push(' ' + label + ' '); length += label.length; return; }
        if (node.tagName === 'IMG') { const alt = (node.getAttribute('alt') || '').trim(); if (alt) { parts.push(' ' + alt + ' '); length += alt.length; } return; }
      }
      for (const child of flatChildNodes(node)) visit(child);
    };
    visit(el);
    return parts.join('').replace(/\s+([,.;:])/g, '$1');
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return s.replace(/["\\\]]/g, '\\$&');
  }

  // ── open shadow DOM ───────────────────────────────────────────────────────
  // Web components render their controls inside shadow roots, where
  // document-level queries, closest(), contains() and elementFromPoint() stop
  // at each host. The decision protocol walks the flat (rendered) tree
  // instead: a host's shadow content, and each slot's assigned light nodes.
  // `shadowPage` is refreshed before every decision snapshot and task action;
  // a page without open shadow roots keeps the native fast paths and identical
  // results. Closed shadow roots stay unreachable to any page script.
  let shadowPage = false;
  let flatCache = null;
  // Set when a flat walk hit its element cap: unseen content may include a
  // dialog, so absence and free scrolling can no longer be established.
  let flatTruncated = false;
  function detectShadow() {
    shadowPage = false;
    flatTruncated = false;
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) { shadowPage = true; break; }
    }
    return shadowPage;
  }
  function flatChildNodes(node) {
    if (node.shadowRoot) return node.shadowRoot.childNodes;
    if (node.tagName === 'SLOT') {
      const assigned = node.assignedNodes();
      if (assigned.length) return assigned;
    }
    return node.childNodes;
  }
  // Elements below root in rendered order, like root.querySelectorAll('*').
  function flatElements(root) {
    if (flatCache && flatCache.has(root)) return flatCache.get(root);
    const out = [], stack = [];
    const push = node => { const children = flatChildNodes(node); for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]); };
    push(root);
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType !== 1) continue;
      if (out.length >= 60000) { flatTruncated = true; break; }
      out.push(node);
      push(node);
    }
    if (flatCache) flatCache.set(root, out);
    return out;
  }
  function queryAll(selector, root) {
    root = root || document;
    if (!shadowPage) return Array.from(root.querySelectorAll(selector));
    return flatElements(root).filter(el => el.matches(selector));
  }
  // Rendered parent: a slotted node's slot, else its parent, else its shadow host.
  function composedParent(node) {
    if (!shadowPage) return node.parentElement;
    return node.assignedSlot || node.parentElement || (node.parentNode && node.parentNode.host) || null;
  }
  function composedClosest(el, selector) {
    if (!shadowPage) return el.closest(selector);
    for (let node = el; node; node = composedParent(node)) if (node.matches(selector)) return node;
    return null;
  }
  function composedContains(ancestor, node) {
    if (!shadowPage) return ancestor.contains(node);
    for (let current = node; current; current = composedParent(current)) if (current === ancestor) return true;
    return false;
  }
  function deepActiveElement() {
    let el = document.activeElement;
    while (shadowPage && el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }
  // document.elementFromPoint retargets a hit inside a shadow tree to its host.
  function deepElementFromPoint(x, y) {
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }
  // IDs and label[for] are scoped to the element's own document or shadow root.
  function idScope(el) {
    const root = el.getRootNode && el.getRootNode();
    return root && typeof root.getElementById === 'function' ? root : document;
  }
  // Text nodes below root, lazily, in rendered order. Shadow roots commonly
  // start with a <style>; never-rendered subtrees are skipped outright.
  const UNRENDERED_TEXT = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
  function textIterator(root) {
    if (!shadowPage) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      return () => walker.nextNode();
    }
    const stack = [];
    const push = node => { const children = flatChildNodes(node); for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]); };
    push(root);
    return () => {
      while (stack.length) {
        const node = stack.pop();
        if (node.nodeType === 3) return node;
        if (node.nodeType === 1 && !UNRENDERED_TEXT.test(node.tagName)) push(node);
      }
      return null;
    };
  }
  // A shadow root's own text children have no parent element; use its host.
  function textParent(node) {
    return node.parentElement || (shadowPage && node.parentNode && node.parentNode.host) || null;
  }
  // A slot is not in an element's textContent; rendered text includes it.
  function flatText(el) {
    if (!shadowPage) return el.textContent || '';
    const next = textIterator(el);
    let text = '', node, count = 0;
    while ((node = next()) && ++count <= 5000 && text.length < 2000) text += node.data;
    return text;
  }
  // A label's own words: never the option list or value of the control it
  // wraps (or of any other field inside it).
  function labelText(label, control) {
    const next = textIterator(label);
    let text = '', node, count = 0;
    while ((node = next()) && ++count <= 2000 && text.length < 2000) {
      const parent = textParent(node);
      if (!parent || parent === control || composedContains(control, parent) ||
          composedClosest(parent, 'select,option,datalist,textarea,script,style')) continue;
      text += node.data;
    }
    return text.trim();
  }

  // ── actionability ─────────────────────────────────────────────────────────
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
    'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch',
    'slider', 'tab', 'spinbutton', 'gridcell',
  ]);

  function isNativelyInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) {
      if (tag === 'a') return el.hasAttribute('href');
      return true;
    }
    if (el.isContentEditable) return true;
    return false;
  }

  // agent-browser's heuristic: catch div-as-button that ARIA misses. Only when
  // the element is NOT already native/ARIA-interactive (avoid double counting).
  function isHeuristicInteractive(el, style) {
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && ti !== '-1') return true;
    // cursor:pointer, but only if this element SETS it (not inherited from a
    // clickable ancestor — that would tag every child).
    if (style.cursor === 'pointer') {
      const parent = composedParent(el);
      if (!parent || getComputedStyle(parent).cursor !== 'pointer') return true;
    }
    return false;
  }

  function isActionable(el, style) {
    const role = explicitRole(el);
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (isNativelyInteractive(el)) return true;
    if (isHeuristicInteractive(el, style)) return true;
    return false;
  }

  // An in-PROSE link is a plain <a href> that sits inside body text (a
  // paragraph, list item, table cell, etc.) and is not itself a control. These
  // dominate content pages (a Wikipedia article is ~1000 of them) and are noise
  // for an agent looking for controls. `snapshot({ prose: false })` (the
  // default) collapses them to a single count line; `{ prose: true }` includes
  // them. A link in nav/menu/header/footer or with a button-ish role is NOT
  // in-prose — those are real navigation the agent wants.
  const PROSE_CONTAINERS = new Set(['P', 'LI', 'TD', 'TH', 'DD', 'DT', 'BLOCKQUOTE', 'FIGCAPTION', 'SPAN', 'CITE']);
  const NAV_CONTAINERS = new Set(['NAV', 'HEADER', 'FOOTER', 'MENU']);
  function isInProseLink(el) {
    if (el.tagName.toLowerCase() !== 'a' || !el.hasAttribute('href')) return false;
    if (explicitRole(el)) return false; // a role means it's a deliberate widget
    // Walk ancestors: nav/header/footer/menu or [role=navigation] => NOT prose.
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (NAV_CONTAINERS.has(p.tagName)) return false;
      const r = p.getAttribute && p.getAttribute('role');
      if (r === 'navigation' || r === 'menu' || r === 'menubar' || r === 'tablist') return false;
    }
    // Immediate-ish text container => prose.
    for (let p = el.parentElement, hops = 0; p && hops < 4; p = p.parentElement, hops++) {
      if (PROSE_CONTAINERS.has(p.tagName)) return true;
    }
    return false;
  }

  // Disabled?
  function isDisabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    return false;
  }

  // ── snapshot walk ─────────────────────────────────────────────────────────
  // Walk the DOM depth-first. For each actionable + visible element, emit a
  // line. Indentation reflects how many actionable ancestors it has (cheap
  // structure signal without dumping containers).
  function truncate(s, n) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function lineFor(el, ref, depth) {
    const tag = el.tagName.toLowerCase();
    const role = explicitRole(el) || tagRole(el);
    const parts = ['[' + role];

    // key attributes inline
    if (tag === 'input' || tag === 'button') {
      const t = el.getAttribute('type');
      if (t) parts.push('type="' + t + '"');
    }
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href) parts.push('href="' + truncate(href, 60) + '"');
    }
    let head = parts.join(' ') + ']';

    // state flags
    const flags = [];
    if (isDisabled(el)) flags.push('disabled');
    if (el.checked || el.getAttribute('aria-checked') === 'true') flags.push('checked');
    if (el.selected || el.getAttribute('aria-selected') === 'true') flags.push('selected');
    if (el.getAttribute('aria-expanded')) flags.push('expanded=' + el.getAttribute('aria-expanded'));
    const flagStr = flags.length ? ' {' + flags.join(',') + '}' : '';

    const name = truncate(accName(el), 80);
    const nameStr = name ? ' "' + name.replace(/"/g, '\\"') + '"' : '';

    let extra = '';
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) extra += ' placeholder="' + truncate(ph, 40) + '"';
    const val = (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea') && el.value;
    if (val) extra += ' value="' + truncate(val, 40) + '"';

    const indent = '  '.repeat(Math.min(depth, 6));
    return indent + '@' + ref + ' ' + head + flagStr + nameStr + extra;
  }

  // Is the element's box within (or near) the current viewport? Used to rank
  // on-screen elements first when capping. "Near" includes a margin so an
  // element just below the fold isn't dropped when there is room.
  function onScreen(el, margin) {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const m = margin == null ? 0 : margin;
    return r.bottom >= -m && r.top <= vh + m && r.right >= -m && r.left <= vw + m;
  }

  // Returns { items: [{line, onScreen}], proseCount }. Formatting/capping is
  // done by the caller so it can rank on-screen first.
  function walk(root, opts) {
    const items = [];
    const seen = new Set();
    const includeProse = !!opts.prose;
    let proseCount = 0;

    function visit(node, depth) {
      if (!(node instanceof Element)) return;
      if (seen.has(node)) return;
      seen.add(node);

      // Skip subtrees that can never matter.
      const tag = node.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return;
      if (node.getAttribute('aria-hidden') === 'true') return;

      const style = getComputedStyle(node);
      if (style.display === 'none') return; // whole subtree gone

      let nextDepth = depth;
      if (isActionable(node, style) && isVisible(node)) {
        if (!includeProse && isInProseLink(node)) {
          proseCount++; // collapse in-prose links to a count
        } else {
          const role = explicitRole(node) || tagRole(node);
          const name = accName(node);
          const ref = assignRef(node, role, name);
          items.push({ line: lineFor(node, ref, depth), onScreen: onScreen(node, 0) });
          nextDepth = depth + 1;
        }
      }

      // Descend into open shadow roots + same-origin iframes + light DOM.
      if (node.shadowRoot) {
        for (const child of node.shadowRoot.children) visit(child, nextDepth);
      }
      if (tag === 'iframe') {
        let doc = null;
        try {
          doc = node.contentDocument; // throws / null for cross-origin
        } catch (e) {
          doc = null;
        }
        if (doc && doc.body) {
          items.push({ line: '  '.repeat(Math.min(nextDepth, 6)) + '[iframe] (same-origin)', onScreen: onScreen(node, 0) });
          visit(doc.body, nextDepth + 1);
        } else {
          items.push({ line: '  '.repeat(Math.min(nextDepth, 6)) + '[iframe] (cross-origin, not readable)', onScreen: onScreen(node, 0) });
        }
        return;
      }
      for (const child of node.children) visit(child, nextDepth);
    }

    visit(root, 0);
    return { items, proseCount };
  }

  // Turn the walk result into the final line list, applying a viewport-aware
  // cap. Elements keep DOM order; when there are more than `max`, off-screen
  // ones past the budget are dropped and summarized (on-screen elements are
  // always kept). `max` = 0 disables the cap.
  function formatWalk(walkResult, opts) {
    const includeProse = !opts.prose;
    const max = opts.max == null ? 200 : opts.max;
    let items = walkResult.items;
    let offScreenOmitted = 0;

    if (max > 0 && items.length > max) {
      const onScreenItems = items.filter((i) => i.onScreen);
      if (onScreenItems.length >= max) {
        // Even on-screen alone overflows: keep the first `max` in DOM order.
        offScreenOmitted = items.length - max;
        items = onScreenItems.slice(0, max);
      } else {
        // Keep all on-screen, then fill the remaining budget with the earliest
        // off-screen ones (DOM order preserved by filtering the original list).
        const budget = max - onScreenItems.length;
        const kept = new Set(onScreenItems);
        let added = 0;
        for (const i of items) {
          if (i.onScreen) continue;
          if (added < budget) {
            kept.add(i);
            added++;
          } else {
            offScreenOmitted++;
          }
        }
        items = items.filter((i) => kept.has(i));
      }
    }

    const lines = items.map((i) => i.line);
    if (offScreenOmitted > 0) {
      lines.push('… +' + offScreenOmitted + ' more off-screen elements (scroll, or raise `max`)');
    }
    if (includeProse && walkResult.proseCount > 0) {
      lines.push('… +' + walkResult.proseCount + ' in-body links (call snapshot with prose:true to include)');
    }
    return lines;
  }

  // ── resolution ────────────────────────────────────────────────────────────
  function resolve(ref) {
    const entry = entryOf.get(ref);
    if (!entry) return null;
    let el = entry.el.deref();
    if (el && el.isConnected) return el;
    // Fallback: re-query by role+name (agent-browser's stale-ref recovery).
    const candidates = document.querySelectorAll('*');
    for (const c of candidates) {
      if ((explicitRole(c) || tagRole(c)) === entry.role && accName(c) === entry.name && isVisible(c)) {
        refOf.set(c, ref);
        entry.el = new WeakRef(c);
        return c;
      }
    }
    return null;
  }

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // ── public API ────────────────────────────────────────────────────────────
  let lastLines = [];

  function snapshot(options) {
    options = options || {};
    if (options.decision) return decisionSnapshot();
    detectShadow();
    const lines = formatWalk(walk(document.body, options), options);
    const removed = [];
    if (options.delta && lastLines.length) {
      const now = new Set(lines);
      for (const l of lastLines) if (!now.has(l)) removed.push(l);
      const prev = new Set(lastLines);
      const added = lines.filter((l) => !prev.has(l));
      lastLines = lines;
      return {
        url: location.href,
        title: document.title,
        delta: true,
        added,
        removed,
        count: lines.length,
      };
    }
    lastLines = lines;
    return {
      url: location.href,
      title: document.title,
      text: lines.join('\n'),
      count: lines.length,
    };
  }

  function click(ref) {
    const el = resolve(ref);
    if (!el) return { ok: false, error: 'ref not found: ' + ref };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const c = centerOf(el);
    const opts = { bubbles: true, cancelable: true, view: window, clientX: c.x, clientY: c.y };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return { ok: true, ref, clicked: (el.textContent || '').trim().slice(0, 40) };
  }

  // Walk the ELEMENT'S OWN prototype chain for the native `value` setter. The
  // agent runtime runs in an isolated WKContentWorld, where
  // window.HTMLInputElement / HTMLTextAreaElement are a DIFFERENT realm's
  // constructors than the page's — their prototype's setter can be absent or
  // refuse to apply to a page element, so a set silently no-ops (the bug where
  // typing "didn't register" on Google's search box). The element's own
  // prototype chain is the page's, so its setter always applies. Falls back to a
  // plain assignment if no descriptor is found.
  function nativeValueSetter(node, property) {
    let p = Object.getPrototypeOf(node);
    while (p) {
      const d = Object.getOwnPropertyDescriptor(p, property || 'value');
      if (d && d.set) return d.set;
      p = Object.getPrototypeOf(p);
    }
    return null;
  }

  function type(ref, text, opts) {
    opts = opts || {};
    const el = resolve(ref);
    if (!el) return { ok: false, error: 'ref not found: ' + ref };
    el.focus();

    const next = opts.append
      ? (el.isContentEditable ? (el.textContent || '') : (el.value || '')) + text
      : text;

    if (el.isContentEditable) {
      el.textContent = next;
    } else {
      const setter = nativeValueSetter(el);
      if (setter) {
        try { setter.call(el, next); } catch (_e) { el.value = next; }
      } else {
        el.value = next;
      }
    }

    // A fuller event sequence: some sites gate autocomplete / submit-enabling on
    // real input events (beforeinput + an InputEvent with inputType), not just a
    // bare Event('input'). Guarded because older engines may lack InputEvent.
    try {
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    } catch (_e) { /* InputEvent unsupported: the input Event below still fires */ }
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } catch (_e) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // Verify the write actually landed, so the caller can tell (and not proceed
    // to a dead submit). Report the resulting value.
    const got = el.isContentEditable ? (el.textContent || '') : (el.value || '');
    const ok = got.indexOf(text) !== -1;
    return ok
      ? { ok: true, ref, value: got.slice(0, 200) }
      : { ok: false, ref, error: 'the field did not accept the text (value unchanged)', value: got.slice(0, 200) };
  }

  function getText(maxChars) {
    const t = (document.body.innerText || '').replace(/\n{3,}/g, '\n\n');
    return { url: location.href, title: document.title, text: t.slice(0, maxChars || 50000) };
  }

  // The task API deliberately never uses resolve()'s role/name rebinding.
  // A prediction belongs to one exact observed node, document and user-input epoch.
  const documentId = crypto.randomUUID ? crypto.randomUUID() :
    Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');
  let observationId = 0;
  let interactionEpoch = 0;
  let decisionObservation = null;
  let decisionScroll = null;
  const taskTargets = new Map();
  for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(event, e => { if (e.isTrusted) interactionEpoch++; }, { capture: true, passive: true });
  }
  const sensitiveWords = /\b(buy|purchase|pay|checkout|order|delete|remove|send|transfer|confirm|subscribe|unsubscribe|deactivate|close account|sign in|log in)\b/i;
  const dialogSelector = 'dialog,[role~="dialog"],[role~="alertdialog"],[aria-modal="true"]';
  function forbiddenField(el) {
    return /password|credit.?card|card.?number|security.?code|cvv|cvc|cc-number|cc-csc|one-time-code/i.test(
      [el.type, el.autocomplete, el.name, el.id, accName(el)].join(' '));
  }
  function observedControlState(el) {
    const state = {};
    // Missing or invalid ARIA is unknown, never an inferred false value.
    for (const key of ['checked', 'selected', 'expanded']) {
      const value = el.getAttribute('aria-' + key);
      if (value === 'true' || value === 'false' || (key === 'checked' && value === 'mixed')) state[key] = value;
    }
    // Live native properties take precedence over stale markup or ARIA.
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      state.checked = el.type === 'checkbox' && el.indeterminate ? 'mixed' : String(el.checked);
    }
    if (el.tagName === 'OPTION') state.selected = String(el.selected);
    return state;
  }
  function inputHints(el) {
    const scope = idScope(el);
    const description = (el.getAttribute('aria-describedby') || '').trim().split(/\s+/).slice(0, 5)
      .map(id => scope.getElementById(id)).filter(Boolean).map(node => accName(node)).join(' ').replace(/\s+/g, ' ').trim();
    return { type: el.tagName === 'INPUT' ? el.type : el.isContentEditable ? 'contenteditable' : el.tagName.toLowerCase(),
      placeholder: String(el.getAttribute('placeholder') || '').slice(0, 200),
      description: description.slice(0, 500), descriptionTruncated: description.length > 500,
      autocomplete: String(el.getAttribute('autocomplete') || '').slice(0, 100),
      inputMode: String(el.getAttribute('inputmode') || '').slice(0, 40),
      hasPopup: String(el.getAttribute('aria-haspopup') || '').slice(0, 50),
      min: String(el.getAttribute('min') || '').slice(0, 100), max: String(el.getAttribute('max') || '').slice(0, 100),
      pattern: String(el.getAttribute('pattern') || '').slice(0, 200), required: !!el.required };
  }
  function optionLabel(option) {
    return String(option.label || option.text || '').replace(/\s+/g, ' ').trim();
  }
  // A native single-choice dropdown opens an OS menu outside the page, so a
  // click can never choose from it. Its enabled options become direct choices,
  // addressed by their index in el.options and checked again at dispatch.
  function dropdownChoices(el) {
    if (el.tagName !== 'SELECT' || el.multiple) return null;
    const options = [];
    let truncated = false;
    for (let index = 0; index < el.options.length; index++) {
      if (index > 9999) { truncated = true; break; }
      const option = el.options[index];
      if (option.disabled || option.hidden || (option.parentElement && option.parentElement.tagName === 'OPTGROUP' && option.parentElement.disabled)) continue;
      const label = optionLabel(option);
      if (!label) continue;
      if (options.length >= 300) { truncated = true; break; }
      if (label.length > 100) truncated = true;
      options.push({ index, label: label.slice(0, 100), ...(option.selected ? { selected: true } : {}) });
    }
    return { options, optionsTruncated: truncated };
  }
  // A layout-free slot cannot supply rendered context text.
  function contextRoot(el) {
    let parent = composedParent(el);
    while (parent && parent.tagName === 'SLOT') parent = composedParent(parent);
    return parent;
  }
  function targetData(el) {
    const role = explicitRole(el) || tagRole(el);
    const name = accName(el).slice(0, 300);
    const forbidden = forbiddenField(el);
    const canType = !el.readOnly && (el.tagName === 'TEXTAREA' || el.isContentEditable ||
      (el.tagName === 'INPUT' && /^(text|search|email|url|tel|number|date|time|datetime-local|month|week)$/.test(el.type)));
    const form = composedClosest(el, 'form');
    const context = ((form || contextRoot(el) || el).innerText || '').replace(/\s+/g, ' ').slice(0, 500);
    const destination = String(el.href || el.formAction || (form && form.action) || '').slice(0, 4000);
    const dialog = composedClosest(el, dialogSelector);
    const dropdown = forbidden ? null : dropdownChoices(el);
    // Keep a real field's empty value. A custom combobox without a value
    // property exposes its rendered selection, not its accessible label. A
    // native dropdown reports its selected option's label, not its form value.
    const value = el.isContentEditable ? el.textContent : dropdown ? (el.selectedIndex >= 0 ? optionLabel(el.options[el.selectedIndex]) : '') :
      'value' in el ? el.value : role === 'combobox' ? String(el.innerText || '').trim() : '';
    return { ref: assignRef(el, role, name), role, name, canType, forbidden,
      value: forbidden ? '' : String(value ?? '').slice(0, 2000),
      ...(canType && !forbidden ? { input: inputHints(el) } : {}),
      ...(dropdown ? dropdown : {}),
      ...observedControlState(el),
      disabled: isDisabled(el) || el.matches(':disabled'), context, destination,
      ...(dialog ? { dialog: accName(dialog).replace(/\s+/g, ' ').trim().slice(0, 300) } : {}),
      sensitive: sensitiveWords.test([name, context, destination].join(' ')) ||
        (!name && (role === 'button' || el.type === 'submit')) };
  }
  function fingerprint(el, expandedOverride) {
    const form = composedClosest(el, 'form');
    // Values are held only in this isolated world, never returned to the model.
    const fields = form ? Array.from(form.elements).map(e => [e.name, e.value, e.checked, e.disabled]) : [];
    const data = targetData(el);
    if (expandedOverride !== undefined) data.expanded = expandedOverride;
    return JSON.stringify([data, fields, [el.tagName, el.type, el.name, form?.action, form?.method],
      el.checked, el.indeterminate, expandedOverride ?? el.getAttribute('aria-expanded'), el.getAttribute('aria-checked'),
      el.getAttribute('onclick'), composedClosest(el, '[role="dialog"]')?.textContent?.slice(0, 2000)]);
  }
  // The viewport point (CSS px) where a real click on el lands on el itself.
  function hitPoint(el) {
    // Inline controls can wrap into separate painted fragments. The center of
    // their union box may be empty line spacing, even when every line is visible.
    // Hit-test each visible fragment; covered controls still have no valid hit.
    for (const r of Array.from(el.getClientRects())) {
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight || r.width < 1 || r.height < 1) continue;
      const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
      const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
      const hit = deepElementFromPoint(x, y);
      if (hit && (hit === el || composedContains(el, hit))) return { x, y };
    }
    return null;
  }
  function hitTarget(el) { return hitPoint(el) !== null; }
  const FRAME_TAGS = /^(IFRAME|FRAME|EMBED|OBJECT)$/;
  function isControl(node) {
    return isNativelyInteractive(node) || INTERACTIVE_ROLES.has(explicitRole(node) || '');
  }
  // A point where a REAL click would activate el itself: not a nested control
  // (a "Delete" button inside a clickable card) and not an embedded frame.
  // A DOM click() needs no point; a real one goes to whatever is deepest.
  function strictPoint(el) {
    for (const r of Array.from(el.getClientRects())) {
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight || r.width < 1 || r.height < 1) continue;
      const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
      const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
      const hit = deepElementFromPoint(x, y);
      if (!hit || (hit !== el && !composedContains(el, hit)) || (FRAME_TAGS.test(hit.tagName) && hit !== el)) continue;
      let nested = false;
      for (let node = hit; node && node !== el; node = composedParent(node)) if (isControl(node)) { nested = true; break; }
      if (!nested) return { x, y };
    }
    return null;
  }
  // Closes the gap between the check and the real click: until the click
  // arrives, a trusted press in this document must land on `allowed` (or
  // inside it); anything else, such as a re-rendered list item now under the
  // point, is cancelled. Removed after the click or a short time.
  function guardRealClick(allowed) {
    const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    const guard = event => {
      if (!event.isTrusted) return;
      const target = event.composedPath()[0];
      if (!(target instanceof Node) || (target !== allowed && !composedContains(allowed, target.nodeType === 1 ? target : target.parentElement))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (event.type === 'click') release();
    };
    const release = () => { for (const type of types) window.removeEventListener(type, guard, true); clearTimeout(timer); };
    for (const type of types) window.addEventListener(type, guard, true);
    const timer = setTimeout(release, 1500);
  }
  // Frames the agent never operates, whatever page embeds them: CAPTCHA,
  // payment and sign-in. Mirrors RESTRICTED_FRAME_HOSTS on the website.
  const RESTRICTED_FRAME_HOSTS = ['recaptcha.net', 'hcaptcha.com', 'challenges.cloudflare.com', 'arkoselabs.com', 'funcaptcha.com',
    'geetest.com', 'captcha-delivery.com', 'perimeterx.net', 'px-cloud.net', 'stripe.com', 'stripe.network', 'paypal.com',
    'paypalobjects.com', 'braintreegateway.com', 'braintree-api.com', 'adyen.com', 'checkout.com', 'squareup.com', 'klarna.com',
    'affirm.com', 'pay.google.com', 'shop.app', 'accounts.google.com', 'login.microsoftonline.com', 'login.live.com',
    'appleid.apple.com', 'facebook.com', 'auth0.com', 'okta.com', 'onelogin.com'];
  function restrictedFrame() {
    if (window === window.top) return false;
    const host = location.hostname.toLowerCase();
    return !host || RESTRICTED_FRAME_HOSTS.some(suffix => host === suffix || host.endsWith('.' + suffix)) ||
      (/(^|\.)google\.com$/.test(host) && location.pathname.startsWith('/recaptcha'));
  }

  // ── embedded frames ───────────────────────────────────────────────────────
  // This runtime runs in every frame. The native app reaches each frame
  // through its own registration, and maps it to its <iframe> by the frame's
  // index among its parent's child frames: the same index the parent sees in
  // window.frames. Both are plain reads; nothing is posted to the page.
  function childFrameElements() {
    const windows = Array.from({ length: window.frames.length }, (_, i) => window.frames[i]);
    const out = [];
    for (const el of queryAll('iframe,frame')) {
      let index = -1;
      try { index = windows.indexOf(el.contentWindow); } catch { index = -1; }
      if (index < 0) continue;
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      const left = parseFloat(style.paddingLeft) || 0, top = parseFloat(style.paddingTop) || 0;
      const right = parseFloat(style.paddingRight) || 0, bottom = parseFloat(style.paddingBottom) || 0;
      const round = value => Math.round(value * 100) / 100;
      // A scaled, rotated or zoomed frame does not map 1 CSS px to 1 CSS px:
      // its points cannot be placed, so it is not offered.
      let scaled = Math.abs(r.width - el.offsetWidth) > 0.5 || Math.abs(r.height - el.offsetHeight) > 0.5;
      for (let node = el; node && !scaled; node = composedParent(node)) {
        const zoom = getComputedStyle(node).zoom;
        if (zoom && zoom !== 'normal' && parseFloat(zoom) !== 1) scaled = true;
      }
      out.push({ el, geometry: { index, x: round(r.left + el.clientLeft + left), y: round(r.top + el.clientTop + top),
        width: round(Math.max(0, el.clientWidth - left - right)), height: round(Math.max(0, el.clientHeight - top - bottom)), visible: !scaled && taskVisible(el) } });
      if (out.length >= 16) break;
    }
    return out;
  }
  // This frame's index in each ancestor's child frames, from the top. null
  // when the frame cannot be placed (or is deeper than four levels).
  function framePath() {
    const path = [];
    try {
      for (let w = window; w !== w.parent; w = w.parent) {
        const siblings = w.parent.frames;
        let index = -1;
        for (let i = 0; i < siblings.length; i++) if (siblings[i] === w) { index = i; break; }
        if (index < 0 || path.length >= 4) return null;
        path.unshift(index);
      }
    } catch { return null; }
    return path;
  }
  // Checked in each enclosing document before an action inside a child frame:
  // the same observation, the same unmoved and visible <iframe>, and the
  // action's point lands on that <iframe> rather than on an overlay.
  // Enter in a message composer sends; in a form it presses the default
  // submit button. Either is as consequential as clicking Send or Pay.
  function enterSensitive(el) {
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    const form = composedClosest(el, 'form');
    if (!form) return false;
    return queryAll('button,input[type="submit"],input[type="image"]', form).some(button =>
      (button.tagName !== 'BUTTON' || (button.getAttribute('type') || 'submit').toLowerCase() === 'submit') &&
      sensitiveWords.test([accName(button), button.value || '', form.action || ''].join(' ')));
  }
  function frameGate(request) {
    detectShadow();
    const obs = decisionObservation;
    const stale = { ok: false, code: 'stale_observation' };
    if (!obs || request.documentId !== documentId || request.observationId !== obs.observationId ||
        request.interactionEpoch !== interactionEpoch || obs.interactionEpoch !== interactionEpoch ||
        obs.url !== location.href || Date.now() - obs.observedAt > 10000) return stale;
    const observed = (obs.childFrames || []).find(frame => frame.index === request.index);
    const current = childFrameElements().find(frame => frame.geometry.index === request.index);
    if (!observed || !current || !current.geometry.visible ||
        ['x', 'y', 'width', 'height'].some(key => Math.abs(observed[key] - current.geometry[key]) > 0.5)) return stale;
    const { x, y } = request;
    const g = current.geometry;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < g.x || y < g.y || x >= g.x + g.width || y >= g.y + g.height) return stale;
    if (deepElementFromPoint(x, y) !== current.el) return stale;
    // A real click is coming: in this document it may only land on the frame.
    if (request.guardClick === true) guardRealClick(current.el);
    return { ok: true, x: g.x, y: g.y };
  }
  // A styled dropdown is often a fully transparent native <select> laid over
  // its own label: the select itself receives the user's click. Only that
  // element's own opacity is excused, and actions still require its hit test.
  function transparentDropdown(el) {
    return el.tagName === 'SELECT' && !el.multiple && parseFloat(getComputedStyle(el).opacity) === 0 && hitTarget(el);
  }
  function taskVisible(el) {
    const transparent = transparentDropdown(el);
    if (!isVisible(el, transparent) || composedClosest(el, '[inert],[aria-hidden="true"]')) return false;
    for (let node = el; node; node = composedParent(node)) {
      const style = getComputedStyle(node);
      if ((parseFloat(style.opacity) === 0 && !(transparent && node === el)) || style.visibility === 'hidden' || style.display === 'none') return false;
    }
    return true;
  }
  function viewportState() {
    const root = document.scrollingElement || document.documentElement;
    return { width: innerWidth, height: innerHeight, scrollX: Math.max(0, window.scrollX), scrollY: Math.max(0, window.scrollY),
      scrollWidth: Math.max(innerWidth, root?.scrollWidth || 0), scrollHeight: Math.max(innerHeight, root?.scrollHeight || 0) };
  }
  // Bind scrolling to the same interaction surface that the observation exposes.
  // A modal never authorizes movement of the obscured document behind it.
  function scrollContext() {
    const dialogs = queryAll(dialogSelector)
      .filter(el => taskVisible(el) && hitTarget(el) && (el.tagName !== 'DIALOG' || el.open));
    const modal = dialogs.at(-1) || null;
    // An unseen part of a huge page may hold the modal: never move what is behind it.
    if (flatTruncated) return { el: null, modal, surface: { scope: 'blocked', name: '',
      width: innerWidth, height: innerHeight, scrollX: 0, scrollY: 0, scrollWidth: innerWidth, scrollHeight: innerHeight } };
    const root = modal || document.body;
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = document.body && getComputedStyle(document.body);
    // CSS Overflow viewport propagation: an uncontained HTML root with
    // visible overflow delegates its body's overflow to the viewport. The
    // body's computed overflow still says auto/scroll, but its own scrollTop
    // cannot move that page. See https://www.w3.org/TR/css-overflow/#overflow-propagation
    const bodyPropagates = document.documentElement.tagName === 'HTML' &&
      rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible' &&
      rootStyle.contain === 'none' && bodyStyle?.contain === 'none' && bodyStyle.display !== 'none';
    const scrollable = el => !(el === document.body && bodyPropagates) && /^(auto|scroll)$/.test(getComputedStyle(el).overflowY) &&
      el.scrollHeight > el.clientHeight + 1 && taskVisible(el) && hitTarget(el);
    const candidates = root ? [root, ...queryAll('*', root).slice(0, 2000)].filter(scrollable) : [];
    const area = el => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) * Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)); };
    const active = deepActiveElement();
    const focused = candidates.filter(el => active && composedContains(el, active));
    // Prefer a focused scroll region; otherwise the largest visible region.
    const el = [...(focused.length ? focused : candidates)].sort((a, b) => area(b) - area(a))[0];
    const surfaceName = node => node && (node.hasAttribute('aria-label') || node.hasAttribute('aria-labelledby')) ? accName(node).slice(0, 300) : '';
    if (!modal && el === document.scrollingElement) return { el, modal: null, surface: { scope: 'page', name: '', ...viewportState() } };
    if (el && (modal || area(el) >= innerWidth * innerHeight * 0.5)) {
      return { el, modal, surface: { scope: modal ? 'dialog' : 'container', name: surfaceName(modal || el),
        width: el.clientWidth, height: el.clientHeight, scrollX: Math.max(0, el.scrollLeft), scrollY: Math.max(0, el.scrollTop),
        scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight } };
    }
    const page = viewportState();
    const viewportOverflow = bodyPropagates ? bodyStyle.overflowY : rootStyle.overflowY;
    if (modal || /^(hidden|clip)$/.test(viewportOverflow)) {
      return { el: null, modal, surface: { scope: 'blocked', name: surfaceName(modal),
        width: innerWidth, height: innerHeight, scrollX: 0, scrollY: 0, scrollWidth: innerWidth, scrollHeight: innerHeight } };
    }
    return { el: document.scrollingElement || document.documentElement, modal: null, surface: { scope: 'page', name: '', ...page } };
  }
  function viewportText() {
    if (!document.body) return { text: '', textScope: 'viewport', textTruncated: false };
    const words = [];
    const nextText = textIterator(document.body);
    const range = document.createRange();
    const inViewport = r => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    const whollyInViewport = r => inViewport(r) && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    let node, length = 0, nodes = 0, rangeChecks = 0, truncated = false, lastGroup = null;
    function append(value, group) {
      const text = value.replace(/\s+/g, ' ').trim();
      if (!text) return;
      const gap = words.length ? 1 : 0;
      const remaining = 12000 - length - gap;
      if (remaining <= 0) { truncated = true; return; }
      // Keep one rendered semantic row/paragraph together. Splitting price,
      // name and time into independent lines loses their association in a
      // bounded reading ledger. This only groups already-visible fragments.
      if (group && group === lastGroup) words[words.length - 1] += ' ' + text.slice(0, remaining);
      else words.push(text.slice(0, remaining));
      lastGroup = group;
      length += gap + Math.min(text.length, remaining);
      if (text.length >= remaining) truncated = true;
    }
    while ((node = nextText())) {
      // Large documents and a single enormous wrapped text node are bounded
      // independently. A cutoff is incomplete evidence, never proof of absence.
      if (++nodes > 20000 || rangeChecks >= 20000) { truncated = true; break; }
      const value = node.textContent || '';
      const parent = textParent(node);
      if (!value.trim() || !parent || composedClosest(parent, 'script,style,noscript,template,textarea,select') || !taskVisible(parent)) continue;
      const group = composedClosest(parent, '[role~="row"],[role~="listitem"],li,article,p') || composedClosest(parent, '[role~="link"]');
      range.selectNodeContents(node);
      rangeChecks++;
      const rects = Array.from(range.getClientRects());
      if (!rects.some(inViewport)) continue;
      if (rects.every(whollyInViewport)) append(value, group);
      else {
        // A wrapped text node can straddle the viewport. Do not expose all its
        // offscreen lines merely because its first line intersects the screen.
        const fragments = [];
        let fragment = '', offset = 0;
        // Character ranges also handle unbroken identifiers and CJK text.
        // A whitespace-token range would expose its whole offscreen suffix.
        for (const character of value) {
          if (++rangeChecks > 20000) { truncated = true; break; }
          const end = offset + character.length;
          if (/\s/.test(character)) { if (fragment) fragment += ' '; offset = end; continue; }
          range.setStart(node, offset);
          range.setEnd(node, end);
          if (Array.from(range.getClientRects()).some(inViewport)) {
            fragment += character;
          } else if (fragment) { fragments.push(fragment); fragment = ''; }
          offset = end;
        }
        if (fragment) fragments.push(fragment);
        append(fragments.join(' '), group);
      }
      if (truncated) break;
    }
    // Layout visibility matches the reference's text walk. It does not claim
    // that every text pixel is unobscured by another element; action hit tests
    // remain separate and strict.
    return { text: words.join('\n'), textScope: 'viewport', textTruncated: truncated };
  }
  function completionEvidence() {
    const headings = [];
    for (const el of queryAll('h1,h2,h3,h4,h5,h6,[role~="heading"]')) {
      if (headings.length >= 40) break;
      if (!taskVisible(el) || !hitTarget(el)) continue;
      const name = accName(el).replace(/\s+/g, ' ').trim();
      // A truncated name cannot prove an exact heading match.
      if (!name || name.length > 300) continue;
      const declaredLevel = Number(el.getAttribute('aria-level'));
      const nativeLevel = /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : null;
      const level = Number.isInteger(declaredLevel) && declaredLevel >= 1 && declaredLevel <= 6 ? declaredLevel : nativeLevel;
      headings.push({ name, level });
    }
    const dialogs = [];
    let dialogsComplete = true;
    for (const el of queryAll(dialogSelector)) {
      if ((el.tagName === 'DIALOG' && !el.open) || !taskVisible(el)) continue;
      // Inventory layout-present dialogs even offscreen/occluded: absence must
      // not pass because a prompt moved or another prompt covered it.
      if (dialogs.length >= 20) { dialogsComplete = false; break; }
      const name = accName(el).replace(/\s+/g, ' ').trim();
      if (name.length > 300) dialogsComplete = false;
      dialogs.push({ name: name.slice(0, 300), visible: hitTarget(el) });
    }
    // This protocol observes the top document and its open shadow roots.
    // Embedded frames, or a walk cut short, cannot establish that all dialogs disappeared.
    if (flatTruncated) dialogsComplete = false;
    for (const el of queryAll('iframe,frame,object,embed')) {
      if (taskVisible(el)) {
        dialogsComplete = false;
        break;
      }
    }
    return { headings, dialogs, dialogsComplete };
  }
  function readingContext(anchor) {
    let root = anchor;
    for (let parent = composedParent(anchor), depth = 0; parent && parent !== document.body && depth < 5; parent = composedParent(parent), depth++) {
      if (queryAll('h1,h2,h3,h4,h5,h6,[role~="heading"]', parent).length > 1) break;
      root = parent;
    }
    const nextText = textIterator(root);
    const parts = [];
    let node, nodes = 0, length = 0, truncated = false;
    while ((node = nextText())) {
      if (++nodes > 300) { truncated = true; break; }
      const parent = textParent(node);
      if (!parent || !taskVisible(parent) || composedClosest(parent, 'input,textarea,select,[contenteditable="true"],script,style,noscript')) continue;
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const remaining = 700 - length - (parts.length ? 1 : 0);
      if (remaining <= 0) { truncated = true; break; }
      parts.push(text.slice(0, remaining));
      length += Math.min(text.length, remaining) + (parts.length > 1 ? 1 : 0);
      if (text.length > remaining) { truncated = true; break; }
    }
    return { context: parts.join(' '), contextTruncated: truncated };
  }
  function documentHeadingLinks() {
    // Read metadata is separate from viewport text and executable targets.
    // A rendered offscreen heading/link may be read, never clicked through
    // this inventory. No fields, action refs or hidden DOM text are returned.
    const links = [];
    let truncated = false, section = '';
    const activeDialogs = queryAll(dialogSelector)
      .filter(el => taskVisible(el) && hitTarget(el) && (el.tagName !== 'DIALOG' || el.open));
    const nodes = queryAll('h1,h2,h3,h4,h5,h6,[role~="heading"]');
    for (let order = 0; order < nodes.length; order++) {
      if (order >= 500) { truncated = true; break; }
      const heading = nodes[order];
      if (!taskVisible(heading)) continue;
      const title = accName(heading).replace(/\s+/g, ' ').trim();
      const declared = Number(heading.getAttribute('aria-level'));
      const level = Number.isInteger(declared) && declared >= 1 && declared <= 6 ? declared : /^H[1-6]$/.test(heading.tagName) ? Number(heading.tagName[1]) : null;
      if (level === 1 || level === 2) section = title.slice(0, 300);
      const anchor = composedClosest(heading, 'a[href]') || queryAll('a[href]', heading)[0];
      // An inline anchor wrapping a block heading may have a zero-area own
      // box. The heading's rendered box and ancestor checks establish reading
      // visibility; requiring the anchor's own box would lose that exact pair.
      if (!anchor || activeDialogs.length && !activeDialogs.some(dialog => composedContains(dialog, heading))) continue;
      const rect = heading.getBoundingClientRect();
      const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      if (inViewport && !hitTarget(heading)) continue;
      const destination = String(anchor.href || '');
      try {
        const url = new URL(destination);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      } catch { continue; }
      if (!title || title.length > 300 || destination.length >= 4000) { truncated = true; continue; }
      const record = { title, destination, order, section, ...readingContext(anchor) };
      if (links.length >= 40 || new TextEncoder().encode(JSON.stringify([...links, record])).length > 6500) { truncated = true; break; }
      links.push(record);
    }
    return { documentLinks: links, documentLinksScope: 'rendered_heading_links', documentLinksTruncated: truncated || flatTruncated };
  }
  function documentReadingRecords() {
    // Read-only semantic records may be offscreen. Action refs and field values
    // still come only from validated, visible targets in the current viewport.
    const selector = 'tr,[role~="row"],li,[role~="listitem"],article';
    const records = [], candidates = queryAll(selector);
    const dialogs = queryAll(dialogSelector)
      .filter(el => taskVisible(el) && hitTarget(el) && (el.tagName !== 'DIALOG' || el.open));
    let truncated = false;
    for (let order = 0; order < candidates.length; order++) {
      if (order >= 500) { truncated = true; break; }
      const root = candidates[order];
      if (!taskVisible(root) || (shadowPage ? queryAll(selector, root).length : root.querySelector(selector)) ||
          dialogs.length && !dialogs.some(dialog => composedContains(dialog, root))) continue;
      const nextText = textIterator(root);
      const parts = [];
      let node, scanned = 0, length = 0, textTruncated = false;
      while ((node = nextText())) {
        if (++scanned > 300) { textTruncated = true; break; }
        const parent = textParent(node);
        if (!parent || !taskVisible(parent) || composedClosest(parent, 'input,textarea,select,[contenteditable="true"],script,style,noscript')) continue;
        const value = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!value) continue;
        const gap = parts.length ? 1 : 0, remaining = 480 - length - gap;
        if (remaining <= 0) { textTruncated = true; break; }
        let excerpt = '';
        for (const character of value) { if (excerpt.length + character.length > remaining) break; excerpt += character; }
        parts.push(excerpt); length += excerpt.length + gap;
        if (excerpt.length < value.length) { textTruncated = true; break; }
      }
      const text = parts.join(' ');
      if (!text) continue;
      const role = explicitRole(root);
      const kind = root.tagName === 'TR' || role === 'row' ? 'row' : root.tagName === 'ARTICLE' ? 'article' : 'listitem';
      const record = { kind, text, textTruncated, order };
      if (records.length >= 40 || new TextEncoder().encode(JSON.stringify([...records, record])).length > 6500) { truncated = true; break; }
      records.push(record);
    }
    return { documentRecords: records, documentRecordsScope: 'rendered_semantic_records', documentRecordsTruncated: truncated || flatTruncated };
  }
  function currentFormState() {
    // Fresh reading evidence is independent of executable viewport targets.
    // Offscreen fields can establish values, never acquire action refs here.
    const fields = [], nodes = queryAll('input,textarea,select,[contenteditable="true"],[role~="combobox"],[role~="textbox"],[role~="checkbox"],[role~="radio"],[role~="switch"],[role~="spinbutton"],[role~="slider"]');
    const dialogs = queryAll(dialogSelector)
      .filter(el => taskVisible(el) && hitTarget(el) && (el.tagName !== 'DIALOG' || el.open));
    const clip = (value, limit) => {
      let excerpt = '';
      for (const character of String(value ?? '')) { if (excerpt.length + character.length > limit) break; excerpt += character; }
      return excerpt;
    };
    let truncated = false;
    for (let index = 0; index < nodes.length; index++) {
      if (index >= 500) { truncated = true; break; }
      const el = nodes[index];
      if (!taskVisible(el) || forbiddenField(el) || el.type === 'hidden' || dialogs.length && !dialogs.some(dialog => composedContains(dialog, el))) continue;
      const name = accName(el).replace(/\s+/g, ' ').trim();
      const role = explicitRole(el) || tagRole(el);
      const selected = el.tagName === 'SELECT' && !el.multiple ? (el.selectedIndex >= 0 ? optionLabel(el.options[el.selectedIndex]) : '') : null;
      const value = String(el.isContentEditable ? el.textContent : selected !== null ? selected : 'value' in el ? el.value : role === 'combobox' ? String(el.innerText || '').trim() : '');
      const dialog = composedClosest(el, dialogSelector);
      const field = { role: clip(role, 100), name: clip(name, 300), nameTruncated: name.length > 300,
        value: clip(value, 500), valueTruncated: value.length > 500, ...observedControlState(el),
        disabled: isDisabled(el) || el.matches(':disabled'),
        ...(dialog ? { dialog: clip(accName(dialog).replace(/\s+/g, ' ').trim(), 300) } : {}) };
      if (fields.length >= 40 || new TextEncoder().encode(JSON.stringify([...fields, field])).length > 6500) { truncated = true; break; }
      fields.push(field);
    }
    return { currentFields: fields, currentFieldsScope: 'rendered_form_state', currentFieldsTruncated: truncated || flatTruncated };
  }
  function canonicalTaskTargets(candidates) {
    // Some autocomplete widgets expose both an ARIA option and its real link
    // with the same name. Clicking the wrapper is not equivalent to activating
    // the link: it can dismiss the popup without following the destination.
    // Resolve that ambiguity while building the observation, never at dispatch.
    const wrappers = new Set(candidates.filter(el => !isNativelyInteractive(el) &&
      /^(option|menuitem|listbox|gridcell)$/.test(explicitRole(el) || '') &&
      !['onclick', 'aria-expanded', 'aria-haspopup', 'aria-controls'].some(attribute => el.hasAttribute(attribute))));
    const descendants = new Map();
    for (const child of candidates) {
      for (let parent = composedParent(child); parent; parent = composedParent(parent)) {
        if (!wrappers.has(parent)) continue;
        if (!descendants.has(parent)) descendants.set(parent, []);
        descendants.get(parent).push(child);
      }
    }
    const canonical = new Set(candidates);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const wrapper = candidates[i];
      if (!wrappers.has(wrapper)) continue;
      const children = (descendants.get(wrapper) || []).filter(child => canonical.has(child) &&
        !isDisabled(child) && !child.matches(':disabled') && !forbiddenField(child));
      if (!children.length) continue;
      if (explicitRole(wrapper) === 'listbox') {
        // The choices are the actions; a separate listbox click adds no choice.
        canonical.delete(wrapper);
        continue;
      }
      if (children.length !== 1) continue;
      const child = children[0];
      if (!/^(link|button|option|menuitem)$/.test(explicitRole(child) || tagRole(child))) continue;
      const name = accName(wrapper).replace(/\s+/g, ' ').trim();
      if (name && name === accName(child).replace(/\s+/g, ' ').trim()) canonical.delete(wrapper);
    }
    // A web component host and the same-named control rendered inside its
    // shadow root are one control. Keep the inner control: it carries the
    // component's own handlers, and its click still reaches the host.
    const hosts = new Set(candidates.filter(el => el.shadowRoot && canonical.has(el)));
    if (hosts.size) {
      for (const el of candidates) {
        if (!canonical.has(el) || hosts.has(el)) continue;
        let parent = composedParent(el);
        for (let depth = 0; parent && depth < 40 && !hosts.has(parent); depth++) parent = composedParent(parent);
        if (parent && hosts.has(parent) && accName(parent).replace(/\s+/g, ' ').trim() === accName(el).replace(/\s+/g, ' ').trim()) canonical.delete(parent);
      }
    }
    return candidates.filter(el => canonical.has(el));
  }
  function decisionSnapshot() {
    taskTargets.clear();
    detectShadow();
    // Every flat-tree query in one observation shares a single walk per root.
    flatCache = shadowPage ? new Map() : null;
    try { return observeDecision(); } finally { flatCache = null; }
  }
  function observeDecision() {
    const elements = [], readMetrics = {}, started = performance.now();
    let phaseStart = started;
    const measured = name => { readMetrics[name] = Math.min(60000, Math.max(0, Math.round(performance.now() - phaseStart))); phaseStart = performance.now(); };
    // Top-document and open-shadow-DOM controls; frames, closed shadow roots and canvas escalate.
    // An embedded frame is never itself a target: its own controls are offered instead.
    const candidates = queryAll('a[href],button,input,textarea,select,summary,[role],[contenteditable="true"],[tabindex]')
      .filter(el => !FRAME_TAGS.test(el.tagName) && isActionable(el, getComputedStyle(el)) && taskVisible(el) && hitTarget(el));
    measured('controlScan');
    // Apply the budget after canonicalization so wrappers cannot crowd their
    // actual links out of the observed/actionable target set.
    // Dropdown options share one bound so a page of long lists cannot crowd
    // out the observation. The fingerprint keeps each control's full list.
    let optionBudget = 600;
    const active = deepActiveElement();
    const inFrame = window !== window.top;
    for (const el of canonicalTaskTargets(candidates)) {
      if (elements.length >= 100) break;
      const data = targetData(el);
      // Focus and position are observation facts, not part of the fingerprint.
      if (el === active) {
        data.focused = true;
        if (data.canType && enterSensitive(el)) data.enterSensitive = true;
      }
      if (inFrame) { const point = strictPoint(el) || hitPoint(el); if (point) data.point = { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 }; }
      if (data.options) {
        if (data.options.length > optionBudget) { data.options = data.options.slice(0, optionBudget); data.optionsTruncated = true; }
        optionBudget -= data.options.length;
      }
      elements.push(data);
      taskTargets.set(data.ref, { el: new WeakRef(el), fingerprint: fingerprint(el) });
    }
    measured('targetBuild');
    const text = viewportText(); measured('viewportText');
    const completion = { ...completionEvidence(), ...currentFormState() }; measured('completionEvidence');
    const reading = { ...documentHeadingLinks(), ...documentReadingRecords() }; measured('documentLinks');
    const scroll = scrollContext();
    decisionScroll = { el: scroll.el && new WeakRef(scroll.el), modal: scroll.modal && new WeakRef(scroll.modal), surface: scroll.surface };
    readMetrics.total = Math.min(60000, Math.max(0, Math.round(performance.now() - started)));
    decisionObservation = { protocol: 'dial8-browser-decision-v1', documentId, observationId: ++observationId,
      interactionEpoch, observedAt: Date.now(), url: location.href, title: document.title.slice(0, 500),
      readyState: document.readyState,
      loading: document.readyState === 'loading' || queryAll('[aria-busy="true"]').some(taskVisible),
      ...text, viewport: viewportState(), scrollSurface: scroll.surface, evidence: { ...completion, ...reading }, elements, readMetrics,
      childFrames: childFrameElements().map(frame => frame.geometry),
      ...(inFrame ? { framePath: framePath(), origin: location.origin } : {}) };
    return decisionObservation;
  }
  function taskAction(request) {
    detectShadow();
    const obs = decisionObservation;
    const stale = () => ({ ok: false, code: 'stale_observation', error: 'Observe the page again before acting.' });
    if (!obs || request.documentId !== documentId || request.observationId !== obs.observationId ||
        request.interactionEpoch !== interactionEpoch || obs.interactionEpoch !== interactionEpoch ||
        obs.url !== location.href || Date.now() - obs.observedAt > 10000 ||
        !Number.isFinite(request.deadline) || Date.now() >= request.deadline) return stale();
    const operation = request.operation;
    if (operation === 'scroll_down' || operation === 'scroll_up') {
      const fresh = scrollContext(), bound = decisionScroll;
      if (!bound || fresh.el !== bound.el?.deref() || fresh.modal !== (bound.modal?.deref() || null) ||
          JSON.stringify(fresh.surface) !== JSON.stringify(bound.surface)) return stale();
      const surface = fresh.surface, down = operation === 'scroll_down';
      if (!fresh.el || (down ? surface.scrollY + surface.height >= surface.scrollHeight - 1 : surface.scrollY <= 1))
        return { ok: false, code: 'unsupported' };
      decisionObservation = null;
      const distance = Math.max(1, Math.round(surface.height * 0.7));
      if (surface.scope === 'page') window.scrollBy({ top: (down ? 1 : -1) * distance, behavior: 'instant' });
      else fresh.el.scrollBy({ top: (down ? 1 : -1) * distance, behavior: 'instant' });
      return { ok: true };
    }
    // Real keyboard input from the app. Escape dismisses whatever has focus.
    if (operation === 'press_key' && request.key === 'Escape') {
      if (request.trustedInput !== true || request.ref !== undefined) return { ok: false, code: 'unsupported' };
      decisionObservation = null;
      return { ok: true, input: { kind: 'key', key: 'Escape' } };
    }
    if (operation === 'press_key' && (request.key !== 'Enter' || request.trustedInput !== true)) return { ok: false, code: 'unsupported' };
    if (operation !== 'click' && operation !== 'type' && operation !== 'select' && operation !== 'press_key') return { ok: false, code: 'unsupported' };
    if (restrictedFrame()) return { ok: false, code: 'forbidden_frame' };
    const record = taskTargets.get(request.ref);
    const el = record?.el.deref();
    if (!el || !el.isConnected || !taskVisible(el) || isDisabled(el) || el.matches(':disabled') ||
        record.fingerprint !== fingerprint(el) || !hitTarget(el)) return stale();
    const data = targetData(el);
    if (data.forbidden) return { ok: false, code: 'forbidden_field' };
    if (data.sensitive && !request.approved) return { ok: false, code: 'approval_required' };
    if (operation === 'type' && (!data.canType || typeof request.text !== 'string' || request.text.length > 2000))
      return { ok: false, code: 'unsupported' };
    // Enter goes to the focused field, so it must be the observed, still-focused one.
    if (operation === 'press_key' && (!data.canType || el !== deepActiveElement())) return stale();
    if (operation === 'press_key' && !request.approved && enterSensitive(el)) return { ok: false, code: 'approval_required' };
    // A real click lands where the app sends it: inside a frame, exactly where
    // every enclosing document just verified its <iframe> is uncovered. Where
    // no point activates el itself, the DOM click on el is used instead.
    const point = operation === 'click' && request.trustedInput === true ? strictPoint(el) : null;
    if (point && request.expectedPoint &&
        (Math.abs(point.x - request.expectedPoint.x) > 1 || Math.abs(point.y - request.expectedPoint.y) > 1)) return stale();
    // Only an option offered in this control's observed list can be chosen.
    if (operation === 'select' && (!data.options || !Number.isInteger(request.option) ||
        !data.options.some(choice => choice.index === request.option))) return { ok: false, code: 'unsupported' };
    // Choosing "Delete" or "Confirm order" is as consequential as the button.
    if (operation === 'select' && !request.approved && sensitiveWords.test(optionLabel(el.options[request.option])))
      return { ok: false, code: 'approval_required' };
    // Consume before dispatch: an uncertain response must never replay this write.
    decisionObservation = null;
    if (operation === 'press_key') return { ok: true, input: { kind: 'key', key: 'Enter' } };
    if (operation === 'click' && point) {
      guardRealClick(el);
      return { ok: true, input: { kind: 'click', x: point.x, y: point.y } };
    }
    if (operation === 'click') {
      el.click();
      return { ok: true };
    }
    if (operation === 'select') {
      // The page realm's setter, as for typing. Frameworks listen for change.
      const setter = nativeValueSetter(el, 'selectedIndex');
      if (setter) setter.call(el, request.option);
      else el.selectedIndex = request.option;
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const chosen = el.selectedIndex === request.option;
      return { ok: chosen, code: chosen ? undefined : 'write_unverified' };
    }
    // A visible field at the viewport edge can open its suggestions entirely
    // below the screen. Position only this already-authorized target before
    // typing; this does not make an offscreen/covered field actionable.
    const rect = el.getBoundingClientRect();
    if (rect.top < innerHeight * 0.2 || rect.bottom > innerHeight * 0.8) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      if (!el.isConnected || !taskVisible(el) || isDisabled(el) || el.matches(':disabled') ||
          record.fingerprint !== fingerprint(el) || !hitTarget(el) || Date.now() >= request.deadline) return stale();
    }
    const expandedBeforeFocus = el.getAttribute('aria-expanded');
    el.focus();
    // Our own focus can expand the same combobox. Normalize only that exact
    // false→true transition; every other fingerprint field must still match.
    // Replaced or repurposed controls never inherit the authorized write.
    const expandedOnFocus = expandedBeforeFocus === 'false' && el.getAttribute('aria-expanded') === 'true' &&
      record.fingerprint === fingerprint(el, 'false');
    if (!el.isConnected || !taskVisible(el) || isDisabled(el) || el.matches(':disabled') ||
        (record.fingerprint !== fingerprint(el) && !expandedOnFocus) || !hitTarget(el) || Date.now() >= request.deadline) return stale();
    if (el.isContentEditable) el.textContent = request.text;
    else {
      const setter = nativeValueSetter(el);
      if (!setter) return { ok: false, code: 'unsupported' };
      setter.call(el, request.text);
    }
    // Like a real keystroke's input event, this one crosses shadow boundaries.
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: request.text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const value = el.isContentEditable ? el.textContent : el.value;
    return { ok: value === request.text, code: value === request.text ? undefined : 'write_unverified' };
  }

  window.__dial8Agent = {
    __v: 1,
    snapshot,
    click,
    type,
    getText,
    taskAction,
    frameGate,
    resolve: (ref) => !!resolve(ref),
  };
  // A child frame tells the app it exists; the handler lives in this isolated
  // world only, so page scripts cannot register or impersonate a frame.
  if (window !== window.top) {
    const register = () => { try { window.webkit.messageHandlers.dial8Frame.postMessage(1); } catch (_e) { /* handler absent */ } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', register, { once: true });
    else register();
    // A page restored from the back/forward cache never loads again, but the
    // app forgot its frames when the restored main document committed.
    window.addEventListener('pageshow', event => { if (event.persisted) register(); });
  }
})();
