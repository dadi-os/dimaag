/**
 * In-process Playwright CDP connections to Nas-owned Chromium instances.
 * Ephemeral like TranscriptStore — lost on process restart.
 */

import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import type { Config } from "../config.js";
import { DimaagError } from "../errors.js";
import type { NasClient } from "../nas/client.js";

type Connection = {
  browser: Browser;
  cdpUrl: string;
};

export type TabInfo = {
  tab_id: string;
  url: string;
  title: string;
  focused: boolean;
};

export type SnapshotResult = {
  tree: string;
  truncated: boolean;
  url: string;
};

/** Manage CDP connections and page actions for Nas browsers. */
export class BrowserDriver {
  private readonly connections = new Map<number, Connection>();
  private readonly cdpUrls = new Map<number, string>();

  constructor(
    private readonly nas: NasClient,
    private readonly config: Config,
  ) {}

  /** Cache the CDP URL from spawn without connecting yet. */
  remember(browserId: number, cdpUrl: string): void {
    this.cdpUrls.set(browserId, cdpUrl);
  }

  drop(browserId: number): void {
    this.cdpUrls.delete(browserId);
    this.detach(browserId);
  }

  /** Close the Playwright connection but keep the remembered CDP URL for reconnect. */
  private detach(browserId: number): void {
    const conn = this.connections.get(browserId);
    this.connections.delete(browserId);
    if (!conn) {
      return;
    }
    void conn.browser.close().catch(() => {});
  }

  dropAll(): void {
    for (const id of new Set([...this.connections.keys(), ...this.cdpUrls.keys()])) {
      this.drop(id);
    }
  }

  async connect(browserId: number, cdpUrl: string): Promise<Browser> {
    this.cdpUrls.set(browserId, cdpUrl);
    const existing = this.connections.get(browserId);
    if (existing && existing.browser.isConnected()) {
      return existing.browser;
    }
    if (existing) {
      this.connections.delete(browserId);
      void existing.browser.close().catch(() => {});
    }
    const browser = await chromium.connectOverCDP(cdpUrl);
    this.connections.set(browserId, { browser, cdpUrl });
    browser.on("disconnected", () => {
      if (this.connections.get(browserId)?.browser === browser) {
        this.connections.delete(browserId);
      }
    });
    return browser;
  }

  private async resolveCdpUrl(browserId: number): Promise<string> {
    const remembered = this.cdpUrls.get(browserId);
    if (remembered) {
      return remembered;
    }
    const cached = this.connections.get(browserId);
    if (cached?.cdpUrl) {
      return cached.cdpUrl;
    }
    const list = await this.nas.listBrowsers();
    const found = list.find((b) => b.id === browserId);
    if (!found || !found.cdp_url) {
      throw new DimaagError(404, "not_found", `browser ${browserId} is not running`);
    }
    this.cdpUrls.set(browserId, found.cdp_url);
    return found.cdp_url;
  }

  private async withBrowser<T>(browserId: number, fn: (browser: Browser) => Promise<T>): Promise<T> {
    const run = async () => {
      const cdpUrl = await this.resolveCdpUrl(browserId);
      const browser = await this.connect(browserId, cdpUrl);
      return await fn(browser);
    };
    try {
      return await run();
    } catch (err) {
      if (err instanceof DimaagError) {
        throw err;
      }
      this.detach(browserId);
      try {
        return await run();
      } catch (err2) {
        if (err2 instanceof DimaagError) {
          throw err2;
        }
        throw new DimaagError(404, "not_found", `browser ${browserId} is not running`);
      }
    }
  }

  private applyTimeouts(page: Page): void {
    page.setDefaultTimeout(this.config.browser.action_timeout_ms);
    page.setDefaultNavigationTimeout(this.config.browser.navigation_timeout_ms);
  }

  private async pageTargetId(page: Page): Promise<string> {
    const session = await page.context().newCDPSession(page);
    try {
      const info = (await session.send("Target.getTargetInfo")) as {
        targetInfo: { targetId: string };
      };
      return info.targetInfo.targetId;
    } finally {
      await session.detach().catch(() => {});
    }
  }

