# OGO Staff Portal — SQL Server Database Blueprint

**Status:** Draft 1 for review · **Target:** SQL Server 2025 Standard on Ubuntu 24.04
**Companion documents:** [`02-api-blueprint.md`](02-api-blueprint.md) · [`03-deploy17-migration-map.md`](03-deploy17-migration-map.md)

---

## 0. The two questions this schema has to answer

Every table below was designed against the two rules from the build plan:

> **"What happens if two employees do this at the exact same time?"**
> **"Can we prove who did it?"**

The schema answers the first question **at the storage layer**, not only in C#. Three
filtered unique indexes make the dangerous races *physically impossible* rather than
merely unlikely:

| Race | Index that prevents it |
|---|---|
| Two people accept the same handoff → client has two owners | `UX_ClientAssignments_OneActive` |
| One employee clocks in twice (two phones, two tabs) | `UX_TimeEntries_OneOpen` |
| Two handoffs pending on the same client at once | `UX_ClientHandoffs_OnePending` |

If application logic ever has a gap, the database still refuses. The second request
loses with a duplicate-key violation, which the API translates into a clean
`409 Conflict`. That is the difference between "we check first" and "it cannot happen."

The second question is answered by three layers that do different jobs:

| Layer | Answers | Mutable? |
|---|---|---|
| **Temporal tables** | *What* the row looked like at any past instant | No — SQL maintains it |
| **`AuditLog`** | *Who* changed it, from where, and *why* | Append-only |
| **Domain ledgers** (`ClientAssignments`, `PtoTransactions`, `TimeEntryCorrections`) | The business narrative, queryable without time-travel syntax | Append-only |

Temporal tables alone are not enough (they record no actor and no reason). `AuditLog`
alone is not enough (a JSON blob is not a queryable history). We use all three.

---

## 1. Conventions locked in

These apply to every table. They are not negotiable per-table, because inconsistency
here is what makes a schema rot.

| Concern | Decision | Rationale |
|---|---|---|
| **Primary keys** | `int IDENTITY` for entities, `bigint IDENTITY` for high-volume ledgers (`AuditLog`, `Notifications`) | Narrow clustered keys; no GUID page splits |
| **External IDs** | Separate `PublicId uniqueidentifier DEFAULT NEWID()` on entities exposed in URLs | Never leak row counts or let users enumerate clients |
| **Timestamps** | `datetime2(3)`, **always UTC**, always suffixed `Utc` | Removes every DST bug from payroll |
| **Local time** | Derived at read time from `Offices.TimeZoneId` (IANA, e.g. `America/New_York`) | One office could move states; stored UTC stays correct |
| **Money** | `decimal(19,4)` | Never `float` |
| **Hours** | `decimal(9,4)` | 15-minute increments divide cleanly; avoids float drift on sums |
| **Concurrency** | `RowVersion rowversion` on every user-editable entity | Optimistic concurrency → `412 Precondition Failed`, not silent overwrite |
| **Deletion** | No `DELETE` on business data. `IsActive`/`DeletedAtUtc` + `DeletedByEmployeeId` | Deploy 17 hard-deletes punches and clients; that ends here |
| **Strings** | `nvarchar`, never `varchar` | Client names contain accents today |
| **Enums** | `tinyint` column + a lookup table + a `CHECK` | Readable in SQL *and* fast |
| **Booleans** | `bit NOT NULL` with an explicit `DEFAULT` | No tri-state ambiguity |
| **Schemas** | `org`, `hr`, `crm`, `time`, `portal`, `doc`, `audit` | Grant `SELECT` per schema; keeps `dbo` empty |
| **Collation** | `Latin1_General_100_CI_AS_SC_UTF8` | Case-insensitive search, UTF-8 storage |

**Deployment order.** `hr.Employees` carries an FK to `hr.PtoPolicies`, and several
tables reference `hr.Employees` in turn. The EF migration creates tables in dependency
order and adds the circular references (`Employees.PtoPolicyId`, the
`*ByEmployeeId` columns on `org` and `audit` tables) as `ALTER TABLE ... ADD CONSTRAINT`
in a final step. The DDL below is grouped by subject area for reading, not by run order.

**Naming:** singular schema, plural table (`crm.Clients`), FK column = referenced table
singular + `Id` (`ClientId`). Index prefixes: `PK_`, `UX_` (unique), `IX_` (nonclustered),
`FK_`, `CK_`, `DF_`.

---

## 2. Schema map

```
org ──────────── Companies · Offices · OfficeNotes · SystemSettings
 │
hr ───────────── Employees · Roles · Permissions · RolePermissions
 │               EmployeeRoles · EmployeePermissionOverrides
 │               PtoPolicies · PtoPolicyTiers · PtoTransactions
 │               EmployeeRequests
 │
crm ──────────── Clients · ClientContacts · ClientNotes
 │               ClientAssignments · WorkflowStages
 │               ClientWorkflowStatus · ClientWorkflowHistory
 │               ClientHandoffs · HandoffEvents
 │
time ─────────── PayPeriods · TimeEntries · TimeEntryCorrections
 │               PayrollAdjustments
 │
portal ───────── Events · EventResponses · Announcements · Tasks
 │               Notifications · Alerts · AlertDismissals · Messages · Resources
 │
doc ──────────── Documents · DocumentPermissions
 │
audit ────────── AuditLog · LoginHistory · SecurityEvents
```

**Temporal (system-versioned):** `org.Offices`, `org.SystemSettings`, `hr.Employees`,
`crm.Clients`, `crm.ClientWorkflowStatus`, `hr.EmployeePermissionOverrides`.

**Deliberately *not* temporal:** `time.TimeEntries`, `hr.PtoTransactions`,
`crm.ClientAssignments`, `audit.AuditLog`. These are append-only ledgers by design —
system-versioning them would imply rows are expected to change, which is exactly the
behaviour we are removing.

---

## 3. Organization

```sql
CREATE SCHEMA org;
GO

CREATE TABLE org.Companies (
    CompanyId       int IDENTITY(1,1) NOT NULL,
    PublicId        uniqueidentifier NOT NULL CONSTRAINT DF_Companies_PublicId DEFAULT NEWID(),
    Name            nvarchar(200) NOT NULL,
    LegalName       nvarchar(200) NULL,
    DefaultTimeZone nvarchar(64)  NOT NULL CONSTRAINT DF_Companies_Tz DEFAULT N'America/New_York',
    CreatedAtUtc    datetime2(3)  NOT NULL CONSTRAINT DF_Companies_Created DEFAULT SYSUTCDATETIME(),
    RowVersion      rowversion    NOT NULL,
    CONSTRAINT PK_Companies PRIMARY KEY CLUSTERED (CompanyId)
);
```

`Offices` is temporal because an office's address, manager, hours and **geofence** all
change, and a payroll dispute six months from now needs to know what the geofence
radius was *on the day of the punch* — not what it is today.

```sql
CREATE TABLE org.Offices (
    OfficeId              int IDENTITY(1,1) NOT NULL,
    PublicId              uniqueidentifier NOT NULL CONSTRAINT DF_Offices_PublicId DEFAULT NEWID(),
    CompanyId             int NOT NULL,
    Code                  nvarchar(20)  NOT NULL,   -- 'ORL', 'CLR', 'WHV'
    Name                  nvarchar(100) NOT NULL,
    Phone                 nvarchar(32)  NULL,
    Email                 nvarchar(256) NULL,
    AddressLine1          nvarchar(200) NULL,
    AddressLine2          nvarchar(200) NULL,
    City                  nvarchar(100) NULL,
    StateCode             char(2)       NULL,
    PostalCode            nvarchar(12)  NULL,
    TimeZoneId            nvarchar(64)  NOT NULL CONSTRAINT DF_Offices_Tz DEFAULT N'America/New_York',
    Latitude              decimal(9,6)  NULL,
    Longitude             decimal(9,6)  NULL,
    GeofenceRadiusMeters  int           NULL CONSTRAINT DF_Offices_Geo DEFAULT 500,
    GeofenceEnforced      bit           NOT NULL CONSTRAINT DF_Offices_GeoEnf DEFAULT 1,
    OpenTimeLocal         time(0)       NULL,
    CloseTimeLocal        time(0)       NULL,
    Notes                 nvarchar(1000) NULL,
    IsActive              bit           NOT NULL CONSTRAINT DF_Offices_Active DEFAULT 1,
    RowVersion            rowversion    NOT NULL,
    ValidFrom             datetime2(3) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
    ValidTo               datetime2(3) GENERATED ALWAYS AS ROW END   HIDDEN NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo),
    CONSTRAINT PK_Offices PRIMARY KEY CLUSTERED (OfficeId),
    CONSTRAINT UX_Offices_Code UNIQUE (CompanyId, Code),
    CONSTRAINT FK_Offices_Company FOREIGN KEY (CompanyId) REFERENCES org.Companies(CompanyId),
    CONSTRAINT CK_Offices_Geo CHECK (
        (Latitude IS NULL AND Longitude IS NULL)
     OR (Latitude BETWEEN -90 AND 90 AND Longitude BETWEEN -180 AND 180))
) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = org.OfficesHistory));
```

> **Note on office identity.** Deploy 17 keys offices by their display name
> (`S.offices['Winter Haven']`). Renaming an office there would orphan every employee,
> client, event and punch that referenced the old string. Here the name is just an
> attribute; `OfficeId` is identity. See migration map §3.2.

