import { createHash } from "node:crypto";
import type { Frame, Locator, Page } from "playwright";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import type { WorkflowInterventionPort } from "../lib/automation/workflow-executor.ts";
import { frameScope, ifFound, type BrowserScope, type FrameScope } from "./frame-scope.ts";
import { expectPageState } from "./page-state-wait.ts";
import { isDeclaredProviderResponse, type ProviderResponseDeclaration } from "./provider-response.ts";
import type { ProviderResponseReader } from "./provider-response-reader.ts";

export const YUANTA_EBANK_ORIGIN = "https://ebank.yuantabank.com.tw";
const YUANTA_CSV_MAX_BYTES = 25 * 1024 * 1024;
/** How long a route may take to render before the site falls back to menuaction(). */
const ROUTE_RENDER_TIMEOUT_MS = 15_000;
const SHELL_TIMEOUT_MS = 5_000;
const MENU_ACTION_TIMEOUT_MS = 10_000;

/** Where one product's page lives on the Yuanta eBank site. */
export type YuantaRoute = Readonly<{
  /** The route under /nib/tx/, with any query the page needs. */
  path: string;
  description: string;
  /** Whether this scope shows the product's page. It may throw a typed absence. */
  ready(scope: BrowserScope): Promise<boolean>;
  /** The provider's menu id, passed to menuaction() when the route does not render the page. */
  menuId?: string;
  /** A route that the signed-in session reaches without a cid. */
  cid?: "required" | "optional";
}>;

export type YuantaDuration =
  | Readonly<{ label: string }>
  | Readonly<{ customLabel: string; startDate: string; endDate: string }>;

export type YuantaCsvDownload = Readonly<{
  content: string;
  byteLength: number;
  contentDigest: `sha256:${string}`;
  contentDisposition: string;
  exportUrl: string;
}>;

type WaitOptions = Readonly<{ timeoutMs?: number }>;

/**
 * Collection's waits for a page state the step expects (ADR 0147), shaped
 * like the frame scope's own. Each pass is a Run intervention safe point, and
 * an expired one pauses a manual run; after Hand back the page is checked
 * again. Use them only to read the page, never for an optional wait that is
 * expected to time out, nor around a request or a one-time click.
 */
export type YuantaPageStateWaits = Readonly<{
  until<T>(probe: () => Promise<T | null | undefined | false>, failure: string, options?: WaitOptions): Promise<T>;
  /** The first scope in which the locator matches an attached element. */
  scopeWith(
    target: string | ((scope: BrowserScope) => Locator),
    description?: string,
    options?: WaitOptions,
  ): Promise<BrowserScope>;
  /** The first visible match, searching one scope or every scope in order. */
  firstVisible(
    locatorFor: (scope: BrowserScope) => Locator,
    description: string,
    options?: WaitOptions & Readonly<{ in?: BrowserScope }>,
  ): Promise<Locator>;
}>;

/**
 * The signed-in Yuanta eBank site (ADR 0066): an fmenu/fmain frameset whose
 * pages are server-rendered routes bound to the session's cid.
 */
export type YuantaEbankSite = Readonly<{
  frames: FrameScope;
  /** Expected-page-state waits over `frames` with the run's Run intervention points. */
  expect: YuantaPageStateWaits;
  cid(): Promise<string | null>;
  /** Open a product's page from any signed-in page and return the scope that shows it. */
  open(route: YuantaRoute): Promise<BrowserScope>;
  menuAction(path: string, menuId: string, timeoutMs?: number): Promise<void>;
  chooseDuration(scope: BrowserScope, duration: YuantaDuration): Promise<void>;
  /**
   * Open a route that its own navigation renders, and read the document that
   * navigation served through `reader` (ADR 0112). The navigation's response is
   * the one Playwright lands on, so a redirect on the way is never read as the
   * page, and the route's readiness, which may throw a typed absence, is
   * decided before the reply is checked against its declaration.
   */
  openDocument(
    route: YuantaRoute,
    declaration: ProviderResponseDeclaration,
    reader: ProviderResponseReader,
  ): Promise<Readonly<{ scope: BrowserScope; html: string }>>;
  /**
   * Fetch a CSV export link's bytes in the page, then accept the reply through
   * `reader` against where it was requested (ADR 0110) and decode it strictly as Big5.
   */
  readCsv(link: Locator, reader: ProviderResponseReader): Promise<YuantaCsvDownload>;
}>;

