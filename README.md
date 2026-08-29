# TokenUsage

Track AI token usage across **Cursor**, **OpenCode**, **OpenRouter**, **Google Gemini / AI Studio**, and **Mistral**, then publish a dashboard on GitHub Pages.

**Tracking window:** `2026-08-28` onward (aggregates only — no prompts).

**Live site (after Pages is enabled):** https://koundinyapidaparthydev.github.io/TokenUsage/

## Quick start

```bash
cd TokenUsage
cp .env.example .env   # add keys locally — never commit .env
npm run sync           # collect → write data/*.json
npm run sync:push      # collect → commit data → push (updates the site)
```

## Daily automation (macOS)

Install the LaunchAgent (runs ~09:00 local every day):

```bash
./scripts/install-launchd.sh
```

Logs: `~/Library/Logs/tokenusage-sync.log`

## Sources

| Source | How it is collected | What you need |
|--------|---------------------|---------------|
| OpenCode | Local SQLite `~/.local/share/opencode/opencode.db` | Nothing |
| Cursor | CSV export dropped into `data/imports/cursor/` | Dashboard → Usage → Export CSV |
| OpenRouter | Credits + analytics APIs | `OPENROUTER_API_KEY` (management key preferred) |
| Mistral | Admin usage API | `MISTRAL_ADMIN_API_KEY` |
| Gemini / AI Studio | GCP Cloud Monitoring | `GOOGLE_APPLICATION_CREDENTIALS` + `GCP_PROJECT_ID` |

**Important:** A Gemini API key alone cannot read historical usage. Use a GCP service account with **Monitoring Viewer** on the AI Studio project. Rotate any key that was pasted into chat or screenshots.

OpenCode sessions are attributed under `opencode` only (even if the model is Gemini/OpenRouter), so direct provider APIs do not double-count those sessions.

## Cursor CSV

1. Open [Cursor Dashboard → Usage](https://cursor.com/dashboard?tab=usage)
2. Export CSV
3. Save into `data/imports/cursor/` (filename can be anything ending in `.csv`)
4. Run `npm run sync` (CSV files themselves are gitignored; aggregates are committed)

## Secrets

See [`.env.example`](.env.example). Keep keys on your machine only. This repo is public and stores aggregated JSON.

## Layout

- `collectors/` — one module per provider
- `scripts/sync.mjs` — daily orchestrator
- `data/daily/` — per-day snapshots
- `data/summary.json` — site payload
- `site/` — GitHub Pages UI
