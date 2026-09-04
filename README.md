# INVERT public website

This repository contains the static public edition of the INVERT website.
It is intentionally limited to public pages and public machine-readable files.

The publishing artifact excludes Studio, admin, databases, media uploads, API
routes, environment files, and private source code. Public pages use anonymous
Umami analytics; Auth callbacks are explicitly excluded from analytics.

## Hosting

GitHub Pages deploys the contents of `site/` through the included workflow.
The production artifact is rooted at `https://invertagent.com/` and contains
only generated public files.
