import crypto from 'node:crypto';
import type { Request, RequestHandler, Response, NextFunction } from 'express';

export const API_V1_VERSION = '1.0.0';

export type ApiErrorCode = 'validation' | 'not_found' | 'unsupported' | 'conflict' | 'provider' | 'internal' | 'disabled' | 'unknown' | 'confirmation_required' | 'storage';

export class ApiError extends Error {
    readonly status: number;
    readonly code: ApiErrorCode;
    readonly retryable: boolean;
    readonly details: unknown;

    constructor(status: number, code: ApiErrorCode, message: string, options: { retryable?: boolean; details?: unknown } = {}) {
        const { retryable = false, details } = options;
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
export function errorBody(requestId: string, error: ApiError | Error) {
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
export function sendApiError(response: Response, requestId: string, error: unknown): Response {
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
export function asyncHandler(handler: (request: Request, response: Response) => Promise<unknown>): RequestHandler {
    return (request: Request, response: Response, next: NextFunction) => {
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
export function ensureRequestId(request: Request & { apiV1RequestId?: string }): string {
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
export function mergePatch(target: any, patch: any): any {
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
function isPlainObject(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates that a value is a plain object.
 * @param {unknown} value Value
 * @param {string} name Field name
 * @returns {Record<string, unknown>} Plain object
 */
export function requireObject(value: unknown, name: string): Record<string, unknown> {
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
export function requireSafeId(value: unknown, name: string): string {
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
export function getUserKey(handle: string): string {
    return crypto.createHash('sha256').update(String(handle)).digest('hex').slice(0, 16);
}
