# OGO Staff Portal — API Blueprint

**Status:** Draft 1 for review · **Target:** ASP.NET Core 10 (.NET 10 LTS) on Ubuntu 24.04
**Companion documents:** [`01-database-blueprint.md`](01-database-blueprint.md) · [`03-deploy17-migration-map.md`](03-deploy17-migration-map.md)

---

## 1. The rule this API is built on

> **The server decides. The browser asks.**

Deploy 17 inverted this: the browser held the state, decided the time, checked the
permissions, and wrote the whole document back. Every endpoint below exists to move one
of those decisions from the client to the server.

Three consequences run through the whole design:

1. **No endpoint trusts a client-supplied timestamp** for anything payroll touches. The
   clock-in DTO has no time field, so there is nothing to forge.
2. **No endpoint trusts a client-supplied identity.** `EmployeeId` comes from the
   session cookie, never the request body. An endpoint that accepted
   `{ "employeeId": 4 }` from the browser would be a privilege-escalation bug.
3. **Hiding a button is not authorization.** Every endpoint declares a permission and
   the middleware enforces it before the handler runs. The UI hides buttons purely as a
   courtesy.

---

## 2. Shape

### 2.1 Project layout

```
src/
  Ogo.Portal.Api/            ASP.NET Core 10 — controllers, middleware, DI, Program.cs
  Ogo.Portal.Application/    Use-case handlers, DTOs, validators, permission policies
  Ogo.Portal.Domain/         Entities, enums, domain rules (no EF, no HTTP)
  Ogo.Portal.Infrastructure/ EF Core 10 DbContext, repositories, storage, email
  Ogo.Portal.Migrations/     EF migrations + idempotent seed
  Ogo.Portal.Web/            The portal front end (Deploy 17's UI, re-pointed at the API)
tests/
  Ogo.Portal.UnitTests/
  Ogo.Portal.IntegrationTests/   Testcontainers → real SQL Server 2025
  Ogo.Portal.ConcurrencyTests/   The §11 collision suite
```

`Domain` references nothing. `Application` references `Domain`. `Infrastructure` and
`Api` reference both. This is what keeps the handoff rules testable without a web server.

### 2.2 Conventions

| Concern | Decision |
|---|---|
| **Base path** | `/api/v1` — versioned from day one |
| **IDs in URLs** | `PublicId` (GUID), never `int`. Row counts stay private and IDs stay unguessable |
| **Casing** | `camelCase` JSON, `PascalCase` C# — `JsonSerializerOptions.PropertyNamingPolicy` |
| **Dates over the wire** | ISO-8601 with offset (`2026-08-31T13:32:04.123Z`). UTC always; the client formats to office-local |
| **Errors** | RFC 9457 `application/problem+json` on every non-2xx |
| **Concurrency** | `If-Match` with the entity's `RowVersion` as `ETag`; mismatch → `412` |
| **Idempotency** | `Idempotency-Key` header required on POSTs that create money/payroll/handoff effects |
| **Paging** | `?page=1&pageSize=50`, `pageSize` capped at 200. Envelope `{ items, page, pageSize, totalCount }` |
| **Validation** | FluentValidation; failures → `400` with per-field `errors` |
| **Correlation** | `X-Correlation-Id` in, echoed out, written to every `AuditLog` row from that request |

### 2.3 Error envelope

```json
{
  "type": "https://portal.ogofin.com/errors/handoff-not-pending",
  "title": "Handoff is no longer pending",
  "status": 409,
  "detail": "This client was already transferred by another user at 1:32 PM.",
  "instance": "/api/v1/handoffs/8f2c.../accept",
  "correlationId": "7b1e9d44-...",
  "errors": {}
}
```

`detail` is written for the person on the screen, not the developer. "Frances got there
first" is a better message than "optimistic concurrency failure", and it is what the
front end shows verbatim.

### 2.4 SQL error → HTTP status

The database throws; one middleware translates. This mapping is the contract between the
two blueprints:

