# Deploy 17 → SQL Server Migration Map

**Status:** ⚠️ **Draft 1 — SUPERSEDED IN PART. Re-derivation required.**
**Written against:** `ogo-staff-portal/index.html` @ `b02e783` (1,453 lines) — **the public demo build**
**Actual production:** the file deployed to `ogodashboard1.netlify.app` (1,977 lines, 282 KB, `FB_PATH='portals/ogo-v6-final/state'`)
**Companion documents:** [`01-database-blueprint.md`](01-database-blueprint.md) · [`02-api-blueprint.md`](02-api-blueprint.md)

---

## 0. ⚠️ Read this before anything else

This document was derived from the **public demo build in this repository**, on the
working assumption — flagged at the time as blocker #1 — that it matched production. **It
does not.** Production is a separate, substantially newer file, deployed to Netlify by
manual drag-and-drop with no Git connection, and is roughly 36% larger.

Three headline findings below are **wrong for production** and are corrected here:

| § | Draft 1 said | Production reality |
|---|---|---|
| §5 | "Deploy 17 has no handoff feature" — zero matches | **Handoffs exist.** 44 references. The engine is a port, not new construction |
| §2 | `fbRef.set()` overwrites the whole document on every action | **Production uses `fbRef.update()`**, excludes `tc` from the bulk write, and writes punches to per-employee paths via `fbSavePunch(k)`. The catastrophic whole-document race is demo-only |
| §4 | State tree as listed | Production adds `clientWorkflow`, `workSaturdays`, and the sync markers `eventsSync`, `ptoSeed`, `satSync`, `seededEvents`, `staffSync` |

**Everything else in this document must be re-verified against the production file before
it is used to build anything.** The conventions, the reconciliation method, the name→ID
resolution procedure and the cutover sequence all still hold as *method*; the specific
field inventories do not.

What survives unchanged: §3.1 (config in JavaScript constants, not Firebase — still true,
and still means freezing the *file* matters), §3.2 (name-keyed identity), §3.8 (PINs in
`localStorage`), and the §9 reconciliation gates.

**Corrected blocker list is §11.**

---

## 1. What this document is

Every field in Deploy 17, traced to where it lands in SQL — or flagged as having nowhere
to land. It is written against the actual source, not against a description of it, which
is why several entries below contradict reasonable assumptions about what the portal
stores.

**Read §5 first.** It contains the one finding that changes the build plan.

---

## 2. The source shape

Deploy 17 is a Firebase **Realtime Database** app (`firebase-database-compat.js`), not
Firestore. There are no collections and no documents. There is one JSON node:

```
portals/demo/state          ← the entire company, in a single JSON value
```

Written by:

```js
function fbSave(){
  if(!fbRef||fbLock)return;
  const data=clone(S);
  delete data.activeOffice;delete data.activeSection;delete data.adminMode;
  data._ts=Date.now();
  fbRef.set(data);          // ← whole-document overwrite
}
```

`fbRef.set(data)` replaces the entire node on every action — every clock-in, every RSVP,
every note. Read back via `fbRef.on('value', …)` → `fbMerge()` → `S=Object.assign(makeDefault(),data,ui)`,
which replaces local state wholesale.

**This is the architecture problem in one line.** If Gina approves PTO at 1:32:04 and
Frances clocks in at 1:32:04, both browsers hold a full copy of company state, both write
it back, and the second write silently erases the first person's change — not just their
field, the *whole document* they didn't know about. No error, no conflict, no trace. It
is not a race that is unlikely; it is a race with no lock at all.

Two further consequences for migration:

- **The export is one file.** `firebase database:get /portals/demo/state > deploy17.json`.
  There is no per-collection export and no server-side change history to mine.
- **`_ts` is the only timestamp on the document**, and it is `Date.now()` from whichever
  browser wrote last — so it records neither reliable time nor an author.

### 2.1 State tree

| Key | Type | Grain |
|---|---|---|
| `nextId` | int | **One counter shared by every entity type** |
| `employees` | array | `{id,name,bday,hireDate,phone,email,pos,office,status}` |
| `events` | array | `{id,name,date,time,type,office,attendees[],link,notes}` |
| `announcements` | array | `{id,text,tag,office}` |
| `todos` | array | `{id,label,office,done}` |
| `offices` | **object keyed by name** | `{manager,phone,address,hours,email,note,notes[]}` |
| `requests` | array | `{id,type,office,dateFrom,dateTo,notes,ptoHours,ptoYear,requester,status,reviewedBy,reviewedAt,reviewNote}` |
| `clients` | array | `{id,name,status,office,owner,stage,notes}` |
| `resources` | array | `{id,name,desc,url,category,fileName,fileData}` |
| `photos` | array | `{id,title,caption,category,office,dataUrl,uploadedBy,uploadedAt}` |
| `urgentAlerts` | array | `{id,title,desc,office,createdAt,dismissed}` |
| `notifications` | array | `{id,text,scope,createdAt}` — **capped at 30** |
| `activity` | array | `{id,text,actor,office,ts}` — **capped at 100** |
| `rsvps` | object | `eventId → employeeId → status` |
| `inbox` | **object keyed by name** | `name → [{id,text,ts,read}]` — **capped at 30 each** |
| `tc.entries` | object | `'emp_<id>' → [{id,date,clockIn,clockOut,duration,office,manual,notes}]` |
| `tc.active` | object | `'emp_<id>' → clientTimestamp` |
| `analytics` | object | Hardcoded demo numbers |
| `ptoOverrides` | **object keyed by name** | `name → {total}` |
| `rosterSync` | string | Migration marker (`'2026-07-07'`) |
| `removedSeeds` | object | `{events:[ids], employees:[ids]}` — tombstones |

