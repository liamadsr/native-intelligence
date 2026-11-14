import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
import { createStorage, prefixStorage } from "../_libs/unstorage.mjs";
//#region #nitro/virtual/server-assets
const _assets = { ["eve-skill-index:skills.json"]: {
	import: () => import("../_virtual/skills.json.mjs").then((r) => r.default || r),
	meta: {
		"type": "application/json",
		"etag": "\"19-rMkh6NjlVvfDxnRkVcdY8U+y7sM\"",
		"mtime": "2026-11-14T21:02:00.887Z"
	}
} };
const normalizeKey = function normalizeKey(key) {
	if (!key) return "";
	return key.split("?")[0]?.replace(/[/\\]/g, ":").replace(/:+/g, ":").replace(/^:|:$/g, "") || "";
};
const assets = {
	getKeys() {
		return Promise.resolve(Object.keys(_assets));
	},
	hasItem(id) {
		id = normalizeKey(id);
		return Promise.resolve(id in _assets);
	},
	getItem(id) {
		id = normalizeKey(id);
		return Promise.resolve(_assets[id] ? _assets[id].import() : null);
	},
	getMeta(id) {
		id = normalizeKey(id);
		return Promise.resolve(_assets[id] ? _assets[id].meta : {});
	}
};
//#endregion
//#region #nitro/virtual/storage
function initStorage() {
	const storage = createStorage({});
	storage.mount("/assets", assets);
	return storage;
}
//#endregion
//#region node_modules/nitro/dist/runtime/internal/storage.mjs
function useStorage(base = "") {
	const storage = useStorage._storage ??= initStorage();
	return base ? prefixStorage(storage, base) : storage;
}
//#endregion
export { useStorage };
