# INVERT public-site invariants

Read `DEPLOYMENT_BOUNDARY.md` completely before changing public Website,
authentication callback, download, or release routing.

The production `site/CNAME` is exactly `invertagent.com`. Mandatory public
traffic must never use `auth.invertagent.com`, terminate on `chatgpt.site`, or
depend on OpenAI Sites. The locked callback routes are the apex-domain confirm
and recovery pages listed in `DEPLOYMENT_BOUNDARY.md`.

Keep the verifier fail-closed for this topology. A deployable artifact whose
CNAME or contents violate the boundary must fail before upload.