---

## 3. Findings that change the plan

### 3.1 🔴 Critical — Configuration lives in code, not in the database

These are **not in the Firebase export** and cannot be recovered from it. They must be
transcribed from `index.html` by hand into seed data:

| Deploy 17 source | Line | Contents | SQL destination |
|---|---|---|---|
| `const ROLES = {...}` | 570 | Who is Admin/Manager — **5 named people** | `hr.EmployeeRoles` |
| `var PTO_SAL = [...]` | 572 | 5 salaried employees, by name | `hr.Employees.PtoPolicyId` → `SALARIED_80` |
| `var PTO_HR = [...]` | 573 | 6 hourly employees, by name | `hr.Employees.PtoPolicyId` → `HOURLY_TIERED` |
| `const GEO = {...}` | 596 | Office lat/lng, radius 500 m | `org.Offices.Latitude/Longitude/GeofenceRadiusMeters` |
| `const ADMIN_PW` | 566 | Single shared admin passcode | **Nothing. Retired.** |
| `getPPs()` | 764 | Pay period generator | `time.PayPeriods` rows |
| `getPTOInfo()` | 574 | Accrual rules (80h salaried; 0/40/80h hourly by tenure; 90-day probation) | `hr.PtoPolicies` + `hr.PtoPolicyTiers` |

**Why this matters:** anyone planning migration from the Firebase export alone will
produce a database in which nobody is an Admin, nobody has a PTO policy, and no office
has a geofence. The export is not sufficient. `index.html` is the second source, and
Stage A's "freeze Deploy 17" must freeze **the file**, not just the data.

Deploy 17's accrual rules, transcribed for seeding:

```
SALARIED_80    : 80 h granted annually, resets Jan 1, no probation
HOURLY_TIERED  : probation 90 days → 0 h
                 <1 year tenure     → 40 h
                 ≥1 year tenure     → 80 h
                 resets Jan 1
Override       : ptoOverrides[name].total replaces the computed total
```

### 3.2 🔴 Critical — Identity is by display name in eight places

`employees[].id` exists, but most references use the **name string** instead:

| Reference | Line | Points at |
|---|---|---|
| `clients[].owner` | 1155 | Free-text `<input>`. Not a dropdown — an arbitrary typed string |
| `requests[].requester` | 1128 | `CU.name` |
| `requests[].reviewedBy` | — | Approver's name |
| `inbox` keys | 689 | Recipient's name |
| `ptoOverrides` keys | 577 | Employee name |
| `photos[].uploadedBy` | 1185 | Uploader's name |
| `activity[].actor` | 687 | Actor's name |
| `offices[].manager` | 643 | Manager's name |
| `ROLES` / `PTO_SAL` / `PTO_HR` | 570-573 | Employee names |

`clients[].owner` being a **free-text input** is the sharpest edge. `editClient()` renders
`<input class="field" id="m-owner">` — so "Alex Rivera", "alex rivera", "A. Rivera" and
a typo are four different owners, and none of them is a foreign key.

**Migration consequence:** name→`EmployeeId` resolution is the single largest source of
migration risk, and it will not be 100% automatic. The plan is in §6.

### 3.3 🟠 High — Audit history is already partially gone

```js
S.activity = S.activity.slice(0,100);       // line 687
S.notifications = S.notifications.slice(0,30);  // line 688
S.inbox[toName] = S.inbox[toName].slice(0,30);  // line 689
```

`activity` is the closest thing Deploy 17 has to an audit log, and it is a 100-entry ring
buffer. Everything older has been overwritten and is unrecoverable. Whatever remains at
export time is all the history that exists.

We migrate what survives into `audit.AuditLog` marked `Action = 'Legacy.Activity'`, and
we state plainly in the UAT record that pre-cutover audit coverage begins at the oldest
surviving entry. This is a fact to disclose, not a gap to paper over.

### 3.4 🟠 High — Time punches carry browser time

```js
const now = Date.now();          // line 811 — the employee's device clock
S.tc.active[k] = now;            // clock in
S.tc.entries[k].push({ clockIn: ic, clockOut: now, duration: dur, ... });
```

Every historical punch reflects whatever the employee's phone or laptop believed the time
was. A device with a 4-minute skew produced 4-minute-wrong payroll. Migrated punches
therefore land as `EntrySource = 3 (Migrated)` and are **never** presented as
server-verified. Historical accuracy claims start at cutover.

`tc.active` entries at export time are **in-flight punches with no clock-out**. See §7.3.

### 3.5 🟡 Medium — Files are base64 inside the state document

`resources[].fileData` (10 MB limit, line 1359) and `photos[].dataUrl` (5 MB limit) hold
`FileReader.readAsDataURL()` output — base64 strings inside the same JSON node that every
clock-in rewrites. A 10 MB PDF becomes ~13.4 MB of base64 that is re-uploaded on every
single portal action by every connected browser.

These extract to DigitalOcean Spaces during migration; `doc.Documents` holds the metadata.
This alone will shrink the state payload by orders of magnitude.

### 3.6 🟡 Medium — `removedSeeds` tombstones must be honoured

