import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import {
  SOURCE_CANDIDATE_PUBLISHABLE_KEY,
  assertDeployablePublishableKey,
} from "../scripts/auth-callback-artifact.mjs";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const approvedKey = "sb_publishable_ABCDEF0123456789ApprovedReviewKey";
const publicKeyEnvironment = "NEXT_PUBLIC_INVERT_AUTH_SUPABASE_PUBLISHABLE_KEY";
const authGeneratedFiles = new Set([
  "assets/auth-callback-runtime.js",
  "auth/confirm/index.html",
  "auth/recovery/index.html",
  "zh/auth/confirm/index.html",
  "zh/auth/recovery/index.html",
]);

test("deployable public config rejects missing and non-production markers", () => {
  for (const key of [
    "",
    "legacy-anon-key",
    "service_role-secret",
    "sb_secret_value",
    SOURCE_CANDIDATE_PUBLISHABLE_KEY,
    "sb_publishable_synthetic_key",
    "sb_publishable_fixture_key",
    "sb_publishable_test_key",
  ]) {
    assert.throws(() => assertDeployablePublishableKey(key), /approved production/);
  }
  assert.doesNotThrow(() => assertDeployablePublishableKey(approvedKey));
});

test("committed source artifact cannot pass the default deployment verifier", () => {
  for (const invalidKey of [
    null,
    "legacy-anon-key",
    "service_role-secret",
    "sb_secret_value",
    SOURCE_CANDIDATE_PUBLISHABLE_KEY,
  ]) {
    const environment = invalidKey === null
      ? {}
      : { [publicKeyEnvironment]: invalidKey };
    const verification = runNode("scripts/verify-static.mjs", environment);
    assert.notEqual(verification.status, 0, String(invalidKey));
    assert.match(verification.stderr, /approved production/);
  }

  const sourceReview = runNode("scripts/verify-static.mjs", {}, ["--source-candidate"]);
  assert.equal(sourceReview.status, 0, `${sourceReview.stdout}\n${sourceReview.stderr}`);
});

test("production regeneration and exact-key verification gate the upload artifact", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "invert-pages-deploy-gate-"));
  await cp(path.join(repositoryRoot, "site"), path.join(temporaryRoot, "site"), {
    recursive: true,
  });
  try {
    const nonAuthBefore = await nonAuthFileHashes(path.join(temporaryRoot, "site"));
    const regeneration = runNode(
      path.join(repositoryRoot, "scripts/export-auth-production.mjs"),
      { [publicKeyEnvironment]: approvedKey },
      [],
      temporaryRoot,
    );
    assert.equal(regeneration.status, 0, `${regeneration.stdout}\n${regeneration.stderr}`);
    assert.deepEqual(
      await nonAuthFileHashes(path.join(temporaryRoot, "site")),
      nonAuthBefore,
    );

    const verification = runNode(
      path.join(repositoryRoot, "scripts/verify-static.mjs"),
      { [publicKeyEnvironment]: approvedKey },
      [],
      temporaryRoot,
    );
    assert.equal(verification.status, 0, `${verification.stdout}\n${verification.stderr}`);

    const mismatch = runNode(
      path.join(repositoryRoot, "scripts/verify-static.mjs"),
      { [publicKeyEnvironment]: `${approvedKey}Mismatch` },
      [],
      temporaryRoot,
    );
    assert.notEqual(mismatch.status, 0);

    for (const route of [
      "auth/confirm/index.html",
      "auth/recovery/index.html",
      "zh/auth/confirm/index.html",
      "zh/auth/recovery/index.html",
    ]) {
      const html = await readFile(path.join(temporaryRoot, "site", route), "utf8");
      assert.ok(html.includes(`content="${approvedKey}"`), route);
      assert.ok(!html.includes(SOURCE_CANDIDATE_PUBLISHABLE_KEY), route);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("push-main and manual dispatch share regeneration and strict verification before upload", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/pages.yml"), "utf8");
  assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  const regeneration = workflow.indexOf("run: npm run export:auth-production");
  const verification = workflow.indexOf("run: npm run verify");
  const upload = workflow.indexOf("uses: actions/upload-pages-artifact@v3");
  const deploy = workflow.indexOf("uses: actions/deploy-pages@v4");
  assert.ok(regeneration > 0 && regeneration < verification);
  assert.ok(verification < upload && upload < deploy);
  assert.equal(workflow.match(/upload-pages-artifact@/g)?.length, 1);
  assert.equal(workflow.match(/NEXT_PUBLIC_INVERT_AUTH_SUPABASE_PUBLISHABLE_KEY: \$\{\{ vars\./g)?.length, 2);
  assert.doesNotMatch(workflow, /verify:source/);
});

function runNode(script, environment = {}, argumentsList = [], cwd = repositoryRoot) {
  return spawnSync(process.execPath, [script, ...argumentsList], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

async function nonAuthFileHashes(root) {
  const hashes = new Map();
  for (const file of await walk(root)) {
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    if (authGeneratedFiles.has(relative)) continue;
    const contents = await readFile(file);
    hashes.set(relative, createHash("sha256").update(contents).digest("hex"));
  }
  return hashes;
}

async function walk(directory) {
  const entries = await readdir(directory);
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry);
    return (await stat(file)).isDirectory() ? walk(file) : [file];
  }));
  return nested.flat();
}
