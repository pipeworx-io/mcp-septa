interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * SEPTA MCP — Philadelphia SEPTA real-time transit (www3.septa.org/api, keyless)
 *
 * Tools:
 * - septa_rail_arrivals: regional rail departures board at a station
 * - septa_next_to_arrive: next trains from origin to destination (with connections)
 * - septa_train_view: all live regional-rail trains with position + lateness
 * - septa_bus_positions: live bus/trolley vehicle positions for a route
 * - septa_alerts: system service alerts, advisories, and detours by route
 *
 * API quirks (probed live 2026-07-15):
 * - Arrivals responds with ONE dynamic top-level key like
 *   "Ardmore Departures: July 15, 2026, 6:54 pm" — parse via Object.entries.
 * - Station names are strict (case-sensitive, exact): "suburban station" and
 *   "Suburban" both error. We resolve user input against the embedded
 *   station list (exact → alias → substring → edit-distance) before calling.
 * - Alerts route ids: bus_route_<n>, trolley_route_<n> (LEGACY numbers),
 *   rr_route_<code> (pao, trent, wtren, warm, wilm, med, nor, landdoy, apt,
 *   che, chw, cyn, fxc, gc), rr_route_bsl / rr_route_mfl / rr_route_nhsl for
 *   the subways, plus "generic" for system-wide.
 * - TransitView requires SEPTA Metro trolley codes (T1..T5, G1, D1, D2);
 *   legacy trolley numbers return a bare []. Unknown routes also return [].
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'SEPTA');
}

const BASE_URL = 'https://www3.septa.org/api';

// ── Regional Rail station list ──────────────────────────────────────
// Every name below was verified against the live Arrivals API (2026-07-15).
// The API requires an exact match, so user input is fuzzy-resolved to one
// of these canonical names.
const STATIONS: string[] = [
  // Center City + trunk
  'Gray 30th Street', 'Suburban Station', 'Jefferson Station', 'Temple University',
  'Wayne Junction', 'Fern Rock TC', 'North Broad', 'North Philadelphia',
  // Airport Line
  'Airport Terminal E-F', 'Airport Terminal C-D', 'Airport Terminal B',
  'Airport Terminal A', 'Eastwick',
  // Manayunk/Norristown Line
  'Allegheny', 'East Falls', 'Wissahickon', 'Manayunk', 'Ivy Ridge', 'Miquon',
  'Spring Mill', 'Conshohocken', 'Norristown Elm Street', 'Main Street', 'Norristown TC',
  // Chestnut Hill East Line
  'Wister', 'Germantown', 'Washington Lane', 'Stenton', 'Sedgwick', 'Mount Airy',
  'Wyndmoor', 'Gravers', 'Chestnut Hill East',
  // Chestnut Hill West Line
  'Queen Lane', 'Chelten Avenue', 'Tulpehocken', 'Upsal', 'Carpenter', 'Allen Lane',
  'St. Martins', 'Highland', 'Chestnut Hill West',
  // Cynwyd Line
  'Wynnefield Avenue', 'Bala', 'Cynwyd',
  // Fox Chase Line
  'Olney', 'Lawndale', 'Cheltenham', 'Ryers', 'Fox Chase',
  // Lansdale/Doylestown + Warminster Lines
  'Melrose Park', 'Elkins Park', 'Jenkintown-Wyncote', 'Glenside', 'Ardsley',
  'Roslyn', 'Crestmont', 'Willow Grove', 'Hatboro', 'Warminster', 'North Hills',
  'Oreland', 'Fort Washington', 'Ambler', 'Penllyn', 'Gwynedd Valley', 'North Wales',
  'Pennbrook', 'Lansdale', 'Fortuna', 'Colmar', 'Link Belt', 'Chalfont',
  'New Britain', 'Delaware Valley College', 'Doylestown',
  // Media/Wawa Line
  'Penn Medicine Station', '49th Street', 'Angora', 'Fernwood-Yeadon', 'Lansdowne',
  'Gladstone', 'Clifton-Aldan', 'Primos', 'Secane', 'Morton', 'Swarthmore',
  'Wallingford', 'Moylan-Rose Valley', 'Media', 'Elwyn', 'Wawa',
  // Paoli/Thorndale Line
  'Overbrook', 'Merion', 'Narberth', 'Wynnewood', 'Ardmore', 'Haverford',
  'Bryn Mawr', 'Rosemont', 'Villanova', 'Radnor', 'St. Davids', 'Wayne',
  'Strafford', 'Devon', 'Berwyn', 'Daylesford', 'Paoli', 'Malvern', 'Exton',
  'Whitford', 'Downingtown', 'Thorndale',
  // Trenton Line
  'Bridesburg', 'Tacony', 'Holmesburg Jct', 'Torresdale', 'Cornwells Heights',
  'Eddington', 'Croydon', 'Bristol', 'Levittown', 'Trenton',
  // West Trenton Line
  'Noble', 'Rydal', 'Meadowbrook', 'Bethayres', 'Philmont', 'Forest Hills',
  'Somerton', 'Trevose', 'Neshaminy Falls', 'Langhorne', 'Woodbourne', 'Yardley',
  'West Trenton',
  // Wilmington/Newark Line
  'Darby', 'Curtis Park', 'Sharon Hill', 'Folcroft', 'Glenolden', 'Norwood',
  'Prospect Park', 'Ridley Park', 'Crum Lynne', 'Eddystone', 'Chester TC',
  'Highland Avenue', 'Marcus Hook', 'Claymont', 'Wilmington', 'Churchmans Crossing',
  'Newark',
];