`removeEmp()` (1342) and `deleteEvent()` (1091) don't just filter the array — they push
the id into `removedSeeds`, because `fbMerge()` re-inserts any seed employee or event
that is missing. A migration that ignores `removedSeeds` will **resurrect deleted staff
and events**. Migration must read the tombstone lists and exclude those ids.

### 3.7 🟡 Medium — Shared `nextId` counter

`nextId` (starting 900) issues ids for employees, events, announcements, todos, requests,
clients, resources, photos, alerts, notifications, activity and office notes alike. So
`id: 947` is not "client 947" — it's the 47th thing anyone created, of any type. IDs are
**not** transferable across tables, and migration mints fresh identity values in every
target table while retaining the legacy id in a staging column for reconciliation.

### 3.8 🟡 Medium — PINs are per-device and unrecoverable

```js
function getPins(){ return JSON.parse(localStorage.getItem('ogo_pins_v6f')||'{}'); }
```

PINs live in `localStorage`, per browser, and are never synced. Two facts follow: they
cannot be migrated, and they were never a real authentication boundary — the "Skip" button
is shown during PIN creation (line 964), so a PIN is optional. Combined with
`ADMIN_PW = 'DEMO1234'` as a hardcoded constant readable by anyone who views source, and
`toggleAdmin()` gating on it, Deploy 17 has no server-side authorization at all.

Nothing here migrates. Every employee is issued a new account at cutover (§10).

### 3.9 🟢 Low — Three defects to fix in transit, not port

| Deploy 17 behaviour | Line | Fix |
|---|---|---|
| `urgentAlerts[].dismissed` is a **global** flag — one person dismisses, everyone loses it | 1043 | `portal.AlertDismissals` per employee |
| `todos[].done` is **shared** — one person's checkbox is everyone's | 1117 | Per-employee completion |
| `setRSVP` writes both `rsvps[eid][empId]` **and** `events[].attendees[]` — two sources that can disagree | 1239 | `EventResponses` only; attendee list derived |

The RSVP double-write is a genuine data-consistency bug: `attendees` was seeded
independently of `rsvps`, so seeded attendees have no RSVP row and the two disagree today.

---

## 4. Field-by-field mapping

### 4.0 Table disposition — the complete list

Every table in the database blueprint, and where its rows come from. This is the checklist
that makes the three documents verifiably consistent: no table may be absent from it.

| SQL table | Source | Rows at cutover |
|---|---|---|
| `org.Companies` | Seeded | 1 |
| `org.Offices` | `offices{}` + `GEO` constant | 3 |
| `org.OfficeNotes` | `offices[].notes[]` | As exported |
| `org.SystemSettings` | **Seeded** — replaces `ADMIN_PW`, timeouts, geofence policy | 0 migrated |
| `hr.Employees` | `employees[]` + `removedSeeds.employees` | 11 + departed |
| `hr.Roles` | **Seeded** — Staff / Manager / Admin | 0 migrated |
| `hr.Permissions` | **Seeded** — the §4.1 catalog | 0 migrated |
| `hr.RolePermissions` | **Seeded** | 0 migrated |
| `hr.EmployeeRoles` | `ROLES` constant + `offices[].manager` | ~8 |
| `hr.EmployeePermissionOverrides` | **New capability** | 0 |
| `hr.PtoPolicies` / `PtoPolicyTiers` | `getPTOInfo()` rules, transcribed | 2 policies |
| `hr.PtoTransactions` | Computed from policy + approved requests (§4.5) | 2 per employee + uses |
| `hr.EmployeeRequests` | `requests[]` | As exported |
| `crm.Clients` | `clients[]` | As exported |
| `crm.ClientContacts` | **No source.** Deploy 17 has no contacts | 0 |
| `crm.ClientNotes` | `clients[].notes` (one row each) | 1 per client with notes |
| `crm.ClientAssignments` | `clients[].owner` — one row per client, `StartReason=Migration` | 1 per client |
| `crm.WorkflowStages` | **Seeded** (§4.4) | 0 migrated |
| `crm.ClientWorkflowStatus` | `clients[].stage` | 1 per client |
| `crm.ClientWorkflowHistory` | **No source.** No stage history exists | 0 |
| `crm.ClientHandoffs` | **No source — feature does not exist (§5)** | **0** |
| `crm.HandoffEvents` | **No source (§5)** | **0** |
| `time.PayPeriods` | Generated from confirmed cadence (§7.1) | Spanning all punches |
| `time.TimeEntries` | `tc.entries{}` (+ `tc.active` per §7.3) | As exported |
| `time.TimeEntryCorrections` | **No source.** Deploy 17 hard-deletes instead | 0 |
| `time.PayrollAdjustments` | **No source.** No locking existed | 0 |
| `portal.Events` | `events[]` | As exported |
| `portal.EventResponses` | `rsvps{}` + `events[].attendees[]` (§3.9) | As reconciled |
| `portal.Announcements` | `announcements[]` | As exported |
| `portal.Tasks` | `todos[]` | As exported |
| `portal.Alerts` | `urgentAlerts[]` | As exported |
| `portal.AlertDismissals` | **No source.** Dismissal was global (§3.9) | 0 |
| `portal.Notifications` | `notifications[]`, fanned out by office | ≤30 × recipients |
| `portal.Messages` | `inbox{}` | ≤30 per employee |
| `portal.Resources` | `resources[]` | As exported |
| `doc.Documents` | `resources[].fileData` + `photos[].dataUrl` (§7.2) | Files only |
| `doc.DocumentPermissions` | **New capability** | 0 |
| `audit.AuditLog` | `activity[]` (≤100, §3.3) + migration's own entries | ≤100 legacy |
| `audit.LoginHistory` | **No source.** No login tracking existed | 0 |
| `audit.SecurityEvents` | **No source** | 0 |

