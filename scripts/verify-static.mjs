import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("site");
const files = await walk(root);
const htmlFiles = files.filter((file) => file.endsWith(".html"));
const deployment = JSON.parse(await readFile(path.join(root, "deployment.json"), "utf8"));
const basePath = deployment.basePath ?? "";

if (htmlFiles.length < 30) {
  throw new Error(`Expected at least 30 HTML pages, found ${htmlFiles.length}.`);
}

const forbiddenPaths = ["/auth/", "/studio/", "/admin/", "/api/"];
for (const file of files) {
  const relative = `/${path.relative(root, file).replaceAll(path.sep, "/")}`;
  if (forbiddenPaths.some((segment) => relative.includes(segment))) {
    throw new Error(`Private route leaked into static artifact: ${relative}`);
  }
  if (/\.(env|sql|ts|tsx|map)$/i.test(file)) {
    throw new Error(`Source or environment file leaked into static artifact: ${relative}`);
  }
}

for (const file of htmlFiles) {
  const html = await readFile(file, "utf8");
  if (/__VINEXT_|<script(?![^>]*application\/ld\+json)/i.test(html)) {
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

console.log(`Verified ${htmlFiles.length} HTML pages and ${files.length} total files.`);
console.log(`Deployment base path: ${deployment.basePath || "/"}`);

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
