# Deployment boundary

Rebecca approved an emergency public-site cutover on 2026-08-21 after the
previous hosting security layer blocked legitimate mobile visitors.

This repository must not:

- change authentication callbacks, provider settings, redirect allowlists, or
  transactional email templates;
- publish `/auth`, `/api`, `/studio`, `/admin`, secrets, or private source;
- describe the static preview as a completed or verified authentication flow.

Locked AUTH callbacks remain:

- `https://invertagent.com/auth/confirm/`
- `https://invertagent.com/auth/recovery/`
- `invert://auth/return`