**Fifteen tables migrate zero rows.** That is the honest measure of how much of this
system is new capability rather than a port — and it is concentrated exactly where the
audit found the weaknesses: handoffs, corrections, payroll adjustments, login history and
security events. Deploy 17 had no way to record any of them.


### 4.1 Employees → `hr.Employees`

| Deploy 17 | Type | SQL | Transform |
|---|---|---|---|
| `id` | int | *(staging only)* `LegacyId` | New `EmployeeId` minted; legacy id retained for reconciliation |
| `name` | string | `FirstName` + `LastName` | Split on last space; **manual review** for multi-word surnames |
| — | | `PreferredName` | From `name` where split is ambiguous |
| `bday` | `YYYY-MM-DD` | `DateOfBirth` | Direct; `''` → `NULL` |
| `hireDate` | `YYYY-MM-DD` | `HireDate` | Direct. **One employee has `''`** (Quinn Foster) → `NULL`, blocks PTO calc, needs HR input |
| `phone` | string | `Phone` | Normalise to E.164 |
| `email` | string | `WorkEmail` | ⚠️ Demo data is `@example.com`. Production values must be real and unique — `UX_Employees_WorkEmail` will reject duplicates |
| `pos` | string | `JobTitle` | Direct |
| `office` | name string | `PrimaryOfficeId` | Lookup by office name → id |
| `status` | `'Active'` | `EmploymentStatus` | `Active`→1, else map; terminated requires `TerminationDate` (`CK_Employees_Term`) |
| *(from `ROLES`)* | code | `hr.EmployeeRoles` | Named Admins/Managers; everyone else → `Staff` |
| *(from `PTO_SAL`/`PTO_HR`)* | code | `PtoPolicyId` | Salaried vs hourly policy |
| — | | `EmployeeNumber` | **Minted.** Deploy 17 has none. Format TBD with HR |
| — | | `UserId` | Created at cutover, not migrated |

**`status` is currently `'Active'` for all 11 employees, including the departed employee
referenced in build plan §12.** Deploy 17's `removeEmp()` deletes the row rather than
marking it terminated, so a departure leaves no record — which is precisely why that
person is absent from the roster rather than present-and-terminated. Confirm against
`removedSeeds.employees` at export time: any id listed there is someone who left, and
their name may still appear in `clients[].owner`, `requests[].requester` and `tc.entries`.
They must be **recreated as `Terminated`**, not dropped, or their payroll history has no
owner (build plan §12).

### 4.2 Offices → `org.Offices`

| Deploy 17 | SQL | Transform |
|---|---|---|
| object key (`'Winter Haven'`) | `Name` + `Code` | Code minted: `ORL`, `CLR`, `WHV` |
| `manager` | *(→ `hr.EmployeeRoles`)* | Name → `EmployeeId`, granted `Manager` scoped to that office |
| `phone` | `Phone` | Winter Haven's is `''` → `NULL` |
| `address` | `AddressLine1/City/StateCode/PostalCode` | **Parse required** — stored as one ` · `-delimited string |
| `hours` | `OpenTimeLocal`/`CloseTimeLocal` | Parse `'Mon–Fri 10AM–5PM'`; weekday pattern is uniform across all three |
| `email` | `Email` | Direct |
| `note` | `Notes` | Direct |
| `notes[]` | `org.OfficeNotes` | `{id,text,ts,author}` → rows; `author` name → `EmployeeId` |
| *(from `GEO`)* | `Latitude`/`Longitude`/`GeofenceRadiusMeters` | Transcribed from line 596; all three radius 500 |
| — | `TimeZoneId` | `America/New_York` — all three offices are in Florida |

### 4.3 Clients → `crm.Clients` + `crm.ClientAssignments`

| Deploy 17 | SQL | Transform |
|---|---|---|
| `id` | *(staging)* | New `ClientId` |
| `name` | `LegalName` + `DisplayName` | Both set to source value; refine later |
| `status` | `ClientStatus` | `Active`→1 `Waiting Docs`→2 `On Hold`→3 `Closed`→4 |
| `office` | `OfficeId` | Name lookup |
| `owner` | **`crm.ClientAssignments`** | Name→`EmployeeId`; one row per client, `AssignmentRole=1`, `StartReason=4 (Migration)`, `StartedAtUtc` = migration timestamp, `EndedAtUtc=NULL` |
| `stage` | `crm.ClientWorkflowStatus` | Map to `WorkflowStages` (§4.4) |
| `notes` | `crm.ClientNotes` | One row, author = migration system, `CreatedAtUtc` = migration timestamp |
| — | `ClientNumber` | **Minted** |
| — | `ClientType` | Heuristic: name contains `LLC`/`Inc`/`Corp`/`Group` → Business, else Individual. **Requires review** |
| — | `CreatedAtUtc` | Unknown. Set to migration timestamp; genuinely not recoverable |

**`owner` is free text** (§3.2). Expect exact matches for most rows and a manual
resolution list for the rest. Any unresolvable owner **blocks** migration rather than
defaulting — see §6.

