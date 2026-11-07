import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
import { GatewayAuthenticationError, GatewayError, _enum, _instanceof, _null, array, boolean, custom, discriminatedUnion, gateway, lazy, literal, looseObject, never, number, object, record, string, union, unknown } from "./@ai-sdk/gateway+[...].mjs";
import { AISDKError, APICallError, DecisionRefusalError, DecisionUnsupportedQuestionTypeError, InvalidPromptError, InvalidResponseDataError, NoSuchModelError, UnsupportedFunctionalityError, getErrorMessage } from "./ai-sdk__provider.mjs";
import { DelayedPromise, DownloadError, asArray, asSchema, cancelResponseBody, convertBase64ToUint8Array, convertUint8ArrayToBase64, createIdGenerator, detectMediaType, executeTool, fetchUntrustedUrl, filterNullable, getRuntimeEnvironmentUserAgent, getToolCaller, isAbortError, isBuffer, isExecutableTool, isFullMediaType, isProviderReference, isProviderStreamError, isUrlSupported, lazySchema, readResponseWithSizeLimit, retryWithExponentialBackoff, safeParseJSON, safeValidateTypes, validateTypes, withUserAgentSuffix, zodSchema } from "./ai-sdk__provider-utils.mjs";
//#region node_modules/ai/dist/index.js
const name$23 = "AI_InvalidArgumentError";
const marker$23 = `vercel.ai.error.${name$23}`;
const symbol$23 = Symbol.for(marker$23);
var InvalidArgumentError = class extends AISDKError {
	constructor({ parameter, value, message }) {
		super({
			name: name$23,
			message: `Invalid argument for parameter ${parameter}: ${message}`
		});
		this[symbol$23] = true;
		this.parameter = parameter;
		this.value = value;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$23);
	}
};
const name$21 = "AI_InvalidToolApprovalError";
const marker$21 = `vercel.ai.error.${name$21}`;
const symbol$21 = Symbol.for(marker$21);
var InvalidToolApprovalError = class extends AISDKError {
	constructor({ approvalId }) {
		super({
			name: name$21,
			message: `Tool approval response references unknown approvalId: "${approvalId}". No matching tool-approval-request found in message history.`
		});
		this[symbol$21] = true;
		this.approvalId = approvalId;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$21);
	}
};
const name$20 = "AI_InvalidToolApprovalSignatureError";
const marker$20 = `vercel.ai.error.${name$20}`;
const symbol$20 = Symbol.for(marker$20);
var InvalidToolApprovalSignatureError = class extends AISDKError {
	constructor({ approvalId, toolCallId, reason }) {
		super({
			name: name$20,
			message: `Tool approval signature verification failed for approval "${approvalId}" (tool call "${toolCallId}"): ${reason}`
		});
		this[symbol$20] = true;
		this.approvalId = approvalId;
		this.toolCallId = toolCallId;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$20);
	}
};
const name$19 = "AI_InvalidToolInputError";
const marker$19 = `vercel.ai.error.${name$19}`;
const symbol$19 = Symbol.for(marker$19);
var InvalidToolInputError = class extends AISDKError {
	constructor({ toolInput, toolName, cause, message = `Invalid input for tool ${toolName}: ${getErrorMessage(cause)}` }) {
		super({
			name: name$19,
			message,
			cause
		});
		this[symbol$19] = true;
		this.toolInput = toolInput;
		this.toolName = toolName;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$19);
	}
};
const name$18 = "AI_ToolCallNotFoundForApprovalError";
const marker$18 = `vercel.ai.error.${name$18}`;
const symbol$18 = Symbol.for(marker$18);
var ToolCallNotFoundForApprovalError = class extends AISDKError {
	constructor({ toolCallId, approvalId }) {
		super({
			name: name$18,
			message: `Tool call "${toolCallId}" not found for approval request "${approvalId}".`
		});
		this[symbol$18] = true;
		this.toolCallId = toolCallId;
		this.approvalId = approvalId;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$18);
	}
};
const name$17 = "AI_MissingToolResultsError";
const marker$17 = `vercel.ai.error.${name$17}`;
const symbol$17 = Symbol.for(marker$17);
var MissingToolResultsError = class extends AISDKError {
	constructor({ toolCallIds }) {
		super({
			name: name$17,
			message: `Tool result${toolCallIds.length > 1 ? "s are" : " is"} missing for tool call${toolCallIds.length > 1 ? "s" : ""} ${toolCallIds.join(", ")}.`
		});
		this[symbol$17] = true;
		this.toolCallIds = toolCallIds;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$17);
	}
};
const name$14 = "AI_NoOutputGeneratedError";
const marker$14 = `vercel.ai.error.${name$14}`;
const symbol$14 = Symbol.for(marker$14);
/**
* Thrown when no LLM output was generated, e.g. because of errors.
*/
var NoOutputGeneratedError = class extends AISDKError {
	constructor({ message = "No output generated.", cause } = {}) {
		super({
			name: name$14,
			message,
			cause
		});
		this[symbol$14] = true;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$14);
	}
};
const name$9 = "AI_NoSuchToolError";
const marker$9 = `vercel.ai.error.${name$9}`;
const symbol$9 = Symbol.for(marker$9);
var NoSuchToolError = class extends AISDKError {
	constructor({ toolName, availableTools = void 0, message = `Model tried to call unavailable tool '${toolName}'. ${availableTools === void 0 ? "No tools are available." : `Available tools: ${availableTools.join(", ")}.`}` }) {
		super({
			name: name$9,
			message
		});
		this[symbol$9] = true;
		this.toolName = toolName;
		this.availableTools = availableTools;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$9);
	}
};
const name$8 = "AI_StreamProviderError";
const marker$8 = `vercel.ai.error.${name$8}`;
const symbol$8 = Symbol.for(marker$8);
/**
* Error reported by a provider after a model response stream has started.
*/
var StreamProviderError = class extends AISDKError {
	constructor({ message, type, code, statusCode, isRetryable = isRetryableStatusCode$1(statusCode), data, cause }) {
		super({
			name: name$8,
			message,
			cause
		});
		this[symbol$8] = true;
		this.type = type;
		this.code = code;
		this.statusCode = statusCode;
		this.isRetryable = isRetryable;
		this.data = data;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$8);
	}
};
function isRetryableStatusCode$1(statusCode) {
	return statusCode != null && (statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500);
}
const name$7 = "AI_ToolCallRepairError";
const marker$7 = `vercel.ai.error.${name$7}`;
const symbol$7 = Symbol.for(marker$7);
var ToolCallRepairError = class extends AISDKError {
	constructor({ cause, originalError, message = `Error repairing tool call: ${getErrorMessage(cause)}` }) {
		super({
			name: name$7,
			message,
			cause
		});
		this[symbol$7] = true;
		this.originalError = originalError;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$7);
	}
};
const name$6 = "AI_ToolChoiceViolationError";
const marker$6 = `vercel.ai.error.${name$6}`;
const symbol$6 = Symbol.for(marker$6);
/**
* Thrown when a model response does not satisfy an enforced tool choice.
*/
var ToolChoiceViolationError = class extends AISDKError {
	constructor({ toolChoice, finishReason, provider, modelId, content, message = toolChoice.type === "required" ? "Model response did not contain a tool call even though tool choice was required." : `Model response did not contain a call to the required tool '${toolChoice.toolName}'.` }) {
		super({
			name: name$6,
			message
		});
		this[symbol$6] = true;
		this.toolChoice = toolChoice;
		this.finishReason = finishReason;
		this.provider = provider;
		this.modelId = modelId;
		this.content = content;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$6);
	}
};
/**
* Error that is thrown when a model with an unsupported version is used.
*/
var UnsupportedModelVersionError = class extends AISDKError {
	constructor(options) {
		super({
			name: "AI_UnsupportedModelVersionError",
			message: `Unsupported model version ${options.version} for provider "${options.provider}" and model "${options.modelId}". AI SDK 5 only supports models that implement specification version "v2".`
		});
		this.version = options.version;
		this.provider = options.provider;
		this.modelId = options.modelId;
	}
};
const name$5 = "AI_UIMessageStreamError";
const marker$5 = `vercel.ai.error.${name$5}`;
const symbol$5 = Symbol.for(marker$5);
/**
* Error thrown when a UI message stream reports an error or contains invalid
* or out-of-sequence chunks.
*
* This typically occurs when:
* - An error chunk is received
* - A delta chunk is received without a corresponding start chunk
* - An end chunk is received without a corresponding start chunk
* - A tool invocation is not found for the given toolCallId
*
* @see https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-ui-message-stream-error
*/
var UIMessageStreamError = class extends AISDKError {
	constructor({ chunkType, chunkId, message }) {
		super({
			name: name$5,
			message
		});
		this[symbol$5] = true;
		this.chunkType = chunkType;
		this.chunkId = chunkId;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$5);
	}
};
const name$4 = "AI_InvalidDataContentError";
const marker$4 = `vercel.ai.error.${name$4}`;
const symbol$4 = Symbol.for(marker$4);
var InvalidDataContentError = class extends AISDKError {
	constructor({ content, cause, message = `Invalid data content. Expected a base64 string, Uint8Array, ArrayBuffer, or Buffer, but got ${typeof content}.` }) {
		super({
			name: name$4,
			message,
			cause
		});
		this[symbol$4] = true;
		this.content = content;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$4);
	}
};
const name$3 = "AI_InvalidMessageRoleError";
const marker$3 = `vercel.ai.error.${name$3}`;
const symbol$3 = Symbol.for(marker$3);
var InvalidMessageRoleError = class extends AISDKError {
	constructor({ role, message = `Invalid message role: '${role}'. Must be one of: "system", "user", "assistant", "tool".` }) {
		super({
			name: name$3,
			message
		});
		this[symbol$3] = true;
		this.role = role;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$3);
	}
};
const name$1 = "AI_RetryError";
const marker$1 = `vercel.ai.error.${name$1}`;
const symbol$1 = Symbol.for(marker$1);
var RetryError = class extends AISDKError {
	constructor({ message, reason, errors }) {
		super({
			name: name$1,
			message
		});
		this[symbol$1] = true;
		this.reason = reason;
		this.errors = errors;
		this.lastError = errors[errors.length - 1];
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$1);
	}
};
const deprecationCodes = /* @__PURE__ */ new Map([
	["generateObject", "AISDK_DEP_GENERATE_OBJECT"],
	["streamObject", "AISDK_DEP_STREAM_OBJECT"],
	["experimental_generateSpeech", "AISDK_DEP_EXPERIMENTAL_GENERATE_SPEECH"],
	["experimental_transcribe", "AISDK_DEP_EXPERIMENTAL_TRANSCRIBE"],
	["\"image\" content part", "AISDK_DEP_IMAGE_CONTENT_PART"],
	["\"tool-result\" content of type \"file-data\"", "AISDK_DEP_TOOL_RESULT_FILE_DATA"],
	["\"tool-result\" content of type \"file-url\"", "AISDK_DEP_TOOL_RESULT_FILE_URL"],
	["\"tool-result\" content of type \"file-id\"", "AISDK_DEP_TOOL_RESULT_FILE_ID"],
	["\"tool-result\" content of type \"file-reference\"", "AISDK_DEP_TOOL_RESULT_FILE_REFERENCE"],
	["\"tool-result\" content of type \"image-data\"", "AISDK_DEP_TOOL_RESULT_IMAGE_DATA"],
	["\"tool-result\" content of type \"image-url\"", "AISDK_DEP_TOOL_RESULT_IMAGE_URL"],
	["\"tool-result\" content of type \"image-file-id\"", "AISDK_DEP_TOOL_RESULT_IMAGE_FILE_ID"],
	["\"tool-result\" content of type \"image-file-reference\"", "AISDK_DEP_TOOL_RESULT_IMAGE_FILE_REFERENCE"],
	["rawInput in output-error UI message parts", "AISDK_DEP_UI_MESSAGE_RAW_INPUT"]
]);
/**
* Escape punctuation and UTF-16 code units without losing case or collapsing
* distinct settings. Underscores are escaped too, so `__` separates code parts.
*/
function encodeCodePart(value) {
	return value.replace(/[^a-zA-Z0-9]/g, (character) => `_${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
}
function getDeprecationCode({ setting, provider }) {
	if (provider == null) return deprecationCodes.get(setting) ?? `AISDK_DEP_SETTING_${encodeCodePart(setting)}`;
	return `AISDK_DEP_PROVIDER_${encodeCodePart(provider)}__${encodeCodePart(setting)}`;
}
/**
* Formats a warning object into a human-readable string with clear AI SDK branding.
*
* @param options - The options for formatting the warning.
* @param options.warning - The warning to format.
* @param options.provider - The provider id used for the call, if scoped to a specific provider.
* @param options.model - The model id used for the call, if scoped to a specific provider.
* @returns A formatted warning message string.
*/
function formatWarning({ warning, provider, model }) {
	const prefix = `AI SDK Warning${provider != null && model != null ? ` (${provider} / ${model})` : ""}:`;
	switch (warning.type) {
		case "unsupported": {
			let message = `${prefix} The feature "${warning.feature}" is not supported.`;
			if (warning.details) message += ` ${warning.details}`;
			return message;
		}
		case "compatibility": {
			let message = `${prefix} The feature "${warning.feature}" is used in a compatibility mode.`;
			if (warning.details) message += ` ${warning.details}`;
			return message;
		}
		case "deprecated": return `${prefix} Deprecated: "${warning.setting}". ${warning.message}`;
		case "other": return `${prefix} ${warning.message}`;
		default: return `${prefix} ${JSON.stringify(warning, null, 2)}`;
	}
}
const FIRST_WARNING_INFO_MESSAGE = "AI SDK Warning System: To turn off warning logging, set the AI_SDK_LOG_WARNINGS global to false.";
let hasLoggedBefore = false;
const emittedDeprecationCodes = /* @__PURE__ */ new Set();
function emitWarning({ message, type, code }) {
	if (typeof process !== "undefined" && typeof process.emitWarning === "function") process.emitWarning(message, code == null ? { type } : {
		type,
		code
	});
	else console.warn(code == null ? message : `[${code}] ${message}`);
}
/**
* Logs warnings to the console or uses a custom logger if configured.
*
* The behavior can be customized via the `AI_SDK_LOG_WARNINGS` global variable:
* - If set to `false`, warnings are suppressed.
* - If set to a function, that function is called with the warnings.
* - Otherwise, warnings use `process.emitWarning` when available, falling back
*   to `console.warn`. Deprecations have stable codes and are emitted once per
*   code by the default logger. Custom loggers receive every warning.
*
* @param options - The options containing warnings and context.
* @param options.warnings - The warnings to log.
* @param options.provider - The provider id used for the call, if scoped to a specific provider.
* @param options.model - The model id used for the call, if scoped to a specific provider.
*/
const logWarnings = (options) => {
	if (options.warnings.length === 0) return;
	const logger = globalThis.AI_SDK_LOG_WARNINGS;
	if (logger === false) return;
	if (typeof logger === "function") {
		logger(options);
		return;
	}
	if (!hasLoggedBefore) {
		hasLoggedBefore = true;
		emitWarning({
			message: FIRST_WARNING_INFO_MESSAGE,
			type: "Warning"
		});
	}
	for (const warning of options.warnings) {
		const code = warning.type === "deprecated" ? getDeprecationCode({
			setting: warning.setting,
			provider: options.provider
		}) : void 0;
		if (code != null) {
			if (emittedDeprecationCodes.has(code)) continue;
			emittedDeprecationCodes.add(code);
		}
		emitWarning({
			message: formatWarning({
				warning,
				provider: options.provider,
				model: options.model
			}),
			type: warning.type === "deprecated" ? "DeprecationWarning" : "Warning",
			code
		});
	}
};
function logV2CompatibilityWarning({ provider, modelId }) {
	logWarnings({
		warnings: [{
			type: "compatibility",
			feature: "specificationVersion",
			details: `Using v2 specification compatibility mode. Some features may not be available.`
		}],
		provider,
		model: modelId
	});
}
function asEmbeddingModelV3(model) {
	if (model.specificationVersion === "v3") return model;
	logV2CompatibilityWarning({
		provider: model.provider,
		modelId: model.modelId
	});
	return new Proxy(model, { get(target, prop) {
		if (prop === "specificationVersion") return "v3";
		return target[prop];
	} });
}
function asEmbeddingModelV4(model) {
	if (model.specificationVersion === "v4") return model;
	const v3Model = model.specificationVersion === "v2" ? asEmbeddingModelV3(model) : model;
	return new Proxy(v3Model, { get(target, prop) {
		if (prop === "specificationVersion") return "v4";
		return target[prop];
	} });
}
function asImageModelV3(model) {
	if (model.specificationVersion === "v3") return model;
	logV2CompatibilityWarning({
		provider: model.provider,
		modelId: model.modelId
	});
	return new Proxy(model, { get(target, prop) {
		if (prop === "specificationVersion") return "v3";
		return target[prop];
	} });
}
function asImageModelV4(model) {
	if (model.specificationVersion === "v4") return model;
	const v3Model = model.specificationVersion === "v2" ? asImageModelV3(model) : model;
	return new Proxy(v3Model, { get(target, prop) {
		if (prop === "specificationVersion") return "v4";
		return target[prop];
	} });
}
function asLanguageModelV3(model) {
	if (model.specificationVersion === "v3") return model;
	logV2CompatibilityWarning({
		provider: model.provider,
		modelId: model.modelId
	});
	return new Proxy(model, { get(target, prop) {
		switch (prop) {
			case "specificationVersion": return "v3";
			case "doGenerate": return async (...args) => {
				const result = await target.doGenerate(...args);
				return {
					...result,
					finishReason: convertV2FinishReasonToV3(result.finishReason),
					usage: convertV2UsageToV3(result.usage)
				};
			};
			case "doStream": return async (...args) => {
				const result = await target.doStream(...args);
				return {
					...result,
					stream: convertV2StreamToV3(result.stream)
				};
			};
			default: return target[prop];
		}
	} });
}
function convertV2StreamToV3(stream) {
	return stream.pipeThrough(new TransformStream({ transform(chunk, controller) {
		switch (chunk.type) {
			case "finish":
				controller.enqueue({
					...chunk,
					finishReason: convertV2FinishReasonToV3(chunk.finishReason),
					usage: convertV2UsageToV3(chunk.usage)
				});
				break;
			default: controller.enqueue(chunk);
		}
	} }));
}
function convertV2FinishReasonToV3(finishReason) {
	return {
		unified: finishReason === "unknown" ? "other" : finishReason,
		raw: void 0
	};
}
function convertV2UsageToV3(usage) {
	return {
		inputTokens: {
			total: usage.inputTokens,
			noCache: void 0,
			cacheRead: usage.cachedInputTokens,
			cacheWrite: void 0
		},
		outputTokens: {
			total: usage.outputTokens,
			text: void 0,
			reasoning: usage.reasoningTokens
		},
		raw: usage.totalTokens == null ? void 0 : { totalTokens: usage.totalTokens }
	};
}
function asLanguageModelV4(model) {
	if (model.specificationVersion === "v4") return model;
	const v3Model = model.specificationVersion === "v2" ? asLanguageModelV3(model) : model;
	return new Proxy(v3Model, { get(target, prop) {
		switch (prop) {
			case "specificationVersion": return "v4";
			case "doGenerate": return async (options) => {
				const result = await target.doGenerate({
					...options,
					prompt: convertV4PromptToV3(options.prompt)
				});
				return {
					...result,
					content: result.content.map(convertV3ContentToV4)
				};
			};
			case "doStream": return async (options) => {
				const result = await target.doStream({
					...options,
					prompt: convertV4PromptToV3(options.prompt)
				});
				return {
					...result,
					stream: convertV3StreamToV4(result.stream)
				};
			};
			default: return target[prop];
		}
	} });
}
function convertV4PromptToV3(prompt) {
	return prompt.map((message) => {
		if (message.role === "system") return message;
		return {
			...message,
			content: message.content.map((part) => {
				switch (part.type) {
					case "file": return {
						...part,
						data: convertV4FileDataToV3(part.data)
					};
					case "tool-result": return {
						...part,
						output: convertV4ToolResultOutputToV3(part.output)
					};
					default: return part;
				}
			})
		};
	});
}
function convertV4FileDataToV3(data) {
	switch (data.type) {
		case "data": return data.data;
		case "url": return data.url;
		case "reference":
		case "text": return data;
	}
}
function convertV4ToolResultOutputToV3(output) {
	if (output.type !== "content") return output;
	return {
		...output,
		value: output.value.map((part) => {
			if (part.type !== "file") return part;
			switch (part.data.type) {
				case "data": return {
					type: "file-data",
					data: typeof part.data.data === "string" ? part.data.data : convertUint8ArrayToBase64(part.data.data),
					mediaType: part.mediaType,
					filename: part.filename,
					providerOptions: part.providerOptions
				};
				case "url": return {
					type: "file-url",
					url: part.data.url.toString(),
					providerOptions: part.providerOptions
				};
				case "reference": return {
					type: "file-id",
					fileId: part.data.reference,
					providerOptions: part.providerOptions
				};
				case "text": return part;
			}
		})
	};
}
function convertV3ContentToV4(content) {
	return content.type === "file" ? {
		...content,
		data: {
			type: "data",
			data: content.data
		}
	} : content;
}
function convertV3StreamToV4(stream) {
	return stream.pipeThrough(new TransformStream({ transform(chunk, controller) {
		controller.enqueue(chunk.type === "file" ? {
			...chunk,
			data: {
				type: "data",
				data: chunk.data
			}
		} : chunk);
	} }));
}
function asRerankingModelV4(model) {
	if (model.specificationVersion === "v4") return model;
	return new Proxy(model, { get(target, prop) {
		if (prop === "specificationVersion") return "v4";
		return target[prop];
	} });
}
function asSpeechModelV3(model) {
	if (model.specificationVersion === "v3") return model;
	logV2CompatibilityWarning({
		provider: model.provider,
		modelId: model.modelId
	});
	return new Proxy(model, { get(target, prop) {
		if (prop === "specificationVersion") return "v3";
		return target[prop];
	} });
}
function asSpeechModelV4(model) {
	if (model.specificationVersion === "v4") return model;
	const v3Model = model.specificationVersion === "v2" ? asSpeechModelV3(model) : model;
	return new Proxy(v3Model, { get(target, prop) {
		if (prop === "specificationVersion") return "v4";
		return target[prop];
	} });
}
function asTranscriptionModelV3(model) {
	if (model.specificationVersion === "v3") return model;
	logV2CompatibilityWarning({
		provider: model.provider,
		modelId: model.modelId
	});
	return new Proxy(model, { get(target, prop) {
		if (prop === "specificationVersion") return "v3";
		return target[prop];
	} });
}
function asTranscriptionModelV4(model) {
	if (model.specificationVersion === "v4") return model;
	const v3Model = model.specificationVersion === "v2" ? asTranscriptionModelV3(model) : model;
	return new Proxy(v3Model, { get(target, prop) {
		if (prop === "specificationVersion") return "v4";
		return target[prop];
	} });
}
function asProviderV3(provider) {
	if ("specificationVersion" in provider && provider.specificationVersion === "v3") return provider;
	const v2Provider = provider;
	return {
		specificationVersion: "v3",
		languageModel: (modelId) => asLanguageModelV3(v2Provider.languageModel(modelId)),
		embeddingModel: (modelId) => asEmbeddingModelV3(v2Provider.textEmbeddingModel(modelId)),
		imageModel: (modelId) => asImageModelV3(v2Provider.imageModel(modelId)),
		transcriptionModel: v2Provider.transcriptionModel ? (modelId) => asTranscriptionModelV3(v2Provider.transcriptionModel(modelId)) : void 0,
		speechModel: v2Provider.speechModel ? (modelId) => asSpeechModelV3(v2Provider.speechModel(modelId)) : void 0,
		rerankingModel: void 0
	};
}
function asProviderV4(provider) {
	if ("specificationVersion" in provider && provider.specificationVersion === "v4") return provider;
	const v3Provider = !("specificationVersion" in provider) || provider.specificationVersion !== "v3" ? asProviderV3(provider) : provider;
	return {
		specificationVersion: "v4",
		languageModel: (modelId) => asLanguageModelV4(v3Provider.languageModel(modelId)),
		embeddingModel: (modelId) => asEmbeddingModelV4(v3Provider.embeddingModel(modelId)),
		imageModel: (modelId) => asImageModelV4(v3Provider.imageModel(modelId)),
		transcriptionModel: v3Provider.transcriptionModel ? (modelId) => asTranscriptionModelV4(v3Provider.transcriptionModel(modelId)) : void 0,
		speechModel: v3Provider.speechModel ? (modelId) => asSpeechModelV4(v3Provider.speechModel(modelId)) : void 0,
		rerankingModel: v3Provider.rerankingModel ? (modelId) => asRerankingModelV4(v3Provider.rerankingModel(modelId)) : void 0
	};
}
function resolveLanguageModel(model) {
	if (typeof model === "string") return getGlobalProvider().languageModel(model);
	if (![
		"v4",
		"v3",
		"v2"
	].includes(model.specificationVersion)) {
		const unsupportedModel = model;
		throw new UnsupportedModelVersionError({
			version: unsupportedModel.specificationVersion,
			provider: unsupportedModel.provider,
			modelId: unsupportedModel.modelId
		});
	}
	return asLanguageModelV4(model);
}
function resolveDecisionModel(model) {
	if (typeof model === "string") {
		const provider = globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway;
		const factory = provider.decisionModel ?? provider.evaluationModel;
		if (typeof factory !== "function") throw new NoSuchModelError({
			modelId: model,
			modelType: "decisionModel",
			message: "The default provider does not support decision models. Pass a decision model instance or configure AI_SDK_DEFAULT_PROVIDER with a decisionModel method."
		});
		const resolvedModel = factory.call(provider, model);
		if (resolvedModel == null) throw new NoSuchModelError({
			modelId: model,
			modelType: "decisionModel"
		});
		model = resolvedModel;
	}
	if (model.specificationVersion !== "v4") throw new UnsupportedModelVersionError({
		version: model.specificationVersion,
		provider: model.provider,
		modelId: model.modelId
	});
	if ("doDecide" in model) return model;
	const legacyModel = model;
	return {
		specificationVersion: legacyModel.specificationVersion,
		provider: legacyModel.provider,
		modelId: legacyModel.modelId,
		supportedQuestionTypes: legacyModel.supportedQuestionTypes,
		doDecide: (options) => legacyModel.doEvaluate(options)
	};
}
function getGlobalProvider() {
	return asProviderV4(globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway);
}
/**
* Clone model messages while preserving URL instances. Node's structuredClone
* currently rejects URL objects, which are valid file/image prompt payloads.
*/
function cloneModelMessages(messages) {
	return messages.map((message) => cloneValue(message));
}
function cloneValue(value) {
	if (value instanceof URL) return new URL(value.href);
	if (Array.isArray(value)) return value.map((item) => cloneValue(item));
	if (value instanceof Uint8Array) return new Uint8Array(value);
	if (value instanceof ArrayBuffer) return value.slice(0);
	if (value instanceof Date) return new Date(value);
	if (value != null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, cloneValue(value)]));
	return value;
}
const VERSION = "7.0.141";
/**
* Download a file from a URL.
*
* @param url - The URL to download from.
* @param maxBytes - Maximum allowed download size in bytes. Defaults to 100 MiB.
* @param abortSignal - An optional abort signal to cancel the download.
* @returns The downloaded data and media type.
*
* @throws DownloadError if the download fails or exceeds maxBytes.
*/
const download = async ({ url, maxBytes, abortSignal }) => {
	const urlText = url.toString();
	try {
		const headers = withUserAgentSuffix({}, `ai-sdk/${VERSION}`, getRuntimeEnvironmentUserAgent());
		const response = await fetchUntrustedUrl({
			url: urlText,
			headers,
			abortSignal
		});
		if (!response.ok) {
			await cancelResponseBody(response);
			throw new DownloadError({
				url: urlText,
				statusCode: response.status,
				statusText: response.statusText
			});
		}
		return {
			data: await readResponseWithSizeLimit({
				response,
				url: urlText,
				maxBytes: maxBytes ?? 2147483648
			}),
			mediaType: response.headers.get("content-type") ?? void 0
		};
	} catch (error) {
		if (DownloadError.isInstance(error)) throw error;
		throw new DownloadError({
			url: urlText,
			cause: error
		});
	}
};
/**
* Default download function.
* Downloads the file if it is not supported by the model.
*/
const createDefaultDownloadFunction = (download$1 = download, abortSignal) => (requestedDownloads) => Promise.all(requestedDownloads.map(async (requestedDownload) => requestedDownload.isUrlSupportedByModel ? null : await download$1({
	...requestedDownload,
	abortSignal
})));
/**
* Deeply merges two objects together.
* - Properties from the `overrides` object override those in the `base` object with the same key.
* - For nested objects, the merge is performed recursively (deep merge).
* - Arrays are replaced, not merged.
* - Primitive values are replaced.
* - If both `base` and `overrides` are undefined, returns undefined.
* - If one of `base` or `overrides` is undefined, returns the other.
*
* @param base The target object to merge into
* @param overrides The source object to merge from
* @returns A new object with the merged properties, or undefined if both inputs are undefined
*/
function mergeObjects(base, overrides) {
	if (base === void 0 && overrides === void 0) return;
	if (base === void 0) return overrides;
	if (overrides === void 0) return base;
	const result = { ...base };
	for (const key in overrides) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		if (Object.prototype.hasOwnProperty.call(overrides, key)) {
			const overridesValue = overrides[key];
			if (overridesValue === void 0) continue;
			const baseValue = key in base ? base[key] : void 0;
			const isSourceObject = overridesValue !== null && typeof overridesValue === "object" && !Array.isArray(overridesValue) && !(overridesValue instanceof Date) && !(overridesValue instanceof RegExp);
			const isTargetObject = baseValue !== null && baseValue !== void 0 && typeof baseValue === "object" && !Array.isArray(baseValue) && !(baseValue instanceof Date) && !(baseValue instanceof RegExp);
			if (isSourceObject && isTargetObject) result[key] = mergeObjects(baseValue, overridesValue);
			else result[key] = overridesValue;
		}
	}
	return result;
}
function splitDataUrl(dataUrl) {
	try {
		const [header, base64Content] = dataUrl.split(",");
		return {
			mediaType: header.split(";")[0].split(":")[1],
			base64Content
		};
	} catch {
		return {
			mediaType: void 0,
			base64Content: void 0
		};
	}
}
function isTaggedFileData(value) {
	if (typeof value !== "object" || value === null) return false;
	const type = value.type;
	return type === "data" || type === "url" || type === "reference" || type === "text";
}
function convertUrlToFilePartData(url, originalUrl) {
	if (url.protocol === "data:") {
		const { mediaType, base64Content } = splitDataUrl(url.toString());
		if (mediaType == null || base64Content == null) throw new InvalidDataContentError({
			content: url,
			message: `Invalid data URL format in content ${url.toString()}`
		});
		return {
			data: {
				type: "data",
				data: base64Content
			},
			mediaType
		};
	}
	return {
		data: {
			type: "url",
			url,
			...originalUrl != null ? { originalUrl } : {}
		},
		mediaType: void 0
	};
}
function convertUrlStringToFilePartData(content) {
	const result = convertUrlToFilePartData(new URL(content));
	if (result.data.type === "url" && result.data.url.toString() !== content) result.data.originalUrl = content;
	return result;
}
function convertInlineDataToFilePartData(content) {
	if (content instanceof Uint8Array) return {
		data: {
			type: "data",
			data: content
		},
		mediaType: void 0
	};
	if (content instanceof ArrayBuffer) return {
		data: {
			type: "data",
			data: new Uint8Array(content)
		},
		mediaType: void 0
	};
	if (isBuffer(content)) return {
		data: {
			type: "data",
			data: new Uint8Array(content)
		},
		mediaType: void 0
	};
	return {
		data: {
			type: "data",
			data: content
		},
		mediaType: void 0
	};
}
/**
* Converts any legacy-or-tagged top-level `FilePart.data` /
* `ReasoningFilePart.data` value into the tagged v4 provider prompt shape.
*
* Returns the tagged `data` together with the resolved mediaType (extracted
* from a `data:` URL when applicable).
*/
function convertToLanguageModelV4FilePart(content) {
	if (isTaggedFileData(content)) switch (content.type) {
		case "data":
			if (typeof content.data === "string" && content.data.startsWith("data:")) throw new InvalidDataContentError({
				content: content.data,
				message: "Data URLs are not valid inline data. Pass them as { type: \"url\", url } instead."
			});
			return convertInlineDataToFilePartData(content.data);
		case "url": return convertUrlToFilePartData(content.url, content.originalUrl);
		case "reference": return {
			data: {
				type: "reference",
				reference: content.reference
			},
			mediaType: void 0
		};
		case "text": return {
			data: {
				type: "text",
				text: content.text
			},
			mediaType: void 0
		};
	}
	if (content instanceof URL) return convertUrlToFilePartData(content);
	if (typeof content === "string") try {
		return convertUrlStringToFilePartData(content);
	} catch {
		return convertInlineDataToFilePartData(content);
	}
	if (isProviderReference(content)) return {
		data: {
			type: "reference",
			reference: content
		},
		mediaType: void 0
	};
	return convertInlineDataToFilePartData(content);
}
async function convertToLanguageModelPrompt({ prompt, supportedUrls, download, abortSignal, provider }) {
	const downloadedAssets = await downloadAssets(prompt.messages, download ?? createDefaultDownloadFunction(void 0, abortSignal), supportedUrls);
	const messages = [...prompt.instructions != null ? typeof prompt.instructions === "string" ? [{
		role: "system",
		content: prompt.instructions
	}] : asArray(prompt.instructions).map((message) => ({
		role: "system",
		content: message.content,
		providerOptions: message.providerOptions
	})) : [], ...prompt.messages.map((message) => convertToLanguageModelMessage({
		message,
		downloadedAssets,
		provider
	}))];
	const combinedMessages = [];
	for (const message of messages) {
		if (message.role !== "tool") {
			combinedMessages.push(message);
			continue;
		}
		const lastCombinedMessage = combinedMessages.at(-1);
		if (lastCombinedMessage?.role === "tool") {
			const lastContentPart = lastCombinedMessage.content.at(-1);
			if (lastContentPart != null && lastCombinedMessage.providerOptions != null) lastContentPart.providerOptions = mergeObjects(lastCombinedMessage.providerOptions, lastContentPart.providerOptions);
			lastCombinedMessage.content.push(...message.content);
			lastCombinedMessage.providerOptions = lastContentPart == null ? mergeObjects(lastCombinedMessage.providerOptions, message.providerOptions) : message.providerOptions;
		} else combinedMessages.push(message);
	}
	const toolCallIds = /* @__PURE__ */ new Set();
	for (const message of combinedMessages) switch (message.role) {
		case "assistant":
			for (const content of message.content) if (content.type === "tool-call" && !content.providerExecuted) toolCallIds.add(content.toolCallId);
			break;
		case "tool":
			for (const content of message.content) if (content.type === "tool-result") toolCallIds.delete(content.toolCallId);
			break;
		case "user":
		case "system": if (toolCallIds.size > 0) throw new MissingToolResultsError({ toolCallIds: Array.from(toolCallIds) });
	}
	if (toolCallIds.size > 0) throw new MissingToolResultsError({ toolCallIds: Array.from(toolCallIds) });
	return combinedMessages.filter((message) => message.role !== "tool" || message.content.length > 0);
}
/**
* Convert a ModelMessage to a LanguageModelV4Message.
*
* @param message - The ModelMessage to convert.
* @param downloadedAssets - A map of URLs to their downloaded data. Only
* available if the model does not support URLs, null otherwise.
*/
function convertToLanguageModelMessage({ message, downloadedAssets, provider }) {
	const warnings = [];
	const role = message.role;
	switch (role) {
		case "system": return {
			role: "system",
			content: message.content,
			providerOptions: message.providerOptions
		};
		case "user": {
			if (typeof message.content === "string") return {
				role: "user",
				content: [{
					type: "text",
					text: message.content
				}],
				providerOptions: message.providerOptions
			};
			const converted = {
				role: "user",
				content: message.content.map((part) => {
					if (part.type === "image") warnings.push({
						type: "deprecated",
						setting: "\"image\" content part",
						message: `The "image" content part type is deprecated. Use a "file" part with mediaType: 'image' (or a more specific image/* subtype) instead.`
					});
					return convertImagePartToFilePart(part);
				}).map((part) => convertPartToLanguageModelPart(part, downloadedAssets)).filter((part) => part.type !== "text" || part.text !== ""),
				providerOptions: message.providerOptions
			};
			if (warnings.length > 0) logWarnings({ warnings });
			return converted;
		}
		case "assistant": {
			if (typeof message.content === "string") return {
				role: "assistant",
				content: [{
					type: "text",
					text: message.content
				}],
				providerOptions: message.providerOptions
			};
			const converted = {
				role: "assistant",
				content: message.content.filter((part) => part.type !== "text" || part.text !== "" || part.providerOptions != null).filter((part) => part.type !== "tool-approval-request").map((part) => {
					const providerOptions = part.providerOptions;
					switch (part.type) {
						case "custom": return {
							type: "custom",
							kind: part.kind,
							providerOptions
						};
						case "file": {
							const { data, mediaType } = convertToLanguageModelV4FilePart(part.data);
							return {
								type: "file",
								data,
								filename: part.filename,
								mediaType: mediaType ?? part.mediaType,
								providerOptions
							};
						}
						case "reasoning": return {
							type: "reasoning",
							text: part.text,
							providerOptions
						};
						case "reasoning-file": {
							const { data, mediaType } = convertToLanguageModelV4FilePart(part.data);
							if (data.type !== "data" && data.type !== "url") throw new Error(`Unsupported reasoning-file data type: ${data.type}`);
							return {
								type: "reasoning-file",
								data,
								mediaType: mediaType ?? part.mediaType,
								providerOptions
							};
						}
						case "text": return {
							type: "text",
							text: part.text,
							providerOptions
						};
						case "tool-call": return {
							type: "tool-call",
							toolCallId: part.toolCallId,
							toolName: part.toolName,
							input: part.input,
							providerExecuted: part.providerExecuted,
							providerOptions
						};
						case "tool-result": return {
							type: "tool-result",
							toolCallId: part.toolCallId,
							toolName: part.toolName,
							output: mapToolResultOutput({
								output: part.output,
								provider,
								warnings,
								downloadedAssets
							}),
							providerOptions
						};
					}
				}),
				providerOptions: message.providerOptions
			};
			if (warnings.length > 0) logWarnings({ warnings });
			return converted;
		}
		case "tool": {
			const converted = {
				role: "tool",
				content: message.content.filter((part) => part.type !== "tool-approval-response" || part.providerExecuted).map((part) => {
					switch (part.type) {
						case "tool-result": return {
							type: "tool-result",
							toolCallId: part.toolCallId,
							toolName: part.toolName,
							output: mapToolResultOutput({
								output: part.output,
								provider,
								warnings,
								downloadedAssets
							}),
							providerOptions: part.providerOptions
						};
						case "tool-approval-response": return {
							type: "tool-approval-response",
							approvalId: part.approvalId,
							approved: part.approved,
							reason: part.reason
						};
					}
				}),
				providerOptions: message.providerOptions
			};
			if (warnings.length > 0) logWarnings({ warnings });
			return converted;
		}
		default: throw new InvalidMessageRoleError({ role });
	}
}
function convertImagePartToFilePart(part) {
	if (part.type !== "image") return part;
	return {
		type: "file",
		data: part.image,
		mediaType: part.mediaType ?? "image",
		providerOptions: part.providerOptions
	};
}
/**
* Downloads files from URLs in the user messages.
*/
async function downloadAssets(messages, download, supportedUrls) {
	const downloadableFiles = [];
	for (const message of messages) {
		if (message.role === "user" && Array.isArray(message.content)) for (const part of message.content) {
			const filePart = convertImagePartToFilePart(part);
			if (filePart.type === "file") downloadableFiles.push(filePart);
		}
		if (message.role === "tool") for (const part of message.content) {
			if (part.type !== "tool-result") continue;
			if (part.output.type !== "content") continue;
			for (const contentPart of part.output.value) if (contentPart.type === "file") downloadableFiles.push(contentPart);
		}
		if (message.role === "assistant" && Array.isArray(message.content)) for (const part of message.content) {
			if (part.type !== "tool-result") continue;
			if (part.output.type !== "content") continue;
			for (const contentPart of part.output.value) if (contentPart.type === "file") downloadableFiles.push(contentPart);
		}
	}
	const plannedDownloads = downloadableFiles.map((part) => {
		const mediaType = part.mediaType;
		const { data } = convertToLanguageModelV4FilePart(part.data);
		return {
			mediaType,
			data
		};
	}).filter((part) => part.data.type === "url").map((part) => ({
		url: part.data.url,
		isUrlSupportedByModel: part.mediaType != null && isUrlSupported({
			url: part.data.url.toString(),
			mediaType: part.mediaType,
			supportedUrls
		})
	}));
	const downloadedFiles = await download(plannedDownloads);
	return Object.fromEntries(downloadedFiles.map((file, index) => file == null ? null : [plannedDownloads[index].url.toString(), {
		data: file.data,
		mediaType: file.mediaType
	}]).filter((file) => file != null));
}
/**
* Convert part of a user message to a LanguageModelV4Part.
*
* @param part - The part to convert.
* @param downloadedAssets - A map of URLs to their downloaded data. Only
* available if the model does not support URLs, null otherwise.
* @returns The converted part.
*/
function convertPartToLanguageModelPart(part, downloadedAssets) {
	if (part.type === "text") return {
		type: "text",
		text: part.text,
		providerOptions: part.providerOptions
	};
	const { data: normalizedData, mediaType: dataUrlMediaType } = convertToLanguageModelV4FilePart(part.data);
	let mediaType = dataUrlMediaType ?? part.mediaType;
	let data = normalizedData;
	if (data.type === "url") {
		const downloadedFile = downloadedAssets[data.url.toString()];
		if (downloadedFile) {
			data = {
				type: "data",
				data: downloadedFile.data
			};
			if (downloadedFile.mediaType != null && (mediaType == null || !isFullMediaType(mediaType))) mediaType = downloadedFile.mediaType;
		}
	}
	if (data.type === "data" && (data.data instanceof Uint8Array || typeof data.data === "string")) {
		const imageMediaType = detectMediaType({
			data: data.data,
			topLevelType: "image"
		});
		if (imageMediaType != null) mediaType = imageMediaType;
	}
	if (mediaType == null) throw new Error(`Media type is missing for file part`);
	return {
		type: "file",
		mediaType,
		filename: part.filename,
		data,
		providerOptions: part.providerOptions
	};
}
function mapToolResultOutput({ output, provider, warnings = [], downloadedAssets }) {
	if (output.type !== "content") return output;
	return {
		type: "content",
		value: output.value.map((item) => {
			switch (item.type) {
				case "file": {
					const convertedPart = convertPartToLanguageModelPart(item, downloadedAssets);
					if (convertedPart.type !== "file") throw new Error("Expected tool result file content to convert to file.");
					return convertedPart;
				}
				case "file-data":
					warnings.push({
						type: "deprecated",
						setting: "\"tool-result\" content of type \"file-data\"",
						message: `The "file-data" type for tool result content is deprecated. Use the "file" type with mediaType and { type: 'data', data } instead.`
					});
					return {
						type: "file",
						data: {
							type: "data",
							data: item.data
						},
						filename: item.filename,
						mediaType: item.mediaType,
						providerOptions: item.providerOptions
					};
				case "file-url": {
					const mediaType = item.mediaType ?? getMediaTypeFromUrl(item.url);
					const url = new URL(item.url);
					let message = `The "file-url" type for tool result content is deprecated. Use the "file" type with mediaType and { type: 'url', url } instead.`;
					if (!item.mediaType) {
						const inferenceSuffix = mediaType === "application/octet-stream" ? `Unable to infer media type from URL. Defaulting to 'application/octet-stream'.` : `Inferred media type '${mediaType}' from URL.`;
						message = `The "file-url" tool result content part with URL "${item.url}" is missing a "mediaType". ${inferenceSuffix} ${message}`;
					}
					warnings.push({
						type: "deprecated",
						setting: "\"tool-result\" content of type \"file-url\"",
						message
					});
					return {
						type: "file",
						data: {
							type: "url",
							url,
							...url.toString() !== item.url ? { originalUrl: item.url } : {}
						},
						mediaType,
						providerOptions: item.providerOptions
					};
				}
				case "file-id":
					warnings.push({
						type: "deprecated",
						setting: "\"tool-result\" content of type \"file-id\"",
						message: `The "file-id" type for tool result content is deprecated. Use the "file" type with mediaType and { type: 'reference', reference } instead.`
					});
					return {
						type: "file",
						data: {
							type: "reference",
							reference: convertFileIdToProviderReference({
								fileId: item.fileId,
								provider
							})
						},
						mediaType: "application",
						providerOptions: item.providerOptions
					};
				case "file-reference":
					warnings.push({
						type: "deprecated",
						setting: "\"tool-result\" content of type \"file-reference\"",
						message: `The "file-reference" type for tool result content is deprecated. Use the "file" type with mediaType and { type: 'reference', reference } instead.`
					});
					return {
						type: "file",
						data: {
							type: "reference",
							reference: item.providerReference
						},
						mediaType: "application",
						providerOptions: item.providerOptions
					};
				case "image-data":
					warnings.push({
						type: "deprecated",
						setting: "\"tool-result\" content of type \"image-data\"",
						message: `The "image-data" type for tool result content is deprecated. Use the "file" type with mediaType and { type: 'data', data } instead.`
					});
					return {
						type: "file",
						data: {
							type: "data",
							data: item.data
						},
						mediaType: item.mediaType,
						providerOptions: item.providerOptions
					};
				case "image-url": {
					const url = new URL(item.url);
					warnings.push({
						type: "deprecated",
						setting: "\"tool-result\" content of type \"image-url\"",
						message: `The "image-url" type for tool result content is deprecated. Use the "file" type with mediaType 'image' (or a specific image/* subtype) and { type: 'url', url } instead.`
					});
					return {
						type: "file",
						data: {
							type: "url",
							url,
							...url.toString() !== item.url ? { originalUrl: item.url } : {}
						},
						mediaType: "image",
						providerOptions: item.providerOptions
					};
				}
				case "image-file-id":
					warnings.push({
						type: "deprecated",
						setting: "\"tool-result\" content of type \"image-file-id\"",
						message: `The "image-file-id" type for tool result content is deprecated. Use the "file" type with mediaType and { type: 'reference', reference } instead.`
					});
					return {
						type: "file",
						data: {
							type: "reference",
							reference: convertFileIdToProviderReference({
								fileId: item.fileId,
								provider
							})
						},
						mediaType: "image",
						providerOptions: item.providerOptions
					};
				case "image-file-reference":
					warnings.push({
						type: "deprecated",
						setting: "\"tool-result\" content of type \"image-file-reference\"",
						message: `The "image-file-reference" type for tool result content is deprecated. Use the "file" type with mediaType and { type: 'reference', reference } instead.`
					});
					return {
						type: "file",
						data: {
							type: "reference",
							reference: item.providerReference
						},
						mediaType: "image",
						providerOptions: item.providerOptions
					};
				default: return item;
			}
		})
	};
}
function convertFileIdToProviderReference({ fileId, provider }) {
	if (typeof fileId === "object") return fileId;
	if (provider == null) throw new Error("Cannot convert string fileId to provider reference without a provider ID. Use a Record<string, string> fileId or switch to the file-reference type.");
	return { [provider]: fileId };
}
const URL_EXTENSION_TO_MEDIA_TYPE = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	avif: "image/avif",
	heic: "image/heic",
	bmp: "image/bmp",
	tiff: "image/tiff",
	tif: "image/tiff",
	pdf: "application/pdf",
	mp4: "video/mp4",
	webm: "video/webm",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg"
};
function getMediaTypeFromUrl(url, fallbackMediaType = "application/octet-stream") {
	try {
		const fileExtension = new URL(url).pathname.split(".").pop()?.toLowerCase();
		if (fileExtension && Object.hasOwn(URL_EXTENSION_TO_MEDIA_TYPE, fileExtension)) return URL_EXTENSION_TO_MEDIA_TYPE[fileExtension];
	} catch {}
	return fallbackMediaType;
}
async function createToolModelOutput({ toolCallId, input, output, tool, errorMode }) {
	if (errorMode === "text") return {
		type: "error-text",
		value: getErrorMessage(output)
	};
	else if (errorMode === "json") return {
		type: "error-json",
		value: toJSONValue(output)
	};
	if (tool?.toModelOutput) return await tool.toModelOutput({
		toolCallId,
		input,
		output
	});
	return typeof output === "string" ? {
		type: "text",
		value: output
	} : {
		type: "json",
		value: toJSONValue(output)
	};
}
/**
* Normalizes an in-process tool output to a plain JSON value
* (applies `toJSON`, converts `Date`, drops `undefined`, etc.)
* by round-tripping it through `JSON.stringify`.
*
* The parsed text is produced by `JSON.stringify` from a value that is
* already materialized in this process, so it is not untrusted input.
* `JSON.parse` is used deliberately instead of the secure parser from
* `@ai-sdk/provider-utils`: the secure parser rejects own `__proto__` and
* `constructor.prototype` keys, which are valid data in tool outputs
* (e.g. rows from an external API). `JSON.parse` defines `__proto__` as an
* own data property and never modifies the prototype chain, so preserving
* these keys here is safe. Do not reuse this pattern for text that comes
* from outside the process; use `parseJSON` / `safeParseJSON` instead.
*/
function toJSONValue(value) {
	if (value === void 0) return null;
	const serialized = JSON.stringify(value);
	return serialized === void 0 ? null : JSON.parse(serialized);
}
/**
* Validates model call options and returns a new object with normalized values.
*/
function prepareLanguageModelCallOptions({ maxOutputTokens, temperature, topP, topK, presencePenalty, frequencyPenalty, seed, stopSequences, reasoning }) {
	if (maxOutputTokens != null) {
		if (!Number.isInteger(maxOutputTokens)) throw new InvalidArgumentError({
			parameter: "maxOutputTokens",
			value: maxOutputTokens,
			message: "maxOutputTokens must be an integer"
		});
		if (maxOutputTokens < 1) throw new InvalidArgumentError({
			parameter: "maxOutputTokens",
			value: maxOutputTokens,
			message: "maxOutputTokens must be >= 1"
		});
	}
	if (temperature != null) {
		if (typeof temperature !== "number") throw new InvalidArgumentError({
			parameter: "temperature",
			value: temperature,
			message: "temperature must be a number"
		});
	}
	if (topP != null) {
		if (typeof topP !== "number") throw new InvalidArgumentError({
			parameter: "topP",
			value: topP,
			message: "topP must be a number"
		});
	}
	if (topK != null) {
		if (typeof topK !== "number") throw new InvalidArgumentError({
			parameter: "topK",
			value: topK,
			message: "topK must be a number"
		});
	}
	if (presencePenalty != null) {
		if (typeof presencePenalty !== "number") throw new InvalidArgumentError({
			parameter: "presencePenalty",
			value: presencePenalty,
			message: "presencePenalty must be a number"
		});
	}
	if (frequencyPenalty != null) {
		if (typeof frequencyPenalty !== "number") throw new InvalidArgumentError({
			parameter: "frequencyPenalty",
			value: frequencyPenalty,
			message: "frequencyPenalty must be a number"
		});
	}
	if (seed != null) {
		if (!Number.isInteger(seed)) throw new InvalidArgumentError({
			parameter: "seed",
			value: seed,
			message: "seed must be an integer"
		});
	}
	return {
		maxOutputTokens,
		temperature,
		topP,
		topK,
		presencePenalty,
		frequencyPenalty,
		stopSequences,
		seed,
		reasoning
	};
}
function prepareToolChoice({ toolChoice }) {
	return toolChoice == null ? { type: "auto" } : typeof toolChoice === "string" ? { type: toolChoice } : {
		type: "tool",
		toolName: toolChoice.toolName
	};
}
function isNonEmptyObject(object) {
	return object != null && Object.keys(object).length > 0;
}
async function prepareTools({ tools, toolOrder, toolsContext = {}, experimental_sandbox: sandbox }) {
	if (!isNonEmptyObject(tools)) return;
	const languageModelTools = [];
	for (const [name, tool] of orderToolEntries({
		tools,
		toolOrder
	})) {
		const toolType = tool.type;
		switch (toolType) {
			case void 0:
			case "dynamic":
			case "function": {
				const description = resolveToolDescription({
					tool,
					toolName: name,
					toolsContext,
					experimental_sandbox: sandbox
				});
				const providerOptions = tool.providerOptions;
				const inputExamples = tool.inputExamples;
				const strict = tool.strict;
				languageModelTools.push({
					type: "function",
					name,
					inputSchema: await asSchema(tool.inputSchema).jsonSchema,
					...description != null ? { description } : {},
					...inputExamples != null ? { inputExamples } : {},
					...providerOptions != null ? { providerOptions } : {},
					...strict != null ? { strict } : {}
				});
				break;
			}
			case "provider":
				languageModelTools.push({
					type: "provider",
					name,
					id: tool.id,
					args: tool.args
				});
				break;
			default: throw new Error(`Unsupported tool type: ${toolType}`);
		}
	}
	return languageModelTools;
}
function orderToolEntries({ tools, toolOrder }) {
	if (toolOrder == null) return Object.entries(tools);
	const toolEntries = Object.entries(tools);
	const orderedTools = toolEntries.filter(([name]) => toolOrder.includes(name)).sort(([nameA], [nameB]) => toolOrder.indexOf(nameA) - toolOrder.indexOf(nameB));
	const unorderedTools = toolEntries.filter(([name]) => !toolOrder.includes(name)).sort(([nameA], [nameB]) => nameA < nameB ? -1 : nameA > nameB ? 1 : 0);
	return [...orderedTools, ...unorderedTools];
}
function resolveToolDescription({ tool, toolName, toolsContext, experimental_sandbox: sandbox }) {
	return tool.description === void 0 ? void 0 : typeof tool.description === "string" ? tool.description : tool.description({
		context: toolsContext[toolName],
		experimental_sandbox: sandbox
	});
}
/**
* Extracts the total timeout value in milliseconds from a TimeoutConfiguration.
*
* @param timeout - The timeout configuration.
* @returns The total timeout in milliseconds, or undefined if no timeout is configured.
*/
function getTotalTimeoutMs(timeout) {
	if (timeout == null) return;
	if (typeof timeout === "number") return timeout;
	return timeout.totalMs;
}
/**
* Extracts the step timeout value in milliseconds from a TimeoutConfiguration.
*
* @param timeout - The timeout configuration.
* @returns The step timeout in milliseconds, or undefined if no step timeout is configured.
*/
function getStepTimeoutMs(timeout) {
	if (timeout == null || typeof timeout === "number") return;
	return timeout.stepMs;
}
/**
* Extracts the first chunk timeout value in milliseconds from a TimeoutConfiguration.
* This timeout is for streaming only - it aborts if no content chunk is received within the specified duration.
*
* @param timeout - The timeout configuration.
* @returns The first chunk timeout in milliseconds, or undefined if no first chunk timeout is configured.
*/
function getFirstChunkTimeoutMs(timeout) {
	if (timeout == null || typeof timeout === "number") return;
	return timeout.firstChunkMs;
}
/**
* Extracts the chunk timeout value in milliseconds from a TimeoutConfiguration.
* This timeout is for streaming only - it aborts if no new content chunk is received within the specified duration.
*
* @param timeout - The timeout configuration.
* @returns The chunk timeout in milliseconds, or undefined if no chunk timeout is configured.
*/
function getChunkTimeoutMs(timeout) {
	if (timeout == null || typeof timeout === "number") return;
	return timeout.chunkMs;
}
function getToolTimeoutMs(timeout, toolName) {
	if (timeout == null || typeof timeout === "number") return;
	return timeout.tools?.[`${toolName}Ms`] ?? timeout.toolMs;
}
const z = {
	array,
	boolean,
	custom,
	discriminatedUnion,
	enum: _enum,
	instanceof: _instanceof,
	lazy,
	literal,
	looseObject,
	never,
	null: _null,
	number,
	object,
	record,
	string,
	union,
	unknown
};
const jsonValueSchema = z.lazy(() => z.union([
	z.null(),
	z.string(),
	z.number(),
	z.boolean(),
	z.record(z.string(), jsonValueSchema.optional()),
	z.array(jsonValueSchema)
]));
const providerMetadataSchema = z.record(z.string(), z.record(z.string(), jsonValueSchema.optional()));
const fileInlineDataSchema = z.union([
	z.string(),
	z.instanceof(Uint8Array),
	z.instanceof(ArrayBuffer),
	z.custom(isBuffer, { message: "Must be a Buffer" })
]);
const providerReferenceSchema$1 = z.record(z.string(), z.string());
/**
* @internal
*/
const textPartSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
	providerOptions: providerMetadataSchema.optional()
});
/**
* @internal
* @deprecated Use `filePartSchema` with `mediaType: 'image'` instead:
* `{ type: 'file', mediaType: 'image', data: { type: 'data', data } }`.
*/
const imagePartSchema = z.object({
	type: z.literal("image"),
	image: z.union([
		fileInlineDataSchema,
		z.instanceof(URL),
		providerReferenceSchema$1
	]),
	mediaType: z.string().optional(),
	providerOptions: providerMetadataSchema.optional()
});
const taggedFileDataSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("data"),
		data: fileInlineDataSchema
	}),
	z.object({
		type: z.literal("url"),
		url: z.instanceof(URL)
	}),
	z.object({
		type: z.literal("reference"),
		reference: providerReferenceSchema$1
	}),
	z.object({
		type: z.literal("text"),
		text: z.string()
	})
]);
const taggedReasoningFileDataSchema = z.discriminatedUnion("type", [z.object({
	type: z.literal("data"),
	data: fileInlineDataSchema
}), z.object({
	type: z.literal("url"),
	url: z.instanceof(URL)
})]);
/**
* @internal
*/
const filePartSchema = z.object({
	type: z.literal("file"),
	data: z.union([
		taggedFileDataSchema,
		fileInlineDataSchema,
		z.instanceof(URL),
		providerReferenceSchema$1
	]),
	filename: z.string().optional(),
	mediaType: z.string(),
	providerOptions: providerMetadataSchema.optional()
});
/**
* @internal
*/
const reasoningPartSchema = z.object({
	type: z.literal("reasoning"),
	text: z.string(),
	providerOptions: providerMetadataSchema.optional()
});
/**
* @internal
*/
const customPartSchema = z.object({
	type: z.literal("custom"),
	kind: z.string().transform((value) => value),
	providerOptions: providerMetadataSchema.optional()
});
/**
* @internal
*/
const reasoningFilePartSchema = z.object({
	type: z.literal("reasoning-file"),
	data: z.union([
		taggedReasoningFileDataSchema,
		fileInlineDataSchema,
		z.instanceof(URL)
	]),
	mediaType: z.string(),
	providerOptions: providerMetadataSchema.optional()
});
/**
* @internal
*/
const toolCallPartSchema = z.object({
	type: z.literal("tool-call"),
	toolCallId: z.string(),
	toolName: z.string(),
	input: z.unknown(),
	providerOptions: providerMetadataSchema.optional(),
	providerExecuted: z.boolean().optional()
});
/**
* @internal
*/
const outputSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("text"),
		value: z.string(),
		providerOptions: providerMetadataSchema.optional()
	}),
	z.object({
		type: z.literal("json"),
		value: jsonValueSchema,
		providerOptions: providerMetadataSchema.optional()
	}),
	z.object({
		type: z.literal("execution-denied"),
		reason: z.string().optional(),
		providerOptions: providerMetadataSchema.optional()
	}),
	z.object({
		type: z.literal("error-text"),
		value: z.string(),
		providerOptions: providerMetadataSchema.optional()
	}),
	z.object({
		type: z.literal("error-json"),
		value: jsonValueSchema,
		providerOptions: providerMetadataSchema.optional()
	}),
	z.object({
		type: z.literal("content"),
		value: z.array(z.union([
			z.object({
				type: z.literal("text"),
				text: z.string(),
				providerOptions: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("file"),
				data: taggedFileDataSchema,
				mediaType: z.string(),
				filename: z.string().optional(),
				providerOptions: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("file-data"),
				data: z.string(),
				mediaType: z.string(),
				filename: z.string().optional(),
				providerOptions: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("file-url"),
				url: z.string(),
				mediaType: z.string().optional(),
				providerOptions: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("file-id"),
				fileId: z.union([z.string(), z.record(z.string(), z.string())]),
				providerOptions: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("file-reference"),
				providerReference: z.record(z.string(), z.string()),
				providerOptions: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("image-data"),
				data: z.string(),
				mediaType: z.string(),
				providerOptions: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("image-url"),
				url: z.string(),
				providerOptions: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("image-file-id"),
				fileId: z.union([z.string(), z.record(z.string(), z.string())]),
				providerOptions: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("image-file-reference"),
				providerReference: z.record(z.string(), z.string()),
				providerOptions: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("custom"),
				providerOptions: providerMetadataSchema.optional()
			})
		]))
	})
]);
/**
* @internal
*/
const toolResultPartSchema = z.object({
	type: z.literal("tool-result"),
	toolCallId: z.string(),
	toolName: z.string(),
	output: outputSchema,
	providerOptions: providerMetadataSchema.optional()
});
/**
* @internal
*/
const toolApprovalRequestSchema = z.object({
	type: z.literal("tool-approval-request"),
	approvalId: z.string(),
	toolCallId: z.string(),
	reason: z.string().optional(),
	isAutomatic: z.boolean().optional(),
	signature: z.string().optional(),
	inputSchemaInput: z.unknown().optional()
});
/**
* @internal
*/
const toolApprovalResponseSchema = z.object({
	type: z.literal("tool-approval-response"),
	approvalId: z.string(),
	approved: z.boolean(),
	reason: z.string().optional()
});
const systemModelMessageSchema = z.object({
	role: z.literal("system"),
	content: z.string(),
	providerOptions: providerMetadataSchema.optional()
});
const userModelMessageSchema = z.object({
	role: z.literal("user"),
	content: z.union([z.string(), z.array(z.union([
		textPartSchema,
		imagePartSchema,
		filePartSchema
	]))]),
	providerOptions: providerMetadataSchema.optional()
});
const assistantModelMessageSchema = z.object({
	role: z.literal("assistant"),
	content: z.union([z.string(), z.array(z.union([
		textPartSchema,
		customPartSchema,
		filePartSchema,
		reasoningPartSchema,
		reasoningFilePartSchema,
		toolCallPartSchema,
		toolResultPartSchema,
		toolApprovalRequestSchema
	]))]),
	providerOptions: providerMetadataSchema.optional()
});
const toolModelMessageSchema = z.object({
	role: z.literal("tool"),
	content: z.array(z.union([toolResultPartSchema, toolApprovalResponseSchema])),
	providerOptions: providerMetadataSchema.optional()
});
const modelMessageSchema = z.union([
	systemModelMessageSchema,
	userModelMessageSchema,
	assistantModelMessageSchema,
	toolModelMessageSchema
]);
/**
* Converts a prompt input into a standardized prompt with validated model
* messages.
*
* @param prompt - The prompt definition to standardize.
* Set `allowSystemInMessages` to true to allow system messages in the
* `prompt` or `messages` fields. System messages in the `instructions`
* option are always allowed.
* @returns The standardized prompt.
* @throws {InvalidPromptError} When the prompt is invalid.
*/
async function standardizePrompt({ allowSystemInMessages = false, system, instructions = system, prompt, messages }) {
	if (prompt == null && messages == null) throw new InvalidPromptError({
		prompt,
		message: "prompt or messages must be defined"
	});
	if (prompt != null && messages != null) throw new InvalidPromptError({
		prompt,
		message: "prompt and messages cannot be defined at the same time"
	});
	if (typeof instructions !== "string" && !asArray(instructions).every((message) => message.role === "system")) throw new InvalidPromptError({
		prompt,
		message: "instructions must be a string, SystemModelMessage, or array of SystemModelMessage"
	});
	if (prompt != null && typeof prompt === "string") messages = [{
		role: "user",
		content: prompt
	}];
	else if (prompt != null && Array.isArray(prompt)) messages = prompt;
	else if (messages == null) throw new InvalidPromptError({
		prompt,
		message: "prompt or messages must be defined"
	});
	if (messages.length === 0) throw new InvalidPromptError({
		prompt,
		message: "messages must not be empty"
	});
	if (!allowSystemInMessages && messages.some((message) => message.role === "system")) throw new InvalidPromptError({
		prompt,
		message: "System messages are not allowed in the prompt or messages fields. Use the instructions option instead."
	});
	const validationResult = await safeValidateTypes({
		value: messages,
		schema: z.array(modelMessageSchema)
	});
	if (!validationResult.success) throw new InvalidPromptError({
		prompt,
		message: "The messages do not match the ModelMessage[] schema.",
		cause: validationResult.error
	});
	return {
		messages,
		instructions
	};
}
function wrapGatewayError(error) {
	if (!GatewayAuthenticationError.isInstance(error)) return error;
	const isProductionEnv = process?.env.NODE_ENV === "production";
	const moreInfoURL = "https://ai-sdk.dev/unauthenticated-ai-gateway";
	if (isProductionEnv) return new AISDKError({
		name: "GatewayError",
		message: `Unauthenticated. Configure AI_GATEWAY_API_KEY or use a provider module. Learn more: ${moreInfoURL}`
	});
	return Object.assign(/* @__PURE__ */ new Error(`\u001b[1m\u001b[31mUnauthenticated request to AI Gateway.\u001b[0m

To authenticate, set the \u001b[33mAI_GATEWAY_API_KEY\u001b[0m environment variable with your API key.

Alternatively, you can use a provider module instead of the AI Gateway.

Learn more: \u001b[34m${moreInfoURL}\u001b[0m

`), { name: "GatewayAuthenticationError" });
}
function asLanguageModelUsage(usage) {
	return {
		inputTokens: usage.inputTokens.total,
		inputTokenDetails: {
			noCacheTokens: usage.inputTokens.noCache,
			cacheReadTokens: usage.inputTokens.cacheRead,
			cacheWriteTokens: usage.inputTokens.cacheWrite
		},
		outputTokens: usage.outputTokens.total,
		outputTokenDetails: {
			textTokens: usage.outputTokens.text,
			reasoningTokens: usage.outputTokens.reasoning
		},
		totalTokens: addTokenCounts(usage.inputTokens.total, usage.outputTokens.total),
		raw: usage.raw
	};
}
function createNullLanguageModelUsage() {
	return {
		inputTokens: void 0,
		inputTokenDetails: {
			noCacheTokens: void 0,
			cacheReadTokens: void 0,
			cacheWriteTokens: void 0
		},
		outputTokens: void 0,
		outputTokenDetails: {
			textTokens: void 0,
			reasoningTokens: void 0
		},
		totalTokens: void 0,
		raw: void 0
	};
}
function addLanguageModelUsage(usage1, usage2) {
	const raw = isNullLanguageModelUsage(usage1) ? usage2.raw : isNullLanguageModelUsage(usage2) ? usage1.raw : void 0;
	return {
		inputTokens: addTokenCounts(usage1.inputTokens, usage2.inputTokens),
		inputTokenDetails: {
			noCacheTokens: addTokenCounts(usage1.inputTokenDetails?.noCacheTokens, usage2.inputTokenDetails?.noCacheTokens),
			cacheReadTokens: addTokenCounts(usage1.inputTokenDetails?.cacheReadTokens, usage2.inputTokenDetails?.cacheReadTokens),
			cacheWriteTokens: addTokenCounts(usage1.inputTokenDetails?.cacheWriteTokens, usage2.inputTokenDetails?.cacheWriteTokens)
		},
		outputTokens: addTokenCounts(usage1.outputTokens, usage2.outputTokens),
		outputTokenDetails: {
			textTokens: addTokenCounts(usage1.outputTokenDetails?.textTokens, usage2.outputTokenDetails?.textTokens),
			reasoningTokens: addTokenCounts(usage1.outputTokenDetails?.reasoningTokens, usage2.outputTokenDetails?.reasoningTokens)
		},
		totalTokens: addTokenCounts(usage1.totalTokens, usage2.totalTokens),
		...raw == null ? {} : { raw }
	};
}
function isNullLanguageModelUsage(usage) {
	return usage.inputTokens == null && usage.inputTokenDetails?.noCacheTokens == null && usage.inputTokenDetails?.cacheReadTokens == null && usage.inputTokenDetails?.cacheWriteTokens == null && usage.outputTokens == null && usage.outputTokenDetails?.textTokens == null && usage.outputTokenDetails?.reasoningTokens == null && usage.totalTokens == null && usage.raw == null;
}
function addTokenCounts(tokenCount1, tokenCount2) {
	return tokenCount1 == null && tokenCount2 == null ? void 0 : (tokenCount1 ?? 0) + (tokenCount2 ?? 0);
}
/**
* Reads a property by an untrusted key, ignoring inherited prototype members.
*
* Tool sets, tool contexts, and similar lookup objects are indexed by names
* that can come from model output or client-supplied message history. Plain
* bracket access (`obj[name]`) resolves names such as `constructor`,
* `toString`, or `__proto__` to values on `Object.prototype`, which would slip
* past the `== null` / `!value` guards that treat an unknown name as "not
* present". This helper returns `undefined` unless `key` is an own property.
*/
function getOwn(obj, key) {
	return obj != null && Object.hasOwn(obj, key) ? obj[key] : void 0;
}
/**
* Merges multiple abort sources into a single `AbortSignal`.
* The returned signal will abort when any input signal aborts or when any
* numeric timeout elapses, using the reason from the first source to abort.
*
* @param signals - Abort signals or timeout durations in milliseconds.
* `null` and `undefined` values are ignored.
* @returns An `AbortSignal` that aborts when any valid source aborts,
* or `undefined` if no valid sources are provided.
*/
function mergeAbortSignals(...signals) {
	const validSignals = filterNullable(...signals).map((signal) => typeof signal === "number" ? AbortSignal.timeout(signal) : signal);
	return validSignals.length === 0 ? void 0 : validSignals.length === 1 ? validSignals[0] : AbortSignal.any(validSignals);
}
function now() {
	return globalThis?.performance?.now() ?? Date.now();
}
/**
* Notifies all provided callbacks with the given event in parallel.
* Errors in callbacks do not break the generation flow.
*/
async function notify(options) {
	await Promise.all(asArray(options.callbacks).map(async (callback) => {
		try {
			await callback?.(options.event);
		} catch {}
	}));
}
function getRetryDelayInMs({ error, exponentialBackoffDelay }) {
	const headers = APICallError.isInstance(error) ? error.responseHeaders : APICallError.isInstance(error.cause) ? error.cause.responseHeaders : void 0;
	if (!headers) return exponentialBackoffDelay;
	let ms;
	const retryAfterMs = headers["retry-after-ms"];
	if (retryAfterMs) {
		const timeoutMs = parseFloat(retryAfterMs);
		if (!Number.isNaN(timeoutMs)) ms = timeoutMs;
	}
	const retryAfter = headers["retry-after"];
	if (retryAfter && ms === void 0) {
		const timeoutSeconds = parseFloat(retryAfter);
		if (!Number.isNaN(timeoutSeconds)) ms = timeoutSeconds * 1e3;
		else ms = Date.parse(retryAfter) - Date.now();
	}
	if (ms != null && !Number.isNaN(ms) && 0 <= ms && (ms < 6e4 || ms < exponentialBackoffDelay)) return ms;
	return exponentialBackoffDelay;
}
/**
* The `retryWithExponentialBackoffRespectingRetryHeaders` strategy retries a failed API call with an exponential backoff,
* while respecting rate limit headers (retry-after-ms and retry-after) if they are provided and reasonable (0-60 seconds).
* You can configure the maximum number of retries, the initial delay, and the backoff factor.
*/
const retryWithExponentialBackoffRespectingRetryHeaders = ({ maxRetries = 2, initialDelayInMs = 2e3, backoffFactor = 2, abortSignal, additionalRetryableError } = {}) => retryWithExponentialBackoff({
	maxRetries,
	initialDelayInMs,
	backoffFactor,
	abortSignal,
	shouldRetry: async (error) => error instanceof Error && (APICallError.isInstance(error) && error.isRetryable === true || GatewayError.isInstance(error) && error.isRetryable === true) || additionalRetryableError != null && await additionalRetryableError(error),
	getDelayInMs: ({ error, exponentialBackoffDelay }) => getRetryDelayInMs({
		error,
		exponentialBackoffDelay
	}),
	createRetryError: ({ message, reason, errors }) => new RetryError({
		message,
		reason,
		errors
	})
});
/**
* Validate and prepare retries.
*/
function prepareRetries({ maxRetries, abortSignal, additionalRetryableError, parameter = "maxRetries", defaultMaxRetries = 2 }) {
	if (maxRetries != null) {
		if (!Number.isInteger(maxRetries)) throw new InvalidArgumentError({
			parameter,
			value: maxRetries,
			message: `${parameter} must be an integer`
		});
		if (maxRetries < 0) throw new InvalidArgumentError({
			parameter,
			value: maxRetries,
			message: `${parameter} must be >= 0`
		});
	}
	const maxRetriesResult = maxRetries ?? defaultMaxRetries;
	return {
		maxRetries: maxRetriesResult,
		retry: retryWithExponentialBackoffRespectingRetryHeaders({
			maxRetries: maxRetriesResult,
			abortSignal,
			additionalRetryableError
		})
	};
}
/**
* Schedules a timeout that aborts the given controller with a `TimeoutError`
* `DOMException`, matching the reason produced by `AbortSignal.timeout(ms)`.
*
* @param abortController - The controller to abort when the timeout elapses.
* If undefined, no timeout is scheduled.
* @param label - Human-readable label included in the error message
* (e.g. "Step", "Chunk").
* @param timeoutMs - Duration in milliseconds before the controller is aborted.
* If undefined, no timeout is scheduled.
* @returns The timeout id (suitable for passing to `clearTimeout`), or
* `undefined` if no timeout was scheduled.
*/
function setAbortTimeout({ abortController, label, timeoutMs }) {
	if (abortController == null || timeoutMs == null) return;
	return setTimeout(() => abortController.abort(new DOMException(`${label} timeout of ${timeoutMs}ms exceeded`, "TimeoutError")), timeoutMs);
}
/**
* Calculates a token rate in tokens per second.
*
* Returns 0 when the token count is unknown, the duration is unknown or 0, or
* the computed rate cannot be represented as a finite JSON-safe number.
*/
function calculateTokensPerSecond({ tokens, durationMs }) {
	const tokenRate = 1e3 * (tokens ?? 0) / (durationMs ?? 0);
	return Number.isFinite(tokenRate) ? tokenRate : 0;
}
/**
* If the last message is a tool message, this function collects all tool approvals
* from that message.
*/
function collectToolApprovals({ messages }) {
	const lastMessage = messages.at(-1);
	if (lastMessage?.role != "tool") return {
		approvedToolApprovals: [],
		deniedToolApprovals: []
	};
	const toolCallsByToolCallId = Object.create(null);
	const toolCallOrder = Object.create(null);
	let nextToolCallIndex = 0;
	for (const message of messages) if (message.role === "assistant" && typeof message.content !== "string") {
		const content = message.content;
		for (const part of content) if (part.type === "tool-call") {
			toolCallsByToolCallId[part.toolCallId] = part;
			toolCallOrder[part.toolCallId] = nextToolCallIndex++;
		}
	}
	const toolApprovalRequestsByApprovalId = Object.create(null);
	for (const message of messages) if (message.role === "assistant" && typeof message.content !== "string") {
		const content = message.content;
		for (const part of content) if (part.type === "tool-approval-request") toolApprovalRequestsByApprovalId[part.approvalId] = part;
	}
	const toolResults = Object.create(null);
	for (const part of lastMessage.content) if (part.type === "tool-result") toolResults[part.toolCallId] = part;
	const approvedToolApprovals = [];
	const deniedToolApprovals = [];
	const approvalResponses = lastMessage.content.filter((part) => part.type === "tool-approval-response");
	for (const approvalResponse of approvalResponses) {
		const approvalRequest = toolApprovalRequestsByApprovalId[approvalResponse.approvalId];
		if (approvalRequest == null) throw new InvalidToolApprovalError({ approvalId: approvalResponse.approvalId });
		const existingToolResult = toolResults[approvalRequest.toolCallId];
		if (existingToolResult != null && (approvalResponse.approved || existingToolResult.output.type !== "execution-denied")) continue;
		const toolCall = toolCallsByToolCallId[approvalRequest.toolCallId];
		if (toolCall == null) throw new ToolCallNotFoundForApprovalError({
			toolCallId: approvalRequest.toolCallId,
			approvalId: approvalRequest.approvalId
		});
		const approval = {
			approvalRequest,
			approvalResponse,
			toolCall,
			...existingToolResult != null ? { existingToolResult } : {}
		};
		if (approvalResponse.approved) approvedToolApprovals.push(approval);
		else deniedToolApprovals.push(approval);
	}
	approvedToolApprovals.sort((a, b) => toolCallOrder[a.toolCall.toolCallId] - toolCallOrder[b.toolCall.toolCallId]);
	return {
		approvedToolApprovals,
		deniedToolApprovals
	};
}
var DefaultGeneratedFile = class {
	constructor({ data, mediaType, providerMetadata }) {
		const isUint8Array = data instanceof Uint8Array;
		this.base64Data = isUint8Array ? void 0 : data;
		this.uint8ArrayData = isUint8Array ? data : void 0;
		this.mediaType = mediaType;
		this.providerMetadata = providerMetadata;
	}
	get base64() {
		if (this.base64Data == null) this.base64Data = convertUint8ArrayToBase64(this.uint8ArrayData);
		return this.base64Data;
	}
	get uint8Array() {
		if (this.uint8ArrayData == null) this.uint8ArrayData = convertBase64ToUint8Array(this.base64Data);
		return this.uint8ArrayData;
	}
};
var DefaultGeneratedFileWithType = class extends DefaultGeneratedFile {
	constructor(..._args) {
		super(..._args);
		this.type = "file";
	}
};
async function resolveGeneratedFileData({ data, abortSignal, cache }) {
	if (data.type === "data") return data.data;
	const cachedData = cache?.get(data);
	if (cachedData != null) return cachedData;
	const downloadedData = (await download({
		url: data.url,
		abortSignal
	})).data;
	cache?.set(data, downloadedData);
	return downloadedData;
}
async function convertLanguageModelContent({ content, toolCalls, toolOutputs, toolApprovalRequests, toolApprovalResponses, tools, abortSignal, generatedFileDataCache }) {
	const contentParts = [];
	const toolOutputsWithApprovalResponses = [];
	const toolOutputsWithoutApprovalResponses = [];
	const toolCallIdsWithApprovalResponses = new Set(toolApprovalResponses.map((toolApprovalResponse) => toolApprovalResponse.toolCall.toolCallId));
	for (const part of content) switch (part.type) {
		case "text":
		case "reasoning":
		case "custom":
		case "source":
			contentParts.push(part);
			break;
		case "file":
		case "reasoning-file":
			contentParts.push({
				type: part.type,
				file: new DefaultGeneratedFile({
					data: await resolveGeneratedFileData({
						data: part.data,
						abortSignal,
						cache: generatedFileDataCache
					}),
					mediaType: part.mediaType
				}),
				...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {}
			});
			break;
		case "tool-call": {
			const toolCall = toolCalls.find((toolCall) => toolCall.toolCallId === part.toolCallId);
			if (toolCall == null) throw new Error(`Tool call ${part.toolCallId} not found.`);
			contentParts.push(toolCall);
			break;
		}
		case "tool-result": {
			const toolCall = toolCalls.find((toolCall) => toolCall.toolCallId === part.toolCallId);
			if (toolCall == null) {
				const tool = getOwn(tools, part.toolName);
				if (!(tool?.type === "provider" && tool.supportsDeferredResults)) throw new Error(`Tool call ${part.toolCallId} not found.`);
				if (part.isError) contentParts.push({
					type: "tool-error",
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					input: void 0,
					error: part.result,
					providerExecuted: true,
					dynamic: part.dynamic,
					...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {},
					...tool?.metadata != null ? { toolMetadata: tool.metadata } : {}
				});
				else contentParts.push({
					type: "tool-result",
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					input: void 0,
					output: part.result,
					providerExecuted: true,
					dynamic: part.dynamic,
					...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {},
					...tool?.metadata != null ? { toolMetadata: tool.metadata } : {}
				});
				break;
			}
			if (part.isError) contentParts.push({
				type: "tool-error",
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				input: toolCall.input,
				error: part.result,
				providerExecuted: true,
				dynamic: toolCall.dynamic,
				...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {},
				...toolCall.toolMetadata != null ? { toolMetadata: toolCall.toolMetadata } : {}
			});
			else contentParts.push({
				type: "tool-result",
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				input: toolCall.input,
				output: part.result,
				providerExecuted: true,
				dynamic: toolCall.dynamic,
				...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {},
				...toolCall.toolMetadata != null ? { toolMetadata: toolCall.toolMetadata } : {}
			});
			break;
		}
		case "tool-approval-request": {
			const toolCall = toolCalls.find((toolCall) => toolCall.toolCallId === part.toolCallId);
			if (toolCall == null) throw new ToolCallNotFoundForApprovalError({
				toolCallId: part.toolCallId,
				approvalId: part.approvalId
			});
			contentParts.push({
				type: "tool-approval-request",
				approvalId: part.approvalId,
				toolCall
			});
			break;
		}
	}
	for (const toolOutput of toolOutputs) if (toolCallIdsWithApprovalResponses.has(toolOutput.toolCallId)) toolOutputsWithApprovalResponses.push(toolOutput);
	else toolOutputsWithoutApprovalResponses.push(toolOutput);
	return [
		...contentParts,
		...toolOutputsWithoutApprovalResponses,
		...toolApprovalRequests,
		...toolApprovalResponses,
		...toolOutputsWithApprovalResponses
	];
}
function resolveToolCallerConfiguration({ tools, toolCallers }) {
	if (tools == null || toolCallers == null) return;
	const resolved = {};
	for (const [toolName, callers] of Object.entries(toolCallers)) {
		if (!Object.prototype.hasOwnProperty.call(tools, toolName)) throw new InvalidArgumentError({
			parameter: "experimental_toolCallers",
			value: toolCallers,
			message: `unknown tool "${toolName}".`
		});
		if (!Array.isArray(callers)) throw new InvalidArgumentError({
			parameter: "experimental_toolCallers",
			value: toolCallers,
			message: `callers for tool "${toolName}" must be an array.`
		});
		resolved[toolName] = callers.map((caller) => {
			if (caller === "AI_SDK_DIRECT_TOOL_CALL") return caller;
			if (typeof caller !== "string" || !Object.prototype.hasOwnProperty.call(tools, caller) || getToolCaller(tools[caller]) == null) throw new InvalidArgumentError({
				parameter: "experimental_toolCallers",
				value: toolCallers,
				message: `tool "${toolName}" contains an invalid caller.`
			});
			return caller;
		});
	}
	return resolved;
}
function prepareToolsForToolCallers({ tools, toolCallers }) {
	if (tools == null || toolCallers == null) return {
		executionTools: tools,
		modelTools: tools,
		toolCallerMessages: []
	};
	const executionTools = { ...tools };
	const modelTools = { ...tools };
	const localToolsByCaller = /* @__PURE__ */ new Map();
	const toolCallerMessages = [];
	for (const [toolName, callerNames] of Object.entries(toolCallers)) {
		const tool = executionTools[toolName];
		if (tool == null) continue;
		let availableDirectly = false;
		let availableToProvider = false;
		let preparedTool = tool;
		for (const callerName of callerNames) {
			if (callerName === "AI_SDK_DIRECT_TOOL_CALL") {
				availableDirectly = true;
				continue;
			}
			const caller = getToolCaller(executionTools[callerName]);
			if (caller == null) continue;
			if (caller.type === "provider") {
				availableToProvider = true;
				preparedTool = {
					...preparedTool,
					providerOptions: caller.prepareProviderOptions(preparedTool.providerOptions)
				};
			} else {
				const localTools = localToolsByCaller.get(callerName) ?? {};
				localTools[toolName] = preparedTool;
				localToolsByCaller.set(callerName, localTools);
			}
		}
		executionTools[toolName] = preparedTool;
		if (availableDirectly || availableToProvider) modelTools[toolName] = preparedTool;
		else delete modelTools[toolName];
	}
	for (const [callerName, callerTool] of Object.entries(executionTools)) {
		const caller = getToolCaller(callerTool);
		if (caller?.type !== "local") continue;
		const callerTools = localToolsByCaller.get(callerName) ?? {};
		const boundCaller = caller.bind(callerTools);
		executionTools[callerName] = boundCaller;
		if (Object.prototype.hasOwnProperty.call(modelTools, callerName)) {
			if (caller.prepareModelMessage == null) modelTools[callerName] = boundCaller;
			else {
				const content = caller.prepareModelMessage(callerTools);
				if (content != null) toolCallerMessages.push({
					role: "user",
					content
				});
			}
		}
	}
	return {
		executionTools,
		modelTools,
		toolCallerMessages
	};
}
function appendToolCallerMessages({ messages, toolCallerMessages }) {
	if (toolCallerMessages.length === 0) return messages;
	const latestUserText = messages.findLast((message) => message.role === "user" && typeof message.content === "string")?.content;
	const existingUserText = new Set(latestUserText == null ? [] : [latestUserText]);
	const additions = toolCallerMessages.filter((message) => {
		if (typeof message.content !== "string" || existingUserText.has(message.content)) return false;
		existingUserText.add(message.content);
		return true;
	});
	return additions.length === 0 ? messages : [...messages, ...additions];
}
const toolSearchSymbol = Symbol.for("vercel.ai.toolSearch");
const toolSearchFunctionSymbol = Symbol.for("vercel.ai.toolSearch.search");
const toolSearchMaxResultsSymbol = Symbol.for("vercel.ai.toolSearch.maxResults");
function getToolSearchMaxResults(tool) {
	return tool[toolSearchMaxResultsSymbol] ?? 5;
}
function getToolSearchFunction(tool) {
	return tool[toolSearchFunctionSymbol];
}
function isToolSearch(tool) {
	return tool[toolSearchSymbol] === true;
}
/** Create discovery state for one generation, never for a shared tool instance. */
function createToolSearchState({ tools, toolCallers }) {
	const searchTools = Object.entries(tools ?? {}).filter(([, tool]) => tool.deferLoading || isToolSearch(tool));
	if (searchTools.length === 0) return (activeTools) => activeTools;
	const discovered = /* @__PURE__ */ new Set();
	const getCallers = (name) => getOwn(toolCallers, name) ?? ["AI_SDK_DIRECT_TOOL_CALL"];
	for (const [name, tool] of searchTools) if (getCallers(name).some((name) => {
		if (name === "AI_SDK_DIRECT_TOOL_CALL") return false;
		const caller = getToolCaller(tools?.[name]);
		return caller?.type !== "local" || caller.prepareModelMessage == null;
	}) || isToolSearch(tool) && tool.deferLoading) throw new InvalidArgumentError({
		parameter: "tools",
		value: name,
		message: `tool "${name}" must be callable directly or through code mode with toolDiscovery: 'conversation'. The search tool itself must not defer loading.`
	});
	return (activeTools, { toolsContext = {}, experimental_sandbox } = {}) => {
		if (activeTools == null) return;
		const entries = Object.entries(activeTools);
		return Object.fromEntries(entries.filter(([name, tool]) => !tool.deferLoading || discovered.has(name)).map(([searchName, tool]) => {
			if (!isToolSearch(tool)) return [searchName, tool];
			const callers = getCallers(searchName).filter((name) => name === "AI_SDK_DIRECT_TOOL_CALL" || Object.hasOwn(activeTools, name));
			const candidates = entries.filter(([name, candidate]) => candidate.deferLoading && !isToolSearch(candidate) && callers.some((caller) => getCallers(name).includes(caller)));
			return [searchName, {
				...tool,
				execute: async ({ query }) => {
					const availableTools = candidates.map(([name, candidate]) => {
						const description = resolveToolDescription({
							tool: candidate,
							toolName: name,
							toolsContext,
							experimental_sandbox
						});
						return {
							name,
							...description == null ? {} : { description }
						};
					});
					const toolsByName = new Map(availableTools.map((tool) => [tool.name, tool]));
					const customSearch = getToolSearchFunction(tool);
					const terms = [...new Set(tokenize(query))];
					const rankedNames = customSearch ? await customSearch({
						query,
						tools: availableTools.map((tool) => ({ ...tool }))
					}) : availableTools.map(({ name, description }) => {
						const nameTerms = tokenize(name);
						const descriptionTerms = tokenize(description ?? "");
						return {
							name,
							score: terms.reduce((score, term) => score + (nameTerms.includes(term) ? 2 : 0) + (descriptionTerms.includes(term) ? 1 : 0), 0)
						};
					}).filter((match) => match.score > 0).sort((a, b) => b.score - a.score).map((match) => match.name);
					const matches = [...new Set(rankedNames)].flatMap((name) => {
						const match = toolsByName.get(name);
						return match == null ? [] : [match];
					}).slice(0, getToolSearchMaxResults(tool));
					for (const { name } of matches) discovered.add(name);
					return { tools: matches };
				}
			}];
		}));
	};
}
function tokenize(text) {
	return text.replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
/**
* Validates a tool context value against the tool's optional context schema.
*
* When no context schema is defined, the original context value is returned as-is.
* Otherwise, the context is validated and normalized through the schema before
* being passed into tool execution and approval hooks.
*
* @throws {TypeValidationError} When the provided tool context does not match
* the tool's declared `contextSchema`.
*/
async function validateToolContext({ toolName, context, contextSchema }) {
	if (contextSchema == null) return context;
	return await validateTypes({
		value: context,
		schema: contextSchema,
		context: {
			field: "tool context",
			entityName: toolName
		}
	});
}
/**
* Executes a single tool call and manages its lifecycle callbacks.
*
* This function handles the complete tool execution flow:
* 1. Invokes `onToolExecutionStart` callback before execution
* 2. Executes the tool's `execute` function with proper context
* 3. Handles streaming outputs via `onPreliminaryToolResult`
* 4. Invokes `onToolExecutionEnd` callback with success or error result
*
* @returns The tool output with performance metrics, or undefined if the tool has no execute function.
*/
async function executeToolCall({ toolCall, tools, toolsContext, callId, messages, abortSignal, timeout, experimental_sandbox: sandbox, onPreliminaryToolResult, onToolExecutionStart, onToolExecutionEnd, executeToolInTelemetryContext = async ({ execute }) => await execute(), runInTracingChannelSpan = async ({ execute }) => await execute() }) {
	const { toolName, toolCallId, input } = toolCall;
	const tool = getOwn(tools, toolName);
	if (!isExecutableTool(tool)) return;
	const context = await validateToolContext({
		toolName,
		context: getOwn(toolsContext, toolName),
		contextSchema: tool.contextSchema
	});
	const toolExecutionContext = {
		toolCall,
		messages,
		toolContext: context
	};
	const baseCallbackEvent = {
		callId,
		...toolExecutionContext
	};
	return await runInTracingChannelSpan({
		type: "executeTool",
		event: baseCallbackEvent,
		execute: async () => {
			let output;
			await notify({
				event: baseCallbackEvent,
				callbacks: onToolExecutionStart
			});
			const toolAbortSignal = mergeAbortSignals(abortSignal, getToolTimeoutMs(timeout, toolName));
			let toolExecutionMs = 0;
			try {
				await executeToolInTelemetryContext({
					callId,
					toolCallId,
					...toolExecutionContext,
					execute: async () => {
						const startTime = now();
						try {
							const stream = executeTool({
								tool,
								input,
								options: {
									toolCallId,
									messages,
									abortSignal: toolAbortSignal,
									context,
									experimental_sandbox: sandbox
								}
							});
							for await (const part of stream) if (part.type === "preliminary") onPreliminaryToolResult?.({
								...toolCall,
								type: "tool-result",
								output: part.output,
								preliminary: true
							});
							else output = part.output;
						} finally {
							toolExecutionMs = now() - startTime;
						}
					}
				});
			} catch (error) {
				const toolError = {
					type: "tool-error",
					toolCallId,
					toolName,
					input,
					error,
					dynamic: tool.type === "dynamic",
					...toolCall.providerMetadata != null ? { providerMetadata: toolCall.providerMetadata } : {},
					...toolCall.toolMetadata != null ? { toolMetadata: toolCall.toolMetadata } : {}
				};
				await notify({
					event: {
						...baseCallbackEvent,
						toolOutput: toolError,
						toolExecutionMs
					},
					callbacks: onToolExecutionEnd
				});
				return {
					output: toolError,
					toolExecutionMs
				};
			}
			const toolResult = {
				type: "tool-result",
				toolCallId,
				toolName,
				input,
				output,
				dynamic: tool.type === "dynamic",
				...toolCall.providerMetadata != null ? { providerMetadata: toolCall.providerMetadata } : {},
				...toolCall.toolMetadata != null ? { toolMetadata: toolCall.toolMetadata } : {}
			};
			await notify({
				event: {
					...baseCallbackEvent,
					toolOutput: toolResult,
					toolExecutionMs
				},
				callbacks: onToolExecutionEnd
			});
			return {
				output: toolResult,
				toolExecutionMs
			};
		}
	});
}
/**
* Filters the tools to only include the active tools.
* When activeTools is provided, we only include the tools that are in the list.
*
* @param tools - The tools to filter.
* @param activeTools - The active tools to include.
* @returns The filtered tools.
*/
function filterActiveTools({ tools, activeTools }) {
	if (tools == null || activeTools == null) return tools;
	return Object.fromEntries(Object.entries(tools).filter(([name]) => activeTools.includes(name)));
}
function unwrapReasoningFileData(data) {
	if (typeof data === "object" && data !== null && "type" in data) return data.type === "data" ? data.data : data.url;
	return data;
}
function convertFromReasoningOutputs(parts) {
	return parts.map((part) => {
		if (part.type === "reasoning") return {
			type: "reasoning",
			text: part.text,
			...part.providerMetadata != null ? { providerOptions: part.providerMetadata } : {}
		};
		return {
			type: "reasoning-file",
			data: part.file.base64,
			mediaType: part.file.mediaType,
			...part.providerMetadata != null ? { providerOptions: part.providerMetadata } : {}
		};
	});
}
function convertToReasoningOutputs(parts) {
	return parts.map((part) => {
		if (part.type === "reasoning") return {
			type: "reasoning",
			text: part.text,
			...part.providerOptions != null ? { providerMetadata: part.providerOptions } : {}
		};
		const rawData = unwrapReasoningFileData(part.data);
		return {
			type: "reasoning-file",
			file: new DefaultGeneratedFile({
				data: rawData instanceof ArrayBuffer ? new Uint8Array(rawData) : rawData instanceof URL ? rawData.toString() : rawData,
				mediaType: part.mediaType
			}),
			...part.providerOptions != null ? { providerMetadata: part.providerOptions } : {}
		};
	});
}
var DefaultGenerateTextResult = class {
	constructor(options) {
		this.initialResponseMessages = options.initialResponseMessages;
		this.steps = options.steps;
		this._output = options.output;
		this.totalUsage = options.totalUsage;
	}
	get finalStep() {
		return this.steps.at(-1);
	}
	get content() {
		return this.steps.flatMap((step) => step.content);
	}
	get text() {
		return this.finalStep.text;
	}
	get files() {
		return this.steps.flatMap((step) => step.files);
	}
	get reasoningText() {
		return this.finalStep.reasoningText;
	}
	get reasoning() {
		return convertToReasoningOutputs(this.finalStep.reasoning);
	}
	get toolCalls() {
		return this.steps.flatMap((step) => step.toolCalls);
	}
	get staticToolCalls() {
		return this.steps.flatMap((step) => step.staticToolCalls);
	}
	get dynamicToolCalls() {
		return this.steps.flatMap((step) => step.dynamicToolCalls);
	}
	get toolResults() {
		return this.steps.flatMap((step) => step.toolResults);
	}
	get staticToolResults() {
		return this.steps.flatMap((step) => step.staticToolResults);
	}
	get dynamicToolResults() {
		return this.steps.flatMap((step) => step.dynamicToolResults);
	}
	get sources() {
		return this.steps.flatMap((step) => step.sources);
	}
	get finishReason() {
		return this.finalStep.finishReason;
	}
	get rawFinishReason() {
		return this.finalStep.rawFinishReason;
	}
	get warnings() {
		return this.steps.flatMap((step) => step.warnings ?? []);
	}
	get providerMetadata() {
		return this.finalStep.providerMetadata;
	}
	get response() {
		return this.finalStep.response;
	}
	get responseMessages() {
		return [...this.initialResponseMessages, ...this.steps.flatMap((step) => step.response.messages)];
	}
	get request() {
		return this.finalStep.request;
	}
	get usage() {
		return this.totalUsage;
	}
	get output() {
		if (this._output == null) throw new NoOutputGeneratedError();
		return this._output;
	}
};
function isToolExecutionAllowedFinishReason(finishReason) {
	return finishReason === "stop" || finishReason === "tool-calls";
}
function fixJson(input) {
	const stack = ["ROOT"];
	let lastValidIndex = -1;
	let literalStart = null;
	let unicodeEscapeDigits = 0;
	function isHexDigit(char) {
		return char >= "0" && char <= "9" || char >= "A" && char <= "F" || char >= "a" && char <= "f";
	}
	function processValueStart(char, i, swapState) {
		switch (char) {
			case "\"":
				lastValidIndex = i;
				stack.pop();
				stack.push(swapState);
				stack.push("INSIDE_STRING");
				break;
			case "f":
			case "t":
			case "n":
				lastValidIndex = i;
				literalStart = i;
				stack.pop();
				stack.push(swapState);
				stack.push("INSIDE_LITERAL");
				break;
			case "-":
				stack.pop();
				stack.push(swapState);
				stack.push("INSIDE_NUMBER");
				break;
			case "0":
			case "1":
			case "2":
			case "3":
			case "4":
			case "5":
			case "6":
			case "7":
			case "8":
			case "9":
				lastValidIndex = i;
				stack.pop();
				stack.push(swapState);
				stack.push("INSIDE_NUMBER");
				break;
			case "{":
				lastValidIndex = i;
				stack.pop();
				stack.push(swapState);
				stack.push("INSIDE_OBJECT_START");
				break;
			case "[":
				lastValidIndex = i;
				stack.pop();
				stack.push(swapState);
				stack.push("INSIDE_ARRAY_START");
		}
	}
	function processAfterObjectValue(char, i) {
		switch (char) {
			case ",":
				stack.pop();
				stack.push("INSIDE_OBJECT_AFTER_COMMA");
				break;
			case "}":
				lastValidIndex = i;
				stack.pop();
		}
	}
	function processAfterArrayValue(char, i) {
		switch (char) {
			case ",":
				stack.pop();
				stack.push("INSIDE_ARRAY_AFTER_COMMA");
				break;
			case "]":
				lastValidIndex = i;
				stack.pop();
		}
	}
	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		switch (stack[stack.length - 1]) {
			case "ROOT":
				processValueStart(char, i, "FINISH");
				break;
			case "INSIDE_OBJECT_START":
				switch (char) {
					case "\"":
						stack.pop();
						stack.push("INSIDE_OBJECT_KEY");
						break;
					case "}":
						lastValidIndex = i;
						stack.pop();
				}
				break;
			case "INSIDE_OBJECT_AFTER_COMMA":
				switch (char) {
					case "\"":
						stack.pop();
						stack.push("INSIDE_OBJECT_KEY");
				}
				break;
			case "INSIDE_OBJECT_KEY":
				switch (char) {
					case "\"":
						stack.pop();
						stack.push("INSIDE_OBJECT_AFTER_KEY");
				}
				break;
			case "INSIDE_OBJECT_AFTER_KEY":
				switch (char) {
					case ":":
						stack.pop();
						stack.push("INSIDE_OBJECT_BEFORE_VALUE");
				}
				break;
			case "INSIDE_OBJECT_BEFORE_VALUE":
				processValueStart(char, i, "INSIDE_OBJECT_AFTER_VALUE");
				break;
			case "INSIDE_OBJECT_AFTER_VALUE":
				processAfterObjectValue(char, i);
				break;
			case "INSIDE_STRING":
				switch (char) {
					case "\"":
						stack.pop();
						lastValidIndex = i;
						break;
					case "\\":
						stack.push("INSIDE_STRING_ESCAPE");
						break;
					default: lastValidIndex = i;
				}
				break;
			case "INSIDE_ARRAY_START":
				switch (char) {
					case "]":
						lastValidIndex = i;
						stack.pop();
						break;
					default:
						lastValidIndex = i;
						processValueStart(char, i, "INSIDE_ARRAY_AFTER_VALUE");
				}
				break;
			case "INSIDE_ARRAY_AFTER_VALUE":
				switch (char) {
					case ",":
						stack.pop();
						stack.push("INSIDE_ARRAY_AFTER_COMMA");
						break;
					case "]":
						lastValidIndex = i;
						stack.pop();
						break;
					default: lastValidIndex = i;
				}
				break;
			case "INSIDE_ARRAY_AFTER_COMMA":
				processValueStart(char, i, "INSIDE_ARRAY_AFTER_VALUE");
				break;
			case "INSIDE_STRING_ESCAPE":
				stack.pop();
				if (char === "u") {
					unicodeEscapeDigits = 0;
					stack.push("INSIDE_STRING_UNICODE_ESCAPE");
				} else lastValidIndex = i;
				break;
			case "INSIDE_STRING_UNICODE_ESCAPE":
				if (isHexDigit(char)) {
					unicodeEscapeDigits++;
					if (unicodeEscapeDigits === 4) {
						stack.pop();
						lastValidIndex = i;
					}
				}
				break;
			case "INSIDE_NUMBER":
				switch (char) {
					case "0":
					case "1":
					case "2":
					case "3":
					case "4":
					case "5":
					case "6":
					case "7":
					case "8":
					case "9":
						lastValidIndex = i;
						break;
					case "e":
					case "E":
					case "-":
					case ".": break;
					case ",":
						stack.pop();
						if (stack[stack.length - 1] === "INSIDE_ARRAY_AFTER_VALUE") processAfterArrayValue(char, i);
						if (stack[stack.length - 1] === "INSIDE_OBJECT_AFTER_VALUE") processAfterObjectValue(char, i);
						break;
					case "}":
						stack.pop();
						if (stack[stack.length - 1] === "INSIDE_OBJECT_AFTER_VALUE") processAfterObjectValue(char, i);
						break;
					case "]":
						stack.pop();
						if (stack[stack.length - 1] === "INSIDE_ARRAY_AFTER_VALUE") processAfterArrayValue(char, i);
						break;
					default: stack.pop();
				}
				break;
			case "INSIDE_LITERAL": {
				const partialLiteral = input.substring(literalStart, i + 1);
				if (!"false".startsWith(partialLiteral) && !"true".startsWith(partialLiteral) && !"null".startsWith(partialLiteral)) {
					stack.pop();
					if (stack[stack.length - 1] === "INSIDE_OBJECT_AFTER_VALUE") processAfterObjectValue(char, i);
					else if (stack[stack.length - 1] === "INSIDE_ARRAY_AFTER_VALUE") processAfterArrayValue(char, i);
				} else lastValidIndex = i;
				break;
			}
		}
	}
	let result = input.slice(0, lastValidIndex + 1);
	for (let i = stack.length - 1; i >= 0; i--) switch (stack[i]) {
		case "INSIDE_STRING":
			result += "\"";
			break;
		case "INSIDE_OBJECT_KEY":
		case "INSIDE_OBJECT_AFTER_KEY":
		case "INSIDE_OBJECT_AFTER_COMMA":
		case "INSIDE_OBJECT_START":
		case "INSIDE_OBJECT_BEFORE_VALUE":
		case "INSIDE_OBJECT_AFTER_VALUE":
			result += "}";
			break;
		case "INSIDE_ARRAY_START":
		case "INSIDE_ARRAY_AFTER_COMMA":
		case "INSIDE_ARRAY_AFTER_VALUE":
			result += "]";
			break;
		case "INSIDE_LITERAL": {
			const partialLiteral = input.substring(literalStart, input.length);
			if ("true".startsWith(partialLiteral)) result += "true".slice(partialLiteral.length);
			else if ("false".startsWith(partialLiteral)) result += "false".slice(partialLiteral.length);
			else if ("null".startsWith(partialLiteral)) result += "null".slice(partialLiteral.length);
		}
	}
	return result;
}
async function parsePartialJson(jsonText) {
	if (jsonText === void 0) return {
		value: void 0,
		state: "undefined-input"
	};
	let result = await safeParseJSON({ text: jsonText });
	if (result.success) return {
		value: result.value,
		state: "successful-parse"
	};
	result = await safeParseJSON({ text: fixJson(jsonText) });
	if (result.success) return {
		value: result.value,
		state: "repaired-parse"
	};
	return {
		value: void 0,
		state: "failed-parse"
	};
}
/**
* Output specification for text generation.
* This is the default output mode that generates plain text.
*
* @returns An output specification for generating text.
*/
const text = () => ({
	name: "text",
	responseFormat: Promise.resolve({ type: "text" }),
	async parseCompleteOutput({ text }) {
		return text;
	},
	async parsePartialOutput({ text }) {
		return { partial: text };
	},
	createElementStreamTransform() {}
});
const inputSchemaInputSymbol = Symbol("ai-sdk-tool-call-input-schema-input");
function setToolCallInputSchemaInput(toolCall, inputSchemaInput) {
	Object.defineProperty(toolCall, inputSchemaInputSymbol, { value: inputSchemaInput });
	return toolCall;
}
function getToolCallInputSchemaInput(toolCall) {
	return inputSchemaInputSymbol in toolCall ? { value: toolCall[inputSchemaInputSymbol] } : void 0;
}
async function parseToolCall({ toolCall, tools, repairToolCall, refineToolInput, messages, instructions, abortSignal }) {
	try {
		if (tools == null) {
			if (toolCall.providerExecuted && toolCall.dynamic) return await refineParsedToolCallInput({
				toolCall: await parseProviderExecutedDynamicToolCall(toolCall),
				refineToolInput
			});
			throw new NoSuchToolError({ toolName: toolCall.toolName });
		}
		try {
			return await refineParsedToolCallInput({
				toolCall: await doParseToolCall({
					toolCall,
					tools
				}),
				refineToolInput
			});
		} catch (error) {
			if (repairToolCall == null || !(NoSuchToolError.isInstance(error) || InvalidToolInputError.isInstance(error))) throw error;
			let repairedToolCall = null;
			try {
				abortSignal?.throwIfAborted();
				repairedToolCall = await waitForPromiseWithAbortSignal({
					promise: repairToolCall({
						toolCall,
						tools,
						inputSchema: async ({ toolName }) => {
							const inputSchema = getOwn(tools, toolName)?.inputSchema;
							return await asSchema(inputSchema).jsonSchema;
						},
						instructions,
						system: instructions,
						messages,
						error,
						abortSignal
					}),
					abortSignal
				});
			} catch (repairError) {
				abortSignal?.throwIfAborted();
				throw new ToolCallRepairError({
					cause: repairError,
					originalError: error
				});
			}
			if (repairedToolCall == null) throw error;
			const parsedRepairedToolCall = await refineParsedToolCallInput({
				toolCall: await doParseToolCall({
					toolCall: repairedToolCall,
					tools
				}),
				refineToolInput
			});
			abortSignal?.throwIfAborted();
			return parsedRepairedToolCall;
		}
	} catch (error) {
		abortSignal?.throwIfAborted();
		const parsedInput = await safeParseJSON({ text: toolCall.input });
		const input = parsedInput.success ? parsedInput.value : toolCall.input;
		const tool = getOwn(tools, toolCall.toolName);
		return {
			type: "tool-call",
			toolCallId: toolCall.toolCallId,
			toolName: toolCall.toolName,
			input,
			dynamic: true,
			invalid: true,
			error,
			title: tool?.title,
			providerExecuted: toolCall.providerExecuted,
			providerMetadata: toolCall.providerMetadata,
			...tool?.metadata != null ? { toolMetadata: tool.metadata } : {}
		};
	}
}
async function waitForPromiseWithAbortSignal({ promise, abortSignal }) {
	if (abortSignal == null) return await promise;
	return await new Promise((resolve, reject) => {
		const cleanup = () => {
			abortSignal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(abortSignal.reason);
		};
		Promise.resolve(promise).then((value) => {
			cleanup();
			resolve(value);
		}).catch((error) => {
			cleanup();
			reject(error);
		});
		abortSignal.addEventListener("abort", onAbort, { once: true });
		if (abortSignal.aborted) onAbort();
	});
}
async function refineParsedToolCallInput({ toolCall, refineToolInput }) {
	const refine = getOwn(refineToolInput, toolCall.toolName);
	if (refine == null) return toolCall;
	const refinedToolCall = {
		...toolCall,
		input: await refine(toolCall.input)
	};
	const inputSchemaInput = getToolCallInputSchemaInput(toolCall);
	return inputSchemaInput == null ? refinedToolCall : setToolCallInputSchemaInput(refinedToolCall, inputSchemaInput.value);
}
async function parseProviderExecutedDynamicToolCall(toolCall) {
	const parseResult = toolCall.input.trim() === "" ? {
		success: true,
		value: {}
	} : await safeParseJSON({ text: toolCall.input });
	if (parseResult.success === false) throw new InvalidToolInputError({
		toolName: toolCall.toolName,
		toolInput: toolCall.input,
		cause: parseResult.error
	});
	return {
		type: "tool-call",
		toolCallId: toolCall.toolCallId,
		toolName: toolCall.toolName,
		input: parseResult.value,
		providerExecuted: true,
		dynamic: true,
		providerMetadata: toolCall.providerMetadata
	};
}
async function doParseToolCall({ toolCall, tools }) {
	const toolName = toolCall.toolName;
	const tool = getOwn(tools, toolName);
	if (tool == null) {
		if (toolCall.providerExecuted && toolCall.dynamic) return await parseProviderExecutedDynamicToolCall(toolCall);
		throw new NoSuchToolError({
			toolName: toolCall.toolName,
			availableTools: Object.keys(tools)
		});
	}
	const schema = asSchema(tool.inputSchema);
	const parseResult = toolCall.input.trim() === "" ? await safeValidateTypes({
		value: {},
		schema
	}) : await safeParseJSON({
		text: toolCall.input,
		schema
	});
	if (parseResult.success === false) throw new InvalidToolInputError({
		toolName,
		toolInput: toolCall.input,
		cause: parseResult.error
	});
	return setToolCallInputSchemaInput(tool.type === "dynamic" ? {
		type: "tool-call",
		toolCallId: toolCall.toolCallId,
		toolName: toolCall.toolName,
		input: parseResult.value,
		providerExecuted: toolCall.providerExecuted,
		providerMetadata: toolCall.providerMetadata,
		...tool.metadata != null ? { toolMetadata: tool.metadata } : {},
		dynamic: true,
		title: tool.title
	} : {
		type: "tool-call",
		toolCallId: toolCall.toolCallId,
		toolName,
		input: parseResult.value,
		providerExecuted: toolCall.providerExecuted,
		providerMetadata: toolCall.providerMetadata,
		...tool.metadata != null ? { toolMetadata: tool.metadata } : {},
		title: tool.title
	}, parseResult.rawValue);
}
/**
* Resolves model call settings for a single step.
*
* Undefined step settings intentionally fall back to the outer call settings,
* while defined falsy values such as `temperature: 0` and `seed: 0` are kept.
*/
function prepareStepCallSettings({ callSettings, stepSettings }) {
	return prepareLanguageModelCallOptions({
		maxOutputTokens: stepSettings?.maxOutputTokens ?? callSettings.maxOutputTokens,
		temperature: stepSettings?.temperature ?? callSettings.temperature,
		topP: stepSettings?.topP ?? callSettings.topP,
		topK: stepSettings?.topK ?? callSettings.topK,
		presencePenalty: stepSettings?.presencePenalty ?? callSettings.presencePenalty,
		frequencyPenalty: stepSettings?.frequencyPenalty ?? callSettings.frequencyPenalty,
		stopSequences: stepSettings?.stopSequences ?? callSettings.stopSequences,
		seed: stepSettings?.seed ?? callSettings.seed,
		reasoning: stepSettings?.reasoning ?? callSettings.reasoning
	});
}
/**
* Resolves the approval state for a tool call by checking user-supplied and tool-defined
* approval settings, and normalizes the result to the object status shape.
* User-defined approval settings take precedence over tool-defined settings.
* If no approval settings are provided, the tool call does not require approval.
*/
async function resolveToolApproval({ tools, toolCall, toolApproval, messages, toolsContext, runtimeContext }) {
	if (toolApproval != null && typeof toolApproval === "function") return normalizeToolApprovalStatus(await toolApproval({
		toolCall,
		tools,
		toolsContext,
		messages,
		runtimeContext
	}));
	const toolName = toolCall.toolName;
	const tool = getOwn(tools, toolName);
	const input = toolCall.input;
	const userDefinedToolApprovalStatus = getOwn(toolApproval, toolName);
	if (userDefinedToolApprovalStatus != null) return normalizeToolApprovalStatus(typeof userDefinedToolApprovalStatus === "function" ? await userDefinedToolApprovalStatus(input, {
		toolCallId: toolCall.toolCallId,
		messages,
		toolContext: await validateToolContext({
			toolName,
			context: getOwn(toolsContext, toolName),
			contextSchema: tool?.contextSchema
		}),
		runtimeContext
	}) : userDefinedToolApprovalStatus);
	if (tool?.needsApproval == null) return { type: "not-applicable" };
	return (typeof tool.needsApproval === "function" ? await tool.needsApproval(input, {
		toolCallId: toolCall.toolCallId,
		messages,
		context: await validateToolContext({
			toolName,
			context: getOwn(toolsContext, toolName),
			contextSchema: tool?.contextSchema
		})
	}) : tool.needsApproval) ? { type: "user-approval" } : { type: "not-applicable" };
}
function normalizeToolApprovalStatus(status) {
	return status === void 0 ? { type: "not-applicable" } : typeof status === "string" ? { type: status } : status;
}
/**
* Returns a shallow copy of the runtime context with only top-level
* properties marked for telemetry inclusion.
*/
function filterIncludedContext({ context, includeContext }) {
	if (context == null) return {};
	return Object.fromEntries(Object.entries(context).filter(([key]) => includeContext?.[key] === true));
}
function filterToolsContext({ toolsContext, includeToolsContext }) {
	if (includeToolsContext == null) return {};
	return Object.fromEntries(Object.entries(toolsContext).map(([toolName, toolContext]) => [toolName, filterToolContext({
		toolName,
		toolContext,
		includeToolsContext
	})]));
}
function filterToolContext({ toolName, toolContext, includeToolsContext }) {
	const includeToolContext = includeToolsContext?.[toolName];
	return filterIncludedContext({
		context: toolContext,
		includeContext: includeToolContext
	});
}
/**
* Creates an async callback that invokes the provided callbacks in parallel.
* Undefined callbacks are skipped, and thrown or rejected callback errors are
* ignored.
*
* @param callbacks The callbacks to invoke for each event.
* @returns A callback that forwards each event to all callbacks and waits for
* them to settle.
*/
function mergeCallbacks(...callbacks) {
	return async (event) => {
		await Promise.allSettled(callbacks.map(async (callback) => {
			await callback?.(event);
		}));
	};
}
function isNodeRuntime() {
	return typeof process !== "undefined" && process.release?.name === "node";
}
let diagnosticsChannelPromise;
/**
* Loads Node's diagnostics channel module only when the current runtime supports
* it. Unsupported runtimes and failed imports intentionally resolve to
* undefined so telemetry tracing never crashes user code.
*/
async function loadDiagnosticsChannel() {
	if (!isNodeRuntime()) return;
	if (diagnosticsChannelPromise == null) diagnosticsChannelPromise = Promise.resolve(loadBuiltinModule("node:diagnostics_channel"));
	return diagnosticsChannelPromise;
}
function loadBuiltinModule(id) {
	const processWithBuiltins = globalThis.process;
	try {
		return processWithBuiltins?.getBuiltinModule?.(id);
	} catch {
		return;
	}
}
/**
* Runs an async operation inside the AI SDK telemetry tracing channel when
* tracing subscribers may exist. Without Node diagnostics-channel support,
* without tracingChannel support, or when the runtime reports no subscribers,
* this is a direct pass-through.
*
* The execution bookkeeping preserves the original model/tool result or error
* if tracing itself throws, and prevents falling back by calling `execute` a
* second time.
*/
async function runWithTracingChannelSpan(message, execute) {
	const tracingChannel = (await loadDiagnosticsChannel())?.tracingChannel?.("ai:telemetry");
	if (tracingChannel == null || tracingChannel.hasSubscribers === false) return await execute();
	let executePromise;
	let executionResult;
	let executionError;
	let hasExecutionResult = false;
	let hasExecutionError = false;
	const tracedExecute = () => {
		try {
			executePromise = Promise.resolve(execute());
		} catch (error) {
			executePromise = Promise.reject(error);
		}
		executePromise = executePromise.then((result) => {
			executionResult = result;
			hasExecutionResult = true;
			return result;
		}, (error) => {
			executionError = error;
			hasExecutionError = true;
			throw error;
		});
		return executePromise;
	};
	try {
		return await tracingChannel.tracePromise(tracedExecute, message);
	} catch {
		if (hasExecutionError) throw executionError;
		if (hasExecutionResult) return executionResult;
		if (executePromise != null) return await executePromise;
		return await execute();
	}
}
/**
* Opens a long-lived tracing-channel span context and returns a runner that can
* re-enter that context later without changing stream setup timing.
*/
function openTelemetryChannelSpanContext({ message, completion }) {
	if (!isNodeRuntime()) {
		Promise.resolve(completion).catch(() => {});
		return;
	}
	const diagnosticsChannel = loadBuiltinModule("node:diagnostics_channel");
	const asyncHooks = loadBuiltinModule("node:async_hooks");
	const tracingChannel = diagnosticsChannel?.tracingChannel?.("ai:telemetry");
	if (tracingChannel == null || tracingChannel.hasSubscribers === false || asyncHooks == null) {
		Promise.resolve(completion).catch(() => {});
		return;
	}
	const context = message;
	let asyncResource;
	let asyncEndPublished = false;
	const safePublish = (publish) => {
		try {
			publish();
		} catch {}
	};
	const publishAsyncEnd = ({ result, error }) => {
		if (asyncEndPublished) return;
		asyncEndPublished = true;
		if (error !== void 0) {
			context.error = error;
			safePublish(() => tracingChannel.error.publish(context));
		}
		if (result !== void 0) context.result = result;
		safePublish(() => tracingChannel.asyncEnd.publish(context));
	};
	safePublish(() => {
		tracingChannel.start.runStores(context, () => {
			asyncResource = new asyncHooks.AsyncResource("ai.telemetry");
		});
	});
	safePublish(() => tracingChannel.end.publish(context));
	Promise.resolve(completion).then((result) => publishAsyncEnd({ result }), (error) => publishAsyncEnd({ error }));
	return { run: (execute) => asyncResource == null ? execute() : asyncResource.runInAsyncScope(execute) };
}
/**
* Registers one or more telemetry integrations globally.
*/
function registerTelemetry(...integrations) {
	if (!globalThis.AI_SDK_TELEMETRY_INTEGRATIONS) globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [];
	globalThis.AI_SDK_TELEMETRY_INTEGRATIONS.push(...integrations);
}
function getGlobalTelemetryIntegrations() {
	return globalThis.AI_SDK_TELEMETRY_INTEGRATIONS ?? [];
}
function augmentEvent(event, telemetry, filterContext = false) {
	const augmentedEvent = Object.assign(Object.create(Object.getPrototypeOf(event)), event, {
		recordInputs: telemetry.recordInputs,
		recordOutputs: telemetry.recordOutputs,
		functionId: telemetry.functionId
	});
	if (filterContext && event != null && typeof event === "object" && "runtimeContext" in event) augmentedEvent.runtimeContext = filterIncludedContext({
		context: event.runtimeContext,
		includeContext: telemetry.includeRuntimeContext
	});
	if (filterContext && event != null && typeof event === "object") {
		if ("toolsContext" in event) augmentedEvent.toolsContext = filterToolsContext({
			toolsContext: event.toolsContext,
			includeToolsContext: telemetry.includeToolsContext
		});
		else if ("toolContext" in event && event.toolContext != null && "toolCall" in event && event.toolCall != null && typeof event.toolCall === "object" && "toolName" in event.toolCall) augmentedEvent.toolContext = filterToolContext({
			toolName: event.toolCall.toolName,
			toolContext: event.toolContext,
			includeToolsContext: telemetry.includeToolsContext
		});
	}
	return augmentedEvent;
}
/**
* Creates a telemetry dispatcher that sends telemetry events
* to the resolved set of integrations.
*
* When per-call integrations are provided, they take precedence over the globally
* registered integrations for that call. When no per-call integrations are
* provided, the globally registered integrations are used.
*
* @param args.telemetry - Optional per-call telemetry settings and integrations.
*
* @returns A telemetry dispatcher that fans out lifecycle events to the
* resolved set of integrations.
*/
function createTelemetryDispatcher({ telemetry }) {
	if (telemetry?.isEnabled === false) return {};
	const localIntegrations = telemetry?.integrations;
	const integrations = localIntegrations != null ? asArray(localIntegrations) : getGlobalTelemetryIntegrations();
	const telemetryMetadata = {
		recordInputs: telemetry?.recordInputs,
		recordOutputs: telemetry?.recordOutputs,
		functionId: telemetry?.functionId,
		includeRuntimeContext: telemetry?.includeRuntimeContext,
		includeToolsContext: telemetry?.includeToolsContext
	};
	const mergeTelemetryCallback = (key, deprecatedKey) => {
		const integrationCallbacks = integrations.map((integration) => {
			const callback = integration[key] ?? (deprecatedKey == null ? void 0 : integration[deprecatedKey]);
			return typeof callback === "function" ? callback.bind(integration) : void 0;
		}).filter(Boolean).map((callback) => ((event) => callback(augmentEvent(event, telemetryMetadata))));
		if (integrationCallbacks.length === 0) return;
		const mergedIntegrationCallback = mergeCallbacks(...integrationCallbacks);
		return async (event) => {
			await mergedIntegrationCallback(event);
		};
	};
	const onStepEnd = mergeTelemetryCallback("onStepEnd");
	const onStepFinish = mergeTelemetryCallback("onStepFinish");
	const executeLanguageModelCallWrappers = integrations.map((integration) => integration.executeLanguageModelCall?.bind(integration)).filter(Boolean);
	const executeToolWrappers = integrations.map((integration) => integration.executeTool?.bind(integration)).filter(Boolean);
	return {
		runInTracingChannelSpan: async ({ type, event, execute }) => await runWithTracingChannelSpan({
			type,
			event: augmentEvent(event, telemetryMetadata, true)
		}, execute),
		startTracingChannelContext: ({ type, event, completion }) => openTelemetryChannelSpanContext({
			message: {
				type,
				event: augmentEvent(event, telemetryMetadata, true)
			},
			completion
		}),
		onStart: mergeTelemetryCallback("onStart"),
		onStepStart: mergeTelemetryCallback("onStepStart"),
		onLanguageModelCallStart: mergeTelemetryCallback("onLanguageModelCallStart"),
		onLanguageModelCallEnd: mergeTelemetryCallback("onLanguageModelCallEnd"),
		onToolExecutionStart: mergeTelemetryCallback("onToolExecutionStart"),
		onToolExecutionEnd: mergeTelemetryCallback("onToolExecutionEnd"),
		onStepEnd: onStepEnd == null && onStepFinish == null ? void 0 : mergeCallbacks(onStepEnd, onStepFinish),
		onObjectStepStart: mergeTelemetryCallback("onObjectStepStart"),
		onObjectStepEnd: mergeTelemetryCallback("onObjectStepEnd"),
		onEmbedStart: mergeTelemetryCallback("onEmbedStart"),
		onEmbedEnd: mergeTelemetryCallback("onEmbedEnd"),
		onRerankStart: mergeTelemetryCallback("onRerankStart"),
		onRerankEnd: mergeTelemetryCallback("onRerankEnd"),
		experimental_onDecideStart: mergeTelemetryCallback("experimental_onDecideStart", "experimental_onEvaluateStart"),
		experimental_onDecisionModelCallStart: mergeTelemetryCallback("experimental_onDecisionModelCallStart", "experimental_onEvaluationModelCallStart"),
		experimental_onDecisionModelCallEnd: mergeTelemetryCallback("experimental_onDecisionModelCallEnd", "experimental_onEvaluationModelCallEnd"),
		experimental_onDecideEnd: mergeTelemetryCallback("experimental_onDecideEnd", "experimental_onEvaluateEnd"),
		experimental_onStreamTranscriptionStart: mergeTelemetryCallback("experimental_onStreamTranscriptionStart"),
		experimental_onStreamTranscriptionEnd: mergeTelemetryCallback("experimental_onStreamTranscriptionEnd"),
		onEnd: mergeTelemetryCallback("onEnd"),
		onAbort: mergeTelemetryCallback("onAbort"),
		onError: mergeTelemetryCallback("onError"),
		/**
		* Runs provider calls inside integration-specific context so
		* auto-instrumented provider requests can be associated with model work.
		*/
		executeLanguageModelCall: async ({ execute, ...event }) => {
			const augmentedEvent = augmentEvent(event, telemetryMetadata);
			let wrappedExecute = execute;
			for (const executeWrapper of executeLanguageModelCallWrappers) {
				const innerExecute = wrappedExecute;
				wrappedExecute = () => executeWrapper({
					...augmentedEvent,
					execute: innerExecute
				});
			}
			return await runWithTracingChannelSpan({
				type: "languageModelCall",
				event: augmentedEvent
			}, wrappedExecute);
		},
		/**
		* Composes all `executeTool` wrappers around the original tool execution.
		* Each wrapper receives an `execute` function that calls the next wrapper in
		* the chain, so integrations can establish nested telemetry context before
		* delegating to the underlying tool.
		*/
		executeTool: async ({ execute, ...event }) => {
			const augmentedEvent = augmentEvent(event, telemetryMetadata);
			let wrappedExecute = execute;
			for (const executeWrapper of executeToolWrappers) {
				const innerExecute = wrappedExecute;
				wrappedExecute = () => executeWrapper({
					...augmentedEvent,
					execute: innerExecute
				});
			}
			return await wrappedExecute();
		}
	};
}
function asReasoningText(reasoningParts) {
	const reasoningText = reasoningParts.map((part) => "text" in part ? part.text : "").join("");
	return reasoningText.length > 0 ? reasoningText : void 0;
}
var DefaultStepResult = class {
	constructor({ callId, stepNumber, provider, modelId, runtimeContext, toolsContext, content, finishReason, rawFinishReason, usage, performance, warnings, request, response, providerMetadata }) {
		this.callId = callId;
		this.stepNumber = stepNumber;
		this.model = {
			provider,
			modelId
		};
		this.runtimeContext = runtimeContext;
		this.toolsContext = toolsContext;
		this.content = content;
		this.finishReason = finishReason;
		this.rawFinishReason = rawFinishReason;
		this.usage = usage;
		this.performance = performance;
		this.warnings = warnings;
		this.request = request;
		this.response = response;
		this.providerMetadata = providerMetadata;
	}
	get text() {
		return this.content.filter((part) => part.type === "text").map((part) => part.text).join("");
	}
	get reasoning() {
		return convertFromReasoningOutputs(this.content.filter((part) => part.type === "reasoning" || part.type === "reasoning-file"));
	}
	get reasoningText() {
		return asReasoningText(this.reasoning);
	}
	get files() {
		return this.content.filter((part) => part.type === "file").map((part) => part.file);
	}
	get sources() {
		return this.content.filter((part) => part.type === "source");
	}
	get toolCalls() {
		return this.content.filter((part) => part.type === "tool-call");
	}
	get staticToolCalls() {
		return this.toolCalls.filter((toolCall) => toolCall.dynamic !== true);
	}
	get dynamicToolCalls() {
		return this.toolCalls.filter((toolCall) => toolCall.dynamic === true);
	}
	get toolResults() {
		return this.content.filter((part) => part.type === "tool-result");
	}
	get staticToolResults() {
		return this.toolResults.filter((toolResult) => toolResult.dynamic !== true);
	}
	get dynamicToolResults() {
		return this.toolResults.filter((toolResult) => toolResult.dynamic === true);
	}
};
/**
* Creates a copy of a step result whose runtime context only contains
* top-level properties marked for telemetry inclusion.
*/
function restrictStepResult({ step, includeRuntimeContext, includeToolsContext }) {
	return new DefaultStepResult({
		callId: step.callId,
		stepNumber: step.stepNumber,
		provider: step.model.provider,
		modelId: step.model.modelId,
		runtimeContext: filterIncludedContext({
			context: step.runtimeContext,
			includeContext: includeRuntimeContext
		}),
		toolsContext: filterToolsContext({
			toolsContext: step.toolsContext,
			includeToolsContext
		}),
		content: step.content,
		finishReason: step.finishReason,
		rawFinishReason: step.rawFinishReason,
		usage: step.usage,
		performance: step.performance,
		warnings: step.warnings,
		request: step.request,
		response: step.response,
		providerMetadata: step.providerMetadata
	});
}
/**
* Creates a telemetry dispatcher that only includes configured runtime context
* properties in text-generation lifecycle events before dispatching them.
*/
function createRestrictedTelemetryDispatcher$3({ telemetry, includeRuntimeContext, includeToolsContext }) {
	const telemetryDispatcher = createTelemetryDispatcher({ telemetry });
	return {
		...telemetryDispatcher,
		onStart: (event) => telemetryDispatcher.onStart?.({
			...event,
			runtimeContext: filterIncludedContext({
				context: event.runtimeContext,
				includeContext: includeRuntimeContext
			}),
			toolsContext: filterToolsContext({
				toolsContext: event.toolsContext,
				includeToolsContext
			})
		}),
		onStepStart: (event) => telemetryDispatcher.onStepStart?.({
			...event,
			runtimeContext: filterIncludedContext({
				context: event.runtimeContext,
				includeContext: includeRuntimeContext
			}),
			steps: event.steps.map((step) => restrictStepResult({
				step,
				includeRuntimeContext,
				includeToolsContext
			})),
			toolsContext: filterToolsContext({
				toolsContext: event.toolsContext,
				includeToolsContext
			})
		}),
		onStepEnd: (event) => telemetryDispatcher.onStepEnd?.(restrictStepResult({
			step: event,
			includeRuntimeContext,
			includeToolsContext
		})),
		onStepFinish: (event) => telemetryDispatcher.onStepEnd?.(restrictStepResult({
			step: event,
			includeRuntimeContext,
			includeToolsContext
		})),
		onEnd: (event) => telemetryDispatcher.onEnd?.(((restrictedSteps) => {
			return {
				...event,
				runtimeContext: filterIncludedContext({
					context: event.runtimeContext,
					includeContext: includeRuntimeContext
				}),
				steps: restrictedSteps,
				finalStep: restrictedSteps.at(-1),
				toolsContext: filterToolsContext({
					toolsContext: event.toolsContext,
					includeToolsContext
				})
			};
		})(event.steps.map((step) => restrictStepResult({
			step,
			includeRuntimeContext,
			includeToolsContext
		})))),
		onAbort: (event) => telemetryDispatcher.onAbort?.({
			...event,
			steps: event.steps.map((step) => restrictStepResult({
				step,
				includeRuntimeContext,
				includeToolsContext
			}))
		}),
		onToolExecutionStart: (event) => telemetryDispatcher.onToolExecutionStart?.({
			...event,
			toolContext: filterToolContext({
				toolName: event.toolCall.toolName,
				toolContext: event.toolContext,
				includeToolsContext
			})
		}),
		onToolExecutionEnd: (event) => telemetryDispatcher.onToolExecutionEnd?.({
			...event,
			toolContext: filterToolContext({
				toolName: event.toolCall.toolName,
				toolContext: event.toolContext,
				includeToolsContext
			})
		})
	};
}
/**
* Creates a stop condition that returns `true` when the number of completed
* steps equals `stepCount`.
*
* @param stepCount - The number of steps to allow before stopping.
*/
function isStepCount(stepCount) {
	return ({ steps }) => steps.length === stepCount;
}
/**
* Evaluates the provided stop conditions for the current list of steps.
*
* Returns `true` as soon as any stop condition is met.
*
* @param stopConditions - The stop conditions to evaluate.
* @param steps - The completed steps accumulated so far.
*/
async function isStopConditionMet({ stopConditions, steps }) {
	return (await Promise.all(stopConditions.map((condition) => condition({ steps })))).some((result) => result);
}
/**
* Adds token counts while preserving an unknown total when both counts are
* unknown.
*/
function sumTokenCounts(tokenCount1, tokenCount2) {
	return tokenCount1 == null && tokenCount2 == null ? void 0 : (tokenCount1 ?? 0) + (tokenCount2 ?? 0);
}
/**
* Performs a deep-equal comparison of two parsed JSON objects.
*
* @param {any} obj1 - The first object to compare.
* @param {any} obj2 - The second object to compare.
* @returns {boolean} - Returns true if the two objects are deeply equal, false otherwise.
*/
function isDeepEqualData(obj1, obj2) {
	if (obj1 === obj2) return true;
	if (obj1 == null || obj2 == null) return false;
	if (typeof obj1 !== "object" && typeof obj2 !== "object") return obj1 === obj2;
	if (obj1.constructor !== obj2.constructor) return false;
	if (obj1 instanceof Date && obj2 instanceof Date) return obj1.getTime() === obj2.getTime();
	if (Array.isArray(obj1)) {
		if (obj1.length !== obj2.length) return false;
		for (let i = 0; i < obj1.length; i++) if (!isDeepEqualData(obj1[i], obj2[i])) return false;
		return true;
	}
	const keys1 = Object.keys(obj1);
	const keys2 = Object.keys(obj2);
	if (keys1.length !== keys2.length) return false;
	for (const key of keys1) {
		if (!keys2.includes(key)) return false;
		if (!isDeepEqualData(obj1[key], obj2[key])) return false;
	}
	return true;
}
/**
* Converts the result of a `generateText` or `streamText` call to a list of response messages.
*/
async function toResponseMessages({ content: inputContent, tools }) {
	const responseMessages = [];
	const toolCallOrder = /* @__PURE__ */ new Map();
	const content = [];
	for (const part of inputContent) {
		if (part.type === "source") continue;
		if ((part.type === "tool-result" || part.type === "tool-error") && !part.providerExecuted) continue;
		if (part.type === "text" && part.text.length === 0) continue;
		switch (part.type) {
			case "text":
				content.push({
					type: "text",
					text: part.text,
					providerOptions: part.providerMetadata
				});
				break;
			case "custom":
				content.push({
					type: "custom",
					kind: part.kind,
					providerOptions: part.providerMetadata
				});
				break;
			case "reasoning":
				content.push({
					type: "reasoning",
					text: part.text,
					providerOptions: part.providerMetadata
				});
				break;
			case "file":
				content.push({
					type: "file",
					data: part.file.base64,
					mediaType: part.file.mediaType,
					providerOptions: part.providerMetadata
				});
				break;
			case "reasoning-file":
				content.push({
					type: "reasoning-file",
					data: part.file.base64,
					mediaType: part.file.mediaType,
					providerOptions: part.providerMetadata
				});
				break;
			case "tool-call":
				if (!toolCallOrder.has(part.toolCallId)) toolCallOrder.set(part.toolCallId, toolCallOrder.size);
				content.push({
					type: "tool-call",
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					input: part.invalid && typeof part.input !== "object" ? {} : part.input,
					providerExecuted: part.providerExecuted,
					providerOptions: part.providerMetadata
				});
				break;
			case "tool-result": {
				const output = await createToolModelOutput({
					toolCallId: part.toolCallId,
					input: part.input,
					tool: getOwn(tools, part.toolName),
					output: part.output,
					errorMode: "none"
				});
				content.push({
					type: "tool-result",
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					output,
					providerOptions: part.providerMetadata
				});
				break;
			}
			case "tool-error": {
				const output = await createToolModelOutput({
					toolCallId: part.toolCallId,
					input: part.input,
					tool: getOwn(tools, part.toolName),
					output: part.error,
					errorMode: "json"
				});
				content.push({
					type: "tool-result",
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					output,
					providerOptions: part.providerMetadata
				});
				break;
			}
			case "tool-approval-request":
				const inputSchemaInput = getToolCallInputSchemaInput(part.toolCall);
				content.push({
					type: "tool-approval-request",
					approvalId: part.approvalId,
					toolCallId: part.toolCall.toolCallId,
					...part.reason != null ? { reason: part.reason } : {},
					isAutomatic: part.isAutomatic,
					...part.signature != null ? { signature: part.signature } : {},
					...inputSchemaInput != null && !isDeepEqualData(inputSchemaInput.value, part.toolCall.input) ? { inputSchemaInput: inputSchemaInput.value } : {}
				});
		}
	}
	if (content.length > 0) responseMessages.push({
		role: "assistant",
		content
	});
	const toolResultContent = [];
	for (const part of inputContent) {
		if (part.type !== "tool-approval-response" && part.type !== "tool-result" && part.type !== "tool-error") continue;
		if (part.type === "tool-approval-response") {
			toolResultContent.push({
				type: "tool-approval-response",
				approvalId: part.approvalId,
				approved: part.approved,
				reason: part.reason,
				providerExecuted: part.providerExecuted
			});
			if (part.approved === false) toolResultContent.push({
				type: "tool-result",
				toolCallId: part.toolCall.toolCallId,
				toolName: part.toolCall.toolName,
				output: {
					type: "execution-denied",
					reason: part.reason
				}
			});
			continue;
		}
		if (part.providerExecuted) continue;
		const output = await createToolModelOutput({
			toolCallId: part.toolCallId,
			input: part.input,
			tool: getOwn(tools, part.toolName),
			output: part.type === "tool-result" ? part.output : part.error,
			errorMode: part.type === "tool-error" ? "text" : "none"
		});
		toolResultContent.push({
			type: "tool-result",
			toolCallId: part.toolCallId,
			toolName: part.toolName,
			output,
			...part.providerMetadata != null ? { providerOptions: part.providerMetadata } : {}
		});
	}
	if (toolResultContent.length > 0) responseMessages.push({
		role: "tool",
		content: sortToolResultContentByToolCallOrder({
			toolResultContent,
			toolCallOrder
		})
	});
	return responseMessages;
}
function sortToolResultContentByToolCallOrder({ toolResultContent, toolCallOrder }) {
	const sortedToolResults = toolResultContent.filter((part) => part.type === "tool-result").map((part, index) => ({
		part,
		index
	})).sort((a, b) => {
		const aOrder = toolCallOrder.get(a.part.toolCallId);
		const bOrder = toolCallOrder.get(b.part.toolCallId);
		if (aOrder == null && bOrder == null) return a.index - b.index;
		if (aOrder == null) return 1;
		if (bOrder == null) return -1;
		return aOrder - bOrder || a.index - b.index;
	}).map(({ part }) => part);
	let toolResultIndex = 0;
	return toolResultContent.map((part) => part.type === "tool-result" ? sortedToolResults[toolResultIndex++] : part);
}
const encoder$1 = new TextEncoder();
/**
* Deterministic JSON serialization: object keys are sorted so that two
* structurally-equal values always produce the same string regardless of key
* insertion order. Used as the input to content hashing.
*/
function canonicalJSON(value) {
	if (value === null || value === void 0) return JSON.stringify(value);
	if (typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((element) => element === void 0 ? "null" : canonicalJSON(element)).join(",")}]`;
	return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(",")}}`;
}
function toBase64url(bytes) {
	return convertUint8ArrayToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
/**
* Canonical SHA-256 digest (base64url) of an arbitrary JSON-serializable value.
*/
async function hashCanonical(value) {
	const digest = await crypto.subtle.digest("SHA-256", encoder$1.encode(canonicalJSON(value)));
	return toBase64url(new Uint8Array(digest));
}
const encoder = new TextEncoder();
function fromBase64url(str) {
	return convertBase64ToUint8Array(str);
}
async function importKey(secret) {
	const keyData = typeof secret === "string" ? encoder.encode(secret) : secret;
	return crypto.subtle.importKey("raw", keyData, {
		name: "HMAC",
		hash: "SHA-256"
	}, false, ["sign", "verify"]);
}
function buildPayload(approvalId, toolCallId, toolName, inputDigest) {
	return encoder.encode(JSON.stringify([
		"ai-sdk-tool-approval-v1",
		approvalId,
		toolCallId,
		toolName,
		inputDigest
	]));
}
function buildLegacyPayload(approvalId, toolCallId, toolName, inputDigest) {
	return encoder.encode(`${approvalId}\n${toolCallId}\n${toolName}\n${inputDigest}`);
}
async function signToolApproval({ secret, approvalId, toolCallId, toolName, input }) {
	const key = await importKey(secret);
	const payload = buildPayload(approvalId, toolCallId, toolName, await hashCanonical(input));
	const sig = await crypto.subtle.sign("HMAC", key, payload);
	return toBase64url(new Uint8Array(sig));
}
async function verifyToolApprovalSignature({ secret, signature, approvalId, toolCallId, toolName, input }) {
	const key = await importKey(secret);
	const inputDigest = await hashCanonical(input);
	const sigBytes = fromBase64url(signature);
	const payload = buildPayload(approvalId, toolCallId, toolName, inputDigest);
	if (await crypto.subtle.verify("HMAC", key, sigBytes, payload)) return true;
	if (!approvalId.includes("\n") && !toolCallId.includes("\n") && !toolName.includes("\n")) {
		const legacyPayload = buildLegacyPayload(approvalId, toolCallId, toolName, inputDigest);
		return crypto.subtle.verify("HMAC", key, sigBytes, legacyPayload);
	}
	return false;
}
async function maybeSignApproval({ secret, approvalId, toolCallId, toolName, input }) {
	if (secret == null) return void 0;
	return signToolApproval({
		secret,
		approvalId,
		toolCallId,
		toolName,
		input
	});
}
/**
* Re-validates approved tool approvals reconstructed from client-supplied
* message history before they are executed. Checks HMAC signature (when
* configured), input schema, and approval policy.
*/
async function validateApprovedToolApprovals({ approvedToolApprovals, tools, toolApproval, messages, toolsContext, runtimeContext, toolApprovalSecret, refineToolInput }) {
	const approved = [];
	const denied = [];
	const invalid = [];
	for (const approval of approvedToolApprovals) {
		const { approvalRequest, toolCall } = approval;
		const tool = getOwn(tools, toolCall.toolName);
		if (toolApprovalSecret != null) {
			if (approvalRequest.signature == null) throw new InvalidToolApprovalSignatureError({
				approvalId: approvalRequest.approvalId,
				toolCallId: toolCall.toolCallId,
				reason: "missing signature"
			});
			if (!await verifyToolApprovalSignature({
				secret: toolApprovalSecret,
				signature: approvalRequest.signature,
				approvalId: approvalRequest.approvalId,
				toolCallId: toolCall.toolCallId,
				toolName: toolCall.toolName,
				input: toolCall.input
			})) throw new InvalidToolApprovalSignatureError({
				approvalId: approvalRequest.approvalId,
				toolCallId: toolCall.toolCallId,
				reason: "invalid signature"
			});
		}
		if (isExecutableTool(tool) && tool.inputSchema != null) {
			const hasInputSchemaInput = Object.prototype.hasOwnProperty.call(approvalRequest, "inputSchemaInput");
			const validation = await safeValidateTypes({
				value: hasInputSchemaInput ? approvalRequest.inputSchemaInput : toolCall.input,
				schema: asSchema(tool.inputSchema)
			});
			let validationError;
			if (!validation.success) validationError = validation.error;
			else try {
				const revalidatedToolCall = await refineParsedToolCallInput({
					toolCall: {
						...toolCall,
						input: validation.value
					},
					refineToolInput
				});
				if (!isDeepEqualData(structuredClone(revalidatedToolCall.input), structuredClone(toolCall.input))) validationError = /* @__PURE__ */ new Error("Approved tool input does not match the validated schema output.");
			} catch (error) {
				validationError = error;
			}
			if (validationError != null) {
				invalid.push({
					...approval,
					error: new InvalidToolInputError({
						toolName: toolCall.toolName,
						toolInput: JSON.stringify(toolCall.input),
						cause: validationError
					})
				});
				continue;
			}
		}
		const approvalStatus = await resolveToolApproval({
			tools,
			toolApproval,
			toolCall,
			messages,
			toolsContext,
			runtimeContext
		});
		if (approvalStatus.type === "denied") denied.push({
			...approval,
			approvalResponse: {
				...approval.approvalResponse,
				approved: false,
				reason: approvalStatus.reason ?? approval.approvalResponse.reason
			}
		});
		else approved.push(approval);
	}
	return {
		approvedToolApprovals: approved,
		deniedToolApprovals: denied,
		invalidToolApprovals: invalid
	};
}
/**
* Validates the maximum number of tool calls that may execute concurrently.
*/
function prepareToolCallConcurrency(toolCallConcurrency) {
	if (toolCallConcurrency == null) return;
	if (!Number.isInteger(toolCallConcurrency)) throw new InvalidArgumentError({
		parameter: "toolCallConcurrency",
		value: toolCallConcurrency,
		message: "toolCallConcurrency must be an integer"
	});
	if (toolCallConcurrency < 1) throw new InvalidArgumentError({
		parameter: "toolCallConcurrency",
		value: toolCallConcurrency,
		message: "toolCallConcurrency must be >= 1"
	});
	return toolCallConcurrency;
}
/**
* Maps items with an optional concurrency limit while preserving result order.
*
* Workers claim items in input order. When the signal is aborted or an
* execution rejects, no additional queued items are started.
*/
async function mapWithConcurrency({ items, concurrency, abortSignal, execute }) {
	if (concurrency == null || concurrency >= items.length) return Promise.all(items.map(execute));
	const results = new Array(items.length);
	let nextIndex = 0;
	let stopped = false;
	const worker = async () => {
		while (!stopped) {
			abortSignal?.throwIfAborted();
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				results[index] = await execute(items[index], index);
			} catch (error) {
				stopped = true;
				throw error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return results;
}
const originalGenerateId$4 = createIdGenerator({
	prefix: "aitxt",
	size: 24
});
const originalGenerateCallId$9 = createIdGenerator({
	prefix: "call",
	size: 24
});
/**
* Generate a text and call tools for a given prompt using a language model.
*
* This function does not stream the output. If you want to stream the output, use `streamText` instead.
*
* @param model - The language model to use.
*
* @param tools - Tools that are accessible to and can be called by the model. The model needs to support calling tools.
* @param toolChoice - The tool choice strategy. Default: 'auto'.
* @param toolOrder - Controls the order in which tools are sent to the provider. Tools not listed are appended alphabetically.
* @param toolCallConcurrency - Maximum number of tool calls that may execute concurrently within a step. Set to 1 for sequential execution. Default: unlimited.
*
* @param system - A system message that will be part of the prompt.
* @param prompt - A simple text prompt. You can either use `prompt` or `messages` but not both.
* @param messages - A list of messages. You can either use `prompt` or `messages` but not both.
* @param allowSystemInMessages - Whether system messages are allowed in the `prompt` or `messages` fields. Default: false.
*
* @param maxOutputTokens - Maximum number of tokens to generate.
* @param temperature - Temperature setting.
* The value is passed through to the provider. The range depends on the provider and model.
* It is recommended to set either `temperature` or `topP`, but not both.
* @param topP - Nucleus sampling.
* The value is passed through to the provider. The range depends on the provider and model.
* It is recommended to set either `temperature` or `topP`, but not both.
* @param topK - Only sample from the top K options for each subsequent token.
* Used to remove "long tail" low probability responses.
* Recommended for advanced use cases only. You usually only need to use temperature.
* @param presencePenalty - Presence penalty setting.
* It affects the likelihood of the model to repeat information that is already in the prompt.
* The value is passed through to the provider. The range depends on the provider and model.
* @param frequencyPenalty - Frequency penalty setting.
* It affects the likelihood of the model to repeatedly use the same words or phrases.
* The value is passed through to the provider. The range depends on the provider and model.
* @param stopSequences - Stop sequences.
* If set, the model will stop generating text when one of the stop sequences is generated.
* @param seed - The seed (integer) to use for random sampling.
* If set and supported by the model, calls will generate deterministic results.
*
* @param maxRetries - Maximum number of retries. Set to 0 to disable retries. Default: 2.
* @param abortSignal - An optional abort signal that can be used to cancel the call.
* @param timeout - An optional timeout in milliseconds. The call will be aborted if it takes longer than the specified timeout.
* @param headers - Additional HTTP headers to be sent with the request. Only applicable for HTTP-based providers.
*
* @param experimental_sandbox - The sandbox environment that is passed through to tool execution.
* @param runtimeContext - User-defined runtime context that flows through the entire generation lifecycle.
* @param experimental_refineToolInput - Optional mapping of tool names to functions that refine parsed tool inputs before tools are executed and before outputs, callbacks, and telemetry are recorded.
* @param onStart - Callback invoked when generation begins, before any LLM calls.
* @param experimental_onStart - Deprecated alias for `onStart`.
* @param onStepStart - Callback invoked when each step begins, before the provider is called.
* @param experimental_onStepStart - Deprecated alias for `onStepStart`.
* Receives step number, messages (in ModelMessage format), tools, and runtimeContext.
* @param onLanguageModelCallStart - Callback invoked immediately before each provider model call begins.
* @param experimental_onLanguageModelCallStart - Deprecated alias for `onLanguageModelCallStart`.
* @param onLanguageModelCallEnd - Callback invoked after each provider model call response is normalized and parsed.
* @param experimental_onLanguageModelCallEnd - Deprecated alias for `onLanguageModelCallEnd`.
* @param onToolExecutionStart - Callback invoked before each tool execution begins.
* Receives tool name, call ID, input, and context.
* @param experimental_onToolCallStart - Deprecated alias for `onToolExecutionStart`.
* @param onToolExecutionEnd - Callback invoked after each tool execution completes.
* Uses a discriminated union: check `success` to determine if `output` or `error` is present.
* @param experimental_onToolCallFinish - Deprecated alias for `onToolExecutionEnd`.
* @param onStepFinish - Callback that is called when each step (LLM call) is finished, including intermediate steps.
* @param onEnd - Callback that is called when all steps are finished and the response is complete.
* @param onFinish - Deprecated alias for `onEnd`.
*
* @returns
* A result object that contains the generated text, the results of the tool calls, and additional information.
*/
async function generateText({ model: modelArg, tools, toolChoice, instructions, system, prompt, messages, allowSystemInMessages, maxRetries: maxRetriesArg, abortSignal, timeout, headers, stopWhen = isStepCount(1), experimental_sandbox: sandbox, output, toolApproval, experimental_toolCallers, experimental_toolApprovalSecret, experimental_telemetry, telemetry = experimental_telemetry, providerOptions, activeTools, toolOrder, toolCallConcurrency, prepareStep, experimental_repairToolCall, repairToolCall = experimental_repairToolCall, experimental_refineToolInput: refineToolInput, experimental_download: download, runtimeContext = {}, toolsContext = {}, experimental_include, include = experimental_include, _internal: { generateId = originalGenerateId$4, generateCallId = originalGenerateCallId$9, now: now$4 = now } = {}, onStart, experimental_onStart, onStepStart, experimental_onStepStart, onLanguageModelCallStart, experimental_onLanguageModelCallStart, onLanguageModelCallEnd, experimental_onLanguageModelCallEnd, onToolExecutionStart, onToolExecutionEnd, experimental_onToolCallStart, experimental_onToolCallFinish, onStepEnd, onStepFinish, onFinish, onEnd = onFinish, ...settings }) {
	include = {
		requestBody: include?.requestBody ?? false,
		requestMessages: include?.requestMessages ?? false,
		responseBody: include?.responseBody ?? false
	};
	const resolvedToolCallConcurrency = prepareToolCallConcurrency(toolCallConcurrency);
	const model = resolveLanguageModel(modelArg);
	const resolvedToolCallers = resolveToolCallerConfiguration({
		tools,
		toolCallers: experimental_toolCallers
	});
	const prepareToolSearch = createToolSearchState({
		tools,
		toolCallers: resolvedToolCallers
	});
	const stopConditions = asArray(stopWhen);
	const resolvedOnStart = onStart ?? experimental_onStart;
	const resolvedOnStepStart = onStepStart ?? experimental_onStepStart;
	const resolvedOnLanguageModelCallStart = onLanguageModelCallStart ?? experimental_onLanguageModelCallStart;
	const resolvedOnLanguageModelCallEnd = onLanguageModelCallEnd ?? experimental_onLanguageModelCallEnd;
	const resolvedOnToolExecutionStart = onToolExecutionStart ?? experimental_onToolCallStart;
	const resolvedOnToolExecutionEnd = onToolExecutionEnd ?? experimental_onToolCallFinish;
	const resolvedOnStepEnd = onStepEnd ?? onStepFinish;
	const unsupportedTimeoutWarnings = [];
	if (getFirstChunkTimeoutMs(timeout) != null) unsupportedTimeoutWarnings.push({
		type: "unsupported",
		feature: "timeout.firstChunkMs",
		details: "The firstChunkMs timeout is only supported by streaming functions."
	});
	if (getChunkTimeoutMs(timeout) != null) unsupportedTimeoutWarnings.push({
		type: "unsupported",
		feature: "timeout.chunkMs",
		details: "The chunkMs timeout is only supported by streaming functions."
	});
	if (unsupportedTimeoutWarnings.length > 0) logWarnings({
		warnings: unsupportedTimeoutWarnings,
		provider: model.provider,
		model: model.modelId
	});
	const totalTimeoutMs = getTotalTimeoutMs(timeout);
	const stepTimeoutMs = getStepTimeoutMs(timeout);
	const stepAbortController = stepTimeoutMs != null ? new AbortController() : void 0;
	const mergedAbortSignal = mergeAbortSignals(abortSignal, totalTimeoutMs, stepAbortController?.signal);
	const { maxRetries, retry } = prepareRetries({
		maxRetries: maxRetriesArg,
		abortSignal: mergedAbortSignal
	});
	const callSettings = prepareLanguageModelCallOptions(settings);
	const headersWithUserAgent = withUserAgentSuffix(headers ?? {}, `ai/${VERSION}`);
	const initialPrompt = await standardizePrompt({
		instructions,
		system,
		prompt,
		messages,
		allowSystemInMessages
	});
	const callId = generateCallId();
	const telemetryDispatcher = createRestrictedTelemetryDispatcher$3({
		telemetry,
		includeRuntimeContext: telemetry?.includeRuntimeContext,
		includeToolsContext: telemetry?.includeToolsContext
	});
	const runInTracingChannelSpan = telemetryDispatcher.runInTracingChannelSpan ?? (async ({ execute }) => await execute());
	const generateTextStartEvent = {
		callId,
		operationId: "ai.generateText",
		provider: model.provider,
		modelId: model.modelId,
		instructions: initialPrompt.instructions,
		messages: initialPrompt.messages,
		tools,
		toolChoice,
		activeTools,
		toolOrder,
		maxOutputTokens: callSettings.maxOutputTokens,
		temperature: callSettings.temperature,
		topP: callSettings.topP,
		topK: callSettings.topK,
		presencePenalty: callSettings.presencePenalty,
		frequencyPenalty: callSettings.frequencyPenalty,
		stopSequences: callSettings.stopSequences,
		seed: callSettings.seed,
		reasoning: callSettings.reasoning,
		maxRetries,
		timeout,
		headers: headersWithUserAgent,
		providerOptions,
		output,
		runtimeContext,
		toolsContext
	};
	const executeGenerateText = async () => {
		await notify({
			event: generateTextStartEvent,
			callbacks: [resolvedOnStart, telemetryDispatcher.onStart]
		});
		try {
			const initialMessages = initialPrompt.messages;
			const initialResponseMessages = [];
			const { approvedToolApprovals, deniedToolApprovals: collectedDeniedToolApprovals } = collectToolApprovals({ messages: initialMessages });
			const { approvedToolApprovals: localApprovedToolApprovals, deniedToolApprovals: revalidationDeniedToolApprovals, invalidToolApprovals } = await validateApprovedToolApprovals({
				approvedToolApprovals: approvedToolApprovals.filter((toolApproval) => !toolApproval.toolCall.providerExecuted),
				tools,
				toolApproval,
				messages: initialMessages,
				toolsContext,
				runtimeContext,
				toolApprovalSecret: experimental_toolApprovalSecret,
				refineToolInput
			});
			const deniedToolApprovalsWithoutResults = [...collectedDeniedToolApprovals, ...revalidationDeniedToolApprovals].filter((toolApproval) => toolApproval.existingToolResult == null);
			if (deniedToolApprovalsWithoutResults.length > 0 || localApprovedToolApprovals.length > 0 || invalidToolApprovals.length > 0) {
				const toolResults = await executeTools({
					toolCalls: localApprovedToolApprovals.map((toolApproval) => toolApproval.toolCall),
					tools,
					callId,
					messages: initialMessages,
					abortSignal: mergedAbortSignal,
					timeout,
					experimental_sandbox: sandbox,
					toolsContext,
					onToolExecutionStart: (event) => notify({
						event,
						callbacks: [resolvedOnToolExecutionStart, telemetryDispatcher.onToolExecutionStart]
					}),
					onToolExecutionEnd: (event) => notify({
						event,
						callbacks: [resolvedOnToolExecutionEnd, telemetryDispatcher.onToolExecutionEnd]
					}),
					executeToolInTelemetryContext: telemetryDispatcher.executeTool,
					runInTracingChannelSpan,
					toolCallConcurrency: resolvedToolCallConcurrency
				});
				const toolContent = [];
				for (const result of toolResults) {
					const output = result.output;
					const modelOutput = await createToolModelOutput({
						toolCallId: output.toolCallId,
						input: output.input,
						tool: getOwn(tools, output.toolName),
						output: output.type === "tool-result" ? output.output : output.error,
						errorMode: output.type === "tool-error" ? "text" : "none"
					});
					toolContent.push({
						type: "tool-result",
						toolCallId: output.toolCallId,
						toolName: output.toolName,
						output: modelOutput
					});
				}
				for (const toolApproval of invalidToolApprovals) toolContent.push({
					type: "tool-result",
					toolCallId: toolApproval.toolCall.toolCallId,
					toolName: toolApproval.toolCall.toolName,
					output: await createToolModelOutput({
						toolCallId: toolApproval.toolCall.toolCallId,
						input: toolApproval.toolCall.input,
						tool: getOwn(tools, toolApproval.toolCall.toolName),
						output: toolApproval.error,
						errorMode: "text"
					})
				});
				for (const toolApproval of deniedToolApprovalsWithoutResults) toolContent.push({
					type: "tool-result",
					toolCallId: toolApproval.toolCall.toolCallId,
					toolName: toolApproval.toolCall.toolName,
					output: {
						type: "execution-denied",
						reason: toolApproval.approvalResponse.reason,
						...toolApproval.toolCall.providerExecuted && { providerOptions: { openai: { approvalId: toolApproval.approvalResponse.approvalId } } }
					}
				});
				initialResponseMessages.push({
					role: "tool",
					content: toolContent
				});
			}
			const callSettings = prepareLanguageModelCallOptions(settings);
			let currentModelResponse;
			let clientToolCalls = [];
			let clientToolOutputs = [];
			let toolApprovalResponses = [];
			let deniedToolApprovalResponses = [];
			const steps = [];
			let instructionsForNextStep = initialPrompt.instructions;
			let messagesForNextStep = [...initialMessages, ...initialResponseMessages];
			const pendingDeferredToolCalls = /* @__PURE__ */ new Map();
			do {
				if (steps.length > 0) mergedAbortSignal?.throwIfAborted();
				const stepTimeoutId = setAbortTimeout({
					abortController: stepAbortController,
					label: "Step",
					timeoutMs: stepTimeoutMs
				});
				const stepNumber = steps.length;
				try {
					await runInTracingChannelSpan({
						type: "step",
						event: {
							callId,
							stepNumber
						},
						execute: async () => {
							const accumulatedResponseMessages = [...initialResponseMessages, ...steps.flatMap((step) => step.response.messages)];
							const stepInputMessages = messagesForNextStep;
							const prepareStepResult = await prepareStep?.({
								model,
								steps,
								stepNumber: steps.length,
								instructions: instructionsForNextStep,
								initialInstructions: initialPrompt.instructions,
								messages: stepInputMessages,
								initialMessages,
								responseMessages: accumulatedResponseMessages,
								runtimeContext,
								toolsContext,
								experimental_sandbox: sandbox
							});
							const stepSandbox = prepareStepResult?.experimental_sandbox ?? sandbox;
							const stepModel = resolveLanguageModel(prepareStepResult?.model ?? model);
							const stepInstructions = prepareStepResult?.instructions ?? prepareStepResult?.system ?? instructionsForNextStep;
							runtimeContext = prepareStepResult?.runtimeContext ?? runtimeContext;
							toolsContext = prepareStepResult?.toolsContext ?? toolsContext;
							const stepActiveTools = filterActiveTools({
								tools,
								activeTools: prepareStepResult?.activeTools ?? activeTools
							});
							const { executionTools: stepExecutionTools, modelTools: stepModelTools, toolCallerMessages } = prepareToolsForToolCallers({
								tools: prepareToolSearch(stepActiveTools, {
									toolsContext,
									experimental_sandbox: stepSandbox
								}),
								toolCallers: resolvedToolCallers
							});
							const stepToolOrder = prepareStepResult?.toolOrder ?? toolOrder;
							const stepTools = await prepareTools({
								tools: stepModelTools,
								toolOrder: stepToolOrder,
								toolsContext,
								experimental_sandbox: stepSandbox
							});
							const stepToolChoice = prepareToolChoice({ toolChoice: prepareStepResult?.toolChoice ?? toolChoice });
							const stepMessages = appendToolCallerMessages({
								messages: prepareStepResult?.messages ?? stepInputMessages,
								toolCallerMessages
							});
							const promptMessages = await convertToLanguageModelPrompt({
								prompt: {
									instructions: stepInstructions,
									messages: stepMessages
								},
								supportedUrls: await stepModel.supportedUrls,
								download,
								abortSignal: mergedAbortSignal,
								provider: stepModel.provider.split(".")[0]
							});
							const stepProviderOptions = mergeObjects(providerOptions, prepareStepResult?.providerOptions);
							const stepCallSettings = prepareStepCallSettings({
								callSettings,
								stepSettings: prepareStepResult
							});
							await notify({
								event: {
									callId,
									provider: stepModel.provider,
									modelId: stepModel.modelId,
									stepNumber,
									instructions: stepInstructions,
									messages: stepMessages,
									tools,
									toolChoice: prepareStepResult?.toolChoice ?? toolChoice,
									activeTools: prepareStepResult?.activeTools ?? activeTools,
									toolOrder: stepToolOrder,
									steps: [...steps],
									providerOptions: stepProviderOptions,
									output,
									runtimeContext,
									promptMessages,
									stepTools,
									stepToolChoice,
									toolsContext
								},
								callbacks: [resolvedOnStepStart, telemetryDispatcher.onStepStart]
							});
							const languageModelCallContext = {
								provider: stepModel.provider,
								modelId: stepModel.modelId,
								instructions: stepInstructions,
								messages: stepMessages,
								tools: stepTools,
								...stepCallSettings
							};
							const languageModelCallStartEvent = {
								callId,
								...languageModelCallContext
							};
							const stepStartTimestampMs = now$4();
							await notify({
								event: languageModelCallStartEvent,
								callbacks: [resolvedOnLanguageModelCallStart, telemetryDispatcher.onLanguageModelCallStart]
							});
							const executeLanguageModelCallInTelemetryContext = telemetryDispatcher.executeLanguageModelCall ?? (async ({ execute }) => await execute());
							currentModelResponse = await retry(async () => {
								const result = await executeLanguageModelCallInTelemetryContext({
									...languageModelCallStartEvent,
									execute: async () => await stepModel.doGenerate({
										...stepCallSettings,
										tools: stepTools,
										toolChoice: stepToolChoice,
										responseFormat: await output?.responseFormat,
										prompt: promptMessages,
										providerOptions: stepProviderOptions,
										abortSignal: mergedAbortSignal,
										headers: headersWithUserAgent
									})
								});
								const responseData = {
									id: result.response?.id ?? generateId(),
									timestamp: result.response?.timestamp ?? /* @__PURE__ */ new Date(),
									modelId: result.response?.modelId ?? stepModel.modelId,
									headers: result.response?.headers,
									body: result.response?.body
								};
								return {
									...result,
									response: responseData
								};
							});
							const responseTimeMs = now$4() - stepStartTimestampMs;
							const stepUsage = asLanguageModelUsage(currentModelResponse.usage);
							const stepToolCalls = await Promise.all(currentModelResponse.content.filter((part) => part.type === "tool-call").map((toolCall) => parseToolCall({
								toolCall,
								tools: stepModelTools,
								repairToolCall,
								refineToolInput,
								instructions: stepInstructions,
								messages: stepMessages,
								abortSignal: mergedAbortSignal
							})));
							const toolApprovalRequests = {};
							const stepToolApprovalResponses = {};
							const blockedToolCallIds = /* @__PURE__ */ new Set();
							const generatedFileDataCache = /* @__PURE__ */ new WeakMap();
							const modelCallContent = await convertLanguageModelContent({
								content: currentModelResponse.content,
								toolCalls: stepToolCalls,
								toolOutputs: [],
								toolApprovalRequests: [],
								toolApprovalResponses: [],
								tools,
								abortSignal: mergedAbortSignal,
								generatedFileDataCache
							});
							await notify({
								event: {
									callId,
									provider: stepModel.provider,
									modelId: currentModelResponse.response.modelId,
									finishReason: currentModelResponse.finishReason.unified,
									usage: stepUsage,
									content: modelCallContent,
									responseId: currentModelResponse.response.id,
									...currentModelResponse.providerMetadata != null ? { providerMetadata: currentModelResponse.providerMetadata } : {},
									performance: {
										responseTimeMs,
										effectiveOutputTokensPerSecond: calculateTokensPerSecond({
											tokens: stepUsage.outputTokens,
											durationMs: responseTimeMs
										}),
										outputTokensPerSecond: void 0,
										inputTokensPerSecond: void 0,
										effectiveTotalTokensPerSecond: calculateTokensPerSecond({
											tokens: sumTokenCounts(stepUsage.inputTokens, stepUsage.outputTokens),
											durationMs: responseTimeMs
										}),
										timeToFirstOutputMs: void 0
									}
								},
								callbacks: [resolvedOnLanguageModelCallEnd, telemetryDispatcher.onLanguageModelCallEnd]
							});
							const enforcedToolChoice = stepToolChoice.type === "required" || stepToolChoice.type === "tool" ? stepToolChoice : void 0;
							if (enforcedToolChoice != null && !stepToolCalls.some((toolCall) => enforcedToolChoice.type === "required" || toolCall.toolName === enforcedToolChoice.toolName)) throw new ToolChoiceViolationError({
								toolChoice: enforcedToolChoice,
								finishReason: currentModelResponse.finishReason.unified,
								provider: stepModel.provider,
								modelId: stepModel.modelId,
								content: currentModelResponse.content
							});
							for (const toolCall of stepToolCalls) {
								if (toolCall.invalid) continue;
								const tool = getOwn(stepExecutionTools, toolCall.toolName);
								if (tool == null) continue;
								if (tool.onInputStart != null || tool.onInputAvailable != null) {
									const context = await validateToolContext({
										toolName: toolCall.toolName,
										context: getOwn(toolsContext, toolCall.toolName),
										contextSchema: tool.contextSchema
									});
									if (tool.onInputStart != null) await tool.onInputStart({
										toolCallId: toolCall.toolCallId,
										messages: stepMessages,
										abortSignal: mergedAbortSignal,
										context
									});
									if (tool.onInputAvailable != null) await tool.onInputAvailable({
										input: toolCall.input,
										toolCallId: toolCall.toolCallId,
										messages: stepMessages,
										abortSignal: mergedAbortSignal,
										context
									});
								}
								const toolApprovalStatus = await resolveToolApproval({
									tools: stepExecutionTools,
									toolApproval,
									toolCall,
									messages: stepMessages,
									toolsContext,
									runtimeContext
								});
								if (toolApprovalStatus.type === "not-applicable") continue;
								const approvalId = generateId();
								const signature = await maybeSignApproval({
									secret: experimental_toolApprovalSecret,
									approvalId,
									toolCallId: toolCall.toolCallId,
									toolName: toolCall.toolName,
									input: toolCall.input
								});
								switch (toolApprovalStatus.type) {
									case "user-approval":
										toolApprovalRequests[toolCall.toolCallId] = {
											type: "tool-approval-request",
											approvalId,
											toolCall,
											...toolApprovalStatus.reason != null ? { reason: toolApprovalStatus.reason } : {},
											...signature != null ? { signature } : {}
										};
										blockedToolCallIds.add(toolCall.toolCallId);
										break;
									case "approved":
										toolApprovalRequests[toolCall.toolCallId] = {
											type: "tool-approval-request",
											approvalId,
											toolCall,
											isAutomatic: true,
											...signature != null ? { signature } : {}
										};
										stepToolApprovalResponses[toolCall.toolCallId] = {
											type: "tool-approval-response",
											approvalId,
											toolCall,
											approved: true,
											reason: toolApprovalStatus.reason,
											providerExecuted: toolCall.providerExecuted
										};
										break;
									case "denied":
										toolApprovalRequests[toolCall.toolCallId] = {
											type: "tool-approval-request",
											approvalId,
											toolCall,
											isAutomatic: true,
											...signature != null ? { signature } : {}
										};
										stepToolApprovalResponses[toolCall.toolCallId] = {
											type: "tool-approval-response",
											approvalId,
											toolCall,
											approved: false,
											reason: toolApprovalStatus.reason,
											providerExecuted: toolCall.providerExecuted
										};
										blockedToolCallIds.add(toolCall.toolCallId);
								}
							}
							const invalidToolCalls = stepToolCalls.filter((toolCall) => toolCall.invalid && toolCall.dynamic && !toolCall.providerExecuted);
							clientToolOutputs = [];
							for (const toolCall of invalidToolCalls) clientToolOutputs.push({
								type: "tool-error",
								toolCallId: toolCall.toolCallId,
								toolName: toolCall.toolName,
								input: toolCall.input,
								error: getErrorMessage(toolCall.error),
								dynamic: true
							});
							clientToolCalls = stepToolCalls.filter((toolCall) => !toolCall.providerExecuted);
							toolApprovalResponses = Object.values(stepToolApprovalResponses);
							deniedToolApprovalResponses = toolApprovalResponses.filter((toolApprovalResponse) => toolApprovalResponse.approved === false);
							const toolExecutionMs = {};
							if (stepExecutionTools != null && isToolExecutionAllowedFinishReason(currentModelResponse.finishReason.unified)) {
								const toolExecutionResults = await executeTools({
									toolCalls: clientToolCalls.filter((toolCall) => !toolCall.invalid && !blockedToolCallIds.has(toolCall.toolCallId)),
									tools: stepExecutionTools,
									callId,
									messages: stepMessages,
									abortSignal: mergedAbortSignal,
									timeout,
									experimental_sandbox: stepSandbox,
									toolsContext,
									onToolExecutionStart: (event) => notify({
										event,
										callbacks: [resolvedOnToolExecutionStart, telemetryDispatcher.onToolExecutionStart]
									}),
									onToolExecutionEnd: (event) => notify({
										event,
										callbacks: [resolvedOnToolExecutionEnd, telemetryDispatcher.onToolExecutionEnd]
									}),
									executeToolInTelemetryContext: telemetryDispatcher.executeTool,
									runInTracingChannelSpan,
									toolCallConcurrency: resolvedToolCallConcurrency
								});
								for (const result of toolExecutionResults) {
									toolExecutionMs[result.output.toolCallId] = result.toolExecutionMs;
									clientToolOutputs.push(result.output);
								}
							}
							const stepTimeMs = now$4() - stepStartTimestampMs;
							const stepPerformance = {
								effectiveOutputTokensPerSecond: calculateTokensPerSecond({
									tokens: stepUsage.outputTokens,
									durationMs: responseTimeMs
								}),
								outputTokensPerSecond: void 0,
								inputTokensPerSecond: void 0,
								effectiveTotalTokensPerSecond: calculateTokensPerSecond({
									tokens: sumTokenCounts(stepUsage.inputTokens, stepUsage.outputTokens),
									durationMs: responseTimeMs
								}),
								stepTimeMs,
								responseTimeMs,
								toolExecutionMs,
								timeToFirstOutputMs: void 0
							};
							for (const toolCall of stepToolCalls) {
								if (!toolCall.providerExecuted) continue;
								const tool = getOwn(stepExecutionTools, toolCall.toolName);
								if (tool?.type === "provider" && tool.supportsDeferredResults) {
									if (!currentModelResponse.content.some((part) => part.type === "tool-result" && part.toolCallId === toolCall.toolCallId)) pendingDeferredToolCalls.set(toolCall.toolCallId, { toolName: toolCall.toolName });
								}
							}
							for (const part of currentModelResponse.content) if (part.type === "tool-result") pendingDeferredToolCalls.delete(part.toolCallId);
							const stepContent = await convertLanguageModelContent({
								content: currentModelResponse.content,
								toolCalls: stepToolCalls,
								toolOutputs: clientToolOutputs,
								toolApprovalRequests: Object.values(toolApprovalRequests),
								toolApprovalResponses,
								tools,
								abortSignal: mergedAbortSignal,
								generatedFileDataCache
							});
							const stepResponseMessages = await toResponseMessages({
								content: stepContent,
								tools
							});
							const stepRequest = {
								...currentModelResponse.request,
								body: include.requestBody ? currentModelResponse.request?.body : void 0,
								messages: include.requestMessages ? cloneModelMessages(stepMessages) : void 0
							};
							const stepResponse = {
								...currentModelResponse.response,
								messages: cloneModelMessages(stepResponseMessages),
								body: include.responseBody ? currentModelResponse.response?.body : void 0
							};
							const currentStepResult = new DefaultStepResult({
								callId,
								stepNumber,
								provider: stepModel.provider,
								modelId: stepModel.modelId,
								runtimeContext,
								content: stepContent,
								finishReason: currentModelResponse.finishReason.unified,
								rawFinishReason: currentModelResponse.finishReason.raw,
								usage: stepUsage,
								performance: stepPerformance,
								warnings: currentModelResponse.warnings,
								providerMetadata: currentModelResponse.providerMetadata,
								request: stepRequest,
								response: stepResponse,
								toolsContext
							});
							logWarnings({
								warnings: currentModelResponse.warnings ?? [],
								provider: stepModel.provider,
								model: stepModel.modelId
							});
							steps.push(currentStepResult);
							instructionsForNextStep = stepInstructions;
							messagesForNextStep = [...stepMessages, ...stepResponseMessages];
							await notify({
								event: currentStepResult,
								callbacks: [resolvedOnStepEnd, telemetryDispatcher.onStepEnd]
							});
							return currentStepResult;
						}
					});
				} finally {
					if (stepTimeoutId != null) clearTimeout(stepTimeoutId);
				}
			} while (clientToolOutputs.length + deniedToolApprovalResponses.length === clientToolCalls.length && (clientToolCalls.length > 0 || pendingDeferredToolCalls.size > 0) && !await isStopConditionMet({
				stopConditions,
				steps
			}));
			const lastStep = steps[steps.length - 1];
			const totalUsage = steps.reduce((totalUsage, step) => {
				return addLanguageModelUsage(totalUsage, step.usage);
			}, {
				inputTokens: void 0,
				inputTokenDetails: {
					noCacheTokens: void 0,
					cacheReadTokens: void 0,
					cacheWriteTokens: void 0
				},
				outputTokens: void 0,
				outputTokenDetails: {
					textTokens: void 0,
					reasoningTokens: void 0
				},
				totalTokens: void 0
			});
			const files = steps.flatMap((step) => step.files);
			const sources = steps.flatMap((step) => step.sources);
			const toolCalls = steps.flatMap((step) => step.toolCalls);
			const staticToolCalls = steps.flatMap((step) => step.staticToolCalls);
			const dynamicToolCalls = steps.flatMap((step) => step.dynamicToolCalls);
			const toolResults = steps.flatMap((step) => step.toolResults);
			const staticToolResults = steps.flatMap((step) => step.staticToolResults);
			const dynamicToolResults = steps.flatMap((step) => step.dynamicToolResults);
			const warnings = steps.flatMap((step) => step.warnings ?? []);
			await notify({
				event: {
					callId,
					stepNumber: lastStep.stepNumber,
					model: lastStep.model,
					runtimeContext: lastStep.runtimeContext,
					finishReason: lastStep.finishReason,
					rawFinishReason: lastStep.rawFinishReason,
					usage: totalUsage,
					totalUsage,
					content: steps.flatMap((step) => step.content),
					text: lastStep.text,
					reasoning: lastStep.reasoning,
					reasoningText: lastStep.reasoningText,
					files,
					sources,
					toolCalls,
					staticToolCalls,
					dynamicToolCalls,
					toolResults,
					staticToolResults,
					dynamicToolResults,
					responseMessages: [...initialResponseMessages, ...steps.flatMap((step) => step.response.messages)],
					warnings,
					request: lastStep.request,
					response: lastStep.response,
					providerMetadata: lastStep.providerMetadata,
					steps,
					finalStep: lastStep,
					toolsContext
				},
				callbacks: [onEnd, telemetryDispatcher.onEnd]
			});
			let resolvedOutput;
			if (lastStep.finishReason === "stop" || lastStep.finishReason !== "tool-calls" && lastStep.text.length > 0) resolvedOutput = await (output ?? text()).parseCompleteOutput({ text: lastStep.text }, {
				response: lastStep.response,
				usage: lastStep.usage,
				finishReason: lastStep.finishReason
			});
			return new DefaultGenerateTextResult({
				initialResponseMessages,
				steps,
				totalUsage,
				output: resolvedOutput
			});
		} catch (error) {
			await telemetryDispatcher.onError?.({
				callId,
				error
			});
			throw wrapGatewayError(error);
		}
	};
	return await runInTracingChannelSpan({
		type: "generateText",
		event: generateTextStartEvent,
		execute: executeGenerateText
	});
}
async function executeTools({ toolCalls, tools, callId, messages, abortSignal, timeout, experimental_sandbox: sandbox, toolsContext, onToolExecutionStart, onToolExecutionEnd, executeToolInTelemetryContext, runInTracingChannelSpan, toolCallConcurrency }) {
	return (await mapWithConcurrency({
		items: toolCalls,
		concurrency: toolCallConcurrency,
		abortSignal,
		execute: async (toolCall) => await executeToolCall({
			toolCall,
			tools,
			callId,
			messages,
			abortSignal,
			timeout,
			experimental_sandbox: sandbox,
			toolsContext,
			onToolExecutionStart,
			onToolExecutionEnd,
			executeToolInTelemetryContext,
			runInTracingChannelSpan
		})
	})).filter((result) => result != null);
}
function prepareHeaders(headers, defaultHeaders) {
	const responseHeaders = new Headers(headers ?? {});
	for (const [key, value] of Object.entries(defaultHeaders)) if (!responseHeaders.has(key)) responseHeaders.set(key, value);
	return responseHeaders;
}
/**
* Creates a Response object from a text stream.
* Each text chunk is encoded as UTF-8 and sent as a separate chunk.
* Sets a `Content-Type` header to `text/plain; charset=utf-8`.
*
* @param options - The options for creating the response.
* @param options.status - Optional HTTP status code (default: 200).
* @param options.statusText - Optional HTTP status text.
* @param options.headers - Optional response headers.
* @param options.stream - The text stream to send.
* @returns A Response object with the text stream body.
*/
function createTextStreamResponse({ status, statusText, headers, stream }) {
	return new Response(stream.pipeThrough(new TextEncoderStream()), {
		status: status ?? 200,
		statusText,
		headers: prepareHeaders(headers, { "content-type": "text/plain; charset=utf-8" })
	});
}
/**
* Writes the content of a stream to a server response.
*
* When the client disconnects before the stream has been fully written
* (premature `close`), the stream is cancelled so that upstream resources
* can be released, and no further chunks are written.
*/
function writeToServerResponse({ response, status, statusText, headers, stream }) {
	const statusCode = status ?? 200;
	if (headers != null) response.setHeaders(headers);
	if (statusText !== void 0) response.writeHead(statusCode, statusText);
	else response.writeHead(statusCode);
	const reader = stream.getReader();
	let clientDisconnected = false;
	let onDisconnect;
	const handleClose = () => {
		if (response.writableFinished) return;
		clientDisconnected = true;
		onDisconnect?.();
		reader.cancel(/* @__PURE__ */ new Error("Client disconnected.")).catch(() => {});
	};
	response.once("close", handleClose);
	if (response.destroyed) handleClose();
	const read = async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done || clientDisconnected || response.destroyed) break;
				const canContinue = response.write(value);
				const flush = response.flush;
				if (typeof flush === "function") flush.call(response);
				if (!canContinue) {
					await new Promise((resolve) => {
						onDisconnect = resolve;
						response.once("drain", resolve);
					});
					onDisconnect = void 0;
				}
			}
		} finally {
			response.off("close", handleClose);
			if (clientDisconnected || response.destroyed) reader.cancel().catch(() => {});
			else response.end();
		}
	};
	return read();
}
/**
* Writes a text stream to a Node.js ServerResponse object.
* Each text chunk is encoded as UTF-8 and written as a separate chunk.
* Sets a `Content-Type` header to `text/plain; charset=utf-8`.
*
* @param options - The options for piping the stream.
* @param options.response - The Node.js ServerResponse to write to.
* @param options.status - Optional HTTP status code.
* @param options.statusText - Optional HTTP status text.
* @param options.headers - Optional response headers.
* @param options.stream - The text stream to pipe.
* @returns A promise that resolves when the stream has been written.
*/
function pipeTextStreamToResponse({ response, status, statusText, headers, stream }) {
	return writeToServerResponse({
		response,
		status,
		statusText,
		headers: prepareHeaders(headers, { "content-type": "text/plain; charset=utf-8" }),
		stream: stream.pipeThrough(new TextEncoderStream())
	});
}
/**
* Converts a stream of `TextStreamPart` chunks into a stream of text deltas.
*/
function toTextStream({ stream }) {
	return stream.pipeThrough(new TransformStream({ transform(part, controller) {
		if (part.type === "text-delta") controller.enqueue(part.text);
	} }));
}
const STREAM_OPEN_COMMENT = ": stream-open\n\n";
const KEEP_ALIVE_COMMENT = ": keep-alive\n\n";
function createSseStreamWithKeepAlive({ stream, keepAliveMs }) {
	if (keepAliveMs == null) return stream;
	if (!Number.isFinite(keepAliveMs) || keepAliveMs <= 0 || keepAliveMs > 2147483647) throw new Error("keepAliveMs must be a positive finite timer duration no greater than 2147483647");
	const reader = stream.getReader();
	let keepAliveTimeout;
	let isCancelled = false;
	const clearKeepAliveTimeout = () => {
		clearTimeout(keepAliveTimeout);
		keepAliveTimeout = void 0;
	};
	const scheduleKeepAlive = (controller) => {
		clearKeepAliveTimeout();
		keepAliveTimeout = setTimeout(() => {
			if (isCancelled) return;
			if (controller.desiredSize != null && controller.desiredSize > 0) controller.enqueue(KEEP_ALIVE_COMMENT);
			scheduleKeepAlive(controller);
		}, keepAliveMs);
	};
	return new ReadableStream({
		start(controller) {
			controller.enqueue(STREAM_OPEN_COMMENT);
			scheduleKeepAlive(controller);
		},
		pull(controller) {
			return reader.read().then((result) => {
				clearKeepAliveTimeout();
				if (isCancelled) return;
				if (result.done) controller.close();
				else {
					controller.enqueue(result.value);
					scheduleKeepAlive(controller);
				}
			}, (error) => {
				clearKeepAliveTimeout();
				if (!isCancelled) throw error;
			});
		},
		async cancel(reason) {
			isCancelled = true;
			clearKeepAliveTimeout();
			await reader.cancel(reason);
		}
	});
}
/**
* A TransformStream that converts JSON objects to Server-Sent Events (SSE) format.
* Each object is serialized to JSON and wrapped in `data: ...\n\n` format.
* When the stream ends, a `data: [DONE]\n\n` message is sent.
*/
var JsonToSseTransformStream = class extends TransformStream {
	constructor() {
		super({
			transform(part, controller) {
				controller.enqueue(`data: ${JSON.stringify(part)}\n\n`);
			},
			flush(controller) {
				controller.enqueue("data: [DONE]\n\n");
			}
		});
	}
};
const UI_MESSAGE_STREAM_HEADERS = {
	"content-type": "text/event-stream",
	"cache-control": "no-cache",
	connection: "keep-alive",
	"x-vercel-ai-ui-message-stream": "v1",
	"x-accel-buffering": "no"
};
/**
* Creates a Response object from a UI message stream.
* The stream is transformed to Server-Sent Events (SSE) format.
*
* @param options.status - The HTTP status code for the response.
* @param options.statusText - The HTTP status text for the response.
* @param options.headers - Additional HTTP headers to include in the response.
* @param options.stream - The UI message chunk stream to send.
* @param options.keepAliveMs - Optional interval for sending SSE keep-alive comments.
* @param options.consumeSseStream - Optional callback to consume a copy of the SSE stream independently.
*
* @returns A `Response` object with the UI message stream as the body.
*/
function createUIMessageStreamResponse({ status, statusText, headers, stream, keepAliveMs, consumeSseStream }) {
	let sseStream = createSseStreamWithKeepAlive({
		stream: stream.pipeThrough(new JsonToSseTransformStream()),
		keepAliveMs
	});
	if (consumeSseStream) {
		const [stream1, stream2] = sseStream.tee();
		sseStream = stream1;
		consumeSseStream({ stream: stream2 });
	}
	return new Response(sseStream.pipeThrough(new TextEncoderStream()), {
		status,
		statusText,
		headers: prepareHeaders(headers, UI_MESSAGE_STREAM_HEADERS)
	});
}
/**
* Pipes a UI message stream to a Node.js ServerResponse object.
* The stream is transformed to Server-Sent Events (SSE) format.
*
* @param options.response - The Node.js ServerResponse object to write to.
* @param options.status - The HTTP status code for the response.
* @param options.statusText - The HTTP status text for the response.
* @param options.headers - Additional HTTP headers to include in the response.
* @param options.stream - The UI message chunk stream to send.
* @param options.keepAliveMs - Optional interval for sending SSE keep-alive comments.
* @param options.consumeSseStream - Optional callback to consume a copy of the SSE stream independently.
* @returns A promise that resolves when the stream has been written.
*/
function pipeUIMessageStreamToResponse({ response, status, statusText, headers, stream, keepAliveMs, consumeSseStream }) {
	let sseStream = createSseStreamWithKeepAlive({
		stream: stream.pipeThrough(new JsonToSseTransformStream()),
		keepAliveMs
	});
	if (consumeSseStream) {
		const [stream1, stream2] = sseStream.tee();
		sseStream = stream1;
		consumeSseStream({ stream: stream2 });
	}
	return writeToServerResponse({
		response,
		status,
		statusText,
		headers: prepareHeaders(headers, UI_MESSAGE_STREAM_HEADERS),
		stream: sseStream.pipeThrough(new TextEncoderStream())
	});
}
/**
* Determines the message ID to use for a response message.
* If the last message is an assistant message, its ID is reused (continuation).
* Otherwise, a new ID is generated or the provided ID is used.
*
* @param options.originalMessages - The original messages. If not provided, returns `undefined`
*   since client-side ID generation is used in non-persistence mode.
* @param options.responseMessageId - The response message ID or an ID generator function.
*
* @returns The message ID to use, or `undefined` if no persistence mode.
*/
function getResponseUIMessageId({ originalMessages, responseMessageId }) {
	if (originalMessages == null) return;
	const lastMessage = originalMessages[originalMessages.length - 1];
	return lastMessage?.role === "assistant" ? lastMessage.id : typeof responseMessageId === "function" ? responseMessageId() : responseMessageId;
}
const citationSchema = z.object({
	source: z.discriminatedUnion("sourceType", [z.object({
		type: z.literal("source"),
		sourceType: z.literal("url"),
		id: z.string(),
		url: z.string(),
		title: z.string().optional(),
		providerMetadata: providerMetadataSchema.optional()
	}), z.object({
		type: z.literal("source"),
		sourceType: z.literal("document"),
		id: z.string(),
		mediaType: z.string(),
		title: z.string(),
		filename: z.string().optional(),
		providerMetadata: providerMetadataSchema.optional()
	})]),
	startIndex: z.number().int().nonnegative().optional(),
	endIndex: z.number().int().nonnegative().optional(),
	citedText: z.string().optional()
});
const toolMetadataSchema$1 = z.record(z.string(), jsonValueSchema.optional());
lazySchema(() => zodSchema(z.union([
	z.looseObject({
		type: z.literal("text-start"),
		id: z.string(),
		providerMetadata: providerMetadataSchema.optional()
	}),
	z.looseObject({
		type: z.literal("text-delta"),
		id: z.string(),
		delta: z.string(),
		providerMetadata: providerMetadataSchema.optional()
	}),
	z.looseObject({
		type: z.literal("text-end"),
		id: z.string(),
		citations: z.array(citationSchema).optional(),
		providerMetadata: providerMetadataSchema.optional()
	}),
	z.looseObject({
		type: z.literal("error"),
		errorText: z.string()
	}),
	z.looseObject({
		type: z.literal("tool-input-start"),
		toolCallId: z.string(),
		toolName: z.string(),
		providerExecuted: z.boolean().optional(),
		providerMetadata: providerMetadataSchema.optional(),
		toolMetadata: toolMetadataSchema$1.optional(),
		dynamic: z.boolean().optional(),
		title: z.string().optional()
	}),
	z.looseObject({
		type: z.literal("tool-input-delta"),
		toolCallId: z.string(),
		inputTextDelta: z.string()
	}),
	z.looseObject({
		type: z.literal("tool-input-available"),
		toolCallId: z.string(),
		toolName: z.string(),
		input: z.unknown(),
		providerExecuted: z.boolean().optional(),
		providerMetadata: providerMetadataSchema.optional(),
		toolMetadata: toolMetadataSchema$1.optional(),
		dynamic: z.boolean().optional(),
		title: z.string().optional()
	}),
	z.looseObject({
		type: z.literal("tool-input-error"),
		toolCallId: z.string(),
		toolName: z.string(),
		input: z.unknown(),
		providerExecuted: z.boolean().optional(),
		providerMetadata: providerMetadataSchema.optional(),
		toolMetadata: toolMetadataSchema$1.optional(),
		dynamic: z.boolean().optional(),
		errorText: z.string(),
		title: z.string().optional()
	}),
	z.looseObject({
		type: z.literal("tool-approval-request"),
		approvalId: z.string(),
		toolCallId: z.string(),
		approvalDescriptor: z.unknown().optional(),
		inputSchemaInput: z.unknown().optional(),
		reason: z.string().optional(),
		isAutomatic: z.boolean().optional(),
		signature: z.string().optional()
	}),
	z.looseObject({
		type: z.literal("tool-approval-response"),
		approvalId: z.string(),
		approved: z.boolean(),
		reason: z.string().optional(),
		providerExecuted: z.boolean().optional(),
		providerMetadata: providerMetadataSchema.optional()
	}),
	z.looseObject({
		type: z.literal("tool-output-available"),
		toolCallId: z.string(),
		output: z.unknown(),
		providerExecuted: z.boolean().optional(),
		providerMetadata: providerMetadataSchema.optional(),
		toolMetadata: toolMetadataSchema$1.optional(),
		dynamic: z.boolean().optional(),
		preliminary: z.boolean().optional()
	}),
	z.looseObject({
		type: z.literal("tool-output-error"),
		toolCallId: z.string(),
		errorText: z.string(),
		providerExecuted: z.boolean().optional(),
		providerMetadata: providerMetadataSchema.optional(),
		toolMetadata: toolMetadataSchema$1.optional(),
		dynamic: z.boolean().optional()
	}),
	z.looseObject({
		type: z.literal("tool-output-denied"),
		toolCallId: z.string()
	}),
	z.looseObject({
		type: z.literal("reasoning-start"),
		id: z.string(),
		providerMetadata: providerMetadataSchema.optional()
	}),
	z.looseObject({
		type: z.literal("reasoning-delta"),
		id: z.string(),
		delta: z.string(),
		providerMetadata: providerMetadataSchema.optional()
	}),
	z.looseObject({
		type: z.literal("reasoning-end"),
		id: z.string(),
		providerMetadata: providerMetadataSchema.optional()
	}),
	z.looseObject({
		type: z.literal("custom"),
		kind: z.string().transform((value) => value),
		providerMetadata: providerMetadataSchema.optional()
	}),
	z.looseObject({
		type: z.literal("source-url"),
		sourceId: z.string(),
		url: z.string(),
		title: z.string().optional(),
		providerMetadata: providerMetadataSchema.optional()
	}),
	z.looseObject({
		type: z.literal("source-document"),
		sourceId: z.string(),
		mediaType: z.string(),
		title: z.string(),
		filename: z.string().optional(),
		providerMetadata: providerMetadataSchema.optional()
	}),
	z.looseObject({
		type: z.literal("file"),
		url: z.string(),
		mediaType: z.string(),
		providerMetadata: providerMetadataSchema.optional()
	}),
	z.looseObject({
		type: z.literal("reasoning-file"),
		url: z.string(),
		mediaType: z.string(),
		providerMetadata: providerMetadataSchema.optional()
	}),
	z.looseObject({
		type: z.custom((value) => typeof value === "string" && value.startsWith("data-"), { message: "Type must start with \"data-\"" }),
		id: z.string().optional(),
		data: z.unknown(),
		transient: z.boolean().optional()
	}),
	z.looseObject({ type: z.literal("start-step") }),
	z.looseObject({ type: z.literal("finish-step") }),
	z.looseObject({ type: z.literal("reset-step") }),
	z.looseObject({
		type: z.literal("start"),
		messageId: z.string().optional(),
		messageMetadata: z.unknown().optional()
	}),
	z.looseObject({
		type: z.literal("finish"),
		finishReason: z.enum([
			"stop",
			"length",
			"content-filter",
			"tool-calls",
			"error",
			"other"
		]).optional(),
		messageMetadata: z.unknown().optional()
	}),
	z.looseObject({
		type: z.literal("abort"),
		reason: z.string().optional()
	}),
	z.looseObject({
		type: z.literal("message-metadata"),
		messageMetadata: z.unknown()
	})
])));
function isDataUIMessageChunk(chunk) {
	return chunk.type.startsWith("data-");
}
/**
* Creates a string-keyed map without an object prototype.
*
* Use this for lookup tables keyed by IDs or names that may come from outside
* the SDK, such as streamed chunk IDs or tool call IDs. Unlike `{}`, these maps
* do not inherit `__proto__`, `constructor`, or other Object prototype members,
* so a missing untrusted key cannot resolve to a shared prototype object.
*/
function createIdMap() {
	return Object.create(null);
}
/**
* Check if a message part is a static tool part.
*
* Static tools are tools for which the types are known at development time.
*/
function isStaticToolUIPart(part) {
	return part.type.startsWith("tool-");
}
/**
* Check if a message part is a dynamic tool part.
*
* Dynamic tools are tools for which the input and output types are unknown.
*/
function isDynamicToolUIPart(part) {
	return part.type === "dynamic-tool";
}
/**
* Check if a message part is a tool part.
*
* Tool parts are either static or dynamic tools.
*
* Use `isStaticToolUIPart` or `isDynamicToolUIPart` to check the type of the tool.
*/
function isToolUIPart(part) {
	return isStaticToolUIPart(part) || isDynamicToolUIPart(part);
}
/**
* Returns the name of the static tool.
*
* The possible values are the keys of the tool set.
*/
function getStaticToolName(part) {
	return part.type.split("-").slice(1).join("-");
}
function createStreamingUIMessageState({ lastMessage, messageId }) {
	const message = lastMessage?.role === "assistant" ? lastMessage : {
		id: messageId,
		metadata: void 0,
		role: "assistant",
		parts: []
	};
	const partialToolCalls = createIdMap();
	const lastStepStartIndex = message.parts.findLastIndex((part) => part.type === "step-start");
	let staticToolIndex = 0;
	for (const part of message.parts.slice(lastStepStartIndex + 1)) {
		if (!isToolUIPart(part)) continue;
		const index = staticToolIndex;
		if (isStaticToolUIPart(part)) staticToolIndex++;
		if (part.state !== "input-streaming") continue;
		partialToolCalls[part.toolCallId] = {
			text: part.rawInput ?? "",
			index,
			toolName: part.type === "dynamic-tool" ? part.toolName : getStaticToolName(part),
			dynamic: part.type === "dynamic-tool",
			title: part.title,
			toolMetadata: part.toolMetadata
		};
	}
	return {
		message,
		activeTextParts: createIdMap(),
		activeReasoningParts: createIdMap(),
		partialToolCalls
	};
}
function processUIMessageStream({ stream, messageMetadataSchema, dataPartSchemas, runUpdateMessageJob, onError, onToolCall, onData, resetStateOnMessageIdChange = false, resetStateOnFirstMessageStart = false }) {
	let isFirstMessageStart = true;
	return stream.pipeThrough(new TransformStream({ async transform(chunk, controller) {
		await runUpdateMessageJob(async ({ state, write }) => {
			function getCurrentStepParts() {
				const parts = state.message.parts;
				let currentStepStartIndex = parts.length - 1;
				while (currentStepStartIndex >= 0 && parts[currentStepStartIndex].type !== "step-start") currentStepStartIndex--;
				return parts.slice(currentStepStartIndex + 1);
			}
			function getCurrentStepToolInvocations() {
				return getCurrentStepParts().filter(isToolUIPart);
			}
			function getToolInvocation(toolCallId) {
				let toolInvocation = getCurrentStepToolInvocations().find((invocation) => invocation.toolCallId === toolCallId);
				if (toolInvocation == null) {
					const parts = state.message.parts;
					for (let i = parts.length - 1; i >= 0; i--) {
						const part = parts[i];
						if (isToolUIPart(part) && part.toolCallId === toolCallId) {
							toolInvocation = part;
							break;
						}
					}
				}
				if (toolInvocation == null) throw new UIMessageStreamError({
					chunkType: "tool-invocation",
					chunkId: toolCallId,
					message: `No tool invocation found for tool call ID "${toolCallId}".`
				});
				return toolInvocation;
			}
			function getToolInvocationByApprovalId(approvalId) {
				const toolInvocation = state.message.parts.filter(isToolUIPart).find((invocation) => invocation.approval?.id === approvalId);
				if (toolInvocation == null) throw new UIMessageStreamError({
					chunkType: "tool-approval-response",
					chunkId: approvalId,
					message: `No tool invocation found for approval ID "${approvalId}".`
				});
				return toolInvocation;
			}
			function updateToolPart(options, existingPart) {
				const part = existingPart ?? getCurrentStepParts().find((part) => isStaticToolUIPart(part) && part.toolCallId === options.toolCallId);
				const anyOptions = options;
				const anyPart = part;
				if (part != null) {
					part.state = options.state;
					anyPart.input = anyOptions.input;
					anyPart.output = anyOptions.output;
					anyPart.errorText = anyOptions.errorText;
					anyPart.rawInput = anyOptions.rawInput;
					anyPart.preliminary = anyOptions.preliminary;
					if (options.title !== void 0) anyPart.title = options.title;
					if (options.toolMetadata !== void 0) anyPart.toolMetadata = options.toolMetadata;
					anyPart.providerExecuted = anyOptions.providerExecuted ?? part.providerExecuted;
					const providerMetadata = anyOptions.providerMetadata;
					if (providerMetadata != null) {
						if (options.state === "output-available" || options.state === "output-error") {
							const resultPart = part;
							resultPart.resultProviderMetadata = providerMetadata;
						} else part.callProviderMetadata = providerMetadata;
					}
				} else state.message.parts.push({
					type: `tool-${options.toolName}`,
					toolCallId: options.toolCallId,
					state: options.state,
					title: options.title,
					...options.toolMetadata !== void 0 ? { toolMetadata: options.toolMetadata } : {},
					input: anyOptions.input,
					output: anyOptions.output,
					rawInput: anyOptions.rawInput,
					errorText: anyOptions.errorText,
					providerExecuted: anyOptions.providerExecuted,
					preliminary: anyOptions.preliminary,
					...anyOptions.providerMetadata != null && (options.state === "output-available" || options.state === "output-error") ? { resultProviderMetadata: anyOptions.providerMetadata } : {},
					...anyOptions.providerMetadata != null && !(options.state === "output-available" || options.state === "output-error") ? { callProviderMetadata: anyOptions.providerMetadata } : {}
				});
			}
			function updateDynamicToolPart(options, existingPart) {
				const part = existingPart ?? getCurrentStepParts().find((part) => part.type === "dynamic-tool" && part.toolCallId === options.toolCallId);
				const anyOptions = options;
				const anyPart = part;
				if (part != null) {
					part.state = options.state;
					anyPart.toolName = options.toolName;
					anyPart.input = anyOptions.input;
					anyPart.output = anyOptions.output;
					anyPart.errorText = anyOptions.errorText;
					anyPart.rawInput = anyOptions.rawInput;
					anyPart.preliminary = anyOptions.preliminary;
					if (options.title !== void 0) anyPart.title = options.title;
					if (options.toolMetadata !== void 0) anyPart.toolMetadata = options.toolMetadata;
					anyPart.providerExecuted = anyOptions.providerExecuted ?? part.providerExecuted;
					const providerMetadata = anyOptions.providerMetadata;
					if (providerMetadata != null) {
						if (options.state === "output-available" || options.state === "output-error") {
							const resultPart = part;
							resultPart.resultProviderMetadata = providerMetadata;
						} else part.callProviderMetadata = providerMetadata;
					}
				} else state.message.parts.push({
					type: "dynamic-tool",
					toolName: options.toolName,
					toolCallId: options.toolCallId,
					state: options.state,
					input: anyOptions.input,
					output: anyOptions.output,
					errorText: anyOptions.errorText,
					preliminary: anyOptions.preliminary,
					providerExecuted: anyOptions.providerExecuted,
					title: options.title,
					...options.toolMetadata !== void 0 ? { toolMetadata: options.toolMetadata } : {},
					...anyOptions.providerMetadata != null && (options.state === "output-available" || options.state === "output-error") ? { resultProviderMetadata: anyOptions.providerMetadata } : {},
					...anyOptions.providerMetadata != null && !(options.state === "output-available" || options.state === "output-error") ? { callProviderMetadata: anyOptions.providerMetadata } : {}
				});
			}
			async function updateMessageMetadata(metadata) {
				if (metadata != null) {
					const mergedMetadata = state.message.metadata != null ? mergeObjects(state.message.metadata, metadata) : metadata;
					if (messageMetadataSchema != null) await validateTypes({
						value: mergedMetadata,
						schema: messageMetadataSchema,
						context: {
							field: "message.metadata",
							entityId: state.message.id
						}
					});
					state.message.metadata = mergedMetadata;
				}
			}
			switch (chunk.type) {
				case "text-start": {
					const textPart = {
						type: "text",
						text: "",
						providerMetadata: chunk.providerMetadata,
						state: "streaming"
					};
					state.activeTextParts[chunk.id] = textPart;
					state.message.parts.push(textPart);
					write();
					break;
				}
				case "text-delta": {
					const textPart = state.activeTextParts[chunk.id];
					if (textPart == null) throw new UIMessageStreamError({
						chunkType: "text-delta",
						chunkId: chunk.id,
						message: `Received text-delta for missing text part with ID "${chunk.id}". Ensure a "text-start" chunk is sent before any "text-delta" chunks.`
					});
					textPart.text += chunk.delta;
					textPart.providerMetadata = chunk.providerMetadata ?? textPart.providerMetadata;
					write();
					break;
				}
				case "text-end": {
					const textPart = state.activeTextParts[chunk.id];
					if (textPart == null) throw new UIMessageStreamError({
						chunkType: "text-end",
						chunkId: chunk.id,
						message: `Received text-end for missing text part with ID "${chunk.id}". Ensure a "text-start" chunk is sent before any "text-end" chunks.`
					});
					textPart.state = "done";
					if (chunk.citations != null) textPart.citations = chunk.citations;
					textPart.providerMetadata = chunk.providerMetadata ?? textPart.providerMetadata;
					delete state.activeTextParts[chunk.id];
					write();
					break;
				}
				case "custom": {
					const customPart = {
						type: "custom",
						kind: chunk.kind,
						providerMetadata: chunk.providerMetadata
					};
					state.message.parts.push(customPart);
					write();
					break;
				}
				case "reasoning-start": {
					const reasoningPart = {
						type: "reasoning",
						id: chunk.id,
						text: "",
						providerMetadata: chunk.providerMetadata,
						state: "streaming"
					};
					state.activeReasoningParts[chunk.id] = reasoningPart;
					state.message.parts.push(reasoningPart);
					write();
					break;
				}
				case "reasoning-delta": {
					const reasoningPart = state.activeReasoningParts[chunk.id];
					if (reasoningPart == null) throw new UIMessageStreamError({
						chunkType: "reasoning-delta",
						chunkId: chunk.id,
						message: `Received reasoning-delta for missing reasoning part with ID "${chunk.id}". Ensure a "reasoning-start" chunk is sent before any "reasoning-delta" chunks.`
					});
					reasoningPart.text += chunk.delta;
					reasoningPart.providerMetadata = chunk.providerMetadata ?? reasoningPart.providerMetadata;
					write();
					break;
				}
				case "reasoning-end": {
					const reasoningPart = state.activeReasoningParts[chunk.id];
					if (reasoningPart == null) throw new UIMessageStreamError({
						chunkType: "reasoning-end",
						chunkId: chunk.id,
						message: `Received reasoning-end for missing reasoning part with ID "${chunk.id}". Ensure a "reasoning-start" chunk is sent before any "reasoning-end" chunks.`
					});
					reasoningPart.providerMetadata = chunk.providerMetadata ?? reasoningPart.providerMetadata;
					reasoningPart.state = "done";
					delete state.activeReasoningParts[chunk.id];
					write();
					break;
				}
				case "file":
				case "reasoning-file":
					state.message.parts.push({
						type: chunk.type,
						mediaType: chunk.mediaType,
						url: chunk.url,
						...chunk.providerMetadata != null ? { providerMetadata: chunk.providerMetadata } : {}
					});
					write();
					break;
				case "source-url":
					state.message.parts.push({
						type: "source-url",
						sourceId: chunk.sourceId,
						url: chunk.url,
						title: chunk.title,
						providerMetadata: chunk.providerMetadata
					});
					write();
					break;
				case "source-document":
					state.message.parts.push({
						type: "source-document",
						sourceId: chunk.sourceId,
						mediaType: chunk.mediaType,
						title: chunk.title,
						filename: chunk.filename,
						providerMetadata: chunk.providerMetadata
					});
					write();
					break;
				case "tool-input-start": {
					const toolInvocations = getCurrentStepParts().filter(isStaticToolUIPart);
					state.partialToolCalls[chunk.toolCallId] = {
						text: "",
						toolName: chunk.toolName,
						index: toolInvocations.length,
						dynamic: chunk.dynamic,
						title: chunk.title,
						toolMetadata: chunk.toolMetadata
					};
					if (chunk.dynamic) updateDynamicToolPart({
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						state: "input-streaming",
						input: void 0,
						providerExecuted: chunk.providerExecuted,
						title: chunk.title,
						toolMetadata: chunk.toolMetadata,
						providerMetadata: chunk.providerMetadata
					});
					else updateToolPart({
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						state: "input-streaming",
						input: void 0,
						providerExecuted: chunk.providerExecuted,
						title: chunk.title,
						toolMetadata: chunk.toolMetadata,
						providerMetadata: chunk.providerMetadata
					});
					write();
					break;
				}
				case "tool-input-delta": {
					const partialToolCall = state.partialToolCalls[chunk.toolCallId];
					if (partialToolCall == null) throw new UIMessageStreamError({
						chunkType: "tool-input-delta",
						chunkId: chunk.toolCallId,
						message: `Received tool-input-delta for missing tool call with ID "${chunk.toolCallId}". Ensure a "tool-input-start" chunk is sent before any "tool-input-delta" chunks.`
					});
					partialToolCall.text += chunk.inputTextDelta;
					const { value: partialArgs } = await parsePartialJson(partialToolCall.text);
					if (partialToolCall.dynamic) updateDynamicToolPart({
						toolCallId: chunk.toolCallId,
						toolName: partialToolCall.toolName,
						state: "input-streaming",
						input: partialArgs,
						rawInput: partialToolCall.text,
						title: partialToolCall.title,
						toolMetadata: partialToolCall.toolMetadata
					});
					else updateToolPart({
						toolCallId: chunk.toolCallId,
						toolName: partialToolCall.toolName,
						state: "input-streaming",
						input: partialArgs,
						rawInput: partialToolCall.text,
						title: partialToolCall.title,
						toolMetadata: partialToolCall.toolMetadata
					});
					write();
					break;
				}
				case "tool-input-available":
					if (chunk.dynamic) updateDynamicToolPart({
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						state: "input-available",
						input: chunk.input,
						providerExecuted: chunk.providerExecuted,
						providerMetadata: chunk.providerMetadata,
						title: chunk.title,
						toolMetadata: chunk.toolMetadata
					});
					else updateToolPart({
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						state: "input-available",
						input: chunk.input,
						providerExecuted: chunk.providerExecuted,
						providerMetadata: chunk.providerMetadata,
						title: chunk.title,
						toolMetadata: chunk.toolMetadata
					});
					write();
					if (onToolCall && !chunk.providerExecuted) await onToolCall({ toolCall: chunk });
					break;
				case "tool-input-error": {
					const existingPart = getCurrentStepParts().filter(isToolUIPart).find((p) => p.toolCallId === chunk.toolCallId);
					if (existingPart != null ? existingPart.type === "dynamic-tool" : !!chunk.dynamic) updateDynamicToolPart({
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						state: "output-error",
						input: chunk.input,
						errorText: chunk.errorText,
						providerExecuted: chunk.providerExecuted,
						providerMetadata: chunk.providerMetadata,
						toolMetadata: chunk.toolMetadata
					});
					else updateToolPart({
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						state: "output-error",
						input: chunk.input,
						errorText: chunk.errorText,
						providerExecuted: chunk.providerExecuted,
						providerMetadata: chunk.providerMetadata,
						toolMetadata: chunk.toolMetadata
					});
					write();
					break;
				}
				case "tool-approval-request": {
					const toolInvocation = getToolInvocation(chunk.toolCallId);
					toolInvocation.state = "approval-requested";
					toolInvocation.approval = {
						id: chunk.approvalId,
						...chunk.approvalDescriptor != null ? { descriptor: chunk.approvalDescriptor } : {},
						...Object.prototype.hasOwnProperty.call(chunk, "inputSchemaInput") ? { inputSchemaInput: chunk.inputSchemaInput } : {},
						...chunk.reason != null ? { requestReason: chunk.reason } : {},
						...chunk.isAutomatic === true ? { isAutomatic: true } : {},
						...chunk.signature != null ? { signature: chunk.signature } : {}
					};
					write();
					break;
				}
				case "tool-approval-response": {
					const toolInvocation = getToolInvocationByApprovalId(chunk.approvalId);
					const approval = toolInvocation.approval == null ? { id: chunk.approvalId } : toolInvocation.approval;
					toolInvocation.state = "approval-responded";
					toolInvocation.approval = {
						...approval,
						id: chunk.approvalId,
						approved: chunk.approved,
						...chunk.reason != null ? { reason: chunk.reason } : {}
					};
					if (chunk.providerExecuted != null) toolInvocation.providerExecuted = chunk.providerExecuted;
					if (chunk.providerMetadata != null) toolInvocation.callProviderMetadata = chunk.providerMetadata;
					write();
					break;
				}
				case "tool-output-denied": {
					const toolInvocation = getToolInvocation(chunk.toolCallId);
					toolInvocation.state = "output-denied";
					write();
					break;
				}
				case "tool-output-available": {
					const toolInvocation = getToolInvocation(chunk.toolCallId);
					if (toolInvocation.type === "dynamic-tool") updateDynamicToolPart({
						toolCallId: chunk.toolCallId,
						toolName: toolInvocation.toolName,
						state: "output-available",
						input: toolInvocation.input,
						output: chunk.output,
						preliminary: chunk.preliminary,
						providerExecuted: chunk.providerExecuted,
						providerMetadata: chunk.providerMetadata,
						title: toolInvocation.title,
						toolMetadata: chunk.toolMetadata ?? toolInvocation.toolMetadata
					}, toolInvocation);
					else updateToolPart({
						toolCallId: chunk.toolCallId,
						toolName: getStaticToolName(toolInvocation),
						state: "output-available",
						input: toolInvocation.input,
						output: chunk.output,
						providerExecuted: chunk.providerExecuted,
						preliminary: chunk.preliminary,
						providerMetadata: chunk.providerMetadata,
						title: toolInvocation.title,
						toolMetadata: chunk.toolMetadata ?? toolInvocation.toolMetadata
					}, toolInvocation);
					write();
					break;
				}
				case "tool-output-error": {
					const toolInvocation = getToolInvocation(chunk.toolCallId);
					if (toolInvocation.type === "dynamic-tool") updateDynamicToolPart({
						toolCallId: chunk.toolCallId,
						toolName: toolInvocation.toolName,
						state: "output-error",
						input: toolInvocation.input,
						errorText: chunk.errorText,
						providerExecuted: chunk.providerExecuted,
						providerMetadata: chunk.providerMetadata,
						title: toolInvocation.title,
						toolMetadata: chunk.toolMetadata ?? toolInvocation.toolMetadata
					}, toolInvocation);
					else updateToolPart({
						toolCallId: chunk.toolCallId,
						toolName: getStaticToolName(toolInvocation),
						state: "output-error",
						input: toolInvocation.input,
						rawInput: toolInvocation.rawInput,
						errorText: chunk.errorText,
						providerExecuted: chunk.providerExecuted,
						providerMetadata: chunk.providerMetadata,
						title: toolInvocation.title,
						toolMetadata: chunk.toolMetadata ?? toolInvocation.toolMetadata
					}, toolInvocation);
					write();
					break;
				}
				case "start-step":
					state.message.parts.push({ type: "step-start" });
					break;
				case "finish-step": break;
				case "reset-step": {
					const currentStepParts = getCurrentStepParts();
					state.activeTextParts = createIdMap();
					state.activeReasoningParts = createIdMap();
					state.partialToolCalls = createIdMap();
					if (currentStepParts.length > 0) {
						state.message.parts.splice(state.message.parts.length - currentStepParts.length, currentStepParts.length);
						write();
					}
					break;
				}
				case "start": {
					const shouldReset = resetStateOnFirstMessageStart && isFirstMessageStart || resetStateOnMessageIdChange && chunk.messageId != null && chunk.messageId !== state.message.id;
					isFirstMessageStart = false;
					if (shouldReset) Object.assign(state, createStreamingUIMessageState({
						lastMessage: void 0,
						messageId: chunk.messageId ?? state.message.id
					}), { finishReason: void 0 });
					if (chunk.messageId != null) state.message.id = chunk.messageId;
					await updateMessageMetadata(chunk.messageMetadata);
					if (shouldReset || chunk.messageId != null || chunk.messageMetadata != null) write({ updateStatus: false });
					break;
				}
				case "finish":
					if (chunk.finishReason != null) state.finishReason = chunk.finishReason;
					await updateMessageMetadata(chunk.messageMetadata);
					if (chunk.messageMetadata != null) write();
					break;
				case "message-metadata":
					await updateMessageMetadata(chunk.messageMetadata);
					if (chunk.messageMetadata != null) write();
					break;
				case "error":
					onError?.(new Error(chunk.errorText));
					break;
				default: if (isDataUIMessageChunk(chunk)) {
					if (dataPartSchemas?.[chunk.type] != null) {
						const partIdx = state.message.parts.findIndex((p) => "id" in p && "data" in p && p.id === chunk.id && p.type === chunk.type);
						const actualPartIdx = partIdx >= 0 ? partIdx : state.message.parts.length;
						await validateTypes({
							value: chunk.data,
							schema: dataPartSchemas[chunk.type],
							context: {
								field: `message.parts[${actualPartIdx}].data`,
								entityName: chunk.type,
								entityId: chunk.id
							}
						});
					}
					const dataChunk = chunk;
					if (dataChunk.transient) {
						onData?.(dataChunk);
						break;
					}
					const existingUIPart = dataChunk.id != null ? state.message.parts.find((chunkArg) => dataChunk.type === chunkArg.type && dataChunk.id === chunkArg.id) : void 0;
					if (existingUIPart != null) existingUIPart.data = dataChunk.data;
					else state.message.parts.push(dataChunk);
					onData?.(dataChunk);
					write();
				}
			}
			controller.enqueue(chunk);
		});
	} }));
}
function handleUIMessageStreamFinish({ messageId, originalMessages = [], onStepEnd, onStepFinish, onEnd, onFinish, onError, stream, getOutcome }) {
	let lastMessage = originalMessages?.[originalMessages.length - 1];
	if (lastMessage?.role !== "assistant") lastMessage = void 0;
	else messageId = lastMessage.id;
	let isAborted = false;
	let hasProcessingFailure = false;
	let processingError;
	const recordProcessingFailure = (error) => {
		hasProcessingFailure = true;
		processingError = error;
	};
	const idInjectedStream = stream.pipeThrough(new TransformStream({ transform(chunk, controller) {
		try {
			let outputChunk = chunk;
			if (chunk.type === "start") {
				const startChunk = chunk;
				if (startChunk.messageId == null && messageId != null) outputChunk = {
					...startChunk,
					messageId
				};
			}
			if (chunk.type === "abort") isAborted = true;
			controller.enqueue(outputChunk);
		} catch (error) {
			recordProcessingFailure(error);
			throw error;
		}
	} }));
	const resolvedOnStepEnd = onStepEnd ?? onStepFinish;
	const resolvedOnEnd = onEnd ?? onFinish;
	if (resolvedOnEnd == null && resolvedOnStepEnd == null) return idInjectedStream;
	const state = createStreamingUIMessageState({
		lastMessage: lastMessage ? structuredClone(lastMessage) : void 0,
		messageId: messageId ?? ""
	});
	const runUpdateMessageJob = async (job) => {
		try {
			await job({
				state,
				write: () => {}
			});
		} catch (error) {
			recordProcessingFailure(error);
			throw error;
		}
	};
	let finishCalled = false;
	const callOnEnd = async ({ isCancelled }) => {
		if (finishCalled || !resolvedOnEnd) return;
		finishCalled = true;
		const isContinuation = state.message.id === lastMessage?.id;
		const declaredOutcome = getOutcome?.() ?? { status: "unknown" };
		const outcome = hasProcessingFailure ? {
			status: "failed",
			error: processingError
		} : declaredOutcome.status === "unknown" && isAborted ? { status: "aborted" } : declaredOutcome;
		const isConsumerCancellation = isCancelled && outcome.status === "unknown";
		await resolvedOnEnd({
			isAborted: isAborted || outcome.status === "aborted",
			...isConsumerCancellation ? { isCancelled: true } : {},
			isContinuation,
			outcome,
			responseMessage: state.message,
			messages: [...isContinuation ? originalMessages.slice(0, -1) : originalMessages, state.message],
			finishReason: state.finishReason
		});
	};
	const callOnStepFinish = async () => {
		if (!resolvedOnStepEnd) return;
		const isContinuation = state.message.id === lastMessage?.id;
		try {
			await resolvedOnStepEnd({
				isContinuation,
				responseMessage: structuredClone(state.message),
				messages: [...isContinuation ? originalMessages.slice(0, -1) : originalMessages, structuredClone(state.message)]
			});
		} catch (error) {
			onError(error);
		}
	};
	return processUIMessageStream({
		stream: idInjectedStream,
		runUpdateMessageJob,
		onError
	}).pipeThrough(new TransformStream({
		async transform(chunk, controller) {
			if (chunk.type === "finish-step") await callOnStepFinish();
			controller.enqueue(chunk);
		},
		async cancel() {
			await callOnEnd({ isCancelled: true });
		},
		async flush() {
			await callOnEnd({ isCancelled: false });
		}
	}));
}
/**
* Converts a single `TextStreamPart` (as emitted by `streamText`'s
* `stream`) into a `UIMessageChunk`.
*
* Returns `undefined` for stream parts that do not produce UI message chunks.
*/
function toUIMessageChunk(part, { tools, sendReasoning = true, sendSources = false, sendStart = true, sendFinish = true, onError = () => "An error occurred.", messageMetadata, responseMessageId } = {}) {
	const isDynamic = (toolPart) => {
		const tool = tools?.[toolPart.toolName];
		if (tool == null) return toolPart.dynamic;
		return tool?.type === "dynamic" ? true : void 0;
	};
	const partType = part.type;
	switch (partType) {
		case "text-start": return {
			type: "text-start",
			id: part.id,
			...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {}
		};
		case "text-delta": return {
			type: "text-delta",
			id: part.id,
			delta: part.text,
			...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {}
		};
		case "text-end": return {
			type: "text-end",
			id: part.id,
			...part.citations != null ? { citations: part.citations } : {},
			...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {}
		};
		case "reasoning-start":
		case "reasoning-end":
			if (!sendReasoning) return;
			return {
				type: partType,
				id: part.id,
				...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {}
			};
		case "reasoning-delta":
			if (!sendReasoning) return;
			return {
				type: "reasoning-delta",
				id: part.id,
				delta: part.text,
				...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {}
			};
		case "file":
		case "reasoning-file":
			if (partType === "reasoning-file" && !sendReasoning) return;
			return {
				type: part.type,
				mediaType: part.file.mediaType,
				url: `data:${part.file.mediaType};base64,${part.file.base64}`,
				...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {}
			};
		case "source":
			if (!sendSources) return;
			if (part.sourceType === "url") return {
				type: "source-url",
				sourceId: part.id,
				url: part.url,
				title: part.title,
				...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {}
			};
			if (part.sourceType === "document") return {
				type: "source-document",
				sourceId: part.id,
				mediaType: part.mediaType,
				title: part.title,
				filename: part.filename,
				...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {}
			};
			return;
		case "custom": return {
			type: "custom",
			kind: part.kind,
			...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {}
		};
		case "tool-input-start": {
			const dynamic = isDynamic(part);
			return {
				type: "tool-input-start",
				toolCallId: part.id,
				toolName: part.toolName,
				...part.providerExecuted != null ? { providerExecuted: part.providerExecuted } : {},
				...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {},
				...part.toolMetadata != null ? { toolMetadata: part.toolMetadata } : {},
				...dynamic != null ? { dynamic } : {},
				...part.title != null ? { title: part.title } : {}
			};
		}
		case "tool-input-delta": return {
			type: "tool-input-delta",
			toolCallId: part.id,
			inputTextDelta: part.delta
		};
		case "tool-call": {
			const dynamic = isDynamic(part);
			if (part.invalid) return {
				type: "tool-input-error",
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				input: part.input,
				...part.providerExecuted != null ? { providerExecuted: part.providerExecuted } : {},
				...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {},
				...part.toolMetadata != null ? { toolMetadata: part.toolMetadata } : {},
				...dynamic != null ? { dynamic } : {},
				errorText: onError(part.error),
				...part.title != null ? { title: part.title } : {}
			};
			return {
				type: "tool-input-available",
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				input: part.input,
				...part.providerExecuted != null ? { providerExecuted: part.providerExecuted } : {},
				...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {},
				...part.toolMetadata != null ? { toolMetadata: part.toolMetadata } : {},
				...dynamic != null ? { dynamic } : {},
				...part.title != null ? { title: part.title } : {}
			};
		}
		case "tool-approval-request": {
			const inputSchemaInput = getToolCallInputSchemaInput(part.toolCall);
			return {
				type: "tool-approval-request",
				approvalId: part.approvalId,
				toolCallId: part.toolCall.toolCallId,
				...inputSchemaInput != null && !isDeepEqualData(inputSchemaInput.value, part.toolCall.input) ? { inputSchemaInput: inputSchemaInput.value } : {},
				...part.reason != null ? { reason: part.reason } : {},
				...part.isAutomatic != null ? { isAutomatic: part.isAutomatic } : {},
				...part.signature != null ? { signature: part.signature } : {}
			};
		}
		case "tool-approval-response": return {
			type: "tool-approval-response",
			approvalId: part.approvalId,
			approved: part.approved,
			...part.reason != null ? { reason: part.reason } : {},
			...part.providerExecuted != null ? { providerExecuted: part.providerExecuted } : {}
		};
		case "tool-result": {
			const dynamic = isDynamic(part);
			return {
				type: "tool-output-available",
				toolCallId: part.toolCallId,
				output: part.output === void 0 ? null : part.output,
				...part.providerExecuted != null ? { providerExecuted: part.providerExecuted } : {},
				...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {},
				...part.toolMetadata != null ? { toolMetadata: part.toolMetadata } : {},
				...part.preliminary != null ? { preliminary: part.preliminary } : {},
				...dynamic != null ? { dynamic } : {}
			};
		}
		case "tool-error": {
			const dynamic = isDynamic(part);
			return {
				type: "tool-output-error",
				toolCallId: part.toolCallId,
				errorText: part.providerExecuted ? typeof part.error === "string" ? part.error : JSON.stringify(part.error) : onError(part.error),
				...part.providerExecuted != null ? { providerExecuted: part.providerExecuted } : {},
				...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {},
				...part.toolMetadata != null ? { toolMetadata: part.toolMetadata } : {},
				...dynamic != null ? { dynamic } : {}
			};
		}
		case "tool-output-denied": return {
			type: "tool-output-denied",
			toolCallId: part.toolCallId
		};
		case "error": return {
			type: "error",
			errorText: onError(part.error)
		};
		case "start-step": return { type: "start-step" };
		case "finish-step": return { type: "finish-step" };
		case "start":
			if (!sendStart) return;
			return {
				type: "start",
				...messageMetadata != null ? { messageMetadata } : {},
				...responseMessageId != null ? { messageId: responseMessageId } : {}
			};
		case "finish":
			if (!sendFinish) return;
			return {
				type: "finish",
				finishReason: part.finishReason,
				...messageMetadata != null ? { messageMetadata } : {}
			};
		case "abort": return part;
		case "tool-input-end":
		case "raw": return;
		default: throw new Error(`Unknown chunk type: ${partType}`);
	}
}
/**
* Converts a stream of `TextStreamPart<TOOLS>` chunks (as emitted by
* `streamText`'s `stream`) into a stream of `UIMessageChunk`s suitable for
* UI message streaming, including response message ID injection and
* step and stream end callbacks.
*/
function toUIMessageStream({ stream, tools, sendReasoning = true, sendSources = false, sendStart = true, sendFinish = true, onError = () => "An error occurred.", messageMetadata, originalMessages, generateMessageId, onStepEnd, onStepFinish, onEnd, onFinish }) {
	let outcome = { status: "unknown" };
	let hasFatalFailure = false;
	const setSourceOutcome = (newOutcome) => {
		if (!hasFatalFailure && outcome.status !== "completed" && outcome.status !== "aborted" && newOutcome.status !== "unknown" && (outcome.status === "unknown" || newOutcome.status !== "failed")) outcome = newOutcome;
	};
	const failOutcome = (error) => {
		hasFatalFailure = true;
		outcome = {
			status: "failed",
			error
		};
	};
	const responseMessageId = generateMessageId != null ? getResponseUIMessageId({
		originalMessages,
		responseMessageId: generateMessageId
	}) : void 0;
	const sourceReader = stream.getReader();
	let sourceReaderReleased = false;
	let sourceStreamCancelled = false;
	const releaseSourceReader = () => {
		if (!sourceReaderReleased) {
			sourceReader.releaseLock();
			sourceReaderReleased = true;
		}
	};
	return handleUIMessageStreamFinish({
		stream: new ReadableStream({
			async pull(controller) {
				try {
					const { done, value } = await sourceReader.read();
					if (done) {
						releaseSourceReader();
						if (!sourceStreamCancelled) controller.close();
					} else controller.enqueue(value);
				} catch (error) {
					releaseSourceReader();
					if (!sourceStreamCancelled) {
						failOutcome(error);
						controller.error(error);
					}
				}
			},
			async cancel(reason) {
				sourceStreamCancelled = true;
				if (sourceReaderReleased) return;
				try {
					await sourceReader.cancel(reason);
				} finally {
					releaseSourceReader();
				}
			}
		}).pipeThrough(new TransformStream({ transform: async (part, controller) => {
			try {
				const messageMetadataValue = messageMetadata?.({ part });
				const uiMessageChunk = toUIMessageChunk(part, {
					tools,
					sendReasoning,
					sendSources,
					sendStart,
					sendFinish,
					onError,
					messageMetadata: messageMetadataValue,
					responseMessageId
				});
				if (uiMessageChunk != null && part.type !== "finish-step") controller.enqueue(uiMessageChunk);
				if (messageMetadataValue != null && part.type !== "start" && part.type !== "finish") controller.enqueue({
					type: "message-metadata",
					messageMetadata: messageMetadataValue
				});
				if (uiMessageChunk != null && part.type === "finish-step") controller.enqueue(uiMessageChunk);
				if (part.type === "finish") setSourceOutcome({ status: "completed" });
				else if (part.type === "abort") setSourceOutcome({ status: "aborted" });
				else if (part.type === "error") setSourceOutcome({
					status: "failed",
					error: part.error
				});
			} catch (error) {
				failOutcome(error);
				throw error;
			}
		} })),
		messageId: responseMessageId ?? generateMessageId?.(),
		originalMessages,
		onStepEnd: onStepEnd ?? onStepFinish,
		onEnd: onEnd ?? onFinish,
		onError,
		getOutcome: () => outcome
	});
}
/**
* Wraps a ReadableStream and returns an object that is both a ReadableStream and an AsyncIterable.
* This enables consumption of the stream using for-await-of, with proper resource cleanup on early exit or error.
*
* @template T The type of the stream's chunks.
* @param source The source ReadableStream to wrap.
* @returns An AsyncIterableStream that can be used as both a ReadableStream and an AsyncIterable.
*/
function createAsyncIterableStream(source) {
	return asAsyncIterableStream(source.pipeThrough(new TransformStream()));
}
/**
* Attaches the async iterator protocol to an existing ReadableStream in place,
* turning it into an AsyncIterableStream without piping through an additional
* TransformStream.
*
* Use this when the stream is already known to be fresh and exclusively owned
* (e.g. the readable side of a TransformStream created for this consumer).
* Adding an extra `pipeThrough` in that situation creates a chain of two
* transforms fed by an active upstream pipe, which can surface a spurious
* unhandled `undefined` rejection when the consumer cancels early (observed on
* Node.js 26). {@link createAsyncIterableStream} wraps this after adding a
* fresh transform for callers that may pass shared or locked streams.
*
* @template T The type of the stream's chunks.
* @param stream The ReadableStream to augment. It must be fresh and unlocked.
* @returns The same stream, augmented with the async iterator protocol.
*/
function asAsyncIterableStream(stream) {
	/**
	* Implements the async iterator protocol for the stream.
	* Ensures proper cleanup (cancelling and releasing the reader) on completion, early exit, or error.
	*/
	stream[Symbol.asyncIterator] = function() {
		const reader = this.getReader();
		let finished = false;
		/**
		* Cleans up the reader by cancelling and releasing the lock.
		*/
		async function cleanup(cancelStream) {
			if (finished) return;
			finished = true;
			try {
				if (cancelStream) await reader.cancel?.();
			} finally {
				try {
					reader.releaseLock();
				} catch {}
			}
		}
		return {
			/**
			* Reads the next chunk from the stream.
			* @returns A promise resolving to the next IteratorResult.
			*/
			async next() {
				if (finished) return {
					done: true,
					value: void 0
				};
				let result;
				try {
					result = await reader.read();
				} catch (error) {
					await cleanup(false);
					throw error;
				}
				const { done, value } = result;
				if (done) {
					await cleanup(true);
					return {
						done: true,
						value: void 0
					};
				}
				return {
					done: false,
					value
				};
			},
			/**
			* May be called on early exit (e.g., break from for-await) or after completion.
			* Ensures the stream is cancelled and resources are released.
			* @returns A promise resolving to a completed IteratorResult.
			*/
			async return() {
				await cleanup(true);
				return {
					done: true,
					value: void 0
				};
			},
			/**
			* Called on early exit with error.
			* Ensures the stream is cancelled and resources are released, then rethrows the error.
			* @param err The error to throw.
			* @returns A promise that rejects with the provided error.
			*/
			async throw(err) {
				await cleanup(true);
				throw err;
			}
		};
	};
	return stream;
}
/**
* Consumes a ReadableStream until it's fully read.
*
* This function reads the stream chunk by chunk until the stream is exhausted.
* It doesn't process or return the data from the stream; it simply ensures
* that the entire stream is read.
*
* @param options - The options for consuming the stream.
* @param options.stream - The ReadableStream to be consumed.
* @param options.onError - Optional callback to handle errors that occur during consumption.
* @returns A promise that resolves when the stream is fully consumed.
*/
async function consumeStream({ stream, onError, abortSignal }) {
	const reader = stream.getReader();
	const cancelOnAbort = () => {
		reader.cancel().catch(() => {});
	};
	if (abortSignal?.aborted) cancelOnAbort();
	else abortSignal?.addEventListener("abort", cancelOnAbort, { once: true });
	try {
		while (true) {
			const { done } = await reader.read();
			if (done) break;
		}
	} catch (error) {
		onError?.(error);
	} finally {
		abortSignal?.removeEventListener("abort", cancelOnAbort);
		reader.releaseLock();
	}
}
/**
* Creates a Promise with externally accessible resolve and reject functions.
*
* @template T - The type of the value that the Promise will resolve to.
* @returns An object containing:
*   - promise: A Promise that can be resolved or rejected externally.
*   - resolve: A function to resolve the Promise with a value of type T.
*   - reject: A function to reject the Promise with an error.
*/
function createResolvablePromise() {
	let resolve;
	let reject;
	return {
		promise: new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		}),
		resolve,
		reject
	};
}
/**
* Creates a stitchable stream that can pipe one stream at a time.
*
* @template T - The type of values emitted by the streams.
* @returns {Object} An object containing the stitchable stream and control methods.
*/
function createStitchableStream() {
	let innerStreams = [];
	let controller = null;
	let isClosed = false;
	let isCancelled = false;
	let waitForNewStream = createResolvablePromise();
	const terminate = () => {
		if (isCancelled) return;
		isClosed = true;
		waitForNewStream.resolve();
		innerStreams.forEach(({ reader, onCancel }) => {
			onCancel?.();
			reader.cancel();
		});
		innerStreams = [];
		controller?.close();
	};
	const processPull = async () => {
		if (isCancelled) return;
		if (isClosed && innerStreams.length === 0) {
			controller?.close();
			return;
		}
		if (innerStreams.length === 0) {
			waitForNewStream = createResolvablePromise();
			await waitForNewStream.promise;
			return await processPull();
		}
		const currentStream = innerStreams[0];
		try {
			const { value, done } = await currentStream.reader.read();
			if (isCancelled) return;
			if (done) {
				innerStreams.shift();
				if (innerStreams.length === 0 && isClosed) controller?.close();
				else await processPull();
			} else controller?.enqueue(value);
		} catch (error) {
			if (isCancelled) return;
			currentStream.onError?.(error);
			controller?.error(error);
			innerStreams.shift();
			terminate();
		}
	};
	return {
		stream: new ReadableStream({
			start(controllerParam) {
				controller = controllerParam;
			},
			pull: processPull,
			async cancel() {
				isCancelled = true;
				isClosed = true;
				waitForNewStream.resolve();
				for (const { reader, onCancel } of innerStreams) {
					onCancel?.();
					await reader.cancel();
				}
				innerStreams = [];
			}
		}),
		addStream: (innerStream, callbacks) => {
			if (isCancelled) {
				callbacks?.onCancel?.();
				innerStream.cancel().catch(() => {});
				return;
			}
			if (isClosed) throw new Error("Cannot add inner stream: outer stream is closed");
			innerStreams.push({
				reader: innerStream.getReader(),
				...callbacks
			});
			waitForNewStream.resolve();
		},
		/**
		* Gracefully close the outer stream. This will let the inner streams
		* finish processing and then close the outer stream.
		*/
		close: () => {
			if (isCancelled) return;
			isClosed = true;
			waitForNewStream.resolve();
			if (innerStreams.length === 0) controller?.close();
		},
		/**
		* Immediately close the outer stream. This will cancel all inner streams
		* and close the outer stream.
		*/
		terminate
	};
}
const streamRetryAttemptBoundarySymbol = Symbol("streamRetryAttemptBoundary");
function createStreamRetryAttemptBoundaryPart({ warnings }) {
	return {
		[streamRetryAttemptBoundarySymbol]: true,
		warnings
	};
}
function isStreamRetryAttemptBoundaryPart(part) {
	return typeof part === "object" && part != null && streamRetryAttemptBoundarySymbol in part;
}
function executeToolsFromStream({ stream, tools, callId, messages, abortSignal, timeout, experimental_sandbox: sandbox, toolsContext, toolApproval, runtimeContext, toolApprovalSecret, generateId, onToolExecutionStart, onToolExecutionEnd, executeToolInTelemetryContext, runInTracingChannelSpan, toolCallConcurrency }) {
	const toolCallsToExecute = [];
	return stream.pipeThrough(new TransformStream({ async transform(chunk, controller) {
		controller.enqueue(chunk);
		if (isStreamRetryAttemptBoundaryPart(chunk)) {
			toolCallsToExecute.length = 0;
			return;
		}
		switch (chunk.type) {
			case "tool-call": {
				if (chunk.invalid) return;
				const tool = getOwn(tools, chunk.toolName);
				if (tool == null) return;
				const toolApprovalStatus = await resolveToolApproval({
					tools,
					toolCall: chunk,
					toolApproval,
					messages,
					toolsContext,
					runtimeContext
				});
				if (toolApprovalStatus.type === "not-applicable") {
					if (tool.execute != null && chunk.providerExecuted !== true) toolCallsToExecute.push(chunk);
					return;
				}
				const approvalId = generateId();
				const signature = await maybeSignApproval({
					secret: toolApprovalSecret,
					approvalId,
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					input: chunk.input
				});
				switch (toolApprovalStatus.type) {
					case "user-approval":
						controller.enqueue({
							type: "tool-approval-request",
							approvalId,
							toolCall: chunk,
							...toolApprovalStatus.reason != null ? { reason: toolApprovalStatus.reason } : {},
							...signature != null ? { signature } : {}
						});
						return;
					case "denied":
						controller.enqueue({
							type: "tool-approval-request",
							approvalId,
							toolCall: chunk,
							isAutomatic: true,
							...signature != null ? { signature } : {}
						});
						controller.enqueue({
							type: "tool-approval-response",
							approvalId,
							approved: false,
							toolCall: chunk,
							reason: toolApprovalStatus.reason,
							providerExecuted: chunk.providerExecuted
						});
						controller.enqueue({
							type: "tool-output-denied",
							toolCallId: chunk.toolCallId,
							toolName: chunk.toolName
						});
						return;
					case "approved":
						controller.enqueue({
							type: "tool-approval-request",
							approvalId,
							toolCall: chunk,
							isAutomatic: true,
							...signature != null ? { signature } : {}
						});
						controller.enqueue({
							type: "tool-approval-response",
							approvalId,
							approved: true,
							toolCall: chunk,
							reason: toolApprovalStatus.reason,
							providerExecuted: chunk.providerExecuted
						});
				}
				if (tool.execute != null && chunk.providerExecuted !== true) toolCallsToExecute.push(chunk);
				return;
			}
			case "model-call-end":
				if (!isToolExecutionAllowedFinishReason(chunk.finishReason)) return;
				await mapWithConcurrency({
					items: toolCallsToExecute,
					concurrency: toolCallConcurrency,
					abortSignal,
					execute: async (toolCall) => {
						try {
							const result = await executeToolCall({
								toolCall,
								tools,
								callId,
								messages,
								abortSignal,
								timeout,
								experimental_sandbox: sandbox,
								toolsContext,
								onToolExecutionStart,
								onToolExecutionEnd,
								executeToolInTelemetryContext,
								runInTracingChannelSpan,
								onPreliminaryToolResult: (result) => {
									controller.enqueue(result);
								}
							});
							if (result != null) {
								controller.enqueue({
									type: "tool-execution-end",
									toolCallId: result.output.toolCallId,
									toolExecutionMs: result.toolExecutionMs
								});
								controller.enqueue(result.output);
							}
						} catch (error) {
							controller.enqueue({
								type: "error",
								error
							});
						}
					}
				});
		}
	} }));
}
const isOutputChunkType = {
	file: true,
	custom: false,
	source: false,
	"text-start": false,
	"text-end": false,
	"text-delta": true,
	"reasoning-start": false,
	"reasoning-end": false,
	"reasoning-delta": true,
	"reasoning-file": true,
	"tool-input-start": false,
	"tool-input-end": false,
	"tool-input-delta": true,
	"tool-approval-request": false,
	"tool-approval-response": false,
	"tool-call": true,
	"tool-result": false,
	"tool-error": false,
	"tool-output-denied": false,
	"tool-execution-end": false,
	"model-call-start": false,
	"model-call-response-metadata": false,
	"model-call-end": false,
	error: false,
	raw: false
};
function isOutputChunk$1(chunk) {
	if (!isOutputChunkType[chunk.type]) return false;
	switch (chunk.type) {
		case "text-delta":
		case "reasoning-delta": return chunk.text.length > 0;
		case "tool-input-delta": return chunk.delta.length > 0;
		case "file":
		case "reasoning-file":
		case "tool-call": return true;
		default: return false;
	}
}
function invokeToolCallbacksFromStream({ stream, tools, stepInputMessages, abortSignal, toolsContext }) {
	if (tools == null) return stream;
	let ongoingToolCalls = createIdMap();
	const getValidatedContext = ({ toolCallId, toolName }) => {
		const ongoingToolCall = ongoingToolCalls[toolCallId];
		const validatedContext = ongoingToolCall?.validatedContexts[toolName];
		if (validatedContext != null) return validatedContext;
		const tool = getOwn(tools, toolName);
		const newValidatedContext = validateToolContext({
			toolName,
			context: getOwn(toolsContext, toolName),
			contextSchema: tool?.contextSchema
		});
		if (ongoingToolCall != null) ongoingToolCall.validatedContexts[toolName] = newValidatedContext;
		return newValidatedContext;
	};
	return stream.pipeThrough(new TransformStream({ async transform(chunk, controller) {
		controller.enqueue(chunk);
		if (isStreamRetryAttemptBoundaryPart(chunk)) {
			ongoingToolCalls = createIdMap();
			return;
		}
		switch (chunk.type) {
			case "tool-input-start": {
				ongoingToolCalls[chunk.id] = {
					toolName: chunk.toolName,
					validatedContexts: createIdMap()
				};
				const tool = getOwn(tools, chunk.toolName);
				if (tool?.onInputStart != null) await tool.onInputStart({
					toolCallId: chunk.id,
					messages: stepInputMessages,
					abortSignal,
					context: await getValidatedContext({
						toolCallId: chunk.id,
						toolName: chunk.toolName
					})
				});
				break;
			}
			case "tool-input-delta": {
				const toolName = ongoingToolCalls[chunk.id]?.toolName;
				const tool = getOwn(tools, toolName);
				if (tool?.onInputDelta != null) await tool.onInputDelta({
					inputTextDelta: chunk.delta,
					toolCallId: chunk.id,
					messages: stepInputMessages,
					abortSignal,
					context: await getValidatedContext({
						toolCallId: chunk.id,
						toolName
					})
				});
				break;
			}
			case "tool-call": {
				const toolName = chunk.toolName;
				const tool = getOwn(tools, toolName);
				if (!chunk.invalid && tool?.onInputAvailable != null) {
					const validatedContext = getValidatedContext({
						toolCallId: chunk.toolCallId,
						toolName
					});
					delete ongoingToolCalls[chunk.toolCallId];
					await tool.onInputAvailable({
						input: chunk.input,
						toolCallId: chunk.toolCallId,
						messages: stepInputMessages,
						abortSignal,
						context: await validatedContext
					});
				} else delete ongoingToolCalls[chunk.toolCallId];
			}
		}
	} }));
}
/**
* Normalizes well-formed provider error payloads without changing existing
* Error instances or malformed/unknown values.
*/
function normalizeStreamProviderError(error) {
	if (isError(error) || AISDKError.isInstance(error) || StreamProviderError.isInstance(error)) return error;
	const outer = asRecord(error);
	if (outer == null) return error;
	const providerStreamError = isProviderStreamError(error);
	const details = providerStreamError ? outer : asRecord(asRecord(outer.response)?.error) ?? asRecord(outer.error) ?? outer;
	if (typeof details.message !== "string") return error;
	const type = getString(details.type) ?? getString(outer.type);
	const code = getStringOrNumber(details.code) ?? getStringOrNumber(outer.code);
	const explicitStatusCode = getHttpStatusCode(details.statusCode) ?? getHttpStatusCode(outer.statusCode) ?? getHttpStatusCode(details.status_code) ?? getHttpStatusCode(outer.status_code) ?? getHttpStatusCode(details.status) ?? getHttpStatusCode(outer.status) ?? getHttpStatusCode(details.code) ?? getHttpStatusCode(outer.code);
	const messageMetadata = inferExactMessageMetadata(details.message);
	const statusCode = explicitStatusCode ?? messageMetadata?.statusCode;
	const explicitRetryability = getBoolean(details.isRetryable) ?? getBoolean(outer.isRetryable) ?? getBoolean(details.is_retryable) ?? getBoolean(outer.is_retryable);
	return new StreamProviderError({
		message: details.message,
		type,
		code,
		statusCode,
		isRetryable: explicitRetryability ?? messageMetadata?.isRetryable ?? isRetryableStatusCode(statusCode),
		data: providerStreamError ? error.data : error
	});
}
function inferExactMessageMetadata(message) {
	switch (message.trim().toLowerCase()) {
		case "overloaded":
		case "overloaded error":
		case "model overloaded": return {
			statusCode: 503,
			isRetryable: true
		};
		case "internal server error": return {
			statusCode: 500,
			isRetryable: true
		};
		case "service unavailable": return {
			statusCode: 503,
			isRetryable: true
		};
		default: return;
	}
}
function isRetryableStatusCode(statusCode) {
	return statusCode != null && (statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500);
}
function asRecord(value) {
	return typeof value === "object" && value != null ? value : void 0;
}
function isError(value) {
	return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
}
function getString(value) {
	return typeof value === "string" ? value : void 0;
}
function getStringOrNumber(value) {
	return typeof value === "string" || typeof value === "number" ? value : void 0;
}
function getBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function getHttpStatusCode(value) {
	const statusCode = typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : value;
	return typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : void 0;
}
const originalGenerateId$3 = createIdGenerator({
	prefix: "aitxt",
	size: 24
});
const originalGenerateCallId$8 = createIdGenerator({
	prefix: "call",
	size: 24
});
/**
* Streams a single language model call after standardizing the prompt and tools.
*
* The returned stream emits model call parts together with request and response
* metadata when available.
*
* @param model - The language model to use.
* @param tools - Tools that are accessible to and can be called by the model. The model needs to support calling tools.
* @param output - Output configuration that controls the response format requested from the model.
* @param toolChoice - The tool choice strategy for the model call.
*
* @param system - A system message that will be part of the prompt.
* @param prompt - A simple text prompt. You can either use `prompt` or `messages` but not both.
* @param messages - A list of messages. You can either use `prompt` or `messages` but not both.
* @param allowSystemInMessages - Whether system messages are allowed in the `prompt` or `messages` fields. Default: false.
*
* @param maxOutputTokens - Maximum number of tokens to generate.
* @param temperature - Temperature setting.
* The value is passed through to the provider. The range depends on the provider and model.
* It is recommended to set either `temperature` or `topP`, but not both.
* @param topP - Nucleus sampling.
* The value is passed through to the provider. The range depends on the provider and model.
* It is recommended to set either `temperature` or `topP`, but not both.
* @param topK - Only sample from the top K options for each subsequent token.
* Used to remove "long tail" low probability responses.
* Recommended for advanced use cases only. You usually only need to use temperature.
* @param presencePenalty - Presence penalty setting.
* It affects the likelihood of the model to repeat information that is already in the prompt.
* The value is passed through to the provider. The range depends on the provider and model.
* @param frequencyPenalty - Frequency penalty setting.
* It affects the likelihood of the model to repeatedly use the same words or phrases.
* The value is passed through to the provider. The range depends on the provider and model.
* @param stopSequences - Stop sequences.
* If set, the model will stop generating text when one of the stop sequences is generated.
* @param seed - The seed (integer) to use for random sampling.
* If set and supported by the model, calls will generate deterministic results.
* @param reasoning - Reasoning configuration for the model call.
*
* @param download - A function that downloads URLs as part of prompt conversion.
* @param abortSignal - An optional abort signal that can be used to cancel the call.
* @param headers - Additional HTTP headers to be sent with the request.
* @param includeRawChunks - Whether to include raw provider stream chunks in the model stream.
* @param providerOptions - Additional provider-specific options.
* @param repairToolCall - A function that can repair invalid tool calls before they are emitted.
* @param refineToolInput - Optional mapping of tool names to functions that refine parsed tool inputs before they are emitted, used for telemetry, or executed.
* @param onStart - A callback that receives the fully converted prompt before the model call starts.
*
* @returns A stream of model call parts together with request and response metadata when available.
*/
async function streamLanguageModelCall({ model, tools, toolOrder, output, toolChoice, prompt, system, instructions, messages, allowSystemInMessages, download, abortSignal, headers, includeRawChunks, providerOptions, repairToolCall, refineToolInput, executeLanguageModelCallInTelemetryContext = async ({ execute }) => await execute(), callId, toolsContext, experimental_sandbox: sandbox, _internal: { generateId = originalGenerateId$3, generateCallId = originalGenerateCallId$8, now: now$3 = now } = {}, onStart, onLanguageModelCallStart, onLanguageModelCallEnd, ...callSettings }) {
	const resolvedModel = resolveLanguageModel(model);
	const effectiveCallId = callId ?? generateCallId();
	const standardizedPrompt = await standardizePrompt({
		instructions,
		system,
		prompt,
		messages,
		allowSystemInMessages
	});
	const promptMessages = await convertToLanguageModelPrompt({
		prompt: {
			instructions: standardizedPrompt.instructions,
			messages: standardizedPrompt.messages
		},
		supportedUrls: await resolvedModel.supportedUrls,
		download,
		abortSignal,
		provider: resolvedModel.provider.split(".")[0]
	});
	const stepTools = await prepareTools({
		tools,
		toolOrder,
		toolsContext,
		experimental_sandbox: sandbox
	});
	const stepToolChoice = prepareToolChoice({ toolChoice });
	await notify({
		event: { promptMessages },
		callbacks: onStart
	});
	const languageModelCallStartEvent = {
		callId: effectiveCallId,
		provider: resolvedModel.provider,
		modelId: resolvedModel.modelId,
		instructions: standardizedPrompt.instructions,
		messages: standardizedPrompt.messages,
		tools: stepTools,
		...callSettings
	};
	await notify({
		event: languageModelCallStartEvent,
		callbacks: onLanguageModelCallStart
	});
	const callStartTimestampMs = now$3();
	const { stream: languageModelStream, response, request } = await executeLanguageModelCallInTelemetryContext({
		...languageModelCallStartEvent,
		execute: async () => await resolvedModel.doStream({
			...callSettings,
			tools: stepTools,
			toolChoice: stepToolChoice,
			responseFormat: await output?.responseFormat,
			prompt: promptMessages,
			providerOptions,
			abortSignal,
			headers,
			includeRawChunks
		})
	});
	return {
		stream: createAsyncIterableStream(languageModelStream.pipeThrough(createLanguageModelV4StreamPartToLanguageModelStreamPartTransform({
			tools,
			instructions: standardizedPrompt.instructions,
			messages: standardizedPrompt.messages,
			repairToolCall,
			refineToolInput,
			abortSignal,
			callId: effectiveCallId,
			provider: resolvedModel.provider,
			modelId: resolvedModel.modelId,
			toolChoice: stepToolChoice,
			generateId,
			now: now$3,
			callStartTimestampMs,
			onLanguageModelCallEnd
		}))),
		response,
		request
	};
}
function createLanguageModelV4StreamPartToLanguageModelStreamPartTransform({ tools, instructions, messages, repairToolCall, refineToolInput, abortSignal, callId, provider, modelId, toolChoice, generateId, now, callStartTimestampMs, onLanguageModelCallEnd }) {
	const toolCallsByToolCallId = /* @__PURE__ */ new Map();
	const modelCallContent = [];
	const rawModelCallContent = [];
	const textPartIndexes = /* @__PURE__ */ new Map();
	const reasoningPartIndexes = /* @__PURE__ */ new Map();
	const rawTextPartIndexes = /* @__PURE__ */ new Map();
	const rawReasoningPartIndexes = /* @__PURE__ */ new Map();
	let responseId = generateId();
	let responseModelId = modelId;
	let timeToFirstOutputMs;
	let previousOutputChunkTimestampMs;
	const timeBetweenOutputChunksMs = [];
	return new TransformStream({ async transform(chunk, controller) {
		if (isOutputChunk(chunk)) {
			const outputChunkTimestampMs = now();
			if (timeToFirstOutputMs == null) timeToFirstOutputMs = outputChunkTimestampMs - callStartTimestampMs;
			else if (previousOutputChunkTimestampMs != null) timeBetweenOutputChunksMs.push(outputChunkTimestampMs - previousOutputChunkTimestampMs);
			previousOutputChunkTimestampMs = outputChunkTimestampMs;
		}
		switch (chunk.type) {
			case "error":
				controller.enqueue({
					type: "error",
					error: normalizeStreamProviderError(chunk.error)
				});
				break;
			case "text-start":
				upsertTextContentPart({
					content: modelCallContent,
					rawContent: rawModelCallContent,
					partIndexes: textPartIndexes,
					rawPartIndexes: rawTextPartIndexes,
					id: chunk.id,
					type: "text",
					providerMetadata: chunk.providerMetadata
				});
				controller.enqueue(chunk);
				break;
			case "text-delta":
				upsertTextContentPart({
					content: modelCallContent,
					rawContent: rawModelCallContent,
					partIndexes: textPartIndexes,
					rawPartIndexes: rawTextPartIndexes,
					id: chunk.id,
					type: "text",
					textDelta: chunk.delta,
					providerMetadata: chunk.providerMetadata
				});
				controller.enqueue({
					type: "text-delta",
					id: chunk.id,
					text: chunk.delta,
					providerMetadata: chunk.providerMetadata
				});
				break;
			case "text-end":
				upsertTextContentPart({
					content: modelCallContent,
					rawContent: rawModelCallContent,
					partIndexes: textPartIndexes,
					rawPartIndexes: rawTextPartIndexes,
					id: chunk.id,
					type: "text",
					providerMetadata: chunk.providerMetadata
				});
				textPartIndexes.delete(chunk.id);
				rawTextPartIndexes.delete(chunk.id);
				controller.enqueue(chunk);
				break;
			case "reasoning-start":
				upsertTextContentPart({
					content: modelCallContent,
					rawContent: rawModelCallContent,
					partIndexes: reasoningPartIndexes,
					rawPartIndexes: rawReasoningPartIndexes,
					id: chunk.id,
					type: "reasoning",
					providerMetadata: chunk.providerMetadata
				});
				controller.enqueue(chunk);
				break;
			case "reasoning-delta":
				upsertTextContentPart({
					content: modelCallContent,
					rawContent: rawModelCallContent,
					partIndexes: reasoningPartIndexes,
					rawPartIndexes: rawReasoningPartIndexes,
					id: chunk.id,
					type: "reasoning",
					textDelta: chunk.delta,
					providerMetadata: chunk.providerMetadata
				});
				controller.enqueue({
					type: "reasoning-delta",
					id: chunk.id,
					text: chunk.delta,
					providerMetadata: chunk.providerMetadata
				});
				break;
			case "reasoning-end":
				upsertTextContentPart({
					content: modelCallContent,
					rawContent: rawModelCallContent,
					partIndexes: reasoningPartIndexes,
					rawPartIndexes: rawReasoningPartIndexes,
					id: chunk.id,
					type: "reasoning",
					providerMetadata: chunk.providerMetadata
				});
				reasoningPartIndexes.delete(chunk.id);
				rawReasoningPartIndexes.delete(chunk.id);
				controller.enqueue(chunk);
				break;
			case "file":
			case "reasoning-file": {
				const file = new DefaultGeneratedFileWithType({
					data: await resolveGeneratedFileData({
						data: chunk.data,
						abortSignal
					}),
					mediaType: chunk.mediaType
				});
				modelCallContent.push({
					type: chunk.type,
					file,
					...chunk.providerMetadata != null ? { providerMetadata: chunk.providerMetadata } : {}
				});
				rawModelCallContent.push(chunk);
				controller.enqueue({
					type: chunk.type,
					file,
					providerMetadata: chunk.providerMetadata
				});
				break;
			}
			case "finish": {
				const usage = asLanguageModelUsage(chunk.usage);
				const responseTimeMs = now() - callStartTimestampMs;
				const performance = {
					responseTimeMs,
					effectiveOutputTokensPerSecond: calculateTokensPerSecond({
						tokens: usage.outputTokens,
						durationMs: responseTimeMs
					}),
					outputTokensPerSecond: timeToFirstOutputMs == null ? void 0 : calculateTokensPerSecond({
						tokens: usage.outputTokens,
						durationMs: responseTimeMs - timeToFirstOutputMs
					}),
					inputTokensPerSecond: timeToFirstOutputMs == null ? void 0 : calculateTokensPerSecond({
						tokens: usage.inputTokens,
						durationMs: timeToFirstOutputMs
					}),
					effectiveTotalTokensPerSecond: calculateTokensPerSecond({
						tokens: sumTokenCounts(usage.inputTokens, usage.outputTokens),
						durationMs: responseTimeMs
					}),
					timeToFirstOutputMs,
					timeBetweenOutputChunksMs: timeBetweenOutputChunksMs.length > 0 ? calculateOutputChunkTimingStats(timeBetweenOutputChunksMs) : void 0
				};
				await notify({
					event: {
						callId,
						provider,
						modelId: responseModelId,
						finishReason: chunk.finishReason.unified,
						usage,
						content: modelCallContent,
						responseId,
						...chunk.providerMetadata != null ? { providerMetadata: chunk.providerMetadata } : {},
						performance
					},
					callbacks: onLanguageModelCallEnd
				});
				const enforcedToolChoice = toolChoice.type === "required" || toolChoice.type === "tool" ? toolChoice : void 0;
				const toolChoiceViolationError = enforcedToolChoice != null && ![...toolCallsByToolCallId.values()].some((toolCall) => enforcedToolChoice.type === "required" || toolCall.toolName === enforcedToolChoice.toolName) ? new ToolChoiceViolationError({
					toolChoice: enforcedToolChoice,
					finishReason: chunk.finishReason.unified,
					provider,
					modelId,
					content: rawModelCallContent
				}) : void 0;
				controller.enqueue({
					type: "model-call-end",
					finishReason: toolChoiceViolationError == null ? chunk.finishReason.unified : "error",
					rawFinishReason: chunk.finishReason.raw,
					usage,
					providerMetadata: chunk.providerMetadata,
					performance
				});
				if (toolChoiceViolationError != null) {
					controller.enqueue({
						type: "error",
						error: toolChoiceViolationError
					});
					break;
				}
				break;
			}
			case "tool-call":
				rawModelCallContent.push(chunk);
				try {
					const toolCall = await parseToolCall({
						toolCall: chunk,
						tools,
						repairToolCall,
						refineToolInput,
						instructions,
						messages,
						abortSignal
					});
					toolCallsByToolCallId.set(toolCall.toolCallId, toolCall);
					controller.enqueue(toolCall);
					modelCallContent.push(toolCall);
					if (toolCall.invalid) {
						if (!toolCall.providerExecuted) controller.enqueue({
							type: "tool-error",
							toolCallId: toolCall.toolCallId,
							toolName: toolCall.toolName,
							input: toolCall.input,
							error: getErrorMessage(toolCall.error),
							dynamic: true,
							title: toolCall.title,
							...toolCall.toolMetadata != null ? { toolMetadata: toolCall.toolMetadata } : {}
						});
						break;
					}
				} catch (error) {
					controller.enqueue({
						type: "error",
						error
					});
				}
				break;
			case "tool-approval-request": {
				rawModelCallContent.push(chunk);
				const toolCall = toolCallsByToolCallId.get(chunk.toolCallId);
				if (toolCall == null) {
					controller.enqueue({
						type: "error",
						error: new ToolCallNotFoundForApprovalError({
							toolCallId: chunk.toolCallId,
							approvalId: chunk.approvalId
						})
					});
					break;
				}
				const toolApprovalRequest = {
					type: "tool-approval-request",
					approvalId: chunk.approvalId,
					toolCall
				};
				controller.enqueue(toolApprovalRequest);
				modelCallContent.push(toolApprovalRequest);
				break;
			}
			case "tool-result": {
				rawModelCallContent.push(chunk);
				const toolName = chunk.toolName;
				const toolCall = toolCallsByToolCallId.get(chunk.toolCallId);
				const toolResultPart = chunk.isError ? {
					type: "tool-error",
					toolCallId: chunk.toolCallId,
					toolName,
					input: toolCall?.input,
					providerExecuted: true,
					error: chunk.result,
					dynamic: chunk.dynamic,
					...chunk.providerMetadata != null ? { providerMetadata: chunk.providerMetadata } : {},
					...toolCall?.toolMetadata != null ? { toolMetadata: toolCall.toolMetadata } : {}
				} : {
					type: "tool-result",
					toolCallId: chunk.toolCallId,
					toolName,
					input: toolCall?.input,
					output: chunk.result,
					providerExecuted: true,
					dynamic: chunk.dynamic,
					...chunk.providerMetadata != null ? { providerMetadata: chunk.providerMetadata } : {},
					...toolCall?.toolMetadata != null ? { toolMetadata: toolCall.toolMetadata } : {}
				};
				controller.enqueue(toolResultPart);
				modelCallContent.push(toolResultPart);
				break;
			}
			case "tool-input-start": {
				const tool = getOwn(tools, chunk.toolName);
				controller.enqueue({
					...chunk,
					dynamic: chunk.dynamic ?? tool?.type === "dynamic",
					title: tool?.title,
					...tool?.metadata != null ? { toolMetadata: tool.metadata } : {}
				});
				break;
			}
			case "stream-start":
				controller.enqueue({
					type: "model-call-start",
					warnings: chunk.warnings
				});
				break;
			case "response-metadata":
				responseId = chunk.id ?? responseId;
				responseModelId = chunk.modelId ?? responseModelId;
				controller.enqueue({
					type: "model-call-response-metadata",
					id: chunk.id,
					timestamp: chunk.timestamp,
					modelId: chunk.modelId
				});
				break;
			default:
				if (chunk.type === "custom" || chunk.type === "source") {
					modelCallContent.push(chunk);
					rawModelCallContent.push(chunk);
				}
				controller.enqueue(chunk);
		}
	} });
}
/**
* Returns true for chunks that contain generated model output.
* Used to measure time-to-first-output for text, reasoning, generated files,
* and tool calls.
*/
function isOutputChunk(chunk) {
	return chunk.type === "text-delta" && chunk.delta.length > 0 || chunk.type === "reasoning-delta" && chunk.delta.length > 0 || chunk.type === "tool-input-delta" && chunk.delta.length > 0 || chunk.type === "file" || chunk.type === "reasoning-file" || chunk.type === "tool-call";
}
function calculateOutputChunkTimingStats(timingsMs) {
	const sortedTimingsMs = [...timingsMs].sort((a, b) => a - b);
	const sum = timingsMs.reduce((sum, timingMs) => sum + timingMs, 0);
	return {
		min: sortedTimingsMs[0],
		p10: calculateNearestRankPercentile(sortedTimingsMs, .1),
		median: calculateNearestRankPercentile(sortedTimingsMs, .5),
		avg: sum / timingsMs.length,
		p90: calculateNearestRankPercentile(sortedTimingsMs, .9),
		max: sortedTimingsMs[sortedTimingsMs.length - 1]
	};
}
function calculateNearestRankPercentile(sortedValues, percentile) {
	return sortedValues[Math.ceil(percentile * sortedValues.length) - 1];
}
/**
* Appends a text or reasoning content part into the content array and updates the part indexes.
*/
function upsertTextContentPart({ content, rawContent, partIndexes, rawPartIndexes, id, type, textDelta, providerMetadata }) {
	let partIndex = partIndexes.get(id);
	if (partIndex == null) {
		partIndex = content.push({
			type,
			text: "",
			...providerMetadata != null ? { providerMetadata } : {}
		}) - 1;
		partIndexes.set(id, partIndex);
	}
	let rawPartIndex = rawPartIndexes.get(id);
	if (rawPartIndex == null) {
		rawPartIndex = rawContent.push({
			type,
			text: "",
			...providerMetadata != null ? { providerMetadata } : {}
		}) - 1;
		rawPartIndexes.set(id, rawPartIndex);
	}
	const part = content[partIndex];
	const rawPart = rawContent[rawPartIndex];
	if (textDelta != null) {
		part.text += textDelta;
		rawPart.text += textDelta;
	}
	if (providerMetadata != null) {
		part.providerMetadata = providerMetadata;
		rawPart.providerMetadata = providerMetadata;
	}
}
const originalGenerateId$2 = createIdGenerator({
	prefix: "aitxt",
	size: 24
});
const originalGenerateCallId$7 = createIdGenerator({
	prefix: "call",
	size: 24
});
/**
* Generate a text and call tools for a given prompt using a language model.
*
* This function streams the output. If you do not want to stream the output, use `generateText` instead.
*
* @param model - The language model to use.
* @param tools - Tools that are accessible to and can be called by the model. The model needs to support calling tools.
* @param toolOrder - Controls the order in which tools are sent to the provider. Tools not listed are appended alphabetically.
* @param toolCallConcurrency - Maximum number of tool calls that may execute concurrently within a step. Set to 1 for sequential execution. Default: unlimited.
*
* @param system - A system message that will be part of the prompt.
* @param prompt - A simple text prompt. You can either use `prompt` or `messages` but not both.
* @param messages - A list of messages. You can either use `prompt` or `messages` but not both.
* @param allowSystemInMessages - Whether system messages are allowed in the `prompt` or `messages` fields. Default: false.
*
* @param maxOutputTokens - Maximum number of tokens to generate.
* @param temperature - Temperature setting.
* The value is passed through to the provider. The range depends on the provider and model.
* It is recommended to set either `temperature` or `topP`, but not both.
* @param topP - Nucleus sampling.
* The value is passed through to the provider. The range depends on the provider and model.
* It is recommended to set either `temperature` or `topP`, but not both.
* @param topK - Only sample from the top K options for each subsequent token.
* Used to remove "long tail" low probability responses.
* Recommended for advanced use cases only. You usually only need to use temperature.
* @param presencePenalty - Presence penalty setting.
* It affects the likelihood of the model to repeat information that is already in the prompt.
* The value is passed through to the provider. The range depends on the provider and model.
* @param frequencyPenalty - Frequency penalty setting.
* It affects the likelihood of the model to repeatedly use the same words or phrases.
* The value is passed through to the provider. The range depends on the provider and model.
* @param stopSequences - Stop sequences.
* If set, the model will stop generating text when one of the stop sequences is generated.
* @param seed - The seed (integer) to use for random sampling.
* If set and supported by the model, calls will generate deterministic results.
*
* @param maxRetries - Maximum number of retries. Set to 0 to disable retries. Default: 2.
* @param streamRetries - Maximum number of retries for provider errors received after streaming starts. Set to 0 to disable automatic stream retries while allowing `onError` to request retries. Omit to disable all stream retry behavior. Default: 0.
* @param abortSignal - An optional abort signal that can be used to cancel the call.
* @param timeout - An optional timeout in milliseconds. The call will be aborted if it takes longer than the specified timeout.
* @param headers - Additional HTTP headers to be sent with the request. Only applicable for HTTP-based providers.
*
* @param experimental_sandbox - The sandbox environment that is passed through to tool execution.
* @param runtimeContext - User-defined runtime context that flows through the entire generation lifecycle.
* @param experimental_refineToolInput - Optional mapping of tool names to functions that refine parsed tool inputs before tools are executed and before outputs, callbacks, and telemetry are recorded.
*
* @param onChunk - Callback that is called for each chunk of the stream. The stream processing will pause until the callback promise is resolved.
* @param onError - Callback that is called when an error occurs during streaming. You can use it to log errors.
* @param onStart - Callback invoked when generation begins, before any LLM calls.
* @param experimental_onStart - Deprecated alias for `onStart`.
* @param onStepStart - Callback invoked when each step begins, before the provider is called.
* @param experimental_onStepStart - Deprecated alias for `onStepStart`.
* @param onLanguageModelCallStart - Callback invoked immediately before each provider model call begins.
* @param experimental_onLanguageModelCallStart - Deprecated alias for `onLanguageModelCallStart`.
* @param onLanguageModelCallEnd - Callback invoked after each provider model call response is normalized and parsed.
* @param experimental_onLanguageModelCallEnd - Deprecated alias for `onLanguageModelCallEnd`.
* @param onToolExecutionStart - Callback invoked before each tool execution begins.
* @param experimental_onToolCallStart - Deprecated alias for `onToolExecutionStart`.
* @param onToolExecutionEnd - Callback invoked after each tool execution completes.
* @param experimental_onToolCallFinish - Deprecated alias for `onToolExecutionEnd`.
* @param onStepEnd - Callback that is called when each step (LLM call) ends, including intermediate steps.
* @param onStepFinish - Deprecated alias for `onStepEnd`.
* @param onEnd - Callback that is called when all steps are finished and the response is complete.
* @param onFinish - Deprecated alias for `onEnd`.
*
* @returns
* A result object for accessing different stream types and additional information.
*/
function streamText({ model, tools, toolChoice, instructions, system, prompt, messages, allowSystemInMessages, maxRetries, streamRetries, abortSignal, timeout, headers, stopWhen = isStepCount(1), experimental_sandbox: sandbox, output, toolApproval, experimental_toolCallers, experimental_toolApprovalSecret, experimental_telemetry, telemetry = experimental_telemetry, prepareStep, providerOptions, activeTools, toolOrder, toolCallConcurrency, experimental_repairToolCall, repairToolCall = experimental_repairToolCall, experimental_refineToolInput: refineToolInput, experimental_transform: transform, experimental_download: download, includeRawChunks, onChunk, onError: onErrorArg, onFinish, onEnd = onFinish, onAbort, onStepEnd, onStepFinish, onStart, experimental_onStart, onStepStart, experimental_onStepStart, onLanguageModelCallStart, experimental_onLanguageModelCallStart, onLanguageModelCallEnd, experimental_onLanguageModelCallEnd, onToolExecutionStart, onToolExecutionEnd, experimental_onToolCallStart, experimental_onToolCallFinish, runtimeContext = {}, toolsContext = {}, experimental_include, include = experimental_include, _internal: { now: now$2 = now, generateId = originalGenerateId$2, generateCallId = originalGenerateCallId$7 } = {}, ...settings }) {
	const resolvedToolCallConcurrency = prepareToolCallConcurrency(toolCallConcurrency);
	const totalTimeoutMs = getTotalTimeoutMs(timeout);
	const stepTimeoutMs = getStepTimeoutMs(timeout);
	const firstChunkTimeoutMs = getFirstChunkTimeoutMs(timeout);
	const chunkTimeoutMs = getChunkTimeoutMs(timeout);
	const stepAbortController = stepTimeoutMs != null ? new AbortController() : void 0;
	const firstChunkAbortController = firstChunkTimeoutMs != null ? new AbortController() : void 0;
	const chunkAbortController = chunkTimeoutMs != null ? new AbortController() : void 0;
	const onError = onErrorArg ?? (({ error }) => {
		console.error(error);
	});
	const resolvedOnStart = onStart ?? experimental_onStart;
	const resolvedOnStepStart = onStepStart ?? experimental_onStepStart;
	const resolvedOnLanguageModelCallStart = onLanguageModelCallStart ?? experimental_onLanguageModelCallStart;
	const resolvedOnLanguageModelCallEnd = onLanguageModelCallEnd ?? experimental_onLanguageModelCallEnd;
	const resolvedOnToolExecutionStart = onToolExecutionStart ?? experimental_onToolCallStart;
	const resolvedOnToolExecutionEnd = onToolExecutionEnd ?? experimental_onToolCallFinish;
	const resolvedOnStepEnd = onStepEnd ?? onStepFinish;
	return new DefaultStreamTextResult({
		model: resolveLanguageModel(model),
		telemetry,
		headers,
		settings,
		maxRetries,
		streamRetries,
		abortSignal: mergeAbortSignals(abortSignal, totalTimeoutMs, stepAbortController?.signal, firstChunkAbortController?.signal, chunkAbortController?.signal),
		stepTimeoutMs,
		stepAbortController,
		firstChunkTimeoutMs,
		firstChunkAbortController,
		chunkTimeoutMs,
		chunkAbortController,
		instructions,
		system,
		prompt,
		messages,
		allowSystemInMessages,
		experimental_sandbox: sandbox,
		tools,
		toolsContext,
		runtimeContext,
		toolChoice,
		transforms: asArray(transform),
		activeTools,
		toolOrder,
		toolCallConcurrency: resolvedToolCallConcurrency,
		repairToolCall,
		refineToolInput,
		stopConditions: asArray(stopWhen),
		output,
		toolApproval,
		experimental_toolCallers,
		experimental_toolApprovalSecret,
		providerOptions,
		prepareStep,
		timeout,
		onChunk,
		onError,
		canRetryStreamViaOnError: streamRetries !== void 0 && onErrorArg != null,
		onEnd,
		onAbort,
		onStepFinish: resolvedOnStepEnd,
		onStart: resolvedOnStart,
		onStepStart: resolvedOnStepStart,
		onLanguageModelCallStart: resolvedOnLanguageModelCallStart,
		onLanguageModelCallEnd: resolvedOnLanguageModelCallEnd,
		onToolExecutionStart: resolvedOnToolExecutionStart,
		onToolExecutionEnd: resolvedOnToolExecutionEnd,
		now: now$2,
		generateId,
		generateCallId,
		download,
		include: {
			requestBody: include?.requestBody ?? false,
			requestMessages: include?.requestMessages ?? false,
			rawChunks: include?.rawChunks ?? includeRawChunks ?? false
		}
	});
}
const streamRetryBoundarySymbol = Symbol("streamRetryBoundary");
function isStreamRetryBoundaryPart(part) {
	return streamRetryBoundarySymbol in part;
}
async function markPromiseAsHandled$1(promise) {
	try {
		await promise;
	} catch {}
}
function createOutputTransformStream(output) {
	let firstTextChunkId = void 0;
	let text = "";
	let textChunk = "";
	let textProviderMetadata = void 0;
	let lastPublishedValue = void 0;
	let hasPublishedValue = false;
	function resetOutputState() {
		firstTextChunkId = void 0;
		text = "";
		textChunk = "";
		textProviderMetadata = void 0;
		lastPublishedValue = void 0;
		hasPublishedValue = false;
	}
	function enqueueChunk({ controller, chunk }) {
		controller.enqueue(chunk);
	}
	function publishTextChunk({ controller, partialOutput = void 0 }) {
		enqueueChunk({
			controller,
			chunk: {
				part: {
					type: "text-delta",
					id: firstTextChunkId,
					text: textChunk,
					providerMetadata: textProviderMetadata
				},
				partialOutput
			}
		});
		textChunk = "";
	}
	return new TransformStream({ async transform(chunk, controller) {
		if (isStreamRetryBoundaryPart(chunk)) {
			resetOutputState();
			controller.enqueue(chunk);
			return;
		}
		if (chunk.type === "start-step") resetOutputState();
		if (chunk.type === "finish-step" && textChunk.length > 0) publishTextChunk({ controller });
		if (chunk.type !== "text-delta" && chunk.type !== "text-start" && chunk.type !== "text-end") {
			enqueueChunk({
				controller,
				chunk: {
					part: chunk,
					partialOutput: void 0
				}
			});
			return;
		}
		if (firstTextChunkId == null) firstTextChunkId = chunk.id;
		else if (chunk.id !== firstTextChunkId) {
			enqueueChunk({
				controller,
				chunk: {
					part: chunk,
					partialOutput: void 0
				}
			});
			return;
		}
		if (chunk.type === "text-start") {
			enqueueChunk({
				controller,
				chunk: {
					part: chunk,
					partialOutput: void 0
				}
			});
			return;
		}
		if (chunk.type === "text-end") {
			if (textChunk.length > 0) publishTextChunk({ controller });
			enqueueChunk({
				controller,
				chunk: {
					part: chunk,
					partialOutput: void 0
				}
			});
			return;
		}
		text += chunk.text;
		textChunk += chunk.text;
		textProviderMetadata = chunk.providerMetadata ?? textProviderMetadata;
		if (chunk.text.length === 0 && chunk.providerMetadata != null) {
			enqueueChunk({
				controller,
				chunk: {
					part: chunk,
					partialOutput: void 0
				}
			});
			return;
		}
		const result = await output.parsePartialOutput({ text });
		if (result !== void 0) {
			const currentValue = typeof result.partial === "string" ? result.partial : JSON.stringify(result.partial);
			if (!hasPublishedValue || currentValue !== lastPublishedValue) {
				publishTextChunk({
					controller,
					partialOutput: result.partial
				});
				lastPublishedValue = currentValue;
				hasPublishedValue = true;
			}
		}
	} });
}
function applyStreamTextTransforms({ stream, transforms, tools, stopStream }) {
	const sourceReader = stream.getReader();
	let sourceDone = false;
	let pendingBoundary;
	let transformedSegmentReader;
	const createTransformedSegmentReader = () => {
		let segment = new ReadableStream({
			async pull(controller) {
				const { done, value } = await sourceReader.read();
				if (done) {
					sourceDone = true;
					controller.close();
					return;
				}
				if (isStreamRetryBoundaryPart(value)) {
					pendingBoundary = value;
					controller.close();
					return;
				}
				controller.enqueue(value);
			},
			cancel(reason) {
				return sourceReader.cancel(reason);
			}
		}, { highWaterMark: 0 });
		for (const transform of transforms) segment = segment.pipeThrough(transform({
			tools,
			stopStream
		}));
		return segment.getReader();
	};
	return new ReadableStream({
		async pull(controller) {
			transformedSegmentReader ??= createTransformedSegmentReader();
			const { done, value } = await transformedSegmentReader.read();
			if (!done) {
				controller.enqueue(value);
				return;
			}
			transformedSegmentReader = void 0;
			if (pendingBoundary != null) {
				controller.enqueue(pendingBoundary);
				pendingBoundary = void 0;
				return;
			}
			if (sourceDone) controller.close();
		},
		async cancel(reason) {
			await transformedSegmentReader?.cancel(reason);
			await sourceReader.cancel(reason);
		}
	});
}
var DefaultStreamTextResult = class {
	constructor({ model, telemetry, headers, settings, maxRetries: maxRetriesArg, streamRetries: streamRetriesArg, abortSignal, stepTimeoutMs, stepAbortController, firstChunkTimeoutMs, firstChunkAbortController, chunkTimeoutMs, chunkAbortController, instructions, system, prompt, messages, allowSystemInMessages, experimental_sandbox: sandbox, tools, toolChoice, transforms, activeTools, toolOrder, toolCallConcurrency, repairToolCall, refineToolInput, stopConditions, output, toolApproval, experimental_toolCallers, experimental_toolApprovalSecret, providerOptions, prepareStep, now, generateId, generateCallId, timeout, onChunk, onError, canRetryStreamViaOnError, onEnd, onAbort, onStepFinish, onStart, onStepStart, onLanguageModelCallStart, onLanguageModelCallEnd, onToolExecutionStart, onToolExecutionEnd, runtimeContext, toolsContext, download, include }) {
		this._totalUsage = new DelayedPromise();
		this._finishReason = new DelayedPromise();
		this._rawFinishReason = new DelayedPromise();
		this._steps = new DelayedPromise();
		this._initialResponseMessages = new DelayedPromise();
		this.outputSpecification = output;
		this.tools = tools;
		const resolvedToolCallers = resolveToolCallerConfiguration({
			tools,
			toolCallers: experimental_toolCallers
		});
		const prepareToolSearch = createToolSearchState({
			tools,
			toolCallers: resolvedToolCallers
		});
		const telemetryDispatcher = createRestrictedTelemetryDispatcher$3({
			telemetry,
			includeRuntimeContext: telemetry?.includeRuntimeContext,
			includeToolsContext: telemetry?.includeToolsContext
		});
		let stepFinish;
		let recordedContent = [];
		let recordedFinishReason = void 0;
		let recordedRawFinishReason = void 0;
		let recordedTotalUsage = void 0;
		let recordedRequest = {};
		let recordedRequestMessages = [];
		let recordedWarnings = [];
		const recordedSteps = [];
		const initialResponseMessages = [];
		let stepMessagesForNextStep;
		let currentStepMessages = [];
		let isAborted = false;
		let currentStepModel = model;
		const createPartIdReserver = () => {
			const usedIds = /* @__PURE__ */ new Set();
			return (id) => {
				if (!usedIds.has(id)) {
					usedIds.add(id);
					return id;
				}
				const generatedId = generateId();
				let uniqueId = generatedId;
				let suffix = 0;
				while (usedIds.has(uniqueId)) uniqueId = `${generatedId}-${++suffix}`;
				usedIds.add(uniqueId);
				return uniqueId;
			};
		};
		const reserveTextPartId = createPartIdReserver();
		const reserveReasoningPartId = createPartIdReserver();
		const pendingDeferredToolCalls = /* @__PURE__ */ new Map();
		let activeTextContent = createIdMap();
		let activeReasoningContent = createIdMap();
		let recordedNoOutputError;
		const errorsHandledForStreamRetry = /* @__PURE__ */ new Set();
		const eventProcessor = new TransformStream({
			async transform(chunk, controller) {
				if (isStreamRetryBoundaryPart(chunk)) {
					const retryBoundary = chunk[streamRetryBoundarySymbol];
					recordedContent = [];
					activeReasoningContent = createIdMap();
					activeTextContent = createIdMap();
					recordedRequest = retryBoundary.request;
					recordedRequestMessages = retryBoundary.request.messages ?? [];
					recordedWarnings = retryBoundary.warnings;
					return;
				}
				const { part } = chunk;
				controller.enqueue(chunk);
				const callbacksHandledForStreamRetry = part.type === "error" && errorsHandledForStreamRetry.has(part.error);
				if (!callbacksHandledForStreamRetry) await notify({
					event: { chunk: part },
					callbacks: onChunk
				});
				if (part.type === "error") {
					const error = wrapGatewayError(part.error);
					if (NoOutputGeneratedError.isInstance(error)) recordedNoOutputError = error;
					if (callbacksHandledForStreamRetry) errorsHandledForStreamRetry.delete(part.error);
					else await notify({
						event: { error },
						callbacks: async (event) => {
							await onError(event);
						}
					});
				}
				if (part.type === "custom" || part.type === "source" || part.type === "tool-call" || part.type === "tool-approval-request" || part.type === "tool-approval-response" || part.type === "tool-error") recordedContent.push(part);
				if (part.type === "text-start") {
					activeTextContent[part.id] = {
						type: "text",
						text: "",
						providerMetadata: part.providerMetadata
					};
					recordedContent.push(activeTextContent[part.id]);
				}
				if (part.type === "text-delta") {
					const activeText = activeTextContent[part.id];
					if (activeText == null) {
						controller.enqueue({
							part: {
								type: "error",
								error: `text part ${part.id} not found`
							},
							partialOutput: void 0
						});
						return;
					}
					activeText.text += part.text;
					activeText.providerMetadata = part.providerMetadata ?? activeText.providerMetadata;
				}
				if (part.type === "text-end") {
					const activeText = activeTextContent[part.id];
					if (activeText == null) {
						controller.enqueue({
							part: {
								type: "error",
								error: `text part ${part.id} not found`
							},
							partialOutput: void 0
						});
						return;
					}
					activeText.providerMetadata = part.providerMetadata ?? activeText.providerMetadata;
					if (part.citations != null) activeText.citations = part.citations;
					delete activeTextContent[part.id];
				}
				if (part.type === "reasoning-start") {
					activeReasoningContent[part.id] = {
						type: "reasoning",
						text: "",
						providerMetadata: part.providerMetadata
					};
					recordedContent.push(activeReasoningContent[part.id]);
				}
				if (part.type === "reasoning-delta") {
					const activeReasoning = activeReasoningContent[part.id];
					if (activeReasoning == null) {
						controller.enqueue({
							part: {
								type: "error",
								error: `reasoning part ${part.id} not found`
							},
							partialOutput: void 0
						});
						return;
					}
					activeReasoning.text += part.text;
					activeReasoning.providerMetadata = part.providerMetadata ?? activeReasoning.providerMetadata;
				}
				if (part.type === "reasoning-end") {
					const activeReasoning = activeReasoningContent[part.id];
					if (activeReasoning == null) {
						controller.enqueue({
							part: {
								type: "error",
								error: `reasoning part ${part.id} not found`
							},
							partialOutput: void 0
						});
						return;
					}
					activeReasoning.providerMetadata = part.providerMetadata ?? activeReasoning.providerMetadata;
					delete activeReasoningContent[part.id];
				}
				if (part.type === "file" || part.type === "reasoning-file") recordedContent.push({
					type: part.type,
					file: part.file,
					...part.providerMetadata != null ? { providerMetadata: part.providerMetadata } : {}
				});
				if (part.type === "tool-result" && !part.preliminary) recordedContent.push(part);
				if (part.type === "start-step") {
					recordedContent = [];
					activeReasoningContent = createIdMap();
					activeTextContent = createIdMap();
					recordedRequest = part.request;
					recordedWarnings = part.warnings;
				}
				if (part.type === "finish-step") {
					const stepResponseMessages = await toResponseMessages({
						content: recordedContent,
						tools
					});
					const currentStepResult = new DefaultStepResult({
						callId,
						stepNumber: recordedSteps.length,
						provider: currentStepModel.provider,
						modelId: currentStepModel.modelId,
						runtimeContext,
						toolsContext,
						content: recordedContent,
						finishReason: part.finishReason,
						rawFinishReason: part.rawFinishReason,
						usage: part.usage,
						performance: part.performance,
						warnings: recordedWarnings,
						request: {
							...recordedRequest,
							messages: include.requestMessages ? cloneModelMessages(recordedRequestMessages) : void 0
						},
						response: {
							...part.response,
							messages: cloneModelMessages(stepResponseMessages)
						},
						providerMetadata: part.providerMetadata
					});
					await notify({
						event: currentStepResult,
						callbacks: [onStepFinish, telemetryDispatcher.onStepEnd]
					});
					logWarnings({
						warnings: recordedWarnings,
						provider: currentStepModel.provider,
						model: currentStepModel.modelId
					});
					recordedSteps.push(currentStepResult);
					stepMessagesForNextStep = [...currentStepMessages, ...stepResponseMessages];
					stepFinish.resolve();
				}
				if (part.type === "finish") {
					recordedTotalUsage = part.totalUsage;
					recordedFinishReason = part.finishReason;
					recordedRawFinishReason = part.rawFinishReason;
				}
			},
			async flush(controller) {
				try {
					if (recordedSteps.length === 0 || recordedNoOutputError != null) {
						const error = abortSignal?.aborted ? abortSignal.reason : recordedNoOutputError ?? new NoOutputGeneratedError({ message: "No output generated. Check the stream for errors." });
						self.rejectResultPromises(error);
						return;
					}
					const finishReason = recordedFinishReason ?? "other";
					const totalUsage = recordedTotalUsage ?? createNullLanguageModelUsage();
					self._finishReason.resolve(finishReason);
					self._rawFinishReason.resolve(recordedRawFinishReason);
					self._totalUsage.resolve(totalUsage);
					self._steps.resolve(recordedSteps);
					if (isAborted) return;
					const finalStep = recordedSteps[recordedSteps.length - 1];
					const content = recordedSteps.flatMap((step) => step.content);
					const files = recordedSteps.flatMap((step) => step.files);
					const sources = recordedSteps.flatMap((step) => step.sources);
					const toolCalls = recordedSteps.flatMap((step) => step.toolCalls);
					const staticToolCalls = recordedSteps.flatMap((step) => step.staticToolCalls);
					const dynamicToolCalls = recordedSteps.flatMap((step) => step.dynamicToolCalls);
					const toolResults = recordedSteps.flatMap((step) => step.toolResults);
					const staticToolResults = recordedSteps.flatMap((step) => step.staticToolResults);
					const dynamicToolResults = recordedSteps.flatMap((step) => step.dynamicToolResults);
					const warnings = recordedSteps.flatMap((step) => step.warnings ?? []);
					const onEndWithOutput = onEnd == null ? void 0 : async (event) => {
						const parsedOutput = output == null ? void 0 : await self.getOutputPromise().catch(() => void 0);
						await onEnd({
							...event,
							...output != null ? { output: parsedOutput } : {}
						});
					};
					const onEndEvent = {
						callId,
						toolsContext: finalStep.toolsContext,
						stepNumber: finalStep.stepNumber,
						model: finalStep.model,
						runtimeContext: finalStep.runtimeContext,
						finishReason: finalStep.finishReason,
						rawFinishReason: finalStep.rawFinishReason,
						usage: totalUsage,
						totalUsage,
						content,
						text: finalStep.text,
						reasoning: finalStep.reasoning,
						reasoningText: finalStep.reasoningText,
						files,
						sources,
						toolCalls,
						staticToolCalls,
						dynamicToolCalls,
						toolResults,
						staticToolResults,
						dynamicToolResults,
						responseMessages: [...initialResponseMessages, ...recordedSteps.flatMap((step) => step.response.messages)],
						warnings,
						request: finalStep.request,
						response: finalStep.response,
						providerMetadata: finalStep.providerMetadata,
						steps: recordedSteps,
						finalStep
					};
					await Promise.all([notify({
						event: onEndEvent,
						callbacks: onEndWithOutput
					}), notify({
						event: onEndEvent,
						callbacks: telemetryDispatcher.onEnd
					})]);
				} catch (error) {
					controller.error(error);
				}
			}
		});
		const stitchableStream = createStitchableStream();
		this.addStream = stitchableStream.addStream;
		this.closeStream = stitchableStream.close;
		const reader = stitchableStream.stream.getReader();
		const cancelOnAbort = () => {
			this.rejectResultPromises(abortSignal?.reason);
			reader.cancel(abortSignal?.reason).catch(() => {});
		};
		const removeAbortListener = () => abortSignal?.removeEventListener("abort", cancelOnAbort);
		let stream = new ReadableStream({
			async start(controller) {
				controller.enqueue({ type: "start" });
				abortSignal?.addEventListener("abort", cancelOnAbort, { once: true });
				if (abortSignal?.aborted) cancelOnAbort();
			},
			async pull(controller) {
				async function abort() {
					isAborted = true;
					removeAbortListener();
					await notify({
						event: {
							callId,
							steps: recordedSteps,
							...abortSignal?.reason !== void 0 ? { reason: abortSignal.reason } : {}
						},
						callbacks: [onAbort, telemetryDispatcher.onAbort]
					});
					controller.enqueue({
						type: "abort",
						...abortSignal?.reason !== void 0 ? { reason: getErrorMessage(abortSignal.reason) } : {}
					});
					controller.close();
				}
				try {
					const { done, value } = await reader.read();
					if (abortSignal?.aborted) {
						await abort();
						return;
					}
					if (done) {
						removeAbortListener();
						controller.close();
						return;
					}
					controller.enqueue(value);
				} catch (error) {
					removeAbortListener();
					if (isAbortError(error) && abortSignal?.aborted) await abort();
					else {
						await telemetryDispatcher.onError?.({
							callId,
							error
						});
						controller.error(error);
					}
				}
			},
			cancel(reason) {
				removeAbortListener();
				return reader.cancel(reason);
			}
		});
		let isRunning = true;
		stream = stream.pipeThrough(new TransformStream({ async transform(chunk, controller) {
			if (isRunning) controller.enqueue(chunk);
		} }));
		stream = applyStreamTextTransforms({
			stream,
			transforms,
			tools,
			stopStream() {
				stitchableStream.terminate();
				isRunning = false;
			}
		});
		this.baseStream = stream.pipeThrough(createOutputTransformStream(output ?? text())).pipeThrough(eventProcessor);
		const { maxRetries } = prepareRetries({
			maxRetries: maxRetriesArg,
			abortSignal
		});
		const { maxRetries: streamRetries } = prepareRetries({
			maxRetries: streamRetriesArg,
			abortSignal,
			parameter: "streamRetries",
			defaultMaxRetries: 0
		});
		const callSettings = prepareLanguageModelCallOptions(settings);
		const self = this;
		const callId = generateCallId();
		(async () => {
			const initialPrompt = await standardizePrompt({
				instructions,
				system,
				prompt,
				messages,
				allowSystemInMessages
			});
			const startEvent = {
				callId,
				operationId: "ai.streamText",
				provider: model.provider,
				modelId: model.modelId,
				instructions: initialPrompt.instructions,
				messages: initialPrompt.messages,
				tools,
				toolChoice,
				activeTools,
				toolOrder,
				maxOutputTokens: callSettings.maxOutputTokens,
				temperature: callSettings.temperature,
				topP: callSettings.topP,
				topK: callSettings.topK,
				presencePenalty: callSettings.presencePenalty,
				frequencyPenalty: callSettings.frequencyPenalty,
				stopSequences: callSettings.stopSequences,
				seed: callSettings.seed,
				reasoning: callSettings.reasoning,
				maxRetries,
				timeout,
				headers,
				providerOptions,
				output,
				runtimeContext,
				toolsContext
			};
			const streamTextTracingChannelContext = telemetryDispatcher.startTracingChannelContext?.({
				type: "streamText",
				event: startEvent,
				completion: self._totalUsage.promise.then(() => void 0)
			});
			const runInStreamTextTracingChannelContext = (execute) => streamTextTracingChannelContext?.run(execute) ?? execute();
			const runInTracingChannelSpanInStreamText = telemetryDispatcher.runInTracingChannelSpan == null ? void 0 : (options) => runInStreamTextTracingChannelContext(() => telemetryDispatcher.runInTracingChannelSpan(options));
			await notify({
				event: startEvent,
				callbacks: [onStart, telemetryDispatcher.onStart]
			});
			const initialMessages = initialPrompt.messages;
			let instructionsForNextStep = initialPrompt.instructions;
			const { approvedToolApprovals, deniedToolApprovals } = collectToolApprovals({ messages: initialMessages });
			if (deniedToolApprovals.length > 0 || approvedToolApprovals.length > 0) {
				const { approvedToolApprovals: localApprovedToolApprovals, deniedToolApprovals: revalidationDeniedToolApprovals, invalidToolApprovals } = await validateApprovedToolApprovals({
					approvedToolApprovals: approvedToolApprovals.filter((toolApproval) => !toolApproval.toolCall.providerExecuted),
					tools,
					toolApproval,
					messages: initialMessages,
					toolsContext,
					runtimeContext,
					toolApprovalSecret: experimental_toolApprovalSecret,
					refineToolInput
				});
				const localDeniedToolApprovals = [...deniedToolApprovals.filter((toolApproval) => !toolApproval.toolCall.providerExecuted), ...revalidationDeniedToolApprovals];
				const localDeniedToolApprovalsWithoutResults = localDeniedToolApprovals.filter((toolApproval) => toolApproval.existingToolResult == null);
				const deniedProviderExecutedToolApprovals = deniedToolApprovals.filter((toolApproval) => toolApproval.toolCall.providerExecuted);
				let toolExecutionStepStreamController;
				const toolExecutionStepStream = new ReadableStream({ start(controller) {
					toolExecutionStepStreamController = controller;
				} });
				self.addStream(toolExecutionStepStream);
				try {
					for (const toolApproval of [...localDeniedToolApprovals, ...deniedProviderExecutedToolApprovals]) toolExecutionStepStreamController?.enqueue({
						type: "tool-output-denied",
						toolCallId: toolApproval.toolCall.toolCallId,
						toolName: toolApproval.toolCall.toolName
					});
					for (const toolApproval of invalidToolApprovals) toolExecutionStepStreamController?.enqueue({
						type: "tool-error",
						toolCallId: toolApproval.toolCall.toolCallId,
						toolName: toolApproval.toolCall.toolName,
						input: toolApproval.toolCall.input,
						error: getErrorMessage(toolApproval.error),
						title: toolApproval.toolCall.title,
						...toolApproval.toolCall.dynamic === true ? { dynamic: true } : {},
						...toolApproval.toolCall.toolMetadata != null ? { toolMetadata: toolApproval.toolCall.toolMetadata } : {}
					});
					const toolOutputs = [];
					await mapWithConcurrency({
						items: localApprovedToolApprovals,
						concurrency: toolCallConcurrency,
						abortSignal,
						execute: async (toolApproval) => {
							const result = await executeToolCall({
								toolCall: toolApproval.toolCall,
								tools,
								callId,
								messages: initialMessages,
								abortSignal,
								timeout,
								experimental_sandbox: sandbox,
								toolsContext,
								onToolExecutionStart: filterNullable(onToolExecutionStart, telemetryDispatcher.onToolExecutionStart),
								onToolExecutionEnd: filterNullable(onToolExecutionEnd, telemetryDispatcher.onToolExecutionEnd),
								executeToolInTelemetryContext: telemetryDispatcher.executeTool,
								runInTracingChannelSpan: runInTracingChannelSpanInStreamText,
								onPreliminaryToolResult: (result) => {
									toolExecutionStepStreamController?.enqueue(result);
								}
							});
							if (result != null) {
								toolExecutionStepStreamController?.enqueue(result.output);
								toolOutputs.push(result.output);
							}
						}
					});
					if (toolOutputs.length > 0 || localDeniedToolApprovalsWithoutResults.length > 0 || invalidToolApprovals.length > 0) {
						const localToolContent = [];
						for (const output of toolOutputs) localToolContent.push({
							type: "tool-result",
							toolCallId: output.toolCallId,
							toolName: output.toolName,
							output: await createToolModelOutput({
								toolCallId: output.toolCallId,
								input: output.input,
								tool: getOwn(tools, output.toolName),
								output: output.type === "tool-result" ? output.output : output.error,
								errorMode: output.type === "tool-error" ? "text" : "none"
							})
						});
						for (const toolApproval of invalidToolApprovals) localToolContent.push({
							type: "tool-result",
							toolCallId: toolApproval.toolCall.toolCallId,
							toolName: toolApproval.toolCall.toolName,
							output: await createToolModelOutput({
								toolCallId: toolApproval.toolCall.toolCallId,
								input: toolApproval.toolCall.input,
								tool: getOwn(tools, toolApproval.toolCall.toolName),
								output: toolApproval.error,
								errorMode: "text"
							})
						});
						for (const toolApproval of localDeniedToolApprovalsWithoutResults) localToolContent.push({
							type: "tool-result",
							toolCallId: toolApproval.toolCall.toolCallId,
							toolName: toolApproval.toolCall.toolName,
							output: {
								type: "execution-denied",
								reason: toolApproval.approvalResponse.reason
							}
						});
						initialResponseMessages.push({
							role: "tool",
							content: localToolContent
						});
					}
				} finally {
					toolExecutionStepStreamController?.close();
				}
			}
			self._initialResponseMessages.resolve(initialResponseMessages);
			async function streamStep({ currentStep, usage }) {
				const stepTimeoutId = setAbortTimeout({
					abortController: stepAbortController,
					label: "Step",
					timeoutMs: stepTimeoutMs
				});
				let firstChunkTimeoutId = void 0;
				function startFirstChunkTimeout() {
					if (abortSignal?.aborted) return;
					firstChunkTimeoutId = setAbortTimeout({
						abortController: firstChunkAbortController,
						label: "First chunk",
						timeoutMs: firstChunkTimeoutMs
					});
				}
				function clearFirstChunkTimeout() {
					if (firstChunkTimeoutId != null) {
						clearTimeout(firstChunkTimeoutId);
						firstChunkTimeoutId = void 0;
					}
				}
				let chunkTimeoutId = void 0;
				function resetChunkTimeout() {
					if (chunkTimeoutId != null) clearTimeout(chunkTimeoutId);
					if (abortSignal?.aborted) return;
					chunkTimeoutId = setAbortTimeout({
						abortController: chunkAbortController,
						label: "Chunk",
						timeoutMs: chunkTimeoutMs
					});
				}
				function clearChunkTimeout() {
					if (chunkTimeoutId != null) {
						clearTimeout(chunkTimeoutId);
						chunkTimeoutId = void 0;
					}
				}
				function clearModelOutputTimeouts() {
					clearFirstChunkTimeout();
					clearChunkTimeout();
				}
				function clearStepTimeout() {
					if (stepTimeoutId != null) clearTimeout(stepTimeoutId);
				}
				function clearStepTimeouts() {
					clearStepTimeout();
					clearModelOutputTimeouts();
				}
				function cleanupStepTimeouts() {
					abortSignal?.removeEventListener("abort", cleanupStepTimeouts);
					clearStepTimeouts();
				}
				abortSignal?.addEventListener("abort", cleanupStepTimeouts, { once: true });
				try {
					stepFinish = new DelayedPromise();
					const stepTracingChannelContext = telemetryDispatcher.startTracingChannelContext?.({
						type: "step",
						event: {
							callId,
							stepNumber: currentStep
						},
						completion: stepFinish.promise
					});
					const runInStepTracingChannelContext = (execute) => stepTracingChannelContext?.run(execute) ?? execute();
					const responseMessagesFromPreviousSteps = recordedSteps.flatMap((step) => step.response.messages);
					const accumulatedResponseMessages = [...initialResponseMessages, ...responseMessagesFromPreviousSteps];
					const stepInputMessages = stepMessagesForNextStep ?? [...initialMessages, ...initialResponseMessages];
					const prepareStepResult = await prepareStep?.({
						model,
						steps: recordedSteps,
						stepNumber: recordedSteps.length,
						instructions: instructionsForNextStep,
						initialInstructions: initialPrompt.instructions,
						messages: stepInputMessages,
						initialMessages,
						responseMessages: accumulatedResponseMessages,
						toolsContext,
						runtimeContext,
						experimental_sandbox: sandbox
					});
					const stepSandbox = prepareStepResult?.experimental_sandbox ?? sandbox;
					runtimeContext = prepareStepResult?.runtimeContext ?? runtimeContext;
					toolsContext = prepareStepResult?.toolsContext ?? toolsContext;
					const stepModel = resolveLanguageModel(prepareStepResult?.model ?? model);
					currentStepModel = stepModel;
					const stepActiveTools = filterActiveTools({
						tools,
						activeTools: prepareStepResult?.activeTools ?? activeTools
					});
					const { executionTools: stepExecutionTools, modelTools: stepModelTools, toolCallerMessages } = prepareToolsForToolCallers({
						tools: prepareToolSearch(stepActiveTools, {
							toolsContext,
							experimental_sandbox: stepSandbox
						}),
						toolCallers: resolvedToolCallers
					});
					const stepToolOrder = prepareStepResult?.toolOrder ?? toolOrder;
					const stepTools = await prepareTools({
						tools: stepModelTools,
						toolOrder: stepToolOrder,
						toolsContext,
						experimental_sandbox: stepSandbox
					});
					const stepToolChoice = prepareToolChoice({ toolChoice: prepareStepResult?.toolChoice ?? toolChoice });
					const stepMessages = appendToolCallerMessages({
						messages: prepareStepResult?.messages ?? stepInputMessages,
						toolCallerMessages
					});
					currentStepMessages = stepMessages;
					const stepInstructions = prepareStepResult?.instructions ?? prepareStepResult?.system ?? instructionsForNextStep;
					instructionsForNextStep = stepInstructions;
					const stepProviderOptions = mergeObjects(providerOptions, prepareStepResult?.providerOptions);
					const stepCallSettings = prepareStepCallSettings({
						callSettings,
						stepSettings: prepareStepResult
					});
					const stepStartTimestampMs = now();
					const { retry } = prepareRetries({
						maxRetries,
						abortSignal
					});
					let hasNotifiedStepStart = false;
					const callLanguageModel = () => runInStepTracingChannelContext(() => retry(async () => streamLanguageModelCall({
						model: prepareStepResult?.model ?? model,
						tools: stepModelTools,
						toolOrder: stepToolOrder,
						toolChoice: prepareStepResult?.toolChoice ?? toolChoice,
						instructions: stepInstructions,
						messages: stepMessages,
						allowSystemInMessages,
						repairToolCall,
						refineToolInput,
						abortSignal,
						headers,
						includeRawChunks: include.rawChunks,
						providerOptions: stepProviderOptions,
						download,
						output,
						callId,
						executeLanguageModelCallInTelemetryContext: telemetryDispatcher.executeLanguageModelCall,
						toolsContext,
						experimental_sandbox: stepSandbox,
						onLanguageModelCallStart: filterNullable(onLanguageModelCallStart, telemetryDispatcher.onLanguageModelCallStart),
						onLanguageModelCallEnd: filterNullable(onLanguageModelCallEnd, telemetryDispatcher.onLanguageModelCallEnd),
						onStart: async ({ promptMessages }) => {
							if (hasNotifiedStepStart) return;
							hasNotifiedStepStart = true;
							await notify({
								event: {
									callId,
									provider: stepModel.provider,
									modelId: stepModel.modelId,
									stepNumber: recordedSteps.length,
									instructions: stepInstructions,
									messages: stepMessages,
									tools,
									toolChoice: prepareStepResult?.toolChoice ?? toolChoice,
									activeTools: prepareStepResult?.activeTools ?? activeTools,
									toolOrder: stepToolOrder,
									steps: [...recordedSteps],
									providerOptions: stepProviderOptions,
									runtimeContext,
									toolsContext,
									output,
									promptMessages,
									stepTools,
									stepToolChoice
								},
								callbacks: [onStepStart, telemetryDispatcher.onStepStart]
							});
						},
						_internal: { now },
						...stepCallSettings
					})));
					const initialLanguageModelCall = await callLanguageModel();
					let request = initialLanguageModelCall.request;
					let response = initialLanguageModelCall.response;
					let languageModelStreamReader = initialLanguageModelCall.stream.getReader();
					let automaticStreamRetryCount = 0;
					let callbackStreamRetryCount = 0;
					let bufferedAttemptParts = [];
					const openTextParts = /* @__PURE__ */ new Set();
					const openReasoningParts = /* @__PURE__ */ new Set();
					let enqueueStreamRetryAttemptBoundary = false;
					const shouldBufferToolParts = streamRetries > 0 || canRetryStreamViaOnError;
					const languageModelStream = new ReadableStream({
						async pull(controller) {
							const enqueueAttemptPart = (part) => {
								switch (part.type) {
									case "text-start":
										openTextParts.add(part.id);
										break;
									case "text-end":
										openTextParts.delete(part.id);
										break;
									case "reasoning-start":
										openReasoningParts.add(part.id);
										break;
									case "reasoning-end": openReasoningParts.delete(part.id);
								}
								controller.enqueue(part);
							};
							const flushBufferedAttemptParts = () => {
								for (const part of bufferedAttemptParts) enqueueAttemptPart(part);
								bufferedAttemptParts = [];
							};
							const closeOpenAttemptParts = () => {
								for (const id of openTextParts) controller.enqueue({
									type: "text-end",
									id
								});
								openTextParts.clear();
								for (const id of openReasoningParts) controller.enqueue({
									type: "reasoning-end",
									id
								});
								openReasoningParts.clear();
							};
							while (true) {
								let result;
								try {
									result = await languageModelStreamReader.read();
								} catch (error) {
									clearModelOutputTimeouts();
									throw error;
								}
								const { done, value } = result;
								if (enqueueStreamRetryAttemptBoundary) {
									controller.enqueue(createStreamRetryAttemptBoundaryPart({ warnings: !done && value.type === "model-call-start" ? value.warnings : [] }));
									enqueueStreamRetryAttemptBoundary = false;
								}
								if (done) {
									clearModelOutputTimeouts();
									flushBufferedAttemptParts();
									controller.close();
									return;
								}
								const isToolPart = value.type === "tool-input-start" || value.type === "tool-input-delta" || value.type === "tool-input-end" || value.type === "tool-call" || value.type === "tool-approval-request" || value.type === "tool-approval-response" || value.type === "tool-result" || value.type === "tool-error";
								if (value.type === "model-call-end") {
									clearModelOutputTimeouts();
									flushBufferedAttemptParts();
									enqueueAttemptPart(value);
									return;
								}
								if (isOutputChunk$1(value)) {
									clearFirstChunkTimeout();
									resetChunkTimeout();
								}
								if (shouldBufferToolParts && value.type !== "error" && (isToolPart || bufferedAttemptParts.length > 0)) {
									bufferedAttemptParts.push(value);
									continue;
								}
								if (value.type !== "error") {
									enqueueAttemptPart(value);
									return;
								}
								clearModelOutputTimeouts();
								await notify({
									event: { chunk: value },
									callbacks: onChunk
								});
								const error = wrapGatewayError(value.error);
								const isToolChoiceViolation = ToolChoiceViolationError.isInstance(error);
								let onErrorResult;
								try {
									onErrorResult = await onError({ error });
								} catch {}
								const callbackRequestedRetry = canRetryStreamViaOnError && typeof onErrorResult === "object" && onErrorResult != null && "retry" in onErrorResult && onErrorResult.retry === true;
								const automaticRetry = !isToolChoiceViolation && automaticStreamRetryCount < streamRetries;
								if (!automaticRetry && !(!isToolChoiceViolation && !automaticRetry && callbackRequestedRetry && callbackStreamRetryCount < 1)) {
									flushBufferedAttemptParts();
									errorsHandledForStreamRetry.add(value.error);
									controller.enqueue(value);
									return;
								}
								if (automaticRetry) automaticStreamRetryCount++;
								else callbackStreamRetryCount++;
								await languageModelStreamReader.cancel(error);
								bufferedAttemptParts = [];
								closeOpenAttemptParts();
								let retryLanguageModelCall;
								try {
									retryLanguageModelCall = await callLanguageModel();
								} catch (retryError) {
									controller.enqueue({
										type: "error",
										error: retryError
									});
									controller.close();
									return;
								}
								request = retryLanguageModelCall.request;
								response = retryLanguageModelCall.response;
								languageModelStreamReader = retryLanguageModelCall.stream.getReader();
								startFirstChunkTimeout();
								enqueueStreamRetryAttemptBoundary = true;
							}
						},
						cancel(reason) {
							clearModelOutputTimeouts();
							return languageModelStreamReader.cancel(reason);
						}
					});
					startFirstChunkTimeout();
					const streamAfterToolCallbackInvocation = invokeToolCallbacksFromStream({
						stream: languageModelStream,
						tools: stepExecutionTools,
						stepInputMessages: stepMessages,
						abortSignal,
						toolsContext
					});
					const runInTracingChannelSpanInStep = telemetryDispatcher.runInTracingChannelSpan == null ? void 0 : (options) => runInStepTracingChannelContext(() => telemetryDispatcher.runInTracingChannelSpan(options));
					const streamWithToolResults = executeToolsFromStream({
						stream: streamAfterToolCallbackInvocation,
						tools: stepExecutionTools,
						callId,
						messages: stepMessages,
						abortSignal,
						timeout,
						experimental_sandbox: stepSandbox,
						toolsContext,
						toolApproval,
						runtimeContext,
						toolApprovalSecret: experimental_toolApprovalSecret,
						generateId,
						onToolExecutionStart: filterNullable(onToolExecutionStart, telemetryDispatcher.onToolExecutionStart),
						onToolExecutionEnd: filterNullable(onToolExecutionEnd, telemetryDispatcher.onToolExecutionEnd),
						executeToolInTelemetryContext: telemetryDispatcher.executeTool,
						runInTracingChannelSpan: runInTracingChannelSpanInStep,
						toolCallConcurrency
					});
					const getStepRequest = () => ({
						...request,
						body: include.requestBody ? request?.body : void 0,
						messages: include.requestMessages ? cloneModelMessages(stepMessages) : void 0
					});
					recordedRequestMessages = getStepRequest().messages ?? [];
					const stepToolCalls = [];
					const stepToolOutputs = [];
					const stepToolApprovalResponses = [];
					let warnings;
					let stepFinishReason = "other";
					let stepRawFinishReason = void 0;
					let hasReceivedTerminalChunk = false;
					let hasReceivedOutputChunk = false;
					let stepUsage = createNullLanguageModelUsage();
					let stepProviderMetadata;
					let stepFirstChunk = true;
					const createModelCallPerformance = () => ({
						responseTimeMs: 0,
						effectiveOutputTokensPerSecond: 0,
						outputTokensPerSecond: void 0,
						inputTokensPerSecond: void 0,
						effectiveTotalTokensPerSecond: 0,
						timeToFirstOutputMs: void 0,
						timeBetweenOutputChunksMs: void 0
					});
					let modelCallPerformance = createModelCallPerformance();
					const toolExecutionMs = {};
					const createStepResponse = () => ({
						id: generateId(),
						timestamp: /* @__PURE__ */ new Date(),
						modelId: stepModel.modelId
					});
					let stepResponse = createStepResponse();
					const textPartIds = /* @__PURE__ */ new Map();
					const reasoningPartIds = /* @__PURE__ */ new Map();
					const enqueueStepPart = (controller, part) => {
						controller.enqueue(part);
					};
					self.addStream(streamWithToolResults.pipeThrough(new TransformStream({
						async transform(chunk, controller) {
							if (isStreamRetryAttemptBoundaryPart(chunk)) {
								warnings = chunk.warnings;
								stepFinishReason = "other";
								stepRawFinishReason = void 0;
								hasReceivedTerminalChunk = false;
								hasReceivedOutputChunk = false;
								stepUsage = createNullLanguageModelUsage();
								stepProviderMetadata = void 0;
								modelCallPerformance = createModelCallPerformance();
								stepResponse = createStepResponse();
								textPartIds.clear();
								reasoningPartIds.clear();
								controller.enqueue({ [streamRetryBoundarySymbol]: {
									request: getStepRequest(),
									warnings
								} });
								return;
							}
							if (chunk.type === "model-call-start") {
								warnings = chunk.warnings;
								return;
							}
							if (stepFirstChunk) {
								stepFirstChunk = false;
								enqueueStepPart(controller, {
									type: "start-step",
									request: getStepRequest(),
									warnings: warnings ?? []
								});
							}
							const chunkType = chunk.type;
							if (isOutputChunk$1(chunk)) hasReceivedOutputChunk = true;
							switch (chunkType) {
								case "file":
								case "custom":
								case "source":
								case "reasoning-file":
								case "tool-input-start":
								case "tool-input-end":
								case "tool-input-delta":
								case "tool-approval-request":
								case "tool-output-denied":
									enqueueStepPart(controller, chunk);
									break;
								case "text-start": {
									const id = reserveTextPartId(chunk.id);
									textPartIds.set(chunk.id, id);
									enqueueStepPart(controller, {
										...chunk,
										id
									});
									break;
								}
								case "text-delta":
									if (chunk.text.length > 0 || chunk.providerMetadata != null) enqueueStepPart(controller, {
										...chunk,
										id: textPartIds.get(chunk.id) ?? chunk.id
									});
									break;
								case "text-end":
									enqueueStepPart(controller, {
										...chunk,
										id: textPartIds.get(chunk.id) ?? chunk.id
									});
									textPartIds.delete(chunk.id);
									break;
								case "reasoning-start": {
									const id = reserveReasoningPartId(chunk.id);
									reasoningPartIds.set(chunk.id, id);
									enqueueStepPart(controller, {
										...chunk,
										id
									});
									break;
								}
								case "reasoning-delta":
									enqueueStepPart(controller, {
										...chunk,
										id: reasoningPartIds.get(chunk.id) ?? chunk.id
									});
									break;
								case "reasoning-end":
									enqueueStepPart(controller, {
										...chunk,
										id: reasoningPartIds.get(chunk.id) ?? chunk.id
									});
									reasoningPartIds.delete(chunk.id);
									break;
								case "tool-call":
									enqueueStepPart(controller, chunk);
									stepToolCalls.push(chunk);
									break;
								case "tool-approval-response":
									enqueueStepPart(controller, chunk);
									stepToolApprovalResponses.push(chunk);
									break;
								case "tool-result":
									enqueueStepPart(controller, chunk);
									if (!chunk.preliminary) stepToolOutputs.push(chunk);
									break;
								case "tool-error":
									enqueueStepPart(controller, chunk);
									stepToolOutputs.push(chunk);
									break;
								case "tool-execution-end":
									toolExecutionMs[chunk.toolCallId] = chunk.toolExecutionMs;
									break;
								case "model-call-response-metadata":
									stepResponse = {
										id: chunk.id ?? stepResponse.id,
										timestamp: chunk.timestamp ?? stepResponse.timestamp,
										modelId: chunk.modelId ?? stepResponse.modelId
									};
									break;
								case "model-call-end":
									hasReceivedTerminalChunk = true;
									stepUsage = chunk.usage;
									stepFinishReason = chunk.finishReason;
									stepRawFinishReason = chunk.rawFinishReason;
									stepProviderMetadata = chunk.providerMetadata;
									modelCallPerformance = chunk.performance;
									break;
								case "error":
									hasReceivedTerminalChunk = true;
									enqueueStepPart(controller, chunk);
									stepFinishReason = "error";
									break;
								case "raw":
									if (include.rawChunks) enqueueStepPart(controller, chunk);
									break;
								default: throw new Error(`Unknown chunk type: ${chunkType}`);
							}
						},
						async flush(controller) {
							if (!hasReceivedTerminalChunk && !hasReceivedOutputChunk) {
								enqueueStepPart(controller, {
									type: "error",
									error: new NoOutputGeneratedError({ message: "No output generated. The model stream ended without a finish chunk." })
								});
								cleanupStepTimeouts();
								self.closeStream();
								return;
							}
							const stepTimeMs = now() - stepStartTimestampMs;
							const finishStepPart = {
								type: "finish-step",
								finishReason: stepFinishReason,
								rawFinishReason: stepRawFinishReason,
								usage: stepUsage,
								performance: {
									stepTimeMs,
									toolExecutionMs,
									...modelCallPerformance
								},
								providerMetadata: stepProviderMetadata,
								response: {
									...stepResponse,
									headers: response?.headers
								}
							};
							enqueueStepPart(controller, finishStepPart);
							const combinedUsage = addLanguageModelUsage(usage, stepUsage);
							await stepFinish.promise;
							const clientToolCalls = stepToolCalls.filter((toolCall) => toolCall.providerExecuted !== true);
							const clientToolOutputs = stepToolOutputs.filter((toolOutput) => toolOutput.providerExecuted !== true);
							const deniedToolApprovalResponses = stepToolApprovalResponses.filter((toolApprovalResponse) => toolApprovalResponse.approved === false);
							for (const toolCall of stepToolCalls) {
								if (toolCall.providerExecuted !== true) continue;
								const tool = getOwn(stepExecutionTools, toolCall.toolName);
								if (tool?.type === "provider" && tool.supportsDeferredResults) {
									if (!stepToolOutputs.some((output) => (output.type === "tool-result" || output.type === "tool-error") && output.toolCallId === toolCall.toolCallId)) pendingDeferredToolCalls.set(toolCall.toolCallId, { toolName: toolCall.toolName });
								}
							}
							for (const output of stepToolOutputs) if (output.type === "tool-result" || output.type === "tool-error") pendingDeferredToolCalls.delete(output.toolCallId);
							cleanupStepTimeouts();
							if (clientToolCalls.length === clientToolOutputs.length + deniedToolApprovalResponses.length && (clientToolCalls.length > 0 || pendingDeferredToolCalls.size > 0) && !await isStopConditionMet({
								stopConditions,
								steps: recordedSteps
							})) try {
								await runInStreamTextTracingChannelContext(() => streamStep({
									currentStep: currentStep + 1,
									usage: combinedUsage
								}));
							} catch (error) {
								enqueueStepPart(controller, {
									type: "error",
									error
								});
								self.closeStream();
							}
							else {
								enqueueStepPart(controller, {
									type: "finish",
									finishReason: stepFinishReason,
									rawFinishReason: stepRawFinishReason,
									totalUsage: combinedUsage
								});
								self.closeStream();
							}
						}
					})), {
						onError: cleanupStepTimeouts,
						onCancel: cleanupStepTimeouts
					});
				} catch (error) {
					cleanupStepTimeouts();
					throw error;
				}
			}
			await runInStreamTextTracingChannelContext(() => streamStep({
				currentStep: 0,
				usage: createNullLanguageModelUsage()
			}));
		})().catch(async (error) => {
			await telemetryDispatcher.onError?.({
				callId,
				error
			});
			self._initialResponseMessages.reject(error);
			markPromiseAsHandled$1(self._initialResponseMessages.promise);
			self.addStream(new ReadableStream({ start(controller) {
				controller.enqueue({
					type: "error",
					error
				});
				controller.close();
			} }));
			self.closeStream();
		});
	}
	get steps() {
		this.consumeStream();
		return this._steps.promise;
	}
	get finalStep() {
		return this.steps.then((steps) => steps.at(-1));
	}
	get content() {
		return this.steps.then((steps) => steps.flatMap((step) => step.content));
	}
	get warnings() {
		return this.steps.then((steps) => steps.flatMap((step) => step.warnings ?? []));
	}
	get providerMetadata() {
		return this.finalStep.then((step) => step.providerMetadata);
	}
	get text() {
		return this.finalStep.then((step) => step.text);
	}
	get reasoningText() {
		return this.finalStep.then((step) => step.reasoningText);
	}
	get reasoning() {
		return this.finalStep.then((step) => convertToReasoningOutputs(step.reasoning));
	}
	get sources() {
		return this.steps.then((steps) => steps.flatMap((step) => step.sources));
	}
	get files() {
		return this.steps.then((steps) => steps.flatMap((step) => step.files));
	}
	get toolCalls() {
		return this.steps.then((steps) => steps.flatMap((step) => step.toolCalls));
	}
	get staticToolCalls() {
		return this.steps.then((steps) => steps.flatMap((step) => step.staticToolCalls));
	}
	get dynamicToolCalls() {
		return this.steps.then((steps) => steps.flatMap((step) => step.dynamicToolCalls));
	}
	get toolResults() {
		return this.steps.then((steps) => steps.flatMap((step) => step.toolResults));
	}
	get staticToolResults() {
		return this.steps.then((steps) => steps.flatMap((step) => step.staticToolResults));
	}
	get dynamicToolResults() {
		return this.steps.then((steps) => steps.flatMap((step) => step.dynamicToolResults));
	}
	get usage() {
		return this.totalUsage;
	}
	get request() {
		return this.finalStep.then((step) => step.request);
	}
	get response() {
		return this.finalStep.then((step) => step.response);
	}
	get responseMessages() {
		return Promise.all([this._initialResponseMessages.promise, this.steps]).then(([initialResponseMessages, steps]) => [...initialResponseMessages, ...steps.flatMap((step) => step.response.messages)]);
	}
	get totalUsage() {
		this.consumeStream();
		return this._totalUsage.promise;
	}
	get finishReason() {
		this.consumeStream();
		return this._finishReason.promise;
	}
	get rawFinishReason() {
		this.consumeStream();
		return this._rawFinishReason.promise;
	}
	/**
	* Split out a new stream from the original stream.
	* The original stream is replaced to allow for further splitting,
	* since we do not know how many times the stream will be split.
	*
	* Note: this leads to buffering the stream content on the server.
	* However, the LLM results are expected to be small enough to not cause issues.
	*/
	teeStream() {
		const [stream1, stream2] = this.baseStream.tee();
		this.baseStream = stream2;
		return stream1;
	}
	get textStream() {
		return createAsyncIterableStream(toTextStream({ stream: this.stream }));
	}
	get stream() {
		return createAsyncIterableStream(this.teeStream().pipeThrough(new TransformStream({ transform({ part }, controller) {
			controller.enqueue(part);
		} })));
	}
	get fullStream() {
		return this.stream;
	}
	rejectResultPromises(error) {
		this.rejectResultPromise({
			delayedPromise: this._finishReason,
			error
		});
		this.rejectResultPromise({
			delayedPromise: this._rawFinishReason,
			error
		});
		this.rejectResultPromise({
			delayedPromise: this._totalUsage,
			error
		});
		this.rejectResultPromise({
			delayedPromise: this._steps,
			error
		});
		this.rejectResultPromise({
			delayedPromise: this._initialResponseMessages,
			error
		});
	}
	rejectResultPromise({ delayedPromise, error }) {
		if (delayedPromise.isPending()) {
			delayedPromise.reject(error);
			markPromiseAsHandled$1(delayedPromise.promise);
		}
	}
	async consumeStream(options) {
		try {
			await consumeStream({
				stream: this.stream,
				onError: (error) => {
					this.rejectResultPromises(error);
					options?.onError?.(error);
				}
			});
		} catch (error) {
			this.rejectResultPromises(error);
			options?.onError?.(error);
		}
	}
	get experimental_partialOutputStream() {
		return this.partialOutputStream;
	}
	get partialOutputStream() {
		return createAsyncIterableStream(this.teeStream().pipeThrough(new TransformStream({ transform({ partialOutput }, controller) {
			if (partialOutput !== void 0) controller.enqueue(partialOutput);
		} })));
	}
	get elementStream() {
		const transform = this.outputSpecification?.createElementStreamTransform();
		if (transform == null) throw new UnsupportedFunctionalityError({ functionality: `element streams in ${this.outputSpecification?.name ?? "text"} mode` });
		return createAsyncIterableStream(this.teeStream().pipeThrough(transform));
	}
	getOutputPromise() {
		if (this.outputPromise == null) this.outputPromise = this.finalStep.then((step) => {
			return (this.outputSpecification ?? text()).parseCompleteOutput({ text: step.text }, {
				response: step.response,
				usage: step.usage,
				finishReason: step.finishReason
			});
		});
		return this.outputPromise;
	}
	get output() {
		return this.getOutputPromise();
	}
	toUIMessageStream({ originalMessages, generateMessageId, onStepEnd, onStepFinish, onEnd, onFinish, messageMetadata, sendReasoning, sendSources, sendStart, sendFinish, onError } = {}) {
		return createAsyncIterableStream(toUIMessageStream({
			stream: this.stream,
			tools: this.tools,
			originalMessages,
			generateMessageId,
			onStepEnd: onStepEnd ?? onStepFinish,
			onEnd: onEnd ?? onFinish,
			messageMetadata,
			sendReasoning,
			sendSources,
			sendStart,
			sendFinish,
			onError
		}));
	}
	pipeUIMessageStreamToResponse(response, { originalMessages, generateMessageId, onStepEnd, onStepFinish, onEnd, onFinish, messageMetadata, sendReasoning, sendSources, sendFinish, sendStart, onError, ...init } = {}) {
		return pipeUIMessageStreamToResponse({
			response,
			stream: this.toUIMessageStream({
				originalMessages,
				generateMessageId,
				onStepEnd: onStepEnd ?? onStepFinish,
				onEnd: onEnd ?? onFinish,
				messageMetadata,
				sendReasoning,
				sendSources,
				sendFinish,
				sendStart,
				onError
			}),
			...init
		});
	}
	pipeTextStreamToResponse(response, init) {
		return pipeTextStreamToResponse({
			response,
			stream: this.textStream,
			...init
		});
	}
	toUIMessageStreamResponse({ originalMessages, generateMessageId, onStepEnd, onStepFinish, onEnd, onFinish, messageMetadata, sendReasoning, sendSources, sendFinish, sendStart, onError, ...init } = {}) {
		return createUIMessageStreamResponse({
			stream: this.toUIMessageStream({
				originalMessages,
				generateMessageId,
				onStepEnd: onStepEnd ?? onStepFinish,
				onEnd: onEnd ?? onFinish,
				messageMetadata,
				sendReasoning,
				sendSources,
				sendFinish,
				sendStart,
				onError
			}),
			...init
		});
	}
	toTextStreamResponse(init) {
		return createTextStreamResponse({
			stream: this.textStream,
			...init
		});
	}
};
/**
* Stop conditions are only evaluated when the tool loop can otherwise continue,
* so logging here avoids warning when a call finishes naturally at the limit.
*/
function createDefaultStopCondition(stepCount) {
	return ({ steps }) => {
		if (steps.length !== stepCount) return false;
		const { provider, modelId } = steps[steps.length - 1].model;
		logWarnings({
			provider,
			model: modelId,
			warnings: [{
				type: "other",
				message: `The tool loop stopped because it reached the default stopWhen condition, isStepCount(${stepCount}). To allow more steps, set stopWhen to isStepCount(...) with a higher limit or provide a custom stop condition. Learn more: https://ai-sdk.dev/docs/agents/loop-control`
			}]
		});
		return true;
	};
}
/**
* A tool loop agent is an agent that runs tools in a loop. In each step,
* it calls the LLM, and if there are tool calls, it executes the tools
* and calls the LLM again in a new step with the tool results.
*
* The loop continues until:
* - A finish reasoning other than tool-calls is returned, or
* - A tool that is invoked does not have an execute function, or
* - A tool call needs approval via `toolApproval` or tool-level `needsApproval`, or
* - A stop condition is met (default stop condition is isStepCount(20))
*/
var ToolLoopAgent = class {
	constructor(settings) {
		this.version = "agent-v1";
		const { onFinish, onEnd = onFinish } = settings;
		this.settings = {
			...settings,
			onEnd
		};
	}
	/**
	* The id of the agent.
	*/
	get id() {
		return this.settings.id;
	}
	/**
	* The tools that the agent can use.
	*/
	get tools() {
		return this.settings.tools;
	}
	async prepareCall(options) {
		if (this.settings.callOptionsSchema != null && options.options !== void 0) {
			const validatedOptions = await validateTypes({
				value: options.options,
				schema: this.settings.callOptionsSchema,
				context: { field: "options" }
			});
			options = {
				...options,
				options: validatedOptions
			};
		}
		const { onStart: _settingsStableOnStart, experimental_onStart: _settingsExperimentalOnStart, onStepStart: _settingsStableOnStepStart, experimental_onStepStart: _settingsExperimentalOnStepStart, onToolExecutionStart: _settingsOnToolExecutionStart, onToolExecutionEnd: _settingsOnToolExecutionEnd, onStepEnd: _settingsOnStepEnd, onStepFinish: _settingsOnStepFinish, onFinish: _settingsOnFinish, onEnd: _settingsOnEnd, ...settingsWithoutCallbacks } = this.settings;
		const baseCallArgs = {
			...settingsWithoutCallbacks,
			stopWhen: this.settings.stopWhen ?? createDefaultStopCondition(20),
			...options
		};
		const { instructions, allowSystemInMessages, messages, prompt, runtimeContext, ...callArgs } = await this.settings.prepareCall?.(baseCallArgs) ?? baseCallArgs;
		const promptArgs = {
			instructions,
			allowSystemInMessages,
			messages,
			prompt
		};
		if (runtimeContext === void 0) return {
			...callArgs,
			...promptArgs
		};
		return {
			...callArgs,
			runtimeContext,
			...promptArgs
		};
	}
	/**
	* Tags outgoing requests so usage can be attributed to ToolLoopAgent. Chains
	* with the `ai/<version>` and `ai-sdk/<provider>/<version>` suffixes added
	* downstream by generateText/streamText and the provider.
	*/
	agentHeaders(preparedCall) {
		return withUserAgentSuffix(preparedCall.headers ?? {}, "ai-sdk-agent/tool-loop");
	}
	/**
	* Generates an output from the agent (non-streaming).
	*/
	async generate({ abortSignal, timeout, experimental_sandbox: sandbox, onStart, experimental_onStart, onStepStart, experimental_onStepStart, onToolExecutionStart, onToolExecutionEnd, onStepEnd, onStepFinish, onFinish, onEnd = onFinish, ...options }) {
		const generate = generateText;
		const preparedCall = await this.prepareCall({
			...options,
			experimental_sandbox: sandbox
		});
		const callbackArgs = {
			abortSignal,
			timeout: timeout ?? preparedCall.timeout,
			experimental_sandbox: sandbox,
			onStart: mergeCallbacks(this.settings.onStart ?? this.settings.experimental_onStart, onStart ?? experimental_onStart),
			onStepStart: mergeCallbacks(this.settings.onStepStart ?? this.settings.experimental_onStepStart, onStepStart ?? experimental_onStepStart),
			onToolExecutionStart: mergeCallbacks(this.settings.onToolExecutionStart, onToolExecutionStart),
			onToolExecutionEnd: mergeCallbacks(this.settings.onToolExecutionEnd, onToolExecutionEnd),
			onStepEnd: mergeCallbacks(this.settings.onStepEnd ?? this.settings.onStepFinish, onStepEnd ?? onStepFinish),
			onEnd: mergeCallbacks(this.settings.onEnd, onEnd)
		};
		return await generate({
			...preparedCall,
			...callbackArgs,
			headers: this.agentHeaders(preparedCall)
		});
	}
	/**
	* Streams an output from the agent (streaming).
	*/
	async stream({ abortSignal, timeout, experimental_sandbox: sandbox, experimental_transform, onStart, experimental_onStart, onStepStart, experimental_onStepStart, onToolExecutionStart, onToolExecutionEnd, onStepEnd, onStepFinish, onFinish, onEnd = onFinish, ...options }) {
		const stream = streamText;
		const preparedCall = await this.prepareCall({
			...options,
			experimental_sandbox: sandbox
		});
		const callbackArgs = {
			abortSignal,
			timeout: timeout ?? preparedCall.timeout,
			experimental_sandbox: sandbox,
			experimental_transform,
			onStart: mergeCallbacks(this.settings.onStart ?? this.settings.experimental_onStart, onStart ?? experimental_onStart),
			onStepStart: mergeCallbacks(this.settings.onStepStart ?? this.settings.experimental_onStepStart, onStepStart ?? experimental_onStepStart),
			onToolExecutionStart: mergeCallbacks(this.settings.onToolExecutionStart, onToolExecutionStart),
			onToolExecutionEnd: mergeCallbacks(this.settings.onToolExecutionEnd, onToolExecutionEnd),
			onStepEnd: mergeCallbacks(this.settings.onStepEnd ?? this.settings.onStepFinish, onStepEnd ?? onStepFinish),
			onEnd: mergeCallbacks(this.settings.onEnd, onEnd)
		};
		return await stream({
			...preparedCall,
			...callbackArgs,
			headers: this.agentHeaders(preparedCall)
		});
	}
};
const toolMetadataSchema = z.record(z.string(), jsonValueSchema.optional());
const providerReferenceSchema = z.record(z.string(), z.string());
lazySchema(() => {
	const approvalRequestedSchema = z.object({
		id: z.string(),
		approved: z.never().optional(),
		descriptor: z.unknown().optional(),
		requestReason: z.string().optional(),
		reason: z.never().optional(),
		isAutomatic: z.boolean().optional(),
		signature: z.string().optional(),
		inputSchemaInput: z.unknown().optional()
	});
	const approvalRespondedSchema = approvalRequestedSchema.extend({
		approved: z.boolean(),
		reason: z.string().optional()
	});
	const approvalGrantedSchema = approvalRespondedSchema.extend({ approved: z.literal(true) });
	const approvalDeniedSchema = approvalRespondedSchema.extend({ approved: z.literal(false) });
	return zodSchema(z.array(z.object({
		id: z.string(),
		role: z.enum([
			"system",
			"user",
			"assistant"
		]),
		metadata: z.unknown().optional(),
		parts: z.array(z.union([
			z.object({
				type: z.literal("text"),
				text: z.string(),
				citations: z.array(citationSchema).optional(),
				state: z.enum(["streaming", "done"]).optional(),
				providerMetadata: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("reasoning"),
				id: z.string().optional(),
				text: z.string(),
				state: z.enum(["streaming", "done"]).optional(),
				providerMetadata: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("custom"),
				kind: z.string(),
				providerMetadata: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("source-url"),
				sourceId: z.string(),
				url: z.string(),
				title: z.string().optional(),
				providerMetadata: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("source-document"),
				sourceId: z.string(),
				mediaType: z.string(),
				title: z.string(),
				filename: z.string().optional(),
				providerMetadata: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("file"),
				mediaType: z.string(),
				filename: z.string().optional(),
				url: z.string(),
				providerReference: providerReferenceSchema.optional(),
				providerMetadata: providerMetadataSchema.optional()
			}),
			z.object({
				type: z.literal("reasoning-file"),
				mediaType: z.string(),
				url: z.string(),
				providerMetadata: providerMetadataSchema.optional()
			}),
			z.object({ type: z.literal("step-start") }),
			z.object({
				type: z.string().startsWith("data-"),
				id: z.string().optional(),
				data: z.unknown()
			}),
			z.object({
				type: z.literal("dynamic-tool"),
				dynamic: z.literal(false).optional(),
				toolName: z.string(),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("input-streaming"),
				input: z.unknown().optional(),
				rawInput: z.string().optional(),
				providerExecuted: z.boolean().optional(),
				callProviderMetadata: providerMetadataSchema.optional(),
				output: z.never().optional(),
				errorText: z.never().optional(),
				approval: z.never().optional()
			}),
			z.object({
				type: z.literal("dynamic-tool"),
				dynamic: z.literal(false).optional(),
				toolName: z.string(),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("input-available"),
				input: z.unknown(),
				providerExecuted: z.boolean().optional(),
				output: z.never().optional(),
				errorText: z.never().optional(),
				callProviderMetadata: providerMetadataSchema.optional(),
				approval: z.never().optional()
			}),
			z.object({
				type: z.literal("dynamic-tool"),
				dynamic: z.literal(false).optional(),
				toolName: z.string(),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("approval-requested"),
				input: z.unknown(),
				providerExecuted: z.boolean().optional(),
				output: z.never().optional(),
				errorText: z.never().optional(),
				callProviderMetadata: providerMetadataSchema.optional(),
				approval: approvalRequestedSchema
			}),
			z.object({
				type: z.literal("dynamic-tool"),
				dynamic: z.literal(false).optional(),
				toolName: z.string(),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("approval-responded"),
				input: z.unknown(),
				providerExecuted: z.boolean().optional(),
				output: z.never().optional(),
				errorText: z.never().optional(),
				callProviderMetadata: providerMetadataSchema.optional(),
				approval: approvalRespondedSchema
			}),
			z.object({
				type: z.literal("dynamic-tool"),
				dynamic: z.literal(false).optional(),
				toolName: z.string(),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("output-available"),
				input: z.unknown(),
				providerExecuted: z.boolean().optional(),
				output: z.unknown(),
				errorText: z.never().optional(),
				callProviderMetadata: providerMetadataSchema.optional(),
				resultProviderMetadata: providerMetadataSchema.optional(),
				preliminary: z.boolean().optional(),
				approval: approvalGrantedSchema.optional()
			}),
			z.object({
				type: z.literal("dynamic-tool"),
				dynamic: z.literal(false).optional(),
				toolName: z.string(),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("output-error"),
				input: z.unknown().optional(),
				rawInput: z.unknown().optional(),
				providerExecuted: z.boolean().optional(),
				output: z.never().optional(),
				errorText: z.string(),
				callProviderMetadata: providerMetadataSchema.optional(),
				resultProviderMetadata: providerMetadataSchema.optional(),
				approval: approvalGrantedSchema.optional()
			}),
			z.object({
				type: z.literal("dynamic-tool"),
				dynamic: z.literal(false).optional(),
				toolName: z.string(),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("output-denied"),
				input: z.unknown(),
				providerExecuted: z.boolean().optional(),
				output: z.never().optional(),
				errorText: z.never().optional(),
				callProviderMetadata: providerMetadataSchema.optional(),
				approval: approvalDeniedSchema
			}),
			z.object({
				type: z.string().startsWith("tool-"),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("input-streaming"),
				providerExecuted: z.boolean().optional(),
				callProviderMetadata: providerMetadataSchema.optional(),
				input: z.unknown().optional(),
				rawInput: z.string().optional(),
				output: z.never().optional(),
				errorText: z.never().optional(),
				approval: z.never().optional()
			}),
			z.object({
				type: z.string().startsWith("tool-"),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("input-available"),
				providerExecuted: z.boolean().optional(),
				input: z.unknown(),
				output: z.never().optional(),
				errorText: z.never().optional(),
				callProviderMetadata: providerMetadataSchema.optional(),
				approval: z.never().optional()
			}),
			z.object({
				type: z.string().startsWith("tool-"),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("approval-requested"),
				input: z.unknown(),
				providerExecuted: z.boolean().optional(),
				output: z.never().optional(),
				errorText: z.never().optional(),
				callProviderMetadata: providerMetadataSchema.optional(),
				approval: approvalRequestedSchema
			}),
			z.object({
				type: z.string().startsWith("tool-"),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("approval-responded"),
				input: z.unknown(),
				providerExecuted: z.boolean().optional(),
				output: z.never().optional(),
				errorText: z.never().optional(),
				callProviderMetadata: providerMetadataSchema.optional(),
				approval: approvalRespondedSchema
			}),
			z.object({
				type: z.string().startsWith("tool-"),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("output-available"),
				providerExecuted: z.boolean().optional(),
				input: z.unknown(),
				output: z.unknown(),
				errorText: z.never().optional(),
				callProviderMetadata: providerMetadataSchema.optional(),
				resultProviderMetadata: providerMetadataSchema.optional(),
				preliminary: z.boolean().optional(),
				approval: approvalGrantedSchema.optional()
			}),
			z.object({
				type: z.string().startsWith("tool-"),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("output-error"),
				providerExecuted: z.boolean().optional(),
				input: z.unknown().optional(),
				rawInput: z.unknown().optional(),
				output: z.never().optional(),
				errorText: z.string(),
				callProviderMetadata: providerMetadataSchema.optional(),
				resultProviderMetadata: providerMetadataSchema.optional(),
				approval: approvalGrantedSchema.optional()
			}),
			z.object({
				type: z.string().startsWith("tool-"),
				toolCallId: z.string(),
				title: z.string().optional(),
				toolMetadata: toolMetadataSchema.optional(),
				state: z.literal("output-denied"),
				providerExecuted: z.boolean().optional(),
				input: z.unknown(),
				output: z.never().optional(),
				errorText: z.never().optional(),
				callProviderMetadata: providerMetadataSchema.optional(),
				approval: approvalDeniedSchema
			})
		]))
	}).superRefine((message, context) => {
		if (message.role !== "assistant" && message.parts.length === 0) context.addIssue({
			origin: "array",
			code: "too_small",
			minimum: 1,
			inclusive: true,
			input: message.parts,
			path: ["parts"],
			message: "Message must contain at least one part"
		});
	})).nonempty("Messages array must not be empty"));
});
/**
* Converts data content to a base64-encoded string.
*
* @param content - Data content to convert.
* @returns Base64-encoded string.
*/
function convertDataContentToBase64String(content) {
	if (typeof content === "string") return content;
	if (content instanceof ArrayBuffer) return convertUint8ArrayToBase64(new Uint8Array(content));
	return convertUint8ArrayToBase64(content);
}
createIdGenerator({
	prefix: "call",
	size: 24
});
createIdGenerator({
	prefix: "call",
	size: 24
});
new TextEncoder();
function isDecisionStateParts(state) {
	return Array.isArray(state);
}
async function prepareDecisionState(state, abortSignal) {
	if (typeof state === "string") return [{
		type: "text",
		text: state
	}];
	if (!isDecisionStateParts(state)) return [{
		type: "json",
		value: state
	}];
	if (state.every((part) => part.type !== "file")) return state;
	const message = (await convertToLanguageModelPrompt({
		prompt: {
			instructions: void 0,
			messages: [{
				role: "user",
				content: state.filter((part) => part.type === "file")
			}]
		},
		supportedUrls: {},
		download: void 0,
		abortSignal
	}))[0];
	if (message.role !== "user") throw new Error("Expected user message.");
	let fileIndex = 0;
	return state.map((part) => part.type === "file" ? message.content[fileIndex++] : part);
}
function createRestrictedTelemetryDispatcher$1({ telemetry }) {
	const dispatcher = createTelemetryDispatcher({ telemetry });
	return {
		...dispatcher,
		onStart: (event) => dispatcher.experimental_onDecideStart?.({
			...event,
			runtimeContext: filterIncludedContext({
				context: event.runtimeContext,
				includeContext: telemetry?.includeRuntimeContext
			})
		}),
		onEnd: (event) => dispatcher.experimental_onDecideEnd?.({
			...event,
			runtimeContext: filterIncludedContext({
				context: event.runtimeContext,
				includeContext: telemetry?.includeRuntimeContext
			})
		})
	};
}
const tolerance = 1e-6;
function isRecord$1(value) {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function isJSON(value, ancestors = /* @__PURE__ */ new Set()) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || !Array.isArray(value) && !isRecord$1(value)) return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	const valid = Object.getOwnPropertySymbols(value).length === 0 && (Array.isArray(value) ? Array.from(value).every((item) => isJSON(item, ancestors)) : Object.values(value).every((item) => isJSON(item, ancestors)));
	ancestors.delete(value);
	return valid;
}
function isInput(value) {
	return (typeof value === "string" || Array.isArray(value) || isRecord$1(value)) && isJSON(value);
}
function invalidInput(parameter, value, message) {
	throw new InvalidArgumentError({
		parameter,
		value,
		message
	});
}
function validateDecisionInput({ state, questions }) {
	if (!(Array.isArray(state) ? Array.from(state).every((part) => {
		if (!isRecord$1(part)) return false;
		switch (part.type) {
			case "text": return textPartSchema.safeParse(part).success;
			case "file": return filePartSchema.safeParse(part).success;
			case "json": return isJSON(part.value);
			default: return false;
		}
	}) : (typeof state === "string" || isRecord$1(state)) && isJSON(state))) invalidInput("state", state, "must be a string, JSON object, or array of text, file, or json parts");
	if (!isRecord$1(questions) || Object.keys(questions).length === 0) invalidInput("questions", questions, "must be a nonempty question map");
	for (const [id, question] of Object.entries(questions)) {
		const parameter = `questions.${id}`;
		if (!isRecord$1(question) || !isInput(question.instructions)) invalidInput(parameter, question, "instructions must be a JSON-compatible string, object, or array");
		const criteria = question.criteria;
		switch (question.type) {
			case "choice":
				if (!isRecord$1(criteria) || Object.keys(criteria).length === 0) invalidInput(parameter, question, "choice criteria must be a nonempty option map");
				break;
			case "score":
				if (!Array.isArray(criteria) || criteria.length < 2) invalidInput(parameter, question, "score criteria must contain at least two ordered levels");
				break;
			case "boolean":
				if (criteria === void 0) continue;
				if (!isRecord$1(criteria) || Object.keys(criteria).some((key) => key !== "true" && key !== "false")) invalidInput(parameter, question, "boolean criteria may only describe true and false");
				break;
			default: invalidInput(parameter, question, "question type must be choice, score, or boolean");
		}
		if (!isJSON(criteria) || Object.values(criteria).some((value) => value !== null && !isInput(value))) invalidInput(parameter, question, "criteria descriptions must be JSON-compatible strings, objects, arrays, or null");
	}
}
function invalidAnswer(answers, message) {
	throw new InvalidResponseDataError({
		data: answers,
		message
	});
}
function isProbability(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function hasExactKeys(value, keys) {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function validateDistribution(value, keys, answers, id, roundingError) {
	if (!isRecord$1(value) || !hasExactKeys(value, keys) || !Object.values(value).every(isProbability)) invalidAnswer(answers, `Question "${id}" must have a complete distribution of finite probabilities in [0, 1].`);
	const sum = Object.values(value).reduce((total, probability) => total + probability, 0);
	if (Math.abs(sum - 1) > tolerance + keys.length * roundingError) invalidAnswer(answers, `Question "${id}" probabilities must sum to 1 within the declared rounding precision.`);
}
function validateDecisionAnswers({ questions, answers, rounding }) {
	function roundingError(decimals) {
		if (decimals === void 0) return 0;
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > 15) invalidAnswer(answers, "Decision rounding decimals must be integers between 0 and 15.");
		return .5 * 10 ** -decimals;
	}
	const probabilityError = roundingError(rounding?.probabilityDecimals);
	const scoreError = roundingError(rounding?.scoreDecimals);
	if (!isRecord$1(answers) || !hasExactKeys(answers, Object.keys(questions))) invalidAnswer(answers, "Decision must return exactly one answer for every question.");
	for (const [id, question] of Object.entries(questions)) {
		const answer = answers[id];
		if (isRecord$1(answer) && answer.type === "refusal") continue;
		if (!isRecord$1(answer) || answer.type !== question.type) invalidAnswer(answers, `Question "${id}" returned an answer with the wrong type.`);
		switch (question.type) {
			case "choice":
				if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) invalidAnswer(answers, `Question "${id}" selected an unknown option.`);
				if (answer.probabilities !== void 0) {
					validateDistribution(answer.probabilities, Object.keys(question.criteria), answers, id, probabilityError);
					const selected = answer.probabilities[answer.choice];
					if (Object.values(answer.probabilities).some((probability) => probability > selected + tolerance + 2 * probabilityError)) invalidAnswer(answers, `Question "${id}" did not select a highest-probability option.`);
				}
				break;
			case "score":
				if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1) invalidAnswer(answers, `Question "${id}" score must be in [0, ${question.criteria.length - 1}].`);
				if (answer.probabilities !== void 0) {
					const keys = question.criteria.map((_, index) => String(index));
					validateDistribution(answer.probabilities, keys, answers, id, probabilityError);
					const mean = Object.entries(answer.probabilities).reduce((total, [index, probability]) => total + Number(index) * probability, 0);
					const meanRoundingError = keys.reduce((total, index) => total + Number(index) * probabilityError, 0);
					if (Math.abs(mean - answer.score) > tolerance + meanRoundingError + scoreError) invalidAnswer(answers, `Question "${id}" score must equal the probability-weighted mean within the declared rounding precision.`);
				}
				break;
			case "boolean": if (!isProbability(answer.probability)) invalidAnswer(answers, `Question "${id}" must return P(true) as a finite probability in [0, 1].`);
		}
	}
}
const originalGenerateCallId$4 = createIdGenerator({
	prefix: "call",
	size: 24
});
/** Decide answers to typed questions against one shared state. Experimental. */
async function decide({ model: modelArg, state, questions, maxRetries, abortSignal, headers, providerOptions = {}, telemetry, runtimeContext = {}, onStart, onEnd, _internal: { generateCallId = originalGenerateCallId$4 } = {} }) {
	const model = resolveDecisionModel(modelArg);
	validateDecisionInput({
		state,
		questions
	});
	for (const [questionId, question] of Object.entries(questions)) if (!model.supportedQuestionTypes.includes(question.type)) throw new DecisionUnsupportedQuestionTypeError({
		questionId,
		questionType: question.type,
		provider: model.provider,
		modelId: model.modelId
	});
	const callId = generateCallId();
	const { maxRetries: resolvedMaxRetries, retry } = prepareRetries({
		maxRetries,
		abortSignal
	});
	const telemetryDispatcher = createRestrictedTelemetryDispatcher$1({ telemetry });
	const runInTracingChannelSpan = telemetryDispatcher.runInTracingChannelSpan ?? (async ({ execute }) => await execute());
	const startEvent = {
		callId,
		operationId: "ai.decide",
		runtimeContext,
		provider: model.provider,
		modelId: model.modelId,
		state,
		questions,
		maxRetries: resolvedMaxRetries,
		headers,
		providerOptions
	};
	return await runInTracingChannelSpan({
		type: "experimental_decide",
		event: startEvent,
		execute: async () => {
			await notify({
				event: startEvent,
				callbacks: [onStart, telemetryDispatcher.onStart]
			});
			try {
				const preparedState = await prepareDecisionState(state, abortSignal);
				const modelCallEvent = {
					callId,
					operationId: "ai.decide.doDecide",
					provider: model.provider,
					modelId: model.modelId,
					state: preparedState,
					questions
				};
				await notify({
					event: modelCallEvent,
					callbacks: [telemetryDispatcher.experimental_onDecisionModelCallStart]
				});
				const result = await retry(async () => {
					abortSignal?.throwIfAborted();
					return await model.doDecide({
						state: preparedState,
						questions,
						abortSignal,
						headers: withUserAgentSuffix(headers ?? {}, `ai/${VERSION}`),
						providerOptions
					});
				});
				abortSignal?.throwIfAborted();
				validateDecisionAnswers({
					questions,
					answers: result.answers,
					rounding: result.rounding
				});
				const refusedQuestionIds = Object.keys(questions).filter((id) => result.answers[id]?.type === "refusal");
				if (refusedQuestionIds.length > 0) throw new DecisionRefusalError({
					questionIds: refusedQuestionIds,
					provider: model.provider,
					modelId: model.modelId
				});
				await notify({
					event: {
						...modelCallEvent,
						...result
					},
					callbacks: [telemetryDispatcher.experimental_onDecisionModelCallEnd]
				});
				logWarnings({
					warnings: result.warnings,
					provider: model.provider,
					model: model.modelId
				});
				const inputTokens = result.usage?.inputTokens;
				const outputTokens = result.usage?.outputTokens;
				const decisionResult = {
					answers: result.answers,
					usage: {
						inputTokens,
						outputTokens,
						totalTokens: inputTokens != null && outputTokens != null ? inputTokens + outputTokens : void 0
					},
					warnings: result.warnings,
					rounding: result.rounding,
					providerMetadata: result.providerMetadata,
					response: {
						...result.response,
						timestamp: result.response?.timestamp ?? /* @__PURE__ */ new Date(),
						modelId: result.response?.modelId ?? model.modelId
					}
				};
				await notify({
					event: {
						...startEvent,
						...decisionResult
					},
					callbacks: [onEnd, telemetryDispatcher.onEnd]
				});
				return decisionResult;
			} catch (error) {
				await telemetryDispatcher.onError?.({
					callId,
					error
				});
				throw error;
			}
		}
	});
}
createIdGenerator({
	prefix: "aiobj",
	size: 24
});
/**
* Creates a download function with configurable options.
*
* @param options - Configuration options for the download function.
* @param options.maxBytes - Maximum allowed download size in bytes. Default: 2 GiB.
* @returns A download function that can be passed to `transcribe()` or `experimental_generateVideo()`.
*/
function createDownload(options) {
	return ({ url, abortSignal }) => download({
		url,
		maxBytes: options?.maxBytes,
		abortSignal
	});
}
const { atob: atob$1 } = globalThis;
createIdGenerator({
	prefix: "aiobj",
	size: 24
});
createIdGenerator({
	prefix: "call",
	size: 24
});
/**
* Wraps a LanguageModelV4 instance with middleware functionality.
* This function allows you to apply middleware to transform parameters,
* wrap generate operations, and wrap stream operations of a language model.
*
* @param options - Configuration options for wrapping the language model.
* @param options.model - The original LanguageModelV4 instance to be wrapped.
* @param options.middleware - The middleware to be applied to the language model. When multiple middlewares are provided, the first middleware will transform the input first, and the last middleware will be wrapped directly around the model.
* @param options.modelId - Optional custom model ID to override the original model's ID.
* @param options.providerId - Optional custom provider ID to override the original model's provider ID.
* @returns A new LanguageModelV4 instance with middleware applied.
*/
const wrapLanguageModel = ({ model: inputModel, middleware: middlewareArg, modelId, providerId }) => {
	const model = asLanguageModelV4(inputModel);
	return [...asArray(middlewareArg)].reverse().reduce((wrappedModel, middleware) => {
		return doWrap$2({
			model: wrappedModel,
			middleware,
			modelId,
			providerId
		});
	}, model);
};
const doWrap$2 = ({ model, middleware: { transformParams, wrapGenerate, wrapStream, overrideProvider, overrideModelId, overrideSupportedUrls }, modelId, providerId }) => {
	async function doTransform({ params, type }) {
		return transformParams ? await transformParams({
			params,
			type,
			model
		}) : params;
	}
	return {
		specificationVersion: "v4",
		provider: providerId ?? overrideProvider?.({ model }) ?? model.provider,
		modelId: modelId ?? overrideModelId?.({ model }) ?? model.modelId,
		supportedUrls: overrideSupportedUrls?.({ model }) ?? model.supportedUrls,
		async doGenerate(params) {
			const transformedParams = await doTransform({
				params,
				type: "generate"
			});
			const doGenerate = async () => await model.doGenerate(transformedParams);
			const doStream = async () => await model.doStream(transformedParams);
			return wrapGenerate ? await wrapGenerate({
				doGenerate,
				doStream,
				params: transformedParams,
				model
			}) : await doGenerate();
		},
		async doStream(params) {
			const transformedParams = await doTransform({
				params,
				type: "stream"
			});
			const doGenerate = async () => await model.doGenerate(transformedParams);
			const doStream = async () => await model.doStream(transformedParams);
			return wrapStream ? await wrapStream({
				doGenerate,
				doStream,
				params: transformedParams,
				model
			}) : await doStream();
		}
	};
};
z.object({
	token: z.string().refine((value) => value.trim().length > 0),
	url: z.string().refine((value) => {
		try {
			const url = new URL(value);
			return (url.protocol === "ws:" || url.protocol === "wss:") && url.hostname !== "";
		} catch {
			return false;
		}
	}),
	expiresAt: z.number().positive().max(Number.MAX_SAFE_INTEGER).optional(),
	tools: z.array(z.object({
		type: z.literal("function"),
		name: z.string().min(1),
		description: z.string().optional(),
		parameters: z.record(z.string(), z.unknown())
	})).optional()
});
createIdGenerator({
	prefix: "call",
	size: 24
});
createIdGenerator({
	prefix: "call",
	size: 24
});
createIdGenerator({
	prefix: "call",
	size: 24
});
//#endregion
//#region node_modules/ai/dist/test/index.js
function notImplemented() {
	throw new Error("Not implemented");
}
var MockLanguageModelV3 = class {
	constructor({ provider = "mock-provider", modelId = "mock-model-id", supportedUrls = {}, doGenerate = notImplemented, doStream = notImplemented } = {}) {
		this.specificationVersion = "v3";
		this.doGenerateCalls = [];
		this.doStreamCalls = [];
		this.provider = provider;
		this.modelId = modelId;
		this.doGenerate = async (options) => {
			this.doGenerateCalls.push(options);
			if (typeof doGenerate === "function") return await doGenerate(options);
			else if (Array.isArray(doGenerate)) return doGenerate[this.doGenerateCalls.length - 1];
			else return doGenerate;
		};
		this.doStream = async (options) => {
			this.doStreamCalls.push(options);
			if (typeof doStream === "function") return await doStream(options);
			else if (Array.isArray(doStream)) return doStream[this.doStreamCalls.length - 1];
			else return doStream;
		};
		this._supportedUrls = typeof supportedUrls === "function" ? supportedUrls : async () => await supportedUrls;
	}
	get supportedUrls() {
		return this._supportedUrls();
	}
};
//#endregion
export { DefaultGeneratedFile, InvalidArgumentError, InvalidDataContentError, InvalidMessageRoleError, InvalidToolApprovalError, InvalidToolApprovalSignatureError, InvalidToolInputError, JsonToSseTransformStream, MissingToolResultsError, MockLanguageModelV3, NoOutputGeneratedError, NoSuchToolError, RetryError, StreamProviderError, ToolCallNotFoundForApprovalError, ToolCallRepairError, ToolChoiceViolationError, ToolLoopAgent, UIMessageStreamError, UI_MESSAGE_STREAM_HEADERS, UnsupportedModelVersionError, assistantModelMessageSchema, consumeStream, convertDataContentToBase64String, createDownload, createTextStreamResponse, createUIMessageStreamResponse, decide, filterActiveTools, generateText, getChunkTimeoutMs, getFirstChunkTimeoutMs, getStaticToolName, getStepTimeoutMs, getToolTimeoutMs, getTotalTimeoutMs, isDeepEqualData, isDynamicToolUIPart, isStaticToolUIPart, isStepCount, isToolUIPart, modelMessageSchema, parsePartialJson, pipeTextStreamToResponse, pipeUIMessageStreamToResponse, registerTelemetry, streamLanguageModelCall, streamText, systemModelMessageSchema, toTextStream, toUIMessageChunk, toUIMessageStream, toolModelMessageSchema, userModelMessageSchema, wrapLanguageModel };
