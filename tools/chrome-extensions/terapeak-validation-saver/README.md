# Hankuk Terapeak Validation Saver

Chrome MV3 helper for the simplified manual Research/Terapeak path.

## Operator flow

1. Open an eBay Research/Terapeak page in Chrome and sign in normally.
2. Confirm the extension icon shows the green `1` badge, meaning a scrapeable Terapeak query was found on the page.
3. Click the extension.
4. Enter the **Server base URL** and admin key.
5. Search validation records, choose the matching `recordID - Item`, or paste a `rec...` ID directly.
6. Click **Save session + re-run record**.

The extension does two calls against the hosted MCP admin API:

- `POST /admin/playwright-session`
  - Converts the current `ebay.com` cookies + `localStorage` into Playwright storage-state format.
  - Stores the Research browser session in the configured server-side session store.
- `POST /admin/validation/run-record`
  - Triggers only the selected Airtable validation record.
  - Returns a field-transfer confirmation with active/sold/velocity Airtable fields, before/after values, and changed-field count.
  - Includes a visible-page Terapeak snapshot under `providerOptions.manualTerapeakSnapshot` for downstream use/debugging.
- `GET /admin/validation/records`
  - Loads the searchable selector list shown as `recordID - Item`.

## Install locally

1. Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked**
4. Select this directory:

```text
tools/chrome-extensions/terapeak-validation-saver
```

## Notes

- The admin API key is stored only in local Chrome extension storage.
- This does not bundle or hardcode secrets.
- Current backend support already stores session state and can re-run a single validation record. The manual Terapeak snapshot is forwarded through `providerOptions`; if the n8n/Airtable side wants to write those scraped fields directly, wire that payload there instead of requiring another browser-copy workflow.
