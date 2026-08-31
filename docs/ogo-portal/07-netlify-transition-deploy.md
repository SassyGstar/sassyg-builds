# OGO Staff Portal — Verified Netlify Transition Deploy

**Target site:** `ogodashboard1`  
**Target site ID:** `aed9ec10-e7fd-4dbd-9159-58f891ca01b1`  
**Verified frontend SHA-256:** `39f4472ebbbd709672a9ec8d9ebac83c637db72dfeb385781b6fb1fe1bcac3af`

## Verified source

The transition package `index.html` and the standalone transition baseline available in the working session are byte-identical and both contain:

```javascript
fbRef.child('tc/activeOffice/'+k).set(actOffice);
```

JavaScript syntax validation passes.

The production deploy artifact should contain **only**:

```text
index.html
```

Do not deploy the architecture markdown documents to the public staff portal.

## Current Netlify deployment mode

The Netlify project currently reports:

- production context;
- `manual_deploy: true`;
- `deploy_source: drop`;
- no Git `commit_ref`;
- one generated page: `index.html`.

Therefore the transition site is still a manual-drop site, not a Git-connected production pipeline.

## Deployment safety rule

Only publish an artifact whose `index.html` hashes to:

```text
39f4472ebbbd709672a9ec8d9ebac83c637db72dfeb385781b6fb1fe1bcac3af
```

Immediately after deployment verify:

1. site loads;
2. employee login screen renders;
3. Client Workflow and Handoffs tab render;
4. a test clock-in records active office on a second session/device;
5. no architecture `.md` files are publicly deployed;
6. Netlify reports the new deploy `ready`.

## Future state

This manual-drop process is transition-only. The SQL rebuild remains isolated from the live site until the cutover gates in `04-netlify-sync-contract.md` pass. The eventual production frontend should have a controlled Git/CI deployment with staging previews separated from production API/SQL.
