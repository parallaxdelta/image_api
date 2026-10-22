/**
 * Every error the API returns has the same shape:
 *   { "error": { "code": "...", "message": "...", "details"?: ... }, "requestId": "..." }
 * `code` is stable and machine-readable; `message` tells the caller what to fix.
 */
export const ERROR_STATUS = {
  INVALID_PARAMS: 400,
  URL_NOT_ALLOWED: 400,
  NOT_FOUND: 404,
  UNSUPPORTED_MEDIA_TYPE: 415,
  SOURCE_TOO_LARGE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  SOURCE_ERROR: 502,
  SOURCE_UNREACHABLE: 502,
  SOURCE_TIMEOUT: 504,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class ApiError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = ERROR_STATUS[code];
  }

  toBody(requestId: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
      requestId,
    };
  }
}
