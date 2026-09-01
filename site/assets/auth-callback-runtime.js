export const EXPECTED_SUPABASE_PUBLIC_ORIGIN =
  "https://gioalvawiuuvphzilavr.supabase.co";

const MAX_FRAGMENT_LENGTH = 4096;
const MAX_TOKEN_HASH_LENGTH = 2048;
const MAX_RESPONSE_LENGTH = 128 * 1024;
const TOKEN_HASH_PATTERN = /^[A-Za-z0-9._~-]+$/;
const ALLOWED_KEYS = new Set(["token_hash", "type"]);

export class AuthRequestFailure extends Error {
  constructor(kind) {
    super("The authentication request could not be completed.");
    this.name = "AuthRequestFailure";
    this.kind = kind;
  }
}

function parsePair(pair) {
  const separator = pair.indexOf("=");
  if (separator <= 0 || separator !== pair.lastIndexOf("=")) return null;

  const rawKey = pair.slice(0, separator);
  const rawValue = pair.slice(separator + 1);
  if (!rawValue || pair.includes("%")) return null;
  return { key: rawKey, value: rawValue };
}

export function parseAuthCallbackFragment(hash, expectedPurpose) {
  if (!hash || hash === "#") return { ok: false, reason: "empty" };
  if (hash.length > MAX_FRAGMENT_LENGTH) return { ok: false, reason: "overlong" };

  const rawFragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const pairs = rawFragment.split("&");
  if (pairs.length !== 2) return { ok: false, reason: "missing" };

  const values = new Map();
  for (const rawPair of pairs) {
    const pair = parsePair(rawPair);
    if (!pair) return { ok: false, reason: "malformed" };
    if (!ALLOWED_KEYS.has(pair.key)) return { ok: false, reason: "unknown" };
    if (values.has(pair.key)) return { ok: false, reason: "duplicate" };
    values.set(pair.key, pair.value);
  }

  const tokenHash = values.get("token_hash");
  const purpose = values.get("type");
  if (!tokenHash || !purpose) return { ok: false, reason: "missing" };
  if (tokenHash.length > MAX_TOKEN_HASH_LENGTH) return { ok: false, reason: "overlong" };
  if (!TOKEN_HASH_PATTERN.test(tokenHash)) return { ok: false, reason: "malformed" };
  if (purpose !== expectedPurpose) return { ok: false, reason: "wrong_purpose" };

  return { ok: true, tokenHash, purpose: expectedPurpose };
}

export function readAndClearAuthCallback(location, history, expectedPurpose) {
  const hash = location.hash;
  const hadQuery = location.search.length > 0;

  try {
    history.replaceState(null, "", location.pathname);
  } catch {
    return { ok: false, reason: "url_cleanup_failed" };
  }

  if (hadQuery) return { ok: false, reason: "query_present" };
  return parseAuthCallbackFragment(hash, expectedPurpose);
}

function validateProviderConfig(config) {
  let origin;
  try {
    origin = new URL(config.origin);
  } catch {
    throw new AuthRequestFailure("protocol");
  }

  if (
    config.origin !== EXPECTED_SUPABASE_PUBLIC_ORIGIN ||
    origin.protocol !== "https:" ||
    origin.hostname.includes("*") ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    config.origin !== origin.origin
  ) {
    throw new AuthRequestFailure("protocol");
  }

  if (
    !/^sb_publishable_[A-Za-z0-9._-]+$/.test(config.publishableKey) ||
    config.publishableKey.length > 4096 ||
    /service_role|sb_secret_/i.test(config.publishableKey)
  ) {
    throw new AuthRequestFailure("protocol");
  }

  return { origin: origin.origin, publishableKey: config.publishableKey };
}

function providerHeaders(config, accessToken, hasJsonBody = true) {
  const headers = new Headers({ apikey: config.publishableKey });
  if (hasJsonBody) headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  return headers;
}