**Ownership history does not exist before cutover.** Every client gets exactly one
assignment row, starting at the migration timestamp with `StartReason = Migration`. We
cannot invent a history we do not have, and we must not: `ClientAssignments` is a payroll-
and accountability-grade ledger, and seeding it with guesses would poison it. The honest
statement for UAT: *"Ownership history begins at cutover. Prior ownership is not
recorded, because Deploy 17 did not record it."*

### 4.4 Workflow stage mapping

Deploy 17's `stage` values (from `addClient`, line 1355) do not match the build plan's
tax-workflow stages (§6). Both lists, and the proposed mapping:

| Deploy 17 `stage` | → `crm.WorkflowStages.Code` |
|---|---|
| `In Progress` | `InProgress` |
| `Review` | `ReadyForReview` |
| `Documents Requested` | `PendingDocuments` |
| `Filed` | `EFiled` |
| `Complete` | `IrsAccepted` |
| `On Hold` | `OnHold` |

Build plan §6 also lists `Waiting for Authorization`, which has **no Deploy 17 equivalent**
— it is a new stage, seeded but with zero migrated rows. `Filed → EFiled` and
`Complete → IrsAccepted` are the two semantically lossy mappings: "Complete" may have
meant "we finished our part," not "IRS accepted it." **Alex Rivera should confirm both
before Phase 5**, because these drive the workflow-duration reports.

`TaxYear` is not in Deploy 17 at all. Migration sets it to the tax year OGO confirms
(likely 2025 for work in progress during 2026); it cannot be derived.

### 4.5 Requests → `hr.EmployeeRequests` + `hr.PtoTransactions`

| Deploy 17 | SQL | Transform |
|---|---|---|
| `type` | `RequestType` | `PTO`→1 `Vacation`→2 `IT Support`→3 `Supply Request`→4 `Schedule Change`→5 `Training`→6 `Other`→9 |
| `requester` | `EmployeeId` | Name lookup |
| `office` | `OfficeId` | Name lookup |
| `dateFrom`/`dateTo` | `StartDate`/`EndDate` | Direct |
| `ptoHours` | `HoursRequested` | Where blank, apply Deploy 17's own default: `max(1, days)×8` (`getPTOUsed`, line 587) |
| `notes` | `Notes` | Direct |
| `status` | `RequestStatus` | `Pending`→1 `Approved`→2 `Denied`→3 |
| `reviewedBy` | `ReviewedByEmployeeId` | Name lookup |
| `reviewedAt` | `ReviewedAtUtc` | ⚠️ **Locale-formatted display string**, not ISO. Parse or set `NULL` |
| `reviewNote` | `ReviewNote` | Direct |
| `ptoYear` | *(→ `PtoTransactions.PlanYear`)* | |

**`CK_Req_NotSelfApproved` may reject legacy rows.** Deploy 17's `approveWithNote()`
lets a Manager or anyone in admin mode approve their own request. Any such row must be
migrated with `ReviewedByEmployeeId = NULL` and flagged in the exception report — we do
not weaken the constraint to accommodate a practice we are deliberately ending.

**PTO ledger seeding.** Deploy 17 stores no balance; `getPTOInfo()` recomputes it every
render. So for each employee we write, for the current plan year:

1. A `Grant` transaction for the policy entitlement (with `ptoOverrides[name].total` where present).
2. A `Use` transaction per approved PTO/Vacation request, hours per the rule above.

`hr.vPtoBalances` must then equal `getPTOInfo().total − getPTOUsed(name)` for all 11
employees. That equality is the Phase 8 gate.

### 4.6 Time clock → `time.TimeEntries`

| Deploy 17 | SQL | Transform |
|---|---|---|
| `tc.entries` key `'emp_7'` | `EmployeeId` | Strip `emp_` prefix, map legacy id → new id |
| `clockIn` (ms epoch) | `ClockInUtc`, `EffectiveClockInUtc` | `DateTimeOffset.FromUnixTimeMilliseconds().UtcDateTime` |
| `clockOut` (ms epoch) | `ClockOutUtc`, `EffectiveClockOutUtc` | Same |
| `duration` (ms) | *(recomputed)* | `DurationMinutes` is computed. **Verify** it matches `duration/60000` and report any mismatch |
| `date` (`YYYY-MM-DD`) | `WorkDateLocal` | ⚠️ Deploy 17 uses `ldate(ic)` — the **local date of the browser that wrote it**. Recompute from `ClockInUtc` + office tz; log differences |
| `office` | `OfficeId` | Name lookup. ⚠️ **Meaning changed mid-life.** Before the multi-office geofence fix this was the employee's *home* office; after it, the office they actually clocked in at. Punches carrying `homeOffice` are post-fix and their `office` is a verified location; those without it are pre-fix and are only an assumption |
| `homeOffice` | *(cross-check)* | Post-fix punches only. Where it differs from `office`, the employee worked at another location — expected, not an error |
| `manual` | `EntrySource` | `true`→2, `false`→3 (Migrated). **No migrated punch is `EntrySource=1`** |
| `autoOut` | `EntrySource` = 4 | System-closed at 11:59 PM after a missed clock-out. These are *ceilings, not measurements* — import with the correction row intact and treat every one as needing review, never as verified hours |
| `notes` | `Note` | Direct |
| — | `PayPeriodId` | Assigned from generated historical periods (§7.1) |
| — | `EntryStatus` | 2 (Closed) |
| — | geo/IP/device columns | `NULL`. Deploy 17 checked the geofence but **never stored the result** — `handleClock()` calls `checkGeo()` and discards it |

