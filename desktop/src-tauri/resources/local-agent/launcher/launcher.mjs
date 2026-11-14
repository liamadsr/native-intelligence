import { createRequire as __niRequire } from 'node:module'; const require = __niRequire(import.meta.url);

// agents/local-agent/launcher/launcher.ts
import { execFileSync, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { randomBytes as randomBytes2 } from "node:crypto";
import { constants as fsConstants, existsSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// node_modules/eve/dist/src/compiled/_chunks/client/rolldown-runtime-DK3Fl9T5.js
var e = Object.defineProperty;
var t = (t4, n3) => {
  let r2 = {};
  for (var i3 in t4) e(r2, i3, { get: t4[i3], enumerable: true });
  return n3 || e(r2, Symbol.toStringTag, { value: `Module` }), r2;
};

// node_modules/eve/dist/src/compiled/_chunks/client/core-CspsxXR-.js
var t2 = t({ BIGINT_FORMAT_RANGES: () => ve, CONSTANT_CATCH: () => Ze, Class: () => Ve, NUMBER_FORMAT_RANGES: () => _e, aborted: () => w, allowsEval: () => le, assert: () => s, assertEqual: () => n, assertIs: () => a, assertNever: () => o, assertNotEqual: () => r, assignProp: () => g, attachSchema: () => Oe, base64ToUint8Array: () => Fe, base64urlToUint8Array: () => Le, cached: () => d, captureStackTrace: () => se, cleanEnum: () => Pe, cleanRegex: () => p, clone: () => x, cloneDef: () => ne, codePointLength: () => je, constantCatch: () => Qe, createTransparentProxy: () => he, defineLazy: () => h, defineLazyInternal: () => O, esc: () => v, escapeRegex: () => b, explicitlyAborted: () => Ee, extend: () => xe, finalizeIssue: () => E, floatSafeRemainder: () => m, getElementAtPath: () => re, getEnumValues: () => c, getLengthableOrigin: () => Me, getParsedType: () => fe, getSizableOrigin: () => ke, hexToUint8Array: () => ze, hide: () => We, installLazyProp: () => Xe, isObject: () => ce, isPlainObject: () => y, issue: () => Ne, joinValues: () => l, jsonStringifyReplacer: () => u, members: () => He, merge: () => Ce, mergeDefs: () => _, normalizeParams: () => S, nullish: () => f, numKeys: () => de, objectClone: () => te, omit: () => be, optionalKeys: () => ge, own: () => Ue, parsedType: () => D, partial: () => we, pick: () => ye, prefixIssues: () => T, primitiveTypes: () => me, promiseAllObject: () => ie, propertyKeyTypes: () => pe, randomString: () => ae, required: () => Te, safeExtend: () => Se, shallowClone: () => ue, slugify: () => oe, stringifyPrimitive: () => C, toZod: () => i, uint8ArrayToBase64: () => Ie, uint8ArrayToBase64url: () => Re, uint8ArrayToHex: () => Be, unwrapMessage: () => De });
function n(e9) {
  return e9;
}
function r(e9) {
  return e9;
}
function i() {
  return (e9) => e9;
}
function a(e9) {
}
function o(e9) {
  throw Error(`Unexpected value in exhaustive check`);
}
function s(e9) {
}
function c(e9) {
  let t4 = Object.values(e9).filter((e10) => typeof e10 == `number`);
  return Object.entries(e9).filter(([e10, n3]) => t4.indexOf(+e10) === -1).map(([e10, t5]) => t5);
}
function l(e9, t4 = `|`) {
  return e9.map((e10) => C(e10)).join(t4);
}
function u(e9, t4) {
  return typeof t4 == `bigint` ? t4.toString() : t4;
}
function d(e9) {
  return { get value() {
    {
      let t4 = e9();
      return Object.defineProperty(this, "value", { value: t4 }), t4;
    }
  } };
}
function f(e9) {
  return e9 == null;
}
function p(e9) {
  let t4 = +!!e9.startsWith(`^`), n3 = e9.endsWith(`$`) ? e9.length - 1 : e9.length;
  return e9.slice(t4, n3);
}
function m(e9, t4) {
  let n3 = e9 / t4, r2 = Math.round(n3), i3 = 4 * 2 ** -52 * Math.max(Math.abs(n3), 1);
  return Math.abs(n3 - r2) < i3 ? 0 : n3 - r2;
}
var ee = /* @__PURE__ */ Symbol(`evaluating`);
function h(e9, t4, n3) {
  let r2;
  Object.defineProperty(e9, t4, { get() {
    if (r2 !== ee) return r2 === void 0 && (r2 = ee, r2 = n3()), r2;
  }, set(n4) {
    Object.defineProperty(e9, t4, { value: n4 });
  }, configurable: true });
}
function te(e9) {
  return Object.create(Object.getPrototypeOf(e9), Object.getOwnPropertyDescriptors(e9));
}
function g(e9, t4, n3) {
  Object.defineProperty(e9, t4, { value: n3, writable: true, enumerable: true, configurable: true });
}
function _(...e9) {
  let t4 = {};
  for (let n3 of e9) {
    let e10 = Object.getOwnPropertyDescriptors(n3);
    Object.assign(t4, e10);
  }
  return Object.defineProperties({}, t4);
}
function ne(e9) {
  return _(e9._zod.def);
}
function re(e9, t4) {
  return t4 ? t4.reduce((e10, t5) => e10?.[t5], e9) : e9;
}
function ie(e9) {
  let t4 = Object.keys(e9), n3 = t4.map((t5) => e9[t5]);
  return Promise.all(n3).then((e10) => {
    let n4 = {};
    for (let r2 = 0; r2 < t4.length; r2++) n4[t4[r2]] = e10[r2];
    return n4;
  });
}
function ae(e9 = 10) {
  let t4 = ``;
  for (let n3 = 0; n3 < e9; n3++) t4 += `abcdefghijklmnopqrstuvwxyz`[Math.floor(Math.random() * 26)];
  return t4;
}
function v(e9) {
  return JSON.stringify(e9);
}
function oe(e9) {
  return e9.toLowerCase().trim().replace(/[^\w\s-]/g, ``).replace(/[\s_-]+/g, `-`).replace(/^-+|-+$/g, ``);
}
var se = `captureStackTrace` in Error ? Error.captureStackTrace : (...e9) => {
};
function ce(e9) {
  return typeof e9 == `object` && !!e9 && !Array.isArray(e9);
}
var le = d(() => {
  if (j.jitless || typeof navigator < `u` && navigator?.userAgent?.includes(`Cloudflare`)) return false;
  try {
    return Function(``), true;
  } catch {
    return false;
  }
});
function y(e9) {
  if (ce(e9) === false) return false;
  let t4 = e9.constructor;
  if (t4 === void 0 || typeof t4 != `function`) return true;
  let n3 = t4.prototype;
  return ce(n3) !== false && Object.prototype.hasOwnProperty.call(n3, `isPrototypeOf`) !== false;
}
function ue(e9) {
  return y(e9) ? { ...e9 } : Array.isArray(e9) ? [...e9] : e9 instanceof Map ? new Map(e9) : e9 instanceof Set ? new Set(e9) : e9;
}
function de(e9) {
  let t4 = 0;
  for (let n3 in e9) Object.prototype.hasOwnProperty.call(e9, n3) && t4++;
  return t4;
}
var fe = (e9) => {
  let t4 = typeof e9;
  switch (t4) {
    case `undefined`:
      return `undefined`;
    case `string`:
      return `string`;
    case `number`:
      return Number.isNaN(e9) ? `nan` : `number`;
    case `boolean`:
      return `boolean`;
    case `function`:
      return `function`;
    case `bigint`:
      return `bigint`;
    case `symbol`:
      return `symbol`;
    case `object`:
      return Array.isArray(e9) ? `array` : e9 === null ? `null` : e9.then && typeof e9.then == `function` && e9.catch && typeof e9.catch == `function` ? `promise` : typeof Map < `u` && e9 instanceof Map ? `map` : typeof Set < `u` && e9 instanceof Set ? `set` : typeof Date < `u` && e9 instanceof Date ? `date` : typeof File < `u` && e9 instanceof File ? `file` : `object`;
    default:
      throw Error(`Unknown data type: ${t4}`);
  }
};
var pe = /* @__PURE__ */ new Set([`string`, `number`, `symbol`]);
var me = /* @__PURE__ */ new Set([`string`, `number`, `bigint`, `boolean`, `symbol`, `undefined`]);
function b(e9) {
  return e9.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`);
}
function x(e9, t4, n3) {
  let r2 = new e9._zod.constr(t4 ?? e9._zod.def);
  return (!t4 || n3?.parent) && (r2._zod.parent = e9), r2;
}
function S(e9) {
  let t4 = e9;
  if (!t4) return {};
  if (typeof t4 == `string`) return { error: () => t4 };
  if (t4?.message !== void 0) {
    if (t4?.error !== void 0) throw Error("Cannot specify both `message` and `error` params");
    t4.error = t4.message;
  }
  return delete t4.message, typeof t4.error == `string` ? { ...t4, error: () => t4.error } : t4;
}
function he(e9) {
  let t4;
  return new Proxy({}, { get(n3, r2, i3) {
    return t4 ??= e9(), Reflect.get(t4, r2, i3);
  }, set(n3, r2, i3, a3) {
    return t4 ??= e9(), Reflect.set(t4, r2, i3, a3);
  }, has(n3, r2) {
    return t4 ??= e9(), Reflect.has(t4, r2);
  }, deleteProperty(n3, r2) {
    return t4 ??= e9(), Reflect.deleteProperty(t4, r2);
  }, ownKeys(n3) {
    return t4 ??= e9(), Reflect.ownKeys(t4);
  }, getOwnPropertyDescriptor(n3, r2) {
    return t4 ??= e9(), Reflect.getOwnPropertyDescriptor(t4, r2);
  }, defineProperty(n3, r2, i3) {
    return t4 ??= e9(), Reflect.defineProperty(t4, r2, i3);
  } });
}
function C(e9) {
  return typeof e9 == `bigint` ? e9.toString() + `n` : typeof e9 == `string` ? `"${e9}"` : `${e9}`;
}
function ge(e9) {
  return Object.keys(e9).filter((t4) => e9[t4]._zod.optin !== void 0 && e9[t4]._zod.optout === `optional`);
}
var _e = { safeint: [-(2 ** 53 - 1), 2 ** 53 - 1], int32: [-2147483648, 2147483647], uint32: [0, 4294967295], float32: [-34028234663852886e22, 34028234663852886e22], float64: [-Number.MAX_VALUE, Number.MAX_VALUE] };
var ve = { int64: [BigInt(`-9223372036854775808`), BigInt(`9223372036854775807`)], uint64: [BigInt(0), BigInt(`18446744073709551615`)] };
function ye(e9, t4) {
  let n3 = e9._zod.def, r2 = n3.checks;
  if (r2 && r2.length > 0) throw Error(`.pick() cannot be used on object schemas containing refinements`);
  return x(e9, _(e9._zod.def, { get shape() {
    let e10 = {};
    for (let r3 of Reflect.ownKeys(t4)) {
      if (!Object.prototype.hasOwnProperty.call(n3.shape, r3)) throw Error(`Unrecognized key: "${String(r3)}"`);
      t4[r3] && g(e10, r3, n3.shape[r3]);
    }
    return g(this, `shape`, e10), e10;
  }, checks: [] }));
}
function be(e9, t4) {
  let n3 = e9._zod.def, r2 = n3.checks;
  if (r2 && r2.length > 0) throw Error(`.omit() cannot be used on object schemas containing refinements`);
  return x(e9, _(e9._zod.def, { get shape() {
    let r3 = { ...e9._zod.def.shape };
    for (let e10 of Reflect.ownKeys(t4)) {
      if (!Object.prototype.hasOwnProperty.call(n3.shape, e10)) throw Error(`Unrecognized key: "${String(e10)}"`);
      t4[e10] && delete r3[e10];
    }
    return g(this, `shape`, r3), r3;
  }, checks: [] }));
}
function xe(e9, t4) {
  if (!y(t4)) throw Error(`Invalid input to extend: expected a plain object`);
  let n3 = e9._zod.def.checks;
  if (n3 && n3.length > 0) {
    let n4 = e9._zod.def.shape;
    for (let e10 of Reflect.ownKeys(t4)) if (Object.getOwnPropertyDescriptor(n4, e10) !== void 0) throw Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
  }
  return x(e9, _(e9._zod.def, { get shape() {
    let n4 = { ...e9._zod.def.shape, ...t4 };
    return g(this, `shape`, n4), n4;
  } }));
}
function Se(e9, t4) {
  if (!y(t4)) throw Error(`Invalid input to safeExtend: expected a plain object`);
  return x(e9, _(e9._zod.def, { get shape() {
    let n3 = { ...e9._zod.def.shape, ...t4 };
    return g(this, `shape`, n3), n3;
  } }));
}
function Ce(e9, t4) {
  if (!t4?._zod?.def) throw Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
  if (e9._zod.def.checks?.length) throw Error(`.merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.`);
  return x(e9, _(e9._zod.def, { get shape() {
    let n3 = { ...e9._zod.def.shape, ...t4._zod.def.shape };
    return g(this, `shape`, n3), n3;
  }, get catchall() {
    return t4._zod.def.catchall;
  }, checks: t4._zod.def.checks ?? [] }));
}
function we(e9, t4, n3, r2 = `partial`) {
  let i3 = t4._zod.def.checks;
  if (i3 && i3.length > 0) throw Error(`.${r2}() cannot be used on object schemas containing refinements`);
  return x(t4, _(t4._zod.def, { get shape() {
    let r3 = t4._zod.def.shape, i4 = { ...r3 };
    if (n3) for (let t5 of Reflect.ownKeys(n3)) {
      if (!Object.prototype.hasOwnProperty.call(r3, t5)) throw Error(`Unrecognized key: "${String(t5)}"`);
      n3[t5] && (i4[t5] = e9 ? new e9({ type: `optional`, innerType: r3[t5] }) : r3[t5]);
    }
    else for (let t5 of Reflect.ownKeys(r3)) i4[t5] = e9 ? new e9({ type: `optional`, innerType: r3[t5] }) : r3[t5];
    return g(this, `shape`, i4), i4;
  }, checks: [] }));
}
function Te(e9, t4, n3) {
  return x(t4, _(t4._zod.def, { get shape() {
    let r2 = t4._zod.def.shape, i3 = { ...r2 };
    if (n3) for (let t5 of Reflect.ownKeys(n3)) {
      if (!Object.prototype.hasOwnProperty.call(i3, t5)) throw Error(`Unrecognized key: "${String(t5)}"`);
      n3[t5] && (i3[t5] = new e9({ type: `nonoptional`, innerType: r2[t5] }));
    }
    else for (let t5 of Reflect.ownKeys(r2)) i3[t5] = new e9({ type: `nonoptional`, innerType: r2[t5] });
    return g(this, `shape`, i3), i3;
  } }));
}
function w(e9, t4 = 0) {
  if (e9.aborted === true) return true;
  for (let n3 = t4; n3 < e9.issues.length; n3++) if (e9.issues[n3]?.continue !== true) return true;
  return false;
}
function Ee(e9, t4 = 0) {
  if (e9.aborted === true) return true;
  for (let n3 = t4; n3 < e9.issues.length; n3++) if (e9.issues[n3]?.continue === false) return true;
  return false;
}
function T(e9, t4) {
  return t4.map((t5) => {
    var n3;
    return (n3 = t5).path ?? (n3.path = []), t5.path.unshift(e9), t5;
  });
}
function De(e9) {
  return typeof e9 == `string` ? e9 : e9?.message;
}
function Oe(e9, t4, n3) {
  var r2;
  for (let i3 = t4; i3 < e9.length; i3++) (r2 = e9[i3]).schema ?? (r2.schema = n3);
}
function E(e9, t4, n3) {
  var r2;
  let i3 = e9.inst?._zod?.traits;
  i3?.has(`$ZodType`) && (i3.has(`$ZodCheck`) ? (r2 = e9).schema ?? (r2.schema = e9.inst) : e9.schema = e9.inst);
  let a3 = e9.schema === e9.inst ? void 0 : e9.schema?._zod.def?.error, o3 = e9.message ? e9.message : De(e9.inst?._zod.def?.error?.(e9)) ?? De(a3?.(e9)) ?? De(t4?.error?.(e9)) ?? De(n3.customError?.(e9)) ?? De(n3.localeError?.(e9)) ?? `Invalid input`, { inst: s3, schema: c3, continue: l3, input: u3, ...d3 } = e9;
  return d3.path ??= [], d3.message = o3, t4?.reportInput && (d3.input = u3), d3;
}
function ke(e9) {
  return e9 instanceof Set ? `set` : e9 instanceof Map ? `map` : e9 instanceof File ? `file` : `unknown`;
}
var Ae = /[\uD800-\uDBFF]/;
function je(e9) {
  let t4 = e9.length;
  if (!Ae.test(e9)) return t4;
  let n3 = t4;
  for (let r2 = 0; r2 < t4 - 1; r2++) (e9.charCodeAt(r2) & 64512) == 55296 && (e9.charCodeAt(r2 + 1) & 64512) == 56320 && (n3--, r2++);
  return n3;
}
function Me(e9) {
  return Array.isArray(e9) ? `array` : typeof e9 == `string` ? `string` : `unknown`;
}
function D(e9) {
  let t4 = typeof e9;
  switch (t4) {
    case `number`:
      return Number.isNaN(e9) ? `nan` : `number`;
    case `object`: {
      if (e9 === null) return `null`;
      if (Array.isArray(e9)) return `array`;
      let t5 = e9;
      if (t5 && Object.getPrototypeOf(t5) !== Object.prototype && `constructor` in t5 && t5.constructor) return t5.constructor.name;
    }
  }
  return t4;
}
function Ne(...e9) {
  let [t4, n3, r2] = e9;
  return typeof t4 == `string` ? { message: t4, code: `custom`, input: n3, inst: r2 } : { ...t4 };
}
function Pe(e9) {
  return Object.entries(e9).filter(([e10, t4]) => Number.isNaN(Number.parseInt(e10, 10))).map((e10) => e10[1]);
}
function Fe(e9) {
  let t4 = atob(e9), n3 = new Uint8Array(t4.length);
  for (let e10 = 0; e10 < t4.length; e10++) n3[e10] = t4.charCodeAt(e10);
  return n3;
}
function Ie(e9) {
  let t4 = ``;
  for (let n3 = 0; n3 < e9.length; n3++) t4 += String.fromCharCode(e9[n3]);
  return btoa(t4);
}
function Le(e9) {
  let t4 = e9.replace(/-/g, `+`).replace(/_/g, `/`);
  return Fe(t4 + `=`.repeat((4 - t4.length % 4) % 4));
}
function Re(e9) {
  return Ie(e9).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=/g, ``);
}
function ze(e9) {
  let t4 = e9.replace(/^0x/, ``);
  if (t4.length % 2 != 0) throw Error(`Invalid hex string length`);
  let n3 = new Uint8Array(t4.length / 2);
  for (let e10 = 0; e10 < t4.length; e10 += 2) n3[e10 / 2] = Number.parseInt(t4.slice(e10, e10 + 2), 16);
  return n3;
}
function Be(e9) {
  return Array.from(e9).map((e10) => e10.toString(16).padStart(2, `0`)).join(``);
}
var Ve = class {
  constructor(...e9) {
  }
};
function He(e9, t4) {
  for (let n3 in t4) {
    let r2 = Object.getOwnPropertyDescriptor(t4, n3);
    r2.get ? Object.defineProperty(e9, n3, { ...r2, enumerable: false }) : Ge(e9, n3, r2.value);
  }
}
function Ue(e9, t4, n3, r2 = true) {
  return Object.defineProperty(e9, t4, { configurable: true, writable: true, enumerable: r2, value: n3 }), n3;
}
function We(e9, t4, n3) {
  return Ue(e9, t4, n3, false);
}
function Ge(e9, t4, n3) {
  Object.defineProperty(e9, t4, { configurable: true, get() {
    return this == null ? n3 : Ue(this, t4, n3.bind(this));
  }, set(e10) {
    Ue(this, t4, e10);
  } });
}
function Ke(e9, t4) {
  let n3 = Object.getPrototypeOf(e9);
  return t4 in n3 ? void 0 : n3;
}
var qe;
var Je = false;
var Ye = { configurable: true, get() {
  Je = true;
} };
function O(e9, t4, n3) {
  let r2 = Object.getPrototypeOf(e9._zod);
  if (t4 in r2 && qe !== e9._zod) {
    qe = void 0;
    return;
  }
  qe = e9._zod, Object.defineProperty(r2, t4, { configurable: true, get() {
    Object.defineProperty(this, t4, Ye);
    let e10 = Je;
    Je = false;
    try {
      let r3 = n3(this);
      return Je ? delete this[t4] : Object.defineProperty(this, t4, { configurable: true, writable: true, value: r3 }), Je ||= e10, r3;
    } catch (n4) {
      throw delete this[t4], Je ||= e10, n4;
    }
  }, set(e10) {
    Object.defineProperty(this, t4, { configurable: true, writable: true, value: e10 });
  } });
}
function Xe(e9, t4, n3, r2) {
  let i3 = Ke(e9, t4);
  i3 && Object.defineProperty(i3, t4, { configurable: true, get() {
    let e10 = { configurable: true, writable: true, enumerable: r2, value: void 0 };
    return Object.defineProperty(this, t4, e10), e10.value = n3(this), Object.defineProperty(this, t4, e10), e10.value;
  }, set(e10) {
    Object.defineProperty(this, t4, { configurable: true, writable: true, enumerable: r2, value: e10 });
  } });
}
var Ze = `~constantCatch`;
function Qe(e9) {
  let t4 = () => e9;
  return t4[Ze] = true, t4;
}
var $e;
var et = Object.freeze({ status: `aborted` });
var tt = { value: void 0, enumerable: false };
var nt = `captureStackTrace` in Error ? Error : null;
function rt(e9) {
  let t4 = nt;
  if (t4) {
    let n3 = t4.stackTraceLimit;
    if (typeof n3 == `number`) {
      try {
        t4.stackTraceLimit = 0;
      } catch {
        return nt = null, new e9();
      }
      try {
        return new e9();
      } finally {
        t4.stackTraceLimit = n3;
      }
    }
  }
  return new e9();
}
function k(e9, t4, n3, r2) {
  let i3 = {};
  function a3(e10) {
    this.def = e10, this.constr = d3, this.traits = /* @__PURE__ */ new Set();
  }
  a3.prototype = i3;
  let o3 = n3, s3 = o3 && /* @__PURE__ */ new WeakSet();
  function c3(n4, r3) {
    if (!n4._zod) {
      tt.value = new a3(r3);
      try {
        Object.defineProperty(n4, "_zod", tt);
      } finally {
        tt.value = void 0;
      }
    }
    if (n4._zod.traits.has(e9)) return;
    if (n4._zod.traits.add(e9), t4(n4, r3), s3) {
      let e10 = Object.getPrototypeOf(n4), t5 = n4._zod.constr.prototype, r4 = e10;
      for (; r4 && r4 !== t5; ) r4 = Object.getPrototypeOf(r4);
      let i5 = r4 ?? e10;
      s3.has(i5) || (s3.add(i5), He(i5, o3));
    }
    let i4 = d3.prototype;
    for (let e10 in i4) Object.prototype.hasOwnProperty.call(i4, e10) && (e10 in n4 || (n4[e10] = i4[e10].bind(n4)));
  }
  let l3 = r2?.Parent ?? Object;
  class u3 extends l3 {
  }
  Object.defineProperty(u3, "name", { value: e9 });
  function d3(e10) {
    let t5 = r2?.Parent ? rt(u3) : this;
    c3(t5, e10);
    let n4 = t5._zod.deferred;
    if (n4) {
      for (let e11 of n4) e11();
      t5._zod.deferred = void 0;
    }
    let i4 = globalThis.__zod_globalConfig?.postProcessor;
    return i4 && i4(t5), t5;
  }
  return Object.defineProperty(d3, "init", { value: c3 }), Object.defineProperty(d3, Symbol.hasInstance, { value: (t5) => r2?.Parent && t5 instanceof r2.Parent ? true : t5?._zod?.traits?.has(e9) }), Object.defineProperty(d3, "name", { value: e9 }), d3;
}
var it = /* @__PURE__ */ Symbol(`zod_brand`);
var A = class extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
};
var at = class extends Error {
  constructor(e9) {
    super(`Encountered unidirectional transform during encode: ${e9}`), this.name = `ZodEncodeError`;
  }
};
($e = globalThis).__zod_globalConfig ?? ($e.__zod_globalConfig = {});
var j = globalThis.__zod_globalConfig;
function M(e9) {
  return e9 && Object.assign(j, e9), j;
}
function ot() {
  let e9 = this._zod;
  return e9.message ??= JSON.stringify(e9.def, u, 2), e9.message;
}
function st(e9) {
  this._zod.message = e9;
}
var ct = { get: ot, set: st, enumerable: true, configurable: true };
var lt = { value: void 0, enumerable: false };
var ut = { value: void 0, enumerable: false };
var dt = new WeakSet([Object.prototype, Error.prototype]);
var ft = (e9, t4) => {
  e9.name = `$ZodError`, lt.value = e9._zod, Object.defineProperty(e9, "_zod", lt), ut.value = t4, Object.defineProperty(e9, "issues", ut), lt.value = void 0, ut.value = void 0, Object.defineProperty(e9, "message", ct);
  let n3 = Object.getPrototypeOf(e9);
  dt.has(n3) || (dt.add(n3), Object.defineProperty(n3, "toString", { configurable: true, enumerable: false, get() {
    let e10 = () => this.message;
    return Object.defineProperty(this, "toString", { value: e10, configurable: true, writable: true }), e10;
  }, set(e10) {
    Object.defineProperty(this, "toString", { value: e10, configurable: true, writable: true });
  } }));
};
var pt = k(`$ZodError`, ft);
var N = k(`$ZodError`, ft, void 0, { Parent: Error });
function mt(e9, t4, n3) {
  return Object.prototype.hasOwnProperty.call(e9, t4) || (t4 === `__proto__` ? Object.defineProperty(e9, t4, { value: n3(), writable: true, enumerable: true, configurable: true }) : e9[t4] = n3()), e9[t4];
}
function ht(e9, t4 = (e10) => e10.message) {
  let n3 = {}, r2 = [];
  for (let i3 of e9.issues) i3.path.length > 0 ? mt(n3, i3.path[0], () => []).push(t4(i3)) : r2.push(t4(i3));
  return { formErrors: r2, fieldErrors: n3 };
}
function gt(e9, t4 = (e10) => e10.message) {
  let n3 = { _errors: [] }, r2 = (e10, i3 = []) => {
    for (let a3 of e10.issues) if (a3.code === `invalid_union` && a3.errors.length) a3.errors.map((e11) => r2({ issues: e11 }, [...i3, ...a3.path]));
    else if (a3.code === `invalid_key`) r2({ issues: a3.issues }, [...i3, ...a3.path]);
    else if (a3.code === `invalid_element`) r2({ issues: a3.issues }, [...i3, ...a3.path]);
    else {
      let e11 = [...i3, ...a3.path];
      if (e11.length === 0) n3._errors.push(t4(a3));
      else {
        let r3 = n3, i4 = 0;
        for (; i4 < e11.length; ) {
          let n4 = e11[i4], o3 = i4 === e11.length - 1;
          if (n4 === `_errors`) {
            o3 && r3._errors.push(t4(a3)), i4++;
            continue;
          }
          Object.prototype.hasOwnProperty.call(r3, n4) || Object.defineProperty(r3, n4, { value: { _errors: [] }, enumerable: true, writable: true, configurable: true });
          let s3 = r3[n4];
          o3 && s3._errors.push(t4(a3)), r3 = s3, i4++;
        }
      }
    }
  };
  return r2(e9), n3;
}
function _t(e9, t4 = (e10) => e10.message) {
  let n3 = { errors: [] }, r2 = (e10, i3 = []) => {
    var a3;
    for (let o3 of e10.issues) if (o3.code === `invalid_union` && o3.errors.length) o3.errors.map((e11) => r2({ issues: e11 }, [...i3, ...o3.path]));
    else if (o3.code === `invalid_key`) r2({ issues: o3.issues }, [...i3, ...o3.path]);
    else if (o3.code === `invalid_element`) r2({ issues: o3.issues }, [...i3, ...o3.path]);
    else {
      let e11 = [...i3, ...o3.path];
      if (e11.length === 0) {
        n3.errors.push(t4(o3));
        continue;
      }
      let r3 = n3, s3 = 0;
      for (; s3 < e11.length; ) {
        let n4 = e11[s3], i4 = s3 === e11.length - 1;
        typeof n4 == `string` ? (r3.properties ?? (r3.properties = {}), Object.prototype.hasOwnProperty.call(r3.properties, n4) || Object.defineProperty(r3.properties, n4, { value: { errors: [] }, enumerable: true, writable: true, configurable: true }), r3 = r3.properties[n4]) : (r3.items ?? (r3.items = []), (a3 = r3.items)[n4] ?? (a3[n4] = { errors: [] }), r3 = r3.items[n4]), i4 && r3.errors.push(t4(o3)), s3++;
      }
    }
  };
  return r2(e9), n3;
}
function vt(e9) {
  let t4 = [], n3 = e9.map((e10) => typeof e10 == `object` ? e10.key : e10);
  for (let e10 of n3) typeof e10 == `number` ? t4.push(`[${e10}]`) : typeof e10 == `symbol` ? t4.push(`[${JSON.stringify(String(e10))}]`) : /[^\w$]/.test(e10) ? t4.push(`[${JSON.stringify(e10)}]`) : (t4.length && t4.push(`.`), t4.push(e10));
  return t4.join(``);
}
function yt(e9) {
  let t4 = [], n3 = [...e9.issues].sort((e10, t5) => (e10.path ?? []).length - (t5.path ?? []).length);
  for (let e10 of n3) t4.push(`\u2716 ${e10.message}`), e10.path?.length && t4.push(`  \u2192 at ${vt(e10.path)}`);
  return t4.join(`
`);
}
function bt(e9, t4) {
  return { callee: t4?.callee ?? e9, Err: t4?.Err };
}
var xt = (e9) => {
  let t4 = (n3, r2, i3, a3) => {
    let o3 = i3 ? { ...i3, async: false } : { async: false }, s3 = n3._zod.run({ value: r2, issues: [] }, o3);
    if (s3 instanceof Promise) throw new A();
    if (s3.issues.length) {
      let n4 = new (a3?.Err ?? e9)(s3.issues.map((e10) => E(e10, o3, M())));
      throw se(n4, a3?.callee ?? t4), n4;
    }
    return s3.value;
  };
  return t4;
};
var St = xt(N);
var Ct = (e9) => {
  let t4 = async (n3, r2, i3, a3) => {
    let o3 = i3 ? { ...i3, async: true } : { async: true }, s3 = n3._zod.run({ value: r2, issues: [] }, o3);
    if (s3 instanceof Promise && (s3 = await s3), s3.issues.length) {
      let n4 = new (a3?.Err ?? e9)(s3.issues.map((e10) => E(e10, o3, M())));
      throw se(n4, a3?.callee ?? t4), n4;
    }
    return s3.value;
  };
  return t4;
};
var wt = Ct(N);
var Tt = (e9) => (t4, n3, r2) => {
  let i3 = r2 ? { ...r2, async: false } : { async: false }, a3 = t4._zod.run({ value: n3, issues: [] }, i3);
  if (a3 instanceof Promise) throw new A();
  return a3.issues.length ? { success: false, error: new (e9 ?? pt)(a3.issues.map((e10) => E(e10, i3, M()))) } : { success: true, data: a3.value };
};
var Et = Tt(N);
var Dt = (e9) => async (t4, n3, r2) => {
  let i3 = r2 ? { ...r2, async: true } : { async: true }, a3 = t4._zod.run({ value: n3, issues: [] }, i3);
  return a3 instanceof Promise && (a3 = await a3), a3.issues.length ? { success: false, error: new e9(a3.issues.map((e10) => E(e10, i3, M()))) } : { success: true, data: a3.value };
};
var Ot = Dt(N);
var kt = /* @__PURE__ */ Symbol.for(`zod.compile.invalid`);
var At = /* @__PURE__ */ Symbol.for(`zod.compile.fallback`);
var jt = ((e9, t4, n3) => {
  let r2 = e9._zod.bag.validator;
  return r2 !== void 0 && r2(t4) !== kt || Mt(e9, t4, n3);
});
function Mt(e9, t4, n3) {
  let r2 = n3 ? { ...n3, async: false } : { async: false }, i3 = e9._zod.bag.fallbackRun, a3;
  if (i3 ? (r2[At] = true, a3 = i3({ value: t4, issues: [] }, r2)) : a3 = e9._zod.run({ value: t4, issues: [] }, r2), a3 instanceof Promise) throw new A();
  return a3.issues.length === 0;
}
var Nt = async (e9, t4, n3) => {
  let r2 = n3 ? { ...n3, async: true } : { async: true }, i3 = e9._zod.run({ value: t4, issues: [] }, r2);
  return i3 instanceof Promise && (i3 = await i3), i3.issues.length === 0;
};
var Pt = (e9) => {
  let t4 = xt(e9), n3 = (e10, r2, i3, a3) => {
    let o3 = i3 ? { ...i3, direction: `backward` } : { direction: `backward` };
    return t4(e10, r2, o3, bt(n3, a3));
  };
  return n3;
};
var Ft = Pt(N);
var It = (e9) => {
  let t4 = xt(e9), n3 = (e10, r2, i3, a3) => t4(e10, r2, i3, bt(n3, a3));
  return n3;
};
var Lt = It(N);
var Rt = (e9) => {
  let t4 = Ct(e9), n3 = async (e10, r2, i3, a3) => {
    let o3 = i3 ? { ...i3, direction: `backward` } : { direction: `backward` };
    return await t4(e10, r2, o3, bt(n3, a3));
  };
  return n3;
};
var zt = Rt(N);
var Bt = (e9) => {
  let t4 = Ct(e9), n3 = async (e10, r2, i3, a3) => await t4(e10, r2, i3, bt(n3, a3));
  return n3;
};
var Vt = Bt(N);
var Ht = (e9) => (t4, n3, r2) => {
  let i3 = r2 ? { ...r2, direction: `backward` } : { direction: `backward` };
  return Tt(e9)(t4, n3, i3);
};
var Ut = Ht(N);
var Wt = (e9) => (t4, n3, r2) => Tt(e9)(t4, n3, r2);
var Gt = Wt(N);
var Kt = (e9) => async (t4, n3, r2) => {
  let i3 = r2 ? { ...r2, direction: `backward` } : { direction: `backward` };
  return Dt(e9)(t4, n3, i3);
};
var qt = Kt(N);
var Jt = (e9) => async (t4, n3, r2) => Dt(e9)(t4, n3, r2);
var Yt = Jt(N);
var Xt = t({ base64: () => wn, base64url: () => Tn, bigint: () => Rn, boolean: () => Vn, browserEmail: () => _n, cidrv4: () => Sn, cidrv6: () => Cn, creditCard: () => An, cuid: () => Zt, cuid2: () => Qt, date: () => Nn, datetime: () => In, domain: () => Dn, duration: () => an, e164: () => kn, email: () => fn, emoji: () => vn, extendedDuration: () => on, guid: () => sn, hex: () => Kn, hostname: () => En, html5Email: () => pn, httpProtocol: () => On, idnEmail: () => gn, integer: () => zn, ipv4: () => yn, ipv6: () => bn, ksuid: () => tn, lowercase: () => Wn, mac: () => xn, md5_base64: () => Xn, md5_base64url: () => Zn, md5_hex: () => Yn, nanoid: () => nn, nanoidOfLength: () => rn, null: () => Hn, number: () => Bn, rfc5322Email: () => mn, sha1_base64: () => $n, sha1_base64url: () => er, sha1_hex: () => Qn, sha256_base64: () => nr, sha256_base64url: () => rr, sha256_hex: () => tr, sha384_base64: () => ar, sha384_base64url: () => or, sha384_hex: () => ir, sha512_base64: () => cr, sha512_base64url: () => lr, sha512_hex: () => sr, string: () => Ln, time: () => Fn, ulid: () => $t, undefined: () => Un, unicodeEmail: () => hn, uppercase: () => Gn, uuid: () => cn, uuid4: () => ln, uuid6: () => un, uuid7: () => dn, xid: () => en });
var Zt = /^[cC][0-9a-z]{6,}$/;
var Qt = /^[0-9a-z]+$/;
var $t = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
var en = /^[0-9a-vA-V]{20}$/;
var tn = /^[A-Za-z0-9]{27}$/;
var nn = /^[a-zA-Z0-9_-]{21}$/;
function rn(e9) {
  return RegExp(`^[a-zA-Z0-9_-]{${e9}}$`);
}
var an = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var on = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var sn = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var cn = (e9) => e9 ? RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${e9}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`) : /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
var ln = cn(4);
var un = cn(6);
var dn = cn(7);
var fn = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var pn = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var mn = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
var hn = /^[^\s@"]{1,64}@[^\s@]{1,255}$/u;
var gn = hn;
var _n = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
function vn() {
  return RegExp(`^[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$`, `u`);
}
var yn = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var bn = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var xn = (e9) => {
  let t4 = b(e9 ?? `:`);
  return RegExp(`^(?:[0-9A-F]{2}${t4}){5}[0-9A-F]{2}$|^(?:[0-9a-f]{2}${t4}){5}[0-9a-f]{2}$`);
};
var Sn = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var Cn = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var wn = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var Tn = /^[A-Za-z0-9_-]*$/;
var En = /^(?=.{1,253}\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\.?$/;
var Dn = /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;
var On = /^https?$/;
var kn = /^\+[1-9]\d{6,14}$/;
var An = /^\d(?:[ -]?\d){11,18}$/;
var jn = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
function Mn(e9) {
  return RegExp(`^${e9}$`);
}
var Nn = Mn(jn);
function Pn(e9) {
  let t4 = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  return typeof e9.precision == `number` ? e9.precision === -1 ? `${t4}` : e9.precision === 0 ? `${t4}:[0-5]\\d` : `${t4}:[0-5]\\d\\.\\d{${e9.precision}}` : e9.seconds ? `${t4}:[0-5]\\d(?:\\.\\d+)?` : `${t4}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function Fn(e9) {
  return RegExp(`^${Pn(e9)}$`);
}
function In(e9) {
  let t4 = [`Z`];
  e9.offset && t4.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  let n3 = `${Pn({ precision: e9.precision, seconds: true })}(?:${t4.join(`|`)})`, r2 = e9.local ? `${n3}|${Pn({ precision: e9.precision })}` : n3;
  return RegExp(`^${jn}T(?:${r2})$`);
}
var Ln = (e9) => {
  let t4 = e9 ? `[\\s\\S]{${e9?.minimum ?? 0},${e9?.maximum ?? ``}}` : `[\\s\\S]*`;
  return RegExp(`^${t4}$`);
};
var Rn = /^-?\d+n?$/;
var zn = /^-?\d+$/;
var Bn = /^-?\d+(?:\.\d+)?$/;
var Vn = /^(?:true|false)$/i;
var Hn = /^null$/i;
var Un = /^undefined$/i;
var Wn = /^[^A-Z]*$/;
var Gn = /^[^a-z]*$/;
var Kn = /^[0-9a-fA-F]*$/;
function qn(e9, t4) {
  return RegExp(`^[A-Za-z0-9+/]{${e9}}${t4}$`);
}
function Jn(e9) {
  return RegExp(`^[A-Za-z0-9_-]{${e9}}$`);
}
var Yn = /^[0-9a-fA-F]{32}$/;
var Xn = qn(22, `==`);
var Zn = Jn(22);
var Qn = /^[0-9a-fA-F]{40}$/;
var $n = qn(27, `=`);
var er = Jn(27);
var tr = /^[0-9a-fA-F]{64}$/;
var nr = qn(43, `=`);
var rr = Jn(43);
var ir = /^[0-9a-fA-F]{96}$/;
var ar = qn(64, ``);
var or = Jn(64);
var sr = /^[0-9a-fA-F]{128}$/;
var cr = qn(86, `==`);
var lr = Jn(86);
var P = k(`$ZodCheck`, (e9, t4) => {
  var n3;
  e9._zod ??= {}, e9._zod.def = t4, (n3 = e9._zod).onattach ?? (n3.onattach = []);
});
var ur = (e9) => {
  let t4 = e9.value;
  return !f(t4) && t4.size !== void 0;
};
var dr = (e9) => {
  let t4 = e9.value;
  return !f(t4) && t4.length !== void 0;
};
var fr = { number: `number`, bigint: `bigint`, object: `date` };
var pr = k(`$ZodCheckLessThan`, (e9, t4) => {
  P.init(e9, t4);
  let n3 = fr[typeof t4.value];
  e9._zod.onattach.push((e10) => {
    let n4 = e10._zod.bag, r2 = (t4.inclusive ? n4.maximum : n4.exclusiveMaximum) ?? 1 / 0;
    t4.value < r2 && (t4.inclusive ? n4.maximum = t4.value : n4.exclusiveMaximum = t4.value);
  }), e9._zod.check = (r2) => {
    (t4.inclusive ? r2.value <= t4.value : r2.value < t4.value) || r2.issues.push({ origin: fr[typeof r2.value] ?? n3, code: `too_big`, maximum: typeof t4.value == `object` ? t4.value.getTime() : t4.value, input: r2.value, inclusive: t4.inclusive, inst: e9, continue: !t4.abort });
  };
});
var mr = k(`$ZodCheckGreaterThan`, (e9, t4) => {
  P.init(e9, t4);
  let n3 = fr[typeof t4.value];
  e9._zod.onattach.push((e10) => {
    let n4 = e10._zod.bag, r2 = (t4.inclusive ? n4.minimum : n4.exclusiveMinimum) ?? -1 / 0;
    t4.value > r2 && (t4.inclusive ? n4.minimum = t4.value : n4.exclusiveMinimum = t4.value);
  }), e9._zod.check = (r2) => {
    (t4.inclusive ? r2.value >= t4.value : r2.value > t4.value) || r2.issues.push({ origin: fr[typeof r2.value] ?? n3, code: `too_small`, minimum: typeof t4.value == `object` ? t4.value.getTime() : t4.value, input: r2.value, inclusive: t4.inclusive, inst: e9, continue: !t4.abort });
  };
});
var hr = k(`$ZodCheckMultipleOf`, (e9, t4) => {
  P.init(e9, t4), e9._zod.onattach.push((e10) => {
    var n3;
    (n3 = e10._zod.bag).multipleOf ?? (n3.multipleOf = t4.value);
  }), e9._zod.check = (n3) => {
    if (typeof n3.value != typeof t4.value) throw Error(`Cannot mix number and bigint in multiple_of check.`);
    (typeof n3.value == `bigint` ? t4.value !== BigInt(0) && n3.value % t4.value === BigInt(0) : m(n3.value, t4.value) === 0) || n3.issues.push({ origin: typeof n3.value, code: `not_multiple_of`, divisor: t4.value, input: n3.value, inst: e9, continue: !t4.abort });
  };
});
var gr = k(`$ZodCheckNumberFormat`, (e9, t4) => {
  P.init(e9, t4), t4.format = t4.format || `float64`;
  let n3 = t4.format?.includes(`int`), r2 = n3 ? `int` : `number`, [i3, a3] = _e[t4.format];
  e9._zod.onattach.push((e10) => {
    let r3 = e10._zod.bag;
    r3.format = t4.format, r3.minimum = i3, r3.maximum = a3, n3 && (r3.pattern = zn);
  }), e9._zod.check = (o3) => {
    let s3 = o3.value;
    if (n3) {
      if (!Number.isInteger(s3)) {
        o3.issues.push({ expected: r2, format: t4.format, code: `invalid_type`, continue: false, input: s3, inst: e9 });
        return;
      }
      if (!Number.isSafeInteger(s3)) {
        s3 > 0 ? o3.issues.push({ input: s3, code: `too_big`, maximum: 2 ** 53 - 1, note: `Integers must be within the safe integer range.`, inst: e9, origin: r2, inclusive: true, continue: !t4.abort }) : o3.issues.push({ input: s3, code: `too_small`, minimum: -(2 ** 53 - 1), note: `Integers must be within the safe integer range.`, inst: e9, origin: r2, inclusive: true, continue: !t4.abort });
        return;
      }
    }
    s3 < i3 && o3.issues.push({ origin: `number`, input: s3, code: `too_small`, minimum: i3, inclusive: true, inst: e9, continue: !t4.abort }), s3 > a3 && o3.issues.push({ origin: `number`, input: s3, code: `too_big`, maximum: a3, inclusive: true, inst: e9, continue: !t4.abort });
  };
});
var _r = k(`$ZodCheckBigIntFormat`, (e9, t4) => {
  P.init(e9, t4);
  let [n3, r2] = ve[t4.format];
  e9._zod.onattach.push((e10) => {
    let i3 = e10._zod.bag;
    i3.format = t4.format, i3.minimum = n3, i3.maximum = r2;
  }), e9._zod.check = (i3) => {
    let a3 = i3.value;
    a3 < n3 && i3.issues.push({ origin: `bigint`, input: a3, code: `too_small`, minimum: n3, inclusive: true, inst: e9, continue: !t4.abort }), a3 > r2 && i3.issues.push({ origin: `bigint`, input: a3, code: `too_big`, maximum: r2, inclusive: true, inst: e9, continue: !t4.abort });
  };
});
var vr = k(`$ZodCheckMaxSize`, (e9, t4) => {
  var n3;
  P.init(e9, t4), (n3 = e9._zod.def).when ?? (n3.when = ur), e9._zod.onattach.push((e10) => {
    let n4 = e10._zod.bag.maximum ?? 1 / 0;
    t4.maximum < n4 && (e10._zod.bag.maximum = t4.maximum);
  }), e9._zod.check = (n4) => {
    let r2 = n4.value;
    r2.size <= t4.maximum || n4.issues.push({ origin: ke(r2), code: `too_big`, maximum: t4.maximum, inclusive: true, input: r2, inst: e9, continue: !t4.abort });
  };
});
var yr = k(`$ZodCheckMinSize`, (e9, t4) => {
  var n3;
  P.init(e9, t4), (n3 = e9._zod.def).when ?? (n3.when = ur), e9._zod.onattach.push((e10) => {
    let n4 = e10._zod.bag.minimum ?? -1 / 0;
    t4.minimum > n4 && (e10._zod.bag.minimum = t4.minimum);
  }), e9._zod.check = (n4) => {
    let r2 = n4.value;
    r2.size >= t4.minimum || n4.issues.push({ origin: ke(r2), code: `too_small`, minimum: t4.minimum, inclusive: true, input: r2, inst: e9, continue: !t4.abort });
  };
});
var br = k(`$ZodCheckSizeEquals`, (e9, t4) => {
  var n3;
  P.init(e9, t4), (n3 = e9._zod.def).when ?? (n3.when = ur), e9._zod.onattach.push((e10) => {
    let n4 = e10._zod.bag;
    n4.minimum = t4.size, n4.maximum = t4.size, n4.size = t4.size;
  }), e9._zod.check = (n4) => {
    let r2 = n4.value, i3 = r2.size;
    if (i3 === t4.size) return;
    let a3 = i3 > t4.size;
    n4.issues.push({ origin: ke(r2), ...a3 ? { code: `too_big`, maximum: t4.size } : { code: `too_small`, minimum: t4.size }, inclusive: true, exact: true, input: n4.value, inst: e9, continue: !t4.abort });
  };
});
var xr = k(`$ZodCheckMaxLength`, (e9, t4) => {
  var n3;
  P.init(e9, t4), (n3 = e9._zod.def).when ?? (n3.when = dr), e9._zod.onattach.push((e10) => {
    let n4 = e10._zod.bag.maximum ?? 1 / 0;
    t4.maximum < n4 && (e10._zod.bag.maximum = t4.maximum);
  }), e9._zod.check = (n4) => {
    let r2 = n4.value, i3 = r2.length;
    if ((typeof r2 == `string` && i3 > t4.maximum ? je(r2) : i3) <= t4.maximum) return;
    let a3 = Me(r2);
    n4.issues.push({ origin: a3, code: `too_big`, maximum: t4.maximum, inclusive: true, input: r2, inst: e9, continue: !t4.abort });
  };
});
var Sr = k(`$ZodCheckMinLength`, (e9, t4) => {
  var n3;
  P.init(e9, t4), (n3 = e9._zod.def).when ?? (n3.when = dr), e9._zod.onattach.push((e10) => {
    let n4 = e10._zod.bag.minimum ?? -1 / 0;
    t4.minimum > n4 && (e10._zod.bag.minimum = t4.minimum);
  }), e9._zod.check = (n4) => {
    let r2 = n4.value, i3 = r2.length;
    if ((typeof r2 == `string` && i3 >= t4.minimum && i3 < t4.minimum * 2 ? je(r2) : i3) >= t4.minimum) return;
    let a3 = Me(r2);
    n4.issues.push({ origin: a3, code: `too_small`, minimum: t4.minimum, inclusive: true, input: r2, inst: e9, continue: !t4.abort });
  };
});
var Cr = k(`$ZodCheckLengthEquals`, (e9, t4) => {
  var n3;
  P.init(e9, t4), (n3 = e9._zod.def).when ?? (n3.when = dr), e9._zod.onattach.push((e10) => {
    let n4 = e10._zod.bag;
    n4.minimum = t4.length, n4.maximum = t4.length, n4.length = t4.length;
  }), e9._zod.check = (n4) => {
    let r2 = n4.value, i3 = r2.length, a3 = typeof r2 == `string` && i3 >= t4.length && i3 <= t4.length * 2 ? je(r2) : i3;
    if (a3 === t4.length) return;
    let o3 = Me(r2), s3 = a3 > t4.length;
    n4.issues.push({ origin: o3, ...s3 ? { code: `too_big`, maximum: t4.length } : { code: `too_small`, minimum: t4.length }, inclusive: true, exact: true, input: n4.value, inst: e9, continue: !t4.abort });
  };
});
var wr = k(`$ZodCheckStringFormat`, (e9, t4) => {
  var n3, r2;
  P.init(e9, t4), e9._zod.onattach.push((e10) => {
    let n4 = e10._zod.bag;
    n4.format = t4.format, t4.pattern && (n4.patterns ??= /* @__PURE__ */ new Set(), n4.patterns.add(t4.pattern));
  }), t4.pattern ? (n3 = e9._zod).check ?? (n3.check = (n4) => {
    t4.pattern.lastIndex = 0, !t4.pattern.test(n4.value) && n4.issues.push({ origin: `string`, code: `invalid_format`, format: t4.format, input: n4.value, ...t4.pattern ? { pattern: t4.pattern.toString() } : {}, inst: e9, continue: !t4.abort });
  }) : (r2 = e9._zod).check ?? (r2.check = () => {
  });
});
var Tr = k(`$ZodCheckRegex`, (e9, t4) => {
  wr.init(e9, t4), e9._zod.check = (n3) => {
    t4.pattern.lastIndex = 0, !t4.pattern.test(n3.value) && n3.issues.push({ origin: `string`, code: `invalid_format`, format: `regex`, input: n3.value, pattern: t4.pattern.toString(), inst: e9, continue: !t4.abort });
  };
});
var Er = k(`$ZodCheckLowerCase`, (e9, t4) => {
  t4.pattern ??= Wn, wr.init(e9, t4);
});
var Dr = k(`$ZodCheckUpperCase`, (e9, t4) => {
  t4.pattern ??= Gn, wr.init(e9, t4);
});
var Or = k(`$ZodCheckIncludes`, (e9, t4) => {
  P.init(e9, t4);
  let n3 = b(t4.includes), r2 = new RegExp(typeof t4.position == `number` ? `^.{${t4.position},}${n3}` : n3);
  t4.pattern = r2, e9._zod.onattach.push((e10) => {
    let t5 = e10._zod.bag;
    t5.patterns ??= /* @__PURE__ */ new Set(), t5.patterns.add(r2);
  }), e9._zod.check = (n4) => {
    n4.value.includes(t4.includes, t4.position) || n4.issues.push({ origin: `string`, code: `invalid_format`, format: `includes`, includes: t4.includes, input: n4.value, inst: e9, continue: !t4.abort });
  };
});
var kr = k(`$ZodCheckStartsWith`, (e9, t4) => {
  P.init(e9, t4);
  let n3 = RegExp(`^${b(t4.prefix)}.*`);
  t4.pattern ??= n3, e9._zod.onattach.push((e10) => {
    let t5 = e10._zod.bag;
    t5.patterns ??= /* @__PURE__ */ new Set(), t5.patterns.add(n3);
  }), e9._zod.check = (n4) => {
    n4.value.startsWith(t4.prefix) || n4.issues.push({ origin: `string`, code: `invalid_format`, format: `starts_with`, prefix: t4.prefix, input: n4.value, inst: e9, continue: !t4.abort });
  };
});
var Ar = k(`$ZodCheckEndsWith`, (e9, t4) => {
  P.init(e9, t4);
  let n3 = RegExp(`.*${b(t4.suffix)}$`);
  t4.pattern ??= n3, e9._zod.onattach.push((e10) => {
    let t5 = e10._zod.bag;
    t5.patterns ??= /* @__PURE__ */ new Set(), t5.patterns.add(n3);
  }), e9._zod.check = (n4) => {
    n4.value.endsWith(t4.suffix) || n4.issues.push({ origin: `string`, code: `invalid_format`, format: `ends_with`, suffix: t4.suffix, input: n4.value, inst: e9, continue: !t4.abort });
  };
});
function jr(e9, t4, n3) {
  e9.issues.length && t4.issues.push(...T(n3, e9.issues));
}
var Mr = k(`$ZodCheckProperty`, (e9, t4) => {
  P.init(e9, t4), e9._zod.check = (e10) => {
    let n3 = t4.schema._zod.run({ value: e10.value[t4.property], issues: [] }, {});
    if (n3 instanceof Promise) return n3.then((n4) => jr(n4, e10, t4.property));
    jr(n3, e10, t4.property);
  };
});
var Nr = k(`$ZodCheckMimeType`, (e9, t4) => {
  P.init(e9, t4);
  let n3 = new Set(t4.mime);
  e9._zod.onattach.push((e10) => {
    e10._zod.bag.mime = t4.mime;
  }), e9._zod.check = (r2) => {
    n3.has(r2.value.type) || r2.issues.push({ code: `invalid_value`, values: t4.mime, input: r2.value.type, inst: e9, continue: !t4.abort });
  };
});
var Pr = k(`$ZodCheckOverwrite`, (e9, t4) => {
  P.init(e9, t4), e9._zod.check = (e10) => {
    e10.value = t4.tx(e10.value);
  };
});
var Fr = class {
  constructor(e9 = [], t4 = {}) {
    this.content = [], this.indent = 0, this.args = e9, this.closed = t4;
  }
  indented(e9) {
    this.indent += 1, e9(this), --this.indent;
  }
  write(e9) {
    if (typeof e9 == `function`) {
      e9(this, { execution: `sync` }), e9(this, { execution: `async` });
      return;
    }
    let t4 = e9.split(`
`).filter((e10) => e10), n3 = Math.min(...t4.map((e10) => e10.length - e10.trimStart().length)), r2 = t4.map((e10) => e10.slice(n3)).map((e10) => ` `.repeat(this.indent * 2) + e10);
    for (let e10 of r2) this.content.push(e10);
  }
  compile() {
    let e9 = Function, t4 = this?.content ?? [``];
    return new e9(...Object.keys(this.closed), `return function (${this.args.join(`, `)}) {
${t4.join(`
`)}
};`)(...Object.values(this.closed));
  }
};
var Ir = { major: 4, minor: 5, patch: 4 };
var F = k(`$ZodType`, (e9, t4) => {
  var n3;
  e9 ??= {}, e9._zod.def = t4, e9._zod.bag = e9._zod.bag || {}, e9._zod.version = Ir;
  let r2 = e9._zod.def.checks, i3 = e9._zod.traits.has(`$ZodCheck`) ? [e9, ...r2 ?? []] : r2?.length ? [...r2] : [];
  for (let t5 of i3) for (let n4 of t5._zod.onattach) n4(e9);
  if (i3.length === 0) (n3 = e9._zod).deferred ?? (n3.deferred = []), e9._zod.deferred?.push(() => {
    e9._zod.run = e9._zod.parse;
  });
  else {
    let t5 = (t6, n5, r3) => {
      if (t6.memo) return t6;
      let i4 = w(t6), a3;
      for (let o3 of n5) {
        if (o3._zod.def.when) {
          if (Ee(t6) || !o3._zod.def.when(t6)) continue;
        } else if (i4) continue;
        let n6 = t6.issues.length, s3 = o3._zod.check(t6);
        if (s3 instanceof Promise && r3?.async === false) throw new A();
        if (a3 || s3 instanceof Promise) a3 = (a3 ?? Promise.resolve()).then(async () => {
          await s3, t6.issues.length !== n6 && (Oe(t6.issues, n6, e9), i4 ||= w(t6, n6));
        });
        else {
          if (t6.issues.length === n6) continue;
          Oe(t6.issues, n6, e9), i4 ||= w(t6, n6);
        }
      }
      return a3 ? a3.then(() => t6) : t6;
    }, n4 = (n5, r3, a3) => {
      if (w(n5)) return n5.aborted = true, n5;
      let o3 = t5(r3, i3, a3);
      if (o3 instanceof Promise) {
        if (a3.async === false) throw new A();
        return o3.then((t6) => e9._zod.parse(t6, a3));
      }
      return e9._zod.parse(o3, a3);
    };
    e9._zod.run = (r3, a3) => {
      if (a3.skipChecks) return e9._zod.parse(r3, a3);
      if (a3.direction === `backward`) {
        let t6 = e9._zod.parse({ value: r3.value, issues: [] }, { ...a3, skipChecks: true });
        return t6 instanceof Promise ? t6.then((e10) => n4(e10, r3, a3)) : n4(t6, r3, a3);
      }
      let o3 = e9._zod.parse(r3, a3);
      if (o3 instanceof Promise) {
        if (a3.async === false) throw new A();
        return o3.then((e10) => t5(e10, i3, a3));
      }
      return t5(o3, i3, a3);
    };
  }
}, { get "~standard"() {
  return We(this, `~standard`, Rr(this));
}, set "~standard"(e9) {
  Ue(this, `~standard`, e9);
} });
var Lr = (e9) => e9.success ? { value: e9.data } : { issues: e9.error?.issues };
function Rr(e9) {
  return { validate: (t4) => {
    try {
      return Lr(Et(e9, t4));
    } catch {
      return Ot(e9, t4).then(Lr);
    }
  }, vendor: `zod`, version: 1 };
}
var zr = k(`$ZodString`, (e9, t4) => {
  F.init(e9, t4), e9._zod.pattern = [...e9?._zod.bag?.patterns ?? []].pop() ?? Ln(e9._zod.bag), e9._zod.parse = (n3, r2) => {
    if (t4.coerce) try {
      n3.value = String(n3.value);
    } catch {
    }
    return typeof n3.value == `string` || n3.issues.push({ expected: `string`, code: `invalid_type`, input: n3.value, inst: e9 }), n3;
  };
});
var I = k(`$ZodStringFormat`, (e9, t4) => {
  wr.init(e9, t4), zr.init(e9, t4);
});
var Br = k(`$ZodGUID`, (e9, t4) => {
  t4.pattern ??= sn, I.init(e9, t4);
});
var Vr = k(`$ZodUUID`, (e9, t4) => {
  if (t4.version) {
    let e10 = { v1: 1, v2: 2, v3: 3, v4: 4, v5: 5, v6: 6, v7: 7, v8: 8 }[t4.version];
    if (e10 === void 0) throw Error(`Invalid UUID version: "${t4.version}"`);
    t4.pattern ??= cn(e10);
  } else t4.pattern ??= cn();
  I.init(e9, t4);
});
var Hr = k(`$ZodEmail`, (e9, t4) => {
  t4.pattern ??= fn, I.init(e9, t4);
});
function Gr(e9, t4) {
  if (!t4.normalize && t4.protocol?.source === On.source && !/^https?:\/\//i.test(e9)) return 1;
  try {
    return new URL(e9);
  } catch {
    return 2;
  }
}
var Kr = /[\t\n\r]/g;
function qr(e9) {
  return e9.replace(Kr, ``);
}
function Jr(e9, t4) {
  return t4.lastIndex = 0, t4.test(e9.hostname);
}
function Yr(e9, t4) {
  return t4.lastIndex = 0, t4.test(e9.protocol.endsWith(`:`) ? e9.protocol.slice(0, -1) : e9.protocol);
}
var Xr = k(`$ZodURL`, (e9, t4) => {
  I.init(e9, t4), e9._zod.check = (n3) => {
    try {
      let r2 = n3.value.trim(), i3 = Gr(r2, t4);
      if (i3 === 1) {
        n3.issues.push({ code: `invalid_format`, format: `url`, note: `Invalid URL format`, input: n3.value, inst: e9, continue: !t4.abort });
        return;
      }
      if (i3 === 2) {
        n3.issues.push({ code: `invalid_format`, format: `url`, input: n3.value, inst: e9, continue: !t4.abort });
        return;
      }
      t4.hostname && !Jr(i3, t4.hostname) && n3.issues.push({ code: `invalid_format`, format: `url`, note: `Invalid hostname`, pattern: t4.hostname.source, input: n3.value, inst: e9, continue: !t4.abort }), t4.protocol && !Yr(i3, t4.protocol) && n3.issues.push({ code: `invalid_format`, format: `url`, note: `Invalid protocol`, pattern: t4.protocol.source, input: n3.value, inst: e9, continue: !t4.abort }), n3.value = t4.normalize ? i3.href : qr(r2);
      return;
    } catch {
      n3.issues.push({ code: `invalid_format`, format: `url`, input: n3.value, inst: e9, continue: !t4.abort });
    }
  };
});
var Zr = k(`$ZodEmoji`, (e9, t4) => {
  t4.pattern ??= vn(), I.init(e9, t4);
});
var Qr = k(`$ZodNanoID`, (e9, t4) => {
  if (t4.length !== void 0 && (!Number.isInteger(t4.length) || t4.length < 1)) throw Error(`Invalid nanoid length: ${t4.length}`);
  t4.pattern ??= t4.length === void 0 ? nn : rn(t4.length), I.init(e9, t4);
});
var $r = k(`$ZodCUID`, (e9, t4) => {
  t4.pattern ??= Zt, I.init(e9, t4);
});
var ei = k(`$ZodCUID2`, (e9, t4) => {
  t4.pattern ??= Qt, I.init(e9, t4);
});
var ti = k(`$ZodULID`, (e9, t4) => {
  t4.pattern ??= $t, I.init(e9, t4);
});
var ni = k(`$ZodXID`, (e9, t4) => {
  t4.pattern ??= en, I.init(e9, t4);
});
var ri = k(`$ZodKSUID`, (e9, t4) => {
  t4.pattern ??= tn, I.init(e9, t4);
});
var ii = k(`$ZodISODateTime`, (e9, t4) => {
  t4.pattern ??= In(t4), I.init(e9, t4), (t4.local || t4.precision === -1) && (e9._zod.bag.laxFormat = true, e9._zod.onattach.push((e10) => {
    e10._zod.bag.laxFormat = true;
  }));
});
var ai = k(`$ZodISODate`, (e9, t4) => {
  t4.pattern ??= Nn, I.init(e9, t4);
});
var oi = k(`$ZodISOTime`, (e9, t4) => {
  t4.pattern ??= Fn(t4), I.init(e9, t4);
});
var si = k(`$ZodISODuration`, (e9, t4) => {
  t4.pattern ??= an, I.init(e9, t4);
});
var ci = k(`$ZodIPv4`, (e9, t4) => {
  t4.pattern ??= yn, I.init(e9, t4), e9._zod.bag.format = `ipv4`;
});
var li = /^[0-9a-fA-F:.]+$/;
function ui(e9) {
  if (!li.test(e9)) return false;
  try {
    return new URL(`http://[${e9}]`), true;
  } catch {
    return false;
  }
}
var di = k(`$ZodIPv6`, (e9, t4) => {
  t4.pattern ??= bn, I.init(e9, t4), e9._zod.bag.format = `ipv6`, e9._zod.check = (n3) => {
    ui(n3.value) || n3.issues.push({ code: `invalid_format`, format: `ipv6`, input: n3.value, inst: e9, continue: !t4.abort });
  };
});
var fi = k(`$ZodMAC`, (e9, t4) => {
  t4.pattern ??= xn(t4.delimiter), I.init(e9, t4), e9._zod.bag.format = `mac`;
});
var pi = k(`$ZodCIDRv4`, (e9, t4) => {
  t4.pattern ??= Sn, I.init(e9, t4);
});
function mi(e9) {
  let t4 = e9.split(`/`);
  if (t4.length !== 2) return false;
  let [n3, r2] = t4;
  if (!r2) return false;
  let i3 = Number(r2);
  return `${i3}` !== r2 || i3 < 0 || i3 > 128 ? false : ui(n3);
}
var hi = k(`$ZodCIDRv6`, (e9, t4) => {
  t4.pattern ??= Cn, I.init(e9, t4), e9._zod.check = (n3) => {
    mi(n3.value) || n3.issues.push({ code: `invalid_format`, format: `cidrv6`, input: n3.value, inst: e9, continue: !t4.abort });
  };
});
function gi(e9) {
  if (e9 === ``) return true;
  if (/\s/.test(e9) || e9.length % 4 != 0) return false;
  try {
    return atob(e9), true;
  } catch {
    return false;
  }
}
var _i = k(`$ZodBase64`, (e9, t4) => {
  t4.pattern ??= wn, I.init(e9, t4), e9._zod.bag.contentEncoding = `base64`, e9._zod.check = (n3) => {
    gi(n3.value) || n3.issues.push({ code: `invalid_format`, format: `base64`, input: n3.value, inst: e9, continue: !t4.abort });
  };
});
function vi(e9) {
  if (!Tn.test(e9)) return false;
  let t4 = e9.replace(/[-_]/g, (e10) => e10 === `-` ? `+` : `/`);
  return gi(t4.padEnd(Math.ceil(t4.length / 4) * 4, `=`));
}
var yi = k(`$ZodBase64URL`, (e9, t4) => {
  t4.pattern ??= Tn, I.init(e9, t4), e9._zod.bag.contentEncoding = `base64url`, e9._zod.check = (n3) => {
    vi(n3.value) || n3.issues.push({ code: `invalid_format`, format: `base64url`, input: n3.value, inst: e9, continue: !t4.abort });
  };
});
var bi = k(`$ZodE164`, (e9, t4) => {
  t4.pattern ??= kn, I.init(e9, t4);
});
var xi = /[- ]/g;
function Si(e9) {
  let t4 = e9.length, n3 = 1, r2 = 0;
  for (; t4; ) {
    let i3 = +e9[--t4];
    n3 ^= 1, r2 += n3 ? [0, 2, 4, 6, 8, 1, 3, 5, 7, 9][i3] : i3;
  }
  return r2 % 10 == 0;
}
function Ci(e9) {
  return An.test(e9) ? Si(e9.replace(xi, ``)) : false;
}
var wi = k(`$ZodCreditCard`, (e9, t4) => {
  t4.pattern ??= An, I.init(e9, t4), e9._zod.check = (n3) => {
    Ci(n3.value) || n3.issues.push({ code: `invalid_format`, format: `credit_card`, input: n3.value, inst: e9, continue: !t4.abort });
  };
});
function Ti(e9, t4 = null) {
  try {
    let n3 = e9.split(`.`);
    if (n3.length !== 3) return false;
    let [r2] = n3;
    if (!r2) return false;
    let i3 = JSON.parse(atob(r2));
    return !(`typ` in i3 && i3?.typ !== `JWT` || !i3.alg || t4 && (!(`alg` in i3) || i3.alg !== t4));
  } catch {
    return false;
  }
}
var Ei = k(`$ZodJWT`, (e9, t4) => {
  I.init(e9, t4), e9._zod.check = (n3) => {
    Ti(n3.value, t4.alg) || n3.issues.push({ code: `invalid_format`, format: `jwt`, input: n3.value, inst: e9, continue: !t4.abort });
  };
});
var Di = k(`$ZodCustomStringFormat`, (e9, t4) => {
  I.init(e9, t4), e9._zod.check = (n3) => {
    t4.fn(n3.value) || n3.issues.push({ code: `invalid_format`, format: t4.format, input: n3.value, inst: e9, continue: !t4.abort });
  };
});
var Oi = k(`$ZodNumber`, (e9, t4) => {
  F.init(e9, t4), e9._zod.pattern = e9._zod.bag.pattern ?? Bn, e9._zod.parse = (n3, r2) => {
    if (t4.coerce) try {
      n3.value = Number(n3.value);
    } catch {
    }
    let i3 = n3.value;
    if (typeof i3 == `number` && !Number.isNaN(i3) && Number.isFinite(i3)) return n3;
    let a3 = typeof i3 == `number` ? Number.isNaN(i3) ? `NaN` : Number.isFinite(i3) ? void 0 : String(i3) : void 0;
    return n3.issues.push({ expected: `number`, code: `invalid_type`, input: i3, inst: e9, ...a3 ? { received: a3 } : {} }), n3;
  };
});
var ki = k(`$ZodNumberFormat`, (e9, t4) => {
  gr.init(e9, t4), Oi.init(e9, t4);
});
var Ai = k(`$ZodBoolean`, (e9, t4) => {
  F.init(e9, t4), e9._zod.pattern = Vn, e9._zod.parse = (n3, r2) => {
    if (t4.coerce) try {
      n3.value = !!n3.value;
    } catch {
    }
    let i3 = n3.value;
    return typeof i3 == `boolean` || n3.issues.push({ expected: `boolean`, code: `invalid_type`, input: i3, inst: e9 }), n3;
  };
});
var ji = k(`$ZodBigInt`, (e9, t4) => {
  F.init(e9, t4), e9._zod.pattern = Rn, e9._zod.parse = (n3, r2) => {
    if (t4.coerce) try {
      n3.value = BigInt(n3.value);
    } catch {
    }
    return typeof n3.value == `bigint` || n3.issues.push({ expected: `bigint`, code: `invalid_type`, input: n3.value, inst: e9 }), n3;
  };
});
var Mi = k(`$ZodBigIntFormat`, (e9, t4) => {
  _r.init(e9, t4), ji.init(e9, t4);
});
var Ni = k(`$ZodSymbol`, (e9, t4) => {
  F.init(e9, t4), e9._zod.parse = (t5, n3) => {
    let r2 = t5.value;
    return typeof r2 == `symbol` || t5.issues.push({ expected: `symbol`, code: `invalid_type`, input: r2, inst: e9 }), t5;
  };
});
var Pi = k(`$ZodUndefined`, (e9, t4) => {
  F.init(e9, t4), e9._zod.pattern = Un, e9._zod.values = /* @__PURE__ */ new Set([void 0]), e9._zod.parse = (t5, n3) => {
    let r2 = t5.value;
    return r2 === void 0 || t5.issues.push({ expected: `undefined`, code: `invalid_type`, input: r2, inst: e9 }), t5;
  };
});
var Fi = k(`$ZodNull`, (e9, t4) => {
  F.init(e9, t4), e9._zod.pattern = Hn, e9._zod.values = /* @__PURE__ */ new Set([null]), e9._zod.parse = (t5, n3) => {
    let r2 = t5.value;
    return r2 === null || t5.issues.push({ expected: `null`, code: `invalid_type`, input: r2, inst: e9 }), t5;
  };
});
var Ii = k(`$ZodAny`, (e9, t4) => {
  F.init(e9, t4), e9._zod.parse = (e10) => e10;
});
var Li = k(`$ZodUnknown`, (e9, t4) => {
  F.init(e9, t4), e9._zod.parse = (e10) => e10;
});
var Ri = k(`$ZodNever`, (e9, t4) => {
  F.init(e9, t4), e9._zod.parse = (t5, n3) => (t5.issues.push({ expected: `never`, code: `invalid_type`, input: t5.value, inst: e9 }), t5);
});
var zi = k(`$ZodVoid`, (e9, t4) => {
  F.init(e9, t4), e9._zod.parse = (t5, n3) => {
    let r2 = t5.value;
    return r2 === void 0 || t5.issues.push({ expected: `void`, code: `invalid_type`, input: r2, inst: e9 }), t5;
  };
});
var Bi = k(`$ZodDate`, (e9, t4) => {
  F.init(e9, t4), e9._zod.parse = (n3, r2) => {
    if (t4.coerce) try {
      n3.value = new Date(n3.value);
    } catch {
    }
    let i3 = n3.value, a3 = i3 instanceof Date;
    return a3 && !Number.isNaN(i3.getTime()) || n3.issues.push({ expected: `date`, code: `invalid_type`, input: i3, ...a3 ? { received: `Invalid Date` } : {}, inst: e9 }), n3;
  };
});
function Vi(e9, t4, n3) {
  e9.issues.length && t4.issues.push(...T(n3, e9.issues)), t4.value[n3] = e9.value;
}
var Hi = k(`$ZodArray`, (e9, t4) => {
  F.init(e9, t4);
  let n3 = j.memoizer;
  n3?.attach(e9), e9._zod.parse = (r2, i3) => {
    let a3 = r2.value;
    if (!Array.isArray(a3)) return r2.issues.push({ expected: `array`, code: `invalid_type`, input: a3, inst: e9 }), r2;
    r2.value = n3 ? n3.alloc(e9, r2, Array(a3.length), i3) : Array(a3.length);
    let o3 = [];
    for (let e10 = 0; e10 < a3.length; e10++) {
      let n4 = a3[e10], s3 = t4.element._zod.run({ value: n4, issues: [] }, i3);
      s3 instanceof Promise ? o3.push(s3.then((t5) => Vi(t5, r2, e10))) : Vi(s3, r2, e10);
    }
    return o3.length ? Promise.all(o3).then(() => r2) : r2;
  };
});
function Ui(e9, t4, n3, r2, i3, a3) {
  let o3 = n3 in r2, s3 = a3 === `optional`;
  if (o3 || !s3 || i3 !== `optional`) {
    if (e9.issues.length) {
      if (i3 !== void 0 && s3 && !o3) return;
      t4.issues.push(...T(n3, e9.issues));
    }
    if (!o3 && i3 === void 0) {
      e9.issues.length || t4.issues.push({ code: `invalid_type`, expected: `nonoptional`, input: void 0, path: [n3] });
      return;
    }
    e9.value === void 0 ? o3 && (t4.value[n3] = void 0) : t4.value[n3] = e9.value;
  }
}
var Wi = [];
function Gi(e9) {
  let t4 = Object.keys(e9.shape), n3 = Object.getOwnPropertySymbols(e9.shape), r2 = n3.length ? n3 : Wi, i3 = r2.length ? [...t4, ...r2] : t4;
  for (let t5 of i3) if (!e9.shape?.[t5]?._zod?.traits?.has(`$ZodType`)) throw Error(`Invalid element at key "${String(t5)}": expected a Zod schema`);
  let a3 = ge(e9.shape);
  return { ...e9, allKeys: i3, symbolKeys: r2, keySet: new Set(t4), numKeys: t4.length, optionalKeys: new Set(a3) };
}
function Ki(e9, t4, n3, r2, i3, a3) {
  let o3 = [], s3 = i3.keySet, c3 = i3.catchall._zod, l3 = c3.def.type, u3 = c3.optin, d3 = c3.optout;
  for (let i4 in t4) {
    if (s3.has(i4)) continue;
    if (i4 === `__proto__`) {
      l3 === `never` && o3.push(i4);
      continue;
    }
    if (l3 === `never`) {
      o3.push(i4);
      continue;
    }
    let a4 = c3.run({ value: t4[i4], issues: [] }, r2);
    a4 instanceof Promise ? e9.push(a4.then((e10) => Ui(e10, n3, i4, t4, u3, d3))) : Ui(a4, n3, i4, t4, u3, d3);
  }
  return o3.length && n3.issues.push({ code: `unrecognized_keys`, keys: o3, input: t4, inst: a3, continue: true }), e9.length ? Promise.all(e9).then(() => n3) : n3;
}
var qi = /* @__PURE__ */ new WeakMap();
var Ji = k(`$ZodObject`, (e9, t4) => {
  if (F.init(e9, t4), !Object.getOwnPropertyDescriptor(t4, `shape`)?.get) {
    let e10 = t4.shape;
    qi.set(t4, e10), Object.defineProperty(t4, "shape", { get: () => {
      let n4 = { ...e10 };
      return Object.defineProperty(t4, "shape", { value: n4 }), qi.set(t4, n4), n4;
    } });
  }
  let n3 = d(() => Gi(t4));
  O(e9, `propValues`, (e10) => {
    let t5 = e10.def.shape, n4 = {};
    for (let e11 in t5) {
      let r3 = t5[e11]._zod;
      if (r3.values) {
        Object.prototype.hasOwnProperty.call(n4, e11) || g(n4, e11, /* @__PURE__ */ new Set());
        for (let t6 of r3.values) n4[e11].add(t6);
        r3.optin !== void 0 && n4[e11].add(void 0);
      }
    }
    return n4;
  });
  let r2 = ce, i3 = t4.catchall, a3, o3 = j.memoizer;
  o3?.attach(e9), e9._zod.parse = (t5, s3) => {
    a3 ??= n3.value;
    let c3 = t5.value;
    if (!r2(c3)) return t5.issues.push({ expected: `object`, code: `invalid_type`, input: c3, inst: e9 }), t5;
    t5.value = o3 ? o3.alloc(e9, t5, {}, s3) : {};
    let l3 = [], u3 = a3.shape;
    for (let e10 of a3.allKeys) {
      if (e10 === `__proto__`) continue;
      let n4 = u3[e10], r3 = n4._zod.optin, i4 = n4._zod.optout, a4 = n4._zod.run({ value: c3[e10], issues: [] }, s3);
      a4 instanceof Promise ? l3.push(a4.then((n5) => Ui(n5, t5, e10, c3, r3, i4))) : Ui(a4, t5, e10, c3, r3, i4);
    }
    return i3 ? Ki(l3, c3, t5, s3, n3.value, e9) : l3.length ? Promise.all(l3).then(() => t5) : t5;
  };
});
var Yi = k(`$ZodObjectJIT`, (e9, t4) => {
  Ji.init(e9, t4);
  let n3 = e9._zod.parse, r2 = d(() => Gi(t4)), i3 = j.memoizer, a3 = (t5) => {
    let n4 = r2.value, a4 = n4.symbolKeys, o4 = new Fr([`payload`, `ctx`], { shape: t5, inst: e9, memo: i3, syms: a4 }), s4 = (e10) => `shape[${e10}]._zod.run({ value: input[${e10}], issues: [] }, ctx)`, c4 = (e10, t6) => `
          for (let i = 0; i < ${e10}.issues.length; i++) {
            const iss = ${e10}.issues[i];
            iss.path = iss.path ? [${t6}, ...iss.path] : [${t6}];
            payload.issues.push(iss);
          }`;
    o4.write(`const input = payload.value;`);
    let l4 = /* @__PURE__ */ Object.create(null), u4 = 0;
    for (let e10 of n4.allKeys) l4[e10] = `key_${u4++}`;
    o4.write(i3 ? `const newResult = memo.alloc(inst, payload, {}, ctx);` : `const newResult = {};`);
    for (let e10 of n4.allKeys) {
      if (e10 === `__proto__`) continue;
      let n5 = l4[e10], r3 = typeof e10 == `symbol` ? `syms[${a4.indexOf(e10)}]` : v(e10), i4 = `${r3} in input`, u5 = t5[e10], d3 = u5?._zod?.optin, f4 = d3 !== void 0, p3 = u5?._zod?.optout === `optional`;
      if (o4.write(`const ${n5} = ${s4(r3)};`), f4 && p3) {
        let e11 = d3 === `optional` ? `${n5}_present` : `${n5}.value !== undefined || ${n5}_present`;
        o4.write(`
        const ${n5}_present = ${i4};
        if (!${n5}.issues.length || ${n5}_present) {
          if (${n5}.issues.length) {${c4(n5, r3)}
          }

          if (${e11}) {
            newResult[${r3}] = ${n5}.value;
          }
        }

      `);
      } else f4 ? o4.write(`
        if (${n5}.issues.length) {${c4(n5, r3)}
        }
        
        if (${n5}.value === undefined) {
          if (${i4}) {
            newResult[${r3}] = undefined;
          }
        } else {
          newResult[${r3}] = ${n5}.value;
        }

      `) : o4.write(`
        const ${n5}_present = ${i4};
        if (${n5}.issues.length) {${c4(n5, r3)}
        }
        if (!${n5}_present && !${n5}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${r3}]
          });
        }

        if (${n5}_present) {
          newResult[${r3}] = ${n5}.value;
        }

      `);
    }
    return o4.write(`payload.value = newResult;`), o4.write(`return payload;`), o4.compile();
  }, o3, s3 = ce, c3 = !j.jitless, l3 = c3 && le.value, u3 = t4.catchall, f3;
  e9._zod.parse = (i4, d3) => {
    f3 ??= r2.value;
    let p3 = i4.value;
    return s3(p3) ? c3 && l3 && d3?.async === false && d3.jitless !== true ? (o3 ||= a3(t4.shape), i4 = o3(i4, d3), u3 ? Ki([], p3, i4, d3, f3, e9) : i4) : n3(i4, d3) : (i4.issues.push({ expected: `object`, code: `invalid_type`, input: p3, inst: e9 }), i4);
  };
});
function Xi(e9, t4, n3, r2) {
  for (let n4 of e9) if (n4.issues.length === 0) return t4.value = n4.value, t4;
  let i3 = e9.filter((e10) => !w(e10));
  return i3.length === 1 ? (t4.value = i3[0].value, i3[0]) : (t4.issues.push({ code: `invalid_union`, input: t4.value, inst: n3, errors: e9.map((e10) => e10.issues.map((e11) => E(e11, r2, M()))) }), t4);
}
var Zi = k(`$ZodUnion`, (e9, t4) => {
  F.init(e9, t4), O(e9, `optin`, (e10) => e10.def.options.some((e11) => e11._zod.optin === `defaulted`) ? `defaulted` : e10.def.options.some((e11) => e11._zod.optin !== void 0) ? `optional` : void 0), O(e9, `optout`, (e10) => e10.def.options.some((e11) => e11._zod.optout === `optional`) ? `optional` : void 0), O(e9, `values`, (e10) => {
    if (e10.def.options.every((e11) => e11._zod.values)) return new Set(e10.def.options.flatMap((e11) => Array.from(e11._zod.values)));
  }), O(e9, `pattern`, (e10) => {
    if (e10.def.options.every((e11) => e11._zod.pattern)) {
      let t5 = e10.def.options.map((e11) => e11._zod.pattern);
      return RegExp(`^(${t5.map((e11) => p(e11.source)).join(`|`)})$`);
    }
  });
  let n3 = t4.options.length === 1 ? t4.options[0]._zod.run : null;
  e9._zod.parse = (r2, i3) => {
    if (n3) return n3(r2, i3);
    let a3 = false, o3 = [];
    for (let e10 of t4.options) {
      let t5 = e10._zod.run({ value: r2.value, issues: [] }, i3);
      if (t5 instanceof Promise) o3.push(t5), a3 = true;
      else {
        if (t5.issues.length === 0) return t5;
        o3.push(t5);
      }
    }
    return a3 ? Promise.all(o3).then((t5) => Xi(t5, r2, e9, i3)) : Xi(o3, r2, e9, i3);
  };
});
function Qi(e9, t4, n3, r2) {
  let i3 = [];
  for (let t5 = 0; t5 < e9.length; t5++) e9[t5].issues.length === 0 && i3.push(t5);
  return i3.length === 1 ? (t4.value = e9[i3[0]].value, t4) : (i3.length === 0 ? t4.issues.push({ code: `invalid_union`, input: t4.value, inst: n3, errors: e9.map((e10) => e10.issues.map((e11) => E(e11, r2, M()))) }) : t4.issues.push({ code: `invalid_union`, input: t4.value, inst: n3, errors: [], inclusive: false, matches: i3 }), t4);
}
var $i = k(`$ZodXor`, (e9, t4) => {
  Zi.init(e9, t4), t4.inclusive = false;
  let n3 = t4.options.length === 1 ? t4.options[0]._zod.run : null;
  e9._zod.parse = (r2, i3) => {
    if (n3) return n3(r2, i3);
    let a3 = false, o3 = [];
    for (let e10 of t4.options) {
      let t5 = e10._zod.run({ value: r2.value, issues: [] }, i3);
      t5 instanceof Promise ? (o3.push(t5), a3 = true) : o3.push(t5);
    }
    return a3 ? Promise.all(o3).then((t5) => Qi(t5, r2, e9, i3)) : Qi(o3, r2, e9, i3);
  };
});
function ea(e9, t4) {
  let n3 = e9._zod, r2 = n3.bag.optionsMap;
  if (!r2) {
    r2 = /* @__PURE__ */ new Map();
    let { options: e10, discriminator: t5 } = n3.def;
    for (let n4 of e10) for (let e11 of n4._zod.propValues?.[t5] ?? []) r2.has(e11) || r2.set(e11, n4);
    n3.bag.optionsMap = r2;
  }
  return r2.get(t4);
}
var ta = k(`$ZodDiscriminatedUnion`, (e9, t4) => {
  t4.inclusive = false, Zi.init(e9, t4);
  let n3 = e9._zod.parse;
  O(e9, `propValues`, (e10) => {
    let t5 = {};
    for (let n4 of e10.def.options) {
      let r3 = n4._zod.propValues;
      if (!r3 || Object.keys(r3).length === 0) throw Error(`Invalid discriminated union option at index "${e10.def.options.indexOf(n4)}"`);
      for (let [e11, n5] of Object.entries(r3)) {
        Object.prototype.hasOwnProperty.call(t5, e11) || g(t5, e11, /* @__PURE__ */ new Set());
        for (let r4 of n5) t5[e11].add(r4);
      }
    }
    return t5;
  }), t4.options.forEach((e10, n4) => {
    let r3 = qi.get(e10._zod.def);
    if (r3 && !Object.prototype.hasOwnProperty.call(r3, t4.discriminator)) throw Error(`Invalid discriminated union option at index "${n4}"`);
  });
  let r2 = d(() => {
    let e10 = t4.options, n4 = /* @__PURE__ */ new Map();
    for (let r3 of e10) {
      let e11 = r3._zod.propValues?.[t4.discriminator];
      if (!e11 || e11.size === 0) throw Error(`Invalid discriminated union option at index "${t4.options.indexOf(r3)}"`);
      for (let t5 of e11) {
        if (n4.has(t5)) throw Error(`Duplicate discriminator value "${String(t5)}"`);
        n4.set(t5, r3);
      }
    }
    return n4;
  });
  e9._zod.parse = (i3, a3) => {
    let o3 = i3.value;
    if (!ce(o3)) return i3.issues.push({ code: `invalid_type`, expected: `object`, input: o3, inst: e9 }), i3;
    let s3 = r2.value.get(o3?.[t4.discriminator]);
    return s3 ? s3._zod.run(i3, a3) : t4.unionFallback || a3.direction === `backward` ? n3(i3, a3) : (i3.issues.push({ code: `invalid_union`, errors: [], note: `No matching discriminator`, discriminator: t4.discriminator, options: Array.from(r2.value.keys()), input: o3, path: [t4.discriminator], inst: e9 }), i3);
  };
});
var na = k(`$ZodIntersection`, (e9, t4) => {
  F.init(e9, t4), e9._zod.parse = (e10, n3) => {
    let r2 = e10.value, i3 = t4.left._zod.run({ value: r2, issues: [] }, n3), a3 = t4.right._zod.run({ value: r2, issues: [] }, n3);
    return i3 instanceof Promise || a3 instanceof Promise ? Promise.all([i3, a3]).then(([t5, n4]) => ia(e10, t5, n4)) : ia(e10, i3, a3);
  };
});
function ra(e9, t4) {
  if (e9 === t4 || e9 instanceof Date && t4 instanceof Date && +e9 == +t4) return { valid: true, data: e9 };
  if (y(e9) && y(t4)) {
    let n3 = Object.keys(t4), r2 = Object.keys(e9).filter((e10) => n3.indexOf(e10) !== -1), i3 = { ...e9, ...t4 };
    Object.prototype.hasOwnProperty.call(i3, `__proto__`) && delete i3.__proto__;
    for (let n4 of r2) {
      if (n4 === `__proto__`) continue;
      let r3 = ra(e9[n4], t4[n4]);
      if (!r3.valid) return { valid: false, mergeErrorPath: [n4, ...r3.mergeErrorPath] };
      i3[n4] = r3.data;
    }
    return { valid: true, data: i3 };
  }
  if (Array.isArray(e9) && Array.isArray(t4)) {
    if (e9.length !== t4.length) return { valid: false, mergeErrorPath: [] };
    let n3 = [];
    for (let r2 = 0; r2 < e9.length; r2++) {
      let i3 = e9[r2], a3 = t4[r2], o3 = ra(i3, a3);
      if (!o3.valid) return { valid: false, mergeErrorPath: [r2, ...o3.mergeErrorPath] };
      n3.push(o3.data);
    }
    return { valid: true, data: n3 };
  }
  return { valid: false, mergeErrorPath: [] };
}
function ia(e9, t4, n3) {
  let r2 = /* @__PURE__ */ new Map(), i3, a3 = /* @__PURE__ */ new Map(), o3 = (e10, t5) => {
    let n4;
    if (e10.code === `unrecognized_keys` && !e10.path?.length) i3 ??= e10, n4 = e10.keys;
    else if (e10.code === `invalid_key` && e10.origin === `record` && e10.path?.length === 1) {
      let t6 = String(e10.path[0]);
      a3.has(t6) || a3.set(t6, e10), n4 = [t6];
    } else return false;
    for (let e11 of n4) r2.has(e11) || r2.set(e11, {}), r2.get(e11)[t5] = true;
    return true;
  };
  for (let n4 of t4.issues) o3(n4, `l`) || e9.issues.push(n4);
  for (let t5 of n3.issues) o3(t5, `r`) || e9.issues.push(t5);
  let s3 = [...r2].filter(([, e10]) => e10.l && e10.r).map(([e10]) => e10);
  if (s3.length) {
    let t5 = i3 ? s3.filter((e10) => i3.keys.includes(e10)) : [];
    t5.length && e9.issues.push({ ...i3, keys: t5 });
    for (let n4 of s3) !t5.includes(n4) && a3.has(n4) && e9.issues.push(a3.get(n4));
  }
  let c3 = ra(t4.value, n3.value);
  if (!c3.valid) {
    if (w(e9)) return e9;
    throw Error(`Unmergable intersection. Error path: ${JSON.stringify(c3.mergeErrorPath)}`);
  }
  return e9.value = c3.data, e9;
}
var aa = k(`$ZodTuple`, (e9, t4) => {
  F.init(e9, t4);
  let n3 = t4.items, r2 = j.memoizer;
  r2?.attach(e9), e9._zod.parse = (i3, a3) => {
    let o3 = i3.value;
    if (!Array.isArray(o3)) return i3.issues.push({ input: o3, inst: e9, expected: `tuple`, code: `invalid_type` }), i3;
    i3.value = r2 ? r2.alloc(e9, i3, [], a3) : [];
    let s3 = [], c3 = oa(n3, `optin`), l3 = oa(n3, `optout`);
    if (!t4.rest) {
      if (o3.length < c3) return i3.issues.push({ code: `too_small`, minimum: c3, inclusive: true, input: o3, inst: e9, origin: `array` }), i3;
      o3.length > n3.length && i3.issues.push({ code: `too_big`, maximum: n3.length, inclusive: true, input: o3, inst: e9, origin: `array` });
    }
    let u3 = Array(n3.length);
    for (let e10 = 0; e10 < n3.length; e10++) {
      let t5 = n3[e10]._zod.run({ value: o3[e10], issues: [] }, a3);
      t5 instanceof Promise ? s3.push(t5.then((t6) => {
        u3[e10] = t6;
      })) : u3[e10] = t5;
    }
    if (t4.rest) {
      let e10 = n3.length - 1, r3 = o3.slice(n3.length);
      for (let n4 of r3) {
        e10++;
        let r4 = t4.rest._zod.run({ value: n4, issues: [] }, a3);
        r4 instanceof Promise ? s3.push(r4.then((t5) => sa(t5, i3, e10))) : sa(r4, i3, e10);
      }
    }
    return s3.length ? Promise.all(s3).then(() => ca(u3, i3, n3, o3, l3)) : ca(u3, i3, n3, o3, l3);
  };
});
function oa(e9, t4) {
  for (let n3 = e9.length - 1; n3 >= 0; n3--) if (!(t4 === `optin` ? e9[n3]._zod.optin !== void 0 : e9[n3]._zod.optout === `optional`)) return n3 + 1;
  return 0;
}
function sa(e9, t4, n3) {
  e9.issues.length && t4.issues.push(...T(n3, e9.issues)), t4.value[n3] = e9.value;
}
function ca(e9, t4, n3, r2, i3) {
  for (let a3 = 0; a3 < n3.length; a3++) {
    let o3 = e9[a3], s3 = a3 < r2.length;
    if (!s3 && a3 >= i3 && n3[a3]._zod.optin === `optional`) {
      t4.value.length = a3;
      break;
    }
    if (o3.issues.length) {
      if (!s3 && a3 >= i3) {
        t4.value.length = a3;
        break;
      }
      t4.issues.push(...T(a3, o3.issues));
    }
    t4.value[a3] = o3.value;
  }
  for (let e10 = t4.value.length - 1; e10 >= r2.length && n3[e10]._zod.optout === `optional` && t4.value[e10] === void 0; e10--) t4.value.length = e10;
  return t4;
}
var la = k(`$ZodRecord`, (e9, t4) => {
  F.init(e9, t4);
  let n3 = j.memoizer;
  n3?.attach(e9), e9._zod.parse = (r2, i3) => {
    let a3 = r2.value;
    if (!y(a3)) return r2.issues.push({ expected: `record`, code: `invalid_type`, input: a3, inst: e9 }), r2;
    let o3 = [], s3 = t4.keyType._zod.values;
    if (s3 && !t4.partial) {
      r2.value = n3 ? n3.alloc(e9, r2, {}, i3) : {};
      let c3 = /* @__PURE__ */ new Set();
      for (let n4 of s3) if (typeof n4 == `string` || typeof n4 == `number` || typeof n4 == `symbol`) {
        if (c3.add(typeof n4 == `number` ? n4.toString() : n4), n4 === `__proto__`) continue;
        let s4 = t4.keyType._zod.run({ value: n4, issues: [] }, i3);
        if (s4 instanceof Promise) throw Error(`Async schemas not supported in object keys currently`);
        if (s4.issues.length) {
          r2.issues.push({ code: `invalid_key`, origin: `record`, issues: s4.issues.map((e10) => E(e10, i3, M())), input: n4, path: [n4], inst: e9 });
          continue;
        }
        let l4 = s4.value;
        if (l4 === `__proto__`) continue;
        let u3 = t4.valueType._zod.run({ value: a3[n4], issues: [] }, i3);
        u3 instanceof Promise ? o3.push(u3.then((e10) => {
          e10.issues.length && r2.issues.push(...T(n4, e10.issues)), r2.value[l4] = e10.value;
        })) : (u3.issues.length && r2.issues.push(...T(n4, u3.issues)), r2.value[l4] = u3.value);
      }
      let l3;
      for (let e10 in a3) if (!c3.has(e10)) {
        if (t4.mode === `loose`) {
          if (e10 === `__proto__`) continue;
          r2.value[e10] = a3[e10];
        } else l3 ??= [], l3.push(e10);
      }
      l3 && l3.length > 0 && r2.issues.push({ code: `unrecognized_keys`, input: a3, inst: e9, keys: l3, continue: true });
    } else {
      r2.value = n3 ? n3.alloc(e9, r2, {}, i3) : {};
      let c3;
      for (let n4 of Reflect.ownKeys(a3)) {
        if (n4 === `__proto__` || !Object.prototype.propertyIsEnumerable.call(a3, n4)) continue;
        let l3 = t4.keyType._zod.run({ value: n4, issues: [] }, i3);
        if (l3 instanceof Promise) throw Error(`Async schemas not supported in object keys currently`);
        if (typeof n4 == `string` && Bn.test(n4) && l3.issues.length) {
          let e10 = t4.keyType._zod.run({ value: Number(n4), issues: [] }, i3);
          if (e10 instanceof Promise) throw Error(`Async schemas not supported in object keys currently`);
          e10.issues.length === 0 && (l3 = e10);
        }
        if (l3.issues.length) {
          t4.mode === `loose` ? r2.value[n4] = a3[n4] : s3 ? (c3 ??= [], c3.push(n4)) : r2.issues.push({ code: `invalid_key`, origin: `record`, issues: l3.issues.map((e10) => E(e10, i3, M())), input: n4, path: [n4], inst: e9 });
          continue;
        }
        let u3 = l3.value;
        if (u3 === `__proto__`) continue;
        let d3 = t4.valueType._zod.run({ value: a3[n4], issues: [] }, i3);
        d3 instanceof Promise ? o3.push(d3.then((e10) => {
          e10.issues.length && r2.issues.push(...T(n4, e10.issues)), r2.value[u3] = e10.value;
        })) : (d3.issues.length && r2.issues.push(...T(n4, d3.issues)), r2.value[u3] = d3.value);
      }
      c3 && c3.length > 0 && r2.issues.push({ code: `unrecognized_keys`, input: a3, inst: e9, keys: c3, continue: true });
    }
    return o3.length ? Promise.all(o3).then(() => r2) : r2;
  };
});
var ua = k(`$ZodMap`, (e9, t4) => {
  F.init(e9, t4);
  let n3 = j.memoizer;
  n3?.attach(e9), e9._zod.parse = (r2, i3) => {
    let a3 = r2.value;
    if (!(a3 instanceof Map)) return r2.issues.push({ expected: `map`, code: `invalid_type`, input: a3, inst: e9 }), r2;
    let o3 = [];
    r2.value = n3 ? n3.alloc(e9, r2, /* @__PURE__ */ new Map(), i3) : /* @__PURE__ */ new Map();
    for (let [n4, s3] of a3) {
      let c3 = t4.keyType._zod.run({ value: n4, issues: [] }, i3), l3 = t4.valueType._zod.run({ value: s3, issues: [] }, i3);
      c3 instanceof Promise || l3 instanceof Promise ? o3.push(Promise.all([c3, l3]).then(([t5, o4]) => {
        da(t5, o4, r2, n4, a3, e9, i3);
      })) : da(c3, l3, r2, n4, a3, e9, i3);
    }
    return o3.length ? Promise.all(o3).then(() => r2) : r2;
  };
});
function da(e9, t4, n3, r2, i3, a3, o3) {
  e9.issues.length && (pe.has(typeof r2) ? n3.issues.push(...T(r2, e9.issues)) : n3.issues.push({ code: `invalid_key`, origin: `map`, input: i3, inst: a3, issues: e9.issues.map((e10) => E(e10, o3, M())) })), t4.issues.length && (pe.has(typeof r2) ? n3.issues.push(...T(r2, t4.issues)) : n3.issues.push({ origin: `map`, code: `invalid_element`, input: i3, inst: a3, key: r2, issues: t4.issues.map((e10) => E(e10, o3, M())) })), n3.value.set(e9.value, t4.value);
}
var fa = k(`$ZodSet`, (e9, t4) => {
  F.init(e9, t4);
  let n3 = j.memoizer;
  n3?.attach(e9), e9._zod.parse = (r2, i3) => {
    let a3 = r2.value;
    if (!(a3 instanceof Set)) return r2.issues.push({ input: a3, inst: e9, expected: `set`, code: `invalid_type` }), r2;
    let o3 = [];
    r2.value = n3 ? n3.alloc(e9, r2, /* @__PURE__ */ new Set(), i3) : /* @__PURE__ */ new Set();
    for (let e10 of a3) {
      let n4 = t4.valueType._zod.run({ value: e10, issues: [] }, i3);
      n4 instanceof Promise ? o3.push(n4.then((e11) => pa(e11, r2))) : pa(n4, r2);
    }
    return o3.length ? Promise.all(o3).then(() => r2) : r2;
  };
});
function pa(e9, t4) {
  e9.issues.length && t4.issues.push(...e9.issues), t4.value.add(e9.value);
}
var ma = k(`$ZodEnum`, (e9, t4) => {
  F.init(e9, t4);
  let n3 = c(t4.entries), r2 = new Set(n3);
  e9._zod.values = r2;
  let i3 = n3.filter((e10) => pe.has(typeof e10));
  e9._zod.pattern = RegExp(i3.length ? `^(${i3.map((e10) => b(e10.toString())).join(`|`)})$` : `^[^\\s\\S]$`), e9._zod.parse = (t5, i4) => {
    let a3 = t5.value;
    return r2.has(a3) || t5.issues.push({ code: `invalid_value`, values: n3, input: a3, inst: e9 }), t5;
  };
});
var ha = k(`$ZodLiteral`, (e9, t4) => {
  F.init(e9, t4);
  let n3 = new Set(t4.values);
  e9._zod.values = n3, e9._zod.pattern = RegExp(t4.values.length ? `^(${t4.values.map((e10) => typeof e10 == `string` ? b(e10) : e10 ? b(e10.toString()) : String(e10)).join(`|`)})$` : `^[^\\s\\S]$`), e9._zod.parse = (r2, i3) => {
    let a3 = r2.value;
    return n3.has(a3) || r2.issues.push({ code: `invalid_value`, values: t4.values, input: a3, inst: e9 }), r2;
  };
});
var ga = k(`$ZodFile`, (e9, t4) => {
  F.init(e9, t4), e9._zod.parse = (t5, n3) => {
    let r2 = t5.value;
    return r2 instanceof File || t5.issues.push({ expected: `file`, code: `invalid_type`, input: r2, inst: e9 }), t5;
  };
});
var _a = k(`$ZodTransform`, (e9, t4) => {
  F.init(e9, t4), e9._zod.optin = `optional`, j.memoizer?.guard(e9), e9._zod.parse = (n3, r2) => {
    if (r2.direction === `backward`) throw new at(e9.constructor.name);
    let i3 = t4.transform(n3.value, n3);
    if (r2.async) return (i3 instanceof Promise ? i3 : Promise.resolve(i3)).then((e10) => (n3.value = e10, n3));
    if (i3 instanceof Promise) throw new A();
    return n3.value = i3, n3;
  };
});
function va(e9, t4) {
  return e9.value = t4.issues.length ? void 0 : t4.value, e9;
}
var ya = k(`$ZodOptional`, (e9, t4) => {
  F.init(e9, t4), O(e9, `optin`, (e10) => e10.def.innerType._zod.optin === `defaulted` ? `defaulted` : `optional`), e9._zod.optout = `optional`, O(e9, `values`, (e10) => {
    let t5 = e10.def.innerType._zod.values;
    return t5 ? /* @__PURE__ */ new Set([...t5, void 0]) : void 0;
  }), O(e9, `pattern`, (e10) => {
    let t5 = e10.def.innerType._zod.pattern;
    return t5 ? RegExp(`^(${p(t5.source)})?$`) : void 0;
  }), e9._zod.parse = (e10, n3) => {
    if (e10.value === void 0) {
      if (t4.innerType._zod.optin !== `defaulted`) return e10;
      let r2 = t4.innerType._zod.run({ value: e10.value, issues: [] }, n3);
      return r2 instanceof Promise ? r2.then((t5) => va(e10, t5)) : va(e10, r2);
    }
    return t4.innerType._zod.run(e10, n3);
  };
});
var ba = k(`$ZodExactOptional`, (e9, t4) => {
  ya.init(e9, t4), O(e9, `values`, (e10) => e10.def.innerType._zod.values), O(e9, `pattern`, (e10) => e10.def.innerType._zod.pattern), e9._zod.parse = (e10, n3) => t4.innerType._zod.run(e10, n3);
});
var xa = k(`$ZodNullable`, (e9, t4) => {
  F.init(e9, t4), O(e9, `optin`, (e10) => e10.def.innerType._zod.optin), O(e9, `optout`, (e10) => e10.def.innerType._zod.optout), O(e9, `pattern`, (e10) => {
    let t5 = e10.def.innerType._zod.pattern;
    return t5 ? RegExp(`^(${p(t5.source)}|null)$`) : void 0;
  }), O(e9, `values`, (e10) => e10.def.innerType._zod.values ? /* @__PURE__ */ new Set([...e10.def.innerType._zod.values, null]) : void 0), e9._zod.parse = (e10, n3) => e10.value === null ? e10 : t4.innerType._zod.run(e10, n3);
});
var Sa = k(`$ZodDefault`, (e9, t4) => {
  F.init(e9, t4), e9._zod.optin = `defaulted`, O(e9, `values`, (e10) => e10.def.innerType._zod.values), e9._zod.parse = (e10, n3) => {
    if (n3.direction === `backward`) return t4.innerType._zod.run(e10, n3);
    if (e10.value === void 0) return e10.value = t4.defaultValue, e10;
    let r2 = t4.innerType._zod.run(e10, n3);
    return r2 instanceof Promise ? r2.then((e11) => Ca(e11, t4)) : Ca(r2, t4);
  };
});
function Ca(e9, t4) {
  return e9.value === void 0 && (e9.value = t4.defaultValue), e9;
}
var wa = k(`$ZodPrefault`, (e9, t4) => {
  F.init(e9, t4), e9._zod.optin = `defaulted`, O(e9, `values`, (e10) => e10.def.innerType._zod.values), e9._zod.parse = (e10, n3) => (n3.direction === `backward` || e10.value === void 0 && (e10.value = t4.defaultValue), t4.innerType._zod.run(e10, n3));
});
var Ta = k(`$ZodNonOptional`, (e9, t4) => {
  F.init(e9, t4), O(e9, `values`, (e10) => {
    let t5 = e10.def.innerType._zod.values;
    return t5 ? new Set([...t5].filter((e11) => e11 !== void 0)) : void 0;
  }), e9._zod.parse = (n3, r2) => {
    let i3 = t4.innerType._zod.run(n3, r2);
    return i3 instanceof Promise ? i3.then((t5) => Ea(t5, e9)) : Ea(i3, e9);
  };
});
function Ea(e9, t4) {
  return !e9.issues.length && e9.value === void 0 && e9.issues.push({ code: `invalid_type`, expected: `nonoptional`, input: e9.value, inst: t4 }), e9;
}
var Da = k(`$ZodSuccess`, (e9, t4) => {
  F.init(e9, t4), e9._zod.parse = (e10, n3) => {
    if (n3.direction === `backward`) throw new at(`ZodSuccess`);
    let r2 = t4.innerType._zod.run(e10, n3);
    return r2 instanceof Promise ? r2.then((t5) => (e10.value = t5.issues.length === 0, e10)) : (e10.value = r2.issues.length === 0, e10);
  };
});
function Oa(e9, t4, n3, r2) {
  return t4.issues.length ? (e9.value = n3.catchValue({ ...t4, value: e9.value, error: { issues: t4.issues.map((e10) => E(e10, r2, M())) }, input: e9.value }), e9) : (e9.value = t4.value, t4.memo && (e9.memo = true), e9);
}
var ka = k(`$ZodCatch`, (e9, t4) => {
  F.init(e9, t4), O(e9, `optin`, (e10) => e10.def.innerType._zod.optin === `defaulted` ? `defaulted` : `optional`), O(e9, `optout`, (e10) => e10.def.innerType._zod.optout), O(e9, `values`, (e10) => e10.def.innerType._zod.values), e9._zod.parse = (e10, n3) => {
    if (n3.direction === `backward`) return t4.innerType._zod.run(e10, n3);
    let r2 = t4.innerType._zod.run({ value: e10.value, issues: [] }, n3);
    return r2 instanceof Promise ? r2.then((r3) => Oa(e10, r3, t4, n3)) : Oa(e10, r2, t4, n3);
  };
});
var Aa = k(`$ZodNaN`, (e9, t4) => {
  F.init(e9, t4), e9._zod.parse = (t5, n3) => ((typeof t5.value != `number` || !Number.isNaN(t5.value)) && t5.issues.push({ input: t5.value, inst: e9, expected: `nan`, code: `invalid_type` }), t5);
});
var ja = k(`$ZodPipe`, (e9, t4) => {
  F.init(e9, t4), O(e9, `values`, (e10) => e10.def.in._zod.values), O(e9, `optin`, (e10) => e10.def.in._zod.optin), O(e9, `optout`, (e10) => e10.def.out._zod.optout), O(e9, `propValues`, (e10) => e10.def.in._zod.propValues), e9._zod.parse = (e10, n3) => {
    if (n3.direction === `backward`) {
      let r3 = t4.out._zod.run(e10, n3);
      return r3 instanceof Promise ? r3.then((e11) => Ma(e11, t4.in, n3)) : Ma(r3, t4.in, n3);
    }
    let r2 = t4.in._zod.run(e10, n3);
    return r2 instanceof Promise ? r2.then((e11) => Ma(e11, t4.out, n3)) : Ma(r2, t4.out, n3);
  };
});
function Ma(e9, t4, n3) {
  return e9.issues.some((e10) => e10.code !== `unrecognized_keys`) ? (e9.aborted = true, e9) : t4._zod.run({ value: e9.value, issues: e9.issues }, n3);
}
var Na = k(`$ZodCodec`, (e9, t4) => {
  F.init(e9, t4), O(e9, `values`, (e10) => e10.def.in._zod.values), O(e9, `optin`, (e10) => e10.def.in._zod.optin), O(e9, `optout`, (e10) => e10.def.out._zod.optout), O(e9, `propValues`, (e10) => e10.def.in._zod.propValues), e9._zod.parse = (e10, n3) => {
    if ((n3.direction || `forward`) === `forward`) {
      let r2 = t4.in._zod.run(e10, n3);
      return r2 instanceof Promise ? r2.then((e11) => Pa(e11, t4, n3)) : Pa(r2, t4, n3);
    }
    {
      let r2 = t4.out._zod.run(e10, n3);
      return r2 instanceof Promise ? r2.then((e11) => Pa(e11, t4, n3)) : Pa(r2, t4, n3);
    }
  };
});
function Pa(e9, t4, n3) {
  if (e9.issues.length) return e9.aborted = true, e9;
  if ((n3.direction || `forward`) === `forward`) {
    let r2 = t4.transform(e9.value, e9);
    return r2 instanceof Promise ? r2.then((r3) => Fa(e9, r3, t4.out, n3)) : Fa(e9, r2, t4.out, n3);
  }
  {
    let r2 = t4.reverseTransform(e9.value, e9);
    return r2 instanceof Promise ? r2.then((r3) => Fa(e9, r3, t4.in, n3)) : Fa(e9, r2, t4.in, n3);
  }
}
function Fa(e9, t4, n3, r2) {
  return e9.issues.length ? (e9.aborted = true, e9) : n3._zod.run({ value: t4, issues: e9.issues }, r2);
}
var Ia = k(`$ZodPreprocess`, (e9, t4) => {
  ja.init(e9, t4);
});
var La = k(`$ZodReadonly`, (e9, t4) => {
  F.init(e9, t4), O(e9, `propValues`, (e10) => e10.def.innerType._zod.propValues), O(e9, `values`, (e10) => e10.def.innerType._zod.values), O(e9, `optin`, (e10) => e10.def.innerType?._zod?.optin), O(e9, `optout`, (e10) => e10.def.innerType?._zod?.optout), e9._zod.parse = (e10, n3) => {
    if (n3.direction === `backward`) return t4.innerType._zod.run(e10, n3);
    let r2 = t4.innerType._zod.run(e10, n3);
    return r2 instanceof Promise ? r2.then(Ra) : Ra(r2);
  };
});
function Ra(e9) {
  return e9.memo || (e9.value = Object.freeze(e9.value)), e9;
}
var za = k(`$ZodTemplateLiteral`, (e9, t4) => {
  F.init(e9, t4);
  let n3 = [];
  for (let e10 of t4.parts) if (typeof e10 == `object` && e10) {
    if (!e10._zod.pattern) throw Error(`Invalid template literal part, no pattern found: ${[...e10._zod.traits].shift()}`);
    let t5 = e10._zod.pattern instanceof RegExp ? e10._zod.pattern.source : e10._zod.pattern;
    if (!t5) throw Error(`Invalid template literal part: ${e10._zod.traits}`);
    let r2 = +!!t5.startsWith(`^`), i3 = t5.endsWith(`$`) ? t5.length - 1 : t5.length;
    n3.push(t5.slice(r2, i3));
  } else if (e10 === null || me.has(typeof e10)) n3.push(b(`${e10}`));
  else throw Error(`Invalid template literal part: ${e10}`);
  e9._zod.pattern = RegExp(`^${n3.join(``)}$`), e9._zod.parse = (n4, r2) => typeof n4.value == `string` ? (e9._zod.pattern.lastIndex = 0, e9._zod.pattern.test(n4.value) || n4.issues.push({ input: n4.value, inst: e9, code: `invalid_format`, format: t4.format ?? `template_literal`, pattern: e9._zod.pattern.source }), n4) : (n4.issues.push({ input: n4.value, inst: e9, expected: `string`, code: `invalid_type` }), n4);
});
var Ba = k(`$ZodFunction`, (e9, t4) => (F.init(e9, t4), Object.defineProperty(e9, "_def", { value: t4 }), e9._zod.def = t4, e9.implement = (t5) => {
  if (typeof t5 != `function`) throw Error(`implement() must be called with a function`);
  return Object.defineProperty(function(...n3) {
    let r2 = e9._def.input ? St(e9._def.input, n3) : n3, i3 = Reflect.apply(t5, this, r2);
    return e9._def.output ? St(e9._def.output, i3) : i3;
  }, "_zod", { value: e9._zod, enumerable: false });
}, e9.implementAsync = (t5) => {
  if (typeof t5 != `function`) throw Error(`implementAsync() must be called with a function`);
  return Object.defineProperty(async function(...n3) {
    let r2 = e9._def.input ? await wt(e9._def.input, n3) : n3, i3 = await Reflect.apply(t5, this, r2);
    return e9._def.output ? await wt(e9._def.output, i3) : i3;
  }, "_zod", { value: e9._zod, enumerable: false });
}, e9._zod.parse = (t5, n3) => typeof t5.value == `function` ? (t5.value = e9._def.output && e9._def.output._zod.def.type === `promise` ? e9.implementAsync(t5.value) : e9.implement(t5.value), t5) : (t5.issues.push({ code: `invalid_type`, expected: `function`, input: t5.value, inst: e9 }), t5), e9.input = (...t5) => {
  let n3 = e9.constructor;
  return Array.isArray(t5[0]) ? new n3({ type: `function`, input: new aa({ type: `tuple`, items: t5[0], rest: t5[1] }), output: e9._def.output }) : new n3({ type: `function`, input: t5[0], output: e9._def.output });
}, e9.output = (t5) => {
  let n3 = e9.constructor;
  return new n3({ type: `function`, input: e9._def.input, output: t5 });
}, e9));
var Va = k(`$ZodPromise`, (e9, t4) => {
  F.init(e9, t4), e9._zod.parse = (e10, n3) => Promise.resolve(e10.value).then((e11) => t4.innerType._zod.run({ value: e11, issues: [] }, n3));
});
var Ha = k(`$ZodLazy`, (e9, t4) => {
  F.init(e9, t4), h(e9._zod, `innerType`, () => {
    let e10 = t4;
    return e10._cachedInner ||= t4.getter(), e10._cachedInner;
  }), O(e9, `pattern`, (e10) => e10.innerType?._zod?.pattern), O(e9, `propValues`, (e10) => e10.innerType?._zod?.propValues), O(e9, `optin`, (e10) => e10.innerType?._zod?.optin ?? void 0), O(e9, `optout`, (e10) => e10.innerType?._zod?.optout ?? void 0), e9._zod.parse = (t5, n3) => e9._zod.innerType._zod.run(t5, n3);
});
var Ua = k(`$ZodCustom`, (e9, t4) => {
  P.init(e9, t4), F.init(e9, t4), e9._zod.parse = (e10, t5) => e10, e9._zod.check = (n3) => {
    let r2 = n3.value, i3 = t4.fn(r2);
    if (i3 instanceof Promise) return i3.then((t5) => Wa(t5, n3, r2, e9));
    Wa(i3, n3, r2, e9);
  };
});
function Wa(e9, t4, n3, r2) {
  if (!e9) {
    let e10 = { code: `custom`, input: n3, inst: r2, path: [...r2._zod.def.path ?? []], continue: !r2._zod.def.abort };
    r2._zod.def.params && (e10.params = r2._zod.def.params), t4.issues.push(Ne(e10));
  }
}
var Ga = class extends Error {
  constructor() {
    super(`Cannot parse a reference cycle that closes through a transform`), this.name = `ZodCyclicError`;
  }
};
var Ka = `~memo`;
var qa = [];
function Ja(e9) {
  return e9.map((e10) => e10.path ? { ...e10, path: e10.path.slice() } : { ...e10 });
}
var Ya = /* @__PURE__ */ new WeakMap();
function Xa(e9, t4) {
  let n3 = Ya.get(e9);
  if (n3 !== void 0) return n3;
  if (t4.has(e9)) return true;
  t4.add(e9);
  let r2 = false, i3 = (e10) => {
    !r2 && e10?._zod && Xa(e10, t4) && (r2 = true);
  }, a3 = e9._zod.def;
  switch (a3.type) {
    case `object`:
      for (let e10 of Reflect.ownKeys(a3.shape)) i3(a3.shape[e10]);
      i3(a3.catchall);
      break;
    case `array`:
      i3(a3.element);
      break;
    case `tuple`:
      for (let e10 of a3.items) i3(e10);
      i3(a3.rest);
      break;
    case `record`:
    case `map`:
      i3(a3.keyType), i3(a3.valueType);
      break;
    case `set`:
      i3(a3.valueType);
      break;
    case `union`:
      for (let e10 of a3.options) i3(e10);
      break;
    case `intersection`:
      i3(a3.left), i3(a3.right);
      break;
    case `optional`:
    case `nullable`:
    case `default`:
    case `prefault`:
    case `catch`:
    case `readonly`:
    case `nonoptional`:
    case `promise`:
    case `success`:
      i3(a3.innerType);
      break;
    case `pipe`:
      i3(a3.in), i3(a3.out);
      break;
    case `function`:
      i3(a3.input), i3(a3.output);
      break;
    case `lazy`:
      i3(e9._zod.innerType);
      break;
    case `template_literal`:
    case `string`:
    case `number`:
    case `int`:
    case `boolean`:
    case `bigint`:
    case `symbol`:
    case `undefined`:
    case `null`:
    case `void`:
    case `never`:
    case `any`:
    case `unknown`:
    case `date`:
    case `nan`:
    case `enum`:
    case `literal`:
    case `file`:
    case `transform`:
    case `custom`:
      break;
    default:
      for (let e10 in a3) {
        let t5 = Object.getOwnPropertyDescriptor(a3, e10);
        if (!t5 || t5.get) continue;
        let n4 = t5.value;
        if (n4 && typeof n4 == `object`) {
          if (n4._zod) i3(n4);
          else if (Array.isArray(n4)) for (let e11 of n4) i3(e11);
        }
      }
  }
  return t4.delete(e9), Ya.set(e9, r2), r2;
}
function Za(e9) {
  return Xa(e9, /* @__PURE__ */ new Set());
}
function Qa(e9, t4) {
  let n3 = e9.buckets.get(t4);
  return n3 || (n3 = /* @__PURE__ */ new Map(), e9.buckets.set(t4, n3)), n3;
}
var $a;
var eo = [];
var to = { alloc(e9, t4, n3) {
  let r2 = $a;
  if (!r2) return n3;
  $a = void 0;
  let i3 = { value: n3, issues: null };
  return r2.set(t4.value, i3), eo.push(i3), n3;
}, guard(e9) {
  var t4;
  (t4 = e9._zod).deferred ?? (t4.deferred = []), e9._zod.deferred.push(() => {
    let t5 = e9._zod.parse, n3 = (e10, n4) => {
      if (n4.direction !== `backward` && ro(n4, e10.value)) throw new Ga();
      return t5(e10, n4);
    };
    e9._zod.parse = n3, e9._zod.run === t5 && (e9._zod.run = n3);
  });
}, attach(e9) {
  var t4;
  let n3, r2, i3;
  (t4 = e9._zod).deferred ?? (t4.deferred = []), e9._zod.deferred.push(() => {
    let t5 = e9._zod.parse, a3 = (o3, s3) => {
      if (n3 === void 0 && (n3 = Xa(e9, /* @__PURE__ */ new Set()), !n3)) return e9._zod.parse = t5, e9._zod.run === a3 && (e9._zod.run = t5), t5(o3, s3);
      let c3 = o3.value;
      if (typeof c3 != `object` || !c3) return t5(o3, s3);
      let l3 = s3[Ka];
      l3 || (l3 = { buckets: /* @__PURE__ */ new Map(), backEdges: void 0 }, s3[Ka] = l3);
      let u3;
      r2 === s3 ? u3 = i3 : (u3 = Qa(l3, e9), r2 = s3, i3 = u3);
      let d3 = u3.get(c3);
      if (d3) return o3.value = d3.value, d3.issues ? d3.issues.length && o3.issues.push(...Ja(d3.issues)) : (o3.memo = true, l3.backEdges ?? (l3.backEdges = /* @__PURE__ */ new Set()), l3.backEdges.add(d3.value)), o3;
      $a = u3;
      let f3 = eo.length, p3 = t5(o3, s3);
      $a = void 0;
      let m3 = eo.length > f3 ? eo.pop() : void 0;
      return p3 instanceof Promise ? p3.then((e10) => (m3 && (m3.issues = e10.issues.length ? Ja(e10.issues) : qa), e10)) : (m3 && (m3.issues = p3.issues.length ? Ja(p3.issues) : qa), p3);
    };
    e9._zod.parse = a3, e9._zod.run === t5 && (e9._zod.run = a3);
  });
} };
function no() {
  return to;
}
function ro(e9, t4) {
  let n3 = e9[Ka]?.backEdges;
  return n3 !== void 0 && typeof t4 == `object` && !!t4 && n3.has(t4);
}
var io = () => {
  let e9 = { string: { unit: `\u062D\u0631\u0641`, verb: `\u0623\u0646 \u064A\u062D\u0648\u064A` }, file: { unit: `\u0628\u0627\u064A\u062A`, verb: `\u0623\u0646 \u064A\u062D\u0648\u064A` }, array: { unit: `\u0639\u0646\u0635\u0631`, verb: `\u0623\u0646 \u064A\u062D\u0648\u064A` }, set: { unit: `\u0639\u0646\u0635\u0631`, verb: `\u0623\u0646 \u064A\u062D\u0648\u064A` }, map: { unit: `\u0639\u0646\u0635\u0631`, verb: `\u0623\u0646 \u064A\u062D\u0648\u064A` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0645\u062F\u062E\u0644`, email: `\u0628\u0631\u064A\u062F \u0625\u0644\u0643\u062A\u0631\u0648\u0646\u064A`, url: `\u0631\u0627\u0628\u0637`, emoji: `\u0625\u064A\u0645\u0648\u062C\u064A`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `\u062A\u0627\u0631\u064A\u062E \u0648\u0648\u0642\u062A \u0628\u0645\u0639\u064A\u0627\u0631 ISO`, date: `\u062A\u0627\u0631\u064A\u062E \u0628\u0645\u0639\u064A\u0627\u0631 ISO`, time: `\u0648\u0642\u062A \u0628\u0645\u0639\u064A\u0627\u0631 ISO`, duration: `\u0645\u062F\u0629 \u0628\u0645\u0639\u064A\u0627\u0631 ISO`, ipv4: `\u0639\u0646\u0648\u0627\u0646 IPv4`, ipv6: `\u0639\u0646\u0648\u0627\u0646 IPv6`, mac: `\u0639\u0646\u0648\u0627\u0646 MAC`, cidrv4: `\u0645\u062F\u0649 \u0639\u0646\u0627\u0648\u064A\u0646 \u0628\u0635\u064A\u063A\u0629 IPv4`, cidrv6: `\u0645\u062F\u0649 \u0639\u0646\u0627\u0648\u064A\u0646 \u0628\u0635\u064A\u063A\u0629 IPv6`, base64: `\u0646\u064E\u0635 \u0628\u062A\u0631\u0645\u064A\u0632 base64-encoded`, base64url: `\u0646\u064E\u0635 \u0628\u062A\u0631\u0645\u064A\u0632 base64url-encoded`, json_string: `\u0646\u064E\u0635 \u0639\u0644\u0649 \u0647\u064A\u0626\u0629 JSON`, e164: `\u0631\u0642\u0645 \u0647\u0627\u062A\u0641 \u0628\u0645\u0639\u064A\u0627\u0631 E.164`, credit_card: `\u0631\u0642\u0645 \u0628\u0637\u0627\u0642\u0629 \u0627\u0644\u0627\u0626\u062A\u0645\u0627\u0646`, jwt: `JWT`, template_literal: `\u0645\u062F\u062E\u0644` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u0645\u062F\u062E\u0644\u0627\u062A \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644\u0629: \u064A\u0641\u062A\u0631\u0636 \u0625\u062F\u062E\u0627\u0644 instanceof ${e10.expected}\u060C \u0648\u0644\u0643\u0646 \u062A\u0645 \u0625\u062F\u062E\u0627\u0644 ${i3}` : `\u0645\u062F\u062E\u0644\u0627\u062A \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644\u0629: \u064A\u0641\u062A\u0631\u0636 \u0625\u062F\u062E\u0627\u0644 ${t5}\u060C \u0648\u0644\u0643\u0646 \u062A\u0645 \u0625\u062F\u062E\u0627\u0644 ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u0645\u062F\u062E\u0644\u0627\u062A \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644\u0629: \u064A\u0641\u062A\u0631\u0636 \u0625\u062F\u062E\u0627\u0644 ${C(e10.values[0])}` : `\u0627\u062E\u062A\u064A\u0627\u0631 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062A\u0648\u0642\u0639 \u0627\u0646\u062A\u0642\u0627\u0621 \u0623\u062D\u062F \u0647\u0630\u0647 \u0627\u0644\u062E\u064A\u0627\u0631\u0627\u062A: ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? ` \u0623\u0643\u0628\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0623\u0646 \u062A\u0643\u0648\u0646 ${e10.origin ?? `\u0627\u0644\u0642\u064A\u0645\u0629`} ${n4} ${e10.maximum.toString()} ${r3.unit ?? `\u0639\u0646\u0635\u0631`}` : `\u0623\u0643\u0628\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0623\u0646 \u062A\u0643\u0648\u0646 ${e10.origin ?? `\u0627\u0644\u0642\u064A\u0645\u0629`} ${n4} ${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u0623\u0635\u063A\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0644\u0640 ${e10.origin} \u0623\u0646 \u064A\u0643\u0648\u0646 ${n4} ${e10.minimum.toString()} ${r3.unit}` : `\u0623\u0635\u063A\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0644\u0640 ${e10.origin} \u0623\u0646 \u064A\u0643\u0648\u0646 ${n4} ${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0628\u062F\u0623 \u0628\u0640 "${e10.prefix}"` : t5.format === `ends_with` ? `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0646\u062A\u0647\u064A \u0628\u0640 "${t5.suffix}"` : t5.format === `includes` ? `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u062A\u0636\u0645\u0651\u064E\u0646 "${t5.includes}"` : t5.format === `regex` ? `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0637\u0627\u0628\u0642 \u0627\u0644\u0646\u0645\u0637 ${t5.pattern}` : `${n3[t5.format] ?? e10.format} \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644`;
      }
      case `not_multiple_of`:
        return `\u0631\u0642\u0645 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0643\u0648\u0646 \u0645\u0646 \u0645\u0636\u0627\u0639\u0641\u0627\u062A ${e10.divisor}`;
      case `unrecognized_keys`:
        return `\u0645\u0639\u0631\u0641${e10.keys.length > 1 ? `\u0627\u062A` : ``} \u063A\u0631\u064A\u0628${e10.keys.length > 1 ? `\u0629` : ``}: ${l(e10.keys, `\u060C `)}`;
      case `invalid_key`:
        return `\u0645\u0639\u0631\u0641 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644 \u0641\u064A ${e10.origin}`;
      case `invalid_union`:
        return `\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644`;
      case `invalid_element`:
        return `\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644 \u0641\u064A ${e10.origin}`;
      default:
        return `\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644`;
    }
  };
};
function ao() {
  return { localeError: io() };
}
var oo = () => {
  let e9 = { string: { unit: `simvol`, verb: `olmal\u0131d\u0131r` }, file: { unit: `bayt`, verb: `olmal\u0131d\u0131r` }, array: { unit: `element`, verb: `olmal\u0131d\u0131r` }, set: { unit: `element`, verb: `olmal\u0131d\u0131r` }, map: { unit: `element`, verb: `olmal\u0131d\u0131r` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `input`, email: `email address`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO datetime`, date: `ISO date`, time: `ISO time`, duration: `ISO duration`, ipv4: `IPv4 address`, ipv6: `IPv6 address`, mac: `MAC address`, cidrv4: `IPv4 range`, cidrv6: `IPv6 range`, base64: `base64-encoded string`, base64url: `base64url-encoded string`, json_string: `JSON string`, e164: `E.164 number`, credit_card: `kredit kart\u0131 n\xF6mr\u0259si`, jwt: `JWT`, template_literal: `input` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Yanl\u0131\u015F d\u0259y\u0259r: g\xF6zl\u0259nil\u0259n instanceof ${e10.expected}, daxil olan ${i3}` : `Yanl\u0131\u015F d\u0259y\u0259r: g\xF6zl\u0259nil\u0259n ${t5}, daxil olan ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Yanl\u0131\u015F d\u0259y\u0259r: g\xF6zl\u0259nil\u0259n ${C(e10.values[0])}` : `Yanl\u0131\u015F se\xE7im: a\u015Fa\u011F\u0131dak\u0131lardan biri olmal\u0131d\u0131r: ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\xC7ox b\xF6y\xFCk: g\xF6zl\u0259nil\u0259n ${e10.origin ?? `d\u0259y\u0259r`} ${n4}${e10.maximum.toString()} ${r3.unit ?? `element`}` : `\xC7ox b\xF6y\xFCk: g\xF6zl\u0259nil\u0259n ${e10.origin ?? `d\u0259y\u0259r`} ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\xC7ox ki\xE7ik: g\xF6zl\u0259nil\u0259n ${e10.origin} ${n4}${e10.minimum.toString()} ${r3.unit}` : `\xC7ox ki\xE7ik: g\xF6zl\u0259nil\u0259n ${e10.origin} ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Yanl\u0131\u015F m\u0259tn: "${t5.prefix}" il\u0259 ba\u015Flamal\u0131d\u0131r` : t5.format === `ends_with` ? `Yanl\u0131\u015F m\u0259tn: "${t5.suffix}" il\u0259 bitm\u0259lidir` : t5.format === `includes` ? `Yanl\u0131\u015F m\u0259tn: "${t5.includes}" daxil olmal\u0131d\u0131r` : t5.format === `regex` ? `Yanl\u0131\u015F m\u0259tn: ${t5.pattern} \u015Fablonuna uy\u011Fun olmal\u0131d\u0131r` : `Yanl\u0131\u015F ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Yanl\u0131\u015F \u0259d\u0259d: ${e10.divisor} il\u0259 b\xF6l\xFCn\u0259 bil\u0259n olmal\u0131d\u0131r`;
      case `unrecognized_keys`:
        return `Tan\u0131nmayan a\xE7ar${e10.keys.length > 1 ? `lar` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `${e10.origin} daxilind\u0259 yanl\u0131\u015F a\xE7ar`;
      case `invalid_union`:
        return `Yanl\u0131\u015F d\u0259y\u0259r`;
      case `invalid_element`:
        return `${e10.origin} daxilind\u0259 yanl\u0131\u015F d\u0259y\u0259r`;
      default:
        return `Yanl\u0131\u015F d\u0259y\u0259r`;
    }
  };
};
function so() {
  return { localeError: oo() };
}
function co(e9, t4, n3, r2) {
  let i3 = Math.abs(e9), a3 = i3 % 10, o3 = i3 % 100;
  return o3 >= 11 && o3 <= 19 ? r2 : a3 === 1 ? t4 : a3 >= 2 && a3 <= 4 ? n3 : r2;
}
var lo = () => {
  let e9 = { string: { unit: { one: `\u0441\u0456\u043C\u0432\u0430\u043B`, few: `\u0441\u0456\u043C\u0432\u0430\u043B\u044B`, many: `\u0441\u0456\u043C\u0432\u0430\u043B\u0430\u045E` }, verb: `\u043C\u0435\u0446\u044C` }, array: { unit: { one: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442`, few: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u044B`, many: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430\u045E` }, verb: `\u043C\u0435\u0446\u044C` }, set: { unit: { one: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442`, few: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u044B`, many: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430\u045E` }, verb: `\u043C\u0435\u0446\u044C` }, map: { unit: { one: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442`, few: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u044B`, many: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430\u045E` }, verb: `\u043C\u0435\u0446\u044C` }, file: { unit: { one: `\u0431\u0430\u0439\u0442`, few: `\u0431\u0430\u0439\u0442\u044B`, many: `\u0431\u0430\u0439\u0442\u0430\u045E` }, verb: `\u043C\u0435\u0446\u044C` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0443\u0432\u043E\u0434`, email: `email \u0430\u0434\u0440\u0430\u0441`, url: `URL`, emoji: `\u044D\u043C\u043E\u0434\u0437\u0456`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \u0434\u0430\u0442\u0430 \u0456 \u0447\u0430\u0441`, date: `ISO \u0434\u0430\u0442\u0430`, time: `ISO \u0447\u0430\u0441`, duration: `ISO \u043F\u0440\u0430\u0446\u044F\u0433\u043B\u0430\u0441\u0446\u044C`, ipv4: `IPv4 \u0430\u0434\u0440\u0430\u0441`, ipv6: `IPv6 \u0430\u0434\u0440\u0430\u0441`, mac: `MAC \u0430\u0434\u0440\u0430\u0441`, cidrv4: `IPv4 \u0434\u044B\u044F\u043F\u0430\u0437\u043E\u043D`, cidrv6: `IPv6 \u0434\u044B\u044F\u043F\u0430\u0437\u043E\u043D`, base64: `\u0440\u0430\u0434\u043E\u043A \u0443 \u0444\u0430\u0440\u043C\u0430\u0446\u0435 base64`, base64url: `\u0440\u0430\u0434\u043E\u043A \u0443 \u0444\u0430\u0440\u043C\u0430\u0446\u0435 base64url`, json_string: `JSON \u0440\u0430\u0434\u043E\u043A`, e164: `\u043D\u0443\u043C\u0430\u0440 E.164`, credit_card: `\u043D\u0443\u043C\u0430\u0440 \u043A\u0440\u044D\u0434\u044B\u0442\u043D\u0430\u0439 \u043A\u0430\u0440\u0442\u044B`, jwt: `JWT`, template_literal: `\u0443\u0432\u043E\u0434` }, r2 = { nan: `NaN`, number: `\u043B\u0456\u043A`, array: `\u043C\u0430\u0441\u0456\u045E` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434: \u0447\u0430\u043A\u0430\u045E\u0441\u044F instanceof ${e10.expected}, \u0430\u0442\u0440\u044B\u043C\u0430\u043D\u0430 ${i3}` : `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434: \u0447\u0430\u043A\u0430\u045E\u0441\u044F ${t5}, \u0430\u0442\u0440\u044B\u043C\u0430\u043D\u0430 ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F ${C(e10.values[0])}` : `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0432\u0430\u0440\u044B\u044F\u043D\u0442: \u0447\u0430\u043A\u0430\u045E\u0441\u044F \u0430\u0434\u0437\u0456\u043D \u0437 ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        if (r3) {
          let t5 = co(Number(e10.maximum), r3.unit.one, r3.unit.few, r3.unit.many);
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u0432\u044F\u043B\u0456\u043A\u0456: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${e10.origin ?? `\u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435`} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 ${r3.verb} ${n4}${e10.maximum.toString()} ${t5}`;
        }
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u0432\u044F\u043B\u0456\u043A\u0456: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${e10.origin ?? `\u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435`} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 \u0431\u044B\u0446\u044C ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        if (r3) {
          let t5 = co(Number(e10.minimum), r3.unit.one, r3.unit.few, r3.unit.many);
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u043C\u0430\u043B\u044B: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${e10.origin} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 ${r3.verb} ${n4}${e10.minimum.toString()} ${t5}`;
        }
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u043C\u0430\u043B\u044B: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${e10.origin} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 \u0431\u044B\u0446\u044C ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u043F\u0430\u0447\u044B\u043D\u0430\u0446\u0446\u0430 \u0437 "${t5.prefix}"` : t5.format === `ends_with` ? `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0437\u0430\u043A\u0430\u043D\u0447\u0432\u0430\u0446\u0446\u0430 \u043D\u0430 "${t5.suffix}"` : t5.format === `includes` ? `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0437\u043C\u044F\u0448\u0447\u0430\u0446\u044C "${t5.includes}"` : t5.format === `regex` ? `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0430\u0434\u043F\u0430\u0432\u044F\u0434\u0430\u0446\u044C \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${t5.pattern}` : `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u043B\u0456\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0431\u044B\u0446\u044C \u043A\u0440\u0430\u0442\u043D\u044B\u043C ${e10.divisor}`;
      case `unrecognized_keys`:
        return `\u041D\u0435\u0440\u0430\u0441\u043F\u0430\u0437\u043D\u0430\u043D\u044B ${e10.keys.length > 1 ? `\u043A\u043B\u044E\u0447\u044B` : `\u043A\u043B\u044E\u0447`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u043A\u043B\u044E\u0447 \u0443 ${e10.origin}`;
      case `invalid_union`:
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434`;
      case `invalid_element`:
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u0430\u0435 \u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435 \u045E ${e10.origin}`;
      default:
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434`;
    }
  };
};
function uo() {
  return { localeError: lo() };
}
var fo = () => {
  let e9 = { string: { unit: `\u0441\u0438\u043C\u0432\u043E\u043B\u0430`, verb: `\u0434\u0430 \u0441\u044A\u0434\u044A\u0440\u0436\u0430` }, file: { unit: `\u0431\u0430\u0439\u0442\u0430`, verb: `\u0434\u0430 \u0441\u044A\u0434\u044A\u0440\u0436\u0430` }, array: { unit: `\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0430`, verb: `\u0434\u0430 \u0441\u044A\u0434\u044A\u0440\u0436\u0430` }, set: { unit: `\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0430`, verb: `\u0434\u0430 \u0441\u044A\u0434\u044A\u0440\u0436\u0430` }, map: { unit: `\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0430`, verb: `\u0434\u0430 \u0441\u044A\u0434\u044A\u0440\u0436\u0430` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0432\u0445\u043E\u0434`, email: `\u0438\u043C\u0435\u0439\u043B \u0430\u0434\u0440\u0435\u0441`, url: `URL`, emoji: `\u0435\u043C\u043E\u0434\u0436\u0438`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \u0432\u0440\u0435\u043C\u0435`, date: `ISO \u0434\u0430\u0442\u0430`, time: `ISO \u0432\u0440\u0435\u043C\u0435`, duration: `ISO \u043F\u0440\u043E\u0434\u044A\u043B\u0436\u0438\u0442\u0435\u043B\u043D\u043E\u0441\u0442`, ipv4: `IPv4 \u0430\u0434\u0440\u0435\u0441`, ipv6: `IPv6 \u0430\u0434\u0440\u0435\u0441`, mac: `MAC \u0430\u0434\u0440\u0435\u0441`, cidrv4: `IPv4 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D`, cidrv6: `IPv6 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D`, base64: `base64-\u043A\u043E\u0434\u0438\u0440\u0430\u043D \u043D\u0438\u0437`, base64url: `base64url-\u043A\u043E\u0434\u0438\u0440\u0430\u043D \u043D\u0438\u0437`, json_string: `JSON \u043D\u0438\u0437`, e164: `E.164 \u043D\u043E\u043C\u0435\u0440`, credit_card: `\u043D\u043E\u043C\u0435\u0440 \u043D\u0430 \u043A\u0440\u0435\u0434\u0438\u0442\u043D\u0430 \u043A\u0430\u0440\u0442\u0430`, jwt: `JWT`, template_literal: `\u0432\u0445\u043E\u0434` }, r2 = { nan: `NaN`, number: `\u0447\u0438\u0441\u043B\u043E`, array: `\u043C\u0430\u0441\u0438\u0432` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u0432\u0445\u043E\u0434: \u043E\u0447\u0430\u043A\u0432\u0430\u043D instanceof ${e10.expected}, \u043F\u043E\u043B\u0443\u0447\u0435\u043D ${i3}` : `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u0432\u0445\u043E\u0434: \u043E\u0447\u0430\u043A\u0432\u0430\u043D ${t5}, \u043F\u043E\u043B\u0443\u0447\u0435\u043D ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u0432\u0445\u043E\u0434: \u043E\u0447\u0430\u043A\u0432\u0430\u043D ${C(e10.values[0])}` : `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u0430 \u043E\u043F\u0446\u0438\u044F: \u043E\u0447\u0430\u043A\u0432\u0430\u043D\u043E \u0435\u0434\u043D\u043E \u043E\u0442 ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u0422\u0432\u044A\u0440\u0434\u0435 \u0433\u043E\u043B\u044F\u043C\u043E: \u043E\u0447\u0430\u043A\u0432\u0430 \u0441\u0435 ${e10.origin ?? `\u0441\u0442\u043E\u0439\u043D\u043E\u0441\u0442`} \u0434\u0430 \u0441\u044A\u0434\u044A\u0440\u0436\u0430 ${n4}${e10.maximum.toString()} ${r3.unit ?? `\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0430`}` : `\u0422\u0432\u044A\u0440\u0434\u0435 \u0433\u043E\u043B\u044F\u043C\u043E: \u043E\u0447\u0430\u043A\u0432\u0430 \u0441\u0435 ${e10.origin ?? `\u0441\u0442\u043E\u0439\u043D\u043E\u0441\u0442`} \u0434\u0430 \u0431\u044A\u0434\u0435 ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u0422\u0432\u044A\u0440\u0434\u0435 \u043C\u0430\u043B\u043A\u043E: \u043E\u0447\u0430\u043A\u0432\u0430 \u0441\u0435 ${e10.origin} \u0434\u0430 \u0441\u044A\u0434\u044A\u0440\u0436\u0430 ${n4}${e10.minimum.toString()} ${r3.unit}` : `\u0422\u0432\u044A\u0440\u0434\u0435 \u043C\u0430\u043B\u043A\u043E: \u043E\u0447\u0430\u043A\u0432\u0430 \u0441\u0435 ${e10.origin} \u0434\u0430 \u0431\u044A\u0434\u0435 ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        if (t5.format === `starts_with`) return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u043D\u0438\u0437: \u0442\u0440\u044F\u0431\u0432\u0430 \u0434\u0430 \u0437\u0430\u043F\u043E\u0447\u0432\u0430 \u0441 "${t5.prefix}"`;
        if (t5.format === `ends_with`) return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u043D\u0438\u0437: \u0442\u0440\u044F\u0431\u0432\u0430 \u0434\u0430 \u0437\u0430\u0432\u044A\u0440\u0448\u0432\u0430 \u0441 "${t5.suffix}"`;
        if (t5.format === `includes`) return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u043D\u0438\u0437: \u0442\u0440\u044F\u0431\u0432\u0430 \u0434\u0430 \u0432\u043A\u043B\u044E\u0447\u0432\u0430 "${t5.includes}"`;
        if (t5.format === `regex`) return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u043D\u0438\u0437: \u0442\u0440\u044F\u0431\u0432\u0430 \u0434\u0430 \u0441\u044A\u0432\u043F\u0430\u0434\u0430 \u0441 ${t5.pattern}`;
        let r3 = `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D`;
        return t5.format === `emoji` && (r3 = `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u043E`), t5.format === `datetime` && (r3 = `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u043E`), t5.format === `date` && (r3 = `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u0430`), t5.format === `time` && (r3 = `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u043E`), t5.format === `duration` && (r3 = `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u0430`), `${r3} ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u043E \u0447\u0438\u0441\u043B\u043E: \u0442\u0440\u044F\u0431\u0432\u0430 \u0434\u0430 \u0431\u044A\u0434\u0435 \u043A\u0440\u0430\u0442\u043D\u043E \u043D\u0430 ${e10.divisor}`;
      case `unrecognized_keys`:
        return `\u041D\u0435\u0440\u0430\u0437\u043F\u043E\u0437\u043D\u0430\u0442${e10.keys.length > 1 ? `\u0438` : ``} \u043A\u043B\u044E\u0447${e10.keys.length > 1 ? `\u043E\u0432\u0435` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u043A\u043B\u044E\u0447 \u0432 ${e10.origin}`;
      case `invalid_union`:
        return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u0432\u0445\u043E\u0434`;
      case `invalid_element`:
        return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u0430 \u0441\u0442\u043E\u0439\u043D\u043E\u0441\u0442 \u0432 ${e10.origin}`;
      default:
        return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u0432\u0445\u043E\u0434`;
    }
  };
};
function po() {
  return { localeError: fo() };
}
var mo = () => {
  let e9 = { string: { unit: `\u0985\u0995\u09CD\u09B7\u09B0`, verb: `\u09A5\u09BE\u0995\u09A4\u09C7 \u09B9\u09AC\u09C7` }, file: { unit: `\u09AC\u09BE\u0987\u099F`, verb: `\u09A5\u09BE\u0995\u09A4\u09C7 \u09B9\u09AC\u09C7` }, array: { unit: `\u0986\u0987\u099F\u09C7\u09AE`, verb: `\u09A5\u09BE\u0995\u09A4\u09C7 \u09B9\u09AC\u09C7` }, set: { unit: `\u0986\u0987\u099F\u09C7\u09AE`, verb: `\u09A5\u09BE\u0995\u09A4\u09C7 \u09B9\u09AC\u09C7` }, map: { unit: `\u098F\u09A8\u09CD\u099F\u09CD\u09B0\u09BF`, verb: `\u09A5\u09BE\u0995\u09A4\u09C7 \u09B9\u09AC\u09C7` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0987\u09A8\u09AA\u09C1\u099F`, email: `\u0987\u09AE\u09C7\u0987\u09B2 \u09A0\u09BF\u0995\u09BE\u09A8\u09BE`, url: `URL`, emoji: `\u0987\u09AE\u09CB\u099C\u09BF`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \u09A4\u09BE\u09B0\u09BF\u0996 \u0993 \u09B8\u09AE\u09AF\u09BC`, date: `ISO \u09A4\u09BE\u09B0\u09BF\u0996`, time: `ISO \u09B8\u09AE\u09AF\u09BC`, duration: `ISO \u09B8\u09AE\u09AF\u09BC\u0995\u09BE\u09B2`, ipv4: `IPv4 \u09A0\u09BF\u0995\u09BE\u09A8\u09BE`, ipv6: `IPv6 \u09A0\u09BF\u0995\u09BE\u09A8\u09BE`, mac: `MAC \u09A0\u09BF\u0995\u09BE\u09A8\u09BE`, cidrv4: `IPv4 \u09B0\u09C7\u099E\u09CD\u099C`, cidrv6: `IPv6 \u09B0\u09C7\u099E\u09CD\u099C`, base64: `base64-\u098F\u09A8\u0995\u09CB\u09A1\u09C7\u09A1 \u09B8\u09CD\u099F\u09CD\u09B0\u09BF\u0982`, base64url: `base64url-\u098F\u09A8\u0995\u09CB\u09A1\u09C7\u09A1 \u09B8\u09CD\u099F\u09CD\u09B0\u09BF\u0982`, json_string: `JSON \u09B8\u09CD\u099F\u09CD\u09B0\u09BF\u0982`, e164: `E.164 \u09A8\u09AE\u09CD\u09AC\u09B0`, credit_card: `\u0995\u09CD\u09B0\u09C7\u09A1\u09BF\u099F \u0995\u09BE\u09B0\u09CD\u09A1 \u09A8\u09AE\u09CD\u09AC\u09B0`, jwt: `JWT`, template_literal: `\u0987\u09A8\u09AA\u09C1\u099F` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input);
        return `\u0985\u09AC\u09C8\u09A7 \u0987\u09A8\u09AA\u09C1\u099F: \u09AA\u09CD\u09B0\u09A4\u09CD\u09AF\u09BE\u09B6\u09BF\u09A4 ${t5}, \u09AA\u09CD\u09B0\u09BE\u09AA\u09CD\u09A4 ${r2[n4] ?? n4}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u0985\u09AC\u09C8\u09A7 \u0987\u09A8\u09AA\u09C1\u099F: \u09AA\u09CD\u09B0\u09A4\u09CD\u09AF\u09BE\u09B6\u09BF\u09A4 ${C(e10.values[0])}` : `\u0985\u09AC\u09C8\u09A7 \u0985\u09AA\u09B6\u09A8: ${l(e10.values, ` | `)} \u098F\u09B0 \u09AE\u09A7\u09CD\u09AF\u09C7 \u098F\u0995\u099F\u09BF \u09AA\u09CD\u09B0\u09A4\u09CD\u09AF\u09BE\u09B6\u09BF\u09A4`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u0985\u09A8\u09C7\u0995 \u09AC\u09A1\u09BC: ${e10.origin ?? `\u09AE\u09BE\u09A8`} ${n4}${e10.maximum.toString()} ${r3.unit ?? `\u098F\u09B2\u09BF\u09AE\u09C7\u09A8\u09CD\u099F`} \u09B9\u09A4\u09C7 \u09B9\u09AC\u09C7` : `\u0985\u09A8\u09C7\u0995 \u09AC\u09A1\u09BC: ${e10.origin ?? `\u09AE\u09BE\u09A8`} ${n4}${e10.maximum.toString()} \u09B9\u09A4\u09C7 \u09B9\u09AC\u09C7`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u0985\u09A8\u09C7\u0995 \u099B\u09CB\u099F: ${e10.origin} ${n4}${e10.minimum.toString()} ${r3.unit} \u09B9\u09A4\u09C7 \u09B9\u09AC\u09C7` : `\u0985\u09A8\u09C7\u0995 \u099B\u09CB\u099F: ${e10.origin} ${n4}${e10.minimum.toString()} \u09B9\u09A4\u09C7 \u09B9\u09AC\u09C7`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u0985\u09AC\u09C8\u09A7 \u09B8\u09CD\u099F\u09CD\u09B0\u09BF\u0982: "${t5.prefix}" \u09A6\u09BF\u09AF\u09BC\u09C7 \u09B6\u09C1\u09B0\u09C1 \u09B9\u09A4\u09C7 \u09B9\u09AC\u09C7` : t5.format === `ends_with` ? `\u0985\u09AC\u09C8\u09A7 \u09B8\u09CD\u099F\u09CD\u09B0\u09BF\u0982: "${t5.suffix}" \u09A6\u09BF\u09AF\u09BC\u09C7 \u09B6\u09C7\u09B7 \u09B9\u09A4\u09C7 \u09B9\u09AC\u09C7` : t5.format === `includes` ? `\u0985\u09AC\u09C8\u09A7 \u09B8\u09CD\u099F\u09CD\u09B0\u09BF\u0982: "${t5.includes}" \u0985\u09A8\u09CD\u09A4\u09B0\u09CD\u09AD\u09C1\u0995\u09CD\u09A4 \u09A5\u09BE\u0995\u09A4\u09C7 \u09B9\u09AC\u09C7` : t5.format === `regex` ? `\u0985\u09AC\u09C8\u09A7 \u09B8\u09CD\u099F\u09CD\u09B0\u09BF\u0982: ${t5.pattern} \u09AA\u09CD\u09AF\u09BE\u099F\u09BE\u09B0\u09CD\u09A8 \u09AE\u09BF\u09B2\u09A4\u09C7 \u09B9\u09AC\u09C7` : `\u0985\u09AC\u09C8\u09A7 ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u0985\u09AC\u09C8\u09A7 \u09A8\u09AE\u09CD\u09AC\u09B0: ${e10.divisor} \u098F\u09B0 \u0997\u09C1\u09A3\u09BF\u09A4\u0995 \u09B9\u09A4\u09C7 \u09B9\u09AC\u09C7`;
      case `unrecognized_keys`:
        return `\u0985\u099A\u09C7\u09A8\u09BE \u0995\u09C0${e10.keys.length > 1 ? `\u0997\u09C1\u09B2\u09CB` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `${e10.origin} \u098F \u0985\u09AC\u09C8\u09A7 \u0995\u09C0`;
      case `invalid_union`:
        return e10.options && Array.isArray(e10.options) && e10.options.length > 0 ? `\u0985\u09AC\u09C8\u09A7 \u09A1\u09BF\u09B8\u0995\u09CD\u09B0\u09BF\u09AE\u09BF\u09A8\u09C7\u099F\u09B0 \u09AE\u09BE\u09A8\u0964 \u09AA\u09CD\u09B0\u09A4\u09CD\u09AF\u09BE\u09B6\u09BF\u09A4 ${e10.options.map((e11) => `'${e11}'`).join(` | `)}` : `\u0985\u09AC\u09C8\u09A7 \u0987\u09A8\u09AA\u09C1\u099F`;
      case `invalid_element`:
        return `${e10.origin} \u098F \u0985\u09AC\u09C8\u09A7 \u09AE\u09BE\u09A8`;
      default:
        return `\u0985\u09AC\u09C8\u09A7 \u0987\u09A8\u09AA\u09C1\u099F`;
    }
  };
};
function ho() {
  return { localeError: mo() };
}
var go = () => {
  let e9 = { string: { unit: `car\xE0cters`, verb: `contenir` }, file: { unit: `bytes`, verb: `contenir` }, array: { unit: `elements`, verb: `contenir` }, set: { unit: `elements`, verb: `contenir` }, map: { unit: `elements`, verb: `contenir` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `entrada`, email: `adre\xE7a electr\xF2nica`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `data i hora ISO`, date: `data ISO`, time: `hora ISO`, duration: `durada ISO`, ipv4: `adre\xE7a IPv4`, ipv6: `adre\xE7a IPv6`, mac: `adre\xE7a MAC`, cidrv4: `rang IPv4`, cidrv6: `rang IPv6`, base64: `cadena codificada en base64`, base64url: `cadena codificada en base64url`, json_string: `cadena JSON`, e164: `n\xFAmero E.164`, credit_card: `n\xFAmero de targeta de cr\xE8dit`, jwt: `JWT`, template_literal: `entrada` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Tipus inv\xE0lid: s'esperava instanceof ${e10.expected}, s'ha rebut ${i3}` : `Tipus inv\xE0lid: s'esperava ${t5}, s'ha rebut ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Valor inv\xE0lid: s'esperava ${C(e10.values[0])}` : `Opci\xF3 inv\xE0lida: s'esperava una de ${l(e10.values, ` o `)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `com a m\xE0xim` : `menys de`, r3 = t4(e10.origin);
        return r3 ? `Massa gran: s'esperava que ${e10.origin ?? `el valor`} contingu\xE9s ${n4} ${e10.maximum.toString()} ${r3.unit ?? `elements`}` : `Massa gran: s'esperava que ${e10.origin ?? `el valor`} fos ${n4} ${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `com a m\xEDnim` : `m\xE9s de`, r3 = t4(e10.origin);
        return r3 ? `Massa petit: s'esperava que ${e10.origin} contingu\xE9s ${n4} ${e10.minimum.toString()} ${r3.unit}` : `Massa petit: s'esperava que ${e10.origin} fos ${n4} ${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Format inv\xE0lid: ha de comen\xE7ar amb "${t5.prefix}"` : t5.format === `ends_with` ? `Format inv\xE0lid: ha d'acabar amb "${t5.suffix}"` : t5.format === `includes` ? `Format inv\xE0lid: ha d'incloure "${t5.includes}"` : t5.format === `regex` ? `Format inv\xE0lid: ha de coincidir amb el patr\xF3 ${t5.pattern}` : `Format inv\xE0lid per a ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `N\xFAmero inv\xE0lid: ha de ser m\xFAltiple de ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Clau${e10.keys.length > 1 ? `s` : ``} no reconeguda${e10.keys.length > 1 ? `s` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Clau inv\xE0lida a ${e10.origin}`;
      case `invalid_union`:
        return `Entrada inv\xE0lida`;
      case `invalid_element`:
        return `Element inv\xE0lid a ${e10.origin}`;
      default:
        return `Entrada inv\xE0lida`;
    }
  };
};
function _o() {
  return { localeError: go() };
}
var vo = () => {
  let e9 = { string: { unit: `\u067E\u06CC\u062A`, verb: `\u0628\u06CE\u062A` }, file: { unit: `\u0628\u0627\u06CC\u062A`, verb: `\u0628\u06CE\u062A` }, array: { unit: `\u062F\u0627\u0646\u06D5`, verb: `\u0628\u06CE\u062A` }, set: { unit: `\u062F\u0627\u0646\u06D5`, verb: `\u0628\u06CE\u062A` }, map: { unit: `\u062F\u0627\u0646\u06D5`, verb: `\u0628\u06CE\u062A` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `regex`, email: `\u0626\u06CC\u0645\u06D5\u06CC\u06B5`, url: `\u0628\u06D5\u0633\u062A\u06D5\u0631 (URL)`, emoji: `\u0626\u06CC\u0645\u06C6\u062C\u06CC`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `\u0695\u06CE\u06A9\u06D5\u0648\u062A \u0648 \u06A9\u0627\u062A`, date: `\u0695\u06CE\u06A9\u06D5\u0648\u062A`, time: `\u06A9\u0627\u062A`, duration: `\u0645\u0627\u0648\u06D5`, ipv4: `\u0646\u0627\u0648\u0646\u06CC\u0634\u0627\u0646\u06CC IPv4`, ipv6: `\u0646\u0627\u0648\u0646\u06CC\u0634\u0627\u0646\u06CC IPv6`, mac: `\u0646\u0627\u0648\u0646\u06CC\u0634\u0627\u0646\u06CC MAC`, cidrv4: `\u0645\u06D5\u0648\u062F\u0627\u06CC IPv4`, cidrv6: `\u0645\u06D5\u0648\u062F\u0627\u06CC IPv6`, base64: `\u062F\u06D5\u0642\u06CC base64`, base64url: `\u062F\u06D5\u0642\u06CC base64url`, json_string: `\u062F\u06D5\u0642\u06CC JSON`, e164: `\u0698\u0645\u0627\u0631\u06D5\u06CC E.164`, credit_card: `\u0698\u0645\u0627\u0631\u06D5\u06CC \u06A9\u0627\u0631\u062A\u06CC \u06A9\u0631\u06CE\u062F\u06CC\u062A`, jwt: `JWT`, template_literal: `\u062A\u06CE\u06A9\u0631\u062F\u06D5` }, r2 = { nan: `NaN`, string: `\u0646\u0648\u0648\u0633\u06CC\u0646`, number: `\u0698\u0645\u0627\u0631\u06D5`, boolean: `boolean`, array: `array`, object: `object`, date: `\u0695\u06CE\u06A9\u06D5\u0648\u062A`, integer: `\u0698\u0645\u0627\u0631\u06D5`, float: `\u0698\u0645\u0627\u0631\u06D5`, null: `null`, undefined: `undefined`, function: `function`, symbol: `symbol`, unknown: `unknown`, promise: `promise`, void: `void`, never: `never`, map: `map`, set: `set` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4, a3 = [`\u0627`, `\u0648`, `\u06C6`, `\u0648\u0648`, `\u06D5`, `\u06CC`, `\u06CE`].some((e11) => i3.endsWith(e11)) ? `\u06CC\u06D5` : `\u06D5`, o3 = /^[a-zA-Z]+$/.test(i3);
        return n4 === `null` || n4 === `undefined` ? `\u062F\u0627\u0648\u0627\u06A9\u0631\u0627\u0648\u06D5` : `\u0686\u0627\u0648\u06D5\u0695\u0648\u0627\u0646\u06A9\u0631\u0627\u0648\u06D5 ${t5} \u0628\u06CE\u062A\u060C \u0628\u06D5\u06B5\u0627\u0645 ${i3}${o3 ? `` : a3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u0628\u06D5\u0647\u0627\u06A9\u06D5 \u0646\u0627\u062F\u0631\u0648\u0648\u0633\u062A\u06D5: \u0686\u0627\u0648\u06D5\u0695\u0648\u0627\u0646\u06A9\u0631\u0627\u0648\u06D5 ${C(e10.values[0])} \u0628\u06CE\u062A` : `\u0647\u06D5\u06B5\u0628\u0698\u0627\u0631\u062F\u06D5\u06CC \u0646\u0627\u062F\u0631\u0648\u0633\u062A: \u0686\u0627\u0648\u06D5\u0695\u0648\u0627\u0646\u06A9\u0631\u0627\u0648\u06D5 \u06CC\u06D5\u06A9\u06CE\u06A9 \u0628\u06CE\u062A \u0644\u06D5 ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = t4(e10.origin);
        return n4 ? `\u067E\u06CE\u0648\u06CC\u0633\u062A\u06D5 \u0628\u06D5 \u0644\u0627\u06CC\u06D5\u0646\u06CC \u0632\u06C6\u0631\u06D5\u0648\u06D5 ${e10.maximum.toString()} ${n4.unit} ${n4.verb}` : `\u067E\u06CE\u0648\u06CC\u0633\u062A\u06D5 \u0628\u06D5 \u0644\u0627\u06CC\u06D5\u0646\u06CC \u0632\u06C6\u0631\u06D5\u0648\u06D5 ${e10.maximum.toString()} \u0628\u06CE\u062A`;
      }
      case `too_small`: {
        let n4 = t4(e10.origin);
        return n4 ? `\u067E\u06CE\u0648\u06CC\u0633\u062A\u06D5 \u0628\u06D5 \u0644\u0627\u06CC\u06D5\u0646\u06CC \u06A9\u06D5\u0645\u06D5\u0648\u06D5 ${e10.minimum.toString()} ${n4.unit} ${n4.verb}` : `\u067E\u06CE\u0648\u06CC\u0633\u062A\u06D5 \u0628\u06D5 \u0644\u0627\u06CC\u06D5\u0646\u06CC \u06A9\u06D5\u0645\u06D5\u0648\u06D5 ${e10.minimum.toString()} \u0628\u06CE\u062A`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u062F\u06D5\u0642\u06CC \u0646\u0627\u062F\u0631\u0648\u0633\u062A: \u067E\u06CE\u0648\u06CC\u0633\u062A\u06D5 \u062F\u06D5\u0633\u062A\u067E\u06CE\u0628\u06A9\u0627\u062A \u0628\u06D5 "${t5.prefix}"` : t5.format === `ends_with` ? `\u062F\u06D5\u0642\u06CC \u0646\u0627\u062F\u0631\u0648\u0633\u062A: \u067E\u06CE\u0648\u06CC\u0633\u062A\u06D5 \u06A9\u06C6\u062A\u0627\u06CC\u06CC\u0628\u06CE\u062A \u0628\u06D5 "${t5.suffix}"` : t5.format === `includes` ? `\u062F\u06D5\u0642\u06CC \u0646\u0627\u062F\u0631\u0648\u0633\u062A: \u067E\u06CE\u0648\u06CC\u0633\u062A\u06D5 "${t5.includes}" \u0644\u06D5\u062E\u06C6\u0628\u06AF\u0631\u06CE\u062A` : t5.format === `regex` ? `\u062F\u06D5\u0642\u06CC \u0646\u0627\u062F\u0631\u0648\u0633\u062A: \u067E\u06CE\u0648\u06CC\u0633\u062A\u06D5 \u0644\u06D5\u06AF\u06D5\u06B5 \u067E\u0627\u062A\u06CE\u0631\u0646\u06CC ${t5.pattern} \u0628\u06AF\u0648\u0646\u062C\u06CE\u062A` : `\u0628\u06D5\u0647\u0627\u06CC ${n3[t5.format] ?? e10.format} \u0646\u0627\u062F\u0631\u0648\u0633\u062A\u06D5`;
      }
      case `not_multiple_of`:
        return `\u0698\u0645\u0627\u0631\u06D5\u06CC \u0646\u0627\u062F\u0631\u0648\u0633\u062A: \u062F\u06D5\u0628\u06CE\u062A \u0686\u06D5\u0646\u062F \u0647\u06CE\u0646\u062F\u06D5 \u0628\u06CE\u062A \u0628\u06C6 ${e10.divisor}`;
      case `unrecognized_keys`:
        return `\u06A9\u0644\u06CC\u0644\u06CC \u0646\u06D5\u0646\u0627\u0633\u0631\u0627\u0648: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u06A9\u0644\u06CC\u0644\u06CC \u0646\u0627\u062F\u0631\u0648\u0633\u062A \u0644\u06D5 ${e10.origin}`;
      case `invalid_union`:
        return e10.options && Array.isArray(e10.options) && e10.options.length > 0 ? `\u0628\u06D5\u0647\u0627\u06CC \u0646\u06D5\u0646\u0627\u0633\u0631\u0627\u0648 \u0647\u06D5\u06CC\u06D5. \u0628\u06D5\u0647\u0627\u06CC \u0686\u0627\u0648\u06D5\u0695\u0648\u0627\u0646\u06A9\u0631\u0627\u0648: ${e10.options.map((e11) => `'${e11}'`).join(` | `)}` : `\u06CC\u06D5\u06A9\u06AF\u0631\u062A\u0646\u06CC \u0646\u0627\u062F\u0631\u0648\u0633\u062A`;
      case `invalid_element`:
        return `${e10.origin} \u0628\u06D5\u0647\u0627\u06A9\u06D5 \u0646\u0627\u062F\u0631\u0648\u0633\u062A\u06D5`;
      default:
        return `\u062A\u06CE\u06A9\u0631\u062F\u06D5\u06CC \u0646\u0627\u062F\u0631\u0648\u0633\u062A`;
    }
  };
};
function yo() {
  return { localeError: vo() };
}
var bo = () => {
  let e9 = { string: { unit: `znak\u016F`, verb: `m\xEDt` }, file: { unit: `bajt\u016F`, verb: `m\xEDt` }, array: { unit: `prvk\u016F`, verb: `m\xEDt` }, set: { unit: `prvk\u016F`, verb: `m\xEDt` }, map: { unit: `prvk\u016F`, verb: `m\xEDt` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `regul\xE1rn\xED v\xFDraz`, email: `e-mailov\xE1 adresa`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `datum a \u010Das ve form\xE1tu ISO`, date: `datum ve form\xE1tu ISO`, time: `\u010Das ve form\xE1tu ISO`, duration: `doba trv\xE1n\xED ISO`, ipv4: `IPv4 adresa`, ipv6: `IPv6 adresa`, mac: `MAC adresa`, cidrv4: `rozsah IPv4`, cidrv6: `rozsah IPv6`, base64: `\u0159et\u011Bzec zak\xF3dovan\xFD ve form\xE1tu base64`, base64url: `\u0159et\u011Bzec zak\xF3dovan\xFD ve form\xE1tu base64url`, json_string: `\u0159et\u011Bzec ve form\xE1tu JSON`, e164: `\u010D\xEDslo E.164`, credit_card: `\u010D\xEDslo kreditn\xED karty`, jwt: `JWT`, template_literal: `vstup` }, r2 = { nan: `NaN`, number: `\u010D\xEDslo`, string: `\u0159et\u011Bzec`, function: `funkce`, array: `pole` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Neplatn\xFD vstup: o\u010Dek\xE1v\xE1no instanceof ${e10.expected}, obdr\u017Eeno ${i3}` : `Neplatn\xFD vstup: o\u010Dek\xE1v\xE1no ${t5}, obdr\u017Eeno ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Neplatn\xFD vstup: o\u010Dek\xE1v\xE1no ${C(e10.values[0])}` : `Neplatn\xE1 mo\u017Enost: o\u010Dek\xE1v\xE1na jedna z hodnot ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Hodnota je p\u0159\xEDli\u0161 velk\xE1: ${e10.origin ?? `hodnota`} mus\xED m\xEDt ${n4}${e10.maximum.toString()} ${r3.unit ?? `prvk\u016F`}` : `Hodnota je p\u0159\xEDli\u0161 velk\xE1: ${e10.origin ?? `hodnota`} mus\xED b\xFDt ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Hodnota je p\u0159\xEDli\u0161 mal\xE1: ${e10.origin ?? `hodnota`} mus\xED m\xEDt ${n4}${e10.minimum.toString()} ${r3.unit ?? `prvk\u016F`}` : `Hodnota je p\u0159\xEDli\u0161 mal\xE1: ${e10.origin ?? `hodnota`} mus\xED b\xFDt ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Neplatn\xFD \u0159et\u011Bzec: mus\xED za\u010D\xEDnat na "${t5.prefix}"` : t5.format === `ends_with` ? `Neplatn\xFD \u0159et\u011Bzec: mus\xED kon\u010Dit na "${t5.suffix}"` : t5.format === `includes` ? `Neplatn\xFD \u0159et\u011Bzec: mus\xED obsahovat "${t5.includes}"` : t5.format === `regex` ? `Neplatn\xFD \u0159et\u011Bzec: mus\xED odpov\xEDdat vzoru ${t5.pattern}` : `Neplatn\xFD form\xE1t ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Neplatn\xE9 \u010D\xEDslo: mus\xED b\xFDt n\xE1sobkem ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Nezn\xE1m\xE9 kl\xED\u010De: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Neplatn\xFD kl\xED\u010D v ${e10.origin}`;
      case `invalid_union`:
        return `Neplatn\xFD vstup`;
      case `invalid_element`:
        return `Neplatn\xE1 hodnota v ${e10.origin}`;
      default:
        return `Neplatn\xFD vstup`;
    }
  };
};
function xo() {
  return { localeError: bo() };
}
var So = () => {
  let e9 = { string: { unit: `tegn`, verb: `havde` }, file: { unit: `bytes`, verb: `havde` }, array: { unit: `elementer`, verb: `indeholdt` }, set: { unit: `elementer`, verb: `indeholdt` }, map: { unit: `elementer`, verb: `indeholdt` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `input`, email: `e-mailadresse`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO dato- og klokkesl\xE6t`, date: `ISO-dato`, time: `ISO-klokkesl\xE6t`, duration: `ISO-varighed`, ipv4: `IPv4-adresse`, ipv6: `IPv6-adresse`, mac: `MAC-adresse`, cidrv4: `IPv4-spektrum`, cidrv6: `IPv6-spektrum`, base64: `base64-kodet streng`, base64url: `base64url-kodet streng`, json_string: `JSON-streng`, e164: `E.164-nummer`, credit_card: `kreditkortnummer`, jwt: `JWT`, template_literal: `input` }, r2 = { nan: `NaN`, string: `streng`, number: `tal`, boolean: `boolean`, array: `liste`, object: `objekt`, set: `s\xE6t`, file: `fil` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Ugyldigt input: forventede instanceof ${e10.expected}, fik ${i3}` : `Ugyldigt input: forventede ${t5}, fik ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Ugyldig v\xE6rdi: forventede ${C(e10.values[0])}` : `Ugyldigt valg: forventede en af f\xF8lgende ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, i3 = t4(e10.origin), a3 = r2[e10.origin] ?? e10.origin;
        return i3 ? `For stor: forventede ${a3 ?? `value`} ${i3.verb} ${n4} ${e10.maximum.toString()} ${i3.unit ?? `elementer`}` : `For stor: forventede ${a3 ?? `value`} havde ${n4} ${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, i3 = t4(e10.origin), a3 = r2[e10.origin] ?? e10.origin;
        return i3 ? `For lille: forventede ${a3} ${i3.verb} ${n4} ${e10.minimum.toString()} ${i3.unit}` : `For lille: forventede ${a3} havde ${n4} ${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Ugyldig streng: skal starte med "${t5.prefix}"` : t5.format === `ends_with` ? `Ugyldig streng: skal ende med "${t5.suffix}"` : t5.format === `includes` ? `Ugyldig streng: skal indeholde "${t5.includes}"` : t5.format === `regex` ? `Ugyldig streng: skal matche m\xF8nsteret ${t5.pattern}` : `Ugyldig ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Ugyldigt tal: skal v\xE6re deleligt med ${e10.divisor}`;
      case `unrecognized_keys`:
        return `${e10.keys.length > 1 ? `Ukendte n\xF8gler` : `Ukendt n\xF8gle`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Ugyldig n\xF8gle i ${e10.origin}`;
      case `invalid_union`:
        return `Ugyldigt input: matcher ingen af de tilladte typer`;
      case `invalid_element`:
        return `Ugyldig v\xE6rdi i ${e10.origin}`;
      default:
        return `Ugyldigt input`;
    }
  };
};
function Co() {
  return { localeError: So() };
}
var wo = () => {
  let e9 = { string: { unit: `Zeichen`, verb: `zu haben` }, file: { unit: `Bytes`, verb: `zu haben` }, array: { unit: `Elemente`, verb: `zu haben` }, set: { unit: `Elemente`, verb: `zu haben` }, map: { unit: `Elemente`, verb: `zu haben` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `Eingabe`, email: `E-Mail-Adresse`, url: `URL`, emoji: `Emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO-Datum und -Uhrzeit`, date: `ISO-Datum`, time: `ISO-Uhrzeit`, duration: `ISO-Dauer`, ipv4: `IPv4-Adresse`, ipv6: `IPv6-Adresse`, mac: `MAC-Adresse`, cidrv4: `IPv4-Bereich`, cidrv6: `IPv6-Bereich`, base64: `Base64-codierter String`, base64url: `Base64-URL-codierter String`, json_string: `JSON-String`, e164: `E.164-Nummer`, credit_card: `Kreditkartennummer`, jwt: `JWT`, template_literal: `Eingabe` }, r2 = { nan: `NaN`, number: `Zahl`, array: `Array` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Ung\xFCltige Eingabe: erwartet instanceof ${e10.expected}, erhalten ${i3}` : `Ung\xFCltige Eingabe: erwartet ${t5}, erhalten ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Ung\xFCltige Eingabe: erwartet ${C(e10.values[0])}` : `Ung\xFCltige Option: erwartet eine von ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Zu gro\xDF: erwartet, dass ${e10.origin ?? `Wert`} ${n4}${e10.maximum.toString()} ${r3.unit ?? `Elemente`} hat` : `Zu gro\xDF: erwartet, dass ${e10.origin ?? `Wert`} ${n4}${e10.maximum.toString()} ist`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Zu klein: erwartet, dass ${e10.origin} ${n4}${e10.minimum.toString()} ${r3.unit} hat` : `Zu klein: erwartet, dass ${e10.origin} ${n4}${e10.minimum.toString()} ist`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Ung\xFCltiger String: muss mit "${t5.prefix}" beginnen` : t5.format === `ends_with` ? `Ung\xFCltiger String: muss mit "${t5.suffix}" enden` : t5.format === `includes` ? `Ung\xFCltiger String: muss "${t5.includes}" enthalten` : t5.format === `regex` ? `Ung\xFCltiger String: muss dem Muster ${t5.pattern} entsprechen` : `Ung\xFCltig: ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Ung\xFCltige Zahl: muss ein Vielfaches von ${e10.divisor} sein`;
      case `unrecognized_keys`:
        return `${e10.keys.length > 1 ? `Unbekannte Schl\xFCssel` : `Unbekannter Schl\xFCssel`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Ung\xFCltiger Schl\xFCssel in ${e10.origin}`;
      case `invalid_union`:
        return `Ung\xFCltige Eingabe`;
      case `invalid_element`:
        return `Ung\xFCltiger Wert in ${e10.origin}`;
      default:
        return `Ung\xFCltige Eingabe`;
    }
  };
};
function To() {
  return { localeError: wo() };
}
var Eo = () => {
  let e9 = { string: { unit: `\u03C7\u03B1\u03C1\u03B1\u03BA\u03C4\u03AE\u03C1\u03B5\u03C2`, verb: `\u03BD\u03B1 \u03AD\u03C7\u03B5\u03B9` }, file: { unit: `bytes`, verb: `\u03BD\u03B1 \u03AD\u03C7\u03B5\u03B9` }, array: { unit: `\u03C3\u03C4\u03BF\u03B9\u03C7\u03B5\u03AF\u03B1`, verb: `\u03BD\u03B1 \u03AD\u03C7\u03B5\u03B9` }, set: { unit: `\u03C3\u03C4\u03BF\u03B9\u03C7\u03B5\u03AF\u03B1`, verb: `\u03BD\u03B1 \u03AD\u03C7\u03B5\u03B9` }, map: { unit: `\u03BA\u03B1\u03C4\u03B1\u03C7\u03C9\u03C1\u03AE\u03C3\u03B5\u03B9\u03C2`, verb: `\u03BD\u03B1 \u03AD\u03C7\u03B5\u03B9` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u03B5\u03AF\u03C3\u03BF\u03B4\u03BF\u03C2`, email: `\u03B4\u03B9\u03B5\u03CD\u03B8\u03C5\u03BD\u03C3\u03B7 email`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \u03B7\u03BC\u03B5\u03C1\u03BF\u03BC\u03B7\u03BD\u03AF\u03B1 \u03BA\u03B1\u03B9 \u03CE\u03C1\u03B1`, date: `ISO \u03B7\u03BC\u03B5\u03C1\u03BF\u03BC\u03B7\u03BD\u03AF\u03B1`, time: `ISO \u03CE\u03C1\u03B1`, duration: `ISO \u03B4\u03B9\u03AC\u03C1\u03BA\u03B5\u03B9\u03B1`, ipv4: `\u03B4\u03B9\u03B5\u03CD\u03B8\u03C5\u03BD\u03C3\u03B7 IPv4`, ipv6: `\u03B4\u03B9\u03B5\u03CD\u03B8\u03C5\u03BD\u03C3\u03B7 IPv6`, mac: `\u03B4\u03B9\u03B5\u03CD\u03B8\u03C5\u03BD\u03C3\u03B7 MAC`, cidrv4: `\u03B5\u03CD\u03C1\u03BF\u03C2 IPv4`, cidrv6: `\u03B5\u03CD\u03C1\u03BF\u03C2 IPv6`, base64: `\u03C3\u03C5\u03BC\u03B2\u03BF\u03BB\u03BF\u03C3\u03B5\u03B9\u03C1\u03AC \u03BA\u03C9\u03B4\u03B9\u03BA\u03BF\u03C0\u03BF\u03B9\u03B7\u03BC\u03AD\u03BD\u03B7 \u03C3\u03B5 base64`, base64url: `\u03C3\u03C5\u03BC\u03B2\u03BF\u03BB\u03BF\u03C3\u03B5\u03B9\u03C1\u03AC \u03BA\u03C9\u03B4\u03B9\u03BA\u03BF\u03C0\u03BF\u03B9\u03B7\u03BC\u03AD\u03BD\u03B7 \u03C3\u03B5 base64url`, json_string: `\u03C3\u03C5\u03BC\u03B2\u03BF\u03BB\u03BF\u03C3\u03B5\u03B9\u03C1\u03AC JSON`, e164: `\u03B1\u03C1\u03B9\u03B8\u03BC\u03CC\u03C2 E.164`, credit_card: `\u03B1\u03C1\u03B9\u03B8\u03BC\u03CC\u03C2 \u03C0\u03B9\u03C3\u03C4\u03C9\u03C4\u03B9\u03BA\u03AE\u03C2 \u03BA\u03AC\u03C1\u03C4\u03B1\u03C2`, jwt: `JWT`, template_literal: `\u03B5\u03AF\u03C3\u03BF\u03B4\u03BF\u03C2` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return typeof e10.expected == `string` && /^[A-Z]/.test(e10.expected) ? `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03B7 \u03B5\u03AF\u03C3\u03BF\u03B4\u03BF\u03C2: \u03B1\u03BD\u03B1\u03BC\u03B5\u03BD\u03CC\u03C4\u03B1\u03BD instanceof ${e10.expected}, \u03BB\u03AE\u03C6\u03B8\u03B7\u03BA\u03B5 ${i3}` : `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03B7 \u03B5\u03AF\u03C3\u03BF\u03B4\u03BF\u03C2: \u03B1\u03BD\u03B1\u03BC\u03B5\u03BD\u03CC\u03C4\u03B1\u03BD ${t5}, \u03BB\u03AE\u03C6\u03B8\u03B7\u03BA\u03B5 ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03B7 \u03B5\u03AF\u03C3\u03BF\u03B4\u03BF\u03C2: \u03B1\u03BD\u03B1\u03BC\u03B5\u03BD\u03CC\u03C4\u03B1\u03BD ${C(e10.values[0])}` : `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03B7 \u03B5\u03C0\u03B9\u03BB\u03BF\u03B3\u03AE: \u03B1\u03BD\u03B1\u03BC\u03B5\u03BD\u03CC\u03C4\u03B1\u03BD \u03AD\u03BD\u03B1 \u03B1\u03C0\u03CC ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u03A0\u03BF\u03BB\u03CD \u03BC\u03B5\u03B3\u03AC\u03BB\u03BF: \u03B1\u03BD\u03B1\u03BC\u03B5\u03BD\u03CC\u03C4\u03B1\u03BD ${e10.origin ?? `\u03C4\u03B9\u03BC\u03AE`} \u03BD\u03B1 \u03AD\u03C7\u03B5\u03B9 ${n4}${e10.maximum.toString()} ${r3.unit ?? `\u03C3\u03C4\u03BF\u03B9\u03C7\u03B5\u03AF\u03B1`}` : `\u03A0\u03BF\u03BB\u03CD \u03BC\u03B5\u03B3\u03AC\u03BB\u03BF: \u03B1\u03BD\u03B1\u03BC\u03B5\u03BD\u03CC\u03C4\u03B1\u03BD ${e10.origin ?? `\u03C4\u03B9\u03BC\u03AE`} \u03BD\u03B1 \u03B5\u03AF\u03BD\u03B1\u03B9 ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u03A0\u03BF\u03BB\u03CD \u03BC\u03B9\u03BA\u03C1\u03CC: \u03B1\u03BD\u03B1\u03BC\u03B5\u03BD\u03CC\u03C4\u03B1\u03BD ${e10.origin} \u03BD\u03B1 \u03AD\u03C7\u03B5\u03B9 ${n4}${e10.minimum.toString()} ${r3.unit}` : `\u03A0\u03BF\u03BB\u03CD \u03BC\u03B9\u03BA\u03C1\u03CC: \u03B1\u03BD\u03B1\u03BC\u03B5\u03BD\u03CC\u03C4\u03B1\u03BD ${e10.origin} \u03BD\u03B1 \u03B5\u03AF\u03BD\u03B1\u03B9 ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03B7 \u03C3\u03C5\u03BC\u03B2\u03BF\u03BB\u03BF\u03C3\u03B5\u03B9\u03C1\u03AC: \u03C0\u03C1\u03AD\u03C0\u03B5\u03B9 \u03BD\u03B1 \u03BE\u03B5\u03BA\u03B9\u03BD\u03AC \u03BC\u03B5 "${t5.prefix}"` : t5.format === `ends_with` ? `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03B7 \u03C3\u03C5\u03BC\u03B2\u03BF\u03BB\u03BF\u03C3\u03B5\u03B9\u03C1\u03AC: \u03C0\u03C1\u03AD\u03C0\u03B5\u03B9 \u03BD\u03B1 \u03C4\u03B5\u03BB\u03B5\u03B9\u03CE\u03BD\u03B5\u03B9 \u03BC\u03B5 "${t5.suffix}"` : t5.format === `includes` ? `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03B7 \u03C3\u03C5\u03BC\u03B2\u03BF\u03BB\u03BF\u03C3\u03B5\u03B9\u03C1\u03AC: \u03C0\u03C1\u03AD\u03C0\u03B5\u03B9 \u03BD\u03B1 \u03C0\u03B5\u03C1\u03B9\u03AD\u03C7\u03B5\u03B9 "${t5.includes}"` : t5.format === `regex` ? `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03B7 \u03C3\u03C5\u03BC\u03B2\u03BF\u03BB\u03BF\u03C3\u03B5\u03B9\u03C1\u03AC: \u03C0\u03C1\u03AD\u03C0\u03B5\u03B9 \u03BD\u03B1 \u03C4\u03B1\u03B9\u03C1\u03B9\u03AC\u03B6\u03B5\u03B9 \u03BC\u03B5 \u03C4\u03BF \u03BC\u03BF\u03C4\u03AF\u03B2\u03BF ${t5.pattern}` : `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03BF: ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03BF\u03C2 \u03B1\u03C1\u03B9\u03B8\u03BC\u03CC\u03C2: \u03C0\u03C1\u03AD\u03C0\u03B5\u03B9 \u03BD\u03B1 \u03B5\u03AF\u03BD\u03B1\u03B9 \u03C0\u03BF\u03BB\u03BB\u03B1\u03C0\u03BB\u03AC\u03C3\u03B9\u03BF \u03C4\u03BF\u03C5 ${e10.divisor}`;
      case `unrecognized_keys`:
        return `\u0386\u03B3\u03BD\u03C9\u03C3\u03C4${e10.keys.length > 1 ? `\u03B1` : `\u03BF`} \u03BA\u03BB\u03B5\u03B9\u03B4${e10.keys.length > 1 ? `\u03B9\u03AC` : `\u03AF`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03BF \u03BA\u03BB\u03B5\u03B9\u03B4\u03AF \u03C3\u03C4\u03BF ${e10.origin}`;
      case `invalid_union`:
        return `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03B7 \u03B5\u03AF\u03C3\u03BF\u03B4\u03BF\u03C2`;
      case `invalid_element`:
        return `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03B7 \u03C4\u03B9\u03BC\u03AE \u03C3\u03C4\u03BF ${e10.origin}`;
      default:
        return `\u039C\u03B7 \u03AD\u03B3\u03BA\u03C5\u03C1\u03B7 \u03B5\u03AF\u03C3\u03BF\u03B4\u03BF\u03C2`;
    }
  };
};
function Do() {
  return { localeError: Eo() };
}
var Oo = () => {
  let e9 = { string: { unit: `characters`, verb: `to have` }, file: { unit: `bytes`, verb: `to have` }, array: { unit: `items`, verb: `to have` }, set: { unit: `items`, verb: `to have` }, map: { unit: `entries`, verb: `to have` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `input`, email: `email address`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO datetime`, date: `ISO date`, time: `ISO time`, duration: `ISO duration`, ipv4: `IPv4 address`, ipv6: `IPv6 address`, mac: `MAC address`, cidrv4: `IPv4 range`, cidrv6: `IPv6 range`, base64: `base64-encoded string`, base64url: `base64url-encoded string`, json_string: `JSON string`, e164: `E.164 number`, credit_card: `credit card number`, jwt: `JWT`, template_literal: `input` }, r2 = { nan: `NaN` };
  function i3(e10, t5) {
    return e10 === `number` && typeof t5 == `number` && !Number.isFinite(t5) ? String(t5) : r2[e10] ?? e10;
  }
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`:
        return `Invalid input: expected ${i3(e10.expected)}, received ${i3(D(e10.input), e10.input)}`;
      case `invalid_value`:
        return e10.values.length === 1 ? `Invalid input: expected ${C(e10.values[0])}` : `Invalid option: expected one of ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.exact ? `exactly ` : e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Too big: expected ${e10.origin ?? `value`} to have ${n4}${e10.maximum.toString()} ${r3.unit ?? `elements`}` : `Too big: expected ${e10.origin ?? `value`} to be ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.exact ? `exactly ` : e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Too small: expected ${e10.origin} to have ${n4}${e10.minimum.toString()} ${r3.unit}` : `Too small: expected ${e10.origin} to be ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Invalid string: must start with "${t5.prefix}"` : t5.format === `ends_with` ? `Invalid string: must end with "${t5.suffix}"` : t5.format === `includes` ? `Invalid string: must include "${t5.includes}"` : t5.format === `regex` ? `Invalid string: must match pattern ${t5.pattern}` : `Invalid ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Invalid number: must be a multiple of ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Unrecognized key${e10.keys.length > 1 ? `s` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Invalid key in ${e10.origin}`;
      case `invalid_union`:
        return e10.options && Array.isArray(e10.options) && e10.options.length > 0 ? `Invalid discriminator value. Expected ${e10.options.map((e11) => `'${e11}'`).join(` | `)}` : e10.inclusive === false ? `Invalid input: more than one option matched` : `Invalid input`;
      case `invalid_element`:
        return `Invalid value in ${e10.origin}`;
      default:
        return `Invalid input`;
    }
  };
};
function ko() {
  return { localeError: Oo() };
}
var Ao = () => {
  let e9 = { string: { unit: `karaktrojn`, verb: `havi` }, file: { unit: `bajtojn`, verb: `havi` }, array: { unit: `elementojn`, verb: `havi` }, set: { unit: `elementojn`, verb: `havi` }, map: { unit: `elementojn`, verb: `havi` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `enigo`, email: `retadreso`, url: `URL`, emoji: `emo\u011Dio`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO-datotempo`, date: `ISO-dato`, time: `ISO-tempo`, duration: `ISO-da\u016Dro`, ipv4: `IPv4-adreso`, ipv6: `IPv6-adreso`, mac: `MAC-adreso`, cidrv4: `IPv4-rango`, cidrv6: `IPv6-rango`, base64: `64-ume kodita karaktraro`, base64url: `URL-64-ume kodita karaktraro`, json_string: `JSON-karaktraro`, e164: `E.164-nombro`, credit_card: `kreditkarta numero`, jwt: `JWT`, template_literal: `enigo` }, r2 = { nan: `NaN`, number: `nombro`, array: `tabelo`, null: `senvalora` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Nevalida enigo: atendi\u011Dis instanceof ${e10.expected}, ricevi\u011Dis ${i3}` : `Nevalida enigo: atendi\u011Dis ${t5}, ricevi\u011Dis ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Nevalida enigo: atendi\u011Dis ${C(e10.values[0])}` : `Nevalida opcio: atendi\u011Dis unu el ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Tro granda: atendi\u011Dis ke ${e10.origin ?? `valoro`} havu ${n4}${e10.maximum.toString()} ${r3.unit ?? `elementojn`}` : `Tro granda: atendi\u011Dis ke ${e10.origin ?? `valoro`} havu ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Tro malgranda: atendi\u011Dis ke ${e10.origin} havu ${n4}${e10.minimum.toString()} ${r3.unit}` : `Tro malgranda: atendi\u011Dis ke ${e10.origin} estu ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Nevalida karaktraro: devas komenci\u011Di per "${t5.prefix}"` : t5.format === `ends_with` ? `Nevalida karaktraro: devas fini\u011Di per "${t5.suffix}"` : t5.format === `includes` ? `Nevalida karaktraro: devas inkluzivi "${t5.includes}"` : t5.format === `regex` ? `Nevalida karaktraro: devas kongrui kun la modelo ${t5.pattern}` : `Nevalida ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Nevalida nombro: devas esti oblo de ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Nekonata${e10.keys.length > 1 ? `j` : ``} \u015Dlosilo${e10.keys.length > 1 ? `j` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Nevalida \u015Dlosilo en ${e10.origin}`;
      case `invalid_union`:
        return `Nevalida enigo`;
      case `invalid_element`:
        return `Nevalida valoro en ${e10.origin}`;
      default:
        return `Nevalida enigo`;
    }
  };
};
function jo() {
  return { localeError: Ao() };
}
var Mo = () => {
  let e9 = { string: { unit: `caracteres`, verb: `tener` }, file: { unit: `bytes`, verb: `tener` }, array: { unit: `elementos`, verb: `tener` }, set: { unit: `elementos`, verb: `tener` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `entrada`, email: `direcci\xF3n de correo electr\xF3nico`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `fecha y hora ISO`, date: `fecha ISO`, time: `hora ISO`, duration: `duraci\xF3n ISO`, ipv4: `direcci\xF3n IPv4`, ipv6: `direcci\xF3n IPv6`, mac: `direcci\xF3n MAC`, cidrv4: `rango IPv4`, cidrv6: `rango IPv6`, base64: `cadena codificada en base64`, base64url: `URL codificada en base64`, json_string: `cadena JSON`, e164: `n\xFAmero E.164`, credit_card: `n\xFAmero de tarjeta de cr\xE9dito`, jwt: `JWT`, template_literal: `entrada` }, r2 = { nan: `NaN`, string: `texto`, number: `n\xFAmero`, boolean: `booleano`, array: `arreglo`, object: `objeto`, set: `conjunto`, file: `archivo`, date: `fecha`, bigint: `n\xFAmero grande`, symbol: `s\xEDmbolo`, undefined: `indefinido`, null: `nulo`, function: `funci\xF3n`, map: `mapa`, record: `registro`, tuple: `tupla`, enum: `enumeraci\xF3n`, union: `uni\xF3n`, literal: `literal`, promise: `promesa`, void: `vac\xEDo`, never: `nunca`, unknown: `desconocido`, any: `cualquiera` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Entrada inv\xE1lida: se esperaba instanceof ${e10.expected}, recibido ${i3}` : `Entrada inv\xE1lida: se esperaba ${t5}, recibido ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Entrada inv\xE1lida: se esperaba ${C(e10.values[0])}` : `Opci\xF3n inv\xE1lida: se esperaba una de ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, i3 = t4(e10.origin), a3 = r2[e10.origin] ?? e10.origin;
        return i3 ? `Demasiado grande: se esperaba que ${a3 ?? `valor`} tuviera ${n4}${e10.maximum.toString()} ${i3.unit ?? `elementos`}` : `Demasiado grande: se esperaba que ${a3 ?? `valor`} fuera ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, i3 = t4(e10.origin), a3 = r2[e10.origin] ?? e10.origin;
        return i3 ? `Demasiado peque\xF1o: se esperaba que ${a3} tuviera ${n4}${e10.minimum.toString()} ${i3.unit}` : `Demasiado peque\xF1o: se esperaba que ${a3} fuera ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Cadena inv\xE1lida: debe comenzar con "${t5.prefix}"` : t5.format === `ends_with` ? `Cadena inv\xE1lida: debe terminar en "${t5.suffix}"` : t5.format === `includes` ? `Cadena inv\xE1lida: debe incluir "${t5.includes}"` : t5.format === `regex` ? `Cadena inv\xE1lida: debe coincidir con el patr\xF3n ${t5.pattern}` : `Inv\xE1lido ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `N\xFAmero inv\xE1lido: debe ser m\xFAltiplo de ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Llave${e10.keys.length > 1 ? `s` : ``} desconocida${e10.keys.length > 1 ? `s` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Llave inv\xE1lida en ${r2[e10.origin] ?? e10.origin}`;
      case `invalid_union`:
        return `Entrada inv\xE1lida`;
      case `invalid_element`:
        return `Valor inv\xE1lido en ${r2[e10.origin] ?? e10.origin}`;
      default:
        return `Entrada inv\xE1lida`;
    }
  };
};
function No() {
  return { localeError: Mo() };
}
var Po = () => {
  let e9 = { string: { unit: `\u06A9\u0627\u0631\u0627\u06A9\u062A\u0631`, verb: `\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F` }, file: { unit: `\u0628\u0627\u06CC\u062A`, verb: `\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F` }, array: { unit: `\u0622\u06CC\u062A\u0645`, verb: `\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F` }, set: { unit: `\u0622\u06CC\u062A\u0645`, verb: `\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F` }, map: { unit: `\u0622\u06CC\u062A\u0645`, verb: `\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0648\u0631\u0648\u062F\u06CC`, email: `\u0622\u062F\u0631\u0633 \u0627\u06CC\u0645\u06CC\u0644`, url: `URL`, emoji: `\u0627\u06CC\u0645\u0648\u062C\u06CC`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `\u062A\u0627\u0631\u06CC\u062E \u0648 \u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648`, date: `\u062A\u0627\u0631\u06CC\u062E \u0627\u06CC\u0632\u0648`, time: `\u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648`, duration: `\u0645\u062F\u062A \u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648`, ipv4: `IPv4 \u0622\u062F\u0631\u0633`, ipv6: `IPv6 \u0622\u062F\u0631\u0633`, mac: `MAC \u0622\u062F\u0631\u0633`, cidrv4: `IPv4 \u062F\u0627\u0645\u0646\u0647`, cidrv6: `IPv6 \u062F\u0627\u0645\u0646\u0647`, base64: `base64-encoded \u0631\u0634\u062A\u0647`, base64url: `base64url-encoded \u0631\u0634\u062A\u0647`, json_string: `JSON \u0631\u0634\u062A\u0647`, e164: `E.164 \u0639\u062F\u062F`, credit_card: `\u0634\u0645\u0627\u0631\u0647 \u06A9\u0627\u0631\u062A \u0627\u0639\u062A\u0628\u0627\u0631\u06CC`, jwt: `JWT`, template_literal: `\u0648\u0631\u0648\u062F\u06CC` }, r2 = { nan: `NaN`, number: `\u0639\u062F\u062F`, array: `\u0622\u0631\u0627\u06CC\u0647` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A instanceof ${e10.expected} \u0645\u06CC\u200C\u0628\u0648\u062F\u060C ${i3} \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u062F` : `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A ${t5} \u0645\u06CC\u200C\u0628\u0648\u062F\u060C ${i3} \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u062F`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A ${C(e10.values[0])} \u0645\u06CC\u200C\u0628\u0648\u062F` : `\u06AF\u0632\u06CC\u0646\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A \u06CC\u06A9\u06CC \u0627\u0632 ${l(e10.values, `|`)} \u0645\u06CC\u200C\u0628\u0648\u062F`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u062E\u06CC\u0644\u06CC \u0628\u0632\u0631\u06AF: ${e10.origin ?? `\u0645\u0642\u062F\u0627\u0631`} \u0628\u0627\u06CC\u062F ${n4}${e10.maximum.toString()} ${r3.unit ?? `\u0639\u0646\u0635\u0631`} \u0628\u0627\u0634\u062F` : `\u062E\u06CC\u0644\u06CC \u0628\u0632\u0631\u06AF: ${e10.origin ?? `\u0645\u0642\u062F\u0627\u0631`} \u0628\u0627\u06CC\u062F ${n4}${e10.maximum.toString()} \u0628\u0627\u0634\u062F`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u062E\u06CC\u0644\u06CC \u06A9\u0648\u0686\u06A9: ${e10.origin} \u0628\u0627\u06CC\u062F ${n4}${e10.minimum.toString()} ${r3.unit} \u0628\u0627\u0634\u062F` : `\u062E\u06CC\u0644\u06CC \u06A9\u0648\u0686\u06A9: ${e10.origin} \u0628\u0627\u06CC\u062F ${n4}${e10.minimum.toString()} \u0628\u0627\u0634\u062F`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 "${t5.prefix}" \u0634\u0631\u0648\u0639 \u0634\u0648\u062F` : t5.format === `ends_with` ? `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 "${t5.suffix}" \u062A\u0645\u0627\u0645 \u0634\u0648\u062F` : t5.format === `includes` ? `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0634\u0627\u0645\u0644 "${t5.includes}" \u0628\u0627\u0634\u062F` : t5.format === `regex` ? `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 \u0627\u0644\u06AF\u0648\u06CC ${t5.pattern} \u0645\u0637\u0627\u0628\u0642\u062A \u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F` : `${n3[t5.format] ?? e10.format} \u0646\u0627\u0645\u0639\u062A\u0628\u0631`;
      }
      case `not_multiple_of`:
        return `\u0639\u062F\u062F \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0645\u0636\u0631\u0628 ${e10.divisor} \u0628\u0627\u0634\u062F`;
      case `unrecognized_keys`:
        return `\u06A9\u0644\u06CC\u062F${e10.keys.length > 1 ? `\u0647\u0627\u06CC` : ``} \u0646\u0627\u0634\u0646\u0627\u0633: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u06A9\u0644\u06CC\u062F \u0646\u0627\u0634\u0646\u0627\u0633 \u062F\u0631 ${e10.origin}`;
      case `invalid_union`:
        return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631`;
      case `invalid_element`:
        return `\u0645\u0642\u062F\u0627\u0631 \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u062F\u0631 ${e10.origin}`;
      default:
        return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631`;
    }
  };
};
function Fo() {
  return { localeError: Po() };
}
var Io = () => {
  let e9 = { string: { unit: `merkki\xE4`, subject: `merkkijonon` }, file: { unit: `tavua`, subject: `tiedoston` }, array: { unit: `alkiota`, subject: `listan` }, set: { unit: `alkiota`, subject: `joukon` }, map: { unit: `alkiota`, subject: `kuvauksen` }, number: { unit: ``, subject: `luvun` }, bigint: { unit: ``, subject: `suuren kokonaisluvun` }, int: { unit: ``, subject: `kokonaisluvun` }, date: { unit: ``, subject: `p\xE4iv\xE4m\xE4\xE4r\xE4n` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `s\xE4\xE4nn\xF6llinen lauseke`, email: `s\xE4hk\xF6postiosoite`, url: `URL-osoite`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO-aikaleima`, date: `ISO-p\xE4iv\xE4m\xE4\xE4r\xE4`, time: `ISO-aika`, duration: `ISO-kesto`, ipv4: `IPv4-osoite`, ipv6: `IPv6-osoite`, mac: `MAC-osoite`, cidrv4: `IPv4-alue`, cidrv6: `IPv6-alue`, base64: `base64-koodattu merkkijono`, base64url: `base64url-koodattu merkkijono`, json_string: `JSON-merkkijono`, e164: `E.164-luku`, credit_card: `luottokortin numero`, jwt: `JWT`, template_literal: `templaattimerkkijono` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Virheellinen tyyppi: odotettiin instanceof ${e10.expected}, oli ${i3}` : `Virheellinen tyyppi: odotettiin ${t5}, oli ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Virheellinen sy\xF6te: t\xE4ytyy olla ${C(e10.values[0])}` : `Virheellinen valinta: t\xE4ytyy olla yksi seuraavista: ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Liian suuri: ${r3.subject} t\xE4ytyy olla ${n4}${e10.maximum.toString()} ${r3.unit}`.trim() : `Liian suuri: arvon t\xE4ytyy olla ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Liian pieni: ${r3.subject} t\xE4ytyy olla ${n4}${e10.minimum.toString()} ${r3.unit}`.trim() : `Liian pieni: arvon t\xE4ytyy olla ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Virheellinen sy\xF6te: t\xE4ytyy alkaa "${t5.prefix}"` : t5.format === `ends_with` ? `Virheellinen sy\xF6te: t\xE4ytyy loppua "${t5.suffix}"` : t5.format === `includes` ? `Virheellinen sy\xF6te: t\xE4ytyy sis\xE4lt\xE4\xE4 "${t5.includes}"` : t5.format === `regex` ? `Virheellinen sy\xF6te: t\xE4ytyy vastata s\xE4\xE4nn\xF6llist\xE4 lauseketta ${t5.pattern}` : `Virheellinen ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Virheellinen luku: t\xE4ytyy olla luvun ${e10.divisor} monikerta`;
      case `unrecognized_keys`:
        return `${e10.keys.length > 1 ? `Tuntemattomat avaimet` : `Tuntematon avain`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Virheellinen avain tietueessa`;
      case `invalid_union`:
        return `Virheellinen unioni`;
      case `invalid_element`:
        return `Virheellinen arvo joukossa`;
      default:
        return `Virheellinen sy\xF6te`;
    }
  };
};
function Lo() {
  return { localeError: Io() };
}
var Ro = () => {
  let e9 = { string: { unit: `caract\xE8res`, verb: `avoir` }, file: { unit: `octets`, verb: `avoir` }, array: { unit: `\xE9l\xE9ments`, verb: `avoir` }, set: { unit: `\xE9l\xE9ments`, verb: `avoir` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `expression r\xE9guli\xE8re`, email: `adresse e-mail`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `date et heure ISO`, date: `date ISO`, time: `heure ISO`, duration: `dur\xE9e ISO`, ipv4: `adresse IPv4`, ipv6: `adresse IPv6`, mac: `adresse MAC`, cidrv4: `plage IPv4`, cidrv6: `plage IPv6`, base64: `cha\xEEne de caract\xE8res encod\xE9e en base64`, base64url: `cha\xEEne de caract\xE8res encod\xE9e en base64url`, json_string: `cha\xEEne de caract\xE8res JSON`, e164: `num\xE9ro au format E.164`, credit_card: `num\xE9ro de carte de cr\xE9dit`, jwt: `JWT`, template_literal: `entr\xE9e` }, r2 = { string: `cha\xEEne de caract\xE8res`, number: `nombre`, int: `entier`, boolean: `bool\xE9en`, bigint: `grand entier`, symbol: `symbole`, undefined: `ind\xE9fini`, null: `null`, never: `jamais`, void: `vide`, date: `date`, array: `tableau`, object: `objet`, tuple: `tuple`, record: `record`, map: `map`, set: `ensemble`, file: `fichier`, nonoptional: `non optionnel`, nan: `NaN`, function: `fonction` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Entr\xE9e invalide : instance de ${e10.expected} attendu, ${i3} re\xE7u` : `Entr\xE9e invalide : ${t5} attendu, ${i3} re\xE7u`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Entr\xE9e invalide : ${C(e10.values[0])} attendu` : `Option invalide : une valeur parmi ${l(e10.values, `|`)} attendue`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, i3 = t4(e10.origin);
        return i3 ? `Trop grand : ${r2[e10.origin] ?? `valeur`} doit ${i3.verb} ${n4}${e10.maximum.toString()} ${i3.unit ?? `\xE9l\xE9ment(s)`}` : `Trop grand : ${r2[e10.origin] ?? `valeur`} doit \xEAtre ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, i3 = t4(e10.origin);
        return i3 ? `Trop petit : ${r2[e10.origin] ?? `valeur`} doit ${i3.verb} ${n4}${e10.minimum.toString()} ${i3.unit}` : `Trop petit : ${r2[e10.origin] ?? `valeur`} doit \xEAtre ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Cha\xEEne de caract\xE8res invalide : doit commencer par "${t5.prefix}"` : t5.format === `ends_with` ? `Cha\xEEne de caract\xE8res invalide : doit se terminer par "${t5.suffix}"` : t5.format === `includes` ? `Cha\xEEne de caract\xE8res invalide : doit inclure "${t5.includes}"` : t5.format === `regex` ? `Cha\xEEne de caract\xE8res invalide : doit correspondre au motif ${t5.pattern}` : `${n3[t5.format] ?? e10.format} invalide`;
      }
      case `not_multiple_of`:
        return `Nombre invalide : doit \xEAtre un multiple de ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Cl\xE9${e10.keys.length > 1 ? `s` : ``} non reconnue${e10.keys.length > 1 ? `s` : ``} : ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Cl\xE9 invalide dans ${e10.origin}`;
      case `invalid_union`:
        return `Entr\xE9e invalide`;
      case `invalid_element`:
        return `Valeur invalide dans ${e10.origin}`;
      default:
        return `Entr\xE9e invalide`;
    }
  };
};
function zo() {
  return { localeError: Ro() };
}
var Bo = () => {
  let e9 = { string: { unit: `caract\xE8res`, verb: `avoir` }, file: { unit: `octets`, verb: `avoir` }, array: { unit: `\xE9l\xE9ments`, verb: `avoir` }, set: { unit: `\xE9l\xE9ments`, verb: `avoir` }, map: { unit: `\xE9l\xE9ments`, verb: `avoir` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `entr\xE9e`, email: `adresse courriel`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `date-heure ISO`, date: `date ISO`, time: `heure ISO`, duration: `dur\xE9e ISO`, ipv4: `adresse IPv4`, ipv6: `adresse IPv6`, mac: `adresse MAC`, cidrv4: `plage IPv4`, cidrv6: `plage IPv6`, base64: `cha\xEEne encod\xE9e en base64`, base64url: `cha\xEEne encod\xE9e en base64url`, json_string: `cha\xEEne JSON`, e164: `num\xE9ro E.164`, credit_card: `num\xE9ro de carte de cr\xE9dit`, jwt: `JWT`, template_literal: `entr\xE9e` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Entr\xE9e invalide : attendu instanceof ${e10.expected}, re\xE7u ${i3}` : `Entr\xE9e invalide : attendu ${t5}, re\xE7u ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Entr\xE9e invalide : attendu ${C(e10.values[0])}` : `Option invalide : attendu l'une des valeurs suivantes ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `\u2264` : `<`, r3 = t4(e10.origin);
        return r3 ? `Trop grand : attendu que ${e10.origin ?? `la valeur`} ait ${n4}${e10.maximum.toString()} ${r3.unit}` : `Trop grand : attendu que ${e10.origin ?? `la valeur`} soit ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `\u2265` : `>`, r3 = t4(e10.origin);
        return r3 ? `Trop petit : attendu que ${e10.origin} ait ${n4}${e10.minimum.toString()} ${r3.unit}` : `Trop petit : attendu que ${e10.origin} soit ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Cha\xEEne invalide : doit commencer par "${t5.prefix}"` : t5.format === `ends_with` ? `Cha\xEEne invalide : doit se terminer par "${t5.suffix}"` : t5.format === `includes` ? `Cha\xEEne invalide : doit inclure "${t5.includes}"` : t5.format === `regex` ? `Cha\xEEne invalide : doit correspondre au motif ${t5.pattern}` : `${n3[t5.format] ?? e10.format} invalide`;
      }
      case `not_multiple_of`:
        return `Nombre invalide : doit \xEAtre un multiple de ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Cl\xE9${e10.keys.length > 1 ? `s` : ``} non reconnue${e10.keys.length > 1 ? `s` : ``} : ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Cl\xE9 invalide dans ${e10.origin}`;
      case `invalid_union`:
        return `Entr\xE9e invalide`;
      case `invalid_element`:
        return `Valeur invalide dans ${e10.origin}`;
      default:
        return `Entr\xE9e invalide`;
    }
  };
};
function Vo() {
  return { localeError: Bo() };
}
var Ho = () => {
  let e9 = { string: { unit: `\u0A85\u0A95\u0ACD\u0AB7\u0AB0`, verb: `\u0AB9\u0ACB\u0AB5\u0ABE \u0A9C\u0ACB\u0A88\u0A8F` }, file: { unit: `\u0AAC\u0ABE\u0AAF\u0A9F`, verb: `\u0AB9\u0ACB\u0AB5\u0ABE \u0A9C\u0ACB\u0A88\u0A8F` }, array: { unit: `\u0A86\u0A87\u0A9F\u0AAE`, verb: `\u0AB9\u0ACB\u0AB5\u0ABE \u0A9C\u0ACB\u0A88\u0A8F` }, set: { unit: `\u0A86\u0A87\u0A9F\u0AAE`, verb: `\u0AB9\u0ACB\u0AB5\u0ABE \u0A9C\u0ACB\u0A88\u0A8F` }, map: { unit: `\u0A8F\u0AA8\u0ACD\u0A9F\u0ACD\u0AB0\u0AC0`, verb: `\u0AB9\u0ACB\u0AB5\u0ABE \u0A9C\u0ACB\u0A88\u0A8F` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0A87\u0AA8\u0AAA\u0AC1\u0A9F`, email: `\u0A88\u0AAE\u0AC7\u0A87\u0AB2 \u0A8F\u0AA1\u0ACD\u0AB0\u0AC7\u0AB8`, url: `URL`, emoji: `\u0A87\u0AAE\u0ACB\u0A9C\u0AC0`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \u0AA4\u0ABE\u0AB0\u0AC0\u0A96 \u0A85\u0AA8\u0AC7 \u0AB8\u0AAE\u0AAF`, date: `ISO \u0AA4\u0ABE\u0AB0\u0AC0\u0A96`, time: `ISO \u0AB8\u0AAE\u0AAF`, duration: `ISO \u0A85\u0AB5\u0AA7\u0ABF`, ipv4: `IPv4 \u0A8F\u0AA1\u0ACD\u0AB0\u0AC7\u0AB8`, ipv6: `IPv6 \u0A8F\u0AA1\u0ACD\u0AB0\u0AC7\u0AB8`, mac: `MAC \u0A8F\u0AA1\u0ACD\u0AB0\u0AC7\u0AB8`, cidrv4: `IPv4 \u0AB6\u0ACD\u0AB0\u0AC7\u0AA3\u0AC0`, cidrv6: `IPv6 \u0AB6\u0ACD\u0AB0\u0AC7\u0AA3\u0AC0`, base64: `base64-\u0A8F\u0AA8\u0ACD\u0A95\u0ACB\u0AA1\u0AC7\u0AA1 \u0AB8\u0ACD\u0A9F\u0ACD\u0AB0\u0ABF\u0A82\u0A97`, base64url: `base64url-\u0A8F\u0AA8\u0ACD\u0A95\u0ACB\u0AA1\u0AC7\u0AA1 \u0AB8\u0ACD\u0A9F\u0ACD\u0AB0\u0ABF\u0A82\u0A97`, json_string: `JSON \u0AB8\u0ACD\u0A9F\u0ACD\u0AB0\u0ABF\u0A82\u0A97`, e164: `E.164 \u0AA8\u0A82\u0AAC\u0AB0`, credit_card: `\u0A95\u0ACD\u0AB0\u0AC7\u0AA1\u0ABF\u0A9F \u0A95\u0ABE\u0AB0\u0ACD\u0AA1 \u0AA8\u0A82\u0AAC\u0AB0`, jwt: `JWT`, template_literal: `\u0A87\u0AA8\u0AAA\u0AC1\u0A9F` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input);
        return `\u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0A87\u0AA8\u0AAA\u0AC1\u0A9F: \u0A85\u0AAA\u0AC7\u0A95\u0ACD\u0AB7\u0ABF\u0AA4 ${t5}, \u0AAA\u0ACD\u0AB0\u0ABE\u0AAA\u0ACD\u0AA4 ${r2[n4] ?? n4}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0A87\u0AA8\u0AAA\u0AC1\u0A9F: \u0A85\u0AAA\u0AC7\u0A95\u0ACD\u0AB7\u0ABF\u0AA4 ${C(e10.values[0])}` : `\u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0AB5\u0ABF\u0A95\u0AB2\u0ACD\u0AAA: ${l(e10.values, ` | `)} \u0AAE\u0ABE\u0AA7\u0ACD\u0AAF\u0AAE\u0AA5\u0AC0 \u0A8F\u0A95 \u0A85\u0AAA\u0AC7\u0A95\u0ACD\u0AB7\u0ABF\u0AA4`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u0A96\u0AC2\u0AAC \u0AAE\u0ACB\u0A9F\u0AC1\u0A82: ${e10.origin ?? `\u0AAE\u0AC2\u0AB2\u0ACD\u0AAF`} ${n4}${e10.maximum.toString()} ${r3.unit ?? `\u0A8F\u0AB2\u0ABF\u0AAE\u0AC7\u0AA8\u0ACD\u0A9F`} \u0AB9\u0ACB\u0AB5\u0ABE \u0A9C\u0ACB\u0A88\u0A8F` : `\u0A96\u0AC2\u0AAC \u0AAE\u0ACB\u0A9F\u0AC1\u0A82: ${e10.origin ?? `\u0AAE\u0AC2\u0AB2\u0ACD\u0AAF`} ${n4}${e10.maximum.toString()} \u0AB9\u0ACB\u0AB5\u0AC1\u0A82 \u0A9C\u0ACB\u0A88\u0A8F`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u0A96\u0AC2\u0AAC \u0AA8\u0ABE\u0AA8\u0AC1\u0A82: ${e10.origin} ${n4}${e10.minimum.toString()} ${r3.unit} \u0AB9\u0ACB\u0AB5\u0ABE \u0A9C\u0ACB\u0A88\u0A8F` : `\u0A96\u0AC2\u0AAC \u0AA8\u0ABE\u0AA8\u0AC1\u0A82: ${e10.origin} ${n4}${e10.minimum.toString()} \u0AB9\u0ACB\u0AB5\u0AC1\u0A82 \u0A9C\u0ACB\u0A88\u0A8F`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0AB8\u0ACD\u0A9F\u0ACD\u0AB0\u0ABF\u0A82\u0A97: "${t5.prefix}" \u0AA5\u0AC0 \u0AB6\u0AB0\u0AC2 \u0AA5\u0AB5\u0AC1\u0A82 \u0A9C\u0ACB\u0A88\u0A8F` : t5.format === `ends_with` ? `\u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0AB8\u0ACD\u0A9F\u0ACD\u0AB0\u0ABF\u0A82\u0A97: "${t5.suffix}" \u0AAA\u0AB0 \u0AB8\u0AAE\u0ABE\u0AAA\u0ACD\u0AA4 \u0AA5\u0AB5\u0AC1\u0A82 \u0A9C\u0ACB\u0A88\u0A8F` : t5.format === `includes` ? `\u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0AB8\u0ACD\u0A9F\u0ACD\u0AB0\u0ABF\u0A82\u0A97: "${t5.includes}" \u0AB6\u0ABE\u0AAE\u0AC7\u0AB2 \u0AB9\u0ACB\u0AB5\u0AC1\u0A82 \u0A9C\u0ACB\u0A88\u0A8F` : t5.format === `regex` ? `\u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0AB8\u0ACD\u0A9F\u0ACD\u0AB0\u0ABF\u0A82\u0A97: \u0AAA\u0AC7\u0A9F\u0AB0\u0ACD\u0AA8 ${t5.pattern} \u0AB8\u0ABE\u0AA5\u0AC7 \u0AAE\u0AC7\u0AB3 \u0A96\u0ABE\u0AB5\u0AC1\u0A82 \u0A9C\u0ACB\u0A88\u0A8F` : `\u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0AA8\u0A82\u0AAC\u0AB0: ${e10.divisor} \u0AA8\u0ACB \u0A97\u0AC1\u0AA3\u0ABE\u0A82\u0A95 \u0AB9\u0ACB\u0AB5\u0ACB \u0A9C\u0ACB\u0A88\u0A8F`;
      case `unrecognized_keys`:
        return `\u0A93\u0AB3\u0A96\u0AC0 \u0AB6\u0A95\u0ABE\u0AA4\u0ABE \u0AA8\u0AB9\u0AC0\u0A82 \u0AA4\u0AC7 \u0A95\u0AC0${e10.keys.length > 1 ? `\u0A93` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `${e10.origin} \u0AAE\u0ABE\u0A82 \u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0A95\u0AC0`;
      case `invalid_union`:
        return e10.options && Array.isArray(e10.options) && e10.options.length > 0 ? `\u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0AA1\u0ABF\u0AB8\u0ACD\u0A95\u0ACD\u0AB0\u0ABF\u0AAE\u0ABF\u0AA8\u0AC7\u0A9F\u0AB0 \u0AAE\u0AC2\u0AB2\u0ACD\u0AAF. \u0A85\u0AAA\u0AC7\u0A95\u0ACD\u0AB7\u0ABF\u0AA4 ${e10.options.map((e11) => `'${e11}'`).join(` | `)}` : `\u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0A87\u0AA8\u0AAA\u0AC1\u0A9F`;
      case `invalid_element`:
        return `${e10.origin} \u0AAE\u0ABE\u0A82 \u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0AAE\u0AC2\u0AB2\u0ACD\u0AAF`;
      default:
        return `\u0A85\u0AAE\u0ABE\u0AA8\u0ACD\u0AAF \u0A87\u0AA8\u0AAA\u0AC1\u0A9F`;
    }
  };
};
function Uo() {
  return { localeError: Ho() };
}
var Wo = () => {
  let e9 = { string: { label: `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA`, gender: `f` }, number: { label: `\u05DE\u05E1\u05E4\u05E8`, gender: `m` }, boolean: { label: `\u05E2\u05E8\u05DA \u05D1\u05D5\u05DC\u05D9\u05D0\u05E0\u05D9`, gender: `m` }, bigint: { label: `BigInt`, gender: `m` }, date: { label: `\u05EA\u05D0\u05E8\u05D9\u05DA`, gender: `m` }, array: { label: `\u05DE\u05E2\u05E8\u05DA`, gender: `m` }, object: { label: `\u05D0\u05D5\u05D1\u05D9\u05D9\u05E7\u05D8`, gender: `m` }, null: { label: `\u05E2\u05E8\u05DA \u05E8\u05D9\u05E7 (null)`, gender: `m` }, undefined: { label: `\u05E2\u05E8\u05DA \u05DC\u05D0 \u05DE\u05D5\u05D2\u05D3\u05E8 (undefined)`, gender: `m` }, symbol: { label: `\u05E1\u05D9\u05DE\u05D1\u05D5\u05DC (Symbol)`, gender: `m` }, function: { label: `\u05E4\u05D5\u05E0\u05E7\u05E6\u05D9\u05D4`, gender: `f` }, map: { label: `\u05DE\u05E4\u05D4 (Map)`, gender: `f` }, set: { label: `\u05E7\u05D1\u05D5\u05E6\u05D4 (Set)`, gender: `f` }, file: { label: `\u05E7\u05D5\u05D1\u05E5`, gender: `m` }, promise: { label: `Promise`, gender: `m` }, NaN: { label: `NaN`, gender: `m` }, unknown: { label: `\u05E2\u05E8\u05DA \u05DC\u05D0 \u05D9\u05D3\u05D5\u05E2`, gender: `m` }, value: { label: `\u05E2\u05E8\u05DA`, gender: `m` } }, t4 = { string: { unit: `\u05EA\u05D5\u05D5\u05D9\u05DD`, shortLabel: `\u05E7\u05E6\u05E8`, longLabel: `\u05D0\u05E8\u05D5\u05DA` }, file: { unit: `\u05D1\u05D9\u05D9\u05D8\u05D9\u05DD`, shortLabel: `\u05E7\u05D8\u05DF`, longLabel: `\u05D2\u05D3\u05D5\u05DC` }, array: { unit: `\u05E4\u05E8\u05D9\u05D8\u05D9\u05DD`, shortLabel: `\u05E7\u05D8\u05DF`, longLabel: `\u05D2\u05D3\u05D5\u05DC` }, set: { unit: `\u05E4\u05E8\u05D9\u05D8\u05D9\u05DD`, shortLabel: `\u05E7\u05D8\u05DF`, longLabel: `\u05D2\u05D3\u05D5\u05DC` }, number: { unit: ``, shortLabel: `\u05E7\u05D8\u05DF`, longLabel: `\u05D2\u05D3\u05D5\u05DC` } }, n3 = (t5) => t5 ? e9[t5] : void 0, r2 = (t5) => {
    let r3 = n3(t5);
    return r3 ? r3.label : t5 ?? e9.unknown.label;
  }, i3 = (e10) => `\u05D4${r2(e10)}`, a3 = (e10) => (n3(e10)?.gender ?? `m`) === `f` ? `\u05E6\u05E8\u05D9\u05DB\u05D4 \u05DC\u05D4\u05D9\u05D5\u05EA` : `\u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA`, o3 = (e10) => e10 ? t4[e10] ?? null : null, s3 = { regex: { label: `\u05E7\u05DC\u05D8`, gender: `m` }, email: { label: `\u05DB\u05EA\u05D5\u05D1\u05EA \u05D0\u05D9\u05DE\u05D9\u05D9\u05DC`, gender: `f` }, url: { label: `\u05DB\u05EA\u05D5\u05D1\u05EA \u05E8\u05E9\u05EA`, gender: `f` }, emoji: { label: `\u05D0\u05D9\u05DE\u05D5\u05D2'\u05D9`, gender: `m` }, uuid: { label: `UUID`, gender: `m` }, uuidv4: { label: `UUIDv4`, gender: `m` }, uuidv6: { label: `UUIDv6`, gender: `m` }, nanoid: { label: `nanoid`, gender: `m` }, guid: { label: `GUID`, gender: `m` }, cuid: { label: `cuid`, gender: `m` }, cuid2: { label: `cuid2`, gender: `m` }, ulid: { label: `ULID`, gender: `m` }, xid: { label: `XID`, gender: `m` }, ksuid: { label: `KSUID`, gender: `m` }, datetime: { label: `\u05EA\u05D0\u05E8\u05D9\u05DA \u05D5\u05D6\u05DE\u05DF ISO`, gender: `m` }, date: { label: `\u05EA\u05D0\u05E8\u05D9\u05DA ISO`, gender: `m` }, time: { label: `\u05D6\u05DE\u05DF ISO`, gender: `m` }, duration: { label: `\u05DE\u05E9\u05DA \u05D6\u05DE\u05DF ISO`, gender: `m` }, ipv4: { label: `\u05DB\u05EA\u05D5\u05D1\u05EA IPv4`, gender: `f` }, ipv6: { label: `\u05DB\u05EA\u05D5\u05D1\u05EA IPv6`, gender: `f` }, mac: { label: `\u05DB\u05EA\u05D5\u05D1\u05EA MAC`, gender: `f` }, cidrv4: { label: `\u05D8\u05D5\u05D5\u05D7 IPv4`, gender: `m` }, cidrv6: { label: `\u05D8\u05D5\u05D5\u05D7 IPv6`, gender: `m` }, base64: { label: `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D1\u05D1\u05E1\u05D9\u05E1 64`, gender: `f` }, base64url: { label: `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D1\u05D1\u05E1\u05D9\u05E1 64 \u05DC\u05DB\u05EA\u05D5\u05D1\u05D5\u05EA \u05E8\u05E9\u05EA`, gender: `f` }, json_string: { label: `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA JSON`, gender: `f` }, e164: { label: `\u05DE\u05E1\u05E4\u05E8 E.164`, gender: `m` }, credit_card: { label: `\u05DE\u05E1\u05E4\u05E8 \u05DB\u05E8\u05D8\u05D9\u05E1 \u05D0\u05E9\u05E8\u05D0\u05D9`, gender: `m` }, jwt: { label: `JWT`, gender: `m` }, template_literal: { label: `\u05E7\u05DC\u05D8`, gender: `m` }, ends_with: { label: `\u05E7\u05DC\u05D8`, gender: `m` }, includes: { label: `\u05E7\u05DC\u05D8`, gender: `m` }, lowercase: { label: `\u05E7\u05DC\u05D8`, gender: `m` }, starts_with: { label: `\u05E7\u05DC\u05D8`, gender: `m` }, uppercase: { label: `\u05E7\u05DC\u05D8`, gender: `m` } }, c3 = { nan: `NaN` };
  return (t5) => {
    switch (t5.code) {
      case `invalid_type`: {
        let n4 = t5.expected, i4 = c3[n4 ?? ``] ?? r2(n4), a4 = D(t5.input), o4 = c3[a4] ?? e9[a4]?.label ?? a4;
        return /^[A-Z]/.test(t5.expected) ? `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA instanceof ${t5.expected}, \u05D4\u05EA\u05E7\u05D1\u05DC ${o4}` : `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${i4}, \u05D4\u05EA\u05E7\u05D1\u05DC ${o4}`;
      }
      case `invalid_value`: {
        if (t5.values.length === 1) return `\u05E2\u05E8\u05DA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05D4\u05E2\u05E8\u05DA \u05D7\u05D9\u05D9\u05D1 \u05DC\u05D4\u05D9\u05D5\u05EA ${C(t5.values[0])}`;
        let e10 = t5.values.map((e11) => C(e11));
        if (t5.values.length === 2) return `\u05E2\u05E8\u05DA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05D4\u05D0\u05E4\u05E9\u05E8\u05D5\u05D9\u05D5\u05EA \u05D4\u05DE\u05EA\u05D0\u05D9\u05DE\u05D5\u05EA \u05D4\u05DF ${e10[0]} \u05D0\u05D5 ${e10[1]}`;
        let n4 = e10[e10.length - 1];
        return `\u05E2\u05E8\u05DA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05D4\u05D0\u05E4\u05E9\u05E8\u05D5\u05D9\u05D5\u05EA \u05D4\u05DE\u05EA\u05D0\u05D9\u05DE\u05D5\u05EA \u05D4\u05DF ${e10.slice(0, -1).join(`, `)} \u05D0\u05D5 ${n4}`;
      }
      case `too_big`: {
        let e10 = o3(t5.origin), n4 = i3(t5.origin ?? `value`);
        if (t5.origin === `string`) return `${e10?.longLabel ?? `\u05D0\u05E8\u05D5\u05DA`} \u05DE\u05D3\u05D9: ${n4} \u05E6\u05E8\u05D9\u05DB\u05D4 \u05DC\u05D4\u05DB\u05D9\u05DC ${t5.maximum.toString()} ${e10?.unit ?? ``} ${t5.inclusive ? `\u05D0\u05D5 \u05E4\u05D7\u05D5\u05EA` : `\u05DC\u05DB\u05DC \u05D4\u05D9\u05D5\u05EA\u05E8`}`.trim();
        if (t5.origin === `number`) return `\u05D2\u05D3\u05D5\u05DC \u05DE\u05D3\u05D9: ${n4} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${t5.inclusive ? `\u05E7\u05D8\u05DF \u05D0\u05D5 \u05E9\u05D5\u05D5\u05D4 \u05DC-${t5.maximum}` : `\u05E7\u05D8\u05DF \u05DE-${t5.maximum}`}`;
        if (t5.origin === `array` || t5.origin === `set`) return `\u05D2\u05D3\u05D5\u05DC \u05DE\u05D3\u05D9: ${n4} ${t5.origin === `set` ? `\u05E6\u05E8\u05D9\u05DB\u05D4` : `\u05E6\u05E8\u05D9\u05DA`} \u05DC\u05D4\u05DB\u05D9\u05DC ${t5.inclusive ? `${t5.maximum} ${e10?.unit ?? ``} \u05D0\u05D5 \u05E4\u05D7\u05D5\u05EA` : `\u05E4\u05D7\u05D5\u05EA \u05DE-${t5.maximum} ${e10?.unit ?? ``}`}`.trim();
        let r3 = t5.inclusive ? `<=` : `<`, s4 = a3(t5.origin ?? `value`);
        return e10?.unit ? `${e10.longLabel} \u05DE\u05D3\u05D9: ${n4} ${s4} ${r3}${t5.maximum.toString()} ${e10.unit}` : `${e10?.longLabel ?? `\u05D2\u05D3\u05D5\u05DC`} \u05DE\u05D3\u05D9: ${n4} ${s4} ${r3}${t5.maximum.toString()}`;
      }
      case `too_small`: {
        let e10 = o3(t5.origin), n4 = i3(t5.origin ?? `value`);
        if (t5.origin === `string`) return `${e10?.shortLabel ?? `\u05E7\u05E6\u05E8`} \u05DE\u05D3\u05D9: ${n4} \u05E6\u05E8\u05D9\u05DB\u05D4 \u05DC\u05D4\u05DB\u05D9\u05DC ${t5.minimum.toString()} ${e10?.unit ?? ``} ${t5.inclusive ? `\u05D0\u05D5 \u05D9\u05D5\u05EA\u05E8` : `\u05DC\u05E4\u05D7\u05D5\u05EA`}`.trim();
        if (t5.origin === `number`) return `\u05E7\u05D8\u05DF \u05DE\u05D3\u05D9: ${n4} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${t5.inclusive ? `\u05D2\u05D3\u05D5\u05DC \u05D0\u05D5 \u05E9\u05D5\u05D5\u05D4 \u05DC-${t5.minimum}` : `\u05D2\u05D3\u05D5\u05DC \u05DE-${t5.minimum}`}`;
        if (t5.origin === `array` || t5.origin === `set`) {
          let r4 = t5.origin === `set` ? `\u05E6\u05E8\u05D9\u05DB\u05D4` : `\u05E6\u05E8\u05D9\u05DA`;
          return t5.minimum === 1 && t5.inclusive ? `\u05E7\u05D8\u05DF \u05DE\u05D3\u05D9: ${n4} ${r4} \u05DC\u05D4\u05DB\u05D9\u05DC ${t5.origin, `\u05DC\u05E4\u05D7\u05D5\u05EA \u05E4\u05E8\u05D9\u05D8 \u05D0\u05D7\u05D3`}` : `\u05E7\u05D8\u05DF \u05DE\u05D3\u05D9: ${n4} ${r4} \u05DC\u05D4\u05DB\u05D9\u05DC ${t5.inclusive ? `${t5.minimum} ${e10?.unit ?? ``} \u05D0\u05D5 \u05D9\u05D5\u05EA\u05E8` : `\u05D9\u05D5\u05EA\u05E8 \u05DE-${t5.minimum} ${e10?.unit ?? ``}`}`.trim();
        }
        let r3 = t5.inclusive ? `>=` : `>`, s4 = a3(t5.origin ?? `value`);
        return e10?.unit ? `${e10.shortLabel} \u05DE\u05D3\u05D9: ${n4} ${s4} ${r3}${t5.minimum.toString()} ${e10.unit}` : `${e10?.shortLabel ?? `\u05E7\u05D8\u05DF`} \u05DE\u05D3\u05D9: ${n4} ${s4} ${r3}${t5.minimum.toString()}`;
      }
      case `invalid_format`: {
        let e10 = t5;
        if (e10.format === `starts_with`) return `\u05D4\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05EA\u05D7\u05D9\u05DC \u05D1 "${e10.prefix}"`;
        if (e10.format === `ends_with`) return `\u05D4\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05E1\u05EA\u05D9\u05D9\u05DD \u05D1 "${e10.suffix}"`;
        if (e10.format === `includes`) return `\u05D4\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05DB\u05DC\u05D5\u05DC "${e10.includes}"`;
        if (e10.format === `regex`) return `\u05D4\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05EA\u05D0\u05D9\u05DD \u05DC\u05EA\u05D1\u05E0\u05D9\u05EA ${e10.pattern}`;
        let n4 = s3[e10.format];
        return `${n4?.label ?? e10.format} \u05DC\u05D0 ${(n4?.gender ?? `m`) === `f` ? `\u05EA\u05E7\u05D9\u05E0\u05D4` : `\u05EA\u05E7\u05D9\u05DF`}`;
      }
      case `not_multiple_of`:
        return `\u05DE\u05E1\u05E4\u05E8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05D7\u05D9\u05D9\u05D1 \u05DC\u05D4\u05D9\u05D5\u05EA \u05DE\u05DB\u05E4\u05DC\u05D4 \u05E9\u05DC ${t5.divisor}`;
      case `unrecognized_keys`:
        return `\u05DE\u05E4\u05EA\u05D7${t5.keys.length > 1 ? `\u05D5\u05EA` : ``} \u05DC\u05D0 \u05DE\u05D6\u05D5\u05D4${t5.keys.length > 1 ? `\u05D9\u05DD` : `\u05D4`}: ${l(t5.keys, `, `)}`;
      case `invalid_key`:
        return `\u05E9\u05D3\u05D4 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF \u05D1\u05D0\u05D5\u05D1\u05D9\u05D9\u05E7\u05D8`;
      case `invalid_union`:
        return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF`;
      case `invalid_element`:
        return `\u05E2\u05E8\u05DA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF \u05D1${i3(t5.origin ?? `array`)}`;
      default:
        return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF`;
    }
  };
};
function Go() {
  return { localeError: Wo() };
}
var Ko = () => {
  let e9 = { string: { unit: `\u0905\u0915\u094D\u0937\u0930`, verb: `\u0930\u0916\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F` }, file: { unit: `\u092C\u093E\u0907\u091F\u094D\u0938`, verb: `\u0930\u0916\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F` }, array: { unit: `\u0924\u0924\u094D\u0935`, verb: `\u0930\u0916\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F` }, set: { unit: `\u0924\u0924\u094D\u0935`, verb: `\u0930\u0916\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F` }, map: { unit: `\u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F\u093F\u092F\u093E\u0901`, verb: `\u0930\u0916\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0907\u0928\u092A\u0941\u091F`, email: `\u0908\u092E\u0947\u0932 \u092A\u0924\u093E`, url: `URL`, emoji: `\u0907\u092E\u094B\u091C\u0940`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \u0924\u093F\u0925\u093F \u0914\u0930 \u0938\u092E\u092F`, date: `ISO \u0924\u093F\u0925\u093F`, time: `ISO \u0938\u092E\u092F`, duration: `ISO \u0905\u0935\u0927\u093F`, ipv4: `IPv4 \u092A\u0924\u093E`, ipv6: `IPv6 \u092A\u0924\u093E`, mac: `MAC \u092A\u0924\u093E`, cidrv4: `IPv4 \u0936\u094D\u0930\u0947\u0923\u0940`, cidrv6: `IPv6 \u0936\u094D\u0930\u0947\u0923\u0940`, base64: `Base64-\u090F\u0928\u094D\u0915\u094B\u0921\u0947\u0921 \u0938\u094D\u091F\u094D\u0930\u093F\u0902\u0917`, base64url: `Base64URL-\u090F\u0928\u094D\u0915\u094B\u0921\u0947\u0921 \u0938\u094D\u091F\u094D\u0930\u093F\u0902\u0917`, json_string: `JSON \u0938\u094D\u091F\u094D\u0930\u093F\u0902\u0917`, e164: `E.164 \u0938\u0902\u0916\u094D\u092F\u093E`, credit_card: `\u0915\u094D\u0930\u0947\u0921\u093F\u091F \u0915\u093E\u0930\u094D\u0921 \u0938\u0902\u0916\u094D\u092F\u093E`, jwt: `JWT`, template_literal: `\u0907\u0928\u092A\u0941\u091F` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input);
        return `\u0905\u092E\u093E\u0928\u094D\u092F \u0907\u0928\u092A\u0941\u091F: \u0905\u092A\u0947\u0915\u094D\u0937\u093F\u0924 ${t5}, \u092A\u094D\u0930\u093E\u092A\u094D\u0924 ${r2[n4] ?? n4}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u0905\u092E\u093E\u0928\u094D\u092F \u0907\u0928\u092A\u0941\u091F: \u0905\u092A\u0947\u0915\u094D\u0937\u093F\u0924 ${C(e10.values[0])}` : `\u0905\u092E\u093E\u0928\u094D\u092F \u0935\u093F\u0915\u0932\u094D\u092A: \u0905\u092A\u0947\u0915\u094D\u0937\u093F\u0924 \u092E\u093E\u0928\u094B\u0902 \u092E\u0947\u0902 \u0938\u0947 \u090F\u0915 ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u092C\u0939\u0941\u0924 \u092C\u0921\u093C\u093E: \u0905\u092A\u0947\u0915\u094D\u0937\u093F\u0924 \u0925\u093E \u0915\u093F ${e10.origin ?? `\u092E\u093E\u0928`} \u092E\u0947\u0902 ${n4}${e10.maximum} ${r3.unit} \u0939\u094B\u0902` : `\u092C\u0939\u0941\u0924 \u092C\u0921\u093C\u093E: \u0905\u092A\u0947\u0915\u094D\u0937\u093F\u0924 \u0925\u093E \u0915\u093F ${e10.origin ?? `\u092E\u093E\u0928`} ${n4}${e10.maximum} \u0939\u094B`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u092C\u0939\u0941\u0924 \u091B\u094B\u091F\u093E: \u0905\u092A\u0947\u0915\u094D\u0937\u093F\u0924 \u0925\u093E \u0915\u093F ${e10.origin} \u092E\u0947\u0902 ${n4}${e10.minimum} ${r3.unit} \u0939\u094B\u0902` : `\u092C\u0939\u0941\u0924 \u091B\u094B\u091F\u093E: \u0905\u092A\u0947\u0915\u094D\u0937\u093F\u0924 \u0925\u093E \u0915\u093F ${e10.origin} ${n4}${e10.minimum} \u0939\u094B`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u0905\u092E\u093E\u0928\u094D\u092F \u0938\u094D\u091F\u094D\u0930\u093F\u0902\u0917: "${t5.prefix}" \u0938\u0947 \u0936\u0941\u0930\u0942 \u0939\u094B\u0928\u093E \u091A\u093E\u0939\u093F\u090F` : t5.format === `ends_with` ? `\u0905\u092E\u093E\u0928\u094D\u092F \u0938\u094D\u091F\u094D\u0930\u093F\u0902\u0917: "${t5.suffix}" \u092A\u0930 \u0938\u092E\u093E\u092A\u094D\u0924 \u0939\u094B\u0928\u093E \u091A\u093E\u0939\u093F\u090F` : t5.format === `includes` ? `\u0905\u092E\u093E\u0928\u094D\u092F \u0938\u094D\u091F\u094D\u0930\u093F\u0902\u0917: \u0907\u0938\u092E\u0947\u0902 "${t5.includes}" \u0936\u093E\u092E\u093F\u0932 \u0939\u094B\u0928\u093E \u091A\u093E\u0939\u093F\u090F` : t5.format === `regex` ? `\u0905\u092E\u093E\u0928\u094D\u092F \u0938\u094D\u091F\u094D\u0930\u093F\u0902\u0917: \u092A\u0948\u091F\u0930\u094D\u0928 ${t5.pattern} \u0938\u0947 \u092E\u0947\u0932 \u0916\u093E\u0928\u093E \u091A\u093E\u0939\u093F\u090F` : `\u0905\u092E\u093E\u0928\u094D\u092F ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u0905\u092E\u093E\u0928\u094D\u092F \u0938\u0902\u0916\u094D\u092F\u093E: \u092F\u0939 ${e10.divisor} \u0915\u093E \u0917\u0941\u0923\u091C \u0939\u094B\u0928\u093E \u091A\u093E\u0939\u093F\u090F`;
      case `unrecognized_keys`:
        return `\u0905\u092A\u0930\u093F\u091A\u093F\u0924 \u0915\u0941\u0902\u091C\u0940${e10.keys.length > 1 ? `\u092F\u093E\u0901` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u0905\u092E\u093E\u0928\u094D\u092F \u0915\u0941\u0902\u091C\u0940: ${e10.origin} \u092E\u0947\u0902`;
      case `invalid_union`:
        return e10.options && Array.isArray(e10.options) && e10.options.length > 0 ? `\u0905\u092E\u093E\u0928\u094D\u092F \u0921\u093F\u0938\u094D\u0915\u094D\u0930\u093F\u092E\u093F\u0928\u0947\u091F\u0930 \u092E\u093E\u0928: \u0905\u092A\u0947\u0915\u094D\u0937\u093F\u0924 ${e10.options.map((e11) => `'${e11}'`).join(` | `)}` : `\u0905\u092E\u093E\u0928\u094D\u092F \u0907\u0928\u092A\u0941\u091F`;
      case `invalid_element`:
        return `\u0905\u092E\u093E\u0928\u094D\u092F \u092E\u093E\u0928: ${e10.origin} \u092E\u0947\u0902`;
      default:
        return `\u0905\u092E\u093E\u0928\u094D\u092F \u0907\u0928\u092A\u0941\u091F`;
    }
  };
};
function qo() {
  return { localeError: Ko() };
}
var Jo = () => {
  let e9 = { string: { unit: `znakova`, verb: `imati` }, file: { unit: `bajtova`, verb: `imati` }, array: { unit: `stavki`, verb: `imati` }, set: { unit: `stavki`, verb: `imati` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `unos`, email: `email adresa`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO datum i vrijeme`, date: `ISO datum`, time: `ISO vrijeme`, duration: `ISO trajanje`, ipv4: `IPv4 adresa`, ipv6: `IPv6 adresa`, mac: `MAC adresa`, cidrv4: `IPv4 raspon`, cidrv6: `IPv6 raspon`, base64: `base64 kodirani tekst`, base64url: `base64url kodirani tekst`, json_string: `JSON tekst`, e164: `E.164 broj`, credit_card: `broj kreditne kartice`, jwt: `JWT`, template_literal: `unos` }, r2 = { nan: `NaN`, string: `tekst`, number: `broj`, boolean: `boolean`, array: `niz`, object: `objekt`, set: `skup`, file: `datoteka`, date: `datum`, bigint: `bigint`, symbol: `simbol`, undefined: `undefined`, null: `null`, function: `funkcija`, map: `mapa` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Neispravan unos: o\u010Dekuje se instanceof ${e10.expected}, a primljeno je ${i3}` : `Neispravan unos: o\u010Dekuje se ${t5}, a primljeno je ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Neispravna vrijednost: o\u010Dekivano ${C(e10.values[0])}` : `Neispravna opcija: o\u010Dekivano jedno od ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, i3 = t4(e10.origin), a3 = r2[e10.origin] ?? e10.origin;
        return i3 ? `Preveliko: o\u010Dekivano da ${a3 ?? `vrijednost`} ima ${n4}${e10.maximum.toString()} ${i3.unit ?? `elemenata`}` : `Preveliko: o\u010Dekivano da ${a3 ?? `vrijednost`} bude ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, i3 = t4(e10.origin), a3 = r2[e10.origin] ?? e10.origin;
        return i3 ? `Premalo: o\u010Dekivano da ${a3} ima ${n4}${e10.minimum.toString()} ${i3.unit}` : `Premalo: o\u010Dekivano da ${a3} bude ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Neispravan tekst: mora zapo\u010Dinjati s "${t5.prefix}"` : t5.format === `ends_with` ? `Neispravan tekst: mora zavr\u0161avati s "${t5.suffix}"` : t5.format === `includes` ? `Neispravan tekst: mora sadr\u017Eavati "${t5.includes}"` : t5.format === `regex` ? `Neispravan tekst: mora odgovarati uzorku ${t5.pattern}` : `Neispravna ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Neispravan broj: mora biti vi\u0161ekratnik od ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Neprepoznat${e10.keys.length > 1 ? `i klju\u010Devi` : ` klju\u010D`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Neispravan klju\u010D u ${r2[e10.origin] ?? e10.origin}`;
      case `invalid_union`:
        return `Neispravan unos`;
      case `invalid_element`:
        return `Neispravna vrijednost u ${r2[e10.origin] ?? e10.origin}`;
      default:
        return `Neispravan unos`;
    }
  };
};
function Yo() {
  return { localeError: Jo() };
}
var Xo = () => {
  let e9 = { string: { unit: `karakter`, verb: `legyen` }, file: { unit: `byte`, verb: `legyen` }, array: { unit: `elem`, verb: `legyen` }, set: { unit: `elem`, verb: `legyen` }, map: { unit: `elem`, verb: `legyen` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `bemenet`, email: `email c\xEDm`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO id\u0151b\xE9lyeg`, date: `ISO d\xE1tum`, time: `ISO id\u0151`, duration: `ISO id\u0151intervallum`, ipv4: `IPv4 c\xEDm`, ipv6: `IPv6 c\xEDm`, mac: `MAC c\xEDm`, cidrv4: `IPv4 tartom\xE1ny`, cidrv6: `IPv6 tartom\xE1ny`, base64: `base64-k\xF3dolt string`, base64url: `base64url-k\xF3dolt string`, json_string: `JSON string`, e164: `E.164 sz\xE1m`, credit_card: `hitelk\xE1rtyasz\xE1m`, jwt: `JWT`, template_literal: `bemenet` }, r2 = { nan: `NaN`, number: `sz\xE1m`, array: `t\xF6mb` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\xC9rv\xE9nytelen bemenet: a v\xE1rt \xE9rt\xE9k instanceof ${e10.expected}, a kapott \xE9rt\xE9k ${i3}` : `\xC9rv\xE9nytelen bemenet: a v\xE1rt \xE9rt\xE9k ${t5}, a kapott \xE9rt\xE9k ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\xC9rv\xE9nytelen bemenet: a v\xE1rt \xE9rt\xE9k ${C(e10.values[0])}` : `\xC9rv\xE9nytelen opci\xF3: valamelyik \xE9rt\xE9k v\xE1rt ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `T\xFAl nagy: ${e10.origin ?? `\xE9rt\xE9k`} m\xE9rete t\xFAl nagy ${n4}${e10.maximum.toString()} ${r3.unit ?? `elem`}` : `T\xFAl nagy: a bemeneti \xE9rt\xE9k ${e10.origin ?? `\xE9rt\xE9k`} t\xFAl nagy: ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `T\xFAl kicsi: a bemeneti \xE9rt\xE9k ${e10.origin} m\xE9rete t\xFAl kicsi ${n4}${e10.minimum.toString()} ${r3.unit}` : `T\xFAl kicsi: a bemeneti \xE9rt\xE9k ${e10.origin} t\xFAl kicsi ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\xC9rv\xE9nytelen string: "${t5.prefix}" \xE9rt\xE9kkel kell kezd\u0151dnie` : t5.format === `ends_with` ? `\xC9rv\xE9nytelen string: "${t5.suffix}" \xE9rt\xE9kkel kell v\xE9gz\u0151dnie` : t5.format === `includes` ? `\xC9rv\xE9nytelen string: "${t5.includes}" \xE9rt\xE9ket kell tartalmaznia` : t5.format === `regex` ? `\xC9rv\xE9nytelen string: ${t5.pattern} mint\xE1nak kell megfelelnie` : `\xC9rv\xE9nytelen ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\xC9rv\xE9nytelen sz\xE1m: ${e10.divisor} t\xF6bbsz\xF6r\xF6s\xE9nek kell lennie`;
      case `unrecognized_keys`:
        return `Ismeretlen kulcs${e10.keys.length > 1 ? `s` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\xC9rv\xE9nytelen kulcs ${e10.origin}`;
      case `invalid_union`:
        return `\xC9rv\xE9nytelen bemenet`;
      case `invalid_element`:
        return `\xC9rv\xE9nytelen \xE9rt\xE9k: ${e10.origin}`;
      default:
        return `\xC9rv\xE9nytelen bemenet`;
    }
  };
};
function Zo() {
  return { localeError: Xo() };
}
function Qo(e9, t4, n3) {
  return Math.abs(e9) === 1 ? t4 : n3;
}
function $o(e9) {
  if (!e9) return ``;
  let t4 = [`\u0561`, `\u0565`, `\u0568`, `\u056B`, `\u0578`, `\u0578\u0582`, `\u0585`], n3 = e9[e9.length - 1];
  return e9 + (t4.includes(n3) ? `\u0576` : `\u0568`);
}
var es = () => {
  let e9 = { string: { unit: { one: `\u0576\u0577\u0561\u0576`, many: `\u0576\u0577\u0561\u0576\u0576\u0565\u0580` }, verb: `\u0578\u0582\u0576\u0565\u0576\u0561\u056C` }, file: { unit: { one: `\u0562\u0561\u0575\u0569`, many: `\u0562\u0561\u0575\u0569\u0565\u0580` }, verb: `\u0578\u0582\u0576\u0565\u0576\u0561\u056C` }, array: { unit: { one: `\u057F\u0561\u0580\u0580`, many: `\u057F\u0561\u0580\u0580\u0565\u0580` }, verb: `\u0578\u0582\u0576\u0565\u0576\u0561\u056C` }, set: { unit: { one: `\u057F\u0561\u0580\u0580`, many: `\u057F\u0561\u0580\u0580\u0565\u0580` }, verb: `\u0578\u0582\u0576\u0565\u0576\u0561\u056C` }, map: { unit: { one: `\u057F\u0561\u0580\u0580`, many: `\u057F\u0561\u0580\u0580\u0565\u0580` }, verb: `\u0578\u0582\u0576\u0565\u0576\u0561\u056C` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0574\u0578\u0582\u057F\u0584`, email: `\u0567\u056C. \u0570\u0561\u057D\u0581\u0565`, url: `URL`, emoji: `\u0567\u0574\u0578\u057B\u056B`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \u0561\u0574\u057D\u0561\u0569\u056B\u057E \u0587 \u056A\u0561\u0574`, date: `ISO \u0561\u0574\u057D\u0561\u0569\u056B\u057E`, time: `ISO \u056A\u0561\u0574`, duration: `ISO \u057F\u0587\u0578\u0572\u0578\u0582\u0569\u0575\u0578\u0582\u0576`, ipv4: `IPv4 \u0570\u0561\u057D\u0581\u0565`, ipv6: `IPv6 \u0570\u0561\u057D\u0581\u0565`, mac: `MAC \u0570\u0561\u057D\u0581\u0565`, cidrv4: `IPv4 \u0574\u056B\u057B\u0561\u056F\u0561\u0575\u0584`, cidrv6: `IPv6 \u0574\u056B\u057B\u0561\u056F\u0561\u0575\u0584`, base64: `base64 \u0571\u0587\u0561\u0579\u0561\u0583\u0578\u057E \u057F\u0578\u0572`, base64url: `base64url \u0571\u0587\u0561\u0579\u0561\u0583\u0578\u057E \u057F\u0578\u0572`, json_string: `JSON \u057F\u0578\u0572`, e164: `E.164 \u0570\u0561\u0574\u0561\u0580`, credit_card: `\u056F\u0580\u0565\u0564\u056B\u057F \u0584\u0561\u0580\u057F\u056B \u0570\u0561\u0574\u0561\u0580`, jwt: `JWT`, template_literal: `\u0574\u0578\u0582\u057F\u0584` }, r2 = { nan: `NaN`, number: `\u0569\u056B\u057E`, array: `\u0566\u0561\u0576\u0563\u057E\u0561\u056E` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u054D\u056D\u0561\u056C \u0574\u0578\u0582\u057F\u0584\u0561\u0563\u0580\u0578\u0582\u0574\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567\u0580 instanceof ${e10.expected}, \u057D\u057F\u0561\u0581\u057E\u0565\u056C \u0567 ${i3}` : `\u054D\u056D\u0561\u056C \u0574\u0578\u0582\u057F\u0584\u0561\u0563\u0580\u0578\u0582\u0574\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567\u0580 ${t5}, \u057D\u057F\u0561\u0581\u057E\u0565\u056C \u0567 ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u054D\u056D\u0561\u056C \u0574\u0578\u0582\u057F\u0584\u0561\u0563\u0580\u0578\u0582\u0574\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567\u0580 ${C(e10.values[1])}` : `\u054D\u056D\u0561\u056C \u057F\u0561\u0580\u0562\u0565\u0580\u0561\u056F\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567\u0580 \u0570\u0565\u057F\u0587\u0575\u0561\u056C\u0576\u0565\u0580\u056B\u0581 \u0574\u0565\u056F\u0568\u055D ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        if (r3) {
          let t5 = Qo(Number(e10.maximum), r3.unit.one, r3.unit.many);
          return `\u0549\u0561\u0583\u0561\u0566\u0561\u0576\u0581 \u0574\u0565\u056E \u0561\u0580\u056A\u0565\u0584\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567, \u0578\u0580 ${$o(e10.origin ?? `\u0561\u0580\u056A\u0565\u0584`)} \u056F\u0578\u0582\u0576\u0565\u0576\u0561 ${n4}${e10.maximum.toString()} ${t5}`;
        }
        return `\u0549\u0561\u0583\u0561\u0566\u0561\u0576\u0581 \u0574\u0565\u056E \u0561\u0580\u056A\u0565\u0584\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567, \u0578\u0580 ${$o(e10.origin ?? `\u0561\u0580\u056A\u0565\u0584`)} \u056C\u056B\u0576\u056B ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        if (r3) {
          let t5 = Qo(Number(e10.minimum), r3.unit.one, r3.unit.many);
          return `\u0549\u0561\u0583\u0561\u0566\u0561\u0576\u0581 \u0583\u0578\u0584\u0580 \u0561\u0580\u056A\u0565\u0584\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567, \u0578\u0580 ${$o(e10.origin)} \u056F\u0578\u0582\u0576\u0565\u0576\u0561 ${n4}${e10.minimum.toString()} ${t5}`;
        }
        return `\u0549\u0561\u0583\u0561\u0566\u0561\u0576\u0581 \u0583\u0578\u0584\u0580 \u0561\u0580\u056A\u0565\u0584\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567, \u0578\u0580 ${$o(e10.origin)} \u056C\u056B\u0576\u056B ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u054D\u056D\u0561\u056C \u057F\u0578\u0572\u2024 \u057A\u0565\u057F\u0584 \u0567 \u057D\u056F\u057D\u057E\u056B "${t5.prefix}"-\u0578\u057E` : t5.format === `ends_with` ? `\u054D\u056D\u0561\u056C \u057F\u0578\u0572\u2024 \u057A\u0565\u057F\u0584 \u0567 \u0561\u057E\u0561\u0580\u057F\u057E\u056B "${t5.suffix}"-\u0578\u057E` : t5.format === `includes` ? `\u054D\u056D\u0561\u056C \u057F\u0578\u0572\u2024 \u057A\u0565\u057F\u0584 \u0567 \u057A\u0561\u0580\u0578\u0582\u0576\u0561\u056F\u056B "${t5.includes}"` : t5.format === `regex` ? `\u054D\u056D\u0561\u056C \u057F\u0578\u0572\u2024 \u057A\u0565\u057F\u0584 \u0567 \u0570\u0561\u0574\u0561\u057A\u0561\u057F\u0561\u057D\u056D\u0561\u0576\u056B ${t5.pattern} \u0571\u0587\u0561\u0579\u0561\u0583\u056B\u0576` : `\u054D\u056D\u0561\u056C ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u054D\u056D\u0561\u056C \u0569\u056B\u057E\u2024 \u057A\u0565\u057F\u0584 \u0567 \u0562\u0561\u0566\u0574\u0561\u057A\u0561\u057F\u056B\u056F \u056C\u056B\u0576\u056B ${e10.divisor}-\u056B`;
      case `unrecognized_keys`:
        return `\u0549\u0573\u0561\u0576\u0561\u0579\u057E\u0561\u056E \u0562\u0561\u0576\u0561\u056C\u056B${e10.keys.length > 1 ? `\u0576\u0565\u0580` : ``}. ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u054D\u056D\u0561\u056C \u0562\u0561\u0576\u0561\u056C\u056B ${$o(e10.origin)}-\u0578\u0582\u0574`;
      case `invalid_union`:
        return `\u054D\u056D\u0561\u056C \u0574\u0578\u0582\u057F\u0584\u0561\u0563\u0580\u0578\u0582\u0574`;
      case `invalid_element`:
        return `\u054D\u056D\u0561\u056C \u0561\u0580\u056A\u0565\u0584 ${$o(e10.origin)}-\u0578\u0582\u0574`;
      default:
        return `\u054D\u056D\u0561\u056C \u0574\u0578\u0582\u057F\u0584\u0561\u0563\u0580\u0578\u0582\u0574`;
    }
  };
};
function ts() {
  return { localeError: es() };
}
var ns = () => {
  let e9 = { string: { unit: `karakter`, verb: `memiliki` }, file: { unit: `byte`, verb: `memiliki` }, array: { unit: `item`, verb: `memiliki` }, set: { unit: `item`, verb: `memiliki` }, map: { unit: `item`, verb: `memiliki` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `input`, email: `alamat email`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `tanggal dan waktu format ISO`, date: `tanggal format ISO`, time: `jam format ISO`, duration: `durasi format ISO`, ipv4: `alamat IPv4`, ipv6: `alamat IPv6`, mac: `alamat MAC`, cidrv4: `rentang alamat IPv4`, cidrv6: `rentang alamat IPv6`, base64: `string dengan enkode base64`, base64url: `string dengan enkode base64url`, json_string: `string JSON`, e164: `angka E.164`, credit_card: `nomor kartu kredit`, jwt: `JWT`, template_literal: `input` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Input tidak valid: diharapkan instanceof ${e10.expected}, diterima ${i3}` : `Input tidak valid: diharapkan ${t5}, diterima ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Input tidak valid: diharapkan ${C(e10.values[0])}` : `Pilihan tidak valid: diharapkan salah satu dari ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Terlalu besar: diharapkan ${e10.origin ?? `value`} memiliki ${n4}${e10.maximum.toString()} ${r3.unit ?? `elemen`}` : `Terlalu besar: diharapkan ${e10.origin ?? `value`} menjadi ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Terlalu kecil: diharapkan ${e10.origin} memiliki ${n4}${e10.minimum.toString()} ${r3.unit}` : `Terlalu kecil: diharapkan ${e10.origin} menjadi ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `String tidak valid: harus dimulai dengan "${t5.prefix}"` : t5.format === `ends_with` ? `String tidak valid: harus berakhir dengan "${t5.suffix}"` : t5.format === `includes` ? `String tidak valid: harus menyertakan "${t5.includes}"` : t5.format === `regex` ? `String tidak valid: harus sesuai pola ${t5.pattern}` : `${n3[t5.format] ?? e10.format} tidak valid`;
      }
      case `not_multiple_of`:
        return `Angka tidak valid: harus kelipatan dari ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Kunci tidak dikenali ${e10.keys.length > 1 ? `s` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Kunci tidak valid di ${e10.origin}`;
      case `invalid_union`:
        return `Input tidak valid`;
      case `invalid_element`:
        return `Nilai tidak valid di ${e10.origin}`;
      default:
        return `Input tidak valid`;
    }
  };
};
function rs() {
  return { localeError: ns() };
}
var is = () => {
  let e9 = { string: { unit: `stafi`, verb: `a\xF0 hafa` }, file: { unit: `b\xE6ti`, verb: `a\xF0 hafa` }, array: { unit: `hluti`, verb: `a\xF0 hafa` }, set: { unit: `hluti`, verb: `a\xF0 hafa` }, map: { unit: `hluti`, verb: `a\xF0 hafa` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `gildi`, email: `netfang`, url: `vefsl\xF3\xF0`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO dagsetning og t\xEDmi`, date: `ISO dagsetning`, time: `ISO t\xEDmi`, duration: `ISO t\xEDmalengd`, ipv4: `IPv4 address`, ipv6: `IPv6 address`, mac: `MAC address`, cidrv4: `IPv4 range`, cidrv6: `IPv6 range`, base64: `base64-encoded strengur`, base64url: `base64url-encoded strengur`, json_string: `JSON strengur`, e164: `E.164 t\xF6lugildi`, credit_card: `kreditkortan\xFAmer`, jwt: `JWT`, template_literal: `gildi` }, r2 = { nan: `NaN`, number: `n\xFAmer`, array: `fylki` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Rangt gildi: \xDE\xFA sl\xF3st inn ${i3} \xFEar sem \xE1 a\xF0 vera instanceof ${e10.expected}` : `Rangt gildi: \xDE\xFA sl\xF3st inn ${i3} \xFEar sem \xE1 a\xF0 vera ${t5}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Rangt gildi: gert r\xE1\xF0 fyrir ${C(e10.values[0])}` : `\xD3gilt val: m\xE1 vera eitt af eftirfarandi ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Of st\xF3rt: gert er r\xE1\xF0 fyrir a\xF0 ${e10.origin ?? `gildi`} hafi ${n4}${e10.maximum.toString()} ${r3.unit ?? `hluti`}` : `Of st\xF3rt: gert er r\xE1\xF0 fyrir a\xF0 ${e10.origin ?? `gildi`} s\xE9 ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Of l\xEDti\xF0: gert er r\xE1\xF0 fyrir a\xF0 ${e10.origin} hafi ${n4}${e10.minimum.toString()} ${r3.unit}` : `Of l\xEDti\xF0: gert er r\xE1\xF0 fyrir a\xF0 ${e10.origin} s\xE9 ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\xD3gildur strengur: ver\xF0ur a\xF0 byrja \xE1 "${t5.prefix}"` : t5.format === `ends_with` ? `\xD3gildur strengur: ver\xF0ur a\xF0 enda \xE1 "${t5.suffix}"` : t5.format === `includes` ? `\xD3gildur strengur: ver\xF0ur a\xF0 innihalda "${t5.includes}"` : t5.format === `regex` ? `\xD3gildur strengur: ver\xF0ur a\xF0 fylgja mynstri ${t5.pattern}` : `Rangt ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `R\xF6ng tala: ver\xF0ur a\xF0 vera margfeldi af ${e10.divisor}`;
      case `unrecognized_keys`:
        return `\xD3\xFEekkt ${e10.keys.length > 1 ? `ir lyklar` : `ur lykill`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Rangur lykill \xED ${e10.origin}`;
      case `invalid_union`:
        return `Rangt gildi`;
      case `invalid_element`:
        return `Rangt gildi \xED ${e10.origin}`;
      default:
        return `Rangt gildi`;
    }
  };
};
function as() {
  return { localeError: is() };
}
var os = () => {
  let e9 = { string: { unit: `caratteri`, verb: `avere` }, file: { unit: `byte`, verb: `avere` }, array: { unit: `elementi`, verb: `avere` }, set: { unit: `elementi`, verb: `avere` }, map: { unit: `elementi`, verb: `avere` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `input`, email: `indirizzo email`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `data e ora ISO`, date: `data ISO`, time: `ora ISO`, duration: `durata ISO`, ipv4: `indirizzo IPv4`, ipv6: `indirizzo IPv6`, mac: `indirizzo MAC`, cidrv4: `intervallo IPv4`, cidrv6: `intervallo IPv6`, base64: `stringa codificata in base64`, base64url: `URL codificata in base64`, json_string: `stringa JSON`, e164: `numero E.164`, credit_card: `numero di carta di credito`, jwt: `JWT`, template_literal: `input` }, r2 = { nan: `NaN`, number: `numero`, array: `vettore` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Input non valido: atteso instanceof ${e10.expected}, ricevuto ${i3}` : `Input non valido: atteso ${t5}, ricevuto ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Input non valido: atteso ${C(e10.values[0])}` : `Opzione non valida: atteso uno tra ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Troppo grande: ${e10.origin ?? `valore`} deve avere ${n4}${e10.maximum.toString()} ${r3.unit ?? `elementi`}` : `Troppo grande: ${e10.origin ?? `valore`} deve essere ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Troppo piccolo: ${e10.origin} deve avere ${n4}${e10.minimum.toString()} ${r3.unit}` : `Troppo piccolo: ${e10.origin} deve essere ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Stringa non valida: deve iniziare con "${t5.prefix}"` : t5.format === `ends_with` ? `Stringa non valida: deve terminare con "${t5.suffix}"` : t5.format === `includes` ? `Stringa non valida: deve includere "${t5.includes}"` : t5.format === `regex` ? `Stringa non valida: deve corrispondere al pattern ${t5.pattern}` : `Input non valido: ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Numero non valido: deve essere un multiplo di ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Chiav${e10.keys.length > 1 ? `i` : `e`} non riconosciut${e10.keys.length > 1 ? `e` : `a`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Chiave non valida in ${e10.origin}`;
      case `invalid_union`:
        return `Input non valido`;
      case `invalid_element`:
        return `Valore non valido in ${e10.origin}`;
      default:
        return `Input non valido`;
    }
  };
};
function ss() {
  return { localeError: os() };
}
var cs = () => {
  let e9 = { string: { unit: `\u6587\u5B57`, verb: `\u3067\u3042\u308B` }, file: { unit: `\u30D0\u30A4\u30C8`, verb: `\u3067\u3042\u308B` }, array: { unit: `\u8981\u7D20`, verb: `\u3067\u3042\u308B` }, set: { unit: `\u8981\u7D20`, verb: `\u3067\u3042\u308B` }, map: { unit: `\u8981\u7D20`, verb: `\u3067\u3042\u308B` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u5165\u529B\u5024`, email: `\u30E1\u30FC\u30EB\u30A2\u30C9\u30EC\u30B9`, url: `URL`, emoji: `\u7D75\u6587\u5B57`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO\u65E5\u6642`, date: `ISO\u65E5\u4ED8`, time: `ISO\u6642\u523B`, duration: `ISO\u671F\u9593`, ipv4: `IPv4\u30A2\u30C9\u30EC\u30B9`, ipv6: `IPv6\u30A2\u30C9\u30EC\u30B9`, mac: `MAC\u30A2\u30C9\u30EC\u30B9`, cidrv4: `IPv4\u7BC4\u56F2`, cidrv6: `IPv6\u7BC4\u56F2`, base64: `base64\u30A8\u30F3\u30B3\u30FC\u30C9\u6587\u5B57\u5217`, base64url: `base64url\u30A8\u30F3\u30B3\u30FC\u30C9\u6587\u5B57\u5217`, json_string: `JSON\u6587\u5B57\u5217`, e164: `E.164\u756A\u53F7`, credit_card: `\u30AF\u30EC\u30B8\u30C3\u30C8\u30AB\u30FC\u30C9\u756A\u53F7`, jwt: `JWT`, template_literal: `\u5165\u529B\u5024` }, r2 = { nan: `NaN`, number: `\u6570\u5024`, array: `\u914D\u5217` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u7121\u52B9\u306A\u5165\u529B: instanceof ${e10.expected}\u304C\u671F\u5F85\u3055\u308C\u307E\u3057\u305F\u304C\u3001${i3}\u304C\u5165\u529B\u3055\u308C\u307E\u3057\u305F` : `\u7121\u52B9\u306A\u5165\u529B: ${t5}\u304C\u671F\u5F85\u3055\u308C\u307E\u3057\u305F\u304C\u3001${i3}\u304C\u5165\u529B\u3055\u308C\u307E\u3057\u305F`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u7121\u52B9\u306A\u5165\u529B: ${C(e10.values[0])}\u304C\u671F\u5F85\u3055\u308C\u307E\u3057\u305F` : `\u7121\u52B9\u306A\u9078\u629E: ${l(e10.values, `\u3001`)}\u306E\u3044\u305A\u308C\u304B\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      case `too_big`: {
        let n4 = e10.inclusive ? `\u4EE5\u4E0B\u3067\u3042\u308B` : `\u3088\u308A\u5C0F\u3055\u3044`, r3 = t4(e10.origin);
        return r3 ? `\u5927\u304D\u3059\u304E\u308B\u5024: ${e10.origin ?? `\u5024`}\u306F${e10.maximum.toString()}${r3.unit ?? `\u8981\u7D20`}${n4}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059` : `\u5927\u304D\u3059\u304E\u308B\u5024: ${e10.origin ?? `\u5024`}\u306F${e10.maximum.toString()}${n4}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `\u4EE5\u4E0A\u3067\u3042\u308B` : `\u3088\u308A\u5927\u304D\u3044`, r3 = t4(e10.origin);
        return r3 ? `\u5C0F\u3055\u3059\u304E\u308B\u5024: ${e10.origin}\u306F${e10.minimum.toString()}${r3.unit}${n4}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059` : `\u5C0F\u3055\u3059\u304E\u308B\u5024: ${e10.origin}\u306F${e10.minimum.toString()}${n4}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${t5.prefix}"\u3067\u59CB\u307E\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059` : t5.format === `ends_with` ? `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${t5.suffix}"\u3067\u7D42\u308F\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059` : t5.format === `includes` ? `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${t5.includes}"\u3092\u542B\u3080\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059` : t5.format === `regex` ? `\u7121\u52B9\u306A\u6587\u5B57\u5217: \u30D1\u30BF\u30FC\u30F3${t5.pattern}\u306B\u4E00\u81F4\u3059\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059` : `\u7121\u52B9\u306A${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u7121\u52B9\u306A\u6570\u5024: ${e10.divisor}\u306E\u500D\u6570\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      case `unrecognized_keys`:
        return `\u8A8D\u8B58\u3055\u308C\u3066\u3044\u306A\u3044\u30AD\u30FC${e10.keys.length > 1 ? `\u7FA4` : ``}: ${l(e10.keys, `\u3001`)}`;
      case `invalid_key`:
        return `${e10.origin}\u5185\u306E\u7121\u52B9\u306A\u30AD\u30FC`;
      case `invalid_union`:
        return `\u7121\u52B9\u306A\u5165\u529B`;
      case `invalid_element`:
        return `${e10.origin}\u5185\u306E\u7121\u52B9\u306A\u5024`;
      default:
        return `\u7121\u52B9\u306A\u5165\u529B`;
    }
  };
};
function ls() {
  return { localeError: cs() };
}
var us = () => {
  let e9 = { string: { unit: `\u10E1\u10D8\u10DB\u10D1\u10DD\u10DA\u10DD`, verb: `\u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1` }, file: { unit: `\u10D1\u10D0\u10D8\u10E2\u10D8`, verb: `\u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1` }, array: { unit: `\u10D4\u10DA\u10D4\u10DB\u10D4\u10DC\u10E2\u10D8`, verb: `\u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1` }, set: { unit: `\u10D4\u10DA\u10D4\u10DB\u10D4\u10DC\u10E2\u10D8`, verb: `\u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1` }, map: { unit: `\u10D4\u10DA\u10D4\u10DB\u10D4\u10DC\u10E2\u10D8`, verb: `\u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0`, email: `\u10D4\u10DA-\u10E4\u10DD\u10E1\u10E2\u10D8\u10E1 \u10DB\u10D8\u10E1\u10D0\u10DB\u10D0\u10E0\u10D7\u10D8`, url: `URL`, emoji: `\u10D4\u10DB\u10DD\u10EF\u10D8`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `\u10D7\u10D0\u10E0\u10D8\u10E6\u10D8-\u10D3\u10E0\u10DD`, date: `\u10D7\u10D0\u10E0\u10D8\u10E6\u10D8`, time: `\u10D3\u10E0\u10DD`, duration: `\u10EE\u10D0\u10DC\u10D2\u10E0\u10EB\u10DA\u10D8\u10D5\u10DD\u10D1\u10D0`, ipv4: `IPv4 \u10DB\u10D8\u10E1\u10D0\u10DB\u10D0\u10E0\u10D7\u10D8`, ipv6: `IPv6 \u10DB\u10D8\u10E1\u10D0\u10DB\u10D0\u10E0\u10D7\u10D8`, mac: `MAC \u10DB\u10D8\u10E1\u10D0\u10DB\u10D0\u10E0\u10D7\u10D8`, cidrv4: `IPv4 \u10D3\u10D8\u10D0\u10DE\u10D0\u10D6\u10DD\u10DC\u10D8`, cidrv6: `IPv6 \u10D3\u10D8\u10D0\u10DE\u10D0\u10D6\u10DD\u10DC\u10D8`, base64: `base64-\u10D9\u10DD\u10D3\u10D8\u10E0\u10D4\u10D1\u10E3\u10DA\u10D8 \u10D5\u10D4\u10DA\u10D8`, base64url: `base64url-\u10D9\u10DD\u10D3\u10D8\u10E0\u10D4\u10D1\u10E3\u10DA\u10D8 \u10D5\u10D4\u10DA\u10D8`, json_string: `JSON \u10D5\u10D4\u10DA\u10D8`, e164: `E.164 \u10DC\u10DD\u10DB\u10D4\u10E0\u10D8`, credit_card: `\u10E1\u10D0\u10D9\u10E0\u10D4\u10D3\u10D8\u10E2\u10DD \u10D1\u10D0\u10E0\u10D0\u10D7\u10D8\u10E1 \u10DC\u10DD\u10DB\u10D4\u10E0\u10D8`, jwt: `JWT`, template_literal: `\u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0` }, r2 = { nan: `NaN`, number: `\u10E0\u10D8\u10EA\u10EE\u10D5\u10D8`, string: `\u10D5\u10D4\u10DA\u10D8`, boolean: `\u10D1\u10E3\u10DA\u10D4\u10D0\u10DC\u10D8`, function: `\u10E4\u10E3\u10DC\u10E5\u10EA\u10D8\u10D0`, array: `\u10DB\u10D0\u10E1\u10D8\u10D5\u10D8` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 instanceof ${e10.expected}, \u10DB\u10D8\u10E6\u10D4\u10D1\u10E3\u10DA\u10D8 ${i3}` : `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${t5}, \u10DB\u10D8\u10E6\u10D4\u10D1\u10E3\u10DA\u10D8 ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${C(e10.values[0])}` : `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10D5\u10D0\u10E0\u10D8\u10D0\u10DC\u10E2\u10D8: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8\u10D0 \u10D4\u10E0\u10D7-\u10D4\u10E0\u10D7\u10D8 ${l(e10.values, `|`)}-\u10D3\u10D0\u10DC`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u10D6\u10D4\u10D3\u10DB\u10D4\u10E2\u10D0\u10D3 \u10D3\u10D8\u10D3\u10D8: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${e10.origin ?? `\u10DB\u10DC\u10D8\u10E8\u10D5\u10DC\u10D4\u10DA\u10DD\u10D1\u10D0`} ${r3.verb} ${n4}${e10.maximum.toString()} ${r3.unit}` : `\u10D6\u10D4\u10D3\u10DB\u10D4\u10E2\u10D0\u10D3 \u10D3\u10D8\u10D3\u10D8: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${e10.origin ?? `\u10DB\u10DC\u10D8\u10E8\u10D5\u10DC\u10D4\u10DA\u10DD\u10D1\u10D0`} \u10D8\u10E7\u10DD\u10E1 ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u10D6\u10D4\u10D3\u10DB\u10D4\u10E2\u10D0\u10D3 \u10DE\u10D0\u10E2\u10D0\u10E0\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${e10.origin} ${r3.verb} ${n4}${e10.minimum.toString()} ${r3.unit}` : `\u10D6\u10D4\u10D3\u10DB\u10D4\u10E2\u10D0\u10D3 \u10DE\u10D0\u10E2\u10D0\u10E0\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${e10.origin} \u10D8\u10E7\u10DD\u10E1 ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10D5\u10D4\u10DA\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10D8\u10EC\u10E7\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 "${t5.prefix}"-\u10D8\u10D7` : t5.format === `ends_with` ? `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10D5\u10D4\u10DA\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10DB\u10D7\u10D0\u10D5\u10E0\u10D3\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 "${t5.suffix}"-\u10D8\u10D7` : t5.format === `includes` ? `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10D5\u10D4\u10DA\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1 "${t5.includes}"-\u10E1` : t5.format === `regex` ? `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10D5\u10D4\u10DA\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D4\u10E1\u10D0\u10D1\u10D0\u10DB\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 \u10E8\u10D0\u10D1\u10DA\u10DD\u10DC\u10E1 ${t5.pattern}` : `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E0\u10D8\u10EA\u10EE\u10D5\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10D8\u10E7\u10DD\u10E1 ${e10.divisor}-\u10D8\u10E1 \u10EF\u10D4\u10E0\u10D0\u10D3\u10D8`;
      case `unrecognized_keys`:
        return `\u10E3\u10EA\u10DC\u10DD\u10D1\u10D8 \u10D2\u10D0\u10E1\u10D0\u10E6\u10D4\u10D1${e10.keys.length > 1 ? `\u10D4\u10D1\u10D8` : `\u10D8`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10D2\u10D0\u10E1\u10D0\u10E6\u10D4\u10D1\u10D8 ${e10.origin}-\u10E8\u10D8`;
      case `invalid_union`:
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0`;
      case `invalid_element`:
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10DB\u10DC\u10D8\u10E8\u10D5\u10DC\u10D4\u10DA\u10DD\u10D1\u10D0 ${e10.origin}-\u10E8\u10D8`;
      default:
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0`;
    }
  };
};
function ds() {
  return { localeError: us() };
}
var fs = () => {
  let e9 = { string: { unit: `\u178F\u17BD\u17A2\u1780\u17D2\u179F\u179A`, verb: `\u1782\u17BD\u179A\u1798\u17B6\u1793` }, file: { unit: `\u1794\u17C3`, verb: `\u1782\u17BD\u179A\u1798\u17B6\u1793` }, array: { unit: `\u1792\u17B6\u178F\u17BB`, verb: `\u1782\u17BD\u179A\u1798\u17B6\u1793` }, set: { unit: `\u1792\u17B6\u178F\u17BB`, verb: `\u1782\u17BD\u179A\u1798\u17B6\u1793` }, map: { unit: `\u1792\u17B6\u178F\u17BB`, verb: `\u1782\u17BD\u179A\u1798\u17B6\u1793` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B`, email: `\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793\u17A2\u17CA\u17B8\u1798\u17C2\u179B`, url: `URL`, emoji: `\u179F\u1789\u17D2\u1789\u17B6\u17A2\u17B6\u179A\u1798\u17D2\u1798\u178E\u17CD`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `\u1780\u17B6\u179B\u1794\u179A\u17B7\u1785\u17D2\u1786\u17C1\u1791 \u1793\u17B7\u1784\u1798\u17C9\u17C4\u1784 ISO`, date: `\u1780\u17B6\u179B\u1794\u179A\u17B7\u1785\u17D2\u1786\u17C1\u1791 ISO`, time: `\u1798\u17C9\u17C4\u1784 ISO`, duration: `\u179A\u1799\u17C8\u1796\u17C1\u179B ISO`, ipv4: `\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv4`, ipv6: `\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv6`, mac: `\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 MAC`, cidrv4: `\u178A\u17C2\u1793\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv4`, cidrv6: `\u178A\u17C2\u1793\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv6`, base64: `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u17A2\u17CA\u17B7\u1780\u17BC\u178A base64`, base64url: `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u17A2\u17CA\u17B7\u1780\u17BC\u178A base64url`, json_string: `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A JSON`, e164: `\u179B\u17C1\u1781 E.164`, credit_card: `\u179B\u17C1\u1781\u1794\u17D0\u178E\u17D2\u178E\u17A5\u178E\u1791\u17B6\u1793`, jwt: `JWT`, template_literal: `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B` }, r2 = { nan: `NaN`, number: `\u179B\u17C1\u1781`, array: `\u17A2\u17B6\u179A\u17C1 (Array)`, null: `\u1782\u17D2\u1798\u17B6\u1793\u178F\u1798\u17D2\u179B\u17C3 (null)` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A instanceof ${e10.expected} \u1794\u17C9\u17BB\u1793\u17D2\u178F\u17C2\u1791\u1791\u17BD\u179B\u1794\u17B6\u1793 ${i3}` : `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${t5} \u1794\u17C9\u17BB\u1793\u17D2\u178F\u17C2\u1791\u1791\u17BD\u179B\u1794\u17B6\u1793 ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${C(e10.values[0])}` : `\u1787\u1798\u17D2\u179A\u17BE\u179F\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1787\u17B6\u1798\u17BD\u1799\u1780\u17D2\u1793\u17BB\u1784\u1785\u17C6\u178E\u17C4\u1798 ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u1792\u17C6\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${e10.origin ?? `\u178F\u1798\u17D2\u179B\u17C3`} ${n4} ${e10.maximum.toString()} ${r3.unit ?? `\u1792\u17B6\u178F\u17BB`}` : `\u1792\u17C6\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${e10.origin ?? `\u178F\u1798\u17D2\u179B\u17C3`} ${n4} ${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u178F\u17BC\u1785\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${e10.origin} ${n4} ${e10.minimum.toString()} ${r3.unit}` : `\u178F\u17BC\u1785\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${e10.origin} ${n4} ${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1785\u17B6\u1794\u17CB\u1795\u17D2\u178F\u17BE\u1798\u178A\u17C4\u1799 "${t5.prefix}"` : t5.format === `ends_with` ? `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1794\u1789\u17D2\u1785\u1794\u17CB\u178A\u17C4\u1799 "${t5.suffix}"` : t5.format === `includes` ? `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1798\u17B6\u1793 "${t5.includes}"` : t5.format === `regex` ? `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u178F\u17C2\u1795\u17D2\u1782\u17BC\u1795\u17D2\u1782\u1784\u1793\u17B9\u1784\u1791\u1798\u17D2\u179A\u1784\u17CB\u178A\u17C2\u179B\u1794\u17B6\u1793\u1780\u17C6\u178E\u178F\u17CB ${t5.pattern}` : `\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u179B\u17C1\u1781\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u178F\u17C2\u1787\u17B6\u1796\u17A0\u17BB\u1782\u17BB\u178E\u1793\u17C3 ${e10.divisor}`;
      case `unrecognized_keys`:
        return `\u179A\u1780\u1783\u17BE\u1789\u179F\u17C4\u1798\u17B7\u1793\u179F\u17D2\u1782\u17B6\u179B\u17CB\u17D6 ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u179F\u17C4\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u1793\u17C5\u1780\u17D2\u1793\u17BB\u1784 ${e10.origin}`;
      case `invalid_union`:
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C`;
      case `invalid_element`:
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u1793\u17C5\u1780\u17D2\u1793\u17BB\u1784 ${e10.origin}`;
      default:
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C`;
    }
  };
};
function ps() {
  return { localeError: fs() };
}
function ms() {
  return ps();
}
var hs = () => {
  let e9 = { string: { unit: `\u0C85\u0C95\u0CCD\u0CB7\u0CB0\u0C97\u0CB3\u0CC1`, verb: `\u0CB9\u0CCA\u0C82\u0CA6\u0CB2\u0CC1` }, file: { unit: `\u0CAC\u0CC8\u0C9F\u0CCD\u200C\u0C97\u0CB3\u0CC1`, verb: `\u0CB9\u0CCA\u0C82\u0CA6\u0CB2\u0CC1` }, array: { unit: `\u0CB5\u0CB8\u0CCD\u0CA4\u0CC1\u0C97\u0CB3\u0CC1`, verb: `\u0CB9\u0CCA\u0C82\u0CA6\u0CB2\u0CC1` }, set: { unit: `\u0CB5\u0CB8\u0CCD\u0CA4\u0CC1\u0C97\u0CB3\u0CC1`, verb: `\u0CB9\u0CCA\u0C82\u0CA6\u0CB2\u0CC1` }, map: { unit: `entries`, verb: `\u0CB9\u0CCA\u0C82\u0CA6\u0CB2\u0CC1` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0C87\u0CA8\u0CCD\u0CAA\u0CC1\u0C9F\u0CCD`, email: `email \u0CB5\u0CBF\u0CB3\u0CBE\u0CB8`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \u0CA6\u0CBF\u0CA8\u0CBE\u0C82\u0C95\u0CA6 \u0CB8\u0CAE\u0CAF`, date: `ISO \u0CA6\u0CBF\u0CA8\u0CBE\u0C82\u0C95`, time: `ISO \u0CB8\u0CAE\u0CAF`, duration: `ISO \u0C85\u0CB5\u0CA7\u0CBF`, ipv4: `IPv4 \u0CB5\u0CBF\u0CB3\u0CBE\u0CB8`, ipv6: `IPv6 \u0CB5\u0CBF\u0CB3\u0CBE\u0CB8`, mac: `MAC \u0CB5\u0CBF\u0CB3\u0CBE\u0CB8`, cidrv4: `IPv4 \u0CB5\u0CCD\u0CAF\u0CBE\u0CAA\u0CCD\u0CA4\u0CBF\u0CAF`, cidrv6: `IPv6 \u0CB5\u0CCD\u0CAF\u0CBE\u0CAA\u0CCD\u0CA4\u0CBF\u0CAF`, base64: `base64-encoded\u0CB8\u0CCD\u0C9F\u0CCD\u0CB0\u0CBF\u0C82\u0C97\u0CCD`, base64url: `base64url-encoded\u0CB8\u0CCD\u0C9F\u0CCD\u0CB0\u0CBF\u0C82\u0C97\u0CCD`, json_string: `JSON\u0CB8\u0CCD\u0C9F\u0CCD\u0CB0\u0CBF\u0C82\u0C97\u0CCD`, e164: `E.164 \u0CB8\u0C82\u0C96\u0CCD\u0CAF\u0CC6`, credit_card: `\u0C95\u0CCD\u0CB0\u0CC6\u0CA1\u0CBF\u0C9F\u0CCD \u0C95\u0CBE\u0CB0\u0CCD\u0CA1\u0CCD \u0CB8\u0C82\u0C96\u0CCD\u0CAF\u0CC6`, jwt: `JWT`, template_literal: `\u0C87\u0CA8\u0CCD\u0CAA\u0CC1\u0C9F\u0CCD` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input);
        return `\u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF \u0C87\u0CA8\u0CCD\u200C\u0CAA\u0CC1\u0C9F\u0CCD: \u0CA8\u0CBF\u0CB0\u0CC0\u0C95\u0CCD\u0CB7\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6 ${t5}, \u0CB8\u0CCD\u0CB5\u0CC0\u0C95\u0CB0\u0CBF\u0CB8\u0CBF\u0CA6\u0CA8\u0CC1 ${r2[n4] ?? n4}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF \u0C87\u0CA8\u0CCD\u200C\u0CAA\u0CC1\u0C9F\u0CCD: \u0CA8\u0CBF\u0CB0\u0CC0\u0C95\u0CCD\u0CB7\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6 ${C(e10.values[0])}` : `\u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF \u0C86\u0CAF\u0CCD\u0C95\u0CC6: \u0C87\u0CB5\u0CC1\u0C97\u0CB3\u0CB2\u0CCD\u0CB2\u0CBF \u0C92\u0C82\u0CA6\u0CA8\u0CCD\u0CA8\u0CC1 \u0CA8\u0CBF\u0CB0\u0CC0\u0C95\u0CCD\u0CB7\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6 ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u0CA4\u0CC1\u0C82\u0CAC\u0CBE \u0CA6\u0CCA\u0CA1\u0CCD\u0CA1\u0CA6\u0CC1: \u0CA8\u0CBF\u0CB0\u0CC0\u0C95\u0CCD\u0CB7\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6 ${e10.origin ?? `value`} \u0CB9\u0CCA\u0C82\u0CA6\u0CB2\u0CC1 ${n4}${e10.maximum.toString()} ${r3.unit ?? `\u0C85\u0C82\u0CB6\u0C97\u0CB3\u0CC1`}` : `\u0CA4\u0CC1\u0C82\u0CAC\u0CBE \u0CA6\u0CCA\u0CA1\u0CCD\u0CA1\u0CA6\u0CC1: \u0CA8\u0CBF\u0CB0\u0CC0\u0C95\u0CCD\u0CB7\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6 ${e10.origin ?? `value`} \u0C8E\u0C82\u0CA6\u0CC1 ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u0CA4\u0CC1\u0C82\u0CAC\u0CBE \u0C9A\u0CBF\u0C95\u0CCD\u0C95\u0CA6\u0CC1: \u0CA8\u0CBF\u0CB0\u0CC0\u0C95\u0CCD\u0CB7\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6 ${e10.origin} \u0CB9\u0CCA\u0C82\u0CA6\u0CB2\u0CC1 ${n4}${e10.minimum.toString()} ${r3.unit}` : `\u0CA4\u0CC1\u0C82\u0CAC\u0CBE \u0C9A\u0CBF\u0C95\u0CCD\u0C95\u0CA6\u0CC1: \u0CA8\u0CBF\u0CB0\u0CC0\u0C95\u0CCD\u0CB7\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6 ${e10.origin} \u0C8E\u0C82\u0CA6\u0CC1 ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF\u0CB5\u0CBE\u0CA6 \u0CB8\u0CCD\u0C9F\u0CCD\u0CB0\u0CBF\u0C82\u0C97\u0CCD: \u0C87\u0CA6\u0CB0\u0CCA\u0C82\u0CA6\u0CBF\u0C97\u0CC6 \u0CAA\u0CCD\u0CB0\u0CBE\u0CB0\u0C82\u0CAD\u0CBF\u0CB8\u0CAC\u0CC7\u0C95\u0CC1 "${t5.prefix}"` : t5.format === `ends_with` ? `\u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF\u0CB5\u0CBE\u0CA6 \u0CB8\u0CCD\u0C9F\u0CCD\u0CB0\u0CBF\u0C82\u0C97\u0CCD: \u0C87\u0CA6\u0CB0\u0CCA\u0C82\u0CA6\u0CBF\u0C97\u0CC6 \u0C95\u0CCA\u0CA8\u0CC6\u0C97\u0CCA\u0CB3\u0CCD\u0CB3\u0CAC\u0CC7\u0C95\u0CC1 "${t5.suffix}"` : t5.format === `includes` ? `\u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF \u0CB8\u0CCD\u0C9F\u0CCD\u0CB0\u0CBF\u0C82\u0C97\u0CCD: \u0C92\u0CB3\u0C97\u0CCA\u0C82\u0CA1\u0CBF\u0CB0\u0CAC\u0CC7\u0C95\u0CC1 "${t5.includes}"` : t5.format === `regex` ? `\u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF\u0CB5\u0CBE\u0CA6 \u0CB8\u0CCD\u0C9F\u0CCD\u0CB0\u0CBF\u0C82\u0C97\u0CCD: \u0CAE\u0CBE\u0CA6\u0CB0\u0CBF\u0C97\u0CC6 \u0CB9\u0CCA\u0C82\u0CA6\u0CBF\u0C95\u0CC6\u0CAF\u0CBE\u0C97\u0CAC\u0CC7\u0C95\u0CC1 ${t5.pattern}` : `\u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF \u0CB8\u0C82\u0C96\u0CCD\u0CAF\u0CC6: \u0CAC\u0CB9\u0CC1\u0CB8\u0C82\u0C96\u0CCD\u0CAF\u0CC6\u0CAF\u0CBE\u0C97\u0CBF\u0CB0\u0CAC\u0CC7\u0C95\u0CC1 ${e10.divisor}`;
      case `unrecognized_keys`:
        return `\u0C97\u0CC1\u0CB0\u0CC1\u0CA4\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CA6 \u0C95\u0CC0 ${e10.keys.length > 1 ? `s` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF\u0CB5\u0CBE\u0CA6 \u0C95\u0CC0 \u0C87\u0CA8\u0CCD ${e10.origin}`;
      case `invalid_union`:
        return e10.options && Array.isArray(e10.options) && e10.options.length > 0 ? `\u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF \u0CA4\u0CBE\u0CB0\u0CA4\u0CAE\u0CCD\u0CAF \u0CAE\u0CCC\u0CB2\u0CCD\u0CAF. \u0CA8\u0CBF\u0CB0\u0CC0\u0C95\u0CCD\u0CB7\u0CBF\u0CB8\u0CB2\u0CBE\u0C97\u0CBF\u0CA6\u0CC6 ${e10.options.map((e11) => `'${e11}'`).join(` | `)}` : `\u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF \u0C87\u0CA8\u0CCD\u200C\u0CAA\u0CC1\u0C9F\u0CCD`;
      case `invalid_element`:
        return `\u0CB0\u0CB2\u0CCD\u0CB2\u0CBF \u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF \u0CAE\u0CCC\u0CB2\u0CCD\u0CAF ${e10.origin}`;
      default:
        return `\u0C85\u0CAE\u0CBE\u0CA8\u0CCD\u0CAF \u0C87\u0CA8\u0CCD\u200C\u0CAA\u0CC1\u0C9F\u0CCD`;
    }
  };
};
function gs() {
  return { localeError: hs() };
}
var _s = () => {
  let e9 = { string: { unit: `\uBB38\uC790`, verb: `to have` }, file: { unit: `\uBC14\uC774\uD2B8`, verb: `to have` }, array: { unit: `\uAC1C`, verb: `to have` }, set: { unit: `\uAC1C`, verb: `to have` }, map: { unit: `\uAC1C`, verb: `to have` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\uC785\uB825`, email: `\uC774\uBA54\uC77C \uC8FC\uC18C`, url: `URL`, emoji: `\uC774\uBAA8\uC9C0`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \uB0A0\uC9DC\uC2DC\uAC04`, date: `ISO \uB0A0\uC9DC`, time: `ISO \uC2DC\uAC04`, duration: `ISO \uAE30\uAC04`, ipv4: `IPv4 \uC8FC\uC18C`, ipv6: `IPv6 \uC8FC\uC18C`, mac: `MAC \uC8FC\uC18C`, cidrv4: `IPv4 \uBC94\uC704`, cidrv6: `IPv6 \uBC94\uC704`, base64: `base64 \uC778\uCF54\uB529 \uBB38\uC790\uC5F4`, base64url: `base64url \uC778\uCF54\uB529 \uBB38\uC790\uC5F4`, json_string: `JSON \uBB38\uC790\uC5F4`, e164: `E.164 \uBC88\uD638`, credit_card: `\uC2E0\uC6A9\uCE74\uB4DC \uBC88\uD638`, jwt: `JWT`, template_literal: `\uC785\uB825` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\uC798\uBABB\uB41C \uC785\uB825: \uC608\uC0C1 \uD0C0\uC785\uC740 instanceof ${e10.expected}, \uBC1B\uC740 \uD0C0\uC785\uC740 ${i3}\uC785\uB2C8\uB2E4` : `\uC798\uBABB\uB41C \uC785\uB825: \uC608\uC0C1 \uD0C0\uC785\uC740 ${t5}, \uBC1B\uC740 \uD0C0\uC785\uC740 ${i3}\uC785\uB2C8\uB2E4`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\uC798\uBABB\uB41C \uC785\uB825: \uAC12\uC740 ${C(e10.values[0])} \uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4` : `\uC798\uBABB\uB41C \uC635\uC158: ${l(e10.values, `\uB610\uB294 `)} \uC911 \uD558\uB098\uC5EC\uC57C \uD569\uB2C8\uB2E4`;
      case `too_big`: {
        let n4 = e10.inclusive ? `\uC774\uD558` : `\uBBF8\uB9CC`, r3 = n4 === `\uBBF8\uB9CC` ? `\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4` : `\uC5EC\uC57C \uD569\uB2C8\uB2E4`, i3 = t4(e10.origin), a3 = i3?.unit ?? `\uC694\uC18C`;
        return i3 ? `${e10.origin ?? `\uAC12`}\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4: ${e10.maximum.toString()}${a3} ${n4}${r3}` : `${e10.origin ?? `\uAC12`}\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4: ${e10.maximum.toString()} ${n4}${r3}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `\uC774\uC0C1` : `\uCD08\uACFC`, r3 = n4 === `\uC774\uC0C1` ? `\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4` : `\uC5EC\uC57C \uD569\uB2C8\uB2E4`, i3 = t4(e10.origin), a3 = i3?.unit ?? `\uC694\uC18C`;
        return i3 ? `${e10.origin ?? `\uAC12`}\uC774 \uB108\uBB34 \uC791\uC2B5\uB2C8\uB2E4: ${e10.minimum.toString()}${a3} ${n4}${r3}` : `${e10.origin ?? `\uAC12`}\uC774 \uB108\uBB34 \uC791\uC2B5\uB2C8\uB2E4: ${e10.minimum.toString()} ${n4}${r3}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${t5.prefix}"(\uC73C)\uB85C \uC2DC\uC791\uD574\uC57C \uD569\uB2C8\uB2E4` : t5.format === `ends_with` ? `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${t5.suffix}"(\uC73C)\uB85C \uB05D\uB098\uC57C \uD569\uB2C8\uB2E4` : t5.format === `includes` ? `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${t5.includes}"\uC744(\uB97C) \uD3EC\uD568\uD574\uC57C \uD569\uB2C8\uB2E4` : t5.format === `regex` ? `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: \uC815\uADDC\uC2DD ${t5.pattern} \uD328\uD134\uACFC \uC77C\uCE58\uD574\uC57C \uD569\uB2C8\uB2E4` : `\uC798\uBABB\uB41C ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\uC798\uBABB\uB41C \uC22B\uC790: ${e10.divisor}\uC758 \uBC30\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4`;
      case `unrecognized_keys`:
        return `\uC778\uC2DD\uD560 \uC218 \uC5C6\uB294 \uD0A4: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\uC798\uBABB\uB41C \uD0A4: ${e10.origin}`;
      case `invalid_union`:
        return `\uC798\uBABB\uB41C \uC785\uB825`;
      case `invalid_element`:
        return `\uC798\uBABB\uB41C \uAC12: ${e10.origin}`;
      default:
        return `\uC798\uBABB\uB41C \uC785\uB825`;
    }
  };
};
function vs() {
  return { localeError: _s() };
}
var ys = (e9) => e9.charAt(0).toUpperCase() + e9.slice(1);
function bs(e9) {
  let t4 = Math.abs(e9), n3 = t4 % 10, r2 = t4 % 100;
  return r2 >= 11 && r2 <= 19 || n3 === 0 ? `many` : n3 === 1 ? `one` : `few`;
}
var xs = () => {
  let e9 = { string: { unit: { one: `simbolis`, few: `simboliai`, many: `simboli\u0173` }, verb: { smaller: { inclusive: `turi b\u016Bti ne ilgesn\u0117 kaip`, notInclusive: `turi b\u016Bti trumpesn\u0117 kaip` }, bigger: { inclusive: `turi b\u016Bti ne trumpesn\u0117 kaip`, notInclusive: `turi b\u016Bti ilgesn\u0117 kaip` } } }, file: { unit: { one: `baitas`, few: `baitai`, many: `bait\u0173` }, verb: { smaller: { inclusive: `turi b\u016Bti ne didesnis kaip`, notInclusive: `turi b\u016Bti ma\u017Eesnis kaip` }, bigger: { inclusive: `turi b\u016Bti ne ma\u017Eesnis kaip`, notInclusive: `turi b\u016Bti didesnis kaip` } } }, array: { unit: { one: `element\u0105`, few: `elementus`, many: `element\u0173` }, verb: { smaller: { inclusive: `turi tur\u0117ti ne daugiau kaip`, notInclusive: `turi tur\u0117ti ma\u017Eiau kaip` }, bigger: { inclusive: `turi tur\u0117ti ne ma\u017Eiau kaip`, notInclusive: `turi tur\u0117ti daugiau kaip` } } }, set: { unit: { one: `element\u0105`, few: `elementus`, many: `element\u0173` }, verb: { smaller: { inclusive: `turi tur\u0117ti ne daugiau kaip`, notInclusive: `turi tur\u0117ti ma\u017Eiau kaip` }, bigger: { inclusive: `turi tur\u0117ti ne ma\u017Eiau kaip`, notInclusive: `turi tur\u0117ti daugiau kaip` } } } };
  function t4(t5, n4, r3, i3) {
    let a3 = e9[t5] ?? null;
    return a3 === null ? a3 : { unit: a3.unit[n4], verb: a3.verb[i3][r3 ? `inclusive` : `notInclusive`] };
  }
  let n3 = { regex: `\u012Fvestis`, email: `el. pa\u0161to adresas`, url: `URL`, emoji: `jaustukas`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO data ir laikas`, date: `ISO data`, time: `ISO laikas`, duration: `ISO trukm\u0117`, ipv4: `IPv4 adresas`, ipv6: `IPv6 adresas`, mac: `MAC adresas`, cidrv4: `IPv4 tinklo prefiksas (CIDR)`, cidrv6: `IPv6 tinklo prefiksas (CIDR)`, base64: `base64 u\u017Ekoduota eilut\u0117`, base64url: `base64url u\u017Ekoduota eilut\u0117`, json_string: `JSON eilut\u0117`, e164: `E.164 numeris`, credit_card: `kredito kortel\u0117s numeris`, jwt: `JWT`, template_literal: `\u012Fvestis` }, r2 = { nan: `NaN`, number: `skai\u010Dius`, bigint: `sveikasis skai\u010Dius`, string: `eilut\u0117`, boolean: `login\u0117 reik\u0161m\u0117`, undefined: `neapibr\u0117\u017Eta reik\u0161m\u0117`, function: `funkcija`, symbol: `simbolis`, array: `masyvas`, object: `objektas`, null: `nulin\u0117 reik\u0161m\u0117` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Gautas tipas ${i3}, o tik\u0117tasi - instanceof ${e10.expected}` : `Gautas tipas ${i3}, o tik\u0117tasi - ${t5}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Privalo b\u016Bti ${C(e10.values[0])}` : `Privalo b\u016Bti vienas i\u0161 ${l(e10.values, `|`)} pasirinkim\u0173`;
      case `too_big`: {
        let n4 = r2[e10.origin] ?? e10.origin, i3 = t4(e10.origin, bs(Number(e10.maximum)), e10.inclusive ?? false, `smaller`);
        if (i3?.verb) return `${ys(n4 ?? e10.origin ?? `reik\u0161m\u0117`)} ${i3.verb} ${e10.maximum.toString()} ${i3.unit ?? `element\u0173`}`;
        let a3 = e10.inclusive ? `ne didesnis kaip` : `ma\u017Eesnis kaip`;
        return `${ys(n4 ?? e10.origin ?? `reik\u0161m\u0117`)} turi b\u016Bti ${a3} ${e10.maximum.toString()} ${i3?.unit}`;
      }
      case `too_small`: {
        let n4 = r2[e10.origin] ?? e10.origin, i3 = t4(e10.origin, bs(Number(e10.minimum)), e10.inclusive ?? false, `bigger`);
        if (i3?.verb) return `${ys(n4 ?? e10.origin ?? `reik\u0161m\u0117`)} ${i3.verb} ${e10.minimum.toString()} ${i3.unit ?? `element\u0173`}`;
        let a3 = e10.inclusive ? `ne ma\u017Eesnis kaip` : `didesnis kaip`;
        return `${ys(n4 ?? e10.origin ?? `reik\u0161m\u0117`)} turi b\u016Bti ${a3} ${e10.minimum.toString()} ${i3?.unit}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Eilut\u0117 privalo prasid\u0117ti "${t5.prefix}"` : t5.format === `ends_with` ? `Eilut\u0117 privalo pasibaigti "${t5.suffix}"` : t5.format === `includes` ? `Eilut\u0117 privalo \u012Ftraukti "${t5.includes}"` : t5.format === `regex` ? `Eilut\u0117 privalo atitikti ${t5.pattern}` : `Neteisingas ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Skai\u010Dius privalo b\u016Bti ${e10.divisor} kartotinis.`;
      case `unrecognized_keys`:
        return `Neatpa\u017Eint${e10.keys.length > 1 ? `i` : `as`} rakt${e10.keys.length > 1 ? `ai` : `as`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Rastas klaidingas raktas`;
      case `invalid_union`:
        return `Klaidinga \u012Fvestis`;
      case `invalid_element`: {
        let t5 = r2[e10.origin] ?? e10.origin;
        return `${ys(t5 ?? e10.origin ?? `reik\u0161m\u0117`)} turi klaiding\u0105 \u012Fvest\u012F`;
      }
      default:
        return `Klaidinga \u012Fvestis`;
    }
  };
};
function Ss() {
  return { localeError: xs() };
}
var Cs = () => {
  let e9 = { string: { unit: `\u0437\u043D\u0430\u0446\u0438`, verb: `\u0434\u0430 \u0438\u043C\u0430\u0430\u0442` }, file: { unit: `\u0431\u0430\u0458\u0442\u0438`, verb: `\u0434\u0430 \u0438\u043C\u0430\u0430\u0442` }, array: { unit: `\u0441\u0442\u0430\u0432\u043A\u0438`, verb: `\u0434\u0430 \u0438\u043C\u0430\u0430\u0442` }, set: { unit: `\u0441\u0442\u0430\u0432\u043A\u0438`, verb: `\u0434\u0430 \u0438\u043C\u0430\u0430\u0442` }, map: { unit: `\u0441\u0442\u0430\u0432\u043A\u0438`, verb: `\u0434\u0430 \u0438\u043C\u0430\u0430\u0442` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0432\u043D\u0435\u0441`, email: `\u0430\u0434\u0440\u0435\u0441\u0430 \u043D\u0430 \u0435-\u043F\u043E\u0448\u0442\u0430`, url: `URL`, emoji: `\u0435\u043C\u043E\u045F\u0438`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \u0434\u0430\u0442\u0443\u043C \u0438 \u0432\u0440\u0435\u043C\u0435`, date: `ISO \u0434\u0430\u0442\u0443\u043C`, time: `ISO \u0432\u0440\u0435\u043C\u0435`, duration: `ISO \u0432\u0440\u0435\u043C\u0435\u0442\u0440\u0430\u0435\u045A\u0435`, ipv4: `IPv4 \u0430\u0434\u0440\u0435\u0441\u0430`, ipv6: `IPv6 \u0430\u0434\u0440\u0435\u0441\u0430`, mac: `MAC \u0430\u0434\u0440\u0435\u0441\u0430`, cidrv4: `IPv4 \u043E\u043F\u0441\u0435\u0433`, cidrv6: `IPv6 \u043E\u043F\u0441\u0435\u0433`, base64: `base64-\u0435\u043D\u043A\u043E\u0434\u0438\u0440\u0430\u043D\u0430 \u043D\u0438\u0437\u0430`, base64url: `base64url-\u0435\u043D\u043A\u043E\u0434\u0438\u0440\u0430\u043D\u0430 \u043D\u0438\u0437\u0430`, json_string: `JSON \u043D\u0438\u0437\u0430`, e164: `E.164 \u0431\u0440\u043E\u0458`, credit_card: `\u0431\u0440\u043E\u0458 \u043D\u0430 \u043A\u0440\u0435\u0434\u0438\u0442\u043D\u0430 \u043A\u0430\u0440\u0442\u0438\u0447\u043A\u0430`, jwt: `JWT`, template_literal: `\u0432\u043D\u0435\u0441` }, r2 = { nan: `NaN`, number: `\u0431\u0440\u043E\u0458`, array: `\u043D\u0438\u0437\u0430` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 instanceof ${e10.expected}, \u043F\u0440\u0438\u043C\u0435\u043D\u043E ${i3}` : `\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${t5}, \u043F\u0440\u0438\u043C\u0435\u043D\u043E ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Invalid input: expected ${C(e10.values[0])}` : `\u0413\u0440\u0435\u0448\u0430\u043D\u0430 \u043E\u043F\u0446\u0438\u0458\u0430: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 \u0435\u0434\u043D\u0430 ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u0433\u043E\u043B\u0435\u043C: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${e10.origin ?? `\u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442\u0430`} \u0434\u0430 \u0438\u043C\u0430 ${n4}${e10.maximum.toString()} ${r3.unit ?? `\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0438`}` : `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u0433\u043E\u043B\u0435\u043C: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${e10.origin ?? `\u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442\u0430`} \u0434\u0430 \u0431\u0438\u0434\u0435 ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u043C\u0430\u043B: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${e10.origin} \u0434\u0430 \u0438\u043C\u0430 ${n4}${e10.minimum.toString()} ${r3.unit}` : `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u043C\u0430\u043B: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${e10.origin} \u0434\u0430 \u0431\u0438\u0434\u0435 ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0437\u0430\u043F\u043E\u0447\u043D\u0443\u0432\u0430 \u0441\u043E "${t5.prefix}"` : t5.format === `ends_with` ? `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0437\u0430\u0432\u0440\u0448\u0443\u0432\u0430 \u0441\u043E "${t5.suffix}"` : t5.format === `includes` ? `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0432\u043A\u043B\u0443\u0447\u0443\u0432\u0430 "${t5.includes}"` : t5.format === `regex` ? `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u043E\u0434\u0433\u043E\u0430\u0440\u0430 \u043D\u0430 \u043F\u0430\u0442\u0435\u0440\u043D\u043E\u0442 ${t5.pattern}` : `Invalid ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u0431\u0440\u043E\u0458: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0431\u0438\u0434\u0435 \u0434\u0435\u043B\u0438\u0432 \u0441\u043E ${e10.divisor}`;
      case `unrecognized_keys`:
        return `${e10.keys.length > 1 ? `\u041D\u0435\u043F\u0440\u0435\u043F\u043E\u0437\u043D\u0430\u0435\u043D\u0438 \u043A\u043B\u0443\u0447\u0435\u0432\u0438` : `\u041D\u0435\u043F\u0440\u0435\u043F\u043E\u0437\u043D\u0430\u0435\u043D \u043A\u043B\u0443\u0447`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u043A\u043B\u0443\u0447 \u0432\u043E ${e10.origin}`;
      case `invalid_union`:
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441`;
      case `invalid_element`:
        return `\u0413\u0440\u0435\u0448\u043D\u0430 \u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442 \u0432\u043E ${e10.origin}`;
      default:
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441`;
    }
  };
};
function ws() {
  return { localeError: Cs() };
}
var Ts = () => {
  let e9 = { string: { unit: `aksara`, verb: `mempunyai` }, file: { unit: `bait`, verb: `mempunyai` }, array: { unit: `elemen`, verb: `mempunyai` }, set: { unit: `elemen`, verb: `mempunyai` }, map: { unit: `elemen`, verb: `mempunyai` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `input`, email: `alamat e-mel`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `tarikh masa ISO`, date: `tarikh ISO`, time: `masa ISO`, duration: `tempoh ISO`, ipv4: `alamat IPv4`, ipv6: `alamat IPv6`, mac: `alamat MAC`, cidrv4: `julat IPv4`, cidrv6: `julat IPv6`, base64: `string dikodkan base64`, base64url: `string dikodkan base64url`, json_string: `string JSON`, e164: `nombor E.164`, credit_card: `nombor kad kredit`, jwt: `JWT`, template_literal: `input` }, r2 = { nan: `NaN`, number: `nombor` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Input tidak sah: dijangka instanceof ${e10.expected}, diterima ${i3}` : `Input tidak sah: dijangka ${t5}, diterima ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Input tidak sah: dijangka ${C(e10.values[0])}` : `Pilihan tidak sah: dijangka salah satu daripada ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Terlalu besar: dijangka ${e10.origin ?? `nilai`} ${r3.verb} ${n4}${e10.maximum.toString()} ${r3.unit ?? `elemen`}` : `Terlalu besar: dijangka ${e10.origin ?? `nilai`} adalah ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Terlalu kecil: dijangka ${e10.origin} ${r3.verb} ${n4}${e10.minimum.toString()} ${r3.unit}` : `Terlalu kecil: dijangka ${e10.origin} adalah ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `String tidak sah: mesti bermula dengan "${t5.prefix}"` : t5.format === `ends_with` ? `String tidak sah: mesti berakhir dengan "${t5.suffix}"` : t5.format === `includes` ? `String tidak sah: mesti mengandungi "${t5.includes}"` : t5.format === `regex` ? `String tidak sah: mesti sepadan dengan corak ${t5.pattern}` : `${n3[t5.format] ?? e10.format} tidak sah`;
      }
      case `not_multiple_of`:
        return `Nombor tidak sah: perlu gandaan ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Kunci tidak dikenali: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Kunci tidak sah dalam ${e10.origin}`;
      case `invalid_union`:
        return `Input tidak sah`;
      case `invalid_element`:
        return `Nilai tidak sah dalam ${e10.origin}`;
      default:
        return `Input tidak sah`;
    }
  };
};
function Es() {
  return { localeError: Ts() };
}
var Ds = () => {
  let e9 = { string: { unit: `\u0905\u0915\u094D\u0937\u0930`, verb: `\u0939\u0941\u0928\u0941\u092A\u0930\u094D\u091B` }, file: { unit: `\u092C\u093E\u0907\u091F`, verb: `\u0939\u0941\u0928\u0941\u092A\u0930\u094D\u091B` }, array: { unit: `\u0924\u0924\u094D\u0935`, verb: `\u0939\u0941\u0928\u0941\u092A\u0930\u094D\u091B` }, set: { unit: `\u0924\u0924\u094D\u0935`, verb: `\u0939\u0941\u0928\u0941\u092A\u0930\u094D\u091B` }, map: { unit: `\u092A\u094D\u0930\u0935\u093F\u0937\u094D\u091F\u093F`, verb: `\u0939\u0941\u0928\u0941\u092A\u0930\u094D\u091B` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0907\u0928\u092A\u0941\u091F`, email: `\u0907\u092E\u0947\u0932 \u0920\u0947\u0917\u093E\u0928\u093E`, url: `URL`, emoji: `\u0907\u092E\u094B\u091C\u0940`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \u092E\u093F\u0924\u093F \u0930 \u0938\u092E\u092F`, date: `ISO \u092E\u093F\u0924\u093F`, time: `ISO \u0938\u092E\u092F`, duration: `ISO \u0905\u0935\u0927\u093F`, ipv4: `IPv4 \u0920\u0947\u0917\u093E\u0928\u093E`, ipv6: `IPv6 \u0920\u0947\u0917\u093E\u0928\u093E`, mac: `MAC \u0920\u0947\u0917\u093E\u0928\u093E`, cidrv4: `IPv4 \u0926\u093E\u092F\u0930\u093E`, cidrv6: `IPv6 \u0926\u093E\u092F\u0930\u093E`, base64: `base64-\u0907\u0928\u094D\u0915\u094B\u0921 \u0917\u0930\u093F\u090F\u0915\u094B \u0938\u094D\u091F\u094D\u0930\u093F\u0919`, base64url: `base64url-\u0907\u0928\u094D\u0915\u094B\u0921 \u0917\u0930\u093F\u090F\u0915\u094B \u0938\u094D\u091F\u094D\u0930\u093F\u0919`, json_string: `JSON \u0938\u094D\u091F\u094D\u0930\u093F\u0919`, e164: `E.164 \u0928\u092E\u094D\u092C\u0930`, credit_card: `\u0915\u094D\u0930\u0947\u0921\u093F\u091F \u0915\u093E\u0930\u094D\u0921 \u0928\u092E\u094D\u092C\u0930`, jwt: `JWT`, template_literal: `\u0907\u0928\u092A\u0941\u091F` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input);
        return `\u0905\u092E\u093E\u0928\u094D\u092F \u0907\u0928\u092A\u0941\u091F: \u0905\u092A\u0947\u0915\u094D\u0937\u093F\u0924 ${t5}, \u092A\u094D\u0930\u093E\u092A\u094D\u0924 ${r2[n4] ?? n4}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u0905\u092E\u093E\u0928\u094D\u092F \u0907\u0928\u092A\u0941\u091F: \u0905\u092A\u0947\u0915\u094D\u0937\u093F\u0924 ${C(e10.values[0])}` : `\u0905\u092E\u093E\u0928\u094D\u092F \u0935\u093F\u0915\u0932\u094D\u092A: \u0905\u092A\u0947\u0915\u094D\u0937\u093F\u0924 \u092E\u093E\u0928\u0939\u0930\u0942 \u092E\u0927\u094D\u092F\u0947 \u090F\u0915 ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u0927\u0947\u0930\u0948 \u0920\u0942\u0932\u094B: ${e10.origin ?? `\u092E\u093E\u0928`} \u092E\u093E ${n4}${e10.maximum.toString()} ${r3.unit} ${r3.verb}` : `\u0927\u0947\u0930\u0948 \u0920\u0942\u0932\u094B: ${e10.origin ?? `\u092E\u093E\u0928`} ${n4}${e10.maximum.toString()} \u0939\u0941\u0928\u0941\u092A\u0930\u094D\u091B`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u0927\u0947\u0930\u0948 \u0938\u093E\u0928\u094B: ${e10.origin} \u092E\u093E ${n4}${e10.minimum.toString()} ${r3.unit} ${r3.verb}` : `\u0927\u0947\u0930\u0948 \u0938\u093E\u0928\u094B: ${e10.origin} ${n4}${e10.minimum.toString()} \u0939\u0941\u0928\u0941\u092A\u0930\u094D\u091B`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u0905\u092E\u093E\u0928\u094D\u092F \u0938\u094D\u091F\u094D\u0930\u093F\u0919: "${t5.prefix}" \u092C\u093E\u091F \u0938\u0941\u0930\u0941 \u0939\u0941\u0928\u0941\u092A\u0930\u094D\u091B` : t5.format === `ends_with` ? `\u0905\u092E\u093E\u0928\u094D\u092F \u0938\u094D\u091F\u094D\u0930\u093F\u0919: "${t5.suffix}" \u092E\u093E \u0938\u092E\u093E\u092A\u094D\u0924 \u0939\u0941\u0928\u0941\u092A\u0930\u094D\u091B` : t5.format === `includes` ? `\u0905\u092E\u093E\u0928\u094D\u092F \u0938\u094D\u091F\u094D\u0930\u093F\u0919: "${t5.includes}" \u0938\u092E\u093E\u0935\u0947\u0936 \u0939\u0941\u0928\u0941\u092A\u0930\u094D\u091B` : t5.format === `regex` ? `\u0905\u092E\u093E\u0928\u094D\u092F \u0938\u094D\u091F\u094D\u0930\u093F\u0919: \u0922\u093E\u0901\u091A\u093E ${t5.pattern} \u0938\u0901\u0917 \u092E\u0947\u0932 \u0916\u093E\u0928\u0941\u092A\u0930\u094D\u091B` : `\u0905\u092E\u093E\u0928\u094D\u092F ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u0905\u092E\u093E\u0928\u094D\u092F \u0938\u0902\u0916\u094D\u092F\u093E: ${e10.divisor} \u0915\u094B \u0917\u0941\u0923\u091C \u0939\u0941\u0928\u0941\u092A\u0930\u094D\u091B`;
      case `unrecognized_keys`:
        return `\u0905\u092A\u0930\u093F\u091A\u093F\u0924 \u0915\u0941\u091E\u094D\u091C\u0940${e10.keys.length > 1 ? `\u0939\u0930\u0942` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u0905\u092E\u093E\u0928\u094D\u092F \u0915\u0941\u091E\u094D\u091C\u0940: ${e10.origin} \u092E\u093E`;
      case `invalid_union`:
        return e10.options && Array.isArray(e10.options) && e10.options.length > 0 ? `\u0905\u092E\u093E\u0928\u094D\u092F \u0921\u093F\u0938\u094D\u0915\u094D\u0930\u093F\u092E\u093F\u0928\u0947\u091F\u0930 \u092E\u093E\u0928: \u0905\u092A\u0947\u0915\u094D\u0937\u093F\u0924 ${e10.options.map((e11) => `'${e11}'`).join(` | `)}` : `\u0905\u092E\u093E\u0928\u094D\u092F \u0907\u0928\u092A\u0941\u091F`;
      case `invalid_element`:
        return `\u0905\u092E\u093E\u0928\u094D\u092F \u092E\u093E\u0928: ${e10.origin} \u092E\u093E`;
      default:
        return `\u0905\u092E\u093E\u0928\u094D\u092F \u0907\u0928\u092A\u0941\u091F`;
    }
  };
};
function Os() {
  return { localeError: Ds() };
}
var ks = () => {
  let e9 = { string: { unit: `tekens`, verb: `heeft` }, file: { unit: `bytes`, verb: `heeft` }, array: { unit: `elementen`, verb: `heeft` }, set: { unit: `elementen`, verb: `heeft` }, map: { unit: `elementen`, verb: `heeft` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `invoer`, email: `emailadres`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO datum en tijd`, date: `ISO datum`, time: `ISO tijd`, duration: `ISO duur`, ipv4: `IPv4-adres`, ipv6: `IPv6-adres`, mac: `MAC-adres`, cidrv4: `IPv4-bereik`, cidrv6: `IPv6-bereik`, base64: `base64-gecodeerde tekst`, base64url: `base64 URL-gecodeerde tekst`, json_string: `JSON string`, e164: `E.164-nummer`, credit_card: `creditcardnummer`, jwt: `JWT`, template_literal: `invoer` }, r2 = { nan: `NaN`, number: `getal` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Ongeldige invoer: verwacht instanceof ${e10.expected}, ontving ${i3}` : `Ongeldige invoer: verwacht ${t5}, ontving ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Ongeldige invoer: verwacht ${C(e10.values[0])}` : `Ongeldige optie: verwacht \xE9\xE9n van ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin), i3 = e10.origin === `date` ? `laat` : e10.origin === `string` ? `lang` : `groot`;
        return r3 ? `Te ${i3}: verwacht dat ${e10.origin ?? `waarde`} ${n4}${e10.maximum.toString()} ${r3.unit ?? `elementen`} ${r3.verb}` : `Te ${i3}: verwacht dat ${e10.origin ?? `waarde`} ${n4}${e10.maximum.toString()} is`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin), i3 = e10.origin === `date` ? `vroeg` : e10.origin === `string` ? `kort` : `klein`;
        return r3 ? `Te ${i3}: verwacht dat ${e10.origin} ${n4}${e10.minimum.toString()} ${r3.unit} ${r3.verb}` : `Te ${i3}: verwacht dat ${e10.origin} ${n4}${e10.minimum.toString()} is`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Ongeldige tekst: moet met "${t5.prefix}" beginnen` : t5.format === `ends_with` ? `Ongeldige tekst: moet op "${t5.suffix}" eindigen` : t5.format === `includes` ? `Ongeldige tekst: moet "${t5.includes}" bevatten` : t5.format === `regex` ? `Ongeldige tekst: moet overeenkomen met patroon ${t5.pattern}` : `Ongeldig: ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Ongeldig getal: moet een veelvoud van ${e10.divisor} zijn`;
      case `unrecognized_keys`:
        return `Onbekende key${e10.keys.length > 1 ? `s` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Ongeldige key in ${e10.origin}`;
      case `invalid_union`:
        return `Ongeldige invoer`;
      case `invalid_element`:
        return `Ongeldige waarde in ${e10.origin}`;
      default:
        return `Ongeldige invoer`;
    }
  };
};
function As() {
  return { localeError: ks() };
}
var js = () => {
  let e9 = { string: { unit: `teikn`, verb: `\xE5 ha` }, file: { unit: `bytes`, verb: `\xE5 ha` }, array: { unit: `element`, verb: `\xE5 innehalde` }, set: { unit: `element`, verb: `\xE5 innehalde` }, map: { unit: `element`, verb: `\xE5 innehalde` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `input`, email: `e-postadresse`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO dato- og klokkeslett`, date: `ISO-dato`, time: `ISO-klokkeslett`, duration: `ISO-varigheit`, ipv4: `IPv4-adresse`, ipv6: `IPv6-adresse`, mac: `MAC-adresse`, cidrv4: `IPv4-spekter`, cidrv6: `IPv6-spekter`, base64: `base64-enkoda streng`, base64url: `base64url-enkoda streng`, json_string: `JSON-streng`, e164: `E.164-nummer`, credit_card: `kredittkortnummer`, jwt: `JWT`, template_literal: `input` }, r2 = { nan: `NaN`, number: `tal`, array: `liste` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Ugyldig input: forventa instanceof ${e10.expected}, fekk ${i3}` : `Ugyldig input: forventa ${t5}, fekk ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Ugyldig verdi: forventa ${C(e10.values[0])}` : `Ugyldig val: forventa eitt av ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `For stor(t): forventa ${e10.origin ?? `value`} til \xE5 ha ${n4}${e10.maximum.toString()} ${r3.unit ?? `element`}` : `For stor(t): forventa ${e10.origin ?? `value`} til \xE5 ha ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `For lite(n): forventa ${e10.origin} til \xE5 ha ${n4}${e10.minimum.toString()} ${r3.unit}` : `For lite(n): forventa ${e10.origin} til \xE5 ha ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Ugyldig streng: m\xE5 starte med "${t5.prefix}"` : t5.format === `ends_with` ? `Ugyldig streng: m\xE5 slutte med "${t5.suffix}"` : t5.format === `includes` ? `Ugyldig streng: m\xE5 innehalde "${t5.includes}"` : t5.format === `regex` ? `Ugyldig streng: m\xE5 matche m\xF8nsteret ${t5.pattern}` : `Ugyldig ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Ugyldig tal: m\xE5 vere eit multiplum av ${e10.divisor}`;
      case `unrecognized_keys`:
        return `${e10.keys.length > 1 ? `Ukjende n\xF8klar` : `Ukjend n\xF8kkel`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Ugyldig n\xF8kkel i ${e10.origin}`;
      case `invalid_union`:
        return `Ugyldig input`;
      case `invalid_element`:
        return `Ugyldig verdi i ${e10.origin}`;
      default:
        return `Ugyldig input`;
    }
  };
};
function Ms() {
  return { localeError: js() };
}
var Ns = () => {
  let e9 = { string: { unit: `tegn`, verb: `\xE5 ha` }, file: { unit: `bytes`, verb: `\xE5 ha` }, array: { unit: `elementer`, verb: `\xE5 inneholde` }, set: { unit: `elementer`, verb: `\xE5 inneholde` }, map: { unit: `elementer`, verb: `\xE5 inneholde` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `input`, email: `e-postadresse`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO dato- og klokkeslett`, date: `ISO-dato`, time: `ISO-klokkeslett`, duration: `ISO-varighet`, ipv4: `IPv4-adresse`, ipv6: `IPv6-adresse`, mac: `MAC-adresse`, cidrv4: `IPv4-spekter`, cidrv6: `IPv6-spekter`, base64: `base64-enkodet streng`, base64url: `base64url-enkodet streng`, json_string: `JSON-streng`, e164: `E.164-nummer`, credit_card: `kredittkortnummer`, jwt: `JWT`, template_literal: `input` }, r2 = { nan: `NaN`, number: `tall`, array: `liste` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Ugyldig input: forventet instanceof ${e10.expected}, fikk ${i3}` : `Ugyldig input: forventet ${t5}, fikk ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Ugyldig verdi: forventet ${C(e10.values[0])}` : `Ugyldig valg: forventet en av ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `For stor(t): forventet ${e10.origin ?? `value`} til \xE5 ha ${n4}${e10.maximum.toString()} ${r3.unit ?? `elementer`}` : `For stor(t): forventet ${e10.origin ?? `value`} til \xE5 ha ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `For lite(n): forventet ${e10.origin} til \xE5 ha ${n4}${e10.minimum.toString()} ${r3.unit}` : `For lite(n): forventet ${e10.origin} til \xE5 ha ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Ugyldig streng: m\xE5 starte med "${t5.prefix}"` : t5.format === `ends_with` ? `Ugyldig streng: m\xE5 ende med "${t5.suffix}"` : t5.format === `includes` ? `Ugyldig streng: m\xE5 inneholde "${t5.includes}"` : t5.format === `regex` ? `Ugyldig streng: m\xE5 matche m\xF8nsteret ${t5.pattern}` : `Ugyldig ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Ugyldig tall: m\xE5 v\xE6re et multiplum av ${e10.divisor}`;
      case `unrecognized_keys`:
        return `${e10.keys.length > 1 ? `Ukjente n\xF8kler` : `Ukjent n\xF8kkel`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Ugyldig n\xF8kkel i ${e10.origin}`;
      case `invalid_union`:
        return `Ugyldig input`;
      case `invalid_element`:
        return `Ugyldig verdi i ${e10.origin}`;
      default:
        return `Ugyldig input`;
    }
  };
};
function Ps() {
  return { localeError: Ns() };
}
var Fs = () => {
  let e9 = { string: { unit: `harf`, verb: `olmal\u0131d\u0131r` }, file: { unit: `bayt`, verb: `olmal\u0131d\u0131r` }, array: { unit: `unsur`, verb: `olmal\u0131d\u0131r` }, set: { unit: `unsur`, verb: `olmal\u0131d\u0131r` }, map: { unit: `unsur`, verb: `olmal\u0131d\u0131r` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `giren`, email: `epostag\xE2h`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO heng\xE2m\u0131`, date: `ISO tarihi`, time: `ISO zaman\u0131`, duration: `ISO m\xFCddeti`, ipv4: `IPv4 ni\u015F\xE2n\u0131`, ipv6: `IPv6 ni\u015F\xE2n\u0131`, mac: `MAC ni\u015F\xE2n\u0131`, cidrv4: `IPv4 menzili`, cidrv6: `IPv6 menzili`, base64: `base64-\u015Fifreli metin`, base64url: `base64url-\u015Fifreli metin`, json_string: `JSON metin`, e164: `E.164 say\u0131s\u0131`, credit_card: `i'tib\xE2r kart\u0131 numaras\u0131`, jwt: `JWT`, template_literal: `giren` }, r2 = { nan: `NaN`, number: `numara`, array: `saf`, null: `gayb` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `F\xE2sit giren: umulan instanceof ${e10.expected}, al\u0131nan ${i3}` : `F\xE2sit giren: umulan ${t5}, al\u0131nan ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `F\xE2sit giren: umulan ${C(e10.values[0])}` : `F\xE2sit tercih: m\xFBteberler ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Fazla b\xFCy\xFCk: ${e10.origin ?? `value`}, ${n4}${e10.maximum.toString()} ${r3.unit ?? `elements`} sahip olmal\u0131yd\u0131.` : `Fazla b\xFCy\xFCk: ${e10.origin ?? `value`}, ${n4}${e10.maximum.toString()} olmal\u0131yd\u0131.`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Fazla k\xFC\xE7\xFCk: ${e10.origin}, ${n4}${e10.minimum.toString()} ${r3.unit} sahip olmal\u0131yd\u0131.` : `Fazla k\xFC\xE7\xFCk: ${e10.origin}, ${n4}${e10.minimum.toString()} olmal\u0131yd\u0131.`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `F\xE2sit metin: "${t5.prefix}" ile ba\u015Flamal\u0131.` : t5.format === `ends_with` ? `F\xE2sit metin: "${t5.suffix}" ile bitmeli.` : t5.format === `includes` ? `F\xE2sit metin: "${t5.includes}" ihtiv\xE2 etmeli.` : t5.format === `regex` ? `F\xE2sit metin: ${t5.pattern} nak\u015F\u0131na uymal\u0131.` : `F\xE2sit ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `F\xE2sit say\u0131: ${e10.divisor} kat\u0131 olmal\u0131yd\u0131.`;
      case `unrecognized_keys`:
        return `Tan\u0131nmayan anahtar ${e10.keys.length > 1 ? `s` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `${e10.origin} i\xE7in tan\u0131nmayan anahtar var.`;
      case `invalid_union`:
        return `Giren tan\u0131namad\u0131.`;
      case `invalid_element`:
        return `${e10.origin} i\xE7in tan\u0131nmayan k\u0131ymet var.`;
      default:
        return `K\u0131ymet tan\u0131namad\u0131.`;
    }
  };
};
function Is() {
  return { localeError: Fs() };
}
var Ls = () => {
  let e9 = { string: { unit: `\u062A\u0648\u06A9\u064A`, verb: `\u0648\u0644\u0631\u064A` }, file: { unit: `\u0628\u0627\u06CC\u067C\u0633`, verb: `\u0648\u0644\u0631\u064A` }, array: { unit: `\u062A\u0648\u06A9\u064A`, verb: `\u0648\u0644\u0631\u064A` }, set: { unit: `\u062A\u0648\u06A9\u064A`, verb: `\u0648\u0644\u0631\u064A` }, map: { unit: `\u062A\u0648\u06A9\u064A`, verb: `\u0648\u0644\u0631\u064A` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0648\u0631\u0648\u062F\u064A`, email: `\u0628\u0631\u06CC\u069A\u0646\u0627\u0644\u06CC\u06A9`, url: `\u06CC\u0648 \u0622\u0631 \u0627\u0644`, emoji: `\u0627\u06CC\u0645\u0648\u062C\u064A`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `\u0646\u06CC\u067C\u0647 \u0627\u0648 \u0648\u062E\u062A`, date: `\u0646\u06D0\u067C\u0647`, time: `\u0648\u062E\u062A`, duration: `\u0645\u0648\u062F\u0647`, ipv4: `\u062F IPv4 \u067E\u062A\u0647`, ipv6: `\u062F IPv6 \u067E\u062A\u0647`, mac: `\u062F MAC \u067E\u062A\u0647`, cidrv4: `\u062F IPv4 \u0633\u0627\u062D\u0647`, cidrv6: `\u062F IPv6 \u0633\u0627\u062D\u0647`, base64: `base64-encoded \u0645\u062A\u0646`, base64url: `base64url-encoded \u0645\u062A\u0646`, json_string: `JSON \u0645\u062A\u0646`, e164: `\u062F E.164 \u0634\u0645\u06D0\u0631\u0647`, credit_card: `\u062F \u06A9\u0631\u06CC\u0689\u06CC\u067C \u06A9\u0627\u0631\u062A \u0634\u0645\u06CC\u0631\u0647`, jwt: `JWT`, template_literal: `\u0648\u0631\u0648\u062F\u064A` }, r2 = { nan: `NaN`, number: `\u0639\u062F\u062F`, array: `\u0627\u0631\u06D0` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u0646\u0627\u0633\u0645 \u0648\u0631\u0648\u062F\u064A: \u0628\u0627\u06CC\u062F instanceof ${e10.expected} \u0648\u0627\u06CC, \u0645\u06AB\u0631 ${i3} \u062A\u0631\u0644\u0627\u0633\u0647 \u0634\u0648` : `\u0646\u0627\u0633\u0645 \u0648\u0631\u0648\u062F\u064A: \u0628\u0627\u06CC\u062F ${t5} \u0648\u0627\u06CC, \u0645\u06AB\u0631 ${i3} \u062A\u0631\u0644\u0627\u0633\u0647 \u0634\u0648`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u0646\u0627\u0633\u0645 \u0648\u0631\u0648\u062F\u064A: \u0628\u0627\u06CC\u062F ${C(e10.values[0])} \u0648\u0627\u06CC` : `\u0646\u0627\u0633\u0645 \u0627\u0646\u062A\u062E\u0627\u0628: \u0628\u0627\u06CC\u062F \u06CC\u0648 \u0644\u0647 ${l(e10.values, `|`)} \u0685\u062E\u0647 \u0648\u0627\u06CC`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u0689\u06CC\u0631 \u0644\u0648\u06CC: ${e10.origin ?? `\u0627\u0631\u0632\u069A\u062A`} \u0628\u0627\u06CC\u062F ${n4}${e10.maximum.toString()} ${r3.unit ?? `\u0639\u0646\u0635\u0631\u0648\u0646\u0647`} \u0648\u0644\u0631\u064A` : `\u0689\u06CC\u0631 \u0644\u0648\u06CC: ${e10.origin ?? `\u0627\u0631\u0632\u069A\u062A`} \u0628\u0627\u06CC\u062F ${n4}${e10.maximum.toString()} \u0648\u064A`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u0689\u06CC\u0631 \u06A9\u0648\u0686\u0646\u06CC: ${e10.origin} \u0628\u0627\u06CC\u062F ${n4}${e10.minimum.toString()} ${r3.unit} \u0648\u0644\u0631\u064A` : `\u0689\u06CC\u0631 \u06A9\u0648\u0686\u0646\u06CC: ${e10.origin} \u0628\u0627\u06CC\u062F ${n4}${e10.minimum.toString()} \u0648\u064A`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F "${t5.prefix}" \u0633\u0631\u0647 \u067E\u06CC\u0644 \u0634\u064A` : t5.format === `ends_with` ? `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F "${t5.suffix}" \u0633\u0631\u0647 \u067E\u0627\u06CC \u062A\u0647 \u0648\u0631\u0633\u064A\u0696\u064A` : t5.format === `includes` ? `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F "${t5.includes}" \u0648\u0644\u0631\u064A` : t5.format === `regex` ? `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F ${t5.pattern} \u0633\u0631\u0647 \u0645\u0637\u0627\u0628\u0642\u062A \u0648\u0644\u0631\u064A` : `${n3[t5.format] ?? e10.format} \u0646\u0627\u0633\u0645 \u062F\u06CC`;
      }
      case `not_multiple_of`:
        return `\u0646\u0627\u0633\u0645 \u0639\u062F\u062F: \u0628\u0627\u06CC\u062F \u062F ${e10.divisor} \u0645\u0636\u0631\u0628 \u0648\u064A`;
      case `unrecognized_keys`:
        return `\u0646\u0627\u0633\u0645 ${e10.keys.length > 1 ? `\u06A9\u0644\u06CC\u0689\u0648\u0646\u0647` : `\u06A9\u0644\u06CC\u0689`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u0646\u0627\u0633\u0645 \u06A9\u0644\u06CC\u0689 \u067E\u0647 ${e10.origin} \u06A9\u06D0`;
      case `invalid_union`:
        return `\u0646\u0627\u0633\u0645\u0647 \u0648\u0631\u0648\u062F\u064A`;
      case `invalid_element`:
        return `\u0646\u0627\u0633\u0645 \u0639\u0646\u0635\u0631 \u067E\u0647 ${e10.origin} \u06A9\u06D0`;
      default:
        return `\u0646\u0627\u0633\u0645\u0647 \u0648\u0631\u0648\u062F\u064A`;
    }
  };
};
function Rs() {
  return { localeError: Ls() };
}
var zs = () => {
  let e9 = { string: { unit: `znak\xF3w`, verb: `mie\u0107` }, file: { unit: `bajt\xF3w`, verb: `mie\u0107` }, array: { unit: `element\xF3w`, verb: `mie\u0107` }, set: { unit: `element\xF3w`, verb: `mie\u0107` }, map: { unit: `element\xF3w`, verb: `mie\u0107` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `wyra\u017Cenie`, email: `adres email`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `data i godzina w formacie ISO`, date: `data w formacie ISO`, time: `godzina w formacie ISO`, duration: `czas trwania ISO`, ipv4: `adres IPv4`, ipv6: `adres IPv6`, mac: `adres MAC`, cidrv4: `zakres IPv4`, cidrv6: `zakres IPv6`, base64: `ci\u0105g znak\xF3w zakodowany w formacie base64`, base64url: `ci\u0105g znak\xF3w zakodowany w formacie base64url`, json_string: `ci\u0105g znak\xF3w w formacie JSON`, e164: `liczba E.164`, credit_card: `numer karty kredytowej`, jwt: `JWT`, template_literal: `wej\u015Bcie` }, r2 = { nan: `NaN`, number: `liczba`, array: `tablica` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Nieprawid\u0142owe dane wej\u015Bciowe: oczekiwano instanceof ${e10.expected}, otrzymano ${i3}` : `Nieprawid\u0142owe dane wej\u015Bciowe: oczekiwano ${t5}, otrzymano ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Nieprawid\u0142owe dane wej\u015Bciowe: oczekiwano ${C(e10.values[0])}` : `Nieprawid\u0142owa opcja: oczekiwano jednej z warto\u015Bci ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Za du\u017Ca warto\u015B\u0107: oczekiwano, \u017Ce ${e10.origin ?? `warto\u015B\u0107`} b\u0119dzie mie\u0107 ${n4}${e10.maximum.toString()} ${r3.unit ?? `element\xF3w`}` : `Zbyt du\u017C(y/a/e): oczekiwano, \u017Ce ${e10.origin ?? `warto\u015B\u0107`} b\u0119dzie wynosi\u0107 ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Za ma\u0142a warto\u015B\u0107: oczekiwano, \u017Ce ${e10.origin ?? `warto\u015B\u0107`} b\u0119dzie mie\u0107 ${n4}${e10.minimum.toString()} ${r3.unit ?? `element\xF3w`}` : `Zbyt ma\u0142(y/a/e): oczekiwano, \u017Ce ${e10.origin ?? `warto\u015B\u0107`} b\u0119dzie wynosi\u0107 ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi zaczyna\u0107 si\u0119 od "${t5.prefix}"` : t5.format === `ends_with` ? `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi ko\u0144czy\u0107 si\u0119 na "${t5.suffix}"` : t5.format === `includes` ? `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi zawiera\u0107 "${t5.includes}"` : t5.format === `regex` ? `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi odpowiada\u0107 wzorcowi ${t5.pattern}` : `Nieprawid\u0142ow(y/a/e) ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Nieprawid\u0142owa liczba: musi by\u0107 wielokrotno\u015Bci\u0105 ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Nierozpoznane klucze${e10.keys.length > 1 ? `s` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Nieprawid\u0142owy klucz w ${e10.origin}`;
      case `invalid_union`:
        return `Nieprawid\u0142owe dane wej\u015Bciowe`;
      case `invalid_element`:
        return `Nieprawid\u0142owa warto\u015B\u0107 w ${e10.origin}`;
      default:
        return `Nieprawid\u0142owe dane wej\u015Bciowe`;
    }
  };
};
function Bs() {
  return { localeError: zs() };
}
var Vs = () => {
  let e9 = { string: { unit: `caracteres` }, file: { unit: `bytes` }, array: { unit: `elementos` }, set: { unit: `elementos` }, map: { unit: `entradas` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `a entrada`, email: `o endere\xE7o de e-mail`, url: `o URL`, emoji: `o emoji`, uuid: `o UUID`, uuidv4: `o UUIDv4`, uuidv6: `o UUIDv6`, nanoid: `o nanoid`, guid: `o GUID`, cuid: `o cuid`, cuid2: `o cuid2`, ulid: `o ULID`, xid: `o XID`, ksuid: `o KSUID`, datetime: `a data e hora ISO`, date: `a data ISO`, time: `a hora ISO`, duration: `a dura\xE7\xE3o ISO`, ipv4: `o endere\xE7o IPv4`, ipv6: `o endere\xE7o IPv6`, mac: `o endere\xE7o MAC`, cidrv4: `o intervalo de endere\xE7os IPv4`, cidrv6: `o intervalo de endere\xE7os IPv6`, base64: `o texto codificado em base64`, base64url: `o texto codificado em base64url`, json_string: `o texto JSON`, e164: `o n\xFAmero E.164`, credit_card: `o n\xFAmero de cart\xE3o de cr\xE9dito`, jwt: `o JWT`, template_literal: `a entrada` }, r2 = { masculine: { definite: `o`, indefinite: `um` }, feminine: { definite: `a`, indefinite: `uma` } }, i3 = { string: { name: `texto`, articles: r2.masculine }, number: { name: `n\xFAmero`, articles: r2.masculine }, int: { name: `n\xFAmero inteiro`, articles: r2.masculine }, boolean: { name: `valor booleano`, articles: r2.masculine }, bigint: { name: `n\xFAmero bigint`, articles: r2.masculine }, symbol: { name: `s\xEDmbolo`, articles: r2.masculine }, undefined: { name: `valor "undefined"`, articles: r2.masculine }, null: { name: `valor "nulo"`, articles: r2.masculine }, never: { name: `valor "never"`, articles: r2.masculine }, void: { name: `valor "void"`, articles: r2.masculine }, date: { name: `data`, articles: r2.feminine }, array: { name: `vetor`, articles: r2.masculine }, object: { name: `objeto`, articles: r2.masculine }, tuple: { name: `tuplo`, articles: r2.masculine }, record: { name: `registo`, articles: r2.masculine }, map: { name: `mapa`, articles: r2.masculine }, set: { name: `conjunto`, articles: r2.masculine }, file: { name: `ficheiro`, articles: r2.masculine }, nonoptional: { name: `valor n\xE3o opcional`, articles: r2.masculine }, nan: { name: `valor "NaN"`, articles: r2.masculine }, function: { name: `fun\xE7\xE3o`, articles: r2.feminine } };
  function a3(e10, t5) {
    let n4 = i3[e10] ?? { name: `valor "${e10}"`, articles: r2.masculine };
    return `${n4.articles[t5]} ${n4.name}`;
  }
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`:
        return `Entrada inv\xE1lida: esperava ${a3(e10.expected, `indefinite`)}, recebeu ${a3(D(e10.input), `indefinite`)}`;
      case `invalid_value`:
        return e10.values.length === 1 ? `Entrada inv\xE1lida: esperava ${C(e10.values[0])}` : `Op\xE7\xE3o inv\xE1lida: esperava uma das seguintes op\xE7\xF5es: ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Demasiado grande: esperava que ${a3(e10.origin, `definite`)} tivesse ${n4} ${e10.maximum.toString()} ${r3.unit ?? `elementos`}` : `Demasiado grande: esperava que ${a3(e10.origin, `definite`)} fosse ${n4} ${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Demasiado pequeno: esperava que ${a3(e10.origin, `definite`)} tivesse ${n4} ${e10.minimum.toString()} ${r3.unit ?? `elementos`}` : `Demasiado pequeno: esperava que ${a3(e10.origin, `definite`)} fosse ${n4} ${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Texto inv\xE1lido: deve come\xE7ar por "${t5.prefix}"` : t5.format === `ends_with` ? `Texto inv\xE1lido: deve terminar em "${t5.suffix}"` : t5.format === `includes` ? `Texto inv\xE1lido: deve incluir "${t5.includes}"` : t5.format === `regex` ? `Texto inv\xE1lido: deve corresponder ao padr\xE3o ${t5.pattern}` : `Formato d${n3[t5.format] ?? e10.format} inv\xE1lido`;
      }
      case `not_multiple_of`:
        return `N\xFAmero inv\xE1lido: deve ser m\xFAltiplo de ${e10.divisor}`;
      case `unrecognized_keys`: {
        let t5 = e10.keys.length > 1 ? `s` : ``;
        return `Chave${t5} inv\xE1lida${t5}: ${l(e10.keys, `, `)}`;
      }
      case `invalid_key`:
        return `Entrada inv\xE1lida n${a3(e10.origin, `definite`)}`;
      case `invalid_union`:
        return e10.options && Array.isArray(e10.options) && e10.options.length > 0 ? `Valor de discrimina\xE7\xE3o inv\xE1lido. Esperava ${e10.options.map((e11) => `'${e11}'`).join(` | `)}` : `Entrada inv\xE1lida`;
      case `invalid_element`:
        return `Entrada inv\xE1lida n${a3(e10.origin, `definite`)}`;
      default:
        return `Entrada inv\xE1lida`;
    }
  };
};
function Hs() {
  return { localeError: Vs() };
}
var Us = () => {
  let e9 = { string: { unit: `caracteres` }, file: { unit: `bytes` }, array: { unit: `elementos` }, set: { unit: `elementos` }, map: { unit: `entradas` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `a entrada`, email: `o endere\xE7o de e-mail`, url: `o URL`, emoji: `o emoji`, uuid: `o UUID`, uuidv4: `o UUIDv4`, uuidv6: `o UUIDv6`, nanoid: `o nanoid`, guid: `o GUID`, cuid: `o cuid`, cuid2: `o cuid2`, ulid: `o ULID`, xid: `o XID`, ksuid: `o KSUID`, datetime: `a data e hora ISO`, date: `a data ISO`, time: `a hora ISO`, duration: `a dura\xE7\xE3o ISO`, ipv4: `o endere\xE7o IPv4`, ipv6: `o endere\xE7o IPv6`, mac: `o endere\xE7o MAC`, cidrv4: `a faixa de endere\xE7os IPv4`, cidrv6: `a faixa de endere\xE7os IPv6`, base64: `o texto codificado em base64`, base64url: `o texto codificado em base64url`, json_string: `o texto JSON`, e164: `o n\xFAmero E.164`, credit_card: `o n\xFAmero de cart\xE3o de cr\xE9dito`, jwt: `o JWT`, template_literal: `a entrada` }, r2 = { masculine: { definite: `o`, indefinite: `um` }, feminine: { definite: `a`, indefinite: `uma` } }, i3 = { string: { name: `texto`, articles: r2.masculine }, number: { name: `n\xFAmero`, articles: r2.masculine }, int: { name: `n\xFAmero inteiro`, articles: r2.masculine }, boolean: { name: `valor booleano`, articles: r2.masculine }, bigint: { name: `n\xFAmero bigint`, articles: r2.masculine }, symbol: { name: `s\xEDmbolo`, articles: r2.masculine }, undefined: { name: `valor "undefined"`, articles: r2.masculine }, null: { name: `valor "nulo"`, articles: r2.masculine }, never: { name: `valor "never"`, articles: r2.masculine }, void: { name: `valor "void"`, articles: r2.masculine }, date: { name: `data`, articles: r2.feminine }, array: { name: `vetor`, articles: r2.masculine }, object: { name: `objeto`, articles: r2.masculine }, tuple: { name: `tupla`, articles: r2.feminine }, record: { name: `registro`, articles: r2.masculine }, map: { name: `mapa`, articles: r2.masculine }, set: { name: `conjunto`, articles: r2.masculine }, file: { name: `arquivo`, articles: r2.masculine }, nonoptional: { name: `valor n\xE3o opcional`, articles: r2.masculine }, nan: { name: `valor "NaN"`, articles: r2.masculine }, function: { name: `fun\xE7\xE3o`, articles: r2.feminine } };
  function a3(e10, t5) {
    let n4 = i3[e10] ?? { name: `valor "${e10}"`, articles: r2.masculine };
    return `${n4.articles[t5]} ${n4.name}`;
  }
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`:
        return `Entrada inv\xE1lida: esperava ${a3(e10.expected, `indefinite`)}, recebeu ${a3(D(e10.input), `indefinite`)}`;
      case `invalid_value`:
        return e10.values.length === 1 ? `Entrada inv\xE1lida: esperava ${C(e10.values[0])}` : `Op\xE7\xE3o inv\xE1lida: esperava uma das seguintes op\xE7\xF5es: ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Grande demais: esperava que ${a3(e10.origin, `definite`)} tivesse ${n4} ${e10.maximum.toString()} ${r3.unit ?? `elementos`}` : `Grande demais: esperava que ${a3(e10.origin, `definite`)} fosse ${n4} ${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Pequeno demais: esperava que ${a3(e10.origin, `definite`)} tivesse ${n4} ${e10.minimum.toString()} ${r3.unit ?? `elementos`}` : `Pequeno demais: esperava que ${a3(e10.origin, `definite`)} fosse ${n4} ${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Texto inv\xE1lido: deve come\xE7ar com "${t5.prefix}"` : t5.format === `ends_with` ? `Texto inv\xE1lido: deve terminar com "${t5.suffix}"` : t5.format === `includes` ? `Texto inv\xE1lido: deve incluir "${t5.includes}"` : t5.format === `regex` ? `Texto inv\xE1lido: deve corresponder ao padr\xE3o ${t5.pattern}` : `Formato d${n3[t5.format] ?? e10.format} inv\xE1lido`;
      }
      case `not_multiple_of`:
        return `N\xFAmero inv\xE1lido: deve ser m\xFAltiplo de ${e10.divisor}`;
      case `unrecognized_keys`: {
        let t5 = e10.keys.length > 1 ? `s` : ``;
        return `Chave${t5} inv\xE1lida${t5}: ${l(e10.keys, `, `)}`;
      }
      case `invalid_key`:
        return `Entrada inv\xE1lida n${a3(e10.origin, `definite`)}`;
      case `invalid_union`:
        return e10.options && Array.isArray(e10.options) && e10.options.length > 0 ? `Valor de discrimina\xE7\xE3o inv\xE1lido. Esperava ${e10.options.map((e11) => `'${e11}'`).join(` | `)}` : `Entrada inv\xE1lida`;
      case `invalid_element`:
        return `Entrada inv\xE1lida n${a3(e10.origin, `definite`)}`;
      default:
        return `Entrada inv\xE1lida`;
    }
  };
};
function Ws() {
  return { localeError: Us() };
}
var Gs = () => {
  let e9 = { string: { unit: `caractere`, verb: `s\u0103 aib\u0103` }, file: { unit: `octe\u021Bi`, verb: `s\u0103 aib\u0103` }, array: { unit: `elemente`, verb: `s\u0103 aib\u0103` }, set: { unit: `elemente`, verb: `s\u0103 aib\u0103` }, map: { unit: `intr\u0103ri`, verb: `s\u0103 aib\u0103` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `intrare`, email: `adres\u0103 de email`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `dat\u0103 \u0219i or\u0103 ISO`, date: `dat\u0103 ISO`, time: `or\u0103 ISO`, duration: `durat\u0103 ISO`, ipv4: `adres\u0103 IPv4`, ipv6: `adres\u0103 IPv6`, mac: `adres\u0103 MAC`, cidrv4: `interval IPv4`, cidrv6: `interval IPv6`, base64: `\u0219ir codat base64`, base64url: `\u0219ir codat base64url`, json_string: `\u0219ir JSON`, e164: `num\u0103r E.164`, credit_card: `num\u0103r de card de credit`, jwt: `JWT`, template_literal: `intrare` }, r2 = { nan: `NaN`, string: `\u0219ir`, number: `num\u0103r`, boolean: `boolean`, function: `func\u021Bie`, array: `matrice`, object: `obiect`, undefined: `nedefinit`, symbol: `simbol`, bigint: `num\u0103r mare`, void: `void`, never: `never`, map: `hart\u0103`, set: `set` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input);
        return `Intrare invalid\u0103: a\u0219teptat ${t5}, primit ${r2[n4] ?? n4}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Intrare invalid\u0103: a\u0219teptat ${C(e10.values[0])}` : `Op\u021Biune invalid\u0103: a\u0219teptat una dintre ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Prea mare: a\u0219teptat ca ${e10.origin ?? `valoarea`} ${r3.verb} ${n4}${e10.maximum.toString()} ${r3.unit ?? `elemente`}` : `Prea mare: a\u0219teptat ca ${e10.origin ?? `valoarea`} s\u0103 fie ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Prea mic: a\u0219teptat ca ${e10.origin} ${r3.verb} ${n4}${e10.minimum.toString()} ${r3.unit}` : `Prea mic: a\u0219teptat ca ${e10.origin} s\u0103 fie ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u0218ir invalid: trebuie s\u0103 \xEEnceap\u0103 cu "${t5.prefix}"` : t5.format === `ends_with` ? `\u0218ir invalid: trebuie s\u0103 se termine cu "${t5.suffix}"` : t5.format === `includes` ? `\u0218ir invalid: trebuie s\u0103 includ\u0103 "${t5.includes}"` : t5.format === `regex` ? `\u0218ir invalid: trebuie s\u0103 se potriveasc\u0103 cu modelul ${t5.pattern}` : `Format invalid: ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Num\u0103r invalid: trebuie s\u0103 fie multiplu de ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Chei nerecunoscute: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Cheie invalid\u0103 \xEEn ${e10.origin}`;
      case `invalid_union`:
        return `Intrare invalid\u0103`;
      case `invalid_element`:
        return `Valoare invalid\u0103 \xEEn ${e10.origin}`;
      default:
        return `Intrare invalid\u0103`;
    }
  };
};
function Ks() {
  return { localeError: Gs() };
}
function qs(e9, t4, n3, r2) {
  let i3 = Math.abs(e9), a3 = i3 % 10, o3 = i3 % 100;
  return o3 >= 11 && o3 <= 19 ? r2 : a3 === 1 ? t4 : a3 >= 2 && a3 <= 4 ? n3 : r2;
}
var Js = () => {
  let e9 = { string: { unit: { one: `\u0441\u0438\u043C\u0432\u043E\u043B`, few: `\u0441\u0438\u043C\u0432\u043E\u043B\u0430`, many: `\u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432` }, verb: `\u0438\u043C\u0435\u0442\u044C` }, file: { unit: { one: `\u0431\u0430\u0439\u0442`, few: `\u0431\u0430\u0439\u0442\u0430`, many: `\u0431\u0430\u0439\u0442` }, verb: `\u0438\u043C\u0435\u0442\u044C` }, array: { unit: { one: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442`, few: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430`, many: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432` }, verb: `\u0438\u043C\u0435\u0442\u044C` }, set: { unit: { one: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442`, few: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430`, many: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432` }, verb: `\u0438\u043C\u0435\u0442\u044C` }, map: { unit: { one: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442`, few: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430`, many: `\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432` }, verb: `\u0438\u043C\u0435\u0442\u044C` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0432\u0432\u043E\u0434`, email: `email \u0430\u0434\u0440\u0435\u0441`, url: `URL`, emoji: `\u044D\u043C\u043E\u0434\u0437\u0438`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \u0434\u0430\u0442\u0430 \u0438 \u0432\u0440\u0435\u043C\u044F`, date: `ISO \u0434\u0430\u0442\u0430`, time: `ISO \u0432\u0440\u0435\u043C\u044F`, duration: `ISO \u0434\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C`, ipv4: `IPv4 \u0430\u0434\u0440\u0435\u0441`, ipv6: `IPv6 \u0430\u0434\u0440\u0435\u0441`, mac: `MAC \u0430\u0434\u0440\u0435\u0441`, cidrv4: `IPv4 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D`, cidrv6: `IPv6 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D`, base64: `\u0441\u0442\u0440\u043E\u043A\u0430 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 base64`, base64url: `\u0441\u0442\u0440\u043E\u043A\u0430 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 base64url`, json_string: `JSON \u0441\u0442\u0440\u043E\u043A\u0430`, e164: `\u043D\u043E\u043C\u0435\u0440 E.164`, credit_card: `\u043D\u043E\u043C\u0435\u0440 \u043A\u0440\u0435\u0434\u0438\u0442\u043D\u043E\u0439 \u043A\u0430\u0440\u0442\u044B`, jwt: `JWT`, template_literal: `\u0432\u0432\u043E\u0434` }, r2 = { nan: `NaN`, number: `\u0447\u0438\u0441\u043B\u043E`, array: `\u043C\u0430\u0441\u0441\u0438\u0432` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0432\u043E\u0434: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C instanceof ${e10.expected}, \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E ${i3}` : `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0432\u043E\u0434: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C ${t5}, \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0432\u043E\u0434: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C ${C(e10.values[0])}` : `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0430\u0440\u0438\u0430\u043D\u0442: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0434\u043D\u043E \u0438\u0437 ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        if (r3) {
          let t5 = qs(Number(e10.maximum), r3.unit.one, r3.unit.few, r3.unit.many);
          return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${e10.origin ?? `\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435`} \u0431\u0443\u0434\u0435\u0442 \u0438\u043C\u0435\u0442\u044C ${n4}${e10.maximum.toString()} ${t5}`;
        }
        return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${e10.origin ?? `\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435`} \u0431\u0443\u0434\u0435\u0442 ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        if (r3) {
          let t5 = qs(Number(e10.minimum), r3.unit.one, r3.unit.few, r3.unit.many);
          return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u0430\u043B\u0435\u043D\u044C\u043A\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${e10.origin} \u0431\u0443\u0434\u0435\u0442 \u0438\u043C\u0435\u0442\u044C ${n4}${e10.minimum.toString()} ${t5}`;
        }
        return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u0430\u043B\u0435\u043D\u044C\u043A\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${e10.origin} \u0431\u0443\u0434\u0435\u0442 ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u043D\u0430\u0447\u0438\u043D\u0430\u0442\u044C\u0441\u044F \u0441 "${t5.prefix}"` : t5.format === `ends_with` ? `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0437\u0430\u043A\u0430\u043D\u0447\u0438\u0432\u0430\u0442\u044C\u0441\u044F \u043D\u0430 "${t5.suffix}"` : t5.format === `includes` ? `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u044C "${t5.includes}"` : t5.format === `regex` ? `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0441\u043E\u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u043E\u0432\u0430\u0442\u044C \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${t5.pattern}` : `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u043E\u0435 \u0447\u0438\u0441\u043B\u043E: \u0434\u043E\u043B\u0436\u043D\u043E \u0431\u044B\u0442\u044C \u043A\u0440\u0430\u0442\u043D\u044B\u043C ${e10.divisor}`;
      case `unrecognized_keys`:
        return `\u041D\u0435\u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043D\u043D${e10.keys.length > 1 ? `\u044B\u0435` : `\u044B\u0439`} \u043A\u043B\u044E\u0447${e10.keys.length > 1 ? `\u0438` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u043A\u043B\u044E\u0447 \u0432 ${e10.origin}`;
      case `invalid_union`:
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0435 \u0432\u0445\u043E\u0434\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435`;
      case `invalid_element`:
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 \u0432 ${e10.origin}`;
      default:
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0435 \u0432\u0445\u043E\u0434\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435`;
    }
  };
};
function Ys() {
  return { localeError: Js() };
}
var Xs = () => {
  let e9 = { string: { unit: `znakov`, verb: `ma\u0165` }, file: { unit: `bajtov`, verb: `ma\u0165` }, array: { unit: `prvkov`, verb: `ma\u0165` }, set: { unit: `prvkov`, verb: `ma\u0165` }, map: { unit: `polo\u017Eiek`, verb: `ma\u0165` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `regul\xE1rny v\xFDraz`, email: `e-mailov\xE1 adresa`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `d\xE1tum a \u010Das vo form\xE1te ISO`, date: `d\xE1tum vo form\xE1te ISO`, time: `\u010Das vo form\xE1te ISO`, duration: `doba trvania ISO`, ipv4: `IPv4 adresa`, ipv6: `IPv6 adresa`, mac: `MAC adresa`, cidrv4: `rozsah IPv4`, cidrv6: `rozsah IPv6`, base64: `re\u0165azec zak\xF3dovan\xFD vo form\xE1te base64`, base64url: `re\u0165azec zak\xF3dovan\xFD vo form\xE1te base64url`, json_string: `re\u0165azec vo form\xE1te JSON`, e164: `\u010D\xEDslo E.164`, credit_card: `\u010D\xEDslo kreditnej karty`, jwt: `JWT`, template_literal: `vstup` }, r2 = { nan: `NaN`, number: `\u010D\xEDslo`, string: `re\u0165azec`, function: `funkcia`, array: `pole` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Neplatn\xFD vstup: o\u010Dak\xE1van\xE9 instanceof ${e10.expected}, obdr\u017Ean\xE9 ${i3}` : `Neplatn\xFD vstup: o\u010Dak\xE1van\xE9 ${t5}, obdr\u017Ean\xE9 ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Neplatn\xFD vstup: o\u010Dak\xE1van\xE9 ${C(e10.values[0])}` : `Neplatn\xFD vstup: o\u010Dak\xE1van\xE1 jedna z hodn\xF4t ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Hodnota je pr\xEDli\u0161 ve\u013Ek\xE1: ${e10.origin ?? `hodnota`} mus\xED ma\u0165 ${n4}${e10.maximum.toString()} ${r3.unit ?? `prvkov`}` : `Hodnota je pr\xEDli\u0161 ve\u013Ek\xE1: ${e10.origin ?? `hodnota`} mus\xED by\u0165 ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Hodnota je pr\xEDli\u0161 mal\xE1: ${e10.origin ?? `hodnota`} mus\xED ma\u0165 ${n4}${e10.minimum.toString()} ${r3.unit ?? `prvkov`}` : `Hodnota je pr\xEDli\u0161 mal\xE1: ${e10.origin ?? `hodnota`} mus\xED by\u0165 ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Neplatn\xFD re\u0165azec: mus\xED za\u010D\xEDna\u0165 na "${t5.prefix}"` : t5.format === `ends_with` ? `Neplatn\xFD re\u0165azec: mus\xED kon\u010Di\u0165 na "${t5.suffix}"` : t5.format === `includes` ? `Neplatn\xFD re\u0165azec: mus\xED obsahova\u0165 "${t5.includes}"` : t5.format === `regex` ? `Neplatn\xFD re\u0165azec: mus\xED zodpoveda\u0165 vzoru ${t5.pattern}` : `Neplatn\xFD form\xE1t ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Neplatn\xE9 \u010D\xEDslo: mus\xED by\u0165 n\xE1sobkom ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Nezn\xE1me kl\xFA\u010De: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Neplatn\xFD kl\xFA\u010D v ${e10.origin}`;
      case `invalid_union`:
        return `Neplatn\xFD vstup`;
      case `invalid_element`:
        return `Neplatn\xE1 hodnota v ${e10.origin}`;
      default:
        return `Neplatn\xFD vstup`;
    }
  };
};
function Zs() {
  return { localeError: Xs() };
}
var Qs = () => {
  let e9 = { string: { unit: `znakov`, verb: `imeti` }, file: { unit: `bajtov`, verb: `imeti` }, array: { unit: `elementov`, verb: `imeti` }, set: { unit: `elementov`, verb: `imeti` }, map: { unit: `elementov`, verb: `imeti` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `vnos`, email: `e-po\u0161tni naslov`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO datum in \u010Das`, date: `ISO datum`, time: `ISO \u010Das`, duration: `ISO trajanje`, ipv4: `IPv4 naslov`, ipv6: `IPv6 naslov`, mac: `MAC naslov`, cidrv4: `obseg IPv4`, cidrv6: `obseg IPv6`, base64: `base64 kodiran niz`, base64url: `base64url kodiran niz`, json_string: `JSON niz`, e164: `E.164 \u0161tevilka`, credit_card: `\u0161tevilka kreditne kartice`, jwt: `JWT`, template_literal: `vnos` }, r2 = { nan: `NaN`, number: `\u0161tevilo`, array: `tabela` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Neveljaven vnos: pri\u010Dakovano instanceof ${e10.expected}, prejeto ${i3}` : `Neveljaven vnos: pri\u010Dakovano ${t5}, prejeto ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Neveljaven vnos: pri\u010Dakovano ${C(e10.values[0])}` : `Neveljavna mo\u017Enost: pri\u010Dakovano eno izmed ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Preveliko: pri\u010Dakovano, da bo ${e10.origin ?? `vrednost`} imelo ${n4}${e10.maximum.toString()} ${r3.unit ?? `elementov`}` : `Preveliko: pri\u010Dakovano, da bo ${e10.origin ?? `vrednost`} ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Premajhno: pri\u010Dakovano, da bo ${e10.origin} imelo ${n4}${e10.minimum.toString()} ${r3.unit}` : `Premajhno: pri\u010Dakovano, da bo ${e10.origin} ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Neveljaven niz: mora se za\u010Deti z "${t5.prefix}"` : t5.format === `ends_with` ? `Neveljaven niz: mora se kon\u010Dati z "${t5.suffix}"` : t5.format === `includes` ? `Neveljaven niz: mora vsebovati "${t5.includes}"` : t5.format === `regex` ? `Neveljaven niz: mora ustrezati vzorcu ${t5.pattern}` : `Neveljaven ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Neveljavno \u0161tevilo: mora biti ve\u010Dkratnik ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Neprepoznan${e10.keys.length > 1 ? `i klju\u010Di` : ` klju\u010D`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Neveljaven klju\u010D v ${e10.origin}`;
      case `invalid_union`:
        return `Neveljaven vnos`;
      case `invalid_element`:
        return `Neveljavna vrednost v ${e10.origin}`;
      default:
        return `Neveljaven vnos`;
    }
  };
};
function $s() {
  return { localeError: Qs() };
}
var ec = () => {
  let e9 = { string: { unit: `tecken`, verb: `att ha` }, file: { unit: `bytes`, verb: `att ha` }, array: { unit: `objekt`, verb: `att inneh\xE5lla` }, set: { unit: `objekt`, verb: `att inneh\xE5lla` }, map: { unit: `objekt`, verb: `att inneh\xE5lla` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `regulj\xE4rt uttryck`, email: `e-postadress`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO-datum och tid`, date: `ISO-datum`, time: `ISO-tid`, duration: `ISO-varaktighet`, ipv4: `IPv4-adress`, ipv6: `IPv6-adress`, mac: `MAC-adress`, cidrv4: `IPv4-spektrum`, cidrv6: `IPv6-spektrum`, base64: `base64-kodad str\xE4ng`, base64url: `base64url-kodad str\xE4ng`, json_string: `JSON-str\xE4ng`, e164: `E.164-nummer`, credit_card: `kreditkortsnummer`, jwt: `JWT`, template_literal: `mall-literal` }, r2 = { nan: `NaN`, number: `antal`, array: `lista` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Ogiltig inmatning: f\xF6rv\xE4ntat instanceof ${e10.expected}, fick ${i3}` : `Ogiltig inmatning: f\xF6rv\xE4ntat ${t5}, fick ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Ogiltig inmatning: f\xF6rv\xE4ntat ${C(e10.values[0])}` : `Ogiltigt val: f\xF6rv\xE4ntade en av ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `F\xF6r stor(t): f\xF6rv\xE4ntade ${e10.origin ?? `v\xE4rdet`} att ha ${n4}${e10.maximum.toString()} ${r3.unit ?? `element`}` : `F\xF6r stor(t): f\xF6rv\xE4ntat ${e10.origin ?? `v\xE4rdet`} att ha ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `F\xF6r lite(t): f\xF6rv\xE4ntade ${e10.origin ?? `v\xE4rdet`} att ha ${n4}${e10.minimum.toString()} ${r3.unit}` : `F\xF6r lite(t): f\xF6rv\xE4ntade ${e10.origin ?? `v\xE4rdet`} att ha ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Ogiltig str\xE4ng: m\xE5ste b\xF6rja med "${t5.prefix}"` : t5.format === `ends_with` ? `Ogiltig str\xE4ng: m\xE5ste sluta med "${t5.suffix}"` : t5.format === `includes` ? `Ogiltig str\xE4ng: m\xE5ste inneh\xE5lla "${t5.includes}"` : t5.format === `regex` ? `Ogiltig str\xE4ng: m\xE5ste matcha m\xF6nstret "${t5.pattern}"` : `Ogiltig(t) ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Ogiltigt tal: m\xE5ste vara en multipel av ${e10.divisor}`;
      case `unrecognized_keys`:
        return `${e10.keys.length > 1 ? `Ok\xE4nda nycklar` : `Ok\xE4nd nyckel`}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Ogiltig nyckel i ${e10.origin ?? `v\xE4rdet`}`;
      case `invalid_union`:
        return `Ogiltig input`;
      case `invalid_element`:
        return `Ogiltigt v\xE4rde i ${e10.origin ?? `v\xE4rdet`}`;
      default:
        return `Ogiltig input`;
    }
  };
};
function tc() {
  return { localeError: ec() };
}
var nc = () => {
  let e9 = { string: { unit: `\u0B8E\u0BB4\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1\u0B95\u0BCD\u0B95\u0BB3\u0BCD`, verb: `\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD` }, file: { unit: `\u0BAA\u0BC8\u0B9F\u0BCD\u0B9F\u0BC1\u0B95\u0BB3\u0BCD`, verb: `\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD` }, array: { unit: `\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD`, verb: `\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD` }, set: { unit: `\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD`, verb: `\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD` }, map: { unit: `\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD`, verb: `\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1`, email: `\u0BAE\u0BBF\u0BA9\u0BCD\u0BA9\u0B9E\u0BCD\u0B9A\u0BB2\u0BCD \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \u0BA4\u0BC7\u0BA4\u0BBF \u0BA8\u0BC7\u0BB0\u0BAE\u0BCD`, date: `ISO \u0BA4\u0BC7\u0BA4\u0BBF`, time: `ISO \u0BA8\u0BC7\u0BB0\u0BAE\u0BCD`, duration: `ISO \u0B95\u0BBE\u0BB2 \u0B85\u0BB3\u0BB5\u0BC1`, ipv4: `IPv4 \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF`, ipv6: `IPv6 \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF`, mac: `MAC \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF`, cidrv4: `IPv4 \u0BB5\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1`, cidrv6: `IPv6 \u0BB5\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1`, base64: `base64-encoded \u0B9A\u0BB0\u0BAE\u0BCD`, base64url: `base64url-encoded \u0B9A\u0BB0\u0BAE\u0BCD`, json_string: `JSON \u0B9A\u0BB0\u0BAE\u0BCD`, e164: `E.164 \u0B8E\u0BA3\u0BCD`, credit_card: `\u0B95\u0B9F\u0BA9\u0BCD \u0B85\u0B9F\u0BCD\u0B9F\u0BC8 \u0B8E\u0BA3\u0BCD`, jwt: `JWT`, template_literal: `input` }, r2 = { nan: `NaN`, number: `\u0B8E\u0BA3\u0BCD`, array: `\u0B85\u0BA3\u0BBF`, null: `\u0BB5\u0BC6\u0BB1\u0BC1\u0BAE\u0BC8` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 instanceof ${e10.expected}, \u0BAA\u0BC6\u0BB1\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${i3}` : `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${t5}, \u0BAA\u0BC6\u0BB1\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${C(e10.values[0])}` : `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BB5\u0BBF\u0BB0\u0BC1\u0BAA\u0BCD\u0BAA\u0BAE\u0BCD: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${l(e10.values, `|`)} \u0B87\u0BB2\u0BCD \u0B92\u0BA9\u0BCD\u0BB1\u0BC1`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u0BAE\u0BBF\u0B95 \u0BAA\u0BC6\u0BB0\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${e10.origin ?? `\u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1`} ${n4}${e10.maximum.toString()} ${r3.unit ?? `\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD`} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD` : `\u0BAE\u0BBF\u0B95 \u0BAA\u0BC6\u0BB0\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${e10.origin ?? `\u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1`} ${n4}${e10.maximum.toString()} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u0BAE\u0BBF\u0B95\u0B9A\u0BCD \u0B9A\u0BBF\u0BB1\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${e10.origin} ${n4}${e10.minimum.toString()} ${r3.unit} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD` : `\u0BAE\u0BBF\u0B95\u0B9A\u0BCD \u0B9A\u0BBF\u0BB1\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${e10.origin} ${n4}${e10.minimum.toString()} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${t5.prefix}" \u0B87\u0BB2\u0BCD \u0BA4\u0BCA\u0B9F\u0B99\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD` : t5.format === `ends_with` ? `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${t5.suffix}" \u0B87\u0BB2\u0BCD \u0BAE\u0BC1\u0B9F\u0BBF\u0BB5\u0B9F\u0BC8\u0BAF \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD` : t5.format === `includes` ? `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${t5.includes}" \u0B90 \u0B89\u0BB3\u0BCD\u0BB3\u0B9F\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD` : t5.format === `regex` ? `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: ${t5.pattern} \u0BAE\u0BC1\u0BB1\u0BC8\u0BAA\u0BBE\u0B9F\u0BCD\u0B9F\u0BC1\u0B9F\u0BA9\u0BCD \u0BAA\u0BCA\u0BB0\u0BC1\u0BA8\u0BCD\u0BA4 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD` : `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B8E\u0BA3\u0BCD: ${e10.divisor} \u0B87\u0BA9\u0BCD \u0BAA\u0BB2\u0BAE\u0BBE\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      case `unrecognized_keys`:
        return `\u0B85\u0B9F\u0BC8\u0BAF\u0BBE\u0BB3\u0BAE\u0BCD \u0BA4\u0BC6\u0BB0\u0BBF\u0BAF\u0BBE\u0BA4 \u0BB5\u0BBF\u0B9A\u0BC8${e10.keys.length > 1 ? `\u0B95\u0BB3\u0BCD` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `${e10.origin} \u0B87\u0BB2\u0BCD \u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BB5\u0BBF\u0B9A\u0BC8`;
      case `invalid_union`:
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1`;
      case `invalid_element`:
        return `${e10.origin} \u0B87\u0BB2\u0BCD \u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1`;
      default:
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1`;
    }
  };
};
function rc() {
  return { localeError: nc() };
}
var ic = () => {
  let e9 = { string: { unit: `\u0E15\u0E31\u0E27\u0E2D\u0E31\u0E01\u0E29\u0E23`, verb: `\u0E04\u0E27\u0E23\u0E21\u0E35` }, file: { unit: `\u0E44\u0E1A\u0E15\u0E4C`, verb: `\u0E04\u0E27\u0E23\u0E21\u0E35` }, array: { unit: `\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23`, verb: `\u0E04\u0E27\u0E23\u0E21\u0E35` }, set: { unit: `\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23`, verb: `\u0E04\u0E27\u0E23\u0E21\u0E35` }, map: { unit: `\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23`, verb: `\u0E04\u0E27\u0E23\u0E21\u0E35` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E35\u0E48\u0E1B\u0E49\u0E2D\u0E19`, email: `\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48\u0E2D\u0E35\u0E40\u0E21\u0E25`, url: `URL`, emoji: `\u0E2D\u0E34\u0E42\u0E21\u0E08\u0E34`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO`, date: `\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E41\u0E1A\u0E1A ISO`, time: `\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO`, duration: `\u0E0A\u0E48\u0E27\u0E07\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO`, ipv4: `\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48 IPv4`, ipv6: `\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48 IPv6`, mac: `\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48 MAC`, cidrv4: `\u0E0A\u0E48\u0E27\u0E07 IP \u0E41\u0E1A\u0E1A IPv4`, cidrv6: `\u0E0A\u0E48\u0E27\u0E07 IP \u0E41\u0E1A\u0E1A IPv6`, base64: `\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A Base64`, base64url: `\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A Base64 \u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A URL`, json_string: `\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A JSON`, e164: `\u0E40\u0E1A\u0E2D\u0E23\u0E4C\u0E42\u0E17\u0E23\u0E28\u0E31\u0E1E\u0E17\u0E4C\u0E23\u0E30\u0E2B\u0E27\u0E48\u0E32\u0E07\u0E1B\u0E23\u0E30\u0E40\u0E17\u0E28 (E.164)`, credit_card: `\u0E2B\u0E21\u0E32\u0E22\u0E40\u0E25\u0E02\u0E1A\u0E31\u0E15\u0E23\u0E40\u0E04\u0E23\u0E14\u0E34\u0E15`, jwt: `\u0E42\u0E17\u0E40\u0E04\u0E19 JWT`, template_literal: `\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E35\u0E48\u0E1B\u0E49\u0E2D\u0E19` }, r2 = { nan: `NaN`, number: `\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02`, array: `\u0E2D\u0E32\u0E23\u0E4C\u0E40\u0E23\u0E22\u0E4C (Array)`, null: `\u0E44\u0E21\u0E48\u0E21\u0E35\u0E04\u0E48\u0E32 (null)` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19 instanceof ${e10.expected} \u0E41\u0E15\u0E48\u0E44\u0E14\u0E49\u0E23\u0E31\u0E1A ${i3}` : `\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19 ${t5} \u0E41\u0E15\u0E48\u0E44\u0E14\u0E49\u0E23\u0E31\u0E1A ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u0E04\u0E48\u0E32\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19 ${C(e10.values[0])}` : `\u0E15\u0E31\u0E27\u0E40\u0E25\u0E37\u0E2D\u0E01\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19\u0E2B\u0E19\u0E36\u0E48\u0E07\u0E43\u0E19 ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `\u0E44\u0E21\u0E48\u0E40\u0E01\u0E34\u0E19` : `\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32`, r3 = t4(e10.origin);
        return r3 ? `\u0E40\u0E01\u0E34\u0E19\u0E01\u0E33\u0E2B\u0E19\u0E14: ${e10.origin ?? `\u0E04\u0E48\u0E32`} \u0E04\u0E27\u0E23\u0E21\u0E35${n4} ${e10.maximum.toString()} ${r3.unit ?? `\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23`}` : `\u0E40\u0E01\u0E34\u0E19\u0E01\u0E33\u0E2B\u0E19\u0E14: ${e10.origin ?? `\u0E04\u0E48\u0E32`} \u0E04\u0E27\u0E23\u0E21\u0E35${n4} ${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `\u0E2D\u0E22\u0E48\u0E32\u0E07\u0E19\u0E49\u0E2D\u0E22` : `\u0E21\u0E32\u0E01\u0E01\u0E27\u0E48\u0E32`, r3 = t4(e10.origin);
        return r3 ? `\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32\u0E01\u0E33\u0E2B\u0E19\u0E14: ${e10.origin} \u0E04\u0E27\u0E23\u0E21\u0E35${n4} ${e10.minimum.toString()} ${r3.unit}` : `\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32\u0E01\u0E33\u0E2B\u0E19\u0E14: ${e10.origin} \u0E04\u0E27\u0E23\u0E21\u0E35${n4} ${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E02\u0E36\u0E49\u0E19\u0E15\u0E49\u0E19\u0E14\u0E49\u0E27\u0E22 "${t5.prefix}"` : t5.format === `ends_with` ? `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E25\u0E07\u0E17\u0E49\u0E32\u0E22\u0E14\u0E49\u0E27\u0E22 "${t5.suffix}"` : t5.format === `includes` ? `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E21\u0E35 "${t5.includes}" \u0E2D\u0E22\u0E39\u0E48\u0E43\u0E19\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21` : t5.format === `regex` ? `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E15\u0E49\u0E2D\u0E07\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E17\u0E35\u0E48\u0E01\u0E33\u0E2B\u0E19\u0E14 ${t5.pattern}` : `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E15\u0E49\u0E2D\u0E07\u0E40\u0E1B\u0E47\u0E19\u0E08\u0E33\u0E19\u0E27\u0E19\u0E17\u0E35\u0E48\u0E2B\u0E32\u0E23\u0E14\u0E49\u0E27\u0E22 ${e10.divisor} \u0E44\u0E14\u0E49\u0E25\u0E07\u0E15\u0E31\u0E27`;
      case `unrecognized_keys`:
        return `\u0E1E\u0E1A\u0E04\u0E35\u0E22\u0E4C\u0E17\u0E35\u0E48\u0E44\u0E21\u0E48\u0E23\u0E39\u0E49\u0E08\u0E31\u0E01: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u0E04\u0E35\u0E22\u0E4C\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E19 ${e10.origin}`;
      case `invalid_union`:
        return `\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E44\u0E21\u0E48\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E22\u0E39\u0E40\u0E19\u0E35\u0E22\u0E19\u0E17\u0E35\u0E48\u0E01\u0E33\u0E2B\u0E19\u0E14\u0E44\u0E27\u0E49`;
      case `invalid_element`:
        return `\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E19 ${e10.origin}`;
      default:
        return `\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07`;
    }
  };
};
function ac() {
  return { localeError: ic() };
}
var oc = () => {
  let e9 = { string: { unit: `simwol`, verb: `bolmaly` }, file: { unit: `ba\xFDt`, verb: `bolmaly` }, array: { unit: `elementler`, verb: `bolmaly` }, set: { unit: `elementler`, verb: `bolmaly` }, map: { unit: `elementler`, verb: `bolmaly` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `giri\u015F`, email: `e-po\xE7ta salgysy`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO sene we wagt`, date: `ISO sene`, time: `ISO wagt`, duration: `ISO wagt aralygy`, ipv4: `IPv4 salgysy`, ipv6: `IPv6 salgysy`, mac: `MAC salgysy`, cidrv4: `IPv4 aralygy`, cidrv6: `IPv6 aralygy`, base64: `base64 bilen \u015Fifrlenen setir`, base64url: `base64url bilen \u015Fifrlenen setir`, json_string: `JSON setiri`, e164: `E.164 nomeri`, credit_card: `kredit kartyny\u0148 nomeri`, jwt: `JWT`, template_literal: `\u015Fablon` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input);
        return `N\xE4dogry baha: gara\u015Fylan ${t5} \xFDerine ${r2[n4] ?? n4} alyndy`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `N\xE4dogry baha: ${C(e10.values[0])} bolmaly` : `N\xE4dogry sa\xFDlaw: a\u015Fakdakylardan biri bolmaly: ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Has uly: gara\u015Fyl\xFDan ${e10.origin ?? `baha`} ${n4} ${e10.maximum.toString()} ${r3.unit ?? `element`}` : `Has uly: gara\u015Fyl\xFDan ${e10.origin ?? `baha`} ${n4} ${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Has ki\xE7i: gara\u015Fyl\xFDan ${e10.origin} ${n4} ${e10.minimum.toString()} ${r3.unit}` : `Has ki\xE7i: gara\u015Fyl\xFDan ${e10.origin} ${n4} ${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `N\xE4dogry setir: "${t5.prefix}" bilen ba\u015Flamaly` : t5.format === `ends_with` ? `N\xE4dogry setir: "${t5.suffix}" bilen gutarmaly` : t5.format === `includes` ? `N\xE4dogry setir: "${t5.includes}" saklamaly` : t5.format === `regex` ? `N\xE4dogry setir: ${t5.pattern} nusga la\xFDyk bolmaly` : `N\xE4dogry ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `N\xE4dogry san: ${e10.divisor} bilen galyndysyz b\xF6l\xFCnmeli`;
      case `unrecognized_keys`:
        return `Tanalma\xFDan a\xE7ar${e10.keys.length > 1 ? `lar` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `${e10.origin} i\xE7inde n\xE4dogry a\xE7ar`;
      case `invalid_union`:
        return `N\xE4dogry baha`;
      case `invalid_element`:
        return `${e10.origin} i\xE7inde n\xE4dogry baha`;
      default:
        return `N\xE4dogry baha`;
    }
  };
};
function sc() {
  return { localeError: oc() };
}
var cc = () => {
  let e9 = { string: { unit: `karakter`, verb: `olmal\u0131` }, file: { unit: `bayt`, verb: `olmal\u0131` }, array: { unit: `\xF6\u011Fe`, verb: `olmal\u0131` }, set: { unit: `\xF6\u011Fe`, verb: `olmal\u0131` }, map: { unit: `\xF6\u011Fe`, verb: `olmal\u0131` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `girdi`, email: `e-posta adresi`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO tarih ve saat`, date: `ISO tarih`, time: `ISO saat`, duration: `ISO s\xFCre`, ipv4: `IPv4 adresi`, ipv6: `IPv6 adresi`, mac: `MAC adresi`, cidrv4: `IPv4 aral\u0131\u011F\u0131`, cidrv6: `IPv6 aral\u0131\u011F\u0131`, base64: `base64 ile \u015Fifrelenmi\u015F metin`, base64url: `base64url ile \u015Fifrelenmi\u015F metin`, json_string: `JSON dizesi`, e164: `E.164 say\u0131s\u0131`, credit_card: `kredi kart\u0131 numaras\u0131`, jwt: `JWT`, template_literal: `\u015Eablon dizesi` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Ge\xE7ersiz de\u011Fer: beklenen instanceof ${e10.expected}, al\u0131nan ${i3}` : `Ge\xE7ersiz de\u011Fer: beklenen ${t5}, al\u0131nan ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Ge\xE7ersiz de\u011Fer: beklenen ${C(e10.values[0])}` : `Ge\xE7ersiz se\xE7enek: a\u015Fa\u011F\u0131dakilerden biri olmal\u0131: ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\xC7ok b\xFCy\xFCk: beklenen ${e10.origin ?? `de\u011Fer`} ${n4}${e10.maximum.toString()} ${r3.unit ?? `\xF6\u011Fe`}` : `\xC7ok b\xFCy\xFCk: beklenen ${e10.origin ?? `de\u011Fer`} ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\xC7ok k\xFC\xE7\xFCk: beklenen ${e10.origin} ${n4}${e10.minimum.toString()} ${r3.unit}` : `\xC7ok k\xFC\xE7\xFCk: beklenen ${e10.origin} ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Ge\xE7ersiz metin: "${t5.prefix}" ile ba\u015Flamal\u0131` : t5.format === `ends_with` ? `Ge\xE7ersiz metin: "${t5.suffix}" ile bitmeli` : t5.format === `includes` ? `Ge\xE7ersiz metin: "${t5.includes}" i\xE7ermeli` : t5.format === `regex` ? `Ge\xE7ersiz metin: ${t5.pattern} desenine uymal\u0131` : `Ge\xE7ersiz ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Ge\xE7ersiz say\u0131: ${e10.divisor} ile tam b\xF6l\xFCnebilmeli`;
      case `unrecognized_keys`:
        return `Tan\u0131nmayan anahtar${e10.keys.length > 1 ? `lar` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `${e10.origin} i\xE7inde ge\xE7ersiz anahtar`;
      case `invalid_union`:
        return `Ge\xE7ersiz de\u011Fer`;
      case `invalid_element`:
        return `${e10.origin} i\xE7inde ge\xE7ersiz de\u011Fer`;
      default:
        return `Ge\xE7ersiz de\u011Fer`;
    }
  };
};
function lc() {
  return { localeError: cc() };
}
var uc = () => {
  let e9 = { string: { unit: `\u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432`, verb: `\u043C\u0430\u0442\u0438\u043C\u0435` }, file: { unit: `\u0431\u0430\u0439\u0442\u0456\u0432`, verb: `\u043C\u0430\u0442\u0438\u043C\u0435` }, array: { unit: `\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432`, verb: `\u043C\u0430\u0442\u0438\u043C\u0435` }, set: { unit: `\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432`, verb: `\u043C\u0430\u0442\u0438\u043C\u0435` }, map: { unit: `\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432`, verb: `\u043C\u0430\u0442\u0438\u043C\u0435` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456`, email: `\u0430\u0434\u0440\u0435\u0441\u0430 \u0435\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u0457 \u043F\u043E\u0448\u0442\u0438`, url: `URL`, emoji: `\u0435\u043C\u043E\u0434\u0437\u0456`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `\u0434\u0430\u0442\u0430 \u0442\u0430 \u0447\u0430\u0441 ISO`, date: `\u0434\u0430\u0442\u0430 ISO`, time: `\u0447\u0430\u0441 ISO`, duration: `\u0442\u0440\u0438\u0432\u0430\u043B\u0456\u0441\u0442\u044C ISO`, ipv4: `\u0430\u0434\u0440\u0435\u0441\u0430 IPv4`, ipv6: `\u0430\u0434\u0440\u0435\u0441\u0430 IPv6`, mac: `\u0430\u0434\u0440\u0435\u0441\u0430 MAC`, cidrv4: `\u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D IPv4`, cidrv6: `\u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D IPv6`, base64: `\u0440\u044F\u0434\u043E\u043A \u0443 \u043A\u043E\u0434\u0443\u0432\u0430\u043D\u043D\u0456 base64`, base64url: `\u0440\u044F\u0434\u043E\u043A \u0443 \u043A\u043E\u0434\u0443\u0432\u0430\u043D\u043D\u0456 base64url`, json_string: `\u0440\u044F\u0434\u043E\u043A JSON`, e164: `\u043D\u043E\u043C\u0435\u0440 E.164`, credit_card: `\u043D\u043E\u043C\u0435\u0440 \u043A\u0440\u0435\u0434\u0438\u0442\u043D\u043E\u0457 \u043A\u0430\u0440\u0442\u043A\u0438`, jwt: `JWT`, template_literal: `\u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456` }, r2 = { nan: `NaN`, number: `\u0447\u0438\u0441\u043B\u043E`, array: `\u043C\u0430\u0441\u0438\u0432` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F instanceof ${e10.expected}, \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E ${i3}` : `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F ${t5}, \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F ${C(e10.values[0])}` : `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0430 \u043E\u043F\u0446\u0456\u044F: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F \u043E\u0434\u043D\u0435 \u0437 ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u0432\u0435\u043B\u0438\u043A\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${e10.origin ?? `\u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F`} ${r3.verb} ${n4}${e10.maximum.toString()} ${r3.unit ?? `\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432`}` : `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u0432\u0435\u043B\u0438\u043A\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${e10.origin ?? `\u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F`} \u0431\u0443\u0434\u0435 ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u043C\u0430\u043B\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${e10.origin} ${r3.verb} ${n4}${e10.minimum.toString()} ${r3.unit}` : `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u043C\u0430\u043B\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${e10.origin} \u0431\u0443\u0434\u0435 ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u043F\u043E\u0447\u0438\u043D\u0430\u0442\u0438\u0441\u044F \u0437 "${t5.prefix}"` : t5.format === `ends_with` ? `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u0437\u0430\u043A\u0456\u043D\u0447\u0443\u0432\u0430\u0442\u0438\u0441\u044F \u043D\u0430 "${t5.suffix}"` : t5.format === `includes` ? `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u043C\u0456\u0441\u0442\u0438\u0442\u0438 "${t5.includes}"` : t5.format === `regex` ? `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0430\u0442\u0438 \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${t5.pattern}` : `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0435 \u0447\u0438\u0441\u043B\u043E: \u043F\u043E\u0432\u0438\u043D\u043D\u043E \u0431\u0443\u0442\u0438 \u043A\u0440\u0430\u0442\u043D\u0438\u043C ${e10.divisor}`;
      case `unrecognized_keys`:
        return `\u041D\u0435\u0440\u043E\u0437\u043F\u0456\u0437\u043D\u0430\u043D\u0438\u0439 \u043A\u043B\u044E\u0447${e10.keys.length > 1 ? `\u0456` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u043A\u043B\u044E\u0447 \u0443 ${e10.origin}`;
      case `invalid_union`:
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456`;
      case `invalid_element`:
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u0443 ${e10.origin}`;
      default:
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456`;
    }
  };
};
function dc() {
  return { localeError: uc() };
}
function fc() {
  return dc();
}
var pc = () => {
  let e9 = { string: { unit: `\u062D\u0631\u0648\u0641`, verb: `\u06C1\u0648\u0646\u0627` }, file: { unit: `\u0628\u0627\u0626\u0679\u0633`, verb: `\u06C1\u0648\u0646\u0627` }, array: { unit: `\u0622\u0626\u0679\u0645\u0632`, verb: `\u06C1\u0648\u0646\u0627` }, set: { unit: `\u0622\u0626\u0679\u0645\u0632`, verb: `\u06C1\u0648\u0646\u0627` }, map: { unit: `\u0622\u0626\u0679\u0645\u0632`, verb: `\u06C1\u0648\u0646\u0627` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0627\u0646 \u067E\u0679`, email: `\u0627\u06CC \u0645\u06CC\u0644 \u0627\u06CC\u0688\u0631\u06CC\u0633`, url: `\u06CC\u0648 \u0622\u0631 \u0627\u06CC\u0644`, emoji: `\u0627\u06CC\u0645\u0648\u062C\u06CC`, uuid: `\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC`, uuidv4: `\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC \u0648\u06CC 4`, uuidv6: `\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC \u0648\u06CC 6`, nanoid: `\u0646\u06CC\u0646\u0648 \u0622\u0626\u06CC \u0688\u06CC`, guid: `\u062C\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC`, cuid: `\u0633\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC`, cuid2: `\u0633\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC 2`, ulid: `\u06CC\u0648 \u0627\u06CC\u0644 \u0622\u0626\u06CC \u0688\u06CC`, xid: `\u0627\u06CC\u06A9\u0633 \u0622\u0626\u06CC \u0688\u06CC`, ksuid: `\u06A9\u06D2 \u0627\u06CC\u0633 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC`, datetime: `\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0688\u06CC\u0679 \u0679\u0627\u0626\u0645`, date: `\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u062A\u0627\u0631\u06CC\u062E`, time: `\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0648\u0642\u062A`, duration: `\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0645\u062F\u062A`, ipv4: `\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 4 \u0627\u06CC\u0688\u0631\u06CC\u0633`, ipv6: `\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 6 \u0627\u06CC\u0688\u0631\u06CC\u0633`, mac: `\u0627\u06CC\u0645 \u0627\u06D2 \u0633\u06CC \u0627\u06CC\u0688\u0631\u06CC\u0633`, cidrv4: `\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 4 \u0631\u06CC\u0646\u062C`, cidrv6: `\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 6 \u0631\u06CC\u0646\u062C`, base64: `\u0628\u06CC\u0633 64 \u0627\u0646 \u06A9\u0648\u0688\u0688 \u0633\u0679\u0631\u0646\u06AF`, base64url: `\u0628\u06CC\u0633 64 \u06CC\u0648 \u0622\u0631 \u0627\u06CC\u0644 \u0627\u0646 \u06A9\u0648\u0688\u0688 \u0633\u0679\u0631\u0646\u06AF`, json_string: `\u062C\u06D2 \u0627\u06CC\u0633 \u0627\u0648 \u0627\u06CC\u0646 \u0633\u0679\u0631\u0646\u06AF`, e164: `\u0627\u06CC 164 \u0646\u0645\u0628\u0631`, credit_card: `\u06A9\u0631\u06CC\u0688\u0679 \u06A9\u0627\u0631\u0688 \u0646\u0645\u0628\u0631`, jwt: `\u062C\u06D2 \u0688\u0628\u0644\u06CC\u0648 \u0679\u06CC`, template_literal: `\u0627\u0646 \u067E\u0679` }, r2 = { nan: `NaN`, number: `\u0646\u0645\u0628\u0631`, array: `\u0622\u0631\u06D2`, null: `\u0646\u0644` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679: instanceof ${e10.expected} \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627\u060C ${i3} \u0645\u0648\u0635\u0648\u0644 \u06C1\u0648\u0627` : `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679: ${t5} \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627\u060C ${i3} \u0645\u0648\u0635\u0648\u0644 \u06C1\u0648\u0627`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679: ${C(e10.values[0])} \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627` : `\u063A\u0644\u0637 \u0622\u067E\u0634\u0646: ${l(e10.values, `|`)} \u0645\u06CC\u06BA \u0633\u06D2 \u0627\u06CC\u06A9 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u0628\u06C1\u062A \u0628\u0691\u0627: ${e10.origin ?? `\u0648\u06CC\u0644\u06CC\u0648`} \u06A9\u06D2 ${n4}${e10.maximum.toString()} ${r3.unit ?? `\u0639\u0646\u0627\u0635\u0631`} \u06C1\u0648\u0646\u06D2 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u06D2` : `\u0628\u06C1\u062A \u0628\u0691\u0627: ${e10.origin ?? `\u0648\u06CC\u0644\u06CC\u0648`} \u06A9\u0627 ${n4}${e10.maximum.toString()} \u06C1\u0648\u0646\u0627 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u0628\u06C1\u062A \u0686\u06BE\u0648\u0679\u0627: ${e10.origin} \u06A9\u06D2 ${n4}${e10.minimum.toString()} ${r3.unit} \u06C1\u0648\u0646\u06D2 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u06D2` : `\u0628\u06C1\u062A \u0686\u06BE\u0648\u0679\u0627: ${e10.origin} \u06A9\u0627 ${n4}${e10.minimum.toString()} \u06C1\u0648\u0646\u0627 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${t5.prefix}" \u0633\u06D2 \u0634\u0631\u0648\u0639 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2` : t5.format === `ends_with` ? `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${t5.suffix}" \u067E\u0631 \u062E\u062A\u0645 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2` : t5.format === `includes` ? `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${t5.includes}" \u0634\u0627\u0645\u0644 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2` : t5.format === `regex` ? `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: \u067E\u06CC\u0679\u0631\u0646 ${t5.pattern} \u0633\u06D2 \u0645\u06CC\u0686 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2` : `\u063A\u0644\u0637 ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u063A\u0644\u0637 \u0646\u0645\u0628\u0631: ${e10.divisor} \u06A9\u0627 \u0645\u0636\u0627\u0639\u0641 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
      case `unrecognized_keys`:
        return `\u063A\u06CC\u0631 \u062A\u0633\u0644\u06CC\u0645 \u0634\u062F\u06C1 \u06A9\u06CC${e10.keys.length > 1 ? `\u0632` : ``}: ${l(e10.keys, `\u060C `)}`;
      case `invalid_key`:
        return `${e10.origin} \u0645\u06CC\u06BA \u063A\u0644\u0637 \u06A9\u06CC`;
      case `invalid_union`:
        return `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679`;
      case `invalid_element`:
        return `${e10.origin} \u0645\u06CC\u06BA \u063A\u0644\u0637 \u0648\u06CC\u0644\u06CC\u0648`;
      default:
        return `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679`;
    }
  };
};
function mc() {
  return { localeError: pc() };
}
var hc = () => {
  let e9 = { string: { unit: `belgi`, verb: `bo\u2018lishi kerak` }, file: { unit: `bayt`, verb: `bo\u2018lishi kerak` }, array: { unit: `element`, verb: `bo\u2018lishi kerak` }, set: { unit: `element`, verb: `bo\u2018lishi kerak` }, map: { unit: `yozuv`, verb: `bo\u2018lishi kerak` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `kirish`, email: `elektron pochta manzili`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO sana va vaqti`, date: `ISO sana`, time: `ISO vaqt`, duration: `ISO davomiylik`, ipv4: `IPv4 manzil`, ipv6: `IPv6 manzil`, mac: `MAC manzil`, cidrv4: `IPv4 diapazon`, cidrv6: `IPv6 diapazon`, base64: `base64 kodlangan satr`, base64url: `base64url kodlangan satr`, json_string: `JSON satr`, e164: `E.164 raqam`, credit_card: `kredit karta raqami`, jwt: `JWT`, template_literal: `kirish` }, r2 = { nan: `NaN`, number: `raqam`, array: `massiv` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `Noto\u2018g\u2018ri kirish: kutilgan instanceof ${e10.expected}, qabul qilingan ${i3}` : `Noto\u2018g\u2018ri kirish: kutilgan ${t5}, qabul qilingan ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `Noto\u2018g\u2018ri kirish: kutilgan ${C(e10.values[0])}` : `Noto\u2018g\u2018ri variant: quyidagilardan biri kutilgan ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Juda katta: kutilgan ${e10.origin ?? `qiymat`} ${n4}${e10.maximum.toString()} ${r3.unit} ${r3.verb}` : `Juda katta: kutilgan ${e10.origin ?? `qiymat`} ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Juda kichik: kutilgan ${e10.origin} ${n4}${e10.minimum.toString()} ${r3.unit} ${r3.verb}` : `Juda kichik: kutilgan ${e10.origin} ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Noto\u2018g\u2018ri satr: "${t5.prefix}" bilan boshlanishi kerak` : t5.format === `ends_with` ? `Noto\u2018g\u2018ri satr: "${t5.suffix}" bilan tugashi kerak` : t5.format === `includes` ? `Noto\u2018g\u2018ri satr: "${t5.includes}" ni o\u2018z ichiga olishi kerak` : t5.format === `regex` ? `Noto\u2018g\u2018ri satr: ${t5.pattern} shabloniga mos kelishi kerak` : `Noto\u2018g\u2018ri ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `Noto\u2018g\u2018ri raqam: ${e10.divisor} ning karralisi bo\u2018lishi kerak`;
      case `unrecognized_keys`:
        return `Noma\u2019lum kalit${e10.keys.length > 1 ? `lar` : ``}: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `${e10.origin} dagi kalit noto\u2018g\u2018ri`;
      case `invalid_union`:
        return `Noto\u2018g\u2018ri kirish`;
      case `invalid_element`:
        return `${e10.origin} da noto\u2018g\u2018ri qiymat`;
      default:
        return `Noto\u2018g\u2018ri kirish`;
    }
  };
};
function gc() {
  return { localeError: hc() };
}
var _c = () => {
  let e9 = { string: { unit: `k\xFD t\u1EF1`, verb: `c\xF3` }, file: { unit: `byte`, verb: `c\xF3` }, array: { unit: `ph\u1EA7n t\u1EED`, verb: `c\xF3` }, set: { unit: `ph\u1EA7n t\u1EED`, verb: `c\xF3` }, map: { unit: `ph\u1EA7n t\u1EED`, verb: `c\xF3` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u0111\u1EA7u v\xE0o`, email: `\u0111\u1ECBa ch\u1EC9 email`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ng\xE0y gi\u1EDD ISO`, date: `ng\xE0y ISO`, time: `gi\u1EDD ISO`, duration: `kho\u1EA3ng th\u1EDDi gian ISO`, ipv4: `\u0111\u1ECBa ch\u1EC9 IPv4`, ipv6: `\u0111\u1ECBa ch\u1EC9 IPv6`, mac: `\u0111\u1ECBa ch\u1EC9 MAC`, cidrv4: `d\u1EA3i IPv4`, cidrv6: `d\u1EA3i IPv6`, base64: `chu\u1ED7i m\xE3 h\xF3a base64`, base64url: `chu\u1ED7i m\xE3 h\xF3a base64url`, json_string: `chu\u1ED7i JSON`, e164: `s\u1ED1 E.164`, credit_card: `s\u1ED1 th\u1EBB t\xEDn d\u1EE5ng`, jwt: `JWT`, template_literal: `\u0111\u1EA7u v\xE0o` }, r2 = { nan: `NaN`, number: `s\u1ED1`, array: `m\u1EA3ng` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i instanceof ${e10.expected}, nh\u1EADn \u0111\u01B0\u1EE3c ${i3}` : `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i ${t5}, nh\u1EADn \u0111\u01B0\u1EE3c ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i ${C(e10.values[0])}` : `T\xF9y ch\u1ECDn kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i m\u1ED9t trong c\xE1c gi\xE1 tr\u1ECB ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `Qu\xE1 l\u1EDBn: mong \u0111\u1EE3i ${e10.origin ?? `gi\xE1 tr\u1ECB`} ${r3.verb} ${n4}${e10.maximum.toString()} ${r3.unit ?? `ph\u1EA7n t\u1EED`}` : `Qu\xE1 l\u1EDBn: mong \u0111\u1EE3i ${e10.origin ?? `gi\xE1 tr\u1ECB`} ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `Qu\xE1 nh\u1ECF: mong \u0111\u1EE3i ${e10.origin} ${r3.verb} ${n4}${e10.minimum.toString()} ${r3.unit}` : `Qu\xE1 nh\u1ECF: mong \u0111\u1EE3i ${e10.origin} ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i b\u1EAFt \u0111\u1EA7u b\u1EB1ng "${t5.prefix}"` : t5.format === `ends_with` ? `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i k\u1EBFt th\xFAc b\u1EB1ng "${t5.suffix}"` : t5.format === `includes` ? `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i bao g\u1ED3m "${t5.includes}"` : t5.format === `regex` ? `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i kh\u1EDBp v\u1EDBi m\u1EABu ${t5.pattern}` : `${n3[t5.format] ?? e10.format} kh\xF4ng h\u1EE3p l\u1EC7`;
      }
      case `not_multiple_of`:
        return `S\u1ED1 kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i l\xE0 b\u1ED9i s\u1ED1 c\u1EE7a ${e10.divisor}`;
      case `unrecognized_keys`:
        return `Kh\xF3a kh\xF4ng \u0111\u01B0\u1EE3c nh\u1EADn d\u1EA1ng: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `Kh\xF3a kh\xF4ng h\u1EE3p l\u1EC7 trong ${e10.origin}`;
      case `invalid_union`:
        return `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7`;
      case `invalid_element`:
        return `Gi\xE1 tr\u1ECB kh\xF4ng h\u1EE3p l\u1EC7 trong ${e10.origin}`;
      default:
        return `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7`;
    }
  };
};
function vc() {
  return { localeError: _c() };
}
var yc = () => {
  let e9 = { string: { unit: `\u5B57\u7B26`, verb: `\u5305\u542B` }, file: { unit: `\u5B57\u8282`, verb: `\u5305\u542B` }, array: { unit: `\u9879`, verb: `\u5305\u542B` }, set: { unit: `\u9879`, verb: `\u5305\u542B` }, map: { unit: `\u9879`, verb: `\u5305\u542B` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u8F93\u5165`, email: `\u7535\u5B50\u90AE\u4EF6`, url: `URL`, emoji: `\u8868\u60C5\u7B26\u53F7`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO\u65E5\u671F\u65F6\u95F4`, date: `ISO\u65E5\u671F`, time: `ISO\u65F6\u95F4`, duration: `ISO\u65F6\u957F`, ipv4: `IPv4\u5730\u5740`, ipv6: `IPv6\u5730\u5740`, mac: `MAC\u5730\u5740`, cidrv4: `IPv4\u7F51\u6BB5`, cidrv6: `IPv6\u7F51\u6BB5`, base64: `base64\u7F16\u7801\u5B57\u7B26\u4E32`, base64url: `base64url\u7F16\u7801\u5B57\u7B26\u4E32`, json_string: `JSON\u5B57\u7B26\u4E32`, e164: `E.164\u53F7\u7801`, credit_card: `\u4FE1\u7528\u5361\u53F7`, jwt: `JWT`, template_literal: `\u8F93\u5165` }, r2 = { nan: `NaN`, number: `\u6570\u5B57`, array: `\u6570\u7EC4`, null: `\u7A7A\u503C(null)` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u65E0\u6548\u8F93\u5165\uFF1A\u671F\u671B instanceof ${e10.expected}\uFF0C\u5B9E\u9645\u63A5\u6536 ${i3}` : `\u65E0\u6548\u8F93\u5165\uFF1A\u671F\u671B ${t5}\uFF0C\u5B9E\u9645\u63A5\u6536 ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u65E0\u6548\u8F93\u5165\uFF1A\u671F\u671B ${C(e10.values[0])}` : `\u65E0\u6548\u9009\u9879\uFF1A\u671F\u671B\u4EE5\u4E0B\u4E4B\u4E00 ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u6570\u503C\u8FC7\u5927\uFF1A\u671F\u671B ${e10.origin ?? `\u503C`} ${n4}${e10.maximum.toString()} ${r3.unit ?? `\u4E2A\u5143\u7D20`}` : `\u6570\u503C\u8FC7\u5927\uFF1A\u671F\u671B ${e10.origin ?? `\u503C`} ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u6570\u503C\u8FC7\u5C0F\uFF1A\u671F\u671B ${e10.origin} ${n4}${e10.minimum.toString()} ${r3.unit}` : `\u6570\u503C\u8FC7\u5C0F\uFF1A\u671F\u671B ${e10.origin} ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u4EE5 "${t5.prefix}" \u5F00\u5934` : t5.format === `ends_with` ? `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u4EE5 "${t5.suffix}" \u7ED3\u5C3E` : t5.format === `includes` ? `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u5305\u542B "${t5.includes}"` : t5.format === `regex` ? `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u6EE1\u8DB3\u6B63\u5219\u8868\u8FBE\u5F0F ${t5.pattern}` : `\u65E0\u6548${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u65E0\u6548\u6570\u5B57\uFF1A\u5FC5\u987B\u662F ${e10.divisor} \u7684\u500D\u6570`;
      case `unrecognized_keys`:
        return `\u51FA\u73B0\u672A\u77E5\u7684\u952E(key): ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `${e10.origin} \u4E2D\u7684\u952E(key)\u65E0\u6548`;
      case `invalid_union`:
        return `\u65E0\u6548\u8F93\u5165`;
      case `invalid_element`:
        return `${e10.origin} \u4E2D\u5305\u542B\u65E0\u6548\u503C(value)`;
      default:
        return `\u65E0\u6548\u8F93\u5165`;
    }
  };
};
function bc() {
  return { localeError: yc() };
}
var xc = () => {
  let e9 = { string: { unit: `\u5B57\u5143`, verb: `\u64C1\u6709` }, file: { unit: `\u4F4D\u5143\u7D44`, verb: `\u64C1\u6709` }, array: { unit: `\u9805\u76EE`, verb: `\u64C1\u6709` }, set: { unit: `\u9805\u76EE`, verb: `\u64C1\u6709` }, map: { unit: `\u9805\u76EE`, verb: `\u64C1\u6709` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u8F38\u5165`, email: `\u90F5\u4EF6\u5730\u5740`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `ISO \u65E5\u671F\u6642\u9593`, date: `ISO \u65E5\u671F`, time: `ISO \u6642\u9593`, duration: `ISO \u671F\u9593`, ipv4: `IPv4 \u4F4D\u5740`, ipv6: `IPv6 \u4F4D\u5740`, mac: `MAC \u4F4D\u5740`, cidrv4: `IPv4 \u7BC4\u570D`, cidrv6: `IPv6 \u7BC4\u570D`, base64: `base64 \u7DE8\u78BC\u5B57\u4E32`, base64url: `base64url \u7DE8\u78BC\u5B57\u4E32`, json_string: `JSON \u5B57\u4E32`, e164: `E.164 \u6578\u503C`, credit_card: `\u4FE1\u7528\u5361\u865F`, jwt: `JWT`, template_literal: `\u8F38\u5165` }, r2 = { nan: `NaN` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\u7121\u6548\u7684\u8F38\u5165\u503C\uFF1A\u9810\u671F\u70BA instanceof ${e10.expected}\uFF0C\u4F46\u6536\u5230 ${i3}` : `\u7121\u6548\u7684\u8F38\u5165\u503C\uFF1A\u9810\u671F\u70BA ${t5}\uFF0C\u4F46\u6536\u5230 ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\u7121\u6548\u7684\u8F38\u5165\u503C\uFF1A\u9810\u671F\u70BA ${C(e10.values[0])}` : `\u7121\u6548\u7684\u9078\u9805\uFF1A\u9810\u671F\u70BA\u4EE5\u4E0B\u5176\u4E2D\u4E4B\u4E00 ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `\u6578\u503C\u904E\u5927\uFF1A\u9810\u671F ${e10.origin ?? `\u503C`} \u61C9\u70BA ${n4}${e10.maximum.toString()} ${r3.unit ?? `\u500B\u5143\u7D20`}` : `\u6578\u503C\u904E\u5927\uFF1A\u9810\u671F ${e10.origin ?? `\u503C`} \u61C9\u70BA ${n4}${e10.maximum.toString()}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `\u6578\u503C\u904E\u5C0F\uFF1A\u9810\u671F ${e10.origin} \u61C9\u70BA ${n4}${e10.minimum.toString()} ${r3.unit}` : `\u6578\u503C\u904E\u5C0F\uFF1A\u9810\u671F ${e10.origin} \u61C9\u70BA ${n4}${e10.minimum.toString()}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u4EE5 "${t5.prefix}" \u958B\u982D` : t5.format === `ends_with` ? `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u4EE5 "${t5.suffix}" \u7D50\u5C3E` : t5.format === `includes` ? `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u5305\u542B "${t5.includes}"` : t5.format === `regex` ? `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u7B26\u5408\u683C\u5F0F ${t5.pattern}` : `\u7121\u6548\u7684 ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `\u7121\u6548\u7684\u6578\u5B57\uFF1A\u5FC5\u9808\u70BA ${e10.divisor} \u7684\u500D\u6578`;
      case `unrecognized_keys`:
        return `\u7121\u6CD5\u8B58\u5225\u7684\u9375\u503C${e10.keys.length > 1 ? `\u5011` : ``}\uFF1A${l(e10.keys, `\u3001`)}`;
      case `invalid_key`:
        return `${e10.origin} \u4E2D\u6709\u7121\u6548\u7684\u9375\u503C`;
      case `invalid_union`:
        return `\u7121\u6548\u7684\u8F38\u5165\u503C`;
      case `invalid_element`:
        return `${e10.origin} \u4E2D\u6709\u7121\u6548\u7684\u503C`;
      default:
        return `\u7121\u6548\u7684\u8F38\u5165\u503C`;
    }
  };
};
function Sc() {
  return { localeError: xc() };
}
var Cc = () => {
  let e9 = { string: { unit: `\xE0mi`, verb: `n\xED` }, file: { unit: `bytes`, verb: `n\xED` }, array: { unit: `nkan`, verb: `n\xED` }, set: { unit: `nkan`, verb: `n\xED` }, map: { unit: `nkan`, verb: `n\xED` } };
  function t4(t5) {
    return e9[t5] ?? null;
  }
  let n3 = { regex: `\u1EB9\u0300r\u1ECD \xECb\xE1w\u1ECDl\xE9`, email: `\xE0d\xEDr\u1EB9\u0301s\xEC \xECm\u1EB9\u0301l\xEC`, url: `URL`, emoji: `emoji`, uuid: `UUID`, uuidv4: `UUIDv4`, uuidv6: `UUIDv6`, nanoid: `nanoid`, guid: `GUID`, cuid: `cuid`, cuid2: `cuid2`, ulid: `ULID`, xid: `XID`, ksuid: `KSUID`, datetime: `\xE0k\xF3k\xF2 ISO`, date: `\u1ECDj\u1ECD\u0301 ISO`, time: `\xE0k\xF3k\xF2 ISO`, duration: `\xE0k\xF3k\xF2 t\xF3 p\xE9 ISO`, ipv4: `\xE0d\xEDr\u1EB9\u0301s\xEC IPv4`, ipv6: `\xE0d\xEDr\u1EB9\u0301s\xEC IPv6`, mac: `\xE0d\xEDr\u1EB9\u0301s\xEC MAC`, cidrv4: `\xE0gb\xE8gb\xE8 IPv4`, cidrv6: `\xE0gb\xE8gb\xE8 IPv6`, base64: `\u1ECD\u0300r\u1ECD\u0300 t\xED a k\u1ECD\u0301 n\xED base64`, base64url: `\u1ECD\u0300r\u1ECD\u0300 base64url`, json_string: `\u1ECD\u0300r\u1ECD\u0300 JSON`, e164: `n\u1ECD\u0301mb\xE0 E.164`, credit_card: `n\u1ECDmba kaadi gbese`, jwt: `JWT`, template_literal: `\u1EB9\u0300r\u1ECD \xECb\xE1w\u1ECDl\xE9` }, r2 = { nan: `NaN`, number: `n\u1ECD\u0301mb\xE0`, array: `akop\u1ECD` };
  return (e10) => {
    switch (e10.code) {
      case `invalid_type`: {
        let t5 = r2[e10.expected] ?? e10.expected, n4 = D(e10.input), i3 = r2[n4] ?? n4;
        return /^[A-Z]/.test(e10.expected) ? `\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e: a n\xED l\xE1ti fi instanceof ${e10.expected}, \xE0m\u1ECD\u0300 a r\xED ${i3}` : `\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e: a n\xED l\xE1ti fi ${t5}, \xE0m\u1ECD\u0300 a r\xED ${i3}`;
      }
      case `invalid_value`:
        return e10.values.length === 1 ? `\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e: a n\xED l\xE1ti fi ${C(e10.values[0])}` : `\xC0\u1E63\xE0y\xE0n a\u1E63\xEC\u1E63e: yan \u1ECD\u0300kan l\xE1ra ${l(e10.values, `|`)}`;
      case `too_big`: {
        let n4 = e10.inclusive ? `<=` : `<`, r3 = t4(e10.origin);
        return r3 ? `T\xF3 p\u1ECD\u0300 j\xF9: a n\xED l\xE1ti j\u1EB9\u0301 p\xE9 ${e10.origin ?? `iye`} ${r3.verb} ${n4}${e10.maximum} ${r3.unit}` : `T\xF3 p\u1ECD\u0300 j\xF9: a n\xED l\xE1ti j\u1EB9\u0301 ${n4}${e10.maximum}`;
      }
      case `too_small`: {
        let n4 = e10.inclusive ? `>=` : `>`, r3 = t4(e10.origin);
        return r3 ? `K\xE9r\xE9 ju: a n\xED l\xE1ti j\u1EB9\u0301 p\xE9 ${e10.origin} ${r3.verb} ${n4}${e10.minimum} ${r3.unit}` : `K\xE9r\xE9 ju: a n\xED l\xE1ti j\u1EB9\u0301 ${n4}${e10.minimum}`;
      }
      case `invalid_format`: {
        let t5 = e10;
        return t5.format === `starts_with` ? `\u1ECC\u0300r\u1ECD\u0300 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 b\u1EB9\u0300r\u1EB9\u0300 p\u1EB9\u0300l\xFA "${t5.prefix}"` : t5.format === `ends_with` ? `\u1ECC\u0300r\u1ECD\u0300 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 par\xED p\u1EB9\u0300l\xFA "${t5.suffix}"` : t5.format === `includes` ? `\u1ECC\u0300r\u1ECD\u0300 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 n\xED "${t5.includes}"` : t5.format === `regex` ? `\u1ECC\u0300r\u1ECD\u0300 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 b\xE1 \xE0p\u1EB9\u1EB9r\u1EB9 mu ${t5.pattern}` : `A\u1E63\xEC\u1E63e: ${n3[t5.format] ?? e10.format}`;
      }
      case `not_multiple_of`:
        return `N\u1ECD\u0301mb\xE0 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 j\u1EB9\u0301 \xE8y\xE0 p\xEDp\xEDn ti ${e10.divisor}`;
      case `unrecognized_keys`:
        return `B\u1ECDt\xECn\xEC \xE0\xECm\u1ECD\u0300: ${l(e10.keys, `, `)}`;
      case `invalid_key`:
        return `B\u1ECDt\xECn\xEC a\u1E63\xEC\u1E63e n\xEDn\xFA ${e10.origin}`;
      case `invalid_union`:
        return `\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e`;
      case `invalid_element`:
        return `Iye a\u1E63\xEC\u1E63e n\xEDn\xFA ${e10.origin}`;
      default:
        return `\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e`;
    }
  };
};
function wc() {
  return { localeError: Cc() };
}
var Tc = t({ ar: () => ao, az: () => so, be: () => uo, bg: () => po, bn: () => ho, ca: () => _o, ckb: () => yo, cs: () => xo, da: () => Co, de: () => To, el: () => Do, en: () => ko, eo: () => jo, es: () => No, fa: () => Fo, fi: () => Lo, fr: () => zo, frCA: () => Vo, gu: () => Uo, he: () => Go, hi: () => qo, hr: () => Yo, hu: () => Zo, hy: () => ts, id: () => rs, is: () => as, it: () => ss, ja: () => ls, ka: () => ds, kh: () => ms, km: () => ps, kn: () => gs, ko: () => vs, lt: () => Ss, mk: () => ws, ms: () => Es, ne: () => Os, nl: () => As, nn: () => Ms, no: () => Ps, ota: () => Is, pl: () => Bs, ps: () => Rs, pt: () => Hs, ptBR: () => Ws, ro: () => Ks, ru: () => Ys, sk: () => Zs, sl: () => $s, sv: () => tc, ta: () => rc, th: () => ac, tk: () => sc, tr: () => lc, ua: () => fc, uk: () => dc, ur: () => mc, uz: () => gc, vi: () => vc, yo: () => wc, zhCN: () => bc, zhTW: () => Sc });
var Ec;
var Dc = /* @__PURE__ */ Symbol(`ZodOutput`);
var Oc = /* @__PURE__ */ Symbol(`ZodInput`);
var kc = class {
  constructor() {
    this._map = /* @__PURE__ */ new WeakMap(), this._idmap = /* @__PURE__ */ new Map();
  }
  add(e9, ...t4) {
    let n3 = t4[0];
    return this._map.set(e9, n3), n3 && typeof n3 == `object` && `id` in n3 && this._idmap.set(n3.id, e9), this;
  }
  clear() {
    return this._map = /* @__PURE__ */ new WeakMap(), this._idmap = /* @__PURE__ */ new Map(), this;
  }
  remove(e9) {
    let t4 = this._map.get(e9);
    return t4 && typeof t4 == `object` && `id` in t4 && this._idmap.delete(t4.id), this._map.delete(e9), this;
  }
  get(e9) {
    let t4 = e9._zod.parent;
    if (t4) {
      let n3 = { ...this.get(t4) ?? {} };
      delete n3.id;
      let r2 = { ...n3, ...this._map.get(e9) };
      return Object.keys(r2).length ? r2 : void 0;
    }
    return this._map.get(e9);
  }
  has(e9) {
    return this._map.has(e9);
  }
};
function Ac() {
  return new kc();
}
(Ec = globalThis).__zod_globalRegistry ?? (Ec.__zod_globalRegistry = Ac());
var L = globalThis.__zod_globalRegistry;
var R = /* @__PURE__ */ Symbol.for(`zod.compile.invalid`);
var jc = /* @__PURE__ */ Symbol.for(`zod.compile.fallback`);
var z = class extends Error {
  constructor(e9 = `z.compile does not support async refinements, transforms, or checks`) {
    super(e9), this.name = `ZodCompileAsyncError`;
  }
};
var B = class extends Error {
  constructor(e9, t4 = true) {
    super(`z.compile does not support ${e9}; this schema must use the runtime parser`), this.name = `ZodCompileUnsupportedError`, this.islandable = t4;
  }
};
function Mc(e9, t4) {
  try {
    return Fc(e9, { assertOnly: true });
  } catch {
    return t4;
  }
}
function Nc(e9, t4) {
  try {
    let t5 = Fc(e9), n3 = x(e9), r2 = e9._zod.run, i3 = r2.__originalRun ?? r2, a3 = (e10, n4) => {
      if (n4?.async || n4?.direction === `backward` || n4?.skipChecks || n4?.[jc] || n4 && ro(n4, e10.value)) return i3(e10, n4);
      let r3 = t5(e10.value);
      return r3 === R ? (n4 && (n4[jc] = true), i3(e10, n4)) : (e10.value = r3, e10);
    };
    return a3.__originalRun = i3, n3._zod.bag.fallbackRun = i3, n3._zod.bag.validator = Mc(e9, t5), n3._zod.run = a3, r2.__originalRun || Pc(n3, e9, t5), n3;
  } catch (n3) {
    if (t4?.strict) throw n3;
    return e9;
  }
}
function Pc(e9, t4, n3) {
  let r2 = e9, i3 = t4;
  if (typeof i3.safeParse == `function`) {
    let e10 = i3.safeParse;
    r2.safeParse = (t5, r3) => {
      let i4 = n3(t5);
      return i4 === R ? e10(t5, r3) : { success: true, data: i4 };
    };
  }
  if (typeof i3.parse == `function`) {
    let e10 = i3.parse;
    r2.parse = (t5, r3) => {
      let i4 = n3(t5);
      return i4 === R ? e10(t5, r3) : i4;
    };
  }
}
function Fc(e9, t4) {
  let n3 = true;
  try {
    n3 = Za(e9);
  } catch {
  }
  if (n3) throw new B(`a schema whose subtree contains a reference cycle`);
  let r2 = { constants: /* @__PURE__ */ new Map(), constantCounter: 0, varCounter: 0 }, i3 = new Fr([`input`]), a3 = G(i3, r2, e9, `input`, !t4?.assertOnly);
  i3.write(a3 === null ? `return true;` : `return ${a3};`);
  let o3 = [`INVALID`, ...r2.constants.keys()], s3 = [R, ...r2.constants.values()], c3 = i3.content.join(`
`), l3 = t4?.debug ? o3.length > 0 ? `// Constants: ${o3.join(`, `)}
${c3}` : c3 : ``, u3 = Function, d3 = `return (input) => {
${c3}
}`, f3;
  try {
    f3 = new u3(...o3, d3)(...s3);
  } catch (e10) {
    throw new B(`this schema (generated code failed to evaluate: ${e10.message})`);
  }
  return t4?.debug && (f3.code = l3), f3;
}
function V(e9, t4) {
  for (let [n4, r2] of e9.constants) if (r2 === t4) return n4;
  let n3 = `c${e9.constantCounter++}`;
  return e9.constants.set(n3, t4), n3;
}
function H(e9) {
  return `v${e9.varCounter++}`;
}
function Ic(e9, t4) {
  let n3 = e9._zod.run({ value: t4, issues: [] }, {});
  if (n3 && typeof n3.then == `function`) return R;
  let r2 = n3;
  return r2.issues.length === 0 ? r2.value : R;
}
function U(e9, t4, n3, r2, i3 = true) {
  let a3 = e9.content.length, o3 = t4.constants.size, s3 = t4.constantCounter, c3 = t4.varCounter;
  try {
    return G(e9, t4, n3, r2, i3);
  } catch (i4) {
    if (!(i4 instanceof B) || !i4.islandable) throw i4;
    if (e9.content.length = a3, t4.constants.size > o3) {
      let e10 = Array.from(t4.constants.keys()).slice(o3);
      for (let n4 of e10) t4.constants.delete(n4);
    }
    return t4.constantCounter = s3, t4.varCounter = c3, Lc(e9, t4, n3, r2);
  }
}
function Lc(e9, t4, n3, r2) {
  let i3 = V(t4, n3), a3 = V(t4, Ic), o3 = H(t4);
  return e9.write(`const ${o3} = ${a3}(${i3}, ${r2});`), e9.write(`if (${o3} === INVALID) return INVALID;`), o3;
}
var Rc = /* @__PURE__ */ new Set([`max_size`, `min_size`, `size_equals`, `max_length`, `min_length`, `length_equals`]);
function zc(e9, t4, n3, r2) {
  let i3 = n3._zod.def.checks;
  if (!i3 || i3.length === 0) return r2;
  let a3 = r2;
  for (let n4 of i3) {
    let r3 = n4._zod.def;
    if (r3.when && !Rc.has(r3.check)) throw new B(`check with a custom "when" condition`);
    switch (r3.check) {
      case `greater_than`:
        Hc(e9, t4, r3, a3);
        break;
      case `less_than`:
        Uc(e9, t4, r3, a3);
        break;
      case `multiple_of`:
        Wc(e9, t4, r3, a3);
        break;
      case `number_format`:
        Gc(e9, r3, a3);
        break;
      case `min_length`: {
        let n5 = W(r3.minimum, `min_length`), i4 = Bc(e9, t4, a3, `${a3}.length >= ${n5} && ${a3}.length < ${r3.minimum * 2}`);
        e9.write(`if (${i4} < ${n5}) return INVALID;`);
        break;
      }
      case `max_length`: {
        let n5 = W(r3.maximum, `max_length`), i4 = Bc(e9, t4, a3, `${a3}.length > ${n5}`);
        e9.write(`if (${i4} > ${n5}) return INVALID;`);
        break;
      }
      case `length_equals`: {
        let n5 = W(r3.length, `length_equals`), i4 = Bc(e9, t4, a3, `${a3}.length >= ${n5} && ${a3}.length <= ${r3.length * 2}`);
        e9.write(`if (${i4} !== ${n5}) return INVALID;`);
        break;
      }
      case `min_size`:
        e9.write(`if (${a3}.size < ${W(r3.minimum, `min_size`)}) return INVALID;`);
        break;
      case `max_size`:
        e9.write(`if (${a3}.size > ${W(r3.maximum, `max_size`)}) return INVALID;`);
        break;
      case `size_equals`:
        e9.write(`if (${a3}.size !== ${W(r3.size, `size_equals`)}) return INVALID;`);
        break;
      case `string_format`:
        a3 = el(e9, t4, r3, a3);
        break;
      case `custom`:
        a3 = Qc(e9, t4, n4, a3);
        break;
      case `bigint_format`:
        Kc(e9, r3, a3);
        break;
      case `mime_type`:
        qc(e9, t4, r3, a3);
        break;
      case `property`:
        Jc(e9, t4, r3, a3);
        break;
      case `overwrite`: {
        let r4 = H(t4);
        Yc(e9, t4, n4, a3, r4), a3 = r4;
        break;
      }
      default:
        throw new B(`check type ${r3.check}`);
    }
  }
  return a3;
}
function Bc(e9, t4, n3, r2) {
  let i3 = V(t4, je), a3 = H(t4);
  return e9.write(`const ${a3} = typeof ${n3} === "string" && ${r2} ? ${i3}(${n3}) : ${n3}.length;`), a3;
}
function W(e9, t4) {
  if (typeof e9 != `number` || !Number.isFinite(e9)) throw new B(`${t4} bound of type ${typeof e9}`);
  return `${e9}`;
}
function Vc(e9, t4) {
  if (typeof t4 == `bigint`) return `${t4}n`;
  if (typeof t4 == `number`) {
    if (Number.isNaN(t4)) throw new B(`comparison check with NaN bound`);
    return `${t4}`;
  }
  if (t4 instanceof Date) {
    if (Number.isNaN(t4.getTime())) throw new B(`comparison check with Invalid Date bound`);
    return V(e9, t4);
  }
  throw new B(`comparison check bound of type ${typeof t4}`);
}
function Hc(e9, t4, n3, r2) {
  let i3 = n3.inclusive ? `<` : `<=`;
  e9.write(`if (${r2} ${i3} ${Vc(t4, n3.value)}) return INVALID;`);
}
function Uc(e9, t4, n3, r2) {
  let i3 = n3.inclusive ? `>` : `>=`;
  e9.write(`if (${r2} ${i3} ${Vc(t4, n3.value)}) return INVALID;`);
}
function Wc(e9, t4, n3, r2) {
  if (typeof n3.value == `bigint`) {
    if (n3.value === BigInt(0)) throw new B(`multiple_of check with a zero divisor`);
    e9.write(`if (${r2} % ${n3.value}n !== 0n) return INVALID;`);
  } else {
    let i3 = V(t4, m);
    e9.write(`if (${i3}(${r2}, ${W(n3.value, `multiple_of`)}) !== 0) return INVALID;`);
  }
}
function Gc(e9, t4, n3) {
  let r2 = t4.format;
  switch (r2) {
    case `safeint`:
      e9.write(`if (!Number.isSafeInteger(${n3})) return INVALID;`);
      break;
    case `int32`:
      e9.write(`if (!Number.isInteger(${n3}) || ${n3} < -2147483648 || ${n3} > 2147483647) return INVALID;`);
      break;
    case `uint32`:
      e9.write(`if (!Number.isInteger(${n3}) || ${n3} < 0 || ${n3} > 4294967295) return INVALID;`);
      break;
    case `float32`:
      e9.write(`if (!Number.isFinite(${n3}) || ${n3} < -3.4028234663852886e38 || ${n3} > 3.4028234663852886e38) return INVALID;`);
      break;
    case `float64`:
      e9.write(`if (!Number.isFinite(${n3})) return INVALID;`);
      break;
    default:
      throw new B(`number format ${r2}`);
  }
}
function Kc(e9, t4, n3) {
  let r2 = t4.format;
  if (r2) switch (r2) {
    case `int64`:
      e9.write(`if (${n3} < -9223372036854775808n || ${n3} > 9223372036854775807n) return INVALID;`);
      break;
    case `uint64`:
      e9.write(`if (${n3} < 0n || ${n3} > 18446744073709551615n) return INVALID;`);
      break;
    default:
      throw new B(`bigint format ${r2}`);
  }
}
function qc(e9, t4, n3, r2) {
  let i3 = n3.mime;
  if (i3 && i3.length > 0) {
    let n4 = V(t4, new Set(i3));
    e9.write(`if (!${n4}.has(${r2}.type)) return INVALID;`);
  }
}
function Jc(e9, t4, n3, r2) {
  let i3 = `${r2}[${JSON.stringify(n3.property)}]`;
  G(e9, t4, n3.schema, i3);
}
function Yc(e9, t4, n3, r2, i3) {
  let a3 = n3._zod.def.tx;
  if (!a3) throw new B(`overwrite check without a transform function`);
  if (J(a3)) throw new z(`z.compile: async overwrite transforms are not supported`);
  let o3 = V(t4, a3);
  e9.write(`const ${i3} = ${o3}(${r2});`);
}
function Xc() {
  throw new A();
}
function Zc(e9) {
  this.issues.push(e9);
}
function Qc(e9, t4, n3, r2) {
  let i3 = n3._zod.def;
  if (i3.fn) {
    if (J(i3.fn)) throw new z(`z.compile: async .refine() predicates are not supported`);
    let n4 = V(t4, i3.fn), a3 = V(t4, Xc), o3 = H(t4);
    return e9.write(`const ${o3} = ${n4}(${r2});`), e9.write(`if (${o3} instanceof Promise) ${a3}();`), e9.write(`if (!${o3}) return INVALID;`), r2;
  }
  if (n3._zod.check) {
    if (J(n3._zod.check)) throw new z(`z.compile: async .superRefine() / check functions are not supported`);
    let i4 = n3._zod.check, a3 = V(t4, (e10) => {
      let t5 = { value: e10, issues: [], addIssue: Zc };
      return i4(t5) instanceof Promise && Xc(), t5.issues.length === 0 ? t5.value : R;
    }), o3 = H(t4);
    return e9.write(`const ${o3} = ${a3}(${r2});`), e9.write(`if (${o3} === INVALID) return INVALID;`), o3;
  }
  throw new B(`custom check without a predicate or check function`);
}
var $c = /* @__PURE__ */ new Set([`cidrv4`, `cuid`, `cuid2`, `date`, `datetime`, `duration`, `e164`, `email`, `emoji`, `ends_with`, `guid`, `includes`, `ipv4`, `ksuid`, `lowercase`, `mac`, `nanoid`, `regex`, `starts_with`, `time`, `ulid`, `uppercase`, `uuid`, `xid`]);
function el(e9, t4, n3, r2) {
  let i3 = n3.format;
  if (i3 === `base64`) {
    let n4 = V(t4, gi);
    return e9.write(`if (!${n4}(${r2})) return INVALID;`), r2;
  }
  if (i3 === `base64url`) {
    let n4 = V(t4, vi);
    return e9.write(`if (!${n4}(${r2})) return INVALID;`), r2;
  }
  if (i3 === `jwt`) {
    let i4 = V(t4, Ti), a4 = V(t4, n3.alg ?? null);
    return e9.write(`if (!${i4}(${r2}, ${a4})) return INVALID;`), r2;
  }
  if (i3 === `ipv6`) {
    let n4 = V(t4, ui);
    return e9.write(`if (!${n4}(${r2})) return INVALID;`), r2;
  }
  if (i3 === `cidrv6`) {
    let n4 = V(t4, mi);
    return e9.write(`if (!${n4}(${r2})) return INVALID;`), r2;
  }
  if (i3 === `credit_card`) {
    let n4 = V(t4, Ci);
    return e9.write(`if (!${n4}(${r2})) return INVALID;`), r2;
  }
  let a3 = n3;
  if (i3 === `url` || i3 === `httpurl` || a3.normalize || a3.hostname !== void 0 || a3.protocol !== void 0) {
    let i4 = V(t4, Gr), o4 = V(t4, n3), s4 = H(t4), c3 = H(t4);
    if (e9.write(`const ${s4} = ${r2}.trim();`), e9.write(`const ${c3} = ${i4}(${s4}, ${o4});`), e9.write(`if (typeof ${c3} === "number") return INVALID;`), a3.hostname !== void 0) {
      let n4 = V(t4, Jr);
      e9.write(`if (!${n4}(${c3}, ${o4}.hostname)) return INVALID;`);
    }
    if (a3.protocol !== void 0) {
      let n4 = V(t4, Yr);
      e9.write(`if (!${n4}(${c3}, ${o4}.protocol)) return INVALID;`);
    }
    let l3 = H(t4), u3 = a3.normalize ? `${c3}.href` : `${V(t4, qr)}(${s4})`;
    return e9.write(`const ${l3} = ${u3};`), l3;
  }
  let o3 = n3.fn;
  if (o3) {
    if (J(o3)) throw new B(`async string format ${i3}`);
    let n4 = V(t4, o3);
    return e9.write(`if (!${n4}(${r2})) return INVALID;`), r2;
  }
  if ($c.has(i3) && n3.pattern) {
    let i4 = V(t4, n3.pattern);
    return e9.write(`${i4}.lastIndex = 0;`), e9.write(`if (!${i4}.test(${r2})) return INVALID;`), r2;
  }
  let s3 = n3.format;
  switch (s3) {
    case `regex`:
      throw new B(`regex format without a pattern`);
    case `lowercase`:
      e9.write(`if (${r2} !== ${r2}.toLowerCase()) return INVALID;`);
      break;
    case `uppercase`:
      e9.write(`if (${r2} !== ${r2}.toUpperCase()) return INVALID;`);
      break;
    case `includes`:
      e9.write(`if (!${r2}.includes(${v(n3.includes)})) return INVALID;`);
      break;
    case `starts_with`: {
      let t5 = n3.prefix;
      e9.write(`if (${r2}.slice(0, ${t5.length}) !== ${v(t5)}) return INVALID;`);
      break;
    }
    case `ends_with`: {
      let t5 = n3.suffix;
      e9.write(`if (${r2}.slice(-${t5.length}) !== ${v(t5)}) return INVALID;`);
      break;
    }
    default:
      throw new B(`string format ${s3}`);
  }
  return r2;
}
function G(e9, t4, n3, r2, i3 = true) {
  let a3 = n3._zod.def, o3 = a3.type;
  if (a3.coerce) throw new B(`coercion (z.coerce.${o3}())`);
  let s3 = i3 || !!a3.checks?.length, c3;
  switch (o3) {
    case `string`:
      c3 = tl(e9, t4, n3, r2);
      break;
    case `number`:
      c3 = nl(e9, n3, r2);
      break;
    case `boolean`:
      c3 = rl(e9, r2);
      break;
    case `bigint`:
      c3 = il(e9, n3, r2);
      break;
    case `symbol`:
      c3 = al(e9, r2);
      break;
    case `undefined`:
      c3 = ol(e9, r2);
      break;
    case `null`:
      c3 = sl(e9, r2);
      break;
    case `any`:
    case `unknown`:
      c3 = r2;
      break;
    case `never`:
      e9.write(`return INVALID;`), c3 = r2;
      break;
    case `void`:
      c3 = cl(e9, r2);
      break;
    case `nan`:
      c3 = ll(e9, r2);
      break;
    case `date`:
      c3 = ul(e9, r2);
      break;
    case `object`:
      c3 = dl(e9, t4, n3, r2, s3);
      break;
    case `optional`:
      c3 = fl(e9, t4, n3, r2, s3);
      break;
    case `nullable`:
      c3 = gl(e9, t4, n3, r2, s3);
      break;
    case `array`:
      c3 = _l(e9, t4, n3, r2, s3);
      break;
    case `literal`:
      c3 = vl(e9, t4, n3, r2);
      break;
    case `enum`:
      c3 = yl(e9, t4, n3, r2);
      break;
    case `readonly`: {
      let i4 = bl(e9, t4, n3, r2), a4 = H(t4);
      e9.write(`const ${a4} = Object.freeze(${i4});`), c3 = a4;
      break;
    }
    case `success`:
      bl(e9, t4, n3, r2), c3 = `true`;
      break;
    case `default`:
    case `prefault`:
      c3 = xl(e9, t4, n3, r2);
      break;
    case `nonoptional`:
      c3 = Sl(e9, t4, n3, r2);
      break;
    case `tuple`:
      c3 = Cl(e9, t4, n3, r2);
      break;
    case `union`:
      c3 = Tl(e9, t4, n3, r2);
      break;
    case `intersection`:
      c3 = Ol(e9, t4, n3, r2);
      break;
    case `record`:
      c3 = kl(e9, t4, n3, r2);
      break;
    case `map`:
      c3 = jl(e9, t4, n3, r2);
      break;
    case `set`:
      c3 = Ml(e9, t4, n3, r2);
      break;
    case `file`:
      c3 = Nl(e9, r2);
      break;
    case `template_literal`:
      c3 = Pl(e9, t4, n3, r2);
      break;
    case `lazy`:
      c3 = Fl(e9, t4, n3, r2);
      break;
    case `pipe`:
      c3 = Il(e9, t4, n3, r2);
      break;
    case `custom`:
      c3 = Ll(e9, t4, n3, r2);
      break;
    case `transform`:
      c3 = Bl(e9, t4, n3, r2);
      break;
    case `catch`:
      c3 = zl(e9, t4, n3, r2);
      break;
    default:
      throw new B(`schema type ${o3}`);
  }
  return c3 === null ? null : zc(e9, t4, n3, c3);
}
function tl(e9, t4, n3, r2) {
  e9.write(`if (typeof ${r2} !== "string") return INVALID;`);
  let i3 = n3._zod.def;
  return i3.format === void 0 ? r2 : el(e9, t4, i3, r2);
}
function nl(e9, t4, n3) {
  e9.write(`if (typeof ${n3} !== "number" || !Number.isFinite(${n3})) return INVALID;`);
  let r2 = t4._zod.def;
  return r2.check === `number_format` && r2.format && Gc(e9, { format: r2.format }, n3), n3;
}
function rl(e9, t4) {
  return e9.write(`if (typeof ${t4} !== "boolean") return INVALID;`), t4;
}
function il(e9, t4, n3) {
  e9.write(`if (typeof ${n3} !== "bigint") return INVALID;`);
  let r2 = t4._zod.def;
  if (r2.format) switch (r2.format) {
    case `int64`:
      e9.write(`if (${n3} < -9223372036854775808n || ${n3} > 9223372036854775807n) return INVALID;`);
      break;
    case `uint64`:
      e9.write(`if (${n3} < 0n || ${n3} > 18446744073709551615n) return INVALID;`);
  }
  return n3;
}
function al(e9, t4) {
  return e9.write(`if (typeof ${t4} !== "symbol") return INVALID;`), t4;
}
function ol(e9, t4) {
  return e9.write(`if (${t4} !== undefined) return INVALID;`), t4;
}
function sl(e9, t4) {
  return e9.write(`if (${t4} !== null) return INVALID;`), t4;
}
function cl(e9, t4) {
  return e9.write(`if (${t4} !== undefined) return INVALID;`), t4;
}
function ll(e9, t4) {
  return e9.write(`if (typeof ${t4} !== "number" || !Number.isNaN(${t4})) return INVALID;`), t4;
}
function ul(e9, t4) {
  return e9.write(`if (!(${t4} instanceof Date) || Number.isNaN(${t4}.getTime())) return INVALID;`), t4;
}
function dl(e9, t4, n3, r2, i3 = true) {
  let a3 = n3._zod.def;
  e9.write(`if (typeof ${r2} !== "object" || ${r2} === null || Array.isArray(${r2})) return INVALID;`);
  let o3 = a3.shape, s3 = Object.keys(o3), c3 = Object.getOwnPropertySymbols(o3), l3 = c3.length ? [...s3, ...c3] : s3, u3 = (e10) => typeof e10 == `symbol` ? V(t4, e10) : v(e10), d3 = (e10) => typeof e10 == `symbol` ? `[${u3(e10)}]` : v(e10), f3 = o3;
  if (s3.includes(`__proto__`)) throw new B(`object shape key "__proto__"`);
  let p3 = /* @__PURE__ */ new Map();
  for (let n4 of l3) {
    let a4 = f3[n4], o4 = u3(n4), s4 = H(t4);
    if (e9.write(`const ${s4} = ${r2}[${o4}];`), a4._zod.optin !== void 0) {
      let i4 = H(t4);
      e9.write(`let ${i4} = (() => {`), e9.indented((e10) => {
        let n5 = U(e10, t4, a4, s4);
        e10.write(`return ${n5};`);
      }), e9.write(`})();`), a4._zod.optout === `optional` ? (e9.write(`if (${i4} === INVALID) {`), e9.indented((e10) => {
        e10.write(`if (${o4} in ${r2}) return INVALID;`), e10.write(`${i4} = undefined;`);
      }), e9.write(`}`)) : e9.write(`if (${i4} === INVALID) return INVALID;`), p3.set(n4, i4);
    } else {
      ml(a4) && e9.write(`if (!(${o4} in ${r2})) return INVALID;`);
      let c4 = U(e9, t4, a4, s4, i3);
      c4 !== null && p3.set(n4, c4);
    }
  }
  let m3 = a3.catchall, ee3 = `none`;
  if (m3) {
    let t5 = m3._zod.def.type;
    if (t5 === `never`) {
      let t6 = s3.map((e10) => `k !== ${v(e10)}`).join(` && `) || `true`;
      e9.write(`for (const k in ${r2}) {`), e9.indented((e10) => {
        e10.write(`if (${t6}) return INVALID;`);
      }), e9.write(`}`);
    } else ee3 = (t5 === `unknown` || t5 === `any`) && !m3._zod.def.checks?.length ? `passthrough` : `schema`;
  }
  let h3 = H(t4), te3 = l3.some((e10) => q(f3[e10]) || hl(f3[e10]));
  if (!i3) {
    if (ee3 === `schema`) {
      let n4 = s3.length > 0 ? V(t4, new Set(s3)) : null;
      e9.write(`for (const k in ${r2}) {`), e9.indented((e10) => {
        e10.write(`if (k === "__proto__") continue;`), n4 && e10.write(`if (${n4}.has(k)) continue;`);
        let i4 = H(t4);
        e10.write(`const ${i4} = ${r2}[k];`), U(e10, t4, m3, i4, false);
      }), e9.write(`}`);
    }
    return null;
  }
  if (te3) {
    e9.write(`const ${h3} = {};`);
    for (let t5 of l3) {
      let n4 = u3(t5), i4 = p3.get(t5);
      hl(f3[t5]) ? e9.write(`if (${n4} in ${r2}) ${h3}[${n4}] = ${i4};`) : q(f3[t5]) ? e9.write(`if (${i4} !== undefined || ${n4} in ${r2}) ${h3}[${n4}] = ${i4};`) : e9.write(`${h3}[${n4}] = ${i4};`);
    }
  } else {
    let t5 = l3.map((e10) => `${d3(e10)}: ${p3.get(e10)}`).join(`, `);
    e9.write(`const ${h3} = { ${t5} };`);
  }
  if (ee3 !== `none`) {
    let n4 = s3.length > 0 ? V(t4, new Set(s3)) : null;
    e9.write(`for (const k in ${r2}) {`), e9.indented((e10) => {
      if (e10.write(`if (k === "__proto__") continue;`), n4 && e10.write(`if (${n4}.has(k)) continue;`), ee3 === `passthrough`) e10.write(`${h3}[k] = ${r2}[k];`);
      else {
        let n5 = H(t4);
        e10.write(`const ${n5} = ${r2}[k];`);
        let i4 = U(e10, t4, m3, n5);
        e10.write(`${h3}[k] = ${i4};`);
      }
    }), e9.write(`}`);
  }
  return h3;
}
function fl(e9, t4, n3, r2, i3 = true) {
  let a3 = n3._zod.def;
  if (pl(n3)) return G(e9, t4, a3.innerType, r2, i3);
  if (a3.innerType._zod.optin === `defaulted`) {
    let n4 = H(t4), i4 = H(t4);
    return e9.write(`let ${n4};`), e9.write(`if (${r2} === undefined) {`), e9.indented((e10) => {
      e10.write(`const ${i4} = (() => {`), e10.indented((e11) => {
        let n5 = G(e11, t4, a3.innerType, r2);
        e11.write(`return ${n5};`);
      }), e10.write(`})();`), e10.write(`if (${i4} !== INVALID) ${n4} = ${i4};`);
    }), e9.write(`} else {`), e9.indented((e10) => {
      let i5 = G(e10, t4, a3.innerType, r2);
      e10.write(`${n4} = ${i5};`);
    }), e9.write(`}`), n4;
  }
  let o3 = i3 ? H(t4) : null;
  return o3 && e9.write(`let ${o3};`), e9.write(`if (${r2} !== undefined) {`), e9.indented((e10) => {
    let n4 = G(e10, t4, a3.innerType, r2, i3);
    o3 && n4 !== null && e10.write(`${o3} = ${n4};`);
  }), e9.write(`}`), o3;
}
function pl(e9) {
  return e9._zod.traits?.has(`$ZodExactOptional`) === true;
}
function ml(e9) {
  return e9._zod.optin === void 0 && K(e9);
}
function K(e9) {
  if (e9._zod.def.coerce) return true;
  let t4 = e9._zod.def;
  switch (t4.type) {
    case `any`:
    case `unknown`:
    case `undefined`:
    case `void`:
    case `default`:
    case `prefault`:
    case `transform`:
    case `custom`:
    case `lazy`:
      return true;
    case `string`:
    case `number`:
    case `boolean`:
    case `bigint`:
    case `symbol`:
    case `null`:
    case `never`:
    case `nan`:
    case `date`:
    case `object`:
    case `array`:
    case `tuple`:
    case `record`:
    case `map`:
    case `set`:
    case `file`:
    case `template_literal`:
      return false;
    case `nonoptional`:
      return t4.innerType ? K(t4.innerType) : false;
    case `literal`:
      return !!t4.values?.includes(void 0);
    case `enum`:
      return !!e9._zod.values?.has(void 0);
    case `optional`:
    case `nullable`:
    case `readonly`:
    case `success`:
      return !t4.innerType || K(t4.innerType);
    case `catch`:
      return true;
    case `union`:
      return !t4.options || t4.options.some(K);
    case `intersection`:
      return !t4.left || !t4.right || K(t4.left) && K(t4.right);
    case `pipe`:
      return !t4.in || K(t4.in);
    default:
      return true;
  }
}
function hl(e9) {
  return e9._zod.optin === `optional` && e9._zod.optout === `optional`;
}
function q(e9) {
  let t4 = e9._zod.def;
  switch (t4.type) {
    case `string`:
    case `number`:
    case `boolean`:
    case `bigint`:
    case `symbol`:
    case `null`:
    case `nan`:
    case `date`:
    case `object`:
    case `array`:
    case `tuple`:
    case `record`:
    case `map`:
    case `set`:
    case `file`:
    case `template_literal`:
    case `never`:
    case `success`:
      return false;
    case `literal`:
      return !!t4.values?.includes(void 0);
    case `enum`:
      return !!e9._zod.values?.has(void 0);
    case `optional`:
      return true;
    case `nullable`:
    case `readonly`:
    case `nonoptional`:
      return !t4.innerType || q(t4.innerType);
    case `union`:
      return !t4.options || t4.options.some(q);
    case `intersection`:
      return !t4.left || !t4.right || q(t4.left) || q(t4.right);
    case `pipe`:
      return !t4.out || q(t4.out);
    default:
      return true;
  }
}
function gl(e9, t4, n3, r2, i3 = true) {
  let a3 = n3._zod.def, o3 = i3 ? H(t4) : null;
  return o3 && e9.write(`let ${o3} = null;`), e9.write(`if (${r2} !== null) {`), e9.indented((e10) => {
    let n4 = G(e10, t4, a3.innerType, r2, i3);
    o3 && n4 !== null && e10.write(`${o3} = ${n4};`);
  }), e9.write(`}`), o3;
}
function _l(e9, t4, n3, r2, i3 = true) {
  let a3 = n3._zod.def;
  e9.write(`if (!Array.isArray(${r2})) return INVALID;`);
  let o3 = i3 ? H(t4) : null, s3 = H(t4), c3 = H(t4);
  return o3 && e9.write(`const ${o3} = new Array(${r2}.length);`), e9.write(`for (let ${s3} = 0; ${s3} < ${r2}.length; ${s3}++) {`), e9.indented((e10) => {
    e10.write(`const ${c3} = ${r2}[${s3}];`);
    let n4 = U(e10, t4, a3.element, c3, i3);
    o3 && n4 !== null && e10.write(`${o3}[${s3}] = ${n4};`);
  }), e9.write(`}`), o3;
}
function vl(e9, t4, n3, r2) {
  let i3 = n3._zod.def.values;
  if (i3.length !== 1) {
    let n4 = V(t4, new Set(i3));
    return e9.write(`if (!${n4}.has(${r2})) return INVALID;`), r2;
  }
  let a3 = i3[0];
  if (typeof a3 == `number` && Number.isNaN(a3)) {
    let n4 = V(t4, new Set(i3));
    return e9.write(`if (!${n4}.has(${r2})) return INVALID;`), r2;
  }
  if (typeof a3 == `string`) e9.write(`if (${r2} !== ${v(a3)}) return INVALID;`);
  else if (typeof a3 == `number` || typeof a3 == `boolean`) e9.write(`if (${r2} !== ${a3}) return INVALID;`);
  else if (a3 === null) e9.write(`if (${r2} !== null) return INVALID;`);
  else if (a3 === void 0) e9.write(`if (${r2} !== undefined) return INVALID;`);
  else if (typeof a3 == `bigint`) e9.write(`if (${r2} !== ${a3}n) return INVALID;`);
  else throw new B(`literal type ${typeof a3}`);
  return r2;
}
function yl(e9, t4, n3, r2) {
  let i3 = n3._zod.values;
  if (!i3) throw new B(`enum schema without enumerated values`);
  let a3 = V(t4, i3);
  return e9.write(`if (!${a3}.has(${r2})) return INVALID;`), r2;
}
function bl(e9, t4, n3, r2) {
  let i3 = n3._zod.def;
  return G(e9, t4, i3.innerType, r2);
}
function xl(e9, t4, n3, r2) {
  let i3 = n3._zod.def, a3 = Object.getOwnPropertyDescriptor(n3._zod.def, `defaultValue`) ? () => n3._zod.def.defaultValue : void 0;
  if (n3._zod.def.type === `prefault`) {
    if (!a3) return G(e9, t4, i3.innerType, r2);
    let n4 = V(t4, a3), o4 = H(t4);
    return e9.write(`let ${o4} = ${r2};`), e9.write(`if (${r2} === undefined) ${o4} = ${n4}();`), G(e9, t4, i3.innerType, o4);
  }
  let o3 = H(t4);
  if (a3) {
    let n4 = V(t4, a3), s3 = V(t4, ue);
    e9.write(`let ${o3};`), e9.write(`if (${r2} === undefined) {`), e9.indented((e10) => {
      e10.write(`${o3} = ${s3}(${n4}());`);
    }), e9.write(`} else {`), e9.indented((e10) => {
      let a4 = G(e10, t4, i3.innerType, r2);
      e10.write(`${o3} = ${a4} === undefined ? ${s3}(${n4}()) : ${a4};`);
    }), e9.write(`}`);
  } else e9.write(`let ${o3};`), e9.write(`if (${r2} !== undefined) {`), e9.indented((e10) => {
    let n4 = G(e10, t4, i3.innerType, r2);
    e10.write(`${o3} = ${n4};`);
  }), e9.write(`}`);
  return o3;
}
function Sl(e9, t4, n3, r2) {
  let i3 = n3._zod.def, a3 = G(e9, t4, i3.innerType, r2), o3 = H(t4);
  return e9.write(`const ${o3} = ${a3};`), e9.write(`if (${o3} === undefined) return INVALID;`), o3;
}
function Cl(e9, t4, n3, r2) {
  let i3 = n3._zod.def, a3 = i3.items, o3 = i3.rest;
  e9.write(`if (!Array.isArray(${r2})) return INVALID;`);
  let s3 = wl(a3, `optin`), c3 = wl(a3, `optout`);
  o3 ? e9.write(`if (${r2}.length < ${s3}) return INVALID;`) : e9.write(`if (${r2}.length < ${s3} || ${r2}.length > ${a3.length}) return INVALID;`);
  let l3 = H(t4);
  e9.write(`const ${l3} = [];`);
  for (let n4 = 0; n4 < a3.length; n4++) {
    let i4 = a3[n4];
    if (n4 >= c3) e9.write(`if (${l3}.length === ${n4}) {`), e9.indented((e10) => {
      e10.write(`if (${n4} < ${r2}.length) {`), e10.indented((e11) => {
        let a4 = H(t4);
        e11.write(`const ${a4} = ${r2}[${n4}];`);
        let o4 = U(e11, t4, i4, a4);
        e11.write(`${l3}[${n4}] = ${o4};`);
      }), e10.write(`} else {`), e10.indented((e11) => {
        if (hl(i4)) {
          e11.write(`${l3}.length = ${n4};`);
          return;
        }
        let r3 = H(t4), a4 = H(t4);
        e11.write(`const ${r3} = undefined;`), e11.write(`const ${a4} = (() => {`), e11.indented((e12) => {
          let n5 = U(e12, t4, i4, r3);
          e12.write(`return ${n5};`);
        }), e11.write(`})();`), e11.write(`if (${a4} === INVALID || ${a4} === undefined) ${l3}.length = ${n4};`), e11.write(`else ${l3}[${n4}] = ${a4};`);
      }), e10.write(`}`);
    }), e9.write(`}`);
    else {
      let a4 = H(t4);
      e9.write(`const ${a4} = ${r2}[${n4}];`);
      let o4 = U(e9, t4, i4, a4);
      e9.write(`${l3}[${n4}] = ${o4};`);
    }
  }
  if (o3) {
    let n4 = H(t4), i4 = H(t4);
    e9.write(`for (let ${n4} = ${a3.length}; ${n4} < ${r2}.length; ${n4}++) {`), e9.indented((e10) => {
      e10.write(`const ${i4} = ${r2}[${n4}];`);
      let a4 = U(e10, t4, o3, i4);
      e10.write(`${l3}[${n4}] = ${a4};`);
    }), e9.write(`}`);
  }
  return l3;
}
function wl(e9, t4) {
  for (let n3 = e9.length - 1; n3 >= 0; n3--) if (!(t4 === `optin` ? e9[n3]._zod.optin !== void 0 : e9[n3]._zod.optout === `optional`)) return n3 + 1;
  return 0;
}
function Tl(e9, t4, n3, r2) {
  let i3 = n3._zod.def, a3 = i3.options;
  if (i3.discriminator) return El(e9, t4, i3, r2);
  if (i3.inclusive === false) throw new B(`exclusive unions (z.xor)`);
  if (a3.length === 0) return e9.write(`return INVALID;`), r2;
  if (a3.length === 1) return G(e9, t4, a3[0], r2);
  if (a3.every((e10) => e10._zod.def.type === `literal` && !e10._zod.def.checks?.length)) {
    let n4 = V(t4, new Set(a3.flatMap((e10) => e10._zod.def.values)));
    return e9.write(`if (!${n4}.has(${r2})) return INVALID;`), r2;
  }
  let o3 = H(t4);
  e9.write(`let ${o3};`);
  for (let n4 = 0; n4 < a3.length; n4++) {
    let i4 = a3[n4];
    n4 === 0 ? e9.write(`${o3} = (() => {`) : e9.write(`if (${o3} === INVALID) ${o3} = (() => {`), e9.indented((e10) => {
      let n5 = G(e10, t4, i4, r2);
      e10.write(`return ${n5};`);
    }), e9.write(`})();`);
  }
  return e9.write(`if (${o3} === INVALID) return INVALID;`), o3;
}
function El(e9, t4, n3, r2) {
  if (n3.unionFallback) throw new B(`discriminated union with unionFallback`);
  if (n3.options.length === 0) return e9.write(`return INVALID;`), r2;
  let i3 = H(t4), a3 = H(t4);
  e9.write(`const ${i3} = ${r2}?.[${v(n3.discriminator)}];`), e9.write(`let ${a3};`);
  let o3 = true, s3 = /* @__PURE__ */ new Set();
  for (let c3 of n3.options) {
    let l3 = c3._zod.propValues?.[n3.discriminator];
    if (!l3 || l3.size === 0) throw new B(`discriminated union option without static discriminator values`);
    for (let e10 of l3) {
      if (s3.has(e10)) throw new B(`duplicate discriminator value ${String(e10)}`);
      s3.add(e10);
    }
    let u3 = Array.from(l3, (e10) => Dl(t4, i3, e10)), d3 = o3 ? `if` : `else if`;
    e9.write(`${d3} (${u3.join(` || `)}) {`), e9.indented((e10) => {
      let n4 = G(e10, t4, c3, r2);
      e10.write(`${a3} = ${n4};`);
    }), e9.write(`}`), o3 = false;
  }
  return e9.write(`else { return INVALID; }`), a3;
}
function Dl(e9, t4, n3) {
  if (typeof n3 == `string`) return `${t4} === ${v(n3)}`;
  if (typeof n3 == `number`) return Number.isNaN(n3) ? `Number.isNaN(${t4})` : `${t4} === ${n3}`;
  if (typeof n3 == `boolean`) return `${t4} === ${n3}`;
  if (n3 === null) return `${t4} === null`;
  if (n3 === void 0) return `${t4} === undefined`;
  if (typeof n3 == `bigint`) return `${t4} === ${n3}n`;
  if (typeof n3 == `symbol`) return `${t4} === ${V(e9, n3)}`;
  throw new B(`literal discriminator value ${String(n3)}`);
}
function Ol(e9, t4, n3, r2) {
  let i3 = n3._zod.def, a3 = U(e9, t4, i3.left, r2), o3 = U(e9, t4, i3.right, r2), s3 = V(t4, ra), c3 = H(t4);
  return e9.write(`const ${c3} = ${s3}(${a3}, ${o3});`), e9.write(`if (!${c3}.valid) return INVALID;`), `${c3}.data`;
}
function kl(e9, t4, n3, r2) {
  let i3 = n3._zod.def, a3 = V(t4, y);
  e9.write(`if (!${a3}(${r2})) return INVALID;`);
  let o3 = H(t4), s3 = H(t4), c3 = H(t4);
  e9.write(`const ${o3} = {};`);
  let l3 = i3, u3 = l3.partial ? void 0 : i3.keyType._zod.values;
  if (u3) {
    let n4 = [];
    for (let a5 of u3) {
      if (typeof a5 != `string` && typeof a5 != `number` && typeof a5 != `symbol`) throw new B(`record key value ${String(a5)}`);
      let s4 = typeof a5 == `number` ? a5.toString() : a5;
      if (s4 === `__proto__`) throw new B(`record key "__proto__"`);
      n4.push(s4);
      let c4 = V(t4, a5), l4 = G(e9, t4, i3.keyType, c4), u4 = H(t4);
      e9.write(`const ${u4} = ${r2}[${Al(t4, s4)}];`);
      let d4 = U(e9, t4, i3.valueType, u4);
      e9.write(`${o3}[${l4}] = ${d4};`);
    }
    let a4 = V(t4, new Set(n4));
    return e9.write(`for (const ${s3} in ${r2}) {`), e9.indented((e10) => {
      e10.write(`if (${a4}.has(${s3})) continue;`), l3.mode === `loose` ? e10.write(`if (${s3} !== "__proto__") ${o3}[${s3}] = ${r2}[${s3}];`) : e10.write(`return INVALID;`);
    }), e9.write(`}`), o3;
  }
  let d3 = i3.keyType._zod.def;
  if (d3.type !== `string` || d3.format !== void 0 || d3.coerce || (d3.checks?.length ?? 0) !== 0) {
    let n4 = i3.mode === `loose`, a4 = V(t4, Fc(i3.keyType)), c4 = V(t4, Bn), l4 = V(t4, Object.prototype.propertyIsEnumerable), u4 = H(t4);
    return e9.write(`for (const ${s3} of Reflect.ownKeys(${r2})) {`), e9.indented((e10) => {
      e10.write(`if (${s3} === "__proto__") continue;`), e10.write(`if (!${l4}.call(${r2}, ${s3})) continue;`), e10.write(`let ${u4} = ${a4}(${s3});`), e10.write(`if (${u4} === INVALID && typeof ${s3} === "string" && ${c4}.test(${s3})) ${u4} = ${a4}(Number(${s3}));`), n4 ? e10.write(`if (${u4} === INVALID) { ${o3}[${s3}] = ${r2}[${s3}]; continue; }`) : e10.write(`if (${u4} === INVALID) return INVALID;`), e10.write(`if (${u4} === "__proto__") continue;`);
      let d4 = H(t4);
      e10.write(`const ${d4} = ${r2}[${s3}];`);
      let f4 = U(e10, t4, i3.valueType, d4);
      e10.write(`${o3}[${u4}] = ${f4};`);
    }), e9.write(`}`), o3;
  }
  let f3 = V(t4, Object.prototype.propertyIsEnumerable);
  return e9.write(`for (const ${s3} of Reflect.ownKeys(${r2})) {`), e9.indented((e10) => {
    e10.write(`if (${s3} === "__proto__") continue;`), e10.write(`if (!${f3}.call(${r2}, ${s3})) continue;`), e10.write(`if (typeof ${s3} !== "string") return INVALID;`), e10.write(`const ${c3} = ${r2}[${s3}];`);
    let n4 = U(e10, t4, i3.valueType, c3);
    e10.write(`${o3}[${s3}] = ${n4};`);
  }), e9.write(`}`), o3;
}
function Al(e9, t4) {
  return typeof t4 == `string` ? v(t4) : V(e9, t4);
}
function jl(e9, t4, n3, r2) {
  let i3 = n3._zod.def;
  e9.write(`if (!(${r2} instanceof Map)) return INVALID;`);
  let a3 = H(t4), o3 = H(t4), s3 = H(t4);
  return e9.write(`const ${a3} = new Map();`), e9.write(`for (const [${o3}, ${s3}] of ${r2}) {`), e9.indented((e10) => {
    let n4 = G(e10, t4, i3.keyType, o3), r3 = G(e10, t4, i3.valueType, s3);
    e10.write(`${a3}.set(${n4}, ${r3});`);
  }), e9.write(`}`), a3;
}
function Ml(e9, t4, n3, r2) {
  let i3 = n3._zod.def;
  e9.write(`if (!(${r2} instanceof Set)) return INVALID;`);
  let a3 = H(t4), o3 = H(t4);
  return e9.write(`const ${a3} = new Set();`), e9.write(`for (const ${o3} of ${r2}) {`), e9.indented((e10) => {
    let n4 = G(e10, t4, i3.valueType, o3);
    e10.write(`${a3}.add(${n4});`);
  }), e9.write(`}`), a3;
}
function Nl(e9, t4) {
  return e9.write(`if (!(${t4} instanceof File)) return INVALID;`), t4;
}
function Pl(e9, t4, n3, r2) {
  e9.write(`if (typeof ${r2} !== "string") return INVALID;`);
  let i3 = n3._zod.pattern;
  if (i3) {
    let n4 = V(t4, i3);
    e9.write(`${n4}.lastIndex = 0;`), e9.write(`if (!${n4}.test(${r2})) return INVALID;`);
  }
  return r2;
}
function Fl(e9, t4, n3, r2) {
  let i3 = n3._zod.def, a3 = V(t4, i3.getter), o3 = V(t4, { parser: null });
  e9.write(`if (!${o3}.parser) {`), e9.indented((e10) => {
    e10.write(`const inner = ${a3}();`), e10.write(`${o3}.parser = function(input) {`), e10.indented((e11) => {
      e11.write(`const result = inner._zod.run({ value: input, issues: [] }, {});`), e11.write(`return result.issues.length === 0 ? result.value : INVALID;`);
    }), e10.write(`};`);
  }), e9.write(`}`);
  let s3 = H(t4);
  return e9.write(`const ${s3} = ${o3}.parser(${r2});`), e9.write(`if (${s3} === INVALID) return INVALID;`), s3;
}
function Il(e9, t4, n3, r2) {
  let i3 = n3._zod.def, a3 = G(e9, t4, i3.in, r2);
  if (i3.transform) {
    if (J(i3.transform)) throw new z(`z.compile: async transforms in pipes are not supported`);
    let n4 = i3.transform, r3 = V(t4, (e10) => {
      let t5 = { value: e10, issues: [], addIssue: Zc }, r4 = n4(e10, t5);
      return r4 instanceof Promise ? R : t5.issues.length === 0 ? r4 : R;
    }), o3 = H(t4);
    return e9.write(`const ${o3} = ${r3}(${a3});`), e9.write(`if (${o3} === INVALID) return INVALID;`), G(e9, t4, i3.out, o3);
  }
  return G(e9, t4, i3.out, a3);
}
function J(e9) {
  return typeof e9 == `function` && (e9.constructor.name === `AsyncFunction` || e9[Symbol.toStringTag] === `AsyncFunction`);
}
function Ll(e9, t4, n3, r2) {
  let i3 = n3._zod.def;
  if (i3.fn) {
    if (J(i3.fn)) throw new z(`z.compile: async custom predicates are not supported`);
    let n4 = V(t4, i3.fn), a3 = V(t4, Xc), o3 = H(t4);
    e9.write(`const ${o3} = ${n4}(${r2});`), e9.write(`if (${o3} instanceof Promise) ${a3}();`), e9.write(`if (!${o3}) return INVALID;`);
  } else throw new B(`custom schema without a predicate function`);
  return r2;
}
function Rl(e9, t4, n3) {
  let r2 = e9._zod.run({ value: n3, issues: [] }, {});
  if (r2 && typeof r2.then == `function`) return R;
  let i3 = r2;
  return i3.issues.length === 0 ? i3.value : t4();
}
function zl(e9, t4, n3, r2) {
  let i3 = n3._zod.def;
  if (!i3.catchValue[`~constantCatch`]) throw new B(`catch with a callback (only a constant catch value compiles)`, false);
  let a3 = H(t4);
  e9.write(`let ${a3} = (() => {`), e9.indented((e10) => {
    let n4 = U(e10, t4, i3.innerType, r2);
    e10.write(`return ${n4};`);
  }), e9.write(`})();`);
  let o3 = V(t4, i3.innerType), s3 = V(t4, i3.catchValue), c3 = V(t4, Rl);
  return e9.write(`if (${a3} === INVALID) {`), e9.indented((e10) => {
    e10.write(`${a3} = ${c3}(${o3}, ${s3}, ${r2});`), e10.write(`if (${a3} === INVALID) return INVALID;`);
  }), e9.write(`}`), a3;
}
function Bl(e9, t4, n3, r2) {
  let i3 = n3._zod.def;
  if (i3.transform) {
    if (J(i3.transform)) throw new z(`z.compile: async transforms are not supported`);
    let n4 = i3.transform, a3 = V(t4, (e10) => {
      let t5 = { value: e10, issues: [], addIssue: Zc }, r3 = n4(e10, t5);
      return r3 instanceof Promise ? R : t5.issues.length === 0 ? r3 : R;
    }), o3 = H(t4);
    return e9.write(`const ${o3} = ${a3}(${r2});`), e9.write(`if (${o3} === INVALID) return INVALID;`), o3;
  }
  return r2;
}
function Vl(e9, t4) {
  return new e9({ type: `string`, ...S(t4) });
}
function Hl(e9, t4) {
  return new e9({ type: `string`, coerce: true, ...S(t4) });
}
function Ul(e9, t4) {
  return new e9({ type: `string`, format: `email`, check: `string_format`, abort: false, ...S(t4) });
}
function Wl(e9, t4) {
  return new e9({ type: `string`, format: `guid`, check: `string_format`, abort: false, ...S(t4) });
}
function Gl(e9, t4) {
  return new e9({ type: `string`, format: `uuid`, check: `string_format`, abort: false, ...S(t4) });
}
function Kl(e9, t4) {
  return new e9({ type: `string`, format: `uuid`, check: `string_format`, abort: false, version: `v4`, ...S(t4) });
}
function ql(e9, t4) {
  return new e9({ type: `string`, format: `uuid`, check: `string_format`, abort: false, version: `v6`, ...S(t4) });
}
function Jl(e9, t4) {
  return new e9({ type: `string`, format: `uuid`, check: `string_format`, abort: false, version: `v7`, ...S(t4) });
}
function Yl(e9, t4) {
  return new e9({ type: `string`, format: `url`, check: `string_format`, abort: false, ...S(t4) });
}
function Xl(e9, t4) {
  return new e9({ type: `string`, format: `emoji`, check: `string_format`, abort: false, ...S(t4) });
}
function Zl(e9, t4) {
  return new e9({ type: `string`, format: `nanoid`, check: `string_format`, abort: false, ...S(t4) });
}
function Ql(e9, t4) {
  return new e9({ type: `string`, format: `cuid`, check: `string_format`, abort: false, ...S(t4) });
}
function $l(e9, t4) {
  return new e9({ type: `string`, format: `cuid2`, check: `string_format`, abort: false, ...S(t4) });
}
function eu(e9, t4) {
  return new e9({ type: `string`, format: `ulid`, check: `string_format`, abort: false, ...S(t4) });
}
function tu(e9, t4) {
  return new e9({ type: `string`, format: `xid`, check: `string_format`, abort: false, ...S(t4) });
}
function nu(e9, t4) {
  return new e9({ type: `string`, format: `ksuid`, check: `string_format`, abort: false, ...S(t4) });
}
function ru(e9, t4) {
  return new e9({ type: `string`, format: `ipv4`, check: `string_format`, abort: false, ...S(t4) });
}
function iu(e9, t4) {
  return new e9({ type: `string`, format: `ipv6`, check: `string_format`, abort: false, ...S(t4) });
}
function au(e9, t4) {
  return new e9({ type: `string`, format: `mac`, check: `string_format`, abort: false, ...S(t4) });
}
function ou(e9, t4) {
  return new e9({ type: `string`, format: `cidrv4`, check: `string_format`, abort: false, ...S(t4) });
}
function su(e9, t4) {
  return new e9({ type: `string`, format: `cidrv6`, check: `string_format`, abort: false, ...S(t4) });
}
function cu(e9, t4) {
  return new e9({ type: `string`, format: `base64`, check: `string_format`, abort: false, ...S(t4) });
}
function lu(e9, t4) {
  return new e9({ type: `string`, format: `base64url`, check: `string_format`, abort: false, ...S(t4) });
}
function uu(e9, t4) {
  return new e9({ type: `string`, format: `e164`, check: `string_format`, abort: false, ...S(t4) });
}
function du(e9, t4) {
  return new e9({ type: `string`, format: `credit_card`, check: `string_format`, abort: false, ...S(t4) });
}
function fu(e9, t4) {
  return new e9({ type: `string`, format: `jwt`, check: `string_format`, abort: false, ...S(t4) });
}
var pu = { Any: null, Minute: -1, Second: 0, Millisecond: 3, Microsecond: 6 };
function mu(e9, t4) {
  return new e9({ type: `string`, format: `datetime`, check: `string_format`, offset: false, local: false, precision: null, ...S(t4) });
}
function hu(e9, t4) {
  return new e9({ type: `string`, format: `date`, check: `string_format`, ...S(t4) });
}
function gu(e9, t4) {
  return new e9({ type: `string`, format: `time`, check: `string_format`, precision: null, ...S(t4) });
}
function _u(e9, t4) {
  return new e9({ type: `string`, format: `duration`, check: `string_format`, ...S(t4) });
}
function vu(e9, t4) {
  return new e9({ type: `number`, checks: [], ...S(t4) });
}
function yu(e9, t4) {
  return new e9({ type: `number`, coerce: true, checks: [], ...S(t4) });
}
function bu(e9, t4) {
  return new e9({ type: `number`, check: `number_format`, abort: false, format: `safeint`, ...S(t4) });
}
function xu(e9, t4) {
  return new e9({ type: `number`, check: `number_format`, abort: false, format: `float32`, ...S(t4) });
}
function Su(e9, t4) {
  return new e9({ type: `number`, check: `number_format`, abort: false, format: `float64`, ...S(t4) });
}
function Cu(e9, t4) {
  return new e9({ type: `number`, check: `number_format`, abort: false, format: `int32`, ...S(t4) });
}
function wu(e9, t4) {
  return new e9({ type: `number`, check: `number_format`, abort: false, format: `uint32`, ...S(t4) });
}
function Tu(e9, t4) {
  return new e9({ type: `boolean`, ...S(t4) });
}
function Eu(e9, t4) {
  return new e9({ type: `boolean`, coerce: true, ...S(t4) });
}
function Du(e9, t4) {
  return new e9({ type: `bigint`, ...S(t4) });
}
function Ou(e9, t4) {
  return new e9({ type: `bigint`, coerce: true, ...S(t4) });
}
function ku(e9, t4) {
  return new e9({ type: `bigint`, check: `bigint_format`, abort: false, format: `int64`, ...S(t4) });
}
function Au(e9, t4) {
  return new e9({ type: `bigint`, check: `bigint_format`, abort: false, format: `uint64`, ...S(t4) });
}
function ju(e9, t4) {
  return new e9({ type: `symbol`, ...S(t4) });
}
function Mu(e9, t4) {
  return new e9({ type: `undefined`, ...S(t4) });
}
function Nu(e9, t4) {
  return new e9({ type: `null`, ...S(t4) });
}
function Pu(e9) {
  return new e9({ type: `any` });
}
function Fu(e9) {
  return new e9({ type: `unknown` });
}
function Iu(e9, t4) {
  return new e9({ type: `never`, ...S(t4) });
}
function Lu(e9, t4) {
  return new e9({ type: `void`, ...S(t4) });
}
function Ru(e9, t4) {
  return new e9({ type: `date`, ...S(t4) });
}
function zu(e9, t4) {
  return new e9({ type: `date`, coerce: true, ...S(t4) });
}
function Bu(e9, t4) {
  return new e9({ type: `nan`, ...S(t4) });
}
function Vu(e9, t4) {
  return new pr({ check: `less_than`, ...S(t4), value: e9, inclusive: false });
}
function Hu(e9, t4) {
  return new pr({ check: `less_than`, ...S(t4), value: e9, inclusive: true });
}
function Uu(e9, t4) {
  return new mr({ check: `greater_than`, ...S(t4), value: e9, inclusive: false });
}
function Wu(e9, t4) {
  return new mr({ check: `greater_than`, ...S(t4), value: e9, inclusive: true });
}
function Gu(e9) {
  return Uu(0, e9);
}
function Ku(e9) {
  return Vu(0, e9);
}
function qu(e9) {
  return Hu(0, e9);
}
function Ju(e9) {
  return Wu(0, e9);
}
function Yu(e9, t4) {
  return new hr({ check: `multiple_of`, ...S(t4), value: e9 });
}
function Xu(e9, t4) {
  return new vr({ check: `max_size`, ...S(t4), maximum: e9 });
}
function Zu(e9, t4) {
  return new yr({ check: `min_size`, ...S(t4), minimum: e9 });
}
function Qu(e9, t4) {
  return new br({ check: `size_equals`, ...S(t4), size: e9 });
}
function $u(e9, t4) {
  return new xr({ check: `max_length`, ...S(t4), maximum: e9 });
}
function ed(e9, t4) {
  return new Sr({ check: `min_length`, ...S(t4), minimum: e9 });
}
function td(e9, t4) {
  return new Cr({ check: `length_equals`, ...S(t4), length: e9 });
}
function nd(e9, t4) {
  return new Tr({ check: `string_format`, format: `regex`, ...S(t4), pattern: e9 });
}
function rd(e9) {
  return new Er({ check: `string_format`, format: `lowercase`, ...S(e9) });
}
function id(e9) {
  return new Dr({ check: `string_format`, format: `uppercase`, ...S(e9) });
}
function ad(e9, t4) {
  return new Or({ check: `string_format`, format: `includes`, ...S(t4), includes: e9 });
}
function od(e9, t4) {
  return new kr({ check: `string_format`, format: `starts_with`, ...S(t4), prefix: e9 });
}
function sd(e9, t4) {
  return new Ar({ check: `string_format`, format: `ends_with`, ...S(t4), suffix: e9 });
}
function cd(e9, t4, n3) {
  return new Mr({ check: `property`, property: e9, schema: t4, ...S(n3) });
}
function ld(e9) {
  return Object.entries(e9).map(([e10, t4]) => new Mr({ check: `property`, property: e10, schema: t4 }));
}
function ud(e9, t4) {
  return new Nr({ check: `mime_type`, mime: e9, ...S(t4) });
}
function Y(e9) {
  return new Pr({ check: `overwrite`, tx: e9 });
}
function dd(e9) {
  return Y((t4) => t4.normalize(e9));
}
function fd() {
  return Y((e9) => e9.trim());
}
function pd() {
  return Y((e9) => e9.toLowerCase());
}
function md() {
  return Y((e9) => e9.toUpperCase());
}
function hd() {
  return Y((e9) => oe(e9));
}
function gd(e9, t4, n3) {
  return new e9({ type: `array`, element: t4, ...S(n3) });
}
function _d(e9, t4, n3) {
  return new e9({ type: `union`, options: t4, ...S(n3) });
}
function vd(e9, t4, n3) {
  return new e9({ type: `union`, options: t4, inclusive: false, ...S(n3) });
}
function yd(e9, t4, n3, r2) {
  return new e9({ type: `union`, options: n3, discriminator: t4, ...S(r2) });
}
function bd(e9, t4, n3) {
  return new e9({ type: `intersection`, left: t4, right: n3 });
}
function xd(e9, t4, n3, r2) {
  let i3 = n3 instanceof F;
  return new e9({ type: `tuple`, items: t4, rest: i3 ? n3 : null, ...S(i3 ? r2 : n3) });
}
function Sd(e9, t4, n3, r2) {
  return new e9({ type: `record`, keyType: t4, valueType: n3, ...S(r2) });
}
function Cd(e9, t4, n3, r2) {
  return new e9({ type: `map`, keyType: t4, valueType: n3, ...S(r2) });
}
function wd(e9, t4, n3) {
  return new e9({ type: `set`, valueType: t4, ...S(n3) });
}
function Td(e9, t4, n3) {
  return new e9({ type: `enum`, entries: Array.isArray(t4) ? Object.fromEntries(t4.map((e10) => [e10, e10])) : t4, ...S(n3) });
}
function Ed(e9, t4, n3) {
  return new e9({ type: `enum`, entries: t4, ...S(n3) });
}
function Dd(e9, t4, n3) {
  return new e9({ type: `literal`, values: Array.isArray(t4) ? t4 : [t4], ...S(n3) });
}
function Od(e9, t4) {
  return new e9({ type: `file`, ...S(t4) });
}
function kd(e9, t4) {
  return new e9({ type: `transform`, transform: t4 });
}
function Ad(e9, t4) {
  return new e9({ type: `optional`, innerType: t4 });
}
function jd(e9, t4) {
  return new e9({ type: `nullable`, innerType: t4 });
}
function Md(e9, t4, n3) {
  return new e9({ type: `default`, innerType: t4, get defaultValue() {
    return typeof n3 == `function` ? n3() : ue(n3);
  } });
}
function Nd(e9, t4, n3) {
  return new e9({ type: `nonoptional`, innerType: t4, ...S(n3) });
}
function Pd(e9, t4) {
  return new e9({ type: `success`, innerType: t4 });
}
function Fd(e9, t4, n3) {
  return new e9({ type: `catch`, innerType: t4, catchValue: typeof n3 == `function` ? n3 : Qe(n3) });
}
function Id(e9, t4, n3) {
  return new e9({ type: `pipe`, in: t4, out: n3 });
}
function Ld(e9, t4) {
  return new e9({ type: `readonly`, innerType: t4 });
}
function Rd(e9, t4, n3) {
  return new e9({ type: `template_literal`, parts: t4, ...S(n3) });
}
function zd(e9, t4) {
  return new e9({ type: `lazy`, getter: t4 });
}
function Bd(e9, t4) {
  return new e9({ type: `promise`, innerType: t4 });
}
function Vd(e9, t4, n3) {
  let r2 = S(n3);
  return r2.abort ??= true, new e9({ type: `custom`, check: `custom`, fn: t4, ...r2 });
}
function Hd(e9, t4, n3) {
  return new e9({ type: `custom`, check: `custom`, fn: t4, ...S(n3) });
}
function Ud(e9, t4) {
  let n3 = Wd((t5) => (t5.addIssue = (e10) => {
    if (typeof e10 == `string`) t5.issues.push(Ne(e10, t5.value, n3._zod.def));
    else {
      let r2 = e10;
      r2.fatal && (r2.continue = false), r2.code ??= `custom`, `input` in r2 || (r2.input = t5.value), r2.inst ??= n3, r2.continue ??= !n3._zod.def.abort, t5.issues.push(Ne(r2));
    }
  }, e9(t5.value, t5)), t4);
  return n3;
}
function Wd(e9, t4) {
  let n3 = new P({ check: `custom`, ...S(t4) });
  return n3._zod.check = e9, n3;
}
function Gd(e9) {
  let t4 = new P({ check: `describe` });
  return t4._zod.onattach = [(t5) => {
    let n3 = L.get(t5) ?? {};
    L.add(t5, { ...n3, description: e9 });
  }], t4._zod.check = () => {
  }, t4;
}
function Kd(e9) {
  let t4 = new P({ check: `meta` });
  return t4._zod.onattach = [(t5) => {
    let n3 = L.get(t5) ?? {};
    L.add(t5, { ...n3, ...e9 });
  }], t4._zod.check = () => {
  }, t4;
}
function qd(e9, t4) {
  let n3 = S(t4), r2 = n3.truthy ?? [`true`, `1`, `yes`, `on`, `y`, `enabled`], i3 = n3.falsy ?? [`false`, `0`, `no`, `off`, `n`, `disabled`];
  n3.case !== `sensitive` && (r2 = r2.map((e10) => typeof e10 == `string` ? e10.toLowerCase() : e10), i3 = i3.map((e10) => typeof e10 == `string` ? e10.toLowerCase() : e10));
  let a3 = new Set(r2), o3 = new Set(i3), s3 = e9.Codec ?? Na, c3 = e9.Boolean ?? Ai, l3 = new s3({ type: `pipe`, in: new (e9.String ?? zr)({ type: `string`, error: n3.error }), out: new c3({ type: `boolean`, error: n3.error }), transform: ((e10, t5) => {
    let r3 = e10;
    return n3.case !== `sensitive` && (r3 = r3.toLowerCase()), a3.has(r3) ? true : !o3.has(r3) && (t5.issues.push({ code: `invalid_value`, expected: `stringbool`, values: [...a3, ...o3], input: t5.value, inst: l3, continue: false }), {});
  }), reverseTransform: ((e10, t5) => e10 === true ? r2[0] || `true` : i3[0] || `false`), error: n3.error });
  return l3._zod.bag.truthy = r2, l3._zod.bag.falsy = i3, l3._zod.bag.case = n3.case ?? `insensitive`, l3;
}
function Jd(e9, t4, n3, r2 = {}) {
  let i3 = S(r2), a3 = { check: `string_format`, type: `string`, format: t4, fn: typeof n3 == `function` ? n3 : (e10) => n3.test(e10), ...i3 };
  return n3 instanceof RegExp && (a3.pattern = n3), new e9(a3);
}
function Yd(e9, ...t4) {
  for (let n3 of t4) for (let t5 of Reflect.ownKeys(n3)) Object.prototype.propertyIsEnumerable.call(n3, t5) && g(e9, t5, n3[t5]);
  return e9;
}
function X(e9) {
  let t4 = e9?.target ?? `draft-2020-12`;
  return t4 === `draft-4` && (t4 = `draft-04`), t4 === `draft-7` && (t4 = `draft-07`), { processors: e9.processors ?? {}, metadataRegistry: e9?.metadata ?? L, target: t4, unrepresentable: e9?.unrepresentable ?? `throw`, override: e9?.override ?? (() => {
  }), io: e9?.io ?? `output`, counter: 0, seen: /* @__PURE__ */ new Map(), sharedDefsExtractedFor: void 0, sharedEmitDoneFor: void 0, cycles: e9?.cycles ?? `ref`, reused: e9?.reused ?? `inline`, intersections: [], deferred: [], external: e9?.external ?? void 0 };
}
function Z(e9, t4, n3, r2, i3) {
  let a3 = typeof t4.unrepresentable == `function` ? t4.unrepresentable({ zodSchema: e9, path: r2.path, message: i3 }) : t4.unrepresentable;
  if (a3 === `any`) return false;
  if (a3 === void 0 || a3 === `throw`) throw Error(i3);
  return Object.assign(n3, a3), true;
}
function Q(e9, t4, n3 = { path: [], schemaPath: [] }) {
  var r2;
  let i3 = e9._zod.def, a3 = t4.seen.get(e9);
  if (a3) return a3.count++, n3.schemaPath.includes(e9) && (a3.cycle = n3.path), a3.schema;
  let o3 = { schema: {}, count: 1, cycle: void 0, path: n3.path };
  t4.seen.set(e9, o3), t4.sharedDefsExtractedFor = void 0, t4.sharedEmitDoneFor = void 0;
  let s3 = e9._zod.toJSONSchema?.();
  if (s3) o3.schema = s3;
  else {
    let r3 = { ...n3, schemaPath: [...n3.schemaPath, e9], path: n3.path };
    if (e9._zod.processJSONSchema) e9._zod.processJSONSchema(t4, o3.schema, r3);
    else {
      let n4 = o3.schema, a5 = t4.processors[i3.type];
      if (!a5) throw Error(`[toJSONSchema]: Non-representable type encountered: ${i3.type}`);
      a5(e9, t4, n4, r3);
    }
    let a4 = e9._zod.parent;
    a4 && (o3.ref ||= a4, Q(a4, t4, r3), t4.seen.get(a4).isParent = true);
  }
  let c3 = t4.metadataRegistry.get(e9);
  return c3 && Yd(o3.schema, c3), t4.io === `input` && $(e9) && (delete o3.schema.examples, delete o3.schema.default), t4.io === `input` && `_prefault` in o3.schema && ((r2 = o3.schema).default ?? (r2.default = o3.schema._prefault)), delete o3.schema._prefault, t4.seen.get(e9).schema;
}
function Xd(e9) {
  return e9.replace(/~/g, `~0`).replace(/\//g, `~1`);
}
function Zd(e9, t4) {
  let n3 = e9.seen.get(t4);
  if (!n3) throw Error(`Unprocessed schema. This is a bug in Zod.`);
  if (e9.external && e9.sharedDefsExtractedFor === e9.external) return;
  let r2 = /* @__PURE__ */ new Map();
  for (let t5 of e9.seen.entries()) {
    let n4 = e9.metadataRegistry.get(t5[0])?.id;
    if (n4) {
      let e10 = r2.get(n4);
      if (e10 && e10 !== t5[0]) throw Error(`Duplicate schema id "${n4}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      r2.set(n4, t5[0]);
    }
  }
  let i3 = (t5) => {
    let r3 = e9.target === `draft-2020-12` ? `$defs` : `definitions`;
    if (e9.external) {
      let n4 = e9.external.registry.get(t5[0])?.id, i5 = e9.external.uri ?? ((e10) => e10);
      if (n4) return { ref: i5(n4) };
      let a5 = t5[1].defId ?? t5[1].schema.id ?? `schema${e9.counter++}`;
      return t5[1].defId = a5, { defId: a5, ref: `${i5(`__shared`)}#/${r3}/${Xd(a5)}` };
    }
    let i4 = `#/${r3}/`;
    if (t5[1] === n3 && !t5[1].schema.id) return { ref: `#` };
    let a4 = t5[1].schema.id ?? `__schema${e9.counter++}`;
    return { defId: a4, ref: i4 + Xd(a4) };
  }, a3 = (e10) => {
    if (e10[1].schema.$ref) return;
    let t5 = e10[1], { ref: n4, defId: r3 } = i3(e10);
    t5.def = { ...t5.schema }, r3 && (t5.defId = r3);
    let a4 = t5.schema;
    for (let e11 in a4) delete a4[e11];
    a4.$ref = n4;
  };
  if (e9.cycles === `throw`) for (let t5 of e9.seen.entries()) {
    let e10 = t5[1];
    if (e10.cycle) throw Error(`Cycle detected: #/${e10.cycle?.join(`/`)}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
  }
  for (let n4 of e9.seen.entries()) {
    let r3 = n4[1];
    if (t4 === n4[0]) {
      a3(n4);
      continue;
    }
    if (e9.external) {
      let r4 = e9.external.registry.get(n4[0])?.id;
      if (t4 !== n4[0] && r4) {
        a3(n4);
        continue;
      }
    }
    if (e9.metadataRegistry.get(n4[0])?.id) {
      a3(n4);
      continue;
    }
    if (r3.cycle) {
      a3(n4);
      continue;
    }
    if (r3.count > 1 && e9.reused === `ref`) {
      a3(n4);
      continue;
    }
  }
  e9.external && (e9.sharedDefsExtractedFor = e9.external);
}
function Qd(e9) {
  let t4 = e9.anyOf;
  if (!Array.isArray(t4) || t4.length === 0 || e9.type !== void 0) return;
  let n3 = [];
  for (let e10 of t4) {
    if (!e10 || typeof e10 != `object`) return;
    Qd(e10);
    let t5 = Object.keys(e10);
    if (t5.length !== 1 || t5[0] !== `type`) return;
    let r2 = e10.type;
    for (let e11 of Array.isArray(r2) ? r2 : [r2]) {
      if (typeof e11 != `string`) return;
      n3.includes(e11) || n3.push(e11);
    }
  }
  delete e9.anyOf, e9.type = n3.length === 1 ? n3[0] : n3;
}
var $d = /* @__PURE__ */ new Set([`type`, `properties`, `required`, `additionalProperties`]);
var ef = [`oneOf`, `anyOf`];
function tf(e9) {
  let t4 = e9.additionalProperties;
  return t4 === void 0 || t4 === false || typeof t4 != `object` || !t4 ? null : Object.keys(t4).length ? t4 : null;
}
function nf(e9) {
  let t4 = [];
  for (let n4 of e9) {
    if (typeof n4 != `object` || n4.type !== `object`) return null;
    for (let e10 in n4) if (!$d.has(e10)) return null;
    t4.push(n4);
  }
  let n3 = {}, r2 = /* @__PURE__ */ new Set();
  for (let e10 of t4) {
    for (let r3 in e10.properties) {
      if (Object.prototype.hasOwnProperty.call(n3, r3)) continue;
      let e11 = [];
      for (let n4 of t4) {
        let t5 = n4.properties?.[r3] ?? tf(n4);
        t5 != null && (e11.some((e12) => JSON.stringify(e12) === JSON.stringify(t5)) || e11.push(t5));
      }
      g(n3, r3, e11.length === 1 ? e11[0] : nf(e11) ?? { allOf: e11 });
    }
    for (let t5 of e10.required ?? []) r2.add(t5);
  }
  let i3 = { type: `object`, properties: n3 };
  if (r2.size && (i3.required = [...r2]), t4.every((e10) => e10.additionalProperties === false)) i3.additionalProperties = false;
  else {
    let e10 = [];
    for (let n4 of t4) {
      let t5 = tf(n4);
      t5 && !e10.some((e11) => JSON.stringify(e11) === JSON.stringify(t5)) && e10.push(t5);
    }
    e10.length === 1 ? i3.additionalProperties = e10[0] : e10.length > 1 && (i3.additionalProperties = { allOf: e10 });
  }
  return i3;
}
function rf(e9) {
  let t4 = e9.allOf;
  if (!Array.isArray(t4) || t4.length < 2) return;
  for (let t5 of $d) if (t5 in e9) return;
  let n3 = t4.filter((e10) => ef.some((t5) => Array.isArray(e10[t5]))), r2 = null;
  if (!n3.length) r2 = nf(t4);
  else {
    let e10 = n3[0], i3 = ef.find((t5) => Array.isArray(e10[t5]));
    if (Object.keys(e10).length !== 1) return;
    let a3 = t4.filter((t5) => t5 !== e10), o3 = e10[i3].map((e11) => nf([...a3, e11]));
    if (o3.some((e11) => !e11)) return;
    r2 = { [i3]: o3 };
  }
  r2 && (delete e9.allOf, Yd(e9, r2));
}
function af(e9, t4) {
  let n3 = e9.seen.get(t4);
  if (!n3) throw Error(`Unprocessed schema. This is a bug in Zod.`);
  let r2 = (t5) => {
    let n4 = e9.seen.get(t5);
    if (n4.ref === null) return;
    let i4 = n4.def ?? n4.schema, a4 = { ...i4 }, o4 = n4.ref;
    if (n4.ref = null, o4) {
      r2(o4);
      let n5 = e9.seen.get(o4), s4 = n5.schema;
      if (s4.$ref && (e9.target === `draft-07` || e9.target === `draft-04` || e9.target === `openapi-3.0`) ? (i4.allOf = i4.allOf ?? [], i4.allOf.push(s4)) : Yd(i4, s4), Yd(i4, a4), t5._zod.parent === o4) for (let e10 in i4) e10 !== `$ref` && e10 !== `allOf` && (e10 in a4 || delete i4[e10]);
      if (s4.$ref && n5.def) for (let e10 in i4) e10 !== `$ref` && e10 !== `allOf` && e10 in n5.def && JSON.stringify(i4[e10]) === JSON.stringify(n5.def[e10]) && delete i4[e10];
    }
    let s3 = t5._zod.parent;
    if (s3 && s3 !== o4) {
      r2(s3);
      let t6 = e9.seen.get(s3);
      if (t6?.schema.$ref && (i4.$ref = t6.schema.$ref, t6.def)) for (let e10 in i4) e10 !== `$ref` && e10 !== `allOf` && e10 in t6.def && JSON.stringify(i4[e10]) === JSON.stringify(t6.def[e10]) && delete i4[e10];
    }
    e9.override({ zodSchema: t5, jsonSchema: i4, path: n4.path ?? [] });
  };
  if (!e9.external || e9.sharedEmitDoneFor !== e9.external) {
    for (let t5 of [...e9.seen.entries()].reverse()) r2(t5[0]);
    if (e9.target !== `openapi-3.0`) for (let t5 of e9.seen.entries()) Qd(t5[1].def ?? t5[1].schema);
    for (let t5 of e9.deferred) t5();
    if (e9.intersections.length) {
      let t5 = /* @__PURE__ */ new Map();
      for (let n4 of e9.seen.values()) for (let e10 of [n4.schema, n4.def]) {
        let n5 = e10?.allOf;
        if (!Array.isArray(n5)) continue;
        let r3 = t5.get(n5);
        r3 ? r3.push(e10) : t5.set(n5, [e10]);
      }
      for (let n4 of e9.intersections) for (let e10 of t5.get(n4) ?? []) rf(e10);
    }
  }
  let i3 = {};
  if (e9.target === `draft-2020-12` ? i3.$schema = `https://json-schema.org/draft/2020-12/schema` : e9.target === `draft-07` ? i3.$schema = `http://json-schema.org/draft-07/schema#` : e9.target === `draft-04` ? i3.$schema = `http://json-schema.org/draft-04/schema#` : e9.target, e9.external?.uri) {
    let n4 = e9.external.registry.get(t4)?.id;
    if (!n4) throw Error("Schema is missing an `id` property");
    i3.$id = e9.external.uri(n4);
  }
  Yd(i3, n3.defId ? n3.schema : n3.def ?? n3.schema);
  let a3 = e9.metadataRegistry.get(t4)?.id;
  a3 !== void 0 && i3.id === a3 && delete i3.id;
  let o3 = e9.external?.defs ?? {};
  if (!e9.external || e9.sharedEmitDoneFor !== e9.external) for (let t5 of e9.seen.entries()) {
    let e10 = t5[1];
    e10.def && e10.defId && (e10.def.id === e10.defId && delete e10.def.id, g(o3, e10.defId, e10.def));
  }
  e9.external && (e9.sharedEmitDoneFor = e9.external), e9.external || Object.keys(o3).length > 0 && (e9.target === `draft-2020-12` ? i3.$defs = o3 : i3.definitions = o3);
  try {
    let n4 = JSON.parse(JSON.stringify(i3));
    return Object.defineProperty(n4, "~standard", { value: { ...t4[`~standard`], jsonSchema: { input: sf(t4, `input`, e9.processors), output: sf(t4, `output`, e9.processors) } }, enumerable: false, writable: false }), n4;
  } catch {
    throw Error(`Error converting schema to JSON.`);
  }
}
function $(e9, t4) {
  let n3 = t4 ?? { seen: /* @__PURE__ */ new Set() };
  if (n3.seen.has(e9)) return false;
  n3.seen.add(e9);
  let r2 = e9._zod.def;
  if (r2.type === `transform`) return true;
  if (r2.type === `array`) return $(r2.element, n3);
  if (r2.type === `set`) return $(r2.valueType, n3);
  if (r2.type === `lazy`) return $(r2.getter(), n3);
  if (r2.type === `promise` || r2.type === `optional` || r2.type === `nonoptional` || r2.type === `nullable` || r2.type === `readonly` || r2.type === "default" || r2.type === `prefault` || r2.type === `catch`) return $(r2.innerType, n3);
  if (r2.type === `intersection`) return $(r2.left, n3) || $(r2.right, n3);
  if (r2.type === `record` || r2.type === `map`) return $(r2.keyType, n3) || $(r2.valueType, n3);
  if (r2.type === `pipe`) return e9._zod.traits.has(`$ZodCodec`) ? true : $(r2.in, n3) || $(r2.out, n3);
  if (r2.type === `object`) {
    for (let e10 in r2.shape) if ($(r2.shape[e10], n3)) return true;
    return false;
  }
  if (r2.type === `union`) {
    for (let e10 of r2.options) if ($(e10, n3)) return true;
    return false;
  }
  if (r2.type === `tuple`) {
    for (let e10 of r2.items) if ($(e10, n3)) return true;
    return !!(r2.rest && $(r2.rest, n3));
  }
  return false;
}
var of = (e9, t4 = {}) => (n3) => {
  let r2 = X({ ...n3, processors: t4 });
  return Q(e9, r2), Zd(r2, e9), af(r2, e9);
};
var sf = (e9, t4, n3 = {}) => (r2) => {
  let { libraryOptions: i3, target: a3 } = r2 ?? {}, o3 = X({ ...i3 ?? {}, target: a3, io: t4, processors: n3 });
  return Q(e9, o3), Zd(o3, e9), af(o3, e9);
};
var cf = { guid: `uuid`, url: `uri`, datetime: `date-time`, json_string: `json-string`, regex: `` };
var lf = (e9, t4, n3, r2) => {
  let i3 = n3;
  i3.type = `string`;
  let { minimum: a3, maximum: o3, format: s3, patterns: c3, contentEncoding: l3, laxFormat: u3 } = e9._zod.bag;
  if (typeof a3 == `number` && (i3.minLength = a3), typeof o3 == `number` && (i3.maxLength = o3), s3 && (i3.format = cf[s3] ?? s3, i3.format === `` && delete i3.format, (s3 === `time` || u3) && delete i3.format), l3 && (i3.contentEncoding = l3), c3 && c3.size > 0) {
    let e10 = [...c3];
    e10.length === 1 ? i3.pattern = e10[0].source : e10.length > 1 && (i3.allOf = [...e10.map((e11) => ({ ...t4.target === `draft-07` || t4.target === `draft-04` || t4.target === `openapi-3.0` ? { type: `string` } : {}, pattern: e11.source }))]);
  }
};
var uf = (e9, t4, n3, r2) => {
  let i3 = n3, { minimum: a3, maximum: o3, format: s3, multipleOf: c3, exclusiveMaximum: l3, exclusiveMinimum: u3 } = e9._zod.bag;
  i3.type = typeof s3 == `string` && s3.includes(`int`) ? `integer` : `number`;
  let d3 = typeof u3 == `number` && u3 >= (a3 ?? -1 / 0), f3 = typeof l3 == `number` && l3 <= (o3 ?? 1 / 0), p3 = t4.target === `draft-04` || t4.target === `openapi-3.0`;
  d3 ? p3 ? (i3.minimum = u3, i3.exclusiveMinimum = true) : i3.exclusiveMinimum = u3 : typeof a3 == `number` && (i3.minimum = a3), f3 ? p3 ? (i3.maximum = l3, i3.exclusiveMaximum = true) : i3.exclusiveMaximum = l3 : typeof o3 == `number` && (i3.maximum = o3), typeof c3 == `number` && (Number.isFinite(c3) && c3 !== 0 ? i3.multipleOf = Math.abs(c3) : Z(e9, t4, i3, r2, `A multipleOf divisor of ${c3} cannot be represented in JSON Schema`));
};
var df = (e9, t4, n3, r2) => {
  n3.type = `boolean`;
};
var ff = (e9, t4, n3, r2) => {
  Z(e9, t4, n3, r2, `BigInt cannot be represented in JSON Schema`);
};
var pf = (e9, t4, n3, r2) => {
  Z(e9, t4, n3, r2, `Symbols cannot be represented in JSON Schema`);
};
var mf = (e9, t4, n3, r2) => {
  t4.target === `openapi-3.0` ? (n3.type = `string`, n3.nullable = true, n3.enum = [null]) : n3.type = `null`;
};
var hf = (e9, t4, n3, r2) => {
  Z(e9, t4, n3, r2, `Undefined cannot be represented in JSON Schema`);
};
var gf = (e9, t4, n3, r2) => {
  Z(e9, t4, n3, r2, `Void cannot be represented in JSON Schema`);
};
var _f = (e9, t4, n3, r2) => {
  n3.not = {};
};
var vf = (e9, t4, n3, r2) => {
};
var yf = (e9, t4, n3, r2) => {
};
var bf = (e9, t4, n3, r2) => {
  Z(e9, t4, n3, r2, `Date cannot be represented in JSON Schema`);
};
var xf = (e9, t4, n3, r2) => {
  let i3 = e9._zod.def, a3 = c(i3.entries);
  if (a3.length === 0) {
    n3.not = {};
    return;
  }
  a3.every((e10) => typeof e10 == `number`) && (n3.type = `number`), a3.every((e10) => typeof e10 == `string`) && (n3.type = `string`), n3.enum = a3;
};
var Sf = (e9, t4, n3, r2) => {
  let i3 = e9._zod.def;
  if (i3.values.length === 0) {
    n3.not = {};
    return;
  }
  let a3 = [];
  for (let o3 of i3.values) if (o3 === void 0) {
    if (Z(e9, t4, n3, r2, "Literal `undefined` cannot be represented in JSON Schema")) return;
  } else if (typeof o3 == `bigint`) {
    if (Z(e9, t4, n3, r2, `BigInt literals cannot be represented in JSON Schema`)) return;
    a3.push(Number(o3));
  } else a3.push(o3);
  if (a3.length !== 0) {
    if (a3.length === 1) {
      let e10 = a3[0];
      n3.type = e10 === null ? `null` : typeof e10, t4.target === `draft-04` || t4.target === `openapi-3.0` ? n3.enum = [e10] : n3.const = e10;
    } else a3.every((e10) => typeof e10 == `number`) && (n3.type = `number`), a3.every((e10) => typeof e10 == `string`) && (n3.type = `string`), a3.every((e10) => typeof e10 == `boolean`) && (n3.type = `boolean`), a3.every((e10) => e10 === null) && (n3.type = `null`), n3.enum = a3;
  }
};
var Cf = (e9, t4, n3, r2) => {
  Z(e9, t4, n3, r2, `NaN cannot be represented in JSON Schema`);
};
var wf = (e9, t4, n3, r2) => {
  let i3 = n3, a3 = e9._zod.pattern;
  if (!a3) throw Error(`Pattern not found in template literal`);
  i3.type = `string`, i3.pattern = a3.source;
};
var Tf = (e9, t4, n3, r2) => {
  let i3 = n3, a3 = { type: `string`, format: `binary`, contentEncoding: `binary` }, { minimum: o3, maximum: s3, mime: c3 } = e9._zod.bag;
  o3 !== void 0 && (a3.minLength = o3), s3 !== void 0 && (a3.maxLength = s3), c3 ? c3.length === 1 ? (a3.contentMediaType = c3[0], Object.assign(i3, a3)) : (Object.assign(i3, a3), i3.anyOf = c3.map((e10) => ({ contentMediaType: e10 }))) : Object.assign(i3, a3);
};
var Ef = (e9, t4, n3, r2) => {
  n3.type = `boolean`;
};
var Df = (e9, t4, n3, r2) => {
  Z(e9, t4, n3, r2, `Custom types cannot be represented in JSON Schema`);
};
var Of = (e9, t4, n3, r2) => {
  Z(e9, t4, n3, r2, `Function types cannot be represented in JSON Schema`);
};
var kf = (e9, t4, n3, r2) => {
  Z(e9, t4, n3, r2, `Transforms cannot be represented in JSON Schema`);
};
var Af = (e9, t4, n3, r2) => {
  Z(e9, t4, n3, r2, `Map cannot be represented in JSON Schema`);
};
var jf = (e9, t4, n3, r2) => {
  Z(e9, t4, n3, r2, `Set cannot be represented in JSON Schema`);
};
var Mf = (e9, t4, n3, r2) => {
  let i3 = n3, a3 = e9._zod.def, { minimum: o3, maximum: s3 } = e9._zod.bag;
  typeof o3 == `number` && (i3.minItems = o3), typeof s3 == `number` && (i3.maxItems = s3), i3.type = `array`, i3.items = Q(a3.element, t4, { ...r2, path: [...r2.path, `items`] });
};
function Nf(e9) {
  let t4 = e9._zod.def;
  return t4.type === `pipe` && t4.in._zod.traits.has(`$ZodTransform`) ? Nf(t4.out) : t4.type === `catch` ? Nf(t4.innerType) : e9._zod.optin;
}
var Pf = (e9, t4, n3, r2) => {
  let i3 = n3, a3 = e9._zod.def, o3 = a3.shape;
  if (Object.getOwnPropertySymbols(o3).length && Z(e9, t4, i3, r2, `Symbol keys cannot be represented in JSON Schema`)) return;
  i3.type = `object`, i3.properties = {};
  for (let e10 in o3) g(i3.properties, e10, Q(o3[e10], t4, { ...r2, path: [...r2.path, `properties`, e10] }));
  let s3 = new Set(Object.keys(o3)), c3 = new Set([...s3].filter((e10) => {
    let n4 = a3.shape[e10];
    return t4.io === `input` ? Nf(n4) === void 0 : n4._zod.optout === void 0;
  }));
  c3.size > 0 && (i3.required = Array.from(c3)), a3.catchall?._zod.def.type === `never` ? i3.additionalProperties = false : a3.catchall ? a3.catchall && (i3.additionalProperties = Q(a3.catchall, t4, { ...r2, path: [...r2.path, `additionalProperties`] })) : t4.io === `output` && (i3.additionalProperties = false);
};
var Ff = (e9, t4, n3, r2) => {
  let i3 = e9._zod.def, a3 = i3.inclusive === false, o3 = i3.options.map((e10, n4) => Q(e10, t4, { ...r2, path: [...r2.path, a3 ? `oneOf` : `anyOf`, n4] }));
  a3 ? n3.oneOf = o3 : n3.anyOf = o3;
};
var If = (e9, t4, n3, r2) => {
  let i3 = e9._zod.def, a3 = Q(i3.left, t4, { ...r2, path: [...r2.path, `allOf`, 0] }), o3 = Q(i3.right, t4, { ...r2, path: [...r2.path, `allOf`, 1] }), s3 = (e10) => `allOf` in e10 && Object.keys(e10).length === 1, c3 = [...s3(a3) ? a3.allOf : [a3], ...s3(o3) ? o3.allOf : [o3]];
  n3.allOf = c3, t4.intersections.push(c3);
};
var Lf = (e9, t4, n3, r2) => {
  let i3 = n3, a3 = e9._zod.def;
  i3.type = `array`;
  let o3 = t4.target === `draft-2020-12` ? `prefixItems` : `items`, s3 = t4.target === `draft-2020-12` || t4.target === `openapi-3.0` ? `items` : `additionalItems`, c3 = a3.items.map((e10, n4) => Q(e10, t4, { ...r2, path: [...r2.path, o3, n4] })), l3 = a3.rest ? Q(a3.rest, t4, { ...r2, path: [...r2.path, s3, ...t4.target === `openapi-3.0` ? [a3.items.length] : []] }) : null, u3 = a3.items.length;
  for (; u3 > 0; ) {
    let e10 = a3.items[u3 - 1];
    if (!(t4.io === `input` ? Nf(e10) !== void 0 : e10._zod.optout === `optional`)) break;
    u3--;
  }
  let d3 = a3.items.length, f3 = !a3.rest;
  t4.target === `draft-2020-12` ? (i3.prefixItems = c3, f3 ? i3.items = false : l3 && (i3.items = l3), u3 > 0 && (i3.minItems = u3), f3 && (i3.maxItems = d3)) : t4.target === `openapi-3.0` ? (i3.items = { anyOf: c3 }, l3 && i3.items.anyOf.push(l3), u3 > 0 && (i3.minItems = u3), f3 && (i3.maxItems = d3)) : (i3.items = c3, f3 ? i3.additionalItems = false : l3 && (i3.additionalItems = l3), u3 > 0 && (i3.minItems = u3), f3 && (i3.maxItems = d3));
  let { minimum: p3, maximum: m3 } = e9._zod.bag;
  typeof p3 == `number` && (i3.minItems = p3), typeof m3 == `number` && (i3.maxItems = m3);
};
function Rf(e9, t4, n3) {
  if (t4.$ref) {
    if (n3.has(t4)) return t4;
    n3.add(t4);
    let r3 = e9.get(t4)?.def;
    if (!r3) return t4;
    let i4 = Rf(e9, r3, n3);
    return i4 === r3 ? t4 : i4;
  }
  for (let r3 of [`anyOf`, `oneOf`]) {
    let i4 = t4[r3];
    if (!Array.isArray(i4)) continue;
    let a4 = i4.map((t5) => Rf(e9, t5, n3));
    a4.some((e10, t5) => e10 !== i4[t5]) && (t4 = { ...t4, [r3]: a4 });
  }
  let r2 = Array.isArray(t4.type) ? t4.type : [t4.type], i3 = !r2.includes(`string`) && r2.some((e10) => e10 === `number` || e10 === `integer`), a3 = t4.enum ?? (t4.const === void 0 ? void 0 : [t4.const]);
  if (!i3 && !a3?.some((e10) => typeof e10 == `number`)) return t4;
  let { minimum: o3, maximum: s3, exclusiveMinimum: c3, exclusiveMaximum: l3, multipleOf: u3, format: d3, id: f3, ...p3 } = t4;
  return p3.enum ? p3.enum = p3.enum.map((e10) => typeof e10 == `number` ? String(e10) : e10) : typeof p3.const == `number` && (p3.const = String(p3.const)), i3 ? (p3.type = `string`, a3 || (p3.pattern = (r2.includes(`number`) ? Bn : zn).source), p3) : p3;
}
var zf = /* @__PURE__ */ new WeakMap();
function Bf(e9) {
  let t4 = /* @__PURE__ */ new Map();
  for (let n4 of e9.seen.values()) n4.def && !t4.has(n4.schema) && t4.set(n4.schema, n4);
  let n3 = /* @__PURE__ */ new Map();
  for (let r2 of zf.get(e9) ?? []) {
    let i3 = e9.seen.get(r2), a3 = (i3?.def ?? i3?.schema)?.propertyNames;
    if (!a3 || a3 === true || n3.has(a3)) continue;
    let o3 = Rf(t4, a3, /* @__PURE__ */ new Set());
    o3 !== a3 && n3.set(a3, o3);
  }
  if (n3.size) for (let t5 of e9.seen.values()) for (let e10 of [t5.schema, t5.def]) {
    let t6 = e10 && n3.get(e10.propertyNames);
    t6 && (e10.propertyNames = t6);
  }
}
var Vf = (e9, t4, n3, r2) => {
  let i3 = n3, a3 = e9._zod.def;
  i3.type = `object`;
  let o3 = a3.keyType, s3 = o3._zod.bag?.patterns;
  if (a3.mode === `loose` && s3 && s3.size > 0) {
    let e10 = Q(a3.valueType, t4, { ...r2, path: [...r2.path, `patternProperties`, `*`] });
    i3.patternProperties = {};
    for (let t5 of s3) g(i3.patternProperties, t5.source, e10);
  } else {
    if (t4.target === `draft-07` || t4.target === `draft-2020-12`) {
      i3.propertyNames = Q(a3.keyType, t4, { ...r2, path: [...r2.path, `propertyNames`] });
      let n4 = zf.get(t4);
      n4 || (n4 = [], zf.set(t4, n4), t4.deferred.push(() => Bf(t4))), n4.push(e9);
    }
    i3.additionalProperties = Q(a3.valueType, t4, { ...r2, path: [...r2.path, `additionalProperties`] });
  }
  let c3 = o3._zod.values, l3 = t4.io === `input` && Nf(a3.valueType) !== void 0;
  if (c3 && !a3.partial && !l3) {
    let e10 = [...c3].filter((e11) => typeof e11 == `string` || typeof e11 == `number`);
    e10.length > 0 && (i3.required = e10.map(String));
  }
};
var Hf = (e9, t4, n3, r2) => {
  let i3 = e9._zod.def, a3 = Q(i3.innerType, t4, r2), o3 = t4.seen.get(e9);
  t4.target === `openapi-3.0` ? (o3.ref = i3.innerType, n3.nullable = true) : n3.anyOf = [a3, { type: `null` }];
};
var Uf = (e9, t4, n3, r2) => {
  let i3 = e9._zod.def;
  Q(i3.innerType, t4, r2);
  let a3 = t4.seen.get(e9);
  a3.ref = i3.innerType;
};
var Wf = /* @__PURE__ */ Symbol();
function Gf(e9, t4, n3, r2, i3) {
  let a3 = false, o3 = JSON.stringify(e9, (e10, t5) => typeof t5 == `bigint` ? (a3 = true, null) : t5);
  return a3 ? (Z(t4, n3, r2, i3, `BigInt defaults cannot be represented in JSON Schema`), Wf) : JSON.parse(o3);
}
var Kf = (e9, t4, n3, r2) => {
  let i3 = e9._zod.def;
  Q(i3.innerType, t4, r2);
  let a3 = t4.seen.get(e9);
  a3.ref = i3.innerType;
  let o3 = Gf(i3.defaultValue, e9, t4, n3, r2);
  o3 !== Wf && (n3.default = o3);
};
var qf = (e9, t4, n3, r2) => {
  let i3 = e9._zod.def;
  Q(i3.innerType, t4, r2);
  let a3 = t4.seen.get(e9);
  if (a3.ref = i3.innerType, t4.io !== `input`) return;
  let o3 = Gf(i3.defaultValue, e9, t4, n3, r2);
  o3 !== Wf && (n3._prefault = o3);
};
var Jf = (e9, t4, n3, r2) => {
  let i3 = e9._zod.def;
  Q(i3.innerType, t4, r2);
  let a3 = t4.seen.get(e9);
  a3.ref = i3.innerType;
  let o3;
  try {
    o3 = i3.catchValue(void 0);
  } catch {
    Z(e9, t4, n3, r2, `Dynamic catch values are not supported in JSON Schema`);
    return;
  }
  n3.default = o3;
};
var Yf = (e9, t4, n3, r2) => {
  let i3 = e9._zod.def, a3 = i3.in._zod.traits.has(`$ZodTransform`), o3 = t4.io === `input` ? a3 ? i3.out : i3.in : i3.out;
  Q(o3, t4, r2);
  let s3 = t4.seen.get(e9);
  s3.ref = o3;
};
var Xf = (e9, t4, n3, r2) => {
  let i3 = e9._zod.def;
  Q(i3.innerType, t4, r2);
  let a3 = t4.seen.get(e9);
  a3.ref = i3.innerType, n3.readOnly = true;
};
var Zf = (e9, t4, n3, r2) => {
  let i3 = e9._zod.def;
  Q(i3.innerType, t4, r2);
  let a3 = t4.seen.get(e9);
  a3.ref = i3.innerType;
};
var Qf = (e9, t4, n3, r2) => {
  let i3 = e9._zod.def;
  Q(i3.innerType, t4, r2);
  let a3 = t4.seen.get(e9);
  a3.ref = i3.innerType;
};
var $f = (e9, t4, n3, r2) => {
  let i3 = e9._zod.innerType;
  Q(i3, t4, r2);
  let a3 = t4.seen.get(e9);
  a3.ref = i3;
};
var ep = { string: lf, number: uf, boolean: df, bigint: ff, symbol: pf, null: mf, undefined: hf, void: gf, never: _f, any: vf, unknown: yf, date: bf, enum: xf, literal: Sf, nan: Cf, template_literal: wf, file: Tf, success: Ef, custom: Df, function: Of, transform: kf, map: Af, set: jf, array: Mf, object: Pf, union: Ff, intersection: If, tuple: Lf, record: Vf, nullable: Hf, nonoptional: Uf, default: Kf, prefault: qf, catch: Jf, pipe: Yf, readonly: Xf, promise: Zf, optional: Qf, lazy: $f };
function tp(e9, t4) {
  if (`_idmap` in e9) {
    let n4 = e9, r2 = X({ ...t4, processors: ep }), i3 = {};
    for (let e10 of n4._idmap.entries()) {
      let [t5, n5] = e10;
      Q(n5, r2);
    }
    let a3 = {};
    r2.external = { registry: n4, uri: t4?.uri, defs: i3 };
    for (let e10 of n4._idmap.entries()) {
      let [t5, n5] = e10;
      Zd(r2, n5), g(a3, t5, af(r2, n5));
    }
    return Object.keys(i3).length > 0 && (a3.__shared = { [r2.target === `draft-2020-12` ? `$defs` : `definitions`]: i3 }), { schemas: a3 };
  }
  let n3 = X({ ...t4, processors: ep });
  return Q(e9, n3), Zd(n3, e9), af(n3, e9);
}
var np = class {
  get metadataRegistry() {
    return this.ctx.metadataRegistry;
  }
  get target() {
    return this.ctx.target;
  }
  get unrepresentable() {
    return this.ctx.unrepresentable;
  }
  get override() {
    return this.ctx.override;
  }
  get io() {
    return this.ctx.io;
  }
  get counter() {
    return this.ctx.counter;
  }
  set counter(e9) {
    this.ctx.counter = e9;
  }
  get seen() {
    return this.ctx.seen;
  }
  constructor(e9) {
    let t4 = e9?.target ?? `draft-2020-12`;
    t4 === `draft-4` && (t4 = `draft-04`), t4 === `draft-7` && (t4 = `draft-07`), this.ctx = X({ processors: ep, target: t4, ...e9?.metadata && { metadata: e9.metadata }, ...e9?.unrepresentable && { unrepresentable: e9.unrepresentable }, ...e9?.override && { override: e9.override }, ...e9?.io && { io: e9.io } });
  }
  process(e9, t4 = { path: [], schemaPath: [] }) {
    return Q(e9, this.ctx, t4);
  }
  emit(e9, t4) {
    t4 && (t4.cycles && (this.ctx.cycles = t4.cycles), t4.reused && (this.ctx.reused = t4.reused), t4.external && (this.ctx.external = t4.external)), this.ctx.sharedDefsExtractedFor = void 0, this.ctx.sharedEmitDoneFor = void 0, Zd(this.ctx, e9);
    let { "~standard": n3, ...r2 } = af(this.ctx, e9);
    return r2;
  }
};
var rp = t({});
var ip = t({ $ZodAny: () => Ii, $ZodArray: () => Hi, $ZodAsyncError: () => A, $ZodBase64: () => _i, $ZodBase64URL: () => yi, $ZodBigInt: () => ji, $ZodBigIntFormat: () => Mi, $ZodBoolean: () => Ai, $ZodCIDRv4: () => pi, $ZodCIDRv6: () => hi, $ZodCUID: () => $r, $ZodCUID2: () => ei, $ZodCatch: () => ka, $ZodCheck: () => P, $ZodCheckBigIntFormat: () => _r, $ZodCheckEndsWith: () => Ar, $ZodCheckGreaterThan: () => mr, $ZodCheckIncludes: () => Or, $ZodCheckLengthEquals: () => Cr, $ZodCheckLessThan: () => pr, $ZodCheckLowerCase: () => Er, $ZodCheckMaxLength: () => xr, $ZodCheckMaxSize: () => vr, $ZodCheckMimeType: () => Nr, $ZodCheckMinLength: () => Sr, $ZodCheckMinSize: () => yr, $ZodCheckMultipleOf: () => hr, $ZodCheckNumberFormat: () => gr, $ZodCheckOverwrite: () => Pr, $ZodCheckProperty: () => Mr, $ZodCheckRegex: () => Tr, $ZodCheckSizeEquals: () => br, $ZodCheckStartsWith: () => kr, $ZodCheckStringFormat: () => wr, $ZodCheckUpperCase: () => Dr, $ZodCodec: () => Na, $ZodCreditCard: () => wi, $ZodCustom: () => Ua, $ZodCustomStringFormat: () => Di, $ZodCyclicError: () => Ga, $ZodDate: () => Bi, $ZodDefault: () => Sa, $ZodDiscriminatedUnion: () => ta, $ZodE164: () => bi, $ZodEmail: () => Hr, $ZodEmoji: () => Zr, $ZodEncodeError: () => at, $ZodEnum: () => ma, $ZodError: () => pt, $ZodExactOptional: () => ba, $ZodFile: () => ga, $ZodFunction: () => Ba, $ZodGUID: () => Br, $ZodIPv4: () => ci, $ZodIPv6: () => di, $ZodISODate: () => ai, $ZodISODateTime: () => ii, $ZodISODuration: () => si, $ZodISOTime: () => oi, $ZodIntersection: () => na, $ZodJWT: () => Ei, $ZodKSUID: () => ri, $ZodLazy: () => Ha, $ZodLiteral: () => ha, $ZodMAC: () => fi, $ZodMap: () => ua, $ZodNaN: () => Aa, $ZodNanoID: () => Qr, $ZodNever: () => Ri, $ZodNonOptional: () => Ta, $ZodNull: () => Fi, $ZodNullable: () => xa, $ZodNumber: () => Oi, $ZodNumberFormat: () => ki, $ZodObject: () => Ji, $ZodObjectJIT: () => Yi, $ZodOptional: () => ya, $ZodPipe: () => ja, $ZodPrefault: () => wa, $ZodPreprocess: () => Ia, $ZodPromise: () => Va, $ZodReadonly: () => La, $ZodRealError: () => N, $ZodRecord: () => la, $ZodRegistry: () => kc, $ZodSet: () => fa, $ZodString: () => zr, $ZodStringFormat: () => I, $ZodSuccess: () => Da, $ZodSymbol: () => Ni, $ZodTemplateLiteral: () => za, $ZodTransform: () => _a, $ZodTuple: () => aa, $ZodType: () => F, $ZodULID: () => ti, $ZodURL: () => Xr, $ZodUUID: () => Vr, $ZodUndefined: () => Pi, $ZodUnion: () => Zi, $ZodUnknown: () => Li, $ZodVoid: () => zi, $ZodXID: () => ni, $ZodXor: () => $i, $brand: () => it, $constructor: () => k, $input: () => Oc, $output: () => Dc, Doc: () => Fr, INVALID: () => R, JSONSchema: () => rp, JSONSchemaGenerator: () => np, NEVER: () => et, TimePrecision: () => pu, URL_BAD_FORMAT: () => 1, URL_UNPARSEABLE: () => 2, ZodCompileAsyncError: () => z, ZodCompileUnsupportedError: () => B, _any: () => Pu, _array: () => gd, _base64: () => cu, _base64url: () => lu, _bigint: () => Du, _boolean: () => Tu, _catch: () => Fd, _check: () => Wd, _cidrv4: () => ou, _cidrv6: () => su, _coercedBigint: () => Ou, _coercedBoolean: () => Eu, _coercedDate: () => zu, _coercedNumber: () => yu, _coercedString: () => Hl, _creditCard: () => du, _cuid: () => Ql, _cuid2: () => $l, _custom: () => Vd, _date: () => Ru, _decode: () => It, _decodeAsync: () => Bt, _default: () => Md, _discriminatedUnion: () => yd, _e164: () => uu, _email: () => Ul, _emoji: () => Xl, _encode: () => Pt, _encodeAsync: () => Rt, _endsWith: () => sd, _enum: () => Td, _file: () => Od, _float32: () => xu, _float64: () => Su, _gt: () => Uu, _gte: () => Wu, _guid: () => Wl, _includes: () => ad, _int: () => bu, _int32: () => Cu, _int64: () => ku, _intersection: () => bd, _ipv4: () => ru, _ipv6: () => iu, _isoDate: () => hu, _isoDateTime: () => mu, _isoDuration: () => _u, _isoTime: () => gu, _jwt: () => fu, _ksuid: () => nu, _lazy: () => zd, _length: () => td, _literal: () => Dd, _lowercase: () => rd, _lt: () => Vu, _lte: () => Hu, _mac: () => au, _map: () => Cd, _max: () => Hu, _maxLength: () => $u, _maxSize: () => Xu, _mime: () => ud, _min: () => Wu, _minLength: () => ed, _minSize: () => Zu, _multipleOf: () => Yu, _nan: () => Bu, _nanoid: () => Zl, _nativeEnum: () => Ed, _negative: () => Ku, _never: () => Iu, _nonnegative: () => Ju, _nonoptional: () => Nd, _nonpositive: () => qu, _normalize: () => dd, _null: () => Nu, _nullable: () => jd, _number: () => vu, _optional: () => Ad, _overwrite: () => Y, _parse: () => xt, _parseAsync: () => Ct, _pipe: () => Id, _positive: () => Gu, _promise: () => Bd, _properties: () => ld, _property: () => cd, _readonly: () => Ld, _record: () => Sd, _refine: () => Hd, _regex: () => nd, _safeDecode: () => Wt, _safeDecodeAsync: () => Jt, _safeEncode: () => Ht, _safeEncodeAsync: () => Kt, _safeParse: () => Tt, _safeParseAsync: () => Dt, _set: () => wd, _size: () => Qu, _slugify: () => hd, _startsWith: () => od, _string: () => Vl, _stringFormat: () => Jd, _stringbool: () => qd, _success: () => Pd, _superRefine: () => Ud, _symbol: () => ju, _templateLiteral: () => Rd, _toLowerCase: () => pd, _toUpperCase: () => md, _transform: () => kd, _trim: () => fd, _tuple: () => xd, _uint32: () => wu, _uint64: () => Au, _ulid: () => eu, _undefined: () => Mu, _union: () => _d, _unknown: () => Fu, _uppercase: () => id, _url: () => Yl, _uuid: () => Gl, _uuidv4: () => Kl, _uuidv6: () => ql, _uuidv7: () => Jl, _void: () => Lu, _xid: () => tu, _xor: () => vd, clone: () => x, compile: () => Nc, compileFn: () => Fc, config: () => M, createStandardJSONSchemaMethod: () => sf, createToJSONSchemaMethod: () => of, decode: () => Lt, decodeAsync: () => Vt, describe: () => Gd, encode: () => Ft, encodeAsync: () => zt, extractDefs: () => Zd, finalize: () => af, flattenError: () => ht, formatError: () => gt, getDiscriminatedOption: () => ea, globalConfig: () => j, globalRegistry: () => L, handleUnrepresentable: () => Z, initializeContext: () => X, isBackEdge: () => ro, isRecursiveSchema: () => Za, isValidBase64: () => gi, isValidBase64URL: () => vi, isValidCIDRv6: () => mi, isValidCreditCard: () => Ci, isValidIPv6: () => ui, isValidJWT: () => Ti, locales: () => Tc, memoizer: () => no, mergeValues: () => ra, meta: () => Kd, parse: () => St, parseAsync: () => wt, parseURLObject: () => Gr, prettifyError: () => yt, process: () => Q, regexes: () => Xt, registry: () => Ac, safeDecode: () => Gt, safeDecodeAsync: () => Yt, safeEncode: () => Ut, safeEncodeAsync: () => qt, safeParse: () => Et, safeParseAsync: () => Ot, standardProps: () => Rr, stripTabAndNewline: () => qr, toDotPath: () => vt, toJSONSchema: () => tp, toZod: () => i, treeifyError: () => _t, urlHostnameOk: () => Jr, urlProtocolOk: () => Yr, util: () => t2, validate: () => jt, validateAsync: () => Nt, version: () => Ir });

// node_modules/eve/dist/src/compiled/zod/index.js
var zi2 = t({ endsWith: () => sd, gt: () => Uu, gte: () => Wu, includes: () => ad, length: () => td, lowercase: () => rd, lt: () => Vu, lte: () => Hu, maxLength: () => $u, maxSize: () => Xu, mime: () => ud, minLength: () => ed, minSize: () => Zu, multipleOf: () => Yu, negative: () => Ku, nonnegative: () => Ju, nonpositive: () => qu, normalize: () => dd, overwrite: () => Y, positive: () => Gu, properties: () => ld, property: () => cd, regex: () => nd, size: () => Qu, slugify: () => hd, startsWith: () => od, toLowerCase: () => pd, toUpperCase: () => md, trim: () => fd, uppercase: () => id });
var Bi2 = new WeakSet([Object.prototype, Error.prototype]);
function Vi2(e9, t4, n3) {
  Object.defineProperty(e9, t4, { configurable: true, enumerable: false, get() {
    let e10 = n3(this);
    return Object.defineProperty(this, t4, { value: e10, configurable: true, writable: true }), e10;
  }, set(e10) {
    Object.defineProperty(this, t4, { value: e10, configurable: true, writable: true });
  } });
}
var Hi2 = (e9, t4) => {
  pt.init(e9, t4), e9.name = `ZodError`;
  let n3 = Object.getPrototypeOf(e9);
  Bi2.has(n3) || (Bi2.add(n3), Vi2(n3, `format`, (e10) => (t5) => gt(e10, t5)), Vi2(n3, `flatten`, (e10) => (t5) => ht(e10, t5)), Vi2(n3, `addIssue`, (e10) => (t5) => {
    e10.issues.push(t5), e10.message = JSON.stringify(e10.issues, u, 2);
  }), Vi2(n3, `addIssues`, (e10) => (t5) => {
    e10.issues.push(...t5), e10.message = JSON.stringify(e10.issues, u, 2);
  }), Object.defineProperty(n3, "isEmpty", { configurable: true, enumerable: false, get() {
    return this.issues.length === 0;
  } }));
};
var Ui2 = k(`ZodError`, Hi2);
var x2 = k(`ZodError`, Hi2, void 0, { Parent: Error });
var Wi2 = xt(x2);
var Gi2 = Ct(x2);
var Ki2 = Tt(x2);
var qi2 = Dt(x2);
var Ji2 = Pt(x2);
var Yi2 = It(x2);
var Xi2 = Rt(x2);
var Zi2 = Bt(x2);
var Qi2 = Ht(x2);
var $i2 = Wt(x2);
var ea2 = Kt(x2);
var ta2 = Jt(x2);
var na2 = t({ ZodAny: () => _o2, ZodArray: () => Eo2, ZodBase64: () => za2, ZodBase64URL: () => Va2, ZodBigInt: () => L2, ZodBigIntFormat: () => so2, ZodBoolean: () => I2, ZodCIDRv4: () => Fa2, ZodCIDRv6: () => La2, ZodCUID: () => ya2, ZodCUID2: () => xa2, ZodCatch: () => fs2, ZodCodec: () => Y2, ZodCreditCard: () => Ga2, ZodCustom: () => Z2, ZodCustomStringFormat: () => N2, ZodDate: () => wo2, ZodDefault: () => is2, ZodDiscriminatedUnion: () => No2, ZodE164: () => Ua2, ZodEmail: () => aa2, ZodEmoji: () => ha2, ZodEnum: () => W2, ZodExactOptional: () => es2, ZodFile: () => Xo2, ZodFunction: () => Os2, ZodGUID: () => sa2, ZodIPv4: () => ka2, ZodIPv6: () => Na2, ZodISODate: () => O2, ZodISODateTime: () => D2, ZodISODuration: () => A2, ZodISOTime: () => k2, ZodIntersection: () => Fo2, ZodJWT: () => qa2, ZodKSUID: () => Da2, ZodLazy: () => ws2, ZodLiteral: () => Jo2, ZodMAC: () => ja2, ZodMap: () => Ho2, ZodNaN: () => ms2, ZodNanoID: () => _a2, ZodNever: () => bo2, ZodNonOptional: () => cs2, ZodNull: () => ho2, ZodNullable: () => ns2, ZodNumber: () => P2, ZodNumberFormat: () => F2, ZodObject: () => B2, ZodOptional: () => G2, ZodPipe: () => J2, ZodPrefault: () => os2, ZodPreprocess: () => ys2, ZodPromise: () => Es2, ZodReadonly: () => bs2, ZodRecord: () => U2, ZodSet: () => Wo2, ZodString: () => w2, ZodStringFormat: () => E2, ZodSuccess: () => us2, ZodSymbol: () => uo2, ZodTemplateLiteral: () => Ss2, ZodTransform: () => Qo2, ZodTuple: () => Lo2, ZodType: () => C2, ZodULID: () => Ca2, ZodURL: () => M2, ZodUUID: () => j2, ZodUndefined: () => po2, ZodUnion: () => V2, ZodUnknown: () => yo2, ZodVoid: () => So2, ZodXID: () => Ta2, ZodXor: () => jo2, _ZodString: () => ia2, _default: () => as2, _function: () => X2, any: () => vo2, array: () => z2, base64: () => Ba2, base64url: () => Ha2, bigint: () => oo2, boolean: () => ao2, catch: () => ps2, check: () => ks2, cidrv4: () => Ia2, cidrv6: () => Ra2, codec: () => _s2, creditCard: () => Ka2, cuid: () => ba2, cuid2: () => Sa2, custom: () => As2, date: () => To2, describe: () => Ns2, discriminatedUnion: () => Po2, e164: () => Wa2, email: () => oa2, emoji: () => ga2, enum: () => Ko2, exactOptional: () => ts2, file: () => Zo2, float32: () => to2, float64: () => no2, function: () => X2, guid: () => ca2, hash: () => Qa2, hex: () => Za2, hostname: () => Xa2, httpUrl: () => ma2, instanceof: () => Fs2, int: () => eo2, int32: () => ro2, int64: () => co2, intersection: () => Io2, invertCodec: () => vs2, ipv4: () => Aa2, ipv6: () => Pa2, json: () => Ls2, jwt: () => Ja2, keyof: () => Do2, ksuid: () => Oa2, lazy: () => Ts2, literal: () => Yo2, looseObject: () => Ao2, looseRecord: () => Vo2, mac: () => Ma2, map: () => Uo2, meta: () => Ps2, nan: () => hs2, nanoid: () => va2, nativeEnum: () => qo2, never: () => xo2, nonoptional: () => ls2, null: () => go2, nullable: () => q2, nullish: () => rs2, number: () => $a2, object: () => Oo2, optional: () => K2, partialRecord: () => Bo2, pipe: () => gs2, prefault: () => ss2, preprocess: () => Rs2, promise: () => Ds2, readonly: () => xs2, record: () => zo2, refine: () => js2, set: () => Go2, strictObject: () => ko2, string: () => T2, stringFormat: () => Ya2, stringbool: () => Is2, success: () => ds2, superRefine: () => Ms2, symbol: () => fo2, templateLiteral: () => Cs2, transform: () => $o2, tuple: () => Ro2, uint32: () => io2, uint64: () => lo2, ulid: () => wa2, undefined: () => mo2, union: () => H2, unknown: () => R2, url: () => pa2, uuid: () => la2, uuidv4: () => ua2, uuidv6: () => da2, uuidv7: () => fa2, void: () => Co2, xid: () => Ea2, xor: () => Mo2 });
function ra2() {
  j.localeError || M(ko());
}
function S2() {
  j.memoizer || M({ memoizer: no() });
}
var C2 = k(`ZodType`, (e9, t4) => (ra2(), F.init(e9, t4), e9.def = t4, e9.type = t4.type, e9), { check(...e9) {
  let t4 = this.def;
  return this.clone(_(t4, { checks: [...t4.checks ?? [], ...e9.map((e10) => typeof e10 == `function` ? { _zod: { check: e10, def: { check: `custom` }, onattach: [] } } : e10)] }), { parent: true });
}, with(...e9) {
  return this.check(...e9);
}, clone(e9, t4) {
  return x(this, e9, t4);
}, brand() {
  return this;
}, register(e9, t4) {
  return e9.add(this, t4), this;
}, refine(e9, t4) {
  return this.check(js2(e9, t4));
}, superRefine(e9, t4) {
  return this.check(Ms2(e9, t4));
}, overwrite(e9) {
  return this.check(Y(e9));
}, optional() {
  return K2(this);
}, exactOptional() {
  return ts2(this);
}, nullable() {
  return q2(this);
}, nullish() {
  return K2(q2(this));
}, nonoptional(e9) {
  return ls2(this, e9);
}, array() {
  return z2(this);
}, or(e9) {
  return H2([this, e9]);
}, and(e9) {
  return Io2(this, e9);
}, transform(e9) {
  return gs2(this, $o2(e9));
}, default(e9) {
  return as2(this, e9);
}, prefault(e9) {
  return ss2(this, e9);
}, catch(e9) {
  return ps2(this, e9);
}, pipe(e9) {
  return gs2(this, e9);
}, readonly() {
  return xs2(this);
}, describe(e9) {
  let t4 = this.clone();
  return L.add(t4, { description: e9 }), t4;
}, meta(...e9) {
  if (e9.length === 0) return L.get(this);
  let t4 = this.clone();
  return L.add(t4, e9[0]), t4;
}, isOptional() {
  return this.safeParse(void 0).success;
}, isNullable() {
  return this.safeParse(null).success;
}, apply(e9, ...t4) {
  return t4.length === 0 ? e9(this) : e9(this, ...t4);
}, get "~standard"() {
  return We(this, `~standard`, { ...Rr(this), jsonSchema: { input: sf(this, `input`), output: sf(this, `output`) } });
}, set "~standard"(e9) {
  Ue(this, `~standard`, e9);
}, parse: function e2(t4, n3) {
  return Wi2(this, t4, n3, { callee: e2 });
}, parseAsync: async function e3(t4, n3) {
  return await Gi2(this, t4, n3, { callee: e3 });
}, safeParse(e9, t4) {
  return Ki2(this, e9, t4);
}, async safeParseAsync(e9, t4) {
  return qi2(this, e9, t4);
}, get spa() {
  return this?.safeParseAsync;
}, set spa(e9) {
  Ue(this, `spa`, e9);
}, encode: function e4(t4, n3) {
  return Ji2(this, t4, n3, { callee: e4 });
}, decode: function e5(t4, n3) {
  return Yi2(this, t4, n3, { callee: e5 });
}, encodeAsync: async function e6(t4, n3) {
  return await Xi2(this, t4, n3, { callee: e6 });
}, decodeAsync: async function e7(t4, n3) {
  return await Zi2(this, t4, n3, { callee: e7 });
}, safeEncode(e9, t4) {
  return Qi2(this, e9, t4);
}, safeDecode(e9, t4) {
  return $i2(this, e9, t4);
}, async safeEncodeAsync(e9, t4) {
  return ea2(this, e9, t4);
}, async safeDecodeAsync(e9, t4) {
  return ta2(this, e9, t4);
}, toJSONSchema(e9) {
  return of(this, {})(e9);
}, get description() {
  return L.get(this)?.description;
}, get _def() {
  return this._zod.def;
} });
var ia2 = k(`_ZodString`, (e9, t4) => {
  zr.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n4, r2) => lf(e9, t5, n4, r2);
  let n3 = e9._zod.bag;
  e9.format = n3.format ?? null, e9.minLength = n3.minimum ?? null, e9.maxLength = n3.maximum ?? null;
}, { regex(...e9) {
  return this.check(nd(...e9));
}, includes(...e9) {
  return this.check(ad(...e9));
}, startsWith(...e9) {
  return this.check(od(...e9));
}, endsWith(...e9) {
  return this.check(sd(...e9));
}, min(...e9) {
  return this.check(ed(...e9));
}, max(...e9) {
  return this.check($u(...e9));
}, length(...e9) {
  return this.check(td(...e9));
}, nonempty(...e9) {
  return this.check(ed(1, ...e9));
}, lowercase(e9) {
  return this.check(rd(e9));
}, uppercase(e9) {
  return this.check(id(e9));
}, trim() {
  return this.check(fd());
}, normalize(...e9) {
  return this.check(dd(...e9));
}, toLowerCase() {
  return this.check(pd());
}, toUpperCase() {
  return this.check(md());
}, slugify() {
  return this.check(hd());
} });
var w2 = k(`ZodString`, (e9, t4) => {
  zr.init(e9, t4), ia2.init(e9, t4);
}, { email(e9) {
  return this.check(Ul(aa2, e9));
}, url(e9) {
  return this.check(Yl(M2, e9));
}, jwt(e9) {
  return this.check(fu(qa2, e9));
}, emoji(e9) {
  return this.check(Xl(ha2, e9));
}, guid(e9) {
  return this.check(Wl(sa2, e9));
}, uuid(e9) {
  return this.check(Gl(j2, e9));
}, uuidv4(e9) {
  return this.check(Kl(j2, e9));
}, uuidv6(e9) {
  return this.check(ql(j2, e9));
}, uuidv7(e9) {
  return this.check(Jl(j2, e9));
}, nanoid(e9) {
  return this.check(Zl(_a2, e9));
}, cuid(e9) {
  return this.check(Ql(ya2, e9));
}, cuid2(e9) {
  return this.check($l(xa2, e9));
}, ulid(e9) {
  return this.check(eu(Ca2, e9));
}, base64(e9) {
  return this.check(cu(za2, e9));
}, base64url(e9) {
  return this.check(lu(Va2, e9));
}, xid(e9) {
  return this.check(tu(Ta2, e9));
}, ksuid(e9) {
  return this.check(nu(Da2, e9));
}, ipv4(e9) {
  return this.check(ru(ka2, e9));
}, ipv6(e9) {
  return this.check(iu(Na2, e9));
}, cidrv4(e9) {
  return this.check(ou(Fa2, e9));
}, cidrv6(e9) {
  return this.check(su(La2, e9));
}, e164(e9) {
  return this.check(uu(Ua2, e9));
}, datetime(e9) {
  return this.check(mu(D2, e9));
}, date(e9) {
  return this.check(hu(O2, e9));
}, time(e9) {
  return this.check(gu(k2, e9));
}, duration(e9) {
  return this.check(_u(A2, e9));
} });
function T2(e9) {
  return Vl(w2, e9);
}
var E2 = k(`ZodStringFormat`, (e9, t4) => {
  I.init(e9, t4), ia2.init(e9, t4);
});
var D2 = k(`ZodISODateTime`, (e9, t4) => {
  ii.init(e9, t4), E2.init(e9, t4);
});
var O2 = k(`ZodISODate`, (e9, t4) => {
  ai.init(e9, t4), E2.init(e9, t4);
});
var k2 = k(`ZodISOTime`, (e9, t4) => {
  oi.init(e9, t4), E2.init(e9, t4);
});
var A2 = k(`ZodISODuration`, (e9, t4) => {
  si.init(e9, t4), E2.init(e9, t4);
});
var aa2 = k(`ZodEmail`, (e9, t4) => {
  Hr.init(e9, t4), E2.init(e9, t4);
});
function oa2(e9) {
  return Ul(aa2, e9);
}
var sa2 = k(`ZodGUID`, (e9, t4) => {
  Br.init(e9, t4), E2.init(e9, t4);
});
function ca2(e9) {
  return Wl(sa2, e9);
}
var j2 = k(`ZodUUID`, (e9, t4) => {
  Vr.init(e9, t4), E2.init(e9, t4);
});
function la2(e9) {
  return Gl(j2, e9);
}
function ua2(e9) {
  return Kl(j2, e9);
}
function da2(e9) {
  return ql(j2, e9);
}
function fa2(e9) {
  return Jl(j2, e9);
}
var M2 = k(`ZodURL`, (e9, t4) => {
  Xr.init(e9, t4), E2.init(e9, t4);
});
function pa2(e9) {
  return Yl(M2, e9);
}
function ma2(e9) {
  return Yl(M2, { protocol: On, hostname: Dn, ...S(e9) });
}
var ha2 = k(`ZodEmoji`, (e9, t4) => {
  Zr.init(e9, t4), E2.init(e9, t4);
});
function ga2(e9) {
  return Xl(ha2, e9);
}
var _a2 = k(`ZodNanoID`, (e9, t4) => {
  Qr.init(e9, t4), E2.init(e9, t4);
});
function va2(e9) {
  return Zl(_a2, e9);
}
var ya2 = k(`ZodCUID`, (e9, t4) => {
  $r.init(e9, t4), E2.init(e9, t4);
});
function ba2(e9) {
  return Ql(ya2, e9);
}
var xa2 = k(`ZodCUID2`, (e9, t4) => {
  ei.init(e9, t4), E2.init(e9, t4);
});
function Sa2(e9) {
  return $l(xa2, e9);
}
var Ca2 = k(`ZodULID`, (e9, t4) => {
  ti.init(e9, t4), E2.init(e9, t4);
});
function wa2(e9) {
  return eu(Ca2, e9);
}
var Ta2 = k(`ZodXID`, (e9, t4) => {
  ni.init(e9, t4), E2.init(e9, t4);
});
function Ea2(e9) {
  return tu(Ta2, e9);
}
var Da2 = k(`ZodKSUID`, (e9, t4) => {
  ri.init(e9, t4), E2.init(e9, t4);
});
function Oa2(e9) {
  return nu(Da2, e9);
}
var ka2 = k(`ZodIPv4`, (e9, t4) => {
  ci.init(e9, t4), E2.init(e9, t4);
});
function Aa2(e9) {
  return ru(ka2, e9);
}
var ja2 = k(`ZodMAC`, (e9, t4) => {
  fi.init(e9, t4), E2.init(e9, t4);
});
function Ma2(e9) {
  return au(ja2, e9);
}
var Na2 = k(`ZodIPv6`, (e9, t4) => {
  di.init(e9, t4), E2.init(e9, t4);
});
function Pa2(e9) {
  return iu(Na2, e9);
}
var Fa2 = k(`ZodCIDRv4`, (e9, t4) => {
  pi.init(e9, t4), E2.init(e9, t4);
});
function Ia2(e9) {
  return ou(Fa2, e9);
}
var La2 = k(`ZodCIDRv6`, (e9, t4) => {
  hi.init(e9, t4), E2.init(e9, t4);
});
function Ra2(e9) {
  return su(La2, e9);
}
var za2 = k(`ZodBase64`, (e9, t4) => {
  _i.init(e9, t4), E2.init(e9, t4);
});
function Ba2(e9) {
  return cu(za2, e9);
}
var Va2 = k(`ZodBase64URL`, (e9, t4) => {
  yi.init(e9, t4), E2.init(e9, t4);
});
function Ha2(e9) {
  return lu(Va2, e9);
}
var Ua2 = k(`ZodE164`, (e9, t4) => {
  bi.init(e9, t4), E2.init(e9, t4);
});
function Wa2(e9) {
  return uu(Ua2, e9);
}
var Ga2 = k(`ZodCreditCard`, (e9, t4) => {
  wi.init(e9, t4), E2.init(e9, t4);
});
function Ka2(e9) {
  return du(Ga2, e9);
}
var qa2 = k(`ZodJWT`, (e9, t4) => {
  Ei.init(e9, t4), E2.init(e9, t4);
});
function Ja2(e9) {
  return fu(qa2, e9);
}
var N2 = k(`ZodCustomStringFormat`, (e9, t4) => {
  Di.init(e9, t4), E2.init(e9, t4);
});
function Ya2(e9, t4, n3 = {}) {
  return Jd(N2, e9, t4, n3);
}
function Xa2(e9) {
  return Jd(N2, `hostname`, En, e9);
}
function Za2(e9) {
  return Jd(N2, `hex`, Kn, e9);
}
function Qa2(e9, t4) {
  let n3 = `${e9}_${t4?.enc ?? `hex`}`, r2 = Xt[n3];
  if (!r2) throw Error(`Unrecognized hash format: ${n3}`);
  return Jd(N2, n3, r2, t4);
}
var P2 = k(`ZodNumber`, (e9, t4) => {
  Oi.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n4, r2) => uf(e9, t5, n4, r2);
  let n3 = e9._zod.bag;
  e9.minValue = Math.max(n3.minimum ?? -1 / 0, n3.exclusiveMinimum ?? -1 / 0) ?? null, e9.maxValue = Math.min(n3.maximum ?? 1 / 0, n3.exclusiveMaximum ?? 1 / 0) ?? null, e9.isInt = (n3.format ?? ``).includes(`int`) || Number.isSafeInteger(n3.multipleOf ?? 0.5), e9.isFinite = true, e9.format = n3.format ?? null;
}, { gt(e9, t4) {
  return this.check(Uu(e9, t4));
}, gte(e9, t4) {
  return this.check(Wu(e9, t4));
}, min(e9, t4) {
  return this.check(Wu(e9, t4));
}, lt(e9, t4) {
  return this.check(Vu(e9, t4));
}, lte(e9, t4) {
  return this.check(Hu(e9, t4));
}, max(e9, t4) {
  return this.check(Hu(e9, t4));
}, int(e9) {
  return this.check(eo2(e9));
}, safe(e9) {
  return this.check(eo2(e9));
}, positive(e9) {
  return this.check(Uu(0, e9));
}, nonnegative(e9) {
  return this.check(Wu(0, e9));
}, negative(e9) {
  return this.check(Vu(0, e9));
}, nonpositive(e9) {
  return this.check(Hu(0, e9));
}, multipleOf(e9, t4) {
  return this.check(Yu(e9, t4));
}, step(e9, t4) {
  return this.check(Yu(e9, t4));
}, finite() {
  return this;
} });
function $a2(e9) {
  return vu(P2, e9);
}
var F2 = k(`ZodNumberFormat`, (e9, t4) => {
  ki.init(e9, t4), P2.init(e9, t4);
});
function eo2(e9) {
  return bu(F2, e9);
}
function to2(e9) {
  return xu(F2, e9);
}
function no2(e9) {
  return Su(F2, e9);
}
function ro2(e9) {
  return Cu(F2, e9);
}
function io2(e9) {
  return wu(F2, e9);
}
var I2 = k(`ZodBoolean`, (e9, t4) => {
  Ai.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => df(e9, t5, n3, r2);
});
function ao2(e9) {
  return Tu(I2, e9);
}
var L2 = k(`ZodBigInt`, (e9, t4) => {
  ji.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n4, r2) => ff(e9, t5, n4, r2);
  let n3 = e9._zod.bag;
  e9.minValue = n3.minimum ?? null, e9.maxValue = n3.maximum ?? null, e9.format = n3.format ?? null;
}, { gte(e9, t4) {
  return this.check(Wu(e9, t4));
}, min(e9, t4) {
  return this.check(Wu(e9, t4));
}, gt(e9, t4) {
  return this.check(Uu(e9, t4));
}, lt(e9, t4) {
  return this.check(Vu(e9, t4));
}, lte(e9, t4) {
  return this.check(Hu(e9, t4));
}, max(e9, t4) {
  return this.check(Hu(e9, t4));
}, positive(e9) {
  return this.check(Uu(BigInt(0), e9));
}, negative(e9) {
  return this.check(Vu(BigInt(0), e9));
}, nonpositive(e9) {
  return this.check(Hu(BigInt(0), e9));
}, nonnegative(e9) {
  return this.check(Wu(BigInt(0), e9));
}, multipleOf(e9, t4) {
  return this.check(Yu(e9, t4));
} });
function oo2(e9) {
  return Du(L2, e9);
}
var so2 = k(`ZodBigIntFormat`, (e9, t4) => {
  Mi.init(e9, t4), L2.init(e9, t4);
});
function co2(e9) {
  return ku(so2, e9);
}
function lo2(e9) {
  return Au(so2, e9);
}
var uo2 = k(`ZodSymbol`, (e9, t4) => {
  Ni.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => pf(e9, t5, n3, r2);
});
function fo2(e9) {
  return ju(uo2, e9);
}
var po2 = k(`ZodUndefined`, (e9, t4) => {
  Pi.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => hf(e9, t5, n3, r2);
});
function mo2(e9) {
  return Mu(po2, e9);
}
var ho2 = k(`ZodNull`, (e9, t4) => {
  Fi.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => mf(e9, t5, n3, r2);
});
function go2(e9) {
  return Nu(ho2, e9);
}
var _o2 = k(`ZodAny`, (e9, t4) => {
  Ii.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => vf(e9, t5, n3, r2);
});
function vo2() {
  return Pu(_o2);
}
var yo2 = k(`ZodUnknown`, (e9, t4) => {
  Li.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => yf(e9, t5, n3, r2);
});
function R2() {
  return Fu(yo2);
}
var bo2 = k(`ZodNever`, (e9, t4) => {
  Ri.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => _f(e9, t5, n3, r2);
});
function xo2(e9) {
  return Iu(bo2, e9);
}
var So2 = k(`ZodVoid`, (e9, t4) => {
  zi.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => gf(e9, t5, n3, r2);
});
function Co2(e9) {
  return Lu(So2, e9);
}
var wo2 = k(`ZodDate`, (e9, t4) => {
  Bi.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n4, r2) => bf(e9, t5, n4, r2), e9.min = (t5, n4) => e9.check(Wu(t5, n4)), e9.max = (t5, n4) => e9.check(Hu(t5, n4));
  let n3 = e9._zod.bag;
  e9.minDate = n3.minimum ? new Date(n3.minimum) : null, e9.maxDate = n3.maximum ? new Date(n3.maximum) : null;
});
function To2(e9) {
  return Ru(wo2, e9);
}
var Eo2 = k(`ZodArray`, (e9, t4) => {
  S2(), Hi.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Mf(e9, t5, n3, r2), e9.element = t4.element;
}, { min(e9, t4) {
  return this.check(ed(e9, t4));
}, nonempty(e9) {
  return this.check(ed(1, e9));
}, max(e9, t4) {
  return this.check($u(e9, t4));
}, length(e9, t4) {
  return this.check(td(e9, t4));
}, unwrap() {
  return this.element;
} });
function z2(e9, n3) {
  return gd(Eo2, e9, n3);
}
function Do2(e9) {
  let t4 = e9._zod.def.shape;
  return Ko2(Object.keys(t4));
}
var B2 = k(`ZodObject`, (e9, t4) => {
  S2(), Yi.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Pf(e9, t5, n3, r2), Xe(e9, `shape`, (e10) => e10._zod.def.shape, false);
}, { keyof() {
  return Ko2(Object.keys(this._zod.def.shape));
}, catchall(e9) {
  return this.clone({ ...this._zod.def, catchall: e9 });
}, passthrough() {
  return this.clone({ ...this._zod.def, catchall: R2() });
}, loose() {
  return this.clone({ ...this._zod.def, catchall: R2() });
}, strict() {
  return this.clone({ ...this._zod.def, catchall: xo2() });
}, strip() {
  return this.clone({ ...this._zod.def, catchall: void 0 });
}, extend(e9) {
  return xe(this, e9);
}, safeExtend(e9) {
  return Se(this, e9);
}, merge(e9) {
  return Ce(this, e9);
}, pick(e9) {
  return ye(this, e9);
}, omit(e9) {
  return be(this, e9);
}, partial(...e9) {
  return we(G2, this, e9[0]);
}, exactPartial(...e9) {
  return we(es2, this, e9[0], `exactPartial`);
}, required(...e9) {
  return Te(cs2, this, e9[0]);
} });
function Oo2(e9, t4) {
  let n3 = { type: `object`, shape: e9 ?? {}, ...S(t4) };
  return new B2(n3);
}
function ko2(e9, t4) {
  return new B2({ type: `object`, shape: e9, catchall: xo2(), ...S(t4) });
}
function Ao2(e9, t4) {
  return new B2({ type: `object`, shape: e9, catchall: R2(), ...S(t4) });
}
var V2 = k(`ZodUnion`, (e9, t4) => {
  Zi.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Ff(e9, t5, n3, r2), e9.options = t4.options;
});
function H2(e9, t4) {
  return new V2({ type: `union`, options: e9, ...S(t4) });
}
var jo2 = k(`ZodXor`, (e9, t4) => {
  V2.init(e9, t4), $i.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Ff(e9, t5, n3, r2), e9.options = t4.options;
});
function Mo2(e9, t4) {
  return new jo2({ type: `union`, options: e9, inclusive: false, ...S(t4) });
}
var No2 = k(`ZodDiscriminatedUnion`, (e9, t4) => {
  V2.init(e9, t4), ta.init(e9, t4);
});
function Po2(e9, t4, n3) {
  return new No2({ type: `union`, options: t4, discriminator: e9, ...S(n3) });
}
var Fo2 = k(`ZodIntersection`, (e9, t4) => {
  na.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => If(e9, t5, n3, r2);
});
function Io2(e9, t4) {
  return new Fo2({ type: `intersection`, left: e9, right: t4 });
}
var Lo2 = k(`ZodTuple`, (e9, t4) => {
  S2(), aa.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Lf(e9, t5, n3, r2);
}, { rest(e9) {
  return this.clone({ ...this._zod.def, rest: e9 });
}, partial() {
  let e9 = this._zod.def;
  if (e9.checks?.length) throw Error(`.partial() cannot be used on tuple schemas containing refinements`);
  return this.clone({ ...e9, items: e9.items.map((e10) => new G2({ type: `optional`, innerType: e10 })) });
} });
function Ro2(e9, t4, n3) {
  let r2 = t4 instanceof F;
  return new Lo2({ type: `tuple`, items: e9, rest: r2 ? t4 : null, ...S(r2 ? n3 : t4) });
}
var U2 = k(`ZodRecord`, (e9, t4) => {
  S2(), la.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Vf(e9, t5, n3, r2), e9.keyType = t4.keyType, e9.valueType = t4.valueType;
});
function zo2(e9, t4, n3) {
  return !t4 || !t4._zod ? new U2({ type: `record`, keyType: T2(), valueType: e9, ...S(t4) }) : new U2({ type: `record`, keyType: e9, valueType: t4, ...S(n3) });
}
function Bo2(e9, t4, n3) {
  return new U2({ type: `record`, keyType: e9, valueType: t4, ...S(n3), partial: true });
}
function Vo2(e9, t4, n3) {
  return new U2({ type: `record`, keyType: e9, valueType: t4, mode: `loose`, ...S(n3) });
}
var Ho2 = k(`ZodMap`, (e9, t4) => {
  S2(), ua.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Af(e9, t5, n3, r2), e9.keyType = t4.keyType, e9.valueType = t4.valueType, e9.min = (...t5) => e9.check(Zu(...t5)), e9.nonempty = (t5) => e9.check(Zu(1, t5)), e9.max = (...t5) => e9.check(Xu(...t5)), e9.size = (...t5) => e9.check(Qu(...t5));
});
function Uo2(e9, t4, n3) {
  return new Ho2({ type: `map`, keyType: e9, valueType: t4, ...S(n3) });
}
var Wo2 = k(`ZodSet`, (e9, t4) => {
  S2(), fa.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => jf(e9, t5, n3, r2), e9.min = (...t5) => e9.check(Zu(...t5)), e9.nonempty = (t5) => e9.check(Zu(1, t5)), e9.max = (...t5) => e9.check(Xu(...t5)), e9.size = (...t5) => e9.check(Qu(...t5));
});
function Go2(e9, t4) {
  return new Wo2({ type: `set`, valueType: e9, ...S(t4) });
}
var W2 = k(`ZodEnum`, (e9, t4) => {
  ma.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n4, r2) => xf(e9, t5, n4, r2), e9.enum = t4.entries, e9.options = Object.values(t4.entries);
  let n3 = new Set(Object.keys(t4.entries));
  e9.extract = (e10, r2) => {
    let i3 = {};
    for (let r3 of e10) if (n3.has(r3)) i3[r3] = t4.entries[r3];
    else throw Error(`Key ${r3} not found in enum`);
    return new W2({ ...t4, checks: [], ...S(r2), entries: i3 });
  }, e9.exclude = (e10, r2) => {
    let i3 = { ...t4.entries };
    for (let t5 of e10) if (n3.has(t5)) delete i3[t5];
    else throw Error(`Key ${t5} not found in enum`);
    return new W2({ ...t4, checks: [], ...S(r2), entries: i3 });
  };
});
function Ko2(e9, t4) {
  let n3 = Array.isArray(e9) ? Object.fromEntries(e9.map((e10) => [e10, e10])) : e9;
  return new W2({ type: `enum`, entries: n3, ...S(t4) });
}
function qo2(e9, t4) {
  return new W2({ type: `enum`, entries: e9, ...S(t4) });
}
var Jo2 = k(`ZodLiteral`, (e9, t4) => {
  ha.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Sf(e9, t5, n3, r2), e9.values = new Set(t4.values), Object.defineProperty(e9, "value", { get() {
    if (t4.values.length > 1) throw Error("This schema contains multiple valid literal values. Use `.values` instead.");
    return t4.values[0];
  } });
});
function Yo2(e9, t4) {
  return new Jo2({ type: `literal`, values: Array.isArray(e9) ? e9 : [e9], ...S(t4) });
}
var Xo2 = k(`ZodFile`, (e9, t4) => {
  ga.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Tf(e9, t5, n3, r2), e9.min = (t5, n3) => e9.check(Zu(t5, n3)), e9.max = (t5, n3) => e9.check(Xu(t5, n3)), e9.mime = (t5, n3) => e9.check(ud(Array.isArray(t5) ? t5 : [t5], n3));
});
function Zo2(e9) {
  return Od(Xo2, e9);
}
var Qo2 = k(`ZodTransform`, (e9, t4) => {
  S2(), _a.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => kf(e9, t5, n3, r2), e9._zod.parse = (n3, r2) => {
    if (r2.direction === `backward`) throw new at(e9.constructor.name);
    n3.addIssue = (r3) => {
      if (typeof r3 == `string`) n3.issues.push(Ne(r3, n3.value, t4));
      else {
        let t5 = r3;
        t5.fatal && (t5.continue = false), t5.code ??= `custom`, `input` in t5 || (t5.input = n3.value), t5.inst ??= e9, n3.issues.push(Ne(t5));
      }
    };
    let i3 = t4.transform(n3.value, n3);
    return i3 instanceof Promise ? i3.then((e10) => (n3.value = e10, n3)) : (n3.value = i3, n3);
  };
});
function $o2(e9) {
  return new Qo2({ type: `transform`, transform: e9 });
}
var G2 = k(`ZodOptional`, (e9, t4) => {
  ya.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Qf(e9, t5, n3, r2), e9.unwrap = () => e9._zod.def.innerType;
});
function K2(e9) {
  return new G2({ type: `optional`, innerType: e9 });
}
var es2 = k(`ZodExactOptional`, (e9, t4) => {
  ba.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Qf(e9, t5, n3, r2), e9.unwrap = () => e9._zod.def.innerType;
});
function ts2(e9) {
  return new es2({ type: `optional`, innerType: e9 });
}
var ns2 = k(`ZodNullable`, (e9, t4) => {
  xa.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Hf(e9, t5, n3, r2), e9.unwrap = () => e9._zod.def.innerType;
});
function q2(e9) {
  return new ns2({ type: `nullable`, innerType: e9 });
}
function rs2(e9) {
  return K2(q2(e9));
}
var is2 = k(`ZodDefault`, (e9, t4) => {
  Sa.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Kf(e9, t5, n3, r2), e9.unwrap = () => e9._zod.def.innerType, e9.removeDefault = e9.unwrap;
});
function as2(e9, t4) {
  return new is2({ type: `default`, innerType: e9, get defaultValue() {
    return typeof t4 == `function` ? t4() : ue(t4);
  } });
}
var os2 = k(`ZodPrefault`, (e9, t4) => {
  wa.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => qf(e9, t5, n3, r2), e9.unwrap = () => e9._zod.def.innerType;
});
function ss2(e9, t4) {
  return new os2({ type: `prefault`, innerType: e9, get defaultValue() {
    return typeof t4 == `function` ? t4() : ue(t4);
  } });
}
var cs2 = k(`ZodNonOptional`, (e9, t4) => {
  Ta.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Uf(e9, t5, n3, r2), e9.unwrap = () => e9._zod.def.innerType;
});
function ls2(e9, t4) {
  return new cs2({ type: `nonoptional`, innerType: e9, ...S(t4) });
}
var us2 = k(`ZodSuccess`, (e9, t4) => {
  Da.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Ef(e9, t5, n3, r2), e9.unwrap = () => e9._zod.def.innerType;
});
function ds2(e9) {
  return new us2({ type: `success`, innerType: e9 });
}
var fs2 = k(`ZodCatch`, (e9, t4) => {
  ka.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Jf(e9, t5, n3, r2), e9.unwrap = () => e9._zod.def.innerType, e9.removeCatch = e9.unwrap;
});
function ps2(e9, t4) {
  return new fs2({ type: `catch`, innerType: e9, catchValue: typeof t4 == `function` ? t4 : Qe(t4) });
}
var ms2 = k(`ZodNaN`, (e9, t4) => {
  Aa.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Cf(e9, t5, n3, r2);
});
function hs2(e9) {
  return Bu(ms2, e9);
}
var J2 = k(`ZodPipe`, (e9, t4) => {
  ja.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Yf(e9, t5, n3, r2), e9.in = t4.in, e9.out = t4.out;
});
function gs2(e9, t4) {
  return new J2({ type: `pipe`, in: e9, out: t4 });
}
var Y2 = k(`ZodCodec`, (e9, t4) => {
  J2.init(e9, t4), Na.init(e9, t4);
});
function _s2(e9, t4, n3) {
  return new Y2({ type: `pipe`, in: e9, out: t4, transform: n3.decode, reverseTransform: n3.encode });
}
function vs2(e9) {
  let t4 = e9._zod.def;
  return new Y2({ type: `pipe`, in: t4.out, out: t4.in, transform: t4.reverseTransform, reverseTransform: t4.transform });
}
var ys2 = k(`ZodPreprocess`, (e9, t4) => {
  J2.init(e9, t4), Ia.init(e9, t4);
});
var bs2 = k(`ZodReadonly`, (e9, t4) => {
  La.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Xf(e9, t5, n3, r2), e9.unwrap = () => e9._zod.def.innerType;
});
function xs2(e9) {
  return new bs2({ type: `readonly`, innerType: e9 });
}
var Ss2 = k(`ZodTemplateLiteral`, (e9, t4) => {
  za.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => wf(e9, t5, n3, r2);
});
function Cs2(e9, t4) {
  return new Ss2({ type: `template_literal`, parts: e9, ...S(t4) });
}
var ws2 = k(`ZodLazy`, (e9, t4) => {
  Ha.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => $f(e9, t5, n3, r2), e9.unwrap = () => e9._zod.def.getter();
});
function Ts2(e9) {
  return new ws2({ type: `lazy`, getter: e9 });
}
var Es2 = k(`ZodPromise`, (e9, t4) => {
  Va.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Zf(e9, t5, n3, r2), e9.unwrap = () => e9._zod.def.innerType;
});
function Ds2(e9) {
  return new Es2({ type: `promise`, innerType: e9 });
}
var Os2 = k(`ZodFunction`, (e9, t4) => {
  Ba.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Of(e9, t5, n3, r2);
});
function X2(e9) {
  return new Os2({ type: `function`, input: Array.isArray(e9?.input) ? Ro2(e9?.input) : e9?.input ?? z2(R2()), output: e9?.output ?? R2() });
}
var Z2 = k(`ZodCustom`, (e9, t4) => {
  Ua.init(e9, t4), C2.init(e9, t4), e9._zod.processJSONSchema = (t5, n3, r2) => Df(e9, t5, n3, r2);
});
function ks2(e9) {
  let t4 = new P({ check: `custom` });
  return t4._zod.check = e9, t4;
}
function As2(e9, t4) {
  return Vd(Z2, e9 ?? (() => true), t4);
}
function js2(e9, t4 = {}) {
  return Hd(Z2, e9, t4);
}
function Ms2(e9, t4) {
  return Ud(e9, t4);
}
var Ns2 = Gd;
var Ps2 = Kd;
function Fs2(e9, t4 = {}) {
  let n3 = new Z2({ type: `custom`, check: `custom`, fn: (t5) => t5 instanceof e9, abort: true, ...S(t4) });
  return n3._zod.bag.Class = e9, n3._zod.check = (t5) => {
    t5.value instanceof e9 || t5.issues.push({ code: `invalid_type`, expected: e9.name, input: t5.value, inst: n3, path: [...n3._zod.def.path ?? []] });
  }, n3;
}
var Is2 = (...e9) => qd({ Codec: Y2, Boolean: I2, String: w2 }, ...e9);
function Ls2(e9) {
  let t4 = Ts2(() => H2([T2(e9), $a2(), ao2(), go2(), z2(t4), zo2(T2(), t4)]));
  return t4;
}
function Rs2(e9, t4) {
  return new ys2({ type: `pipe`, in: $o2(e9), out: t4 });
}
var zs2 = { invalid_type: `invalid_type`, too_big: `too_big`, too_small: `too_small`, invalid_format: `invalid_format`, not_multiple_of: `not_multiple_of`, unrecognized_keys: `unrecognized_keys`, invalid_union: `invalid_union`, invalid_key: `invalid_key`, invalid_element: `invalid_element`, invalid_value: `invalid_value`, custom: `custom` };
function Bs2(e9) {
  M({ customError: e9 });
}
function Vs2() {
  return M().customError;
}
var Hs2;
Hs2 ||= {};
var Us2 = t({ ZodISODate: () => O2, ZodISODateTime: () => D2, ZodISODuration: () => A2, ZodISOTime: () => k2, date: () => Gs2, datetime: () => Ws2, duration: () => qs2, time: () => Ks2 });
function Ws2(e9) {
  return mu(D2, e9);
}
function Gs2(e9) {
  return hu(O2, e9);
}
function Ks2(e9) {
  return gu(k2, e9);
}
function qs2(e9) {
  return _u(A2, e9);
}
var Q2 = { ...na2, ...zi2, iso: Us2 };
var Js2 = new Set(`$schema.$ref.$defs.definitions.$id.id.$comment.$anchor.$vocabulary.$dynamicRef.$dynamicAnchor.type.enum.const.anyOf.oneOf.allOf.not.properties.required.additionalProperties.patternProperties.propertyNames.minProperties.maxProperties.items.prefixItems.additionalItems.minItems.maxItems.uniqueItems.contains.minContains.maxContains.minLength.maxLength.pattern.format.minimum.maximum.exclusiveMinimum.exclusiveMaximum.multipleOf.description.default.contentEncoding.contentMediaType.contentSchema.unevaluatedItems.unevaluatedProperties.if.then.else.dependentSchemas.dependentRequired.nullable.readOnly`.split(`.`));
function Ys2(e9, t4) {
  let n3 = e9.$schema;
  return n3 === `https://json-schema.org/draft/2020-12/schema` ? `draft-2020-12` : n3 === `http://json-schema.org/draft-07/schema#` ? `draft-7` : n3 === `http://json-schema.org/draft-04/schema#` ? `draft-4` : t4 ?? `draft-2020-12`;
}
function Xs2(e9, t4) {
  return e9.map((e10, n3) => n3 < t4 ? e10 : e10.optional());
}
function Zs2(e9) {
  return e9.replace(/~1/g, `/`).replace(/~0/g, `~`);
}
function Qs2(e9, t4) {
  if (!e9.startsWith(`#`)) throw Error(`External $ref is not supported, only local refs (#/...) are allowed`);
  let n3 = e9.slice(1).split(`/`).filter(Boolean);
  if (n3.length === 0) return t4.rootSchema;
  let r2 = t4.version === `draft-2020-12` ? `$defs` : `definitions`;
  if (n3[0] === r2) {
    let r3 = n3[1] === void 0 ? void 0 : Zs2(n3[1]);
    if (!r3 || !t4.defs[r3]) throw Error(`Reference not found: ${e9}`);
    return t4.defs[r3];
  }
  throw Error(`Reference not found: ${e9}`);
}
function $s2(e9, t4) {
  return Q2.transform((e10) => e10).check((e10) => {
    let n3 = e10.value;
    if (typeof n3 == `object` && n3 && !Array.isArray(n3)) for (let r2 of Object.getOwnPropertyNames(n3)) {
      let n4 = t4.safeParse(r2);
      n4.success || e10.issues.push({ code: `invalid_key`, origin: `record`, issues: n4.error.issues, input: r2, path: [r2], continue: true });
    }
  }).pipe(e9);
}
function ec2(e9, t4) {
  if (e9 !== false) return e9 === void 0 || e9 === true ? Q2.any() : $2(e9, t4);
}
var tc2 = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
function nc2(e9, t4) {
  if (e9.not !== void 0) {
    if (typeof e9.not == `object` && Object.keys(e9.not).length === 0) return Q2.never();
    throw Error(`not is not supported in Zod (except { not: {} } for never)`);
  }
  if (e9.unevaluatedItems !== void 0) throw Error(`unevaluatedItems is not supported`);
  if (e9.unevaluatedProperties !== void 0) throw Error(`unevaluatedProperties is not supported`);
  if (e9.if !== void 0 || e9.then !== void 0 || e9.else !== void 0) throw Error(`Conditional schemas (if/then/else) are not supported`);
  if (e9.dependentSchemas !== void 0 || e9.dependentRequired !== void 0) throw Error(`dependentSchemas and dependentRequired are not supported`);
  if (e9.$ref) {
    let n4 = e9.$ref;
    if (t4.refs.has(n4)) return t4.refs.get(n4);
    if (t4.processing.has(n4)) return Q2.lazy(() => {
      if (!t4.refs.has(n4)) throw Error(`Circular reference not resolved: ${n4}`);
      return t4.refs.get(n4);
    });
    t4.processing.add(n4);
    let r3 = $2(Qs2(n4, t4), t4);
    return t4.refs.set(n4, r3), t4.processing.delete(n4), r3;
  }
  if (e9.enum !== void 0) {
    let n4 = e9.enum;
    if (t4.version === `openapi-3.0` && e9.nullable === true && n4.length === 1 && n4[0] === null) return Q2.null();
    if (n4.length === 0) return Q2.never();
    if (n4.length === 1) return Q2.literal(n4[0]);
    if (n4.every((e10) => typeof e10 == `string`)) return Q2.enum(n4);
    let r3 = n4.map((e10) => Q2.literal(e10));
    return r3.length < 2 ? r3[0] : Q2.union([r3[0], r3[1], ...r3.slice(2)]);
  }
  if (e9.const !== void 0) return Q2.literal(e9.const);
  let n3 = e9.type;
  if (Array.isArray(n3)) {
    let r3 = n3.map((n4) => nc2({ ...e9, type: n4 }, t4));
    return r3.length === 0 ? Q2.never() : r3.length === 1 ? r3[0] : Q2.union(r3);
  }
  if (!n3) return Q2.any();
  let r2;
  switch (n3) {
    case `string`: {
      let t5 = Q2.string();
      if (e9.format) {
        let n4 = e9.format;
        n4 === `email` ? t5 = t5.check(Q2.email()) : n4 === `uri` || n4 === `uri-reference` ? t5 = t5.check(Q2.url()) : n4 === `uuid` || n4 === `guid` ? t5 = t5.check(Q2.uuid()) : n4 === `date-time` ? t5 = t5.check(Q2.iso.datetime({ offset: true })) : n4 === `date` ? t5 = t5.check(Q2.iso.date()) : n4 === `time` ? t5 = t5.check(Q2.regex(tc2)) : n4 === `duration` ? t5 = t5.check(Q2.iso.duration()) : n4 === `hostname` ? t5 = t5.check(Q2.hostname()) : n4 === `ipv4` ? t5 = t5.check(Q2.ipv4()) : n4 === `ipv6` ? t5 = t5.check(Q2.ipv6()) : n4 === `mac` ? t5 = t5.check(Q2.mac()) : n4 === `cidr` ? t5 = t5.check(Q2.cidrv4()) : n4 === `cidr-v6` ? t5 = t5.check(Q2.cidrv6()) : n4 === `base64` ? t5 = t5.check(Q2.base64()) : n4 === `base64url` ? t5 = t5.check(Q2.base64url()) : n4 === `e164` ? t5 = t5.check(Q2.e164()) : n4 === `credit_card` ? t5 = t5.check(Q2.creditCard()) : n4 === `jwt` ? t5 = t5.check(Q2.jwt()) : n4 === `emoji` ? t5 = t5.check(Q2.emoji()) : n4 === `nanoid` ? t5 = t5.check(Q2.nanoid()) : n4 === `cuid` ? t5 = t5.check(Q2.cuid()) : n4 === `cuid2` ? t5 = t5.check(Q2.cuid2()) : n4 === `ulid` ? t5 = t5.check(Q2.ulid()) : n4 === `xid` ? t5 = t5.check(Q2.xid()) : n4 === `ksuid` && (t5 = t5.check(Q2.ksuid()));
      }
      typeof e9.minLength == `number` && (t5 = t5.min(e9.minLength)), typeof e9.maxLength == `number` && (t5 = t5.max(e9.maxLength)), e9.pattern && (t5 = t5.regex(new RegExp(e9.pattern))), r2 = t5;
      break;
    }
    case `number`:
    case `integer`: {
      let t5 = n3 === `integer` ? Q2.number().int() : Q2.number();
      typeof e9.minimum == `number` && e9.exclusiveMinimum !== true && (t5 = t5.min(e9.minimum)), typeof e9.maximum == `number` && e9.exclusiveMaximum !== true && (t5 = t5.max(e9.maximum)), typeof e9.exclusiveMinimum == `number` ? t5 = t5.gt(e9.exclusiveMinimum) : e9.exclusiveMinimum === true && typeof e9.minimum == `number` && (t5 = t5.gt(e9.minimum)), typeof e9.exclusiveMaximum == `number` ? t5 = t5.lt(e9.exclusiveMaximum) : e9.exclusiveMaximum === true && typeof e9.maximum == `number` && (t5 = t5.lt(e9.maximum)), typeof e9.multipleOf == `number` && (t5 = t5.multipleOf(e9.multipleOf)), r2 = t5;
      break;
    }
    case `boolean`:
      r2 = Q2.boolean();
      break;
    case `null`:
      r2 = Q2.null();
      break;
    case `object`: {
      let n4 = {}, i3 = e9.properties || {}, a3 = new Set(e9.required || []), o3 = typeof e9.additionalProperties == `object` ? $2(e9.additionalProperties, t4) : void 0;
      for (let [e10, r3] of Object.entries(i3)) {
        let i4 = $2(r3, t4);
        g(n4, e10, a3.has(e10) ? i4 : i4.optional());
      }
      if (e9.patternProperties) {
        let i4 = e9.patternProperties, a4 = Object.keys(i4), o4 = [];
        for (let e10 of a4) {
          let n5 = $2(i4[e10], t4), r3 = Q2.string().regex(new RegExp(e10));
          o4.push(Q2.looseRecord(r3, n5));
        }
        let s3 = [];
        if (Object.keys(n4).length > 0 && s3.push(Q2.object(n4).passthrough()), s3.push(...o4), s3.length === 0) r2 = Q2.object({}).passthrough();
        else if (s3.length === 1) r2 = s3[0];
        else {
          let e10 = Q2.intersection(s3[0], s3[1]);
          for (let t5 = 2; t5 < s3.length; t5++) e10 = Q2.intersection(e10, s3[t5]);
          r2 = e10;
        }
        if (e9.additionalProperties === false) {
          let e10 = Object.keys(n4), t5 = a4.map((e11) => new RegExp(e11)), i5 = r2;
          r2 = r2.check((n5) => {
            if (!y(n5.value)) return;
            let r3 = [];
            for (let i6 of Object.keys(n5.value)) e10.includes(i6) || t5.some((e11) => e11.test(i6)) || r3.push(i6);
            r3.length && n5.issues.push({ code: `unrecognized_keys`, keys: r3, input: n5.value, inst: i5 });
          });
        }
      } else {
        let t5 = Q2.object(n4);
        r2 = e9.additionalProperties === false ? t5.strict() : o3 ? t5.catchall(o3) : t5.passthrough();
      }
      if (e9.propertyNames !== void 0 && e9.propertyNames !== true) {
        let n5 = typeof e9.propertyNames == `object` && e9.propertyNames.type === void 0 ? { type: `string`, ...e9.propertyNames } : e9.propertyNames;
        r2 = $s2(r2, $2(n5, t4));
      }
      break;
    }
    case `array`: {
      let n4 = e9.prefixItems, i3 = e9.items;
      if (n4 && Array.isArray(n4)) {
        let a3 = typeof e9.minItems == `number` ? e9.minItems : 0, o3 = Xs2(n4.map((e10) => $2(e10, t4)), a3), s3 = Array.isArray(i3) ? void 0 : ec2(i3, t4), c3 = Q2.tuple(o3);
        r2 = s3 ? c3.rest(s3) : c3, typeof e9.minItems == `number` && (r2 = r2.check(Q2.minLength(e9.minItems))), typeof e9.maxItems == `number` && (r2 = r2.check(Q2.maxLength(e9.maxItems)));
      } else if (Array.isArray(i3)) {
        let n5 = typeof e9.minItems == `number` ? e9.minItems : 0, a3 = Xs2(i3.map((e10) => $2(e10, t4)), n5), o3 = ec2(e9.additionalItems, t4), s3 = Q2.tuple(a3);
        r2 = o3 ? s3.rest(o3) : s3, typeof e9.minItems == `number` && (r2 = r2.check(Q2.minLength(e9.minItems))), typeof e9.maxItems == `number` && (r2 = r2.check(Q2.maxLength(e9.maxItems)));
      } else if (i3 !== void 0) {
        let n5 = $2(i3, t4), a3 = Q2.array(n5);
        typeof e9.minItems == `number` && (a3 = a3.min(e9.minItems)), typeof e9.maxItems == `number` && (a3 = a3.max(e9.maxItems)), r2 = a3;
      } else r2 = Q2.array(Q2.any());
      break;
    }
    default:
      throw Error(`Unsupported type: ${n3}`);
  }
  return r2;
}
function $2(e9, t4) {
  if (typeof e9 == `boolean`) return e9 ? Q2.any() : Q2.never();
  let n3 = nc2(e9, t4), r2 = e9.type || e9.enum !== void 0 || e9.const !== void 0;
  if (e9.anyOf && Array.isArray(e9.anyOf)) {
    let i4 = e9.anyOf.map((e10) => $2(e10, t4)), a3 = Q2.union(i4);
    n3 = r2 ? Q2.intersection(n3, a3) : a3;
  }
  if (e9.oneOf && Array.isArray(e9.oneOf)) {
    let i4 = e9.oneOf.map((e10) => $2(e10, t4)), a3 = Q2.xor(i4);
    n3 = r2 ? Q2.intersection(n3, a3) : a3;
  }
  if (e9.allOf && Array.isArray(e9.allOf)) {
    if (e9.allOf.length === 0) n3 = r2 ? n3 : Q2.any();
    else {
      let i4 = r2 ? n3 : $2(e9.allOf[0], t4), a3 = +!r2;
      for (let n4 = a3; n4 < e9.allOf.length; n4++) i4 = Q2.intersection(i4, $2(e9.allOf[n4], t4));
      n3 = i4;
    }
  }
  e9.nullable === true && t4.version === `openapi-3.0` && (n3 = Q2.nullable(n3)), e9.readOnly === true && (n3 = Q2.readonly(n3)), e9.default !== void 0 && (n3 = n3.default(e9.default));
  let i3 = {};
  for (let t5 of [`$id`, `id`, `$comment`, `$anchor`, `$vocabulary`, `$dynamicRef`, `$dynamicAnchor`]) t5 in e9 && (i3[t5] = e9[t5]);
  for (let t5 of [`contentEncoding`, `contentMediaType`, `contentSchema`]) t5 in e9 && (i3[t5] = e9[t5]);
  e9.propertyNames !== void 0 && e9.type === `object` && e9.$ref === void 0 && (i3.propertyNames = e9.propertyNames);
  for (let t5 of Object.keys(e9)) Js2.has(t5) || g(i3, t5, e9[t5]);
  return Object.keys(i3).length > 0 && t4.registry.add(n3, i3), e9.description && (n3 = n3.describe(e9.description)), n3;
}
function rc2(e9, t4) {
  if (typeof e9 == `boolean`) return e9 ? Q2.any() : Q2.never();
  let n3;
  try {
    n3 = JSON.parse(JSON.stringify(e9));
  } catch {
    throw Error(`fromJSONSchema input is not valid JSON (possibly cyclic); use $defs/$ref for recursive schemas`);
  }
  let r2 = { version: Ys2(n3, t4?.defaultTarget), defs: n3.$defs || n3.definitions || {}, refs: /* @__PURE__ */ new Map(), processing: /* @__PURE__ */ new Set(), rootSchema: n3, registry: t4?.registry ?? L };
  return $2(n3, r2);
}
var ic2 = /* @__PURE__ */ Symbol(`z.visit/resolving`);
function ac2(e9, t4) {
  let n3 = typeof t4 == `function` ? t4 : (e10, n4) => {
    let r3 = t4[e10._zod.def.type];
    return r3 ? r3(e10, n4) : e10;
  }, r2 = /* @__PURE__ */ new Map();
  function i3(e10) {
    let t5 = r2.get(e10);
    if (t5 === ic2) return new Ha({ type: `lazy`, getter: () => r2.get(e10) });
    if (t5 !== void 0) return t5;
    r2.set(e10, ic2);
    let i4 = a3(e10), o3 = n3(i4, i4 !== e10);
    return r2.set(e10, o3), o3;
  }
  function a3(e10) {
    let t5 = e10._zod.def;
    switch (t5.type) {
      case `object`: {
        let n4 = t5.shape, r3 = Object.keys(n4), a4 = false, o3 = {};
        for (let e11 of r3) {
          let t6 = i3(n4[e11]);
          t6 !== n4[e11] && (a4 = true), o3[e11] = t6;
        }
        let s3 = t5.catchall;
        return t5.catchall && (s3 = i3(t5.catchall), s3 !== t5.catchall && (a4 = true)), a4 ? x(e10, { ...t5, shape: o3, catchall: s3 }) : e10;
      }
      case `array`: {
        let n4 = i3(t5.element);
        return n4 === t5.element ? e10 : x(e10, { ...t5, element: n4 });
      }
      case `tuple`: {
        let n4 = t5.items, r3 = false, a4 = [];
        for (let e11 of n4) {
          let t6 = i3(e11);
          t6 !== e11 && (r3 = true), a4.push(t6);
        }
        let o3 = t5.rest;
        return t5.rest && (o3 = i3(t5.rest), o3 !== t5.rest && (r3 = true)), r3 ? x(e10, { ...t5, items: a4, rest: o3 }) : e10;
      }
      case `record`:
      case `map`: {
        let n4 = i3(t5.keyType), r3 = i3(t5.valueType);
        return n4 === t5.keyType && r3 === t5.valueType ? e10 : x(e10, { ...t5, keyType: n4, valueType: r3 });
      }
      case `set`: {
        let n4 = i3(t5.valueType);
        return n4 === t5.valueType ? e10 : x(e10, { ...t5, valueType: n4 });
      }
      case `union`: {
        let n4 = t5.options, r3 = false, a4 = [];
        for (let e11 of n4) {
          let t6 = i3(e11);
          t6 !== e11 && (r3 = true), a4.push(t6);
        }
        return r3 ? x(e10, { ...t5, options: a4 }) : e10;
      }
      case `intersection`: {
        let n4 = i3(t5.left), r3 = i3(t5.right);
        return n4 === t5.left && r3 === t5.right ? e10 : x(e10, { ...t5, left: n4, right: r3 });
      }
      case `optional`:
      case `nullable`:
      case `default`:
      case `prefault`:
      case `catch`:
      case `readonly`:
      case `nonoptional`:
      case `promise`:
      case `success`: {
        let n4 = i3(t5.innerType);
        return n4 === t5.innerType ? e10 : x(e10, { ...t5, innerType: n4 });
      }
      case `pipe`: {
        let n4 = i3(t5.in), r3 = i3(t5.out);
        return n4 === t5.in && r3 === t5.out ? e10 : x(e10, { ...t5, in: n4, out: r3 });
      }
      case `function`: {
        let n4 = i3(t5.input), r3 = i3(t5.output);
        return n4 === t5.input && r3 === t5.output ? e10 : x(e10, { ...t5, input: n4, output: r3 });
      }
      case `lazy`: {
        let n4 = t5.getter, { _cachedInner: r3, ...a4 } = t5;
        return x(e10, { ...a4, getter: () => i3(n4()) });
      }
      case `template_literal`:
      case `string`:
      case `number`:
      case `int`:
      case `boolean`:
      case `bigint`:
      case `symbol`:
      case `undefined`:
      case `null`:
      case `void`:
      case `never`:
      case `any`:
      case `unknown`:
      case `date`:
      case `nan`:
      case `enum`:
      case `literal`:
      case `file`:
      case `transform`:
      case `custom`:
        return e10;
      default:
        return e10;
    }
  }
  return i3(e9);
}
function oc2(e9) {
  return ac2(e9, { object: (e10) => e10.partial(), union: (e10) => {
    let t4 = e10._zod.def;
    return t4.discriminator === void 0 ? e10 : H2(t4.options);
  } });
}
function sc2(e9, t4) {
  if (!t4?.length) return e9;
  let n3 = e9._zod.def;
  return x(e9, _(n3, { checks: [...n3.checks ?? [], ...t4] }), { parent: true });
}
function cc2(e9) {
  return sc2(e9.out, e9.checks);
}
function lc2(e9) {
  return e9.in._zod.traits.has(`$ZodTransform`) ? cc2(e9) : e9.in;
}
function uc2(e9) {
  return ac2(e9, { pipe: (e10) => lc2(e10._zod.def), default: (e10, t4) => t4 ? K2(e10._zod.def.innerType) : e10, catch: (e10, t4) => t4 ? e10._zod.def.innerType : e10 });
}
function dc2(e9) {
  return ac2(e9, { pipe: (e10) => cc2(e10._zod.def), prefault: (e10, t4) => t4 ? e10._zod.def.innerType : e10 });
}
var fc2 = t({ bigint: () => gc2, boolean: () => hc2, date: () => _c2, number: () => mc2, string: () => pc2 });
function pc2(e9) {
  return Hl(w2, e9);
}
function mc2(e9) {
  return yu(P2, e9);
}
function hc2(e9) {
  return Eu(I2, e9);
}
function gc2(e9) {
  return Ou(L2, e9);
}
function _c2(e9) {
  return zu(wo2, e9);
}
var vc2 = t({ $brand: () => it, $input: () => Oc, $output: () => Dc, NEVER: () => et, TimePrecision: () => pu, ZodAny: () => _o2, ZodArray: () => Eo2, ZodBase64: () => za2, ZodBase64URL: () => Va2, ZodBigInt: () => L2, ZodBigIntFormat: () => so2, ZodBoolean: () => I2, ZodCIDRv4: () => Fa2, ZodCIDRv6: () => La2, ZodCUID: () => ya2, ZodCUID2: () => xa2, ZodCatch: () => fs2, ZodCodec: () => Y2, ZodCompileAsyncError: () => z, ZodCompileUnsupportedError: () => B, ZodCreditCard: () => Ga2, ZodCustom: () => Z2, ZodCustomStringFormat: () => N2, ZodDate: () => wo2, ZodDefault: () => is2, ZodDiscriminatedUnion: () => No2, ZodE164: () => Ua2, ZodEmail: () => aa2, ZodEmoji: () => ha2, ZodEnum: () => W2, ZodError: () => Ui2, ZodExactOptional: () => es2, ZodFile: () => Xo2, ZodFirstPartyTypeKind: () => Hs2, ZodFunction: () => Os2, ZodGUID: () => sa2, ZodIPv4: () => ka2, ZodIPv6: () => Na2, ZodISODate: () => O2, ZodISODateTime: () => D2, ZodISODuration: () => A2, ZodISOTime: () => k2, ZodIntersection: () => Fo2, ZodIssueCode: () => zs2, ZodJWT: () => qa2, ZodKSUID: () => Da2, ZodLazy: () => ws2, ZodLiteral: () => Jo2, ZodMAC: () => ja2, ZodMap: () => Ho2, ZodNaN: () => ms2, ZodNanoID: () => _a2, ZodNever: () => bo2, ZodNonOptional: () => cs2, ZodNull: () => ho2, ZodNullable: () => ns2, ZodNumber: () => P2, ZodNumberFormat: () => F2, ZodObject: () => B2, ZodOptional: () => G2, ZodPipe: () => J2, ZodPrefault: () => os2, ZodPreprocess: () => ys2, ZodPromise: () => Es2, ZodReadonly: () => bs2, ZodRealError: () => x2, ZodRecord: () => U2, ZodSet: () => Wo2, ZodString: () => w2, ZodStringFormat: () => E2, ZodSuccess: () => us2, ZodSymbol: () => uo2, ZodTemplateLiteral: () => Ss2, ZodTransform: () => Qo2, ZodTuple: () => Lo2, ZodType: () => C2, ZodULID: () => Ca2, ZodURL: () => M2, ZodUUID: () => j2, ZodUndefined: () => po2, ZodUnion: () => V2, ZodUnknown: () => yo2, ZodVoid: () => So2, ZodXID: () => Ta2, ZodXor: () => jo2, _ZodString: () => ia2, _default: () => as2, _function: () => X2, any: () => vo2, array: () => z2, base64: () => Ba2, base64url: () => Ha2, bigint: () => oo2, boolean: () => ao2, catch: () => ps2, check: () => ks2, cidrv4: () => Ia2, cidrv6: () => Ra2, clone: () => x, codec: () => _s2, coerce: () => fc2, compile: () => Nc, config: () => M, core: () => ip, creditCard: () => Ka2, cuid: () => ba2, cuid2: () => Sa2, custom: () => As2, date: () => To2, decode: () => Yi2, decodeAsync: () => Zi2, deepPartial: () => oc2, describe: () => Ns2, discriminatedUnion: () => Po2, e164: () => Wa2, email: () => oa2, emoji: () => ga2, encode: () => Ji2, encodeAsync: () => Xi2, endsWith: () => sd, enum: () => Ko2, exactOptional: () => ts2, file: () => Zo2, flattenError: () => ht, float32: () => to2, float64: () => no2, formatError: () => gt, fromJSONSchema: () => rc2, function: () => X2, getDiscriminatedOption: () => ea, getErrorMap: () => Vs2, globalRegistry: () => L, gt: () => Uu, gte: () => Wu, guid: () => ca2, hash: () => Qa2, hex: () => Za2, hostname: () => Xa2, httpUrl: () => ma2, includes: () => ad, input: () => uc2, instanceof: () => Fs2, int: () => eo2, int32: () => ro2, int64: () => co2, intersection: () => Io2, invertCodec: () => vs2, ipv4: () => Aa2, ipv6: () => Pa2, iso: () => Us2, json: () => Ls2, jwt: () => Ja2, keyof: () => Do2, ksuid: () => Oa2, lazy: () => Ts2, length: () => td, literal: () => Yo2, locales: () => Tc, looseObject: () => Ao2, looseRecord: () => Vo2, lowercase: () => rd, lt: () => Vu, lte: () => Hu, mac: () => Ma2, map: () => Uo2, maxLength: () => $u, maxSize: () => Xu, memoizer: () => no, meta: () => Ps2, mime: () => ud, minLength: () => ed, minSize: () => Zu, multipleOf: () => Yu, nan: () => hs2, nanoid: () => va2, nativeEnum: () => qo2, negative: () => Ku, never: () => xo2, nonnegative: () => Ju, nonoptional: () => ls2, nonpositive: () => qu, normalize: () => dd, null: () => go2, nullable: () => q2, nullish: () => rs2, number: () => $a2, object: () => Oo2, optional: () => K2, output: () => dc2, overwrite: () => Y, parse: () => Wi2, parseAsync: () => Gi2, partialRecord: () => Bo2, pipe: () => gs2, positive: () => Gu, prefault: () => ss2, preprocess: () => Rs2, prettifyError: () => yt, promise: () => Ds2, properties: () => ld, property: () => cd, readonly: () => xs2, record: () => zo2, refine: () => js2, regex: () => nd, regexes: () => Xt, registry: () => Ac, safeDecode: () => $i2, safeDecodeAsync: () => ta2, safeEncode: () => Qi2, safeEncodeAsync: () => ea2, safeParse: () => Ki2, safeParseAsync: () => qi2, set: () => Go2, setErrorMap: () => Bs2, size: () => Qu, slugify: () => hd, startsWith: () => od, strictObject: () => ko2, string: () => T2, stringFormat: () => Ya2, stringbool: () => Is2, success: () => ds2, superRefine: () => Ms2, symbol: () => fo2, templateLiteral: () => Cs2, toJSONSchema: () => tp, toLowerCase: () => pd, toUpperCase: () => md, toZod: () => i, transform: () => $o2, treeifyError: () => _t, trim: () => fd, tuple: () => Ro2, uint32: () => io2, uint64: () => lo2, ulid: () => wa2, undefined: () => mo2, union: () => H2, unknown: () => R2, uppercase: () => id, url: () => pa2, util: () => t2, uuid: () => la2, uuidv4: () => ua2, uuidv6: () => da2, uuidv7: () => fa2, validate: () => jt, validateAsync: () => Nt, void: () => Co2, xid: () => Ea2, xor: () => Mo2 });

// node_modules/eve/dist/src/shared/json.js
var INVALID_JSON_VALUE_CANDIDATE = /* @__PURE__ */ Symbol(`invalid-json-value-candidate`);
function parseJsonValue(e9) {
  let t4 = normalizeJsonValueCandidate(e9);
  if (t4 === INVALID_JSON_VALUE_CANDIDATE) throw TypeError(`Expected a JSON-serializable value.`);
  return t4;
}
function parseJsonObject(e9) {
  let t4 = parseJsonValue(e9);
  if (!isJsonObjectValue(t4)) throw TypeError(`Expected a JSON-serializable object.`);
  return t4;
}
function normalizeJsonValueCandidate(e9, t4 = /* @__PURE__ */ new WeakSet()) {
  if (e9 === null || typeof e9 == `boolean` || typeof e9 == `string`) return e9;
  if (typeof e9 == `number`) return Number.isFinite(e9) ? e9 : INVALID_JSON_VALUE_CANDIDATE;
  if (Array.isArray(e9)) {
    let n4 = [];
    for (let r2 of e9) {
      let e10 = normalizeJsonValueCandidate(r2, t4);
      if (e10 === INVALID_JSON_VALUE_CANDIDATE) return INVALID_JSON_VALUE_CANDIDATE;
      n4.push(e10);
    }
    return n4;
  }
  if (typeof e9 != `object` || e9 === void 0 || !isPlainObject(e9) || t4.has(e9)) return INVALID_JSON_VALUE_CANDIDATE;
  t4.add(e9);
  let n3 = {};
  for (let [r2, i3] of Object.entries(e9)) {
    if (i3 === void 0) continue;
    let e10 = normalizeJsonValueCandidate(i3, t4);
    if (e10 === INVALID_JSON_VALUE_CANDIDATE) return INVALID_JSON_VALUE_CANDIDATE;
    n3[r2] = e10;
  }
  return t4.delete(e9), n3;
}
function isJsonObjectValue(e9) {
  return e9 !== null && !Array.isArray(e9) && typeof e9 == `object`;
}
function isPlainObject(e9) {
  let t4 = Object.getPrototypeOf(e9);
  return t4 === null || Object.getPrototypeOf(t4) === null;
}

// node_modules/eve/dist/src/shared/json-schemas.js
var jsonValueSchema = vc2.unknown().transform((e9, t4) => {
  try {
    return parseJsonValue(e9);
  } catch (e10) {
    return t4.addIssue({ code: `custom`, message: formatJsonParseError(e10, `Expected a JSON-serializable value.`) }), vc2.NEVER;
  }
});
var jsonObjectSchema = vc2.unknown().transform((e9, t4) => {
  try {
    return parseJsonObject(e9);
  } catch (e10) {
    return t4.addIssue({ code: `custom`, message: formatJsonParseError(e10, `Expected a JSON-serializable object.`) }), vc2.NEVER;
  }
});
function formatJsonParseError(e9, t4) {
  return e9 instanceof Error ? e9.message : t4;
}

// node_modules/eve/dist/src/shared/action-types.js
var runtimeToolCallActionRequestSchema = vc2.object({ callId: vc2.string(), input: jsonObjectSchema, kind: vc2.literal(`tool-call`), toolName: vc2.string() }).strict();
vc2.object({ callId: vc2.string(), description: vc2.string(), input: jsonObjectSchema, kind: vc2.literal(`subagent-call`), name: vc2.string(), nodeId: vc2.string(), subagentName: vc2.string() }).strict(), vc2.object({ callId: vc2.string(), description: vc2.string(), input: jsonObjectSchema, kind: vc2.literal(`remote-agent-call`), name: vc2.string(), nodeId: vc2.string(), remoteAgentName: vc2.string() }).strict(), vc2.object({ callId: vc2.string(), input: jsonObjectSchema, kind: vc2.literal(`workflow-tool-call`), toolName: vc2.string(), workflowId: vc2.string() }).strict(), vc2.object({ callId: vc2.string(), description: vc2.string(), input: jsonObjectSchema, kind: vc2.literal(`subagent-call`), name: vc2.string(), nodeId: vc2.string(), subagentName: vc2.string() }).strict();
var runtimeRemoteAgentDispatchRequestSchema = vc2.object({ callId: vc2.string(), description: vc2.string(), input: jsonObjectSchema, kind: vc2.literal(`remote-agent-call`), name: vc2.string(), nodeId: vc2.string(), remoteAgentName: vc2.string() }).strict();
var workflowToolCallEntrySchema = vc2.discriminatedUnion(`entryPoint`, [vc2.object({ entryPoint: vc2.literal(`execute`) }).strict(), vc2.object({ entryPoint: vc2.literal(`task`), taskId: vc2.string() }).strict(), vc2.object({ entryPoint: vc2.literal(`serve`), taskId: vc2.string() }).strict(), vc2.object({ entryPoint: vc2.literal(`receive`), taskId: vc2.string() }).strict()]);
var runtimeWorkflowTaskRequestSchema = vc2.object({ callId: vc2.string(), entry: workflowToolCallEntrySchema, executeInput: jsonValueSchema.optional(), input: jsonObjectSchema, kind: vc2.literal(`workflow-task`), toolName: vc2.string(), workflowId: vc2.string() }).strict();
vc2.object({ callId: vc2.string(), input: jsonObjectSchema, kind: vc2.literal(`load-skill`), name: vc2.string() }).strict();
vc2.object({ callId: vc2.string(), isError: vc2.boolean().optional(), kind: vc2.literal(`tool-result`), output: jsonValueSchema, toolName: vc2.string() }).strict(), vc2.object({ callId: vc2.string(), isError: vc2.literal(true), kind: vc2.literal(`subagent-result`), origin: vc2.literal(`dispatch`), output: jsonValueSchema, subagentName: vc2.string() }).strict(), vc2.object({ callId: vc2.string(), isError: vc2.boolean().optional(), kind: vc2.literal(`load-skill-result`), name: vc2.string(), output: jsonValueSchema }).strict();

// node_modules/eve/dist/src/shared/input.js
var inputOptionSchema = vc2.object({ description: vc2.string().describe(`Optional additional context for this option.`).optional(), id: vc2.string().describe(`Stable identifier for the option.`), label: vc2.string().describe(`User-facing label for the option.`), style: vc2.enum([`primary`, `danger`, `default`]).describe(`Visual treatment hint for the option.`).optional() }).strict();
var inputRequestKindSchema = vc2.enum([`question`, `session-limit`, `tool-approval`]);
var inputRequestSchema = vc2.object({ action: runtimeToolCallActionRequestSchema, allowFreeform: vc2.boolean().describe(`Whether the user may answer with freeform text instead of selecting one of the provided options.`).optional(), display: vc2.enum([`confirmation`, `select`, `text`]).describe(`Rendering hint: the channel uses this to pick a UX treatment.`).optional(), kind: inputRequestKindSchema.describe(`Framework-owned request source used to resolve, route, and render the response.`), options: vc2.array(inputOptionSchema).describe(`Selectable answer options to present to the user.`).optional(), prompt: vc2.string().describe(`The prompt to present to the user.`), requestId: vc2.string().describe(`Stable identifier for this request.`) }).strict();
var inputResponseSchema = vc2.object({ optionId: vc2.string().optional(), requestId: vc2.string(), text: vc2.string().optional() }).strict();

// node_modules/eve/dist/src/protocol/session-projection.js
function initialSessionProjection() {
  return { authorizations: {}, calls: {}, candidates: {}, inputs: {}, nextSequence: 0, tasks: {}, turns: {} };
}
function updateTurn(e9, t4, n3) {
  let r2 = e9.turns[t4];
  if (r2 === void 0) return e9;
  let i3 = n3(r2);
  return i3 === r2 ? e9 : { ...e9, turns: { ...e9.turns, [t4]: i3 } };
}
function putTask(e9, t4) {
  return e9.tasks[t4.taskId] === t4 ? e9 : { ...e9, tasks: { ...e9.tasks, [t4.taskId]: t4 } };
}
function putTaskCall(e9, t4) {
  return e9.calls[t4.callId] === t4 ? e9 : { ...e9, calls: { ...e9.calls, [t4.callId]: t4 } };
}
function putCall(e9, t4) {
  return e9.calls[t4.callId] === t4 ? e9 : { ...e9, calls: { ...e9.calls, [t4.callId]: t4 } };
}
function updateTask(e9, t4, n3) {
  let r2 = e9.tasks[t4];
  return r2 === void 0 ? e9 : putTask(e9, n3(r2));
}
function updateCall(e9, t4, n3) {
  let r2 = e9.calls[t4];
  return r2 === void 0 ? e9 : putCall(e9, n3(r2));
}
var SETTLED_CALL_STATUSES = /* @__PURE__ */ new Set([`completed`, `failed`, `rejected`, `cancelled`]);
function isSettledCallStatus(e9) {
  return SETTLED_CALL_STATUSES.has(e9);
}
function settleCall(e9, t4, n3) {
  if (e9.taskId !== void 0 || isSettledCallStatus(e9.status)) return e9;
  let { requestId: r2, error: i3, ...a3 } = e9, o3 = { ...a3, status: t4 };
  return e9.requestId !== void 0 && (o3.requestId = e9.requestId), n3 !== void 0 && (o3.error = n3), o3;
}
function actionName(e9) {
  switch (e9.kind) {
    case `load-skill`:
      return e9.name;
    case `subagent-call`:
    case `remote-agent-call`:
      return e9.name;
    case `tool-call`:
    case `workflow-tool-call`:
      return e9.toolName;
  }
}
function resultName(e9) {
  switch (e9.kind) {
    case `load-skill-result`:
      return e9.name;
    case `subagent-result`:
      return e9.subagentName;
    default:
      return e9.toolName;
  }
}
function callStatusAfterApproval(e9) {
  switch (e9) {
    case `approved`:
      return `running`;
    case `denied`:
      return `rejected`;
    case `cancelled`:
      return `cancelled`;
    default:
      return;
  }
}
function foldSession(e9, t4) {
  let n3 = t4;
  switch (n3.type) {
    case `session.started`:
      return e9.started ? e9 : { ...e9, started: true };
    case `turn.started`: {
      let { sequence: t5, turnId: r2 } = n3.data, i3 = { turnId: r2, sequence: t5, status: `active` };
      return { ...e9, activeTurnId: r2, nextSequence: Math.max(e9.nextSequence, t5 + 1), turns: { ...e9.turns, [r2]: i3 } };
    }
    case `step.started`:
      return updateTurn(e9, n3.data.turnId, (e10) => {
        if (!e10.waiting && e10.stepIndex === n3.data.stepIndex) return e10;
        let { waiting: t5, ...r2 } = e10;
        return { ...r2, stepIndex: n3.data.stepIndex };
      });
    case `turn.waiting`:
      return updateTurn(e9, n3.data.turnId, (e10) => e10.status === `active` && !e10.waiting ? { ...e10, waiting: true } : e10);
    case `message.appended`:
    case `message.completed`:
    case `result.completed`:
      return (n3.type === `message.appended` ? n3.data.messageDelta.length > 0 : n3.type !== `message.completed` || (n3.data.message?.length ?? 0) > 0) ? updateTurn(e9, n3.data.turnId, (e10) => e10.outputStarted ? e10 : { ...e10, outputStarted: true }) : e9;
    case `turn.completed`:
    case `turn.cancelled`:
    case `turn.failed`: {
      let { turnId: t5 } = n3.data, r2 = n3.type === `turn.completed` ? `completed` : n3.type === `turn.failed` ? `failed` : `cancelled`, { waiting: i3, ...a3 } = e9.turns[t5] ?? { turnId: t5, sequence: n3.data.sequence };
      return { ...e9, activeTurnId: e9.activeTurnId === t5 ? void 0 : e9.activeTurnId, turns: { ...e9.turns, [t5]: { ...a3, status: r2 } } };
    }
    case `context.cleared`:
      return { ...e9, calls: Object.fromEntries(Object.entries(e9.calls).filter(([, e10]) => e10.taskId !== void 0)) };
    case `session.waiting`:
      return e9.activeTurnId === void 0 ? e9 : { ...e9, activeTurnId: void 0 };
    case `session.completed`:
    case `session.failed`: {
      let { activeTurnId: t5, ...n4 } = e9;
      return { ...n4, ended: true };
    }
    case `actions.requested`: {
      let t5;
      for (let r2 of n3.data.actions) e9.calls[r2.callId] === void 0 && (t5 ??= { ...e9.calls }, t5[r2.callId] = { callId: r2.callId, name: actionName(r2), turnId: n3.data.turnId, stepIndex: n3.data.stepIndex, status: `running` });
      return t5 === void 0 ? e9 : { ...e9, calls: t5 };
    }
    case `action.result`: {
      let { result: t5, status: r2, error: i3 } = n3.data, a3 = e9.calls[t5.callId];
      if (a3?.taskId !== void 0) return e9;
      let o3 = r2 === `rejected` || i3?.code === `TOOL_EXECUTION_DENIED` ? `rejected` : r2 === `failed` || t5.isError === true ? `failed` : `completed`;
      if (a3 === void 0) {
        let r3 = { callId: t5.callId, name: resultName(t5), turnId: n3.data.turnId, stepIndex: n3.data.stepIndex, status: o3 };
        return i3 !== void 0 && (r3.error = i3), putCall(e9, r3);
      }
      return updateCall(e9, t5.callId, (e10) => settleCall(e10, o3, i3));
    }
    case `task.started`: {
      let { callId: t5, kind: r2, name: i3, taskId: a3, turnId: o3 } = n3.data, s3 = e9.tasks[a3] ?? { taskId: a3, name: i3, kind: r2, calls: {} }, c3 = e9;
      s3.calls[t5] === void 0 && (c3 = putTask(c3, putTaskCall(s3, { callId: t5, turnId: o3, status: `working` })));
      let l3 = c3.calls[t5];
      if (l3?.taskId === a3) return c3;
      let u3 = { callId: t5, name: l3?.name ?? i3, stepIndex: l3?.stepIndex ?? 0, taskId: a3, turnId: l3?.turnId ?? o3 };
      return l3?.requestId !== void 0 && (u3.requestId = l3.requestId), putCall(c3, u3);
    }
    case `task.settled`: {
      let { callId: t5, error: r2, output: i3, status: a3, taskId: o3 } = n3.data;
      return updateTask(e9, o3, (e10) => {
        let n4 = e10.calls[t5];
        if (n4 === void 0 || n4.status !== `working`) return e10;
        let o4 = { callId: t5, turnId: n4.turnId, status: a3 };
        return putTaskCall(e10, a3 === `completed` && i3 !== void 0 ? { ...o4, output: i3 } : a3 === `failed` && r2 !== void 0 ? { ...o4, error: r2 } : o4);
      });
    }
    case `input.requested`: {
      let t5 = { ...e9.inputs }, r2;
      for (let i3 of n3.data.requests) {
        if (t5[i3.requestId] !== void 0) continue;
        let a3 = { request: i3, sequence: n3.data.sequence, turnId: n3.data.turnId, stepIndex: n3.data.stepIndex, status: `open` };
        if (n3.data.taskId !== void 0 && (a3.taskId = n3.data.taskId), n3.data.callId !== void 0 && (a3.callId = n3.data.callId), t5[i3.requestId] = a3, i3.kind !== `tool-approval` || isRelayed(n3.data)) continue;
        let { callId: o3, toolName: s3 } = i3.action;
        r2 ??= { ...e9.calls };
        let c3 = r2[o3];
        c3?.taskId === void 0 && (c3 !== void 0 && isSettledCallStatus(c3.status) || (r2[o3] = { ...c3 ?? { callId: o3, name: s3, turnId: n3.data.turnId, stepIndex: n3.data.stepIndex }, requestId: i3.requestId, status: `awaiting-input` }));
      }
      return r2 === void 0 ? { ...e9, inputs: t5 } : { ...e9, calls: r2, inputs: t5 };
    }
    case `approval.candidate`: {
      let { candidateId: t5, outcome: r2, requestId: i3 } = n3.data;
      e9 = { ...e9, candidates: { ...e9.candidates, [t5]: { candidateId: t5, outcome: r2, requestId: i3 } } };
      let a3 = e9.inputs[n3.data.requestId];
      if (a3 === void 0 || a3.status === `settled` || n3.data.outcome === `pending` || a3.status === `open`) return e9;
      let { response: o3, ...s3 } = a3;
      return { ...e9, inputs: { ...e9.inputs, [n3.data.requestId]: { ...s3, status: `open` } } };
    }
    case `approval.settled`: {
      let t5 = e9.inputs[n3.data.requestId];
      if (t5 === void 0 || t5.status === `settled`) return e9;
      let r2 = n3.data.outcome === `approved` ? `approved` : `denied`;
      return settleApprovalCall({ ...e9, inputs: { ...e9.inputs, [n3.data.requestId]: { ...t5, status: `settled`, outcome: r2 } } }, t5, r2);
    }
    case `input.resolved`: {
      let t5 = e9;
      for (let e10 of n3.data.resolutions) {
        let n4 = t5.inputs[e10.requestId];
        if (n4 === void 0 || n4.status === `settled`) continue;
        let r2 = e10.response ?? n4.response, i3 = { ...n4, status: `settled`, outcome: e10.outcome };
        r2 !== void 0 && (i3.response = r2), t5 = { ...t5, inputs: { ...t5.inputs, [e10.requestId]: i3 } }, t5 = settleApprovalCall(t5, n4, e10.outcome);
      }
      return t5;
    }
    case `authorization.required`: {
      let t5 = n3.data.attemptId ?? n3.data.name, r2 = { attemptId: t5, name: n3.data.name, sequence: n3.data.sequence, turnId: n3.data.turnId, stepIndex: n3.data.stepIndex, status: `required` };
      return n3.data.taskId !== void 0 && (r2.taskId = n3.data.taskId), n3.data.principalId !== void 0 && (r2.principalId = n3.data.principalId), n3.data.candidateId !== void 0 && (r2.candidateId = n3.data.candidateId), n3.data.webhookUrl !== void 0 && (r2.awaitsCallback = true), { ...e9, authorizations: { ...e9.authorizations, [t5]: r2 } };
    }
    case `authorization.completed`: {
      let t5 = n3.data.attemptId ?? n3.data.name, r2 = { ...e9.authorizations[t5] ?? { attemptId: t5, name: n3.data.name, sequence: n3.data.sequence, turnId: n3.data.turnId, stepIndex: n3.data.stepIndex }, status: n3.data.outcome };
      return { ...e9, authorizations: { ...e9.authorizations, [t5]: r2 } };
    }
    default:
      return e9;
  }
}
function isRelayed(e9) {
  return e9.callId !== void 0 || e9.taskId !== void 0;
}
function settleApprovalCall(e9, t4, n3) {
  if (t4.request.kind !== `tool-approval` || isRelayed(t4)) return e9;
  let r2 = callStatusAfterApproval(n3);
  return r2 === void 0 ? e9 : updateCall(e9, t4.request.action.callId, (e10) => e10.status !== `awaiting-input` || e10.requestId !== t4.request.requestId ? e10 : r2 === `running` ? { ...e10, status: r2 } : settleCall(e10, r2));
}
function openInputs(e9) {
  return Object.values(e9.inputs).filter((e10) => e10.status !== `settled`);
}
function openSignIns(e9) {
  return Object.values(e9.authorizations).filter((e10) => e10.status === `required`);
}
function reportedCallStatus(e9, t4) {
  if (t4.taskId === void 0) return t4.status;
  let n3 = e9.tasks[t4.taskId]?.calls[t4.callId]?.status;
  return n3 === void 0 || n3 === `working` ? `running` : n3;
}

// node_modules/eve/dist/src/client/conversation-projection.js
var projectionKey = /* @__PURE__ */ Symbol(`eve.conversationProjection`);
function conversationProjection(e9) {
  return e9[projectionKey] ?? initialSessionProjection();
}
function withConversationProjection(e9, t4) {
  return e9[projectionKey] === t4 ? e9 : Object.defineProperty({ ...e9 }, projectionKey, { value: t4 });
}

// node_modules/eve/dist/src/client/conversation-state.js
function hasPendingAuthorizations(e9) {
  return openSignIns(conversationProjection(e9)).some((e10) => e10.awaitsCallback === true);
}
function agentToolTask(e9, t4) {
  let n3 = t4.taskId === void 0 ? void 0 : e9.tasks[t4.taskId];
  return n3?.kind === `agent` ? n3 : void 0;
}
function isAgentSessionCaughtUp(e9, t4) {
  if (t4.observation.status !== `following` && t4.observation.status !== `idle`) return false;
  let n3 = agentToolTask(e9, t4);
  if (n3 === void 0) return false;
  let r2 = Object.values(n3.calls);
  if (r2.some((e10) => e10.status === `working`)) return false;
  let i3 = t4.observation.conversation;
  return i3.activeTurnId !== void 0 || Object.values(i3.inputs).some((e10) => e10.status !== `settled`) || hasPendingAuthorizations(i3) ? false : i3.messages.filter((e10) => e10.role === `user`).length >= r2.filter((e10) => e10.status === `completed`).length;
}

// node_modules/eve/dist/src/shared/guards.js
function isObject(e9) {
  return typeof e9 == `object` && !!e9 && !Array.isArray(e9);
}

// node_modules/eve/dist/src/shared/errors.js
function toErrorMessage(e9) {
  return e9 instanceof Error ? e9.message : typeof e9 == `string` ? e9 : e9 == null ? String(e9) : isObject(e9) ? typeof e9.message == `string` && e9.message.length > 0 ? e9.message : safeJsonStringify(e9) : String(e9);
}
function toError(e9) {
  if (e9 instanceof Error) return e9;
  let t4 = Error(toErrorMessage(e9));
  return isObject(e9) ? (typeof e9.name == `string` && e9.name.length > 0 && (t4.name = e9.name), typeof e9.stack == `string` && e9.stack.length > 0 && (t4.stack = e9.stack), `cause` in e9 && e9.cause !== void 0 && e9.cause !== e9 && (t4.cause = e9.cause), t4) : t4;
}
function safeJsonStringify(e9) {
  try {
    return JSON.stringify(e9) ?? String(e9);
  } catch {
    return String(e9);
  }
}

// node_modules/eve/dist/src/internal/attachments/media-metadata.js
var PDF_MEDIA_TYPE = `application/pdf`;
var INLINE_IMAGE_MEDIA_TYPES = /* @__PURE__ */ new Set([`image/gif`, `image/jpeg`, `image/png`, `image/webp`]);
var VERIFIABLE_MEDIA_TYPES = /* @__PURE__ */ new Set([...INLINE_IMAGE_MEDIA_TYPES, `image/jpg`, PDF_MEDIA_TYPE]);

// node_modules/eve/dist/src/protocol/routes.js
var EVE_ROUTE_PREFIX = `/eve/v1`;
var EVE_PRODUCTION_CRON_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/cron/:token`;
var EVE_HEALTH_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/health`;
var EVE_INFO_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/info`;
var EVE_SESSION_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/session`;
var EVE_SESSION_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId`;
var EVE_SESSION_CANCEL_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/cancel`;
var EVE_SESSION_COMPACT_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/compact`;
var EVE_SESSION_CLEAR_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/clear`;
var EVE_SESSION_RESET_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/reset`;
var EVE_SESSION_STUBS_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/stubs`;
var EVE_SESSION_STREAM_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/stream`;
var EVE_SUBAGENT_STREAM_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:parentSessionId/subagents/:callId/:childSessionId/stream`;
var EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/dev/schedules/:scheduleId`;
var EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/dev/runtime-artifacts`;
var EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH = `${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}/rebuild`;
var EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH = `${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}/suspend`;
var EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH = `${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}/resume`;
var EVE_CONNECTION_CALLBACK_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/connections/:name/callback/:attemptId/:token`;
var EVE_CALLBACK_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/callback/:token`;
function createEveSessionRoutePath(e9) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(e9)}`;
}
function createEveSessionCancelRoutePath(e9) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(e9)}/cancel`;
}
function createEveSessionCompactRoutePath(e9) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(e9)}/compact`;
}
function createEveSessionClearRoutePath(e9) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(e9)}/clear`;
}
function createEveSessionResetRoutePath(e9) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(e9)}/reset`;
}
function createEveSessionStreamRoutePath(e9) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(e9)}/stream`;
}

// node_modules/eve/dist/src/shared/ulid.js
var ENCODING = `0123456789ABCDEFGHJKMNPQRSTVWXYZ`;
var TIME_MAX = 2 ** 48 - 1;
function createUlidFactory() {
  let e9 = -1, t4 = new Uint8Array(10);
  return function() {
    let n3 = Date.now();
    if (!Number.isInteger(n3) || n3 < 0 || n3 > TIME_MAX) throw Error(`Cannot mint a ULID: timestamp must be an integer from 0 to ${TIME_MAX}.`);
    if (n3 > e9) e9 = n3, randomFill(t4);
    else if (!incrementRandom(t4)) {
      if (e9 === TIME_MAX) throw Error(`Cannot mint a ULID: random component overflowed at the maximum timestamp.`);
      e9 += 1, randomFill(t4);
    }
    return `${encodeTime(e9)}${encodeRandom(t4)}`;
  };
}
var createUlid = createUlidFactory();
function randomFill(e9) {
  let t4 = globalThis.crypto;
  if (typeof t4?.getRandomValues != `function`) throw Error(`Cannot mint a ULID: globalThis.crypto.getRandomValues is unavailable.`);
  t4.getRandomValues(e9);
}
function encodeTime(e9) {
  let t4 = e9, n3 = ``;
  for (let e10 = 0; e10 < 10; e10 += 1) n3 = ENCODING[t4 % 32] + n3, t4 = Math.floor(t4 / 32);
  return n3;
}
function encodeRandom(e9) {
  let t4 = 0, n3 = 0, r2 = ``;
  for (let i3 of e9) {
    for (t4 = t4 << 8 | i3, n3 += 8; n3 >= 5; ) n3 -= 5, r2 += ENCODING[t4 >>> n3 & 31];
    t4 &= (1 << n3) - 1;
  }
  return r2;
}
function incrementRandom(e9) {
  for (let t4 = e9.length - 1; t4 >= 0; --t4) {
    let n3 = e9[t4] ?? 0;
    if (n3 < 255) return e9[t4] = n3 + 1, e9.fill(0, t4 + 1), true;
  }
  return false;
}

// node_modules/eve/dist/src/protocol/message.js
var EVE_SESSION_ID_HEADER = `x-eve-session-id`;
var EVE_STREAM_TAIL_INDEX_HEADER = `x-eve-stream-tail-index`;
var EVE_STREAM_VERSION_HEADER = `x-eve-stream-version`;
var EVE_STREAM_CONTROL_VERSION = `1`;
var EVE_STREAM_CONTROL_VERSION_QUERY = `streamControlVersion`;
var EVE_STREAM_LEASE_ENDED_CONTROL = { $eve: `stream.lease-ended`, version: 1 };
var textEncoder = new TextEncoder();
function isCurrentTurnBoundaryEvent(e9) {
  return e9.type === `session.completed` || e9.type === `session.failed` || e9.type === `session.waiting`;
}
function isTurnFailureEvent(e9) {
  return e9.type === `session.failed` || e9.type === `step.failed` || e9.type === `turn.failed`;
}

// node_modules/eve/dist/src/client/session-utils.js
function summarizeTurnEvents(e9) {
  let t4 = new TurnSegment(), n3, r2, i3;
  for (let a3 of e9) t4.observe(a3) && (n3 = a3), isTurnFailureEvent(a3) && (r2 = a3), isFinalMessageCompleted(a3) && (i3 = a3.data.message ?? void 0);
  return { boundary: n3, failure: r2, inputRequests: t4.inputRequests, message: i3, pendingAuthorizations: t4.pendingAuthorizations, status: summarizeBoundaryStatus(n3) };
}
function summarizeBoundaryStatus(e9) {
  return e9?.type === `session.waiting` || e9?.type === `turn.waiting` ? `waiting` : e9?.type === `session.failed` ? `failed` : `completed`;
}
function endsTurnSegment(e9, t4) {
  return e9.type === `turn.waiting` ? t4.requests || e9.data.on === `input` && !t4.callbacks : isCurrentTurnBoundaryEvent(e9) && (e9.type !== `session.waiting` || !t4.callbacks);
}
var TurnSegment = class {
  #e = initialSessionProjection();
  #t = /* @__PURE__ */ new Map();
  #n;
  constructor(e9 = {}) {
    this.#n = e9.followCallbacks === true;
  }
  get inputRequests() {
    return openInputs(this.#e).map((e9) => e9.request);
  }
  get pendingAuthorizations() {
    return openSignIns(this.#e).flatMap((e9) => this.#t.get(e9.attemptId) ?? []);
  }
  observe(e9) {
    return this.#e = foldSession(this.#e, e9), e9.type === `authorization.required` && this.#t.set(e9.data.attemptId ?? e9.data.name, e9.data), endsTurnSegment(e9, { callbacks: this.#n && openSignIns(this.#e).some((e10) => e10.awaitsCallback === true), requests: openInputs(this.#e).length > 0 });
  }
};
function isFinalMessageCompleted(e9) {
  return e9.type === `message.completed` && e9.data.finishReason !== `tool-calls`;
}

// node_modules/eve/dist/src/client/eve-agent-store-helpers.js
function activeTurnForOptimisticFollowUp(e9) {
  let t4 = e9.findLast((e10) => e10.type === `turn.started` || e10.type === `turn.completed` || e10.type === `turn.failed` || e10.type === `turn.cancelled` || isCurrentTurnBoundaryEvent(e10));
  return t4?.type === `turn.started` ? t4.data.turnId : void 0;
}
function isResponseBoundary(e9, t4) {
  return endsTurnSegment(e9, { callbacks: hasPendingAuthorizations(t4), requests: Object.values(t4.inputs).some((e10) => e10.status !== `settled`) });
}
function settledStatus(e9, t4) {
  return e9 === void 0 ? t4.activeTurnId === void 0 ? `ready` : `streaming` : `error`;
}
function isSettledSessionTail(e9, t4) {
  let n3 = e9.at(-1);
  return n3 !== void 0 && isResponseBoundary(n3, t4);
}
function assertAnswerable(e9, t4) {
  for (let { requestId: n3 } of e9.inputResponses ?? []) {
    let e10 = t4.inputs[n3]?.status;
    if (e10 !== void 0 && e10 !== `open`) throw Error(`Input request ${n3} was already answered.`);
  }
}
function assertInFlightFollowUp(e9) {
  if (e9.inputResponses === void 0 && (e9.message === void 0 || e9.turnPolicy !== `steer`)) throw Error(`eve session is already processing a turn. Send a message with turnPolicy: "steer" to guide it at the next boundary, or answer an open input request.`);
}
function validateFollowUp(e9) {
  return assertExclusiveTurnInput(e9), assertInFlightFollowUp(e9), e9;
}
function assertExclusiveTurnInput(e9) {
  if (e9.message !== void 0 == (e9.inputResponses !== void 0)) throw Error(`A turn requires exactly one of message or inputResponses.`);
}
var submissionSequence = 0;
function createSubmissionId() {
  let e9 = globalThis.crypto?.randomUUID;
  return e9 === void 0 ? (submissionSequence += 1, `submission_${submissionSequence.toString()}`) : e9.call(globalThis.crypto);
}
function createAbortSignal(e9, t4) {
  return e9 ? AbortSignal.any([e9, t4]) : t4;
}
function summarizeUserContent(e9) {
  if (typeof e9 == `string`) return e9;
  let t4 = [];
  for (let n3 of e9) n3.type === `text` ? t4.push(n3.text) : n3.type === `file` && t4.push(n3.filename ? `[file: ${n3.filename}]` : `[file]`);
  return t4.join(`
`);
}
function isAbortError(e9) {
  return e9 instanceof Error && e9.name === `AbortError`;
}
function toTerminalStreamFailureError(e9) {
  if (e9.type !== `session.failed`) return;
  let t4 = Error(e9.data.message);
  return t4.name = e9.data.code, t4;
}
function createActiveTurn(e9) {
  let t4 = Promise.withResolvers(), n3 = Promise.withResolvers(), r2 = { abortController: new AbortController(), acceptedFollowUps: 0, cancel: () => e9(r2), completion: n3.promise, followUpDispatches: /* @__PURE__ */ new Set(), receivedFollowUps: 0, receivedFollowUpEvents: /* @__PURE__ */ new Map(), followUpSubmissionIds: /* @__PURE__ */ new Set(), resolveCompletion: n3.resolve, response: t4.promise, resolveResponse: t4.resolve };
  return r2;
}
function countFollowUpDeliveries(e9, t4) {
  let n3 = 0;
  for (let r2 of t4.ids) e9.followUpSubmissionIds.delete(r2) && (n3 += 1);
  if (n3 !== 0) {
    if (t4.alreadyProjected) e9.receivedFollowUps += n3;
    else {
      let r2 = e9.receivedFollowUpEvents.get(t4.event) ?? 0;
      e9.receivedFollowUpEvents.set(t4.event, r2 + n3);
    }
  }
}
async function followSteeredTurns(e9, t4, n3) {
  for (; e9.followUpDispatches.size > 0; ) await Promise.allSettled(e9.followUpDispatches);
  if (e9.receivedFollowUps >= e9.acceptedFollowUps) return;
  let r2 = new TurnSegment({ followCallbacks: true });
  for await (let i3 of t4) {
    if (!n3()) return;
    if (e9.receivedFollowUps += e9.receivedFollowUpEvents.get(i3) ?? 0, e9.receivedFollowUpEvents.delete(i3), r2.observe(i3)) {
      for (; e9.followUpDispatches.size > 0; ) await Promise.allSettled(e9.followUpDispatches);
      if (e9.receivedFollowUps >= e9.acceptedFollowUps) return;
    }
  }
}
async function waitWithSignal(e9, t4) {
  if (t4 === void 0) return await e9;
  let n3 = Promise.withResolvers(), onAbort = () => n3.reject(t4.reason);
  t4.addEventListener(`abort`, onAbort, { once: true }), t4.aborted && onAbort();
  try {
    return await Promise.race([n3.promise, e9]);
  } finally {
    t4.removeEventListener(`abort`, onAbort);
  }
}

// node_modules/eve/dist/src/client/eve-agent-projection.js
var EveAgentProjection = class {
  #e;
  #t;
  #n;
  constructor(e9, t4) {
    this.#e = e9, this.#t = [...t4], this.#n = this.#r();
  }
  get data() {
    return this.#n;
  }
  get reducer() {
    return this.#e;
  }
  reset() {
    this.#t = [], this.#n = this.#e.initial();
  }
  append(e9) {
    this.#t.push(e9), this.#n = this.#e.reduce(this.#n, e9);
  }
  remove(e9) {
    this.#t = this.#t.filter((t4) => !e9(t4)), this.#n = this.#r();
  }
  replace(e9, t4) {
    let n3 = this.#t.findIndex(e9);
    n3 === -1 ? this.#t.push(t4) : this.#t[n3] = t4, this.#n = this.#r();
  }
  #r() {
    let e9 = this.#e.initial();
    for (let t4 of this.#t) e9 = this.#e.reduce(e9, t4);
    return e9;
  }
};

// node_modules/eve/dist/src/client/abort-signal.js
function throwIfAborted(e9) {
  if (e9 === void 0) return;
  let t4 = e9.throwIfAborted;
  if (typeof t4 == `function`) {
    t4.call(e9);
    return;
  }
  if (!e9.aborted) return;
  if (e9.reason !== void 0) throw e9.reason;
  let n3 = Error(`The operation was aborted.`);
  throw n3.name = `AbortError`, n3;
}

// node_modules/eve/dist/src/internal/http/basic-auth.js
function encodeBasicCredentials(e9, t4) {
  let n3 = new TextEncoder().encode(`${e9}:${t4}`), r2 = Array.from(n3, (e10) => String.fromCodePoint(e10)).join(``);
  return btoa(r2);
}

// node_modules/eve/dist/src/client/client-error.js
var ClientError = class extends Error {
  code;
  status;
  body;
  headers;
  constructor(e9, t4, n3) {
    let r2 = Object.freeze(Object.fromEntries(new Headers(n3).entries())), i3 = r2[`content-type`]?.toLowerCase(), a3 = parseJsonObject2(t4), o3 = t4 || `Server returned ${e9}.`;
    typeof a3?.error == `string` ? o3 = a3.error : a3 === void 0 && i3?.includes(`text/html`) && (o3 = `Server returned ${e9} with an HTML response. Check the eve route and development server configuration.`), super(o3), this.name = `ClientError`, this.code = typeof a3?.code == `string` ? a3.code : void 0, this.status = e9, this.body = t4, this.headers = r2;
  }
};
var ClientSessionStrandedError = class extends ClientError {
  eveVersion;
  constructor(e9, t4, n3, r2) {
    super(e9, t4, n3), this.name = `ClientSessionStrandedError`, this.eveVersion = r2.eveVersion;
  }
};
function createClientError(e9, t4, n3) {
  let r2 = e9 === 409 ? parseJsonObject2(t4) : void 0;
  return r2?.code === `session_stranded` ? new ClientSessionStrandedError(e9, t4, n3, { eveVersion: typeof r2.eveVersion == `string` ? r2.eveVersion : void 0 }) : new ClientError(e9, t4, n3);
}
function parseJsonObject2(e9) {
  try {
    let t4 = JSON.parse(e9);
    return isObject(t4) ? t4 : void 0;
  } catch {
    return;
  }
}

// node_modules/eve/dist/src/client/agent-info-error.js
var AgentInfoResponseError = class extends Error {
  issues;
  constructor(e9 = []) {
    let t4 = e9.length === 0 ? `` : ` (${e9.join(`; `)})`;
    super(`The server returned an unrecognized response from the eve agent info route.${t4}`), this.name = `AgentInfoResponseError`, this.issues = e9;
  }
};

// node_modules/eve/dist/src/client/health-response-error.js
var HealthResponseError = class extends Error {
  issues;
  constructor(e9 = []) {
    let t4 = e9.length === 0 ? `` : ` (${e9.join(`; `)})`;
    super(`The server returned an unrecognized eve health response.${t4}`), this.name = `HealthResponseError`, this.issues = e9;
  }
};

// node_modules/eve/dist/src/client/health-schema.js
var HealthResultSchema = vc2.object({ ok: vc2.literal(true), status: vc2.literal(`ready`), workflowId: vc2.string().min(1) }).strict();

// node_modules/eve/dist/src/shared/extension-mount.js
var mountIdSchema = vc2.string().min(1);

// node_modules/eve/dist/src/client/agent-info-schema.js
var owner = vc2.discriminatedUnion(`kind`, [vc2.object({ kind: vc2.literal(`application`) }).strict(), vc2.object({ feature: vc2.string(), kind: vc2.literal(`framework`) }).strict(), vc2.object({ kind: vc2.literal(`extension`), mountId: mountIdSchema.optional(), namespace: vc2.string(), packageName: vc2.string() }).strict()]);
var moduleBacking = vc2.discriminatedUnion(`kind`, [vc2.object({ externalDependencies: vc2.array(vc2.string()), extensionScope: vc2.object({ namespace: vc2.string(), sourceRoot: vc2.string() }).strict().optional(), kind: vc2.literal(`filesystem`), mountId: vc2.string().optional(), sourcePath: vc2.string() }).strict(), vc2.object({ dependencies: vc2.record(vc2.string(), vc2.string()).optional(), kind: vc2.literal(`programmatic`), mountId: vc2.string().optional(), moduleId: vc2.string(), parameters: vc2.record(vc2.string(), vc2.unknown()).optional(), registryId: vc2.string(), revision: vc2.string(), semanticRevision: vc2.string().optional() }).strict()]);
var binding = vc2.object({ backing: moduleBacking, logicalPath: vc2.string(), owner }).strict();
var source = vc2.object({ binding: binding.optional(), exportName: vc2.string().optional(), logicalPath: vc2.string(), owner, sourceId: vc2.string(), sourceKind: vc2.enum([`markdown`, `module`, `skill-package`]) }).strict();
var entry = source.extend({ name: vc2.string() }).strict();
var dynamicResolver = source.extend({ eventNames: vc2.array(vc2.string()), slug: vc2.string() }).strict();
var modelRouting = vc2.discriminatedUnion(`kind`, [vc2.object({ kind: vc2.literal(`gateway`), target: vc2.string(), byok: vc2.string().optional() }).strict(), vc2.object({ kind: vc2.literal(`external`), provider: vc2.string() }).strict()]);
var modelEndpoint = vc2.union([vc2.object({ kind: vc2.literal(`external`), provider: vc2.string() }).strict(), vc2.object({ kind: vc2.literal(`chatgpt`), state: vc2.enum([`checking`, `ready`, `signed-out`, `reauth-required`, `unavailable`]), accountLabel: vc2.string().optional() }).strict(), vc2.object({ kind: vc2.literal(`gateway`), connected: vc2.literal(true), credential: vc2.enum([`api-key`, `oidc`, `oauth`]), team: vc2.optional(vc2.string()) }).strict(), vc2.object({ kind: vc2.literal(`gateway`), connected: vc2.literal(false) }).strict()]);
var modelBaseFields = { contextWindowTokens: vc2.number().optional(), providerOptions: vc2.unknown().optional(), reasoning: vc2.enum([`provider-default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`]).optional().catch(void 0), source: source.optional() };
var agentModel = vc2.union([vc2.object({ ...modelBaseFields, endpoint: modelEndpoint.optional(), id: vc2.string(), routing: modelRouting }).strict(), vc2.object({ ...modelBaseFields, endpoint: vc2.never().optional(), id: vc2.never().optional(), routing: vc2.object({ kind: vc2.literal(`dynamic`), resolver: dynamicResolver }).strict() }).strict()]);
var tool = entry.extend({ description: vc2.string(), hasAuth: vc2.boolean(), hasExecute: vc2.boolean(), hasModelOutputProjection: vc2.boolean(), hasOutputSchema: vc2.boolean(), inputSchema: vc2.unknown(), outputSchema: vc2.unknown().optional(), requiresApproval: vc2.boolean() }).strict();
var skill = entry.extend({ description: vc2.string(), license: vc2.string().optional(), markdown: vc2.string(), metadata: vc2.record(vc2.string(), vc2.string()).optional() }).strict();
var instructions = entry.extend({ content: vc2.string(), role: vc2.enum([`system`, `user`]) }).strict();
var schedule = entry.extend({ cron: vc2.string(), hasRun: vc2.boolean(), markdown: vc2.string().optional() }).strict();
var channelMethod = vc2.enum([`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `WEBSOCKET`]);
var channelRoute = entry.extend({ adapterKind: vc2.string().optional(), method: channelMethod, urlPath: vc2.string() }).strict();
var sourceDescriptor = vc2.object({ backing: vc2.union([moduleBacking, vc2.object({ kind: vc2.literal(`resource`), sourcePath: vc2.string() }).strict()]), form: vc2.enum([`derived`, `direct`]), layer: vc2.enum([`framework-default`, `extension-package`, `extension-override`, `application`]), logicalPath: vc2.string(), owner, sourceId: vc2.string() }).strict();
var shadowedChannelRoute = vc2.object({ method: channelMethod, source: sourceDescriptor, urlPath: vc2.string(), winnerSourceId: vc2.string() }).strict();
var connection = source.extend({ connectionName: vc2.string(), description: vc2.string(), hasApproval: vc2.boolean(), hasAuthorization: vc2.boolean(), hasHeaders: vc2.boolean(), protocol: vc2.string(), toolFilter: vc2.unknown().optional(), url: vc2.string() }).strict();
var hook = source.extend({ eventNames: vc2.array(vc2.string()), slug: vc2.string() }).strict();
var memory = source.extend({ description: vc2.string().optional(), slot: vc2.string(), visibility: vc2.enum([`scope`, `session`]) }).strict();
var sandbox = source.extend({ provider: vc2.string().optional(), environmentExportName: vc2.string().optional(), revisionHash: vc2.string() }).strict();
var subagent = entry.extend({ configResolver: dynamicResolver.optional(), description: vc2.string().optional(), entryPath: vc2.string(), nodeId: vc2.string(), parentNodeId: vc2.string(), rootPath: vc2.string(), summary: vc2.object({ channels: vc2.number(), connections: vc2.number(), hooks: vc2.number(), instructions: vc2.number(), memories: vc2.number(), schedules: vc2.number(), skills: vc2.number(), tools: vc2.number() }).strict() }).strict();
var remoteAgent = entry.extend({ description: vc2.string(), nodeId: vc2.string(), parentNodeId: vc2.string(), url: vc2.string().optional() }).strict();
var kernelEffect = vc2.object({ action: vc2.union([vc2.enum([`subagent-call`, `workflow-tool-call`]), vc2.literal(`unrecognized`)]).catch(`unrecognized`).optional(), audience: vc2.array(vc2.union([vc2.literal(`root-session`), vc2.literal(`unrecognized`)]).catch(`unrecognized`)), kind: vc2.union([vc2.enum([`dispatch`, `provider-tool`]), vc2.literal(`unrecognized`)]).catch(`unrecognized`), sourceId: vc2.string() }).strict();
var compositionDiagnostic = vc2.object({ kind: vc2.enum([`disabled`, `shadowed`]), logicalPath: vc2.string(), owner, sourceId: vc2.string(), winnerSourceId: vc2.string().optional() }).strict();
var AgentInfoResultSchema = vc2.object({ agent: vc2.object({ agentRoot: vc2.string(), appRoot: vc2.string(), config: source.extend({ binding }).strict(), description: vc2.string().optional(), model: agentModel, name: vc2.string(), nodeId: vc2.string(), outputSchema: vc2.unknown().optional() }).strict(), capabilities: vc2.object({ devRoutes: vc2.boolean() }).strict(), channels: vc2.object({ routes: vc2.array(channelRoute), shadowed: vc2.array(shadowedChannelRoute) }).strict(), composition: vc2.object({ disabled: vc2.array(compositionDiagnostic), shadowed: vc2.array(compositionDiagnostic) }).strict(), connections: vc2.array(connection), diagnostics: vc2.object({ discoveryErrors: vc2.number(), discoveryWarnings: vc2.number() }).strict(), hooks: vc2.array(hook), instructions: vc2.object({ dynamic: vc2.array(dynamicResolver), static: vc2.array(instructions) }).strict(), instrumentation: source.optional(), kernelEffects: vc2.array(kernelEffect), kind: vc2.literal(`eve-agent-info`), memories: vc2.array(memory), mode: vc2.enum([`development`, `production`]), remoteAgents: vc2.object({ entries: vc2.array(remoteAgent), total: vc2.number() }).strict(), sandbox, schedules: vc2.array(schedule), skills: vc2.object({ dynamic: vc2.array(dynamicResolver), static: vc2.array(skill) }).strict(), subagents: vc2.object({ local: vc2.array(subagent), total: vc2.number() }).strict(), tools: vc2.object({ dynamic: vc2.array(dynamicResolver), static: vc2.array(tool) }).strict(), version: vc2.literal(5), workspace: vc2.object({ resourceRoot: vc2.unknown(), rootEntries: vc2.array(vc2.string()) }).strict() }).strict().superRefine((e9, t4) => {
  let assertUnique = (e10, n4, r2) => {
    let i3 = /* @__PURE__ */ new Set();
    e10.forEach((e11, a3) => {
      let o3 = n4(e11);
      i3.has(o3) && t4.addIssue({ code: `custom`, message: `Duplicate public identity "${o3}".`, path: [...r2, a3] }), i3.add(o3);
    });
  }, assertTotal = (e10, n4, r2) => {
    (!Number.isSafeInteger(e10) || e10 < 0 || e10 !== n4.length) && t4.addIssue({ code: `custom`, message: `Expected total ${n4.length}, received ${e10}.`, path: [...r2] });
  };
  assertUnique(e9.tools.static, (e10) => e10.name, [`tools`, `static`]), assertUnique(e9.tools.dynamic, (e10) => e10.slug, [`tools`, `dynamic`]), assertUnique(e9.skills.static, (e10) => e10.name, [`skills`, `static`]), assertUnique(e9.skills.dynamic, (e10) => e10.slug, [`skills`, `dynamic`]), assertUnique(e9.instructions.static, (e10) => e10.name, [`instructions`, `static`]), assertUnique(e9.instructions.dynamic, (e10) => e10.slug, [`instructions`, `dynamic`]), assertUnique(e9.schedules, (e10) => e10.name, [`schedules`]), assertUnique(e9.connections, (e10) => e10.connectionName, [`connections`]), assertUnique(e9.hooks, (e10) => e10.slug, [`hooks`]), assertUnique(e9.memories, (e10) => e10.slot, [`memories`]), assertUnique(e9.channels.routes, (e10) => `${e10.method} ${normalizeRoutePattern(e10.urlPath)}`, [`channels`, `routes`]), assertUnique(e9.subagents.local, (e10) => e10.nodeId, [`subagents`, `local`]), assertUnique(e9.remoteAgents.entries, (e10) => e10.nodeId, [`remoteAgents`, `entries`]), assertTotal(e9.subagents.total, e9.subagents.local, [`subagents`, `total`]), assertTotal(e9.remoteAgents.total, e9.remoteAgents.entries, [`remoteAgents`, `total`]);
  let n3 = [[e9.agent.config, [`agent`, `config`]], ...e9.agent.model.source === void 0 ? [] : [[e9.agent.model.source, [`agent`, `model`, `source`]]], ...e9.agent.model.routing.kind === `dynamic` ? [[e9.agent.model.routing.resolver, [`agent`, `model`, `routing`, `resolver`]]] : [], ...e9.channels.routes.map((e10, t5) => [e10, [`channels`, `routes`, t5]]), ...e9.connections.map((e10, t5) => [e10, [`connections`, t5]]), ...e9.hooks.map((e10, t5) => [e10, [`hooks`, t5]]), ...e9.instructions.dynamic.map((e10, t5) => [e10, [`instructions`, `dynamic`, t5]]), ...e9.instructions.static.map((e10, t5) => [e10, [`instructions`, `static`, t5]]), ...e9.memories.map((e10, t5) => [e10, [`memories`, t5]]), ...e9.instrumentation === void 0 ? [] : [[e9.instrumentation, [`instrumentation`]]], ...e9.remoteAgents.entries.map((e10, t5) => [e10, [`remoteAgents`, `entries`, t5]]), ...e9.schedules.map((e10, t5) => [e10, [`schedules`, t5]]), ...e9.skills.dynamic.map((e10, t5) => [e10, [`skills`, `dynamic`, t5]]), ...e9.skills.static.map((e10, t5) => [e10, [`skills`, `static`, t5]]), ...e9.subagents.local.flatMap((e10, t5) => e10.configResolver === void 0 ? [] : [[e10.configResolver, [`subagents`, `local`, t5, `configResolver`]]]), ...e9.tools.dynamic.map((e10, t5) => [e10, [`tools`, `dynamic`, t5]]), ...e9.tools.static.map((e10, t5) => [e10, [`tools`, `static`, t5]]), [e9.sandbox, [`sandbox`]]];
  for (let [e10, r2] of n3) {
    if (e10.sourceKind === `module` && e10.binding === void 0) {
      t4.addIssue({ code: `custom`, message: `Module source is missing its compiled binding.`, path: [...r2, `binding`] });
      continue;
    }
    if (e10.sourceKind !== `module` && e10.binding !== void 0) {
      t4.addIssue({ code: `custom`, message: `${e10.sourceKind} source cannot carry a module binding.`, path: [...r2, `binding`] });
      continue;
    }
    e10.binding !== void 0 && (e10.binding.logicalPath !== e10.logicalPath && t4.addIssue({ code: `custom`, message: `Source and binding logical paths do not match.`, path: [...r2, `binding`, `logicalPath`] }), JSON.stringify(e10.binding.owner) !== JSON.stringify(e10.owner) && t4.addIssue({ code: `custom`, message: `Source and binding owners do not match.`, path: [...r2, `binding`, `owner`] }));
  }
});
function normalizeRoutePattern(e9) {
  return e9.replace(/^\/+|\/+$/g, ``).split(`/`).map((e10) => e10.startsWith(`:`) || /^\[[^\]]+\]$/.test(e10) ? `:` : e10).join(`/`);
}

// node_modules/eve/dist/src/shared/eve-route-path.js
var EVE_NAMED_AGENT_MOUNT_PATTERN = /^\/eve\/[a-z0-9][a-z0-9_-]*$/;
var EVE_NAMED_AGENT_PROTOCOL_PATTERN = /^\/eve\/[a-z0-9][a-z0-9_-]*\/v1$/;
function joinEveRoutePath(e9, t4) {
  let n3 = trimTrailingSlash(e9), r2 = t4.startsWith(`/`) ? t4 : `/${t4}`;
  if (r2 === EVE_ROUTE_PREFIX || r2.startsWith(`${EVE_ROUTE_PREFIX}/`)) {
    if (EVE_NAMED_AGENT_MOUNT_PATTERN.test(n3)) return `${n3}${r2.slice(4)}`;
    if (EVE_NAMED_AGENT_PROTOCOL_PATTERN.test(n3)) return `${n3}${r2.slice(EVE_ROUTE_PREFIX.length)}`;
  }
  return `${n3}${r2}`;
}
function trimTrailingSlash(e9) {
  return e9 === `/` ? `` : e9.endsWith(`/`) ? e9.slice(0, -1) : e9;
}

// node_modules/eve/dist/src/client/url.js
function createClientUrl(e9, t4, n3) {
  let r2 = t4.indexOf(`?`), i3 = r2 === -1 ? t4 : t4.slice(0, r2), a3 = r2 === -1 ? `` : t4.slice(r2 + 1), o3 = i3.startsWith(`/`) ? i3 : `/${i3}`;
  if (isAbsoluteUrl(e9)) {
    let t5 = new URL(e9), r3 = trimTrailingSlash2(t5.pathname);
    return t5.pathname = joinEveRoutePath(r3, o3), mergeEmbeddedQuery(t5.searchParams, a3), mergeSearchParams(t5.searchParams, n3), t5.hash = ``, t5.toString();
  }
  let s3 = new URL(e9, `http://eve.local`), c3 = trimTrailingSlash2(s3.pathname);
  return mergeEmbeddedQuery(s3.searchParams, a3), mergeSearchParams(s3.searchParams, n3), `${joinEveRoutePath(c3, o3)}${formatSearch(s3.searchParams)}`;
}
function mergeEmbeddedQuery(e9, t4) {
  if (t4.length !== 0) for (let [n3, r2] of new URLSearchParams(t4)) e9.append(n3, r2);
}
function isAbsoluteUrl(e9) {
  return /^[a-z][a-z\d+\-.]*:/i.test(e9);
}
function trimTrailingSlash2(e9) {
  return e9 === `/` ? `` : e9.endsWith(`/`) ? e9.slice(0, -1) : e9;
}
function mergeSearchParams(e9, t4) {
  if (t4 !== void 0) for (let [n3, r2] of Object.entries(t4)) e9.set(n3, r2);
}
function formatSearch(e9) {
  let t4 = e9.toString();
  return t4.length === 0 ? `` : `?${t4}`;
}

// node_modules/eve/dist/src/protocol/message-version.js
function normalizeMessageStreamEvent(e9, t4) {
  return nameSkillLoads(normalizeAppendEvent(e9, t4));
}
function normalizeAppendEvent(e9, t4) {
  switch (e9) {
    case `21`:
    case `22`:
    case `23`:
    case `24`:
      return normalizeLegacyMessageStreamEvent(e9, t4);
    case `25`:
    case `26`:
      return validateDeltaMessageStreamEvent(e9, t4);
    default:
      return assertNever(e9);
  }
}
function normalizeLegacyMessageStreamEvent(e9, t4) {
  if (t4.type === `message.appended`) return assertLegacyAppendSnapshot(t4.data.messageSoFar, t4.data.messageDelta, `message`, e9), { data: { messageDelta: t4.data.messageDelta, sequence: t4.data.sequence, stepIndex: t4.data.stepIndex, turnId: t4.data.turnId }, meta: t4.meta, type: `message.appended` };
  if (t4.type === `reasoning.appended`) return assertLegacyAppendSnapshot(t4.data.reasoningSoFar, t4.data.reasoningDelta, `reasoning`, e9), { data: { reasoningDelta: t4.data.reasoningDelta, sequence: t4.data.sequence, stepIndex: t4.data.stepIndex, turnId: t4.data.turnId }, meta: t4.meta, type: `reasoning.appended` };
  if (t4.type === `action.input.appended`) {
    if (e9 !== void 0 && e9 !== `24`) throw TypeError(`Invalid action input append for stream version ${e9}.`);
    return assertLegacyActionInputOffset(t4.data.inputTextOffset, e9), { data: { callId: t4.data.callId, inputTextDelta: t4.data.inputTextDelta, sequence: t4.data.sequence, stepIndex: t4.data.stepIndex, toolName: t4.data.toolName, turnId: t4.data.turnId }, meta: t4.meta, type: `action.input.appended` };
  }
  return t4;
}
function nameSkillLoads(e9) {
  return e9.type !== `actions.requested` || !e9.data.actions.some(isUnnamedSkillLoad) ? e9 : { ...e9, data: { ...e9.data, actions: e9.data.actions.map((e10) => isUnnamedSkillLoad(e10) ? { ...e10, name: releasedSkillName(e10) } : e10) } };
}
function isUnnamedSkillLoad(e9) {
  return e9.kind === `load-skill` && typeof Reflect.get(e9, `name`) != `string`;
}
function releasedSkillName(e9) {
  let t4 = e9.input.skill;
  return typeof t4 == `string` ? t4 : `load_skill`;
}
function validateDeltaMessageStreamEvent(e9, t4) {
  return t4.type === `message.appended` ? (assertAppendDelta(t4.data.messageDelta, `message`, e9), assertUnsupportedAppendField(t4.data, `messageOffset`, `message`, e9), assertUnsupportedAppendField(t4.data, `messageSoFar`, `message`, e9)) : t4.type === `reasoning.appended` ? (assertAppendDelta(t4.data.reasoningDelta, `reasoning`, e9), assertUnsupportedAppendField(t4.data, `reasoningOffset`, `reasoning`, e9), assertUnsupportedAppendField(t4.data, `reasoningSoFar`, `reasoning`, e9)) : t4.type === `action.input.appended` && (assertAppendDelta(t4.data.inputTextDelta, `action input`, e9), assertUnsupportedAppendField(t4.data, `inputTextOffset`, `action input`, e9)), t4;
}
function assertAppendDelta(e9, t4, n3) {
  if (typeof e9 != `string`) throw TypeError(`Invalid ${t4} append delta for stream version ${n3}.`);
}
function assertUnsupportedAppendField(e9, t4, n3, r2) {
  if (t4 in e9) throw TypeError(`Invalid ${n3} append shape for stream version ${r2}.`);
}
function assertNever(e9) {
  throw TypeError(`Unsupported message stream version: ${String(e9)}.`);
}
function assertLegacyActionInputOffset(e9, t4) {
  if (!Number.isSafeInteger(e9) || e9 < 0) {
    let e10 = t4 === void 0 ? `persisted stream` : `stream version ${t4}`;
    throw TypeError(`Invalid action input append offset for ${e10}.`);
  }
}
function assertLegacyAppendSnapshot(e9, t4, n3, r2) {
  let i3 = e9.length - t4.length;
  if (i3 < 0 || e9.slice(i3) !== t4) {
    let e10 = r2 === void 0 ? `persisted stream` : `stream version ${r2}`;
    throw TypeError(`Invalid cumulative ${n3} append for ${e10}.`);
  }
}

// node_modules/eve/dist/src/client/ndjson.js
function isStreamDisconnectError(e9) {
  if (e9 instanceof DOMException) return e9.name === `AbortError`;
  if (!(e9 instanceof Error)) return false;
  let t4 = `code` in e9 && typeof e9.code == `string` ? e9.code : void 0;
  return e9.name === `AbortError` || e9.message === `terminated` || t4 === `UND_ERR_SOCKET` || e9 instanceof TypeError && /^(?:failed to fetch|fetch failed|load failed|networkerror when attempting to fetch resource\.)$/i.test(e9.message) || /abort|cancel|disconnect|premature close|socket|terminated/i.test(e9.message);
}
async function* readNdjsonStream(e9, t4) {
  let n3 = e9.getReader(), r2 = new TextDecoder(), i3 = ``, a3 = false, abort = () => {
    n3.cancel().catch(() => {
    });
  };
  t4.signal?.addEventListener(`abort`, abort, { once: true });
  try {
    for (; ; ) {
      throwIfAborted(t4.signal);
      let e11 = await readWithIdleTimeout(n3, t4?.idleTimeoutMs);
      if (throwIfAborted(t4.signal), e11.done) {
        a3 = true, i3 += r2.decode();
        break;
      }
      e11.value && (i3 += r2.decode(e11.value, { stream: true }));
      let o3 = i3.indexOf(`
`);
      for (; o3 !== -1; ) {
        let e12 = i3.slice(0, o3).trim();
        if (i3 = i3.slice(o3 + 1), e12.length > 0) {
          let n4 = JSON.parse(e12);
          t4.controlVersion === `1` && isLeaseEndedControl(n4) ? t4.onLeaseEnded?.() : yield parseMessageStreamEvent(n4, t4.streamVersion);
        }
        o3 = i3.indexOf(`
`);
      }
    }
    let e10 = i3.trim();
    if (e10.length > 0) {
      let n4 = JSON.parse(e10);
      t4.controlVersion === `1` && isLeaseEndedControl(n4) ? t4.onLeaseEnded?.() : yield parseMessageStreamEvent(n4, t4.streamVersion);
    }
  } finally {
    t4.signal?.removeEventListener(`abort`, abort), a3 || n3.cancel().catch(() => {
    }), n3.releaseLock();
  }
}
function isLeaseEndedControl(e9) {
  if (typeof e9 != `object` || !e9) return false;
  let t4 = e9;
  return t4.$eve === EVE_STREAM_LEASE_ENDED_CONTROL.$eve && t4.version === EVE_STREAM_LEASE_ENDED_CONTROL.version;
}
function parseMessageStreamEvent(e9, t4) {
  return normalizeMessageStreamEvent(t4, e9);
}
async function readWithIdleTimeout(e9, t4) {
  let n3;
  try {
    return t4 === void 0 ? await e9.read() : await Promise.race([e9.read(), new Promise((e10, r2) => {
      n3 = setTimeout(() => r2(new DOMException(`Session stream was idle.`, `AbortError`)), t4);
    })]);
  } catch (e10) {
    throw e10 instanceof TypeError ? Error(`Session stream disconnected.`, { cause: e10 }) : e10;
  } finally {
    n3 !== void 0 && clearTimeout(n3);
  }
}

// node_modules/eve/dist/src/client/stream-version.js
var supportedMessageStreamVersions = { 21: true, 22: true, 23: true, 24: true, 25: true, 26: true };
function readMessageStreamVersion(e9) {
  let t4 = e9.get(EVE_STREAM_VERSION_HEADER);
  if (t4 !== null && Object.hasOwn(supportedMessageStreamVersions, t4)) return t4;
  throw TypeError(t4 === null ? `Missing ${EVE_STREAM_VERSION_HEADER} response header.` : `Unsupported message stream version: ${t4}.`);
}

// node_modules/eve/dist/src/client/open-stream.js
var DEFAULT_STREAM_RECONNECT_POLICY = { retryableErrorStatuses: /* @__PURE__ */ new Set([404, 409, 425, 500, 502, 503, 504]), streamIdleReconnectPolicy: { baseDelayMs: 250, maxAttempts: 5, maxDelayMs: 4e3 }, streamOpenReconnectPolicy: { baseDelayMs: 250, maxAttempts: 12, maxDelayMs: 5e3 } };
var NO_STREAM_RECONNECT_POLICY = { ...DEFAULT_STREAM_RECONNECT_POLICY, streamIdleReconnectPolicy: { ...DEFAULT_STREAM_RECONNECT_POLICY.streamIdleReconnectPolicy, maxAttempts: 0 }, streamOpenReconnectPolicy: { ...DEFAULT_STREAM_RECONNECT_POLICY.streamOpenReconnectPolicy, maxAttempts: 1 } };
function resolveRetryPolicy(e9, t4) {
  return { ...t4, ...e9 };
}
function resolveStreamReconnectPolicy(e9, t4 = false) {
  if (e9 && `reconnect` in e9 && e9.reconnect === false) return NO_STREAM_RECONNECT_POLICY;
  let n3 = e9;
  return { retryableErrorStatuses: n3?.retryableErrorStatuses ? new Set(n3.retryableErrorStatuses) : DEFAULT_STREAM_RECONNECT_POLICY.retryableErrorStatuses, streamIdleReconnectPolicy: resolveRetryPolicy(n3?.streamIdleReconnectPolicy, { ...DEFAULT_STREAM_RECONNECT_POLICY.streamIdleReconnectPolicy, maxAttempts: t4 ? 1 / 0 : DEFAULT_STREAM_RECONNECT_POLICY.streamIdleReconnectPolicy.maxAttempts }), streamOpenReconnectPolicy: resolveRetryPolicy(n3?.streamOpenReconnectPolicy, DEFAULT_STREAM_RECONNECT_POLICY.streamOpenReconnectPolicy) };
}
async function* followStreamIterable(e9) {
  if (e9.follow === false && e9.startIndex < 0) throw Error(`stream({ follow: false }) requires a nonnegative startIndex; a tail-relative cursor cannot be bounded.`);
  let resolvePolicy = () => resolveStreamReconnectPolicy(e9.resolveReconnectPolicy === void 0 ? e9.streamReconnectPolicy : e9.resolveReconnectPolicy(), e9.keepAlive), t4 = resolvePolicy(), n3 = t4.streamIdleReconnectPolicy, r2 = e9.startIndex, i3 = n3.baseDelayMs, a3 = 0, o3 = true, s3, c3 = false;
  for (; ; ) {
    t4 = resolvePolicy(), n3 = t4.streamIdleReconnectPolicy;
    let l3;
    try {
      l3 = await openStreamBody({ ...e9, retryPolicy: t4, startIndex: r2, requestTailIndex: (e9.follow === false || e9.onCaughtUp !== void 0) && s3 === void 0 });
    } catch (t5) {
      if (e9.signal?.aborted) return;
      throw t5;
    }
    if ((e9.follow === false || e9.onCaughtUp !== void 0) && s3 === void 0 && (s3 = l3.tailIndex, s3 === void 0)) throw l3.close(), Error(`stream({ follow: false }) requires the server to report the ${EVE_STREAM_TAIL_INDEX_HEADER} header. The agent may be running an older eve version.`);
    if (!c3 && s3 !== void 0 && r2 > s3 && (c3 = true, e9.onCaughtUp?.()), e9.follow === false && s3 !== void 0 && r2 > s3) {
      l3.close();
      return;
    }
    let u3 = false, d3 = false;
    try {
      for await (let t5 of readNdjsonStream(l3.body, { signal: e9.signal, controlVersion: l3.controlVersion, idleTimeoutMs: e9.streamReadIdleTimeoutMs ?? 15e3, onLeaseEnded: () => {
        d3 = true;
      }, streamVersion: l3.streamVersion })) if (r2 += 1, u3 = true, i3 = n3.baseDelayMs, a3 = 0, yield t5, !c3 && s3 !== void 0 && r2 > s3 && (c3 = true, e9.onCaughtUp?.()), t5.type === `session.failed` || t5.type === `session.completed` || e9.follow === false && s3 !== void 0 && r2 > s3) return;
    } catch (e10) {
      if (!isStreamDisconnectError(e10)) throw e10;
    } finally {
      l3.close();
    }
    if (n3 = resolvePolicy().streamIdleReconnectPolicy, e9.signal?.aborted || e9.startIndex < 0 || n3.maxAttempts === 0) return;
    if (!d3) {
      if (!u3 && !o3 && (a3 += 1) >= n3.maxAttempts || (o3 = false, await sleep(i3, e9.signal), e9.signal?.aborted)) return;
      i3 = Math.min(i3 * 2, n3.maxDelayMs);
    }
  }
}
async function openStreamBody(e9) {
  let t4 = e9.retryPolicy ?? resolveStreamReconnectPolicy(e9.streamReconnectPolicy, e9.keepAlive), n3 = t4.streamOpenReconnectPolicy, r2, i3, a3, o3 = n3.baseDelayMs, s3 = e9.startIndex >= 0 && t4.streamIdleReconnectPolicy.maxAttempts > 0 ? EVE_STREAM_CONTROL_VERSION : void 0, c3 = {};
  s3 !== void 0 && (c3[EVE_STREAM_CONTROL_VERSION_QUERY] = s3), e9.startIndex !== 0 && (c3.startIndex = String(e9.startIndex)), e9.requestTailIndex === true && (c3.includeTailIndex = `1`), e9.follow === false && (c3.follow = `false`);
  for (let l3 = 0; l3 < n3.maxAttempts; l3 += 1) {
    throwIfAborted(e9.signal);
    let u3 = createClientUrl(e9.host, e9.path, Object.keys(c3).length > 0 ? c3 : void 0), d3 = await e9.resolveHeaders();
    throwIfAborted(e9.signal);
    let f3 = new AbortController(), p3 = e9.signal ? AbortSignal.any([e9.signal, f3.signal]) : f3.signal, m3;
    try {
      m3 = await fetch(u3, { cache: `no-store`, headers: d3, redirect: e9.redirect, signal: p3 });
    } catch (t5) {
      if (e9.signal?.aborted || !isStreamDisconnectError(t5) || l3 === n3.maxAttempts - 1) throw t5;
      await sleep(o3, e9.signal), o3 = Math.min(o3 * 2, n3.maxDelayMs);
      continue;
    }
    if (m3.ok) {
      if (!m3.body) throw new ClientError(m3.status, `Response body is null.`, m3.headers);
      let e10 = false;
      return { body: m3.body, close: () => {
        e10 || (e10 = true, m3.body?.cancel().catch(() => {
        }), f3.abort());
      }, controlVersion: s3, streamVersion: readMessageStreamVersion(m3.headers), tailIndex: parseTailIndexHeader(m3.headers) };
    }
    r2 = m3.status, i3 = await m3.text(), a3 = m3.headers;
    let h3 = createClientError(m3.status, i3, m3.headers);
    if (h3 instanceof ClientSessionStrandedError || !t4.retryableErrorStatuses.has(m3.status)) throw h3;
    l3 < n3.maxAttempts - 1 && (await sleep(o3, e9.signal), o3 = Math.min(o3 * 2, n3.maxDelayMs));
  }
  throw new ClientError(r2 ?? 0, i3 ?? `Failed to open message stream.`, a3);
}
function parseTailIndexHeader(e9) {
  let t4 = e9.get(EVE_STREAM_TAIL_INDEX_HEADER);
  if (t4 === null || !/^-?\d+$/.test(t4)) return;
  let n3 = Number(t4);
  return Number.isSafeInteger(n3) ? n3 : void 0;
}
async function sleep(e9, t4) {
  t4?.aborted || await new Promise((n3) => {
    let onAbort = () => {
      clearTimeout(r2), n3();
    }, r2 = setTimeout(() => {
      t4?.removeEventListener(`abort`, onAbort), n3();
    }, e9);
    t4?.addEventListener(`abort`, onAbort, { once: true });
  });
}

// node_modules/eve/dist/src/client/output-schema.js
function extractCompletedResult(e9) {
  let t4;
  for (let n3 of e9) isResultCompletedEvent(n3) && (t4 = n3.data.result);
  return t4;
}
function isResultCompletedEvent(e9) {
  return e9.type === `result.completed`;
}

// node_modules/eve/dist/src/client/message-response.js
var consumeResponse = /* @__PURE__ */ Symbol(`consumeMessageResponse`);
var acceptedDeliveryId = /* @__PURE__ */ Symbol(`acceptedDeliveryId`);
var MessageResponse = class {
  sessionId;
  [acceptedDeliveryId];
  #e;
  #t;
  #n = false;
  #r;
  #i;
  #a = false;
  #o = Promise.withResolvers();
  constructor(e9) {
    this.#e = e9.cancelTurn, this.sessionId = e9.sessionId, this[acceptedDeliveryId] = e9.deliveryId, this.#r = e9.createStream, this.#i = e9.resumesTurn ?? false;
  }
  cancel() {
    if (this.#a) return Promise.resolve({ status: `no_active_turn` });
    if (this.#t !== void 0) return this.#t;
    let e9 = this.#o.promise.then((e10) => e10 === void 0 ? { status: `no_active_turn` } : this.#e(e10));
    return this.#t = e9, e9.catch(() => {
      !this.#a && this.#t === e9 && (this.#t = void 0);
    }), e9;
  }
  async result() {
    let e9 = [];
    for await (let t5 of this) e9.push(t5);
    let t4 = summarizeTurnEvents(e9);
    return { data: extractCompletedResult(e9), events: e9, inputRequests: t4.inputRequests, message: t4.message, sessionId: this.sessionId, status: t4.status };
  }
  [Symbol.asyncIterator]() {
    return this[consumeResponse]();
  }
  [consumeResponse](e9) {
    if (this.#n) throw Error(`MessageResponse has already been consumed.`);
    return this.#n = true, this.#s(e9);
  }
  async *#s(e9) {
    try {
      for await (let t4 of this.#r(e9)) t4.type === `turn.started` || this.#i && t4.type === `input.resolved` ? this.#o.resolve(t4.data.turnId) : isCurrentTurnBoundaryEvent(t4) && (this.#a = true, this.#o.resolve(void 0)), yield t4;
    } finally {
      this.#o.resolve(void 0);
    }
  }
};
function getMessageResponseDeliveryId(e9) {
  return e9[acceptedDeliveryId];
}
function consumeMessageResponse(e9, t4) {
  return e9[consumeResponse](t4);
}

// node_modules/eve/dist/src/client/agent-session.js
var ClientAgentSession = class {
  name;
  sessionId;
  taskId;
  #e;
  #t;
  constructor(e9, t4) {
    this.#e = e9, this.#t = t4.data.streamPath, this.name = t4.data.name, this.sessionId = t4.data.sessionId, this.taskId = t4.data.taskId;
  }
  stream(e9) {
    let t4 = e9?.startIndex ?? 0;
    if (e9?.follow === false && t4 < 0) throw Error(`agent(started).stream({ follow: false }) requires a nonnegative startIndex; a tail-relative cursor cannot be bounded.`);
    return followStreamIterable({ follow: e9?.follow, host: this.#e.host, path: this.#t, redirect: this.#e.redirect, resolveHeaders: () => this.#e.resolveHeaders(), signal: e9?.signal, startIndex: t4, streamReconnectPolicy: e9?.streamReconnectPolicy });
  }
};

// node_modules/eve/dist/src/protocol/cancel-turn.js
var CancelTurnResponseSchema = vc2.discriminatedUnion(`status`, [vc2.strictObject({ ok: vc2.literal(true), sessionId: vc2.string().min(1), status: vc2.literal(`accepted`) }), vc2.strictObject({ ok: vc2.literal(true), status: vc2.literal(`no_active_turn`) })]);

// node_modules/eve/dist/src/protocol/clear-session.js
var ClearResponseSchema = vc2.discriminatedUnion(`status`, [vc2.object({ ok: vc2.literal(true), sessionId: vc2.string().min(1), status: vc2.literal(`accepted`) }), vc2.object({ ok: vc2.literal(true), status: vc2.literal(`no_active_session`) })]);

// node_modules/eve/dist/src/protocol/compact-session.js
var CompactResponseSchema = vc2.discriminatedUnion(`status`, [vc2.object({ ok: vc2.literal(true), sessionId: vc2.string().min(1), status: vc2.literal(`accepted`) }), vc2.object({ ok: vc2.literal(true), status: vc2.literal(`no_active_session`) })]);

// node_modules/eve/dist/src/protocol/reset-session.js
var ResetResponseSchema = vc2.discriminatedUnion(`status`, [vc2.object({ ok: vc2.literal(true), previousSessionId: vc2.string().min(1), status: vc2.literal(`reset`) }), vc2.object({ ok: vc2.literal(true), status: vc2.literal(`no_active_session`) })]);

// node_modules/eve/dist/src/client/session-controls.js
async function cancelClientSession(e9) {
  let { signal: t4, ...n3 } = e9.options ?? {}, { payload: r2, response: i3 } = await postJson({ body: n3, context: e9.context, operation: `Cancel`, path: createEveSessionCancelRoutePath(e9.sessionId), signal: t4 }), a3 = CancelTurnResponseSchema.safeParse(r2);
  if (!a3.success || a3.data.status === `accepted` && a3.data.sessionId !== e9.sessionId) throw Error(`Cancel route returned an invalid response (${i3.status}).`);
  return a3.data.status === `accepted` ? { sessionId: a3.data.sessionId, status: `accepted` } : { status: `no_active_turn` };
}
async function clearClientSession(e9) {
  let { payload: t4 } = await postJson({ context: e9.context, operation: `Clear`, path: createEveSessionClearRoutePath(e9.sessionId) }), n3 = ClearResponseSchema.safeParse(t4);
  if (!n3.success || n3.data.status === `accepted` && n3.data.sessionId !== e9.sessionId) throw Error(`Clear route returned an invalid response.`);
  return n3.data.status === `accepted` ? { sessionId: n3.data.sessionId, status: `accepted` } : { status: `no_active_session` };
}
async function compactClientSession(e9) {
  let { payload: t4 } = await postJson({ context: e9.context, operation: `Compact`, path: createEveSessionCompactRoutePath(e9.sessionId) }), n3 = CompactResponseSchema.safeParse(t4);
  if (!n3.success || n3.data.status === `accepted` && n3.data.sessionId !== e9.sessionId) throw Error(`Compact route returned an invalid response.`);
  return n3.data.status === `accepted` ? { sessionId: n3.data.sessionId, status: `accepted` } : { status: `no_active_session` };
}
async function resetClientSession(e9) {
  let { signal: t4, ...n3 } = e9.options ?? {}, { payload: r2 } = await postJson({ body: n3, context: e9.context, operation: `Reset`, path: createEveSessionResetRoutePath(e9.sessionId), signal: t4 }), i3 = ResetResponseSchema.safeParse(r2);
  if (!i3.success || i3.data.status === `reset` && i3.data.previousSessionId !== e9.sessionId) throw Error(`Reset route returned an invalid response.`);
  return i3.data.status === `reset` ? { previousSessionId: i3.data.previousSessionId, status: `reset` } : { status: `no_active_session` };
}
async function postJson(e9) {
  let t4 = await e9.context.resolveHeaders();
  t4.set(`content-type`, `application/json`);
  let n3 = await fetch(createClientUrl(e9.context.host, e9.path), withRedirectPolicy({ body: e9.body === void 0 ? void 0 : JSON.stringify(e9.body), headers: t4, method: `POST`, signal: e9.signal }, e9.context.redirect)), r2 = await n3.text();
  if (!n3.ok) throw createClientError(n3.status, r2, n3.headers);
  try {
    return { payload: JSON.parse(r2), response: n3 };
  } catch {
    throw Error(`${e9.operation} route returned invalid JSON (${n3.status}).`);
  }
}
function withRedirectPolicy(e9, t4) {
  return t4 === void 0 ? e9 : { ...e9, redirect: t4 };
}

// node_modules/eve/dist/src/tools/schema-emission.js
function serializeOutputSchema(e9) {
  return e9 == null ? e9 : emitJsonSchema(e9, `output`);
}
function emitJsonSchema(e9, t4) {
  let n3 = getStandardSchemaProperties(e9);
  if (n3 === void 0) return withoutSchemaVersion(parseJsonObject(e9));
  let r2 = readJsonSchemaEmitter(n3, t4);
  if (r2 === void 0) throw Error(describeMissingEmitter(n3));
  return withoutSchemaVersion(parseJsonObject(r2({ target: `draft-07` })));
}
function readJsonSchemaEmitter(e9, t4) {
  let n3 = e9.jsonSchema;
  if (typeof n3 != `object` || !n3) return;
  let r2 = n3[t4];
  return typeof r2 == `function` ? r2 : void 0;
}
function getStandardSchemaProperties(e9) {
  if (typeof e9 != `object` || !e9 || !(`~standard` in e9)) return;
  let t4 = e9[`~standard`];
  return typeof t4 == `object` && t4 ? t4 : void 0;
}
function describeMissingEmitter(e9) {
  let t4 = typeof e9.vendor == `string` ? e9.vendor : `unknown`;
  return t4 === `zod` ? `Zod 3 cannot emit an output JSON Schema. Upgrade to Zod 4 or provide a plain JSON Schema object.` : `Standard Schema vendor "${t4}" does not support JSON Schema conversion. Provide a Standard Schema implementation with JSON Schema conversion or a plain JSON Schema object.`;
}
function withoutSchemaVersion(e9) {
  let { $schema: t4, ...n3 } = e9;
  return n3;
}

// node_modules/eve/dist/src/compiled/@cfworker/json-schema/index.js
function e8(t4, n3) {
  let r2 = typeof t4;
  if (r2 !== typeof n3) return false;
  if (Array.isArray(t4)) {
    if (!Array.isArray(n3)) return false;
    let r3 = t4.length;
    if (r3 !== n3.length) return false;
    for (let i3 = 0; i3 < r3; i3++) if (!e8(t4[i3], n3[i3])) return false;
    return true;
  }
  if (r2 === `object`) {
    if (!t4 || !n3) return t4 === n3;
    let r3 = Object.keys(t4), i3 = Object.keys(n3);
    if (r3.length !== i3.length) return false;
    for (let i4 of r3) if (!e8(t4[i4], n3[i4])) return false;
    return true;
  }
  return t4 === n3;
}
function t3(e9) {
  return encodeURI(n2(e9));
}
function n2(e9) {
  return e9.replace(/~/g, `~0`).replace(/\//g, `~1`);
}
var i2 = { prefixItems: true, items: true, allOf: true, anyOf: true, oneOf: true };
var a2 = { $defs: true, definitions: true, properties: true, patternProperties: true, dependentSchemas: true };
var o2 = { id: true, $id: true, $ref: true, $schema: true, $anchor: true, $vocabulary: true, $comment: true, default: true, enum: true, const: true, required: true, type: true, maximum: true, minimum: true, exclusiveMaximum: true, exclusiveMinimum: true, multipleOf: true, maxLength: true, minLength: true, pattern: true, format: true, maxItems: true, minItems: true, uniqueItems: true, maxProperties: true, minProperties: true };
var s2 = typeof self < `u` && self.location && self.location.origin !== `null` ? new URL(self.location.origin + self.location.pathname + location.search) : new URL(`https://github.com/cfworker`);
function c2(e9, n3 = /* @__PURE__ */ Object.create(null), r2 = s2, l3 = ``) {
  if (e9 && typeof e9 == `object` && !Array.isArray(e9)) {
    let t4 = e9.$id || e9.id;
    if (t4) {
      let i3 = new URL(t4, r2.href);
      i3.hash.length > 1 ? n3[i3.href] = e9 : (i3.hash = ``, l3 === `` ? r2 = i3 : c2(e9, n3, r2));
    }
  } else if (e9 !== true && e9 !== false) return n3;
  let u3 = r2.href + (l3 ? `#` + l3 : ``);
  if (n3[u3] !== void 0) throw Error(`Duplicate schema URI "${u3}".`);
  if (n3[u3] = e9, e9 === true || e9 === false) return n3;
  if (e9.__absolute_uri__ === void 0 && Object.defineProperty(e9, "__absolute_uri__", { enumerable: false, value: u3 }), e9.$ref && e9.__absolute_ref__ === void 0) {
    let t4 = new URL(e9.$ref, r2.href);
    t4.hash = t4.hash, Object.defineProperty(e9, "__absolute_ref__", { enumerable: false, value: t4.href });
  }
  if (e9.$recursiveRef && e9.__absolute_recursive_ref__ === void 0) {
    let t4 = new URL(e9.$recursiveRef, r2.href);
    t4.hash = t4.hash, Object.defineProperty(e9, "__absolute_recursive_ref__", { enumerable: false, value: t4.href });
  }
  if (e9.$anchor) {
    let t4 = new URL(`#` + e9.$anchor, r2.href);
    n3[t4.href] = e9;
  }
  for (let s3 in e9) {
    if (o2[s3]) continue;
    let u4 = `${l3}/${t3(s3)}`, d3 = e9[s3];
    if (Array.isArray(d3)) {
      if (i2[s3]) {
        let e10 = d3.length;
        for (let t4 = 0; t4 < e10; t4++) c2(d3[t4], n3, r2, `${u4}/${t4}`);
      }
    } else if (a2[s3]) for (let e10 in d3) c2(d3[e10], n3, r2, `${u4}/${t3(e10)}`);
    else c2(d3, n3, r2, u4);
  }
  return n3;
}
var l2 = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
var u2 = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
var d2 = /^(\d\d):(\d\d):(\d\d)(\.\d+)?(z|[+-]\d\d(?::?\d\d)?)?$/i;
var f2 = /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i;
var p2 = /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
var m2 = /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i;
var h2 = /^(?:(?:https?|ftp):\/\/)(?:\S+(?::\S*)?@)?(?:(?!10(?:\.\d{1,3}){3})(?!127(?:\.\d{1,3}){3})(?!169\.254(?:\.\d{1,3}){2})(?!192\.168(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)(?:\.(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu;
var g2 = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
var _2 = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
var v2 = /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i;
var y2 = /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/;
var ee2 = (e9) => {
  if (e9[0] === `"`) return false;
  let [t4, n3, ...r2] = e9.split(`@`);
  return !t4 || !n3 || r2.length !== 0 || t4.length > 64 || n3.length > 253 || t4[0] === `.` || t4.endsWith(`.`) || t4.includes(`..`) || !/^[a-z0-9.-]+$/i.test(n3) || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(t4) ? false : n3.split(`.`).every((e10) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(e10));
};
var b2 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
var x3 = /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i;
var S3 = (e9) => e9.length > 1 && e9.length < 80 && (/^P\d+([.,]\d+)?W$/.test(e9) || /^P[\dYMDTHS]*(\d[.,]\d+)?[YMDHS]$/.test(e9) && /^P([.,\d]+Y)?([.,\d]+M)?([.,\d]+D)?(T([.,\d]+H)?([.,\d]+M)?([.,\d]+S)?)?$/.test(e9));
function C3(e9) {
  return e9.test.bind(e9);
}
var w3 = { date: E3, time: D3.bind(void 0, false), "date-time": k3, duration: S3, uri: j3, "uri-reference": C3(p2), "uri-template": C3(m2), url: C3(h2), email: ee2, hostname: C3(f2), ipv4: C3(b2), ipv6: C3(x3), regex: N3, uuid: C3(g2), "json-pointer": C3(_2), "json-pointer-uri-fragment": C3(v2), "relative-json-pointer": C3(y2) };
function T3(e9) {
  return e9 % 4 == 0 && (e9 % 100 != 0 || e9 % 400 == 0);
}
function E3(e9) {
  let t4 = e9.match(l2);
  if (!t4) return false;
  let n3 = +t4[1], r2 = +t4[2], i3 = +t4[3];
  return r2 >= 1 && r2 <= 12 && i3 >= 1 && i3 <= (r2 == 2 && T3(n3) ? 29 : u2[r2]);
}
function D3(e9, t4) {
  let n3 = t4.match(d2);
  if (!n3) return false;
  let r2 = +n3[1], i3 = +n3[2], a3 = +n3[3], o3 = !!n3[5];
  return (r2 <= 23 && i3 <= 59 && a3 <= 59 || r2 == 23 && i3 == 59 && a3 == 60) && (!e9 || o3);
}
var O3 = /t|\s/i;
function k3(e9) {
  let t4 = e9.split(O3);
  return t4.length == 2 && E3(t4[0]) && D3(true, t4[1]);
}
var A3 = /\/|:/;
var te2 = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
function j3(e9) {
  return A3.test(e9) && te2.test(e9);
}
var M3 = /[^\\]\\Z/;
function N3(e9) {
  if (M3.test(e9)) return false;
  try {
    return new RegExp(e9, `u`), true;
  } catch {
    return false;
  }
}
var P3;
(function(e9) {
  e9[e9.Flag = 1] = `Flag`, e9[e9.Basic = 2] = `Basic`, e9[e9.Detailed = 4] = `Detailed`;
})(P3 ||= {});
function ne2(e9) {
  let t4 = 0, n3 = e9.length, r2 = 0, i3;
  for (; r2 < n3; ) t4++, i3 = e9.charCodeAt(r2++), i3 >= 55296 && i3 <= 56319 && r2 < n3 && (i3 = e9.charCodeAt(r2), (i3 & 64512) == 56320 && r2++);
  return t4;
}
function F3(n3, r2, i3 = `2019-09`, a3 = c2(r2), o3 = true, s3 = null, l3 = `#`, u3 = `#`, d3 = /* @__PURE__ */ Object.create(null)) {
  if (r2 === true) return { valid: true, errors: [] };
  if (r2 === false) return { valid: false, errors: [{ instanceLocation: l3, keyword: `false`, keywordLocation: l3, error: `False boolean schema.` }] };
  let f3 = typeof n3, p3;
  switch (f3) {
    case `boolean`:
    case `number`:
    case `string`:
      p3 = f3;
      break;
    case `object`:
      p3 = n3 === null ? `null` : Array.isArray(n3) ? `array` : `object`;
      break;
    default:
      throw Error(`Instances of "${f3}" type are not supported.`);
  }
  let { $ref: m3, $recursiveRef: h3, $recursiveAnchor: g3, type: _3, const: v3, enum: y3, required: ee3, not: b3, anyOf: x4, allOf: S4, oneOf: C4, if: T4, then: E4, else: D4, format: O4, properties: k4, patternProperties: A4, additionalProperties: te3, unevaluatedProperties: j4, minProperties: M4, maxProperties: N4, propertyNames: P4, dependentRequired: I4, dependentSchemas: L3, dependencies: R3, prefixItems: re2, items: z3, additionalItems: ie2, unevaluatedItems: ae2, contains: oe2, minContains: B3, maxContains: V3, minItems: H3, maxItems: U3, uniqueItems: se2, minimum: W3, maximum: G3, exclusiveMinimum: K3, exclusiveMaximum: q3, multipleOf: J3, minLength: Y3, maxLength: X3, pattern: ce2, __absolute_ref__: Z3, __absolute_recursive_ref__: le2 } = r2, Q3 = [];
  if (g3 === true && s3 === null && (s3 = r2), h3 === `#`) {
    let e9 = s3 === null ? a3[le2] : s3, t4 = `${u3}/$recursiveRef`, c3 = F3(n3, s3 === null ? r2 : s3, i3, a3, o3, e9, l3, t4, d3);
    c3.valid || Q3.push({ instanceLocation: l3, keyword: `$recursiveRef`, keywordLocation: t4, error: `A subschema had errors.` }, ...c3.errors);
  }
  if (m3 !== void 0) {
    let e9 = a3[Z3 || m3];
    if (e9 === void 0) {
      let e10 = `Unresolved $ref "${m3}".`;
      throw Z3 && Z3 !== m3 && (e10 += `  Absolute URI "${Z3}".`), e10 += `
Known schemas:
- ${Object.keys(a3).join(`
- `)}`, Error(e10);
    }
    let t4 = `${u3}/$ref`, r3 = F3(n3, e9, i3, a3, o3, s3, l3, t4, d3);
    if (r3.valid || Q3.push({ instanceLocation: l3, keyword: `$ref`, keywordLocation: t4, error: `A subschema had errors.` }, ...r3.errors), i3 === `4` || i3 === `7`) return { valid: Q3.length === 0, errors: Q3 };
  }
  if (Array.isArray(_3)) {
    let e9 = _3.length, t4 = false;
    for (let r3 = 0; r3 < e9; r3++) if (p3 === _3[r3] || _3[r3] === `integer` && p3 === `number` && n3 % 1 == 0 && n3 === n3) {
      t4 = true;
      break;
    }
    t4 || Q3.push({ instanceLocation: l3, keyword: `type`, keywordLocation: `${u3}/type`, error: `Instance type "${p3}" is invalid. Expected "${_3.join(`", "`)}".` });
  } else _3 === `integer` ? (p3 !== `number` || n3 % 1 || n3 !== n3) && Q3.push({ instanceLocation: l3, keyword: `type`, keywordLocation: `${u3}/type`, error: `Instance type "${p3}" is invalid. Expected "${_3}".` }) : _3 !== void 0 && p3 !== _3 && Q3.push({ instanceLocation: l3, keyword: `type`, keywordLocation: `${u3}/type`, error: `Instance type "${p3}" is invalid. Expected "${_3}".` });
  if (v3 !== void 0 && (p3 === `object` || p3 === `array` ? e8(n3, v3) || Q3.push({ instanceLocation: l3, keyword: `const`, keywordLocation: `${u3}/const`, error: `Instance does not match ${JSON.stringify(v3)}.` }) : n3 !== v3 && Q3.push({ instanceLocation: l3, keyword: `const`, keywordLocation: `${u3}/const`, error: `Instance does not match ${JSON.stringify(v3)}.` })), y3 !== void 0 && (p3 === `object` || p3 === `array` ? y3.some((t4) => e8(n3, t4)) || Q3.push({ instanceLocation: l3, keyword: `enum`, keywordLocation: `${u3}/enum`, error: `Instance does not match any of ${JSON.stringify(y3)}.` }) : y3.some((e9) => n3 === e9) || Q3.push({ instanceLocation: l3, keyword: `enum`, keywordLocation: `${u3}/enum`, error: `Instance does not match any of ${JSON.stringify(y3)}.` })), b3 !== void 0) {
    let e9 = `${u3}/not`;
    F3(n3, b3, i3, a3, o3, s3, l3, e9).valid && Q3.push({ instanceLocation: l3, keyword: `not`, keywordLocation: e9, error: `Instance matched "not" schema.` });
  }
  let $3 = [];
  if (x4 !== void 0) {
    let e9 = `${u3}/anyOf`, t4 = Q3.length, r3 = false;
    for (let t5 = 0; t5 < x4.length; t5++) {
      let c3 = x4[t5], u4 = Object.create(d3), f4 = F3(n3, c3, i3, a3, o3, g3 === true ? s3 : null, l3, `${e9}/${t5}`, u4);
      Q3.push(...f4.errors), r3 ||= f4.valid, f4.valid && $3.push(u4);
    }
    r3 ? Q3.length = t4 : Q3.splice(t4, 0, { instanceLocation: l3, keyword: `anyOf`, keywordLocation: e9, error: `Instance does not match any subschemas.` });
  }
  if (S4 !== void 0) {
    let e9 = `${u3}/allOf`, t4 = Q3.length, r3 = true;
    for (let t5 = 0; t5 < S4.length; t5++) {
      let c3 = S4[t5], u4 = Object.create(d3), f4 = F3(n3, c3, i3, a3, o3, g3 === true ? s3 : null, l3, `${e9}/${t5}`, u4);
      Q3.push(...f4.errors), r3 &&= f4.valid, f4.valid && $3.push(u4);
    }
    r3 ? Q3.length = t4 : Q3.splice(t4, 0, { instanceLocation: l3, keyword: `allOf`, keywordLocation: e9, error: `Instance does not match every subschema.` });
  }
  if (C4 !== void 0) {
    let e9 = `${u3}/oneOf`, t4 = Q3.length, r3 = C4.filter((t5, r4) => {
      let c3 = Object.create(d3), u4 = F3(n3, t5, i3, a3, o3, g3 === true ? s3 : null, l3, `${e9}/${r4}`, c3);
      return Q3.push(...u4.errors), u4.valid && $3.push(c3), u4.valid;
    }).length;
    r3 === 1 ? Q3.length = t4 : Q3.splice(t4, 0, { instanceLocation: l3, keyword: `oneOf`, keywordLocation: e9, error: `Instance does not match exactly one subschema (${r3} matches).` });
  }
  if ((p3 === `object` || p3 === `array`) && Object.assign(d3, ...$3), T4 !== void 0) {
    let e9 = `${u3}/if`;
    if (F3(n3, T4, i3, a3, o3, s3, l3, e9, d3).valid) {
      if (E4 !== void 0) {
        let t4 = F3(n3, E4, i3, a3, o3, s3, l3, `${u3}/then`, d3);
        t4.valid || Q3.push({ instanceLocation: l3, keyword: `if`, keywordLocation: e9, error: `Instance does not match "then" schema.` }, ...t4.errors);
      }
    } else if (D4 !== void 0) {
      let t4 = F3(n3, D4, i3, a3, o3, s3, l3, `${u3}/else`, d3);
      t4.valid || Q3.push({ instanceLocation: l3, keyword: `if`, keywordLocation: e9, error: `Instance does not match "else" schema.` }, ...t4.errors);
    }
  }
  if (p3 === `object`) {
    if (ee3 !== void 0) for (let e10 of ee3) e10 in n3 || Q3.push({ instanceLocation: l3, keyword: `required`, keywordLocation: `${u3}/required`, error: `Instance does not have required property "${e10}".` });
    let e9 = Object.keys(n3);
    if (M4 !== void 0 && e9.length < M4 && Q3.push({ instanceLocation: l3, keyword: `minProperties`, keywordLocation: `${u3}/minProperties`, error: `Instance does not have at least ${M4} properties.` }), N4 !== void 0 && e9.length > N4 && Q3.push({ instanceLocation: l3, keyword: `maxProperties`, keywordLocation: `${u3}/maxProperties`, error: `Instance does not have at least ${N4} properties.` }), P4 !== void 0) {
      let e10 = `${u3}/propertyNames`;
      for (let r4 in n3) {
        let n4 = `${l3}/${t3(r4)}`, c4 = F3(r4, P4, i3, a3, o3, s3, n4, e10);
        c4.valid || Q3.push({ instanceLocation: l3, keyword: `propertyNames`, keywordLocation: e10, error: `Property name "${r4}" does not match schema.` }, ...c4.errors);
      }
    }
    if (I4 !== void 0) {
      let e10 = `${u3}/dependantRequired`;
      for (let t4 in I4) if (t4 in n3) {
        let r4 = I4[t4];
        for (let i4 of r4) i4 in n3 || Q3.push({ instanceLocation: l3, keyword: `dependentRequired`, keywordLocation: e10, error: `Instance has "${t4}" but does not have "${i4}".` });
      }
    }
    if (L3 !== void 0) for (let e10 in L3) {
      let r4 = `${u3}/dependentSchemas`;
      if (e10 in n3) {
        let c4 = F3(n3, L3[e10], i3, a3, o3, s3, l3, `${r4}/${t3(e10)}`, d3);
        c4.valid || Q3.push({ instanceLocation: l3, keyword: `dependentSchemas`, keywordLocation: r4, error: `Instance has "${e10}" but does not match dependant schema.` }, ...c4.errors);
      }
    }
    if (R3 !== void 0) {
      let e10 = `${u3}/dependencies`;
      for (let r4 in R3) if (r4 in n3) {
        let c4 = R3[r4];
        if (Array.isArray(c4)) for (let t4 of c4) t4 in n3 || Q3.push({ instanceLocation: l3, keyword: `dependencies`, keywordLocation: e10, error: `Instance has "${r4}" but does not have "${t4}".` });
        else {
          let u4 = F3(n3, c4, i3, a3, o3, s3, l3, `${e10}/${t3(r4)}`);
          u4.valid || Q3.push({ instanceLocation: l3, keyword: `dependencies`, keywordLocation: e10, error: `Instance has "${r4}" but does not match dependant schema.` }, ...u4.errors);
        }
      }
    }
    let r3 = /* @__PURE__ */ Object.create(null), c3 = false;
    if (k4 !== void 0) {
      let e10 = `${u3}/properties`;
      for (let u4 in k4) {
        if (!(u4 in n3)) continue;
        let f4 = `${l3}/${t3(u4)}`, p4 = F3(n3[u4], k4[u4], i3, a3, o3, s3, f4, `${e10}/${t3(u4)}`);
        if (p4.valid) d3[u4] = r3[u4] = true;
        else if (c3 = o3, Q3.push({ instanceLocation: l3, keyword: `properties`, keywordLocation: e10, error: `Property "${u4}" does not match schema.` }, ...p4.errors), c3) break;
      }
    }
    if (!c3 && A4 !== void 0) {
      let e10 = `${u3}/patternProperties`;
      for (let u4 in A4) {
        let f4 = new RegExp(u4, `u`), p4 = A4[u4];
        for (let m4 in n3) {
          if (!f4.test(m4)) continue;
          let h4 = `${l3}/${t3(m4)}`, g4 = F3(n3[m4], p4, i3, a3, o3, s3, h4, `${e10}/${t3(u4)}`);
          g4.valid ? d3[m4] = r3[m4] = true : (c3 = o3, Q3.push({ instanceLocation: l3, keyword: `patternProperties`, keywordLocation: e10, error: `Property "${m4}" matches pattern "${u4}" but does not match associated schema.` }, ...g4.errors));
        }
      }
    }
    if (!c3 && te3 !== void 0) {
      let e10 = `${u3}/additionalProperties`;
      for (let u4 in n3) {
        if (r3[u4]) continue;
        let f4 = `${l3}/${t3(u4)}`, p4 = F3(n3[u4], te3, i3, a3, o3, s3, f4, e10);
        p4.valid ? d3[u4] = true : (c3 = o3, Q3.push({ instanceLocation: l3, keyword: `additionalProperties`, keywordLocation: e10, error: `Property "${u4}" does not match additional properties schema.` }, ...p4.errors));
      }
    } else if (!c3 && j4 !== void 0) {
      let e10 = `${u3}/unevaluatedProperties`;
      for (let r4 in n3) if (!d3[r4]) {
        let c4 = `${l3}/${t3(r4)}`, u4 = F3(n3[r4], j4, i3, a3, o3, s3, c4, e10);
        u4.valid ? d3[r4] = true : Q3.push({ instanceLocation: l3, keyword: `unevaluatedProperties`, keywordLocation: e10, error: `Property "${r4}" does not match unevaluated properties schema.` }, ...u4.errors);
      }
    }
  } else if (p3 === `array`) {
    U3 !== void 0 && n3.length > U3 && Q3.push({ instanceLocation: l3, keyword: `maxItems`, keywordLocation: `${u3}/maxItems`, error: `Array has too many items (${n3.length} > ${U3}).` }), H3 !== void 0 && n3.length < H3 && Q3.push({ instanceLocation: l3, keyword: `minItems`, keywordLocation: `${u3}/minItems`, error: `Array has too few items (${n3.length} < ${H3}).` });
    let t4 = n3.length, r3 = 0, c3 = false;
    if (re2 !== void 0) {
      let e9 = `${u3}/prefixItems`, f4 = Math.min(re2.length, t4);
      for (; r3 < f4; r3++) {
        let t5 = F3(n3[r3], re2[r3], i3, a3, o3, s3, `${l3}/${r3}`, `${e9}/${r3}`);
        if (d3[r3] = true, !t5.valid && (c3 = o3, Q3.push({ instanceLocation: l3, keyword: `prefixItems`, keywordLocation: e9, error: `Items did not match schema.` }, ...t5.errors), c3)) break;
      }
    }
    if (z3 !== void 0) {
      let e9 = `${u3}/items`;
      if (Array.isArray(z3)) {
        let u4 = Math.min(z3.length, t4);
        for (; r3 < u4; r3++) {
          let t5 = F3(n3[r3], z3[r3], i3, a3, o3, s3, `${l3}/${r3}`, `${e9}/${r3}`);
          if (d3[r3] = true, !t5.valid && (c3 = o3, Q3.push({ instanceLocation: l3, keyword: `items`, keywordLocation: e9, error: `Items did not match schema.` }, ...t5.errors), c3)) break;
        }
      } else for (; r3 < t4; r3++) {
        let t5 = F3(n3[r3], z3, i3, a3, o3, s3, `${l3}/${r3}`, e9);
        if (d3[r3] = true, !t5.valid && (c3 = o3, Q3.push({ instanceLocation: l3, keyword: `items`, keywordLocation: e9, error: `Items did not match schema.` }, ...t5.errors), c3)) break;
      }
      if (!c3 && ie2 !== void 0) {
        let e10 = `${u3}/additionalItems`;
        for (; r3 < t4; r3++) {
          let t5 = F3(n3[r3], ie2, i3, a3, o3, s3, `${l3}/${r3}`, e10);
          d3[r3] = true, t5.valid || (c3 = o3, Q3.push({ instanceLocation: l3, keyword: `additionalItems`, keywordLocation: e10, error: `Items did not match additional items schema.` }, ...t5.errors));
        }
      }
    }
    if (oe2 !== void 0) {
      if (t4 === 0 && B3 === void 0) Q3.push({ instanceLocation: l3, keyword: `contains`, keywordLocation: `${u3}/contains`, error: `Array is empty. It must contain at least one item matching the schema.` });
      else if (B3 !== void 0 && t4 < B3) Q3.push({ instanceLocation: l3, keyword: `minContains`, keywordLocation: `${u3}/minContains`, error: `Array has less items (${t4}) than minContains (${B3}).` });
      else {
        let e9 = `${u3}/contains`, r4 = Q3.length, c4 = 0;
        for (let r5 = 0; r5 < t4; r5++) {
          let t5 = F3(n3[r5], oe2, i3, a3, o3, s3, `${l3}/${r5}`, e9);
          t5.valid ? (d3[r5] = true, c4++) : Q3.push(...t5.errors);
        }
        c4 >= (B3 || 0) && (Q3.length = r4), B3 === void 0 && V3 === void 0 && c4 === 0 ? Q3.splice(r4, 0, { instanceLocation: l3, keyword: `contains`, keywordLocation: e9, error: `Array does not contain item matching schema.` }) : B3 !== void 0 && c4 < B3 ? Q3.push({ instanceLocation: l3, keyword: `minContains`, keywordLocation: `${u3}/minContains`, error: `Array must contain at least ${B3} items matching schema. Only ${c4} items were found.` }) : V3 !== void 0 && c4 > V3 && Q3.push({ instanceLocation: l3, keyword: `maxContains`, keywordLocation: `${u3}/maxContains`, error: `Array may contain at most ${V3} items matching schema. ${c4} items were found.` });
      }
    }
    if (!c3 && ae2 !== void 0) {
      let e9 = `${u3}/unevaluatedItems`;
      for (; r3 < t4; r3++) {
        if (d3[r3]) continue;
        let t5 = F3(n3[r3], ae2, i3, a3, o3, s3, `${l3}/${r3}`, e9);
        d3[r3] = true, t5.valid || Q3.push({ instanceLocation: l3, keyword: `unevaluatedItems`, keywordLocation: e9, error: `Items did not match unevaluated items schema.` }, ...t5.errors);
      }
    }
    if (se2) for (let r4 = 0; r4 < t4; r4++) {
      let i4 = n3[r4], a4 = typeof i4 == `object` && !!i4;
      for (let o4 = 0; o4 < t4; o4++) {
        if (r4 === o4) continue;
        let t5 = n3[o4];
        (i4 === t5 || a4 && typeof t5 == `object` && t5 && e8(i4, t5)) && (Q3.push({ instanceLocation: l3, keyword: `uniqueItems`, keywordLocation: `${u3}/uniqueItems`, error: `Duplicate items at indexes ${r4} and ${o4}.` }), r4 = 2 ** 53 - 1, o4 = 2 ** 53 - 1);
      }
    }
  } else if (p3 === `number`) {
    if (i3 === `4` ? (W3 !== void 0 && (K3 === true && n3 <= W3 || n3 < W3) && Q3.push({ instanceLocation: l3, keyword: `minimum`, keywordLocation: `${u3}/minimum`, error: `${n3} is less than ${K3 ? `or equal to ` : ``} ${W3}.` }), G3 !== void 0 && (q3 === true && n3 >= G3 || n3 > G3) && Q3.push({ instanceLocation: l3, keyword: `maximum`, keywordLocation: `${u3}/maximum`, error: `${n3} is greater than ${q3 ? `or equal to ` : ``} ${G3}.` })) : (W3 !== void 0 && n3 < W3 && Q3.push({ instanceLocation: l3, keyword: `minimum`, keywordLocation: `${u3}/minimum`, error: `${n3} is less than ${W3}.` }), G3 !== void 0 && n3 > G3 && Q3.push({ instanceLocation: l3, keyword: `maximum`, keywordLocation: `${u3}/maximum`, error: `${n3} is greater than ${G3}.` }), K3 !== void 0 && n3 <= K3 && Q3.push({ instanceLocation: l3, keyword: `exclusiveMinimum`, keywordLocation: `${u3}/exclusiveMinimum`, error: `${n3} is less than ${K3}.` }), q3 !== void 0 && n3 >= q3 && Q3.push({ instanceLocation: l3, keyword: `exclusiveMaximum`, keywordLocation: `${u3}/exclusiveMaximum`, error: `${n3} is greater than or equal to ${q3}.` })), J3 !== void 0) {
      let e9 = n3 % J3;
      Math.abs(0 - e9) >= 11920929e-14 && Math.abs(J3 - e9) >= 11920929e-14 && Q3.push({ instanceLocation: l3, keyword: `multipleOf`, keywordLocation: `${u3}/multipleOf`, error: `${n3} is not a multiple of ${J3}.` });
    }
  } else if (p3 === `string`) {
    let e9 = Y3 === void 0 && X3 === void 0 ? 0 : ne2(n3);
    Y3 !== void 0 && e9 < Y3 && Q3.push({ instanceLocation: l3, keyword: `minLength`, keywordLocation: `${u3}/minLength`, error: `String is too short (${e9} < ${Y3}).` }), X3 !== void 0 && e9 > X3 && Q3.push({ instanceLocation: l3, keyword: `maxLength`, keywordLocation: `${u3}/maxLength`, error: `String is too long (${e9} > ${X3}).` }), ce2 !== void 0 && !new RegExp(ce2, `u`).test(n3) && Q3.push({ instanceLocation: l3, keyword: `pattern`, keywordLocation: `${u3}/pattern`, error: `String does not match pattern.` }), O4 !== void 0 && w3[O4] && !w3[O4](n3) && Q3.push({ instanceLocation: l3, keyword: `format`, keywordLocation: `${u3}/format`, error: `String does not match format "${O4}".` });
  }
  return { valid: Q3.length === 0, errors: Q3 };
}
var I3 = class {
  schema;
  draft;
  shortCircuit;
  lookup;
  constructor(e9, t4 = `2019-09`, n3 = true) {
    this.schema = e9, this.draft = t4, this.shortCircuit = n3, this.lookup = c2(e9);
  }
  validate(e9) {
    return F3(e9, this.schema, this.draft, this.lookup, this.shortCircuit);
  }
  addSchema(e9, t4) {
    t4 && (e9 = { ...e9, $id: t4 }), c2(e9, this.lookup);
  }
};

// node_modules/eve/dist/src/tools/schema.js
function defineJsonSchema(e9, t4) {
  let emit = () => structuredClone(e9), n3 = { "~standard": { version: 1, vendor: `eve`, validate: createJsonSchemaValidator(e9, t4), jsonSchema: { input: emit, output: emit } } };
  return plainJsonSchemas.add(n3), n3;
}
var plainJsonSchemas = /* @__PURE__ */ new WeakSet();
var UNSPECIFIED_INPUT_SCHEMA = defineJsonSchema({});
function createJsonSchemaValidator(e9, t4) {
  let n3, r2 = false, passThrough = (e10, t5) => (r2 || (r2 = true, console.warn(`[eve] Tool schema cannot validate values locally; passing them through unvalidated: ${t5}`)), { value: e10 });
  return (r3) => {
    if (n3 === void 0) {
      let t5 = buildValidator(e9);
      if (typeof t5 == `string`) return n3 = null, passThrough(r3, t5);
      n3 = t5;
    }
    if (n3 === null) return { value: r3 };
    let i3;
    try {
      i3 = n3.validate(r3);
    } catch (e10) {
      return r3 === void 0 ? { issues: [{ message: `Expected a JSON value.` }] } : passThrough(r3, toErrorMessage(e10));
    }
    if (!i3.valid) return { issues: toIssues(i3.errors) };
    let a3 = applyDefaults(e9, e9, r3), o3 = t4?.(a3);
    return o3 === void 0 ? { value: a3 } : { issues: [{ message: o3 }] };
  };
}
function applyDefaults(e9, t4, n3) {
  let r2 = n3;
  for (let n4 of followRefs(e9, t4)) {
    let { items: t5, properties: i3 } = n4;
    if (isObject(r2) && isObject(i3)) r2 = fillProperties(e9, i3, r2);
    else if (Array.isArray(r2) && isObject(t5)) {
      let n5 = r2, i4 = n5.map((n6) => applyDefaults(e9, t5, n6));
      i4.some((e10, t6) => e10 !== n5[t6]) && (r2 = i4);
    }
  }
  return r2;
}
function fillProperties(e9, t4, n3) {
  let r2 = n3;
  for (let [i3, a3] of Object.entries(t4)) {
    let t5 = Object.hasOwn(n3, i3) ? n3[i3] : void 0, o3 = t5 === void 0 ? findDefault(e9, a3) : applyDefaults(e9, a3, t5);
    o3 !== t5 && (r2 === n3 && (r2 = { ...n3 }), r2[i3] = o3);
  }
  return r2;
}
function findDefault(e9, t4) {
  for (let n3 of followRefs(e9, t4)) if (`default` in n3) return structuredClone(n3.default);
}
function* followRefs(e9, t4) {
  let n3 = /* @__PURE__ */ new Set(), r2 = t4;
  for (; isObject(r2) && !n3.has(r2); ) n3.add(r2), yield r2, r2 = resolveLocalRef(e9, r2.$ref);
}
function resolveLocalRef(e9, t4) {
  if (typeof t4 != `string` || t4 !== `#` && !t4.startsWith(`#/`)) return;
  let n3 = e9;
  for (let e10 of decodePointer(t4)) {
    if (typeof n3 != `object` || !n3 || !Object.hasOwn(n3, e10)) return;
    n3 = n3[e10];
  }
  return n3;
}
function buildValidator(e9) {
  try {
    let t4 = structuredClone(e9);
    return prepareForValidation(t4) ?? new I3(t4, `2020-12`, false);
  } catch (e10) {
    return toErrorMessage(e10);
  }
}
var JSON_TYPES = /* @__PURE__ */ new Set([`array`, `boolean`, `integer`, `null`, `number`, `object`, `string`]);
var EXCLUSIVE_BOUNDS = [[`exclusiveMinimum`, `minimum`], [`exclusiveMaximum`, `maximum`]];
var SUBSCHEMA_KEYWORDS = [`additionalItems`, `additionalProperties`, `contains`, `else`, `if`, `not`, `propertyNames`, `then`, `unevaluatedItems`, `unevaluatedProperties`];
var SUBSCHEMA_LIST_KEYWORDS = [`allOf`, `anyOf`, `oneOf`, `prefixItems`];
var SUBSCHEMA_MAP_KEYWORDS = [`$defs`, `definitions`, `dependencies`, `dependentSchemas`, `patternProperties`, `properties`];
function prepareForValidation(e9) {
  if (typeof e9 == `boolean`) return;
  if (typeof e9 != `object` || !e9 || Array.isArray(e9)) return `a subschema is neither an object nor a boolean`;
  let t4 = e9;
  delete t4.format;
  for (let [e10, n4] of EXCLUSIVE_BOUNDS) typeof t4[e10] == `boolean` && (t4[e10] && typeof t4[n4] == `number` ? (t4[e10] = t4[n4], delete t4[n4]) : delete t4[e10]);
  let { enum: n3, pattern: r2, required: i3, type: a3 } = t4;
  if (a3 !== void 0 && !(Array.isArray(a3) ? a3.every(isJsonType) : isJsonType(a3))) return `unsupported type ${JSON.stringify(a3)}`;
  if (n3 !== void 0 && !Array.isArray(n3)) return "`enum` is not an array";
  if (i3 !== void 0 && !(Array.isArray(i3) && i3.every((e10) => typeof e10 == `string`))) return "`required` is not an array of strings";
  if (r2 !== void 0 && !isRegExpSource(r2)) return `invalid pattern ${JSON.stringify(r2)}`;
  for (let e10 of SUBSCHEMA_KEYWORDS) if (e10 in t4) {
    let n4 = prepareForValidation(t4[e10]);
    if (n4 !== void 0) return n4;
  }
  let o3 = t4.items;
  for (let e10 of Array.isArray(o3) ? o3 : o3 === void 0 ? [] : [o3]) {
    let t5 = prepareForValidation(e10);
    if (t5 !== void 0) return t5;
  }
  for (let e10 of SUBSCHEMA_LIST_KEYWORDS) {
    let n4 = t4[e10];
    if (n4 !== void 0) {
      if (!Array.isArray(n4)) return `\`${e10}\` is not an array`;
      for (let e11 of n4) {
        let t5 = prepareForValidation(e11);
        if (t5 !== void 0) return t5;
      }
    }
  }
  for (let e10 of SUBSCHEMA_MAP_KEYWORDS) {
    let n4 = t4[e10];
    if (n4 !== void 0) {
      if (typeof n4 != `object` || !n4 || Array.isArray(n4)) return `\`${e10}\` is not an object`;
      for (let [t5, r3] of Object.entries(n4)) {
        if (e10 === `patternProperties` && !isRegExpSource(t5)) return `invalid pattern ${JSON.stringify(t5)}`;
        if (e10 === `dependencies` && Array.isArray(r3)) continue;
        let n5 = prepareForValidation(r3);
        if (n5 !== void 0) return n5;
      }
    }
  }
}
function isJsonType(e9) {
  return typeof e9 == `string` && JSON_TYPES.has(e9);
}
function isRegExpSource(e9) {
  if (typeof e9 != `string`) return false;
  try {
    return new RegExp(e9, `u`), true;
  } catch {
    return false;
  }
}
var CLOSED_OBJECT_KEYWORD = /\/(?:additional|unevaluated)Properties$/;
function toIssues(e9) {
  let t4 = [];
  for (let n4 = 0; n4 < e9.length; n4++) {
    let r2 = e9[n4], i3 = e9[n4 + 1];
    if (CLOSED_OBJECT_KEYWORD.test(r2.keywordLocation) && i3?.keyword === `false`) {
      let e10 = decodePointer(i3.instanceLocation).at(-1);
      t4.push({ keyword: `false`, location: i3.instanceLocation, message: `Unrecognized key: ${JSON.stringify(e10)}`, object: r2.instanceLocation }), n4++;
    } else t4.push({ keyword: r2.keyword, location: r2.instanceLocation, message: r2.error });
  }
  let n3 = t4.filter((e10) => e10.object === void 0 || !t4.some((t5) => t5.object === void 0 && (t5.location === e10.location || t5.location.startsWith(`${e10.location}/`))));
  return n3.filter((e10, t5) => {
    let r2 = n3[t5 + 1];
    return r2 === void 0 ? true : r2.location.startsWith(`${e10.location}/`) ? false : e10.keyword !== `$ref` || r2.location !== e10.location;
  }).map(({ location: e10, message: t5, object: n4 }) => {
    let r2 = decodePointer(n4 ?? e10);
    return r2.length === 0 ? { message: t5 } : { message: t5, path: r2 };
  });
}
function decodePointer(e9) {
  return e9.split(`/`).slice(1).map((e10) => {
    let t4 = e10;
    try {
      t4 = decodeURIComponent(e10);
    } catch {
    }
    return t4.replaceAll(`~1`, `/`).replaceAll(`~0`, `~`);
  });
}

// node_modules/eve/dist/src/client/session.js
var followSession = /* @__PURE__ */ Symbol(`followClientSession`);
var ClientSession = class ClientSession2 {
  #e;
  #t;
  constructor(e9, t4) {
    this.#e = e9, this.#t = t4;
  }
  static async create(e9, t4) {
    let n3 = await postTurn(e9, EVE_SESSION_ROUTE_PATH, t4, true, t4.stubs), { sessionId: r2 } = await readAcceptedMessage(n3), i3 = new ClientSession2(e9, { sessionId: r2, streamIndex: 0 });
    return { response: i3.#r(n3, t4, 0), session: i3 };
  }
  static async prewarm(e9, t4 = {}) {
    let { sessionId: n3 } = await readAcceptedMessage(await postCreateSession(e9, t4));
    return new ClientSession2(e9, { sessionId: n3, streamIndex: 0 });
  }
  get state() {
    return this.#t;
  }
  async snapshot(e9) {
    throwIfAborted(e9?.signal);
    let t4 = [];
    for await (let n3 of this.#s({ follow: false, signal: e9?.signal, startIndex: 0 })) t4.push(n3);
    return throwIfAborted(e9?.signal), { events: t4, session: { sessionId: this.#t.sessionId, streamIndex: t4.length } };
  }
  async send(e9, t4 = {}) {
    return await this.#n({ ...t4, message: e9 }, true);
  }
  async respond(e9, t4 = {}) {
    if (e9.length === 0) throw Error(`ClientSession.respond() requires at least one input response.`);
    return await this.#n({ ...t4, inputResponses: e9 }, false);
  }
  async #n(e9, t4) {
    let n3 = this.#t.streamIndex, r2 = createEveSessionRoutePath(this.#t.sessionId), i3 = t4 ? await postSessionSend(this.#e, r2, e9) : await postTurn(this.#e, r2, e9, false), { sessionId: a3, deliveryId: o3 } = await readAcceptedMessage(i3, this.#t.sessionId);
    if (a3 !== this.#t.sessionId) throw Error(`Message route returned a different session id.`);
    if (e9.message !== void 0 && o3 === void 0) throw Error(`Message route did not return a delivery id. Update the server before sending with this client.`);
    return this.#r(i3, e9, n3, e9.message === void 0 ? void 0 : o3);
  }
  async cancel(e9) {
    return await cancelClientSession({ context: this.#e, options: e9, sessionId: this.#t.sessionId });
  }
  async clear() {
    return await clearClientSession({ context: this.#e, sessionId: this.#t.sessionId });
  }
  async compact() {
    return await compactClientSession({ context: this.#e, sessionId: this.#t.sessionId });
  }
  async reset(e9) {
    return await resetClientSession({ context: this.#e, options: e9, sessionId: this.#t.sessionId });
  }
  stream(e9) {
    if (e9?.follow === false && (e9.startIndex ?? this.#t.streamIndex) < 0) throw Error(`stream({ follow: false }) requires a nonnegative startIndex; a tail-relative cursor cannot be bounded.`);
    return this.#a(e9);
  }
  agent(e9) {
    return new ClientAgentSession(this.#e, e9);
  }
  [followSession](e9) {
    return this.#a({ ...e9, keepAlive: true });
  }
  #r(e9, t4, n3, r2) {
    return e9.body?.cancel().catch(() => {
    }), new MessageResponse({ cancelTurn: async (e10) => await this.cancel({ turnId: e10 }), createStream: (e10) => this.#i(n3, t4, r2, e10), deliveryId: r2, resumesTurn: t4.inputResponses !== void 0, sessionId: this.#t.sessionId });
  }
  async *#i(e9, t4, n3, r2) {
    let i3 = 0, a3 = n3 === void 0, o3 = false, s3 = new TurnSegment({ followCallbacks: true });
    try {
      for await (let c3 of r2 ?? this.#s({ headers: t4.headers, keepAlive: true, signal: t4.signal, startIndex: e9, streamReconnectPolicy: t4.streamReconnectPolicy })) {
        if (i3 += 1, n3 !== void 0) {
          let e10 = c3.meta?.deliveryIds?.includes(n3) === true, t5 = c3.type === `session.failed` || c3.type === `session.completed`;
          if (!e10 && t5 && (!a3 || c3.type === `session.completed`)) throw Error(`The session ended before the accepted message reached its turn boundary.`);
          if (!a3 && !e10) continue;
          let r3 = c3.meta?.deliveryIds !== void 0;
          if (!t5 && r3 && !e10) continue;
          a3 = true;
        }
        if (o3 = s3.observe(c3), yield c3, o3) break;
      }
      if (n3 !== void 0 && !o3 && !t4.signal?.aborted) throw Error(`The response stream ended before the accepted message reached its turn boundary.`);
    } finally {
      this.#o(e9 + i3);
    }
  }
  async *#a(e9) {
    let t4 = e9?.startIndex ?? this.#t.streamIndex, n3 = 0;
    for await (let r2 of this.#s({ follow: e9?.follow, headers: e9?.headers, keepAlive: e9?.keepAlive, onCaughtUp: e9?.onCaughtUp, resolveHeaders: e9?.resolveHeaders, resolveReconnectPolicy: e9?.resolveReconnectPolicy, signal: e9?.signal, startIndex: t4, streamReconnectPolicy: e9?.streamReconnectPolicy })) n3 += 1, t4 >= 0 && this.#o(t4 + n3), yield r2;
  }
  #o(e9) {
    this.#t = { sessionId: this.#t.sessionId, streamIndex: Math.max(this.#t.streamIndex, e9) };
  }
  #s(e9) {
    return followStreamIterable({ onCaughtUp: e9.onCaughtUp, follow: e9.follow, host: this.#e.host, keepAlive: e9.keepAlive, resolveHeaders: () => this.#e.resolveHeaders(e9.resolveHeaders?.() ?? e9.headers), path: createEveSessionStreamRoutePath(this.#t.sessionId), redirect: this.#e.redirect, signal: e9.signal, startIndex: e9.startIndex, streamReconnectPolicy: e9.streamReconnectPolicy, resolveReconnectPolicy: e9.resolveReconnectPolicy });
  }
};
function followClientSession(e9, t4) {
  return e9[followSession](t4);
}
async function postSessionSend(e9, t4, n3) {
  let r2 = Date.now() + 2e4, i3 = 250;
  for (; ; ) {
    try {
      return await postTurn(e9, t4, n3, false);
    } catch (e10) {
      if (!isSessionNotReady(e10)) throw e10;
      let t5 = r2 - Date.now();
      if (t5 <= 0) throw e10;
      await sleep(Math.min(i3, t5), n3.signal);
    }
    throwIfAborted(n3.signal), i3 = Math.min(i3 * 2, 2e3);
  }
}
async function postCreateSession(e9, t4) {
  let n3 = await e9.resolveHeaders(t4.headers), r2 = t4.stubs === void 0 ? void 0 : JSON.stringify({ stubs: t4.stubs });
  r2 !== void 0 && n3.set(`content-type`, `application/json`);
  let i3 = await fetch(createClientUrl(e9.host, EVE_SESSION_ROUTE_PATH), { body: r2, headers: n3, method: `POST`, redirect: e9.redirect, signal: t4.signal ?? null });
  if (!i3.ok) {
    let e10 = await i3.text();
    throw new ClientError(i3.status, e10, i3.headers);
  }
  return i3;
}
function isSessionNotReady(e9) {
  return e9 instanceof ClientError && e9.status === 409 && e9.code === `session_not_ready`;
}
async function postTurn(e9, t4, n3, r2, i3) {
  let a3 = createMessageBody(n3, r2);
  if (a3 === null) throw Error(r2 ? `Creating a session requires a non-empty message.` : `A session turn requires a non-empty message or inputResponses.`);
  i3 !== void 0 && (a3.stubs = i3);
  let o3 = await e9.resolveHeaders(n3.headers);
  o3.set(`content-type`, `application/json`);
  let s3 = await fetch(createClientUrl(e9.host, t4), { body: JSON.stringify(a3), headers: o3, method: `POST`, redirect: e9.redirect, signal: n3.signal ?? null });
  if (!s3.ok) {
    let e10 = await s3.text();
    throw createClientError(s3.status, e10, s3.headers);
  }
  return s3;
}
async function readAcceptedMessage(e9, t4) {
  let n3 = await e9.json(), r2 = (typeof n3.sessionId == `string` ? n3.sessionId : void 0) ?? e9.headers.get(EVE_SESSION_ID_HEADER)?.trim() ?? t4;
  if (!r2) throw Error(`Message route did not return a session id.`);
  return { sessionId: r2, deliveryId: typeof n3.deliveryId == `string` && n3.deliveryId.length > 0 ? n3.deliveryId : void 0 };
}
function createMessageBody(e9, t4) {
  let n3 = {};
  e9.message !== void 0 && (n3.message = e9.message), e9.inputResponses !== void 0 && e9.inputResponses.length > 0 && (n3.inputResponses = e9.inputResponses), !t4 && e9.message !== void 0 && e9.turnPolicy !== void 0 && (n3.turnPolicy = e9.turnPolicy), e9.clientContext !== void 0 && (n3.clientContext = e9.clientContext);
  let r2 = serializeOutputSchema(e9.outputSchema);
  return r2 !== void 0 && (n3.outputSchema = r2), t4 && n3.message === void 0 || n3.message === void 0 && n3.inputResponses === void 0 ? null : n3;
}

// node_modules/eve/dist/src/client/sessions.js
var ClientSessions = class {
  #e;
  constructor(e9) {
    this.#e = e9;
  }
  async create(e9 = {}) {
    return `message` in e9 ? await ClientSession.create(this.#e, e9) : { session: await ClientSession.prewarm(this.#e, e9) };
  }
  attach(e9, t4) {
    if (e9.length === 0) throw Error(`sessionId must be a non-empty string.`);
    return new ClientSession(this.#e, { sessionId: e9, streamIndex: t4?.streamIndex ?? 0 });
  }
};

// node_modules/eve/dist/src/client/types.js
var VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER = `x-vercel-trusted-oidc-idp-token`;

// node_modules/eve/dist/src/client/client.js
var Client = class {
  #e;
  #t;
  #n;
  #r;
  sessions;
  constructor(e9) {
    this.#n = e9.host, this.#e = e9.auth, this.#t = e9.headers, this.#r = e9.redirect, this.sessions = new ClientSessions({ host: this.#n, redirect: this.#r, resolveHeaders: (e10) => this.#i(e10) });
  }
  async health() {
    let e9 = createClientUrl(this.#n, EVE_HEALTH_ROUTE_PATH), t4 = await this.#i(), n3 = await fetch(e9, withRedirectPolicy2({ headers: t4 }, this.#r));
    if (!n3.ok) {
      let e10 = await n3.text();
      throw new ClientError(n3.status, e10, n3.headers);
    }
    let r2;
    try {
      r2 = await n3.json();
    } catch {
      throw new HealthResponseError();
    }
    let i3 = HealthResultSchema.safeParse(r2);
    if (!i3.success) throw new HealthResponseError(i3.error.issues.slice(0, 5).map((e10) => {
      let t5 = e10.path.join(`.`);
      return t5.length === 0 ? e10.message : `${t5}: ${e10.message}`;
    }));
    return i3.data;
  }
  async info(e9 = {}) {
    let t4 = await this.fetch(EVE_INFO_ROUTE_PATH, e9);
    if (!t4.ok) {
      let e10 = await t4.text();
      throw new ClientError(t4.status, e10, t4.headers);
    }
    let n3;
    try {
      n3 = await t4.json();
    } catch {
      throw new AgentInfoResponseError();
    }
    let r2 = AgentInfoResultSchema.safeParse(n3);
    if (!r2.success) throw new AgentInfoResponseError(r2.error.issues.slice(0, 5).map((e10) => {
      let t5 = e10.path.join(`.`);
      return t5.length === 0 ? e10.message : `${t5}: ${e10.message}`;
    }));
    return r2.data;
  }
  async fetch(e9, t4 = {}) {
    let n3 = createClientUrl(this.#n, e9), r2 = await this.#i(headersInitToRecord(t4.headers));
    return await fetch(n3, withRedirectPolicy2({ ...t4, headers: r2 }, this.#r));
  }
  async #i(e9) {
    let t4 = new Headers(), [n3, r2] = await Promise.all([resolveHeadersValue(this.#t), this.#a()]);
    for (let [e10, r3] of Object.entries(n3)) t4.set(e10, r3);
    for (let [e10, n4] of Object.entries(r2)) t4.set(e10, n4);
    if (e9) for (let [n4, r3] of Object.entries(e9)) t4.set(n4, r3);
    return t4;
  }
  async #a() {
    let e9 = this.#e;
    if (!e9) return {};
    if (`vercelOidc` in e9) {
      let t4 = (await resolveTokenValue(e9.vercelOidc.token)).trim();
      return t4.length === 0 ? {} : { authorization: `Bearer ${t4}`, [VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER]: t4 };
    }
    if (`bearer` in e9) {
      let t4 = (await resolveTokenValue(e9.bearer)).trim();
      return t4.length === 0 ? {} : { authorization: `Bearer ${t4}` };
    }
    if (`basic` in e9) {
      let t4 = await resolveTokenValue(e9.basic.password);
      return { authorization: `Basic ${encodeBasicCredentials(e9.basic.username, t4)}` };
    }
    return {};
  }
};
async function resolveTokenValue(e9) {
  return typeof e9 == `function` ? e9() : e9;
}
async function resolveHeadersValue(e9) {
  return e9 === void 0 ? {} : typeof e9 == `function` ? await e9() : e9;
}
function headersInitToRecord(e9) {
  return e9 === void 0 ? {} : Object.fromEntries(new Headers(e9).entries());
}
function withRedirectPolicy2(e9, t4) {
  return t4 === void 0 ? e9 : { ...e9, redirect: t4 };
}

// node_modules/eve/dist/src/client/optimistic-message-submissions.js
var OptimisticMessageSubmissions = class {
  #e;
  #t;
  #n = [];
  constructor(e9, t4) {
    this.#t = e9, this.#e = t4;
  }
  reset() {
    this.#n = [];
  }
  submit(e9, t4, n3) {
    if (e9.message === void 0) return;
    let r2 = { createdAt: Date.now(), eventStartIndex: t4, id: createSubmissionId(), message: summarizeUserContent(e9.message), turnId: n3, requiresDeliveryId: true };
    if (this.#n = [...this.#n, r2], this.#e) for (let e10 of this.#t) e10.append({ data: { createdAt: r2.createdAt, message: r2.message, submissionId: r2.id, turnId: n3 }, type: `client.message.submitted` });
    return r2.id;
  }
  resubmit(e9, t4) {
    let n3 = this.#n.find((t5) => t5.id === e9), r2 = t4.message === void 0 ? void 0 : summarizeUserContent(t4.message);
    return n3?.message === r2 ? e9 : (n3 !== void 0 && this.#a([n3.id]), this.submit(t4, n3?.eventStartIndex ?? 0, n3?.turnId));
  }
  apply(e9) {
    if (e9.type !== `message.received`) {
      for (let t5 of this.#t) t5.append(e9);
      return;
    }
    let t4 = this.#r(e9);
    if (t4.length === 0) {
      for (let t5 of this.#t) t5.append(e9);
      return;
    }
    return this.#i(t4, e9, false);
  }
  correlate(e9, t4, n3) {
    if (e9 === void 0) return;
    this.#n = this.#n.map((n4) => n4.id === e9 ? { ...n4, deliveryId: t4, requiresDeliveryId: t4 !== void 0 } : n4);
    let r2 = this.#n.find((t5) => t5.id === e9);
    if (r2 !== void 0) for (let t5 of n3.slice(r2.eventStartIndex)) {
      if (t5.type !== `message.received`) continue;
      let n4 = this.#r(t5);
      if (n4.some((t6) => t6.id === e9)) return this.#i(n4, t5, true);
    }
  }
  fail(e9, t4) {
    let n3 = t4 === void 0 ? this.#n[0] : this.#n.find((e10) => e10.id === t4);
    if (n3 !== void 0) {
      this.#n = this.#n.filter((e10) => e10.id !== n3.id);
      for (let t5 of this.#t) t5.replace((e10) => e10.type === `client.message.submitted` && e10.data.submissionId === n3.id, { data: { createdAt: n3.createdAt, error: { message: e9.message }, message: n3.message, submissionId: n3.id, turnId: n3.turnId }, type: `client.message.failed` });
    }
  }
  failAll(e9) {
    for (let t4 of this.#n) this.fail(e9, t4.id);
  }
  #r(e9) {
    return this.#n.filter((t4) => t4.deliveryId === void 0 ? !t4.requiresDeliveryId : e9.meta.deliveryIds?.includes(t4.deliveryId) === true);
  }
  #i(e9, t4, n3) {
    let r2 = e9.map((e10) => e10.id);
    if (this.#a(r2), !n3) for (let e10 of this.#t) e10.append(t4);
    return { alreadyProjected: n3, event: t4, ids: r2 };
  }
  #a(e9) {
    let t4 = new Set(e9);
    this.#n = this.#n.filter((e10) => !t4.has(e10.id));
    for (let e10 of this.#t) e10.remove((e11) => e11.type === `client.message.submitted` && t4.has(e11.data.submissionId));
  }
};

// node_modules/eve/dist/src/client/agent-stream-follower.js
var agentStreamReconnectPolicy = { streamIdleReconnectPolicy: { maxAttempts: 1 / 0 }, streamOpenReconnectPolicy: { maxAttempts: 1 / 0 } };
var AgentStreamFollower = class {
  #e;
  #t = /* @__PURE__ */ new Map();
  #n = /* @__PURE__ */ new Map();
  #r = /* @__PURE__ */ new Set();
  #i = false;
  constructor(e9) {
    this.#e = e9;
  }
  acceptParentEvent(e9) {
    e9.type === `agent.started` && this.#t.set(e9.data.sessionId, e9);
  }
  reconcile() {
    if (this.#i) return;
    let e9 = this.#e.getState();
    for (let t4 of Object.values(e9.agents)) {
      if (agentToolTask(e9, t4) === void 0) continue;
      let n3 = this.#n.get(t4.sessionId), r2 = isAgentSessionCaughtUp(e9, t4);
      n3 !== void 0 && r2 ? (this.#n.delete(t4.sessionId), n3.abort(), this.#e.onIdle(t4.sessionId)) : n3 === void 0 && !r2 && !this.#r.has(t4.sessionId) && this.#a(t4.sessionId);
    }
  }
  abortAll() {
    this.#i = true;
    for (let e9 of this.#n.values()) e9.abort();
    this.#n.clear();
  }
  #a(e9) {
    let t4 = this.#t.get(e9);
    if (t4 === void 0) return;
    let n3 = new AbortController();
    this.#n.set(e9, n3), this.#e.onFollowing(e9);
    let { cursors: r2 } = this.#e;
    (async () => {
      let i3 = r2.get(e9) ?? 0;
      try {
        for await (let a3 of this.#e.session.agent(t4).stream({ signal: n3.signal, startIndex: i3, streamReconnectPolicy: agentStreamReconnectPolicy })) {
          if (n3.signal.aborted) return;
          r2.set(e9, ++i3), this.#e.onEvent(e9, a3), this.reconcile();
        }
      } catch {
      }
      n3.signal.aborted || this.#n.get(e9) !== n3 || (this.#n.delete(e9), this.#r.add(e9), this.#e.onUnavailable(e9));
    })();
  }
};

// node_modules/eve/dist/src/shared/action-request-name.js
function actionRequestName(e9) {
  switch (e9.kind) {
    case `load-skill`:
      return e9.name;
    case `subagent-call`:
      return e9.subagentName;
    case `remote-agent-call`:
      return e9.remoteAgentName;
    case `tool-call`:
    case `workflow-tool-call`:
      return e9.toolName;
  }
}

// node_modules/eve/dist/src/shared/display-name.js
function displayName(e9) {
  let t4 = lastSegment(e9).replace(/([a-z0-9])([A-Z])/gu, `$1 $2`).replace(/([A-Z]+)([A-Z][a-z])/gu, `$1 $2`).split(SEPARATORS).filter((e10) => e10 !== ``).map((e10) => e10.length > 1 && e10 === e10.toUpperCase() ? e10 : e10.toLowerCase());
  return t4.length === 0 ? e9 : t4.join(` `);
}
function displayTitle(e9) {
  return capitalize(displayName(e9));
}
var SEPARATORS = /[\s_-]+/u;
function lastSegment(e9) {
  return e9.split(`__`).findLast((e10) => e10 !== ``) ?? e9;
}
function capitalize(e9) {
  return e9.charAt(0).toUpperCase() + e9.slice(1);
}

// node_modules/eve/dist/src/shared/action-label.js
function actionLabel(e9, t4) {
  return t4?.[e9.callId]?.label ?? displayTitle(actionRequestName(e9));
}

// node_modules/eve/dist/src/protocol/catalog-tools.js
var SKILL_TOOL_NAME = `eve__skill`;

// node_modules/eve/dist/src/client/message-action-parts.js
function toMessageInputRequest(e9) {
  return { allowFreeform: e9.allowFreeform, display: e9.display, kind: e9.kind, options: e9.options, prompt: e9.prompt, requestId: e9.requestId };
}
function createToolMetadata(e9, t4) {
  return { eve: { inputRequest: t4?.inputRequest, kind: e9.kind, label: t4?.label, name: e9.name } };
}
function mergeToolMetadata(e9, t4) {
  let n3 = t4.eve?.kind ?? e9?.eve?.kind ?? `unknown`, r2 = t4.eve?.name ?? e9?.eve?.name ?? `unknown`;
  return { eve: { ...e9?.eve, ...t4.eve, inputRequest: t4.eve?.inputRequest ?? e9?.eve?.inputRequest, inputResponse: t4.eve?.inputResponse ?? e9?.eve?.inputResponse, kind: n3, label: t4.eve?.label ?? e9?.eve?.label, name: r2 } };
}
function normalizeActionRequest(e9) {
  let t4 = actionRequestName(e9);
  switch (e9.kind) {
    case `load-skill`:
      return { kind: `load-skill`, name: t4, toolName: SKILL_TOOL_NAME };
    case `tool-call`:
    case `workflow-tool-call`:
      return { kind: `tool-call`, name: t4, toolName: t4 };
    case `subagent-call`:
    case `remote-agent-call`:
      return { kind: `subagent-call`, name: t4, toolName: `eve:subagent:${t4}` };
  }
}
function normalizeActionResult(e9) {
  switch (e9.kind) {
    case `load-skill-result`:
      return { kind: `load-skill`, name: e9.name, toolName: SKILL_TOOL_NAME };
    case `tool-result`:
      return { kind: `tool-call`, name: e9.toolName, toolName: e9.toolName };
    case `subagent-result`:
      return { kind: `subagent-call`, name: e9.subagentName, toolName: `eve:subagent:${e9.subagentName}` };
  }
}
function settledLabel(e9, t4, n3) {
  return t4 ?? e9?.eve?.label ?? displayTitle(n3.name);
}
function stringifyUnknown(e9) {
  if (typeof e9 == `string`) return e9;
  try {
    return JSON.stringify(e9);
  } catch {
    return `Action failed.`;
  }
}

// node_modules/eve/dist/src/client/authorization-message-parts.js
function createAuthorizationRequiredPart(e9) {
  let t4 = e9.data.authorization?.displayName ?? formatAuthorizationDisplayName(e9.data.name), n3 = { authorization: e9.data.authorization, description: normalizeAuthorizationDescription(e9.data.description, e9.data.name, t4), displayName: t4, name: e9.data.name, state: `required`, stepIndex: e9.data.stepIndex, turnId: e9.data.turnId, type: `authorization` };
  return e9.data.attemptId !== void 0 && (n3.attemptId = e9.data.attemptId), e9.data.webhookUrl !== void 0 && (n3.awaitsCallback = true), n3;
}
function createAuthorizationCompletedPart(e9, t4) {
  let n3 = e9.data.authorization?.displayName ?? t4?.displayName ?? formatAuthorizationDisplayName(e9.data.name), r2 = { authorization: t4?.authorization || e9.data.authorization ? { ...t4?.authorization, ...e9.data.authorization } : void 0, description: t4?.description ?? buildCompletedAuthorizationDescription(n3, e9.data.outcome, e9.data.reason), displayName: n3, name: e9.data.name, outcome: e9.data.outcome, state: `completed`, stepIndex: t4?.stepIndex ?? e9.data.stepIndex, turnId: t4?.turnId ?? e9.data.turnId, type: `authorization` }, i3 = e9.data.attemptId ?? t4?.attemptId;
  return i3 !== void 0 && (r2.attemptId = i3), t4?.awaitsCallback && (r2.awaitsCallback = true), e9.data.reason !== void 0 && (r2.reason = e9.data.reason), r2;
}
function buildCompletedAuthorizationDescription(e9, t4, n3) {
  return t4 === `authorized` ? `${e9} connected.` : `${e9} authorization ${t4}${n3 === void 0 ? `` : ` (${n3})`}.`;
}
function normalizeAuthorizationDescription(e9, t4, n3) {
  return e9 === `Authorization required for ${t4}` ? `Authorization required for ${n3}` : e9;
}
function formatAuthorizationDisplayName(e9) {
  return e9.length === 0 ? e9 : `${e9.charAt(0).toUpperCase()}${e9.slice(1)}`;
}

// node_modules/eve/dist/src/client/message-reducer-primitives.js
function projectReceivedParts(e9, t4) {
  return e9?.map((e10) => e10.type === `text` ? { state: `done`, text: e10.text, type: `text` } : { filename: e10.filename, mediaType: e10.mediaType, size: e10.size, type: `file`, url: e10.url }) ?? [{ state: `done`, text: t4, type: `text` }];
}
function partKey(e9) {
  switch (e9.type) {
    case `text`:
      return `text:${e9.stepIndex ?? 0}`;
    case `reasoning`:
      return `reasoning:${e9.stepIndex ?? 0}`;
    case `file`:
      return `file:${e9.stepIndex ?? 0}:${e9.filename ?? e9.url ?? e9.mediaType}`;
    case `step-start`:
      return `step-start`;
    case `authorization`:
      return e9.attemptId === void 0 ? `authorization:${e9.turnId}:${e9.stepIndex}:${e9.name}` : `authorization:${e9.attemptId}`;
    case `dynamic-tool`:
      return `dynamic-tool:${e9.toolCallId}`;
  }
}
function upsertMessage(e9, t4, n3) {
  let r2 = e9.messages.findIndex((e10) => e10.id === t4.id);
  if (r2 !== -1) return { ...e9, messages: [...e9.messages.slice(0, r2), t4, ...e9.messages.slice(r2 + 1)] };
  let i3 = n3 === void 0 ? -1 : e9.messages.findIndex((e10) => e10.role === `assistant` && e10.metadata?.turnId === n3);
  return i3 === -1 ? { ...e9, messages: [...e9.messages, t4] } : { ...e9, messages: [...e9.messages.slice(0, i3), t4, ...e9.messages.slice(i3)] };
}
function optimisticUserMessageId(e9) {
  return `optimistic:${e9}:user`;
}

// node_modules/eve/dist/src/client/message-run-parts.js
function transition(e9, t4) {
  let n3 = e9.parts.findLastIndex((e10) => e10.type === t4.type && e10.stepIndex === t4.stepIndex), r2 = n3 === -1 ? void 0 : e9.parts[n3];
  if (t4.kind === `append` && !t4.delta) return e9;
  let i3 = r2?.state === `streaming` ? r2 : void 0, a3 = { id: i3?.id ?? t4.id ?? `${e9.id}:${t4.type}:${e9.parts.length}`, state: t4.kind === `append` ? `streaming` : `done`, stepIndex: t4.stepIndex, text: t4.kind === `append` ? (i3?.text ?? ``) + t4.delta : t4.text, type: t4.type }, o3 = i3 ? [...e9.parts.slice(0, n3), a3, ...e9.parts.slice(n3 + 1)] : [...e9.parts, a3];
  return { ...e9, metadata: { ...e9.metadata, status: t4.type === `text` && a3.state === `done` ? `complete` : `streaming` }, parts: o3 };
}
var messageRun = { transition };

// node_modules/eve/dist/src/client/tool-part-state.js
function toolPartState(e9, t4) {
  let n3 = t4, r2 = conversationProjection(e9), i3 = r2.calls[t4.toolCallId], a3 = n3.approval?.id, o3 = a3 === void 0 ? void 0 : r2.inputs[a3], s3 = { input: t4.input, stepIndex: t4.stepIndex, toolCallId: t4.toolCallId, toolMetadata: t4.toolMetadata, toolName: t4.toolName, type: `dynamic-tool` }, c3 = a3 === void 0 ? void 0 : { id: a3, ...n3.approval?.isAutomatic !== void 0 && { isAutomatic: n3.approval.isAutomatic } }, responded = (e10, t5) => ({ ...s3, approval: { ...c3, ...e10 && { approved: true }, ...t5 !== void 0 && { reason: t5 } }, state: `approval-responded` }), l3 = c3 === void 0 ? void 0 : { ...c3, approved: true };
  if (c3 !== void 0 && o3 !== void 0 && o3.status !== `settled` && (i3 === void 0 || !isSettledCallStatus(reportedCallStatus(r2, i3)))) return { ...s3, approval: c3, state: `approval-requested` };
  let u3 = i3?.taskId === void 0 ? void 0 : r2.tasks[i3.taskId]?.calls[t4.toolCallId];
  if (i3 === void 0) return o3 === void 0 ? t4 : o3.response === void 0 ? { ...s3, output: { status: o3.outcome }, state: `output-available` } : responded(o3.outcome === `approved`, o3.response.text);
  switch (reportedCallStatus(r2, i3)) {
    case `running`:
    case `awaiting-input`:
      return n3.partial === true ? { ...s3, approval: l3, output: n3.output, partial: true, state: `output-available` } : o3 !== void 0 && (o3.outcome === `approved` || o3.response !== void 0) ? responded(o3.outcome === `approved`, o3.response?.text) : { ...s3, state: `input-available` };
    case `completed`:
      return { ...s3, approval: l3, output: u3?.output ?? n3.output, state: `output-available` };
    case `failed`:
      return { ...s3, approval: l3, errorText: u3?.error?.message ?? n3.errorText ?? i3.error?.message ?? (i3.taskId === void 0 ? `Action failed.` : `Task failed.`), state: `output-error` };
    case `rejected`:
      return { ...s3, approval: { id: a3 ?? t4.toolCallId, approved: false, reason: i3.error?.message ?? n3.errorText }, state: `output-denied` };
    case `cancelled`:
      return a3 !== void 0 && o3?.outcome === `cancelled` ? { ...s3, approval: { id: a3, approved: false, reason: `Tool execution was cancelled.` }, state: `output-denied` } : { ...s3, approval: l3, errorText: i3.taskId === void 0 ? n3.errorText ?? i3.error?.message ?? `Action was cancelled.` : `Task was cancelled.`, state: `output-error` };
  }
}

// node_modules/eve/dist/src/client/message-reducer.js
function receivedMessageEventId(e9) {
  return e9.meta.id ?? `${e9.data.turnId}:${e9.data.sequence}`;
}
function defaultMessageReducer() {
  return { initial() {
    return withConversationProjection({ messages: [] }, initialSessionProjection());
  }, reduce(e9, t4) {
    return reduceMessageData(e9, t4);
  } };
}
function reduceMessageData(e9, t4) {
  let n3 = foldSession(conversationProjection(e9), t4), r2 = withConversationProjection(reduceContent(e9, t4), n3), i3 = toolCallIds(r2, t4);
  return withConversationProjection(i3.length === 0 ? r2 : withToolPartStates(r2, i3), n3);
}
function reduceContent(e9, t4) {
  switch (t4.type) {
    case `client.message.submitted`:
    case `client.message.failed`:
      return upsertMessage(e9, { id: optimisticUserMessageId(t4.data.submissionId), metadata: { optimistic: true, status: t4.type === `client.message.failed` ? `failed` : `submitted` }, parts: [{ type: `text`, text: t4.data.message }], role: `user` }, t4.data.turnId);
    case `message.received`:
      return upsertMessage(e9, { id: `${receivedMessageEventId(t4)}:user`, metadata: { status: `complete`, turnId: t4.data.turnId }, parts: projectReceivedParts(t4.data.parts, t4.data.message), role: `user` }, t4.data.turnId);
    case `step.started`:
      return updateAssistantMessage(e9, t4.data.turnId, (e10) => ensureStepStartPart(e10, t4.data.stepIndex));
    case `step.completed`:
      return e9.messages.find((e10) => e10.role === `assistant` && e10.metadata?.turnId === t4.data.turnId) === void 0 ? e9 : updateAssistantMessage(e9, t4.data.turnId, (e10) => ({ ...e10, parts: closeStreamingRuns(e10.parts, t4.data.stepIndex) }));
    case `reasoning.appended`:
      return updateAssistantMessage(e9, t4.data.turnId, (e10) => messageRun.transition(ensureStepStartPart(e10, t4.data.stepIndex), { kind: `append`, delta: t4.data.reasoningDelta, id: t4.meta?.id, stepIndex: t4.data.stepIndex, type: `reasoning` }));
    case `reasoning.completed`:
      return updateAssistantMessage(e9, t4.data.turnId, (e10) => messageRun.transition(ensureStepStartPart(e10, t4.data.stepIndex), { kind: `complete`, stepIndex: t4.data.stepIndex, text: t4.data.reasoning, id: t4.meta?.id, type: `reasoning` }));
    case `action.input.appended`: {
      let n3 = findToolPart(e9, t4.data.callId);
      if (n3 !== void 0 && n3.state !== `input-streaming`) return e9;
      let r2 = (n3?.state === `input-streaming` ? n3.inputText : ``) + t4.data.inputTextDelta;
      return upsertToolPart(e9, t4.data.turnId, t4.data.stepIndex, { input: void 0, inputText: r2, state: `input-streaming`, stepIndex: t4.data.stepIndex, toolCallId: t4.data.callId, toolMetadata: n3?.toolMetadata ?? { eve: { kind: `unknown`, name: t4.data.toolName } }, toolName: t4.data.toolName, type: `dynamic-tool` });
    }
    case `actions.requested`: {
      let n3 = e9;
      for (let e10 of t4.data.actions) {
        let r2 = findToolPart(n3, e10.callId);
        if (r2 !== void 0 && r2.state !== `input-streaming`) continue;
        let i3 = normalizeActionRequest(e10);
        n3 = updateAssistantMessage(n3, t4.data.turnId, (n4) => upsertPart(ensureStepStartPart(n4, t4.data.stepIndex), { input: `input` in e10 ? e10.input : void 0, state: `input-available`, stepIndex: t4.data.stepIndex, toolCallId: e10.callId, toolMetadata: createToolMetadata(i3, { label: actionLabel(e10, t4.data.presentation) }), toolName: i3.toolName, type: `dynamic-tool` }));
      }
      return n3;
    }
    case `input.requested`: {
      let n3 = e9;
      for (let e10 of t4.data.requests) {
        let r2 = findToolPart(n3, e10.action.callId);
        if (r2?.approval?.id === e10.requestId || r2 !== void 0 && isSettledToolPart(r2)) continue;
        let i3 = normalizeActionRequest(e10.action);
        n3 = updateAssistantMessage(n3, t4.data.turnId, (n4) => upsertPart(ensureStepStartPart(n4, t4.data.stepIndex), { ...r2, approval: { id: e10.requestId }, input: e10.action.input, state: `approval-requested`, stepIndex: r2?.stepIndex ?? t4.data.stepIndex, toolCallId: e10.action.callId, toolMetadata: createToolMetadata(i3, { inputRequest: toMessageInputRequest(e10), label: r2?.toolMetadata?.eve?.label ?? actionLabel(e10.action, void 0) }), toolName: i3.toolName, type: `dynamic-tool` }));
      }
      return n3;
    }
    case `action.result`: {
      if (conversationProjection(e9).calls[t4.data.result.callId]?.taskId !== void 0) return e9;
      if (t4.data.error?.code === `MODEL_CALL_ATTEMPT_RETRIED`) return updateAssistantMessage(e9, t4.data.turnId, (e10) => ({ ...e10, parts: e10.parts.filter((e11) => e11.type !== `dynamic-tool` || e11.toolCallId !== t4.data.result.callId) }));
      let n3 = findToolPart(e9, t4.data.result.callId), r2 = normalizeActionResult(t4.data.result), i3 = t4.data.status === void 0 || t4.data.status === `completed` ? t4.data.result.isError !== true && t4.data.error === void 0 : false, a3 = { ...n3, input: n3?.input, stepIndex: n3?.stepIndex ?? t4.data.stepIndex, toolCallId: t4.data.result.callId, toolMetadata: mergeToolMetadata(n3?.toolMetadata, createToolMetadata(r2, { label: settledLabel(n3?.toolMetadata, t4.data.presentation?.[t4.data.result.callId]?.label, r2) })), toolName: n3?.toolName ?? r2.toolName, type: `dynamic-tool` }, o3 = i3 ? { errorText: void 0, output: t4.data.result.output } : { errorText: t4.data.error?.message ?? stringifyUnknown(t4.data.result.output), output: void 0 };
      return upsertToolPart(e9, t4.data.turnId, t4.data.stepIndex, { ...a3, ...o3, partial: void 0 });
    }
    case `action.partial`: {
      let n3 = findToolPart(e9, t4.data.result.callId);
      if (n3 !== void 0 && isSettledToolPart(n3)) return e9;
      let r2 = normalizeActionResult(t4.data.result);
      return upsertToolPart(e9, t4.data.turnId, t4.data.stepIndex, { ...n3, input: n3?.input, output: t4.data.result.output, partial: true, state: `output-available`, stepIndex: n3?.stepIndex ?? t4.data.stepIndex, toolCallId: t4.data.result.callId, toolMetadata: mergeToolMetadata(n3?.toolMetadata, createToolMetadata(r2, { label: settledLabel(n3?.toolMetadata, t4.data.presentation?.[t4.data.result.callId]?.label, r2) })), toolName: n3?.toolName ?? r2.toolName, type: `dynamic-tool` });
    }
    case `input.resolved`: {
      let n3 = e9;
      for (let { requestId: e10, response: r2 } of t4.data.resolutions) {
        let t5 = r2 === void 0 ? void 0 : findToolPartByApprovalId(n3, e10);
        t5 !== void 0 && (n3 = replaceToolPart(n3, { ...t5, toolMetadata: mergeToolMetadata(t5.toolMetadata, { eve: { inputResponse: r2, kind: t5.toolMetadata?.eve?.kind ?? `unknown`, name: t5.toolMetadata?.eve?.name ?? t5.toolName } }) }));
      }
      return n3;
    }
    case `task.settled`: {
      let n3 = findToolPart(e9, t4.data.callId);
      if (n3 === void 0) return e9;
      let { error: r2, output: i3, status: a3 } = t4.data, o3 = a3 === `completed` ? { output: i3 } : { errorText: r2?.message };
      return replaceToolPart(e9, { ...n3, ...o3 });
    }
    case `authorization.required`:
      return updateAssistantMessage(e9, t4.data.turnId, (e10) => upsertPart(ensureStepStartPart(e10, t4.data.stepIndex), createAuthorizationRequiredPart(t4)));
    case `authorization.completed`:
      return completeAuthorization(e9, t4);
    case `message.appended`:
      return updateAssistantMessage(e9, t4.data.turnId, (e10) => messageRun.transition(ensureStepStartPart(e10, t4.data.stepIndex), { kind: `append`, delta: t4.data.messageDelta, id: t4.meta?.id, stepIndex: t4.data.stepIndex, type: `text` }));
    case `message.completed`:
      return updateAssistantMessage(e9, t4.data.turnId, (e10) => messageRun.transition(ensureStepStartPart(e10, t4.data.stepIndex), { kind: `complete`, stepIndex: t4.data.stepIndex, text: t4.data.message, id: t4.meta?.id, type: `text` }));
    case `result.completed`:
      return updateAssistantMessage(e9, t4.data.turnId, (e10) => ({ ...e10, metadata: { ...e10.metadata, result: t4.data.result } }));
    case `turn.completed`:
    case `turn.cancelled`:
    case `turn.failed`:
      return t4.type === `turn.failed` && !e9.messages.some((e10) => e10.role === `assistant` && e10.metadata?.turnId === t4.data.turnId) ? e9 : updateAssistantMessage(e9, t4.data.turnId, (t5) => ({ ...t5, metadata: { ...t5.metadata, status: `complete` }, parts: removeUnsettledToolParts(closeStreamingRuns(t5.parts), conversationProjection(e9)) }));
    default:
      return e9;
  }
}
function toolCallIds(e9, t4) {
  let byRequest = (t5) => findToolPartByApprovalId(e9, t5)?.toolCallId ?? [];
  switch (t4.type) {
    case `actions.requested`:
      return t4.data.actions.map((e10) => e10.callId);
    case `input.requested`:
      return t4.data.requests.map((e10) => e10.action.callId);
    case `action.result`:
    case `action.partial`:
      return [t4.data.result.callId];
    case `task.started`:
    case `task.settled`:
      return [t4.data.callId];
    case `input.resolved`:
      return t4.data.resolutions.flatMap((e10) => byRequest(e10.requestId));
    case `approval.settled`:
      return [byRequest(t4.data.requestId)].flat();
    default:
      return [];
  }
}
function withToolPartStates(e9, t4) {
  let n3 = e9;
  for (let r2 of new Set(t4)) {
    let t5 = findToolPart(n3, r2);
    if (t5 === void 0) continue;
    let i3 = toolPartState(n3, t5);
    i3 !== t5 && (n3 = withConversationProjection(replaceToolPart(n3, i3), conversationProjection(e9)));
  }
  return n3;
}
function closeStreamingRuns(e9, t4) {
  return e9.map((e10) => (e10.type === `text` || e10.type === `reasoning`) && e10.state === `streaming` && (t4 === void 0 || e10.stepIndex === t4) ? { ...e10, state: `done` } : e10);
}
function removeUnsettledToolParts(e9, t4) {
  return e9.filter((e10) => {
    if (e10.type !== `dynamic-tool`) return true;
    if (e10.state === `input-streaming`) return false;
    if (e10.state !== `input-available`) return true;
    let n3 = t4.calls[e10.toolCallId];
    return n3 === void 0 || n3.taskId !== void 0 || reportedCallStatus(t4, n3) !== `running`;
  });
}
function updateAssistantMessage(e9, t4, n3) {
  let r2 = e9.messages.find((e10) => e10.role === `assistant` && e10.metadata?.turnId === t4) ?? createAssistantMessage(t4);
  return upsertMessage(e9, n3(r2));
}
function createAssistantMessage(e9) {
  return { id: `${e9}:assistant`, metadata: { status: `streaming`, turnId: e9 }, parts: [], role: `assistant` };
}
function ensureStepStartPart(e9, t4) {
  let n3 = e9.parts.filter((e10) => e10.type === `step-start`).length;
  if (n3 > t4) return e9;
  let r2 = t4 - n3 + 1;
  return { ...e9, parts: [...e9.parts, ...Array.from({ length: r2 }, () => ({ type: `step-start` }))] };
}
function upsertPart(e9, t4) {
  let n3 = e9.parts.findIndex((e10) => partKey(e10) === partKey(t4)), r2 = n3 === -1 ? [...e9.parts, t4] : [...e9.parts.slice(0, n3), t4, ...e9.parts.slice(n3 + 1)];
  return { ...e9, metadata: { ...e9.metadata, status: t4.type === `text` && t4.state === `done` ? `complete` : `streaming` }, parts: r2 };
}
function upsertToolPart(e9, t4, n3, r2) {
  let i3 = updateToolPart(e9, r2.toolCallId, r2);
  return i3 === e9 ? updateAssistantMessage(e9, t4, (e10) => upsertPart(ensureStepStartPart(e10, n3), r2)) : i3;
}
function updateToolPart(e9, t4, n3) {
  let r2 = e9.messages.find((e10) => e10.role === `assistant` && e10.parts.some((e11) => e11.type === `dynamic-tool` && e11.toolCallId === t4));
  return r2 ? upsertMessage(e9, upsertPart(r2, n3)) : e9;
}
function replaceToolPart(e9, t4) {
  let n3 = e9.messages.find((e10) => e10.parts.some((e11) => e11.type === `dynamic-tool` && e11.toolCallId === t4.toolCallId));
  return n3 === void 0 ? e9 : upsertMessage(e9, { ...n3, parts: n3.parts.map((e10) => partKey(e10) === partKey(t4) ? t4 : e10) });
}
function completeAuthorization(e9, t4) {
  let n3 = findPendingAuthorizationPart(e9, t4.data.name, t4.data.attemptId), r2 = createAuthorizationCompletedPart(t4, n3);
  return updateAssistantMessage(e9, n3?.turnId ?? t4.data.turnId, (e10) => upsertPart(ensureStepStartPart(e10, r2.stepIndex), r2));
}
function findToolPart(e9, t4) {
  for (let n3 of e9.messages) for (let e10 of n3.parts) if (e10.type === `dynamic-tool` && e10.toolCallId === t4) return e10;
}
function isSettledToolPart(e9) {
  return e9.state === `output-denied` || e9.state === `output-error` || e9.state === `output-available` && e9.partial !== true;
}
function findPendingAuthorizationPart(e9, t4, n3) {
  for (let r2 = e9.messages.length - 1; r2 >= 0; --r2) {
    let i3 = e9.messages[r2];
    if (i3?.role === `assistant`) for (let e10 = i3.parts.length - 1; e10 >= 0; --e10) {
      let r3 = i3.parts[e10];
      if (r3?.type === `authorization` && r3.state === `required` && (n3 === void 0 ? r3.attemptId === void 0 && r3.name === t4 : r3.attemptId === n3)) return r3;
    }
  }
}
function findToolPartByApprovalId(e9, t4) {
  for (let n3 of e9.messages) for (let e10 of n3.parts) if (e10.type === `dynamic-tool` && e10.approval?.id === t4) return e10;
}

// node_modules/eve/dist/src/client/conversation-reducer.js
function initialConversationState() {
  return withConversationProjection({ turns: {}, inputs: {}, tasks: {}, messages: [], agents: {} }, initialSessionProjection());
}
function updateObservation(e9, t4, n3) {
  let r2 = e9.agents[t4];
  if (r2 === void 0) return e9;
  let i3 = n3(r2.observation);
  return i3 === r2.observation ? e9 : { ...e9, agents: { ...e9.agents, [t4]: { ...r2, observation: i3 } } };
}
function observedConversation(e9) {
  return e9.status === `not-followed` ? void 0 : e9.conversation;
}
function reduceConversationLifecycle(e9, t4) {
  switch (t4.type) {
    case `agent.started`: {
      let { callId: n3, name: r2, sessionId: i3, taskId: a3, turnId: o3 } = t4.data;
      if (e9.agents[i3] !== void 0) return e9;
      let s3 = { sessionId: i3, name: r2, callId: n3, turnId: o3, observation: { status: `not-followed` } };
      return a3 !== void 0 && (s3.taskId = a3), withConversationProjection({ ...e9, agents: { ...e9.agents, [i3]: s3 } }, conversationProjection(e9));
    }
    case `client.input.responded`: {
      let n3 = { ...e9.inputs };
      for (let e10 of t4.data.responses) {
        let t5 = n3[e10.requestId];
        t5?.status === `open` && (n3[e10.requestId] = { ...t5, response: e10, status: `responded` });
      }
      let r2 = conversationProjection(e9), i3 = { ...r2.inputs };
      for (let e10 of t4.data.responses) {
        let t5 = i3[e10.requestId];
        t5?.status === `open` && (i3[e10.requestId] = { ...t5, response: e10, status: `responded` });
      }
      return withConversationProjection({ ...e9, inputs: n3 }, { ...r2, inputs: i3 });
    }
    default:
      return e9;
  }
}
var messageReducer = defaultMessageReducer();
function reduceConversation(e9, t4) {
  let n3 = reduceConversationEvent(e9, t4);
  return t4.type.startsWith(`client.agent.`) ? withConversationProjection(n3, conversationProjection(e9)) : n3;
}
function reduceConversationEvent(e9, t4) {
  switch (t4.type) {
    case `client.agent.following`:
      return updateObservation(e9, t4.data.sessionId, (e10) => e10.status === `following` ? e10 : { status: `following`, conversation: observedConversation(e10) ?? initialConversationState() });
    case `client.agent.observed`:
      return updateObservation(e9, t4.data.sessionId, (e10) => e10.status === `following` ? { status: `following`, conversation: reduceConversation(e10.conversation, t4.data.event) } : e10);
    case `client.agent.idle`:
      return updateObservation(e9, t4.data.sessionId, (e10) => e10.status === `following` ? { status: `idle`, conversation: e10.conversation } : e10);
    case `client.agent.unavailable`:
      return updateObservation(e9, t4.data.sessionId, (e10) => {
        let t5 = observedConversation(e10);
        return t5 === void 0 ? { status: `unavailable` } : { status: `unavailable`, conversation: t5 };
      });
    default:
      let n3 = messageReducer.reduce(e9, t4), r2 = conversationProjection(n3), { activeTurnId: i3, ...a3 } = e9, { activeTurnId: o3, ...s3 } = n3, c3 = { ...a3, ...s3, turns: Object.fromEntries(Object.entries(r2.turns).map(([e10, t5]) => {
        let { turnId: n4, status: r3, waiting: i4 } = t5, a4 = { turnId: n4, status: r3 };
        return i4 !== void 0 && (a4.waiting = i4), [e10, a4];
      })), inputs: Object.fromEntries(Object.entries(r2.inputs).map(([e10, t5]) => {
        let { sequence: n4, callId: r3, ...i4 } = t5;
        return [e10, i4];
      })), tasks: r2.tasks };
      return r2.activeTurnId !== void 0 && (c3.activeTurnId = r2.activeTurnId), reduceConversationLifecycle(withConversationProjection(c3, r2), t4);
  }
}
var canonicalConversationReducer = { initial: initialConversationState, reduce: reduceConversation };
var conversationReducer = canonicalConversationReducer;

// node_modules/eve/dist/src/protocol/event-dedupe.js
function createEventDeduper() {
  let e9 = /* @__PURE__ */ new Set();
  return { admit(t4) {
    let n3 = t4.meta?.id;
    return n3 === void 0 || !e9.has(n3) && (e9.add(n3), true);
  }, get size() {
    return e9.size;
  } };
}

// node_modules/eve/dist/src/client/session-event-stream.js
var SessionEventStream = class {
  #e = new AbortController();
  #t = /* @__PURE__ */ new Set();
  #n = Promise.withResolvers();
  caughtUp = this.#n.promise;
  #r = false;
  #i;
  #a;
  #o;
  constructor(e9, t4) {
    this.setOptions(t4), this.caughtUp.catch(() => {
    }), t4.catchUp || this.#n.resolve(), (async () => {
      try {
        for await (let n3 of followClientSession(e9, { signal: this.#e.signal, resolveHeaders: () => this.#a, resolveReconnectPolicy: () => this.#o, startIndex: t4.startIndex, onCaughtUp: t4.catchUp ? () => this.#n.resolve() : void 0 })) {
          if (this.#e.signal.aborted) return;
          t4.onEvent(n3);
          for (let e10 of this.#t) e10.push(n3);
          if (n3.type === `session.completed` || n3.type === `session.failed`) break;
        }
        this.#n.resolve(), this.#s();
      } catch (e10) {
        this.#n.reject(e10), this.#s(e10), this.#e.signal.aborted || t4.onError(e10);
      }
    })();
  }
  subscribe(e9) {
    let t4 = new SessionEventReader(() => this.#t.delete(t4), e9);
    return this.#r ? t4.end(this.#i) : this.#t.add(t4), t4;
  }
  get ended() {
    return this.#r;
  }
  setOptions(e9) {
    `headers` in e9 && (this.#a = e9.headers), `streamReconnectPolicy` in e9 && (this.#o = e9.streamReconnectPolicy);
  }
  close() {
    let e9 = new DOMException(`Session stream was detached.`, `AbortError`);
    this.#e.abort(e9), this.#n.reject(e9), this.#s(e9);
  }
  #s(e9) {
    if (!this.#r) {
      this.#r = true, this.#i = e9;
      for (let t4 of this.#t) t4.end(e9);
    }
  }
};
var SessionEventReader = class {
  #e = [];
  #t = Promise.withResolvers();
  #n = false;
  #r;
  #i;
  constructor(e9, t4) {
    let abort = () => this.end(t4?.reason);
    t4?.addEventListener(`abort`, abort, { once: true }), this.#i = () => {
      t4?.removeEventListener(`abort`, abort), e9();
    }, t4?.aborted && abort();
  }
  push(e9) {
    this.#n || (this.#e.push(e9), this.#t.resolve());
  }
  end(e9) {
    this.#n || (this.#n = true, this.#r = e9, this.#t.resolve());
  }
  [Symbol.dispose]() {
    this.end(), this.#e = [], this.#i();
  }
  discard() {
    this.#e = [];
  }
  async *[Symbol.asyncIterator]() {
    for (; ; ) {
      for (; this.#e.length > 0; ) yield this.#e.shift();
      if (this.#n) {
        if (this.#r !== void 0) throw this.#r;
        return;
      }
      this.#t = Promise.withResolvers(), await this.#t.promise;
    }
  }
};

// node_modules/eve/dist/src/client/conversation-client.js
var ConversationClient = class {
  projection;
  #e;
  #t = /* @__PURE__ */ new Map();
  #n = createEventDeduper();
  #r;
  #i;
  #a;
  #o;
  constructor(e9, t4, n3) {
    this.projection = e9, this.#e = e9.reducer === conversationReducer ? e9 : new EveAgentProjection(canonicalConversationReducer, []), this.#a = t4, this.#o = n3;
  }
  get data() {
    return this.projection.data;
  }
  get conversation() {
    return this.#e.data;
  }
  get projections() {
    return this.#e === this.projection ? [this.projection] : [this.#e, this.projection];
  }
  get following() {
    return this.#r !== void 0;
  }
  append(e9) {
    let t4 = this.data, n3 = this.conversation;
    this.#c(e9), t4 === this.data ? n3 !== this.conversation && this.#o?.(this.conversation, n3) : this.#a(this.data, t4);
  }
  projectResponses(e9) {
    if (!e9?.length) return;
    let t4 = { data: { createdAt: Date.now(), responses: e9 }, type: `client.input.responded` };
    return this.append(t4), () => this.#s(t4);
  }
  replaceResponses(e9, t4) {
    return e9?.(), assertAnswerable(t4, this.conversation), this.projectResponses(t4.inputResponses);
  }
  #s(e9) {
    let t4 = this.data, n3 = this.conversation;
    for (let t5 of this.projections) t5.remove((t6) => t6 === e9);
    t4 === this.data ? n3 !== this.conversation && this.#o?.(this.conversation, n3) : this.#a(this.data, t4);
  }
  observe(e9, t4 = {}) {
    if (!this.#n.admit(e9)) return false;
    t4.onAccepted?.(e9);
    let n3 = this.data, r2 = this.conversation;
    return t4.project ? t4.project(e9) : this.#c(e9), t4.notify !== false && (n3 === this.data ? r2 !== this.conversation && this.#o?.(this.conversation, r2) : this.#a(this.data, n3)), this.#r?.acceptParentEvent(e9), this.#r?.reconcile(), true;
  }
  hydrate(e9) {
    return this.#n.admit(e9) ? (this.#c(e9), true) : false;
  }
  follow(e9, t4 = []) {
    this.#r?.abortAll();
    let n3 = new AgentStreamFollower({ session: e9, cursors: this.#t, getState: () => this.conversation, onFollowing: (e10) => this.#l({ type: `client.agent.following`, data: { sessionId: e10 } }), onEvent: (e10, t5) => this.#l({ type: `client.agent.observed`, data: { sessionId: e10, event: t5 } }), onIdle: (e10) => this.#l({ type: `client.agent.idle`, data: { sessionId: e10 } }), onUnavailable: (e10) => this.#l({ type: `client.agent.unavailable`, data: { sessionId: e10 } }) });
    this.#r = n3;
    for (let e10 of t4) n3.acceptParentEvent(e10);
    n3.reconcile();
  }
  #c(e9) {
    for (let t4 of this.projections) t4.append(e9);
  }
  #l(e9) {
    let t4 = this.data, n3 = this.conversation;
    this.#e.append(e9), t4 === this.data ? n3 !== this.conversation && this.#o?.(this.conversation, n3) : this.#a(this.data, t4);
  }
  stream(e9, t4) {
    return this.#i !== void 0 && !this.#i.ended ? (this.#i.setOptions(t4), this.#i) : (this.#i = new SessionEventStream(e9, t4), this.#i);
  }
  closeStream() {
    this.#i?.close(), this.#i = void 0;
  }
  stop() {
    this.#r?.abortAll(), this.#r = void 0, this.closeStream();
  }
  reset() {
    this.stop(), this.#t.clear(), this.#n = createEventDeduper();
    for (let e9 of this.projections) e9.reset();
  }
};

// node_modules/eve/dist/src/client/session-turn-dispatch.js
async function dispatchSessionTurn(e9) {
  let { client: t4, session: n3, turn: r2, beforeSend: i3 } = e9;
  if (n3 === void 0) {
    if (t4 === void 0) throw Error(`An external eve session is required before sending.`);
    if (r2.message === void 0) throw Error(`Cannot answer an input request before the session starts.`);
    let e10 = await t4.sessions.create({ ...r2, message: r2.message });
    return throwIfAborted(r2.signal), { ...e10, created: true };
  }
  if (i3?.(), r2.inputResponses === void 0) {
    let { message: e10, ...t5 } = r2;
    return { session: n3, response: await n3.send(e10, t5), created: false };
  }
  let { inputResponses: a3, ...o3 } = r2;
  return { session: n3, response: await n3.respond(a3, o3), created: false };
}

// node_modules/eve/dist/src/client/eve-agent-store.js
var detachStore = /* @__PURE__ */ Symbol(`detachEveAgentStore`);
var attachStore = /* @__PURE__ */ Symbol(`attachEveAgentStore`);
var EveAgentStore = class {
  #e;
  #t;
  #n = false;
  #r;
  #i;
  #a;
  #o;
  #s = /* @__PURE__ */ new Set();
  #c;
  #l = {};
  #u;
  #d;
  #f;
  #p = 0;
  #m;
  #h;
  #g;
  #_;
  #v;
  #y = `ready`;
  constructor(e9) {
    this.#t = e9.prewarm ?? false, this.#i = e9.followSubagents ?? false, this.#a = e9.followIdle ?? true, this.#o = e9.session !== void 0, this.#e = this.#o ? void 0 : e9.client ?? new Client({ auth: e9.auth, headers: e9.headers, host: e9.host ?? `` }), this.#r = new ConversationClient(new EveAgentProjection(e9.reducer, []), () => this.#L(), () => this.#L()), this.#d = (e9.initialEvents ?? []).filter((e10) => this.#r.hydrate(e10)), this.#f = new OptimisticMessageSubmissions(this.#r.projections, e9.optimistic ?? true), this.#_ = e9.session ?? (e9.initialSession === void 0 ? void 0 : this.#e?.sessions.attach(e9.initialSession.sessionId, { streamIndex: e9.initialSession.streamIndex })), this.#v = this.#I();
  }
  get snapshot() {
    return this.#v;
  }
  setCallbacks(e9) {
    this.#l = e9;
  }
  subscribe(e9) {
    return this.#s.add(e9), () => void this.#s.delete(e9);
  }
  prewarm() {
    if (this.#m !== void 0) return this.#m;
    if (this.#_ !== void 0 || this.#o) return Promise.resolve();
    if (this.#c !== void 0) return this.#c.response.then((e10) => {
      if (e10 === void 0) throw this.#u ?? new DOMException(`Session creation was aborted.`, `AbortError`);
    });
    let e9 = this.#e;
    if (e9 === void 0) return Promise.reject(Error(`This eve agent store does not own a session client.`));
    let t4 = this.#p, n3 = new AbortController();
    this.#h = n3;
    let r2 = (async () => {
      try {
        let r3 = await e9.sessions.create({ signal: n3.signal });
        if (t4 !== this.#p) return;
        this.#u = void 0, this.#y === `error` && (this.#y = `ready`), this.#T(r3.session), this.#a && this.#w();
      } catch (e10) {
        throw t4 === this.#p && this.#c === void 0 && this.#u === void 0 && this.#E(e10), e10;
      }
    })();
    this.#m = r2;
    let clear = () => {
      this.#m === r2 && (this.#m = void 0, this.#h = void 0);
    };
    return r2.then(clear, clear), r2;
  }
  async send(e9) {
    return await this.#b(e9, this.#l.prepareSend);
  }
  async #b(e9, t4) {
    if (assertAnswerable(e9, this.#r.conversation), this.#c !== void 0) {
      if (this.#y === `resuming`) throw Error(`eve session is resuming.`);
      return await this.#S(this.#c, e9, t4);
    }
    let n3 = createActiveTurn((e10) => e10.acceptedFollowUps > 0 && this.#_ !== void 0 ? this.#_.cancel() : e10.response.then((e11) => e11 === void 0 ? { status: `no_active_turn` } : e11.cancel()));
    this.#c = n3, this.#u = void 0, this.#y = `submitted`;
    let r2, i3, a3;
    try {
      assertExclusiveTurnInput(e9), i3 = this.#f.submit(e9, this.#d.length), a3 = this.#r.projectResponses(e9.inputResponses), this.#L();
      let o3 = await (t4 === void 0 ? e9 : waitWithSignal(Promise.resolve(t4(e9)), createAbortSignal(e9.signal, n3.abortController.signal)));
      if (assertExclusiveTurnInput(o3), !this.#A(n3)) return;
      o3 !== e9 && (i3 = this.#f.resubmit(i3, o3), a3 = this.#r.replaceResponses(a3, o3), this.#L());
      let s3 = { ...o3, signal: createAbortSignal(o3.signal, n3.abortController.signal) }, c3 = await this.#C(s3);
      a3 = void 0;
      let l3 = c3.response;
      if (r2 = c3.reader, !this.#A(n3)) return;
      n3.resolveResponse(l3), this.#N(i3, l3);
      for await (let e10 of consumeMessageResponse(l3, r2)) {
        if (!this.#A(n3)) return;
        n3.receivedFollowUps += n3.receivedFollowUpEvents.get(e10) ?? 0, n3.receivedFollowUpEvents.delete(e10);
      }
      if (!this.#A(n3) || (await followSteeredTurns(n3, r2, () => this.#A(n3)), !this.#A(n3))) return;
      this.#y = settledStatus(this.#u, this.#r.conversation);
    } catch (e10) {
      if (!this.#A(n3)) return;
      if (a3?.(), isAbortError(e10)) this.#y = `ready`, this.#f.fail(toError(e10), i3);
      else {
        let t5 = this.#u !== void 0;
        this.#u ??= toError(e10), this.#y = `error`, this.#f.fail(this.#u, i3), t5 || this.#l.onError?.(this.#u);
      }
    } finally {
      r2?.[Symbol.dispose](), this.#k(n3);
    }
  }
  resume() {
    if (this.#g !== void 0) return this.#g;
    let e9 = this.#x();
    this.#g = e9;
    let clear = () => {
      this.#g === e9 && (this.#g = void 0);
    };
    return e9.then(clear, clear), e9;
  }
  async #x() {
    if (this.#y !== `ready` && this.#y !== `error`) throw Error(`eve session is already processing a turn.`);
    if (this.#_ === void 0) throw Error(`An eve session is required before resuming.`);
    let e9 = this.#_, t4 = createActiveTurn(() => e9.cancel());
    this.#c = t4, t4.resolveResponse(void 0), this.#u = void 0, this.#y = `resuming`, this.#L();
    let n3;
    try {
      let r2 = this.#w({ catchUp: true, startIndex: this.#d.length === e9.state.streamIndex ? e9.state.streamIndex : 0 });
      if (n3 = r2.subscribe(t4.abortController.signal), await r2.caughtUp, !this.#A(t4)) return;
      n3.discard();
      let i3 = this.#d.at(-1);
      if (i3 !== void 0 && this.#F(i3), i3 && !this.#u && !isSettledSessionTail(this.#d, this.#r.conversation)) {
        this.#y = `streaming`, this.#L();
        for await (let e10 of n3) {
          if (!this.#A(t4)) return;
          if (t4.receivedFollowUps += t4.receivedFollowUpEvents.get(e10) ?? 0, t4.receivedFollowUpEvents.delete(e10), isResponseBoundary(e10, this.#r.conversation)) break;
        }
      }
      await followSteeredTurns(t4, n3, () => this.#A(t4)), this.#A(t4) && (this.#y = settledStatus(this.#u, this.#r.conversation));
    } catch (e10) {
      if (!this.#A(t4)) return;
      isAbortError(e10) ? this.#y = `ready` : (this.#u = toError(e10), this.#y = `error`, this.#l.onError?.(this.#u));
    } finally {
      n3?.[Symbol.dispose](), this.#k(t4);
    }
  }
  cancel() {
    let e9 = this.#c;
    return e9 === void 0 ? this.#y === `streaming` && this.#_ !== void 0 ? this.#_.cancel() : Promise.resolve({ status: `no_active_turn` }) : e9.cancel();
  }
  async compact() {
    return await this.#_?.compact() ?? { status: `no_active_session` };
  }
  async clear() {
    return await this.#_?.clear() ?? { status: `no_active_session` };
  }
  async retire() {
    if (this.#o) throw Error(`retire() needs a store-owned session. Call reset() on the session you supplied, then create a new store for the next session.`);
    let e9 = await this.#_?.reset() ?? { status: `no_active_session` };
    return this.reset(), e9;
  }
  [attachStore]() {
    this.#n = true, this.#i && !this.#r.following && this.#D(), this.#t && this.#_ === void 0 && this.prewarm().catch(() => {
    });
  }
  [detachStore]() {
    this.#n = false, this.#r.stop(), this.#c?.abortController.abort(), this.#O(), this.#g = void 0;
  }
  reset() {
    this.#r.stop();
    let e9 = this.#c;
    this.#c = void 0, e9?.resolveResponse(void 0), e9?.resolveCompletion(), e9?.abortController.abort(), this.#O(), this.#g = void 0, this.#o || (this.#_ = void 0), this.#d = [], this.#r.reset(), this.#f.reset(), this.#i && this.#n && this.#D(), this.#u = void 0, this.#y = `ready`, this.#l.onSessionChange?.(this.#_?.state), this.#L(), this.#t && this.#n && this.prewarm().catch(() => {
    });
  }
  async #S(e9, t4, n3) {
    assertInFlightFollowUp(t4);
    let r2 = this.#p, i3 = createAbortSignal(t4.signal, e9.abortController.signal), a3 = this.#r.projectResponses(t4.inputResponses), o3 = await waitWithSignal(Promise.resolve(n3?.(t4)), i3).then((e10) => {
      let n4 = validateFollowUp(e10 ?? t4);
      return n4 === t4 || (a3 = this.#r.replaceResponses(a3, n4)), n4;
    }).catch((e10) => {
      throw a3?.(), e10;
    });
    if (r2 !== this.#p) return;
    if (!this.#A(e9)) return a3?.(), await this.#b(o3);
    let s3 = this.#f.submit(o3, this.#d.length, activeTurnForOptimisticFollowUp(this.#d));
    s3 !== void 0 && e9.followUpSubmissionIds.add(s3), this.#L();
    let c3;
    c3 = (async () => {
      try {
        let t5 = createAbortSignal(o3.signal, e9.abortController.signal);
        if (await waitWithSignal(e9.response, t5), !this.#A(e9) || this.#_ === void 0) throw Error(`The active eve turn ended before the follow-up could be sent.`);
        this.#w({ headers: o3.headers, streamReconnectPolicy: o3.streamReconnectPolicy });
        let n4 = (await dispatchSessionTurn({ session: this.#_, turn: { ...o3, signal: t5 } })).response;
        if (a3 = void 0, o3.message === void 0) return;
        e9.acceptedFollowUps += 1, this.#N(s3, n4);
      } catch (t5) {
        throw this.#A(e9) && (this.#f.fail(toError(t5), s3), a3?.(), this.#L()), t5;
      } finally {
        e9.followUpDispatches.delete(c3);
      }
    })(), e9.followUpDispatches.add(c3), await c3, await e9.completion;
  }
  async #C(e9) {
    let t4 = { headers: e9.headers, streamReconnectPolicy: e9.streamReconnectPolicy };
    this.#m !== void 0 && (await waitWithSignal(this.#m.catch((e10) => {
      if (this.#_ !== void 0) throw e10;
    }), e9.signal), throwIfAborted(e9.signal));
    let n3 = this.#_, r2;
    try {
      let i3 = await dispatchSessionTurn({ client: this.#e, session: n3, turn: e9, beforeSend: () => {
        r2 = this.#w(t4).subscribe(e9.signal);
      } });
      return i3.created && (this.#T(i3.session), r2 = this.#w(t4).subscribe(e9.signal)), { response: i3.response, reader: r2 };
    } catch (e10) {
      throw r2?.[Symbol.dispose](), e10;
    }
  }
  #w(e9 = {}) {
    if (this.#_ === void 0) throw Error(`A session is required before opening its stream.`);
    let t4 = this.#p;
    return this.#i && !this.#r.following && this.#D(), this.#r.stream(this.#_, { ...e9, onEvent: (e10) => {
      t4 === this.#p && this.#j(e10);
    }, onError: (e10) => {
      t4 === this.#p && this.#c === void 0 && this.#E(e10);
    } });
  }
  #T(e9) {
    this.#_ = e9, this.#i && this.#n && this.#D(), this.#l.onSessionChange?.(e9.state), this.#L();
  }
  #E(e9) {
    this.#u = toError(e9), this.#y = `error`, this.#l.onError?.(this.#u), this.#L();
  }
  #D() {
    this.#_ && this.#r.follow(this.#_, this.#d);
  }
  #O() {
    this.#p += 1, this.#h?.abort(), this.#h = void 0, this.#m = void 0;
  }
  #k(e9) {
    if (this.#A(e9)) {
      e9.resolveResponse(void 0), this.#c = void 0, this.#M();
      try {
        this.#l.onSessionChange?.(this.#_?.state), this.#L(), this.#l.onFinish?.(this.#v);
      } finally {
        e9.resolveCompletion();
      }
    }
  }
  #A(e9) {
    return this.#c === e9;
  }
  #j(e9) {
    let t4 = this.#y === `streaming`;
    if (!this.#r.observe(e9, { onAccepted: () => {
      this.#d = [...this.#d, e9];
    }, project: (e10) => {
      this.#P(this.#f.apply(e10));
    }, notify: false })) return false;
    this.#l.onEvent?.(e9), this.#F(e9);
    let { conversation: n3 } = this.#r, r2 = isSettledSessionTail(this.#d, n3) && n3.activeTurnId === void 0;
    return this.#y !== `resuming` && this.#u === void 0 && (`data` in e9 && e9.data !== void 0 && `turnId` in e9.data && (this.#y = `streaming`), this.#c === void 0 && r2 && (this.#y = `ready`)), this.#l.onSessionChange?.(this.#_?.state), this.#y !== `resuming` && this.#L(), this.#c === void 0 && t4 && r2 && this.#l.onFinish?.(this.#v), this.#c === void 0 && this.#M(), true;
  }
  #M() {
    if (this.#a) return;
    let { conversation: e9 } = this.#r;
    e9.activeTurnId !== void 0 || this.#d.length > 0 && !isSettledSessionTail(this.#d, e9) || Object.values(e9.tasks).some((e10) => Object.values(e10.calls).some((e11) => e11.status === `working`)) || this.#r.closeStream();
  }
  #N(e9, t4) {
    let n3 = getMessageResponseDeliveryId(t4), r2 = this.#f.correlate(e9, n3, this.#d);
    this.#P(r2) && this.#L();
  }
  #P(e9) {
    return e9 !== void 0 && (this.#c !== void 0 && countFollowUpDeliveries(this.#c, e9), true);
  }
  #F(e9) {
    let t4 = toTerminalStreamFailureError(e9);
    t4 !== void 0 && (this.#y = `error`, this.#f.failAll(t4), this.#u === void 0 && (this.#u = t4, this.#l.onError?.(t4)));
  }
  #I() {
    return { data: this.#r.data, conversation: this.#r.conversation, error: this.#u, events: this.#d, session: this.#_?.state, status: this.#y };
  }
  #L() {
    this.#v = this.#I();
    for (let e9 of this.#s) e9();
  }
};

// agents/local-agent/launcher/prompts.ts
import { randomBytes } from "node:crypto";
var DEFAULT_PROMPT_TIMEOUT_MS = 5 * 6e4;
var MIN_PROMPT_TIMEOUT_MS = 1e4;
var MAX_PROMPT_TIMEOUT_MS = 30 * 6e4;
var PROMPT_SLOT_GRACE_MS = 6e4;
var PROMPT_FD_ENV = "LOCAL_AGENT_PROMPT_FD";
var PROMPT_STDIO = ["pipe", "pipe", "pipe", "pipe"];
var PROMPT_ID = /^[\x21-\x7e]{1,128}$/;
var TITLE_MAX = 256;
var BODY_MAX = 6e4;
var PATH_MAX_BYTES = 1024;
var REASON_MAX = 300;
var CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
var yes = { allowed: true, reason: "allowed" };
var no3 = (reason) => ({ allowed: false, reason });
function normalizePrompt(kind, detail) {
  const d3 = detail && typeof detail === "object" ? detail : null;
  if (!d3) return { error: "the detail must be an object" };
  if (kind === "push") {
    const title = typeof d3.title === "string" ? d3.title.replace(CONTROL_CHARS, "").trim() : "";
    if (title.length < 1 || title.length > TITLE_MAX) return { error: `a push title is 1\u2013${TITLE_MAX} characters` };
    if (d3.body !== void 0 && (typeof d3.body !== "string" || d3.body.length > BODY_MAX)) return { error: `a push body is at most ${BODY_MAX} characters` };
    return { detail: d3.body === void 0 ? { title } : { title, body: d3.body } };
  }
  if (kind === "fence") {
    const path = d3.path;
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return { error: "a fence path is absolute" };
    if (new TextEncoder().encode(path).length > PATH_MAX_BYTES) return { error: `a fence path is at most ${PATH_MAX_BYTES} bytes` };
    if (d3.access === "write") return { error: "fence grants are read-only (C3): a write is never asked" };
    if (d3.access !== "read") return { error: 'a fence access is "read"' };
    if (d3.reason !== void 0 && (typeof d3.reason !== "string" || d3.reason.length > REASON_MAX)) return { error: `a fence reason is at most ${REASON_MAX} characters` };
    return { detail: d3.reason === void 0 ? { path, access: d3.access } : { path, access: d3.access, reason: d3.reason } };
  }
  return { error: `unknown prompt kind ${JSON.stringify(kind)}` };
}
function parsePromptAnswer(line) {
  let v3;
  try {
    v3 = JSON.parse(line);
  } catch {
    return null;
  }
  const m3 = v3 && typeof v3 === "object" ? v3 : null;
  if (!m3 || m3.type !== "prompt_answer" || typeof m3.id !== "string" || !PROMPT_ID.test(m3.id) || typeof m3.allow !== "boolean") return null;
  return { type: "prompt_answer", id: m3.id, allow: m3.allow };
}
function clampTimeout(ms3) {
  if (typeof ms3 !== "number" || !Number.isFinite(ms3)) return DEFAULT_PROMPT_TIMEOUT_MS;
  return Math.min(MAX_PROMPT_TIMEOUT_MS, Math.max(MIN_PROMPT_TIMEOUT_MS, Math.round(ms3)));
}
function lineSplitter(onLine) {
  const decoder = new TextDecoder();
  let pending = new Uint8Array(0);
  return (chunk) => {
    const merged = new Uint8Array(pending.length + chunk.length);
    merged.set(pending);
    merged.set(chunk, pending.length);
    let start = 0;
    for (let nl2 = merged.indexOf(10); nl2 !== -1; nl2 = merged.indexOf(10, start)) {
      onLine(decoder.decode(merged.subarray(start, nl2)));
      start = nl2 + 1;
    }
    pending = merged.slice(start);
  };
}
function jsonLine(value) {
  return `${JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}
`;
}
function createPromptBroker(io3, opts = {}) {
  const prefix = opts.idPrefix ?? `p-${randomBytes(4).toString("hex")}`;
  const queue = [];
  let open = null;
  let closed = false;
  let seq = 0;
  const nextShowable = () => {
    for (let p3 = queue.shift(); p3; p3 = queue.shift()) {
      if (p3.deadline - Date.now() >= MIN_PROMPT_TIMEOUT_MS) return p3;
      io3.log(`[local-agent] prompt ${p3.id} had under ${MIN_PROMPT_TIMEOUT_MS / 1e3} s left when its turn came: not shown`);
    }
    return void 0;
  };
  const pump = () => {
    if (closed || open) return;
    const next = nextShowable();
    if (!next) return;
    const timeoutMs = next.deadline - Date.now();
    open = next;
    next.sent = true;
    next.slotTimer = setTimeout(() => {
      if (open !== next) return;
      io3.log(`[local-agent] prompt ${next.id} had no answer ${PROMPT_SLOT_GRACE_MS / 1e3} s after its timeout: the next prompt may be shown`);
      open = null;
      pump();
    }, timeoutMs + PROMPT_SLOT_GRACE_MS);
    next.slotTimer.unref?.();
    io3.write({ type: "prompt", id: next.id, kind: next.kind, detail: { ...next.detail, timeoutMs } });
  };
  return {
    ask(kind, detail, o3) {
      if (closed) return Promise.resolve(no3("unavailable"));
      const checked = normalizePrompt(kind, detail);
      if ("error" in checked) {
        io3.log(`[local-agent] prompt not shown: ${checked.error}`);
        return Promise.resolve(no3("invalid"));
      }
      const timeoutMs = clampTimeout(o3?.timeoutMs);
      return new Promise((resolve) => {
        const p3 = { id: `${prefix}-${++seq}`, kind, detail: checked.detail, settle: resolve, deadline: Date.now() + timeoutMs, sent: false, timedOut: false };
        p3.timer = setTimeout(() => {
          p3.timedOut = true;
          const queued = queue.indexOf(p3);
          if (queued >= 0) queue.splice(queued, 1);
          resolve(no3("timeout"));
        }, timeoutMs);
        p3.timer.unref?.();
        queue.push(p3);
        pump();
      });
    },
    handleLine(line) {
      if (!line.includes("prompt_answer")) return false;
      const answer = parsePromptAnswer(line);
      if (!answer) {
        let type;
        try {
          type = JSON.parse(line)?.type;
        } catch {
          return false;
        }
        if (type !== "prompt_answer") return false;
        io3.log("[local-agent] a malformed prompt_answer was ignored");
        return true;
      }
      if (!open || open.id !== answer.id) {
        io3.log(`[local-agent] prompt_answer for ${answer.id}, which is not open, was ignored`);
        return true;
      }
      const p3 = open;
      open = null;
      clearTimeout(p3.timer);
      clearTimeout(p3.slotTimer);
      if (!p3.timedOut) p3.settle(answer.allow ? yes : no3("denied"));
      else io3.log(`[local-agent] prompt_answer for ${p3.id} (allow: ${answer.allow}) came after its timeout and was dropped`);
      pump();
      return true;
    },
    close() {
      closed = true;
      for (const p3 of [...queue, ...open ? [open] : []]) {
        clearTimeout(p3.timer);
        clearTimeout(p3.slotTimer);
        if (!p3.timedOut) p3.settle(no3("unavailable"));
      }
      queue.length = 0;
      open = null;
    }
  };
}
function attachPromptBridge(opts) {
  const broker = createPromptBroker(opts);
  const channel = opts.channel;
  if (channel) {
    const send = (msg) => {
      if (!channel.destroyed && channel.writable) channel.write(jsonLine(msg));
    };
    const onLine = (line) => {
      let m3 = null;
      try {
        const v3 = JSON.parse(line);
        m3 = v3 && typeof v3 === "object" ? v3 : null;
      } catch {
      }
      if (!m3 || m3.type !== "ask" || !Number.isSafeInteger(m3.ref)) {
        opts.log("[local-agent] an unreadable line on the prompt channel was ignored");
        return;
      }
      const ref = m3.ref;
      void broker.ask(m3.kind, m3.detail, { timeoutMs: m3.timeoutMs }).then((outcome) => send({ type: "answer", ref, outcome: outcome.reason }));
    };
    const split = lineSplitter(onLine);
    channel.on("data", (chunk) => split(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
    channel.on("error", () => {
    });
  }
  return broker;
}

// agents/local-agent/launcher/launcher.ts
var INPUT_LIMIT = 2 * 1024;
var OUTPUT_LIMIT = 4 * 1024;
var MANAGER_TOOLS = /* @__PURE__ */ new Set(["finish"]);
var MODEL_TOKEN = /^[\x21-\x7e]{16,2048}$/;
var MODEL_TOKEN_FILE = ".model-token";
function createLineSplitter(onLine) {
  const decoder = new TextDecoder();
  let pending = new Uint8Array(0);
  const emit = (bytes) => {
    const line = decoder.decode(bytes);
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  return {
    push(chunk) {
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending);
      merged.set(chunk, pending.length);
      let start = 0;
      for (let nl2 = merged.indexOf(10); nl2 !== -1; nl2 = merged.indexOf(10, start)) {
        emit(merged.subarray(start, nl2));
        start = nl2 + 1;
      }
      pending = merged.slice(start);
    },
    end() {
      if (pending.length > 0) emit(pending);
      pending = new Uint8Array(0);
    }
  };
}
function serializeLine(msg) {
  return `${JSON.stringify(msg).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}
`;
}
function parseInbound(line) {
  let v3;
  try {
    v3 = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v3 || typeof v3 !== "object") return null;
  const m3 = v3;
  switch (m3.type) {
    case "start":
      return typeof m3.request === "string" && m3.request.trim() ? { type: "start", request: m3.request } : null;
    case "resume":
      return typeof m3.sessionId === "string" && m3.sessionId && Number.isInteger(m3.streamIndex) && m3.streamIndex >= 0 ? { type: "resume", sessionId: m3.sessionId, streamIndex: m3.streamIndex } : null;
    case "send":
      return typeof m3.text === "string" && m3.text.trim() && (m3.policy === "steer" || m3.policy === "queue") ? { type: "send", text: m3.text, policy: m3.policy } : null;
    case "stop":
      return { type: "stop" };
    case "token":
      return typeof m3.modelToken === "string" && MODEL_TOKEN.test(m3.modelToken) ? { type: "token", modelToken: m3.modelToken } : null;
    default:
      return null;
  }
}
function truncateJson(value, limit) {
  let s3;
  try {
    s3 = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? "null";
  } catch {
    s3 = '"[unserializable]"';
  }
  return s3.length <= limit ? s3 : `${s3.slice(0, limit - 1)}\u2026`;
}
function field(input, key) {
  const v3 = input && typeof input === "object" ? input[key] : void 0;
  return typeof v3 === "string" ? v3 : "";
}
function createNormalizer() {
  const managerCalls = /* @__PURE__ */ new Set();
  const toolNames = /* @__PURE__ */ new Map();
  let cancelled = false;
  return function normalize(ev) {
    switch (ev.type) {
      case "session.started":
        return [{ kind: "status", status: "starting" }];
      case "turn.started":
        cancelled = false;
        return [{ kind: "status", status: "running" }];
      case "message.appended":
        return ev.data.messageDelta ? [{ kind: "text", delta: ev.data.messageDelta }] : [];
      case "message.completed":
        return ev.data.message ? [{ kind: "message", text: ev.data.message }] : [];
      case "actions.requested": {
        const out = [];
        for (const action of ev.data.actions) {
          const name = "toolName" in action ? action.toolName : action.name;
          if (action.kind === "tool-call" && MANAGER_TOOLS.has(name)) {
            managerCalls.add(action.callId);
            out.push({ kind: "finish", summary: field(action.input, "summary") });
            continue;
          }
          toolNames.set(action.callId, name);
          out.push({ kind: "tool", callId: action.callId, name, input: truncateJson(action.input, INPUT_LIMIT) });
        }
        return out;
      }
      case "action.result": {
        const result = ev.data.result;
        if (managerCalls.has(result.callId)) return [];
        const ok = ev.data.status === "completed" && !result.isError && !ev.data.error;
        const output = ev.data.error && result.output === void 0 ? ev.data.error.message : result.output;
        const name = result.toolName ?? toolNames.get(result.callId) ?? "unknown";
        return [{ kind: "tool_result", callId: result.callId, name, ok, output: truncateJson(output ?? null, OUTPUT_LIMIT) }];
      }
      case "input.requested":
        return ev.data.requests.map((r2) => ({ kind: "ask", question: r2.prompt }));
      case "turn.waiting":
        return ev.data.on === "input" ? [{ kind: "status", status: "waiting" }] : [];
      case "turn.failed":
        return [{ kind: "error", message: ev.data.message }];
      case "turn.cancelled":
        cancelled = true;
        return [{ kind: "status", status: "cancelled" }];
      case "session.waiting":
        if (cancelled) return [];
        return [{ kind: "status", status: "waiting" }];
      case "session.completed":
        return [{ kind: "status", status: "completed" }];
      case "session.failed":
        return [
          { kind: "error", message: ev.data.message },
          { kind: "status", status: "failed" }
        ];
      default:
        return [];
    }
  };
}
function readGatewayKey(dotenv) {
  for (const raw of dotenv.split(/\r?\n/)) {
    const m3 = /^\s*(?:export\s+)?AI_GATEWAY_API_KEY\s*=\s*(.*)$/.exec(raw);
    if (!m3) continue;
    let v3 = m3[1].trim();
    if (v3.startsWith('"') && v3.endsWith('"') || v3.startsWith("'") && v3.endsWith("'")) v3 = v3.slice(1, -1);
    else v3 = v3.replace(/\s+#.*$/, "");
    return v3.length > 0 ? v3 : void 0;
  }
  return void 0;
}
function relayBaseUrl(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.href.replace(/\/+$/, "");
}
var LOCAL_MODEL_ID = /^[\x21-\x7e]{1,256}$/;
var LOCAL_MODEL_SERVERS = /* @__PURE__ */ new Set(["ollama", "lmstudio"]);
function localModelBaseUrl(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!loopback || url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.href.replace(/\/+$/, "");
}
function modelLaunchFromEnv(env) {
  const rawBase = env.LOCAL_AGENT_MODEL_BASE_URL;
  const token = env.LOCAL_AGENT_MODEL_TOKEN;
  const localBase = env.LOCAL_AGENT_LOCAL_MODEL_BASE_URL;
  const localId = env.LOCAL_AGENT_LOCAL_MODEL_ID;
  if (localBase || localId) {
    if (!localBase || !localId) throw new Error("LOCAL_AGENT_LOCAL_MODEL_BASE_URL and LOCAL_AGENT_LOCAL_MODEL_ID must be set together");
    if (rawBase) throw new Error("a local-model run never has LOCAL_AGENT_MODEL_BASE_URL");
    if (env.LOCAL_AGENT_DEV_ENV_FILE) throw new Error("a local-model run never has LOCAL_AGENT_DEV_ENV_FILE");
    const baseURL2 = localModelBaseUrl(localBase);
    if (!baseURL2) throw new Error("LOCAL_AGENT_LOCAL_MODEL_BASE_URL is not a loopback URL");
    if (!LOCAL_MODEL_ID.test(localId)) throw new Error("LOCAL_AGENT_LOCAL_MODEL_ID is not a model id");
    const server = env.LOCAL_AGENT_LOCAL_MODEL_SERVER;
    if (server && !LOCAL_MODEL_SERVERS.has(server)) throw new Error("LOCAL_AGENT_LOCAL_MODEL_SERVER is not ollama or lmstudio");
    if (token && !MODEL_TOKEN.test(token)) throw new Error("LOCAL_AGENT_MODEL_TOKEN is not a model token");
    return { kind: "local", local: { baseURL: baseURL2, id: localId, ...server ? { server } : {} }, token: token || null };
  }
  if (!rawBase && !token) return { kind: "dev" };
  if (!rawBase || !token) throw new Error("LOCAL_AGENT_MODEL_BASE_URL and LOCAL_AGENT_MODEL_TOKEN must be set together");
  const baseURL = relayBaseUrl(rawBase);
  if (!baseURL) throw new Error("LOCAL_AGENT_MODEL_BASE_URL is not an https URL");
  if (!MODEL_TOKEN.test(token)) throw new Error("LOCAL_AGENT_MODEL_TOKEN is not a model token");
  return { kind: "relay", baseURL, token };
}
function writeModelToken(dir, token) {
  if (!MODEL_TOKEN.test(token)) throw new Error("not a model token");
  const file = join(dir, MODEL_TOKEN_FILE);
  const tmp = join(dir, `${MODEL_TOKEN_FILE}.${process.pid}.${randomBytes2(6).toString("hex")}`);
  try {
    writeFileSync(tmp, token, { mode: 384, flag: "wx" });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}
function apiOriginFromEnv(env) {
  const raw = env.LOCAL_AGENT_API_ORIGIN;
  if (!raw) return null;
  const checked = relayBaseUrl(raw);
  if (!checked || new URL(checked).pathname !== "/") throw new Error("LOCAL_AGENT_API_ORIGIN is not an https origin");
  const origin = new URL(checked).origin;
  const relay = relayBaseUrl(env.LOCAL_AGENT_MODEL_BASE_URL);
  if (relay && new URL(relay).origin !== origin) throw new Error("LOCAL_AGENT_API_ORIGIN and LOCAL_AGENT_MODEL_BASE_URL name different origins");
  return origin;
}
function c1OriginRefusal(launch, apiOrigin) {
  if (launch.kind === "local" && launch.token && !apiOrigin) return "a local-model run with a session token needs LOCAL_AGENT_API_ORIGIN";
  return null;
}
var HOST_MARKER = "dial8-host.json";
function hostMarkerRefusal(marker, launch) {
  const m3 = marker && typeof marker === "object" ? marker : null;
  if (!m3 || m3.host !== "mac") return "the agent build is not the Mac body (scripts/local-agent/build.sh or bundle.sh builds it)";
  if (launch.kind === "local" && m3.localModel !== true) return "this agent build cannot run a model on this Mac";
  return null;
}
function isWithinPath(child, parent) {
  return child === parent || child.startsWith(`${parent}/`);
}
function grantEnvRefusal(env, jobDir) {
  const mode = env.LOCAL_AGENT_MODE;
  if (mode !== "read" && mode !== "edit") return `unsupported mode: ${mode}`;
  const extra = env.LOCAL_AGENT_EXTRA_READ;
  if (extra) {
    if (mode !== "edit") return "LOCAL_AGENT_EXTRA_READ is only allowed in edit mode";
    if (!extra.startsWith("/") || basename(extra) !== ".git") return "LOCAL_AGENT_EXTRA_READ must be a directory named .git";
    let isDir = false;
    try {
      isDir = statSync(extra).isDirectory();
    } catch {
    }
    if (!isDir) return "LOCAL_AGENT_EXTRA_READ must be a directory named .git";
  } else if (mode === "edit") {
    return "edit mode needs LOCAL_AGENT_EXTRA_READ (the repository git directory)";
  }
  for (const root of [env.LOCAL_AGENT_FOLDER, extra]) {
    if (root && (isWithinPath(jobDir, root) || isWithinPath(root, jobDir))) return "the job dir cannot overlap the folder or the repository git directory";
  }
  return null;
}
function deliveryIdOf(response) {
  const sym = Object.getOwnPropertySymbols(response).find((s3) => s3.description === "acceptedDeliveryId");
  const v3 = sym ? response[sym] : void 0;
  return typeof v3 === "string" ? v3 : void 0;
}
var JobDriver = class {
  session = null;
  client;
  io;
  normalize = createNormalizer();
  seen = /* @__PURE__ */ new Set();
  pending = /* @__PURE__ */ new Set();
  anonymousPending = 0;
  pump = null;
  streamAbort = new AbortController();
  turnOpen = false;
  stopping = false;
  lastStatus = null;
  constructor(client, io3) {
    this.client = client;
    this.io = io3;
  }
  emit(event) {
    if (event.kind === "status") this.lastStatus = event.status;
    this.io.write({ type: "event", event });
  }
  cursor() {
    if (this.session) this.io.write({ type: "cursor", streamIndex: this.session.state.streamIndex });
  }
  expect(response) {
    const id2 = deliveryIdOf(response);
    if (id2) this.pending.add(id2);
    else this.anonymousPending += 1;
  }
  get awaiting() {
    return this.pending.size > 0 || this.anonymousPending > 0;
  }
  /** Feed one stream event; true at a boundary the pump may stop at. */
  ingest(ev) {
    const id2 = ev.meta?.id;
    if (id2) {
      if (this.seen.has(id2)) return false;
      this.seen.add(id2);
    }
    const ids = ev.meta?.deliveryIds ?? [];
    for (const d3 of ids) this.pending.delete(d3);
    if (ev.type === "message.received" && this.anonymousPending > 0 && !ids.some((d3) => this.pending.has(d3))) {
      this.anonymousPending = Math.max(0, this.anonymousPending - Math.max(1, ids.length));
    }
    if (ev.type === "turn.started") this.turnOpen = true;
    const boundary = isCurrentTurnBoundaryEvent(ev);
    if (boundary) {
      this.turnOpen = false;
      this.cursor();
    }
    for (const n3 of this.normalize(ev)) this.emit(n3);
    if (ev.type === "session.completed") this.io.terminal?.("completed", "the session completed");
    else if (ev.type === "session.failed") this.io.terminal?.("failed", ev.data.message);
    return boundary && (!this.awaiting || ev.type !== "session.waiting");
  }
  ensurePump() {
    if (this.pump || !this.session || this.stopping) return;
    this.pump = this.runPump().finally(() => {
      this.pump = null;
      if (!this.stopping && this.awaiting) this.ensurePump();
    });
  }
  async runPump() {
    const session = this.session;
    const signal = this.streamAbort.signal;
    let idleRestarts = 0;
    for (; ; ) {
      let progressed = false;
      try {
        for await (const ev of session.stream({ signal })) {
          progressed = true;
          if (this.ingest(ev)) return;
        }
      } catch (err) {
        if (signal.aborted) return;
        this.io.log(`[local-agent] stream error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (signal.aborted) return;
      idleRestarts = progressed ? 0 : idleRestarts + 1;
      if (idleRestarts > 20) {
        this.io.log("[local-agent] the stream made no progress; reading again on the next message");
        this.pending.clear();
        this.anonymousPending = 0;
        return;
      }
      await new Promise((r2) => setTimeout(r2, 250));
    }
  }
  async start(request) {
    if (this.session) return this.emit({ kind: "error", message: "this job already has a session" });
    this.emit({ kind: "status", status: "starting" });
    const { session, response } = await this.client.sessions.create({ message: request });
    this.session = session;
    this.expect(response);
    this.io.write({ type: "session", sessionId: session.state.sessionId, streamIndex: session.state.streamIndex });
    this.ensurePump();
  }
  /**
   * Re-attach after a relaunch. The saved cursor sits right after a boundary,
   * so a bounded catch-up read shows whether a turn ran on past it (the one in
   * flight when the app quit, which eve's durable workflow carries on): then
   * keep following it. Otherwise the session is idle, waiting for a message.
   */
  async resume(sessionId, streamIndex) {
    if (this.session) return this.emit({ kind: "error", message: "this job already has a session" });
    const session = this.client.sessions.attach(sessionId, { streamIndex });
    this.session = session;
    this.io.write({ type: "session", sessionId, streamIndex });
    let idle = true;
    for await (const ev of session.stream({ follow: false, signal: this.streamAbort.signal })) {
      this.ingest(ev);
      idle = isCurrentTurnBoundaryEvent(ev);
    }
    if (idle) {
      this.emit({ kind: "status", status: "waiting" });
    } else {
      this.emit({ kind: "status", status: "running" });
      this.turnOpen = true;
      this.ensurePump();
    }
  }
  async send(text, policy) {
    if (!this.session) return this.emit({ kind: "error", message: "no session yet: send start or resume first" });
    let response;
    try {
      response = await this.session.send(text, { turnPolicy: policy });
    } catch (err) {
      return this.emit({ kind: "error", message: `message not delivered: ${err instanceof Error ? err.message : String(err)}` });
    }
    this.expect(response);
    this.ensurePump();
  }
  /** Cancel the running turn, wait (bounded) for its boundary, and stop reading. */
  async stop(budgetMs) {
    this.stopping = true;
    const deadline = Date.now() + budgetMs;
    const running = this.turnOpen || this.pump !== null;
    if (this.session) {
      try {
        const res = await withTimeout(this.session.cancel(), Math.max(200, deadline - Date.now()));
        if (res && res.status === "accepted" && running) await this.drainUntilBoundary(deadline);
      } catch (err) {
        this.io.log(`[local-agent] cancel failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.streamAbort.abort();
    if (this.lastStatus !== "cancelled") this.emit({ kind: "status", status: "cancelled" });
  }
  /** Take over from the pump and read until the cancelled turn's boundary or the deadline. */
  async drainUntilBoundary(deadline) {
    this.streamAbort.abort();
    await this.pump?.catch(() => {
    });
    const local = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    try {
      for await (const ev of this.session.stream({ signal: local })) {
        this.ingest(ev);
        if (isCurrentTurnBoundaryEvent(ev)) break;
      }
    } catch {
    }
  }
};
function withTimeout(p3, ms3) {
  return Promise.race([p3, new Promise((r2) => setTimeout(() => r2(null), ms3).unref())]);
}
var SERVER_GUARD = new URL("./server-guard.ts", import.meta.url).href;
function probeStatus(port, headers, path = "/eve/v1/health") {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers, timeout: 2e3 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error("probe timed out")));
    req.on("error", reject);
    req.end();
  });
}
async function assertGuardLive(port) {
  const host = `127.0.0.1:${port}`;
  const checks = await Promise.all([
    probeStatus(port, { host, origin: "http://example.test" }),
    probeStatus(port, { host: `localhost:${port}` }),
    probeStatus(port, { host }, "/.well-known/workflow/v1/flow")
  ]);
  if (checks.some((s3) => s3 !== 403)) throw new Error(`the server's request guard is not active (${checks.join(", ")})`);
  const anonymous = await probeStatus(port, { host }, "/eve/v1/session/probe-without-secret/stream");
  if (anonymous !== 401) throw new Error(`the server admits a session request without the secret (${anonymous})`);
}
var REQUIRED_ENV = ["LOCAL_AGENT_JOB_ID", "LOCAL_AGENT_FOLDER", "LOCAL_AGENT_MODE", "LOCAL_AGENT_TOOL_PATH", "LOCAL_AGENT_DIR"];
var OPTIONAL_ENV = ["LOCAL_AGENT_EXTRA_READ"];
var AGENT_HOST_ENV = "NI_AGENT_HOST";
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => addr && typeof addr === "object" ? resolve(addr.port) : reject(new Error("no port")));
    });
  });
}
async function waitForHealth(port, child, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`eve server exited during startup (${child.exitCode ?? child.signalCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/eve/v1/health`, { redirect: "error", signal: AbortSignal.timeout(1e3) });
      if (res.ok) return;
    } catch {
    }
    await new Promise((r2) => setTimeout(r2, 50));
  }
  throw new Error("eve server did not become healthy in time");
}
var O_EXLOCK = 32;
function acquireJobLock(dir) {
  const exlock = process.platform === "darwin" ? O_EXLOCK : 0;
  try {
    return openSync(join(dir, ".launcher.lock"), fsConstants.O_RDWR | fsConstants.O_CREAT | exlock | fsConstants.O_NONBLOCK, 384);
  } catch (err) {
    const code = err.code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") return null;
    throw err;
  }
}
function descendants(rows, rootPid, ownPgid) {
  const kids = /* @__PURE__ */ new Map();
  for (const r2 of rows) kids.set(r2.ppid, [...kids.get(r2.ppid) ?? [], r2.pid]);
  const byPid = new Map(rows.map((r2) => [r2.pid, r2]));
  const pids = [];
  const queue = [...kids.get(rootPid) ?? []];
  while (queue.length) {
    const pid = queue.shift();
    if (pids.includes(pid)) continue;
    pids.push(pid);
    queue.push(...kids.get(pid) ?? []);
  }
  const groups = [...new Set(pids.map((p3) => byPid.get(p3).pgid))].filter((g3) => g3 !== ownPgid && g3 > 1);
  return { pids, groups };
}
function kill(target, signal) {
  try {
    process.kill(target, signal);
  } catch {
  }
}
function killJobProcesses(serverPid) {
  if (serverPid !== void 0) {
    try {
      const rows = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 1e3 }).trim().split("\n").map((l3) => l3.trim().split(/\s+/).map(Number)).filter((r2) => r2.length === 3 && r2.every(Number.isInteger)).map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
      const own = rows.find((r2) => r2.pid === process.pid)?.pgid ?? -1;
      const { pids, groups } = descendants(rows, serverPid, own);
      for (const g3 of groups) kill(-g3, "SIGKILL");
      for (const p3 of pids) kill(p3, "SIGKILL");
    } catch {
    }
  }
}
function pipeLines(stream, prefix, log) {
  if (!stream) return;
  createInterface({ input: stream }).on("line", (l3) => log(`${prefix}${l3}`));
}
async function main() {
  const write = (msg) => process.stdout.write(serializeLine(msg));
  const log = (line) => process.stderr.write(`${line}
`);
  let server = null;
  let exiting = false;
  let tokenFile = null;
  let prompts = null;
  try {
    if (acquireJobLock(process.cwd()) === null) {
      write({ type: "fatal", message: "job already running" });
      process.exit(1);
    }
  } catch (err) {
    write({ type: "fatal", message: `could not lock the job dir: ${err instanceof Error ? err.message : String(err)}` });
    process.exit(1);
  }
  const killServer = async (graceMs) => {
    const child = server;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r2) => child.once("exit", () => r2()));
    child.kill("SIGTERM");
    if (await withTimeout(exited.then(() => true), graceMs) === null) child.kill("SIGKILL");
  };
  const teardown = async (graceMs, code) => {
    prompts?.close();
    killJobProcesses(server?.pid);
    await killServer(graceMs);
    if (tokenFile) rmSync(tokenFile, { force: true });
    process.exit(code);
  };
  const fatal = async (message) => {
    exiting = true;
    write({ type: "fatal", message });
    return teardown(600, 1);
  };
  const env = process.env;
  const missing = REQUIRED_ENV.filter((k4) => !env[k4]);
  if (missing.length) return fatal(`missing environment: ${missing.join(", ")}`);
  const grantRefused = grantEnvRefusal(env, realpathSync(process.cwd()));
  if (grantRefused) return fatal(grantRefused);
  const agentDir = env.LOCAL_AGENT_DIR;
  const entry2 = join(agentDir, ".output", "server", "index.mjs");
  if (!existsSync(entry2)) return fatal(`the local agent is not built (${entry2} missing): run scripts/local-agent/build.sh`);
  let eveVersion = "unknown";
  try {
    eveVersion = String(JSON.parse(readFileSync(join(agentDir, ".output", "eve-cache.json"), "utf8")).eveVersion ?? "unknown");
  } catch {
  }
  let launch;
  let apiOrigin;
  try {
    launch = modelLaunchFromEnv(env);
    apiOrigin = apiOriginFromEnv(env);
  } catch (err) {
    return fatal(err instanceof Error ? err.message : String(err));
  }
  const originRefused = c1OriginRefusal(launch, apiOrigin);
  if (originRefused) return fatal(originRefused);
  let marker = null;
  try {
    marker = JSON.parse(readFileSync(join(agentDir, ".output", HOST_MARKER), "utf8"));
  } catch {
  }
  const hostRefused = hostMarkerRefusal(marker, launch);
  if (hostRefused) return fatal(hostRefused);
  const modelEnv = {};
  const sessionToken = launch.kind === "relay" ? launch.token : launch.kind === "local" ? launch.token : null;
  if (sessionToken) {
    try {
      tokenFile = writeModelToken(process.cwd(), sessionToken);
    } catch {
      return fatal("could not write the model token file in the job dir");
    }
    modelEnv.LOCAL_AGENT_SESSION_TOKEN_FILE = tokenFile;
  }
  if (apiOrigin) modelEnv.LOCAL_AGENT_API_ORIGIN = apiOrigin;
  if (launch.kind === "relay") {
    modelEnv.LOCAL_AGENT_MODEL_BASE_URL = launch.baseURL;
    modelEnv.LOCAL_AGENT_MODEL_TOKEN_FILE = tokenFile;
    log(`[local-agent] model: the Native Intelligence relay at ${launch.baseURL}`);
  } else if (launch.kind === "local") {
    modelEnv.LOCAL_AGENT_LOCAL_MODEL_BASE_URL = launch.local.baseURL;
    modelEnv.LOCAL_AGENT_LOCAL_MODEL_ID = launch.local.id;
    if (launch.local.server) modelEnv.LOCAL_AGENT_LOCAL_MODEL_SERVER = launch.local.server;
    log(`[local-agent] model: ${launch.local.id} on this Mac (${launch.local.server ?? "local server"})${launch.token ? "" : ", no session token: no Native Intelligence tools"}`);
  } else {
    let gatewayKey;
    if (env.LOCAL_AGENT_DEV_ENV_FILE) {
      try {
        gatewayKey = readGatewayKey(readFileSync(env.LOCAL_AGENT_DEV_ENV_FILE, "utf8"));
      } catch {
        return fatal("LOCAL_AGENT_DEV_ENV_FILE could not be read");
      }
    }
    if (!gatewayKey) return fatal("no model key: AI_GATEWAY_API_KEY was not found in LOCAL_AGENT_DEV_ENV_FILE");
    modelEnv.AI_GATEWAY_API_KEY = gatewayKey;
    log("[local-agent] model: the AI Gateway with the dev key");
  }
  const secret = randomBytes2(32).toString("base64url");
  let port = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    port = await freePort();
    const serverEnv = {
      HOME: env.HOME ?? "",
      TMPDIR: env.TMPDIR ?? "",
      LANG: env.LANG ?? "en_US.UTF-8",
      PATH: env.PATH ?? "/usr/bin:/bin",
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      NITRO_HOST: "127.0.0.1",
      PORT: String(port),
      NITRO_PORT: String(port),
      WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${port}`,
      LOCAL_AGENT_SECRET: secret,
      LOCAL_AGENT_SERVER_GUARD: "1",
      LOCAL_AGENT_WORKFLOW_SECRET: randomBytes2(32).toString("base64url"),
      [AGENT_HOST_ENV]: "mac",
      // The server's end of the prompt channel (C3): its fd 3, a socketpair.
      [PROMPT_FD_ENV]: "3",
      ...modelEnv
    };
    for (const k4 of REQUIRED_ENV) serverEnv[k4] = env[k4];
    for (const k4 of OPTIONAL_ENV) if (env[k4]) serverEnv[k4] = env[k4];
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", SERVER_GUARD, entry2], { cwd: process.cwd(), env: serverEnv, stdio: PROMPT_STDIO });
    server = child;
    pipeLines(child.stdout, "[eve] ", log);
    pipeLines(child.stderr, "[eve] ", log);
    try {
      await waitForHealth(port, child, 6e4);
      await assertGuardLive(port);
      log(`[local-agent] eve server ready on 127.0.0.1:${port} in ${Date.now() - started} ms (pid ${child.pid})`);
      break;
    } catch (err) {
      await killServer(500);
      if (attempt === 2) return fatal(err instanceof Error ? err.message : String(err));
      log(`[local-agent] retrying startup: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  server.once("exit", (code, sig) => {
    if (!exiting) void fatal(`eve server exited (${code ?? sig})`);
  });
  prompts = attachPromptBridge({ channel: server.stdio[3], write, log });
  write({ type: "ready", port, eveVersion });
  const client = new Client({ host: `http://127.0.0.1:${port}`, auth: { bearer: secret }, redirect: "error" });
  const driver = new JobDriver(client, {
    write,
    log,
    // session.completed / session.failed: report it and exit, so no live launcher holds a slot.
    terminal: (status, message) => {
      if (exiting) return;
      exiting = true;
      if (status === "failed") write({ type: "fatal", message: `the eve session failed: ${message}` });
      void teardown(600, status === "completed" ? 0 : 1);
    }
  });
  const shutdown = async (stopMs, graceMs) => {
    if (exiting) return;
    exiting = true;
    await driver.stop(stopMs);
    await teardown(graceMs, 0);
  };
  const refreshToken = (modelToken) => {
    if (!tokenFile) {
      log("[local-agent] model token ignored: this job was launched without one");
      return;
    }
    try {
      writeModelToken(process.cwd(), modelToken);
      log("[local-agent] model token refreshed");
    } catch {
      write({ type: "event", event: { kind: "error", message: "the model token could not be updated" } });
    }
  };
  let chain = Promise.resolve();
  const onLine = (line) => {
    if (!line.trim()) return;
    if (prompts?.handleLine(line)) return;
    const msg = parseInbound(line);
    if (!msg) {
      write({ type: "event", event: { kind: "error", message: "unreadable message on stdin" } });
      return;
    }
    if (msg.type === "token") {
      if (!exiting) refreshToken(msg.modelToken);
      return;
    }
    chain = chain.then(async () => {
      if (exiting) return;
      if (msg.type === "start") await driver.start(msg.request);
      else if (msg.type === "resume") await driver.resume(msg.sessionId, msg.streamIndex);
      else if (msg.type === "send") await driver.send(msg.text, msg.policy);
      else await shutdown(2300, 1e3);
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!driver.session) return fatal(`could not ${msg.type}: ${message}`);
      write({ type: "event", event: { kind: "error", message } });
    });
  };
  const splitter = createLineSplitter(onLine);
  process.stdin.on("data", (chunk) => splitter.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
  process.stdin.on("end", () => {
    splitter.end();
    void shutdown(1e3, 600);
  });
  process.on("SIGTERM", () => void shutdown(1e3, 600));
  process.on("SIGINT", () => void shutdown(1e3, 600));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stdout.write(`${JSON.stringify({ type: "fatal", message: err instanceof Error ? err.message : String(err) })}
`);
    process.exit(1);
  });
}
export {
  HOST_MARKER,
  INPUT_LIMIT,
  JobDriver,
  MODEL_TOKEN,
  MODEL_TOKEN_FILE,
  OUTPUT_LIMIT,
  acquireJobLock,
  apiOriginFromEnv,
  assertGuardLive,
  c1OriginRefusal,
  createLineSplitter,
  createNormalizer,
  deliveryIdOf,
  descendants,
  grantEnvRefusal,
  hostMarkerRefusal,
  killJobProcesses,
  localModelBaseUrl,
  modelLaunchFromEnv,
  parseInbound,
  probeStatus,
  readGatewayKey,
  relayBaseUrl,
  serializeLine,
  truncateJson,
  writeModelToken
};