async function readSession(response) {
  const responseText = await response.text();
  if (responseText.length > MAX_RESPONSE_LENGTH) throw new AuthRequestFailure("protocol");

  let body;
  try {
    body = JSON.parse(responseText);
  } catch {
    throw new AuthRequestFailure("protocol");
  }

  if (!body || typeof body !== "object") throw new AuthRequestFailure("protocol");
  const accessToken = Reflect.get(body, "access_token");
  const refreshToken = Reflect.get(body, "refresh_token");
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new AuthRequestFailure("protocol");
  }
  if (!accessToken || !refreshToken || accessToken.length > 16384 || refreshToken.length > 16384) {
    throw new AuthRequestFailure("protocol");
  }

  return { accessToken, refreshToken };
}

export function createAuthProviderClient(inputConfig, options = {}) {
  const config = validateProviderConfig(inputConfig);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function request(requestPath, init) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(`${config.origin}${requestPath}`, {
        ...init,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AuthRequestFailure(response.status >= 500 ? "temporary" : "unavailable");
      }
      return response;
    } catch (error) {
      if (error instanceof AuthRequestFailure) throw error;
      throw new AuthRequestFailure("temporary");
    } finally {
      clearTimeout(timeout);
    }
  }

  async function verify(tokenHash, purpose) {
    const response = await request("/auth/v1/verify", {
      method: "POST",
      headers: providerHeaders(config),
      body: JSON.stringify({ token_hash: tokenHash, type: purpose }),
    });
    return readSession(response);
  }

  async function logout(accessToken, scope) {
    await request(`/auth/v1/logout?scope=${scope}`, {
      method: "POST",
      headers: providerHeaders(config, accessToken, false),
    });
  }

  return {
    verifyEmail: (tokenHash) => verify(tokenHash, "email"),
    verifyRecovery: (tokenHash) => verify(tokenHash, "recovery"),
    async updatePassword(accessToken, password) {
      await request("/auth/v1/user", {
        method: "PUT",
        headers: providerHeaders(config, accessToken),
        body: JSON.stringify({ password }),
      });
    },
    logoutLocal: (accessToken) => logout(accessToken, "local"),
    logoutGlobal: (accessToken) => logout(accessToken, "global"),
  };
}

export function passwordPolicyFailure(password) {
  const codePoints = Array.from(password).length;
  if (codePoints < 8 || codePoints > 64) return "length";
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return "complexity";
  }
  return null;
}

