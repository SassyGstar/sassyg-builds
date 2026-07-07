# Project context for Claude

## About the owner

Gina (GitHub: SassyGstar) is a beginner, not a developer — explain things in
plain language, avoid jargon, and spell out click paths for anything done on
github.com. She works at OGO Financial Services, a multi-office tax firm in
Florida (offices: Orlando, Clermont, Winter Haven).

## What this repository is

Gina's public portfolio, renamed from `desktop-tutorial` to `sassyg-builds`
(July 2026). It is deployed as a live website via GitHub Pages:

- Live site: https://sassygstar.github.io/sassyg-builds/
- `index.html` — landing page linking to both apps
- `ogo-staff-portal/` — single-file staff portal web app (**demo version**)
- `ogo-tax-academy/` — single-file training app for tax preparers (AFSP prep)
- `.github/workflows/pages.yml` — deploys the whole repo to GitHub Pages on
  every push to `main` (Pages source is set to "GitHub Actions")
- `mpc_network.py`, `network_config.json`, `certs/` — leftovers from an
  earlier experiment, unrelated to the portfolio; safe to delete if asked
- License: MIT (copyright Gina Altidor)

## CRITICAL: privacy rules for this repo

This repo is PUBLIC. The published Staff Portal is a scrubbed demo:

- All staff records are FICTIONAL (the real roster with names, birthdays,
  personal phones/emails was removed before publishing)
- All client records are FICTIONAL (real client names were removed —
  client confidentiality is critical for a tax firm)
- The Firebase config is a PLACEHOLDER (the app runs in offline/local mode);
  the real database key was removed
- The demo admin passcode is `DEMO1234` (public on purpose, shown on the
  landing page)

If Gina uploads a newer build of either app to publish, ALWAYS scan it for
real staff data, client names, passcodes, API keys, and database configs, and
scrub before committing. Never commit real personal data, credentials, or
keys to this repo.

## Workflow conventions

- Work on a feature branch, then merge to `main` via PR (Gina's account
  merges; sessions here have done this on her behalf when she asks)
- Any merge to `main` auto-redeploys the website within ~1 minute
- Owner-only switches (repo visibility, Pages settings, renames) must be done
  by Gina in Settings — walk her through them step by step

## Open items as of July 7, 2026

- Gina was advised to change the admin passcode on her REAL internal staff
  portal (the one not in this repo), since the old one was embedded in files
  that were shared around. Status unknown — worth a gentle reminder if
  relevant.
- Possible next steps she's shown interest in: profile README repo
  (`SassyGstar/SassyGstar`), deleting the leftover experiment files.
