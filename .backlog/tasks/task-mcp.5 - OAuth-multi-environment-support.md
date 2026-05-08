---
id: TASK-MCP.5
title: OAuth multi-environment support for ebay_get_oauth_url
status: Done
assignee:
  - '@Bruno'
created_date: '2026-05-05'
updated_date: '2026-05-05'
labels: [bug, medium]
dependencies: []
parent_task_id: null
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`ebay_get_oauth_url` fails with "EBAY_CLIENT_ID environment variable missing". Per Naji review: credentials are NOT missing — both PRODUCTION and SANDBOX credential sets exist in `.env.shared`. The tool needs to read environment-specific variants:

- `EBAY_CLIENT_ID_PRODUCTION` / `EBAY_CLIENT_ID_SANDBOX`
- `EBAY_CLIENT_SECRET_PRODUCTION` / `EBAY_CLIENT_SECRET_SANDBOX`
- `EBAY_REDIRECT_URI_PRODUCTION` / `EBAY_REDIRECT_URI_SANDBOX`

Instead of the hardcoded single `EBAY_CLIENT_ID`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- `ebay_get_oauth_url` reads credentials from PRODUCTION and SANDBOX env var variants
- Tool works in both sandbox and production environments
- Graceful fallback to single-env vars for backward compatibility
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
Medium
<!-- SECTION:PRIORITY:END -->
