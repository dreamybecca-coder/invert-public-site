import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_SUPABASE_PUBLIC_ORIGIN } from "../src/auth-callback-runtime.js";

export { EXPECTED_SUPABASE_PUBLIC_ORIGIN };

export const authCallbackRoutes = [
  { route: "/auth/confirm/", locale: "en", purpose: "email" },
  { route: "/auth/recovery/", locale: "en", purpose: "recovery" },
  { route: "/zh/auth/confirm/", locale: "zh", purpose: "email" },
  { route: "/zh/auth/recovery/", locale: "zh", purpose: "recovery" },
];

const runtimeSource = fileURLToPath(
  new URL("../src/auth-callback-runtime.js", import.meta.url),
);

export async function writeAuthCallbackArtifact({
  outputDir,
  basePath = "",
  stylesheetPath,
  publishableKey,
}) {
  validatePublicConfig(publishableKey);
  const runtime = await readFile(runtimeSource, "utf8");
  const runtimeTarget = path.join(outputDir, "assets/auth-callback-runtime.js");
  await mkdir(path.dirname(runtimeTarget), { recursive: true });
  await writeFile(runtimeTarget, runtime);

  for (const callback of authCallbackRoutes) {
    const target = path.join(outputDir, callback.route.slice(1), "index.html");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, makeAuthCallbackPage({
      ...callback,
      basePath,
      stylesheetPath,
      publishableKey,
    }));
  }
}

function validatePublicConfig(publishableKey) {
  if (
    !/^sb_publishable_[A-Za-z0-9._-]+$/.test(publishableKey) ||
    publishableKey.length > 4096 ||
    /service_role|sb_secret_/i.test(publishableKey)
  ) {
    throw new Error("A publishable-only Supabase public key is required for AUTH export.");
  }
}

function makeAuthCallbackPage({
  route,
  locale,
  purpose,
  basePath,
  stylesheetPath,
  publishableKey,
}) {
  const prefix = basePath ? `${basePath}` : "";
  const isChinese = locale === "zh";
  const localePrefix = isChinese ? "/zh" : "";
  const title = purpose === "email"
    ? (isChinese ? "确认邮箱 | INVERT" : "Confirm email | INVERT")
    : (isChinese ? "账号找回 | INVERT" : "Account recovery | INVERT");
  const heading = purpose === "email"
    ? (isChinese ? "确认这个邮箱" : "Confirm this email")
    : (isChinese ? "设置新密码" : "Set a new password");
  const lead = purpose === "email"
    ? (isChinese ? "只在你主动打开此链接时继续。" : "Continue only if you opened this link yourself.")
    : (isChinese ? "只在你主动打开此找回链接时继续。" : "Continue only if you opened this recovery link yourself.");
  const accountEyebrow = purpose === "email"
    ? (isChinese ? "INVERT 账号" : "INVERT Account")
    : (isChinese ? "账号找回" : "Account recovery");
  const password = isChinese ? "新密码" : "New password";
  const confirmation = isChinese ? "再次输入新密码" : "Confirm new password";
  const policy = isChinese
    ? "使用 8–64 个字符，并至少包含一个大写英文字母、一个小写英文字母和一个数字。"
    : "Use 8–64 characters with an uppercase letter, a lowercase letter, and a number.";
  const action = purpose === "email"
    ? (isChinese ? "确认邮箱" : "Confirm email")
    : (isChinese ? "更新密码" : "Update password");
  const retry = isChinese ? "重试" : "Try again";
  const legal = isChinese
    ? { privacy: "隐私", terms: "条款", contact: "联系" }
    : { privacy: "Privacy", terms: "Terms", contact: "Contact" };
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${EXPECTED_SUPABASE_PUBLIC_ORIGIN}`,
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "worker-src 'none'",
  ].join("; ");

  return `<!doctype html>
<html lang="${isChinese ? "zh-CN" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
  <meta name="invert-auth-publishable-key" content="${escapeHtml(publishableKey)}">
  <title>${title}</title>
  <link rel="canonical" href="https://invertagent.com${route}">
  <link rel="stylesheet" href="${prefix}${stylesheetPath}">
</head>
<body data-auth-purpose="${purpose}" data-locale="${locale}">
  <div class="auth-frame">
    <header class="auth-header">
      <a class="brand-lockup" href="${prefix}${localePrefix}/" aria-label="INVERT"><span class="brand-word">INVERT</span></a>
    </header>
    <main class="auth-main">
      <section id="auth-panel" class="auth-panel auth-state-ready" aria-live="polite">
        <p class="eyebrow">${accountEyebrow}</p>
        <h1 id="auth-title">${heading}</h1>
        <p id="auth-lead" class="auth-lead">${lead}</p>
        <div class="auth-form">
          <button id="auth-confirm-action" type="button"${purpose === "email" ? "" : " hidden"}>${action}</button>
        </div>
        <form id="auth-recovery-form" class="auth-form"${purpose === "recovery" ? "" : " hidden"}>
          <label>${password}<input id="auth-password" autocomplete="new-password" name="new-password" spellcheck="false" type="password"></label>
          <label>${confirmation}<input id="auth-password-confirmation" autocomplete="new-password" name="confirm-password" spellcheck="false" type="password"></label>
          <p>${policy}</p>
          <p id="auth-validation" role="alert" hidden></p>
          <button type="submit">${action}</button>
        </form>
        <button id="auth-logout-retry" class="auth-home-link" type="button" hidden>${retry}</button>
        <div id="auth-progress" class="auth-progress" aria-hidden="true" hidden><span></span></div>
        <div class="auth-form"><p id="auth-manual-return" hidden></p><p id="auth-access-residual" hidden></p></div>
        <noscript><p class="auth-lead">${isChinese ? "请启用 JavaScript 或返回 INVERT 重新申请链接。" : "Enable JavaScript or return to INVERT and request a new link."}</p></noscript>
      </section>
    </main>
    <footer class="auth-footer">
      <span>© 2026 INVERT</span>
      <nav aria-label="Legal">
        <a href="${prefix}${localePrefix}/privacy/">${legal.privacy}</a>
        <a href="${prefix}${localePrefix}/terms/">${legal.terms}</a>
        <a href="${prefix}${localePrefix}/contact/">${legal.contact}</a>
      </nav>
    </footer>
  </div>
  <script type="module" src="${prefix}/assets/auth-callback-runtime.js"></script>
</body>
</html>
`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