const copy = {
  en: {
    confirm: {
      ready: ["Confirm this email", "Continue only if you opened this link yourself."],
      working: ["Confirming email", "Keep this page open while the request completes."],
      success: ["Email confirmed", "Email confirmed. Return to INVERT and sign in with your password."],
      unavailable: ["This link can’t be used", "This link can’t be used. It may be incomplete, expired, or already used. Return to INVERT to request another email."],
      restart: ["Request a new verification link", "The verification request outcome is uncertain, so this link will not be tried again. Return to INVERT and request a new verification email."],
      logout_failed: ["Verification is temporarily unavailable", "The secure browser session could not be closed. Close this page and return to INVERT. Nothing from your local INVERT workspace was uploaded."],
      action: "Confirm email",
    },
    recovery: {
      ready: ["Set a new password", "Continue only if you opened this recovery link yourself."],
      working: ["Updating password", "Keep this page open while the request completes."],
      success: ["Password updated", "Password updated. Existing refresh sessions were revoked. Return to INVERT and sign in again."],
      unavailable: ["This link can’t be used", "This link can’t be used. It may be incomplete, expired, or already used. Return to INVERT to request another email."],
      restart: ["Request a new recovery link", "The recovery request outcome is uncertain, so this link will not be tried again. Return to INVERT and request a new recovery email."],
      update_retry: ["Recovery is temporarily unavailable", "Nothing from your local INVERT workspace was uploaded. You can retry while this page remains open."],
      logout_retry: ["Password updated; session revocation needs retry", "The password update completed, but refresh-session revocation could not be confirmed. Keep this page open and retry."],
      action: "Update password",
      retry: "Try again",
      mismatch: "The passwords do not match.",
      invalidPassword: "Use 8–64 characters with uppercase and lowercase letters and a number.",
      manual: "Return to the INVERT app and sign in there.",
      residual: "Already issued access tokens may remain valid until their normal expiry.",
    },
  },
  zh: {
    confirm: {
      ready: ["确认这个邮箱", "只在你主动打开此链接时继续。"],
      working: ["正在确认邮箱", "请求完成前请保持此页面打开。"],
      success: ["邮箱已确认", "邮箱已确认。请返回 INVERT 用密码登录。"],
      unavailable: ["此链接无法使用", "此链接无法使用，可能不完整、已过期或已使用。请回 INVERT 重发邮件。"],
      restart: ["请申请新的验证链接", "验证请求的结果无法确定，因此不会再次尝试这个链接。请返回 INVERT 重新申请验证邮件。"],
      logout_failed: ["暂时无法完成确认", "无法确认安全浏览器会话已经关闭。请关闭此页面并返回 INVERT。你的本地 workspace 没有被上传。"],
      action: "确认邮箱",
    },
    recovery: {
      ready: ["设置新密码", "只在你主动打开此找回链接时继续。"],
      working: ["正在更新密码", "请求完成前请保持此页面打开。"],
      success: ["密码已更新", "密码已更新，既有 refresh session 已撤销。请回 INVERT 重新登录。"],
      unavailable: ["此链接无法使用", "此链接无法使用，可能不完整、已过期或已使用。请回 INVERT 重发邮件。"],
      restart: ["请申请新的找回链接", "找回请求的结果无法确定，因此不会再次尝试这个链接。请返回 INVERT 重新申请找回邮件。"],
      update_retry: ["暂时无法完成找回", "你的 INVERT 本地 workspace 没有被上传。只要此页面保持打开，你可以手动重试。"],
      logout_retry: ["密码已更新，需要重试撤销会话", "密码已经更新，但无法确认 refresh session 已撤销。请保持此页面打开并重试。"],
      action: "更新密码",
      retry: "重试",
      mismatch: "两次输入的密码不一致。",
      invalidPassword: "请使用 8–64 个字符，并包含大小写英文字母和数字。",
      manual: "请手动切回 INVERT 应用并在那里登录。",
      residual: "已经签发的 access token 可能在正常到期前继续有效。",
    },
  },
};