| SQL condition | HTTP | Meaning |
|---|---|---|
| `THROW 50403` | `403` | Not yours |
| `THROW 50404` | `404` | Not found |
| `THROW 50409` | `409` | State changed underneath you |
| `THROW 50410` | `410` | Expired |
| `THROW 50423` | `423 Locked` | Pay period is locked |
| `THROW 50451` | `500` | Append-only violation — a bug, alert on it |
| Error `2601`/`2627` on `UX_ClientAssignments_OneActive` | `409` | Someone else accepted first |
| Error `2601`/`2627` on `UX_TimeEntries_OneOpen` | `409` | Already clocked in |
| Error `2601`/`2627` on `UX_ClientHandoffs_OnePending` | `409` | A handoff is already pending |
| Error `1205` (deadlock) | retry ×3, then `409` | |
| `DbUpdateConcurrencyException` | `412` | Stale `If-Match` |

---

## 3. Authorization model

### 3.1 How a request is authorized

```
Cookie ──▶ Authenticated?          no ──▶ 401
   │ yes
   ▼
Employee active & not terminated?  no ──▶ 401 + session revoked
   │ yes
   ▼
Has required permission?           no ──▶ 403 + SecurityEvent
   │ yes
   ▼
Scope check: Own / Office / All    no ──▶ 404  ← not 403
   │ yes
   ▼
Handler runs
```

**Scope failures return `404`, not `403`,** on client-scoped resources. `403` on a
specific client ID confirms that client exists — that is an information leak to a staff
member probing other offices' books. Not found is not found.

### 3.2 Permission catalog → endpoint map

Permissions are exactly the seed set in database blueprint §4.1. Every endpoint declares
one:

| Permission | Endpoints |
|---|---|
| `Client.ViewAssigned` | `GET /clients` (own), `GET /clients/{id}` (own) |
| `Client.ViewOffice` | `GET /clients?scope=office` |
| `Client.ViewAll` | `GET /clients?scope=all` |
| `Client.Create` | `POST /clients` |
| `Client.EditAssigned` | `PUT /clients/{id}`, `POST /clients/{id}/notes`, `PUT /clients/{id}/workflow` |
| `Client.Archive` | `POST /clients/{id}/archive` |
| `Handoff.Send` | `POST /handoffs` |
| `Handoff.Accept` | `POST /handoffs/{id}/accept`, `/decline` |
| `Handoff.ViewOffice` | `GET /handoffs?scope=office` |
| `Handoff.ForceReassign` | `POST /clients/{id}/reassign` |
| `TimeClock.Own` | `POST /timeclock/clock-in`, `/clock-out`, `GET /timeclock/me` |
| `TimeClock.Review` | `GET /timeclock/entries`, `GET /timeclock/employees/{id}` |
| `TimeClock.Correct` | `POST /timeclock/entries/{id}/corrections`, `POST /timeclock/entries` |
| `PTO.Request` | `POST /requests` |
| `PTO.Approve` | `POST /requests/{id}/approve`, `/deny` |
| `PTO.AdjustBalance` | `POST /pto/{employeeId}/adjustments` |
| `Payroll.View` | `GET /payroll/periods`, `GET /payroll/periods/{id}/summary` |
| `Payroll.Lock` | `POST /payroll/periods/{id}/lock`, `/reopen` |
| `Payroll.Adjust` | `POST /payroll/periods/{id}/adjustments` |
| `Employee.ViewDirectory` | `GET /employees` |
| `Employee.Manage` | `POST /employees`, `PUT /employees/{id}`, role grants |
| `Employee.Terminate` | `POST /employees/{id}/terminate` |
| `Reports.Office` / `Reports.All` | `GET /reports/*` |
| `Document.ViewClient` | `GET /documents/{id}/download-url` |
| `Document.Upload` | `POST /documents/upload-url`, `POST /documents` |
| `Document.Delete` | `DELETE /documents/{id}` |
| `Permissions.Manage` | `POST /admin/roles/*`, `/permissions/*` |
| `System.Manage` | `GET/PUT /admin/settings` |
| `Audit.View` | `GET /audit`, `GET /audit/entities/{type}/{id}` |

### 3.3 Implementation

Permissions become claims at sign-in and are re-checked against the database on a
**60-second cache**, so a revoked permission takes effect within a minute rather than at
next login.

```csharp
[HttpPost("{publicId:guid}/accept")]
[RequirePermission(Permissions.HandoffAccept)]
public async Task<IActionResult> Accept(Guid publicId, [FromBody] AcceptHandoffRequest body, CancellationToken ct)
```

