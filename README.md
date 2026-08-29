# TokenUsage

Track AI token usage across **OpenCode**, **Cursor**, and **Google Gemini / AI Studio**, then publish a dashboard on GitHub Pages.

**Tracking window:** `2026-08-28` onward (aggregates only — no prompts).

**Live site:** https://koundinyapidaparthydev.github.io/TokenUsage/

## Quick start

```bash
cd TokenUsage
cp .env.example .env   # add keys locally — never commit .env
npm run sync           # collect → write data/*.json
npm run sync:push      # collect → commit data → push (updates the site)
```

## Daily automation (macOS)

```bash
./scripts/install-launchd.sh
```

Logs: `~/Library/Logs/tokenusage-sync.log`

## Sources

| Source | How it is collected | What you need |
|--------|---------------------|---------------|
| OpenCode | Local SQLite `~/.local/share/opencode/opencode.db` | Nothing |
| Cursor | Dashboard session cookie (`CURSOR_SESSION_TOKEN`) | `WorkosCursorSessionToken` from cursor.com |
| Gemini / AI Studio | GCP Cloud Monitoring | `GOOGLE_APPLICATION_CREDENTIALS` + `GCP_PROJECT_ID` |

OpenCode sessions are attributed under `opencode` only. The heatmap starts at the tracking start date and keeps the rest of the year as empty upcoming slots (no blank year of history).

## Secrets

See [`.env.example`](.env.example). Keep keys on your machine only.
