import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertDeployablePublishableKey,
  writeAuthCallbackArtifact,
} from "./auth-callback-artifact.mjs";

const outputDir = path.resolve("site");
const publishableKey =
  process.env.NEXT_PUBLIC_INVERT_AUTH_SUPABASE_PUBLISHABLE_KEY ?? "";
assertDeployablePublishableKey(publishableKey);

const deployment = JSON.parse(
  await readFile(path.join(outputDir, "deployment.json"), "utf8"),
);
const basePath = deployment.basePath ?? "";
if (basePath) {
  throw new Error("Production AUTH regeneration requires the apex deployment artifact.");
}

const indexHtml = await readFile(path.join(outputDir, "index.html"), "utf8");
const stylesheetPath = indexHtml.match(/href="(\/assets\/[^"]+\.css)"/)?.[1] ?? "";
if (!stylesheetPath) {
  throw new Error("The production artifact does not expose its stylesheet.");
}

await writeAuthCallbackArtifact({
  outputDir,
  basePath,
  stylesheetPath,
  publishableKey,
});

console.log("Regenerated four production AUTH callback routes.");
