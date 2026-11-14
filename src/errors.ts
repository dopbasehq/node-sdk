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
  // Declared, not initialized: set only when there's a value, so a printed
  // error doesn't show `status: undefined`.
  declare readonly status?: number;
  declare readonly requestId?: string;

  constructor(message: string, details: DopbaseErrorDetails) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.code = details.code;
    if (details.status !== undefined) this.status = details.status;
    if (details.requestId !== undefined) this.requestId = details.requestId;
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
  declare readonly issues: readonly DopbaseIssue[];

  constructor(message: string, issues: DopbaseIssue[], details: Partial<DopbaseErrorDetails> = {}) {
    super(message, { code: 'VALIDATION_FAILED', ...details });
    // Not enumerable: the message already lists the issues, so a printed error shows them once.
    Object.defineProperty(this, 'issues', {
      value: Object.freeze([...issues]),
      enumerable: false,
    });
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

/** A function or class the app called; frames from it inward are dropped from the stack. */
export type Caller = ((...args: never[]) => unknown) | (abstract new (...args: never[]) => unknown);

// V8 (Node, Deno, Workers, Vercel Edge) and Bun have both. Elsewhere the helpers below do nothing.
const ErrorStatics = Error as unknown as {
  captureStackTrace?: (target: object, caller?: Caller) => void;
};

/**
 * Restarts the stack at the app's call into `caller`. Node and Bun print the
 * source line of the first frame above an uncaught error, so this makes them
 * show the app's own line instead of SDK internals.
 */
export function fromCaller<E>(error: E, caller: Caller): E {
  if (error instanceof DopbaseError) ErrorStatics.captureStackTrace?.(error, caller);
  return error;
}

// Never on the stack, so capturing "from" it leaves no frames. Bun ignores
// Error.stackTraceLimit inside captureStackTrace, so lowering that isn't enough.
function offStack(): void {}

/** Drops every stack frame. For errors with no app call to point at. */
export function withoutFrames<E extends Error>(error: E): E {
  ErrorStatics.captureStackTrace?.(error, offStack);
  return error;
}
