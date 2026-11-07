import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
//#region node_modules/ai/node_modules/@ai-sdk/provider/dist/index.js
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
const name$15 = "AI_DecisionUnsupportedQuestionTypeError";
const marker$15 = `vercel.ai.error.${name$15}`;
const symbol$15 = Symbol.for(marker$15);
/**
* A decision model does not support the type of a requested question.
*/
var DecisionUnsupportedQuestionTypeError = class extends AISDKError {
	constructor({ questionId, questionType, provider, modelId, message = `Question "${questionId}" has type "${questionType}", which is not supported by provider "${provider}" and model "${modelId}".` }) {
		super({
			name: name$15,
			message
		});
		this[symbol$15] = true;
		this.questionId = questionId;
		this.questionType = questionType;
		this.provider = provider;
		this.modelId = modelId;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$15);
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
const name$12 = "AI_DecisionRefusalError";
const marker$12 = `vercel.ai.error.${name$12}`;
const symbol$12 = Symbol.for(marker$12);
/**
* A decision model declined to answer one or more questions.
*/
var DecisionRefusalError = class extends AISDKError {
	constructor({ questionIds, provider, modelId, message = `Decision model "${modelId}" from provider "${provider}" refused ${questionIds.length === 1 ? "question" : "questions"} ${questionIds.map((id) => JSON.stringify(id)).join(", ")}.` }) {
		super({
			name: name$12,
			message
		});
		this[symbol$12] = true;
		this.questionIds = questionIds;
		this.provider = provider;
		this.modelId = modelId;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$12);
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
const symbol$11 = Symbol.for(marker$11);
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
		this[symbol$11] = true;
		this.argument = argument;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$11);
	}
};
const name$10 = "AI_InvalidPromptError";
const marker$10 = `vercel.ai.error.${name$10}`;
const symbol$10 = Symbol.for(marker$10);
/**
* A prompt is invalid. This error should be thrown by providers when they cannot
* process a prompt.
*/
var InvalidPromptError = class extends AISDKError {
	constructor({ prompt, message, cause }) {
		super({
			name: name$10,
			message: `Invalid prompt: ${message}`,
			cause
		});
		this[symbol$10] = true;
		this.prompt = prompt;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$10);
	}
};
const name$9 = "AI_InvalidResponseDataError";
const marker$9 = `vercel.ai.error.${name$9}`;
const symbol$9 = Symbol.for(marker$9);
/**
* Server returned a response with invalid data content.
* This should be thrown by providers when they cannot parse the response from the API.
*/
var InvalidResponseDataError = class extends AISDKError {
	constructor({ data, message = `Invalid response data: ${JSON.stringify(data)}.` }) {
		super({
			name: name$9,
			message
		});
		this[symbol$9] = true;
		this.data = data;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$9);
	}
};
const name$8 = "AI_JSONParseError";
const marker$8 = `vercel.ai.error.${name$8}`;
const symbol$8 = Symbol.for(marker$8);
var JSONParseError = class extends AISDKError {
	constructor({ text, cause }) {
		super({
			name: name$8,
			message: `JSON parsing failed: Text: ${text}.\nError message: ${getErrorMessage(cause)}`,
			cause
		});
		this[symbol$8] = true;
		this.text = text;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$8);
	}
};
const name$4 = "AI_NoSuchModelError";
const marker$4 = `vercel.ai.error.${name$4}`;
const symbol$4 = Symbol.for(marker$4);
var NoSuchModelError = class extends AISDKError {
	constructor({ errorName = name$4, modelId, modelType, message = `No such ${modelType}: ${modelId}` }) {
		super({
			name: errorName,
			message
		});
		this[symbol$4] = true;
		this.modelId = modelId;
		this.modelType = modelType;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$4);
	}
};
const name$1 = "AI_TypeValidationError";
const marker$1 = `vercel.ai.error.${name$1}`;
const symbol$1 = Symbol.for(marker$1);
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
			name: name$1,
			message: `${contextPrefix}: Value: ${JSON.stringify(value)}.\nError message: ${getErrorMessage(cause)}`,
			cause
		});
		this[symbol$1] = true;
		this.value = value;
		this.context = context;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker$1);
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
const name = "AI_UnsupportedFunctionalityError";
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);
var UnsupportedFunctionalityError = class extends AISDKError {
	constructor({ functionality, message = `'${functionality}' functionality not supported.` }) {
		super({
			name,
			message
		});
		this[symbol] = true;
		this.functionality = functionality;
	}
	static isInstance(error) {
		return AISDKError.hasMarker(error, marker);
	}
};
//#endregion
export { AISDKError, APICallError, DecisionRefusalError, DecisionUnsupportedQuestionTypeError, InvalidArgumentError, InvalidPromptError, InvalidResponseDataError, JSONParseError, NoSuchModelError, TypeValidationError, UnsupportedFunctionalityError, getErrorMessage };
