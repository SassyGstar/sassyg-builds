# OGO Staff Portal — Production Build Blueprints

The first deliverable of the production rebuild: **database blueprint + API blueprint +
Deploy 17 migration map**. Blueprint before concrete.

| # | Document | What it settles |
|---|---|---|
| 1 | [Database blueprint](01-database-blueprint.md) | Every table, constraint and index for SQL Server 2025 Standard, plus the handoff transaction |
| 2 | [API blueprint](02-api-blueprint.md) | Every endpoint, its permission, its error contract, and the concurrency test suite |
| 3 | [Deploy 17 migration map](03-deploy17-migration-map.md) | Field-by-field mapping from the live portal, with the gaps named |

## How the three interlock

They are meant to be checked against each other, not read in isolation:

- Every table in **(1)** has endpoint coverage in **(2)** §3.2 and §8, and a migration
  disposition in **(3)** §4.
- Every SQL `THROW` and unique index in **(1)** has an HTTP status in **(2)** §2.4.
- Every permission in **(1)** §4.1 maps to endpoints in **(2)** §3.2.
- Every reconciliation view in **(1)** §13 is used by a gate in **(3)** §9.

## The two questions

Every design decision was tested against the rule from the build plan:

> **"What happens if two employees do this at the exact same time?"**
> **"Can we prove who did it?"**

The first is answered by three filtered unique indexes that make the dangerous races
impossible at the storage layer — not merely unlikely in application code
([1](01-database-blueprint.md) §0). The second by three layers doing different jobs:
temporal tables (*what* changed), `AuditLog` (*who* and *why*), and append-only domain
ledgers (the business narrative).

## Read this first

Two findings in **(3)** change the build plan and need an answer before Phase 0 closes:

1. **Deploy 17 has no handoff feature.** Zero matches for `handoff`, `transfer` or
   `reassign` across all 1,453 lines. The handoff engine is new construction, not a port,
   and the "9 handoffs must reconcile" gate has no source table
   ([3](03-deploy17-migration-map.md) §5).
2. **Roles, PTO classes, geofences and pay periods live in JavaScript constants, not in
   Firebase.** They are absent from any data export. Freezing Deploy 17 must freeze the
   *file*, not just the data ([3](03-deploy17-migration-map.md) §3.1).

The full blocker list is [3](03-deploy17-migration-map.md) §11; open design decisions for
OGO are [1](01-database-blueprint.md) §14.

## Scope

These are design documents. No code is being replaced yet — Deploy 17
(`ogo-staff-portal/index.html`) remains the running portal and the design foundation.
