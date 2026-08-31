# OGO Staff Portal — Transition Baseline & Netlify Sync Contract

**Status:** Locked transition baseline for the production rebuild  
**Baseline source:** `index (4).html` supplied 2026-08-31  
**Patched artifact:** `OGO_Portal_Transition_Baseline.html`  
**SHA-256:** `39f4472ebbbd709672a9ec8d9ebac83c637db72dfeb385781b6fb1fe1bcac3af`  
**Bytes:** `290,755`  
**Lines:** `2,127`  

## 1. Why this baseline is locked

This file is the frontend behavior specification for the production rebuild. The SQL/ASP.NET version must preserve the user-visible behavior that is working here (dashboard, time clock, PTO, requests, Client Workflow, handoffs, inbox, reports, mobile layout) unless a later product decision explicitly changes it.

The production rebuild is **not** a redesign-from-scratch. We replace the trust, storage, synchronization, and authorization layers underneath this UI.

## 2. Interim patch applied

The baseline contained a multi-office time-clock sync hole: `handleClock()` stored `S.tc.activeOffice[k]`, but `fbSavePunch(k)` wrote only `tc/active/<employee>` and `tc/entries/<employee>`.

The patched baseline now also writes:

```javascript
fbRef.child('tc/activeOffice/'+k).set(actOffice);
```

This keeps the physical OGO office used for an open shift synchronized across reloads/devices during the Firebase transition period.

JavaScript syntax validation passed after the patch.

## 3. Netlify stays the frontend host

### Production topology

```text
Employee browser
    |
    | HTTPS
    v
portal.ogofin.com                 Netlify
    |
    | HTTPS API + SignalR
    v
api.ogofin.com                    ASP.NET Core 10
    |
    | private network only
    v
SQL Server 2025                   source of truth
    |
    +--> private object storage   documents/photos
```

### Hard rules

1. **Netlify serves frontend assets only.** It never connects directly to SQL Server.
2. **The browser never receives a SQL connection string, database password, signing key, storage secret, or service credential.**
3. The only public runtime configuration in the frontend is non-secret configuration such as `API_BASE_URL` and SignalR hub URL.
4. The final SQL build removes the Firebase browser SDK and all direct `firebase.database(...)` calls.
5. Production frontend talks only to the production API; deploy previews/branches talk only to staging API/database.
6. `main` remains the live/stable branch until cutover is explicitly approved.

## 4. Environment separation

| Netlify context | Frontend | API | Database |
|---|---|---|---|
| Production (`main`) | `portal.ogofin.com` | `https://api.ogofin.com` | OGO Production SQL |
| Deploy Preview / rebuild branch | Netlify preview URL | `https://api-staging.ogofin.com` | OGO Staging SQL |
| Local developer | localhost | localhost / dev API | Local/dev SQL |

A preview build must never point to the production SQL database.

## 5. Real-time synchronization contract

SQL Server is the **only source of truth**. SignalR makes changes appear immediately, but it is not the database.

Every mutation follows this order:

```text
Browser action
  -> ASP.NET authorization
  -> validate business rule
  -> SQL transaction
  -> COMMIT
  -> AuditLog
  -> SignalR event
  -> other open portals refetch changed record
```

### Reconnect behavior

When SignalR reconnects, the browser does not assume it saw every event. It requests fresh state (or changes since its last server sequence/version) from the API. This makes dropped Wi-Fi a recoverable display problem rather than a data-loss event.

### Concurrency behavior

Mutable records expose SQL `rowversion` as an HTTP `ETag`.

- Browser reads record + ETag.
- Browser sends `If-Match` when saving.
- If another employee changed the row first, API returns `412 Precondition Failed`.
- UI tells the employee the record changed and reloads it instead of silently overwriting the other employee.

### Transactional workflows

The following must commit atomically:

- Accept client handoff + close old assignment + create new assignment + audit event.
- Clock-out + completed time entry + audit event.
- PTO approval/denial + balance/effect + audit event.
- Payroll lock/reopen/correction + audit event.

## 6. Handoff synchronization contract

A handoff is an offer until accepted.

1. Sender initiates handoff.
2. SQL stores `Pending`; current assignment stays unchanged.
3. Intended receiver is notified.
4. Receiver accepts or declines.
5. On accept, one SQL transaction closes the old assignment and opens the new assignment.
6. SignalR informs sender/receiver and any authorized manager views.
7. If two actors race, only one transaction can succeed; the loser receives `409 Conflict`.

The browser may never change `assignedTo` by itself to complete a handoff.

## 7. Time-clock synchronization contract

The interim Firebase patch preserves `activeOffice`, but the production API replaces browser-trusted punches entirely.

Production rules:

- Clock-in/out timestamps are server-generated.
- One employee can have at most one open shift.
- Completed punches are append-only.
- Corrections are separate records; original punch remains visible.
- Locked pay periods reject ordinary edits.
- Location submitted by the browser is evidence; server enforces the configured office/geofence rule.
- Open-shift auto-close is a server background job, not a browser timer.

## 8. Authentication contract

The current local PIN/admin-password model is transition-only.

Production uses ASP.NET Core Identity/session cookies. Client Workflow uses the same session as the rest of the portal. There is no second email/password prompt.

Permissions are enforced server-side. UI visibility is convenience only.

## 9. Cutover rule

Do not point the live Netlify portal at the SQL API until all of these pass:

- identity and role tests;
- three-office concurrent action tests;
- handoff race tests;
- time-clock concurrency tests;
- staging migration reconciliation;
- object-storage upload/download tests;
- SignalR disconnect/reconnect tests;
- backup restore test;
- user acceptance testing.

Until then, this patched baseline remains the transition reference and the current live portal remains isolated from the rebuild branch.
