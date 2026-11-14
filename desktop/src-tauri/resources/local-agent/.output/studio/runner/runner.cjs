var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// agents/local-agent/studio/stage/kit-script.ts
var kit_script_exports = {};
__export(kit_script_exports, {
  compileScript: () => compileScript,
  createDomDriver: () => createDomDriver,
  createPlayer: () => createPlayer,
  describeTargets: () => describeTargets,
  resolveTarget: () => resolveTarget
});
function typingTimes(text, cps) {
  const out = [];
  let t = 0;
  for (let i = 0; i < text.length; i++) {
    const jitter = 0.65 + (Math.sin(i * 12.9898) * 43758.5453 % 1 + 1) % 1 * 0.7;
    t += 1e3 / cps * jitter * (/[ ,.!?]/.test(text[i - 1] ?? "") ? 1.6 : 1);
    out.push(t);
  }
  return out;
}
function compileScript(steps) {
  const phases = [];
  let cursor = 0;
  const add = (p, length, at) => {
    const start = at !== void 0 ? at * 1e3 : cursor;
    phases.push({ ...p, start, end: start + length });
    cursor = start + length;
  };
  for (const s of steps) {
    const at = s.at, travel = s.duration !== void 0 && (s.move || s.hover) ? s.duration * 1e3 : TRAVEL;
    if (s.wait !== void 0) add({ step: s, kind: "wait" }, s.wait * 1e3, at);
    else if (s.move) add({ step: s, kind: "move", target: s.move }, travel, at);
    else if (s.hover) add({ step: s, kind: "hover", target: s.hover }, travel + (s.duration === void 0 ? 450 : 0), at);
    else if (s.click) add({ step: s, kind: "click", target: s.click }, TRAVEL + SETTLE + PRESS * 2 + 80, at);
    else if (s.type !== void 0) {
      if (s.into) add({ step: { click: s.into }, kind: "click", target: s.into }, TRAVEL + SETTLE + PRESS * 2 + 120, at);
      const chars = typingTimes(s.type, s.cps ?? 22);
      add({ step: s, kind: "type", chars }, (chars.at(-1) ?? 0) + 160, s.into ? void 0 : at);
    } else if (s.press) add({ step: s, kind: "press" }, 180, at);
    else if (s.scroll !== void 0) add({ step: s, kind: "scroll", target: s.in }, (s.duration ?? 0.7) * 1e3 + 120, at);
    else if (s.drag) add({ step: s, kind: "drag", target: s.drag }, TRAVEL + SETTLE + PRESS + (s.duration ?? 0.8) * 1e3 + PRESS + 120, at);
  }
  return { phases, end: phases.reduce((m, p) => Math.max(m, p.end), 0) };
}
function resolveTarget(target, root) {
  const [spec, nthPart] = target.split(/\s*>>\s*nth=/);
  const nth = Number(nthPart ?? 0) || 0;
  const s = spec.trim(), box = root.getBoundingClientRect();
  const point = /^@\s*([\d.]+)\s*,\s*([\d.]+)$/.exec(s);
  if (point) return { el: null, x: box.left + Number(point[1]) * box.width, y: box.top + Number(point[2]) * box.height };
  const all = (sel) => Array.from(document.querySelectorAll(sel)).filter(visible);
  let found = [];
  const eq = /^(text|placeholder|label|role)=(.*)$/.exec(s);
  if (eq) {
    const [, kind, raw] = eq;
    const value = raw.replace(/^["']|["']$/g, "").trim().toLowerCase();
    if (kind === "text") {
      const leaves = Array.from(document.body.querySelectorAll("*")).filter(
        (el2) => visible(el2) && (el2.textContent ?? "").toLowerCase().includes(value) && !Array.from(el2.children).some((c) => (c.textContent ?? "").toLowerCase().includes(value))
      );
      found = leaves.map(
        (el2) => el2.closest(CLICKABLE) && el2.closest(CLICKABLE).contains(el2) && (el2.closest(CLICKABLE).textContent ?? "").length < value.length + 80 ? el2.closest(CLICKABLE) : el2
      );
    } else if (kind === "placeholder") {
      found = all("input, textarea, [contenteditable], [data-placeholder], [aria-placeholder]").filter(
        (el2) => (el2.getAttribute("placeholder") ?? el2.getAttribute("data-placeholder") ?? el2.getAttribute("aria-placeholder") ?? "").toLowerCase().includes(value)
      );
      if (!found.length) {
        const hint = Array.from(document.body.querySelectorAll("*")).find(
          (el2) => visible(el2) && el2.children.length === 0 && (el2.textContent ?? "").toLowerCase().includes(value)
        );
        const editable = hint?.closest("[contenteditable], label, form") ?? hint?.parentElement?.querySelector("[contenteditable], textarea, input");
        if (editable) found = [editable];
      }
    } else if (kind === "label") {
      found = all("[aria-label], [title]").filter((el2) => (el2.getAttribute("aria-label") ?? el2.getAttribute("title") ?? "").toLowerCase().includes(value));
    } else {
      const m = /^([a-z]+)(?:\[name=(.*)\])?$/.exec(value);
      const role = m?.[1] ?? value, name = m?.[2]?.replace(/^["']|["']$/g, "");
      found = all(`[role=${role}]${IMPLICIT[role] ? ", " + IMPLICIT[role] : ""}`).filter(
        (el2) => !name || ((el2.getAttribute("aria-label") ?? "") + " " + (el2.textContent ?? "")).toLowerCase().includes(name)
      );
    }
  } else {
    try {
      found = all(s);
    } catch {
      found = [];
    }
  }
  found = [...found.filter((el2) => root.contains(el2)), ...found.filter((el2) => !root.contains(el2))];
  const el = found[nth] ?? null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const isText = el.matches("input, textarea, [contenteditable], [contenteditable] *");
  return { el, x: isText ? r.left + Math.min(r.width / 2, 48) : r.left + r.width / 2, y: r.top + r.height / 2 };
}
function cursorLayer() {
  let el = document.getElementById("kit-cursor");
  if (!el) {
    el = document.createElement("div");
    el.id = "kit-cursor";
    el.style.cssText = "position:fixed;left:0;top:0;width:26px;height:26px;pointer-events:none;z-index:2147483647;transform-origin:5px 3px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.28));opacity:0;will-change:transform";
    el.innerHTML = CURSOR_SVG;
    const ring = document.createElement("div");
    ring.id = "kit-cursor-ring";
    ring.style.cssText = "position:fixed;left:0;top:0;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;background:rgba(17,17,17,.16);pointer-events:none;z-index:2147483646;opacity:0";
    document.body.append(ring, el);
  }
  return { cursor: el, ring: document.getElementById("kit-cursor-ring") };
}
function createPlayer(steps, root, options = {}) {
  const { phases, end } = compileScript(steps), show = options.cursor !== false;
  const layer = show ? cursorLayer() : null;
  const box = root.getBoundingClientRect();
  let pos = { x: box.right - 40, y: box.bottom + 30 }, last = -1, pressedAt = -1e9, down = false, visibleFrom = Infinity;
  const firstMove = phases.find((p) => p.target && p.kind !== "scroll");
  if (firstMove) visibleFrom = firstMove.start - 150;
  const states = /* @__PURE__ */ new Map();
  const log = globalThis.__scriptLog ??= [];
  function travel(st, phase, t, length = TRAVEL) {
    if (!st.from) {
      st.from = { ...pos };
      st.to = phase.target ? resolveTarget(phase.target, root) : null;
      if (phase.target && !st.to) log.push(`not found: ${phase.target}`);
    }
    if (!st.to) return 1;
    const p = clamp01((t - phase.start) / length), e = ease(p);
    const dx = st.to.x - st.from.x, dy = st.to.y - st.from.y, bow = Math.sin(Math.PI * e) * Math.min(40, Math.hypot(dx, dy) * 0.08);
    pos = { x: st.from.x + dx * e - dy / (Math.hypot(dx, dy) || 1) * bow, y: st.from.y + dy * e + dx / (Math.hypot(dx, dy) || 1) * bow };
    return p;
  }
  function at(t) {
    const ops = [];
    for (const phase of phases) {
      if (phase.start > t || phase.end <= last) continue;
      const st = states.get(phase) ?? { typed: 0, pressed: false, released: false, stage: 0 };
      states.set(phase, st);
      const local = Math.min(t, phase.end);
      if (phase.kind === "move" || phase.kind === "hover") {
        travel(st, phase, local, phase.step.duration !== void 0 && phase.kind === "move" ? phase.step.duration * 1e3 : TRAVEL);
        ops.push({ kind: "move", ...pos });
      } else if (phase.kind === "click") {
        const p = travel(st, phase, local);
        ops.push({ kind: "move", ...pos });
        const pressT = phase.start + TRAVEL + SETTLE;
        if (p >= 1 && local >= pressT && !st.pressed) {
          st.pressed = true;
          down = true;
          pressedAt = pressT;
          ops.push({ kind: "down" });
        }
        if (st.pressed && local >= pressT + PRESS && !st.released) {
          st.released = true;
          down = false;
          ops.push({ kind: "up" });
        }
      } else if (phase.kind === "type") {
        const due = phase.chars.filter((c) => phase.start + c <= local).length;
        if (due > st.typed) {
          ops.push({ kind: "type", text: (phase.step.type ?? "").slice(st.typed, due) });
          st.typed = due;
        }
      } else if (phase.kind === "press") {
        if (!st.pressed) {
          st.pressed = true;
          ops.push({ kind: "key", key: phase.step.press });
        }
      } else if (phase.kind === "scroll") {
        if (st.scroller === void 0) {
          const hit = phase.target ? resolveTarget(phase.target, root)?.el : document.elementFromPoint(pos.x, pos.y);
          let el = hit ?? root;
          while (el && !(el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
          st.scroller = el ?? document.scrollingElement;
          st.scrollFrom = st.scroller?.scrollTop ?? 0;
        }
        const length = (phase.step.duration ?? 0.7) * 1e3, p = ease(clamp01((local - phase.start) / length));
        if (st.scroller) st.scroller.scrollTop = (st.scrollFrom ?? 0) + (phase.step.scroll ?? 0) * p;
      } else if (phase.kind === "drag") {
        const p = travel(st, phase, local);
        ops.push({ kind: "move", ...pos });
        const pressT = phase.start + TRAVEL + SETTLE, moveStart = pressT + PRESS, moveLength = (phase.step.duration ?? 0.8) * 1e3;
        if (p >= 1 && local >= pressT && !st.pressed) {
          st.pressed = true;
          down = true;
          pressedAt = pressT;
          ops.push({ kind: "down" });
        }
        if (st.pressed && local >= moveStart) {
          if (st.dropTo === void 0) {
            st.dropTo = phase.step.to ? resolveTarget(phase.step.to, root) : null;
            st.from = { ...pos };
            if (phase.step.to && !st.dropTo) log.push(`not found: ${phase.step.to}`);
          }
          if (st.dropTo) {
            const e = ease(clamp01((local - moveStart) / moveLength));
            pos = { x: st.from.x + (st.dropTo.x - st.from.x) * e, y: st.from.y + (st.dropTo.y - st.from.y) * e };
            ops.push({ kind: "move", ...pos });
          }
        }
        if (st.pressed && local >= moveStart + moveLength + PRESS && !st.released) {
          st.released = true;
          down = false;
          ops.push({ kind: "up" });
        }
      }
    }
    last = t;
    if (layer) {
      const shown = clamp01((t - visibleFrom) / 180), since = t - pressedAt;
      layer.cursor.style.opacity = String(shown);
      layer.cursor.style.transform = `translate(${pos.x - 5}px, ${pos.y - 3}px) scale(${down ? 0.86 : 1})`;
      const ring = clamp01(since / 380);
      layer.ring.style.opacity = since >= 0 && since < 380 ? String((1 - ring) * 0.9) : "0";
      layer.ring.style.transform = `translate(${pos.x}px, ${pos.y}px) scale(${0.3 + ring * 0.9})`;
    }
    return ops;
  }
  return {
    at,
    end,
    get position() {
      return pos;
    }
  };
}
function createDomDriver() {
  let over = null, buttons = 0, at = { x: 0, y: 0 };
  return (ops) => {
    for (const op of ops) {
      if (op.kind === "move") {
        at = op;
        const el = document.elementFromPoint(op.x, op.y) ?? document.body;
        if (el !== over) {
          if (over) {
            pointer("pointerout", op.x, op.y, over, buttons);
            pointer("mouseout", op.x, op.y, over, buttons);
          }
          pointer("pointerover", op.x, op.y, el, buttons);
          pointer("mouseover", op.x, op.y, el, buttons);
          over = el;
        }
        pointer("pointermove", op.x, op.y, el, buttons);
        pointer("mousemove", op.x, op.y, el, buttons);
      } else if (op.kind === "down") {
        const el = document.elementFromPoint(at.x, at.y) ?? document.body;
        buttons = 1;
        pointer("pointerdown", at.x, at.y, el, 1);
        pointer("mousedown", at.x, at.y, el, 1);
        const focusable = el.closest("input, textarea, select, button, a, [contenteditable], [tabindex]");
        focusable?.focus();
      } else if (op.kind === "up") {
        const el = document.elementFromPoint(at.x, at.y) ?? document.body;
        buttons = 0;
        pointer("pointerup", at.x, at.y, el, 0);
        pointer("mouseup", at.x, at.y, el, 0);
        el.click?.();
      } else if (op.kind === "type") {
        const el = document.activeElement;
        if (!el) continue;
        for (const ch of op.text) {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
          if ("value" in el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
            setter?.call(el, el.value + ch);
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
          } else if (el.isContentEditable) document.execCommand("insertText", false, ch);
          el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
        }
      } else if (op.kind === "key") {
        const el = document.activeElement ?? document.body;
        el.dispatchEvent(new KeyboardEvent("keydown", { key: op.key, code: op.key, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: op.key, code: op.key, bubbles: true }));
      }
    }
  };
}
function describeTargets(root) {
  const box = root.getBoundingClientRect();
  const inView = (r) => r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  const ours = (el) => !!el.closest("#kit-cursor, #kit-cursor-ring");
  const short = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  const hits = (target, el) => {
    const r = resolveTarget(target, root)?.el;
    return !!r && (r === el || el.contains(r) || r.contains(el));
  };
  const targetFor = (el, candidates) => {
    for (const c of candidates) if (hits(c, el)) return c;
    for (const c of candidates) for (let n = 1; n < 12; n++) if (hits(`${c} >> nth=${n}`, el)) return `${c} >> nth=${n}`;
    return null;
  };
  const targets = [], seen = /* @__PURE__ */ new Set();
  for (const el of Array.from(document.querySelectorAll(CLICKABLE))) {
    if (seen.has(el) || ours(el) || !visible(el) || !inView(el.getBoundingClientRect())) continue;
    if (Array.from(seen).some((s) => s.contains(el) && s.matches("button, a, [role=button], [role=tab], [role=menuitem], [role=option]"))) continue;
    const area = el.getBoundingClientRect();
    if (el.matches("[tabindex]:not(button, a, input, textarea, select, [role])") && area.width * area.height > box.width * box.height * 0.25) continue;
    seen.add(el);
    const label = short(el.getAttribute("aria-label") ?? el.getAttribute("title"));
    const placeholder = short(el.getAttribute("placeholder") ?? el.getAttribute("aria-placeholder") ?? el.getAttribute("data-placeholder"));
    const text = short(el.innerText).split(" ").slice(0, 8).join(" ").slice(0, 48);
    const role = el.getAttribute("role") ?? (el.matches("button") ? "button" : el.matches("a[href]") ? "link" : el.matches("input, textarea, [contenteditable]") ? "textbox" : el.tagName.toLowerCase());
    const candidates = [label && `label=${label}`, placeholder && `placeholder=${placeholder}`, text && `text=${text}`, `role=${role}`].filter(
      Boolean
    );
    const target = targetFor(el, candidates);
    if (!target) continue;
    const r = el.getBoundingClientRect();
    targets.push({
      target,
      kind: role,
      text: text || label || placeholder,
      at: [+((r.left + r.width / 2 - box.left) / box.width).toFixed(2), +((r.top + r.height / 2 - box.top) / box.height).toFixed(2)],
      ...el.disabled || el.getAttribute("aria-disabled") === "true" ? { disabled: true } : {}
    });
    if (targets.length >= 60) break;
  }
  const handles = (el) => {
    if (!el) return false;
    const key = Object.keys(el).find((k) => k.startsWith("__reactProps"));
    const p = key ? el[key] : null;
    return !!p && ["onClick", "onMouseDown", "onPointerDown", "onDoubleClick"].some((h) => typeof p[h] === "function") || getComputedStyle(el).cursor === "pointer";
  };
  for (const el of Array.from(root.querySelectorAll("div, li, tr, article, section, span"))) {
    if (targets.length >= 80) break;
    if (seen.has(el) || ours(el) || !visible(el) || !handles(el) || handles(el.parentElement)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 14 || rect.width * rect.height > box.width * box.height * 0.6) continue;
    if (Array.from(seen).some((s) => s.contains(el) && s.matches("button, a, [role=button], [role=tab], [role=menuitem], [role=option], [role=checkbox]")))
      continue;
    const leaves = Array.from(el.querySelectorAll("*")).filter((c) => visible(c) && c.children.length === 0 && short(c.textContent).length > 1).slice(0, 3);
    const target = targetFor(
      leaves[0] ?? el,
      leaves.map((c) => `text=${short(c.textContent).slice(0, 40)}`)
    );
    if (!target || targets.some((t) => t.target === target)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    targets.push({
      target,
      kind: el.getAttribute("role") ?? "clickable",
      text: short(el.innerText).slice(0, 60),
      at: [+((r.left + r.width / 2 - box.left) / box.width).toFixed(2), +((r.top + r.height / 2 - box.top) / box.height).toFixed(2)]
    });
  }
  targets.sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]);
  const texts = [];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (ours(el) || !visible(el) || !inView(el.getBoundingClientRect())) continue;
    const own = short(
      Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ")
    );
    if (own && own.length <= 90 && !texts.includes(own)) texts.push(own);
    if (texts.length >= 50) break;
  }
  const scrollAreas = [];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (!(el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) || !visible(el)) continue;
    const leaf = Array.from(el.querySelectorAll("*")).find((c) => visible(c) && c.children.length === 0 && short(c.textContent).length > 2);
    const target = leaf ? targetFor(leaf, [`text=${short(leaf.textContent).slice(0, 40)}`]) : null;
    if (target) scrollAreas.push({ in: target, scrollable: el.scrollHeight - el.clientHeight });
  }
  return { targets, texts, scrollAreas };
}
var TRAVEL, PRESS, SETTLE, CLICKABLE, visible, IMPLICIT, CURSOR_SVG, ease, clamp01, pointer;
var init_kit_script = __esm({
  "agents/local-agent/studio/stage/kit-script.ts"() {
    TRAVEL = 520;
    PRESS = 90;
    SETTLE = 70;
    CLICKABLE = 'button, a, input, textarea, select, label, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [contenteditable=""], [contenteditable=true], [tabindex]';
    visible = (el) => {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    IMPLICIT = {
      button: "button",
      link: "a[href]",
      textbox: 'input:not([type]), input[type=text], input[type=search], input[type=email], textarea, [contenteditable=true], [contenteditable=""]',
      checkbox: "input[type=checkbox]",
      tab: "[role=tab]",
      menuitem: "[role=menuitem]"
    };
    CURSOR_SVG = '<svg width="26" height="26" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg"><path d="M5 3.2v17.6l4.4-4.1 2.7 6.1 3.1-1.4-2.7-6h6.2L5 3.2z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    ease = (p) => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    clamp01 = (p) => Math.max(0, Math.min(1, p));
    pointer = (type, x, y, target, buttons) => {
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        buttons,
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true
      };
      target.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, init) : new MouseEvent(type, init));
    };
  }
});

// agents/local-agent/studio/runner.ts
var runner_exports = {};
__export(runner_exports, {
  findBrowser: () => findBrowser,
  main: () => main
});
module.exports = __toCommonJS(runner_exports);
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_node_util = require("node:util");

// agents/local-agent/studio/kit.ts
var SLUG = /^[a-z0-9][a-z0-9_-]{0,40}$/;
var STAGE_VERSION = 1;
function slugOf(name) {
  const slug = name.toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 41);
  return SLUG.test(slug) ? slug : "product";
}
function checkRelativePath(path) {
  if (typeof path !== "string") return null;
  const cleaned = path.trim().replace(/^\.\/+/, "");
  if (!cleaned || cleaned.length > 300) return null;
  if (cleaned.startsWith("/") || cleaned.startsWith("~") || cleaned.includes("\0") || cleaned.includes("\\")) return null;
  if (cleaned.split("/").some((part) => part === "..")) return null;
  return cleaned;
}
function dependencyNames(pkg) {
  const record = pkg && typeof pkg === "object" ? pkg : {};
  const names = /* @__PURE__ */ new Set();
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = record[field];
    if (deps && typeof deps === "object") for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}
