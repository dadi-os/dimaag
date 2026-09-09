/**
 * Live Nas + Chromium browser driver. Skipped unless NAS_URL is set
 * (e.g. NAS_URL=http://127.0.0.1:8092 npm test -- test/browser-integration.test.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import axios from "axios";
import { BrowserDriver } from "../src/browser/driver.js";
import { createNasClient } from "../src/nas/client.js";
import { testConfig } from "./helpers.js";

const nasUrl = process.env.NAS_URL;

test("integration: snapshot refs, actions, tabs, truncate, stale_ref", async (t) => {
  if (!nasUrl) {
    t.skip("NAS_URL not set");
    return;
  }

  // Point the Nas constant client at NAS_URL by proxying through axios rewrite:
  // createNasClient uses NAS from constants; hit live Nas via a thin wrapper.
  const config = testConfig();
  const http = axios.create({
    baseURL: nasUrl,
    timeout: Math.max(config.nas.timeout_ms, 120_000),
    headers: { "content-type": "application/json" },
  });

  const created = await http.post("/browsers", {});
  assert.equal(created.status, 200);
  const browserId = created.data.id as number;
  const cdpUrl = String(created.data.cdp_url).replace(
    /^ws:\/\/[^/]+/,
    nasUrl.replace(/^http/, "ws"),
  );

  // Real Nas client still targets topology NAS; use a shim that forwards.
  const base = createNasClient(config);
  const nas = {
    ...base,
    createBrowser: async () => {
      const res = await http.post("/browsers", {});
      return res.data;
    },
    listBrowsers: async () => {
      const res = await http.get("/browsers");
      return res.data.map((b: { id: number; cdp_url: string; display: string; healthy: boolean }) => ({
        ...b,
        cdp_url: String(b.cdp_url).replace(/^ws:\/\/[^/]+/, nasUrl.replace(/^http/, "ws")),
      }));
    },
    closeBrowser: async (id: number) => {
      await http.delete(`/browsers/${id}`);
    },
    browserScreenshot: async (id: number) => {
      const res = await http.get(`/browsers/${id}/screenshot`, { responseType: "arraybuffer" });
      return Buffer.from(res.data);
    },
  };

  const driver = new BrowserDriver(nas, config);
  driver.remember(browserId, cdpUrl);

  try {
    const pageHtml = encodeURIComponent(`<!doctype html><html><body>
      <button id="btn">Go</button>
      <input id="inp" type="text" name="q" value="" />
      <select id="sel"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <div id="out"></div>
      <script>
        document.getElementById("btn").onclick = () => {
          document.getElementById("out").textContent = "clicked:" + document.getElementById("inp").value
            + ":" + document.getElementById("sel").value;
        };
      </script>
    </body></html>`);
    const nav = await driver.navigate(browserId, undefined, `data:text/html,${pageHtml}`);
    const tabId = nav.tab_id;

    const snap = await driver.accessibilityTree(browserId, tabId);
    assert.match(snap.tree, /button \[e\d+\]/);
    assert.match(snap.tree, /\[e\d+\].*input/);
    assert.match(snap.tree, /select \[e\d+\]/);

    const buttonRef = snap.tree.match(/button \[(e\d+)\]/)?.[1];
    const inputRef = snap.tree.match(/\[(e\d+)\] input/)?.[1];
    const selectRef = snap.tree.match(/select \[(e\d+)\]/)?.[1];
    assert.ok(buttonRef && inputRef && selectRef, snap.tree);

    await driver.type(browserId, tabId, inputRef, "hello");
    await driver.select(browserId, tabId, selectRef, "b");
    await driver.click(browserId, tabId, buttonRef);

    const { page } = await driver.resolvePage(browserId, tabId);
    const out = await page.locator("#out").innerText();
    assert.equal(out, "clicked:hello:b");

    const tab2 = await driver.newTab(browserId, "about:blank");
    const tabs = await driver.listTabs(browserId);
    assert.ok(tabs.length >= 2);
    assert.ok(tabs.some((tab) => tab.tab_id === tab2.tab_id));

    const tiny = await driver.accessibilityTree(browserId, tabId, 40);
    assert.equal(tiny.truncated, true);
    assert.ok(Buffer.byteLength(tiny.tree, "utf8") <= 40);

    // Rewrite DOM so prior refs go stale.
    await page.evaluate(() => {
      document.body.innerHTML = "<p>rewritten</p>";
    });
    await assert.rejects(
      () => driver.click(browserId, tabId, buttonRef),
      (err: unknown) => {
        assert.ok(err && typeof err === "object" && "type" in err);
        assert.equal((err as { type: string }).type, "stale_ref");
        return true;
      },
    );
  } finally {
    driver.drop(browserId);
    try {
      await http.delete(`/browsers/${browserId}`);
    } catch {
      // best-effort — Nas may already have torn the browser down
    }
  }
});