`SystemSettings` replaces the hardcoded constants in Deploy 17 (`ADMIN_PW`, `GEO`,
pay-period anchor, session timeouts). Temporal, so "who loosened the idle timeout and
when" is answerable.

```sql
CREATE TABLE org.SystemSettings (
    SettingKey    nvarchar(128) NOT NULL,
    SettingValue  nvarchar(4000) NULL,
    ValueType     nvarchar(20)  NOT NULL CONSTRAINT DF_Settings_Type DEFAULT N'string',
    Description   nvarchar(500) NULL,
    IsSecret      bit           NOT NULL CONSTRAINT DF_Settings_Secret DEFAULT 0,
    UpdatedByEmployeeId int     NULL,
    UpdatedAtUtc  datetime2(3)  NOT NULL CONSTRAINT DF_Settings_Upd DEFAULT SYSUTCDATETIME(),
    ValidFrom     datetime2(3) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
    ValidTo       datetime2(3) GENERATED ALWAYS AS ROW END   HIDDEN NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo),
    CONSTRAINT PK_SystemSettings PRIMARY KEY CLUSTERED (SettingKey),
    CONSTRAINT CK_Settings_Type CHECK (ValueType IN (N'string',N'int',N'bool',N'json',N'decimal'))
) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = org.SystemSettingsHistory));
```

**`IsSecret` is a redaction flag, not encryption.** It marks rows the API must never
return and the audit log must never capture. Actual secrets (connection strings, S3
keys, signing keys) live in environment variables / a secret store — never in this table.

---

## 4. Identity, roles and permissions

`hr.Employees` is the HR record. Authentication lives in ASP.NET Core Identity's own
tables (`AspNetUsers` et al., created by its EF migration into schema `auth`). The two
are linked one-to-one and **kept separate on purpose**: a terminated employee keeps their
HR row and their whole payroll history forever, while their login row is disabled.

```sql
CREATE SCHEMA hr;
GO

CREATE TABLE hr.Employees (
    EmployeeId       int IDENTITY(1,1) NOT NULL,
    PublicId         uniqueidentifier NOT NULL CONSTRAINT DF_Employees_PublicId DEFAULT NEWID(),
    CompanyId        int NOT NULL,
    PrimaryOfficeId  int NOT NULL,
    UserId           nvarchar(450) NULL,          -- FK -> auth.AspNetUsers.Id; NULL = no portal login
    EmployeeNumber   nvarchar(20)  NOT NULL,
    FirstName        nvarchar(100) NOT NULL,
    LastName         nvarchar(100) NOT NULL,
    PreferredName    nvarchar(100) NULL,
    WorkEmail        nvarchar(256) NOT NULL,
    PersonalEmail    nvarchar(256) NULL,
    Phone            nvarchar(32)  NULL,
    DateOfBirth      date          NULL,
    HireDate         date          NULL,
    TerminationDate  date          NULL,
    JobTitle         nvarchar(120) NULL,
    EmploymentType   tinyint       NOT NULL CONSTRAINT DF_Employees_EmpType DEFAULT 2, -- 1=Salaried 2=Hourly
    EmploymentStatus tinyint       NOT NULL CONSTRAINT DF_Employees_Status  DEFAULT 1, -- 1=Active 2=OnLeave 3=Terminated
    PtoPolicyId      int           NULL,
    ShowBirthdayInDirectory bit    NOT NULL CONSTRAINT DF_Employees_ShowBday DEFAULT 1,
    CreatedAtUtc     datetime2(3)  NOT NULL CONSTRAINT DF_Employees_Created DEFAULT SYSUTCDATETIME(),
    RowVersion       rowversion    NOT NULL,
    ValidFrom        datetime2(3) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
    ValidTo          datetime2(3) GENERATED ALWAYS AS ROW END   HIDDEN NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo),
    CONSTRAINT PK_Employees PRIMARY KEY CLUSTERED (EmployeeId),
    CONSTRAINT UX_Employees_Number UNIQUE (CompanyId, EmployeeNumber),
    CONSTRAINT UX_Employees_WorkEmail UNIQUE (WorkEmail),
    CONSTRAINT FK_Employees_Company FOREIGN KEY (CompanyId) REFERENCES org.Companies(CompanyId),
    CONSTRAINT FK_Employees_Office  FOREIGN KEY (PrimaryOfficeId) REFERENCES org.Offices(OfficeId),
    CONSTRAINT FK_Employees_Pto     FOREIGN KEY (PtoPolicyId) REFERENCES hr.PtoPolicies(PtoPolicyId),
    CONSTRAINT CK_Employees_EmpType CHECK (EmploymentType IN (1,2)),
    CONSTRAINT CK_Employees_Status  CHECK (EmploymentStatus IN (1,2,3)),
    CONSTRAINT CK_Employees_Term    CHECK (
        (EmploymentStatus = 3 AND TerminationDate IS NOT NULL)
     OR (EmploymentStatus <> 3 AND TerminationDate IS NULL))
) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = hr.EmployeesHistory));

CREATE UNIQUE INDEX UX_Employees_UserId ON hr.Employees(UserId) WHERE UserId IS NOT NULL;
CREATE INDEX IX_Employees_Office_Status ON hr.Employees(PrimaryOfficeId, EmploymentStatus)
    INCLUDE (FirstName, LastName, JobTitle);
```

`CK_Employees_Term` is the constraint that makes build-plan §12 real: you cannot mark
someone Terminated without recording *when*, and you cannot leave a termination date on
an active employee. Termination is a status change, never a `DELETE`.

### 4.1 Permissions

Roles are bundles; permissions are the currency. The server authorizes on
**permissions**, never on role name — so adding a fourth role later changes no
authorization code.

```sql
CREATE TABLE hr.Permissions (
    PermissionId int IDENTITY(1,1) NOT NULL,
    Code         nvarchar(80)  NOT NULL,   -- 'Client.ViewAssigned'
    Category     nvarchar(40)  NOT NULL,   -- 'Client'
    Description  nvarchar(300) NOT NULL,
    IsOfficeScoped bit NOT NULL CONSTRAINT DF_Perm_Scoped DEFAULT 0,
    CONSTRAINT PK_Permissions PRIMARY KEY CLUSTERED (PermissionId),
    CONSTRAINT UX_Permissions_Code UNIQUE (Code)
);

CREATE TABLE hr.Roles (
    RoleId      int IDENTITY(1,1) NOT NULL,
    Code        nvarchar(40)  NOT NULL,   -- 'Staff','Manager','Admin'
    Name        nvarchar(80)  NOT NULL,
    Description nvarchar(300) NULL,
    RankOrder   int NOT NULL CONSTRAINT DF_Roles_Rank DEFAULT 100,
    IsSystem    bit NOT NULL CONSTRAINT DF_Roles_System DEFAULT 0,
    CONSTRAINT PK_Roles PRIMARY KEY CLUSTERED (RoleId),
    CONSTRAINT UX_Roles_Code UNIQUE (Code)
);

CREATE TABLE hr.RolePermissions (
    RoleId       int NOT NULL,
    PermissionId int NOT NULL,
    CONSTRAINT PK_RolePermissions PRIMARY KEY CLUSTERED (RoleId, PermissionId),
    CONSTRAINT FK_RolePerm_Role FOREIGN KEY (RoleId) REFERENCES hr.Roles(RoleId),
    CONSTRAINT FK_RolePerm_Perm FOREIGN KEY (PermissionId) REFERENCES hr.Permissions(PermissionId)
);
```

A role grant is **scoped** and **time-bounded** — an interim manager covering Clermont
for two months is a first-class concept, not a note in someone's inbox:

```sql
CREATE TABLE hr.EmployeeRoles (
    EmployeeRoleId int IDENTITY(1,1) NOT NULL,
    EmployeeId     int NOT NULL,
    RoleId         int NOT NULL,
    ScopeType      tinyint NOT NULL CONSTRAINT DF_EmpRoles_Scope DEFAULT 1, -- 1=Own 2=Office 3=Company
    ScopeOfficeId  int NULL,
    GrantedAtUtc   datetime2(3) NOT NULL CONSTRAINT DF_EmpRoles_Granted DEFAULT SYSUTCDATETIME(),
    GrantedByEmployeeId int NULL,
    RevokedAtUtc   datetime2(3) NULL,
    RevokedByEmployeeId int NULL,
    RevokeReason   nvarchar(300) NULL,
    CONSTRAINT PK_EmployeeRoles PRIMARY KEY CLUSTERED (EmployeeRoleId),
    CONSTRAINT FK_EmpRoles_Employee FOREIGN KEY (EmployeeId) REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT FK_EmpRoles_Role     FOREIGN KEY (RoleId)     REFERENCES hr.Roles(RoleId),
    CONSTRAINT FK_EmpRoles_Office   FOREIGN KEY (ScopeOfficeId) REFERENCES org.Offices(OfficeId),
    CONSTRAINT CK_EmpRoles_Scope CHECK (
        (ScopeType = 2 AND ScopeOfficeId IS NOT NULL)
     OR (ScopeType <> 2 AND ScopeOfficeId IS NULL))
);

CREATE UNIQUE INDEX UX_EmployeeRoles_ActiveGrant
    ON hr.EmployeeRoles(EmployeeId, RoleId, ScopeType, ScopeOfficeId)
    WHERE RevokedAtUtc IS NULL;
```