```csharp
// Deny beats Grant. Evaluated once per request from cached claims.
public bool HasPermission(string code, int? officeId = null)
{
    if (_overrides.Any(o => o.Code == code && o.Effect == Effect.Deny && o.IsInEffect))
        return false;
    if (_overrides.Any(o => o.Code == code && o.Effect == Effect.Grant && o.IsInEffect))
        return true;
    return _rolePermissions.Contains(code) && IsInScope(code, officeId);
}
```

---

## 4. Authentication and sessions

Build plan §10 and §13. ASP.NET Core Identity with cookie authentication — **not** JWT
in `localStorage`, which is exactly the shared-computer weakness the audit flagged.

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/v1/auth/login` | anonymous | Email + password. Writes `LoginHistory` on **every** outcome |
| `POST /api/v1/auth/mfa/verify` | partial | TOTP; required for Admin, optional then mandatory for all |
| `POST /api/v1/auth/logout` | authenticated | Revokes the session server-side |
| `POST /api/v1/auth/forgot-password` | anonymous | Always `202`, regardless of whether the email exists |
| `POST /api/v1/auth/reset-password` | anonymous + token | Single-use, 1-hour token |
| `POST /api/v1/auth/change-password` | authenticated | Requires current password; revokes all other sessions |
| `GET  /api/v1/auth/me` | authenticated | Employee, office, roles, **permission list**, session expiry |
| `POST /api/v1/auth/heartbeat` | authenticated | Extends idle window; returns remaining seconds |
| `GET  /api/v1/auth/sessions` | authenticated | Active sessions with IP/device |
| `DELETE /api/v1/auth/sessions/{id}` | authenticated | "Log out that other device" |

**Cookie settings — all four matter:**

```csharp
options.Cookie.HttpOnly = true;        // JavaScript cannot read it → XSS can't steal the session
options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
options.Cookie.SameSite = SameSiteMode.Lax;
options.Cookie.Name = "__Host-ogo.session";   // __Host- pins it to exact origin, no subdomain
options.SlidingExpiration = true;
options.ExpireTimeSpan = TimeSpan.FromMinutes(20);     // idle timeout — build plan §13
```

| Control | Setting |
|---|---|
| Idle timeout | 20 min sliding (configurable in `SystemSettings`) |
| Absolute timeout | 12 hours — a workday. No infinite sessions on the front-desk PC |
| Failed logins | 5 attempts → 15-minute lockout, per account **and** per IP |
| Account disabled | Server-side session store; disabling revokes everywhere on next request |
| Password policy | 12+ chars, checked against a breached-password list, no forced rotation (NIST SP 800-63B) |
| MFA | Mandatory for `Permissions.Manage` / `System.Manage` / `Payroll.*` from Phase 3 |

**Single sign-on across the portal.** Client Workflow is a section of this application
behind the same cookie, not a separate system. Build plan §10's "one login" requirement
is satisfied structurally — there is no second thing to log into.

---

## 5. Client Handoff API

The centrepiece. Every endpoint here maps to the transaction in database blueprint §6.1.

### 5.1 Send

```http
POST /api/v1/handoffs
Idempotency-Key: 6f0c1a...
Content-Type: application/json

{
  "clientId": "3b7f...",
  "toEmployeeId": "9a21...",
  "message": "Frances — ABC Services is ready for review. All docs uploaded.",
  "expiresInHours": 72
}
```

Server-side checks, in order:

1. Caller holds `Handoff.Send`.
2. Caller is the **current active owner** of the client (from `vCurrentClientOwner`) — or holds `Handoff.ForceReassign`.
3. Recipient exists, is `Active`, is not the caller (`CK_Handoff_NotSelf`).
4. No pending handoff already exists (`UX_ClientHandoffs_OnePending` — a race here returns `409`).

```json
201 Created
Location: /api/v1/handoffs/8f2c9d1e-...
{
  "handoffId": "8f2c9d1e-...",
  "handoffNumber": "HF-2048",
  "client": { "id": "3b7f...", "displayName": "ABC Services" },
  "from": { "id": "1c4d...", "displayName": "Gina Altidor" },
  "to":   { "id": "9a21...", "displayName": "Frances ..." },
  "status": "Pending",
  "initiatedAtUtc": "2026-08-31T17:32:04.117Z",
  "expiresAtUtc": "2026-09-03T17:32:04.117Z"
}
```

**The client still belongs to Gina.** No assignment row changed. This is only an offer.

### 5.2 Accept

```http
POST /api/v1/handoffs/8f2c9d1e-.../accept
If-Match: "AAAAAAAAB9E="
Idempotency-Key: 21ab77...