`CK_TimeEntry_MaxSpan` (18 hours) may reject legacy rows from forgotten clock-outs,
including `autoOut` entries closed at 11:59 PM after a late-morning clock-in. These
**do not get the constraint relaxed.** They import as `EntryStatus = 3 (Voided)` with
`VoidReason = 'Migrated: exceeds maximum shift length; requires manager correction'`, plus
an exception-report row. A manager then enters the real hours as a correction. That is one
uncomfortable conversation per bad punch, and it is better than importing an 31-hour shift
into payroll because a constraint was loosened.

### 4.7 Portal content

| Deploy 17 | SQL | Notes |
|---|---|---|
| `events[]` | `portal.Events` | `date`+`time`; `time` is free text (`'5:30 PM – 9:30 PM'`, `'All Day'`, `'May 30–31'`) — **parse with a fallback to `LocationText`/`Notes`**; multi-day events have no end-date field |
| `events[].attendees[]` | `portal.EventResponses` | `Response = Going`. Reconcile against `rsvps` (§3.9) and report disagreements |
| `rsvps{}` | `portal.EventResponses` | `eventId → empId → status`; authoritative where it disagrees with `attendees` |
| `announcements[]` | `portal.Announcements` | No author or timestamp in source → migration system + migration timestamp |
| `todos[]` | `portal.Tasks` | Shared `done` → completion for **nobody**; per-employee from cutover |
| `urgentAlerts[]` | `portal.Alerts` (+ `AlertDismissals`) | Global `dismissed:true` → no per-employee rows; alert imports as active-but-expired |
| `notifications[]` | `portal.Notifications` | `scope` is an office name, not a recipient — fan out to employees in that office |
| `inbox{}` | `portal.Messages` | Key (name) → `ToEmployeeId`. **`FromEmployeeId` is not recorded in the source** → `NULL` with a system marker |
| `photos[]` | `doc.Documents` + `portal.Resources` | `dataUrl` → Spaces (§7.2) |
| `resources[]` | `portal.Resources` | `fileData` → Spaces; `url`-only rows carry `DocumentId = NULL` |
| `activity[]` | `audit.AuditLog` | `Action='Legacy.Activity'`, `Summary=text`, `ActorEmployeeId` from name. **≤100 rows survive** |
| `analytics{}` | — | **Not migrated.** Hardcoded demo values (`[42,51,49,63,58,71]`), not real data. Reports compute from live tables |
| `rosterSync` | — | **Not migrated.** Internal marker |
| `removedSeeds{}` | — | **Not migrated, but must be read** (§3.6) |

---

## 5. 🔴 The finding that changes the plan: there are no handoffs

Build plan §17 lists `Old handoff → ClientHandoffs`, and §17's reconciliation target
includes **9 handoffs**.

> ✅ **RESOLVED — and this section's premise was wrong.** Production *does* have handoffs
> (44 references in the deployed file). What follows describes the **demo** build only.
> For production, `crm.ClientHandoffs` and `crm.HandoffEvents` are a **port with real
> source rows**, not new construction, and the "9 handoffs must reconcile" gate is valid
> and must be honoured. The production handoff data model still needs mapping — that is
> the first task of the re-derivation.

**The demo build contains no handoff feature.** Searching its 1,453 lines for `handoff`,
`hand off`, `transfer` and `reassign` returns zero matches — no state key, no function, no
UI, no button. Client ownership is a free-text `owner` field on `clients[]`, edited in
place by `saveClient()`. Changing an owner overwrites the previous value with no record
that it changed, no sender, no recipient, no acceptance and no timestamp.

**Consequences:**

1. **`crm.ClientHandoffs` and `crm.HandoffEvents` migrate zero rows.** They are new
   construction (Phase 6), correctly placed in the build plan — but they are not a port,
   and no reconciliation query can compare them to a source that doesn't exist.
2. **The "9 handoffs must equal 9" gate cannot be met as written.** It has no source
   table. Either the number came from somewhere outside the portal, or the production
   Deploy 17 differs from this repository copy.
3. **`ClientAssignments` cannot be back-filled.** Every client gets exactly one assignment
   row starting at cutover (§4.3).

**This needs an answer before Phase 0 closes** — pick one:

- **(a)** The 9 handoffs are tracked outside the portal (email, verbal, a spreadsheet). If
  so, we can import them as historical `ClientAssignments` rows *if* someone can supply
  client, from, to and date. That is a data-entry task with a real source, and it is worth
  doing — it gives the ownership ledger a real starting history.
- **(b)** The production Deploy 17 is a **newer build than this repository**, and does
  have handoffs. Then this entire migration map must be re-derived against that file
  before anything is built. **Confirm this first**, because it would also invalidate parts
  of §4.
- **(c)** The number was aspirational — describing what the new system will track. Then
  the reconciliation gate simply drops handoffs, and §18 records "handoffs: new
  functionality, no source data."

Everything else in this document assumes the repository copy is the production build. If
it is not, say so and this gets redone against the real file — cheaply, now, rather than
after Phase 6.

---

## 6. Name → EmployeeId resolution

The largest mechanical risk (§3.2). Deterministic, fail-loud procedure:

**Stage 1 — Build the map.** From `employees[]` plus any ids in `removedSeeds.employees`,
build `name → EmployeeId`. Reject the migration immediately if two employees share a
display name; there is no safe automatic resolution for that.

**Stage 2 — Resolve, in this order:**

1. Exact match.
2. Trimmed, case-insensitive, whitespace-collapsed match.
3. Unique match on last name + first initial.
4. **Nothing else.** No fuzzy matching, no Levenshtein, no "closest".

**Stage 3 — Unresolved names go to an exception report, not a default.** Assigning a
mistyped owner to the wrong person is worse than stopping: it silently moves a client's
accountability. A human resolves each one, the decisions are recorded in the migration
log, and migration re-runs.

**Stage 4 — Names belonging to departed staff** (present in `owner`/`requester`/`tc.entries`
but absent from `employees[]`) are recreated as `EmploymentStatus = Terminated` with the
best-known termination date, so their history has an owner (build plan §12).

**Expected outcome by field** (demo data; production will differ):

| Field | Rows | Risk |
|---|---|---|
| `requests[].requester` | 0 in demo | Low — written from `CU.name`, always exact |
| `activity[].actor` | ≤100 | Low — same source |
| `inbox` keys | 0 in demo | Low — written by `addInbox(toName)` from a picker |
| `clients[].owner` | 3 in demo | **High — free-text input** |
| `offices[].manager` | 3 | Medium — hand-typed in the office editor |
| `ROLES`/`PTO_SAL`/`PTO_HR` | 11 | Low — hand-transcribed once, verified against roster |

---

## 7. Things that need decisions before migration runs

### 7.1 Pay period cadence — blocks Phase 9

Deploy 17's `getPPs()` (line 764) generates **biweekly** periods: start `2026-03-15`,
`+13` days each, 14 iterations. The build plan §9 shows a **semi-monthly** period
(`08/16/2026 – 08/31/2026`).

These are different pay systems. Biweekly gives 26 paychecks a year and clean 40-hour
overtime weeks; semi-monthly gives 24 and splits weeks across periods. They also assign
the same punch to different periods, so historical `PayPeriodId` assignment depends
entirely on the answer.

**OGO must confirm which one is real payroll.** Deploy 17's generator may simply be wrong —
it is display-only there and never affected a paycheck, so an error would have gone
unnoticed. Migration generates historical periods from the confirmed cadence, covering
the full span of migrated punches.

### 7.2 Object storage extraction

For each `resources[].fileData` and `photos[].dataUrl`:

1. Strip the `data:<mime>;base64,` prefix; decode.
2. Compute SHA-256 → `doc.Documents.Sha256` (also de-duplicates repeated uploads).
3. `PUT` to Spaces at `documents/{PublicId}/{sanitized-filename}` — **private ACL**.
4. Insert `doc.Documents` with real `ContentType` and `ByteSize` (decoded, not base64).
5. Verify byte-for-byte by re-reading and comparing hashes. A document that does not
   verify fails the migration; it is not skipped with a warning.

`UploadedByEmployeeId` comes from `photos[].uploadedBy` (name lookup); `resources[]` has
**no uploader recorded** → migration system account.

### 7.3 In-flight punches at cutover

`tc.active` holds employees clocked in *right now*, as `'emp_<id>' → timestamp`, with no
clock-out. At cutover these are either:

- **(a)** imported as `EntryStatus = 1 (Open)` with the legacy `clockIn` — but then
  `UX_TimeEntries_OneOpen` correctly prevents a fresh clock-in on the new system, and the
  employee is stuck until a manager closes it; or
- **(b)** closed at the cutover moment with `EntrySource = 3` and a note, then the
  employee clocks in fresh on the new system.

**Recommendation: (b), and schedule the cutover outside working hours** so `tc.active` is
empty. A cutover during business hours with people clocked in is an avoidable payroll
dispute on day one.

---

## 8. Front-end migration

Deploy 17's UI is the design foundation (build plan §1) and is being kept. Three
structural changes are needed to put it in front of an API, and the third is a real cost
worth naming now:

1. **State access → API calls.** Every `S.<key>` read becomes a fetch; every `fbSave()`
   becomes a `POST`/`PUT` with `If-Match`. `renderAll()` re-renders from responses.
2. **Optimistic UI needs conflict handling.** With `fbRef.set()` the client always "won."
   Now a `409` or `412` is a normal outcome that the UI must show gracefully — "Frances
   accepted this first" is a screen state that does not exist in Deploy 17 today.
3. **CSP compliance is a rewrite of the event wiring.** API blueprint §9 mandates a CSP
   with no `unsafe-inline`. Deploy 17 is built almost entirely from inline
   `onclick="..."` attributes and inline `<style>`; `renderRequests()` alone generates
   more than a dozen per card, including `onclick='editReq(...JSON...)'` with
   JSON-in-an-attribute. All of it moves to `addEventListener` with `data-` attributes.

   This is mechanical but touches most of the render layer. **Budget it in Phase 3
   explicitly** — it is the sort of task that looks like a detail in a plan and consumes a
   week in reality. The alternative, shipping with `unsafe-inline`, throws away most of
   the XSS protection the rebuild is for.

`esc()` (line 672) already escapes HTML on output, which is good practice worth keeping —
but it is applied per-call-site, so a single missed `esc()` in a new template is an XSS
hole. CSP is the backstop for exactly that.

