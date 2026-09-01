import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import {
  EXPECTED_SUPABASE_PUBLIC_ORIGIN,
  authCallbackRoutes,
  writeAuthCallbackArtifact,
} from "../scripts/auth-callback-artifact.mjs";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const sourceSite = path.join(repositoryRoot, "site");
const syntheticKey = "sb_publishable_synthetic_pages_key";

test("AUTH exporter adds only four routes and one runtime without changing public artifacts", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "invert-pages-auth-"));
  const outputDir = path.join(temporaryRoot, "site");
  await cp(sourceSite, outputDir, { recursive: true });
  const generatedFiles = [
    "assets/auth-callback-runtime.js",
    ...authCallbackRoutes.map(({ route }) => `${route.slice(1)}index.html`),
  ];
  for (const file of generatedFiles) {
    await rm(path.join(outputDir, file), { force: true });
  }
  const before = await fileHashes(outputDir);

  try {
    await writeAuthCallbackArtifact({
      outputDir,
      basePath: "",
      stylesheetPath: "/assets/index-Rf2Vy7Nv.css",
      publishableKey: syntheticKey,
    });
    const after = await fileHashes(outputDir);
    for (const [file, hash] of before) assert.equal(after.get(file), hash, file);

    const expectedNewFiles = new Set(generatedFiles);
    assert.deepEqual(
      new Set([...after.keys()].filter((file) => !before.has(file))),
      expectedNewFiles,
    );

    const verification = spawnSync(
      process.execPath,
      [path.join(repositoryRoot, "scripts/verify-static.mjs")],
      { cwd: temporaryRoot, encoding: "utf8" },
    );
    assert.equal(verification.status, 0, `${verification.stdout}\n${verification.stderr}`);

    const server = await serve(outputDir);
    try {
      for (const { route } of authCallbackRoutes) {
        const response = await fetch(`${server.origin}${route}`);
        assert.equal(response.status, 200, route);
        const html = await response.text();
        assert.match(html, /meta name="referrer" content="no-referrer"/);
        assert.match(html, /meta name="robots" content="noindex,nofollow,noarchive"/);
        assert.ok(html.includes(`connect-src ${EXPECTED_SUPABASE_PUBLIC_ORIGIN}`));
        assert.doesNotMatch(html, /frame-ancestors|token_hash=[^&"<]+|access_token=|refresh_token=/i);
        assert.match(html, /<script type="module" src="\/assets\/auth-callback-runtime\.js"><\/script>/);
      }
      const runtimeResponse = await fetch(`${server.origin}/assets/auth-callback-runtime.js`);
      assert.equal(runtimeResponse.status, 200);
      assert.match(await runtimeResponse.text(), /bootAuthCallbackPage/);
    } finally {
      await server.close();
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("AUTH exporter rejects missing, secret-shaped, and service-role build material", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "invert-pages-auth-config-"));
  try {
    for (const publishableKey of ["", "legacy-anon", "sb_secret_value", "service_role-secret"]) {
      await assert.rejects(
        writeAuthCallbackArtifact({
          outputDir,
          basePath: "",
          stylesheetPath: "/assets/site.css",
          publishableKey,
        }),
        /publishable-only/,
      );
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

async function fileHashes(root) {
  const hashes = new Map();
  for (const file of await walk(root)) {
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
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

async function serve(root) {
  const server = createServer(async (request, response) => {
    const requestPath = new URL(request.url, "http://127.0.0.1").pathname;
    const relative = requestPath.endsWith("/")
      ? `${requestPath.slice(1)}index.html`
      : requestPath.slice(1);
    const file = path.resolve(root, relative || "index.html");
    if (!file.startsWith(`${path.resolve(root)}${path.sep}`) && file !== path.join(path.resolve(root), "index.html")) {
      response.writeHead(400).end();
      return;
    }
    try {
      response.writeHead(200, {
        "content-type": file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8",
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
