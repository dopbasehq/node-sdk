import { MAX_TIMER_MS } from './duration';
import {
  DopbaseAuthError,
  DopbaseError,
  DopbaseNetworkError,
  DopbaseScopeError,
  DopbaseServerError,
  DopbaseUnsupportedServerError,
  DopbaseValidationError,
  isAvailabilityError,
} from './errors';
import { type RuntimeSnapshot, validateSnapshot } from './validate';

export type FetchResult =
  | { status: 'fetched'; etag: string | null; snapshot: RuntimeSnapshot; requestId?: string }
  | { status: 'unchanged'; etag: string | null; requestId?: string };

export interface RuntimeApiOptions {
  endpoint: string;
  /** Shown in error messages instead of the endpoint. */
  baseUrl: string;
  token: string;
  timeoutMs: number;
  retries: number;
  userAgent: string;
  fetch?: typeof globalThis.fetch;
}

// The CLI caps runtime responses at the same size.
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_MS = 5_000;

/** One endpoint: `GET /api/v1/runtime/secrets`, conditional on the last ETag. */
export class RuntimeApi {
  readonly #options: RuntimeApiOptions;

  constructor(options: RuntimeApiOptions) {
    this.#options = options;
  }

  async fetch(etag: string | null, signal?: AbortSignal): Promise<FetchResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#attempt(etag, signal);
      } catch (error) {
        if (attempt >= this.#options.retries || !isAvailabilityError(error) || signal?.aborted) {
          throw error;
        }
        const retryAfter = (error as { retryAfterMs?: number }).retryAfterMs;
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS) throw error;
        await sleep(retryAfter ?? backoff(attempt), signal);
      }
    }
  }

  async #attempt(etag: string | null, signal?: AbortSignal): Promise<FetchResult> {
    const { endpoint, baseUrl, token, timeoutMs, userAgent } = this.#options;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': userAgent,
    };
    if (etag) headers['If-None-Match'] = etag;
    const timeout = timeoutSignal(timeoutMs);
    const fetchImpl = this.#options.fetch ?? globalThis.fetch;

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'GET',
        headers,
        // Workers don't support 'error'; any 3xx is refused below instead.
        redirect: 'manual',
        signal: signal ? anySignal(signal, timeout) : timeout,
      });
    } catch (error) {
      if (timeout.aborted) {
        throw new DopbaseNetworkError(
          `Dopbase at ${baseUrl} didn't answer within ${timeoutMs} ms.`,
          {
            code: 'TIMEOUT',
            cause: error,
          },
        );
      }
      throw new DopbaseNetworkError(`Couldn't reach Dopbase at ${baseUrl}.`, {
        code: signal?.aborted ? 'ABORTED' : 'NETWORK_ERROR',
        cause: error,
      });
    }

    const requestId = response.headers.get('x-request-id') ?? undefined;
    const responseEtag = response.headers.get('etag');
    if (response.status === 304) {
      await response.body?.cancel();
      return { status: 'unchanged', etag: responseEtag ?? etag, ...withId(requestId) };
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new DopbaseError(
        `Dopbase at ${baseUrl} answered with a redirect, which the SDK refuses. Check DOPBASE_HOST.`,
        { code: 'REDIRECT_REFUSED', status: response.status, ...withId(requestId) },
      );
    }
    if (!response.ok) throw await errorFor(response, baseUrl, requestId);

    const body = await readLimited(response, MAX_BODY_BYTES, requestId);
    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder().decode(body));
    } catch {
      // Usually a web page: a base path in DOPBASE_HOST that the server's console answers.
      throw invalid(
        `the body is not JSON. Check that DOPBASE_HOST (${baseUrl}) points at the Dopbase server.`,
        requestId,
      );
    }
    const { success, data } = (envelope ?? {}) as { success?: unknown; data?: unknown };
    if (success !== true) throw invalid('success is not true.', requestId);
    return {
      status: 'fetched',
      etag: responseEtag,
      snapshot: validateSnapshot(data, requestId),
      ...withId(requestId),
    };
  }
}

