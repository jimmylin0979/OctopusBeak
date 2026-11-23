import type { Frame, Locator, Page } from "playwright";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import type { ProviderEvidence, ProviderResponse } from "./provider-response.ts";
import { activateControlWithoutPointer } from "./browser-interaction.ts";
import { frameScope, ifFound, type BrowserScope, type FrameScope } from "./frame-scope.ts";
import { expectPageState, type PageStateWaitOptions } from "./page-state-wait.ts";
import type { WorkflowInterventionPort } from "../lib/automation/workflow-executor.ts";

export const FUBON_EBANK_ENTRY_URL = "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";
export const FUBON_EBANK_HOST = new URL(FUBON_EBANK_ENTRY_URL).hostname;
const HEADER_FRAME = "frame1";
const SHELL_TIMEOUT_MS = 5_000;
/** How long a task link already on the page may take to appear before the header menu is opened. */
const LINK_PRESENT_TIMEOUT_MS = 5_000;
const LINK_TIMEOUT_MS = 30_000;
/** How long a triggered task may take to render before the site triggers it once more. */
const ROUTE_RENDER_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 5_000;
const BANK_MASK_SELECTOR = "div._mask, ._mask";

/** Where one product's page lives on the Fubon eBank site. */
export type FubonRoute = Readonly<{
  description: string;
  /** The task link that opens the page, searched in every scope; candidates are tried in order within each scope. */
  link(scope: BrowserScope): Locator | readonly Locator[];
  /** The header-frame menu that reveals the task link, such as "#menu_CLN". */
  menu?: string;
  /**
   * Click the task link where it is even when it carries a real href, so the
   * bank performs its own redirect instead of the site navigating to the href.
   */
  clickInPlace?: boolean;
  /** Whether this scope shows the product's page. It may throw a typed absence. */
  ready(scope: BrowserScope): Promise<boolean>;
}>;

/**
 * The signed-in Fubon eBank site (ADR 0066): a JSF frameset whose header
 * frame1 holds the menus and whose txnFrame shows each task. Tasks are reached
 * through the bank's own links, because navigating a frame directly loses the
 * bank's 302 hand-off.
 */
export type FubonEbankSite = Readonly<{
  frames: FrameScope;
  header(): Promise<Frame>;
  /**
   * Open a product's page from any signed-in page and return the scope that
   * shows it. Its waits are expected page states unless `intervene` is false,
   * for an open that is itself the trigger of a provider-reply wait.
   */
  open(route: FubonRoute, options?: Readonly<{ intervene?: boolean }>): Promise<BrowserScope>;
  /**
   * Wait for a page state collection expects (ADR 0147): each pass is a Run
   * intervention safe point, and an expired wait pauses a manual run, then
   * probes again after Hand back. The probe must only read the page.
   */
  expect<T>(probe: () => Promise<T | null | undefined | false>, failure: string, options?: PageStateWaitOptions): Promise<T>;
  /** The first scope in which the target matches an attached element, as an expected page state. */
  scopeWith(target: string | ((scope: BrowserScope) => Locator), description?: string, options?: PageStateWaitOptions): Promise<BrowserScope>;
  /** Wait for the locator to match an attached element, as an expected page state. */
  attached(locator: Locator, description: string, options?: PageStateWaitOptions): Promise<void>;
  /** Click a control without the pointer, following a real href in its own scope. */
  activate(control: Locator, scope?: BrowserScope): Promise<void>;
  waitForMaskToClear(timeoutMs?: number): Promise<void>;
  /** Post a form from inside the page and return the reply as observed, before any check. */
  postback(form: Locator, submitFieldName?: string, fields?: Readonly<Record<string, string>>): Promise<FubonPostbackReply>;
  replaceDocument(scope: BrowserScope, html: string): Promise<void>;
}>;

/** One HTML reply the site observed: its body bytes and the response that carried them. */
export type FubonReply = Readonly<{
  evidence: Extract<ProviderEvidence, { kind: "text" }>;
  response: ProviderResponse;
}>;

/** A postback's reply, with the URL the form was posted to: its action, resolved against the page. */
export type FubonPostbackReply = FubonReply & Readonly<{ postedTo: string }>;

/** The run's signal, and its Run intervention points, which collection's expected page states consult (ADR 0147). */
type SiteContext = Readonly<{ signal: AbortSignal; intervention?: WorkflowInterventionPort }>;

type PageStateWait = FubonEbankSite["expect"];

const isFollowableHref = (href: string | null): href is string =>
  !!href && href !== "#" && !href.startsWith("javascript:");