Per-person exceptions ("Sam can approve PTO while Dana is out") use an override table
with an explicit **Deny beats Grant** rule, evaluated in the API:

```sql
CREATE TABLE hr.EmployeePermissionOverrides (
    OverrideId   int IDENTITY(1,1) NOT NULL,
    EmployeeId   int NOT NULL,
    PermissionId int NOT NULL,
    Effect       tinyint NOT NULL,          -- 1=Grant 2=Deny
    ScopeOfficeId int NULL,
    Reason       nvarchar(300) NOT NULL,
    GrantedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_PermOv_Granted DEFAULT SYSUTCDATETIME(),
    GrantedByEmployeeId int NOT NULL,
    ExpiresAtUtc datetime2(3) NULL,
    RevokedAtUtc datetime2(3) NULL,
    ValidFrom    datetime2(3) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
    ValidTo      datetime2(3) GENERATED ALWAYS AS ROW END   HIDDEN NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo),
    CONSTRAINT PK_PermOverrides PRIMARY KEY CLUSTERED (OverrideId),
    CONSTRAINT FK_PermOv_Employee FOREIGN KEY (EmployeeId) REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT FK_PermOv_Perm     FOREIGN KEY (PermissionId) REFERENCES hr.Permissions(PermissionId),
    CONSTRAINT CK_PermOv_Effect CHECK (Effect IN (1,2))
) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = hr.EmployeePermissionOverridesHistory));
```

**Seed permission set** (matches build plan §11 exactly; API blueprint §3 maps each
endpoint to one of these):

| Category | Codes |
|---|---|
| Client | `Client.ViewAssigned` `Client.EditAssigned` `Client.ViewOffice` `Client.ViewAll` `Client.Create` `Client.Archive` |
| Handoff | `Handoff.Send` `Handoff.Accept` `Handoff.ViewOffice` `Handoff.ForceReassign` |
| TimeClock | `TimeClock.Own` `TimeClock.Review` `TimeClock.Correct` |
| PTO | `PTO.Request` `PTO.Approve` `PTO.AdjustBalance` |
| Payroll | `Payroll.View` `Payroll.Lock` `Payroll.Adjust` |
| Employee | `Employee.ViewDirectory` `Employee.Manage` `Employee.Terminate` |
| Reports | `Reports.Office` `Reports.All` |
| Documents | `Document.ViewClient` `Document.Upload` `Document.Delete` |
| System | `Permissions.Manage` `System.Manage` `Audit.View` |

`Handoff.ForceReassign` exists because the ordinary handoff needs the recipient to
accept — but when someone leaves abruptly, an Admin must be able to move their book of
clients without a dead person clicking a button. It is a separate, heavily-audited
permission, not a side effect of `Employee.Terminate`.

---

## 5. Clients and the ownership ledger

```sql
CREATE SCHEMA crm;
GO

CREATE TABLE crm.Clients (
    ClientId      int IDENTITY(1,1) NOT NULL,
    PublicId      uniqueidentifier NOT NULL CONSTRAINT DF_Clients_PublicId DEFAULT NEWID(),
    CompanyId     int NOT NULL,
    OfficeId      int NOT NULL,
    ClientNumber  nvarchar(20)  NOT NULL,
    LegalName     nvarchar(200) NOT NULL,
    DisplayName   nvarchar(200) NOT NULL,
    ClientType    tinyint       NOT NULL CONSTRAINT DF_Clients_Type DEFAULT 1, -- 1=Individual 2=Business
    TaxIdLast4    char(4)       NULL,
    ClientStatus  tinyint       NOT NULL CONSTRAINT DF_Clients_Status DEFAULT 1, -- 1=Active 2=WaitingDocs 3=OnHold 4=Closed
    ExternalRef   nvarchar(100) NULL,      -- TaxDome id
    CreatedAtUtc  datetime2(3)  NOT NULL CONSTRAINT DF_Clients_Created DEFAULT SYSUTCDATETIME(),
    CreatedByEmployeeId int NULL,
    ArchivedAtUtc datetime2(3)  NULL,
    ArchivedByEmployeeId int NULL,
    RowVersion    rowversion    NOT NULL,
    ValidFrom     datetime2(3) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
    ValidTo       datetime2(3) GENERATED ALWAYS AS ROW END   HIDDEN NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo),
    CONSTRAINT PK_Clients PRIMARY KEY CLUSTERED (ClientId),
    CONSTRAINT UX_Clients_Number UNIQUE (CompanyId, ClientNumber),
    CONSTRAINT FK_Clients_Company FOREIGN KEY (CompanyId) REFERENCES org.Companies(CompanyId),
    CONSTRAINT FK_Clients_Office  FOREIGN KEY (OfficeId)  REFERENCES org.Offices(OfficeId),
    CONSTRAINT CK_Clients_Status  CHECK (ClientStatus IN (1,2,3,4))
) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = crm.ClientsHistory));
```

**Note what is missing: there is no `OwnerEmployeeId` column on `Clients`.** That is
deliberate and it is the single most important structural change in this blueprint.
Ownership is not an attribute of a client; it is a *relationship over time*. It lives in
`ClientAssignments`, and the current owner is derived:

```sql
CREATE TABLE crm.ClientAssignments (
    ClientAssignmentId int IDENTITY(1,1) NOT NULL,
    ClientId       int NOT NULL,
    EmployeeId     int NOT NULL,
    AssignmentRole tinyint NOT NULL CONSTRAINT DF_CliAsg_Role DEFAULT 1, -- 1=Owner 2=Preparer 3=Reviewer
    StartedAtUtc   datetime2(3) NOT NULL CONSTRAINT DF_CliAsg_Started DEFAULT SYSUTCDATETIME(),
    StartReason    tinyint NOT NULL,   -- 1=InitialAssignment 2=AcceptedHandoff 3=AdminReassign 4=Migration
    StartedByEmployeeId int NULL,
    EndedAtUtc     datetime2(3) NULL,
    EndReason      tinyint NULL,       -- 1=HandedOff 2=AdminReassign 3=Termination 4=ClientClosed
    EndedByEmployeeId int NULL,
    SourceHandoffId int NULL,
    Note           nvarchar(500) NULL,
    CONSTRAINT PK_ClientAssignments PRIMARY KEY CLUSTERED (ClientAssignmentId),
    CONSTRAINT FK_CliAsg_Client   FOREIGN KEY (ClientId)   REFERENCES crm.Clients(ClientId),
    CONSTRAINT FK_CliAsg_Employee FOREIGN KEY (EmployeeId) REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT CK_CliAsg_Window   CHECK (EndedAtUtc IS NULL OR EndedAtUtc >= StartedAtUtc),
    CONSTRAINT CK_CliAsg_EndPair  CHECK (
        (EndedAtUtc IS NULL AND EndReason IS NULL)
     OR (EndedAtUtc IS NOT NULL AND EndReason IS NOT NULL))
);

-- ══ THE CONSTRAINT THAT MAKES DOUBLE-ACCEPT IMPOSSIBLE ══
CREATE UNIQUE INDEX UX_ClientAssignments_OneActive
    ON crm.ClientAssignments(ClientId, AssignmentRole)
    WHERE EndedAtUtc IS NULL;

CREATE INDEX IX_CliAsg_Employee_Active
    ON crm.ClientAssignments(EmployeeId, EndedAtUtc) INCLUDE (ClientId, StartedAtUtc);
CREATE INDEX IX_CliAsg_Client_History
    ON crm.ClientAssignments(ClientId, StartedAtUtc DESC);
```

This answers build-plan §5's question directly. "Who had ABC Services on August 20?" is
one index seek:

```sql
SELECT e.FirstName, e.LastName, a.StartedAtUtc, a.EndedAtUtc
FROM   crm.ClientAssignments a
JOIN   hr.Employees e ON e.EmployeeId = a.EmployeeId
WHERE  a.ClientId = @ClientId
  AND  a.AssignmentRole = 1
  AND  a.StartedAtUtc <= @AsOfUtc
  AND  (a.EndedAtUtc IS NULL OR a.EndedAtUtc > @AsOfUtc);
```

The current owner, for list screens, comes from a view so no query ever re-derives it:

```sql
CREATE VIEW crm.vCurrentClientOwner AS
SELECT a.ClientId, a.EmployeeId AS OwnerEmployeeId, a.StartedAtUtc AS OwnedSinceUtc,
       a.ClientAssignmentId
FROM   crm.ClientAssignments a
WHERE  a.EndedAtUtc IS NULL AND a.AssignmentRole = 1;
```

### 5.1 Contacts, notes, workflow