type SiteContext = Readonly<{
  signal: AbortSignal;
  text: SourceTextPort;
  /** The run's Run intervention points, which the expected-page-state waits consult (ADR 0147). */
  intervention?: WorkflowInterventionPort;
  /** How long an expected page state may take by default; 60 s. */
  pageStateTimeoutMs?: number;
}>;

const cidFromUrl = (url: string): string | null => {
  const match = url.match(/[?&]cid=([^&]+)/u);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

export function yuantaRouteUrl(path: string, cid: string | null): string {
  const url = new URL(`/nib/tx/${path}`, YUANTA_EBANK_ORIGIN);
  if (cid) {
    url.searchParams.set("type", "page");
    url.searchParams.set("cid", cid);
  }
  return url.toString();
}

/** Expected-page-state waits over a frame scope (ADR 0147). */
function pageStateWaits(frames: FrameScope, context: SiteContext): YuantaPageStateWaits {
  const until = <T>(
    probe: () => Promise<T | null | undefined | false>,
    failure: string,
    options: WaitOptions = {},
  ): Promise<T> => {
    const timeoutMs = options.timeoutMs ?? context.pageStateTimeoutMs;
    return expectPageState(frames, context.intervention, probe, failure, timeoutMs === undefined ? {} : { timeoutMs });
  };
  const timeoutOf = (options: WaitOptions): WaitOptions =>
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
  return {
    until,
    scopeWith: (target, description, options = {}) => {
      const locatorFor = typeof target === "string" ? (scope: BrowserScope) => scope.locator(target) : target;
      const label = description ?? (typeof target === "string" ? `selector "${target}"` : "the element");
      return until(async () => {
        for (const scope of frames.scopes()) {
          if ((await locatorFor(scope).count().catch(() => 0)) > 0) return scope;
        }
        return null;
      }, `Could not find ${label} in any frame.`, timeoutOf(options));
    },
    firstVisible: (locatorFor, description, options = {}) =>
      until(async () => {
        for (const scope of options.in ? [options.in] : frames.scopes()) {
          const locator = locatorFor(scope);
          const count = await locator.count().catch(() => 0);
          for (let index = 0; index < count; index += 1) {
            const candidate = locator.nth(index);
            if (await candidate.isVisible().catch(() => false)) return candidate;
          }
        }
        return null;
      }, `Could not find a visible ${description}.`, timeoutOf(options)),
  };
}

export function yuantaEbankSite(page: Page, context: SiteContext): YuantaEbankSite {
  const frames = frameScope(page, context.signal);
  const expect = pageStateWaits(frames, context);

  const cid = async (): Promise<string | null> => {
    for (const scope of frames.scopes()) {
      const field = scope.locator('input[name="cid"]').first();
      if ((await frames.race(field.count().catch(() => 0))) === 0) continue;
      const value = (await frames.withSignal((signal) => field.inputValue({ signal }).catch(() => ""))).trim();
      if (value) return value;
    }
    for (const frame of page.frames()) {
      const value = cidFromUrl(frame.url());
      if (value) return value;
    }
    return cidFromUrl(page.url());
  };

  const showsRoute = (route: YuantaRoute) => async () => {
    for (const scope of frames.scopes()) {
      if (await route.ready(scope)) return scope;
    }
    return null;
  };
  const notShowing = (route: YuantaRoute) => `Could not find ${route.description} in any frame.`;

  const exposingMenuAction = async () => {
    for (const candidate of frames.scopes()) {
      const exposed = await candidate
        .evaluate(() => typeof (window as { menuaction?: unknown }).menuaction === "function")
        .catch(() => false);
      if (exposed) return candidate;
    }
    return null;
  };
  const NO_MENU_ACTION = "Could not find YuanTa menuaction() in any frame.";

  const invokeMenuAction = async (scope: BrowserScope, path: string, menuId: string) => {
    await frames.race(scope.evaluate(({ action, id }) => {
      const menuaction = (window as { menuaction?: (action: string, id: string, flag: string) => void }).menuaction;
      if (typeof menuaction !== "function") throw new Error("YuanTa page did not expose menuaction().");
      menuaction(action, id, "N");
    }, { action: path, id: menuId }));
  };

  // A plain wait: a caller may run this inside a provider-reply wait's trigger, which must not pause.
  const menuAction = async (path: string, menuId: string, timeoutMs = MENU_ACTION_TIMEOUT_MS) => {
    await invokeMenuAction(await frames.until(exposingMenuAction, NO_MENU_ACTION, { timeoutMs }), path, menuId);
  };

  const fmain = async (): Promise<Frame> => {
    // A shell without fmain is a lost session, decided at once rather than paused over.
    const frame = await ifFound(frames.frame("fmain", { timeoutMs: SHELL_TIMEOUT_MS }));
    if (!frame) throw new FailureCodeError("authentication-failed");
    return frame;
  };

  const site: YuantaEbankSite = {
    frames,
    expect,
    cid,
    open: async (route) => {
      const content = await fmain();
      const sessionCid = await cid();
      if (sessionCid || route.cid === "optional") {
        const url = yuantaRouteUrl(route.path, sessionCid);
        await frames.withSignal((signal) => content.goto(url, { waitUntil: "domcontentloaded", signal }));
        await frames.settle(content);
        if (!route.menuId) return await expect.until(showsRoute(route), notShowing(route));
        // A route that does not render its page is expected: menuaction() renders it instead.
        const rendered = await ifFound(
          frames.until(showsRoute(route), notShowing(route), { timeoutMs: ROUTE_RENDER_TIMEOUT_MS }),
        );
        if (rendered) return rendered;
      } else if (!route.menuId) {
        throw new FailureCodeError("authentication-failed");
      }
      const menu = await expect.until(exposingMenuAction, NO_MENU_ACTION, { timeoutMs: MENU_ACTION_TIMEOUT_MS });
      await invokeMenuAction(menu, route.path, route.menuId);
      await frames.settle(content);
      return await expect.until(showsRoute(route), notShowing(route));
    },
    menuAction,
    chooseDuration: async (scope, duration) => {
      const label = "label" in duration ? duration.label : duration.customLabel;
      const link = await expect.firstVisible(
        (candidate) => candidate.locator("#duration a").filter({ hasText: label }),
        `YuanTa date range link "${label}"`,
        { in: scope },
      );
      await frames.withSignal((signal) => link.click({ force: true, signal }));
      if ("customLabel" in duration) {
        await frames.withSignal((signal) => scope.locator("#sdate").fill(duration.startDate, { signal }));
        await frames.withSignal((signal) => scope.locator("#edate").fill(duration.endDate, { signal }));
      }
      if (scope !== page) await frames.settle(scope as Frame);
    },
    openDocument: async (route, declaration, reader) => {
      // menuaction() renders in a later navigation whose document this one is not.
      if (route.menuId) throw new Error(`${route.description} is not rendered by its own route.`);
      const content = await fmain();
      const sessionCid = await cid();
      if (!sessionCid && route.cid !== "optional") throw new FailureCodeError("authentication-failed");
      const url = yuantaRouteUrl(route.path, sessionCid);
      const served = await frames.withSignal((signal) => content.goto(url, { waitUntil: "domcontentloaded", signal }));
      // The declared document is read at once, before a later navigation in fmain can evict its body;
      // any other landing is read only after readiness, so a typed absence it shows wins.
      const read = (response: NonNullable<typeof served>) => reader.acquireFrom(frames, declaration, response, "text");
      const early = served && isDeclaredProviderResponse(declaration, served.url(), served.request().method())
        ? read(served)
        : null;
      early?.catch(() => undefined);
      await frames.settle(content);
      // A plain wait: the document read is this navigation's, so a page the person fixed would not be it.
      const scope = await frames.until(showsRoute(route), notShowing(route));
      if (!served) throw new Error(`${route.description} navigation served no document.`);
      const acquired = await (early ?? read(served));
      return { scope, html: (await reader.accept(declaration, acquired)).evidence.text };
    },
    readCsv: (link, reader) => readYuantaBig5CsvFromAnchor(link, reader, context),
  };
  return Object.freeze(site);
}

/** The request the page's export link or form made for its CSV. */
type CsvExportRequest = Readonly<{ url: string; method: "GET" | "POST" }>;

type BrowserCsvResponse = Readonly<{
  requested: CsvExportRequest;
  url: string;
  status: number;
  headers: Record<string, string>;
  byteLength: number;
  base64: string;
}>;

const regExpLiteral = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");

/**
 * The CSV export's reply, declared at the URL it was answered from with the
 * method the page's link or form used. No capture records the export path
 * (ADR 0110), and the reader follows a redirect within the eBank origin by
 * design, so the path is the one the reply landed on; the host, status,
 * charset and size are still checked.
 */
export function yuantaCsvExportResponse(landed: CsvExportRequest): ProviderResponseDeclaration<"optional"> {
  const url = new URL(landed.url);
  return {
    label: "Yuanta CSV export",
    host: new URL(YUANTA_EBANK_ORIGIN).hostname,
    endpoints: [{
      path: url.pathname,
      method: landed.method,
      search: new RegExp(`^${regExpLiteral(url.search)}$`, "u"),
      // The eBank labels its Big5 CSV exports wrongly: deposit replies say
      // utf-8 and foreign-currency replies iso-8859-1. Only those labels are
      // accepted, and the label never changes the decoding: the body is read
      // strictly as Big5, so bytes that are not Big5 fail source text integrity.
      charset: { decode: "big5", labels: ["utf-8", "iso-8859-1"] },
    }],
    cacheControl: [],
    providerDate: "optional",
    maxBytes: YUANTA_CSV_MAX_BYTES,
  };
}

/**
 * Fetch an export link's CSV bytes inside the signed-in page, then accept the
 * reply through the reader and decode it strictly as Big5.
 */
export async function readYuantaBig5CsvFromAnchor(
  exportLink: Locator,
  reader: ProviderResponseReader,
  { signal }: Pick<SiteContext, "signal">,
): Promise<YuantaCsvDownload> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Yuanta CSV retrieval was canceled."),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let response: BrowserCsvResponse;
  try {
    const read = exportLink.evaluate(
      async (element, maxBytes): Promise<BrowserCsvResponse> => {
        const anchor = element as HTMLAnchorElement;
        const href = anchor.getAttribute("href")?.trim();
        const documentUrl = new URL(anchor.ownerDocument.baseURI);
        const pageOrigin = anchor.ownerDocument.location.origin;
        let url: URL;
        let requestBody: URLSearchParams | undefined;
        if (
          /^javascript:void\(0\);?$/iu.test(href ?? "") &&
          /^\s*getDownload\(\s*['"]csv['"]\s*\)\s*;?\s*$/iu.test(anchor.getAttribute("onclick") ?? "")
        ) {
          const foreignForm = anchor.ownerDocument.querySelector('form[name="mform"]') as HTMLFormElement | null;
          const isForeignExport = foreignForm !== null &&
            /\/fxtransactiondetails$/iu.test(new URL(foreignForm.action, documentUrl).pathname);
          const form = isForeignExport
            ? foreignForm
            : anchor.ownerDocument.querySelector('form[name="jform"]') as HTMLFormElement | null;
          if (!form || form.method.toLowerCase() !== "post") {
            throw new Error("Yuanta CSV export form is unavailable.");
          }
          url = new URL(form.action, documentUrl);
          if (!(isForeignExport
            ? /\/fxtransactiondetails$/iu.test(url.pathname)
            : /\/transactiondetails$/iu.test(url.pathname))) {
            throw new Error("Yuanta CSV export form has an unexpected action.");
          }
          if (!isForeignExport) url.searchParams.set("method", "downloadcsv");
          requestBody = new URLSearchParams();
          for (const [name, value] of new FormData(form)) {
            if (typeof value !== "string") {
              throw new Error("Yuanta CSV export form contains a file input.");
            }
            requestBody.append(name, value);
          }
          if (isForeignExport) {
            const transactionType = anchor.ownerDocument.getElementById("txntype") as HTMLInputElement | null;
            if (!transactionType || transactionType.form !== form || !transactionType.name) {
              throw new Error("Yuanta foreign CSV export type is unavailable.");
            }
            requestBody.set(transactionType.name, "downloadcsv");
          }
        } else {
          if (!href || /^(?:javascript|data):/iu.test(href)) {
            throw new Error("Yuanta CSV link has no fetchable URL.");
          }
          url = new URL(href, documentUrl);
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username.length > 0 ||
          url.password.length > 0 ||
          url.origin !== pageOrigin
        ) {
          throw new Error("Yuanta CSV link left the authenticated origin.");
        }

        const method = requestBody ? "POST" : "GET";
        const fetched = await fetch(url.href, {
          method,
          ...(requestBody ? { body: requestBody } : {}),
          mode: "same-origin",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "follow",
        });
        if (new URL(fetched.url).origin !== pageOrigin) {
          throw new Error("Yuanta CSV redirected outside the authenticated origin.");
        }
        const contentLength = fetched.headers.get("content-length");
        if (contentLength !== null) {
          if (!/^\d+$/u.test(contentLength)) {
            throw new Error("Yuanta CSV response length is invalid.");
          }
          const declaredLength = Number(contentLength);
          if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
            throw new Error("Yuanta CSV exceeded the in-memory size limit.");
          }
        }

        const reader = fetched.body?.getReader();
        if (!reader) throw new Error("Yuanta CSV response body is missing.");
        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            byteLength += next.value.byteLength;
            if (byteLength > maxBytes) {
              await reader.cancel().catch(() => undefined);
              throw new Error("Yuanta CSV exceeded the in-memory size limit.");
            }
            chunks.push(next.value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return {
          requested: { url: url.href, method },
          url: fetched.url,
          status: fetched.status,
          headers: Object.fromEntries(fetched.headers),
          byteLength,
          base64: btoa(binary),
        };
      },
      YUANTA_CSV_MAX_BYTES,
    );
    response = await Promise.race([read, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  signal.throwIfAborted();
  const bytes = Buffer.from(response.base64, "base64");
  if (bytes.byteLength !== response.byteLength) {
    throw new Error("Yuanta CSV response was incomplete in memory.");
  }
  const { evidence } = await reader.accept(
    yuantaCsvExportResponse({ url: response.url, method: response.requested.method }),
    {
      evidence: { kind: "text", bytes },
      response: { url: response.url, status: response.status, method: response.requested.method, headers: response.headers },
    },
  );
  return {
    content: evidence.text,
    byteLength: bytes.byteLength,
    contentDigest: `sha256:${createHash("sha256").update(bytes).digest("base64url")}`,
    contentDisposition: response.headers["content-disposition"] ?? "",
    exportUrl: response.url,
  };
}
