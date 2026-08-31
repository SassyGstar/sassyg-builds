# OGO Staff Portal — Production Build Blueprints

The production rebuild is now anchored to the **current transition portal behavior**, not only the older Deploy 17 demo/reference build. Blueprint before concrete.

| # | Document | What it settles |
|---|---|---|
| 1 | [Database blueprint](01-database-blueprint.md) | Every table, constraint and index for SQL Server 2025 Standard, plus the handoff transaction |
| 2 | [API blueprint](02-api-blueprint.md) | Every endpoint, its permission, error contract, authentication model and concurrency rules |
| 3 | [Deploy 17 migration map](03-deploy17-migration-map.md) | Original field-by-field migration analysis; useful history but partly superseded by the current transition baseline |
| 4 | [Netlify & sync contract](04-netlify-sync-contract.md) | Locks Netlify as the frontend host, SQL as source of truth, SignalR/reconnect behavior, environment separation and cutover gates |
| 5 | [Current frontend → API map](05-current-frontend-api-map.md) | Maps the current portal's Firebase-backed mutating functions to the exact server-owned API responsibilities that replace them |

## Current transition baseline

The current frontend behavior specification is the portal supplied on **2026-08-31** and patched only to close the `activeOffice` time-clock synchronization hole.

- Baseline SHA-256: `39f4472ebbbd709672a9ec8d9ebac83c637db72dfeb385781b6fb1fe1bcac3af`
- The patch makes `fbSavePunch(k)` write `tc/activeOffice/<employee>` along with the employee's active shift and entries.
- JavaScript syntax validation passes after the patch.
- A lightweight hash/pointer is kept in [`baseline/OGO_Portal_Transition_Baseline.html`](baseline/OGO_Portal_Transition_Baseline.html).
- ⚠️ **The full baseline must never be committed here.** It carries real staff PII and live
  Firebase configuration, and this repository is public via GitHub Pages. The pointer holds
  the hash only — verify any working copy against it before treating it as the baseline.

This transition baseline preserves the working UI and behavior: dashboard, multi-office time clock, PTO, requests, Client Workflow, handoffs with accept/decline, inbox, events, reports, resources and mobile layout.

## How the documents interlock

They are meant to be checked against each other, not read in isolation:

- Every table in **(1)** needs endpoint coverage in **(2)** and a migration disposition in **(3)/(5)**.
- Every SQL concurrency constraint in **(1)** has an HTTP behavior in **(2)**.
- Every current Firebase write identified in **(5)** must disappear from the final frontend and be replaced by an authenticated API operation.
- **(4)** is the deployment/synchronization contract: Netlify serves the UI, ASP.NET owns business rules, SQL Server is authoritative, and SignalR is an after-commit notification mechanism—not the database.
- The newer native handoff workflow is now explicitly treated as behavior to preserve, not a missing feature to invent.

## The two questions

Every design decision is tested against two rules:

> **"What happens if two employees do this at the exact same time?"**
> **"Can we prove who did it?"**

The first is answered with record-scoped writes, SQL constraints/transactions and optimistic concurrency. The second is answered through domain history, `AuditLog`, server identity and server timestamps.

## Netlify rule

`main` remains the live/stable branch until cutover is explicitly approved. Production-architecture work stays isolated on this branch.

The target topology is:

```text
Netlify frontend -> ASP.NET Core 10 API + SignalR -> SQL Server 2025
                                                   -> private object storage
```

Deploy previews/rebuild branches must point only to staging API + staging SQL. The browser never receives SQL credentials or other server secrets.

## Migration note

The older Deploy 17 migration map remains useful for discovering legacy constants and data-shape issues, but it is no longer the sole description of production behavior. The current transition baseline has native Client Workflow handoffs and improved per-employee time-clock writes. Documents **(4)** and **(5)** are the current bridge between that frontend and the SQL/API architecture.

## Scope

These are production design and transition documents. The live Netlify portal is not switched to SQL until authentication, concurrency, migration reconciliation, SignalR reconnect, object storage, backup/restore and user-acceptance gates pass.