```sql
CREATE TABLE crm.ClientContacts (
    ClientContactId int IDENTITY(1,1) NOT NULL,
    ClientId    int NOT NULL,
    FullName    nvarchar(200) NOT NULL,
    ContactRole nvarchar(80)  NULL,        -- 'Spouse', 'Bookkeeper', 'Controller'
    Email       nvarchar(256) NULL,
    Phone       nvarchar(32)  NULL,
    IsPrimary   bit NOT NULL CONSTRAINT DF_CliContact_Primary DEFAULT 0,
    Notes       nvarchar(1000) NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CliContact_Created DEFAULT SYSUTCDATETIME(),
    CreatedByEmployeeId int NULL,
    DeletedAtUtc datetime2(3) NULL,
    DeletedByEmployeeId int NULL,
    RowVersion  rowversion NOT NULL,
    CONSTRAINT PK_ClientContacts PRIMARY KEY CLUSTERED (ClientContactId),
    CONSTRAINT FK_CliContact_Client FOREIGN KEY (ClientId) REFERENCES crm.Clients(ClientId)
);

CREATE UNIQUE INDEX UX_ClientContacts_OnePrimary
    ON crm.ClientContacts(ClientId) WHERE IsPrimary = 1 AND DeletedAtUtc IS NULL;

CREATE TABLE crm.ClientNotes (
    ClientNoteId bigint IDENTITY(1,1) NOT NULL,
    ClientId     int NOT NULL,
    AuthorEmployeeId int NOT NULL,
    Body         nvarchar(max) NOT NULL,
    Visibility   tinyint NOT NULL CONSTRAINT DF_CliNote_Vis DEFAULT 1, -- 1=Team 2=ManagersOnly
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CliNote_Created DEFAULT SYSUTCDATETIME(),
    EditedAtUtc  datetime2(3) NULL,
    DeletedAtUtc datetime2(3) NULL,
    DeletedByEmployeeId int NULL,
    CONSTRAINT PK_ClientNotes PRIMARY KEY CLUSTERED (ClientNoteId),
    CONSTRAINT FK_CliNote_Client FOREIGN KEY (ClientId) REFERENCES crm.Clients(ClientId)
);
CREATE INDEX IX_ClientNotes_Client ON crm.ClientNotes(ClientId, CreatedAtUtc DESC) WHERE DeletedAtUtc IS NULL;
```

Workflow stages are data, not a hardcoded dropdown, so OGO can add a stage without a
deploy:

```sql
CREATE TABLE crm.WorkflowStages (
    WorkflowStageId int IDENTITY(1,1) NOT NULL,
    Code       nvarchar(40)  NOT NULL,   -- 'PendingDocuments','ReadyForReview','WaitingAuthorization','EFiled','IrsAccepted'
    Name       nvarchar(80)  NOT NULL,
    SortOrder  int NOT NULL,
    IsTerminal bit NOT NULL CONSTRAINT DF_Stage_Terminal DEFAULT 0,
    IsActive   bit NOT NULL CONSTRAINT DF_Stage_Active DEFAULT 1,
    CONSTRAINT PK_WorkflowStages PRIMARY KEY CLUSTERED (WorkflowStageId),
    CONSTRAINT UX_WorkflowStages_Code UNIQUE (Code)
);

-- Current position: one row per client per tax year. Temporal gives point-in-time.
CREATE TABLE crm.ClientWorkflowStatus (
    ClientWorkflowStatusId int IDENTITY(1,1) NOT NULL,
    ClientId        int NOT NULL,
    TaxYear         smallint NOT NULL,
    WorkflowStageId int NOT NULL,
    EnteredAtUtc    datetime2(3) NOT NULL CONSTRAINT DF_CliWf_Entered DEFAULT SYSUTCDATETIME(),
    EnteredByEmployeeId int NULL,
    DueDate         date NULL,
    RowVersion      rowversion NOT NULL,
    ValidFrom       datetime2(3) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
    ValidTo         datetime2(3) GENERATED ALWAYS AS ROW END   HIDDEN NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo),
    CONSTRAINT PK_ClientWorkflowStatus PRIMARY KEY CLUSTERED (ClientWorkflowStatusId),
    CONSTRAINT UX_CliWf_ClientYear UNIQUE (ClientId, TaxYear),
    CONSTRAINT FK_CliWf_Client FOREIGN KEY (ClientId) REFERENCES crm.Clients(ClientId),
    CONSTRAINT FK_CliWf_Stage  FOREIGN KEY (WorkflowStageId) REFERENCES crm.WorkflowStages(WorkflowStageId)
) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = crm.ClientWorkflowStatusHistory));

-- Explicit narrative: every transition, with actor and reason. Queryable without FOR SYSTEM_TIME.
CREATE TABLE crm.ClientWorkflowHistory (
    ClientWorkflowHistoryId bigint IDENTITY(1,1) NOT NULL,
    ClientId    int NOT NULL,
    TaxYear     smallint NOT NULL,
    FromStageId int NULL,                 -- NULL = first entry into workflow
    ToStageId   int NOT NULL,
    ChangedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CliWfH_Changed DEFAULT SYSUTCDATETIME(),
    ChangedByEmployeeId int NOT NULL,
    Reason      nvarchar(500) NULL,
    DurationInPreviousStageMinutes int NULL,
    CONSTRAINT PK_ClientWorkflowHistory PRIMARY KEY CLUSTERED (ClientWorkflowHistoryId),
    CONSTRAINT FK_CliWfH_Client FOREIGN KEY (ClientId) REFERENCES crm.Clients(ClientId)
);
CREATE INDEX IX_CliWfH_Client ON crm.ClientWorkflowHistory(ClientId, TaxYear, ChangedAtUtc DESC);
```

`DurationInPreviousStageMinutes` is written at transition time. It turns "how long do
clients sit in Waiting for Authorization?" into a `SELECT AVG(...)` instead of a
self-join across time — the single report a tax firm most wants.

---

## 6. The handoff engine

This is build-plan §4, and it is the workflow the whole architecture is being justified
by. Deploy 17 has **no handoff feature at all** (see migration map §5) — so this is new
construction, not a port.

```sql
CREATE TABLE crm.ClientHandoffs (
    HandoffId       int IDENTITY(1,1) NOT NULL,
    HandoffNumber   AS (CONCAT(N'HF-', FORMAT(HandoffId, N'0000'))) PERSISTED,
    PublicId        uniqueidentifier NOT NULL CONSTRAINT DF_Handoff_PublicId DEFAULT NEWID(),
    ClientId        int NOT NULL,
    FromEmployeeId  int NOT NULL,
    ToEmployeeId    int NOT NULL,
    HandoffStatus   tinyint NOT NULL CONSTRAINT DF_Handoff_Status DEFAULT 0,
        -- 0=Pending 1=Accepted 2=Declined 3=Cancelled 4=Expired 5=Superseded
    Message         nvarchar(1000) NULL,
    InitiatedAtUtc  datetime2(3) NOT NULL CONSTRAINT DF_Handoff_Init DEFAULT SYSUTCDATETIME(),
    InitiatedByEmployeeId int NOT NULL,
    ExpiresAtUtc    datetime2(3) NULL,
    RespondedAtUtc  datetime2(3) NULL,
    RespondedByEmployeeId int NULL,
    ResponseNote    nvarchar(1000) NULL,
    SourceAssignmentId int NULL,      -- assignment being closed; guards against stale accepts
    RowVersion      rowversion NOT NULL,
    CONSTRAINT PK_ClientHandoffs PRIMARY KEY CLUSTERED (HandoffId),
    CONSTRAINT FK_Handoff_Client FOREIGN KEY (ClientId) REFERENCES crm.Clients(ClientId),
    CONSTRAINT FK_Handoff_From   FOREIGN KEY (FromEmployeeId) REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT FK_Handoff_To     FOREIGN KEY (ToEmployeeId)   REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT CK_Handoff_Status CHECK (HandoffStatus IN (0,1,2,3,4,5)),
    CONSTRAINT CK_Handoff_NotSelf CHECK (FromEmployeeId <> ToEmployeeId),
    CONSTRAINT CK_Handoff_Response CHECK (
        (HandoffStatus = 0 AND RespondedAtUtc IS NULL)
     OR (HandoffStatus <> 0 AND RespondedAtUtc IS NOT NULL))
);

-- ══ ONE PENDING HANDOFF PER CLIENT — no racing offers ══
CREATE UNIQUE INDEX UX_ClientHandoffs_OnePending
    ON crm.ClientHandoffs(ClientId) WHERE HandoffStatus = 0;

CREATE INDEX IX_Handoff_ToEmployee_Pending
    ON crm.ClientHandoffs(ToEmployeeId, HandoffStatus) INCLUDE (ClientId, InitiatedAtUtc);

CREATE TABLE crm.HandoffEvents (
    HandoffEventId bigint IDENTITY(1,1) NOT NULL,
    HandoffId      int NOT NULL,
    EventType      tinyint NOT NULL,   -- 1=Initiated 2=Viewed 3=Accepted 4=Declined 5=Cancelled 6=Expired 7=Reminded
    ActorEmployeeId int NULL,          -- NULL = system (expiry sweep)
    OccurredAtUtc  datetime2(3) NOT NULL CONSTRAINT DF_HandoffEv_At DEFAULT SYSUTCDATETIME(),
    Detail         nvarchar(1000) NULL,
    ActorIp        nvarchar(45) NULL,
    CONSTRAINT PK_HandoffEvents PRIMARY KEY CLUSTERED (HandoffEventId),
    CONSTRAINT FK_HandoffEv_Handoff FOREIGN KEY (HandoffId) REFERENCES crm.ClientHandoffs(HandoffId)
);
CREATE INDEX IX_HandoffEvents_Handoff ON crm.HandoffEvents(HandoffId, OccurredAtUtc);
```

### 6.1 The accept transaction

Exactly the eight steps in build-plan §4, as one atomic unit. `SERIALIZABLE` plus
`UPDLOCK` on the first read means a second concurrent accept blocks at step 1 rather
than reading stale state and racing to step 5.

