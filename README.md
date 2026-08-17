# INVERT public website

This repository contains the static public edition of the INVERT website.
It is intentionally limited to public pages and public machine-readable files.

The publishing artifact excludes Studio, admin, authentication, databases,
media uploads, API routes, environment files, and private source code.

## Hosting

GitHub Pages deploys the contents of `site/` through the included workflow.
The initial preview is built for `/invertagent-pages/`. Before the custom domain
is switched, regenerate the artifact with `npm run export:production`.