{ "responseNote": "Got it, thanks!" }
```

The handler does exactly one thing: call `crm.usp_AcceptHandoff`. All eight steps are
inside that transaction. The API adds only what must not be inside a transaction:

```csharp
var result = await _db.AcceptHandoffAsync(handoffId, currentUser.EmployeeId, note, ip, ct);
// COMMIT has succeeded. Only now do we tell anyone.
await _notifications.QueueAsync(result.NotifyEmployeeId, NotificationKind.HandoffAccepted, ...);
```

Responses:

| Status | When |
|---|---|
| `200 OK` | Transferred. Body carries the new assignment and the client's new owner |
| `403` | Handoff is addressed to someone else |
| `404` | No such handoff, or caller can't see it |
| `409` | Already accepted/declined/cancelled, **or** Gina no longer owns the client, **or** lost the race |
| `410` | Expired |
| `412` | Stale `If-Match` — the handoff changed since you loaded the page |

**The concurrency guarantee, stated plainly:** if Frances and an admin both accept at the
same instant, one commits and one receives `409`. There is no interleaving that produces
two owners, because `UX_ClientAssignments_OneActive` cannot hold two rows. Partial
transfers are not possible because `XACT_ABORT` + one transaction means all eight steps
commit or none do.

### 5.3 Rest of the surface

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /handoffs/{id}/decline` | `Handoff.Accept` | Requires a reason. Ownership does not move; sender is notified |
| `POST /handoffs/{id}/cancel` | `Handoff.Send` | Sender only, Pending only |
| `GET /handoffs/inbox` | `Handoff.Accept` | Pending handoffs addressed to me |
| `GET /handoffs/outbox` | `Handoff.Send` | Ones I sent, any status |
| `GET /handoffs/{id}` | scoped | Includes the full `HandoffEvents` timeline |
| `GET /clients/{id}/assignments` | `Client.View*` | The ownership history table from build plan §5 |
| `POST /clients/{id}/reassign` | `Handoff.ForceReassign` | Admin override for a departed employee. Reason required; heavily audited |

A background job expires stale handoffs (`ExpiresAtUtc` passed), writing
`HandoffEvents` type 6 with a `NULL` actor. Expiry is a system act and is recorded as one.

---

## 6. Time clock API

### 6.1 Clock in

```http
POST /api/v1/timeclock/clock-in
Idempotency-Key: 4c9e...

{
  "latitude": 28.484255,
  "longitude": -81.457552,
  "accuracyMeters": 12,
  "deviceId": "web-4a1f..."
}
```

**There is no time field in this DTO, and that is the entire point.** The server stamps
`SYSUTCDATETIME()`. A tampered client can lie about where it is; it cannot lie about
when.

The handler:

1. Resolves `EmployeeId` **from the session cookie**.
2. Loads the employee's office, computes haversine distance server-side against
   `Offices.Latitude/Longitude/GeofenceRadiusMeters` — the browser's opinion about
   whether it is inside the fence is not consulted.
3. Inserts with `EntrySource = 1`, `ClockInUtc = EffectiveClockInUtc = SYSUTCDATETIME()`.
4. Derives `WorkDateLocal` from the office time zone.
5. Assigns `PayPeriodId` from the open period covering that date.

```json
201 Created
{
  "timeEntryId": "b2e7...",
  "clockInUtc": "2026-08-31T13:03:11.442Z",
  "clockInLocal": "2026-08-31T09:03:11.442-04:00",
  "office": { "code": "ORL", "name": "Orlando" },
  "geofence": { "ok": true, "distanceMeters": 41, "radiusMeters": 500 }
}
```

If already clocked in, `UX_TimeEntries_OneOpen` rejects and the API returns `409` with
the existing open entry so the UI can show "You're already clocked in since 9:03 AM."
Double-tapping the button is harmless.