```sql
CREATE OR ALTER PROCEDURE crm.usp_AcceptHandoff
    @HandoffId          int,
    @ActingEmployeeId   int,
    @ResponseNote       nvarchar(1000) = NULL,
    @ActorIp            nvarchar(45)   = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;                       -- any error rolls the whole thing back
    SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;

    BEGIN TRANSACTION;

    -- 1-4. Lock and validate: handoff exists, is Pending, is addressed to the caller,
    --      and the sender still holds the active Owner assignment.
    DECLARE @ClientId int, @FromEmployeeId int, @ToEmployeeId int,
            @Status tinyint, @ExpiresAtUtc datetime2(3);

    SELECT @ClientId       = h.ClientId,
           @FromEmployeeId = h.FromEmployeeId,
           @ToEmployeeId   = h.ToEmployeeId,
           @Status         = h.HandoffStatus,
           @ExpiresAtUtc   = h.ExpiresAtUtc
    FROM   crm.ClientHandoffs h WITH (UPDLOCK, HOLDLOCK)
    WHERE  h.HandoffId = @HandoffId;

    IF @ClientId IS NULL
        THROW 50404, N'Handoff not found.', 1;
    IF @Status <> 0
        THROW 50409, N'Handoff is no longer pending.', 1;
    IF @ToEmployeeId <> @ActingEmployeeId
        THROW 50403, N'This handoff is not addressed to you.', 1;
    IF @ExpiresAtUtc IS NOT NULL AND @ExpiresAtUtc <= SYSUTCDATETIME()
        THROW 50410, N'Handoff has expired.', 1;

    DECLARE @SourceAssignmentId int;
    SELECT @SourceAssignmentId = a.ClientAssignmentId
    FROM   crm.ClientAssignments a WITH (UPDLOCK, HOLDLOCK)
    WHERE  a.ClientId = @ClientId
      AND  a.AssignmentRole = 1
      AND  a.EndedAtUtc IS NULL;

    IF @SourceAssignmentId IS NULL
        THROW 50409, N'Client has no active owner; cannot transfer.', 1;
    IF NOT EXISTS (SELECT 1 FROM crm.ClientAssignments
                   WHERE ClientAssignmentId = @SourceAssignmentId
                     AND EmployeeId = @FromEmployeeId)
        THROW 50409, N'Ownership changed since this handoff was sent.', 1;

    DECLARE @Now datetime2(3) = SYSUTCDATETIME();

    -- 5. Mark handoff Accepted
    UPDATE crm.ClientHandoffs
    SET    HandoffStatus = 1,
           RespondedAtUtc = @Now,
           RespondedByEmployeeId = @ActingEmployeeId,
           ResponseNote = @ResponseNote,
           SourceAssignmentId = @SourceAssignmentId
    WHERE  HandoffId = @HandoffId;

    -- 6. Close the sender's assignment
    UPDATE crm.ClientAssignments
    SET    EndedAtUtc = @Now,
           EndReason  = 1,                       -- HandedOff
           EndedByEmployeeId = @ActingEmployeeId
    WHERE  ClientAssignmentId = @SourceAssignmentId;

    -- 7. Open the recipient's assignment.
    --    UX_ClientAssignments_OneActive makes a concurrent duplicate impossible.
    INSERT crm.ClientAssignments
        (ClientId, EmployeeId, AssignmentRole, StartedAtUtc,
         StartReason, StartedByEmployeeId, SourceHandoffId)
    VALUES (@ClientId, @ActingEmployeeId, 1, @Now, 2, @ActingEmployeeId, @HandoffId);

    -- 8. Event trail + audit
    INSERT crm.HandoffEvents (HandoffId, EventType, ActorEmployeeId, OccurredAtUtc, Detail, ActorIp)
    VALUES (@HandoffId, 3, @ActingEmployeeId, @Now, @ResponseNote, @ActorIp);

    INSERT audit.AuditLog
        (OccurredAtUtc, ActorEmployeeId, ActorIp, Action, EntityType, EntityId, Summary)
    VALUES (@Now, @ActingEmployeeId, @ActorIp, N'Handoff.Accepted', N'Client', @ClientId,
            CONCAT(N'Client ', @ClientId, N' transferred from employee ',
                   @FromEmployeeId, N' to ', @ActingEmployeeId,
                   N' via handoff ', @HandoffId, N'.'));

    COMMIT TRANSACTION;

    -- Notification to the sender is queued by the API after commit, never inside it:
    -- an email must not be sendable for a transaction that later rolls back.
    SELECT @ClientId AS ClientId, @FromEmployeeId AS NotifyEmployeeId;
END;
```

**Why the notification is outside the transaction.** If we sent it inside and the commit
failed, Gina gets "Frances accepted" for a transfer that never happened. The procedure
returns who to notify; the API enqueues after `COMMIT` succeeds.

**Deadlock policy.** Two handoffs touching the same two employees in opposite directions
can deadlock. The API retries `usp_AcceptHandoff` up to 3 times on SQL error 1205 with
exponential backoff, then returns `409`. The procedure is safe to retry because it is
all-or-nothing.

---

## 7. Time clock and payroll

### 7.1 Server time is the only time

`ClockInUtc` has **no default from the client**. The API passes `SYSUTCDATETIME()`;
the DTO for clock-in has no time field at all, so there is nothing for a tampered
client to send. Build-plan §7, enforced by the shape of the schema.

```sql
CREATE SCHEMA [time];
GO

CREATE TABLE [time].PayPeriods (
    PayPeriodId     int IDENTITY(1,1) NOT NULL,
    CompanyId       int NOT NULL,
    PeriodStartDate date NOT NULL,
    PeriodEndDate   date NOT NULL,
    PayDate         date NULL,
    PeriodStatus    tinyint NOT NULL CONSTRAINT DF_PayPeriod_Status DEFAULT 1,
        -- 1=Open 2=InReview 3=Locked 4=Paid
    LockedAtUtc     datetime2(3) NULL,
    LockedByEmployeeId int NULL,
    PaidAtUtc       datetime2(3) NULL,
    RowVersion      rowversion NOT NULL,
    CONSTRAINT PK_PayPeriods PRIMARY KEY CLUSTERED (PayPeriodId),
    CONSTRAINT UX_PayPeriods_Range UNIQUE (CompanyId, PeriodStartDate),
    CONSTRAINT FK_PayPeriods_Company FOREIGN KEY (CompanyId) REFERENCES org.Companies(CompanyId),
    CONSTRAINT CK_PayPeriods_Order  CHECK (PeriodEndDate >= PeriodStartDate),
    CONSTRAINT CK_PayPeriods_Status CHECK (PeriodStatus IN (1,2,3,4)),
    CONSTRAINT CK_PayPeriods_Lock   CHECK (
        (PeriodStatus IN (3,4) AND LockedAtUtc IS NOT NULL AND LockedByEmployeeId IS NOT NULL)
     OR (PeriodStatus IN (1,2) AND LockedAtUtc IS NULL))
);
```

> ⚠️ **Open decision — pay period cadence.** Deploy 17's `getPPs()` generates
> **biweekly** periods anchored to 2026-03-15 (14-day spans). The build plan §9 shows
> **semi-monthly** ("08/16/2026 – 08/31/2026"). These produce different paychecks and
> different overtime boundaries. `PayPeriods` is a table precisely so this is
> configuration rather than code — but OGO must confirm the real cadence before Phase 9,
> and the migration must generate historical periods on the real one. See migration
> map §7.1.