async function errorFor(response: Response, baseUrl: string, requestId?: string): Promise<Error> {
  const status = response.status;
  let codes: [string, string][] = [];
  try {
    const body = await readLimited(response, MAX_ERROR_BODY_BYTES, requestId);
    const error = (JSON.parse(new TextDecoder().decode(body)) as { error?: unknown }).error;
    if (typeof error === 'object' && error !== null) {
      codes = Object.entries(error).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string',
      );
    }
  } catch {
    // Not a Dopbase error body; the status alone decides.
  }
  const code = codes[0]?.[0] ?? `HTTP_${status}`;
  const serverMessage = codes.map(([key, message]) => `${key}: ${message}`).join('; ');
  const details = { code, status, ...withId(requestId) };
  const said = serverMessage ? ` (${serverMessage})` : '';

  if (status === 401) {
    return new DopbaseAuthError(
      `Dopbase refused the runner token: it's missing, revoked or expired${said}.`,
      details,
    );
  }
  if (status === 403 && code === 'TOKEN_SCOPE_INVALID') {
    return new DopbaseScopeError(
      `The runner token doesn't belong to the environment in DOPBASE_ENV${said}.`,
      details,
    );
  }
  if (status === 403 && code === 'RUNNER_TOKEN_REQUIRED') {
    return new DopbaseAuthError(
      `Dopbase refused the token: it needs a runner token${said}.`,
      details,
    );
  }
  if (status === 403) {
    return new DopbaseAuthError(
      `Dopbase refused the runner token access to its environment${said}.`,
      details,
    );
  }
  if (status === 404) {
    return new DopbaseUnsupportedServerError(
      `Dopbase at ${baseUrl} has no /api/v1/runtime/secrets. Upgrade the server to a release with the runtime gate, or check DOPBASE_HOST.`,
      details,
    );
  }
  if (status === 408 || status === 429 || status >= 500) {
    const error = new DopbaseServerError(
      `Dopbase at ${baseUrl} returned ${status}${said}.`,
      details,
    );
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    if (retryAfter !== undefined) Object.assign(error, { retryAfterMs: retryAfter });
    return error;
  }
  return new DopbaseError(`Dopbase at ${baseUrl} returned ${status}${said}.`, details);
}

async function readLimited(
  response: Response,
  limit: number,
  requestId?: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) {
    await response.body?.cancel();
    throw tooLarge(limit, requestId);
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge(limit, requestId);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function tooLarge(limit: number, requestId?: string): DopbaseValidationError {
  return invalid(`the body is larger than ${limit / 1024 / 1024} MiB.`, requestId);
}

function invalid(message: string, requestId?: string): DopbaseValidationError {
  return new DopbaseValidationError(`The runtime response was invalid: ${message}`, [{ message }], {
    code: 'RESPONSE_INVALID',
    ...withId(requestId),
  });
}

function withId(requestId: string | undefined): { requestId?: string } {
  return requestId ? { requestId } : {};
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Full jitter on 250 ms, 500 ms, 1 s, … capped at 2 s. */
function backoff(attempt: number): number {
  return Math.random() * Math.min(2_000, 250 * 2 ** attempt);
}

// AbortSignal.timeout and AbortSignal.any are missing on some edge runtimes.
function timeoutSignal(requested: number): AbortSignal {
  const ms = Math.min(requested, MAX_TIMER_MS);
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
  return controller.signal;
}

function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const controller = new AbortController();
  const listeners = [a, b].map((signal) => {
    const listener = () => {
      controller.abort(signal.reason);
      // The timeout always fires, so this also unhooks the SDK's long-lived signal.
      for (const [source, added] of listeners) source.removeEventListener('abort', added);
    };
    return [signal, listener] as const;
  });
  for (const [signal, listener] of listeners) {
    if (signal.aborted) {
      listener();
      break;
    }
    signal.addEventListener('abort', listener, { once: true });
  }
  return controller.signal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