export function bootAuthCallbackPage({
  windowObject = window,
  documentObject = document,
  fetchImpl = fetch,
} = {}) {
  const purpose = documentObject.body.dataset.authPurpose;
  const locale = documentObject.body.dataset.locale === "zh" ? "zh" : "en";
  if (purpose !== "email" && purpose !== "recovery") return null;

  const callback = readAndClearAuthCallback(windowObject.location, windowObject.history, purpose);
  let tokenHash = callback.ok ? callback.tokenHash : null;
  let active = true;
  let attempt = null;
  let running = false;

  const elements = {
    panel: documentObject.getElementById("auth-panel"),
    title: documentObject.getElementById("auth-title"),
    lead: documentObject.getElementById("auth-lead"),
    confirmAction: documentObject.getElementById("auth-confirm-action"),
    recoveryForm: documentObject.getElementById("auth-recovery-form"),
    password: documentObject.getElementById("auth-password"),
    confirmation: documentObject.getElementById("auth-password-confirmation"),
    validation: documentObject.getElementById("auth-validation"),
    progress: documentObject.getElementById("auth-progress"),
    logoutRetry: documentObject.getElementById("auth-logout-retry"),
    manual: documentObject.getElementById("auth-manual-return"),
    residual: documentObject.getElementById("auth-access-residual"),
  };

  const publishableKey = documentObject
    .querySelector('meta[name="invert-auth-publishable-key"]')
    ?.getAttribute("content") ?? "";
  const client = createAuthProviderClient({
    origin: EXPECTED_SUPABASE_PUBLIC_ORIGIN,
    publishableKey,
  }, { fetchImpl });

  function render(state, validation = null) {
    const section = copy[locale][purpose === "email" ? "confirm" : "recovery"];
    const content = section[state];
    elements.panel.className = `auth-panel auth-state-${state}`;
    elements.title.textContent = content[0];
    elements.lead.textContent = content[1];
    elements.progress.hidden = state !== "working";
    elements.confirmAction.hidden = purpose !== "email" || state !== "ready";
    elements.confirmAction.disabled = state !== "ready";
    elements.recoveryForm.hidden = purpose !== "recovery" || !["ready", "working", "update_retry"].includes(state);
    elements.password.disabled = state === "working" || state === "update_retry";
    elements.confirmation.disabled = state === "working" || state === "update_retry";
    const submit = elements.recoveryForm.querySelector('button[type="submit"]');
    submit.disabled = state === "working";
    submit.textContent = state === "ready" ? section.action : section.retry;
    elements.logoutRetry.hidden = purpose !== "recovery" || state !== "logout_retry";
    elements.validation.hidden = !validation;
    elements.validation.textContent = validation ? section[validation] : "";
    elements.manual.hidden = state !== "success";
    elements.manual.textContent = purpose === "recovery" ? section.manual : copy[locale].recovery.manual;
    elements.residual.hidden = purpose !== "recovery" || state !== "success";
    elements.residual.textContent = purpose === "recovery" ? section.residual : "";
  }

  async function confirmEmail() {
    const dispatchedToken = tokenHash;
    if (!dispatchedToken) {
      render("unavailable");
      return;
    }

    tokenHash = null;
    render("working");
    let session = null;
    try {
      session = await client.verifyEmail(dispatchedToken);
      await client.logoutLocal(session.accessToken);
      session = null;
      if (active) render("success");
    } catch {
      if (!active) return;
      render(session ? "logout_failed" : "restart");
      session = null;
    }
  }

  async function completeRecovery() {
    if (running) return;

    let currentAttempt = attempt;
    let dispatchedToken = null;
    let pendingPassword = "";
    if (!currentAttempt) {
      const password = elements.password.value;
      const confirmation = elements.confirmation.value;
      if (password !== confirmation) {
        render("ready", "mismatch");
        return;
      }
      if (passwordPolicyFailure(password)) {
        render("ready", "invalidPassword");
        return;
      }

      dispatchedToken = tokenHash;
      if (!dispatchedToken) {
        render("unavailable");
        return;
      }
      tokenHash = null;
      pendingPassword = password;
    }

    running = true;
    render("working");
    try {
      if (!currentAttempt) {
        const session = await client.verifyRecovery(dispatchedToken);
        currentAttempt = { session, pendingPassword, passwordUpdated: false };
        attempt = currentAttempt;
      }

      if (!currentAttempt.passwordUpdated) {
        await client.updatePassword(
          currentAttempt.session.accessToken,
          currentAttempt.pendingPassword,
        );
        currentAttempt = { ...currentAttempt, passwordUpdated: true, pendingPassword: "" };
        attempt = currentAttempt;
        elements.password.value = "";
        elements.confirmation.value = "";
      }

      await client.logoutGlobal(currentAttempt.session.accessToken);
      running = false;
      if (attempt === currentAttempt) attempt = null;
      if (active) render("success");
    } catch {
      running = false;
      if (!active) {
        if (attempt === currentAttempt) attempt = null;
        return;
      }
      if (!currentAttempt) {
        attempt = null;
        elements.password.value = "";
        elements.confirmation.value = "";
        render("restart");
      } else {
        render(currentAttempt.passwordUpdated ? "logout_retry" : "update_retry");
      }
    }
  }

  elements.confirmAction.addEventListener("click", () => { void confirmEmail(); });
  elements.recoveryForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void completeRecovery();
  });
  elements.logoutRetry.addEventListener("click", () => { void completeRecovery(); });
  windowObject.addEventListener("pagehide", () => {
    active = false;
    tokenHash = null;
    elements.password.value = "";
    elements.confirmation.value = "";
    if (!running) attempt = null;
  }, { once: true });

  render(callback.ok ? "ready" : "unavailable");
  return { confirmEmail, completeRecovery };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  bootAuthCallbackPage();
}