```sql
CREATE TABLE [time].TimeEntries (
    TimeEntryId     bigint IDENTITY(1,1) NOT NULL,
    PublicId        uniqueidentifier NOT NULL CONSTRAINT DF_TimeEntry_PublicId DEFAULT NEWID(),
    EmployeeId      int NOT NULL,
    OfficeId        int NOT NULL,
    PayPeriodId     int NULL,          -- assigned on clock-out
    WorkDateLocal   date NOT NULL,     -- derived from ClockInUtc + office tz; the payroll day
    ClockInUtc      datetime2(3) NOT NULL,
    ClockOutUtc     datetime2(3) NULL,
    EntrySource     tinyint NOT NULL CONSTRAINT DF_TimeEntry_Src DEFAULT 1,
        -- 1=Punch 2=ManagerManual 3=Migrated
    EntryStatus     tinyint NOT NULL CONSTRAINT DF_TimeEntry_Status DEFAULT 1,
        -- 1=Open 2=Closed 3=Voided
    -- Captured context at clock-in
    InLatitude      decimal(9,6) NULL,
    InLongitude     decimal(9,6) NULL,
    InAccuracyMeters int NULL,
    InDistanceMeters int NULL,          -- computed server-side vs office geofence
    InGeofenceOk    bit NULL,
    InIpAddress     nvarchar(45) NULL,
    InDeviceId      nvarchar(100) NULL,
    -- Captured context at clock-out
    OutLatitude     decimal(9,6) NULL,
    OutLongitude    decimal(9,6) NULL,
    OutAccuracyMeters int NULL,
    OutDistanceMeters int NULL,
    OutGeofenceOk   bit NULL,
    OutIpAddress    nvarchar(45) NULL,
    OutDeviceId     nvarchar(100) NULL,
    -- Effective (correction-aware) values; equal to raw unless corrected
    EffectiveClockInUtc  datetime2(3) NOT NULL,
    EffectiveClockOutUtc datetime2(3) NULL,
    DurationMinutes AS (CASE WHEN EffectiveClockOutUtc IS NULL THEN NULL
                             ELSE DATEDIFF(MINUTE, EffectiveClockInUtc, EffectiveClockOutUtc) END) PERSISTED,
    Note            nvarchar(500) NULL,
    CreatedAtUtc    datetime2(3) NOT NULL CONSTRAINT DF_TimeEntry_Created DEFAULT SYSUTCDATETIME(),
    CreatedByEmployeeId int NULL,       -- NULL = the employee's own punch
    VoidedAtUtc     datetime2(3) NULL,
    VoidedByEmployeeId int NULL,
    VoidReason      nvarchar(500) NULL,
    RowVersion      rowversion NOT NULL,
    CONSTRAINT PK_TimeEntries PRIMARY KEY CLUSTERED (TimeEntryId),
    CONSTRAINT FK_TimeEntry_Employee FOREIGN KEY (EmployeeId) REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT FK_TimeEntry_Office   FOREIGN KEY (OfficeId)   REFERENCES org.Offices(OfficeId),
    CONSTRAINT FK_TimeEntry_Period   FOREIGN KEY (PayPeriodId) REFERENCES [time].PayPeriods(PayPeriodId),
    CONSTRAINT CK_TimeEntry_Order    CHECK (ClockOutUtc IS NULL OR ClockOutUtc > ClockInUtc),
    CONSTRAINT CK_TimeEntry_EffOrder CHECK (EffectiveClockOutUtc IS NULL OR EffectiveClockOutUtc > EffectiveClockInUtc),
    CONSTRAINT CK_TimeEntry_Status   CHECK (EntryStatus IN (1,2,3)),
    CONSTRAINT CK_TimeEntry_Void     CHECK (
        (EntryStatus = 3 AND VoidedAtUtc IS NOT NULL AND VoidReason IS NOT NULL)
     OR (EntryStatus <> 3 AND VoidedAtUtc IS NULL)),
    -- A shift longer than 18h is a forgotten clock-out, not a shift. Caught at write time.
    CONSTRAINT CK_TimeEntry_MaxSpan  CHECK (
        EffectiveClockOutUtc IS NULL
     OR DATEDIFF(HOUR, EffectiveClockInUtc, EffectiveClockOutUtc) <= 18)
);

-- ══ ONE OPEN PUNCH PER EMPLOYEE — two devices cannot both clock in ══
CREATE UNIQUE INDEX UX_TimeEntries_OneOpen
    ON [time].TimeEntries(EmployeeId)
    WHERE ClockOutUtc IS NULL AND EntryStatus = 1;

CREATE INDEX IX_TimeEntries_Employee_Period
    ON [time].TimeEntries(EmployeeId, PayPeriodId) INCLUDE (WorkDateLocal, DurationMinutes, EntryStatus);
CREATE INDEX IX_TimeEntries_Period_Office
    ON [time].TimeEntries(PayPeriodId, OfficeId) INCLUDE (EmployeeId, DurationMinutes);
```

**Why `EffectiveClockInUtc` is separate from `ClockInUtc`.** `ClockInUtc` is what the
server observed and is **never updated after insert**. `EffectiveClockInUtc` is what
payroll pays, and only a recorded correction may change it. Both rows survive — exactly
the "original punch 8:03, corrected to 8:00" picture in build-plan §8. The original is
not overwritten; it is superseded, visibly.

### 7.2 Corrections replace deletion

```sql
CREATE TABLE [time].TimeEntryCorrections (
    CorrectionId     bigint IDENTITY(1,1) NOT NULL,
    TimeEntryId      bigint NOT NULL,
    CorrectionType   tinyint NOT NULL,   -- 1=AdjustIn 2=AdjustOut 3=AdjustBoth 4=Void 5=ChangeOffice
    OriginalClockInUtc  datetime2(3) NOT NULL,
    OriginalClockOutUtc datetime2(3) NULL,
    CorrectedClockInUtc datetime2(3) NULL,
    CorrectedClockOutUtc datetime2(3) NULL,
    OriginalOfficeId int NULL,
    CorrectedOfficeId int NULL,
    Reason           nvarchar(500) NOT NULL,      -- REQUIRED. No silent corrections.
    RequestedByEmployeeId int NULL,               -- employee who reported the problem
    CorrectedByEmployeeId int NOT NULL,           -- manager who applied it
    AppliedAtUtc     datetime2(3) NOT NULL CONSTRAINT DF_TimeCorr_Applied DEFAULT SYSUTCDATETIME(),
    ActorIp          nvarchar(45) NULL,
    CONSTRAINT PK_TimeEntryCorrections PRIMARY KEY CLUSTERED (CorrectionId),
    CONSTRAINT FK_TimeCorr_Entry FOREIGN KEY (TimeEntryId) REFERENCES [time].TimeEntries(TimeEntryId),
    CONSTRAINT FK_TimeCorr_By    FOREIGN KEY (CorrectedByEmployeeId) REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT CK_TimeCorr_Type  CHECK (CorrectionType IN (1,2,3,4,5)),
    CONSTRAINT CK_TimeCorr_Reason CHECK (LEN(LTRIM(RTRIM(Reason))) >= 10)
);
CREATE INDEX IX_TimeCorr_Entry ON [time].TimeEntryCorrections(TimeEntryId, AppliedAtUtc DESC);
```

`CK_TimeCorr_Reason` requires at least 10 characters. "fix" will not save. A payroll
correction that cannot be explained should not be possible.

### 7.3 Payroll locking, enforced by the database

A manager with a rogue SQL client should not be able to edit a locked period. So the
lock is a trigger, not an `if` statement in C#:

```sql
CREATE OR ALTER TRIGGER [time].trg_TimeEntries_BlockLockedPeriod
ON [time].TimeEntries
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1
        FROM   inserted i
        JOIN   [time].PayPeriods p ON p.PayPeriodId = i.PayPeriodId
        WHERE  p.PeriodStatus IN (3,4)                            -- Locked or Paid
          AND  SESSION_CONTEXT(N'PayrollOverride') IS NULL        -- set only by usp_ApplyPayrollAdjustment
    )
    BEGIN
        THROW 50423, N'Pay period is locked. Use a payroll adjustment.', 1;
    END
END;
```

The only legitimate path into a locked period sets `SESSION_CONTEXT` inside a stored
procedure that simultaneously writes a `PayrollAdjustments` row. There is no way to
change locked payroll without leaving a record — build-plan §9.

```sql
CREATE TABLE [time].PayrollAdjustments (
    AdjustmentId    bigint IDENTITY(1,1) NOT NULL,
    PayPeriodId     int NOT NULL,
    EmployeeId      int NOT NULL,
    AdjustmentType  tinyint NOT NULL,     -- 1=HoursCorrection 2=MissedPunch 3=RetroPay 4=Other
    OriginalHours   decimal(9,4) NULL,
    CorrectedHours  decimal(9,4) NULL,
    OriginalAmount  decimal(19,4) NULL,
    CorrectedAmount decimal(19,4) NULL,
    Reason          nvarchar(1000) NOT NULL,
    RequestedByEmployeeId int NOT NULL,
    ApprovedByEmployeeId  int NOT NULL,   -- must differ from requester
    ApprovedAtUtc   datetime2(3) NOT NULL CONSTRAINT DF_PayAdj_Approved DEFAULT SYSUTCDATETIME(),
    RelatedTimeEntryId bigint NULL,
    CONSTRAINT PK_PayrollAdjustments PRIMARY KEY CLUSTERED (AdjustmentId),
    CONSTRAINT FK_PayAdj_Period   FOREIGN KEY (PayPeriodId) REFERENCES [time].PayPeriods(PayPeriodId),
    CONSTRAINT FK_PayAdj_Employee FOREIGN KEY (EmployeeId)  REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT CK_PayAdj_Reason   CHECK (LEN(LTRIM(RTRIM(Reason))) >= 10),
    -- Two-person rule: you cannot approve your own payroll adjustment.
    CONSTRAINT CK_PayAdj_TwoPerson CHECK (RequestedByEmployeeId <> ApprovedByEmployeeId)
);
```

`CK_PayAdj_TwoPerson` is the separation-of-duties control. Nobody adjusts their own pay,
including an Admin.

---

## 8. PTO as a ledger

Deploy 17 recomputes PTO from hardcoded name arrays every render, and a balance that is
recomputed cannot be audited. Here, balance is the **sum of a ledger**:

```sql
CREATE TABLE hr.PtoPolicies (
    PtoPolicyId  int IDENTITY(1,1) NOT NULL,
    Code         nvarchar(40) NOT NULL,      -- 'SALARIED_80', 'HOURLY_TIERED'
    Name         nvarchar(100) NOT NULL,
    AccrualMethod tinyint NOT NULL,          -- 1=AnnualGrant 2=TenureTiered
    ProbationDays int NOT NULL CONSTRAINT DF_PtoPolicy_Prob DEFAULT 0,
    ResetMonth   tinyint NOT NULL CONSTRAINT DF_PtoPolicy_Month DEFAULT 1,
    ResetDay     tinyint NOT NULL CONSTRAINT DF_PtoPolicy_Day DEFAULT 1,
    CarryoverMaxHours decimal(9,4) NOT NULL CONSTRAINT DF_PtoPolicy_Carry DEFAULT 0,
    IsActive     bit NOT NULL CONSTRAINT DF_PtoPolicy_Active DEFAULT 1,
    CONSTRAINT PK_PtoPolicies PRIMARY KEY CLUSTERED (PtoPolicyId),
    CONSTRAINT UX_PtoPolicies_Code UNIQUE (Code)
);

CREATE TABLE hr.PtoPolicyTiers (
    PtoPolicyTierId  int IDENTITY(1,1) NOT NULL,
    PtoPolicyId      int NOT NULL,
    MinTenureMonths  int NOT NULL,
    AnnualHours      decimal(9,4) NOT NULL,
    CONSTRAINT PK_PtoPolicyTiers PRIMARY KEY CLUSTERED (PtoPolicyTierId),
    CONSTRAINT UX_PtoTiers UNIQUE (PtoPolicyId, MinTenureMonths),
    CONSTRAINT FK_PtoTiers_Policy FOREIGN KEY (PtoPolicyId) REFERENCES hr.PtoPolicies(PtoPolicyId)
);

CREATE TABLE hr.PtoTransactions (
    PtoTransactionId bigint IDENTITY(1,1) NOT NULL,
    EmployeeId    int NOT NULL,
    PlanYear      smallint NOT NULL,
    TransactionType tinyint NOT NULL,   -- 1=Grant 2=Use 3=Adjustment 4=Forfeit 5=Carryover 6=PayoutOnTerm
    Hours         decimal(9,4) NOT NULL,  -- signed: grants +, use -
    EffectiveDate date NOT NULL,
    SourceRequestId int NULL,
    Reason        nvarchar(500) NULL,
    CreatedAtUtc  datetime2(3) NOT NULL CONSTRAINT DF_PtoTxn_Created DEFAULT SYSUTCDATETIME(),
    CreatedByEmployeeId int NULL,        -- NULL = system accrual job
    ReversesTransactionId bigint NULL,   -- corrections reverse, never update
    CONSTRAINT PK_PtoTransactions PRIMARY KEY CLUSTERED (PtoTransactionId),
    CONSTRAINT FK_PtoTxn_Employee FOREIGN KEY (EmployeeId) REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT CK_PtoTxn_Type CHECK (TransactionType IN (1,2,3,4,5,6)),
    CONSTRAINT CK_PtoTxn_Sign CHECK (
        (TransactionType IN (1,5) AND Hours > 0) OR
        (TransactionType IN (2,4) AND Hours < 0) OR
        (TransactionType IN (3,6)))
);
CREATE INDEX IX_PtoTxn_Employee_Year ON hr.PtoTransactions(EmployeeId, PlanYear, EffectiveDate);

CREATE VIEW hr.vPtoBalances AS
SELECT EmployeeId, PlanYear,
       SUM(CASE WHEN TransactionType IN (1,5) THEN Hours ELSE 0 END) AS GrantedHours,
       SUM(CASE WHEN TransactionType = 2 THEN -Hours ELSE 0 END)     AS UsedHours,
       SUM(Hours)                                                    AS AvailableHours
FROM   hr.PtoTransactions
GROUP BY EmployeeId, PlanYear;
```

`ReversesTransactionId` is the pattern used throughout: **a mistake is corrected by a new
opposing row, never by editing the old one.** The history stays truthful.

```sql
CREATE TABLE hr.EmployeeRequests (
    RequestId     int IDENTITY(1,1) NOT NULL,
    RequestNumber AS (CONCAT(N'REQ-', FORMAT(RequestId, N'00000'))) PERSISTED,
    PublicId      uniqueidentifier NOT NULL CONSTRAINT DF_Req_PublicId DEFAULT NEWID(),
    EmployeeId    int NOT NULL,
    OfficeId      int NOT NULL,
    RequestType   tinyint NOT NULL,   -- 1=PTO 2=Vacation 3=ITSupport 4=Supply 5=ScheduleChange 6=Training 9=Other
    StartDate     date NULL,
    EndDate       date NULL,
    HoursRequested decimal(9,4) NULL,
    Notes         nvarchar(2000) NULL,
    RequestStatus tinyint NOT NULL CONSTRAINT DF_Req_Status DEFAULT 1,
        -- 1=Pending 2=Approved 3=Denied 4=Withdrawn 5=Cancelled
    SubmittedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_Req_Submitted DEFAULT SYSUTCDATETIME(),
    ReviewedByEmployeeId int NULL,
    ReviewedAtUtc  datetime2(3) NULL,
    ReviewNote     nvarchar(1000) NULL,
    RowVersion     rowversion NOT NULL,
    CONSTRAINT PK_EmployeeRequests PRIMARY KEY CLUSTERED (RequestId),
    CONSTRAINT FK_Req_Employee FOREIGN KEY (EmployeeId) REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT FK_Req_Office   FOREIGN KEY (OfficeId)   REFERENCES org.Offices(OfficeId),
    CONSTRAINT CK_Req_Dates    CHECK (EndDate IS NULL OR StartDate IS NULL OR EndDate >= StartDate),
    CONSTRAINT CK_Req_Status   CHECK (RequestStatus IN (1,2,3,4,5)),
    CONSTRAINT CK_Req_Review   CHECK (
        (RequestStatus IN (2,3) AND ReviewedByEmployeeId IS NOT NULL AND ReviewedAtUtc IS NOT NULL)
     OR (RequestStatus NOT IN (2,3))),
    -- Nobody approves their own PTO.
    CONSTRAINT CK_Req_NotSelfApproved CHECK (ReviewedByEmployeeId IS NULL OR ReviewedByEmployeeId <> EmployeeId)
);
CREATE INDEX IX_Req_Status_Office ON hr.EmployeeRequests(RequestStatus, OfficeId) INCLUDE (EmployeeId, StartDate);
```

Approving a PTO request writes the `PtoTransactions` row in the **same transaction** as
the status change. A request cannot be Approved without the hours being deducted.

---

## 9. Portal content

Abbreviated — these are low-risk tables. Full DDL follows the same conventions.

| Table | Key columns | Notes |
|---|---|---|
| `portal.Events` | `EventId, Title, EventDateLocal, StartTimeLocal, EndTimeLocal, IsAllDay, EventType, OfficeScopeId (NULL=All), LocationText, ExternalUrl, Notes, CanceledAtUtc` | Cancel, don't delete |
| `portal.EventResponses` | `EventId, EmployeeId, Response (1=Going 2=Maybe 3=No), RespondedAtUtc` | PK `(EventId, EmployeeId)` — RSVP is idempotent by construction |
| `portal.Announcements` | `AnnouncementId, Body, Tag, OfficeScopeId, PostedByEmployeeId, PostedAtUtc, ExpiresAtUtc, RetractedAtUtc` | |
| `portal.Tasks` | `TaskId, Label, OfficeScopeId, AssignedToEmployeeId (NULL=all), DueDate, CompletedAtUtc, CompletedByEmployeeId` | Per-person completion, not a shared `done` flag |
| `portal.Alerts` | `AlertId, Title, Body, Severity, OfficeScopeId, CreatedByEmployeeId, CreatedAtUtc, ExpiresAtUtc` | |
| `portal.AlertDismissals` | `AlertId, EmployeeId, DismissedAtUtc` | **Per-employee.** Deploy 17's `dismissed` flag is global — one person dismisses, everyone loses the alert |
| `portal.Notifications` | `NotificationId bigint, RecipientEmployeeId, Kind, Title, Body, LinkUrl, CreatedAtUtc, ReadAtUtc, DismissedAtUtc` | Addressed by `EmployeeId`, not name |
| `portal.Messages` | `MessageId bigint, FromEmployeeId, ToEmployeeId, Body, SentAtUtc, ReadAtUtc` | Replaces `S.inbox` keyed by display name |
| `portal.Resources` | `ResourceId, Name, Description, Url, Category, DocumentId (NULL), OfficeScopeId, SortOrder, IsActive` | Files go to `doc.Documents`, never inline |

Three of these fix real defects found in Deploy 17: shared task completion, global alert
dismissal, and name-keyed inboxes (see migration map §6).

---

## 10. Documents

Metadata in SQL, bytes in object storage. Nothing base64 ever again (build-plan §14).

```sql
CREATE SCHEMA doc;
GO

CREATE TABLE doc.Documents (
    DocumentId    bigint IDENTITY(1,1) NOT NULL,
    PublicId      uniqueidentifier NOT NULL CONSTRAINT DF_Doc_PublicId DEFAULT NEWID(),
    CompanyId     int NOT NULL,
    ClientId      int NULL,          -- NULL = company/HR document
    EmployeeId    int NULL,          -- NULL = not employee-specific
    Category      nvarchar(60) NOT NULL,
    FileName      nvarchar(260) NOT NULL,
    ContentType   nvarchar(120) NOT NULL,
    ByteSize      bigint NOT NULL,
    Sha256        binary(32) NOT NULL,      -- integrity + duplicate detection
    StorageBucket nvarchar(100) NOT NULL,
    StorageKey    nvarchar(500) NOT NULL,   -- never guessable; contains PublicId
    UploadedByEmployeeId int NOT NULL,
    UploadedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_Doc_Uploaded DEFAULT SYSUTCDATETIME(),
    DeletedAtUtc  datetime2(3) NULL,
    DeletedByEmployeeId int NULL,
    RetentionUntil date NULL,
    CONSTRAINT PK_Documents PRIMARY KEY CLUSTERED (DocumentId),
    CONSTRAINT UX_Documents_StorageKey UNIQUE (StorageBucket, StorageKey),
    CONSTRAINT FK_Doc_Client FOREIGN KEY (ClientId) REFERENCES crm.Clients(ClientId),
    CONSTRAINT CK_Doc_Size CHECK (ByteSize > 0 AND ByteSize <= 104857600)   -- 100 MB
);
CREATE INDEX IX_Documents_Client ON doc.Documents(ClientId, UploadedAtUtc DESC) WHERE DeletedAtUtc IS NULL;
CREATE INDEX IX_Documents_Sha ON doc.Documents(Sha256);
```

