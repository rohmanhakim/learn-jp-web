// P1.12 — the app's ONLY API touchpoint (Phase-001.md Milestone D): one
// hono/client instance typed with the worker's exported `AppType`, so every
// request and response below is compile-time checked on the client end too
// (DECISIONS D11). No other file in src/client may call fetch("/api/…").
//
// The API.md error envelope ({ error: { code, message } }, line 5) is
// unwrapped here into a thrown ApiError, so UI code handles every failure
// with one try/catch. Each client view below (200 body OR envelope) is
// pinned against the contract by Equal assertions in tests/*.test.ts, so
// the casts to `Contract | { error: ApiErrorBody }` cannot drift silently.
//
// `AppType` and the contract types are imported TYPE-ONLY
// (verbatimModuleSyntax erases them), so no worker runtime code — the Hono
// app, D1 helpers — enters the client bundle; only hono/client ships.
import { hc } from "hono/client";
import type {
  ApiError as ApiErrorBody,
  ResponsesRequest,
  ResponsesResponse,
  SessionCompleteRequest,
  SessionCompleteResponse,
  SessionStartRequest,
  SessionStartResponse,
  StatusResponse,
} from "../worker/api-types";
import type { AppType } from "../worker/index";

/** Same-origin base: route paths are `/api/…`, resolved against the page. */
const client = hc<AppType>("");

/** API.md's error envelope, as a throwable with the contract's `code`. */
export class ApiError extends Error {
  readonly code: string;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
  }
}

/** Decode one client call: the 200 body, or throw the error envelope. */
function unwrap<T extends object>(body: T | { error: ApiErrorBody }): T {
  // `in` narrows the false branch to T; the true branch keeps a generic
  // intersection too, so the envelope is cast (it is the only member
  // with a required `error` — contract shapes never carry one).
  if ("error" in body) throw new ApiError((body as { error: ApiErrorBody }).error);
  return body;
}

/** GET /api/status — Home's data (streak, last_session, due_count, …). */
export async function fetchStatus(): Promise<StatusResponse> {
  const res = await client.api.status.$get();
  return unwrap<StatusResponse>((await res.json()) as StatusResponse | { error: ApiErrorBody });
}

/**
 * POST /api/session/start — compose the session snapshot. `session_uuid`
 * is the client-generated idempotency key (API.md): the caller generates
 * it once per attempt, so a retried request replays the stored snapshot
 * instead of forking a second session.
 */
export async function startSession(request: SessionStartRequest): Promise<SessionStartResponse> {
  const res = await client.api.session.start.$post({ json: request });
  return unwrap<SessionStartResponse>(
    (await res.json()) as SessionStartResponse | { error: ApiErrorBody },
  );
}

/**
 * POST /api/responses — one graded answer per call from the session
 * screen (P1.13); the endpoint accepts a batch, Phase 2's offline queue
 * flushes several at once. Grading is server-side (LEARNING-DESIGN §2),
 * so the returned `results[0]` carries the inline verdict: `grade`,
 * `correct_answer` and the production `checks`.
 */
export async function sendResponses(request: ResponsesRequest): Promise<ResponsesResponse> {
  const res = await client.api.responses.$post({ json: request });
  return unwrap<ResponsesResponse>(
    (await res.json()) as ResponsesResponse | { error: ApiErrorBody },
  );
}

/**
 * POST /api/session/complete — finalize (idempotent server-side: the
 * write happens once, the body is recomputed per call). The session
 * screen calls this both after the last prompt and on confirmed exit,
 * with `duration_sec` counted from screen entry; answers that landed
 * already are what the summary counts.
 */
export async function completeSession(
  request: SessionCompleteRequest,
): Promise<SessionCompleteResponse> {
  const res = await client.api.session.complete.$post({ json: request });
  return unwrap<SessionCompleteResponse>(
    (await res.json()) as SessionCompleteResponse | { error: ApiErrorBody },
  );
}