export function fubonEbankSite(page: Page, context: SiteContext): FubonEbankSite {
  const frames = frameScope(page, context.signal);
  const expect: PageStateWait = (probe, failure, options) =>
    expectPageState(frames, context.intervention, probe, failure, options);
  const plainWait: PageStateWait = (probe, failure, options) => frames.until(probe, failure, options);
  const hasAttached = async (locator: Locator) => (await locator.count().catch(() => 0)) > 0;

  const header = async (): Promise<Frame> => {
    const frame = await ifFound(frames.frame(HEADER_FRAME, { timeoutMs: SHELL_TIMEOUT_MS }));
    if (!frame) throw new FailureCodeError("authentication-failed");
    return frame;
  };

  const activate = async (control: Locator, scope?: BrowserScope) => {
    const href = await frames.withSignal((signal) =>
      control.getAttribute("href", { timeout: CONTROL_TIMEOUT_MS, signal }).catch(() => null));
    if (scope && isFollowableHref(href)) {
      const url = new URL(href, FUBON_EBANK_ENTRY_URL).toString();
      await frames.withSignal((signal) => scope.goto(url, { waitUntil: "domcontentloaded", signal }));
      return;
    }
    // A dispatched click takes the run's signal, so a click queued behind a bank redirect cannot outlive the run.
    await frames.withSignal((signal) => activateControlWithoutPointer(control, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)]),
      timeout: CONTROL_TIMEOUT_MS,
    }));
  };

  const findLink = (route: FubonRoute, timeoutMs: number, wait: PageStateWait = plainWait) =>
    wait(async () => {
      for (const scope of frames.scopes()) {
        const candidates = route.link(scope);
        for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
          const link = (candidate as Locator).first();
          if ((await link.count().catch(() => 0)) > 0) return { scope, link };
        }
      }
      return null;
    }, `Could not find the ${route.description} link in any frame.`, { timeoutMs });

  // A control that times out is not proof that the bank ignored it; the ready probe that follows decides.
  const activateTolerantly = async (control: Locator, scope?: BrowserScope) => {
    try {
      await activate(control, scope);
    } catch (error) {
      if (context.signal.aborted) throw error;
    }
  };

  const trigger = async (route: FubonRoute, openMenu: boolean, wait: PageStateWait): Promise<void> => {
    if (openMenu && route.menu) {
      await activateTolerantly((await header()).locator(route.menu).first());
    }
    // A link already on the page is optional: its short wait is expected to expire, so it never pauses the run.
    const present = openMenu ? null : await ifFound(findLink(route, LINK_PRESENT_TIMEOUT_MS));
    if (!present && !openMenu && route.menu) return await trigger(route, true, wait);
    const { scope, link } = present ?? await findLink(route, LINK_TIMEOUT_MS, wait);
    await activateTolerantly(link, route.clickInPlace ? undefined : scope);
  };

  const showing = (route: FubonRoute, timeoutMs?: number, wait: PageStateWait = plainWait) =>
    wait(async () => {
      for (const scope of frames.scopes()) {
        if (await route.ready(scope)) return scope;
      }
      return null;
    }, `Could not find ${route.description} in any frame.`, { timeoutMs });

  const site: FubonEbankSite = {
    frames,
    header,
    open: async (route, { intervene = true } = {}) => {
      const wait = intervene ? expect : plainWait;
      await header();
      await trigger(route, false, wait);
      // The first render has a grace period before the site triggers again, so it never pauses the run.
      const rendered = await ifFound(showing(route, ROUTE_RENDER_TIMEOUT_MS));
      if (rendered) return rendered;
      // The first trigger can replace the transaction frame before its task renders; trigger it once more.
      await trigger(route, true, wait);
      return await showing(route, undefined, wait);
    },
    expect,
    scopeWith: (target, description, options) => {
      const locatorFor = typeof target === "string" ? (scope: BrowserScope) => scope.locator(target) : target;
      const label = description ?? (typeof target === "string" ? `selector "${target}"` : "the element");
      return expect(async () => {
        for (const scope of frames.scopes()) {
          if (await hasAttached(locatorFor(scope))) return scope;
        }
        return null;
      }, `Could not find ${label} in any frame.`, options);
    },
    attached: async (locator, description, options) => {
      await expect(() => hasAttached(locator), `Timed out waiting for ${description}.`, options);
    },
    activate,
    waitForMaskToClear: async (timeoutMs) => {
      await expect(async () => {
        for (const scope of frames.scopes()) {
          const masks = scope.locator(BANK_MASK_SELECTOR);
          const count = await masks.count().catch(() => 0);
          for (let index = 0; index < count; index += 1) {
            if (await masks.nth(index).isVisible().catch(() => false)) return false;
          }
        }
        return true;
      }, "Timed out waiting for the bank loading mask to clear.", timeoutMs === undefined ? {} : { timeoutMs });
    },
    postback: async (form, submitFieldName, fields = {}) => {
      const reply = await frames.race(form.evaluate(async (element, options) => {
        if (!(element instanceof HTMLFormElement)) throw new Error("Postback target is not a form element.");
        const body = new URLSearchParams();
        for (const [key, value] of new FormData(element)) body.append(key, String(value));
        if (options.submitFieldName) body.set(options.submitFieldName, options.submitFieldName);
        for (const [key, value] of Object.entries(options.fields)) body.set(key, value);
        const action = element.getAttribute("action") || window.location.href;
        const init = {
          body: body.toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        };
        const postedTo = new URL(action, window.location.href).toString();
        const response = await fetch(postedTo, init);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return {
          base64: btoa(binary),
          postedTo,
          response: {
            url: response.url,
            status: response.status,
            method: init.method,
            headers: Object.fromEntries(response.headers.entries()),
          },
        };
      }, { fields, submitFieldName }));
      return {
        evidence: { kind: "text", bytes: new Uint8Array(Buffer.from(reply.base64, "base64")) },
        response: reply.response,
        postedTo: reply.postedTo,
      };
    },
    replaceDocument: async (scope, html) => {
      await frames.race(scope.evaluate((nextHtml) => {
        document.open();
        document.write(nextHtml);
        document.close();
      }, html));
    },
  };
  return Object.freeze(site);
}