---

## 9. Reconciliation

Stage E of build plan §17. Migration is not "done" until every query returns zero
variance.

**Count reconciliation** — `audit.vMigrationCounts` versus a `jq` pass over the export:

```bash
jq '{
  employees:    ([.employees[]      | select(.id as $i | ([.removedSeeds.employees[]?] | index($i) | not))] | length),
  clients:      (.clients      | length),
  requests:     (.requests     | length),
  events:       (.events       | length),
  resources:    (.resources    | length),
  photos:       (.photos       | length),
  timeEntries:  ([.tc.entries[]?] | flatten | length),
  activeePunches: (.tc.active  | length),
  activity:     (.activity     | length),
  inboxMessages: ([.inbox[]?]  | flatten | length)
}' deploy17.json
```

**Sum reconciliation — the one that actually protects paychecks.** Counts are necessary
but not sufficient: 192 entries with one truncated duration is still a wrong paycheck.

```bash
jq '[.tc.entries[]? | .[] | .duration] | add / 60000' deploy17.json   # total minutes
```

must equal

```sql
SELECT SUM(DurationMinutes) FROM [time].TimeEntries WHERE EntryStatus <> 3;
```

**Per-employee, not just in total** — offsetting errors cancel in a grand total:

```sql
SELECT * FROM audit.vMigrationTimeTotals ORDER BY WorkEmail;
```

**Full gate checklist:**

| Check | Requirement |
|---|---|
| Employee count | Source (minus tombstones) = SQL, exactly |
| Client count | Exact |
| **Every client has exactly one active assignment** | `COUNT(*) = COUNT(DISTINCT ClientId)` in `vCurrentClientOwner` |
| Time entry count | Exact, including voided |
| **Time entry minutes, per employee** | Exact |
| Request count and per-status counts | Exact |
| PTO balances | `vPtoBalances` = Deploy 17's computed value for all 11 employees |
| Document count and **SHA-256 of every file** | Exact |
| Unresolved names | **Zero** |
| Rows rejected by constraints | Zero, or every one explained in the exception report |
| Legacy activity rows | Exact (whatever survived the 100-cap) |

---

## 10. Cutover sequence

Build plan §19, with the checks that make it reversible.

| # | Step | Verification |
|---|---|---|
| 1 | **Freeze `index.html` as `OGO Portal Legacy v17`** — tag the commit; archive the file, not just the data (§3.1) | Tag pushed; SHA recorded |
| 2 | Announce read-only window; confirm `tc.active` is empty (§7.3) | Zero in-flight punches |
| 3 | Set Firebase RTDB rules to `".write": false` | Write attempt fails |
| 4 | Final export: `firebase database:get /portals/demo/state > deploy17-final.json` | SHA-256 recorded; stored in two locations |
| 5 | Import to **staging** SQL; run every §9 check | Zero variance |
| 6 | Import to **production** SQL | Zero variance, re-run |
| 7 | Extract documents to Spaces; verify hashes | Every hash matches |
| 8 | Issue accounts; force password set + Admin MFA enrolment | All 11 employees enrolled |
| 9 | **Restore test — restore the production backup to a scratch server and query it** | A backup is not a backup until restored (build plan §16) |
| 10 | DNS → new portal | Smoke test from all three offices |
| 11 | Deploy 17 archived read-only, **not destroyed** | Accessible; write-blocked |

**Rollback:** until step 10, rollback is DNS. After step 10 the new system holds punches
and handoffs that Deploy 17 cannot represent — so from that point forward, rollback means
restoring from backup and re-keying, not flipping back. **Step 9 is therefore not
optional and cannot be deferred.** It is the last moment at which the plan is cheaply
reversible.

---

## 11. Summary of blockers

| # | Blocker | Blocks | Owner |
|---|---|---|---|
| 0 | ⚠️ **Re-derive this document against the production file** (§0) | Everything downstream | Claude |
| 1 | ~~Is production the same file as the repo copy?~~ **ANSWERED: no.** Production is a separate 1,977-line build on Netlify | — | ✅ closed |
| 2 | ~~Where do the "9 handoffs" come from?~~ **ANSWERED: production has a real handoff feature** | — | ✅ closed |
| 2b | **Get production into version control.** It is a manual Netlify drop with no Git link, so there is no history and no rollback to a known good build | Stage A of §10 | Gina |
| 3 | Pay period cadence — biweekly or semi-monthly? (§7.1) | Phase 9, historical period generation | OGO payroll |
| 4 | Real work-email addresses for all employees (§4.1) | Phase 3 (accounts) | HR |
| 5 | Quinn Foster's hire date is blank (§4.1) | PTO calc for that employee | HR |
| 6 | Confirm `Filed→EFiled`, `Complete→IrsAccepted` (§4.4) | Phase 5 | Alex Rivera |
| 7 | Tax year for existing workflow rows (§4.4) | Phase 5 | Alex Rivera |
| 8 | Employee numbering scheme (§4.1) | Phase 2 | HR |
| 9 | Departed-employee list + termination dates (§4.1, §6) | Phase 2 | HR |
| 10 | Cutover window outside business hours (§7.3) | Phase 16 | Gina |

Blockers 1 and 2 are the ones to answer this week. Everything downstream is written
assuming an answer to 1 that may be wrong, and that is the cheapest possible moment to
find out — which is exactly the point of building the blueprint before pouring the
concrete.
