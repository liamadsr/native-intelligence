import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
import { __commonJSMin, __require, __toESM } from "../../_runtime.mjs";
//#region node_modules/@vercel/oidc/dist/token-error.js
var require_token_error = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var token_error_exports = {};
	__export(token_error_exports, { VercelOidcTokenError: () => VercelOidcTokenError });
	module.exports = __toCommonJS(token_error_exports);
	var VercelOidcTokenError = class extends Error {
		constructor(message, cause) {
			super(message);
			this.name = "VercelOidcTokenError";
			this.cause = cause;
		}
		toString() {
			if (this.cause) return `${this.name}: ${this.message}: ${this.cause}`;
			return `${this.name}: ${this.message}`;
		}
	};
	0 && (module.exports = { VercelOidcTokenError });
}));
//#endregion
//#region node_modules/@vercel/oidc/dist/token-io.js
var require_token_io = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __create = Object.create;
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __getProtoOf = Object.getPrototypeOf;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
		value: mod,
		enumerable: true
	}) : target, mod));
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var token_io_exports = {};
	__export(token_io_exports, {
		findRootDir: () => findRootDir,
		getUserDataDir: () => getUserDataDir
	});
	module.exports = __toCommonJS(token_io_exports);
	var import_path = __toESM(__require("path"));
	var import_fs = __toESM(__require("fs"));
	var import_os$1 = __toESM(__require("os"));
	var import_token_error = require_token_error();
	function findRootDir() {
		try {
			let dir = process.cwd();
			while (dir !== import_path.default.dirname(dir)) {
				const pkgPath = import_path.default.join(dir, ".vercel");
				if (import_fs.default.existsSync(pkgPath)) return dir;
				dir = import_path.default.dirname(dir);
			}
		} catch (e) {
			throw new import_token_error.VercelOidcTokenError("Token refresh only supported in node server environments");
		}
		return null;
	}
	function getUserDataDir() {
		if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME;
		switch (import_os$1.default.platform()) {
			case "darwin": return import_path.default.join(import_os$1.default.homedir(), "Library/Application Support");
			case "linux": return import_path.default.join(import_os$1.default.homedir(), ".local/share");
			case "win32":
				if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
				return null;
			default: return null;
		}
	}
	0 && (module.exports = {
		findRootDir,
		getUserDataDir
	});
}));
//#endregion
//#region node_modules/@vercel/oidc/dist/auth-config.js
var require_auth_config = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __create = Object.create;
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __getProtoOf = Object.getPrototypeOf;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
		value: mod,
		enumerable: true
	}) : target, mod));
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var auth_config_exports = {};
	__export(auth_config_exports, {
		isValidAccessToken: () => isValidAccessToken,
		readAuthConfig: () => readAuthConfig,
		writeAuthConfig: () => writeAuthConfig
	});
	module.exports = __toCommonJS(auth_config_exports);
	var fs$1 = __toESM(__require("fs"));
	var path$1 = __toESM(__require("path"));
	var import_token_util = require_token_util();
	function getAuthConfigPath() {
		const dataDir = (0, import_token_util.getVercelDataDir)();
		if (!dataDir) throw new Error(`Unable to find Vercel CLI data directory. Your platform: ${process.platform}. Supported: darwin, linux, win32.`);
		return path$1.join(dataDir, "auth.json");
	}
	function readAuthConfig() {
		try {
			const authPath = getAuthConfigPath();
			if (!fs$1.existsSync(authPath)) return null;
			const content = fs$1.readFileSync(authPath, "utf8");
			if (!content) return null;
			return JSON.parse(content);
		} catch (error) {
			return null;
		}
	}
	function writeAuthConfig(config) {
		const authPath = getAuthConfigPath();
		const authDir = path$1.dirname(authPath);
		if (!fs$1.existsSync(authDir)) fs$1.mkdirSync(authDir, {
			mode: 504,
			recursive: true
		});
		fs$1.writeFileSync(authPath, JSON.stringify(config, null, 2), { mode: 384 });
	}
	function isValidAccessToken(authConfig, expirationBufferMs = 0) {
		if (!authConfig.token) return false;
		if (typeof authConfig.expiresAt !== "number") return true;
		const nowInSeconds = Math.floor(Date.now() / 1e3);
		const bufferInSeconds = expirationBufferMs / 1e3;
		return authConfig.expiresAt >= nowInSeconds + bufferInSeconds;
	}
	0 && (module.exports = {
		isValidAccessToken,
		readAuthConfig,
		writeAuthConfig
	});
}));
//#endregion
//#region node_modules/@vercel/oidc/dist/oauth.js
var require_oauth = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var oauth_exports = {};
	__export(oauth_exports, {
		processTokenResponse: () => processTokenResponse,
		refreshTokenRequest: () => refreshTokenRequest
	});
	module.exports = __toCommonJS(oauth_exports);
	var import_os = __require("os");
	const VERCEL_ISSUER = "https://vercel.com";
	const VERCEL_CLI_CLIENT_ID = "cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp";
	const userAgent = `@vercel/oidc node-${process.version} ${(0, import_os.platform)()} (${(0, import_os.arch)()}) ${(0, import_os.hostname)()}`;
	let _tokenEndpoint = null;
	async function getTokenEndpoint() {
		if (_tokenEndpoint) return _tokenEndpoint;
		const response = await fetch(`${VERCEL_ISSUER}/.well-known/openid-configuration`, { headers: { "user-agent": userAgent } });
		if (!response.ok) throw new Error("Failed to discover OAuth endpoints");
		const metadata = await response.json();
		if (!metadata || typeof metadata.token_endpoint !== "string") throw new Error("Invalid OAuth discovery response");
		const endpoint = metadata.token_endpoint;
		_tokenEndpoint = endpoint;
		return endpoint;
	}
	async function refreshTokenRequest(options) {
		const tokenEndpoint = await getTokenEndpoint();
		return await fetch(tokenEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"user-agent": userAgent
			},
			body: new URLSearchParams({
				client_id: VERCEL_CLI_CLIENT_ID,
				grant_type: "refresh_token",
				...options
			})
		});
	}
	async function processTokenResponse(response) {
		const json = await response.json();
		if (!response.ok) {
			const errorMsg = typeof json === "object" && json && "error" in json ? String(json.error) : "Token refresh failed";
			return [new Error(errorMsg)];
		}
		if (typeof json !== "object" || json === null) return [/* @__PURE__ */ new Error("Invalid token response")];
		if (typeof json.access_token !== "string") return [/* @__PURE__ */ new Error("Missing access_token in response")];
		if (json.token_type !== "Bearer") return [/* @__PURE__ */ new Error("Invalid token_type in response")];
		if (typeof json.expires_in !== "number") return [/* @__PURE__ */ new Error("Missing expires_in in response")];
		return [null, json];
	}
	0 && (module.exports = {
		processTokenResponse,
		refreshTokenRequest
	});
}));
//#endregion
//#region node_modules/@vercel/oidc/dist/auth-errors.js
var require_auth_errors = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var auth_errors_exports = {};
	__export(auth_errors_exports, {
		AccessTokenMissingError: () => AccessTokenMissingError,
		RefreshAccessTokenFailedError: () => RefreshAccessTokenFailedError
	});
	module.exports = __toCommonJS(auth_errors_exports);
	var AccessTokenMissingError = class extends Error {
		constructor() {
			super("No authentication found. Please log in with the Vercel CLI (vercel login).");
			this.name = "AccessTokenMissingError";
		}
	};
	var RefreshAccessTokenFailedError = class extends Error {
		constructor(cause) {
			super("Failed to refresh authentication token.", { cause });
			this.name = "RefreshAccessTokenFailedError";
		}
	};
	0 && (module.exports = {
		AccessTokenMissingError,
		RefreshAccessTokenFailedError
	});
}));
//#endregion
//#region node_modules/@vercel/oidc/dist/token-util.js
var require_token_util = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __create = Object.create;
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __getProtoOf = Object.getPrototypeOf;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
		value: mod,
		enumerable: true
	}) : target, mod));
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var token_util_exports = {};
	__export(token_util_exports, {
		assertVercelOidcTokenResponse: () => assertVercelOidcTokenResponse,
		findProjectInfo: () => findProjectInfo,
		getTokenPayload: () => getTokenPayload,
		getVercelDataDir: () => getVercelDataDir,
		getVercelOidcToken: () => getVercelOidcToken,
		getVercelToken: () => getVercelToken,
		isExpired: () => isExpired,
		loadToken: () => loadToken,
		saveToken: () => saveToken
	});
	module.exports = __toCommonJS(token_util_exports);
	var path = __toESM(__require("path"));
	var fs = __toESM(__require("fs"));
	var import_token_error = require_token_error();
	var import_token_io = require_token_io();
	var import_auth_config = require_auth_config();
	var import_oauth = require_oauth();
	var import_auth_errors = require_auth_errors();
	function getVercelDataDir() {
		const vercelFolder = "com.vercel.cli";
		const dataDir = (0, import_token_io.getUserDataDir)();
		if (!dataDir) return null;
		return path.join(dataDir, vercelFolder);
	}
	async function getVercelToken(options) {
		const authConfig = (0, import_auth_config.readAuthConfig)();
		if (!authConfig?.token) throw new import_auth_errors.AccessTokenMissingError();
		if ((0, import_auth_config.isValidAccessToken)(authConfig, options?.expirationBufferMs)) return authConfig.token;
		if (!authConfig.refreshToken) {
			(0, import_auth_config.writeAuthConfig)({});
			throw new import_auth_errors.RefreshAccessTokenFailedError("No refresh token available");
		}
		try {
			const tokenResponse = await (0, import_oauth.refreshTokenRequest)({ refresh_token: authConfig.refreshToken });
			const [tokensError, tokens] = await (0, import_oauth.processTokenResponse)(tokenResponse);
			if (tokensError || !tokens) {
				(0, import_auth_config.writeAuthConfig)({});
				throw new import_auth_errors.RefreshAccessTokenFailedError(tokensError);
			}
			const updatedConfig = {
				token: tokens.access_token,
				expiresAt: Math.floor(Date.now() / 1e3) + tokens.expires_in
			};
			if (tokens.refresh_token) updatedConfig.refreshToken = tokens.refresh_token;
			(0, import_auth_config.writeAuthConfig)(updatedConfig);
			return updatedConfig.token;
		} catch (error) {
			(0, import_auth_config.writeAuthConfig)({});
			if (error instanceof import_auth_errors.AccessTokenMissingError || error instanceof import_auth_errors.RefreshAccessTokenFailedError) throw error;
			throw new import_auth_errors.RefreshAccessTokenFailedError(error);
		}
	}
	async function getVercelOidcToken(authToken, projectId, teamId) {
		const url = `https://api.vercel.com/v1/projects/${projectId}/token?source=vercel-oidc-refresh${teamId ? `&teamId=${teamId}` : ""}`;
		const res = await fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${authToken}` }
		});
		if (!res.ok) throw new import_token_error.VercelOidcTokenError(`Failed to refresh OIDC token: ${res.statusText}`);
		const tokenRes = await res.json();
		assertVercelOidcTokenResponse(tokenRes);
		return tokenRes;
	}
	function assertVercelOidcTokenResponse(res) {
		if (!res || typeof res !== "object") throw new TypeError("Vercel OIDC token is malformed. Expected an object. Please run `vc env pull` and try again");
		if (!("token" in res) || typeof res.token !== "string") throw new TypeError("Vercel OIDC token is malformed. Expected a string-valued token property. Please run `vc env pull` and try again");
	}
	function findProjectInfo() {
		const dir = (0, import_token_io.findRootDir)();
		if (!dir) throw new import_token_error.VercelOidcTokenError("Unable to find project root directory. Have you linked your project with `vc link?`");
		const prjPath = path.join(dir, ".vercel", "project.json");
		if (!fs.existsSync(prjPath)) throw new import_token_error.VercelOidcTokenError("project.json not found, have you linked your project with `vc link?`");
		const prj = JSON.parse(fs.readFileSync(prjPath, "utf8"));
		if (typeof prj.projectId !== "string" && typeof prj.orgId !== "string") throw new TypeError("Expected a string-valued projectId property. Try running `vc link` to re-link your project.");
		return {
			projectId: prj.projectId,
			teamId: prj.orgId
		};
	}
	function saveToken(token, projectId) {
		const dir = (0, import_token_io.getUserDataDir)();
		if (!dir) throw new import_token_error.VercelOidcTokenError("Unable to find user data directory. Please reach out to Vercel support.");
		const tokenPath = path.join(dir, "com.vercel.token", `${projectId}.json`);
		const tokenJson = JSON.stringify(token);
		fs.mkdirSync(path.dirname(tokenPath), {
			mode: 504,
			recursive: true
		});
		fs.writeFileSync(tokenPath, tokenJson);
		fs.chmodSync(tokenPath, 432);
	}
	function loadToken(projectId) {
		const dir = (0, import_token_io.getUserDataDir)();
		if (!dir) throw new import_token_error.VercelOidcTokenError("Unable to find user data directory. Please reach out to Vercel support.");
		const tokenPath = path.join(dir, "com.vercel.token", `${projectId}.json`);
		if (!fs.existsSync(tokenPath)) return null;
		const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
		assertVercelOidcTokenResponse(token);
		return token;
	}
	function getTokenPayload(token) {
		const tokenParts = token.split(".");
		if (tokenParts.length !== 3) throw new import_token_error.VercelOidcTokenError("Invalid token. Please run `vc env pull` and try again");
		const base64 = tokenParts[1].replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, "=");
		return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
	}
	function isExpired(token, bufferMs = 0) {
		return token.exp * 1e3 < Date.now() + bufferMs;
	}
	0 && (module.exports = {
		assertVercelOidcTokenResponse,
		findProjectInfo,
		getTokenPayload,
		getVercelDataDir,
		getVercelOidcToken,
		getVercelToken,
		isExpired,
		loadToken,
		saveToken
	});
}));
//#endregion
//#region node_modules/@ai-sdk/gateway/node_modules/@ai-sdk/provider/dist/index.js
/**
* Symbol used for identifying AI SDK Error instances.
* Enables checking if an error is an instance of AISDKError across package versions.
*/
const marker$16 = "vercel.ai.error";
const symbol$16 = Symbol.for(marker$16);
/**
* Custom error class for AI SDK related errors.
* @extends Error
*/
var AISDKError = class AISDKError extends Error {
	/**
	* Creates an AI SDK Error.
	*
	* @param {Object} params - The parameters for creating the error.
	* @param {string} params.name - The name of the error.
	* @param {string} params.message - The error message.
	* @param {unknown} [params.cause] - The underlying cause of the error.
	*/
	constructor({ name, message, cause }) {
		super(message);
		this[symbol$16] = true;
		this.name = name;
		this.cause = cause;
	}
	/**
	* Checks if the given error is an AI SDK Error.
	* @param {unknown} error - The error to check.
	* @returns {boolean} True if the error is an AI SDK Error, false otherwise.
	*/
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$16);
	}
	static hasMarker(error, marker) {
		const markerSymbol = Symbol.for(marker);
		return error != null && typeof error === "object" && markerSymbol in error && typeof error[markerSymbol] === "boolean" && error[markerSymbol] === true;
	}
};
const name$14 = "AI_APICallError";
const marker$14 = `vercel.ai.error.${name$14}`;
const symbol$14 = Symbol.for(marker$14);
var APICallError = class extends AISDKError {
	constructor({ message, url, requestBodyValues, statusCode, responseHeaders, responseBody, cause, isRetryable = statusCode != null && (statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500), data }) {
		super({
			name: name$14,
			message,
			cause
		});
		this[symbol$14] = true;
		this.url = url;
		this.requestBodyValues = requestBodyValues;
		this.statusCode = statusCode;
		this.responseHeaders = responseHeaders;
		this.responseBody = responseBody;
		this.isRetryable = isRetryable;
		this.data = data;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$14);
	}
};
const name$13 = "AI_EmptyResponseBodyError";
const marker$13 = `vercel.ai.error.${name$13}`;
const symbol$13 = Symbol.for(marker$13);
var EmptyResponseBodyError = class extends AISDKError {
	constructor({ message = "Empty response body" } = {}) {
		super({
			name: name$13,
			message
		});
		this[symbol$13] = true;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$13);
	}
};
function getErrorMessage(error) {
	if (error == null) return "unknown error";
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.toString();
	return JSON.stringify(error);
}
const name$11 = "AI_InvalidArgumentError";
const marker$11 = `vercel.ai.error.${name$11}`;
const symbol$11$1 = Symbol.for(marker$11);
/**
* A function argument is invalid.
*/
var InvalidArgumentError = class extends AISDKError {
	constructor({ message, cause, argument }) {
		super({
			name: name$11,
			message,
			cause
		});
		this[symbol$11$1] = true;
		this.argument = argument;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$11);
	}
};
const name$8$2 = "AI_JSONParseError";
const marker$8$2 = `vercel.ai.error.${name$8$2}`;
const symbol$8$2 = Symbol.for(marker$8$2);
var JSONParseError = class extends AISDKError {
	constructor({ text, cause }) {
		super({
			name: name$8$2,
			message: `JSON parsing failed: Text: ${text}.\nError message: ${getErrorMessage(cause)}`,
			cause
		});
		this[symbol$8$2] = true;
		this.text = text;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$8$2);
	}
};
const name$1$11 = "AI_TypeValidationError";
const marker$1$11 = `vercel.ai.error.${name$1$11}`;
const symbol$1$12 = Symbol.for(marker$1$11);
var TypeValidationError = class TypeValidationError extends AISDKError {
	constructor({ value, cause, context }) {
		let contextPrefix = "Type validation failed";
		if (context?.field) contextPrefix += ` for ${context.field}`;
		if (context?.entityName || context?.entityId) {
			contextPrefix += " (";
			const parts = [];
			if (context.entityName) parts.push(context.entityName);
			if (context.entityId) parts.push(`id: "${context.entityId}"`);
			contextPrefix += parts.join(", ");
			contextPrefix += ")";
		}
		super({
			name: name$1$11,
			message: `${contextPrefix}: Value: ${JSON.stringify(value)}.\nError message: ${getErrorMessage(cause)}`,
			cause
		});
		this[symbol$1$12] = true;
		this.value = value;
		this.context = context;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$1$11);
	}
	/**
	* Wraps an error into a TypeValidationError.
	* If the cause is already a TypeValidationError with the same value and context, it returns the cause.
	* Otherwise, it creates a new TypeValidationError.
	*
	* @param {Object} params - The parameters for wrapping the error.
	* @param {unknown} params.value - The value that failed validation.
	* @param {unknown} params.cause - The original error or cause of the validation failure.
	* @param {TypeValidationContext} params.context - Optional context about what is being validated.
	* @returns {TypeValidationError} A TypeValidationError instance.
	*/
	static wrap({ value, cause, context }) {
		if (TypeValidationError.isInstance(cause) && cause.value === value && cause.context?.field === context?.field && cause.context?.entityName === context?.entityName && cause.context?.entityId === context?.entityId) return cause;
		return new TypeValidationError({
			value,
			cause,
			context
		});
	}
};
const name$16 = "AI_UnsupportedFunctionalityError";
const marker$17 = `vercel.ai.error.${name$16}`;
const symbol$12 = Symbol.for(marker$17);
var UnsupportedFunctionalityError = class extends AISDKError {
	constructor({ functionality, message = `'${functionality}' functionality not supported.` }) {
		super({
			name: name$16,
			message
		});
		this[symbol$12] = true;
		this.functionality = functionality;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$17);
	}
};
Object.freeze({ status: "aborted" });
function $constructor(name, initializer, params) {
	function init(inst, def) {
		if (!inst._zod) Object.defineProperty(inst, "_zod", {
			value: {
				def,
				constr: _,
				traits: /* @__PURE__ */ new Set()
			},
			enumerable: false
		});
		if (inst._zod.traits.has(name)) return;
		inst._zod.traits.add(name);
		initializer(inst, def);
		const proto = _.prototype;
		const keys = Object.keys(proto);
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i];
			if (!(k in inst)) inst[k] = proto[k].bind(inst);
		}
	}
	const Parent = params?.Parent ?? Object;
	class Definition extends Parent {}
	Object.defineProperty(Definition, "name", { value: name });
	function _(def) {
		var _a;
		const inst = params?.Parent ? new Definition() : this;
		init(inst, def);
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		for (const fn of inst._zod.deferred) fn();
		return inst;
	}
	Object.defineProperty(_, "init", { value: init });
	Object.defineProperty(_, Symbol.hasInstance, { value: (inst) => {
		if (params?.Parent && inst instanceof params.Parent) return true;
		return inst?._zod?.traits?.has(name);
	} });
	Object.defineProperty(_, "name", { value: name });
	return _;
}
var $ZodAsyncError = class extends Error {
	constructor() {
		super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
	}
};
var $ZodEncodeError = class extends Error {
	constructor(name) {
		super(`Encountered unidirectional transform during encode: ${name}`);
		this.name = "ZodEncodeError";
	}
};
const globalConfig = {};
function config(newConfig) {
	if (newConfig) Object.assign(globalConfig, newConfig);
	return globalConfig;
}
//#endregion
//#region node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
	const numericValues = Object.values(entries).filter((v) => typeof v === "number");
	return Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
}
function jsonStringifyReplacer(_, value) {
	if (typeof value === "bigint") return value.toString();
	return value;
}
function cached(getter) {
	return { get value() {
		{
			const value = getter();
			Object.defineProperty(this, "value", { value });
			return value;
		}
	} };
}
function nullish(input) {
	return input === null || input === void 0;
}
function cleanRegex(source) {
	const start = source.startsWith("^") ? 1 : 0;
	const end = source.endsWith("$") ? source.length - 1 : source.length;
	return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
	const valDecCount = (val.toString().split(".")[1] || "").length;
	const stepString = step.toString();
	let stepDecCount = (stepString.split(".")[1] || "").length;
	if (stepDecCount === 0 && /\d?e-\d?/.test(stepString)) {
		const match = stepString.match(/\d?e-(\d?)/);
		if (match?.[1]) stepDecCount = Number.parseInt(match[1]);
	}
	const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
	return Number.parseInt(val.toFixed(decCount).replace(".", "")) % Number.parseInt(step.toFixed(decCount).replace(".", "")) / 10 ** decCount;
}
const EVALUATING = Symbol("evaluating");
function defineLazy(object, key, getter) {
	let value = void 0;
	Object.defineProperty(object, key, {
		get() {
			if (value === EVALUATING) return;
			if (value === void 0) {
				value = EVALUATING;
				value = getter();
			}
			return value;
		},
		set(v) {
			Object.defineProperty(object, key, { value: v });
		},
		configurable: true
	});
}
function assignProp(target, prop, value) {
	Object.defineProperty(target, prop, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
function mergeDefs(...defs) {
	const mergedDescriptors = {};
	for (const def of defs) {
		const descriptors = Object.getOwnPropertyDescriptors(def);
		Object.assign(mergedDescriptors, descriptors);
	}
	return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
	return JSON.stringify(str);
}
function slugify(input) {
	return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
const captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}
const allowsEval = cached(() => {
	if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
	try {
		new Function("");
		return true;
	} catch (_) {
		return false;
	}
});
function isPlainObject(o) {
	if (isObject(o) === false) return false;
	const ctor = o.constructor;
	if (ctor === void 0) return true;
	if (typeof ctor !== "function") return true;
	const prot = ctor.prototype;
	if (isObject(prot) === false) return false;
	if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
	return true;
}
function shallowClone(o) {
	if (isPlainObject(o)) return { ...o };
	if (Array.isArray(o)) return [...o];
	return o;
}
const propertyKeyTypes = /* @__PURE__ */ new Set([
	"string",
	"number",
	"symbol"
]);
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
	const cl = new inst._zod.constr(def ?? inst._zod.def);
	if (!def || params?.parent) cl._zod.parent = inst;
	return cl;
}
function normalizeParams(_params) {
	const params = _params;
	if (!params) return {};
	if (typeof params === "string") return { error: () => params };
	if (params?.message !== void 0) {
		if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
		params.error = params.message;
	}
	delete params.message;
	if (typeof params.error === "string") return {
		...params,
		error: () => params.error
	};
	return params;
}
function optionalKeys(shape) {
	return Object.keys(shape).filter((k) => {
		return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
	});
}
const NUMBER_FORMAT_RANGES = {
	safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int32: [-2147483648, 2147483647],
	uint32: [0, 4294967295],
	float32: [-34028234663852886e22, 34028234663852886e22],
	float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
function pick(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = {};
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				newShape[key] = currDef.shape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function omit(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = { ...schema._zod.def.shape };
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				delete newShape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function extend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to extend: expected a plain object");
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) {
		const existingShape = schema._zod.def.shape;
		for (const key in shape) if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
	}
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function safeExtend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to safeExtend: expected a plain object");
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function merge(a, b) {
	return clone(a, mergeDefs(a._zod.def, {
		get shape() {
			const _shape = {
				...a._zod.def.shape,
				...b._zod.def.shape
			};
			assignProp(this, "shape", _shape);
			return _shape;
		},
		get catchall() {
			return b._zod.def.catchall;
		},
		checks: []
	}));
}
function partial(Class, schema, mask) {
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) throw new Error(".partial() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const oldShape = schema._zod.def.shape;
			const shape = { ...oldShape };
			if (mask) for (const key in mask) {
				if (!(key in oldShape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				shape[key] = Class ? new Class({
					type: "optional",
					innerType: oldShape[key]
				}) : oldShape[key];
			}
			else for (const key in oldShape) shape[key] = Class ? new Class({
				type: "optional",
				innerType: oldShape[key]
			}) : oldShape[key];
			assignProp(this, "shape", shape);
			return shape;
		},
		checks: []
	}));
}
function required(Class, schema, mask) {
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const oldShape = schema._zod.def.shape;
		const shape = { ...oldShape };
		if (mask) for (const key in mask) {
			if (!(key in shape)) throw new Error(`Unrecognized key: "${key}"`);
			if (!mask[key]) continue;
			shape[key] = new Class({
				type: "nonoptional",
				innerType: oldShape[key]
			});
		}
		else for (const key in oldShape) shape[key] = new Class({
			type: "nonoptional",
			innerType: oldShape[key]
		});
		assignProp(this, "shape", shape);
		return shape;
	} }));
}
function aborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue !== true) return true;
	return false;
}
function prefixIssues(path, issues) {
	return issues.map((iss) => {
		var _a;
		(_a = iss).path ?? (_a.path = []);
		iss.path.unshift(path);
		return iss;
	});
}
function unwrapMessage(message) {
	return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config) {
	const full = {
		...iss,
		path: iss.path ?? []
	};
	if (!iss.message) full.message = unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
	delete full.inst;
	delete full.continue;
	if (!ctx?.reportInput) delete full.input;
	return full;
}
function getLengthableOrigin(input) {
	if (Array.isArray(input)) return "array";
	if (typeof input === "string") return "string";
	return "unknown";
}
function issue(...args) {
	const [iss, input, inst] = args;
	if (typeof iss === "string") return {
		message: iss,
		code: "custom",
		input,
		inst
	};
	return { ...iss };
}
//#endregion
//#region node_modules/zod/v4/core/errors.js
const initializer$1 = (inst, def) => {
	inst.name = "$ZodError";
	Object.defineProperty(inst, "_zod", {
		value: inst._zod,
		enumerable: false
	});
	Object.defineProperty(inst, "issues", {
		value: def,
		enumerable: false
	});
	inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
	Object.defineProperty(inst, "toString", {
		value: () => inst.message,
		enumerable: false
	});
};
const $ZodError = $constructor("$ZodError", initializer$1);
const $ZodRealError = $constructor("$ZodError", initializer$1, { Parent: Error });
function flattenError(error, mapper = (issue) => issue.message) {
	const fieldErrors = {};
	const formErrors = [];
	for (const sub of error.issues) if (sub.path.length > 0) {
		fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
		fieldErrors[sub.path[0]].push(mapper(sub));
	} else formErrors.push(mapper(sub));
	return {
		formErrors,
		fieldErrors
	};
}
function formatError(error, mapper = (issue) => issue.message) {
	const fieldErrors = { _errors: [] };
	const processError = (error) => {
		for (const issue of error.issues) if (issue.code === "invalid_union" && issue.errors.length) issue.errors.map((issues) => processError({ issues }));
		else if (issue.code === "invalid_key") processError({ issues: issue.issues });
		else if (issue.code === "invalid_element") processError({ issues: issue.issues });
		else if (issue.path.length === 0) fieldErrors._errors.push(mapper(issue));
		else {
			let curr = fieldErrors;
			let i = 0;
			while (i < issue.path.length) {
				const el = issue.path[i];
				if (!(i === issue.path.length - 1)) curr[el] = curr[el] || { _errors: [] };
				else {
					curr[el] = curr[el] || { _errors: [] };
					curr[el]._errors.push(mapper(issue));
				}
				curr = curr[el];
				i++;
			}
		}
	};
	processError(error);
	return fieldErrors;
}
//#endregion
//#region node_modules/zod/v4/core/parse.js
const _parse$1 = (_Err) => (schema, value, _ctx, _params) => {
	const ctx = _ctx ? Object.assign(_ctx, { async: false }) : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	if (result.issues.length) {
		const e = new ((_params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, _params?.callee);
		throw e;
	}
	return result.value;
};
const _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
	const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	if (result.issues.length) {
		const e = new ((params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, params?.callee);
		throw e;
	}
	return result.value;
};
const _safeParse = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length ? {
		success: false,
		error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
const safeParse$1 = /* @__PURE__*/ _safeParse($ZodRealError);
const _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length ? {
		success: false,
		error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
const safeParseAsync$1 = /* @__PURE__*/ _safeParseAsync($ZodRealError);
const _encode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
	return _parse$1(_Err)(schema, value, ctx);
};
const _decode = (_Err) => (schema, value, _ctx) => {
	return _parse$1(_Err)(schema, value, _ctx);
};
const _encodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
	return _parseAsync(_Err)(schema, value, ctx);
};
const _decodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _parseAsync(_Err)(schema, value, _ctx);
};
const _safeEncode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
	return _safeParse(_Err)(schema, value, ctx);
};
const _safeDecode = (_Err) => (schema, value, _ctx) => {
	return _safeParse(_Err)(schema, value, _ctx);
};
const _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
	return _safeParseAsync(_Err)(schema, value, ctx);
};
const _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _safeParseAsync(_Err)(schema, value, _ctx);
};
//#endregion
//#region node_modules/zod/v4/core/regexes.js
const cuid = /^[cC][^\s-]{8,}$/;
const cuid2 = /^[0-9a-z]+$/;
const ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
const xid = /^[0-9a-vA-V]{20}$/;
const ksuid = /^[A-Za-z0-9]{27}$/;
const nanoid = /^[a-zA-Z0-9_-]{21}$/;
/** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
const duration$1 = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
/** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
const guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Returns a regex for validating an RFC 9562/4122 UUID.
*
* @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
const uuid = (version) => {
	if (!version) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
	return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
/** Practical email validation */
const email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const _emoji$1 = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
	return new RegExp(_emoji$1, "u");
}
const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
const cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
const cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
const base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
const base64url = /^[A-Za-z0-9_-]*$/;
const e164 = /^\+[1-9]\d{6,14}$/;
const dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
const date$1 = /*@__PURE__*/ new RegExp(`^${dateSource}$`);
function timeSource(args) {
	const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
	return typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function time$1(args) {
	return new RegExp(`^${timeSource(args)}$`);
}
function datetime$1(args) {
	const time = timeSource({ precision: args.precision });
	const opts = ["Z"];
	if (args.local) opts.push("");
	if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
	const timeRegex = `${time}(?:${opts.join("|")})`;
	return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
const string$1 = (params) => {
	const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
	return new RegExp(`^${regex}$`);
};
const integer = /^-?\d+$/;
const number$1 = /^-?\d+(?:\.\d+)?$/;
const boolean$1 = /^(?:true|false)$/i;
const _null$2 = /^null$/i;
const lowercase = /^[^A-Z]*$/;
const uppercase = /^[^a-z]*$/;
//#endregion
//#region node_modules/zod/v4/core/checks.js
const $ZodCheck = /*@__PURE__*/ $constructor("$ZodCheck", (inst, def) => {
	var _a;
	inst._zod ?? (inst._zod = {});
	inst._zod.def = def;
	(_a = inst._zod).onattach ?? (_a.onattach = []);
});
const numericOriginMap = {
	number: "number",
	bigint: "bigint",
	object: "date"
};
const $ZodCheckLessThan = /*@__PURE__*/ $constructor("$ZodCheckLessThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
		if (def.value < curr) {
			if (def.inclusive) bag.maximum = def.value;
			else bag.exclusiveMaximum = def.value;
		}
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value <= def.value : payload.value < def.value) return;
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckGreaterThan = /*@__PURE__*/ $constructor("$ZodCheckGreaterThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
		if (def.value > curr) {
			if (def.inclusive) bag.minimum = def.value;
			else bag.exclusiveMinimum = def.value;
		}
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value >= def.value : payload.value > def.value) return;
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMultipleOf = /*@__PURE__*/ $constructor("$ZodCheckMultipleOf", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		var _a;
		(_a = inst._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
	});
	inst._zod.check = (payload) => {
		if (typeof payload.value !== typeof def.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
		if (typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0) return;
		payload.issues.push({
			origin: typeof payload.value,
			code: "not_multiple_of",
			divisor: def.value,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckNumberFormat = /*@__PURE__*/ $constructor("$ZodCheckNumberFormat", (inst, def) => {
	$ZodCheck.init(inst, def);
	def.format = def.format || "float64";
	const isInt = def.format?.includes("int");
	const origin = isInt ? "int" : "number";
	const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		bag.minimum = minimum;
		bag.maximum = maximum;
		if (isInt) bag.pattern = integer;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (isInt) {
			if (!Number.isInteger(input)) {
				payload.issues.push({
					expected: origin,
					format: def.format,
					code: "invalid_type",
					continue: false,
					input,
					inst
				});
				return;
			}
			if (!Number.isSafeInteger(input)) {
				if (input > 0) payload.issues.push({
					input,
					code: "too_big",
					maximum: Number.MAX_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				else payload.issues.push({
					input,
					code: "too_small",
					minimum: Number.MIN_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				return;
			}
		}
		if (input < minimum) payload.issues.push({
			origin: "number",
			input,
			code: "too_small",
			minimum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
		if (input > maximum) payload.issues.push({
			origin: "number",
			input,
			code: "too_big",
			maximum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMaxLength = /*@__PURE__*/ $constructor("$ZodCheckMaxLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
		if (def.maximum < curr) inst._zod.bag.maximum = def.maximum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length <= def.maximum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: def.maximum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMinLength = /*@__PURE__*/ $constructor("$ZodCheckMinLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
		if (def.minimum > curr) inst._zod.bag.minimum = def.minimum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length >= def.minimum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: def.minimum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLengthEquals = /*@__PURE__*/ $constructor("$ZodCheckLengthEquals", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.minimum = def.length;
		bag.maximum = def.length;
		bag.length = def.length;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		const length = input.length;
		if (length === def.length) return;
		const origin = getLengthableOrigin(input);
		const tooBig = length > def.length;
		payload.issues.push({
			origin,
			...tooBig ? {
				code: "too_big",
				maximum: def.length
			} : {
				code: "too_small",
				minimum: def.length
			},
			inclusive: true,
			exact: true,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStringFormat = /*@__PURE__*/ $constructor("$ZodCheckStringFormat", (inst, def) => {
	var _a, _b;
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		if (def.pattern) {
			bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
			bag.patterns.add(def.pattern);
		}
	});
	if (def.pattern) (_a = inst._zod).check ?? (_a.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: def.format,
			input: payload.value,
			...def.pattern ? { pattern: def.pattern.toString() } : {},
			inst,
			continue: !def.abort
		});
	});
	else (_b = inst._zod).check ?? (_b.check = () => {});
});
const $ZodCheckRegex = /*@__PURE__*/ $constructor("$ZodCheckRegex", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "regex",
			input: payload.value,
			pattern: def.pattern.toString(),
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLowerCase = /*@__PURE__*/ $constructor("$ZodCheckLowerCase", (inst, def) => {
	def.pattern ?? (def.pattern = lowercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckUpperCase = /*@__PURE__*/ $constructor("$ZodCheckUpperCase", (inst, def) => {
	def.pattern ?? (def.pattern = uppercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckIncludes = /*@__PURE__*/ $constructor("$ZodCheckIncludes", (inst, def) => {
	$ZodCheck.init(inst, def);
	const escapedRegex = escapeRegex(def.includes);
	const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
	def.pattern = pattern;
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.includes(def.includes, def.position)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "includes",
			includes: def.includes,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStartsWith = /*@__PURE__*/ $constructor("$ZodCheckStartsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.startsWith(def.prefix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "starts_with",
			prefix: def.prefix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckEndsWith = /*@__PURE__*/ $constructor("$ZodCheckEndsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.endsWith(def.suffix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "ends_with",
			suffix: def.suffix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckOverwrite = /*@__PURE__*/ $constructor("$ZodCheckOverwrite", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		payload.value = def.tx(payload.value);
	};
});
//#endregion
//#region node_modules/zod/v4/core/doc.js
var Doc = class {
	constructor(args = []) {
		this.content = [];
		this.indent = 0;
		if (this) this.args = args;
	}
	indented(fn) {
		this.indent += 1;
		fn(this);
		this.indent -= 1;
	}
	write(arg) {
		if (typeof arg === "function") {
			arg(this, { execution: "sync" });
			arg(this, { execution: "async" });
			return;
		}
		const lines = arg.split("\n").filter((x) => x);
		const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
		const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
		for (const line of dedented) this.content.push(line);
	}
	compile() {
		const F = Function;
		const args = this?.args;
		const lines = [...(this?.content ?? [``]).map((x) => `  ${x}`)];
		return new F(...args, lines.join("\n"));
	}
};
//#endregion
//#region node_modules/zod/v4/core/versions.js
const version = {
	major: 4,
	minor: 3,
	patch: 6
};
//#endregion
//#region node_modules/zod/v4/core/schemas.js
const $ZodType = /*@__PURE__*/ $constructor("$ZodType", (inst, def) => {
	var _a;
	inst ?? (inst = {});
	inst._zod.def = def;
	inst._zod.bag = inst._zod.bag || {};
	inst._zod.version = version;
	const checks = [...inst._zod.def.checks ?? []];
	if (inst._zod.traits.has("$ZodCheck")) checks.unshift(inst);
	for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
	if (checks.length === 0) {
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred?.push(() => {
			inst._zod.run = inst._zod.parse;
		});
	} else {
		const runChecks = (payload, checks, ctx) => {
			let isAborted = aborted(payload);
			let asyncResult;
			for (const ch of checks) {
				if (ch._zod.def.when) {
					if (!ch._zod.def.when(payload)) continue;
				} else if (isAborted) continue;
				const currLen = payload.issues.length;
				const _ = ch._zod.check(payload);
				if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
				if (asyncResult || _ instanceof Promise) asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
					await _;
					if (payload.issues.length === currLen) return;
					if (!isAborted) isAborted = aborted(payload, currLen);
				});
				else {
					if (payload.issues.length === currLen) continue;
					if (!isAborted) isAborted = aborted(payload, currLen);
				}
			}
			if (asyncResult) return asyncResult.then(() => {
				return payload;
			});
			return payload;
		};
		const handleCanaryResult = (canary, payload, ctx) => {
			if (aborted(canary)) {
				canary.aborted = true;
				return canary;
			}
			const checkResult = runChecks(payload, checks, ctx);
			if (checkResult instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
			}
			return inst._zod.parse(checkResult, ctx);
		};
		inst._zod.run = (payload, ctx) => {
			if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
			if (ctx.direction === "backward") {
				const canary = inst._zod.parse({
					value: payload.value,
					issues: []
				}, {
					...ctx,
					skipChecks: true
				});
				if (canary instanceof Promise) return canary.then((canary) => {
					return handleCanaryResult(canary, payload, ctx);
				});
				return handleCanaryResult(canary, payload, ctx);
			}
			const result = inst._zod.parse(payload, ctx);
			if (result instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return result.then((result) => runChecks(result, checks, ctx));
			}
			return runChecks(result, checks, ctx);
		};
	}
	defineLazy(inst, "~standard", () => ({
		validate: (value) => {
			try {
				const r = safeParse$1(inst, value);
				return r.success ? { value: r.data } : { issues: r.error?.issues };
			} catch (_) {
				return safeParseAsync$1(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
			}
		},
		vendor: "zod",
		version: 1
	}));
});
const $ZodString = /*@__PURE__*/ $constructor("$ZodString", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string$1(inst._zod.bag);
	inst._zod.parse = (payload, _) => {
		if (def.coerce) try {
			payload.value = String(payload.value);
		} catch (_) {}
		if (typeof payload.value === "string") return payload;
		payload.issues.push({
			expected: "string",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
const $ZodStringFormat = /*@__PURE__*/ $constructor("$ZodStringFormat", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	$ZodString.init(inst, def);
});
const $ZodGUID = /*@__PURE__*/ $constructor("$ZodGUID", (inst, def) => {
	def.pattern ?? (def.pattern = guid);
	$ZodStringFormat.init(inst, def);
});
const $ZodUUID = /*@__PURE__*/ $constructor("$ZodUUID", (inst, def) => {
	if (def.version) {
		const v = {
			v1: 1,
			v2: 2,
			v3: 3,
			v4: 4,
			v5: 5,
			v6: 6,
			v7: 7,
			v8: 8
		}[def.version];
		if (v === void 0) throw new Error(`Invalid UUID version: "${def.version}"`);
		def.pattern ?? (def.pattern = uuid(v));
	} else def.pattern ?? (def.pattern = uuid());
	$ZodStringFormat.init(inst, def);
});
const $ZodEmail = /*@__PURE__*/ $constructor("$ZodEmail", (inst, def) => {
	def.pattern ?? (def.pattern = email);
	$ZodStringFormat.init(inst, def);
});
const $ZodURL = /*@__PURE__*/ $constructor("$ZodURL", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		try {
			const trimmed = payload.value.trim();
			const url = new URL(trimmed);
			if (def.hostname) {
				def.hostname.lastIndex = 0;
				if (!def.hostname.test(url.hostname)) payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid hostname",
					pattern: def.hostname.source,
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
			if (def.protocol) {
				def.protocol.lastIndex = 0;
				if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid protocol",
					pattern: def.protocol.source,
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
			if (def.normalize) payload.value = url.href;
			else payload.value = trimmed;
			return;
		} catch (_) {
			payload.issues.push({
				code: "invalid_format",
				format: "url",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
const $ZodEmoji = /*@__PURE__*/ $constructor("$ZodEmoji", (inst, def) => {
	def.pattern ?? (def.pattern = emoji());
	$ZodStringFormat.init(inst, def);
});
const $ZodNanoID = /*@__PURE__*/ $constructor("$ZodNanoID", (inst, def) => {
	def.pattern ?? (def.pattern = nanoid);
	$ZodStringFormat.init(inst, def);
});
const $ZodCUID = /*@__PURE__*/ $constructor("$ZodCUID", (inst, def) => {
	def.pattern ?? (def.pattern = cuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodCUID2 = /*@__PURE__*/ $constructor("$ZodCUID2", (inst, def) => {
	def.pattern ?? (def.pattern = cuid2);
	$ZodStringFormat.init(inst, def);
});
const $ZodULID = /*@__PURE__*/ $constructor("$ZodULID", (inst, def) => {
	def.pattern ?? (def.pattern = ulid);
	$ZodStringFormat.init(inst, def);
});
const $ZodXID = /*@__PURE__*/ $constructor("$ZodXID", (inst, def) => {
	def.pattern ?? (def.pattern = xid);
	$ZodStringFormat.init(inst, def);
});
const $ZodKSUID = /*@__PURE__*/ $constructor("$ZodKSUID", (inst, def) => {
	def.pattern ?? (def.pattern = ksuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodISODateTime = /*@__PURE__*/ $constructor("$ZodISODateTime", (inst, def) => {
	def.pattern ?? (def.pattern = datetime$1(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODate = /*@__PURE__*/ $constructor("$ZodISODate", (inst, def) => {
	def.pattern ?? (def.pattern = date$1);
	$ZodStringFormat.init(inst, def);
});
const $ZodISOTime = /*@__PURE__*/ $constructor("$ZodISOTime", (inst, def) => {
	def.pattern ?? (def.pattern = time$1(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODuration = /*@__PURE__*/ $constructor("$ZodISODuration", (inst, def) => {
	def.pattern ?? (def.pattern = duration$1);
	$ZodStringFormat.init(inst, def);
});
const $ZodIPv4 = /*@__PURE__*/ $constructor("$ZodIPv4", (inst, def) => {
	def.pattern ?? (def.pattern = ipv4);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv4`;
});
const $ZodIPv6 = /*@__PURE__*/ $constructor("$ZodIPv6", (inst, def) => {
	def.pattern ?? (def.pattern = ipv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv6`;
	inst._zod.check = (payload) => {
		try {
			new URL(`http://[${payload.value}]`);
		} catch {
			payload.issues.push({
				code: "invalid_format",
				format: "ipv6",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
const $ZodCIDRv4 = /*@__PURE__*/ $constructor("$ZodCIDRv4", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv4);
	$ZodStringFormat.init(inst, def);
});
const $ZodCIDRv6 = /*@__PURE__*/ $constructor("$ZodCIDRv6", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		const parts = payload.value.split("/");
		try {
			if (parts.length !== 2) throw new Error();
			const [address, prefix] = parts;
			if (!prefix) throw new Error();
			const prefixNum = Number(prefix);
			if (`${prefixNum}` !== prefix) throw new Error();
			if (prefixNum < 0 || prefixNum > 128) throw new Error();
			new URL(`http://[${address}]`);
		} catch {
			payload.issues.push({
				code: "invalid_format",
				format: "cidrv6",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
function isValidBase64(data) {
	if (data === "") return true;
	if (data.length % 4 !== 0) return false;
	try {
		atob(data);
		return true;
	} catch {
		return false;
	}
}
const $ZodBase64 = /*@__PURE__*/ $constructor("$ZodBase64", (inst, def) => {
	def.pattern ?? (def.pattern = base64);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64";
	inst._zod.check = (payload) => {
		if (isValidBase64(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
function isValidBase64URL(data) {
	if (!base64url.test(data)) return false;
	const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
	return isValidBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}
const $ZodBase64URL = /*@__PURE__*/ $constructor("$ZodBase64URL", (inst, def) => {
	def.pattern ?? (def.pattern = base64url);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64url";
	inst._zod.check = (payload) => {
		if (isValidBase64URL(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64url",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodE164 = /*@__PURE__*/ $constructor("$ZodE164", (inst, def) => {
	def.pattern ?? (def.pattern = e164);
	$ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
	try {
		const tokensParts = token.split(".");
		if (tokensParts.length !== 3) return false;
		const [header] = tokensParts;
		if (!header) return false;
		const parsedHeader = JSON.parse(atob(header));
		if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT") return false;
		if (!parsedHeader.alg) return false;
		if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
		return true;
	} catch {
		return false;
	}
}
const $ZodJWT = /*@__PURE__*/ $constructor("$ZodJWT", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidJWT(payload.value, def.alg)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "jwt",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodNumber = /*@__PURE__*/ $constructor("$ZodNumber", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = inst._zod.bag.pattern ?? number$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Number(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) return payload;
		const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
		payload.issues.push({
			expected: "number",
			code: "invalid_type",
			input,
			inst,
			...received ? { received } : {}
		});
		return payload;
	};
});
const $ZodNumberFormat = /*@__PURE__*/ $constructor("$ZodNumberFormat", (inst, def) => {
	$ZodCheckNumberFormat.init(inst, def);
	$ZodNumber.init(inst, def);
});
const $ZodBoolean = /*@__PURE__*/ $constructor("$ZodBoolean", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = boolean$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Boolean(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "boolean") return payload;
		payload.issues.push({
			expected: "boolean",
			code: "invalid_type",
			input,
			inst
		});
		return payload;
	};
});
const $ZodNull = /*@__PURE__*/ $constructor("$ZodNull", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = _null$2;
	inst._zod.values = /* @__PURE__ */ new Set([null]);
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (input === null) return payload;
		payload.issues.push({
			expected: "null",
			code: "invalid_type",
			input,
			inst
		});
		return payload;
	};
});
const $ZodAny = /*@__PURE__*/ $constructor("$ZodAny", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload) => payload;
});
const $ZodUnknown = /*@__PURE__*/ $constructor("$ZodUnknown", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload) => payload;
});
const $ZodNever = /*@__PURE__*/ $constructor("$ZodNever", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _ctx) => {
		payload.issues.push({
			expected: "never",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
function handleArrayResult(result, final, index) {
	if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
	final.value[index] = result.value;
}
const $ZodArray = /*@__PURE__*/ $constructor("$ZodArray", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!Array.isArray(input)) {
			payload.issues.push({
				expected: "array",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = Array(input.length);
		const proms = [];
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			const result = def.element._zod.run({
				value: item,
				issues: []
			}, ctx);
			if (result instanceof Promise) proms.push(result.then((result) => handleArrayResult(result, payload, i)));
			else handleArrayResult(result, payload, i);
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
function handlePropertyResult(result, final, key, input, isOptionalOut) {
	if (result.issues.length) {
		if (isOptionalOut && !(key in input)) return;
		final.issues.push(...prefixIssues(key, result.issues));
	}
	if (result.value === void 0) {
		if (key in input) final.value[key] = void 0;
	} else final.value[key] = result.value;
}
function normalizeDef(def) {
	const keys = Object.keys(def.shape);
	for (const k of keys) if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
	const okeys = optionalKeys(def.shape);
	return {
		...def,
		keys,
		keySet: new Set(keys),
		numKeys: keys.length,
		optionalKeys: new Set(okeys)
	};
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
	const unrecognized = [];
	const keySet = def.keySet;
	const _catchall = def.catchall._zod;
	const t = _catchall.def.type;
	const isOptionalOut = _catchall.optout === "optional";
	for (const key in input) {
		if (keySet.has(key)) continue;
		if (t === "never") {
			unrecognized.push(key);
			continue;
		}
		const r = _catchall.run({
			value: input[key],
			issues: []
		}, ctx);
		if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalOut)));
		else handlePropertyResult(r, payload, key, input, isOptionalOut);
	}
	if (unrecognized.length) payload.issues.push({
		code: "unrecognized_keys",
		keys: unrecognized,
		input,
		inst
	});
	if (!proms.length) return payload;
	return Promise.all(proms).then(() => {
		return payload;
	});
}
const $ZodObject = /*@__PURE__*/ $constructor("$ZodObject", (inst, def) => {
	$ZodType.init(inst, def);
	if (!Object.getOwnPropertyDescriptor(def, "shape")?.get) {
		const sh = def.shape;
		Object.defineProperty(def, "shape", { get: () => {
			const newSh = { ...sh };
			Object.defineProperty(def, "shape", { value: newSh });
			return newSh;
		} });
	}
	const _normalized = cached(() => normalizeDef(def));
	defineLazy(inst._zod, "propValues", () => {
		const shape = def.shape;
		const propValues = {};
		for (const key in shape) {
			const field = shape[key]._zod;
			if (field.values) {
				propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
				for (const v of field.values) propValues[key].add(v);
			}
		}
		return propValues;
	});
	const isObject$2 = isObject;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$2(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = {};
		const proms = [];
		const shape = value.shape;
		for (const key of value.keys) {
			const el = shape[key];
			const isOptionalOut = el._zod.optout === "optional";
			const r = el._zod.run({
				value: input[key],
				issues: []
			}, ctx);
			if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalOut)));
			else handlePropertyResult(r, payload, key, input, isOptionalOut);
		}
		if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
		return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
	};
});
const $ZodObjectJIT = /*@__PURE__*/ $constructor("$ZodObjectJIT", (inst, def) => {
	$ZodObject.init(inst, def);
	const superParse = inst._zod.parse;
	const _normalized = cached(() => normalizeDef(def));
	const generateFastpass = (shape) => {
		const doc = new Doc([
			"shape",
			"payload",
			"ctx"
		]);
		const normalized = _normalized.value;
		const parseStr = (key) => {
			const k = esc(key);
			return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
		};
		doc.write(`const input = payload.value;`);
		const ids = Object.create(null);
		let counter = 0;
		for (const key of normalized.keys) ids[key] = `key_${counter++}`;
		doc.write(`const newResult = {};`);
		for (const key of normalized.keys) {
			const id = ids[key];
			const k = esc(key);
			const isOptionalOut = shape[key]?._zod?.optout === "optional";
			doc.write(`const ${id} = ${parseStr(key)};`);
			if (isOptionalOut) doc.write(`
        if (${id}.issues.length) {
          if (${k} in input) {
            payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${k}, ...iss.path] : [${k}]
            })));
          }
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
			else doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
		}
		doc.write(`payload.value = newResult;`);
		doc.write(`return payload;`);
		const fn = doc.compile();
		return (payload, ctx) => fn(shape, payload, ctx);
	};
	let fastpass;
	const isObject$1 = isObject;
	const jit = !globalConfig.jitless;
	const fastEnabled = jit && allowsEval.value;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$1(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
			if (!fastpass) fastpass = generateFastpass(def.shape);
			payload = fastpass(payload, ctx);
			if (!catchall) return payload;
			return handleCatchall([], input, payload, ctx, value, inst);
		}
		return superParse(payload, ctx);
	};
});
function handleUnionResults(results, final, inst, ctx) {
	for (const result of results) if (result.issues.length === 0) {
		final.value = result.value;
		return final;
	}
	const nonaborted = results.filter((r) => !aborted(r));
	if (nonaborted.length === 1) {
		final.value = nonaborted[0].value;
		return nonaborted[0];
	}
	final.issues.push({
		code: "invalid_union",
		input: final.value,
		inst,
		errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	});
	return final;
}
const $ZodUnion = /*@__PURE__*/ $constructor("$ZodUnion", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "values", () => {
		if (def.options.every((o) => o._zod.values)) return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
	});
	defineLazy(inst._zod, "pattern", () => {
		if (def.options.every((o) => o._zod.pattern)) {
			const patterns = def.options.map((o) => o._zod.pattern);
			return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
		}
	});
	const single = def.options.length === 1;
	const first = def.options[0]._zod.run;
	inst._zod.parse = (payload, ctx) => {
		if (single) return first(payload, ctx);
		let async = false;
		const results = [];
		for (const option of def.options) {
			const result = option._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) {
				results.push(result);
				async = true;
			} else {
				if (result.issues.length === 0) return result;
				results.push(result);
			}
		}
		if (!async) return handleUnionResults(results, payload, inst, ctx);
		return Promise.all(results).then((results) => {
			return handleUnionResults(results, payload, inst, ctx);
		});
	};
});
const $ZodDiscriminatedUnion = /*@__PURE__*/ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
	def.inclusive = false;
	$ZodUnion.init(inst, def);
	const _super = inst._zod.parse;
	defineLazy(inst._zod, "propValues", () => {
		const propValues = {};
		for (const option of def.options) {
			const pv = option._zod.propValues;
			if (!pv || Object.keys(pv).length === 0) throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
			for (const [k, v] of Object.entries(pv)) {
				if (!propValues[k]) propValues[k] = /* @__PURE__ */ new Set();
				for (const val of v) propValues[k].add(val);
			}
		}
		return propValues;
	});
	const disc = cached(() => {
		const opts = def.options;
		const map = /* @__PURE__ */ new Map();
		for (const o of opts) {
			const values = o._zod.propValues?.[def.discriminator];
			if (!values || values.size === 0) throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(o)}"`);
			for (const v of values) {
				if (map.has(v)) throw new Error(`Duplicate discriminator value "${String(v)}"`);
				map.set(v, o);
			}
		}
		return map;
	});
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isObject(input)) {
			payload.issues.push({
				code: "invalid_type",
				expected: "object",
				input,
				inst
			});
			return payload;
		}
		const opt = disc.value.get(input?.[def.discriminator]);
		if (opt) return opt._zod.run(payload, ctx);
		if (def.unionFallback) return _super(payload, ctx);
		payload.issues.push({
			code: "invalid_union",
			errors: [],
			note: "No matching discriminator",
			discriminator: def.discriminator,
			input,
			path: [def.discriminator],
			inst
		});
		return payload;
	};
});
const $ZodIntersection = /*@__PURE__*/ $constructor("$ZodIntersection", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		const left = def.left._zod.run({
			value: input,
			issues: []
		}, ctx);
		const right = def.right._zod.run({
			value: input,
			issues: []
		}, ctx);
		if (left instanceof Promise || right instanceof Promise) return Promise.all([left, right]).then(([left, right]) => {
			return handleIntersectionResults(payload, left, right);
		});
		return handleIntersectionResults(payload, left, right);
	};
});
function mergeValues(a, b) {
	if (a === b) return {
		valid: true,
		data: a
	};
	if (a instanceof Date && b instanceof Date && +a === +b) return {
		valid: true,
		data: a
	};
	if (isPlainObject(a) && isPlainObject(b)) {
		const bKeys = Object.keys(b);
		const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		for (const key of sharedKeys) {
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
			};
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return {
			valid: false,
			mergeErrorPath: []
		};
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
			};
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	}
	return {
		valid: false,
		mergeErrorPath: []
	};
}
function handleIntersectionResults(result, left, right) {
	const unrecKeys = /* @__PURE__ */ new Map();
	let unrecIssue;
	for (const iss of left.issues) if (iss.code === "unrecognized_keys") {
		unrecIssue ?? (unrecIssue = iss);
		for (const k of iss.keys) {
			if (!unrecKeys.has(k)) unrecKeys.set(k, {});
			unrecKeys.get(k).l = true;
		}
	} else result.issues.push(iss);
	for (const iss of right.issues) if (iss.code === "unrecognized_keys") for (const k of iss.keys) {
		if (!unrecKeys.has(k)) unrecKeys.set(k, {});
		unrecKeys.get(k).r = true;
	}
	else result.issues.push(iss);
	const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
	if (bothKeys.length && unrecIssue) result.issues.push({
		...unrecIssue,
		keys: bothKeys
	});
	if (aborted(result)) return result;
	const merged = mergeValues(left.value, right.value);
	if (!merged.valid) throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
	result.value = merged.data;
	return result;
}
const $ZodRecord = /*@__PURE__*/ $constructor("$ZodRecord", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isPlainObject(input)) {
			payload.issues.push({
				expected: "record",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		const proms = [];
		const values = def.keyType._zod.values;
		if (values) {
			payload.value = {};
			const recordKeys = /* @__PURE__ */ new Set();
			for (const key of values) if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
				recordKeys.add(typeof key === "number" ? key.toString() : key);
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[key] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[key] = result.value;
				}
			}
			let unrecognized;
			for (const key in input) if (!recordKeys.has(key)) {
				unrecognized = unrecognized ?? [];
				unrecognized.push(key);
			}
			if (unrecognized && unrecognized.length > 0) payload.issues.push({
				code: "unrecognized_keys",
				input,
				inst,
				keys: unrecognized
			});
		} else {
			payload.value = {};
			for (const key of Reflect.ownKeys(input)) {
				if (key === "__proto__") continue;
				let keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (typeof key === "string" && number$1.test(key) && keyResult.issues.length) {
					const retryResult = def.keyType._zod.run({
						value: Number(key),
						issues: []
					}, ctx);
					if (retryResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
					if (retryResult.issues.length === 0) keyResult = retryResult;
				}
				if (keyResult.issues.length) {
					if (def.mode === "loose") payload.value[key] = input[key];
					else payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[keyResult.value] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[keyResult.value] = result.value;
				}
			}
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
const $ZodEnum = /*@__PURE__*/ $constructor("$ZodEnum", (inst, def) => {
	$ZodType.init(inst, def);
	const values = getEnumValues(def.entries);
	const valuesSet = new Set(values);
	inst._zod.values = valuesSet;
	inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (valuesSet.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodLiteral = /*@__PURE__*/ $constructor("$ZodLiteral", (inst, def) => {
	$ZodType.init(inst, def);
	if (def.values.length === 0) throw new Error("Cannot create literal schema with no valid values");
	const values = new Set(def.values);
	inst._zod.values = values;
	inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (values.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values: def.values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodTransform = /*@__PURE__*/ $constructor("$ZodTransform", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		const _out = def.transform(payload.value, payload);
		if (ctx.async) return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
			payload.value = output;
			return payload;
		});
		if (_out instanceof Promise) throw new $ZodAsyncError();
		payload.value = _out;
		return payload;
	};
});
function handleOptionalResult(result, input) {
	if (result.issues.length && input === void 0) return {
		issues: [],
		value: void 0
	};
	return result;
}
const $ZodOptional = /*@__PURE__*/ $constructor("$ZodOptional", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	inst._zod.optout = "optional";
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, void 0]) : void 0;
	});
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (def.innerType._zod.optin === "optional") {
			const result = def.innerType._zod.run(payload, ctx);
			if (result instanceof Promise) return result.then((r) => handleOptionalResult(r, payload.value));
			return handleOptionalResult(result, payload.value);
		}
		if (payload.value === void 0) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodExactOptional = /*@__PURE__*/ $constructor("$ZodExactOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	defineLazy(inst._zod, "pattern", () => def.innerType._zod.pattern);
	inst._zod.parse = (payload, ctx) => {
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNullable = /*@__PURE__*/ $constructor("$ZodNullable", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
	});
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, null]) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === null) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodDefault = /*@__PURE__*/ $constructor("$ZodDefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) {
			payload.value = def.defaultValue;
			/**
			* $ZodDefault returns the default value immediately in forward direction.
			* It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
			return payload;
		}
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleDefaultResult(result, def));
		return handleDefaultResult(result, def);
	};
});
function handleDefaultResult(payload, def) {
	if (payload.value === void 0) payload.value = def.defaultValue;
	return payload;
}
const $ZodPrefault = /*@__PURE__*/ $constructor("$ZodPrefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) payload.value = def.defaultValue;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNonOptional = /*@__PURE__*/ $constructor("$ZodNonOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => {
		const v = def.innerType._zod.values;
		return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleNonOptionalResult(result, inst));
		return handleNonOptionalResult(result, inst);
	};
});
function handleNonOptionalResult(payload, inst) {
	if (!payload.issues.length && payload.value === void 0) payload.issues.push({
		code: "invalid_type",
		expected: "nonoptional",
		input: payload.value,
		inst
	});
	return payload;
}
const $ZodCatch = /*@__PURE__*/ $constructor("$ZodCatch", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => {
			payload.value = result.value;
			if (result.issues.length) {
				payload.value = def.catchValue({
					...payload,
					error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
					input: payload.value
				});
				payload.issues = [];
			}
			return payload;
		});
		payload.value = result.value;
		if (result.issues.length) {
			payload.value = def.catchValue({
				...payload,
				error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
				input: payload.value
			});
			payload.issues = [];
		}
		return payload;
	};
});
const $ZodPipe = /*@__PURE__*/ $constructor("$ZodPipe", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => def.in._zod.values);
	defineLazy(inst._zod, "optin", () => def.in._zod.optin);
	defineLazy(inst._zod, "optout", () => def.out._zod.optout);
	defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") {
			const right = def.out._zod.run(payload, ctx);
			if (right instanceof Promise) return right.then((right) => handlePipeResult(right, def.in, ctx));
			return handlePipeResult(right, def.in, ctx);
		}
		const left = def.in._zod.run(payload, ctx);
		if (left instanceof Promise) return left.then((left) => handlePipeResult(left, def.out, ctx));
		return handlePipeResult(left, def.out, ctx);
	};
});
function handlePipeResult(left, next, ctx) {
	if (left.issues.length) {
		left.aborted = true;
		return left;
	}
	return next._zod.run({
		value: left.value,
		issues: left.issues
	}, ctx);
}
const $ZodReadonly = /*@__PURE__*/ $constructor("$ZodReadonly", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	defineLazy(inst._zod, "optin", () => def.innerType?._zod?.optin);
	defineLazy(inst._zod, "optout", () => def.innerType?._zod?.optout);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then(handleReadonlyResult);
		return handleReadonlyResult(result);
	};
});
function handleReadonlyResult(payload) {
	payload.value = Object.freeze(payload.value);
	return payload;
}
const $ZodLazy = /*@__PURE__*/ $constructor("$ZodLazy", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "innerType", () => def.getter());
	defineLazy(inst._zod, "pattern", () => inst._zod.innerType?._zod?.pattern);
	defineLazy(inst._zod, "propValues", () => inst._zod.innerType?._zod?.propValues);
	defineLazy(inst._zod, "optin", () => inst._zod.innerType?._zod?.optin ?? void 0);
	defineLazy(inst._zod, "optout", () => inst._zod.innerType?._zod?.optout ?? void 0);
	inst._zod.parse = (payload, ctx) => {
		return inst._zod.innerType._zod.run(payload, ctx);
	};
});
const $ZodCustom = /*@__PURE__*/ $constructor("$ZodCustom", (inst, def) => {
	$ZodCheck.init(inst, def);
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _) => {
		return payload;
	};
	inst._zod.check = (payload) => {
		const input = payload.value;
		const r = def.fn(input);
		if (r instanceof Promise) return r.then((r) => handleRefineResult(r, payload, input, inst));
		handleRefineResult(r, payload, input, inst);
	};
});
function handleRefineResult(result, payload, input, inst) {
	if (!result) {
		const _iss = {
			code: "custom",
			input,
			inst,
			path: [...inst._zod.def.path ?? []],
			continue: !inst._zod.def.abort
		};
		if (inst._zod.def.params) _iss.params = inst._zod.def.params;
		payload.issues.push(issue(_iss));
	}
}
//#endregion
//#region node_modules/zod/v4/core/registries.js
var _a;
var $ZodRegistry = class {
	constructor() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
	}
	add(schema, ..._meta) {
		const meta = _meta[0];
		this._map.set(schema, meta);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.set(meta.id, schema);
		return this;
	}
	clear() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
		return this;
	}
	remove(schema) {
		const meta = this._map.get(schema);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.delete(meta.id);
		this._map.delete(schema);
		return this;
	}
	get(schema) {
		const p = schema._zod.parent;
		if (p) {
			const pm = { ...this.get(p) ?? {} };
			delete pm.id;
			const f = {
				...pm,
				...this._map.get(schema)
			};
			return Object.keys(f).length ? f : void 0;
		}
		return this._map.get(schema);
	}
	has(schema) {
		return this._map.has(schema);
	}
};
function registry() {
	return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
const globalRegistry = globalThis.__zod_globalRegistry;
//#endregion
//#region node_modules/zod/v4/core/api.js
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
	return new Class({
		type: "string",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _email(Class, params) {
	return new Class({
		type: "string",
		format: "email",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _guid(Class, params) {
	return new Class({
		type: "string",
		format: "guid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuid(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv4(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v4",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv6(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v6",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv7(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v7",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _url(Class, params) {
	return new Class({
		type: "string",
		format: "url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _emoji(Class, params) {
	return new Class({
		type: "string",
		format: "emoji",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _nanoid(Class, params) {
	return new Class({
		type: "string",
		format: "nanoid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cuid(Class, params) {
	return new Class({
		type: "string",
		format: "cuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cuid2(Class, params) {
	return new Class({
		type: "string",
		format: "cuid2",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ulid(Class, params) {
	return new Class({
		type: "string",
		format: "ulid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _xid(Class, params) {
	return new Class({
		type: "string",
		format: "xid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ksuid(Class, params) {
	return new Class({
		type: "string",
		format: "ksuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv4(Class, params) {
	return new Class({
		type: "string",
		format: "ipv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv6(Class, params) {
	return new Class({
		type: "string",
		format: "ipv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv4(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv6(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64(Class, params) {
	return new Class({
		type: "string",
		format: "base64",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64url(Class, params) {
	return new Class({
		type: "string",
		format: "base64url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _e164(Class, params) {
	return new Class({
		type: "string",
		format: "e164",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _jwt(Class, params) {
	return new Class({
		type: "string",
		format: "jwt",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class, params) {
	return new Class({
		type: "string",
		format: "datetime",
		check: "string_format",
		offset: false,
		local: false,
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class, params) {
	return new Class({
		type: "string",
		format: "date",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class, params) {
	return new Class({
		type: "string",
		format: "time",
		check: "string_format",
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class, params) {
	return new Class({
		type: "string",
		format: "duration",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
	return new Class({
		type: "number",
		checks: [],
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _int(Class, params) {
	return new Class({
		type: "number",
		check: "number_format",
		abort: false,
		format: "safeint",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class, params) {
	return new Class({
		type: "boolean",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _null$1(Class, params) {
	return new Class({
		type: "null",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _any(Class) {
	return new Class({ type: "any" });
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class) {
	return new Class({ type: "unknown" });
}
// @__NO_SIDE_EFFECTS__
function _never(Class, params) {
	return new Class({
		type: "never",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _lt(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _multipleOf(value, params) {
	return new $ZodCheckMultipleOf({
		check: "multiple_of",
		...normalizeParams(params),
		value
	});
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
	return new $ZodCheckMaxLength({
		check: "max_length",
		...normalizeParams(params),
		maximum
	});
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
	return new $ZodCheckMinLength({
		check: "min_length",
		...normalizeParams(params),
		minimum
	});
}
// @__NO_SIDE_EFFECTS__
function _length(length, params) {
	return new $ZodCheckLengthEquals({
		check: "length_equals",
		...normalizeParams(params),
		length
	});
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
	return new $ZodCheckRegex({
		check: "string_format",
		format: "regex",
		...normalizeParams(params),
		pattern
	});
}
// @__NO_SIDE_EFFECTS__
function _lowercase(params) {
	return new $ZodCheckLowerCase({
		check: "string_format",
		format: "lowercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uppercase(params) {
	return new $ZodCheckUpperCase({
		check: "string_format",
		format: "uppercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _includes(includes, params) {
	return new $ZodCheckIncludes({
		check: "string_format",
		format: "includes",
		...normalizeParams(params),
		includes
	});
}
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
	return new $ZodCheckStartsWith({
		check: "string_format",
		format: "starts_with",
		...normalizeParams(params),
		prefix
	});
}
// @__NO_SIDE_EFFECTS__
function _endsWith(suffix, params) {
	return new $ZodCheckEndsWith({
		check: "string_format",
		format: "ends_with",
		...normalizeParams(params),
		suffix
	});
}
// @__NO_SIDE_EFFECTS__
function _overwrite(tx) {
	return new $ZodCheckOverwrite({
		check: "overwrite",
		tx
	});
}
// @__NO_SIDE_EFFECTS__
function _normalize(form) {
	return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
// @__NO_SIDE_EFFECTS__
function _trim() {
	return /* @__PURE__ */ _overwrite((input) => input.trim());
}
// @__NO_SIDE_EFFECTS__
function _toLowerCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function _toUpperCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function _slugify() {
	return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
// @__NO_SIDE_EFFECTS__
function _array(Class, element, params) {
	return new Class({
		type: "array",
		element,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _custom(Class, fn, _params) {
	const norm = normalizeParams(_params);
	norm.abort ?? (norm.abort = true);
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...norm
	});
}
// @__NO_SIDE_EFFECTS__
function _refine(Class, fn, _params) {
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...normalizeParams(_params)
	});
}
// @__NO_SIDE_EFFECTS__
function _superRefine(fn) {
	const ch = /* @__PURE__ */ _check((payload) => {
		payload.addIssue = (issue$2) => {
			if (typeof issue$2 === "string") payload.issues.push(issue(issue$2, payload.value, ch._zod.def));
			else {
				const _issue = issue$2;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = ch);
				_issue.continue ?? (_issue.continue = !ch._zod.def.abort);
				payload.issues.push(issue(_issue));
			}
		};
		return fn(payload.value, payload);
	});
	return ch;
}
// @__NO_SIDE_EFFECTS__
function _check(fn, params) {
	const ch = new $ZodCheck({
		check: "custom",
		...normalizeParams(params)
	});
	ch._zod.check = fn;
	return ch;
}
//#endregion
//#region node_modules/zod/v4/core/to-json-schema.js
function initializeContext(params) {
	let target = params?.target ?? "draft-2020-12";
	if (target === "draft-4") target = "draft-04";
	if (target === "draft-7") target = "draft-07";
	return {
		processors: params.processors ?? {},
		metadataRegistry: params?.metadata ?? globalRegistry,
		target,
		unrepresentable: params?.unrepresentable ?? "throw",
		override: params?.override ?? (() => {}),
		io: params?.io ?? "output",
		counter: 0,
		seen: /* @__PURE__ */ new Map(),
		cycles: params?.cycles ?? "ref",
		reused: params?.reused ?? "inline",
		external: params?.external ?? void 0
	};
}
function process$1(schema, ctx, _params = {
	path: [],
	schemaPath: []
}) {
	var _a;
	const def = schema._zod.def;
	const seen = ctx.seen.get(schema);
	if (seen) {
		seen.count++;
		if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
		return seen.schema;
	}
	const result = {
		schema: {},
		count: 1,
		cycle: void 0,
		path: _params.path
	};
	ctx.seen.set(schema, result);
	const overrideSchema = schema._zod.toJSONSchema?.();
	if (overrideSchema) result.schema = overrideSchema;
	else {
		const params = {
			..._params,
			schemaPath: [..._params.schemaPath, schema],
			path: _params.path
		};
		if (schema._zod.processJSONSchema) schema._zod.processJSONSchema(ctx, result.schema, params);
		else {
			const _json = result.schema;
			const processor = ctx.processors[def.type];
			if (!processor) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
			processor(schema, ctx, _json, params);
		}
		const parent = schema._zod.parent;
		if (parent) {
			if (!result.ref) result.ref = parent;
			process$1(parent, ctx, params);
			ctx.seen.get(parent).isParent = true;
		}
	}
	const meta = ctx.metadataRegistry.get(schema);
	if (meta) Object.assign(result.schema, meta);
	if (ctx.io === "input" && isTransforming(schema)) {
		delete result.schema.examples;
		delete result.schema.default;
	}
	if (ctx.io === "input" && result.schema._prefault) (_a = result.schema).default ?? (_a.default = result.schema._prefault);
	delete result.schema._prefault;
	return ctx.seen.get(schema).schema;
}
function extractDefs(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const idToSchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.entries()) {
		const id = ctx.metadataRegistry.get(entry[0])?.id;
		if (id) {
			const existing = idToSchema.get(id);
			if (existing && existing !== entry[0]) throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
			idToSchema.set(id, entry[0]);
		}
	}
	const makeURI = (entry) => {
		const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
		if (ctx.external) {
			const externalId = ctx.external.registry.get(entry[0])?.id;
			const uriGenerator = ctx.external.uri ?? ((id) => id);
			if (externalId) return { ref: uriGenerator(externalId) };
			const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
			entry[1].defId = id;
			return {
				defId: id,
				ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}`
			};
		}
		if (entry[1] === root) return { ref: "#" };
		const defUriPrefix = `#/${defsSegment}/`;
		const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
		return {
			defId,
			ref: defUriPrefix + defId
		};
	};
	const extractToDef = (entry) => {
		if (entry[1].schema.$ref) return;
		const seen = entry[1];
		const { ref, defId } = makeURI(entry);
		seen.def = { ...seen.schema };
		if (defId) seen.defId = defId;
		const schema = seen.schema;
		for (const key in schema) delete schema[key];
		schema.$ref = ref;
	};
	if (ctx.cycles === "throw") for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.cycle) throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
	}
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (schema === entry[0]) {
			extractToDef(entry);
			continue;
		}
		if (ctx.external) {
			const ext = ctx.external.registry.get(entry[0])?.id;
			if (schema !== entry[0] && ext) {
				extractToDef(entry);
				continue;
			}
		}
		if (ctx.metadataRegistry.get(entry[0])?.id) {
			extractToDef(entry);
			continue;
		}
		if (seen.cycle) {
			extractToDef(entry);
			continue;
		}
		if (seen.count > 1) {
			if (ctx.reused === "ref") {
				extractToDef(entry);
				continue;
			}
		}
	}
}
function finalize(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const flattenRef = (zodSchema) => {
		const seen = ctx.seen.get(zodSchema);
		if (seen.ref === null) return;
		const schema = seen.def ?? seen.schema;
		const _cached = { ...schema };
		const ref = seen.ref;
		seen.ref = null;
		if (ref) {
			flattenRef(ref);
			const refSeen = ctx.seen.get(ref);
			const refSchema = refSeen.schema;
			if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
				schema.allOf = schema.allOf ?? [];
				schema.allOf.push(refSchema);
			} else Object.assign(schema, refSchema);
			Object.assign(schema, _cached);
			if (zodSchema._zod.parent === ref) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (!(key in _cached)) delete schema[key];
			}
			if (refSchema.$ref && refSeen.def) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) delete schema[key];
			}
		}
		const parent = zodSchema._zod.parent;
		if (parent && parent !== ref) {
			flattenRef(parent);
			const parentSeen = ctx.seen.get(parent);
			if (parentSeen?.schema.$ref) {
				schema.$ref = parentSeen.schema.$ref;
				if (parentSeen.def) for (const key in schema) {
					if (key === "$ref" || key === "allOf") continue;
					if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) delete schema[key];
				}
			}
		}
		ctx.override({
			zodSchema,
			jsonSchema: schema,
			path: seen.path ?? []
		});
	};
	for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
	const result = {};
	if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
	else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
	else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";
	else if (ctx.target === "openapi-3.0") {}
	if (ctx.external?.uri) {
		const id = ctx.external.registry.get(schema)?.id;
		if (!id) throw new Error("Schema is missing an `id` property");
		result.$id = ctx.external.uri(id);
	}
	Object.assign(result, root.def ?? root.schema);
	const defs = ctx.external?.defs ?? {};
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.def && seen.defId) defs[seen.defId] = seen.def;
	}
	if (ctx.external) {} else if (Object.keys(defs).length > 0) {
		if (ctx.target === "draft-2020-12") result.$defs = defs;
		else result.definitions = defs;
	}
	try {
		const finalized = JSON.parse(JSON.stringify(result));
		Object.defineProperty(finalized, "~standard", {
			value: {
				...schema["~standard"],
				jsonSchema: {
					input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
					output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
				}
			},
			enumerable: false,
			writable: false
		});
		return finalized;
	} catch (_err) {
		throw new Error("Error converting schema to JSON.");
	}
}
function isTransforming(_schema, _ctx) {
	const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
	if (ctx.seen.has(_schema)) return false;
	ctx.seen.add(_schema);
	const def = _schema._zod.def;
	if (def.type === "transform") return true;
	if (def.type === "array") return isTransforming(def.element, ctx);
	if (def.type === "set") return isTransforming(def.valueType, ctx);
	if (def.type === "lazy") return isTransforming(def.getter(), ctx);
	if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault") return isTransforming(def.innerType, ctx);
	if (def.type === "intersection") return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
	if (def.type === "record" || def.type === "map") return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
	if (def.type === "pipe") return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
	if (def.type === "object") {
		for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
		return false;
	}
	if (def.type === "union") {
		for (const option of def.options) if (isTransforming(option, ctx)) return true;
		return false;
	}
	if (def.type === "tuple") {
		for (const item of def.items) if (isTransforming(item, ctx)) return true;
		if (def.rest && isTransforming(def.rest, ctx)) return true;
		return false;
	}
	return false;
}
/**
* Creates a toJSONSchema method for a schema instance.
* This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
*/
const createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
	const ctx = initializeContext({
		...params,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
const createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
	const { libraryOptions, target } = params ?? {};
	const ctx = initializeContext({
		...libraryOptions ?? {},
		target,
		io,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
//#endregion
//#region node_modules/zod/v4/core/json-schema-processors.js
const formatMap = {
	guid: "uuid",
	url: "uri",
	datetime: "date-time",
	json_string: "json-string",
	regex: ""
};
const stringProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	json.type = "string";
	const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
	if (typeof minimum === "number") json.minLength = minimum;
	if (typeof maximum === "number") json.maxLength = maximum;
	if (format) {
		json.format = formatMap[format] ?? format;
		if (json.format === "") delete json.format;
		if (format === "time") delete json.format;
	}
	if (contentEncoding) json.contentEncoding = contentEncoding;
	if (patterns && patterns.size > 0) {
		const regexes = [...patterns];
		if (regexes.length === 1) json.pattern = regexes[0].source;
		else if (regexes.length > 1) json.allOf = [...regexes.map((regex) => ({
			...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
			pattern: regex.source
		}))];
	}
};
const numberProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
	if (typeof format === "string" && format.includes("int")) json.type = "integer";
	else json.type = "number";
	if (typeof exclusiveMinimum === "number") {
		if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
			json.minimum = exclusiveMinimum;
			json.exclusiveMinimum = true;
		} else json.exclusiveMinimum = exclusiveMinimum;
	}
	if (typeof minimum === "number") {
		json.minimum = minimum;
		if (typeof exclusiveMinimum === "number" && ctx.target !== "draft-04") {
			if (exclusiveMinimum >= minimum) delete json.minimum;
			else delete json.exclusiveMinimum;
		}
	}
	if (typeof exclusiveMaximum === "number") {
		if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
			json.maximum = exclusiveMaximum;
			json.exclusiveMaximum = true;
		} else json.exclusiveMaximum = exclusiveMaximum;
	}
	if (typeof maximum === "number") {
		json.maximum = maximum;
		if (typeof exclusiveMaximum === "number" && ctx.target !== "draft-04") {
			if (exclusiveMaximum <= maximum) delete json.maximum;
			else delete json.exclusiveMaximum;
		}
	}
	if (typeof multipleOf === "number") json.multipleOf = multipleOf;
};
const booleanProcessor = (_schema, _ctx, json, _params) => {
	json.type = "boolean";
};
const bigintProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("BigInt cannot be represented in JSON Schema");
};
const symbolProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Symbols cannot be represented in JSON Schema");
};
const nullProcessor = (_schema, ctx, json, _params) => {
	if (ctx.target === "openapi-3.0") {
		json.type = "string";
		json.nullable = true;
		json.enum = [null];
	} else json.type = "null";
};
const undefinedProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Undefined cannot be represented in JSON Schema");
};
const voidProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Void cannot be represented in JSON Schema");
};
const neverProcessor = (_schema, _ctx, json, _params) => {
	json.not = {};
};
const anyProcessor = (_schema, _ctx, _json, _params) => {};
const unknownProcessor = (_schema, _ctx, _json, _params) => {};
const dateProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Date cannot be represented in JSON Schema");
};
const enumProcessor = (schema, _ctx, json, _params) => {
	const def = schema._zod.def;
	const values = getEnumValues(def.entries);
	if (values.every((v) => typeof v === "number")) json.type = "number";
	if (values.every((v) => typeof v === "string")) json.type = "string";
	json.enum = values;
};
const literalProcessor = (schema, ctx, json, _params) => {
	const def = schema._zod.def;
	const vals = [];
	for (const val of def.values) if (val === void 0) {
		if (ctx.unrepresentable === "throw") throw new Error("Literal `undefined` cannot be represented in JSON Schema");
	} else if (typeof val === "bigint") {
		if (ctx.unrepresentable === "throw") throw new Error("BigInt literals cannot be represented in JSON Schema");
		else vals.push(Number(val));
	} else vals.push(val);
	if (vals.length === 0) {} else if (vals.length === 1) {
		const val = vals[0];
		json.type = val === null ? "null" : typeof val;
		if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") json.enum = [val];
		else json.const = val;
	} else {
		if (vals.every((v) => typeof v === "number")) json.type = "number";
		if (vals.every((v) => typeof v === "string")) json.type = "string";
		if (vals.every((v) => typeof v === "boolean")) json.type = "boolean";
		if (vals.every((v) => v === null)) json.type = "null";
		json.enum = vals;
	}
};
const nanProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("NaN cannot be represented in JSON Schema");
};
const templateLiteralProcessor = (schema, _ctx, json, _params) => {
	const _json = json;
	const pattern = schema._zod.pattern;
	if (!pattern) throw new Error("Pattern not found in template literal");
	_json.type = "string";
	_json.pattern = pattern.source;
};
const fileProcessor = (schema, _ctx, json, _params) => {
	const _json = json;
	const file = {
		type: "string",
		format: "binary",
		contentEncoding: "binary"
	};
	const { minimum, maximum, mime } = schema._zod.bag;
	if (minimum !== void 0) file.minLength = minimum;
	if (maximum !== void 0) file.maxLength = maximum;
	if (mime) {
		if (mime.length === 1) {
			file.contentMediaType = mime[0];
			Object.assign(_json, file);
		} else {
			Object.assign(_json, file);
			_json.anyOf = mime.map((m) => ({ contentMediaType: m }));
		}
	} else Object.assign(_json, file);
};
const successProcessor = (_schema, _ctx, json, _params) => {
	json.type = "boolean";
};
const customProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Custom types cannot be represented in JSON Schema");
};
const functionProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Function types cannot be represented in JSON Schema");
};
const transformProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Transforms cannot be represented in JSON Schema");
};
const mapProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Map cannot be represented in JSON Schema");
};
const setProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Set cannot be represented in JSON Schema");
};
const arrayProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const { minimum, maximum } = schema._zod.bag;
	if (typeof minimum === "number") json.minItems = minimum;
	if (typeof maximum === "number") json.maxItems = maximum;
	json.type = "array";
	json.items = process$1(def.element, ctx, {
		...params,
		path: [...params.path, "items"]
	});
};
const objectProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	json.properties = {};
	const shape = def.shape;
	for (const key in shape) json.properties[key] = process$1(shape[key], ctx, {
		...params,
		path: [
			...params.path,
			"properties",
			key
		]
	});
	const allKeys = new Set(Object.keys(shape));
	const requiredKeys = new Set([...allKeys].filter((key) => {
		const v = def.shape[key]._zod;
		if (ctx.io === "input") return v.optin === void 0;
		else return v.optout === void 0;
	}));
	if (requiredKeys.size > 0) json.required = Array.from(requiredKeys);
	if (def.catchall?._zod.def.type === "never") json.additionalProperties = false;
	else if (!def.catchall) {
		if (ctx.io === "output") json.additionalProperties = false;
	} else if (def.catchall) json.additionalProperties = process$1(def.catchall, ctx, {
		...params,
		path: [...params.path, "additionalProperties"]
	});
};
const unionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const isExclusive = def.inclusive === false;
	const options = def.options.map((x, i) => process$1(x, ctx, {
		...params,
		path: [
			...params.path,
			isExclusive ? "oneOf" : "anyOf",
			i
		]
	}));
	if (isExclusive) json.oneOf = options;
	else json.anyOf = options;
};
const intersectionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const a = process$1(def.left, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			0
		]
	});
	const b = process$1(def.right, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			1
		]
	});
	const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
	json.allOf = [...isSimpleIntersection(a) ? a.allOf : [a], ...isSimpleIntersection(b) ? b.allOf : [b]];
};
const tupleProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "array";
	const prefixPath = ctx.target === "draft-2020-12" ? "prefixItems" : "items";
	const restPath = ctx.target === "draft-2020-12" ? "items" : ctx.target === "openapi-3.0" ? "items" : "additionalItems";
	const prefixItems = def.items.map((x, i) => process$1(x, ctx, {
		...params,
		path: [
			...params.path,
			prefixPath,
			i
		]
	}));
	const rest = def.rest ? process$1(def.rest, ctx, {
		...params,
		path: [
			...params.path,
			restPath,
			...ctx.target === "openapi-3.0" ? [def.items.length] : []
		]
	}) : null;
	if (ctx.target === "draft-2020-12") {
		json.prefixItems = prefixItems;
		if (rest) json.items = rest;
	} else if (ctx.target === "openapi-3.0") {
		json.items = { anyOf: prefixItems };
		if (rest) json.items.anyOf.push(rest);
		json.minItems = prefixItems.length;
		if (!rest) json.maxItems = prefixItems.length;
	} else {
		json.items = prefixItems;
		if (rest) json.additionalItems = rest;
	}
	const { minimum, maximum } = schema._zod.bag;
	if (typeof minimum === "number") json.minItems = minimum;
	if (typeof maximum === "number") json.maxItems = maximum;
};
const recordProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	const keyType = def.keyType;
	const patterns = keyType._zod.bag?.patterns;
	if (def.mode === "loose" && patterns && patterns.size > 0) {
		const valueSchema = process$1(def.valueType, ctx, {
			...params,
			path: [
				...params.path,
				"patternProperties",
				"*"
			]
		});
		json.patternProperties = {};
		for (const pattern of patterns) json.patternProperties[pattern.source] = valueSchema;
	} else {
		if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") json.propertyNames = process$1(def.keyType, ctx, {
			...params,
			path: [...params.path, "propertyNames"]
		});
		json.additionalProperties = process$1(def.valueType, ctx, {
			...params,
			path: [...params.path, "additionalProperties"]
		});
	}
	const keyValues = keyType._zod.values;
	if (keyValues) {
		const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
		if (validKeyValues.length > 0) json.required = validKeyValues;
	}
};
const nullableProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const inner = process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	if (ctx.target === "openapi-3.0") {
		seen.ref = def.innerType;
		json.nullable = true;
	} else json.anyOf = [inner, { type: "null" }];
};
const nonoptionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
const defaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.default = JSON.parse(JSON.stringify(def.defaultValue));
};
const prefaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	if (ctx.io === "input") json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
};
const catchProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	let catchValue;
	try {
		catchValue = def.catchValue(void 0);
	} catch {
		throw new Error("Dynamic catch values are not supported in JSON Schema");
	}
	json.default = catchValue;
};
const pipeProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	const innerType = ctx.io === "input" ? def.in._zod.def.type === "transform" ? def.out : def.in : def.out;
	process$1(innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = innerType;
};
const readonlyProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.readOnly = true;
};
const promiseProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
const optionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
const lazyProcessor = (schema, ctx, _json, params) => {
	const innerType = schema._zod.innerType;
	process$1(innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = innerType;
};
const allProcessors = {
	string: stringProcessor,
	number: numberProcessor,
	boolean: booleanProcessor,
	bigint: bigintProcessor,
	symbol: symbolProcessor,
	null: nullProcessor,
	undefined: undefinedProcessor,
	void: voidProcessor,
	never: neverProcessor,
	any: anyProcessor,
	unknown: unknownProcessor,
	date: dateProcessor,
	enum: enumProcessor,
	literal: literalProcessor,
	nan: nanProcessor,
	template_literal: templateLiteralProcessor,
	file: fileProcessor,
	success: successProcessor,
	custom: customProcessor,
	function: functionProcessor,
	transform: transformProcessor,
	map: mapProcessor,
	set: setProcessor,
	array: arrayProcessor,
	object: objectProcessor,
	union: unionProcessor,
	intersection: intersectionProcessor,
	tuple: tupleProcessor,
	record: recordProcessor,
	nullable: nullableProcessor,
	nonoptional: nonoptionalProcessor,
	default: defaultProcessor,
	prefault: prefaultProcessor,
	catch: catchProcessor,
	pipe: pipeProcessor,
	readonly: readonlyProcessor,
	promise: promiseProcessor,
	optional: optionalProcessor,
	lazy: lazyProcessor
};
function toJSONSchema(input, params) {
	if ("_idmap" in input) {
		const registry = input;
		const ctx = initializeContext({
			...params,
			processors: allProcessors
		});
		const defs = {};
		for (const entry of registry._idmap.entries()) {
			const [_, schema] = entry;
			process$1(schema, ctx);
		}
		const schemas = {};
		ctx.external = {
			registry,
			uri: params?.uri,
			defs
		};
		for (const entry of registry._idmap.entries()) {
			const [key, schema] = entry;
			extractDefs(ctx, schema);
			schemas[key] = finalize(ctx, schema);
		}
		if (Object.keys(defs).length > 0) schemas.__shared = { [ctx.target === "draft-2020-12" ? "$defs" : "definitions"]: defs };
		return { schemas };
	}
	const ctx = initializeContext({
		...params,
		processors: allProcessors
	});
	process$1(input, ctx);
	extractDefs(ctx, input);
	return finalize(ctx, input);
}
//#endregion
//#region node_modules/zod/v4/classic/iso.js
const ZodISODateTime = /*@__PURE__*/ $constructor("ZodISODateTime", (inst, def) => {
	$ZodISODateTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function datetime(params) {
	return /* @__PURE__ */ _isoDateTime(ZodISODateTime, params);
}
const ZodISODate = /*@__PURE__*/ $constructor("ZodISODate", (inst, def) => {
	$ZodISODate.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function date(params) {
	return /* @__PURE__ */ _isoDate(ZodISODate, params);
}
const ZodISOTime = /*@__PURE__*/ $constructor("ZodISOTime", (inst, def) => {
	$ZodISOTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function time(params) {
	return /* @__PURE__ */ _isoTime(ZodISOTime, params);
}
const ZodISODuration = /*@__PURE__*/ $constructor("ZodISODuration", (inst, def) => {
	$ZodISODuration.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function duration(params) {
	return /* @__PURE__ */ _isoDuration(ZodISODuration, params);
}
//#endregion
//#region node_modules/zod/v4/classic/errors.js
const initializer = (inst, issues) => {
	$ZodError.init(inst, issues);
	inst.name = "ZodError";
	Object.defineProperties(inst, {
		format: { value: (mapper) => formatError(inst, mapper) },
		flatten: { value: (mapper) => flattenError(inst, mapper) },
		addIssue: { value: (issue) => {
			inst.issues.push(issue);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		addIssues: { value: (issues) => {
			inst.issues.push(...issues);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		isEmpty: { get() {
			return inst.issues.length === 0;
		} }
	});
};
$constructor("ZodError", initializer);
const ZodRealError = $constructor("ZodError", initializer, { Parent: Error });
//#endregion
//#region node_modules/zod/v4/classic/parse.js
const parse = /* @__PURE__ */ _parse$1(ZodRealError);
const parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
const safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
const safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
const encode = /* @__PURE__ */ _encode(ZodRealError);
const decode = /* @__PURE__ */ _decode(ZodRealError);
const encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
const decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
const safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
const safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
const safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
const safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
//#endregion
//#region node_modules/zod/v4/classic/schemas.js
const ZodType = /*@__PURE__*/ $constructor("ZodType", (inst, def) => {
	$ZodType.init(inst, def);
	Object.assign(inst["~standard"], { jsonSchema: {
		input: createStandardJSONSchemaMethod(inst, "input"),
		output: createStandardJSONSchemaMethod(inst, "output")
	} });
	inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
	inst.def = def;
	inst.type = def.type;
	Object.defineProperty(inst, "_def", { value: def });
	inst.check = (...checks) => {
		return inst.clone(mergeDefs(def, { checks: [...def.checks ?? [], ...checks.map((ch) => typeof ch === "function" ? { _zod: {
			check: ch,
			def: { check: "custom" },
			onattach: []
		} } : ch)] }), { parent: true });
	};
	inst.with = inst.check;
	inst.clone = (def, params) => clone(inst, def, params);
	inst.brand = () => inst;
	inst.register = ((reg, meta) => {
		reg.add(inst, meta);
		return inst;
	});
	inst.parse = (data, params) => parse(inst, data, params, { callee: inst.parse });
	inst.safeParse = (data, params) => safeParse(inst, data, params);
	inst.parseAsync = async (data, params) => parseAsync(inst, data, params, { callee: inst.parseAsync });
	inst.safeParseAsync = async (data, params) => safeParseAsync(inst, data, params);
	inst.spa = inst.safeParseAsync;
	inst.encode = (data, params) => encode(inst, data, params);
	inst.decode = (data, params) => decode(inst, data, params);
	inst.encodeAsync = async (data, params) => encodeAsync(inst, data, params);
	inst.decodeAsync = async (data, params) => decodeAsync(inst, data, params);
	inst.safeEncode = (data, params) => safeEncode(inst, data, params);
	inst.safeDecode = (data, params) => safeDecode(inst, data, params);
	inst.safeEncodeAsync = async (data, params) => safeEncodeAsync(inst, data, params);
	inst.safeDecodeAsync = async (data, params) => safeDecodeAsync(inst, data, params);
	inst.refine = (check, params) => inst.check(refine(check, params));
	inst.superRefine = (refinement) => inst.check(superRefine(refinement));
	inst.overwrite = (fn) => inst.check(/* @__PURE__ */ _overwrite(fn));
	inst.optional = () => optional(inst);
	inst.exactOptional = () => exactOptional(inst);
	inst.nullable = () => nullable(inst);
	inst.nullish = () => optional(nullable(inst));
	inst.nonoptional = (params) => nonoptional(inst, params);
	inst.array = () => array(inst);
	inst.or = (arg) => union([inst, arg]);
	inst.and = (arg) => intersection(inst, arg);
	inst.transform = (tx) => pipe(inst, transform(tx));
	inst.default = (def) => _default(inst, def);
	inst.prefault = (def) => prefault(inst, def);
	inst.catch = (params) => _catch(inst, params);
	inst.pipe = (target) => pipe(inst, target);
	inst.readonly = () => readonly(inst);
	inst.describe = (description) => {
		const cl = inst.clone();
		globalRegistry.add(cl, { description });
		return cl;
	};
	Object.defineProperty(inst, "description", {
		get() {
			return globalRegistry.get(inst)?.description;
		},
		configurable: true
	});
	inst.meta = (...args) => {
		if (args.length === 0) return globalRegistry.get(inst);
		const cl = inst.clone();
		globalRegistry.add(cl, args[0]);
		return cl;
	};
	inst.isOptional = () => inst.safeParse(void 0).success;
	inst.isNullable = () => inst.safeParse(null).success;
	inst.apply = (fn) => fn(inst);
	return inst;
});
/** @internal */
const _ZodString = /*@__PURE__*/ $constructor("_ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
	const bag = inst._zod.bag;
	inst.format = bag.format ?? null;
	inst.minLength = bag.minimum ?? null;
	inst.maxLength = bag.maximum ?? null;
	inst.regex = (...args) => inst.check(/* @__PURE__ */ _regex(...args));
	inst.includes = (...args) => inst.check(/* @__PURE__ */ _includes(...args));
	inst.startsWith = (...args) => inst.check(/* @__PURE__ */ _startsWith(...args));
	inst.endsWith = (...args) => inst.check(/* @__PURE__ */ _endsWith(...args));
	inst.min = (...args) => inst.check(/* @__PURE__ */ _minLength(...args));
	inst.max = (...args) => inst.check(/* @__PURE__ */ _maxLength(...args));
	inst.length = (...args) => inst.check(/* @__PURE__ */ _length(...args));
	inst.nonempty = (...args) => inst.check(/* @__PURE__ */ _minLength(1, ...args));
	inst.lowercase = (params) => inst.check(/* @__PURE__ */ _lowercase(params));
	inst.uppercase = (params) => inst.check(/* @__PURE__ */ _uppercase(params));
	inst.trim = () => inst.check(/* @__PURE__ */ _trim());
	inst.normalize = (...args) => inst.check(/* @__PURE__ */ _normalize(...args));
	inst.toLowerCase = () => inst.check(/* @__PURE__ */ _toLowerCase());
	inst.toUpperCase = () => inst.check(/* @__PURE__ */ _toUpperCase());
	inst.slugify = () => inst.check(/* @__PURE__ */ _slugify());
});
const ZodString = /*@__PURE__*/ $constructor("ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	_ZodString.init(inst, def);
	inst.email = (params) => inst.check(/* @__PURE__ */ _email(ZodEmail, params));
	inst.url = (params) => inst.check(/* @__PURE__ */ _url(ZodURL, params));
	inst.jwt = (params) => inst.check(/* @__PURE__ */ _jwt(ZodJWT, params));
	inst.emoji = (params) => inst.check(/* @__PURE__ */ _emoji(ZodEmoji, params));
	inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
	inst.uuid = (params) => inst.check(/* @__PURE__ */ _uuid(ZodUUID, params));
	inst.uuidv4 = (params) => inst.check(/* @__PURE__ */ _uuidv4(ZodUUID, params));
	inst.uuidv6 = (params) => inst.check(/* @__PURE__ */ _uuidv6(ZodUUID, params));
	inst.uuidv7 = (params) => inst.check(/* @__PURE__ */ _uuidv7(ZodUUID, params));
	inst.nanoid = (params) => inst.check(/* @__PURE__ */ _nanoid(ZodNanoID, params));
	inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
	inst.cuid = (params) => inst.check(/* @__PURE__ */ _cuid(ZodCUID, params));
	inst.cuid2 = (params) => inst.check(/* @__PURE__ */ _cuid2(ZodCUID2, params));
	inst.ulid = (params) => inst.check(/* @__PURE__ */ _ulid(ZodULID, params));
	inst.base64 = (params) => inst.check(/* @__PURE__ */ _base64(ZodBase64, params));
	inst.base64url = (params) => inst.check(/* @__PURE__ */ _base64url(ZodBase64URL, params));
	inst.xid = (params) => inst.check(/* @__PURE__ */ _xid(ZodXID, params));
	inst.ksuid = (params) => inst.check(/* @__PURE__ */ _ksuid(ZodKSUID, params));
	inst.ipv4 = (params) => inst.check(/* @__PURE__ */ _ipv4(ZodIPv4, params));
	inst.ipv6 = (params) => inst.check(/* @__PURE__ */ _ipv6(ZodIPv6, params));
	inst.cidrv4 = (params) => inst.check(/* @__PURE__ */ _cidrv4(ZodCIDRv4, params));
	inst.cidrv6 = (params) => inst.check(/* @__PURE__ */ _cidrv6(ZodCIDRv6, params));
	inst.e164 = (params) => inst.check(/* @__PURE__ */ _e164(ZodE164, params));
	inst.datetime = (params) => inst.check(datetime(params));
	inst.date = (params) => inst.check(date(params));
	inst.time = (params) => inst.check(time(params));
	inst.duration = (params) => inst.check(duration(params));
});
function string(params) {
	return /* @__PURE__ */ _string(ZodString, params);
}
const ZodStringFormat = /*@__PURE__*/ $constructor("ZodStringFormat", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	_ZodString.init(inst, def);
});
const ZodEmail = /*@__PURE__*/ $constructor("ZodEmail", (inst, def) => {
	$ZodEmail.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodGUID = /*@__PURE__*/ $constructor("ZodGUID", (inst, def) => {
	$ZodGUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodUUID = /*@__PURE__*/ $constructor("ZodUUID", (inst, def) => {
	$ZodUUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodURL = /*@__PURE__*/ $constructor("ZodURL", (inst, def) => {
	$ZodURL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodEmoji = /*@__PURE__*/ $constructor("ZodEmoji", (inst, def) => {
	$ZodEmoji.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNanoID = /*@__PURE__*/ $constructor("ZodNanoID", (inst, def) => {
	$ZodNanoID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCUID = /*@__PURE__*/ $constructor("ZodCUID", (inst, def) => {
	$ZodCUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCUID2 = /*@__PURE__*/ $constructor("ZodCUID2", (inst, def) => {
	$ZodCUID2.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodULID = /*@__PURE__*/ $constructor("ZodULID", (inst, def) => {
	$ZodULID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodXID = /*@__PURE__*/ $constructor("ZodXID", (inst, def) => {
	$ZodXID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodKSUID = /*@__PURE__*/ $constructor("ZodKSUID", (inst, def) => {
	$ZodKSUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv4 = /*@__PURE__*/ $constructor("ZodIPv4", (inst, def) => {
	$ZodIPv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv6 = /*@__PURE__*/ $constructor("ZodIPv6", (inst, def) => {
	$ZodIPv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv4 = /*@__PURE__*/ $constructor("ZodCIDRv4", (inst, def) => {
	$ZodCIDRv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv6 = /*@__PURE__*/ $constructor("ZodCIDRv6", (inst, def) => {
	$ZodCIDRv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64 = /*@__PURE__*/ $constructor("ZodBase64", (inst, def) => {
	$ZodBase64.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64URL = /*@__PURE__*/ $constructor("ZodBase64URL", (inst, def) => {
	$ZodBase64URL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodE164 = /*@__PURE__*/ $constructor("ZodE164", (inst, def) => {
	$ZodE164.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodJWT = /*@__PURE__*/ $constructor("ZodJWT", (inst, def) => {
	$ZodJWT.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNumber = /*@__PURE__*/ $constructor("ZodNumber", (inst, def) => {
	$ZodNumber.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
	inst.gt = (value, params) => inst.check(/* @__PURE__ */ _gt(value, params));
	inst.gte = (value, params) => inst.check(/* @__PURE__ */ _gte(value, params));
	inst.min = (value, params) => inst.check(/* @__PURE__ */ _gte(value, params));
	inst.lt = (value, params) => inst.check(/* @__PURE__ */ _lt(value, params));
	inst.lte = (value, params) => inst.check(/* @__PURE__ */ _lte(value, params));
	inst.max = (value, params) => inst.check(/* @__PURE__ */ _lte(value, params));
	inst.int = (params) => inst.check(int(params));
	inst.safe = (params) => inst.check(int(params));
	inst.positive = (params) => inst.check(/* @__PURE__ */ _gt(0, params));
	inst.nonnegative = (params) => inst.check(/* @__PURE__ */ _gte(0, params));
	inst.negative = (params) => inst.check(/* @__PURE__ */ _lt(0, params));
	inst.nonpositive = (params) => inst.check(/* @__PURE__ */ _lte(0, params));
	inst.multipleOf = (value, params) => inst.check(/* @__PURE__ */ _multipleOf(value, params));
	inst.step = (value, params) => inst.check(/* @__PURE__ */ _multipleOf(value, params));
	inst.finite = () => inst;
	const bag = inst._zod.bag;
	inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
	inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
	inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? .5);
	inst.isFinite = true;
	inst.format = bag.format ?? null;
});
function number(params) {
	return /* @__PURE__ */ _number(ZodNumber, params);
}
const ZodNumberFormat = /*@__PURE__*/ $constructor("ZodNumberFormat", (inst, def) => {
	$ZodNumberFormat.init(inst, def);
	ZodNumber.init(inst, def);
});
function int(params) {
	return /* @__PURE__ */ _int(ZodNumberFormat, params);
}
const ZodBoolean = /*@__PURE__*/ $constructor("ZodBoolean", (inst, def) => {
	$ZodBoolean.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean(params) {
	return /* @__PURE__ */ _boolean(ZodBoolean, params);
}
const ZodNull = /*@__PURE__*/ $constructor("ZodNull", (inst, def) => {
	$ZodNull.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nullProcessor(inst, ctx, json, params);
});
function _null(params) {
	return /* @__PURE__ */ _null$1(ZodNull, params);
}
const ZodAny = /*@__PURE__*/ $constructor("ZodAny", (inst, def) => {
	$ZodAny.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => void 0;
});
function any() {
	return /* @__PURE__ */ _any(ZodAny);
}
const ZodUnknown = /*@__PURE__*/ $constructor("ZodUnknown", (inst, def) => {
	$ZodUnknown.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => void 0;
});
function unknown() {
	return /* @__PURE__ */ _unknown(ZodUnknown);
}
const ZodNever = /*@__PURE__*/ $constructor("ZodNever", (inst, def) => {
	$ZodNever.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
	return /* @__PURE__ */ _never(ZodNever, params);
}
const ZodArray = /*@__PURE__*/ $constructor("ZodArray", (inst, def) => {
	$ZodArray.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
	inst.element = def.element;
	inst.min = (minLength, params) => inst.check(/* @__PURE__ */ _minLength(minLength, params));
	inst.nonempty = (params) => inst.check(/* @__PURE__ */ _minLength(1, params));
	inst.max = (maxLength, params) => inst.check(/* @__PURE__ */ _maxLength(maxLength, params));
	inst.length = (len, params) => inst.check(/* @__PURE__ */ _length(len, params));
	inst.unwrap = () => inst.element;
});
function array(element, params) {
	return /* @__PURE__ */ _array(ZodArray, element, params);
}
const ZodObject = /*@__PURE__*/ $constructor("ZodObject", (inst, def) => {
	$ZodObjectJIT.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
	defineLazy(inst, "shape", () => {
		return def.shape;
	});
	inst.keyof = () => _enum(Object.keys(inst._zod.def.shape));
	inst.catchall = (catchall) => inst.clone({
		...inst._zod.def,
		catchall
	});
	inst.passthrough = () => inst.clone({
		...inst._zod.def,
		catchall: unknown()
	});
	inst.loose = () => inst.clone({
		...inst._zod.def,
		catchall: unknown()
	});
	inst.strict = () => inst.clone({
		...inst._zod.def,
		catchall: never()
	});
	inst.strip = () => inst.clone({
		...inst._zod.def,
		catchall: void 0
	});
	inst.extend = (incoming) => {
		return extend(inst, incoming);
	};
	inst.safeExtend = (incoming) => {
		return safeExtend(inst, incoming);
	};
	inst.merge = (other) => merge(inst, other);
	inst.pick = (mask) => pick(inst, mask);
	inst.omit = (mask) => omit(inst, mask);
	inst.partial = (...args) => partial(ZodOptional, inst, args[0]);
	inst.required = (...args) => required(ZodNonOptional, inst, args[0]);
});
function object(shape, params) {
	const def = {
		type: "object",
		shape: shape ?? {},
		...normalizeParams(params)
	};
	return new ZodObject(def);
}
function looseObject(shape, params) {
	return new ZodObject({
		type: "object",
		shape,
		catchall: unknown(),
		...normalizeParams(params)
	});
}
const ZodUnion = /*@__PURE__*/ $constructor("ZodUnion", (inst, def) => {
	$ZodUnion.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
	inst.options = def.options;
});
function union(options, params) {
	return new ZodUnion({
		type: "union",
		options,
		...normalizeParams(params)
	});
}
const ZodDiscriminatedUnion = /*@__PURE__*/ $constructor("ZodDiscriminatedUnion", (inst, def) => {
	ZodUnion.init(inst, def);
	$ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
	return new ZodDiscriminatedUnion({
		type: "union",
		options,
		discriminator,
		...normalizeParams(params)
	});
}
const ZodIntersection = /*@__PURE__*/ $constructor("ZodIntersection", (inst, def) => {
	$ZodIntersection.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
	return new ZodIntersection({
		type: "intersection",
		left,
		right
	});
}
const ZodRecord = /*@__PURE__*/ $constructor("ZodRecord", (inst, def) => {
	$ZodRecord.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
	inst.keyType = def.keyType;
	inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
	return new ZodRecord({
		type: "record",
		keyType,
		valueType,
		...normalizeParams(params)
	});
}
const ZodEnum = /*@__PURE__*/ $constructor("ZodEnum", (inst, def) => {
	$ZodEnum.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
	inst.enum = def.entries;
	inst.options = Object.values(def.entries);
	const keys = new Set(Object.keys(def.entries));
	inst.extract = (values, params) => {
		const newEntries = {};
		for (const value of values) if (keys.has(value)) newEntries[value] = def.entries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
	inst.exclude = (values, params) => {
		const newEntries = { ...def.entries };
		for (const value of values) if (keys.has(value)) delete newEntries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
});
function _enum(values, params) {
	const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
	return new ZodEnum({
		type: "enum",
		entries,
		...normalizeParams(params)
	});
}
const ZodLiteral = /*@__PURE__*/ $constructor("ZodLiteral", (inst, def) => {
	$ZodLiteral.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
	inst.values = new Set(def.values);
	Object.defineProperty(inst, "value", { get() {
		if (def.values.length > 1) throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
		return def.values[0];
	} });
});
function literal(value, params) {
	return new ZodLiteral({
		type: "literal",
		values: Array.isArray(value) ? value : [value],
		...normalizeParams(params)
	});
}
const ZodTransform = /*@__PURE__*/ $constructor("ZodTransform", (inst, def) => {
	$ZodTransform.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
	inst._zod.parse = (payload, _ctx) => {
		if (_ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		payload.addIssue = (issue$1) => {
			if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, def));
			else {
				const _issue = issue$1;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = inst);
				payload.issues.push(issue(_issue));
			}
		};
		const output = def.transform(payload.value, payload);
		if (output instanceof Promise) return output.then((output) => {
			payload.value = output;
			return payload;
		});
		payload.value = output;
		return payload;
	};
});
function transform(fn) {
	return new ZodTransform({
		type: "transform",
		transform: fn
	});
}
const ZodOptional = /*@__PURE__*/ $constructor("ZodOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
	return new ZodOptional({
		type: "optional",
		innerType
	});
}
const ZodExactOptional = /*@__PURE__*/ $constructor("ZodExactOptional", (inst, def) => {
	$ZodExactOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
	return new ZodExactOptional({
		type: "optional",
		innerType
	});
}
const ZodNullable = /*@__PURE__*/ $constructor("ZodNullable", (inst, def) => {
	$ZodNullable.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
	return new ZodNullable({
		type: "nullable",
		innerType
	});
}
const ZodDefault = /*@__PURE__*/ $constructor("ZodDefault", (inst, def) => {
	$ZodDefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
	return new ZodDefault({
		type: "default",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodPrefault = /*@__PURE__*/ $constructor("ZodPrefault", (inst, def) => {
	$ZodPrefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
	return new ZodPrefault({
		type: "prefault",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodNonOptional = /*@__PURE__*/ $constructor("ZodNonOptional", (inst, def) => {
	$ZodNonOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
	return new ZodNonOptional({
		type: "nonoptional",
		innerType,
		...normalizeParams(params)
	});
}
const ZodCatch = /*@__PURE__*/ $constructor("ZodCatch", (inst, def) => {
	$ZodCatch.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
	return new ZodCatch({
		type: "catch",
		innerType,
		catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
	});
}
const ZodPipe = /*@__PURE__*/ $constructor("ZodPipe", (inst, def) => {
	$ZodPipe.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
	inst.in = def.in;
	inst.out = def.out;
});
function pipe(in_, out) {
	return new ZodPipe({
		type: "pipe",
		in: in_,
		out
	});
}
const ZodReadonly = /*@__PURE__*/ $constructor("ZodReadonly", (inst, def) => {
	$ZodReadonly.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
	return new ZodReadonly({
		type: "readonly",
		innerType
	});
}
const ZodLazy = /*@__PURE__*/ $constructor("ZodLazy", (inst, def) => {
	$ZodLazy.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => lazyProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.getter();
});
function lazy(getter) {
	return new ZodLazy({
		type: "lazy",
		getter
	});
}
const ZodCustom = /*@__PURE__*/ $constructor("ZodCustom", (inst, def) => {
	$ZodCustom.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function custom(fn, _params) {
	return /* @__PURE__ */ _custom(ZodCustom, fn ?? (() => true), _params);
}
function refine(fn, _params = {}) {
	return /* @__PURE__ */ _refine(ZodCustom, fn, _params);
}
function superRefine(fn) {
	return /* @__PURE__ */ _superRefine(fn);
}
function _instanceof(cls, params = {}) {
	const inst = new ZodCustom({
		type: "custom",
		check: "custom",
		fn: (data) => data instanceof cls,
		abort: true,
		...normalizeParams(params)
	});
	inst._zod.bag.Class = cls;
	inst._zod.check = (payload) => {
		if (!(payload.value instanceof cls)) payload.issues.push({
			code: "invalid_type",
			expected: cls.name,
			input: payload.value,
			inst,
			path: [...inst._zod.def.path ?? []]
		});
	};
	return inst;
}
function json(params) {
	const jsonSchema = lazy(() => {
		return union([
			string(params),
			number(),
			boolean(),
			_null(),
			array(jsonSchema),
			record(string(), jsonSchema)
		]);
	});
	return jsonSchema;
}
//#endregion
//#region node_modules/eventsource-parser/dist/index.js
var ParseError = class extends Error {
	constructor(message, options) {
		super(message), this.name = "ParseError", this.type = options.type, this.field = options.field, this.value = options.value, this.line = options.line;
	}
};
const LF = 10;
const CR = 13;
const SPACE = 32;
function noop(_arg) {}
function createParser(config) {
	if (typeof config == "function") throw new TypeError("`config` must be an object, got a function instead. Did you mean `createParser({onEvent: fn})`?");
	const { onEvent = noop, onError = noop, onRetry = noop, onComment, maxBufferSize } = config, pendingFragments = [];
	let pendingFragmentsLength = 0, isFirstChunk = !0, id, data = "", dataLines = 0, eventType, terminated = !1;
	function feed(chunk) {
		if (terminated) throw new Error("Cannot feed parser: it was terminated after exceeding the configured max buffer size. Call `reset()` to resume parsing.");
		if (isFirstChunk && (isFirstChunk = !1, chunk.charCodeAt(0) === 239 && chunk.charCodeAt(1) === 187 && chunk.charCodeAt(2) === 191 && (chunk = chunk.slice(3))), pendingFragments.length === 0) {
			const trailing2 = processLines(chunk);
			trailing2 !== "" && (pendingFragments.push(trailing2), pendingFragmentsLength = trailing2.length), checkBufferSize();
			return;
		}
		if (chunk.indexOf(`
`) === -1 && chunk.indexOf("\r") === -1) {
			pendingFragments.push(chunk), pendingFragmentsLength += chunk.length, checkBufferSize();
			return;
		}
		pendingFragments.push(chunk);
		const input = pendingFragments.join("");
		pendingFragments.length = 0, pendingFragmentsLength = 0;
		const trailing = processLines(input);
		trailing !== "" && (pendingFragments.push(trailing), pendingFragmentsLength = trailing.length), checkBufferSize();
	}
	function checkBufferSize() {
		maxBufferSize !== void 0 && (pendingFragmentsLength + data.length <= maxBufferSize || (terminated = !0, pendingFragments.length = 0, pendingFragmentsLength = 0, id = void 0, data = "", dataLines = 0, eventType = void 0, onError(new ParseError(`Buffered data exceeded max buffer size of ${maxBufferSize} characters`, { type: "max-buffer-size-exceeded" }))));
	}
	function processLines(chunk) {
		let searchIndex = 0;
		if (chunk.indexOf("\r") === -1) {
			let lfIndex = chunk.indexOf(`
`, searchIndex);
			for (; lfIndex !== -1;) {
				if (searchIndex === lfIndex) {
					dataLines > 0 && onEvent({
						id,
						event: eventType,
						data
					}), id = void 0, data = "", dataLines = 0, eventType = void 0, searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
					continue;
				}
				const firstCharCode = chunk.charCodeAt(searchIndex);
				if (isDataPrefix(chunk, searchIndex, firstCharCode)) {
					const valueStart = chunk.charCodeAt(searchIndex + 5) === SPACE ? searchIndex + 6 : searchIndex + 5, value = chunk.slice(valueStart, lfIndex);
					if (dataLines === 0 && chunk.charCodeAt(lfIndex + 1) === LF) {
						onEvent({
							id,
							event: eventType,
							data: value
						}), id = void 0, data = "", eventType = void 0, searchIndex = lfIndex + 2, lfIndex = chunk.indexOf(`
`, searchIndex);
						continue;
					}
					data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
				} else isEventPrefix(chunk, searchIndex, firstCharCode) ? eventType = chunk.slice(chunk.charCodeAt(searchIndex + 6) === SPACE ? searchIndex + 7 : searchIndex + 6, lfIndex) || void 0 : parseLine(chunk, searchIndex, lfIndex);
				searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
			}
			return chunk.slice(searchIndex);
		}
		for (; searchIndex < chunk.length;) {
			const crIndex = chunk.indexOf("\r", searchIndex), lfIndex = chunk.indexOf(`
`, searchIndex);
			let lineEnd = -1;
			if (crIndex !== -1 && lfIndex !== -1 ? lineEnd = crIndex < lfIndex ? crIndex : lfIndex : crIndex !== -1 ? crIndex === chunk.length - 1 ? lineEnd = -1 : lineEnd = crIndex : lfIndex !== -1 && (lineEnd = lfIndex), lineEnd === -1) break;
			parseLine(chunk, searchIndex, lineEnd), searchIndex = lineEnd + 1, chunk.charCodeAt(searchIndex - 1) === CR && chunk.charCodeAt(searchIndex) === LF && searchIndex++;
		}
		return chunk.slice(searchIndex);
	}
	function parseLine(chunk, start, end) {
		if (start === end) {
			dispatchEvent();
			return;
		}
		const firstCharCode = chunk.charCodeAt(start);
		if (isDataPrefix(chunk, start, firstCharCode)) {
			const valueStart = chunk.charCodeAt(start + 5) === SPACE ? start + 6 : start + 5, value2 = chunk.slice(valueStart, end);
			data = dataLines === 0 ? value2 : `${data}
${value2}`, dataLines++;
			return;
		}
		if (isEventPrefix(chunk, start, firstCharCode)) {
			eventType = chunk.slice(chunk.charCodeAt(start + 6) === SPACE ? start + 7 : start + 6, end) || void 0;
			return;
		}
		if (firstCharCode === 105 && chunk.charCodeAt(start + 1) === 100 && chunk.charCodeAt(start + 2) === 58) {
			const value2 = chunk.slice(chunk.charCodeAt(start + 3) === SPACE ? start + 4 : start + 3, end);
			id = value2.includes("\0") ? void 0 : value2;
			return;
		}
		if (firstCharCode === 58) {
			if (onComment) {
				const line2 = chunk.slice(start, end);
				onComment(line2.slice(chunk.charCodeAt(start + 1) === SPACE ? 2 : 1));
			}
			return;
		}
		const line = chunk.slice(start, end), fieldSeparatorIndex = line.indexOf(":");
		if (fieldSeparatorIndex === -1) {
			processField(line, "", line);
			return;
		}
		const field = line.slice(0, fieldSeparatorIndex), offset = line.charCodeAt(fieldSeparatorIndex + 1) === SPACE ? 2 : 1;
		processField(field, line.slice(fieldSeparatorIndex + offset), line);
	}
	function processField(field, value, line) {
		switch (field) {
			case "event":
				eventType = value || void 0;
				break;
			case "data":
				data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
				break;
			case "id":
				id = value.includes("\0") ? void 0 : value;
				break;
			case "retry":
				/^\d+$/.test(value) ? onRetry(parseInt(value, 10)) : onError(new ParseError(`Invalid \`retry\` value: "${value}"`, {
					type: "invalid-retry",
					value,
					line
				}));
				break;
			default: onError(new ParseError(`Unknown field "${field.length > 20 ? `${field.slice(0, 20)}\u2026` : field}"`, {
				type: "unknown-field",
				field,
				value,
				line
			}));
		}
	}
	function dispatchEvent() {
		dataLines > 0 && onEvent({
			id,
			event: eventType,
			data
		}), id = void 0, data = "", dataLines = 0, eventType = void 0;
	}
	function reset(options = {}) {
		if (options.consume && pendingFragments.length > 0) {
			const incompleteLine = pendingFragments.join("");
			parseLine(incompleteLine, 0, incompleteLine.length);
		}
		isFirstChunk = !0, id = void 0, data = "", dataLines = 0, eventType = void 0, pendingFragments.length = 0, pendingFragmentsLength = 0, terminated = !1;
	}
	return {
		feed,
		reset
	};
}
function isDataPrefix(chunk, i, firstCharCode) {
	return firstCharCode === 100 && chunk.charCodeAt(i + 1) === 97 && chunk.charCodeAt(i + 2) === 116 && chunk.charCodeAt(i + 3) === 97 && chunk.charCodeAt(i + 4) === 58;
}
function isEventPrefix(chunk, i, firstCharCode) {
	return firstCharCode === 101 && chunk.charCodeAt(i + 1) === 118 && chunk.charCodeAt(i + 2) === 101 && chunk.charCodeAt(i + 3) === 110 && chunk.charCodeAt(i + 4) === 116 && chunk.charCodeAt(i + 5) === 58;
}
//#endregion
//#region node_modules/eventsource-parser/dist/stream.js
var EventSourceParserStream = class extends TransformStream {
	constructor({ onError, onRetry, onComment, maxBufferSize } = {}) {
		let parser;
		super({
			start(controller) {
				parser = createParser({
					onEvent: (event) => {
						controller.enqueue(event);
					},
					onError(error) {
						typeof onError == "function" && onError(error), (onError === "terminate" || error.type === "max-buffer-size-exceeded") && controller.error(error);
					},
					onRetry,
					onComment,
					maxBufferSize
				});
			},
			transform(chunk) {
				parser.feed(chunk);
			}
		});
	}
};
//#endregion
//#region node_modules/@ai-sdk/gateway/node_modules/@workflow/serde/dist/index.js
/**
* Symbol used to define custom serialization for user-defined class instances.
* The static method should accept an instance and return serializable data.
*
* @example
* ```ts
* import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
*
* class MyClass {
*   constructor(public value: string) {}
*
*   static [WORKFLOW_SERIALIZE](instance: MyClass) {
*     return { value: instance.value };
*   }
*
*   static [WORKFLOW_DESERIALIZE](data: { value: string }) {
*     return new MyClass(data.value);
*   }
* }
* ```
*/
const WORKFLOW_SERIALIZE = Symbol.for("workflow-serialize");
/**
* Symbol used to define custom deserialization for user-defined class instances.
* The static method should accept serialized data and return a class instance.
*
* @see WORKFLOW_SERIALIZE for usage example
*/
const WORKFLOW_DESERIALIZE = Symbol.for("workflow-deserialize");
//#endregion
//#region node_modules/@ai-sdk/gateway/node_modules/@ai-sdk/provider-utils/dist/index.js
function combineHeaders(...headers) {
	return headers.reduce((combinedHeaders, currentHeaders) => ({
		...combinedHeaders,
		...currentHeaders
	}), {});
}
/**
* Removes entries from a record where the value is null or undefined.
* @param record - The input object whose entries may be null or undefined.
* @returns A new object containing only entries with non-null and non-undefined values.
*/
function removeUndefinedEntries(record) {
	return Object.fromEntries(Object.entries(record).filter(([_key, value]) => value != null));
}
/**
* Creates a Promise that resolves after a specified delay
* @param delayInMs - The delay duration in milliseconds. If null or undefined, resolves immediately.
* @param signal - Optional AbortSignal to cancel the delay
* @returns A Promise that resolves after the specified delay
* @throws {DOMException} When the signal is aborted
*/
async function delay(delayInMs, options) {
	if (delayInMs == null) return;
	const signal = options?.abortSignal;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}
		const timeoutId = setTimeout(() => {
			cleanup();
			resolve();
		}, delayInMs);
		const cleanup = () => {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(createAbortError());
		};
		signal?.addEventListener("abort", onAbort);
	});
}
function createAbortError() {
	return new DOMException("Delay was aborted", "AbortError");
}
function getWebSocketConstructor(webSocket) {
	const WebSocketConstructor = webSocket ?? globalThis.WebSocket;
	if (WebSocketConstructor == null) throw new Error("No WebSocket implementation available.");
	return WebSocketConstructor;
}
const textDecoder$1 = new TextDecoder();
/**
* Reads WebSocket message data as text, handling string, binary,
* and Blob payloads.
*/
async function readWebSocketMessageText(data) {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return textDecoder$1.decode(data);
	if (ArrayBuffer.isView(data)) return textDecoder$1.decode(data);
	if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
	return String(data);
}
const WEBSOCKET_OPEN_STATE = 1;
/**
* Waits until the socket's send buffer drains below `highWaterMark` bytes.
* No-op for implementations that do not expose `bufferedAmount`. There is no
* portable drain event, so this polls. Returns as soon as the socket is no
* longer open or the signal aborts — `bufferedAmount` never drains on a
* closed socket, so waiting on would poll forever.
*/
async function waitForWebSocketBufferDrain(socket, { highWaterMark = 1048576, pollIntervalMs = 20, abortSignal } = {}) {
	while (socket.readyState === WEBSOCKET_OPEN_STATE && (socket.bufferedAmount ?? 0) > highWaterMark) {
		if (abortSignal?.aborted === true) return;
		await delay(pollIntervalMs);
	}
}
/**
* Opens a WebSocket for a provider model, owning the transport-generic layer
* (analogous to `postToApi` for HTTP): constructor resolution, header hygiene,
* abort wiring, and message decoding. Callers own the URL, the auth channel
* (subprotocols vs headers), and the wire protocol.
*/
function connectToWebSocket({ url, protocols, headers, webSocket, abortSignal, onOpen, onMessageText, onProcessingError, onSocketError, onClose, onAbort }) {
	let socket;
	let abortListener;
	const close = (code) => {
		if (abortListener != null) {
			abortSignal?.removeEventListener("abort", abortListener);
			abortListener = void 0;
		}
		try {
			socket?.close(code);
		} catch {}
	};
	if (abortSignal?.aborted) {
		onAbort?.(abortSignal.reason ?? /* @__PURE__ */ new Error("Aborted"));
		return {
			socket: void 0,
			close
		};
	}
	try {
		socket = new (getWebSocketConstructor(webSocket))(url, protocols, { headers: removeUndefinedEntries(headers ?? {}) });
	} catch (error) {
		onProcessingError(error);
		return {
			socket: void 0,
			close
		};
	}
	if (abortSignal != null && onAbort != null) {
		abortListener = () => onAbort(abortSignal.reason ?? /* @__PURE__ */ new Error("Aborted"));
		abortSignal.addEventListener("abort", abortListener, { once: true });
	}
	const openedSocket = socket;
	socket.onopen = () => {
		try {
			onOpen?.(openedSocket);
		} catch (error) {
			onProcessingError(error);
		}
	};
	let tail = Promise.resolve();
	socket.onmessage = (event) => {
		tail = tail.then(() => readWebSocketMessageText(event.data)).then((text) => onMessageText(text)).catch(onProcessingError);
	};
	socket.onerror = () => {
		tail = tail.then(() => onSocketError?.()).catch(onProcessingError);
	};
	socket.onclose = (event) => {
		const closeEvent = event;
		const code = typeof closeEvent?.code === "number" ? closeEvent.code : void 0;
		const reason = typeof closeEvent?.reason === "string" ? closeEvent.reason : void 0;
		tail = tail.then(() => onClose?.({
			code,
			reason
		})).catch(onProcessingError);
	};
	return {
		socket,
		close
	};
}
/**
* Converts an AsyncIterator to a ReadableStream.
*
* @template T - The type of elements produced by the AsyncIterator.
* @param { <T>} iterator - The AsyncIterator to convert.
* @returns {ReadableStream<T>} - A ReadableStream that provides the same data as the AsyncIterator.
*/
function convertAsyncIteratorToReadableStream(iterator) {
	let cancelled = false;
	return new ReadableStream({
		/**
		* Called when the consumer wants to pull more data from the stream.
		*
		* @param {ReadableStreamDefaultController<T>} controller - The controller to enqueue data into the stream.
		* @returns {Promise<void>}
		*/
		async pull(controller) {
			if (cancelled) return;
			try {
				const { value, done } = await iterator.next();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (error) {
				controller.error(error);
			}
		},
		/**
		* Called when the consumer cancels the stream.
		*/
		async cancel(reason) {
			cancelled = true;
			if (iterator.return) try {
				await iterator.return(reason);
			} catch {}
		}
	});
}
const { btoa: btoa$1, atob: atob$1 } = globalThis;
function convertBase64ToUint8Array(base64String) {
	const base64Url = base64String.replace(/-/g, "+").replace(/_/g, "/");
	const latin1string = atob$1(base64Url);
	return Uint8Array.from(latin1string, (byte) => byte.codePointAt(0));
}
function convertUint8ArrayToBase64(array) {
	const chunks = [];
	const chunkSize = 4096;
	for (let i = 0; i < array.length; i += chunkSize) chunks.push(String.fromCodePoint(...array.subarray(i, i + chunkSize)));
	return btoa$1(chunks.join(""));
}
/**
* Extracts the headers from a response object and returns them as a key-value object.
*
* @param response - The response object to extract headers from.
* @returns The headers as a key-value object.
*/
function extractResponseHeaders(response) {
	return Object.fromEntries([...response.headers]);
}
function getRuntimeEnvironmentUserAgent(globalThisAny = globalThis) {
	if (globalThisAny.navigator?.userAgent) return globalThisAny.navigator.userAgent.toLowerCase();
	if (globalThisAny.process?.versions?.node) return `node.js/${globalThisAny.process.version}`;
	if (globalThisAny.EdgeRuntime) return "vercel-edge";
	return "";
}
function isAbortError(error) {
	return (error instanceof Error || typeof DOMException === "function" && error instanceof DOMException) && (error.name === "AbortError" || error.name === "ResponseAborted" || error.name === "TimeoutError");
}
const FETCH_FAILED_ERROR_MESSAGES = ["fetch failed", "failed to fetch"];
const RETRYABLE_NETWORK_ERROR_CODES = /* @__PURE__ */ new Set([
	"ConnectionRefused",
	"ConnectionClosed",
	"FailedToOpenSocket",
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EPIPE",
	"UND_ERR_SOCKET",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT"
]);
function findNetworkError(error) {
	const visited = /* @__PURE__ */ new Set();
	let current = error;
	while (current instanceof Error && !visited.has(current)) {
		visited.add(current);
		const errorWithCode = current;
		if (typeof errorWithCode.code === "string" && RETRYABLE_NETWORK_ERROR_CODES.has(errorWithCode.code)) return errorWithCode;
		current = current.cause;
	}
}
function handleFetchError({ error, url, requestBodyValues }) {
	if (isAbortError(error)) return error;
	if (error instanceof TypeError && FETCH_FAILED_ERROR_MESSAGES.includes(error.message.toLowerCase())) {
		const cause = error.cause;
		if (cause != null) return new APICallError({
			message: `Cannot connect to API: ${cause.message}`,
			cause,
			url,
			requestBodyValues,
			isRetryable: true
		});
	}
	const networkError = findNetworkError(error);
	if (networkError != null) {
		if (APICallError.isInstance(error)) return new APICallError({
			message: error.message,
			cause: error.cause,
			url: error.url,
			requestBodyValues: error.requestBodyValues,
			statusCode: error.statusCode,
			responseHeaders: error.responseHeaders,
			responseBody: error.responseBody,
			data: error.data,
			isRetryable: true
		});
		return new APICallError({
			message: `Cannot connect to API: ${error instanceof Error ? error.message : networkError.message}`,
			cause: error,
			url,
			requestBodyValues,
			isRetryable: true
		});
	}
	return error;
}
/**
* Normalizes different header inputs into a plain record with lower-case keys.
* Entries with `undefined` or `null` values are removed.
*
* @param headers - Input headers (`Headers`, tuples array, plain record) to normalize.
* @returns A record containing the normalized header entries.
*/
function normalizeHeaders(headers) {
	if (headers == null) return {};
	const normalized = {};
	if (headers instanceof Headers) headers.forEach((value, key) => {
		normalized[key.toLowerCase()] = value;
	});
	else {
		if (!Array.isArray(headers)) headers = Object.entries(headers);
		for (const [key, value] of headers) if (value != null) normalized[key.toLowerCase()] = value;
	}
	return normalized;
}
/**
* Appends suffix parts to the `user-agent` header.
* If a `user-agent` header already exists, the suffix parts are appended to it.
* If no `user-agent` header exists, a new one is created with the suffix parts.
* Automatically removes undefined entries from the headers.
*
* @param headers - The original headers.
* @param userAgentSuffixParts - The parts to append to the `user-agent` header.
* @returns The new headers with the `user-agent` header set or updated.
*/
function withUserAgentSuffix(headers, ...userAgentSuffixParts) {
	const normalizedHeaders = new Headers(normalizeHeaders(headers));
	const currentUserAgentHeader = normalizedHeaders.get("user-agent") || "";
	normalizedHeaders.set("user-agent", [currentUserAgentHeader, ...userAgentSuffixParts].filter(Boolean).join(" "));
	return Object.fromEntries(normalizedHeaders.entries());
}
/**
* Cancels a response body to release the underlying connection.
*
* When a fetch Response is rejected without consuming its body (e.g. a failed
* status code, an open-redirect rejection, or a Content-Length that exceeds the
* size limit), the underlying TCP socket is not returned to the connection pool
* and may stay open until the process runs out of file descriptors. Cancelling
* the body avoids this leak.
*
* Errors thrown while cancelling are ignored: the body may already be locked,
* disturbed, or absent, none of which should mask the original rejection.
*/
async function cancelResponseBody(response) {
	try {
		await response.body?.cancel();
	} catch {}
}
const name$1$1 = "AI_DownloadError";
const marker$1$1 = `vercel.ai.error.${name$1$1}`;
const symbol$1$1 = Symbol.for(marker$1$1);
var DownloadError = class extends AISDKError {
	constructor({ url, statusCode, statusText, cause, message = cause == null ? `Failed to download ${url}: ${statusCode} ${statusText}` : `Failed to download ${url}: ${cause}` }) {
		super({
			name: name$1$1,
			message,
			cause
		});
		this[symbol$1$1] = true;
		this.url = url;
		this.statusCode = statusCode;
		this.statusText = statusText;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$1$1);
	}
};
/**
* Returns `true` when running in a browser.
*
* Detection keys on the presence of a global `window`, matching the browser
* check used elsewhere in this package (see `getRuntimeEnvironmentUserAgent`)
* so the SDK has a single, consistent definition of "browser". Server runtimes
* (Node.js, Deno, Bun, edge/workers) do not define `window`.
*/
function isBrowserRuntime(globalThisAny = globalThis) {
	return globalThisAny.window != null;
}
/**
* Returns true when `url` has the same origin (scheme + host + port) as
* `baseUrl`.
*
* Used to decide whether provider credentials may be attached to a request to a
* URL taken from a provider response (e.g. a polling or media-download URL).
* Credentials must only be sent to the provider's own origin; a response that
* names a foreign host (a CDN, or an attacker-controlled host if the response
* is tampered with) must not receive the API key.
*
* Returns false if either value is not a valid absolute URL (fail-closed).
*/
function isSameOrigin(url, baseUrl) {
	try {
		return new URL(url).origin === new URL(baseUrl).origin;
	} catch {
		return false;
	}
}
/**
* Validates that a URL is safe to download from, blocking private/internal addresses
* to prevent SSRF attacks.
*
* Note: this function performs string/literal-IP checks only. The Node.js
* download fetch additionally validates and pins DNS results at connect time.
*
* @param url - The URL string to validate.
* @throws DownloadError if the URL is unsafe.
*/
function validateDownloadUrl(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new DownloadError({
			url,
			message: `Invalid URL: ${url}`
		});
	}
	if (parsed.protocol === "data:") return;
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new DownloadError({
		url,
		message: `URL scheme must be http, https, or data, got ${parsed.protocol}`
	});
	const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
	if (!hostname) throw new DownloadError({
		url,
		message: `URL must have a hostname`
	});
	if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".localhost")) throw new DownloadError({
		url,
		message: `URL with hostname ${hostname} is not allowed`
	});
	if (hostname.startsWith("[") && hostname.endsWith("]")) {
		if (isPrivateIPv6(hostname.slice(1, -1))) throw new DownloadError({
			url,
			message: `URL with IPv6 address ${hostname} is not allowed`
		});
		return;
	}
	if (isIPv4(hostname)) {
		if (isPrivateIPv4(hostname)) throw new DownloadError({
			url,
			message: `URL with IP address ${hostname} is not allowed`
		});
	}
}
/**
* Validates an address returned by DNS before it is used to open a socket.
* This is intentionally not exported from the package entry point.
*/
function validateDownloadAddress({ address, family, hostname }) {
	if (family === 4 ? !isIPv4(address) || isPrivateIPv4(address) : family === 6 ? isPrivateIPv6(address) : true) throw new DownloadError({
		url: hostname,
		message: `Hostname ${hostname} resolved to disallowed IP address ${address}`
	});
}
function isIPv4(hostname) {
	const parts = hostname.split(".");
	if (parts.length !== 4) return false;
	return parts.every((part) => {
		const num = Number(part);
		return Number.isInteger(num) && num >= 0 && num <= 255 && String(num) === part;
	});
}
function isPrivateIPv4(ip) {
	const [a, b, c] = ip.split(".").map(Number);
	if (a === 0) return true;
	if (a === 10) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 0 && c === 0) return true;
	if (a === 192 && b === 0 && c === 2) return true;
	if (a === 192 && b === 168) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a === 198 && b === 51 && c === 100) return true;
	if (a === 203 && b === 0 && c === 113) return true;
	if (a >= 224) return true;
	return false;
}
/**
* Expands an IPv6 address string into its 8 16-bit groups, handling `::`
* compression and an optional dotted-decimal IPv4 tail (e.g. `::ffff:127.0.0.1`).
*
* @returns the 8 groups, or null if the input is not a parseable IPv6 address.
*/
function parseIPv6(ip) {
	let address = ip.toLowerCase();
	const zoneIndex = address.indexOf("%");
	if (zoneIndex !== -1) address = address.slice(0, zoneIndex);
	const halves = address.split("::");
	if (halves.length > 2) return null;
	const toGroups = (segment) => {
		if (segment === "") return [];
		const groups = [];
		const parts = segment.split(":");
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (part.includes(".")) {
				if (i !== parts.length - 1 || !isIPv4(part)) return null;
				const [a, b, c, d] = part.split(".").map(Number);
				groups.push(a << 8 | b, c << 8 | d);
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
			groups.push(parseInt(part, 16));
		}
		return groups;
	};
	const head = toGroups(halves[0]);
	if (head === null) return null;
	if (halves.length === 2) {
		const tail = toGroups(halves[1]);
		if (tail === null) return null;
		const fill = 8 - head.length - tail.length;
		if (fill < 0) return null;
		return [
			...head,
			...new Array(fill).fill(0),
			...tail
		];
	}
	return head.length === 8 ? head : null;
}
function isPrivateIPv6(ip) {
	const groups = parseIPv6(ip);
	if (groups === null) return true;
	const topZero = (count) => groups.slice(0, count).every((group) => group === 0);
	if (topZero(7) && (groups[7] === 0 || groups[7] === 1)) return true;
	if ((groups[0] & 65024) === 64512) return true;
	if ((groups[0] & 65472) === 65152) return true;
	if ((groups[0] & 65472) === 65216) return true;
	if ((groups[0] & 65280) === 65280) return true;
	if (groups[0] === 8193 && groups[1] === 3512) return true;
	if (groups[0] === 16383 && (groups[1] & 61440) === 0) return true;
	if (topZero(6) || topZero(5) && groups[5] === 65535 || topZero(4) && groups[4] === 65535 && groups[5] === 0 || groups[0] === 100 && groups[1] === 65435 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0 || groups[0] === 100 && groups[1] === 65435 && groups[2] === 1) return isPrivateIPv4(`${groups[6] >> 8 & 255}.${groups[6] & 255}.${groups[7] >> 8 & 255}.${groups[7] & 255}`);
	return false;
}
/**
* Creates a DNS lookup hook that validates every returned address before
* returning the callback shape requested by the HTTP connector. Because
* resolution and validation happen inside the connector, the socket is pinned
* to the validated result and DNS rebinding cannot introduce a second lookup.
*/
function createSafeLookup(lookup) {
	return ((hostname, options, callback) => {
		lookup(hostname, {
			...options,
			all: true
		}, (error, addresses) => {
			if (error) {
				callback(error);
				return;
			}
			try {
				const [firstAddress] = addresses;
				if (firstAddress == null) throw new Error(`Hostname ${hostname} did not resolve to an address`);
				for (const { address, family } of addresses) validateDownloadAddress({
					address,
					family,
					hostname
				});
				if (options.all === true) callback(null, addresses);
				else callback(null, firstAddress.address, firstAddress.family);
			} catch (error) {
				callback(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}
let safeNodeFetchPromise;
function isNodeRuntime() {
	const runtimeProcess = globalThis.process;
	return runtimeProcess?.release?.name === "node" && runtimeProcess.versions?.bun == null && runtimeProcess.versions?.deno == null && runtimeProcess.title !== "workerd" && globalThis.EdgeRuntime == null;
}
async function getDefaultDownloadFetch() {
	if (!isNodeRuntime()) return globalThis.fetch;
	return safeNodeFetchPromise ??= Promise.resolve().then(createSafeNodeFetch);
}
function createSafeNodeFetch() {
	const module = loadBuiltinModule("node:module");
	const { lookup } = loadBuiltinModule("node:dns");
	const { Agent, fetch } = module.createRequire(getCurrentModulePath())("undici");
	const dispatcher = new Agent({ connect: { lookup: createSafeLookup(lookup) } });
	return ((input, init) => fetch(input, {
		...init,
		dispatcher
	}));
}
function loadBuiltinModule(id) {
	const builtinModule = globalThis.process?.getBuiltinModule?.(id);
	if (builtinModule == null) throw new Error(`Node.js built-in module ${id} is unavailable`);
	return builtinModule;
}
function getCurrentModulePath() {
	const originalPrepareStackTrace = Error.prepareStackTrace;
	try {
		Error.prepareStackTrace = (_error, callSites) => callSites;
		const error = /* @__PURE__ */ new Error("Capture current module path");
		Error.captureStackTrace(error, getCurrentModulePath);
		const [caller] = error.stack;
		const fileName = caller?.getFileName();
		if (fileName == null) throw new Error("Unable to determine the current module path");
		return fileName;
	} finally {
		Error.prepareStackTrace = originalPrepareStackTrace;
	}
}
/**
* Request headers stripped before fetching an untrusted URL: host/virtual-host
* routing, proxy/origin spoofing, cloud-metadata, cookies, and hop-by-hop
* transport headers (RFC 7230 §6.1).
*
* `Authorization` and other credential-bearing caller headers (e.g. `x-key`)
* are intentionally not listed because trusted provider requests may need
* them. `fetchUntrustedUrl` separately restricts an untrusted first hop to an
* explicit allowlist of non-credential request metadata. Both it and
* `fetchWithValidatedRedirects` drop all caller headers except the user-agent
* on a cross-origin redirect.
*/
const BLOCKED_REQUEST_HEADERS = [
	"connection",
	"keep-alive",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"forwarded",
	"proxy-authorization",
	"via",
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-proto",
	"x-real-ip",
	"metadata",
	"metadata-flavor",
	"x-aws-ec2-metadata-token",
	"x-metadata-token",
	"cookie",
	"set-cookie"
];
/**
* Returns a fresh `Headers` built from `input` with {@link BLOCKED_REQUEST_HEADERS}
* removed. The input is never mutated.
*/
function sanitizeRequestHeaders(input) {
	const headers = new Headers(input);
	for (const name of BLOCKED_REQUEST_HEADERS) headers.delete(name);
	return headers;
}
const MAX_DOWNLOAD_REDIRECTS = 10;
const REDIRECT_STATUS_CODES = /* @__PURE__ */ new Set([
	301,
	302,
	303,
	307,
	308
]);
async function getValidatedFetch(customFetch) {
	return customFetch == null || customFetch === globalThis.fetch ? await getDefaultDownloadFetch() : customFetch;
}
/**
* Fetches a URL while enforcing the download guard on every hop.
*
* Redirects are followed manually (`redirect: 'manual'`) so each hop is
* validated with {@link validateDownloadUrl} *before* it is requested. Relying
* on the default `redirect: 'follow'` would issue the request to a redirect
* target (e.g. an internal address) before we ever see its URL, defeating the
* guard.
*
* Request headers are also protected: {@link sanitizeRequestHeaders} strips
* proxy/metadata/cookie/hop-by-hop headers before the first request, and all
* caller headers except `User-Agent` are dropped on a cross-origin redirect.
* Credentials and custom headers are preserved on the first hop for backwards
* compatibility. The caller must ensure that the initial URL may receive them.
* Use `fetchUntrustedUrl` for URLs that require first-hop credential isolation.
* The fetch spec only strips `Authorization` on cross-origin redirects because
* in a browser, CORS preflighting protects custom headers; there is no CORS on
* the server, so provider API keys carried in custom headers (e.g. `x-key`)
* must be dropped here as well.
*
* A `redirect: 'manual'` request yields an unreadable opaque response in the
* browser (and in other spec-compliant fetch implementations), so the redirect
* target cannot be validated here. In a real browser this is safe to follow
* natively because reaching an internal network is not possible (fetch is
* constrained by CORS and cannot reach a server's internal network or
* cloud-metadata). On any other runtime we cannot validate the hop, so we fail
* closed rather than follow it blindly and bypass the guard.
*
* A hop that is same-origin with `trustedOrigin` (the developer-configured
* provider endpoint) skips target validation: that origin is exactly what an
* unvalidated, config-derived request would fetch anyway, and validating it
* would break legitimate self-hosted / localhost deployments whose response
* URLs point back at the configured host. Hops on any other origin are always
* validated.
*
* The returned response is the final (non-redirect) response. The caller is
* responsible for checking `response.ok` and reading the body.
*
* On Node.js, the default fetch resolves every hostname through a validating
* lookup hook and passes those exact addresses to the connector, preventing
* hostname-to-private-IP and DNS-rebinding bypasses. An injected fetch is
* responsible for equivalent connect-time validation. Other runtimes should
* constrain egress at the network layer when handling untrusted URLs.
*
* @throws DownloadError if a hop is unsafe, the redirect limit is exceeded, or
* a redirect cannot be validated on a non-browser runtime.
*/
async function fetchWithValidatedRedirects({ url, headers, abortSignal, maxRedirects = MAX_DOWNLOAD_REDIRECTS, fetch: customFetch, trustedOrigin }) {
	let currentHeaders = headers === void 0 ? void 0 : sanitizeRequestHeaders(headers);
	const perHopInit = (redirect) => {
		const init = {
			signal: abortSignal,
			redirect
		};
		if (currentHeaders !== void 0) init.headers = new Headers(currentHeaders);
		return init;
	};
	let currentUrl = url;
	for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
		const isTrustedHop = trustedOrigin !== void 0 && isSameOrigin(currentUrl, trustedOrigin);
		if (!isTrustedHop) validateDownloadUrl(currentUrl);
		const fetch = isTrustedHop && customFetch != null ? customFetch : isTrustedHop ? globalThis.fetch : await getValidatedFetch(customFetch);
		const response = await fetch(currentUrl, perHopInit("manual"));
		if (response.type === "opaqueredirect") {
			if (!isBrowserRuntime()) throw new DownloadError({
				url,
				message: `Redirect from ${currentUrl} could not be validated and was blocked`
			});
			return await fetch(currentUrl, perHopInit("follow"));
		}
		const location = response.headers?.get("location");
		if (REDIRECT_STATUS_CODES.has(response.status) && location) {
			cancelResponseBody(response);
			const nextUrl = new URL(location, currentUrl).toString();
			if (currentHeaders !== void 0 && !isSameOrigin(nextUrl, currentUrl)) {
				const userAgent = currentHeaders.get("user-agent");
				currentHeaders = new Headers(userAgent == null ? void 0 : { "user-agent": userAgent });
			}
			currentUrl = nextUrl;
			continue;
		}
		return response;
	}
	throw new DownloadError({
		url,
		message: `Too many redirects (max ${maxRedirects})`
	});
}
/**
* Reads a fetch Response body with a size limit to prevent memory exhaustion.
*
* Checks the Content-Length header for early rejection, then reads the body
* incrementally via ReadableStream and aborts with a DownloadError when the
* limit is exceeded.
*
* @param response - The fetch Response to read.
* @param url - The URL being downloaded (used in error messages).
* @param maxBytes - Maximum allowed bytes. Defaults to DEFAULT_MAX_DOWNLOAD_SIZE.
* @returns A Uint8Array containing the response body.
* @throws DownloadError if the response exceeds maxBytes.
*/
async function readResponseWithSizeLimit({ response, url, maxBytes = 2147483648 }) {
	const contentLength = response.headers.get("content-length");
	if (contentLength != null) {
		const length = parseInt(contentLength, 10);
		if (!isNaN(length) && length > maxBytes) {
			await cancelResponseBody(response);
			throw new DownloadError({
				url,
				message: `Download of ${url} exceeded maximum size of ${maxBytes} bytes (Content-Length: ${length}).`
			});
		}
	}
	const body = response.body;
	if (body == null) return /* @__PURE__ */ new Uint8Array(0);
	const reader = body.getReader();
	const chunks = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.length;
			if (totalBytes > maxBytes) throw new DownloadError({
				url,
				message: `Download of ${url} exceeded maximum size of ${maxBytes} bytes.`
			});
			chunks.push(value);
		}
	} finally {
		try {
			await reader.cancel();
		} catch {} finally {
			reader.releaseLock();
		}
	}
	const result = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}
/**
* Creates an ID generator.
* The total length of the ID is the sum of the prefix, separator, and random part length.
* Not cryptographically secure.
*
* @param alphabet - The alphabet to use for the ID. Default: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.
* @param prefix - The prefix of the ID to generate. Optional.
* @param separator - The separator between the prefix and the random part of the ID. Default: '-'.
* @param size - The size of the random part of the ID to generate. Default: 16.
*/
const createIdGenerator = ({ prefix, size = 16, alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", separator = "-" } = {}) => {
	const generator = () => {
		const alphabetLength = alphabet.length;
		const chars = new Array(size);
		for (let i = 0; i < size; i++) chars[i] = alphabet[Math.random() * alphabetLength | 0];
		return chars.join("");
	};
	if (prefix == null) return generator;
	if (alphabet.includes(separator)) throw new InvalidArgumentError({
		argument: "separator",
		message: `The separator "${separator}" must not be part of the alphabet "${alphabet}".`
	});
	return () => `${prefix}${separator}${generator()}`;
};
createIdGenerator();
const getOriginalFetch$2 = () => globalThis.fetch;
const getFromApi = async ({ url, headers = {}, successfulResponseHandler, failedResponseHandler, abortSignal, fetch, validateUrl, credentialedOrigin, trustedOrigin }) => {
	try {
		const requestFetch = fetch ?? getOriginalFetch$2();
		const requestHeaders = withUserAgentSuffix(credentialedOrigin !== void 0 && !isSameOrigin(url, credentialedOrigin) ? {} : headers, `ai-sdk-provider-utils/5.0.60`, getRuntimeEnvironmentUserAgent());
		const response = validateUrl ? await fetchWithValidatedRedirects({
			url,
			headers: requestHeaders,
			abortSignal,
			fetch,
			trustedOrigin
		}) : await requestFetch(url, {
			method: "GET",
			headers: requestHeaders,
			signal: abortSignal
		});
		const responseHeaders = extractResponseHeaders(response);
		if (!response.ok) {
			let errorInformation;
			try {
				errorInformation = await failedResponseHandler({
					response,
					url,
					requestBodyValues: {}
				});
			} catch (error) {
				if (isAbortError(error) || APICallError.isInstance(error)) throw error;
				throw new APICallError({
					message: "Failed to process error response",
					cause: error,
					statusCode: response.status,
					url,
					responseHeaders,
					requestBodyValues: {}
				});
			}
			throw errorInformation.value;
		}
		try {
			return await successfulResponseHandler({
				response,
				url,
				requestBodyValues: {}
			});
		} catch (error) {
			if (error instanceof Error) {
				if (isAbortError(error) || APICallError.isInstance(error)) throw error;
			}
			throw new APICallError({
				message: "Failed to process successful response",
				cause: error,
				statusCode: response.status,
				url,
				responseHeaders,
				requestBodyValues: {}
			});
		}
	} catch (error) {
		throw handleFetchError({
			error,
			url,
			requestBodyValues: {}
		});
	}
};
/**
* Checks whether a value is a non-null, non-array object.
*/
function isRecord(value) {
	return value != null && typeof value === "object" && !Array.isArray(value);
}
/**
* Loads an optional `string` setting from the environment or a parameter.
*
* @param settingValue - The setting value.
* @param environmentVariableName - The environment variable name.
* @returns The setting value.
*/
function loadOptionalSetting({ settingValue, environmentVariableName }) {
	if (typeof settingValue === "string") return settingValue;
	if (settingValue != null || typeof process === "undefined") return;
	settingValue = process.env[environmentVariableName];
	if (settingValue == null || typeof settingValue !== "string") return;
	return settingValue;
}
/**
* Normalizes complete batch request counts.
*
* Returns `undefined` when any count is missing, is not a non-negative safe
* integer, or when the item counts do not add up to the total.
*/
function normalizeBatchRequestCounts({ total, pending, completed, failed }) {
	if (isNonNegativeSafeInteger(total) && isNonNegativeSafeInteger(pending) && isNonNegativeSafeInteger(completed) && isNonNegativeSafeInteger(failed) && pending + completed + failed === total) return {
		total,
		pending,
		completed,
		failed
	};
}
function isNonNegativeSafeInteger(value) {
	return value != null && Number.isSafeInteger(value) && value >= 0;
}
const suspectProtoRx = /"(?:_|\\u005[Ff])(?:_|\\u005[Ff])(?:p|\\u0070)(?:r|\\u0072)(?:o|\\u006[Ff])(?:t|\\u0074)(?:o|\\u006[Ff])(?:_|\\u005[Ff])(?:_|\\u005[Ff])"\s*:/;
const suspectConstructorRx = /"(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)"\s*:/;
function _parse(text) {
	const obj = JSON.parse(text);
	if (obj === null || typeof obj !== "object") return obj;
	if (suspectProtoRx.test(text) === false && suspectConstructorRx.test(text) === false) return obj;
	return filter(obj);
}
function filter(obj) {
	let next = [obj];
	while (next.length) {
		const nodes = next;
		next = [];
		for (const node of nodes) {
			if (Object.prototype.hasOwnProperty.call(node, "__proto__")) throw new SyntaxError("Object contains forbidden prototype property");
			if (Object.prototype.hasOwnProperty.call(node, "constructor") && node.constructor !== null && typeof node.constructor === "object" && Object.prototype.hasOwnProperty.call(node.constructor, "prototype")) throw new SyntaxError("Object contains forbidden prototype property");
			for (const key in node) {
				const value = node[key];
				if (value && typeof value === "object") next.push(value);
			}
		}
	}
	return obj;
}
function secureJsonParse(text) {
	const { stackTraceLimit } = Error;
	try {
		Error.stackTraceLimit = 0;
	} catch {
		return _parse(text);
	}
	try {
		return _parse(text);
	} finally {
		Error.stackTraceLimit = stackTraceLimit;
	}
}
/**
* Recursively adds additionalProperties: false to object schemas that do not
* define a schema for their additional properties. This is necessary because
* some providers (e.g. OpenAI) do not support additionalProperties: true.
*/
function addAdditionalPropertiesToJsonSchema(jsonSchema) {
	if (jsonSchema.type === "object" || Array.isArray(jsonSchema.type) && jsonSchema.type.includes("object")) {
		const { additionalProperties } = jsonSchema;
		jsonSchema.additionalProperties = additionalProperties != null && typeof additionalProperties !== "boolean" ? visit(additionalProperties) : false;
		const { properties } = jsonSchema;
		if (properties != null) for (const key of Object.keys(properties)) properties[key] = visit(properties[key]);
	}
	if (jsonSchema.items != null) jsonSchema.items = Array.isArray(jsonSchema.items) ? jsonSchema.items.map(visit) : visit(jsonSchema.items);
	if (jsonSchema.anyOf != null) jsonSchema.anyOf = jsonSchema.anyOf.map(visit);
	if (jsonSchema.allOf != null) jsonSchema.allOf = jsonSchema.allOf.map(visit);
	if (jsonSchema.oneOf != null) jsonSchema.oneOf = jsonSchema.oneOf.map(visit);
	const { definitions } = jsonSchema;
	if (definitions != null) for (const key of Object.keys(definitions)) definitions[key] = visit(definitions[key]);
	return jsonSchema;
}
function visit(def) {
	if (typeof def === "boolean") return def;
	return addAdditionalPropertiesToJsonSchema(def);
}
const ignoreOverride = Symbol("Let zodToJsonSchema decide on which parser to use");
const defaultOptions = {
	name: void 0,
	$refStrategy: "root",
	basePath: ["#"],
	effectStrategy: "input",
	pipeStrategy: "all",
	dateStrategy: "format:date-time",
	mapStrategy: "entries",
	removeAdditionalStrategy: "passthrough",
	allowedAdditionalProperties: true,
	rejectedAdditionalProperties: false,
	definitionPath: "definitions",
	strictUnions: false,
	definitions: {},
	errorMessages: false,
	patternStrategy: "escape",
	applyRegexFlags: false,
	emailStrategy: "format:email",
	base64Strategy: "contentEncoding:base64",
	nameStrategy: "ref"
};
const getDefaultOptions = (options) => typeof options === "string" ? {
	...defaultOptions,
	name: options
} : {
	...defaultOptions,
	...options
};
function parseAnyDef() {
	return {};
}
function parseArrayDef(def, refs) {
	const res = { type: "array" };
	if (def.type?._def && def.type?._def?.typeName !== "ZodAny") res.items = parseDef(def.type._def, {
		...refs,
		currentPath: [...refs.currentPath, "items"]
	});
	if (def.minLength) res.minItems = def.minLength.value;
	if (def.maxLength) res.maxItems = def.maxLength.value;
	if (def.exactLength) {
		res.minItems = def.exactLength.value;
		res.maxItems = def.exactLength.value;
	}
	return res;
}
function parseBigintDef(def) {
	const res = {
		type: "integer",
		format: "int64"
	};
	if (!def.checks) return res;
	for (const check of def.checks) switch (check.kind) {
		case "min":
			if (check.inclusive) res.minimum = check.value;
			else res.exclusiveMinimum = check.value;
			break;
		case "max":
			if (check.inclusive) res.maximum = check.value;
			else res.exclusiveMaximum = check.value;
			break;
		case "multipleOf": res.multipleOf = check.value;
	}
	return res;
}
function parseBooleanDef() {
	return { type: "boolean" };
}
function parseBrandedDef(_def, refs) {
	return parseDef(_def.type._def, refs);
}
const parseCatchDef = (def, refs) => {
	return parseDef(def.innerType._def, refs);
};
function parseDateDef(def, refs, overrideDateStrategy) {
	const strategy = overrideDateStrategy ?? refs.dateStrategy;
	if (Array.isArray(strategy)) return { anyOf: strategy.map((item) => parseDateDef(def, refs, item)) };
	switch (strategy) {
		case "string":
		case "format:date-time": return {
			type: "string",
			format: "date-time"
		};
		case "format:date": return {
			type: "string",
			format: "date"
		};
		case "integer": return integerDateParser(def);
	}
}
const integerDateParser = (def) => {
	const res = {
		type: "integer",
		format: "unix-time"
	};
	for (const check of def.checks) switch (check.kind) {
		case "min":
			res.minimum = check.value;
			break;
		case "max": res.maximum = check.value;
	}
	return res;
};
function parseDefaultDef(_def, refs) {
	return {
		...parseDef(_def.innerType._def, refs),
		default: _def.defaultValue()
	};
}
function parseEffectsDef(_def, refs) {
	return refs.effectStrategy === "input" ? parseDef(_def.schema._def, refs) : parseAnyDef();
}
function parseEnumDef(def) {
	return {
		type: "string",
		enum: Array.from(def.values)
	};
}
const isJsonSchema7AllOfType = (type) => {
	if ("type" in type && type.type === "string") return false;
	return "allOf" in type;
};
function parseIntersectionDef(def, refs) {
	const allOf = [parseDef(def.left._def, {
		...refs,
		currentPath: [
			...refs.currentPath,
			"allOf",
			"0"
		]
	}), parseDef(def.right._def, {
		...refs,
		currentPath: [
			...refs.currentPath,
			"allOf",
			"1"
		]
	})].filter((x) => !!x);
	const mergedAllOf = [];
	allOf.forEach((schema) => {
		if (isJsonSchema7AllOfType(schema)) mergedAllOf.push(...schema.allOf);
		else {
			let nestedSchema = schema;
			if ("additionalProperties" in schema && schema.additionalProperties === false) {
				const { additionalProperties: _additionalProperties, ...rest } = schema;
				nestedSchema = rest;
			}
			mergedAllOf.push(nestedSchema);
		}
	});
	return mergedAllOf.length ? { allOf: mergedAllOf } : void 0;
}
function parseLiteralDef(def) {
	const parsedType = typeof def.value;
	if (parsedType !== "bigint" && parsedType !== "number" && parsedType !== "boolean" && parsedType !== "string") return { type: Array.isArray(def.value) ? "array" : "object" };
	return {
		type: parsedType === "bigint" ? "integer" : parsedType,
		const: def.value
	};
}
let emojiRegex = void 0;
/**
* Generated from the regular expressions found here as of 2024-05-22:
* https://github.com/colinhacks/zod/blob/master/src/types.ts.
*
* Expressions with /i flag have been changed accordingly.
*/
const zodPatterns = {
	/**
	* `c` was changed to `[cC]` to replicate /i flag
	*/
	cuid: /^[cC][^\s-]{8,}$/,
	cuid2: /^[0-9a-z]+$/,
	ulid: /^[0-9A-HJKMNP-TV-Z]{26}$/,
	/**
	* `a-z` was added to replicate /i flag
	*/
	email: /^(?!\.)(?!.*\.\.)([a-zA-Z0-9_'+\-.]*)[a-zA-Z0-9_+-]@([a-zA-Z0-9][a-zA-Z0-9-]*\.)+[a-zA-Z]{2,}$/,
	/**
	* Constructed a valid Unicode RegExp
	*
	* Lazily instantiate since this type of regex isn't supported
	* in all envs (e.g. React Native).
	*
	* See:
	* https://github.com/colinhacks/zod/issues/2433
	* Fix in Zod:
	* https://github.com/colinhacks/zod/commit/9340fd51e48576a75adc919bff65dbc4a5d4c99b
	*/
	emoji: () => {
		if (emojiRegex === void 0) emojiRegex = RegExp("^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$", "u");
		return emojiRegex;
	},
	/**
	* Unused
	*/
	uuid: /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/,
	/**
	* Unused
	*/
	ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/,
	ipv4Cidr: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/,
	/**
	* Unused
	*/
	ipv6: /^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/,
	ipv6Cidr: /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/,
	base64: /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/,
	base64url: /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/,
	nanoid: /^[a-zA-Z0-9_-]{21}$/,
	jwt: /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/
};
function parseStringDef(def, refs) {
	const res = { type: "string" };
	if (def.checks) for (const check of def.checks) switch (check.kind) {
		case "min":
			res.minLength = typeof res.minLength === "number" ? Math.max(res.minLength, check.value) : check.value;
			break;
		case "max":
			res.maxLength = typeof res.maxLength === "number" ? Math.min(res.maxLength, check.value) : check.value;
			break;
		case "email":
			switch (refs.emailStrategy) {
				case "format:email":
					addFormat(res, "email", check.message, refs);
					break;
				case "format:idn-email":
					addFormat(res, "idn-email", check.message, refs);
					break;
				case "pattern:zod": addPattern(res, zodPatterns.email, check.message, refs);
			}
			break;
		case "url":
			addFormat(res, "uri", check.message, refs);
			break;
		case "uuid":
			addFormat(res, "uuid", check.message, refs);
			break;
		case "regex":
			addPattern(res, check.regex, check.message, refs);
			break;
		case "cuid":
			addPattern(res, zodPatterns.cuid, check.message, refs);
			break;
		case "cuid2":
			addPattern(res, zodPatterns.cuid2, check.message, refs);
			break;
		case "startsWith":
			addPattern(res, RegExp(`^${escapeLiteralCheckValue(check.value, refs)}`), check.message, refs);
			break;
		case "endsWith":
			addPattern(res, RegExp(`${escapeLiteralCheckValue(check.value, refs)}$`), check.message, refs);
			break;
		case "datetime":
			addFormat(res, "date-time", check.message, refs);
			break;
		case "date":
			addFormat(res, "date", check.message, refs);
			break;
		case "time":
			addFormat(res, "time", check.message, refs);
			break;
		case "duration":
			addFormat(res, "duration", check.message, refs);
			break;
		case "length":
			res.minLength = typeof res.minLength === "number" ? Math.max(res.minLength, check.value) : check.value;
			res.maxLength = typeof res.maxLength === "number" ? Math.min(res.maxLength, check.value) : check.value;
			break;
		case "includes":
			addPattern(res, RegExp(escapeLiteralCheckValue(check.value, refs)), check.message, refs);
			break;
		case "ip":
			if (check.version !== "v6") addFormat(res, "ipv4", check.message, refs);
			if (check.version !== "v4") addFormat(res, "ipv6", check.message, refs);
			break;
		case "base64url":
			addPattern(res, zodPatterns.base64url, check.message, refs);
			break;
		case "jwt":
			addPattern(res, zodPatterns.jwt, check.message, refs);
			break;
		case "cidr":
			if (check.version !== "v6") addPattern(res, zodPatterns.ipv4Cidr, check.message, refs);
			if (check.version !== "v4") addPattern(res, zodPatterns.ipv6Cidr, check.message, refs);
			break;
		case "emoji":
			addPattern(res, zodPatterns.emoji(), check.message, refs);
			break;
		case "ulid":
			addPattern(res, zodPatterns.ulid, check.message, refs);
			break;
		case "base64":
			switch (refs.base64Strategy) {
				case "format:binary":
					addFormat(res, "binary", check.message, refs);
					break;
				case "contentEncoding:base64":
					res.contentEncoding = "base64";
					break;
				case "pattern:zod": addPattern(res, zodPatterns.base64, check.message, refs);
			}
			break;
		case "nanoid": addPattern(res, zodPatterns.nanoid, check.message, refs);
	}
	return res;
}
function escapeLiteralCheckValue(literal, refs) {
	return refs.patternStrategy === "escape" ? escapeNonAlphaNumeric(literal) : literal;
}
const ALPHA_NUMERIC = /* @__PURE__ */ new Set("ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvxyz0123456789");
function escapeNonAlphaNumeric(source) {
	let result = "";
	for (let i = 0; i < source.length; i++) {
		if (!ALPHA_NUMERIC.has(source[i])) result += "\\";
		result += source[i];
	}
	return result;
}
function addFormat(schema, value, message, refs) {
	if (schema.format || schema.anyOf?.some((x) => x.format)) {
		if (!schema.anyOf) schema.anyOf = [];
		if (schema.format) {
			schema.anyOf.push({ format: schema.format });
			delete schema.format;
		}
		schema.anyOf.push({
			format: value,
			...message && refs.errorMessages && { errorMessage: { format: message } }
		});
	} else schema.format = value;
}
function addPattern(schema, regex, message, refs) {
	if (schema.pattern || schema.allOf?.some((x) => x.pattern)) {
		if (!schema.allOf) schema.allOf = [];
		if (schema.pattern) {
			schema.allOf.push({ pattern: schema.pattern });
			delete schema.pattern;
		}
		schema.allOf.push({
			pattern: stringifyRegExpWithFlags(regex, refs),
			...message && refs.errorMessages && { errorMessage: { pattern: message } }
		});
	} else schema.pattern = stringifyRegExpWithFlags(regex, refs);
}
function stringifyRegExpWithFlags(regex, refs) {
	if (!refs.applyRegexFlags || !regex.flags) return regex.source;
	const flags = {
		i: regex.flags.includes("i"),
		m: regex.flags.includes("m"),
		s: regex.flags.includes("s")
	};
	const source = flags.i ? regex.source.toLowerCase() : regex.source;
	let pattern = "";
	let isEscaped = false;
	let inCharGroup = false;
	let inCharRange = false;
	for (let i = 0; i < source.length; i++) {
		if (isEscaped) {
			pattern += source[i];
			isEscaped = false;
			continue;
		}
		if (flags.i) {
			if (inCharGroup) {
				if (source[i].match(/[a-z]/)) {
					if (inCharRange) {
						pattern += source[i];
						pattern += `${source[i - 2]}-${source[i]}`.toUpperCase();
						inCharRange = false;
					} else if (source[i + 1] === "-" && source[i + 2]?.match(/[a-z]/)) {
						pattern += source[i];
						inCharRange = true;
					} else pattern += `${source[i]}${source[i].toUpperCase()}`;
					continue;
				}
			} else if (source[i].match(/[a-z]/)) {
				pattern += `[${source[i]}${source[i].toUpperCase()}]`;
				continue;
			}
		}
		if (flags.m) {
			if (source[i] === "^") {
				pattern += `(^|(?<=[\r\n]))`;
				continue;
			} else if (source[i] === "$") {
				pattern += `($|(?=[\r\n]))`;
				continue;
			}
		}
		if (flags.s && source[i] === ".") {
			pattern += inCharGroup ? `${source[i]}\r\n` : `[${source[i]}\r\n]`;
			continue;
		}
		pattern += source[i];
		if (source[i] === "\\") isEscaped = true;
		else if (inCharGroup && source[i] === "]") inCharGroup = false;
		else if (!inCharGroup && source[i] === "[") inCharGroup = true;
	}
	try {
		new RegExp(pattern);
	} catch {
		console.warn(`Could not convert regex pattern at ${refs.currentPath.join("/")} to a flag-independent form! Falling back to the flag-ignorant source`);
		return regex.source;
	}
	return pattern;
}
function parseRecordDef(def, refs) {
	const schema = {
		type: "object",
		additionalProperties: parseDef(def.valueType._def, {
			...refs,
			currentPath: [...refs.currentPath, "additionalProperties"]
		}) ?? refs.allowedAdditionalProperties
	};
	if (def.keyType?._def.typeName === "ZodString" && def.keyType._def.checks?.length) {
		const { type: _type, ...keyType } = parseStringDef(def.keyType._def, refs);
		return {
			...schema,
			propertyNames: keyType
		};
	} else if (def.keyType?._def.typeName === "ZodEnum") return {
		...schema,
		propertyNames: { enum: def.keyType._def.values }
	};
	else if (def.keyType?._def.typeName === "ZodBranded" && def.keyType._def.type._def.typeName === "ZodString" && def.keyType._def.type._def.checks?.length) {
		const { type: _type, ...keyType } = parseBrandedDef(def.keyType._def, refs);
		return {
			...schema,
			propertyNames: keyType
		};
	}
	return schema;
}
function parseMapDef(def, refs) {
	if (refs.mapStrategy === "record") return parseRecordDef(def, refs);
	return {
		type: "array",
		maxItems: 125,
		items: {
			type: "array",
			items: [parseDef(def.keyType._def, {
				...refs,
				currentPath: [
					...refs.currentPath,
					"items",
					"items",
					"0"
				]
			}) || parseAnyDef(), parseDef(def.valueType._def, {
				...refs,
				currentPath: [
					...refs.currentPath,
					"items",
					"items",
					"1"
				]
			}) || parseAnyDef()],
			minItems: 2,
			maxItems: 2
		}
	};
}
function parseNativeEnumDef(def) {
	const object = def.values;
	const actualValues = Object.keys(def.values).filter((key) => {
		return typeof object[object[key]] !== "number";
	}).map((key) => object[key]);
	const parsedTypes = Array.from(new Set(actualValues.map((values) => typeof values)));
	return {
		type: parsedTypes.length === 1 ? parsedTypes[0] === "string" ? "string" : "number" : ["string", "number"],
		enum: actualValues
	};
}
function parseNeverDef() {
	return { not: parseAnyDef() };
}
function parseNullDef() {
	return { type: "null" };
}
const primitiveMappings = {
	ZodString: "string",
	ZodNumber: "number",
	ZodBigInt: "integer",
	ZodBoolean: "boolean",
	ZodNull: "null"
};
function parseUnionDef(def, refs) {
	const options = def.options instanceof Map ? Array.from(def.options.values()) : def.options;
	if (options.every((x) => x._def.typeName in primitiveMappings && (!x._def.checks || !x._def.checks.length))) {
		const types = options.reduce((types, x) => {
			const type = primitiveMappings[x._def.typeName];
			return type && !types.includes(type) ? [...types, type] : types;
		}, []);
		return { type: types.length > 1 ? types : types[0] };
	} else if (options.every((x) => x._def.typeName === "ZodLiteral" && !x.description)) {
		const types = options.reduce((acc, x) => {
			const type = typeof x._def.value;
			switch (type) {
				case "string":
				case "number":
				case "boolean": return [...acc, type];
				case "bigint": return [...acc, "integer"];
				case "object": if (x._def.value === null) return [...acc, "null"];
				default: return acc;
			}
		}, []);
		if (types.length === options.length) {
			const uniqueTypes = types.filter((x, i, a) => a.indexOf(x) === i);
			return {
				type: uniqueTypes.length > 1 ? uniqueTypes : uniqueTypes[0],
				enum: options.reduce((acc, x) => {
					return acc.includes(x._def.value) ? acc : [...acc, x._def.value];
				}, [])
			};
		}
	} else if (options.every((x) => x._def.typeName === "ZodEnum")) return {
		type: "string",
		enum: options.reduce((acc, x) => [...acc, ...x._def.values.filter((x) => !acc.includes(x))], [])
	};
	return asAnyOf(def, refs);
}
const asAnyOf = (def, refs) => {
	const anyOf = (def.options instanceof Map ? Array.from(def.options.values()) : def.options).map((x, i) => parseDef(x._def, {
		...refs,
		currentPath: [
			...refs.currentPath,
			"anyOf",
			`${i}`
		]
	})).filter((x) => !!x && (!refs.strictUnions || typeof x === "object" && Object.keys(x).length > 0));
	return anyOf.length ? { anyOf } : void 0;
};
function parseNullableDef(def, refs) {
	if ([
		"ZodString",
		"ZodNumber",
		"ZodBigInt",
		"ZodBoolean",
		"ZodNull"
	].includes(def.innerType._def.typeName) && (!def.innerType._def.checks || !def.innerType._def.checks.length)) return { type: [primitiveMappings[def.innerType._def.typeName], "null"] };
	const base = parseDef(def.innerType._def, {
		...refs,
		currentPath: [
			...refs.currentPath,
			"anyOf",
			"0"
		]
	});
	return base && { anyOf: [base, { type: "null" }] };
}
function parseNumberDef(def) {
	const res = { type: "number" };
	if (!def.checks) return res;
	for (const check of def.checks) switch (check.kind) {
		case "int":
			res.type = "integer";
			break;
		case "min":
			if (check.inclusive) res.minimum = check.value;
			else res.exclusiveMinimum = check.value;
			break;
		case "max":
			if (check.inclusive) res.maximum = check.value;
			else res.exclusiveMaximum = check.value;
			break;
		case "multipleOf": res.multipleOf = check.value;
	}
	return res;
}
function parseObjectDef(def, refs) {
	const result = {
		type: "object",
		properties: {}
	};
	const required = [];
	const shape = def.shape();
	for (const propName in shape) {
		let propDef = shape[propName];
		if (propDef === void 0 || propDef._def === void 0) continue;
		const propOptional = safeIsOptional(propDef);
		const parsedDef = parseDef(propDef._def, {
			...refs,
			currentPath: [
				...refs.currentPath,
				"properties",
				propName
			],
			propertyPath: [
				...refs.currentPath,
				"properties",
				propName
			]
		});
		if (parsedDef === void 0) continue;
		result.properties[propName] = parsedDef;
		if (!propOptional) required.push(propName);
	}
	if (required.length) result.required = required;
	const additionalProperties = decideAdditionalProperties(def, refs);
	if (additionalProperties !== void 0) result.additionalProperties = additionalProperties;
	return result;
}
function decideAdditionalProperties(def, refs) {
	if (def.catchall._def.typeName !== "ZodNever") return parseDef(def.catchall._def, {
		...refs,
		currentPath: [...refs.currentPath, "additionalProperties"]
	});
	switch (def.unknownKeys) {
		case "passthrough": return refs.allowedAdditionalProperties;
		case "strict": return refs.rejectedAdditionalProperties;
		case "strip": return refs.removeAdditionalStrategy === "strict" ? refs.allowedAdditionalProperties : refs.rejectedAdditionalProperties;
	}
}
function safeIsOptional(schema) {
	try {
		return schema.isOptional();
	} catch {
		return true;
	}
}
const parseOptionalDef = (def, refs) => {
	if (refs.currentPath.toString() === refs.propertyPath?.toString()) return parseDef(def.innerType._def, refs);
	const innerSchema = parseDef(def.innerType._def, {
		...refs,
		currentPath: [
			...refs.currentPath,
			"anyOf",
			"1"
		]
	});
	return innerSchema ? { anyOf: [{ not: parseAnyDef() }, innerSchema] } : parseAnyDef();
};
const parsePipelineDef = (def, refs) => {
	if (refs.pipeStrategy === "input") return parseDef(def.in._def, refs);
	else if (refs.pipeStrategy === "output") return parseDef(def.out._def, refs);
	const inputSchema = parseDef(def.in._def, {
		...refs,
		currentPath: [
			...refs.currentPath,
			"allOf",
			"0"
		]
	});
	return { allOf: [inputSchema, parseDef(def.out._def, {
		...refs,
		currentPath: [
			...refs.currentPath,
			"allOf",
			inputSchema ? "1" : "0"
		]
	})].filter((schema) => schema !== void 0) };
};
function parsePromiseDef(def, refs) {
	return parseDef(def.type._def, refs);
}
function parseSetDef(def, refs) {
	const schema = {
		type: "array",
		uniqueItems: true,
		items: parseDef(def.valueType._def, {
			...refs,
			currentPath: [...refs.currentPath, "items"]
		})
	};
	if (def.minSize) schema.minItems = def.minSize.value;
	if (def.maxSize) schema.maxItems = def.maxSize.value;
	return schema;
}
function parseTupleDef(def, refs) {
	if (def.rest) return {
		type: "array",
		minItems: def.items.length,
		items: def.items.map((x, i) => parseDef(x._def, {
			...refs,
			currentPath: [
				...refs.currentPath,
				"items",
				`${i}`
			]
		})).reduce((acc, x) => x === void 0 ? acc : [...acc, x], []),
		additionalItems: parseDef(def.rest._def, {
			...refs,
			currentPath: [...refs.currentPath, "additionalItems"]
		})
	};
	else return {
		type: "array",
		minItems: def.items.length,
		maxItems: def.items.length,
		items: def.items.map((x, i) => parseDef(x._def, {
			...refs,
			currentPath: [
				...refs.currentPath,
				"items",
				`${i}`
			]
		})).reduce((acc, x) => x === void 0 ? acc : [...acc, x], [])
	};
}
function parseUndefinedDef() {
	return { not: parseAnyDef() };
}
function parseUnknownDef() {
	return parseAnyDef();
}
const parseReadonlyDef = (def, refs) => {
	return parseDef(def.innerType._def, refs);
};
const selectParser = (def, typeName, refs) => {
	switch (typeName) {
		case "ZodString": return parseStringDef(def, refs);
		case "ZodNumber": return parseNumberDef(def);
		case "ZodObject": return parseObjectDef(def, refs);
		case "ZodBigInt": return parseBigintDef(def);
		case "ZodBoolean": return parseBooleanDef();
		case "ZodDate": return parseDateDef(def, refs);
		case "ZodUndefined": return parseUndefinedDef();
		case "ZodNull": return parseNullDef();
		case "ZodArray": return parseArrayDef(def, refs);
		case "ZodUnion":
		case "ZodDiscriminatedUnion": return parseUnionDef(def, refs);
		case "ZodIntersection": return parseIntersectionDef(def, refs);
		case "ZodTuple": return parseTupleDef(def, refs);
		case "ZodRecord": return parseRecordDef(def, refs);
		case "ZodLiteral": return parseLiteralDef(def);
		case "ZodEnum": return parseEnumDef(def);
		case "ZodNativeEnum": return parseNativeEnumDef(def);
		case "ZodNullable": return parseNullableDef(def, refs);
		case "ZodOptional": return parseOptionalDef(def, refs);
		case "ZodMap": return parseMapDef(def, refs);
		case "ZodSet": return parseSetDef(def, refs);
		case "ZodLazy": return () => def.getter()._def;
		case "ZodPromise": return parsePromiseDef(def, refs);
		case "ZodNaN":
		case "ZodNever": return parseNeverDef();
		case "ZodEffects": return parseEffectsDef(def, refs);
		case "ZodAny": return parseAnyDef();
		case "ZodUnknown": return parseUnknownDef();
		case "ZodDefault": return parseDefaultDef(def, refs);
		case "ZodBranded": return parseBrandedDef(def, refs);
		case "ZodReadonly": return parseReadonlyDef(def, refs);
		case "ZodCatch": return parseCatchDef(def, refs);
		case "ZodPipeline": return parsePipelineDef(def, refs);
		case "ZodFunction":
		case "ZodVoid":
		case "ZodSymbol": return;
		default:
 /* c8 ignore next */
		return ((_) => void 0)(typeName);
	}
};
const getRelativePath = (pathA, pathB) => {
	let i = 0;
	for (; i < pathA.length && i < pathB.length; i++) if (pathA[i] !== pathB[i]) break;
	return [(pathA.length - i).toString(), ...pathB.slice(i)].join("/");
};
function parseDef(def, refs, forceResolution = false) {
	const seenItem = refs.seen.get(def);
	if (refs.override) {
		const overrideResult = refs.override?.(def, refs, seenItem, forceResolution);
		if (overrideResult !== ignoreOverride) return overrideResult;
	}
	if (seenItem && !forceResolution) {
		const seenSchema = get$ref(seenItem, refs);
		if (seenSchema !== void 0) return seenSchema;
	}
	const newItem = {
		def,
		path: refs.currentPath,
		jsonSchema: void 0
	};
	refs.seen.set(def, newItem);
	const jsonSchemaOrGetter = selectParser(def, def.typeName, refs);
	const jsonSchema = typeof jsonSchemaOrGetter === "function" ? parseDef(jsonSchemaOrGetter(), refs) : jsonSchemaOrGetter;
	if (jsonSchema) addMeta(def, refs, jsonSchema);
	if (refs.postProcess) {
		const postProcessResult = refs.postProcess(jsonSchema, def, refs);
		newItem.jsonSchema = jsonSchema;
		return postProcessResult;
	}
	newItem.jsonSchema = jsonSchema;
	return jsonSchema;
}
const get$ref = (item, refs) => {
	switch (refs.$refStrategy) {
		case "root": return { $ref: item.path.join("/") };
		case "relative": return { $ref: getRelativePath(refs.currentPath, item.path) };
		case "none":
		case "seen":
			if (item.path.length < refs.currentPath.length && item.path.every((value, index) => refs.currentPath[index] === value)) {
				console.warn(`Recursive reference detected at ${refs.currentPath.join("/")}! Defaulting to any`);
				return parseAnyDef();
			}
			return refs.$refStrategy === "seen" ? parseAnyDef() : void 0;
	}
};
const addMeta = (def, refs, jsonSchema) => {
	if (def.description) jsonSchema.description = def.description;
	return jsonSchema;
};
const getRefs = (options) => {
	const _options = getDefaultOptions(options);
	const currentPath = _options.name !== void 0 ? [
		..._options.basePath,
		_options.definitionPath,
		_options.name
	] : _options.basePath;
	return {
		..._options,
		currentPath,
		propertyPath: void 0,
		seen: new Map(Object.entries(_options.definitions).map(([name, def]) => [def._def, {
			def: def._def,
			path: [
				..._options.basePath,
				_options.definitionPath,
				name
			],
			jsonSchema: void 0
		}]))
	};
};
const zod3ToJsonSchema = (schema, options) => {
	const refs = getRefs(options);
	let definitions = typeof options === "object" && options.definitions ? Object.entries(options.definitions).reduce((acc, [name, schema]) => ({
		...acc,
		[name]: parseDef(schema._def, {
			...refs,
			currentPath: [
				...refs.basePath,
				refs.definitionPath,
				name
			]
		}, true) ?? parseAnyDef()
	}), {}) : void 0;
	const name = typeof options === "string" ? options : options?.nameStrategy === "title" ? void 0 : options?.name;
	const main = parseDef(schema._def, name === void 0 ? refs : {
		...refs,
		currentPath: [
			...refs.basePath,
			refs.definitionPath,
			name
		]
	}, false) ?? parseAnyDef();
	const title = typeof options === "object" && options.name !== void 0 && options.nameStrategy === "title" ? options.name : void 0;
	if (title !== void 0) main.title = title;
	const combined = name === void 0 ? definitions ? {
		...main,
		[refs.definitionPath]: definitions
	} : main : {
		$ref: [
			...refs.$refStrategy === "relative" ? [] : refs.basePath,
			refs.definitionPath,
			name
		].join("/"),
		[refs.definitionPath]: {
			...definitions,
			[name]: main
		}
	};
	combined.$schema = "http://json-schema.org/draft-07/schema#";
	return combined;
};
/**
* Used to mark schemas so we can support both Zod and custom schemas.
*/
const schemaSymbol = Symbol.for("vercel.ai.schema");
/**
* Creates a schema with deferred creation.
* This is important to reduce the startup time of the library
* and to avoid initializing unused validators.
*
* @param createValidator A function that creates a schema.
* @returns A function that returns a schema.
*/
function lazySchema(createSchema) {
	let schema;
	return () => {
		if (schema == null) schema = createSchema();
		return schema;
	};
}
/**
* Create a schema using a JSON Schema.
*
* @param jsonSchema The JSON Schema for the schema.
* @param options.validate Optional. A validation function for the schema.
*/
function jsonSchema(jsonSchema, { validate } = {}) {
	return {
		[schemaSymbol]: true,
		_type: void 0,
		get jsonSchema() {
			if (typeof jsonSchema === "function") jsonSchema = jsonSchema();
			return jsonSchema;
		},
		validate
	};
}
function isSchema(value) {
	return typeof value === "object" && value !== null && schemaSymbol in value && value[schemaSymbol] === true && "jsonSchema" in value && "validate" in value;
}
function asSchema(schema) {
	return schema == null ? jsonSchema({
		type: "object",
		properties: {},
		additionalProperties: false
	}) : isSchema(schema) ? schema : "~standard" in schema ? schema["~standard"].vendor === "zod" ? zodSchema(schema) : standardSchema(schema) : schema();
}
function standardSchema(standardSchema) {
	return jsonSchema(() => {
		if (!hasStandardJsonSchema(standardSchema)) throw new Error(`Standard schema vendor '${standardSchema["~standard"].vendor}' does not support JSON Schema conversion.`);
		return addAdditionalPropertiesToJsonSchema(standardSchema["~standard"].jsonSchema.input({ target: "draft-07" }));
	}, { validate: async (value) => {
		const result = await standardSchema["~standard"].validate(value);
		return "value" in result ? {
			success: true,
			value: result.value
		} : {
			success: false,
			error: new TypeValidationError({
				value,
				cause: result.issues
			})
		};
	} });
}
function hasStandardJsonSchema(schema) {
	return schema["~standard"].jsonSchema != null;
}
function zod3Schema(zodSchema, options) {
	const useReferences = options?.useReferences ?? false;
	return jsonSchema(() => zod3ToJsonSchema(zodSchema, { $refStrategy: useReferences ? "root" : "none" }), { validate: async (value) => {
		const result = await zodSchema.safeParseAsync(value);
		return result.success ? {
			success: true,
			value: result.data
		} : {
			success: false,
			error: result.error
		};
	} });
}
function zod4Schema(zodSchema, options) {
	const useReferences = options?.useReferences ?? false;
	return jsonSchema(() => addAdditionalPropertiesToJsonSchema(toJSONSchema(zodSchema, {
		target: "draft-7",
		io: "input",
		reused: useReferences ? "ref" : "inline"
	})), { validate: async (value) => {
		const result = await safeParseAsync(zodSchema, value);
		return result.success ? {
			success: true,
			value: result.data
		} : {
			success: false,
			error: result.error
		};
	} });
}
function isZod4Schema(zodSchema) {
	return "_zod" in zodSchema;
}
function zodSchema(zodSchema, options) {
	if (isZod4Schema(zodSchema)) return zod4Schema(zodSchema, options);
	else return zod3Schema(zodSchema, options);
}
/**
* Validates the types of an unknown object using a schema and
* return a strongly-typed object.
*
* @template T - The type of the object to validate.
* @param {string} options.value - The object to validate.
* @param {Validator<T>} options.schema - The schema to use for validating the JSON.
* @param {TypeValidationContext} options.context - Optional context about what is being validated.
* @returns {Promise<T>} - The typed object.
*/
async function validateTypes({ value, schema, context }) {
	const result = await safeValidateTypes({
		value,
		schema,
		context
	});
	if (!result.success) throw TypeValidationError.wrap({
		value,
		cause: result.error,
		context
	});
	return result.value;
}
/**
* Safely validates the types of an unknown object using a schema and
* return a strongly-typed object.
*
* @template T - The type of the object to validate.
* @param {string} options.value - The JSON object to validate.
* @param {Validator<T>} options.schema - The schema to use for validating the JSON.
* @param {TypeValidationContext} options.context - Optional context about what is being validated.
* @returns An object with either a `success` flag and the parsed and typed data, or a `success` flag and an error object.
*/
async function safeValidateTypes({ value, schema, context }) {
	const actualSchema = asSchema(schema);
	try {
		if (actualSchema.validate == null) return {
			success: true,
			value,
			rawValue: value
		};
		const result = await actualSchema.validate(value);
		if (result.success) return {
			success: true,
			value: result.value,
			rawValue: value
		};
		return {
			success: false,
			error: TypeValidationError.wrap({
				value,
				cause: result.error,
				context
			}),
			rawValue: value
		};
	} catch (error) {
		return {
			success: false,
			error: TypeValidationError.wrap({
				value,
				cause: error,
				context
			}),
			rawValue: value
		};
	}
}
async function parseJSON({ text, schema }) {
	try {
		const value = secureJsonParse(text);
		if (schema == null) return value;
		return await validateTypes({
			value,
			schema
		});
	} catch (error) {
		if (JSONParseError.isInstance(error) || TypeValidationError.isInstance(error)) throw error;
		throw new JSONParseError({
			text,
			cause: error
		});
	}
}
async function safeParseJSON({ text, schema }) {
	try {
		const value = secureJsonParse(text);
		if (schema == null) return {
			success: true,
			value,
			rawValue: value
		};
		return await safeValidateTypes({
			value,
			schema
		});
	} catch (error) {
		return {
			success: false,
			error: JSONParseError.isInstance(error) ? error : new JSONParseError({
				text,
				cause: error
			}),
			rawValue: void 0
		};
	}
}
/**
* Parses a JSON event stream into a stream of parsed JSON objects.
*/
function parseJsonEventStream({ stream, schema }) {
	return stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).pipeThrough(new TransformStream({ async transform({ data }, controller) {
		if (data === "[DONE]") return;
		controller.enqueue(await safeParseJSON({
			text: data,
			schema
		}));
	} }));
}
async function parseProviderOptions({ provider, providerOptions, schema }) {
	if (providerOptions?.[provider] == null) return;
	const parsedProviderOptions = await safeValidateTypes({
		value: providerOptions[provider],
		schema
	});
	if (!parsedProviderOptions.success) throw new InvalidArgumentError({
		argument: "providerOptions",
		message: `invalid ${provider} provider options`,
		cause: parsedProviderOptions.error
	});
	return parsedProviderOptions.value;
}
const getOriginalFetch = () => globalThis.fetch;
const postJsonToApi = async ({ url, headers, body, failedResponseHandler, successfulResponseHandler, abortSignal, fetch }) => await postToApi({
	url,
	headers: {
		"Content-Type": "application/json",
		...headers
	},
	body: {
		content: JSON.stringify(body),
		values: body
	},
	failedResponseHandler,
	successfulResponseHandler,
	abortSignal,
	fetch
});
const postToApi = async ({ url, headers = {}, body, successfulResponseHandler, failedResponseHandler, abortSignal, fetch = getOriginalFetch() }) => {
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: withUserAgentSuffix(headers, `ai-sdk-provider-utils/5.0.60`, getRuntimeEnvironmentUserAgent()),
			body: body.content,
			signal: abortSignal
		});
		const responseHeaders = extractResponseHeaders(response);
		if (!response.ok) {
			let errorInformation;
			try {
				errorInformation = await failedResponseHandler({
					response,
					url,
					requestBodyValues: body.values
				});
			} catch (error) {
				if (isAbortError(error) || APICallError.isInstance(error)) throw error;
				throw new APICallError({
					message: "Failed to process error response",
					cause: error,
					statusCode: response.status,
					url,
					responseHeaders,
					requestBodyValues: body.values
				});
			}
			throw errorInformation.value;
		}
		try {
			return await successfulResponseHandler({
				response,
				url,
				requestBodyValues: body.values
			});
		} catch (error) {
			if (error instanceof Error) {
				if (isAbortError(error) || APICallError.isInstance(error)) throw error;
			}
			throw new APICallError({
				message: "Failed to process successful response",
				cause: error,
				statusCode: response.status,
				url,
				responseHeaders,
				requestBodyValues: body.values
			});
		}
	} catch (error) {
		throw handleFetchError({
			error,
			url,
			requestBodyValues: body.values
		});
	}
};
function tool(tool) {
	return tool;
}
function createProviderExecutedToolFactory({ id, inputSchema, outputSchema, supportsDeferredResults }) {
	return ({ onInputStart, onInputDelta, onInputAvailable, ...args }) => tool({
		type: "provider",
		isProviderExecuted: true,
		id,
		args,
		inputSchema,
		outputSchema,
		onInputStart,
		onInputDelta,
		onInputAvailable,
		supportsDeferredResults
	});
}
/**
* Resolves a value that could be a raw value, a Promise, a function returning a value,
* or a function returning a Promise.
*/
async function resolve(value) {
	if (typeof value === "function") value = value();
	return value;
}
const textDecoder = new TextDecoder();
const DEFAULT_MAX_JSON_LINE_BYTES = 67108864;
function wrapResponseBodyStream({ stream, url, requestBodyValues, statusCode, responseHeaders }) {
	const reader = stream.getReader();
	let readerReleased = false;
	const releaseReader = () => {
		if (!readerReleased) {
			reader.releaseLock();
			readerReleased = true;
		}
	};
	return new ReadableStream({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					releaseReader();
					controller.close();
				} else controller.enqueue(value);
			} catch (error) {
				releaseReader();
				if (isAbortError(error)) {
					controller.error(error);
					return;
				}
				controller.error(handleFetchError({
					error: new APICallError({
						message: "Failed to process successful response",
						cause: error,
						statusCode,
						url,
						responseHeaders,
						requestBodyValues
					}),
					url,
					requestBodyValues
				}));
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				releaseReader();
			}
		}
	});
}
async function readResponseBodyAsText({ response, url }) {
	return textDecoder.decode(await readResponseWithSizeLimit({
		response,
		url
	}));
}
const createJsonErrorResponseHandler = ({ errorSchema, errorToMessage, isRetryable }) => async ({ response, url, requestBodyValues }) => {
	const responseBody = await readResponseBodyAsText({
		response,
		url
	});
	const responseHeaders = extractResponseHeaders(response);
	if (responseBody.trim() === "") return {
		responseHeaders,
		value: new APICallError({
			message: response.statusText,
			url,
			requestBodyValues,
			statusCode: response.status,
			responseHeaders,
			responseBody,
			isRetryable: isRetryable?.(response)
		})
	};
	try {
		const parsedError = await parseJSON({
			text: responseBody,
			schema: errorSchema
		});
		return {
			responseHeaders,
			value: new APICallError({
				message: errorToMessage(parsedError),
				url,
				requestBodyValues,
				statusCode: response.status,
				responseHeaders,
				responseBody,
				data: parsedError,
				isRetryable: isRetryable?.(response, parsedError)
			})
		};
	} catch {
		return {
			responseHeaders,
			value: new APICallError({
				message: response.statusText,
				url,
				requestBodyValues,
				statusCode: response.status,
				responseHeaders,
				responseBody,
				isRetryable: isRetryable?.(response)
			})
		};
	}
};
const createEventSourceResponseHandler = (chunkSchema) => async ({ response, url, requestBodyValues }) => {
	const responseHeaders = extractResponseHeaders(response);
	if (response.body == null) throw new EmptyResponseBodyError({});
	return {
		responseHeaders,
		value: parseJsonEventStream({
			stream: wrapResponseBodyStream({
				stream: response.body,
				url,
				requestBodyValues,
				statusCode: response.status,
				responseHeaders
			}),
			schema: chunkSchema
		})
	};
};
const createJsonResponseHandler = (responseSchema) => async ({ response, url, requestBodyValues }) => {
	const responseBody = await readResponseBodyAsText({
		response,
		url
	});
	const parsedResult = await safeParseJSON({
		text: responseBody,
		schema: responseSchema
	});
	const responseHeaders = extractResponseHeaders(response);
	if (!parsedResult.success) throw new APICallError({
		message: "Invalid JSON response",
		cause: parsedResult.error,
		statusCode: response.status,
		responseHeaders,
		responseBody,
		url,
		requestBodyValues
	});
	return {
		responseHeaders,
		value: parsedResult.value,
		rawValue: parsedResult.rawValue
	};
};
const createJsonLinesResponseHandler = (responseSchema, { maxLineBytes = DEFAULT_MAX_JSON_LINE_BYTES } = {}) => {
	if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) throw new InvalidArgumentError({
		argument: "maxLineBytes",
		message: "maxLineBytes must be a positive safe integer."
	});
	return async ({ response, url }) => {
		const responseHeaders = extractResponseHeaders(response);
		if (response.body == null) throw new EmptyResponseBodyError({});
		return {
			responseHeaders,
			value: parseJsonLines({
				stream: response.body,
				schema: responseSchema,
				url,
				maxLineBytes
			})
		};
	};
};
async function* parseJsonLines({ stream, schema, url, maxLineBytes }) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let lineBytes = 0;
	let finished = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				finished = true;
				buffer += decoder.decode();
				break;
			}
			let offset = 0;
			while (offset < value.length) {
				const lineEnd = value.indexOf(10, offset);
				const segmentEnd = lineEnd === -1 ? value.length : lineEnd;
				lineBytes += segmentEnd - offset;
				if (lineBytes > maxLineBytes) throw new DownloadError({
					message: `JSON Lines response exceeded maximum line size of ${maxLineBytes} bytes.`,
					url
				});
				const decodeEnd = lineEnd === -1 ? segmentEnd : lineEnd + 1;
				buffer += decoder.decode(value.subarray(offset, decodeEnd), { stream: true });
				if (lineEnd === -1) break;
				const line = buffer.slice(0, -1).replace(/\r$/, "");
				buffer = "";
				lineBytes = 0;
				offset = decodeEnd;
				if (line.trim().length > 0) yield await parseJSON({
					text: line,
					schema
				});
			}
		}
		const finalLine = buffer.replace(/\r$/, "");
		if (finalLine.trim().length > 0) yield await parseJSON({
			text: finalLine,
			schema
		});
	} finally {
		if (!finished) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
/**
* Checks whether a value can cross a workflow serialization boundary.
*
* The check accepts JSON-like primitives, arrays, and plain objects whose
* nested values are also serializable. It rejects functions, symbols,
* bigints, and non-plain objects such as class instances, dates, and regexes.
*/
function isJSONSerializable(value) {
	if (value === null || value === void 0) return true;
	const type = typeof value;
	if (type === "string" || type === "number" || type === "boolean") return true;
	if (type === "function" || type === "symbol" || type === "bigint") return false;
	if (Array.isArray(value)) return value.every(isJSONSerializable);
	if (Object.getPrototypeOf(value) === Object.prototype) return Object.values(value).every(isJSONSerializable);
	return false;
}
const name$10 = "AI_SerializationError";
const marker$10 = `vercel.ai.error.${name$10}`;
const symbol$11 = Symbol.for(marker$10);
var SerializationError = class extends AISDKError {
	constructor({ message = "Failed to serialize value.", cause } = {}) {
		super({
			name: name$10,
			message,
			cause
		});
		this[symbol$11] = true;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$10);
	}
};
/**
* Serializes a model instance for workflow step boundaries.
* Returns the `modelId` plus the JSON-serializable config properties.
*
* Non-serializable values are omitted. As a special case, a
* function-valued `headers` property is resolved during serialization
* and included if the returned value is JSON-serializable.
*
* Used as the body of `static [WORKFLOW_SERIALIZE]` in provider models.
*
* @example
* ```ts
* static [WORKFLOW_SERIALIZE](model: MyLanguageModel) {
*   return serializeModelOptions({
*     modelId: model.modelId,
*     config: model.config,
*   });
* }
* ```
*/
function serializeModelOptions(options) {
	const serializableConfig = {};
	for (const [key, value] of Object.entries(options.config)) if (key === "headers") {
		const resolvedHeaders = resolveSync(value);
		if (isJSONSerializable(resolvedHeaders)) serializableConfig[key] = resolvedHeaders;
	} else if (isJSONSerializable(value)) serializableConfig[key] = value;
	return {
		modelId: options.modelId,
		config: serializableConfig
	};
}
function resolveSync(value) {
	let next = value;
	if (typeof value === "function") next = value();
	if (next instanceof Promise) throw new SerializationError({ message: "Cannot serialize asynchronous model options." });
	return next;
}
/**
* Client-side: parse a server TEXT frame into a transcription stream part.
* Returns `undefined` for malformed or unsafe (prototype-polluting) JSON
* (parsed with `secureJsonParse`), unknown part types, and known part types
* whose required or optional fields are missing or mistyped (including
* warning and segment elements) — downstream SDK code dereferences those
* fields, so a drifted server must not crash or pollute the stream.
* Revives `response-metadata.timestamp` to a `Date`.
*/
function parseTranscriptionStreamPart(text) {
	let value;
	try {
		value = secureJsonParse(text);
	} catch {
		return;
	}
	if (value == null || typeof value !== "object" || Array.isArray(value)) return;
	const part = value;
	switch (part.type) {
		case "stream-start": return Array.isArray(part.warnings) && part.warnings.every(isWarning) ? part : void 0;
		case "transcript-delta": return isString(part.delta) && isOptional(part.id, isString) && isOptional(part.providerMetadata, isRecord) ? part : void 0;
		case "transcript-partial": return isString(part.text) && isOptional(part.id, isString) && isOptional(part.startSecond, isNumber) && isOptional(part.durationInSeconds, isNumber) && isOptional(part.channelIndex, isNumber) && isOptional(part.providerMetadata, isRecord) ? part : void 0;
		case "transcript-final": return isString(part.text) && isOptional(part.id, isString) && isOptional(part.startSecond, isNumber) && isOptional(part.endSecond, isNumber) && isOptional(part.channelIndex, isNumber) && isOptional(part.providerMetadata, isRecord) ? part : void 0;
		case "finish": return isString(part.text) && Array.isArray(part.segments) && part.segments.every(isSegment) && isOptional(part.language, isString) && isOptional(part.durationInSeconds, isNumber) && isOptional(part.usage, isRecord) && isOptional(part.providerMetadata, isRecord) ? part : void 0;
		case "response-metadata": {
			if (!(isOptional(part.modelId, isString) && isOptional(part.headers, isRecord))) return;
			const timestamp = part.timestamp;
			if (timestamp == null) return {
				...part,
				timestamp: void 0
			};
			if (typeof timestamp !== "string") return;
			const revived = new Date(timestamp);
			return Number.isNaN(revived.getTime()) ? void 0 : {
				...part,
				timestamp: revived
			};
		}
		case "raw": return "rawValue" in part ? part : void 0;
		case "error": return "error" in part ? part : void 0;
		default: return;
	}
}
function isString(value) {
	return typeof value === "string";
}
function isNumber(value) {
	return typeof value === "number";
}
function isOptional(value, check) {
	return value === void 0 || check(value);
}
function isWarning(value) {
	return isRecord(value) && isString(value.type);
}
function isSegment(value) {
	return isRecord(value) && isString(value.text) && isNumber(value.startSecond) && isNumber(value.endSecond);
}
function withoutTrailingSlash(url) {
	return url?.replace(/\/$/, "");
}
//#endregion
//#region node_modules/@vercel/oidc/dist/get-context.js
var require_get_context = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var get_context_exports = {};
	__export(get_context_exports, {
		SYMBOL_FOR_REQ_CONTEXT: () => SYMBOL_FOR_REQ_CONTEXT,
		getContext: () => getContext
	});
	module.exports = __toCommonJS(get_context_exports);
	const SYMBOL_FOR_REQ_CONTEXT = Symbol.for("@vercel/request-context");
	function getContext() {
		return globalThis[SYMBOL_FOR_REQ_CONTEXT]?.get?.() ?? {};
	}
	0 && (module.exports = {
		SYMBOL_FOR_REQ_CONTEXT,
		getContext
	});
}));
//#endregion
//#region node_modules/@vercel/oidc/dist/get-vercel-oidc-token.js
var require_get_vercel_oidc_token = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var get_vercel_oidc_token_exports = {};
	__export(get_vercel_oidc_token_exports, {
		getVercelOidcToken: () => getVercelOidcToken,
		getVercelOidcTokenSync: () => getVercelOidcTokenSync
	});
	module.exports = __toCommonJS(get_vercel_oidc_token_exports);
	var import_get_context = require_get_context();
	var import_token_error = require_token_error();
	async function getVercelOidcToken(options) {
		let token = "";
		let err;
		try {
			token = getVercelOidcTokenSync();
		} catch (error) {
			err = error;
		}
		try {
			const [{ getTokenPayload, isExpired }, { refreshToken }] = await Promise.all([await import("../_.mjs").then((m) => /* @__PURE__ */ __toESM(m.default)), await import("../_2.mjs").then((m) => /* @__PURE__ */ __toESM(m.default))]);
			if (!token || isExpired(getTokenPayload(token), options?.expirationBufferMs)) {
				await refreshToken(options);
				token = getVercelOidcTokenSync();
			}
		} catch (error) {
			let message = err instanceof Error ? err.message : "";
			if (error instanceof Error) message = `${message}
${error.message}`;
			if (message) throw new import_token_error.VercelOidcTokenError(message);
			throw error;
		}
		return token;
	}
	function getVercelOidcTokenSync() {
		const token = (0, import_get_context.getContext)().headers?.["x-vercel-oidc-token"] ?? process.env.VERCEL_OIDC_TOKEN;
		if (!token) throw new Error(`The 'x-vercel-oidc-token' header is missing from the request. Do you have the OIDC option enabled in the Vercel project settings?`);
		return token;
	}
	0 && (module.exports = {
		getVercelOidcToken,
		getVercelOidcTokenSync
	});
}));
//#endregion
//#region node_modules/@ai-sdk/gateway/dist/index.js
var import_dist = (/* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var src_exports = {};
	__export(src_exports, {
		AccessTokenMissingError: () => import_auth_errors.AccessTokenMissingError,
		RefreshAccessTokenFailedError: () => import_auth_errors.RefreshAccessTokenFailedError,
		getContext: () => import_get_context.getContext,
		getVercelOidcToken: () => import_get_vercel_oidc_token.getVercelOidcToken,
		getVercelOidcTokenSync: () => import_get_vercel_oidc_token.getVercelOidcTokenSync,
		getVercelToken: () => import_token_util.getVercelToken
	});
	module.exports = __toCommonJS(src_exports);
	var import_get_vercel_oidc_token = require_get_vercel_oidc_token();
	var import_get_context = require_get_context();
	var import_auth_errors = require_auth_errors();
	var import_token_util = require_token_util();
	0 && (module.exports = {
		AccessTokenMissingError,
		RefreshAccessTokenFailedError,
		getContext,
		getVercelOidcToken,
		getVercelOidcTokenSync,
		getVercelToken
	});
})))();
/**
* Client-side: build the WebSocket subprotocols that carry `token` to the
* Gateway. Pass the result as the second argument to `new WebSocket(url, ...)`.
*/
function getGatewayRealtimeProtocols(token, options) {
	return buildGatewayProtocols("ai-gateway-realtime.v1", token, options);
}
/**
* Client-side: `getGatewayRealtimeProtocols`, but with the streaming
* transcription marker subprotocol.
*/
function getGatewayTranscriptionProtocols(token, options) {
	return buildGatewayProtocols("ai-gateway-transcription.v1", token, options);
}
function buildGatewayProtocols(marker, token, options) {
	const protocols = [marker, `ai-gateway-auth.${token}`];
	if (options?.teamIdOrSlug) protocols.push(`ai-gateway-team.${encodeSubprotocolValue(options.teamIdOrSlug)}`);
	return protocols;
}
function encodeSubprotocolValue(value) {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
const z = {
	any,
	array,
	boolean,
	discriminatedUnion,
	enum: _enum,
	literal,
	json,
	number,
	object,
	record,
	string,
	union,
	unknown
};
const symbol$10 = Symbol.for("vercel.ai.gateway.error");
var GatewayError = class GatewayError extends Error {
	constructor({ message, statusCode = 500, cause, generationId, isRetryable = statusCode != null && (statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500) }) {
		super(generationId ? `${message} [${generationId}]` : message);
		this[symbol$10] = true;
		this.statusCode = statusCode;
		this.cause = cause;
		this.generationId = generationId;
		this.isRetryable = isRetryable;
	}
	/**
	* Checks if the given error is a Gateway Error.
	* @param {unknown} error - The error to check.
	* @returns {boolean} True if the error is a Gateway Error, false otherwise.
	*/
	static isInstance(error) {
		return GatewayError.hasMarker(error);
	}
	static hasMarker(error) {
		return typeof error === "object" && error !== null && symbol$10 in error && error[symbol$10] === true;
	}
};
const name$9 = "GatewayAuthenticationError";
const marker$9 = `vercel.ai.gateway.error.${name$9}`;
const symbol$9 = Symbol.for(marker$9);
/**
* Authentication failed - invalid API key or OIDC token
*/
var GatewayAuthenticationError = class GatewayAuthenticationError extends GatewayError {
	constructor({ message = "Authentication failed", statusCode = 401, cause, generationId } = {}) {
		super({
			message,
			statusCode,
			cause,
			generationId
		});
		this[symbol$9] = true;
		this.name = name$9;
		this.type = "authentication_error";
	}
	static isInstance(error) {
		return GatewayError.hasMarker(error) && symbol$9 in error;
	}
	/**
	* Creates a contextual error message when authentication fails
	*/
	static createContextualError({ apiKeyProvided, oidcTokenProvided, statusCode = 401, cause, generationId }) {
		let contextualMessage;
		if (apiKeyProvided) contextualMessage = `AI Gateway authentication failed: Invalid API key or token.

Create a new API key: https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys

Provide an API key or Vercel access token via 'apiKey' option or 'AI_GATEWAY_API_KEY' environment variable.`;
		else if (oidcTokenProvided) contextualMessage = `AI Gateway authentication failed: Invalid OIDC token.

Run 'npx vercel link' to link your project, then 'vc env pull' to fetch the token.

Alternatively, use an API key: https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys
or pass a Vercel access token via the 'apiKey' option.`;
		else contextualMessage = `AI Gateway authentication failed: No authentication provided.

Option 1 - API key:
Create an API key: https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys
Provide via 'apiKey' option or 'AI_GATEWAY_API_KEY' environment variable.

Option 2 - Vercel access token:
Pass a Vercel personal access token or Vercel app access token via the 'apiKey' option.

Option 3 - OIDC token:
Run 'npx vercel link' to link your project, then 'vc env pull' to fetch the token.`;
		return new GatewayAuthenticationError({
			message: contextualMessage,
			statusCode,
			cause,
			generationId
		});
	}
};
const name$8 = "GatewayInvalidRequestError";
const marker$8 = `vercel.ai.gateway.error.${name$8}`;
const symbol$8 = Symbol.for(marker$8);
/**
* Invalid request - missing headers, malformed data, etc.
*/
var GatewayInvalidRequestError = class extends GatewayError {
	constructor({ message = "Invalid request", statusCode = 400, cause, generationId } = {}) {
		super({
			message,
			statusCode,
			cause,
			generationId
		});
		this[symbol$8] = true;
		this.name = name$8;
		this.type = "invalid_request_error";
	}
	static isInstance(error) {
		return GatewayError.hasMarker(error) && symbol$8 in error;
	}
};
const name$7 = "GatewayRateLimitError";
const marker$7 = `vercel.ai.gateway.error.${name$7}`;
const symbol$7 = Symbol.for(marker$7);
/**
* Rate limit exceeded.
*/
var GatewayRateLimitError = class extends GatewayError {
	constructor({ message = "Rate limit exceeded", statusCode = 429, cause, generationId } = {}) {
		super({
			message,
			statusCode,
			cause,
			generationId
		});
		this[symbol$7] = true;
		this.name = name$7;
		this.type = "rate_limit_exceeded";
	}
	static isInstance(error) {
		return GatewayError.hasMarker(error) && symbol$7 in error;
	}
};
const name$6 = "GatewayModelNotFoundError";
const marker$6 = `vercel.ai.gateway.error.${name$6}`;
const symbol$6 = Symbol.for(marker$6);
const modelNotFoundParamSchema = lazySchema(() => zodSchema(z.object({ modelId: z.string() })));
/**
* Model not found or not available
*/
var GatewayModelNotFoundError = class extends GatewayError {
	constructor({ message = "Model not found", statusCode = 404, modelId, cause, generationId } = {}) {
		super({
			message,
			statusCode,
			cause,
			generationId
		});
		this[symbol$6] = true;
		this.name = name$6;
		this.type = "model_not_found";
		this.modelId = modelId;
	}
	static isInstance(error) {
		return GatewayError.hasMarker(error) && symbol$6 in error;
	}
};
const name$5 = "GatewayNotFoundError";
const marker$5 = `vercel.ai.gateway.error.${name$5}`;
const symbol$5 = Symbol.for(marker$5);
/**
* Not found - the requested Gateway resource does not exist or is not
* visible to the caller (e.g. an unknown async batch/video job id).
* Distinct from `GatewayModelNotFoundError`, which is model-specific.
*/
var GatewayNotFoundError = class extends GatewayError {
	constructor({ message = "Resource not found", statusCode = 404, cause, generationId } = {}) {
		super({
			message,
			statusCode,
			cause,
			generationId
		});
		this[symbol$5] = true;
		this.name = name$5;
		this.type = "not_found";
	}
	static isInstance(error) {
		return GatewayError.hasMarker(error) && symbol$5 in error;
	}
};
const name$4 = "GatewayInternalServerError";
const marker$4 = `vercel.ai.gateway.error.${name$4}`;
const symbol$4 = Symbol.for(marker$4);
/**
* Internal server error from the Gateway
*/
var GatewayInternalServerError = class extends GatewayError {
	constructor({ message = "Internal server error", statusCode = 500, cause, generationId } = {}) {
		super({
			message,
			statusCode,
			cause,
			generationId
		});
		this[symbol$4] = true;
		this.name = name$4;
		this.type = "internal_server_error";
	}
	static isInstance(error) {
		return GatewayError.hasMarker(error) && symbol$4 in error;
	}
};
const name$3 = "GatewayFailedDependencyError";
const marker$3 = `vercel.ai.gateway.error.${name$3}`;
const symbol$3 = Symbol.for(marker$3);
/**
* The request could not be fulfilled because a dependency it relied on was not
* available on the credentials or provider used to serve it (HTTP 424). Not
* retryable — the caller must change the request.
*/
var GatewayFailedDependencyError = class extends GatewayError {
	constructor({ message = "Failed dependency", statusCode = 424, cause, generationId } = {}) {
		super({
			message,
			statusCode,
			cause,
			generationId
		});
		this[symbol$3] = true;
		this.name = name$3;
		this.type = "failed_dependency";
	}
	static isInstance(error) {
		return GatewayError.hasMarker(error) && symbol$3 in error;
	}
};
const name$2 = "GatewayForbiddenError";
const marker$2 = `vercel.ai.gateway.error.${name$2}`;
const symbol$2 = Symbol.for(marker$2);
const forbiddenParamSchema = lazySchema(() => zodSchema(z.object({ ruleId: z.string() })));
/**
* Forbidden - the request was rejected by policy (e.g. a routing rule),
* not an authentication failure.
*/
var GatewayForbiddenError = class extends GatewayError {
	constructor({ message = "Forbidden", statusCode = 403, cause, generationId, ruleId } = {}) {
		super({
			message,
			statusCode,
			cause,
			generationId
		});
		this[symbol$2] = true;
		this.name = name$2;
		this.type = "forbidden";
		this.ruleId = ruleId;
	}
	static isInstance(error) {
		return GatewayError.hasMarker(error) && symbol$2 in error;
	}
};
const name$1 = "GatewayResponseError";
const marker$1 = `vercel.ai.gateway.error.${name$1}`;
const symbol$1 = Symbol.for(marker$1);
/**
* Gateway response parsing error
*/
var GatewayResponseError = class extends GatewayError {
	constructor({ message = "Invalid response from Gateway", statusCode = 502, response, validationError, cause, generationId, isRetryable } = {}) {
		super({
			message,
			statusCode,
			cause,
			generationId,
			isRetryable
		});
		this[symbol$1] = true;
		this.name = name$1;
		this.type = "response_error";
		this.response = response;
		this.validationError = validationError;
	}
	static isInstance(error) {
		return GatewayError.hasMarker(error) && symbol$1 in error;
	}
};
async function createGatewayErrorFromResponse({ response, statusCode, defaultMessage = "Gateway request failed", cause, authMethod, isRetryable }) {
	const parseResult = await safeValidateTypes({
		value: response,
		schema: gatewayErrorResponseSchema
	});
	if (!parseResult.success) {
		const rawGenerationId = typeof response === "object" && response !== null && "generationId" in response ? response.generationId : void 0;
		return new GatewayResponseError({
			message: `Invalid error response format: ${defaultMessage}`,
			statusCode,
			response,
			validationError: parseResult.error,
			cause,
			generationId: rawGenerationId,
			isRetryable
		});
	}
	const validatedResponse = parseResult.value;
	const errorType = validatedResponse.error.type;
	const message = validatedResponse.error.message;
	const generationId = validatedResponse.generationId ?? void 0;
	switch (errorType) {
		case "authentication_error": return GatewayAuthenticationError.createContextualError({
			apiKeyProvided: authMethod === "api-key",
			oidcTokenProvided: authMethod === "oidc",
			statusCode,
			cause,
			generationId
		});
		case "invalid_request_error": return new GatewayInvalidRequestError({
			message,
			statusCode,
			cause,
			generationId
		});
		case "rate_limit_exceeded": return new GatewayRateLimitError({
			message,
			statusCode,
			cause,
			generationId
		});
		case "model_not_found": {
			const modelResult = await safeValidateTypes({
				value: validatedResponse.error.param,
				schema: modelNotFoundParamSchema
			});
			return new GatewayModelNotFoundError({
				message,
				statusCode,
				modelId: modelResult.success ? modelResult.value.modelId : void 0,
				cause,
				generationId
			});
		}
		case "not_found": return new GatewayNotFoundError({
			message,
			statusCode,
			cause,
			generationId
		});
		case "internal_server_error": return new GatewayInternalServerError({
			message,
			statusCode,
			cause,
			generationId
		});
		case "failed_dependency": return new GatewayFailedDependencyError({
			message,
			statusCode,
			cause,
			generationId
		});
		case "forbidden": {
			const ruleResult = await safeValidateTypes({
				value: validatedResponse.error.param,
				schema: forbiddenParamSchema
			});
			return new GatewayForbiddenError({
				message,
				statusCode,
				cause,
				generationId,
				ruleId: ruleResult.success ? ruleResult.value.ruleId : void 0
			});
		}
		default: return new GatewayInternalServerError({
			message,
			statusCode,
			cause,
			generationId
		});
	}
}
const gatewayErrorResponseSchema = lazySchema(() => zodSchema(z.object({
	error: z.object({
		message: z.string(),
		type: z.string().nullish(),
		param: z.unknown().nullish(),
		code: z.union([z.string(), z.number()]).nullish()
	}),
	generationId: z.string().nullish()
})));
function extractApiCallResponse(error) {
	if (error.data !== void 0) return error.data;
	if (error.responseBody != null) try {
		return secureJsonParse(error.responseBody);
	} catch {
		return error.responseBody;
	}
	return {};
}
const name = "GatewayTimeoutError";
const marker = `vercel.ai.gateway.error.${name}`;
const symbol = Symbol.for(marker);
/**
* Client request timed out before receiving a response.
*/
var GatewayTimeoutError = class GatewayTimeoutError extends GatewayError {
	constructor({ message = "Request timed out", statusCode = 408, cause, generationId } = {}) {
		super({
			message,
			statusCode,
			cause,
			generationId
		});
		this[symbol] = true;
		this.name = name;
		this.type = "timeout_error";
	}
	static isInstance(error) {
		return GatewayError.hasMarker(error) && symbol in error;
	}
	/**
	* Creates a helpful timeout error message with troubleshooting guidance
	*/
	static createTimeoutError({ originalMessage, statusCode = 408, cause, generationId }) {
		const message = `Gateway request timed out: ${originalMessage}

    This is a client-side timeout. To resolve this, increase your timeout configuration: https://vercel.com/docs/ai-gateway/capabilities/video-generation#extending-timeouts-for-node.js`;
		return new GatewayTimeoutError({
			message,
			statusCode,
			cause,
			generationId
		});
	}
};
/**
* Checks if an error is a timeout error from undici.
* Only checks undici-specific error codes to avoid false positives.
*/
function isTimeoutError(error) {
	if (!(error instanceof Error)) return false;
	const errorCode = error.code;
	if (typeof errorCode === "string") return [
		"UND_ERR_HEADERS_TIMEOUT",
		"UND_ERR_BODY_TIMEOUT",
		"UND_ERR_CONNECT_TIMEOUT"
	].includes(errorCode);
	return false;
}
async function asGatewayError(error, authMethod) {
	if (GatewayError.isInstance(error)) return error;
	if (isTimeoutError(error)) return GatewayTimeoutError.createTimeoutError({
		originalMessage: error instanceof Error ? error.message : "Unknown error",
		cause: error
	});
	if (APICallError.isInstance(error)) {
		if (error.cause && isTimeoutError(error.cause)) return GatewayTimeoutError.createTimeoutError({
			originalMessage: error.message,
			cause: error
		});
		return await createGatewayErrorFromResponse({
			response: extractApiCallResponse(error),
			statusCode: error.statusCode ?? 500,
			defaultMessage: "Gateway request failed",
			cause: error,
			authMethod,
			isRetryable: error.isRetryable && (error.statusCode == null || error.statusCode < 400) ? true : void 0
		});
	}
	return await createGatewayErrorFromResponse({
		response: {},
		statusCode: 500,
		defaultMessage: error instanceof Error ? `Gateway request failed: ${error.message}` : "Unknown Gateway error",
		cause: error,
		authMethod
	});
}
const GATEWAY_AUTH_METHOD_HEADER = "ai-gateway-auth-method";
const VERCEL_AI_GATEWAY_TEAM_HEADER = "x-vercel-ai-gateway-team";
async function parseAuthMethod(headers) {
	const result = await safeValidateTypes({
		value: headers[GATEWAY_AUTH_METHOD_HEADER],
		schema: gatewayAuthMethodSchema
	});
	return result.success ? result.value : void 0;
}
const gatewayAuthMethodSchema = lazySchema(() => zodSchema(z.union([z.literal("api-key"), z.literal("oidc")])));
const KNOWN_MODEL_TYPES = [
	"embedding",
	"decision",
	"evaluation",
	"image",
	"language",
	"realtime",
	"reranking",
	"speech",
	"transcription",
	"video"
];
var GatewayFetchMetadata = class {
	constructor(config) {
		this.config = config;
	}
	async getAvailableModels() {
		try {
			const { value } = await getFromApi({
				url: `${this.config.baseURL}/config`,
				validateUrl: false,
				headers: this.config.headers ? await resolve(this.config.headers) : void 0,
				successfulResponseHandler: createJsonResponseHandler(gatewayAvailableModelsResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				fetch: this.config.fetch
			});
			return value;
		} catch (error) {
			throw await asGatewayError(error);
		}
	}
	async getCredits() {
		try {
			const baseUrl = new URL(this.config.baseURL);
			const headers = this.config.headers ? await resolve(this.config.headers) : void 0;
			const url = new URL("/v1/credits", baseUrl.origin);
			const teamIdOrSlug = getTeamIdOrSlug(headers);
			if (teamIdOrSlug) url.searchParams.set(teamIdOrSlug.startsWith("team_") ? "teamId" : "slug", teamIdOrSlug);
			const { value } = await getFromApi({
				url: url.toString(),
				validateUrl: false,
				headers,
				successfulResponseHandler: createJsonResponseHandler(gatewayCreditsResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				fetch: this.config.fetch
			});
			return value;
		} catch (error) {
			throw await asGatewayError(error);
		}
	}
};
function getTeamIdOrSlug(headers) {
	if (!headers) return void 0;
	for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === "x-vercel-ai-gateway-team") return value?.trim() || void 0;
}
const gatewayAvailableModelsResponseSchema = lazySchema(() => zodSchema(z.object({ models: z.array(z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().nullish(),
	pricing: z.object({
		input: z.string(),
		output: z.string(),
		input_cache_read: z.string().nullish(),
		input_cache_write: z.string().nullish()
	}).transform(({ input, output, input_cache_read, input_cache_write }) => ({
		input,
		output,
		...input_cache_read ? { cachedInputTokens: input_cache_read } : {},
		...input_cache_write ? { cacheCreationInputTokens: input_cache_write } : {}
	})).nullish(),
	specification: z.object({
		specificationVersion: z.literal("v4"),
		provider: z.string(),
		modelId: z.string()
	}),
	modelType: z.string().nullish()
})).transform((models) => models.filter((m) => m.modelType == null || KNOWN_MODEL_TYPES.includes(m.modelType))) })));
const gatewayCreditsResponseSchema = lazySchema(() => zodSchema(z.object({
	balance: z.string(),
	total_used: z.string()
}).transform(({ balance, total_used }) => ({
	balance,
	totalUsed: total_used
}))));
var GatewaySpendReport = class {
	constructor(config) {
		this.config = config;
	}
	async getSpendReport(params) {
		try {
			const baseUrl = new URL(this.config.baseURL);
			const searchParams = new URLSearchParams();
			searchParams.set("start_date", params.startDate);
			searchParams.set("end_date", params.endDate);
			if (params.groupBy) searchParams.set("group_by", params.groupBy);
			if (params.datePart) searchParams.set("date_part", params.datePart);
			if (params.userId) searchParams.set("user_id", params.userId);
			if (params.model) searchParams.set("model", params.model);
			if (params.provider) searchParams.set("provider", params.provider);
			if (params.credentialType) searchParams.set("credential_type", params.credentialType);
			if (params.tags && params.tags.length > 0) searchParams.set("tags", params.tags.join(","));
			const { value } = await getFromApi({
				url: `${baseUrl.origin}/v1/report?${searchParams.toString()}`,
				validateUrl: false,
				headers: this.config.headers ? await resolve(this.config.headers) : void 0,
				successfulResponseHandler: createJsonResponseHandler(gatewaySpendReportResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				fetch: this.config.fetch
			});
			return value;
		} catch (error) {
			throw await asGatewayError(error);
		}
	}
};
const gatewaySpendReportResponseSchema = lazySchema(() => zodSchema(z.object({ results: z.array(z.object({
	day: z.string().optional(),
	hour: z.string().optional(),
	user: z.string().optional(),
	model: z.string().optional(),
	tag: z.string().optional(),
	provider: z.string().optional(),
	credential_type: z.enum(["byok", "system"]).optional(),
	total_cost: z.number(),
	market_cost: z.number().optional(),
	input_tokens: z.number().optional(),
	output_tokens: z.number().optional(),
	cached_input_tokens: z.number().optional(),
	cache_creation_input_tokens: z.number().optional(),
	reasoning_tokens: z.number().optional(),
	request_count: z.number().optional()
}).transform(({ credential_type, total_cost, market_cost, input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_tokens, request_count, ...rest }) => ({
	...rest,
	...credential_type !== void 0 ? { credentialType: credential_type } : {},
	totalCost: total_cost,
	...market_cost !== void 0 ? { marketCost: market_cost } : {},
	...input_tokens !== void 0 ? { inputTokens: input_tokens } : {},
	...output_tokens !== void 0 ? { outputTokens: output_tokens } : {},
	...cached_input_tokens !== void 0 ? { cachedInputTokens: cached_input_tokens } : {},
	...cache_creation_input_tokens !== void 0 ? { cacheCreationInputTokens: cache_creation_input_tokens } : {},
	...reasoning_tokens !== void 0 ? { reasoningTokens: reasoning_tokens } : {},
	...request_count !== void 0 ? { requestCount: request_count } : {}
}))) })));
var GatewayGenerationInfoFetcher = class {
	constructor(config) {
		this.config = config;
	}
	async getGenerationInfo(params) {
		try {
			const baseUrl = new URL(this.config.baseURL);
			const { value } = await getFromApi({
				url: `${baseUrl.origin}/v1/generation?id=${encodeURIComponent(params.id)}`,
				validateUrl: false,
				headers: this.config.headers ? await resolve(this.config.headers) : void 0,
				successfulResponseHandler: createJsonResponseHandler(gatewayGenerationInfoResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				fetch: this.config.fetch
			});
			return value;
		} catch (error) {
			throw await asGatewayError(error);
		}
	}
};
const gatewayGenerationInfoResponseSchema = lazySchema(() => zodSchema(z.object({ data: z.object({
	id: z.string(),
	total_cost: z.number(),
	upstream_inference_cost: z.number(),
	usage: z.number(),
	created_at: z.string(),
	model: z.string(),
	is_byok: z.boolean(),
	provider_name: z.string(),
	streamed: z.boolean(),
	finish_reason: z.string(),
	latency: z.number(),
	generation_time: z.number(),
	native_tokens_prompt: z.number(),
	native_tokens_completion: z.number(),
	native_tokens_reasoning: z.number(),
	native_tokens_cached: z.number(),
	native_tokens_cache_creation: z.number(),
	billable_web_search_calls: z.number()
}).transform(({ total_cost, upstream_inference_cost, created_at, is_byok, provider_name, finish_reason, generation_time, native_tokens_prompt, native_tokens_completion, native_tokens_reasoning, native_tokens_cached, native_tokens_cache_creation, billable_web_search_calls, ...rest }) => ({
	...rest,
	totalCost: total_cost,
	upstreamInferenceCost: upstream_inference_cost,
	createdAt: created_at,
	isByok: is_byok,
	providerName: provider_name,
	finishReason: finish_reason,
	generationTime: generation_time,
	promptTokens: native_tokens_prompt,
	completionTokens: native_tokens_completion,
	reasoningTokens: native_tokens_reasoning,
	cachedTokens: native_tokens_cached,
	cacheCreationTokens: native_tokens_cache_creation,
	billableWebSearchCalls: billable_web_search_calls
})) }).transform(({ data }) => data)));
var GatewayBatch = class {
	constructor(config) {
		this.config = config;
		this.specificationVersion = "v4";
		this.supportedUrls = { "*/*": [/.*/] };
		this.provider = `${config.provider}.batch`;
	}
	/**
	* Starts a durable batch of text-generation requests through the Gateway's
	* async batch surface (`POST {baseURL}/batch/start`). The returned
	* `batchId` is the Gateway job id — provider-native batch ids stay
	* server-side, so status and results always route back through the
	* Gateway job.
	*/
	async doStartBatch({ requests, providerOptions, headers, abortSignal, webhookUrl }) {
		assertTextBatchRequests(requests);
		const modelId = validateSingleModel(requests);
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		const idempotencyKey = getGatewayBatchIdempotencyKey(providerOptions);
		const forwardedProviderOptions = omitGatewayIdempotencyKey(providerOptions);
		try {
			const { value: responseBody } = await postJsonToApi({
				url: this.getBatchUrl("start"),
				headers: combineHeaders(resolvedHeaders, headers, { "ai-model-id": modelId }, await resolve(this.config.o11yHeaders), idempotencyKey != null ? { "idempotency-key": idempotencyKey } : void 0),
				body: {
					...webhookUrl != null && { callbackUrl: webhookUrl },
					requests: requests.map((request) => ({
						id: request.id,
						type: request.type,
						modelId: request.modelId,
						options: maybeEncodeBatchFileParts(request.options)
					})),
					...forwardedProviderOptions != null && { providerOptions: forwardedProviderOptions }
				},
				successfulResponseHandler: createJsonResponseHandler(gatewayBatchStartResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			return {
				batchId: responseBody.batchId,
				...convertGatewayBatchStatus(responseBody),
				warnings: responseBody.warnings ?? []
			};
		} catch (error) {
			if (isAbortOrTimeoutError(error)) throw error;
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	/**
	* Retrieves the lifecycle status of a Gateway batch job
	* (`POST {baseURL}/batch/status`).
	*/
	async doGetBatchStatus({ batchId, headers, abortSignal }) {
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { value: responseBody } = await postJsonToApi({
				url: this.getBatchUrl("status"),
				headers: combineHeaders(resolvedHeaders, headers, await resolve(this.config.o11yHeaders)),
				body: { batchId },
				successfulResponseHandler: createJsonResponseHandler(gatewayBatchStatusResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			return convertGatewayBatchStatus(responseBody);
		} catch (error) {
			if (isAbortOrTimeoutError(error)) throw error;
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	/**
	* Streams the per-request results of a terminal Gateway batch job
	* (`POST {baseURL}/batch/results`, `application/x-ndjson`: one
	* `BatchV4ItemResult` JSON object per line). Items are validated minimally
	* (id + status) and passed through — the Gateway sanitizes them
	* server-side. The route responds 400 while the batch is non-terminal.
	*/
	async doGetBatchResults({ batchId, headers, abortSignal }) {
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { value: lines } = await postJsonToApi({
				url: this.getBatchUrl("results"),
				headers: combineHeaders(resolvedHeaders, headers, await resolve(this.config.o11yHeaders)),
				body: { batchId },
				successfulResponseHandler: createJsonLinesResponseHandler(gatewayBatchItemResultLineSchema, { maxLineBytes: this.config.maxLineBytes }),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			return convertAsyncIteratorToReadableStream(convertGatewayBatchResultLines(lines));
		} catch (error) {
			if (isAbortOrTimeoutError(error)) throw error;
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	/** Requests cancellation; status and partial results remain separate reads. */
	async doCancelBatch({ batchId, headers, abortSignal }) {
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { value: responseBody } = await postJsonToApi({
				url: this.getBatchUrl("cancel"),
				headers: combineHeaders(resolvedHeaders, headers, await resolve(this.config.o11yHeaders)),
				body: { batchId },
				successfulResponseHandler: createJsonResponseHandler(gatewayBatchStatusResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			return { ...responseBody.providerMetadata != null && { providerMetadata: responseBody.providerMetadata } };
		} catch (error) {
			if (isAbortOrTimeoutError(error)) throw error;
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	getBatchUrl(path) {
		return `${this.config.baseURL}/batch/${path}`;
	}
};
function maybeEncodeBatchFileParts(options) {
	for (const message of options.prompt) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) if (part.type === "file" || part.type === "reasoning-file") part.data = maybeBase64EncodeFileData$1(part.data);
		else if (part.type === "tool-result" && part.output.type === "content") {
			for (const contentPart of part.output.value) if (contentPart.type === "file") contentPart.data = maybeBase64EncodeFileData$1(contentPart.data);
		}
	}
	return options;
}
function maybeBase64EncodeFileData$1(data) {
	if (data.type === "data") {
		const bytes = data.data;
		if (bytes instanceof Uint8Array) return {
			...data,
			data: Buffer.from(bytes).toString("base64")
		};
	}
	return data;
}
function validateSingleModel(requests) {
	const modelId = requests[0]?.modelId;
	if (modelId == null) throw new InvalidArgumentError({
		argument: "requests",
		message: "The AI Gateway Batch API requires at least one request."
	});
	for (const request of requests) if (request.modelId !== modelId) throw new InvalidArgumentError({
		argument: "requests",
		message: `The AI Gateway Batch API requires all requests in a batch to use the same model. Found "${modelId}" and "${request.modelId}".`
	});
	return modelId;
}
function assertTextBatchRequests(requests) {
	for (const request of requests) {
		const requestType = request.type;
		if (requestType !== "text") throw new UnsupportedFunctionalityError({
			functionality: `batch request type: ${requestType}`,
			message: `The AI Gateway Batch API does not support batch requests with type "${requestType}".`
		});
	}
}
/**
* Extracts the optional Gateway idempotency key from
* `providerOptions.gateway.idempotencyKey`. It is sent as the
* `idempotency-key` request header — the Gateway's replay contract for batch
* starts — and stripped from the forwarded body by
* `omitGatewayIdempotencyKey`.
*/
function getGatewayBatchIdempotencyKey(providerOptions) {
	const gatewayOptions = providerOptions?.gateway;
	if (gatewayOptions == null || typeof gatewayOptions !== "object" || Array.isArray(gatewayOptions)) return;
	const key = gatewayOptions.idempotencyKey;
	return typeof key === "string" && key.length > 0 ? key : void 0;
}
/**
* Removes `gateway.idempotencyKey` from the providerOptions forwarded in the
* request body. The key is transport metadata (it rides the `idempotency-key`
* header); the Gateway hashes the raw body for replay payload identity but
* normalizes the header separately, so keeping it out of the payload prevents
* equivalent retries from producing different digests (a false 422).
*/
function omitGatewayIdempotencyKey(providerOptions) {
	const gatewayOptions = providerOptions?.gateway;
	if (gatewayOptions == null || typeof gatewayOptions !== "object" || Array.isArray(gatewayOptions) || !("idempotencyKey" in gatewayOptions)) return providerOptions;
	const { idempotencyKey: _idempotencyKey, ...restGatewayOptions } = gatewayOptions;
	const restProviderOptions = { ...providerOptions };
	if (Object.keys(restGatewayOptions).length === 0) delete restProviderOptions.gateway;
	else restProviderOptions.gateway = restGatewayOptions;
	if (Object.keys(restProviderOptions).length === 0) return;
	return restProviderOptions;
}
/**
* Matches cancellation errors (`AbortError`/`TimeoutError`), which
* `asGatewayError` would otherwise wrap into a retryable Gateway 500. Kept
* local because `isAbortError` is not exported from `@ai-sdk/provider-utils`;
* `DOMException` does not extend `Error`, so both must be checked.
*/
function isAbortOrTimeoutError(error) {
	if (!(error instanceof Error || error instanceof DOMException)) return false;
	return error.name === "AbortError" || error.name === "TimeoutError";
}
function convertGatewayBatchStatus(body) {
	const requestCounts = normalizeBatchRequestCounts({
		total: body.requestCounts?.total,
		pending: body.requestCounts?.pending,
		completed: body.requestCounts?.completed,
		failed: body.requestCounts?.failed
	});
	return {
		status: body.status,
		...body.rawStatus != null && { rawStatus: body.rawStatus },
		...requestCounts != null && { requestCounts },
		...body.error != null && { error: {
			message: body.error.message,
			...body.error.type != null && { type: body.error.type },
			...body.error.code != null && { code: body.error.code },
			...body.error.statusCode != null && { statusCode: body.error.statusCode }
		} },
		...body.createdAt != null && { createdAt: body.createdAt },
		...body.expiresAt != null && { expiresAt: body.expiresAt },
		...body.providerMetadata != null && { providerMetadata: body.providerMetadata }
	};
}
/**
* Converts the minimally validated Gateway batch result lines. The Gateway
* already sanitizes the complete result objects server-side.
*
* @yields Each Gateway batch item result.
*/
async function* convertGatewayBatchResultLines(lines) {
	for await (const line of lines) {
		const item = line;
		if (item.status === "succeeded") {
			const response = item.result?.response;
			if (response !== void 0 && typeof response.timestamp === "string") response.timestamp = new Date(response.timestamp);
		}
		yield item;
	}
}
const gatewayBatchItemResultLineSchema = z.object({
	type: z.literal("text"),
	id: z.string(),
	status: z.enum([
		"cancelled",
		"expired",
		"failed",
		"succeeded"
	])
}).catchall(z.unknown());
const gatewayBatchErrorSchema = z.object({
	message: z.string(),
	type: z.string().nullish(),
	code: z.string().nullish(),
	statusCode: z.number().nullish()
});
const gatewayBatchRequestCountsSchema = z.object({
	total: z.number().nullish(),
	pending: z.number().nullish(),
	completed: z.number().nullish(),
	failed: z.number().nullish()
});
const gatewayBatchProviderMetadataSchema = z.record(z.string(), z.record(z.string(), z.unknown()));
const gatewayBatchStatusFieldsSchema = z.object({
	status: z.enum([
		"completed",
		"failed",
		"pending"
	]),
	rawStatus: z.string().nullish(),
	requestCounts: gatewayBatchRequestCountsSchema.nullish(),
	error: gatewayBatchErrorSchema.nullish(),
	createdAt: z.string().nullish(),
	expiresAt: z.string().nullish(),
	providerMetadata: gatewayBatchProviderMetadataSchema.nullish()
});
const gatewayBatchStartResponseSchema = gatewayBatchStatusFieldsSchema.extend({
	batchId: z.string(),
	warnings: z.array(z.object({
		requestId: z.string().nullish(),
		warning: z.unknown()
	}).catchall(z.unknown())).nullish()
});
const gatewayBatchStatusResponseSchema = gatewayBatchStatusFieldsSchema;
var GatewayLanguageModel = class GatewayLanguageModel {
	static [WORKFLOW_SERIALIZE](model) {
		return serializeModelOptions({
			modelId: model.modelId,
			config: model.config
		});
	}
	static [WORKFLOW_DESERIALIZE](options) {
		return new GatewayLanguageModel(options.modelId, options.config);
	}
	constructor(modelId, config) {
		this.modelId = modelId;
		this.config = config;
		this.specificationVersion = "v4";
		this.supportedUrls = { "*/*": [/.*/] };
	}
	get provider() {
		return this.config.provider;
	}
	async getArgs(options) {
		const { abortSignal: _abortSignal, ...optionsWithoutSignal } = options;
		return {
			args: this.maybeEncodeFileParts(optionsWithoutSignal),
			warnings: []
		};
	}
	async doGenerate(options) {
		const { args, warnings } = await this.getArgs(options);
		const { abortSignal } = options;
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { responseHeaders, value: responseBody, rawValue: rawResponse } = await postJsonToApi({
				url: this.getUrl(),
				headers: combineHeaders(resolvedHeaders, options.headers, this.getModelConfigHeaders(this.modelId, false), await resolve(this.config.o11yHeaders)),
				body: args,
				successfulResponseHandler: createJsonResponseHandler(z.any()),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			return {
				...responseBody,
				request: { body: args },
				response: {
					headers: responseHeaders,
					body: rawResponse
				},
				warnings: [...responseBody.warnings ?? [], ...warnings]
			};
		} catch (error) {
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	async doStream(options) {
		const { args, warnings } = await this.getArgs(options);
		const { abortSignal } = options;
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { value: response, responseHeaders } = await postJsonToApi({
				url: this.getUrl(),
				headers: combineHeaders(resolvedHeaders, options.headers, this.getModelConfigHeaders(this.modelId, true), await resolve(this.config.o11yHeaders)),
				body: args,
				successfulResponseHandler: createEventSourceResponseHandler(z.any()),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			return {
				stream: response.pipeThrough(new TransformStream({
					start(controller) {
						if (warnings.length > 0) controller.enqueue({
							type: "stream-start",
							warnings
						});
					},
					transform(chunk, controller) {
						if (chunk.success) {
							const streamPart = chunk.value;
							if (streamPart.type === "raw" && !options.includeRawChunks) return;
							if (streamPart.type === "response-metadata" && streamPart.timestamp && typeof streamPart.timestamp === "string") streamPart.timestamp = new Date(streamPart.timestamp);
							controller.enqueue(streamPart);
						} else controller.error(chunk.error);
					}
				})),
				request: { body: args },
				response: { headers: responseHeaders }
			};
		} catch (error) {
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	/**
	* Encodes inline `Uint8Array` file data to a base64 string in place.
	* @param options - The options to encode.
	* @returns The options with the file data encoded.
	*/
	maybeEncodeFileParts(options) {
		for (const message of options.prompt) {
			if (!Array.isArray(message.content)) continue;
			for (const part of message.content) if (part.type === "file" || part.type === "reasoning-file") part.data = maybeBase64EncodeFileData(part.data);
			else if (part.type === "tool-result" && part.output.type === "content") {
				for (const contentPart of part.output.value) if (contentPart.type === "file") contentPart.data = maybeBase64EncodeFileData(contentPart.data);
			}
		}
		return options;
	}
	getUrl() {
		return `${this.config.baseURL}/language-model`;
	}
	getModelConfigHeaders(modelId, streaming) {
		return {
			"ai-language-model-specification-version": "4",
			"ai-language-model-id": modelId,
			"ai-language-model-streaming": String(streaming)
		};
	}
};
function maybeBase64EncodeFileData(data) {
	if (data.type === "data") {
		const bytes = data.data;
		if (bytes instanceof Uint8Array) return {
			...data,
			data: Buffer.from(bytes).toString("base64")
		};
	}
	return data;
}
var GatewayEmbeddingModel = class GatewayEmbeddingModel {
	static [WORKFLOW_SERIALIZE](model) {
		return serializeModelOptions({
			modelId: model.modelId,
			config: model.config
		});
	}
	static [WORKFLOW_DESERIALIZE](options) {
		return new GatewayEmbeddingModel(options.modelId, options.config);
	}
	constructor(modelId, config) {
		this.modelId = modelId;
		this.config = config;
		this.specificationVersion = "v4";
		this.maxEmbeddingsPerCall = 2048;
		this.supportsParallelCalls = true;
	}
	get provider() {
		return this.config.provider;
	}
	async doEmbed({ values, dimensions, headers, abortSignal, providerOptions }) {
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { responseHeaders, value: responseBody, rawValue } = await postJsonToApi({
				url: this.getUrl(),
				headers: combineHeaders(resolvedHeaders, headers ?? {}, this.getModelConfigHeaders(), await resolve(this.config.o11yHeaders)),
				body: {
					values,
					dimensions,
					...providerOptions ? { providerOptions } : {}
				},
				successfulResponseHandler: createJsonResponseHandler(gatewayEmbeddingResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			return {
				embeddings: responseBody.embeddings,
				usage: responseBody.usage ?? void 0,
				providerMetadata: responseBody.providerMetadata,
				response: {
					headers: responseHeaders,
					body: rawValue
				},
				warnings: responseBody.warnings ?? []
			};
		} catch (error) {
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	getUrl() {
		return `${this.config.baseURL}/embedding-model`;
	}
	getModelConfigHeaders() {
		return {
			"ai-embedding-model-specification-version": "4",
			"ai-model-id": this.modelId
		};
	}
};
const gatewayEmbeddingWarningSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("unsupported"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("compatibility"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("deprecated"),
		setting: z.string(),
		message: z.string()
	}),
	z.object({
		type: z.literal("other"),
		message: z.string()
	})
]);
const gatewayEmbeddingResponseSchema = lazySchema(() => zodSchema(z.object({
	embeddings: z.array(z.array(z.number())),
	usage: z.object({ tokens: z.number() }).nullish(),
	warnings: z.array(gatewayEmbeddingWarningSchema).optional(),
	providerMetadata: z.record(z.string(), z.record(z.string(), z.unknown())).optional()
})));
var GatewayImageModel = class GatewayImageModel {
	static [WORKFLOW_SERIALIZE](model) {
		return serializeModelOptions({
			modelId: model.modelId,
			config: model.config
		});
	}
	static [WORKFLOW_DESERIALIZE](options) {
		return new GatewayImageModel(options.modelId, options.config);
	}
	constructor(modelId, config) {
		this.modelId = modelId;
		this.config = config;
		this.specificationVersion = "v4";
		this.maxImagesPerCall = Number.MAX_SAFE_INTEGER;
	}
	get provider() {
		return this.config.provider;
	}
	async doGenerate({ prompt, n, size, aspectRatio, seed, files, mask, providerOptions, headers, abortSignal }) {
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { responseHeaders, value: responseBody } = await postJsonToApi({
				url: this.getUrl(),
				headers: combineHeaders(resolvedHeaders, headers ?? {}, this.getModelConfigHeaders(), await resolve(this.config.o11yHeaders)),
				body: {
					prompt,
					n,
					...size && { size },
					...aspectRatio && { aspectRatio },
					...seed && { seed },
					...providerOptions && { providerOptions },
					...files && { files: files.map((file) => maybeEncodeImageFile(file)) },
					...mask && { mask: maybeEncodeImageFile(mask) }
				},
				successfulResponseHandler: createJsonResponseHandler(gatewayImageResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			return {
				images: responseBody.images,
				...responseBody.isRetryable != null && { isRetryable: responseBody.isRetryable },
				warnings: responseBody.warnings ?? [],
				providerMetadata: responseBody.providerMetadata,
				response: {
					timestamp: /* @__PURE__ */ new Date(),
					modelId: this.modelId,
					headers: responseHeaders
				},
				...responseBody.usage != null && { usage: {
					inputTokens: responseBody.usage.inputTokens ?? void 0,
					outputTokens: responseBody.usage.outputTokens ?? void 0,
					totalTokens: responseBody.usage.totalTokens ?? void 0
				} }
			};
		} catch (error) {
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	getUrl() {
		return `${this.config.baseURL}/image-model`;
	}
	getModelConfigHeaders() {
		return {
			"ai-image-model-specification-version": "4",
			"ai-model-id": this.modelId
		};
	}
};
function maybeEncodeImageFile(file) {
	if (file.type === "file" && file.data instanceof Uint8Array) return {
		...file,
		data: convertUint8ArrayToBase64(file.data)
	};
	return file;
}
const providerMetadataEntrySchema$3 = z.object({ images: z.array(z.unknown()).optional() }).catchall(z.unknown());
const gatewayImageWarningSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("unsupported"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("compatibility"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("deprecated"),
		setting: z.string(),
		message: z.string()
	}),
	z.object({
		type: z.literal("other"),
		message: z.string()
	})
]);
const gatewayImageUsageSchema = z.object({
	inputTokens: z.number().nullish(),
	outputTokens: z.number().nullish(),
	totalTokens: z.number().nullish()
});
const gatewayImageResponseSchema = z.object({
	images: z.array(z.string()),
	isRetryable: z.boolean().optional(),
	warnings: z.array(gatewayImageWarningSchema).optional(),
	providerMetadata: z.record(z.string(), providerMetadataEntrySchema$3).optional(),
	usage: gatewayImageUsageSchema.optional()
});
var GatewayVideoModel = class {
	constructor(modelId, config) {
		this.modelId = modelId;
		this.config = config;
		this.specificationVersion = "v4";
		this.maxVideosPerCall = Number.MAX_SAFE_INTEGER;
	}
	get provider() {
		return this.config.provider;
	}
	async doGenerate(options) {
		const { headers, abortSignal } = options;
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { responseHeaders, value: responseBody } = await postJsonToApi({
				url: this.getUrl(),
				headers: combineHeaders(resolvedHeaders, headers ?? {}, this.getModelConfigHeaders(), await resolve(this.config.o11yHeaders), { accept: "text/event-stream" }),
				body: this.buildRequestBody(options),
				successfulResponseHandler: async ({ response, url, requestBodyValues }) => {
					if (response.body == null) throw new APICallError({
						message: "SSE response body is empty",
						url,
						requestBodyValues,
						statusCode: response.status
					});
					const reader = parseJsonEventStream({
						stream: response.body,
						schema: gatewayVideoEventSchema
					}).getReader();
					const { done, value: parseResult } = await reader.read();
					reader.releaseLock();
					if (done || !parseResult) throw new APICallError({
						message: "SSE stream ended without a data event",
						url,
						requestBodyValues,
						statusCode: response.status
					});
					if (!parseResult.success) throw new APICallError({
						message: "Failed to parse video SSE event",
						cause: parseResult.error,
						url,
						requestBodyValues,
						statusCode: response.status
					});
					const event = parseResult.value;
					if (event.type === "error") throw new APICallError({
						message: event.message,
						statusCode: event.statusCode,
						url,
						requestBodyValues,
						responseHeaders: Object.fromEntries([...response.headers]),
						responseBody: JSON.stringify(event),
						data: { error: {
							message: event.message,
							type: event.errorType,
							param: event.param
						} }
					});
					return {
						value: {
							videos: event.videos,
							warnings: event.warnings,
							providerMetadata: event.providerMetadata
						},
						responseHeaders: Object.fromEntries([...response.headers])
					};
				},
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			return {
				videos: responseBody.videos,
				warnings: responseBody.warnings ?? [],
				providerMetadata: responseBody.providerMetadata ?? void 0,
				response: {
					timestamp: /* @__PURE__ */ new Date(),
					modelId: this.modelId,
					headers: responseHeaders
				}
			};
		} catch (error) {
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	async handleWebhookOption({ webhook }) {
		const { url, received } = await webhook();
		return {
			webhookUrl: url,
			received
		};
	}
	async doStart(options) {
		const { headers, abortSignal, webhookUrl } = options;
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { responseHeaders, value: responseBody } = await postJsonToApi({
				url: this.getStartUrl(),
				headers: combineHeaders(resolvedHeaders, headers ?? {}, this.getModelConfigHeaders(), await resolve(this.config.o11yHeaders)),
				body: {
					...this.buildRequestBody(options),
					...webhookUrl && { callbackUrl: webhookUrl }
				},
				successfulResponseHandler: createJsonResponseHandler(gatewayVideoStartResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			return {
				operation: responseBody.operation,
				warnings: responseBody.warnings ?? [],
				providerMetadata: responseBody.providerMetadata ?? void 0,
				response: {
					timestamp: /* @__PURE__ */ new Date(),
					modelId: this.modelId,
					headers: responseHeaders
				}
			};
		} catch (error) {
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	async doStatus({ operation, abortSignal, headers }) {
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { responseHeaders, value: responseBody } = await postJsonToApi({
				url: this.getStatusUrl(),
				headers: combineHeaders(resolvedHeaders, headers ?? {}, this.getModelConfigHeaders(), await resolve(this.config.o11yHeaders)),
				body: { operation },
				successfulResponseHandler: createJsonResponseHandler(gatewayVideoStatusResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			const response = {
				timestamp: /* @__PURE__ */ new Date(),
				modelId: this.modelId,
				headers: responseHeaders
			};
			if (responseBody.status === "completed") return {
				status: "completed",
				videos: responseBody.videos,
				warnings: responseBody.warnings ?? [],
				providerMetadata: responseBody.providerMetadata ?? void 0,
				response
			};
			if (responseBody.status === "error") return {
				status: "error",
				error: responseBody.error,
				providerMetadata: responseBody.providerMetadata ?? void 0,
				response
			};
			if (responseBody.status === "cancelled") return {
				status: "error",
				error: "Video generation was cancelled.",
				providerMetadata: responseBody.providerMetadata ?? void 0,
				response
			};
			return {
				status: "pending",
				warnings: responseBody.warnings ?? [],
				providerMetadata: responseBody.providerMetadata ?? void 0,
				response
			};
		} catch (error) {
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	buildRequestBody({ prompt, n, aspectRatio, resolution, duration, fps, seed, generateAudio, image, frameImages, inputReferences, providerOptions }) {
		return {
			prompt,
			n,
			...aspectRatio && { aspectRatio },
			...resolution && { resolution },
			...duration && { duration },
			...fps && { fps },
			...seed && { seed },
			...generateAudio !== void 0 && { generateAudio },
			...providerOptions && { providerOptions },
			...image && { image: maybeEncodeVideoFile(image) },
			...frameImages && { frameImages: frameImages.map((frame) => ({
				...frame,
				image: maybeEncodeVideoFile(frame.image)
			})) },
			...inputReferences && { inputReferences: inputReferences.map((reference) => maybeEncodeVideoFile(reference)) }
		};
	}
	getUrl() {
		return `${this.config.baseURL}/video-model`;
	}
	getStartUrl() {
		return `${this.config.baseURL}/video-model/start`;
	}
	getStatusUrl() {
		return `${this.config.baseURL}/video-model/status`;
	}
	getModelConfigHeaders() {
		return {
			"ai-video-model-specification-version": "4",
			"ai-model-id": this.modelId
		};
	}
};
function maybeEncodeVideoFile(file) {
	if (file.type === "file" && file.data instanceof Uint8Array) return {
		...file,
		data: convertUint8ArrayToBase64(file.data)
	};
	return file;
}
const providerMetadataEntrySchema$2 = z.object({ videos: z.array(z.unknown()).optional() }).catchall(z.unknown());
const gatewayVideoDataSchema = z.union([z.object({
	type: z.literal("url"),
	url: z.string(),
	mediaType: z.string()
}), z.object({
	type: z.literal("base64"),
	data: z.string(),
	mediaType: z.string()
})]);
const gatewayVideoWarningSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("unsupported"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("compatibility"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("deprecated"),
		setting: z.string(),
		message: z.string()
	}),
	z.object({
		type: z.literal("other"),
		message: z.string()
	})
]);
const gatewayVideoEventSchema = z.discriminatedUnion("type", [z.object({
	type: z.literal("result"),
	videos: z.array(gatewayVideoDataSchema),
	warnings: z.array(gatewayVideoWarningSchema).optional(),
	providerMetadata: z.record(z.string(), providerMetadataEntrySchema$2).optional()
}), z.object({
	type: z.literal("error"),
	message: z.string(),
	errorType: z.string(),
	statusCode: z.number(),
	param: z.unknown().nullable()
})]);
const gatewayVideoStartResponseSchema = z.object({
	operation: z.unknown(),
	warnings: z.array(gatewayVideoWarningSchema).nullish(),
	providerMetadata: z.record(z.string(), providerMetadataEntrySchema$2).nullish()
});
const gatewayVideoStatusResponseSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("pending"),
		warnings: z.array(gatewayVideoWarningSchema).nullish(),
		providerMetadata: z.record(z.string(), providerMetadataEntrySchema$2).nullish()
	}),
	z.object({
		status: z.literal("completed"),
		videos: z.array(gatewayVideoDataSchema),
		warnings: z.array(gatewayVideoWarningSchema).nullish(),
		providerMetadata: z.record(z.string(), providerMetadataEntrySchema$2).nullish()
	}),
	z.object({
		status: z.literal("error"),
		error: z.string(),
		providerMetadata: z.record(z.string(), providerMetadataEntrySchema$2).nullish()
	}),
	z.object({
		status: z.literal("cancelled"),
		providerMetadata: z.record(z.string(), providerMetadataEntrySchema$2).nullish()
	})
]);
const gatewayDecisionProviderOptionsSchema = lazySchema(() => zodSchema(z.object({ models: gatewayModelFallbacksSchema.optional() }).catchall(z.unknown())));
const probabilitySchema = z.number().finite().min(0).max(1);
const questionSchema = z.string().min(1).max(256);
const directConditionSchema = z.union([z.object({
	question: questionSchema.optional(),
	confidenceBelow: probabilitySchema
}).strict(), z.object({
	question: questionSchema.optional(),
	probabilityBetween: z.array(probabilitySchema).length(2).refine(([minimum, maximum]) => minimum <= maximum, { message: "probabilityBetween minimum must be less than or equal to maximum" })
}).strict()]);
const groupBeyondMaxDepthSchema = z.union([
	z.object({ any: z.unknown() }),
	z.object({ all: z.unknown() }),
	z.object({ atLeast: z.unknown() })
]).superRefine((_, context) => {
	context.addIssue({
		code: "custom",
		message: `conditions can be nested at most 5 levels deep`
	});
});
const conditionalModelFallbackSchema = z.object({
	model: z.string().min(1),
	when: conditionSchema(1)
}).strict();
const gatewayModelFallbacksSchema = z.array(z.union([z.string(), conditionalModelFallbackSchema])).superRefine((entries, context) => {
	const conditionalIndexes = entries.flatMap((entry, index) => typeof entry === "string" ? [] : [index]);
	if (conditionalIndexes.length > 1) context.addIssue({
		code: "custom",
		message: "models supports at most one conditional decision fallback"
	});
	if (conditionalIndexes[0] !== void 0 && conditionalIndexes[0] !== 0) context.addIssue({
		code: "custom",
		message: "a conditional decision fallback must be the first models entry",
		path: [conditionalIndexes[0]]
	});
});
function conditionSchema(depth) {
	if (depth === 5) return z.union([directConditionSchema, groupBeyondMaxDepthSchema]);
	const childConditionSchema = conditionSchema(depth + 1);
	const conditionListSchema = z.array(childConditionSchema).min(1).max(20);
	return z.union([
		directConditionSchema,
		z.object({ any: conditionListSchema }).strict(),
		z.object({ all: conditionListSchema }).strict(),
		z.object({ atLeast: z.object({
			count: z.number().int().min(1),
			conditions: conditionListSchema
		}).strict().refine(({ count, conditions }) => count <= conditions.length, {
			message: "atLeast count cannot exceed the number of conditions",
			path: ["count"]
		}) }).strict()
	]);
}
var GatewayDecisionModel = class {
	constructor(modelId, config) {
		this.modelId = modelId;
		this.config = config;
		this.specificationVersion = "v4";
		this.supportedQuestionTypes = [
			"choice",
			"score",
			"boolean"
		];
	}
	get provider() {
		return this.config.provider;
	}
	/** @deprecated Use `doDecide` instead. */
	doEvaluate(options) {
		return this.doDecide(options);
	}
	async doDecide({ state, questions, headers, abortSignal, providerOptions }) {
		const stateParts = toGatewayDecisionState(state);
		const gatewayOptions = await parseProviderOptions({
			provider: "gateway",
			providerOptions,
			schema: gatewayDecisionProviderOptionsSchema
		});
		const validatedProviderOptions = gatewayOptions == null ? providerOptions : {
			...providerOptions,
			gateway: gatewayOptions
		};
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { responseHeaders, value: responseBody, rawValue } = await postJsonToApi({
				url: this.getUrl(),
				headers: combineHeaders(resolvedHeaders, headers ?? {}, this.getModelConfigHeaders(), await resolve(this.config.o11yHeaders)),
				body: {
					stateParts,
					questions,
					...validatedProviderOptions ? { providerOptions: validatedProviderOptions } : {}
				},
				successfulResponseHandler: createJsonResponseHandler(gatewayDecisionResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			return {
				answers: responseBody.answers,
				...responseBody.rounding ? { rounding: responseBody.rounding } : {},
				...responseBody.usage ? { usage: responseBody.usage } : {},
				warnings: responseBody.warnings ?? [],
				providerMetadata: responseBody.providerMetadata,
				response: {
					modelId: responseBody.model ?? this.modelId,
					headers: responseHeaders,
					body: rawValue
				}
			};
		} catch (error) {
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	getUrl() {
		return `${this.config.baseURL}/decision-model`;
	}
	getModelConfigHeaders() {
		return {
			"ai-decision-model-specification-version": "4",
			"ai-model-id": this.modelId
		};
	}
};
const gatewayDecisionAnswerSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("choice"),
		choice: z.string(),
		probabilities: z.record(z.string(), z.number()).optional()
	}),
	z.object({
		type: z.literal("score"),
		score: z.number(),
		probabilities: z.record(z.string(), z.number()).optional()
	}),
	z.object({
		type: z.literal("boolean"),
		probability: z.number()
	}),
	z.object({ type: z.literal("refusal") })
]);
const gatewayDecisionWarningSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("unsupported"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("compatibility"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("deprecated"),
		setting: z.string(),
		message: z.string()
	}),
	z.object({
		type: z.literal("other"),
		message: z.string()
	})
]);
const gatewayDecisionResponseSchema = lazySchema(() => zodSchema(z.object({
	answers: z.record(z.string(), gatewayDecisionAnswerSchema),
	model: z.string().optional(),
	rounding: z.object({
		probabilityDecimals: z.number().optional(),
		scoreDecimals: z.number().optional()
	}).optional(),
	usage: z.object({
		inputTokens: z.number().optional(),
		outputTokens: z.number().optional()
	}).optional(),
	warnings: z.array(gatewayDecisionWarningSchema).optional(),
	providerMetadata: z.record(z.string(), z.record(z.string(), z.unknown())).optional()
})));
function toGatewayDecisionState(state) {
	return state.map((part) => {
		if (part.type !== "file") return part;
		if (part.data.type !== "data") throw new UnsupportedFunctionalityError({ functionality: `Gateway decision file input: ${part.data.type} data` });
		const { data } = part.data;
		return {
			...part,
			data: {
				type: "data",
				data: typeof data === "string" ? data : convertUint8ArrayToBase64(data)
			}
		};
	});
}
var GatewayRerankingModel = class {
	constructor(modelId, config) {
		this.modelId = modelId;
		this.config = config;
		this.specificationVersion = "v4";
	}
	get provider() {
		return this.config.provider;
	}
	async doRerank({ documents, query, topN, headers, abortSignal, providerOptions }) {
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { responseHeaders, value: responseBody, rawValue } = await postJsonToApi({
				url: this.getUrl(),
				headers: combineHeaders(resolvedHeaders, headers ?? {}, this.getModelConfigHeaders(), await resolve(this.config.o11yHeaders)),
				body: {
					documents,
					query,
					...topN != null ? { topN } : {},
					...providerOptions ? { providerOptions } : {}
				},
				successfulResponseHandler: createJsonResponseHandler(gatewayRerankingResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			return {
				ranking: responseBody.ranking,
				providerMetadata: responseBody.providerMetadata,
				response: {
					headers: responseHeaders,
					body: rawValue
				},
				warnings: responseBody.warnings ?? []
			};
		} catch (error) {
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	getUrl() {
		return `${this.config.baseURL}/reranking-model`;
	}
	getModelConfigHeaders() {
		return {
			"ai-reranking-model-specification-version": "4",
			"ai-model-id": this.modelId
		};
	}
};
const gatewayRerankingWarningSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("unsupported"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("compatibility"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("deprecated"),
		setting: z.string(),
		message: z.string()
	}),
	z.object({
		type: z.literal("other"),
		message: z.string()
	})
]);
const gatewayRerankingResponseSchema = lazySchema(() => zodSchema(z.object({
	ranking: z.array(z.object({
		index: z.number(),
		relevanceScore: z.number()
	})),
	warnings: z.array(gatewayRerankingWarningSchema).optional(),
	providerMetadata: z.record(z.string(), z.record(z.string(), z.unknown())).optional()
})));
var GatewaySpeechModel = class {
	constructor(modelId, config) {
		this.modelId = modelId;
		this.config = config;
		this.specificationVersion = "v4";
	}
	get provider() {
		return this.config.provider;
	}
	async doGenerate({ text, voice, outputFormat, instructions, speed, language, providerOptions, headers, abortSignal }) {
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { responseHeaders, value: responseBody, rawValue } = await postJsonToApi({
				url: this.getUrl(),
				headers: combineHeaders(resolvedHeaders, headers ?? {}, this.getModelConfigHeaders(), await resolve(this.config.o11yHeaders)),
				body: {
					text,
					...voice && { voice },
					...outputFormat && { outputFormat },
					...instructions && { instructions },
					...speed != null && { speed },
					...language && { language },
					...providerOptions && { providerOptions }
				},
				successfulResponseHandler: createJsonResponseHandler(gatewaySpeechResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			return {
				audio: responseBody.audio,
				warnings: responseBody.warnings ?? [],
				...responseBody.usage != null && { usage: responseBody.usage },
				providerMetadata: responseBody.providerMetadata,
				response: {
					timestamp: /* @__PURE__ */ new Date(),
					modelId: this.modelId,
					headers: responseHeaders,
					body: rawValue
				}
			};
		} catch (error) {
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	getUrl() {
		return `${this.config.baseURL}/speech-model`;
	}
	getModelConfigHeaders() {
		return {
			"ai-speech-model-specification-version": "4",
			"ai-model-id": this.modelId
		};
	}
};
const providerMetadataEntrySchema$1 = z.object({}).catchall(z.unknown());
const gatewaySpeechWarningSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("unsupported"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("compatibility"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("deprecated"),
		setting: z.string(),
		message: z.string()
	}),
	z.object({
		type: z.literal("other"),
		message: z.string()
	})
]);
const gatewaySpeechResponseSchema = z.object({
	audio: z.string(),
	warnings: z.array(gatewaySpeechWarningSchema).optional(),
	usage: z.record(z.string(), z.json()).optional(),
	providerMetadata: z.record(z.string(), providerMetadataEntrySchema$1).optional()
});
var GatewayTranscriptionModel = class {
	constructor(modelId, config) {
		this.modelId = modelId;
		this.config = config;
		this.specificationVersion = "v4";
	}
	get provider() {
		return this.config.provider;
	}
	async doGenerate({ audio, mediaType, providerOptions, headers, abortSignal }) {
		const resolvedHeaders = this.config.headers ? await resolve(this.config.headers) : void 0;
		try {
			const { responseHeaders, value: responseBody, rawValue } = await postJsonToApi({
				url: this.getUrl(),
				headers: combineHeaders(resolvedHeaders, headers ?? {}, this.getModelConfigHeaders(), await resolve(this.config.o11yHeaders)),
				body: {
					audio: audio instanceof Uint8Array ? convertUint8ArrayToBase64(audio) : audio,
					mediaType,
					...providerOptions && { providerOptions }
				},
				successfulResponseHandler: createJsonResponseHandler(gatewayTranscriptionResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				...abortSignal && { abortSignal },
				fetch: this.config.fetch
			});
			const warnings = [...responseBody.warnings ?? []];
			if (isXaiTranscriptionModel(this.modelId) && requestsXaiDiarization(providerOptions) && !containsSpeaker(rawValue)) warnings.push({
				type: "unsupported",
				feature: "providerOptions.xai.diarize",
				details: "AI Gateway does not currently expose xAI speaker diarization metadata."
			});
			return {
				text: responseBody.text,
				segments: responseBody.segments ?? [],
				language: responseBody.language ?? void 0,
				durationInSeconds: responseBody.durationInSeconds ?? void 0,
				warnings,
				...responseBody.usage != null && { usage: responseBody.usage },
				providerMetadata: responseBody.providerMetadata,
				response: {
					timestamp: /* @__PURE__ */ new Date(),
					modelId: this.modelId,
					headers: responseHeaders,
					body: rawValue
				}
			};
		} catch (error) {
			throw await asGatewayError(error, await parseAuthMethod(resolvedHeaders ?? {}));
		}
	}
	async doStream(options) {
		const currentDate = this.config._internal?.currentDate?.() ?? /* @__PURE__ */ new Date();
		const headers = combineHeaders(await resolve(this.config.headers ?? {}), options.headers ?? {}, this.getModelConfigHeaders(), await resolve(this.config.o11yHeaders));
		const authMethod = await parseAuthMethod(headers);
		const startFrame = {
			type: "transcription-stream.start",
			inputAudioFormat: options.inputAudioFormat,
			...options.providerOptions != null && { providerOptions: options.providerOptions },
			...options.includeRawChunks != null && { includeRawChunks: options.includeRawChunks }
		};
		return {
			stream: createGatewayTranscriptionStream({
				webSocket: this.config.webSocket,
				url: toGatewayTranscriptionUrl(this.config.baseURL, this.modelId),
				protocols: getProtocolsFromHeaders(headers),
				headers,
				startFrame,
				audio: options.audio,
				abortSignal: options.abortSignal,
				authMethod
			}),
			request: { body: startFrame },
			response: {
				timestamp: currentDate,
				modelId: this.modelId
			}
		};
	}
	getUrl() {
		return `${this.config.baseURL}/transcription-model`;
	}
	getModelConfigHeaders() {
		return {
			"ai-transcription-model-specification-version": "4",
			"ai-model-id": this.modelId
		};
	}
};
function isXaiTranscriptionModel(modelId) {
	return modelId.startsWith("spacexai/") || modelId.startsWith("xai/");
}
function requestsXaiDiarization(providerOptions) {
	return providerOptions?.xai?.diarize === true || providerOptions?.spacexai?.diarize === true;
}
function containsSpeaker(value) {
	if (Array.isArray(value)) return value.some(containsSpeaker);
	if (value == null || typeof value !== "object") return false;
	return Object.entries(value).some(([key, nestedValue]) => key === "speaker" && nestedValue != null || containsSpeaker(nestedValue));
}
/**
* Gateway streaming transcription WebSocket URL: HTTP(S) base upgraded to
* WS(S), model id in `?ai-model-id=` (browser `WebSocket` cannot set headers;
* slash-safe for qualified ids like `openai/gpt-realtime-whisper`).
*/
function toGatewayTranscriptionUrl(baseURL, modelId) {
	const url = new URL(`${baseURL.replace(/^http/, "ws")}/transcription-model`);
	url.searchParams.set("ai-model-id", modelId);
	return url.toString();
}
/**
* Auth-carrying subprotocols from the resolved request headers (bearer token
* + optional team scope). Native `WebSocket` cannot send headers, so auth
* rides the `Sec-WebSocket-Protocol` handshake. Header lookups are
* case-insensitive because `combineHeaders` does not normalize casing and
* callers can pass arbitrary casing via the `headers` option.
*/
function getProtocolsFromHeaders(headers) {
	const normalizedHeaders = normalizeHeaders(headers);
	const authorization = normalizedHeaders.authorization;
	const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : void 0;
	return token == null ? ["ai-gateway-transcription.v1"] : getGatewayTranscriptionProtocols(token, { teamIdOrSlug: normalizedHeaders[VERCEL_AI_GATEWAY_TEAM_HEADER] });
}
/** Audio frames stay under server frame-size limits (envelope rule 7). */
const MAX_AUDIO_FRAME_BYTES = 65536;
function createGatewayTranscriptionStream({ webSocket, url, protocols, headers, startFrame, audio, abortSignal, authMethod }) {
	let finished = false;
	let cleanup = () => {};
	return new ReadableStream({
		start: (controller) => {
			let audioReader;
			let hasServerErrorPart = false;
			let lastServerError;
			let audioStopped = false;
			let connection;
			cleanup = (closeCode) => {
				if (audioReader != null) audioReader.cancel().catch(() => {});
				else audio.cancel().catch(() => {});
				connection?.close(closeCode);
			};
			const stopAudio = () => {
				audioStopped = true;
				if (audioReader != null) {
					audioReader.cancel().catch(() => {});
					audioReader = void 0;
				} else audio.cancel().catch(() => {});
			};
			const finishWithError = (error) => {
				if (finished) return;
				finished = true;
				cleanup();
				errorControllerWithGatewayError(controller, error, authMethod);
			};
			const sendAudio = async (socket) => {
				const reader = audio.getReader();
				audioReader = reader;
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done || finished) break;
						const bytes = typeof value === "string" ? convertBase64ToUint8Array(value) : value;
						for (let offset = 0; offset < bytes.length; offset += MAX_AUDIO_FRAME_BYTES) {
							if (finished) break;
							socket.send(bytes.subarray(offset, offset + MAX_AUDIO_FRAME_BYTES));
							await waitForWebSocketBufferDrain(socket);
						}
					}
				} finally {
					reader.releaseLock();
					if (audioReader === reader) audioReader = void 0;
				}
				if (!finished && !audioStopped) socket.send(JSON.stringify({ type: "transcription-stream.audio-done" }));
			};
			connection = connectToWebSocket({
				url,
				protocols,
				headers,
				webSocket,
				abortSignal,
				onAbort: (reason) => {
					if (finished) return;
					finished = true;
					cleanup();
					controller.error(reason);
				},
				onProcessingError: finishWithError,
				onOpen: (socket) => {
					socket.send(JSON.stringify(startFrame));
					sendAudio(socket).catch(finishWithError);
				},
				onMessageText: (text) => {
					if (finished) return;
					const part = parseTranscriptionStreamPart(text);
					if (part == null) return;
					if (part.type === "finish") {
						finished = true;
						controller.enqueue(part);
						controller.close();
						cleanup(1e3);
						return;
					}
					if (part.type === "error") {
						hasServerErrorPart = true;
						lastServerError = part.error;
						stopAudio();
					}
					controller.enqueue(part);
				},
				onSocketError: () => {
					finishWithError(/* @__PURE__ */ new Error("Connection error on AI Gateway transcription stream"));
				},
				onClose: () => {
					if (hasServerErrorPart) {
						if (finished) return;
						createErrorFromServerErrorPart(lastServerError, authMethod).then(finishWithError);
						return;
					}
					finishWithError(/* @__PURE__ */ new Error("AI Gateway transcription stream closed before a finish part was received"));
				}
			});
		},
		cancel: () => {
			if (finished) return;
			finished = true;
			cleanup();
		}
	});
}
const providerMetadataEntrySchema = z.object({}).catchall(z.unknown());
const gatewayTranscriptionWarningSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("unsupported"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("compatibility"),
		feature: z.string(),
		details: z.string().optional()
	}),
	z.object({
		type: z.literal("deprecated"),
		setting: z.string(),
		message: z.string()
	}),
	z.object({
		type: z.literal("other"),
		message: z.string()
	})
]);
const gatewayTranscriptionResponseSchema = z.object({
	text: z.string(),
	segments: z.array(z.object({
		text: z.string(),
		startSecond: z.number(),
		endSecond: z.number()
	})).optional(),
	language: z.string().nullish(),
	durationInSeconds: z.number().nullish(),
	warnings: z.array(gatewayTranscriptionWarningSchema).optional(),
	usage: z.record(z.string(), z.json()).optional(),
	providerMetadata: z.record(z.string(), providerMetadataEntrySchema).optional()
});
/**
* `asGatewayError` is async while the WebSocket event handlers are
* synchronous, hence this helper.
*/
async function errorControllerWithGatewayError(controller, error, authMethod) {
	controller.error(await asGatewayError(error, authMethod));
}
/**
* Extract a human-readable message from an `error` stream part's payload for
* the terminal close error.
*/
function getServerErrorMessage(error) {
	if (error != null && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
	return getErrorMessage(error);
}
/** Canonical status codes for server error-part types (no HTTP status exists on the WebSocket). */
const SERVER_ERROR_STATUS_CODES = {
	authentication_error: 401,
	failed_dependency: 424,
	forbidden: 403,
	internal_server_error: 500,
	invalid_request_error: 400,
	model_not_found: 404,
	rate_limit_exceeded: 429
};
/**
* Maps a server error-part payload (`{ message, type }`) to the public
* Gateway error class for its type; unknown shapes keep the generic message.
*/
async function createErrorFromServerErrorPart(error, authMethod) {
	if (typeof error === "object" && error != null && "message" in error && typeof error.message === "string" && "type" in error && typeof error.type === "string" && error.type in SERVER_ERROR_STATUS_CODES) return createGatewayErrorFromResponse({
		response: { error: {
			message: error.message,
			type: error.type
		} },
		statusCode: SERVER_ERROR_STATUS_CODES[error.type],
		authMethod
	});
	return /* @__PURE__ */ new Error(`AI Gateway transcription stream failed: ${getServerErrorMessage(error)}`);
}
/**
* Realtime model backed by the AI Gateway.
*
* The Gateway normalizes realtime exactly like it normalizes every other
* modality: the client speaks the normalized AI SDK realtime protocol and the
* Gateway translates to and from the upstream provider server-side. This model
* is therefore a thin identity codec over that normalized protocol — only the
* connection and authentication are Gateway-specific.
*/
var GatewayRealtimeModel = class {
	constructor(modelId, config) {
		this.specificationVersion = "v4";
		this.modelId = modelId;
		this.provider = config.provider;
		this.config = config;
	}
	/**
	* Mints a single-use, short-lived client secret (`vcst_`) the browser uses to
	* open the realtime WebSocket without ever holding the long-lived Gateway
	* credential. The customer's server calls this (via
	* `gateway.experimental_realtime.getToken`) and hands the returned token to
	* the browser, which connects with it through the `ai-gateway-auth.<token>`
	* subprotocol. `expiresAfterSeconds` is forwarded to the mint endpoint;
	* `sessionConfig` is intentionally unused here — it is applied later via the
	* normalized `session-update` event.
	*/
	async doCreateClientSecret(options) {
		const secret = await this.config.createClientSecret({
			modelId: this.modelId,
			...options?.expiresAfterSeconds != null && { expiresAfterSeconds: options.expiresAfterSeconds }
		});
		return {
			token: secret.token,
			url: toGatewayRealtimeUrl(this.config.baseURL, this.modelId),
			...secret.expiresAt != null && { expiresAt: secret.expiresAt }
		};
	}
	getWebSocketConfig(options) {
		return {
			url: options.url,
			protocols: getGatewayRealtimeProtocols(options.token, { teamIdOrSlug: this.config.teamIdOrSlug })
		};
	}
	parseServerEvent(raw) {
		return raw;
	}
	serializeClientEvent(event) {
		return event;
	}
	buildSessionConfig(config) {
		return config;
	}
};
/**
* Build the Gateway realtime WebSocket URL. The HTTP(S) base URL is upgraded to
* WS(S) and the model id rides the `?ai-model-id=` query — the WS transport of
* the `ai-model-id` header the HTTP routes use, since a browser `WebSocket`
* cannot set headers. The model id is passed through verbatim; the Gateway owns
* resolution (including the bare → `openai/` qualification), exactly like the
* non-realtime routes. The query is slash-safe for qualified ids such as
* `openai/gpt-realtime-2`.
*/
function toGatewayRealtimeUrl(baseURL, modelId) {
	const url = new URL(`${baseURL.replace(/^http/, "ws")}/realtime-model`);
	url.searchParams.set("ai-model-id", modelId);
	return url.toString();
}
const jsonObjectSchema = z.record(z.string(), z.unknown());
const browserbaseFetchToolFactory = createProviderExecutedToolFactory({
	id: "gateway.browserbase_fetch",
	inputSchema: lazySchema(() => zodSchema(z.object({
		url: z.string().url().describe("URL of the page to fetch."),
		allow_redirects: z.boolean().optional().describe("Whether to follow HTTP redirects (default: false)."),
		allow_insecure_ssl: z.boolean().optional().describe("Whether to bypass TLS certificate verification (default: false). Only use for trusted hosts."),
		proxies: z.boolean().optional().describe("Whether to route the request through Browserbase proxies (default: false)."),
		format: z.enum([
			"raw",
			"json",
			"markdown"
		]).optional().describe("Output format. raw returns the response body unchanged, markdown returns page content as Markdown, and json returns structured content using schema."),
		schema: jsonObjectSchema.optional().describe("JSON Schema for structured extraction. Only use with format set to json.")
	}))),
	outputSchema: lazySchema(() => zodSchema(z.union([z.object({
		id: z.string(),
		content: z.union([z.string(), jsonObjectSchema]),
		contentType: z.string(),
		encoding: z.string(),
		headers: z.record(z.string(), z.string()),
		statusCode: z.number()
	}), z.object({
		error: z.enum([
			"api_error",
			"configuration_error",
			"execution_error",
			"invalid_input",
			"rate_limit",
			"timeout",
			"unknown"
		]),
		statusCode: z.number().optional(),
		message: z.string()
	})])))
});
const browserbaseFetch = (config = {}) => browserbaseFetchToolFactory(config);
const browserbaseSearchToolFactory = createProviderExecutedToolFactory({
	id: "gateway.browserbase_search",
	inputSchema: lazySchema(() => zodSchema(z.object({
		query: z.string().min(1).max(200).describe("Web search query. Must be between 1 and 200 characters."),
		num_results: z.number().int().min(1).max(25).optional().describe("Maximum number of results to return (1-25, default: 10).")
	}))),
	outputSchema: lazySchema(() => zodSchema(z.union([z.object({
		query: z.string(),
		requestId: z.string(),
		results: z.array(z.object({
			id: z.string(),
			title: z.string(),
			url: z.string(),
			author: z.string().optional(),
			favicon: z.string().optional(),
			image: z.string().optional(),
			publishedDate: z.string().optional()
		}))
	}), z.object({
		error: z.enum([
			"api_error",
			"configuration_error",
			"execution_error",
			"invalid_input",
			"rate_limit",
			"timeout",
			"unknown"
		]),
		statusCode: z.number().optional(),
		message: z.string()
	})])))
});
const browserbaseSearch = (config = {}) => browserbaseSearchToolFactory(config);
const exaSearchToolFactory = createProviderExecutedToolFactory({
	id: "gateway.exa_search",
	inputSchema: lazySchema(() => zodSchema(z.object({
		query: z.string().describe("Natural-language web search query. This is required."),
		type: z.enum([
			"auto",
			"fast",
			"instant"
		]).optional().describe("Search method. Use auto for the default balance of speed and quality."),
		num_results: z.number().optional().describe("Maximum number of results to return (1-100, default: 10)."),
		category: z.enum([
			"company",
			"people",
			"research paper",
			"news",
			"personal site",
			"financial report"
		]).optional().describe("Optional content category to focus results."),
		user_location: z.string().optional().describe("Two-letter ISO country code such as 'US'."),
		include_domains: z.array(z.string()).optional().describe("Only return results from these domains."),
		exclude_domains: z.array(z.string()).optional().describe("Exclude results from these domains."),
		start_published_date: z.string().optional().describe("Only return links published after this ISO 8601 date."),
		end_published_date: z.string().optional().describe("Only return links published before this ISO 8601 date."),
		contents: z.object({
			text: z.union([z.boolean(), z.object({
				max_characters: z.number().optional(),
				include_html_tags: z.boolean().optional(),
				verbosity: z.enum([
					"compact",
					"standard",
					"full"
				]).optional(),
				include_sections: z.array(z.enum([
					"header",
					"navigation",
					"banner",
					"body",
					"sidebar",
					"footer",
					"metadata"
				])).optional(),
				exclude_sections: z.array(z.enum([
					"header",
					"navigation",
					"banner",
					"body",
					"sidebar",
					"footer",
					"metadata"
				])).optional()
			})]).optional(),
			highlights: z.union([z.boolean(), z.object({
				query: z.string().optional(),
				max_characters: z.number().optional()
			})]).optional(),
			max_age_hours: z.number().optional(),
			livecrawl_timeout: z.number().optional(),
			subpages: z.number().optional(),
			subpage_target: z.union([z.string(), z.array(z.string())]).optional(),
			extras: z.object({
				links: z.number().optional(),
				image_links: z.number().optional()
			}).optional()
		}).optional().describe("Controls extracted page content and freshness.")
	}))),
	outputSchema: lazySchema(() => zodSchema(z.union([z.object({
		requestId: z.string(),
		searchType: z.string().optional(),
		resolvedSearchType: z.string().optional(),
		results: z.array(z.object({
			title: z.string(),
			url: z.string(),
			id: z.string(),
			publishedDate: z.string().nullable().optional(),
			author: z.string().nullable().optional(),
			image: z.string().nullable().optional(),
			favicon: z.string().nullable().optional(),
			text: z.string().optional(),
			highlights: z.array(z.string()).optional(),
			highlightScores: z.array(z.number()).optional(),
			summary: z.string().optional(),
			subpages: z.array(z.any()).optional(),
			extras: z.object({
				links: z.array(z.string()).optional(),
				imageLinks: z.array(z.string()).optional()
			}).optional()
		})),
		costDollars: z.object({
			total: z.number().optional(),
			search: z.record(z.string(), z.number()).optional()
		}).optional()
	}), z.object({
		error: z.enum([
			"api_error",
			"rate_limit",
			"timeout",
			"invalid_input",
			"configuration_error",
			"execution_error",
			"unknown"
		]),
		statusCode: z.number().optional(),
		message: z.string()
	})])))
});
const exaSearch = (config = {}) => exaSearchToolFactory(config);
const parallelSearchToolFactory = createProviderExecutedToolFactory({
	id: "gateway.parallel_search",
	inputSchema: lazySchema(() => zodSchema(z.object({
		objective: z.string().describe("Natural-language description of the web research goal, including source or freshness guidance and broader context from the task. Maximum 5000 characters."),
		search_queries: z.array(z.string()).optional().describe("Optional search queries to supplement the objective. Maximum 200 characters per query."),
		mode: z.enum(["one-shot", "agentic"]).optional().describe("Mode preset: \"one-shot\" for comprehensive results with longer excerpts (default), \"agentic\" for concise, token-efficient results for multi-step workflows."),
		max_results: z.number().optional().describe("Maximum number of results to return (1-20). Defaults to 10 if not specified."),
		source_policy: z.object({
			include_domains: z.array(z.string()).optional().describe("Limit results to these domains. Use plain domain names only — e.g. example.com or sub.example.gov, or a bare extension like .edu. Do not include a scheme, path, or port (e.g. not https://example.com/page)."),
			exclude_domains: z.array(z.string()).optional().describe("Exclude results from these domains. Use plain domain names only — e.g. example.com or sub.example.gov, or a bare extension like .edu. Do not include a scheme, path, or port (e.g. not https://example.com/page)."),
			after_date: z.string().optional().describe("Only include results published after this date. Use an ISO 8601 calendar date formatted YYYY-MM-DD (e.g. 2025-01-01); do not include a time.")
		}).optional().describe("Source policy for controlling which domains to include/exclude and freshness."),
		excerpts: z.object({
			max_chars_per_result: z.number().optional().describe("Maximum characters per result."),
			max_chars_total: z.number().optional().describe("Maximum total characters across all results.")
		}).optional().describe("Excerpt configuration for controlling result length."),
		fetch_policy: z.object({ max_age_seconds: z.number().optional().describe("Maximum age in seconds for cached content. Set to 0 to always fetch fresh content.") }).optional().describe("Fetch policy for controlling content freshness.")
	}))),
	outputSchema: lazySchema(() => zodSchema(z.union([z.object({
		searchId: z.string(),
		results: z.array(z.object({
			url: z.string(),
			title: z.string(),
			excerpt: z.string(),
			publishDate: z.string().nullable().optional(),
			relevanceScore: z.number().optional()
		}))
	}), z.object({
		error: z.enum([
			"api_error",
			"rate_limit",
			"timeout",
			"invalid_input",
			"configuration_error",
			"unknown"
		]),
		statusCode: z.number().optional(),
		message: z.string()
	})])))
});
const parallelSearch = (config = {}) => parallelSearchToolFactory(config);
const perplexitySearchToolFactory = createProviderExecutedToolFactory({
	id: "gateway.perplexity_search",
	inputSchema: lazySchema(() => zodSchema(z.object({
		query: z.union([z.string(), z.array(z.string())]).describe("Search query (string) or multiple queries (array of up to 5 strings). Multi-query searches return combined results from all queries."),
		max_results: z.number().optional().describe("Maximum number of search results to return (1-20, default: 10)"),
		max_tokens_per_page: z.number().optional().describe("Maximum number of tokens to extract per search result page (256-2048, default: 2048)"),
		max_tokens: z.number().optional().describe("Maximum total tokens across all search results (default: 25000, max: 1000000)"),
		country: z.string().optional().describe("Two-letter ISO 3166-1 alpha-2 country code for regional search results (e.g., 'US', 'GB', 'FR')"),
		search_domain_filter: z.array(z.string()).optional().describe("List of domains to include or exclude from search results (max 20). To include: ['nature.com', 'science.org']. To exclude: ['-example.com', '-spam.net']"),
		search_language_filter: z.array(z.string()).optional().describe("List of ISO 639-1 language codes to filter results (max 10, lowercase). Examples: ['en', 'fr', 'de']"),
		search_after_date: z.string().optional().describe("Include only results published after this date. Format: 'MM/DD/YYYY' (e.g., '3/1/2025'). Cannot be used with search_recency_filter."),
		search_before_date: z.string().optional().describe("Include only results published before this date. Format: 'MM/DD/YYYY' (e.g., '3/15/2025'). Cannot be used with search_recency_filter."),
		last_updated_after_filter: z.string().optional().describe("Include only results last updated after this date. Format: 'MM/DD/YYYY' (e.g., '3/1/2025'). Cannot be used with search_recency_filter."),
		last_updated_before_filter: z.string().optional().describe("Include only results last updated before this date. Format: 'MM/DD/YYYY' (e.g., '3/15/2025'). Cannot be used with search_recency_filter."),
		search_recency_filter: z.enum([
			"day",
			"week",
			"month",
			"year"
		]).optional().describe("Filter results by relative time period. Cannot be used with search_after_date or search_before_date.")
	}))),
	outputSchema: lazySchema(() => zodSchema(z.union([z.object({
		results: z.array(z.object({
			title: z.string(),
			url: z.string(),
			snippet: z.string(),
			date: z.string().optional(),
			lastUpdated: z.string().optional()
		})),
		id: z.string()
	}), z.object({
		error: z.enum([
			"api_error",
			"rate_limit",
			"timeout",
			"invalid_input",
			"unknown"
		]),
		statusCode: z.number().optional(),
		message: z.string()
	})])))
});
const perplexitySearch = (config = {}) => perplexitySearchToolFactory(config);
const takoDataSourceInputSchema = z.object({
	count: z.number().optional().describe("Maximum number of data results to return (1-20). When include_contents is true, each additional result adds its own data surcharge."),
	include_contents: z.boolean().optional().describe("Inline rows for each data result. This adds a data surcharge based on row count and dataset source. To estimate cost, search with include_contents disabled and inspect cards.content.export_pricing. This applies to every returned card; limit sources.data.count and sources.data.max_rows to control cost."),
	mode: z.enum(["inline", "url"]).optional().describe("Requested data delivery mode. Search card data is always inline."),
	content_format: z.enum([
		"card_json",
		"csv",
		"json_compact",
		"json_records"
	]).optional().describe("Serialization for inlined card data."),
	max_rows: z.number().optional().describe("Maximum rows to inline per result. Omit to use the allowance in cards.content.export_pricing. A data surcharge applies per 1,000 exported rows; lower values reduce cost."),
	node_ids: z.array(z.string()).optional().describe("Data Graph node IDs to prioritize. Maximum 20."),
	strict: z.boolean().optional().describe("Only return cards matching node_ids. Requires a non-empty node_ids.")
});
const takoWebSourceInputSchema = z.object({
	count: z.number().optional().describe("Maximum number of web results to return (1-20)."),
	include_contents: z.boolean().optional().describe("Inline extracted web page text. This can add a data charge."),
	category: z.enum([
		"finance",
		"news",
		"sports"
	]).optional().describe("Optional web-result category filter."),
	include_domains: z.array(z.string()).optional().describe("Only return results from these bare domains."),
	exclude_domains: z.array(z.string()).optional().describe("Exclude results from these bare domains."),
	snippet_max_chars: z.number().optional().describe("Maximum characters in each web-result snippet."),
	highlights: z.boolean().optional().describe("Include highlighted passages in web results. Defaults to true in AI Gateway."),
	article_content_max_chars: z.number().optional().describe("Maximum extracted characters per web page when including contents."),
	published_after: z.string().optional().describe("Keep results published on or after this ISO date (YYYY-MM-DD)."),
	published_before: z.string().optional().describe("Keep results published on or before this ISO date (YYYY-MM-DD).")
});
const takoSearchInputSchema = lazySchema(() => zodSchema(z.object({
	query: z.string().describe("Natural-language search query. Include the entity, metric, and time period. Quote a phrase to force it to one entity, for example \"Tesla\":PRODUCT price."),
	effort: z.enum([
		"deep",
		"fast",
		"instant"
	]).optional().describe("Search effort. fast is the balanced default, instant favors cached results and low latency, and deep broadens retrieval with reranking at higher cost and latency."),
	sources: z.object({
		data: takoDataSourceInputSchema.optional(),
		web: takoWebSourceInputSchema.optional()
	}).optional().describe("Sources to search. Omit to search both curated data and the web. When provided, only keys present are searched."),
	location: z.object({
		latitude: z.number().describe("Latitude between -90 and 90."),
		longitude: z.number().describe("Longitude between -180 and 180.")
	}).optional().describe("End-user coordinates for localized results."),
	country_code: z.string().optional().describe("Two-letter ISO 3166-1 country code, such as 'US'."),
	locale: z.string().optional().describe("BCP-47 locale, such as 'en-US'."),
	timezone: z.string().optional().describe("IANA timezone, such as 'America/New_York'."),
	output_settings: z.object({
		image_dark_mode: z.boolean().optional().describe("Render card preview images in dark mode."),
		force_refresh: z.boolean().optional().describe("Instant-effort only. Request a refreshed instant result.")
	}).optional().describe("Controls card rendering in the search response."),
	include_related: z.number().optional().describe("Maximum related search suggestions to include (1-20).")
})));
const takoDatasetCellSchema = z.union([
	z.boolean(),
	z.number(),
	z.string()
]).nullable();
const takoResultContentSchema = z.object({
	content_format: z.enum([
		"card_json",
		"csv",
		"json_compact",
		"json_records"
	]).nullish(),
	cost: z.number().optional(),
	data: z.string().nullish(),
	records: z.array(z.record(z.string(), takoDatasetCellSchema)).nullish(),
	dataset: z.object({
		columns: z.array(z.object({
			name: z.string(),
			type: z.enum([
				"boolean",
				"date",
				"datetime",
				"number",
				"string"
			]),
			unit: z.string().nullish()
		})),
		rows: z.array(z.array(takoDatasetCellSchema)),
		total_rows: z.number(),
		truncated: z.boolean(),
		ref: z.string(),
		sources: z.array(z.object({
			name: z.string(),
			index: z.enum(["data", "web"]).optional()
		})),
		provenance: z.enum(["query", "web_extraction"]).optional()
	}).nullish(),
	card_data: z.object({}).passthrough().nullish(),
	card_data_schema: z.object({}).passthrough().nullish(),
	url: z.string().nullish(),
	expires_at: z.string().nullish(),
	total_rows: z.number().nullish(),
	truncated: z.boolean().optional(),
	export_pricing: z.object({
		baseline_usd: z.number(),
		free_rows: z.number(),
		max_rows_ceiling: z.number(),
		row_cpm_usd: z.number()
	}).nullish(),
	manifest: z.array(z.object({
		dtype: z.enum([
			"boolean",
			"date",
			"datetime",
			"number",
			"string"
		]).nullish(),
		entity: z.string().nullish(),
		metric: z.string().nullish(),
		name: z.string().nullish(),
		unit: z.string().nullish()
	})).nullish()
}).passthrough();
const takoCardSchema = z.object({
	card_id: z.string().nullish(),
	title: z.string().nullish(),
	description: z.string().nullish(),
	semantic_description: z.string().nullish(),
	webpage_url: z.string().nullish(),
	image_url: z.string().nullish(),
	embed_url: z.string().nullish(),
	sources: z.array(z.object({
		source_name: z.string().nullish(),
		source_description: z.string().nullish(),
		source_index: z.enum(["data", "web"]),
		source_text: z.string().nullish(),
		url: z.string().nullish()
	})).nullish(),
	methodologies: z.array(z.object({
		methodology_name: z.string().nullable(),
		methodology_description: z.string().nullable()
	})).nullish(),
	source_indexes: z.array(z.enum(["data", "web"])).nullish(),
	card_type: z.string().nullish(),
	relevance: z.enum([
		"High",
		"Low",
		"Medium"
	]).nullish(),
	content: takoResultContentSchema.nullish(),
	exportable: z.boolean().optional(),
	nodes: z.array(z.object({
		id: z.string(),
		type: z.enum(["entity", "metric"]),
		name: z.string(),
		description: z.string().nullish()
	})).nullish(),
	metric_definitions: z.array(z.object({
		name: z.string(),
		definition: z.string()
	})).nullish(),
	data_freshness: z.object({
		coverage_end: z.string().nullish(),
		data_as_of: z.string().nullish(),
		last_updated: z.string().nullish()
	}).nullish()
}).passthrough();
const takoWebResultSchema = z.object({
	title: z.string(),
	url: z.string(),
	snippet: z.string().nullish(),
	source_name: z.string().nullish(),
	publish_date: z.string().nullish(),
	content: takoResultContentSchema.nullish()
}).passthrough();
const takoSearchToolFactory = createProviderExecutedToolFactory({
	id: "gateway.tako_search",
	inputSchema: takoSearchInputSchema,
	outputSchema: lazySchema(() => zodSchema(z.union([z.object({
		request_id: z.string(),
		cards: z.array(takoCardSchema).optional(),
		web_results: z.array(takoWebResultSchema).optional(),
		usage: z.object({
			total_cost_usd: z.number(),
			compute: z.object({ cost_usd: z.number() }).nullish(),
			data: z.object({
				cost_usd: z.number(),
				datasets: z.number()
			}).nullish()
		}).nullish(),
		related: z.array(z.object({}).passthrough()).nullish()
	}).passthrough(), z.object({
		error: z.enum([
			"api_error",
			"configuration_error",
			"execution_error",
			"invalid_input",
			"rate_limit",
			"timeout",
			"unknown_tool"
		]),
		statusCode: z.number().optional(),
		message: z.string()
	})])))
});
const takoSearch = (config = {}) => takoSearchToolFactory(config);
/**
* Gateway-specific provider-defined tools.
*/
const gatewayTools = {
	/**
	* Fetch page content using Browserbase's lightweight Fetch API.
	*
	* Supports raw, Markdown, and schema-driven JSON output as well as redirects,
	* proxy routing, and TLS controls.
	*/
	browserbaseFetch,
	/**
	* Search the web using Browserbase's Search API for fast, structured results.
	*
	* Returns titles, URLs, and available publication metadata without requiring
	* a browser session.
	*/
	browserbaseSearch,
	/**
	* Search the web using Exa for current information and token-efficient
	* excerpts optimized for agent workflows.
	*
	* Supports search type, category, domain, date, location, and content
	* extraction controls.
	*/
	exaSearch,
	/**
	* Search the web using Parallel AI's Search API for LLM-optimized excerpts.
	*
	* Takes a natural language objective and returns relevant excerpts,
	* replacing multiple keyword searches with a single call for broad
	* or complex queries. Supports different search types for depth vs
	* breadth tradeoffs.
	*/
	parallelSearch,
	/**
	* Search the web using Perplexity's Search API for real-time information,
	* news, research papers, and articles.
	*
	* Provides ranked search results with advanced filtering options including
	* domain, language, date range, and recency filters.
	*/
	perplexitySearch,
	/**
	* Search the web and Tako's curated knowledge graph in one call for
	* token-efficient web excerpts and structured data results grounded in
	* premium sources, each with an embed-ready visualization.
	*
	* Supports effort, per-source web and data controls, localization, and inline
	* contents for agents that need to reason over underlying data.
	*/
	takoSearch
};
async function getVercelRequestId() {
	return (0, import_dist.getContext)().headers?.["x-vercel-id"];
}
const AI_GATEWAY_PROTOCOL_VERSION = "0.0.1";
/** Response shape of `POST /v1/realtime/client-secrets`. `expiresAt` is epoch seconds. */
const gatewayClientSecretResponseSchema = z.object({
	token: z.string(),
	expiresAt: z.number().nullish()
});
/**
* Create a remote provider instance.
*/
function createGateway(options = {}) {
	let pendingMetadata = null;
	let metadataCache = null;
	const cacheRefreshMillis = options.metadataCacheRefreshMillis ?? 3e5;
	let lastFetchTime = 0;
	const baseURL = withoutTrailingSlash(options.baseURL) ?? "https://ai-gateway.vercel.sh/v4/ai";
	const createAuthHeaders = (auth) => withUserAgentSuffix({
		Authorization: `Bearer ${auth.token}`,
		"ai-gateway-protocol-version": AI_GATEWAY_PROTOCOL_VERSION,
		[GATEWAY_AUTH_METHOD_HEADER]: auth.authMethod,
		...options.teamIdOrSlug != null ? { [VERCEL_AI_GATEWAY_TEAM_HEADER]: options.teamIdOrSlug } : {},
		...options.headers
	}, `ai-sdk-gateway/4.0.114`);
	const getHeaders = async () => {
		try {
			return createAuthHeaders(await getGatewayAuthToken(options));
		} catch (error) {
			throw GatewayAuthenticationError.createContextualError({
				apiKeyProvided: false,
				oidcTokenProvided: false,
				statusCode: 401,
				cause: error
			});
		}
	};
	const getRealtimeAuthToken = async () => {
		try {
			return await getGatewayAuthToken(options);
		} catch (error) {
			throw GatewayAuthenticationError.createContextualError({
				apiKeyProvided: false,
				oidcTokenProvided: false,
				statusCode: 401,
				cause: error
			});
		}
	};
	const mintClientSecret = async (params) => {
		assertGatewayClientSecretServerEnvironment();
		const auth = await getRealtimeAuthToken();
		const headers = createAuthHeaders(auth);
		const url = new URL("/v1/realtime/client-secrets", baseURL).toString();
		try {
			const { value } = await postJsonToApi({
				url,
				headers,
				body: {
					model: params.modelId,
					...params.routeKind != null && { routeKind: params.routeKind },
					...params.expiresAfterSeconds != null && { expiresIn: params.expiresAfterSeconds }
				},
				successfulResponseHandler: createJsonResponseHandler(gatewayClientSecretResponseSchema),
				failedResponseHandler: createJsonErrorResponseHandler({
					errorSchema: z.any(),
					errorToMessage: (data) => getErrorMessage(data) ?? "unknown error"
				}),
				fetch: options.fetch
			});
			return {
				token: value.token,
				...value.expiresAt != null && { expiresAt: value.expiresAt }
			};
		} catch (error) {
			throw await asGatewayError(error, await parseAuthMethod(headers));
		}
	};
	const createO11yHeaders = () => {
		const deploymentId = loadOptionalSetting({
			settingValue: void 0,
			environmentVariableName: "VERCEL_DEPLOYMENT_ID"
		});
		const environment = loadOptionalSetting({
			settingValue: void 0,
			environmentVariableName: "VERCEL_ENV"
		});
		const region = loadOptionalSetting({
			settingValue: void 0,
			environmentVariableName: "VERCEL_REGION"
		});
		const projectId = loadOptionalSetting({
			settingValue: void 0,
			environmentVariableName: "VERCEL_PROJECT_ID"
		});
		return async () => {
			const requestId = await getVercelRequestId();
			return {
				...deploymentId && { "ai-o11y-deployment-id": deploymentId },
				...environment && { "ai-o11y-environment": environment },
				...region && { "ai-o11y-region": region },
				...requestId && { "ai-o11y-request-id": requestId },
				...projectId && { "ai-o11y-project-id": projectId }
			};
		};
	};
	const createLanguageModel = (modelId) => {
		return new GatewayLanguageModel(modelId, {
			provider: "gateway",
			baseURL,
			headers: getHeaders,
			fetch: options.fetch,
			o11yHeaders: createO11yHeaders()
		});
	};
	const createBatch = () => new GatewayBatch({
		provider: "gateway",
		maxLineBytes: options.batchResultDownloads?.maxLineBytes,
		baseURL,
		headers: getHeaders,
		fetch: options.fetch,
		o11yHeaders: createO11yHeaders()
	});
	const getAvailableModels = async () => {
		const now = options._internal?.currentDate?.().getTime() ?? Date.now();
		if (!pendingMetadata || now - lastFetchTime > cacheRefreshMillis) {
			lastFetchTime = now;
			pendingMetadata = new GatewayFetchMetadata({
				baseURL,
				headers: getHeaders,
				fetch: options.fetch
			}).getAvailableModels().then((metadata) => {
				metadataCache = metadata;
				return metadata;
			}).catch(async (error) => {
				throw await asGatewayError(error, await parseAuthMethod(await getHeaders()));
			});
		}
		return metadataCache ? Promise.resolve(metadataCache) : pendingMetadata;
	};
	const getCredits = async () => {
		return new GatewayFetchMetadata({
			baseURL,
			headers: getHeaders,
			fetch: options.fetch
		}).getCredits().catch(async (error) => {
			throw await asGatewayError(error, await parseAuthMethod(await getHeaders()));
		});
	};
	const getSpendReport = async (params) => {
		return new GatewaySpendReport({
			baseURL,
			headers: getHeaders,
			fetch: options.fetch
		}).getSpendReport(params).catch(async (error) => {
			throw await asGatewayError(error, await parseAuthMethod(await getHeaders()));
		});
	};
	const getGenerationInfo = async (params) => {
		return new GatewayGenerationInfoFetcher({
			baseURL,
			headers: getHeaders,
			fetch: options.fetch
		}).getGenerationInfo(params).catch(async (error) => {
			throw await asGatewayError(error, await parseAuthMethod(await getHeaders()));
		});
	};
	const provider = function(modelId) {
		if (new.target) throw new Error("The Gateway Provider model function cannot be called with the new keyword.");
		return createLanguageModel(modelId);
	};
	provider.specificationVersion = "v4";
	provider.getAvailableModels = getAvailableModels;
	provider.getCredits = getCredits;
	provider.getSpendReport = getSpendReport;
	provider.getGenerationInfo = getGenerationInfo;
	provider.imageModel = (modelId) => {
		return new GatewayImageModel(modelId, {
			provider: "gateway",
			baseURL,
			headers: getHeaders,
			fetch: options.fetch,
			o11yHeaders: createO11yHeaders()
		});
	};
	provider.languageModel = createLanguageModel;
	provider.experimental_batch = createBatch;
	const createEmbeddingModel = (modelId) => {
		return new GatewayEmbeddingModel(modelId, {
			provider: "gateway",
			baseURL,
			headers: getHeaders,
			fetch: options.fetch,
			o11yHeaders: createO11yHeaders()
		});
	};
	provider.embeddingModel = createEmbeddingModel;
	provider.textEmbeddingModel = createEmbeddingModel;
	provider.videoModel = (modelId) => {
		return new GatewayVideoModel(modelId, {
			provider: "gateway",
			baseURL,
			headers: getHeaders,
			fetch: options.fetch,
			o11yHeaders: createO11yHeaders()
		});
	};
	const createRerankingModel = (modelId) => {
		return new GatewayRerankingModel(modelId, {
			provider: "gateway",
			baseURL,
			headers: getHeaders,
			fetch: options.fetch,
			o11yHeaders: createO11yHeaders()
		});
	};
	provider.rerankingModel = createRerankingModel;
	provider.reranking = createRerankingModel;
	const createDecisionModel = (modelId) => {
		return new GatewayDecisionModel(modelId, {
			provider: "gateway",
			baseURL,
			headers: getHeaders,
			fetch: options.fetch,
			o11yHeaders: createO11yHeaders()
		});
	};
	provider.decisionModel = createDecisionModel;
	provider.decision = createDecisionModel;
	provider.evaluationModel = createDecisionModel;
	provider.evaluation = createDecisionModel;
	const createSpeechModel = (modelId) => {
		return new GatewaySpeechModel(modelId, {
			provider: "gateway",
			baseURL,
			headers: getHeaders,
			fetch: options.fetch,
			o11yHeaders: createO11yHeaders()
		});
	};
	provider.speechModel = createSpeechModel;
	provider.speech = createSpeechModel;
	const createTranscriptionModel = (modelId) => {
		return new GatewayTranscriptionModel(modelId, {
			provider: "gateway",
			baseURL,
			headers: getHeaders,
			fetch: options.fetch,
			o11yHeaders: createO11yHeaders(),
			webSocket: options.webSocket
		});
	};
	provider.transcriptionModel = createTranscriptionModel;
	provider.transcription = createTranscriptionModel;
	provider.experimental_transcription = Object.assign((modelId) => createTranscriptionModel(modelId), { getToken: async (tokenOptions) => {
		const secret = await mintClientSecret({
			modelId: tokenOptions.model,
			routeKind: "transcription",
			...tokenOptions.expiresAfterSeconds != null && { expiresAfterSeconds: tokenOptions.expiresAfterSeconds }
		});
		return {
			token: secret.token,
			url: toGatewayTranscriptionUrl(baseURL, tokenOptions.model),
			...secret.expiresAt != null && { expiresAt: secret.expiresAt }
		};
	} });
	const createRealtimeModel = (modelId) => new GatewayRealtimeModel(modelId, {
		provider: "gateway.realtime",
		baseURL,
		teamIdOrSlug: options.teamIdOrSlug,
		createClientSecret: mintClientSecret
	});
	provider.experimental_realtime = Object.assign((modelId) => createRealtimeModel(modelId), { getToken: async (tokenOptions) => {
		const { model: modelId, ...secretOptions } = tokenOptions;
		const secret = await createRealtimeModel(modelId).doCreateClientSecret(secretOptions);
		return {
			token: secret.token,
			url: secret.url,
			...secret.expiresAt != null && { expiresAt: secret.expiresAt }
		};
	} });
	provider.chat = provider.languageModel;
	provider.embedding = provider.embeddingModel;
	provider.image = provider.imageModel;
	provider.video = provider.videoModel;
	provider.tools = gatewayTools;
	return provider;
}
const gateway = createGateway();
async function getGatewayAuthToken(options) {
	const apiKey = loadOptionalSetting({
		settingValue: options.apiKey,
		environmentVariableName: "AI_GATEWAY_API_KEY"
	});
	if (apiKey) return {
		token: apiKey,
		authMethod: "api-key"
	};
	return {
		token: await (0, import_dist.getVercelOidcToken)(),
		authMethod: "oidc"
	};
}
function assertGatewayClientSecretServerEnvironment() {
	if (typeof globalThis.window !== "undefined") throw new Error("AI Gateway client secrets must be minted server-side: minting needs your Gateway credential, which must never reach the browser. Call gateway.experimental_realtime.getToken() or gateway.experimental_transcription.getToken() from your server and pass the returned token to the client.");
}
//#endregion
export { GatewayAuthenticationError, GatewayError, _enum, _instanceof, _null, array, boolean, createGateway, custom, discriminatedUnion, gateway, lazy, literal, looseObject, never, number, object, record, require_token_error, require_token_util, safeParseAsync, string, toJSONSchema, union, unknown };