  private async targetInfos(browser: Browser): Promise<
    Array<{ targetId: string; type: string; url: string; title: string; attached: boolean }>
  > {
    let session: CDPSession;
    try {
      session = await browser.newBrowserCDPSession();
    } catch {
      // Fallback: derive from open pages only.
      const pages = browser.contexts().flatMap((ctx) => ctx.pages());
      const out = [];
      for (const page of pages) {
        out.push({
          targetId: await this.pageTargetId(page),
          type: "page",
          url: page.url(),
          title: await page.title().catch(() => ""),
          attached: true,
        });
      }
      return out;
    }
    try {
      const result = (await session.send("Target.getTargets")) as {
        targetInfos: Array<{
          targetId: string;
          type: string;
          url: string;
          title: string;
          attached?: boolean;
        }>;
      };
      return result.targetInfos.map((t) => ({
        targetId: t.targetId,
        type: t.type,
        url: t.url,
        title: t.title,
        attached: t.attached === true,
      }));
    } finally {
      await session.detach().catch(() => {});
    }
  }

  private async pageMap(browser: Browser): Promise<Map<string, Page>> {
    const map = new Map<string, Page>();
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const id = await this.pageTargetId(page);
        map.set(id, page);
      }
    }
    return map;
  }

  async resolvePage(browserId: number, tabId?: string): Promise<{ page: Page; tabId: string }> {
    return this.withBrowser(browserId, async (browser) => {
      const pages = await this.pageMap(browser);
      if (tabId) {
        const page = pages.get(tabId);
        if (!page) {
          throw new DimaagError(404, "not_found", `tab ${tabId} not found`);
        }
        this.applyTimeouts(page);
        return { page, tabId };
      }
      const targets = (await this.targetInfos(browser)).filter((t) => t.type === "page");
      const attached = targets.filter((t) => t.attached);
      const preferred = attached[attached.length - 1] ?? targets[targets.length - 1];
      if (!preferred) {
        // No page yet — open a blank one.
        const context = browser.contexts()[0] ?? (await browser.newContext());
        const page = await context.newPage();
        this.applyTimeouts(page);
        const id = await this.pageTargetId(page);
        return { page, tabId: id };
      }
      const page = pages.get(preferred.targetId);
      if (!page) {
        throw new DimaagError(404, "not_found", `tab ${preferred.targetId} not found`);
      }
      this.applyTimeouts(page);
      return { page, tabId: preferred.targetId };
    });
  }

  async listTabs(browserId: number): Promise<TabInfo[]> {
    return this.withBrowser(browserId, async (browser) => {
      const pages = await this.pageMap(browser);
      const targets = (await this.targetInfos(browser)).filter((t) => t.type === "page");
      const focusedId =
        [...targets].reverse().find((t) => t.attached)?.targetId ??
        targets[targets.length - 1]?.targetId;
      const out: TabInfo[] = [];
      for (const t of targets) {
        const page = pages.get(t.targetId);
        out.push({
          tab_id: t.targetId,
          url: page ? page.url() : t.url,
          title: page ? await page.title().catch(() => t.title) : t.title,
          focused: t.targetId === focusedId,
        });
      }
      return out;
    });
  }

  async newTab(browserId: number, url?: string): Promise<{ tab_id: string }> {
    return this.withBrowser(browserId, async (browser) => {
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = await context.newPage();
      this.applyTimeouts(page);
      if (url) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      }
      const tabId = await this.pageTargetId(page);
      return { tab_id: tabId };
    });
  }

  async closeTab(browserId: number, tabId: string): Promise<void> {
    const { page } = await this.resolvePage(browserId, tabId);
    await page.close();
  }

  async navigate(
    browserId: number,
    tabId: string | undefined,
    url: string,
    waitUntil: "load" | "domcontentloaded" | "networkidle" = "load",
  ): Promise<{ url: string; title: string; tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    await resolved.page.goto(url, { waitUntil });
    return {
      url: resolved.page.url(),
      title: await resolved.page.title(),
      tab_id: resolved.tabId,
    };
  }

  async accessibilityTree(
    browserId: number,
    tabId: string | undefined,
    maxBytes?: number,
  ): Promise<SnapshotResult & { tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const limit = maxBytes ?? this.config.browser.snapshot_max_bytes;
    const raw = String(await resolved.page.evaluate(SNAPSHOT_SCRIPT));
    const tree =
      "Refs (eN) are valid only until the next accessibility_tree call.\n" + raw;
    const truncated = Buffer.byteLength(tree, "utf8") > limit;
    const bounded = truncated ? truncateUtf8(tree, limit) : tree;
    return {
      tree: bounded,
      truncated,
      url: resolved.page.url(),
      tab_id: resolved.tabId,
    };
  }

  private async locatorForRef(page: Page, ref: string) {
    const locator = page.locator(`[data-dadi-ref="${cssEscape(ref)}"]`);
    const count = await locator.count();
    if (count !== 1) {
      throw new DimaagError(
        409,
        "stale_ref",
        `ref ${ref} resolved to ${count} element(s); take a fresh accessibility_tree`,
      );
    }
    return locator;
  }

  async click(browserId: number, tabId: string | undefined, ref: string): Promise<{ tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const locator = await this.locatorForRef(resolved.page, ref);
    await locator.click();
    return { tab_id: resolved.tabId };
  }

  async type(
    browserId: number,
    tabId: string | undefined,
    ref: string,
    text: string,
    submit?: boolean,
  ): Promise<{ tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const locator = await this.locatorForRef(resolved.page, ref);
    await locator.fill(text);
    if (submit) {
      await locator.press("Enter");
    }
    return { tab_id: resolved.tabId };
  }

  async select(
    browserId: number,
    tabId: string | undefined,
    ref: string,
    value: string,
  ): Promise<{ tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const locator = await this.locatorForRef(resolved.page, ref);
    try {
      await locator.selectOption({ value });
    } catch {
      await locator.selectOption({ label: value });
    }
    return { tab_id: resolved.tabId };
  }

  async waitFor(
    browserId: number,
    tabId: string | undefined,
    opts: {
      text?: string;
      ref?: string;
      network_idle?: boolean;
      timeout_ms?: number;
    },
  ): Promise<{ tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const timeout = opts.timeout_ms ?? 10_000;
    const page = resolved.page;
    if (opts.text) {
      await page.getByText(opts.text).first().waitFor({ state: "visible", timeout });
    }
    if (opts.ref) {
      const locator = page.locator(`[data-dadi-ref="${cssEscape(opts.ref)}"]`);
      await locator.waitFor({ state: "visible", timeout });
      const count = await locator.count();
      if (count !== 1) {
        throw new DimaagError(
          409,
          "stale_ref",
          `ref ${opts.ref} resolved to ${count} element(s); take a fresh accessibility_tree`,
        );
      }
    }
    if (opts.network_idle) {
      await page.waitForLoadState("networkidle", { timeout });
    }
    return { tab_id: resolved.tabId };
  }

  async pageScreenshot(
    browserId: number,
    tabId: string | undefined,
    fullPage?: boolean,
  ): Promise<{ png: Buffer; tab_id: string; url: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const png = await resolved.page.screenshot({
      type: "png",
      fullPage: fullPage === true,
    });
    return { png, tab_id: resolved.tabId, url: resolved.page.url() };
  }

  async extractText(
    browserId: number,
    tabId: string | undefined,
    maxBytes?: number,
  ): Promise<{ text: string; truncated: boolean; url: string; tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const limit = maxBytes ?? this.config.browser.snapshot_max_bytes;
    const raw = await resolved.page.innerText("body");
    const truncated = Buffer.byteLength(raw, "utf8") > limit;
    return {
      text: truncated ? truncateUtf8(raw, limit) : raw,
      truncated,
      url: resolved.page.url(),
      tab_id: resolved.tabId,
    };
  }
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) {
    return s;
  }
  return buf.subarray(0, maxBytes).toString("utf8");
}

