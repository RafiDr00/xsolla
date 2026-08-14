/**
 * The error taxonomy. Every non-2xx response in the service is produced here, so the
 * envelope shape and the code/status pairing exist in exactly one place.
 */

export type ErrorCode =
  | 'unauthorized'
  | 'payload_too_large'
  | 'invalid_json'
  | 'invalid_diff'
  | 'idempotency_conflict'
  | 'not_found'
  | 'rate_limited'
  | 'internal';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthorized: 401,
  payload_too_large: 413,
  invalid_json: 400,
  invalid_diff: 422,
  idempotency_conflict: 409,
  not_found: 404,
  rate_limited: 429,
  internal: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Extra response headers, e.g. Retry-After on a 429. */
  readonly headers: Record<string, string>;

  constructor(code: ErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.headers = headers;
  }
}

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string };
}

export function envelope(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message } };
}
