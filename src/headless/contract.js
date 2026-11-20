import crypto from 'node:crypto';

export const API_V1_VERSION = '1.0.0';

/**
 * @typedef {'validation'|'not_found'|'unsupported'|'conflict'|'provider'|'internal'|'disabled'|'unknown'|'confirmation_required'|'storage'} ApiErrorCode
 */

export class ApiError extends Error {
    /**
     * @param {number} status HTTP status code
     * @param {ApiErrorCode} code Stable machine-readable error code
     * @param {string} message Human-readable error message
     * @param {object} [options] Additional options
     * @param {boolean} [options.retryable] Whether the client may retry
     * @param {unknown} [options.details] Additional error details
     */
    constructor(status, code, message, { retryable = false, details } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.retryable = retryable;
        this.details = details;
    }
}

/**
 * Creates a request identifier.
 * @returns {string} Request identifier
 */
export function createRequestId() {
    return crypto.randomUUID();
}

/**
 * Creates the stable error body.
 * @param {string} requestId Request identifier
 * @param {ApiError|Error} error Error
 * @returns {{error: {code: string, message: string, retryable: boolean, requestId: string, details?: unknown}}} Error body
 */
export function errorBody(requestId, error) {
    const apiError = error instanceof ApiError
        ? error
        : new ApiError(500, 'internal', 'An internal error occurred.');

    return {
        error: {
            code: apiError.code,
            message: apiError.message,
            retryable: apiError.retryable,
            requestId,
            ...(apiError.details === undefined ? {} : { details: apiError.details }),
        },
    };
}

/**
 * Sends an error using the stable API v1 body.
 * @param {import('express').Response} response Express response
 * @param {string} requestId Request identifier
 * @param {unknown} error Error
 * @returns {import('express').Response} Express response
 */
export function sendApiError(response, requestId, error) {
    const apiError = error instanceof ApiError
        ? error
        : new ApiError(500, 'internal', 'An internal error occurred.');
    if (!(error instanceof ApiError)) {
        console.error('[api-v1]', requestId, error);
    }
    return response.status(apiError.status).json(errorBody(requestId, apiError));
}

/**
 * Wraps an async Express handler with stable error handling.
 * @param {(request: import('express').Request, response: import('express').Response) => Promise<unknown>} handler Route handler
 * @returns {import('express').RequestHandler} Express handler
 */
export function asyncHandler(handler) {
    return (request, response, next) => {
        const requestId = ensureRequestId(request);
        Promise.resolve(handler(request, response)).catch(error => {
            if (response.headersSent || response.writableEnded) {
                next(error);
                return;
            }
            sendApiError(response, requestId, error);
        });
    };
}

/**
 * Gets or creates the request identifier for an Express request.
 * @param {import('express').Request} request Express request
 * @returns {string} Request identifier
 */
export function ensureRequestId(request) {
    if (!request.apiV1RequestId) {
        request.apiV1RequestId = createRequestId();
    }
    return request.apiV1RequestId;
}

/**
 * Applies RFC 7386 JSON Merge Patch semantics, preserving unknown target fields.
 * @param {any} target Target value
 * @param {any} patch Patch value
 * @returns {any} Patched value
 */
export function mergePatch(target, patch) {
    if (!isPlainObject(patch)) {
        return patch;
    }
    const output = isPlainObject(target) ? { ...target } : {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete output[key];
        } else {
            output[key] = mergePatch(output[key], value);
        }
    }
    return output;
}

/**
 * Checks whether a value is a plain object.
 * @param {unknown} value Value
 * @returns {value is Record<string, unknown>} Whether the value is a plain object
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates that a value is a plain object.
 * @param {unknown} value Value
 * @param {string} name Field name
 * @returns {Record<string, unknown>} Plain object
 */
export function requireObject(value, name) {
    if (!isPlainObject(value)) {
        throw new ApiError(400, 'validation', `${name} must be a JSON object.`);
    }
    return value;
}

/**
 * Validates that an identifier only contains safe path characters.
 * @param {unknown} value Identifier
 * @param {string} name Field name
 * @returns {string} Identifier
 */
export function requireSafeId(value, name) {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 240 || !/^[\p{L}\p{N}\p{M}_\- .()]+$/u.test(value) || value.includes('..') || value.startsWith('/') || value.startsWith('\\')) {
        throw new ApiError(400, 'validation', `${name} is not a valid identifier.`);
    }
    return value;
}

/**
 * Gets a stable, non-reversible user key for logs.
 * @param {string} handle User handle
 * @returns {string} Hashed user key
 */
export function getUserKey(handle) {
    return crypto.createHash('sha256').update(String(handle)).digest('hex').slice(0, 16);
}
