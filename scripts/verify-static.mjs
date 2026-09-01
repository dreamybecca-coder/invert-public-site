import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  SOURCE_CANDIDATE_PUBLISHABLE_KEY,
  assertDeployablePublishableKey,
} from "./auth-callback-artifact.mjs";

const argumentsList = process.argv.slice(2);
const sourceCandidateMode = argumentsList.length === 1 && argumentsList[0] === "--source-candidate";
if (argumentsList.length > 0 && !sourceCandidateMode) {
  throw new Error("Unknown static verification mode.");
}
const expectedPublishableKey = sourceCandidateMode
  ? SOURCE_CANDIDATE_PUBLISHABLE_KEY
  : process.env.NEXT_PUBLIC_INVERT_AUTH_SUPABASE_PUBLISHABLE_KEY ?? "";
if (!sourceCandidateMode) assertDeployablePublishableKey(expectedPublishableKey);

const root = path.resolve("site");
const files = await walk(root);
const htmlFiles = files.filter((file) => file.endsWith(".html"));
const deployment = JSON.parse(await readFile(path.join(root, "deployment.json"), "utf8"));
const basePath = deployment.basePath ?? "";
const authHtmlPaths = new Set([
  "/auth/confirm/index.html",
  "/auth/recovery/index.html",
  "/zh/auth/confirm/index.html",
  "/zh/auth/recovery/index.html",
]);
const expectedAuthRuntime = `${basePath}/assets/auth-callback-runtime.js`;
const expectedProviderOrigin = "https://gioalvawiuuvphzilavr.supabase.co";

if (htmlFiles.length < 30) {
  throw new Error(`Expected at least 30 HTML pages, found ${htmlFiles.length}.`);
}

const forbiddenPaths = ["/studio/", "/admin/", "/api/"];
for (const file of files) {
  const relative = `/${path.relative(root, file).replaceAll(path.sep, "/")}`;
  if (forbiddenPaths.some((segment) => relative.includes(segment))) {
    throw new Error(`Private route leaked into static artifact: ${relative}`);
  }
  if (/\.(env|sql|ts|tsx|map)$/i.test(file)) {
    throw new Error(`Source or environment file leaked into static artifact: ${relative}`);
  }
  if (relative.includes("/auth/") && !authHtmlPaths.has(relative)) {
    throw new Error(`Unexpected AUTH path leaked into static artifact: ${relative}`);
  }
}

for (const authPath of authHtmlPaths) {
  if (!files.some((file) => `/${path.relative(root, file).replaceAll(path.sep, "/")}` === authPath)) {
    throw new Error(`Required AUTH route is missing: ${authPath}`);
  }
}

for (const file of htmlFiles) {
  const html = await readFile(file, "utf8");
  const relative = `/${path.relative(root, file).replaceAll(path.sep, "/")}`;
  const isAuthPage = authHtmlPaths.has(relative);
  if (/__VINEXT_/i.test(html)) {
    throw new Error(`Vinext runtime marker remained in ${path.relative(root, file)}.`);
  }
  const executableScripts = [...html.matchAll(/<script\b([^>]*)>[\s\S]*?<\/script>/gi)]
    .filter(([, attributes]) => !/type="application\/ld\+json"/i.test(attributes));
  if (isAuthPage) {
    if (
      executableScripts.length !== 1 ||
      !executableScripts[0][1].includes('type="module"') ||
      !executableScripts[0][1].includes(`src="${expectedAuthRuntime}"`)
    ) {
      throw new Error(`AUTH runtime is missing or not exact in ${path.relative(root, file)}.`);
    }
    assertAuthDocument(html, relative);
  } else if (executableScripts.length > 0) {
    throw new Error(`Runtime script remained in ${path.relative(root, file)}.`);
  }
  const unexpectedRootPath = basePath
    ? new RegExp(`(?:href|src)="/(?!${escapeRegex(basePath.slice(1))}/|/)`)
    : null;
  if (unexpectedRootPath?.test(html)) {
    throw new Error(`Unprefixed root asset remained in ${path.relative(root, file)}.`);
  }

  for (const [, reference] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = localTarget(reference, basePath);
    if (!target) continue;
    try {
      await stat(path.join(root, target));
    } catch {
      throw new Error(`Broken local reference in ${path.relative(root, file)}: ${reference}`);
    }
  }
}

const runtimePath = path.join(root, "assets/auth-callback-runtime.js");
const runtime = await readFile(runtimePath, "utf8");
if (!runtime.includes(expectedProviderOrigin) || !runtime.includes("history.replaceState")) {
  throw new Error("AUTH runtime is missing the locked provider origin or synchronous URL cleanup.");
}
if (
  /(?:service_role|sb_secret_)[A-Za-z0-9._-]{4,}/i.test(runtime) ||
  /localStorage|sessionStorage|indexedDB|document\.cookie|serviceWorker|console\./i.test(runtime)
) {
  throw new Error("AUTH runtime contains forbidden secret, storage, worker, cookie, or logging behavior.");
}

console.log(`Verified ${htmlFiles.length} HTML pages and ${files.length} total files.`);
console.log(`Deployment base path: ${deployment.basePath || "/"}`);

function assertAuthDocument(html, relative) {
  if (!/<meta name="referrer" content="no-referrer">/i.test(html)) {
    throw new Error(`AUTH referrer policy is missing in ${relative}.`);
  }
  if (!/<meta name="robots" content="noindex,nofollow,noarchive">/i.test(html)) {
    throw new Error(`AUTH noindex policy is missing in ${relative}.`);
  }
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/i)?.[1] ?? "";
  if (
    !csp.includes("default-src 'none'") ||
    !csp.includes("script-src 'self'") ||
    !csp.includes(`connect-src ${expectedProviderOrigin}`) ||
    /unsafe-inline|unsafe-eval|connect-src \*|frame-ancestors/i.test(csp)
  ) {
    throw new Error(`AUTH meta CSP is missing, broad, or overclaims frame controls in ${relative}.`);
  }
  const publicKey = html.match(/<meta name="invert-auth-publishable-key" content="([^"]+)">/i)?.[1] ?? "";
  if (
    !/^sb_publishable_[A-Za-z0-9._-]+$/.test(publicKey) ||
    /service_role|sb_secret_/i.test(publicKey) ||
    publicKey !== expectedPublishableKey
  ) {
    throw new Error(`AUTH public config is missing or elevated in ${relative}.`);
  }
  if (/token_hash=[^&"<]+|access_token=|refresh_token=/i.test(html)) {
    throw new Error(`Token-bearing data leaked into AUTH HTML: ${relative}.`);
  }
}

function localTarget(reference, prefix) {
  if (/^(?:https?:|mailto:|tel:|#)/.test(reference)) return null;
  const clean = reference.split(/[?#]/, 1)[0];
  const expectedPrefix = prefix ? `${prefix}/` : "/";
  if (!clean.startsWith(expectedPrefix)) return null;
  const relative = clean.slice(expectedPrefix.length);
  if (!relative) return "index.html";
  return clean.endsWith("/") ? `${relative}index.html` : relative;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function walk(directory) {
  const entries = await readdir(directory);
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry);
    return (await stat(file)).isDirectory() ? walk(file) : [file];
  }));
  return nested.flat();
}
