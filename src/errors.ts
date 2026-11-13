export interface DopbaseErrorDetails {
  /** A stable code: the server's error code, or one of the SDK's own. */
  code: string;
  /** The HTTP status, when the error came from a response. */
  status?: number;
  /** The server's `x-request-id`, to quote when reporting a problem. */
  requestId?: string;
  cause?: unknown;
}

/** Base class for every error the SDK throws. Messages never contain secret values or the token. */
export class DopbaseError extends Error {
  override name = 'DopbaseError';
  readonly code: string;
  readonly status: number | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, details: DopbaseErrorDetails) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.code = details.code;
    this.status = details.status;
    this.requestId = details.requestId;
  }
}

/** Missing or invalid host, token or options. */
export class DopbaseConfigError extends DopbaseError {
  override name = 'DopbaseConfigError';
  constructor(message: string, code = 'CONFIG_INVALID') {
    super(message, { code });
  }
}

/** The token is missing, revoked, expired, or isn't a runner token. Never falls back to a stored copy. */
export class DopbaseAuthError extends DopbaseError {
  override name = 'DopbaseAuthError';
}

/** The token belongs to a different environment than `env` names. */
export class DopbaseScopeError extends DopbaseError {
  override name = 'DopbaseScopeError';
}

/** The server couldn't be reached, or didn't answer in time. */
export class DopbaseNetworkError extends DopbaseError {
  override name = 'DopbaseNetworkError';
}

/** The server answered with a 5xx, 408 or 429. */
export class DopbaseServerError extends DopbaseError {
  override name = 'DopbaseServerError';
}

export interface DopbaseIssue {
  /** The secret's key, when the issue is about one key. */
  key?: string;
  message: string;
}

/** The response, or the values checked against `schema`, didn't pass validation. */
export class DopbaseValidationError extends DopbaseError {
  override name = 'DopbaseValidationError';
  readonly issues: readonly DopbaseIssue[];

  constructor(message: string, issues: DopbaseIssue[], details: Partial<DopbaseErrorDetails> = {}) {
    super(message, { code: 'VALIDATION_FAILED', ...details });
    this.issues = issues;
  }
}

/** The server has no `/api/v1/runtime/secrets` route, so it's older than this SDK supports. */
export class DopbaseUnsupportedServerError extends DopbaseError {
  override name = 'DopbaseUnsupportedServerError';
}

/** Errors worth retrying, and worth falling back to a stored copy for. */
export function isAvailabilityError(error: unknown): boolean {
  return error instanceof DopbaseNetworkError || error instanceof DopbaseServerError;
}

/** Errors that mean the token must stop pulling secrets. */
export function isAccessError(error: unknown): boolean {
  return error instanceof DopbaseAuthError || error instanceof DopbaseScopeError;
}