/**
 * Injected into the page: clear old refs, walk visible DOM, assign data-dadi-ref
 * to interactive nodes, return an indented text tree.
 */
const SNAPSHOT_SCRIPT = `(() => {
  document.querySelectorAll("[data-dadi-ref]").forEach((el) => el.removeAttribute("data-dadi-ref"));
  let next = 1;
  const lines = [];
  const MIN_TEXT = 2;

  function isHidden(el) {
    if (!(el instanceof Element)) return true;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return true;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return true;
    return false;
  }

  function assignRef(el) {
    const ref = "e" + next++;
    el.setAttribute("data-dadi-ref", ref);
    return ref;
  }

  function indent(depth) {
    return "  ".repeat(depth);
  }

  function describeInput(el) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    const name = el.getAttribute("name") || el.getAttribute("aria-label") || el.id || "";
    const placeholder = el.getAttribute("placeholder") || "";
    const value = el.value || "";
    const checked = el.checked ? " checked" : "";
    return "input type=" + JSON.stringify(type)
      + (name ? " name=" + JSON.stringify(name) : "")
      + (placeholder ? " placeholder=" + JSON.stringify(placeholder) : "")
      + (value ? " value=" + JSON.stringify(value) : "")
      + checked;
  }

  function walk(node, depth) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || "").replace(/\\s+/g, " ").trim();
      if (text.length >= MIN_TEXT) {
        const parent = node.parentElement;
        if (parent && !isHidden(parent) && !["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) {
          lines.push(indent(depth) + "text " + JSON.stringify(text));
        }
      }
      return;
    }
    if (!(node instanceof Element)) return;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(node.tagName)) return;
    if (isHidden(node)) return;

    const tag = node.tagName.toLowerCase();
    const role = (node.getAttribute("role") || "").toLowerCase();
    let emitted = false;

    if (/^h[1-6]$/.test(tag) || tag === "main" || tag === "nav" || tag === "header"
        || tag === "footer" || tag === "aside" || tag === "section" || tag === "article"
        || role === "main" || role === "navigation" || role === "banner") {
      const label = (node.getAttribute("aria-label") || node.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      lines.push(indent(depth) + tag + (label ? " " + JSON.stringify(label) : ""));
      emitted = true;
    }

    if (tag === "a" || role === "link") {
      const ref = assignRef(node);
      const href = node.getAttribute("href") || "";
      const text = (node.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      lines.push(indent(depth) + "link [" + ref + "]"
        + (text ? " " + JSON.stringify(text) : "")
        + (href ? " href=" + JSON.stringify(href) : ""));
      emitted = true;
    } else if (tag === "button" || role === "button") {
      const ref = assignRef(node);
      const text = (node.innerText || node.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      lines.push(indent(depth) + "button [" + ref + "]" + (text ? " " + JSON.stringify(text) : ""));
      emitted = true;
    } else if (tag === "input") {
      const ref = assignRef(node);
      lines.push(indent(depth) + "[" + ref + "] " + describeInput(node));
      emitted = true;
    } else if (tag === "textarea") {
      const ref = assignRef(node);
      const name = node.getAttribute("name") || node.getAttribute("aria-label") || "";
      const value = node.value || "";
      lines.push(indent(depth) + "textarea [" + ref + "]"
        + (name ? " name=" + JSON.stringify(name) : "")
        + (value ? " value=" + JSON.stringify(value.slice(0, 200)) : ""));
      emitted = true;
    } else if (tag === "select") {
      const ref = assignRef(node);
      const options = Array.from(node.options).map((o) => ({
        value: o.value,
        label: o.label || o.text,
        selected: o.selected,
      }));
      lines.push(indent(depth) + "select [" + ref + "] options=" + JSON.stringify(options));
      emitted = true;
    } else if (tag === "img") {
      const alt = node.getAttribute("alt") || "";
      lines.push(indent(depth) + "img alt=" + JSON.stringify(alt));
      emitted = true;
    }

    const childDepth = emitted ? depth + 1 : depth;
    // Skip descending into leaves we already summarized fully.
    if (tag === "input" || tag === "textarea" || tag === "select" || tag === "img") {
      return;
    }
    for (const child of node.childNodes) {
      walk(child, childDepth);
    }
  }

  walk(document.body, 0);
  return lines.join("\\n");
})()`;
