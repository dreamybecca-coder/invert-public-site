# Deployment boundary

The GitHub Pages edition is a public-site preview only until Rebecca and the
AUTH Group 3 control plane approve a production cutover.

Until that approval, this repository must not:

- bind `invertagent.com` or `www.invertagent.com` to GitHub Pages;
- replace or disable the dynamic website serving `/auth/confirm/` and
  `/auth/recovery/`;
- change authentication callbacks, provider settings, redirect allowlists, or
  transactional email templates;
- publish `/auth`, `/api`, `/studio`, `/admin`, secrets, or private source;
- describe the static preview as a completed or verified authentication flow.

Locked AUTH callbacks remain:

- `https://invertagent.com/auth/confirm/`
- `https://invertagent.com/auth/recovery/`
- `invert://auth/return`
