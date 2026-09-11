import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

test("deployment verifier rejects a non-apex CNAME and forbidden hosting authorities", async () => {
  for (const mutation of [
    { file: "CNAME", contents: "auth.invertagent.com\n", error: /CNAME must be exactly/ },
    {
      file: "index.html",
      contents: "<!-- https://auth.invertagent.com/auth/confirm/ -->\n",
      error: /Forbidden deployment host auth\.invertagent\.com/,
    },
    {
      file: "index.html",
      contents: "<!-- https://custom-domains.chatgpt.site/ -->\n",
      error: /Forbidden deployment host chatgpt\.site/,
    },
    {
      file: "index.html",
      contents: "<!-- https://AUTH.INVERTAGENT.COM/auth/confirm/ -->\n",
      error: /Forbidden deployment host auth\.invertagent\.com/,
    },
    {
      file: "index.html",
      contents: "<!-- https://Custom-Domains.ChatGPT.Site/ -->\n",
      error: /Forbidden deployment host chatgpt\.site/,
    },
    {
      file: "assets/redirect.mjs",
      contents: "export const target = 'https://AUTH.INVERTAGENT.COM/auth/confirm/';\n",
      error: /Forbidden deployment host auth\.invertagent\.com/,
      newFile: true,
    },
  ]) {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "invert-pages-topology-gate-"));
    await cp(path.join(repositoryRoot, "site"), path.join(temporaryRoot, "site"), {
      recursive: true,
    });
    try {
      const target = path.join(temporaryRoot, "site", mutation.file);
      const original = mutation.file === "CNAME" || mutation.newFile
        ? ""
        : await readFile(target, "utf8");
      await writeFile(target, `${original}${mutation.contents}`);
      const verification = runNode(
        path.join(repositoryRoot, "scripts/verify-static.mjs"),
        {},
        ["--source-candidate"],
        temporaryRoot,
      );
      assert.notEqual(verification.status, 0);
      assert.match(verification.stderr, mutation.error);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
});

test("every responsive navigation exposes the same language destination on mobile", async () => {
  const siteRoot = path.join(repositoryRoot, "site");
  const htmlFiles = (await walk(siteRoot)).filter((file) => file.endsWith(".html"));
  let responsiveNavigationCount = 0;

  for (const file of htmlFiles) {
    const html = await readFile(file, "utf8");
    if (!html.includes('class="mobile-menu"')) continue;
    responsiveNavigationCount += 1;

    const relative = path.relative(siteRoot, file);
    const desktopLanguage = html.match(
      /<a href="([^"]+)" class="language-link" aria-label="([^"]+)">([^<]+)<\/a>/,
    );
    const mobileMenu = html.match(
      /<details class="mobile-menu">[\s\S]*?<nav aria-label="Mobile navigation">([\s\S]*?)<\/nav><\/details>/,
    );
    const mobileLanguage = mobileMenu?.[1].match(
      /<a href="([^"]+)" class="mobile-language-link" aria-label="([^"]+)"><span>([^<]+)<\/span><strong>([^<]+)<\/strong><\/a>/,
    );

    assert.ok(desktopLanguage, `Desktop language switch is missing in ${relative}`);
    assert.ok(mobileLanguage, `Mobile language switch is missing in ${relative}`);
    assert.equal(mobileLanguage[1], desktopLanguage[1], relative);
    assert.equal(mobileLanguage[2], desktopLanguage[2], relative);
    assert.equal(mobileLanguage[4], desktopLanguage[3], relative);
    assert.equal(
      mobileLanguage[3],
      desktopLanguage[3] === "中文" ? "Language" : "语言",
      relative,
    );
  }

  assert.equal(responsiveNavigationCount, 32);
  const stylesheet = await readFile(
    path.join(siteRoot, "assets/index-5S2uRJbO.css"),
    "utf8",
  );
  assert.match(stylesheet, /\.mobile-menu nav \.mobile-language-link\{/);
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
