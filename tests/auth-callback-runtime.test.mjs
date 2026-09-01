import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthRequestFailure,
  EXPECTED_SUPABASE_PUBLIC_ORIGIN,
  bootAuthCallbackPage,
  createAuthProviderClient,
  parseAuthCallbackFragment,
} from "../src/auth-callback-runtime.js";

const syntheticKey = "sb_publishable_synthetic_pages_key";
const syntheticSession = {
  access_token: "synthetic-access-token",
  refresh_token: "synthetic-refresh-token",
};

class FakeNode {
  constructor() {
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type, event = {}) {
    this.listeners.get(type)?.({ preventDefault() {}, ...event });
  }
}

function makePage({ purpose, hash, pathname }) {
  const ids = [
    "auth-panel",
    "auth-title",
    "auth-lead",
    "auth-confirm-action",
    "auth-recovery-form",
    "auth-password",
    "auth-password-confirmation",
    "auth-validation",
    "auth-progress",
    "auth-logout-retry",
    "auth-manual-return",
    "auth-access-residual",
  ];
  const nodes = new Map(ids.map((id) => [id, new FakeNode()]));
  const submit = new FakeNode();
  nodes.get("auth-recovery-form").querySelector = () => submit;
  const listeners = new Map();
  const location = { hash, pathname, search: "" };
  const windowObject = {
    location,
    history: {
      replaceState(_data, _unused, nextPath) {
        location.hash = "";
        location.search = "";
        location.pathname = nextPath;
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  const documentObject = {
    body: { dataset: { authPurpose: purpose, locale: "en" } },
    getElementById(id) {
      return nodes.get(id);
    },
    querySelector(selector) {
      if (selector !== 'meta[name="invert-auth-publishable-key"]') return null;
      return { getAttribute: () => syntheticKey };
    },
  };
  return { documentObject, listeners, location, nodes, submit, windowObject };
}

function domText(page) {
  return [...page.nodes.values()].map((node) => `${node.textContent}${node.value}`).join("\n");
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

test("fragment parser accepts only the reviewed token_hash contracts", () => {
  assert.deepEqual(
    parseAuthCallbackFragment("#token_hash=opaque-token_123&type=email", "email"),
    { ok: true, tokenHash: "opaque-token_123", purpose: "email" },
  );
  assert.deepEqual(
    parseAuthCallbackFragment("#type=recovery&token_hash=opaque-token_456", "recovery"),
    { ok: true, tokenHash: "opaque-token_456", purpose: "recovery" },
  );
  for (const fragment of [
    "",
    "#type=email",
    "#token_hash=one&token_hash=two",
    "#token_hash=one&type=email&extra=value",
    "#token_hash=bad%20token&type=email",
    "#token_hash=token&type=recovery",
  ]) {
    assert.equal(parseAuthCallbackFragment(fragment, "email").ok, false, fragment);
  }
});

test("provider client is pinned to the exact public origin and publishable-only keys", () => {
  assert.doesNotThrow(() => createAuthProviderClient({
    origin: EXPECTED_SUPABASE_PUBLIC_ORIGIN,
    publishableKey: syntheticKey,
  }));
  const expectedHost = new URL(EXPECTED_SUPABASE_PUBLIC_ORIGIN).host;
  for (const origin of [
    "https://unrelated.example",
    `https://${expectedHost}.example`,
    "https://custom.supabase.co",
    `http://${expectedHost}`,
    "https://localhost",
    "https://127.0.0.1",
    `${EXPECTED_SUPABASE_PUBLIC_ORIGIN}/path`,
    `${EXPECTED_SUPABASE_PUBLIC_ORIGIN}?query=value`,
    `https://user@${expectedHost}`,
    "https://*.supabase.co",
  ]) {
    assert.throws(
      () => createAuthProviderClient({ origin, publishableKey: syntheticKey }),
      AuthRequestFailure,
      origin,
    );
  }
  for (const publishableKey of ["legacy-anon", "service_role-secret", "sb_secret_value"]) {
    assert.throws(
      () => createAuthProviderClient({
        origin: EXPECTED_SUPABASE_PUBLIC_ORIGIN,
        publishableKey,
      }),
      AuthRequestFailure,
    );
  }
});

test("confirm cleans the URL on load and waits for a deliberate click", async () => {
  const token = "opaque-confirm-token";
  const page = makePage({
    purpose: "email",
    hash: `#token_hash=${token}&type=email`,
    pathname: "/auth/confirm/",
  });
  const calls = [];
  const controller = bootAuthCallbackPage({
    ...page,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/auth/v1/verify")) return Response.json(syntheticSession);
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(page.location.hash, "");
  assert.equal(calls.length, 0);
  assert.doesNotMatch(domText(page), new RegExp(token));
  await controller.confirmEmail();
  assert.deepEqual(calls.map(({ url }) => url), [
    `${EXPECTED_SUPABASE_PUBLIC_ORIGIN}/auth/v1/verify`,
    `${EXPECTED_SUPABASE_PUBLIC_ORIGIN}/auth/v1/logout?scope=local`,
  ]);
  assert.deepEqual(JSON.parse(calls[0].init.body), { token_hash: token, type: "email" });
  assert.equal(page.nodes.get("auth-panel").className, "auth-panel auth-state-success");
  assert.doesNotMatch(domText(page), new RegExp(token));
});

test("confirm uncertain failure, stale retry, and remount never re-dispatch a token", async () => {
  const token = "single-use-confirm-token";
  const page = makePage({
    purpose: "email",
    hash: `#token_hash=${token}&type=email`,
    pathname: "/auth/confirm/",
  });
  const calls = [];
  const fetchImpl = async () => {
    calls.push(token);
    throw new Error("synthetic response loss");
  };
  const controller = bootAuthCallbackPage({ ...page, fetchImpl });
  await controller.confirmEmail();
  assert.equal(page.nodes.get("auth-panel").className, "auth-panel auth-state-restart");
  await controller.confirmEmail();
  const remount = makePage({
    purpose: "email",
    hash: page.location.hash,
    pathname: page.location.pathname,
  });
  bootAuthCallbackPage({ ...remount, fetchImpl });
  assert.equal(calls.length, 1);
});

test("recovery uncertain failure and stale submit never re-dispatch a token", async () => {
  const token = "single-use-recovery-token";
  const page = makePage({
    purpose: "recovery",
    hash: `#token_hash=${token}&type=recovery`,
    pathname: "/auth/recovery/",
  });
  const calls = [];
  const controller = bootAuthCallbackPage({
    ...page,
    fetchImpl: async () => {
      calls.push(token);
      throw new Error("synthetic uncertain failure");
    },
  });
  page.nodes.get("auth-password").value = "NewPassword8";
  page.nodes.get("auth-password-confirmation").value = "NewPassword8";
  await controller.completeRecovery();
  assert.equal(page.nodes.get("auth-panel").className, "auth-panel auth-state-restart");
  await controller.completeRecovery();
  const remount = makePage({
    purpose: "recovery",
    hash: page.location.hash,
    pathname: page.location.pathname,
  });
  bootAuthCallbackPage({ ...remount, fetchImpl: async () => { calls.push(token); } });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(domText(page), new RegExp(token));
});

test("recovery update retry uses the session and never verifies twice", async () => {
  const page = makePage({
    purpose: "recovery",
    hash: "#token_hash=recovery-update-token&type=recovery",
    pathname: "/auth/recovery/",
  });
  const calls = [];
  let updateAttempts = 0;
  const controller = bootAuthCallbackPage({
    ...page,
    fetchImpl: async (url) => {
      const operation = url.endsWith("/verify")
        ? "verify"
        : url.endsWith("/user")
          ? "update"
          : "logout";
      calls.push(operation);
      if (operation === "verify") return Response.json(syntheticSession);
      if (operation === "update" && updateAttempts++ === 0) {
        return Response.json({}, { status: 503 });
      }
      return new Response(null, { status: 204 });
    },
  });
  page.nodes.get("auth-password").value = "NewPassword8";
  page.nodes.get("auth-password-confirmation").value = "NewPassword8";
  await controller.completeRecovery();
  assert.equal(page.nodes.get("auth-panel").className, "auth-panel auth-state-update_retry");
  await controller.completeRecovery();
  assert.deepEqual(calls, ["verify", "update", "update", "logout"]);
});

test("recovery in-flight unmount and remount cannot replay the token", async () => {
  const token = "unmounted-recovery-token";
  const gate = deferred();
  const page = makePage({
    purpose: "recovery",
    hash: `#token_hash=${token}&type=recovery`,
    pathname: "/auth/recovery/",
  });
  const calls = [];
  const controller = bootAuthCallbackPage({
    ...page,
    fetchImpl: async () => {
      calls.push(token);
      return gate.promise;
    },
  });
  page.nodes.get("auth-password").value = "NewPassword8";
  page.nodes.get("auth-password-confirmation").value = "NewPassword8";
  const completion = controller.completeRecovery();
  await settle();
  page.listeners.get("pagehide")();
  gate.reject(new Error("synthetic response loss"));
  await completion;
  const remount = makePage({
    purpose: "recovery",
    hash: page.location.hash,
    pathname: page.location.pathname,
  });
  bootAuthCallbackPage({ ...remount, fetchImpl: async () => { calls.push(token); } });
  assert.equal(calls.length, 1);
});