### 6.2 Clock out, review, correct

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /timeclock/clock-out` | `TimeClock.Own` | Server time again. Fails `409` if no open entry |
| `GET /timeclock/me` | `TimeClock.Own` | Open entry + today's total + current period total |
| `GET /timeclock/entries?employeeId&payPeriodId` | `TimeClock.Review` | Office-scoped |
| `POST /timeclock/entries` | `TimeClock.Correct` | Manager manual entry. `EntrySource = 2`, `CreatedByEmployeeId` set. Reason required |
| `POST /timeclock/entries/{id}/corrections` | `TimeClock.Correct` | Adjust in/out. Writes `TimeEntryCorrections`, updates only `Effective*` |
| `POST /timeclock/entries/{id}/void` | `TimeClock.Correct` | Reason ≥10 chars. Sets `EntryStatus = 3` |
| `GET /timeclock/entries/{id}/history` | `TimeClock.Review` | Original punch + every correction, in order |

**There is no `DELETE /timeclock/entries/{id}`. There will never be one.** Deploy 17's
`deletePunch()` has no successor endpoint — its replacement is void-with-reason, and the
original row remains readable forever. This is build plan §8 expressed as an absence.

A correction request returns both stories, because that is what a payroll dispute needs:

```json
{
  "timeEntryId": "b2e7...",
  "original":  { "clockInUtc": "2026-09-02T12:03:00Z", "clockInLocal": "8:03 AM" },
  "effective": { "clockInUtc": "2026-09-02T12:00:00Z", "clockInLocal": "8:00 AM" },
  "corrections": [{
    "correctionType": "AdjustIn",
    "reason": "Employee reported missed punch at door",
    "correctedBy": "Gina Altidor",
    "appliedAtUtc": "2026-09-02T18:41:09Z"
  }]
}
```

---

## 7. Payroll API

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /payroll/periods` | `Payroll.View` | With status and totals |
| `GET /payroll/periods/{id}/summary` | `Payroll.View` | Hours per employee, flagged exceptions |
| `GET /payroll/periods/{id}/exceptions` | `Payroll.View` | Open punches, >18h spans, geofence failures, missing clock-outs |
| `POST /payroll/periods/{id}/lock` | `Payroll.Lock` | **Refuses if exceptions exist** unless `acknowledgeExceptions: true` with a reason |
| `POST /payroll/periods/{id}/reopen` | `Payroll.Lock` + MFA | Reason required. Critical `SecurityEvent`. Never silent |
| `POST /payroll/periods/{id}/adjustments` | `Payroll.Adjust` | Two-person rule enforced by `CK_PayAdj_TwoPerson` |
| `GET /payroll/periods/{id}/export` | `Payroll.View` | CSV. Streamed, never buffered |

Locking is transactional: assign every unassigned entry in range to the period, verify no
open punches remain, set `PeriodStatus = 3`, stamp `LockedBy`/`LockedAtUtc`, write audit.
After that the trigger in database blueprint §7.3 refuses writes — including from the
API's own login. The only way in is `POST /adjustments`, which sets `SESSION_CONTEXT`
and writes the adjustment row in the same transaction.

**Reopen requires MFA re-verification even for an already-signed-in Admin.** Unlocking
processed payroll is the highest-consequence action in the system.

---

## 8. Remaining surface

Full CRUD following the conventions in §2. Listed for completeness so the three
documents can be checked against each other — every table in the database blueprint has
coverage here.

**Clients** — `GET/POST /clients`, `GET/PUT /clients/{id}`, `POST /clients/{id}/archive`,
`GET/POST /clients/{id}/contacts`, `PUT/DELETE /clients/{id}/contacts/{cid}`,
`GET/POST /clients/{id}/notes`, `GET /clients/{id}/workflow`,
`PUT /clients/{id}/workflow` (writes `ClientWorkflowHistory` with duration in the same
transaction), `GET /clients/{id}/workflow/history`, `GET /clients/{id}/assignments`,
`GET /clients/{id}/documents`.

**Employees** — `GET /employees` (directory, respects `ShowBirthdayInDirectory`),
`GET/PUT /employees/{id}`, `POST /employees`,
`POST /employees/{id}/terminate`, `GET /employees/{id}/roles`,
`POST/DELETE /employees/{id}/roles/{roleId}`, `GET /employees/birthdays`.