// Common alternate names → canonical station (keys are normalized: see norm()).
const STATION_ALIASES: Record<string, string> = {
  '30thstreet': 'Gray 30th Street',
  '30thstreetstation': 'Gray 30th Street',
  '30thst': 'Gray 30th Street',
  '30thststation': 'Gray 30th Street',
  'universitycity': 'Penn Medicine Station',
  'pennmedicine': 'Penn Medicine Station',
  'marketeast': 'Jefferson Station',
  'marketeaststation': 'Jefferson Station',
  'jefferson': 'Jefferson Station',
  'suburban': 'Suburban Station',
  'templeu': 'Temple University',
  'fernrock': 'Fern Rock TC',
  'fernrocktransportationcenter': 'Fern Rock TC',
  'norristowntransportationcenter': 'Norristown TC',
  'chestertransportationcenter': 'Chester TC',
  'phlairport': 'Airport Terminal E-F',
  'philadelphiaairport': 'Airport Terminal E-F',
  'philadelphiainternationalairport': 'Airport Terminal E-F',
  'airportterminalef': 'Airport Terminal E-F',
  'airportterminalcd': 'Airport Terminal C-D',
  'jenkintown': 'Jenkintown-Wyncote',
  'wyncote': 'Jenkintown-Wyncote',
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Resolve loose user input ("ardmore", "30th street", "Suburban") to the
 *  exact station name the SEPTA API requires. Throws with suggestions when
 *  the input is ambiguous or unrecognized. */
function resolveStation(input: string, argName: string): string {
  const raw = (input ?? '').toString().trim();
  if (!raw) {
    throw new Error(
      `SEPTA: the \`${argName}\` argument is required — a Regional Rail station name, e.g. "Suburban Station", "Ardmore", "30th Street".`,
    );
  }
  const n = norm(raw);
  // 1. exact (normalized) match
  const exact = STATIONS.find((s) => norm(s) === n);
  if (exact) return exact;
  // 2. alias
  if (STATION_ALIASES[n]) return STATION_ALIASES[n];
  // 3. substring match
  let candidates = STATIONS.filter((s) => norm(s).includes(n) || n.includes(norm(s)));
  if (candidates.length > 1) {
    const starts = candidates.filter((s) => norm(s).startsWith(n));
    if (starts.length === 1) candidates = starts;
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(
      `SEPTA: "${raw}" matches multiple stations: ${candidates.join(', ')}. Pick one exact name for \`${argName}\`.`,
    );
  }
  // 4. edit distance (typo tolerance)
  const ranked = STATIONS
    .map((s) => ({ s, d: editDistance(norm(s), n) }))
    .sort((x, y) => x.d - y.d);
  if (ranked[0].d <= 2) return ranked[0].s;
  const suggestions = ranked.slice(0, 5).map((r) => r.s);
  throw new Error(
    `SEPTA: "${raw}" is not a recognized Regional Rail station for \`${argName}\`. Closest matches: ${suggestions.join(', ')}. Station names must be a SEPTA Regional Rail stop (buses and subways use septa_bus_positions / septa_alerts).`,
  );
}

// ── Alerts route-id resolution ──────────────────────────────────────
const RR_LINE_TO_ALERT_ID: Record<string, string> = {
  airport: 'rr_route_apt',
  chestnuthilleast: 'rr_route_che',
  chestnuthillwest: 'rr_route_chw',
  cynwyd: 'rr_route_cyn',
  foxchase: 'rr_route_fxc',
  lansdaledoylestown: 'rr_route_landdoy',
  lansdale: 'rr_route_landdoy',
  doylestown: 'rr_route_landdoy',
  mediawawa: 'rr_route_med',
  media: 'rr_route_med',
  wawa: 'rr_route_med',
  manayunknorristown: 'rr_route_nor',
  manayunk: 'rr_route_nor',
  norristown: 'rr_route_nor',
  paolithorndale: 'rr_route_pao',
  paoli: 'rr_route_pao',
  thorndale: 'rr_route_pao',
  trenton: 'rr_route_trent',
  warminster: 'rr_route_warm',
  wilmingtonnewark: 'rr_route_wilm',
  wilmington: 'rr_route_wilm',
  westtrenton: 'rr_route_wtren',
  glensidecombined: 'rr_route_gc',
  broadstreetline: 'rr_route_bsl',
  broadstreet: 'rr_route_bsl',
  bsl: 'rr_route_bsl',
  broadstreetowl: 'rr_route_bso',
  marketfrankfordline: 'rr_route_mfl',
  marketfrankford: 'rr_route_mfl',
  mfl: 'rr_route_mfl',
  marketfrankfordowl: 'rr_route_mfo',
  norristownhighspeedline: 'rr_route_nhsl',
  nhsl: 'rr_route_nhsl',
  cct: 'cct',
  system: 'generic',
  systemwide: 'generic',
  generic: 'generic',
};

// SEPTA trolley routes by legacy number (everything else numeric is a bus).
const TROLLEY_ROUTES = new Set(['10', '11', '13', '34', '36', '101', '102']);

// SEPTA Metro (2024 rebrand) trolley codes → legacy route numbers.
// TransitView requires the NEW codes (T1..T5, G1, D1, D2); the Alerts feed
// still uses the LEGACY numbers (trolley_route_10 etc.). Verified live
// 2026-07-15 by matching vehicle destinations (T1→63rd-Malvern = old 10, ...).
const METRO_TO_LEGACY: Record<string, string> = {
  T1: '10', T2: '34', T3: '13', T4: '11', T5: '36',
  G1: '15', D1: '101', D2: '102',
};
const LEGACY_TO_METRO: Record<string, string> = Object.fromEntries(
  Object.entries(METRO_TO_LEGACY).map(([m, l]) => [l, m]),
);

/** Map friendly route input ("paoli/thorndale", "23", "T1", "bus_route_23",
 *  "MFL") to a SEPTA alerts route_id. */
function resolveAlertRouteId(input: string): string {
  const raw = input.trim();
  // Already a route_id
  if (/^(bus_route_|trolley_route_|rr_route_)/i.test(raw) || raw.toLowerCase() === 'generic' || raw.toLowerCase() === 'cct') {
    return raw.toLowerCase();
  }
  // SEPTA Metro trolley code ("T1", "D2", "G1") → legacy trolley number
  const metro = METRO_TO_LEGACY[raw.toUpperCase()];
  if (metro) {
    return TROLLEY_ROUTES.has(metro) ? `trolley_route_${metro}` : `bus_route_${metro}`;
  }
  // Bare bus/trolley route number ("23", "10", "route 47")
  const numMatch = raw.match(/^(?:route\s*)?(\d{1,3}[a-z]?)$/i);
  if (numMatch) {
    const num = numMatch[1].toUpperCase();
    return TROLLEY_ROUTES.has(num) ? `trolley_route_${num}` : `bus_route_${num}`;
  }
  const mapped = RR_LINE_TO_ALERT_ID[norm(raw)];
  if (mapped) return mapped;
  throw new Error(
    `SEPTA: unrecognized route "${raw}" for alerts. Use a bus/trolley number ("23", "10"), a Regional Rail line name ("Paoli/Thorndale", "West Trenton", "Airport"), a subway line ("Broad Street Line", "Market-Frankford Line", "NHSL"), or a raw route_id like "bus_route_23" / "rr_route_pao".`,
  );
}

// ── HTTP + shaping helpers ──────────────────────────────────────────

async function septaFetch(path: string, params?: Record<string, string>): Promise<unknown> {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  const res = await pwFetch(`${BASE_URL}/${path}${qs}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(
      `SEPTA API error: HTTP ${res.status} on ${path}. The SEPTA real-time feed is occasionally flaky — retry once, and check septa_alerts for system-wide disruptions.`,
    );
  }
  const data = (await res.json()) as unknown;
  const err = (data as Record<string, unknown>)?.error;
  if (err && typeof err === 'string') {
    throw new Error(`SEPTA API error: ${err}`);
  }
  return data;
}

/** Strip HTML tags/entities from SEPTA alert bodies into readable plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

interface ArrivalRecord {
  direction: string;
  path: string;
  train_id: string;
  origin: string;
  destination: string;
  line: string;
  status: string;
  service_type: string;
  next_station: string | null;
  sched_time: string;
  depart_time: string;
  track: string;
  track_change: string | null;
  platform: string;
  platform_change: string | null;
}

function shapeArrival(t: ArrivalRecord) {
  return {
    train_id: t.train_id,
    line: t.line,
    origin: t.origin,
    destination: t.destination,
    sched_time: t.sched_time,
    depart_time: t.depart_time,
    status: t.status, // "On Time" or minutes late like "5 min"
    service_type: t.service_type,
    next_station: t.next_station,
    track: t.track,
    track_change: t.track_change,
    platform: t.platform || null,
  };
}

// ── Tool implementations ────────────────────────────────────────────

async function railArrivals(args: Record<string, unknown>) {
  const station = resolveStation(
    (args.station as string) ?? (args.stop as string) ?? '',
    'station',
  );
  const results = Math.min(Math.max(Number(args.results) || 8, 1), 30);
  const data = (await septaFetch('Arrivals/index.php', {
    station,
    results: String(results),
  })) as Record<string, Array<Record<string, ArrivalRecord[]>>>;

  // Response has ONE dynamic top-level key, e.g.
  // "Ardmore Departures: July 15, 2026, 6:54 pm" → [{Northbound: [...]}, {Southbound: [...]}]
  const [header, groups] = Object.entries(data)[0] ?? ['', []];
  const asOf = header.includes(':') ? header.slice(header.indexOf(':') + 1).trim() : header;
  const northbound: ReturnType<typeof shapeArrival>[] = [];
  const southbound: ReturnType<typeof shapeArrival>[] = [];
  for (const group of groups ?? []) {
    for (const [dir, trains] of Object.entries(group)) {
      const target = dir === 'Northbound' ? northbound : southbound;
      for (const t of trains ?? []) target.push(shapeArrival(t));
    }
  }
  const total = northbound.length + southbound.length;
  return {
    station,
    as_of: asOf,
    northbound,
    southbound,
    ...(total === 0
      ? { note: 'Zero upcoming departures reported — service may be finished for the night at this station.' }
      : {}),
  };
}

interface NtaRecord {
  orig_train: string;
  orig_line: string;
  orig_departure_time: string;
  orig_arrival_time: string;
  orig_delay: string;
  isdirect: string;
  term_train?: string;
  term_line?: string;
  term_depart_time?: string;
  term_arrival_time?: string;
  term_delay?: string;
  Connection?: string;
}

async function nextToArrive(args: Record<string, unknown>) {
  const orig = resolveStation(
    (args.orig as string) ?? (args.origin as string) ?? (args.from as string) ?? '',
    'orig',
  );
  const dest = resolveStation(
    (args.dest as string) ?? (args.destination as string) ?? (args.to as string) ?? '',
    'dest',
  );
  const n = Math.min(Math.max(Number(args.n) || 3, 1), 10);
  const data = (await septaFetch('NextToArrive/index.php', {
    req1: orig,
    req2: dest,
    req3: String(n),
  })) as NtaRecord[];

  return {
    origin: orig,
    destination: dest,
    trains: (data ?? []).map((t) => ({
      train_id: t.orig_train,
      line: t.orig_line,
      departure_time: t.orig_departure_time,
      arrival_time: t.orig_arrival_time,
      delay: t.orig_delay, // "On time" or e.g. "5 mins"
      direct: t.isdirect === 'true',
      ...(t.isdirect === 'true'
        ? {}
        : {
            connection_station: t.Connection,
            connecting_train_id: t.term_train,
            connecting_line: t.term_line,
            connecting_departure_time: t.term_depart_time,
            final_arrival_time: t.term_arrival_time,
            connecting_delay: t.term_delay,
          }),
    })),
    ...((data ?? []).length === 0
      ? { note: 'Zero upcoming trains found for this origin/destination pair right now.' }
      : {}),
  };
}

interface TrainViewRecord {
  lat: string;
  lon: string;
  trainno: string;
  service: string;
  dest: string;
  currentstop: string;
  nextstop: string;
  line: string;
  consist: string;
  heading: string | number;
  late: number;
  SOURCE: string;
  TRACK: string;
  TRACK_CHANGE: string;
}

async function trainView(args: Record<string, unknown>) {
  const data = (await septaFetch('TrainView/index.php')) as TrainViewRecord[];
  const lineFilter = args.line ? norm(String(args.line)) : null;
  const trains = (data ?? [])
    .filter((t) => !lineFilter || norm(t.line).includes(lineFilter) || lineFilter.includes(norm(t.line)))
    .map((t) => ({
      train_id: t.trainno,
      line: t.line,
      service: t.service, // "LOCAL" or e.g. "EXP TO JENKINTOWN"
      origin: t.SOURCE,
      destination: t.dest,
      current_stop: t.currentstop,
      next_stop: t.nextstop,
      late_minutes: t.late,
      status: t.late > 0 ? `${t.late} min late` : 'On time',
      lat: Number(t.lat),
      lon: Number(t.lon),
      track: t.TRACK,
      track_change: t.TRACK_CHANGE || null,
    }));
  if (lineFilter && trains.length === 0) {
    const lines = [...new Set((data ?? []).map((t) => t.line))].sort();
    return {
      count: 0,
      trains: [],
      note: `Zero live trains matched line "${args.line}". Lines with trains running right now: ${lines.join(', ')}.`,
    };
  }
  return { count: trains.length, trains };
}

interface BusRecord {
  lat: string;
  lng: string;
  label: string;
  route_id: string;
  trip: string;
  VehicleID: string;
  Direction: string;
  destination: string;
  heading: number;
  late: number;
  next_stop_id: string | null;
  next_stop_name: string | null;
  next_stop_sequence: number | null;
  estimated_seat_availability: string;
  timestamp: number;
}

async function busPositions(args: Record<string, unknown>) {
  let route = String(args.route ?? '').trim().replace(/^route\s*/i, '').toUpperCase();
  if (!route) {
    throw new Error(
      'SEPTA septa_bus_positions requires a `route` — a bus route number like "23" or "47", or a trolley code like "T1" (also accepts legacy trolley numbers "10", "34").',
    );
  }
  // TransitView requires SEPTA Metro trolley codes: translate legacy trolley
  // numbers (10→T1, 34→T2, 13→T3, 11→T4, 36→T5, 15→G1, 101→D1, 102→D2).
  if (LEGACY_TO_METRO[route]) route = LEGACY_TO_METRO[route];
  const data = (await septaFetch('TransitView/index.php', { route })) as
    | { bus?: BusRecord[] }
    | BusRecord[];
  // Unknown routes come back as a bare [] instead of {bus: [...]}.
  const raw = Array.isArray(data) ? [] : data.bus ?? [];
  const vehicles = raw.map((b) => ({
    vehicle_id: b.VehicleID,
    route: b.route_id,
    direction: b.Direction,
    destination: b.destination,
    next_stop: b.next_stop_name,
    late_minutes: b.late,
    status: b.late > 0 ? `${b.late} min late` : 'On time',
    seat_availability: b.estimated_seat_availability, // e.g. MANY_SEATS_AVAILABLE, CRUSHED_STANDING_ROOM_ONLY
    lat: Number(b.lat),
    lon: Number(b.lng),
    last_updated_unix: b.timestamp,
  }));
  return {
    route,
    count: vehicles.length,
    vehicles,
    ...(vehicles.length === 0
      ? { note: `Zero vehicles reporting on route "${route}" right now — either the route number is wrong or the route is between service hours. Trolleys use SEPTA Metro codes T1-T5, G1, D1, D2.` }
      : {}),
  };
}

interface AlertRecord {
  route: string;
  route_id: string;
  route_name: string;
  mode: string;
  isadvisory: string;
  isdetour: string;
  isalert: string;
  issuspended: string;
  isstrike: string;
  isdelays: string;
  last_updated: string;
  description: string;
  alert: string;
  advisory: string;
  detour: Array<{
    location_start?: string;
    location_end?: string;
    start?: string;
    end?: string;
    message?: string;
    reason?: string;
  }>;
}

function shapeAlert(a: AlertRecord) {
  return {
    route_id: a.route_id,
    route_name: a.route_name,
    mode: a.mode,
    route_description: a.description,
    has_alert: a.isalert === 'Y',
    has_advisory: a.isadvisory === 'Yes' || a.isadvisory === 'Y',
    has_detour: a.isdetour === 'Y',
    suspended: a.issuspended === 'Y',
    last_updated: a.last_updated,
    alert_text: a.alert ? stripHtml(a.alert) : null,
    advisory_text: a.advisory ? stripHtml(a.advisory).slice(0, 2000) : null,
    detours: (a.detour ?? []).map((d) => ({
      from: d.location_start,
      to: d.location_end,
      start: d.start,
      end: d.end,
      reason: d.reason,
      detour_route: d.message,
    })),
  };
}

function alertHasContent(a: AlertRecord): boolean {
  return (
    a.isalert === 'Y' ||
    a.isdetour === 'Y' ||
    a.issuspended === 'Y' ||
    a.isadvisory === 'Yes' ||
    a.isadvisory === 'Y' ||
    Boolean(a.alert) ||
    Boolean(a.advisory) ||
    (a.detour ?? []).length > 0
  );
}

async function alerts(args: Record<string, unknown>) {
  const routeInput = (args.route as string) ?? (args.route_id as string) ?? '';
  if (routeInput && String(routeInput).trim()) {
    const routeId = resolveAlertRouteId(String(routeInput));
    const data = (await septaFetch('Alerts/index.php', { req1: routeId })) as AlertRecord[];
    return {
      route_id: routeId,
      alerts: (data ?? []).map(shapeAlert),
      ...((data ?? []).length === 0
        ? { note: `Zero alert records returned for route_id "${routeId}" — verify the route id format (bus_route_23, trolley_route_10, rr_route_pao).` }
        : {}),
    };
  }
  // Route omitted → full system scan, return only routes with active content.
  const data = (await septaFetch('Alerts/index.php')) as AlertRecord[];
  const active = (data ?? []).filter(alertHasContent).map(shapeAlert);
  return {
    scope: 'all routes with an active alert, advisory, detour, or suspension',
    total_routes_checked: (data ?? []).length,
    active_count: active.length,
    alerts: active,
  };
}

// ── Tool definitions ────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'septa_rail_arrivals',
    description:
      'Philadelphia SEPTA Regional Rail departures board for a station — the next trains leaving, grouped Northbound/Southbound with train number, line, destination, scheduled vs estimated departure time, live status ("On Time" or minutes late), and track. Station names are matched forgivingly ("30th street", "ardmore", "suburban" all work). Example: septa_rail_arrivals({ station: "Suburban Station", results: 8 })',
    inputSchema: {
      type: 'object',
      properties: {
        station: {
          type: 'string',
          description:
            'Regional Rail station name, e.g. "Suburban Station", "Gray 30th Street" (accepts "30th Street"), "Temple University", "Ardmore", "Airport Terminal B". Partial names are fuzzy-matched to the official station list.',
        },
        results: {
          type: 'number',
          description: 'Departures to return per direction (default 8, max 30)',
        },
      },
      required: ['station'],
    },
  },
  {
    name: 'septa_next_to_arrive',
    description:
      'Next SEPTA Regional Rail trains from an origin station to a destination station in Philly — direct trains and connecting itineraries (with transfer station), departure/arrival times, and live delay status. Answers "when is the next train from X to Y" in Philadelphia. Example: septa_next_to_arrive({ orig: "Suburban Station", dest: "Airport Terminal B", n: 3 })',
    inputSchema: {
      type: 'object',
      properties: {
        orig: {
          type: 'string',
          description: 'Origin Regional Rail station, e.g. "Suburban Station", "Fox Chase" (fuzzy-matched)',
        },
        dest: {
          type: 'string',
          description: 'Destination Regional Rail station, e.g. "Airport Terminal B", "Ardmore" (fuzzy-matched)',
        },
        n: {
          type: 'number',
          description: 'How many upcoming trains to return (default 3, max 10)',
        },
      },
      required: ['orig', 'dest'],
    },
  },
  {
    name: 'septa_train_view',
    description:
      'Live positions of every SEPTA Regional Rail train currently running in the Philadelphia region — train number, line, destination, current and next stop, minutes late, and lat/lon. Answers "is my train late" and "where is train 456". Optionally filter to one line. Example: septa_train_view({ line: "Paoli/Thorndale" })',
    inputSchema: {
      type: 'object',
      properties: {
        line: {
          type: 'string',
          description:
            'Optional Regional Rail line filter: Airport, Chestnut Hill East, Chestnut Hill West, Cynwyd, Fox Chase, Lansdale/Doylestown, Manayunk/Norristown, Media/Wawa, Paoli/Thorndale, Trenton, Warminster, West Trenton, Wilmington/Newark. Omit for all live trains.',
        },
      },
      required: [],
    },
  },
  {
    name: 'septa_bus_positions',
    description:
      'Live SEPTA bus and trolley vehicle positions for a route in Philadelphia — each vehicle with direction, destination, next stop, minutes late, estimated seat availability (crowding), and lat/lon. Buses use route numbers ("23", "47"); trolleys use SEPTA Metro codes T1-T5, G1 (Girard), D1/D2 (Media/Sharon Hill) — legacy trolley numbers like "10" are auto-translated to T1. Example: septa_bus_positions({ route: "23" })',
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description:
            'Bus route number ("23", "47", "66") or trolley code ("T1"-"T5", "G1", "D1", "D2"; legacy trolley numbers 10/34/13/11/36/15/101/102 also accepted)',
        },
      },
      required: ['route'],
    },
  },
  {
    name: 'septa_alerts',
    description:
      'SEPTA service alerts, advisories, detours, and suspensions for Philadelphia transit. Pass a route to check one line: a bus number ("23"), a trolley ("T1" or legacy "10"), a Regional Rail line name ("Paoli/Thorndale", "West Trenton", "Airport"), a subway ("Broad Street Line", "Market-Frankford Line", "NHSL"), or a raw route_id ("bus_route_23", "trolley_route_10", "rr_route_pao"). Omit route to list every route with an active alert system-wide. Example: septa_alerts({ route: "Paoli/Thorndale" })',
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description:
            'Route to check. Bus number ("23"), trolley ("T1" or "10"), rail line name ("Media/Wawa", "Trenton"), subway ("MFL", "BSL", "NHSL"), or raw route_id ("rr_route_pao"). Omit for all active alerts.',
        },
      },
      required: [],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'septa_rail_arrivals':
      return railArrivals(args);
    case 'septa_next_to_arrive':
      return nextToArrive(args);
    case 'septa_train_view':
      return trainView(args);
    case 'septa_bus_positions':
      return busPositions(args);
    case 'septa_alerts':
      return alerts(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
