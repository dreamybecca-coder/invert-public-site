import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertDeployablePublishableKey,
  authCallbackRoutes,
  writeAuthCallbackArtifact,
} from "./auth-callback-artifact.mjs";

const sourceDir = process.env.SOURCE_DIR ?? "/Users/rebecca/Documents/INVERT-WEBSITE-LOGOFIX";
const serverOrigin = (process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3300").replace(/\/$/, "");
const basePath = normalizeBasePath(process.env.BASE_PATH ?? "/invertagent-pages");
const outputDir = path.resolve("site");
const authPublishableKey =
  process.env.NEXT_PUBLIC_INVERT_AUTH_SUPABASE_PUBLISHABLE_KEY ?? "";
assertDeployablePublishableKey(authPublishableKey);
const umamiScriptSrc = "https://cloud.umami.is/script.js";
const umamiWebsiteId = "bb43536b-1f94-46fd-9163-015f87c1d1ec";

const publicRoutes = [
  "/",
  "/products/",
  "/download/",
  "/journal/",
  "/agents/",
  "/projects/",
  "/projects/morning-brief/",
  "/research/",
  "/about/",
  "/privacy/",
  "/terms/",
  "/contact/",
  "/account-data/",
  "/journal/how-investment-judgment-compounds/",
  "/journal/codex-obsidian-investment-cognition-system/",
  "/journal/why-forty-skills-should-not-become-forty-apis/",
  "/zh/",
  "/zh/products/",
  "/zh/download/",
  "/zh/journal/",
  "/zh/agents/",
  "/zh/projects/",
  "/zh/projects/morning-brief/",
  "/zh/research/",
  "/zh/about/",
  "/zh/privacy/",
  "/zh/terms/",
  "/zh/contact/",
  "/zh/account-data/",
  "/zh/journal/investment-judgment-compounds/",
  "/zh/journal/codex-obsidian-investment-cognition-system/",
  "/zh/journal/why-forty-skills-should-not-become-forty-apis/"
];

const publicFiles = [
  "brand",
  "capabilities",
  "products",
  "projects",
  "schemas",
  "llms.txt",
  "og.png",
  "robots.txt",
  "sitemap.xml"
];

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const entry of publicFiles) {
  await cp(path.join(sourceDir, "dist/client", entry), path.join(outputDir, entry), {
    recursive: true
  });
}

let stylesheetPath = null;
for (const route of publicRoutes) {
  const response = await fetch(`${serverOrigin}${route}`);
  if (!response.ok) {
    throw new Error(`Unable to export ${route}: HTTP ${response.status}`);
  }
  let html = await response.text();
  stylesheetPath ??= html.match(/href="(\/assets\/[^\"]+\.css)"/)?.[1] ?? null;
  html = makeStaticHtml(html, basePath);
  const target = route === "/"
    ? path.join(outputDir, "index.html")
    : path.join(outputDir, route.slice(1), "index.html");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, html);
}

if (!stylesheetPath) throw new Error("The rendered site did not expose its stylesheet.");
const stylesheet = await readFile(path.join(sourceDir, "dist/client", stylesheetPath), "utf8");
const staticStylesheet = rewriteCssUrls(stylesheet, basePath);
const stylesheetTarget = path.join(outputDir, stylesheetPath.slice(1));
await mkdir(path.dirname(stylesheetTarget), { recursive: true });
await writeFile(stylesheetTarget, staticStylesheet);
await writeAuthCallbackArtifact({
  outputDir,
  basePath,
  stylesheetPath,
  publishableKey: authPublishableKey,
});

const notFoundHtml = makeNotFoundPage(basePath, stylesheetPath);
await writeFile(path.join(outputDir, "404.html"), notFoundHtml);
await writeFile(path.join(outputDir, ".nojekyll"), "");
if (!basePath) {
  await writeFile(path.join(outputDir, "CNAME"), "invertagent.com\n");
}
await writeFile(
  path.join(outputDir, "deployment.json"),
  `${JSON.stringify({ basePath, sourceCommit: "0ef1b2fd8c5fc98cb59bb01edbeaf2c1a9c55907" }, null, 2)}\n`
);

console.log(`Exported ${publicRoutes.length + authCallbackRoutes.length} public routes to ${outputDir}`);
console.log(`Base path: ${basePath || "/"}`);

function makeStaticHtml(input, prefix) {
  const end = input.indexOf("</html>");
  let html = end >= 0 ? input.slice(0, end + 7) : input;
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (script) => {
    if (/type="application\/ld\+json"/i.test(script)) return script;
    return isApprovedUmamiScript(script) ? script : "";
  });
  html = html.replace(/<link\b[^>]*rel="modulepreload"[^>]*>/gi, "");
  html = html.replace(/\sdata-rsc-css-href="[^"]*"/gi, "");
  html = html.replace(/\sdata-precedence="[^"]*"/gi, "");
  if (prefix) {
    html = html.replace(/\b(href|src)="\/(?!\/)/g, `$1="${prefix}/`);
  }
  return `${html}\n`;
}

function isApprovedUmamiScript(script) {
  const contents = script
    .replace(/^<script\b[^>]*>/i, "")
    .replace(/<\/script>$/i, "")
    .trim();
  return (
    contents === "" &&
    script.includes(`src="${umamiScriptSrc}"`) &&
    script.includes(`data-website-id="${umamiWebsiteId}"`) &&
    script.includes('data-domains="invertagent.com"') &&
    script.includes('data-exclude-search="true"') &&
    script.includes('data-exclude-hash="true"') &&
    script.includes('data-do-not-track="true"')
  );
}

function rewriteCssUrls(css, prefix) {
  if (!prefix) return css;
  return css
    .replace(/url\('\/(?!\/)/g, `url('${prefix}/`)
    .replace(/url\("\/(?!\/)/g, `url("${prefix}/`)
    .replace(/url\(\/(?!\/)/g, `url(${prefix}/`);
}

function makeNotFoundPage(prefix, cssPath) {
  const home = prefix ? `${prefix}/` : "/";
  const css = prefix ? `${prefix}${cssPath}` : cssPath;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Page not found | INVERT</title>
  <link rel="stylesheet" href="${css}">
  <script defer src="${umamiScriptSrc}" data-website-id="${umamiWebsiteId}" data-domains="invertagent.com" data-exclude-search="true" data-exclude-hash="true" data-do-not-track="true"></script>
</head>
<body>
  <main class="legal-shell">
    <p class="eyebrow">404</p>
    <h1>Page not found.</h1>
    <p>The page may have moved as INVERT continues to evolve.</p>
    <a class="arrow-link arrow-link-primary" href="${home}"><span>Return to INVERT</span></a>
  </main>
</body>
</html>
`;
}

function normalizeBasePath(value) {
  if (!value || value === "/") return "";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}