**Termination** (`POST /employees/{id}/terminate`) is one transaction implementing build
plan §12: set status + date, revoke role grants, disable the Identity user, revoke all
sessions, cancel pending handoffs to/from them, close open time entries with a flag for
manager review, list clients needing reassignment, write audit. It returns that client
list so the admin is prompted to reassign — a departure must not silently orphan a book
of business.

**Requests / PTO** — `GET/POST /requests`, `PUT /requests/{id}` (own, Pending only),
`POST /requests/{id}/approve|deny|withdraw`, `GET /pto/me`, `GET /pto/{employeeId}`,
`POST /pto/{employeeId}/adjustments`, `GET /pto/{employeeId}/ledger`.
Approving a PTO request writes the `PtoTransactions` row in the **same transaction** as
the status change — an approval that doesn't deduct hours is not possible.

**Portal** — `GET/POST /events`, `PUT/DELETE(cancel) /events/{id}`,
`PUT /events/{id}/rsvp`, `GET/POST /announcements`, `GET/POST /tasks`,
`PUT /tasks/{id}/complete`, `GET /notifications`, `PUT /notifications/{id}/read`,
`GET /alerts`, `POST /alerts`, `PUT /alerts/{id}/dismiss` (per-employee),
`GET/POST /messages`, `GET/POST /resources`.

**Documents** — `POST /documents/upload-url` → pre-signed PUT (server picks the key, sets
max size and content type), `POST /documents` → confirm and record metadata + SHA-256,
`GET /documents/{id}/download-url` → permission-checked, 5-minute pre-signed GET,
`DELETE /documents/{id}` → soft delete. `doc.DocumentPermissions` rows are written by the
client/document endpoints; there is no direct CRUD surface for them, so an ACL cannot be
edited independently of the resource it protects. **Bytes never transit the API.** The browser
talks to object storage directly; the API only ever handles metadata and permission.

**Offices & lookups** — `GET /offices`, `GET/PUT /offices/{id}` (`System.Manage`),
`GET/POST /offices/{id}/notes`, `GET /lookups/workflow-stages`,
`GET/POST/PUT /admin/workflow-stages` (`System.Manage`),
`GET/POST/PUT /admin/pto-policies` (`PTO.AdjustBalance`).
Editing an office's geofence is `System.Manage`, not `Employee.Manage` — moving a fence
changes whether punches are flagged, so it sits with payroll-grade settings.

**Reports** — `GET /reports/hours`, `/clients-by-stage`, `/handoff-activity`,
`/pto-liability`, `/workflow-durations`.

**Admin** — `GET/PUT /admin/settings`, `GET/POST /admin/roles`,
`PUT /admin/roles/{id}/permissions`, `GET /admin/permissions`,
`GET /admin/audit`, `GET /admin/login-history`, `GET /admin/security-events`.

---

## 9. Cross-cutting middleware

Order matters; this is the pipeline:

```
Correlation ID → Serilog request log → Exception handler (→ problem+json)
→ HSTS/security headers → Rate limiter → Authentication → Employee-active check
→ Authorization (permissions) → Audit context → Controller
```

**Audit context** is the piece that makes "can we prove who did it" automatic rather than
remembered. It puts actor, IP, user-agent and correlation ID into an `AmbientContext`
that the `DbContext`'s `SaveChanges` interceptor reads. A developer who forgets to write
an audit row still gets one — the interceptor writes `Before`/`After` JSON for every
tracked entity change.

**Rate limits:** login 5/min per IP + 10/hour per account; clock-in/out 10/min per
employee; general 300/min per session; document upload-url 30/hour per employee.

**Security headers:** HSTS with preload, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, and a CSP with no
`unsafe-inline` — which is a real constraint, because Deploy 17's UI is built from inline
`onclick` handlers and inline `<style>`. Extracting those is a Phase 3 task, not an
afterthought. See migration map §8.

---

## 10. Nginx and deployment

```nginx
server {
    listen 443 ssl http2;
    server_name portal.ogofin.com;

    ssl_certificate     /etc/letsencrypt/live/portal.ogofin.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/portal.ogofin.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    client_max_body_size 1m;    # API takes metadata only; files go straight to Spaces

    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / { root /var/www/ogo-portal; try_files $uri $uri/ /index.html; }
}
```