**Access is never a public URL.** The API checks permission, then issues a **short-lived
pre-signed URL** (5 minutes, single file). `StorageKey` embeds `PublicId`, so guessing a
key is guessing a GUID. Deleting a document soft-deletes the row and tags the object for
lifecycle expiry after `RetentionUntil` — a client file must survive an accidental click.

---

## 11. Governance

```sql
CREATE SCHEMA audit;
GO

CREATE TABLE audit.AuditLog (
    AuditId       bigint IDENTITY(1,1) NOT NULL,
    OccurredAtUtc datetime2(3) NOT NULL CONSTRAINT DF_Audit_At DEFAULT SYSUTCDATETIME(),
    ActorEmployeeId int NULL,           -- NULL = system job
    ActorUserId   nvarchar(450) NULL,
    ActorIp       nvarchar(45) NULL,
    ActorUserAgent nvarchar(400) NULL,
    CorrelationId uniqueidentifier NULL,  -- ties every row from one HTTP request together
    Action        nvarchar(100) NOT NULL, -- 'Handoff.Accepted', 'TimeEntry.Corrected'
    EntityType    nvarchar(60)  NOT NULL,
    EntityId      bigint NULL,
    OfficeId      int NULL,
    Summary       nvarchar(1000) NOT NULL,
    BeforeJson    nvarchar(max) NULL,
    AfterJson     nvarchar(max) NULL,
    Reason        nvarchar(1000) NULL,
    CONSTRAINT PK_AuditLog PRIMARY KEY CLUSTERED (AuditId)
);
CREATE INDEX IX_Audit_Entity ON audit.AuditLog(EntityType, EntityId, OccurredAtUtc DESC);
CREATE INDEX IX_Audit_Actor  ON audit.AuditLog(ActorEmployeeId, OccurredAtUtc DESC);
CREATE INDEX IX_Audit_Corr   ON audit.AuditLog(CorrelationId);

CREATE TABLE audit.LoginHistory (
    LoginId       bigint IDENTITY(1,1) NOT NULL,
    AttemptedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_Login_At DEFAULT SYSUTCDATETIME(),
    AttemptedEmail nvarchar(256) NULL,   -- kept even when no user matches
    UserId        nvarchar(450) NULL,
    EmployeeId    int NULL,
    Outcome       tinyint NOT NULL,      -- 1=Success 2=BadPassword 3=LockedOut 4=MfaFailed 5=Disabled 6=UnknownUser
    IpAddress     nvarchar(45) NULL,
    UserAgent     nvarchar(400) NULL,
    MfaUsed       bit NOT NULL CONSTRAINT DF_Login_Mfa DEFAULT 0,
    FailureDetail nvarchar(200) NULL,
    CONSTRAINT PK_LoginHistory PRIMARY KEY CLUSTERED (LoginId)
);
CREATE INDEX IX_Login_Email_Time ON audit.LoginHistory(AttemptedEmail, AttemptedAtUtc DESC);
CREATE INDEX IX_Login_Ip_Time    ON audit.LoginHistory(IpAddress, AttemptedAtUtc DESC);

CREATE TABLE audit.SecurityEvents (
    SecurityEventId bigint IDENTITY(1,1) NOT NULL,
    OccurredAtUtc datetime2(3) NOT NULL CONSTRAINT DF_SecEv_At DEFAULT SYSUTCDATETIME(),
    EventType     nvarchar(80) NOT NULL,  -- 'PermissionDenied','PasswordReset','MfaEnrolled','SessionRevoked'
    Severity      tinyint NOT NULL,       -- 1=Info 2=Warning 3=Critical
    EmployeeId    int NULL,
    IpAddress     nvarchar(45) NULL,
    Detail        nvarchar(2000) NULL,
    CONSTRAINT PK_SecurityEvents PRIMARY KEY CLUSTERED (SecurityEventId)
);
```

**Append-only is enforced, not assumed:**

```sql
CREATE OR ALTER TRIGGER audit.trg_AuditLog_NoMutate
ON audit.AuditLog
INSTEAD OF UPDATE, DELETE
AS
BEGIN
    THROW 50451, N'audit.AuditLog is append-only.', 1;
END;
```

The application login has `INSERT` and `SELECT` on `audit`, and no `UPDATE`/`DELETE` at
all. Retention is handled by a separate, tightly-held maintenance login that archives
to cold storage — never by the app.

---

## 12. Security posture at the database layer

| Control | Implementation |
|---|---|
| **App login privileges** | `ogo_app` gets `SELECT/INSERT/UPDATE` on business schemas, `EXECUTE` on procs, `INSERT/SELECT` only on `audit`. **No `db_owner`, no DDL, no `DELETE` anywhere.** |
| **Encryption at rest** | TDE enabled (SQL Server 2025 Standard supports it) |
| **Encryption in transit** | `Encrypt=True;TrustServerCertificate=False` with a real cert; SQL listens only on the DigitalOcean private interface |
| **Backup encryption** | `BACKUP ... WITH ENCRYPTION (ALGORITHM = AES_256)`; certificate backed up separately from the backups |
| **Secrets** | Connection strings in environment variables; no credentials in `SystemSettings` |
| **SQL injection** | EF Core parameterization + stored procedures. No string-concatenated SQL, ever |
| **PII minimisation** | Only `TaxIdLast4` is stored. Full SSN/EIN is not in this database at all |
| **Dynamic Data Masking** | On `DateOfBirth`, `PersonalEmail`, `Phone` for non-HR logins — defence in depth, not a substitute for API authz |

---

## 13. Reconciliation views for migration

These exist so migration Stage E (build plan §17) is a query, not a spreadsheet:

```sql
CREATE VIEW audit.vMigrationCounts AS
SELECT N'Employees' AS Entity, COUNT(*) AS RowCount FROM hr.Employees
UNION ALL SELECT N'Clients',       COUNT(*) FROM crm.Clients
UNION ALL SELECT N'TimeEntries',   COUNT(*) FROM [time].TimeEntries
UNION ALL SELECT N'Requests',      COUNT(*) FROM hr.EmployeeRequests
UNION ALL SELECT N'Events',        COUNT(*) FROM portal.Events
UNION ALL SELECT N'Announcements', COUNT(*) FROM portal.Announcements
UNION ALL SELECT N'Resources',     COUNT(*) FROM portal.Resources
UNION ALL SELECT N'Assignments',   COUNT(*) FROM crm.ClientAssignments;

-- Payroll integrity: total minutes must match the source export exactly.
CREATE VIEW audit.vMigrationTimeTotals AS
SELECT e.EmployeeId, e.WorkEmail,
       COUNT(t.TimeEntryId)        AS EntryCount,
       SUM(t.DurationMinutes)      AS TotalMinutes
FROM   hr.Employees e
LEFT JOIN [time].TimeEntries t ON t.EmployeeId = e.EmployeeId AND t.EntryStatus <> 3
GROUP BY e.EmployeeId, e.WorkEmail;
```

Counts alone are insufficient for payroll. §17 of the build plan says 192 entries must
be 192 — this view additionally requires the **sum of minutes** to match, because 192
entries with one truncated duration is still a wrong paycheck.

---

## 14. Open decisions for OGO

These block Phase 1 sign-off. Each needs a human answer, not a default.

| # | Decision | Why it matters | Owner |
|---|---|---|---|
| 1 | **Pay period cadence** — biweekly (Deploy 17 code) or semi-monthly (build plan §9)? | Changes every paycheck and all historical period generation | OGO payroll |
| 2 | **Overtime rule** — daily >8h, weekly >40h, or none? | Needs `PayPeriods`/reporting design before Phase 9 | OGO payroll |
| 3 | **PTO on termination** — paid out, or forfeited? | Determines whether `TransactionType 6` is used | OGO HR |
| 4 | **Handoff expiry** — do pending handoffs auto-expire, and after how long? | `ExpiresAtUtc` default; a client with an ignored handoff is stuck otherwise | Gina |
| 5 | **Geofence enforcement** — hard block, or allow with a flag for review? | Deploy 17 hard-blocks; a bad GPS fix then costs someone their punch | Gina |
| 6 | **Tax year on workflow** — is `(Client, TaxYear)` the right grain, or does a client have several concurrent engagements? | Changes the `UX_CliWf_ClientYear` unique constraint | Alex Rivera |
| 7 | **Client numbering** — reuse TaxDome IDs, or mint our own? | `ClientNumber` uniqueness and the TaxDome sync story | OGO ops |
