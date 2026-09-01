# Deployment boundary

Rebecca approved an emergency public-site cutover on 2026-08-21 after the
previous hosting security layer blocked legitimate mobile visitors.

Rebecca approved a bounded GitHub Pages AUTH callback amendment and accepted
the platform's HTTP-header residual risk on 2026-09-01. The public artifact may
now contain only these callback documents:

- `/auth/confirm/`
- `/auth/recovery/`
- `/zh/auth/confirm/`
- `/zh/auth/recovery/`

They may contain only the reviewed fragment-only browser runtime, the exact
Supabase public project origin, and a build-time `sb_publishable_*` public key.
They must include meta referrer `no-referrer`, robots `noindex`, and the narrow
meta CSP enforced by the exporter and verifier.

Committed callback HTML is a deliberately non-deployable source fixture. Every
GitHub Pages upload path must first regenerate the four callback documents from
the approved environment-scoped public key and then run strict verification.
Missing, mismatched, synthetic, fixture, test, or placeholder public config must
fail before `upload-pages-artifact`; `verify:source` is review-only evidence and
must never be used as a deployment gate.

This repository must not:

- change provider settings, redirect allowlists, or transactional email
  templates;
- publish any other `/auth` path, `/api`, `/studio`, `/admin`, secrets,
  service-role material, or private Website source;
- describe the static preview as a completed or verified authentication flow.

GitHub Pages cannot provide per-route HTTP `Cache-Control: no-store, private`,
HTTP CSP `frame-ancestors`, `X-Content-Type-Options: nosniff`, COOP/CORP, or
Permissions-Policy. Meta CSP does not implement `frame-ancestors` and must not
be reported as a substitute for any of those HTTP response controls. This
residual is accepted for the bounded callback artifact only; it is not a
general relaxation for Studio, admin, API, private source, or another provider.

Every mandatory public Website, AUTH, or release entry must remain reachable
without CNAME or request termination on `chatgpt.site` or OpenAI Sites. A 200
from one executor network is deployment evidence only, not first-user-network
E3.

Locked AUTH callbacks remain:

- `https://invertagent.com/auth/confirm/`
- `https://invertagent.com/auth/recovery/`
- `invert://auth/return`