`X-Forwarded-For` matters more than it looks: without it every `LoginHistory` and
`AuditLog` row records `127.0.0.1` and the failed-login lockout becomes useless. Configure
`ForwardedHeadersOptions` with `KnownProxies` in `Program.cs` to match.

`client_max_body_size 1m` is deliberate — if a document upload ever hits the API, it is a
bug, and this makes it fail loudly instead of quietly reintroducing the base64 problem.

**Topology** (build plan §15): app droplet holds Nginx + Kestrel; database droplet runs
SQL Server 2025 Standard bound to the DigitalOcean **private** interface only, with the
firewall allowing 1433 solely from the app droplet's private IP. The database has no
public route.

---

## 11. The concurrency test suite

Build plan §18 asks for this explicitly. These are `Ogo.Portal.ConcurrencyTests`, run
against real SQL Server via Testcontainers — not mocks, because the guarantees under test
are database guarantees.

| # | Scenario | Required outcome |
|---|---|---|
| 1 | Two employees accept the same handoff simultaneously | One `200`, one `409`. Exactly one active assignment. Exactly one `Handoff.Accepted` audit row |
| 2 | Sender cancels while recipient accepts | Exactly one wins; handoff ends `Accepted` or `Cancelled`, never both |
| 3 | Same employee clocks in from two devices | One `201`, one `409`. One open entry |
| 4 | Clock out twice, concurrently | One `200`, one `409`. One `ClockOutUtc` |
| 5 | Manager locks payroll while employee clocks out | Either the punch lands first, or `423`. Never a punch inside a locked period |
| 6 | Two managers approve the same PTO request | One `200`, one `412`. One `PtoTransactions` row — the balance never double-deducts |
| 7 | Two users edit the same client | One `200`, one `412`. No lost update |
| 8 | Terminate an employee while they accept a handoff | Handoff fails or is cancelled; no assignment to a terminated employee |
| 9 | The build plan's four-way collision: A clocks in, B accepts a handoff, C approves PTO, D updates a client, all at once | All four succeed; no deadlock; every audit row present |
| 10 | 50 concurrent handoff accepts across 50 clients | All succeed; 50 assignments; no deadlock; p95 < 500 ms |

Test 9 is the exact scenario in build plan §18 and it is the acceptance gate for Phase 6.
Tests 1, 3 and 6 are the ones that would fail today under Deploy 17's
last-write-wins `fbRef.set()`, which is why they are written first.

---

## 12. Phase gates

Maps to build plan §20. Each phase ships behind a gate that can be demonstrated, not
asserted.

| Phase | Deliverable | Gate |
|---|---|---|
| 1 | Solution skeleton, EF migrations, health checks | `/health` green over TLS from the app droplet only |
| 2 | Employees, offices, roles, permissions | Permission matrix test passes; no endpoint lacks a declared permission |
| 3 | Identity, cookies, MFA, sessions | PIN retired; idle + absolute timeout verified on a shared machine; CSP with no `unsafe-inline` |
| 4 | Clients | Office scoping proven — Staff in Clermont cannot read an Orlando client (and gets `404`) |
| 5 | Workflow + contacts | Stage history with durations reconstructs a full client timeline |
| 6 | **Handoff engine** | **Concurrency tests 1, 2, 8 green** |
| 7 | Time clock | Clock-in with a forged client timestamp is impossible (no field exists); tests 3, 4 green |
| 8 | PTO + requests | Ledger balances match policy calc for all 11 employees; test 6 green |
| 9 | Payroll | Locked period rejects writes at the **database** level; test 5 green; two-person rule verified |
| 10 | Events + notifications | Per-employee dismissal and read state correct |
| 11 | Documents | No base64 anywhere; pre-signed URLs expire; `client_max_body_size` never hit |
| 12 | Reporting | Report totals equal ledger totals |
| 13 | Hardening | Pen-test checklist; OWASP ASVS L2; `/health` is the only anonymous endpoint besides auth |
| 14 | Migration | Migration map §9 reconciliation queries all return zero variance |
| 15 | UAT | OGO sign-off across all three offices |
| 16 | Launch | Deploy 17 read-only; restore test passed **before** cutover |
