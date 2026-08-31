# OGO Staff Portal — Production Build Blueprints

The production rebuild is now anchored to the **current transition portal behavior**, not only the older Deploy 17 demo/reference build. Blueprint before concrete.

| # | Document | What it settles |
|---|---|---|
| 1 | [Database blueprint](01-database-blueprint.md) | Core SQL Server 2025 organization, identity, payroll, audit and persistence design |
| 2 | [API blueprint](02-api-blueprint.md) | Endpoint, permission, error, authentication and concurrency conventions |
| 3 | [Deploy 17 migration map](03-deploy17-migration-map.md) | Original field-by-field migration analysis; useful history but partly superseded by the current transition baseline |
| 4 | [Netlify & sync contract](04-netlify-sync-contract.md) | Locks Netlify as the frontend host, SQL as source of truth, SignalR/reconnect behavior, environment separation and cutover gates |
| 5 | [Current frontend → API map](05-current-frontend-api-map.md) | Maps current Firebase-backed actions to server-owned API responsibilities |
| 6 | [Client Workflow redesign](06-client-workflow-redesign.md) | **Authoritative Phase 5 workflow model:** ClientWorkItems, independent preparation/IRS tracks, work-item assignments, history and work-item-scoped handoffs |

## Current transition baseline

The current frontend behavior specification is the portal supplied on **2026-08-31** and patched only to close the `activeOffice` time-clock synchronization hole.

- Baseline SHA-256: `39f4472ebbbd709672a9ec8d9ebac83c637db72dfeb385781b6fb1fe1bcac3af`
- The patch makes `fbSavePunch(k)` write `tc/activeOffice/<employee>` along with the employee's active shift and entries.
- JavaScript syntax validation passes after the patch.
- A lightweight hash/pointer is kept in [`baseline/OGO_Portal_Transition_Baseline.html`](baseline/OGO_Portal_Transition_Baseline.html).
- ⚠️ **The full baseline must never be committed here.** It carries real staff PII and live Firebase configuration, and this repository is public via GitHub Pages. The pointer holds the hash only — verify any working copy against it before treating it as the baseline.

This transition baseline preserves the working UI and behavior: dashboard, multi-office time clock, PTO, requests, Client Workflow, handoffs with accept/decline, inbox, events, reports, resources and mobile layout.

## Important workflow correction

`01-database-blueprint.md` originally modeled workflow as one `ClientWorkflowStatus` row with one `WorkflowStageId`. That model is **superseded** for Phase 5.

The production portal actually tracks one tax **work item** with parallel facts: tax year, return type, preparation status, IRS status, reviewer, owner, milestones, dates, communication method, next action and follow-up. A single stage enum cannot represent that safely.

**For all workflow implementation decisions, `06-client-workflow-redesign.md` wins over the older single-stage sections of documents 1–3.** In particular:

- do not scaffold the old `WorkflowStages` + `ClientWorkflowStatus(WorkflowStageId)` model;
- handoffs transfer a `ClientWorkItemId`, not every matter belonging to a `ClientId`;
- Owner and Reviewer are work-item assignment ledgers, not name strings;
- preparation status and IRS status have independent history tracks;
- a combined headline status is derived for display only.

## How the documents interlock

They are meant to be checked against each other, not read in isolation:

- **(6)** is authoritative for Phase 5 workflow entities and work-item-scoped handoffs.
- The unaffected core tables and platform conventions in **(1)** remain authoritative.
- API/auth/concurrency conventions in **(2)** remain authoritative; workflow resource names are corrected by **(6)** and **(5)**.
- Every current Firebase write identified in **(5)** must disappear from the final frontend and be replaced by an authenticated record-scoped API operation.
- **(4)** is the deployment/synchronization contract: Netlify serves the UI, ASP.NET owns business rules, SQL Server is authoritative, and SignalR is an after-commit notification mechanism—not the database.
- The newer native handoff workflow is behavior to preserve, not a missing feature to invent.

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

The older Deploy 17 migration map remains useful for discovering legacy constants and data-shape issues, but it is no longer the sole description of production behavior. The current transition baseline has native Client Workflow handoffs and improved per-employee time-clock writes. Documents **(4)**, **(5)** and **(6)** are the current bridge between that frontend and the SQL/API architecture.

## Scope

These are production design and transition documents. The live Netlify portal is not switched to SQL until authentication, concurrency, migration reconciliation, SignalR reconnect, object storage, backup/restore and user-acceptance gates pass.