function detectFramework(pkg) {
  const deps = dependencyNames(pkg);
  if (deps.has("next")) return "next";
  if ([...deps].some((name) => name.startsWith("@remix-run/") || name.startsWith("@react-router/"))) return "remix";
  if (deps.has("vite")) return "vite";
  return "react";
}
function parseLooseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1").replace(/,\s*([}\]])/g, "$1"));
  } catch {
    return null;
  }
}
function aliasesFromTsconfig(tsconfigText) {
  const parsed = parseLooseJson(tsconfigText);
  const options = parsed?.compilerOptions;
  const base = checkRelativePath(options?.baseUrl ?? ".") ?? "";
  const out = {};
  for (const [key, targets] of Object.entries(options?.paths ?? {})) {
    const target = Array.isArray(targets) ? targets[0] : void 0;
    if (!key.endsWith("/*") || typeof target !== "string" || !target.endsWith("/*")) continue;
    const joined = [base, target.slice(0, -2)].filter((part) => part && part !== ".").join("/");
    const path = joined === "" ? "." : checkRelativePath(joined);
    if (path) out[key.slice(0, -2)] = path;
  }
  return out;
}
function tailwindVersionOf(cssText) {
  if (/@import\s+['"]tailwindcss['"]/.test(cssText)) return 4;
  if (/@tailwind\s+base/.test(cssText)) return 3;
  return null;
}
function discoverFolders(entries) {
  const have = new Set(entries);
  const found = ["src/components", "components", "app/components", "src/ui"].filter((dir) => have.has(dir));
  return found.length ? found : have.has("src") ? ["src"] : ["."];
}
function detectProduct(facts, title) {
  const pkg = facts.packageJson && typeof facts.packageJson === "object" ? facts.packageJson : null;
  if (!pkg) return { ok: false, reason: "That folder has no package.json: choose the root of a web app." };
  const deps = dependencyNames(pkg);
  if (!deps.has("react")) return { ok: false, reason: "That product does not use React, so its components cannot be rendered here." };
  if (!facts.installed.react || !facts.installed.reactDom) return { ok: false, reason: "The product's packages are not installed: run npm install in that folder on the Mac first." };
  if (!facts.installed.esbuild) return { ok: false, reason: "The product has no esbuild installed: add it as a dev dependency (npm install -D esbuild) on the Mac, then onboard again." };
  const notes = [];
  const sheets = Object.entries(facts.stylesheets).sort(([a], [b]) => a.localeCompare(b));
  const tailwindSheet = sheets.find(([, text]) => tailwindVersionOf(text) !== null);
  const css = tailwindSheet?.[0] ?? sheets[0]?.[0] ?? null;
  const tailwind = tailwindSheet ? tailwindVersionOf(tailwindSheet[1]) : null;
  if (tailwind && !facts.installed.tailwindCli) notes.push("Tailwind's command line is not installed in the product, so its classes are not compiled: install @tailwindcss/cli (Tailwind 4) or tailwindcss (Tailwind 3).");
  if (!css) notes.push("No stylesheet was found in src/, app/ or styles/: components render without the product's styles.");
  const name = typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : "product";
  const kit = {
    slug: slugOf(name),
    title: (title ?? name).slice(0, 80),
    framework: detectFramework(pkg),
    alias: aliasesFromTsconfig(facts.tsconfigText),
    css,
    tailwind,
    discover: discoverFolders(facts.entries),
    components: {},
    ...facts.entries.includes("public") ? { public: "public" } : {}
  };
  if (kit.framework === "next") notes.push("Next.js links, images and navigation are stood in for, so server components and data fetching on the server do not render here.");
  return { ok: true, kit, notes };
}
var EXPORT_RE = /export\s+(?:default\s+)?(?:const\s+([A-Z]\w+)\s*(?::[^=]+)?=\s*(?:memo|forwardRef|React\.memo|React\.forwardRef)?\s*\(|function\s+([A-Z]\w+)\s*\()/g;
var DEFAULT_HIDE = "(Provider|Listener|Handler|Script|Watchdog|Mount|Subscriber|Boundary)$";
function componentId(rel, exportName) {
  return `${rel.replace(/\.tsx$/, "").replace(/[^a-zA-Z0-9]+/g, "-")}--${exportName}`;
}
function discoverExports(text, rel, hide = DEFAULT_HIDE) {
  if (/^\s*['"]use server['"]/.test(text)) return [];
  let hidden;
  try {
    hidden = new RegExp(hide);
  } catch {
    hidden = new RegExp(DEFAULT_HIDE);
  }
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(EXPORT_RE)) {
    const name = match[1] ?? match[2];
    if (!name || seen.has(name) || hidden.test(name)) continue;
    seen.add(name);
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
    out.push({ id: componentId(rel, name), name, group: dir.split("/").slice(-2).join("/"), help: "", curated: false, file: rel, width: 720, height: 420 });
  }
  return out;
}
function isComponentFile(name) {
  return /\.tsx$/.test(name) && !/\.(test|spec|stories)\.tsx$/.test(name);
}
function buildCatalog(kit, files) {
  const entries = [];
  for (const [id, c] of Object.entries(kit.components)) {
    entries.push({ id, name: c.export, group: c.group ?? "Featured", help: c.help, curated: true, file: c.fixture ?? c.file ?? "", width: c.width, height: c.height, ...c.props ? { props: c.props } : {} });
  }
  const seen = new Set(entries.map((e) => `${e.file}#${e.name}`));
  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    for (const entry of discoverExports(f.text, f.rel, kit.hide)) {
      if (seen.has(`${entry.file}#${entry.name}`)) continue;
      seen.add(`${entry.file}#${entry.name}`);
      entries.push(entry);
    }
  }
  return entries;
}
function chunkInputs(metafile, chunk) {
  const inputs = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const output = metafile.outputs[name];
    if (!output) return;
    for (const input of Object.keys(output.inputs ?? {})) inputs.add(input);
    for (const imported of output.imports ?? []) if (imported.kind === "import-statement") visit(imported.path);
  };
  visit(chunk);
  return [...inputs].sort();
}
function componentKey(parts, hash) {
  const lines = [`stage ${STAGE_VERSION}`, `settings ${JSON.stringify(parts.settings)}`, `css ${parts.css ?? ""}`];
  for (const input of [...parts.inputs].sort((a, b) => a.path.localeCompare(b.path))) lines.push(`${input.path} ${input.sha256}`);
  return hash(lines.join("\n")).slice(0, 32);
}
function commitFromGit(files) {
  const head = files.head?.trim() ?? "";
  if (/^[0-9a-f]{40}$/.test(head)) return head;
  const name = /^ref:\s*(refs\/[\w./-]+)$/.exec(head)?.[1];
  if (!name || name.includes("..")) return null;
  const direct = files.ref(name)?.trim() ?? "";
  if (/^[0-9a-f]{40}$/.test(direct)) return direct;
  for (const line of (files.packedRefs ?? "").split("\n")) {
    const [sha, ref] = line.trim().split(" ");
    if (ref === name && sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
}
function isPackagePath(path) {
  return path.includes("node_modules/") || path.startsWith("kit-stub:");
}

// agents/local-agent/studio/runner.ts
var run = (0, import_node_util.promisify)(import_node_child_process.execFile);
var STAGE_ORIGIN = "http://stage.localhost";
var SAMPLE_NOW = Date.parse("2026-10-20T15:30:00Z");
var HEALTH_MAX = 60;
var sha256 = (data) => (0, import_node_crypto.createHash)("sha256").update(data).digest("hex");
function runnerDir() {
  return (0, import_node_path.dirname)((0, import_node_fs.realpathSync)(process.argv[1] ?? "."));
}
async function readText(path, max = 512 * 1024) {
  try {
    const info = await (0, import_promises.stat)(path);
    if (!info.isFile() || info.size > max) return null;
    return await (0, import_promises.readFile)(path, "utf8");
  } catch {
    return null;
  }
}
async function findStylesheets(root, base, out, depth = 0) {
  if (depth > 5 || Object.keys(out).length >= 40) return;
  for (const entry of await (0, import_promises.readdir)(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = (0, import_node_path.join)(root, entry.name);
    if (entry.isDirectory()) await findStylesheets(path, base, out, depth + 1);
    else if (entry.name.endsWith(".css")) {
      const text = await readText(path, 200 * 1024);
      if (text !== null) out[(0, import_node_path.relative)(base, path)] = text;
    }
  }
}
async function readFacts(folder) {
  const probe = ["src", "src/components", "components", "app", "app/components", "src/ui", "public", "styles", "tailwind.config.ts", "tailwind.config.js"];
  const stylesheets = {};
  for (const dir of ["src", "app", "styles"]) if ((0, import_node_fs.existsSync)((0, import_node_path.join)(folder, dir))) await findStylesheets((0, import_node_path.join)(folder, dir), folder, stylesheets);
  const nm = (0, import_node_path.join)(folder, "node_modules");
  const packageText = await readText((0, import_node_path.join)(folder, "package.json"));
  let packageJson = null;
  try {
    packageJson = packageText ? JSON.parse(packageText) : null;
  } catch {
    packageJson = null;
  }
  return {
    packageJson,
    tsconfigText: await readText((0, import_node_path.join)(folder, "tsconfig.json")),
    entries: probe.filter((p) => (0, import_node_fs.existsSync)((0, import_node_path.join)(folder, p))),
    stylesheets,
    installed: {
      react: (0, import_node_fs.existsSync)((0, import_node_path.join)(nm, "react/package.json")),
      reactDom: (0, import_node_fs.existsSync)((0, import_node_path.join)(nm, "react-dom/package.json")),
      esbuild: (0, import_node_fs.existsSync)((0, import_node_path.join)(nm, "esbuild/package.json")),
      tailwindCli: (0, import_node_fs.existsSync)((0, import_node_path.join)(nm, ".bin/tailwindcss"))
    }
  };
}
async function readCommit(folder) {
  const git = (0, import_node_path.join)(folder, ".git");
  const refs = /* @__PURE__ */ new Map();
  const head = await readText((0, import_node_path.join)(git, "HEAD"));
  const name = /^ref:\s*(refs\/[\w./-]+)$/.exec(head?.trim() ?? "")?.[1];
  if (name && !name.includes("..")) refs.set(name, await readText((0, import_node_path.join)(git, name)));
  return commitFromGit({ head, ref: (ref) => refs.get(ref) ?? null, packedRefs: await readText((0, import_node_path.join)(git, "packed-refs"), 4 * 1024 * 1024) });
}
async function componentFiles(folder, kit) {
  const out = [];
  const walk = async (dir, depth) => {
    if (depth > 8 || out.length >= 2e3) return;
    for (const entry of await (0, import_promises.readdir)(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "test") continue;
      const path = (0, import_node_path.join)(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (isComponentFile(entry.name)) {
        const text = await readText(path);
        if (text !== null) out.push({ rel: (0, import_node_path.relative)(folder, path), text });
      }
    }
  };
  for (const dir of kit.discover) {
    const rel = dir === "." ? "." : checkRelativePath(dir);
    if (rel) await walk((0, import_node_path.resolve)(folder, rel), 0);
  }
  return out;
}
function inFolder(folder, rel, what) {
  const checked = checkRelativePath(rel.split("#")[0]);
  const path = checked ? (0, import_node_path.resolve)(folder, checked) : null;
  if (!path || !(path === folder || path.startsWith(folder + import_node_path.sep))) throw new Error(`${what} must be a path inside the product's folder`);
  return path;
}
async function productEsbuild() {
  try {
    return require("esbuild");
  } catch {
    throw new Error("The product has no esbuild installed: add it as a dev dependency (npm install -D esbuild) on the Mac.");
  }
}
async function buildStage(folder, kit, stageDir, log) {
  const nm = (0, import_node_path.join)(folder, "node_modules");
  const own = (0, import_node_path.join)(runnerDir(), "stage");
  const entries = buildCatalog(kit, await componentFiles(folder, kit));
  const work = (0, import_node_path.join)(stageDir, "build");
  await (0, import_promises.rm)(stageDir, { recursive: true, force: true });
  await (0, import_promises.mkdir)((0, import_node_path.join)(work, "out"), { recursive: true });
  const source = (e) => inFolder(folder, e.file, `${e.name}'s file`);
  const aliasKeys = Object.keys(kit.alias);
  const importPath = (from) => aliasKeys.some((a) => from === a || from.startsWith(`${a}/`)) ? from : inFolder(folder, from, "A provider");
  const providers = kit.providers ?? [];
  const registry = (0, import_node_path.join)(work, "stage.tsx");
  const lines = [
    `import { mountStage } from ${JSON.stringify((0, import_node_path.join)(own, "stage-runtime.tsx"))}`,
    "mountStage({",
    "  loaders: {",
    ...entries.map((e) => `    ${JSON.stringify(e.id)}: { export: ${JSON.stringify(e.name)}, load: () => import(${JSON.stringify(source(e))}) },`),
    "  },",
    "  providers: [",
    ...providers.map((p) => `    { name: ${JSON.stringify(p.export)}, export: ${JSON.stringify(p.export)}, load: () => import(${JSON.stringify(importPath(p.from))}), props: ${JSON.stringify(p.props ?? {})} },`),
    "  ],",
    `  rootClass: ${JSON.stringify(kit.rootClass ?? "")}, previewClass: ${JSON.stringify(kit.previewClass ?? "")}, htmlAttributes: ${JSON.stringify(kit.htmlAttributes ?? {})},`,
    "})"
  ];
  await (0, import_promises.writeFile)(registry, lines.join("\n") + "\n");
  const { build } = await productEsbuild();
  const soften = {
    name: "soften",
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === "soft" || args.kind === "entry-point" || args.importer.includes(`${import_node_path.sep}node_modules${import_node_path.sep}`)) return void 0;
        const r = await b.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: "soft" });
        return r.errors.length ? { path: args.path, namespace: "kit-stub" } : r;
      });
      b.onLoad({ filter: /.*/, namespace: "kit-stub" }, () => ({
        contents: 'const stub = new Proxy(function(){}, { get: (t, k) => k === "__esModule" ? true : stub, apply: () => stub }); export default stub;',
        loader: "js"
      }));
    }
  };
  log("Building the stage");
  const result = await build({
    entryPoints: [registry],
    absWorkingDir: folder,
    bundle: true,
    splitting: true,
    format: "esm",
    outdir: (0, import_node_path.join)(work, "out"),
    jsx: "automatic",
    platform: "browser",
    logLevel: "silent",
    metafile: true,
    nodePaths: [nm],
    plugins: [soften],
    alias: {
      react: (0, import_node_path.join)(nm, "react"),
      "react-dom": (0, import_node_path.join)(nm, "react-dom"),
      ...Object.fromEntries(Object.entries(kit.alias).map(([k, v]) => [k, (0, import_node_path.resolve)(folder, v)])),
      "next/navigation": (0, import_node_path.join)(own, "shims/next-navigation.ts"),
      "next/link": (0, import_node_path.join)(own, "shims/next-link.tsx"),
      "next/image": (0, import_node_path.join)(own, "shims/next-image.tsx"),
      "next/dynamic": (0, import_node_path.join)(own, "shims/next-dynamic.tsx")
    },
    // Environment the product reads: its backend URLs point at the stage itself (the stand-in backend answers them).
    banner: {
      js: "globalThis.process = globalThis.process || { env: new Proxy({ NODE_ENV: 'production' }, { get: (t, k) => k in t ? t[k] : (/(URL|HOST|ORIGIN|ENDPOINT)$/.test(String(k)) ? location.origin : 'kit-stage') }) };"
    },
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl", ".woff2": "dataurl", ".woff": "dataurl" }
  });
  await buildStyles(folder, kit, work, log);
  await (0, import_promises.writeFile)(
    (0, import_node_path.join)(work, "out", "stage.html"),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="stage.css"></head><body><div id="root"></div><script type="module" src="stage.js"></script></body></html>'
  );
  await (0, import_promises.writeFile)((0, import_node_path.join)(work, "out", "backend.json"), JSON.stringify({ now: SAMPLE_NOW, routes: [] }));
  await (0, import_promises.writeFile)((0, import_node_path.join)(work, "out", "selects.json"), "{}");
  const keys = await stageKeys(folder, kit, entries, result.metafile);
  const dir = (0, import_node_path.join)(stageDir, "stage");
  await (0, import_promises.rm)(dir, { recursive: true, force: true });
  await (0, import_promises.rename)((0, import_node_path.join)(work, "out"), dir);
  return { dir, entries, keys, commit: await readCommit(folder) };
}
async function buildStyles(folder, kit, work, log) {
  const out = (0, import_node_path.join)(work, "out", "stage.css");
  const tail = "\nhtml,body{background:transparent!important;margin:0}\n";
  const css = kit.css ? inFolder(folder, kit.css, "The stylesheet") : null;
  const bin = (0, import_node_path.join)(folder, "node_modules/.bin/tailwindcss");
  if (!css) return (0, import_promises.writeFile)(out, tail);
  if (!kit.tailwind || !(0, import_node_fs.existsSync)(bin)) return (0, import_promises.writeFile)(out, (await readText(css) ?? "") + tail);
  log(`Compiling the styles (Tailwind ${kit.tailwind})`);
  const cli = (0, import_node_fs.realpathSync)(bin);
  if (kit.tailwind === 3) {
    const config = ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs"].map((f) => (0, import_node_path.join)(folder, f)).find((f) => (0, import_node_fs.existsSync)(f));
    await run(process.execPath, [cli, "-i", css, ...config ? ["-c", config] : [], "-o", out], { cwd: folder, maxBuffer: 64 * 1024 * 1024, timeout: 3e5 });
  } else {
    const sources = ["src", "app", "components", "pages", "lib"].filter((d) => (0, import_node_fs.existsSync)((0, import_node_path.join)(folder, d))).map((d) => `@source ${JSON.stringify((0, import_node_path.join)(folder, d))};`).join("\n");
    const input = (0, import_node_path.join)(work, "stage.input.css");
    await (0, import_promises.writeFile)(input, `@import ${JSON.stringify(css)};
${sources}
`);
    await run(process.execPath, [cli, "-i", input, "-o", out], { cwd: folder, maxBuffer: 64 * 1024 * 1024, timeout: 3e5 });
  }
  await (0, import_promises.writeFile)(out, (await readText(out, 64 * 1024 * 1024) ?? "") + tail);
}
async function stageKeys(folder, kit, entries, metafile) {
  const byEntry = /* @__PURE__ */ new Map();
  for (const [name, output] of Object.entries(metafile.outputs)) if (output.entryPoint) byEntry.set(output.entryPoint, name);
  const shaOf = /* @__PURE__ */ new Map();
  const contentSha = async (rel) => {
    if (!shaOf.has(rel)) shaOf.set(rel, sha256(new Uint8Array(await (0, import_promises.readFile)((0, import_node_path.join)(folder, rel)).catch(() => new Uint8Array()))));
    return shaOf.get(rel);
  };
  const cssSha = kit.css ? sha256(await readText((0, import_node_path.join)(folder, kit.css), 4 * 1024 * 1024) ?? "") : null;
  const settings = { alias: kit.alias, tailwind: kit.tailwind, providers: kit.providers ?? [], rootClass: kit.rootClass ?? "", htmlAttributes: kit.htmlAttributes ?? {} };
  const keys = {};
  for (const entry of entries) {
    const chunk = byEntry.get(entry.file.split("#")[0]);
    const inputs = chunk ? chunkInputs(metafile, chunk) : [entry.file.split("#")[0]];
    const own = inputs.filter((p) => !isPackagePath(p) && !p.startsWith("..") && !p.startsWith("/"));
    const hashed = await Promise.all(own.map(async (path) => ({ path, sha256: await contentSha(path) })));
    keys[entry.id] = componentKey({ inputs: hashed, settings: { ...settings, component: kit.components[entry.id] ?? null }, css: cssSha }, sha256);
  }
  return keys;
}
function findBrowser(folder, env = process.env, exists = import_node_fs.existsSync) {
  if (env.STUDIO_BROWSER && exists(env.STUDIO_BROWSER)) return env.STUDIO_BROWSER;
  const shell = (dir) => {
    let names = [];
    try {
      names = (0, import_node_fs.readdirSync)(dir).filter((n) => n.startsWith("chromium_headless_shell-")).sort().reverse();
    } catch {
      return null;
    }
    for (const name of names) {
      for (const arch of ["mac-arm64", "mac-x64"]) {
        const path = (0, import_node_path.join)(dir, name, `chrome-headless-shell-${arch}`, "chrome-headless-shell");
        if (exists(path)) return path;
      }
    }
    return null;
  };
  const candidates = [
    (0, import_node_path.join)(folder, "node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    shell((0, import_node_path.join)(folder, "node_modules/playwright-core/.local-browsers")),
    shell((0, import_node_path.join)((0, import_node_os.homedir)(), "Library/Caches/ms-playwright"))
  ];
  return candidates.find((p) => !!p && exists(p)) ?? null;
}
async function launch(folder) {
  const path = findBrowser(folder);
  if (!path) throw new Error("No headless browser is readable here. The desktop app provides one for captures (STUDIO_BROWSER); until it does, run npx playwright install chromium-headless-shell on the Mac with PLAYWRIGHT_BROWSERS_PATH=0 in the product folder.");
  const { chromium } = await import("playwright-core");
  return chromium.launch({ executablePath: path, args: ["--disable-gpu", "--no-first-run", "--no-default-browser-check"] });
}
var TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf"
};
async function serveStage(page, stageDir, publicDir) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== STAGE_ORIGIN) return route.abort("blockedbyclient");
    const path = decodeURIComponent(url.pathname);
    const [root, rel] = path.startsWith("/__stage/") ? [stageDir, path.slice(9)] : [publicDir, path.slice(1)];
    const file = root ? (0, import_node_path.resolve)(root, rel) : null;
    if (file && root && file.startsWith(root + import_node_path.sep) && (0, import_node_fs.existsSync)(file) && (await (0, import_promises.stat)(file)).isFile()) {
      return route.fulfill({ status: 200, headers: { "content-type": TYPES[file.split(".").pop().toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" }, body: await (0, import_promises.readFile)(file) });
    }
    return route.fulfill({ status: path.startsWith("/api/") ? 204 : 404, body: "" });
  });
}
var stageUrl = (job) => `${STAGE_ORIGIN}/__stage/stage.html#${encodeURIComponent(JSON.stringify(job))}`;
async function settle(page, advance, limitMs = 6e3) {
  let last = -1;
  let quiet = 0;
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const s = await page.evaluate(() => {
      const w = window;
      return { done: w.__mounted === true || String(w.__status ?? "").startsWith("error"), pending: w.__pending ?? 0, changes: w.__changes ?? 0, loading: !!w.__loading?.() };
    });
    if (!s.done) {
      await advance(50);
      quiet = 0;
      continue;
    }
    if (s.pending > 0) {
      await page.waitForTimeout(30);
      quiet = 0;
      continue;
    }
    if (s.loading && s.changes === last) await advance(100);
    quiet = s.changes === last && !s.loading ? quiet + 1 : 0;
    last = s.changes;
    if (quiet >= 4) return;
    await page.waitForTimeout(s.loading ? 150 : 120);
  }
}
async function checkHealth(browser, stage, publicDir) {
  const results = {};
  const queue = stage.entries.slice(0, HEALTH_MAX);
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      const page = await browser.newPage({ viewport: { width: 1300, height: 1e3 } });
      await serveStage(page, stage.dir, publicDir);
      for (let e = queue.shift(); e; e = queue.shift()) {
        const job = { component: e.id, props: e.props ?? {}, width: e.width, height: e.curated ? e.height : 0, pad: 0 };
        try {
          await page.goto(stageUrl(job), { timeout: 1e4 });
          await page.waitForFunction(() => window.__mounted || String(window.__status ?? "").startsWith("error"), null, { timeout: 5e3 }).catch(() => {
          });
          await settle(page, (ms) => page.waitForTimeout(ms), 6e3);
          results[e.id] = await page.evaluate(() => {
            const status = String(window.__status ?? "blank");
            const cap = document.getElementById("cap");
            const origin = cap.getBoundingClientRect();
            let area = 0;
            let right = 0;
            let bottom = 0;
            for (const el of Array.from(cap.querySelectorAll("#fit *"))) {
              const b = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              if (b.width < 2 || b.height < 2 || cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
              right = Math.max(right, b.right - origin.left);
              bottom = Math.max(bottom, b.bottom - origin.top);
              if (el.children.length === 0 || el.innerText?.trim()) area += Math.min(b.width * b.height, 2e5);
            }
            return { status: status !== "ok" ? status : area > 400 ? "ok" : "blank", w: Math.ceil(right), h: Math.ceil(bottom) };
          });
        } catch (x) {
          results[e.id] = { status: "error: " + x.message.split("\n")[0].slice(0, 160) };
        }
      }
      await page.close();
    })
  );
  return results;
}
async function list(folder, kit, out, log) {
  const stage = await buildStage(folder, kit, (0, import_node_path.join)(out, "stage"), log);
  let health = {};
  let browserNote = null;
  try {
    const browser = await launch(folder);
    try {
      health = await checkHealth(browser, stage, kit.public ? inFolder(folder, kit.public, "The public folder") : null);
    } finally {
      await browser.close();
    }
  } catch (error) {
    browserNote = `Not checked in a browser: ${error.message.split("\n")[0]}`;
  }
  const components = stage.entries.map((e) => {
    const h = health[e.id];
    const sized = !e.curated && h?.status === "ok" && (h.h ?? 0) >= 24;
    return {
      id: e.id,
      name: e.name,
      file: e.file,
      group: e.group,
      help: e.help,
      curated: e.curated,
      width: sized ? Math.round(Math.min(1200, Math.max(240, h.w))) : e.width,
      height: sized ? Math.round(Math.min(900, Math.max(40, h.h))) : e.height,
      status: h?.status ?? "unchecked",
      key: stage.keys[e.id]
    };
  });
  return { ok: true, components, commit: stage.commit, ...browserNote ? { note: browserNote } : {} };
}
async function capture(folder, kit, id, options, out, log) {
  const stage = await buildStage(folder, kit, (0, import_node_path.join)(out, "stage"), log);
  const entry = stage.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`${kit.title} has no component "${id}"`);
  const { compileScript: compileScript2 } = await Promise.resolve().then(() => (init_kit_script(), kit_script_exports));
  const script = options.script ?? [];
  const scriptEnd = script.length ? compileScript2(script).end / 1e3 + 0.8 : 0;
  const fps = options.fps ?? 60;
  const seconds = Math.min(60, Math.max(0.5, options.seconds ?? 6, scriptEnd));
  const scale = options.scale ?? 2;
  const pad = 32;
  const width = options.width ?? entry.width;
  const height = options.height ?? entry.height;
  const solid = typeof options.background === "string" && /^#[0-9a-fA-F]{6}$/.test(options.background) ? options.background : null;
  const ffmpeg = options.still ? null : await findFfmpeg();
  const still = options.still || !ffmpeg;
  const frames = still ? 1 : Math.round(seconds * fps);
  const job = {
    component: id,
    props: { ...entry.props ?? {}, ...options.props ?? {} },
    width,
    height,
    theme: options.theme ?? "light",
    pad,
    ...script.length ? { script, cursor: options.cursor !== false, drive: "capture" } : {}
  };
  await (0, import_promises.mkdir)((0, import_node_path.join)(out, "frames"), { recursive: true });
  log(`Rendering ${entry.name}${still ? " (a still)" : " frame by frame"}`);
  const browser = await launch(folder);
  try {
    const page = await browser.newPage({ viewport: { width: width + pad * 2, height: height + pad * 2 }, deviceScaleFactor: scale });
    await serveStage(page, stage.dir, kit.public ? inFolder(folder, kit.public, "The public folder") : null);
    await page.clock.install({ time: new Date(SAMPLE_NOW - 1e3) });
    await page.clock.pauseAt(new Date(SAMPLE_NOW));
    await page.goto(stageUrl(job), { waitUntil: "load" });
    await settle(page, async (ms) => {
      await page.clock.runFor(ms);
      await page.waitForTimeout(20);
    }, 8e3);
    const status = await page.evaluate(() => window.__status);
    if (status?.startsWith("error")) throw new Error(`${entry.name} can't render outside the product: ${status.slice(7)}`);
    if (solid) await page.evaluate((color) => {
      document.body.style.background = color;
    }, solid);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      const w = window;
      w.__virtual = 0;
      w.__born = /* @__PURE__ */ new WeakMap();
      w.__syncAnimations = () => {
        for (const a of document.getAnimations()) {
          if (!w.__born.has(a)) w.__born.set(a, w.__virtual);
          a.pause();
          a.currentTime = w.__virtual - w.__born.get(a);
        }
      };
    });
    const advance = async (ms) => {
      await page.clock.runFor(ms);
      await page.evaluate((step) => {
        const w = window;
        w.__virtual += step;
        w.__syncAnimations();
      }, ms);
    };
    await advance(50);
    if (still && options.seconds && options.still) await advance(Math.min(6e4, options.seconds * 1e3));
    const box = await page.evaluate(() => {
      const r = document.getElementById("cap").getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const perform = async (ops) => {
      for (const op of ops) {
        if (op.kind === "move") await page.mouse.move(op.x, op.y);
        else if (op.kind === "down") await page.mouse.down();
        else if (op.kind === "up") await page.mouse.up();
        else if (op.kind === "type") await page.keyboard.type(op.text);
        else await page.keyboard.press(op.key);
      }
      if (ops.length) await page.evaluate(() => new Promise((done) => {
        const c = new MessageChannel();
        c.port1.onmessage = () => done(null);
        c.port2.postMessage(0);
      }));
    };
    for (let i = 0; i < frames; i++) {
      if (script.length && !still) await perform(await page.evaluate((t) => window.__scriptAt?.(t) ?? [], i * 1e3 / fps));
      await page.screenshot({ path: (0, import_node_path.join)(out, "frames", `${String(i).padStart(5, "0")}.png`), omitBackground: !solid, animations: "allow", clip: box, timeout: 15e3 });
      if (!still) await advance(1e3 / fps);
      if (i % 60 === 0 && i) log(`${Math.round(i / frames * 100)}%`);
    }
  } finally {
    await browser.close();
  }
  const base = `${kit.slug}-${id.slice(0, 60)}`;
  const poster = (0, import_node_path.join)(out, `${base}-poster.png`);
  await (0, import_promises.copyFile)((0, import_node_path.join)(out, "frames", "00000.png"), poster);
  let file = poster;
  if (!still && ffmpeg) {
    log("Encoding the footage");
    file = (0, import_node_path.join)(out, `${base}.webm`);
    const args = ["-nostdin", "-y", "-v", "error", "-framerate", String(fps), "-i", (0, import_node_path.join)(out, "frames", "%05d.png"), "-c:v", "libvpx-vp9", "-pix_fmt", solid ? "yuv420p" : "yuva420p", "-b:v", "0", "-crf", "18", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", file];
    await run(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024, timeout: 9e5 });
  }
  await (0, import_promises.rm)((0, import_node_path.join)(out, "frames"), { recursive: true, force: true });
  const fullWidth = width + pad * 2;
  const fullHeight = height + pad * 2;
  return {
    ok: true,
    kind: file === poster ? "still" : "video",
    file,
    poster,
    name: `${kit.title} \xB7 ${entry.name}${file === poster ? ".png" : ".webm"}`,
    width: fullWidth,
    height: fullHeight,
    aspect: +(fullWidth / fullHeight).toFixed(4),
    seconds: file === poster ? 0 : seconds,
    key: stage.keys[id],
    commit: stage.commit,
    ...!options.still && !ffmpeg ? { note: "ffmpeg is not on this Mac, so this is a still. Install ffmpeg (brew install ffmpeg) for footage." } : {}
  };
}
async function findFfmpeg() {
  const dirs = [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs) {
    const path = (0, import_node_path.join)(dir, "ffmpeg");
    if (dir && (0, import_node_fs.existsSync)(path)) return path;
  }
  return null;
}
async function main(argv, folder = process.cwd()) {
  const [command, a, b] = argv;
  const out = (0, import_node_path.resolve)(command === "onboard" ? a ?? "." : b ?? ".");
  const log = (line) => process.stderr.write(`${line}
`);
  let answer;
  try {
    await (0, import_promises.mkdir)(out, { recursive: true });
    if (command === "onboard") {
      const detected = detectProduct(await readFacts(folder));
      answer = detected.ok ? { ...detected, commit: await readCommit(folder) } : { ok: false, error: detected.reason };
    } else if (command === "list" || command === "capture") {
      const request = JSON.parse(await (0, import_promises.readFile)((0, import_node_path.resolve)(a ?? ""), "utf8"));
      if (!request.kit || typeof request.kit !== "object") throw new Error("The request has no product settings");
      answer = command === "list" ? await list(folder, request.kit, out, log) : await capture(folder, request.kit, String(request.component ?? ""), request.options ?? {}, out, log);
    } else {
      answer = { ok: false, error: "Usage: runner.cjs onboard <out> | list <request.json> <out> | capture <request.json> <out>" };
    }
  } catch (error) {
    answer = { ok: false, error: error instanceof Error ? error.message.split("\n")[0].slice(0, 500) : String(error) };
  }
  const text = JSON.stringify(answer);
  await (0, import_promises.writeFile)((0, import_node_path.join)(out, "result.json"), text).catch(() => {
  });
  process.stdout.write(text + "\n");
  return answer.ok ? 0 : 1;
}
if (process.argv[1] && /runner\.(cjs|ts)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  findBrowser,
  main
});
