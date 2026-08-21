import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("site");
const previewPrefix = "/invertagent-pages/";
const textExtensions = new Set([".html", ".css", ".json", ".txt", ".xml"]);

for (const file of await walk(root)) {
  if (!textExtensions.has(path.extname(file))) continue;
  const original = await readFile(file, "utf8");
  const rebased = original.replaceAll(previewPrefix, "/");
  if (rebased !== original) await writeFile(file, rebased);
}

const deploymentPath = path.join(root, "deployment.json");
if (await exists(deploymentPath)) {
  const deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
  deployment.basePath = "";
  await writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
}

console.log("Rebased the static site for the invertagent.com root domain.");

async function walk(directory) {
  const entries = await readdir(directory);
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry);
    return (await stat(file)).isDirectory() ? walk(file) : [file];
  }));
  return nested.flat();
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
