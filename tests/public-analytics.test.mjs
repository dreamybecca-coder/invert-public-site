import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const siteRoot = path.join(repositoryRoot, "site");
const scriptSource = "https://cloud.umami.is/script.js";
const websiteId = "bb43536b-1f94-46fd-9163-015f87c1d1ec";
const authDocuments = new Set([
  "auth/confirm/index.html",
  "auth/recovery/index.html",
  "zh/auth/confirm/index.html",
  "zh/auth/recovery/index.html",
]);

test("public pages carry one privacy-bounded Umami tracker and Auth carries none", async () => {
  const htmlFiles = (await walk(siteRoot)).filter((file) => file.endsWith(".html"));

  for (const file of htmlFiles) {
    const relative = path.relative(siteRoot, file).replaceAll(path.sep, "/");
    const html = await readFile(file, "utf8");
    if (authDocuments.has(relative)) {
      assert.doesNotMatch(html, /cloud\.umami\.is|data-umami-event/i, relative);
      continue;
    }

    const trackers = [...html.matchAll(/<script\b([^>]*)>[\s\S]*?<\/script>/gi)]
      .filter(([, attributes]) => attributes.includes(scriptSource));
    assert.equal(trackers.length, 1, relative);
    const attributes = trackers[0][1];
    assert.ok(attributes.includes(`data-website-id="${websiteId}"`), relative);
    assert.ok(attributes.includes('data-domains="invertagent.com"'), relative);
    assert.ok(attributes.includes('data-exclude-search="true"'), relative);
    assert.ok(attributes.includes('data-exclude-hash="true"'), relative);
    assert.ok(attributes.includes('data-do-not-track="true"'), relative);
    assert.doesNotMatch(attributes, /data-auto-track|data-performance|data-before-send/i);
  }
});

test("dashboard outbound events contain only stable product and destination labels", async () => {
  for (const relative of ["products/index.html", "zh/products/index.html"]) {
    const html = await readFile(path.join(siteRoot, relative), "utf8");
    assert.match(html, /data-umami-event="product-link-open"/);
    assert.match(html, /data-umami-event-product="13f-consensus-dashboard"/);
    assert.match(html, /data-umami-event-product="market-sentiment-dashboard"/);
    assert.match(html, /data-umami-event-destination="(?:preview|dashboard|github)"/);
    assert.doesNotMatch(html, /data-umami-event-(?:email|user|account|token|content)=/i);
  }
});

async function walk(directory) {
  const entries = await readdir(directory);
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry);
    return (await stat(file)).isDirectory() ? walk(file) : [file];
  }));
  return nested.flat();
}
