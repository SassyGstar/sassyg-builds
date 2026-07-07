# OGO STAFF PORTAL - PROJECT HANDOFF DOCUMENT

**Last updated:** July 7, 2026 (evening)
**Owner:** Gina Altidor (Tax Resolution Director, OGO Accounting Services)
**Purpose:** Complete state and context so any future session can continue this project with zero gaps.

---

## 1. WHAT THIS PROJECT IS

A live, cloud-hosted staff management portal for **OGO Accounting Services** (3 offices: Orlando, Clermont, Winter Haven). Single self-contained HTML file, hosted on Netlify, backed by Firebase Realtime Database for cross-device sync. Used by ~11 employees on any browser or phone.

**This is OGO work - completely separate from ACE/GIA (Gina's other company). Do not mix them.**

---

## 2. LIVE URLS & CREDENTIALS

| Item | Value |
|------|-------|
| **Live portal URL** | https://ogodashboard1.netlify.app |
| **Netlify project** | https://app.netlify.com/projects/ogodashboard1/overview |
| **Netlify team** | SassyG (gina.altidor@gmail.com) |
| **Firebase project** | `ogo-bulletin-board` |
| **Firebase DB URL** | `https://ogo-bulletin-board-default-rtdb.firebaseio.com` |
| **Firebase data path** | `portals/ogo-v6-final/state` |
| **Firebase console** | https://console.firebase.google.com/project/ogo-bulletin-board/database/ogo-bulletin-board-default-rtdb/rules |
| **Admin passcode** | `OGO2026` |
| **PIN storage key** (localStorage) | `ogo_pins_v6f` |
| **User session key** (localStorage) | `ogo_user_v6f` |
| **Apps Script project** | https://script.google.com/home/projects/1-_--qzlMTrFfnsir-AGSOtncbqWxxGNGSAnz5VCsjUy_fWyG9TrqNkH-/edit |
| **GitHub backup** | SassyGstar/desktop-tutorial, branch `claude/code-review-demo-prep-ipfez8` |

### Firebase Rules (CONFIRMED LIVE)
```json
{
  "rules": {
    "boards": { "ogo-main-board": { ".read": true, ".write": true } },
    "portals": { ".read": true, ".write": true }
  }
}
```
Published and confirmed working. Do not tighten these without testing every browser: earlier restrictive rules silently broke sync on Edge while Chrome appeared fine.

---

## 3. CURRENT DELIVERABLE & DEPLOY METHOD

**Current file:** `OGO_Portal_Deploy_2.zip` containing a single `index.html` (~218,868 bytes, syntax-clean, browser-smoke-tested end to end on July 7, 2026).

### CRITICAL DEPLOY RULE (learned the hard way)
The file inside the deploy MUST be named **`index.html`**. Netlify only serves the site homepage from `index.html`. Deploying a file with any other name (e.g. `OGO_Portal_V6.html`) results in **"Page not found"** at the main URL. Always package as a ZIP containing `index.html` and drag the ZIP to Netlify.

### How Gina deploys (Claude cannot: Netlify is blocked by sandbox network policy)
1. Download the deploy ZIP
2. Go to https://app.netlify.com/drop
3. Drag the ZIP onto the page (do not unzip it)
4. When prompted, choose to update the existing **`ogodashboard1`** site (never create a new site; that changes the team's URL)
5. Verify at https://ogodashboard1.netlify.app: green "Live - All Devices" badge, PTO Tracker tab shows 11 cards

### Deploy status as of this handoff
Gina deployed once on July 7 with the wrongly named file (caused "Page not found"), then received corrected ZIP packages. **VERIFY on next session:** open https://ogodashboard1.netlify.app and confirm it loads the portal with the PTO Tracker tab and that the New Request form shows a "Your PTO Balance" line (that confirms the latest version is live).

---

## 4. JULY 7, 2026 CHANGES (all in the current file)

### Five bug fixes (verified by automated browser test)
1. **PTO Tracker tab rendered blank on first click.** `setSection()` never called `renderPTO()`. Fixed: `if(k==='pto')renderPTO();` added in `setSection`.
2. **Pay period end-of-day bug.** Period end was midnight of day 14, so the entire last day of every pay period fell outside the range and the Time Clock silently fell back to the March 15 period. Fixed: period end is now 23:59:59.999 (`ee.setHours(23,59,59,999)` in `getPPs`).
3. **UTC "today" bug.** Dates used `toISOString()` (UTC), so after 8 PM Florida time, punches were filed under tomorrow's date and the "today" punch log went empty. Fixed: new `ldate()` helper computes local dates; used for clock-out entry dates, punch log filtering, and manual-entry defaults.
4. **Birthday off-by-one.** `new Date('YYYY-MM-DD')` parses as UTC, shifting birthdays a day early in Florida. Fixed: all bday parses now append `'T00:00:00'`.
5. **Deleted seed events/employees resurrected.** `fbMerge` re-added the 4 built-in events and 11 seed employees after deletion. Fixed: deletions are recorded in `S.removedSeeds = {events:[], employees:[]}` and `fbMerge` skips re-adding anything listed there.

### New features added on top of the fixes
6. **PTO hours on requests.** The New Request form now shows the employee's live PTO balance, reveals a "PTO Hours Requested" field for PTO/Vacation types (`togglePTOHours`), and live-previews the balance after the request (`updatePTOAfter`), including a red "exceeds balance!" warning. Requests store `ptoHours` and `ptoYear`. `getPTOUsed()` counts `ptoHours` when present; only old requests without hours fall back to 8 hrs per calendar day.
7. **Verified roster data baked in.** All employees now have real `bday`, `hireDate`, corrected phone/email/position in the `EMPLOYEES` seed array. A one-time migration in `fbMerge` (gated by `S.rosterSync !== '2026-07-07'`) pushes these corrections into existing cloud data, then stamps `S.rosterSync`. If roster data is ever corrected again, update the seeds AND bump the gate date string.

---

## 5. ARCHITECTURE (critical to understand before editing)

**Single source of truth:** ALL data lives in one JS object `S`, pushed to ONE Firebase path as one object.

- `fbSave()` - clones `S`, strips UI-only fields (activeOffice/activeSection/adminMode), pushes entire object via `fbRef.set(data)`.
- `fbMerge(remote)` - rebuilds `S` from `makeDefault()` + remote data + preserved UI state, re-seeds employees/events (honoring `S.removedSeeds`), runs the one-time roster sync (gated by `S.rosterSync`), then `renderAll()`.
- `connectFB()` - initializes Firebase, subscribes `.on('value')`. First run pushes defaults.

**DO NOT reintroduce `fbUpdate`, `fbPush`, `fbRemove`, or `fbRef.child()`.** Those are from an old broken version that caused sync failures. Only `fbSave()` / `fbMerge()`.

**Time clock:** `S.tc = {entries:{}, active:{}}`. `S.tc.active['emp_5'] = timestamp` while clocked in; on clock-out a completed entry moves to `S.tc.entries['emp_5']`. Timestamps are locked at punch time, never recomputed. Entry dates are local Florida dates via `ldate()`.

**Pay periods:** biweekly starting 2026-03-15, generated by `getPPs()` (14 periods). Period end is end-of-day. Current period at handoff: Jul 5 - Jul 18.

**PINs:** localStorage ONLY (never Firebase), key `ogo_pins_v6f`, per device.

**Firebase quirk to remember:** Firebase strips empty arrays/objects on save. `makeDefault()` restores missing keys on merge, and all code uses guarded access (`S.x || []`). Keep that pattern for any new state fields.

---

## 6. EMPLOYEES (11 total, with verified roster data)

| id | Name | Role | Office | Hire Date | PTO Type | Expected PTO |
|----|------|------|--------|-----------|----------|--------------|
| 1 | LeBrun Alexis | Admin (CEO) | Orlando | 2017-02-17 | Salaried | 80h |
| 2 | Vestin Paul (Jean) | Manager | Winter Haven | 2025-07-01 | Salaried | 80h |
| 3 | Brandy Alexis | Staff (Head Marketing) | Orlando | 2025-06-02 | Hourly | 80h (1yr+) |
| 4 | Berline Jolimer | Admin (HR) | Orlando | 2025-07-01 | Hourly | 80h (1yr+) |
| 5 | Gina Altidor | Admin (Ops) | Orlando | 2018-01-01 | Salaried | 80h |
| 6 | Frances Torres | Manager (Team Lead) | Clermont | 2025-03-28 | Salaried | 80h |
| 7 | Guiovan Galarza | Staff | Orlando | 2025-10-13 | Hourly | 40h (first yr) |
| 8 | Bianca Sanchez | Staff | Clermont | 2025-10-09 | Hourly | 40h (first yr) |
| 9 | Clariluz Graham | Staff | Winter Haven | 2025-11-19 | Hourly | 40h (first yr) |
| 10 | Giovanni LeBrun Alexis | Staff (Bookkeeping) | Orlando | 2024-12-02 | Hourly | 80h (1yr+) |
| 11 | Maria Nino | Staff (Marketing Specialist) | Clermont | (blank) | Salaried | 80h |

**Hardcoded roles** (`ROLES` object): LeBrun/Berline/Gina = Admin; Vestin/Frances = Manager; everyone else = Staff.

### Office geofence coordinates (500m radius, clock-in)
- **Orlando:** 28.4842556, -81.4575523 · 5401 S. Kirkman Rd Suite 405, Orlando FL 32819
- **Clermont:** 28.5488526, -81.7283544 · 1200 Oakley Seaver Dr #213, Clermont FL 34711
- **Winter Haven:** 28.0216089, -81.7333756 · 99 6th St SW Suite 201, Winter Haven FL 33880

Admins bypass the geofence. Non-admins must be within 500m. Note: if the browser cannot provide a location (permission denied), clock-in is currently ALLOWED with a "Location unavailable - contact admin" note. That is intentional fallback behavior, not a bug.

---

## 7. PTO POLICY (from company handbook)

**Salaried/Exempt** (Gina, Vestin/Jean, Frances, Maria, LeBrun): 80 hours granted upfront annually, resets Jan 1.

**Hourly/Non-Exempt** (Brandy, Berline, Guiovan, Bianca, Clariluz, Giovanni):
- 0 hours during 90-day probation
- 40 hours after probation (first year)
- 80 hours max after 1-year anniversary
- Resets Jan 1, 80 hrs max

**Implementation:**
- `PTO_SAL` / `PTO_HR` arrays list who is salaried vs hourly (by exact name; update if anyone is renamed)
- `getPTOInfo(emp)` computes `{type, total, status, note}` from `emp.hireDate`
- `getPTOUsed(name)` sums approved PTO/Vacation requests this calendar year: uses the request's `ptoHours` when present, else 8 hrs per calendar day of the date range (old requests only)
- `S.ptoOverrides[name] = {total, note, updatedAt, updatedBy}` for admin manual adjustment (PTO tab, admin mode, "Adjust PTO")

---

## 8. FEATURES IN THE PORTAL (all working, all smoke-tested July 7)

**Sections:** Dashboard, Time Clock, Directory, Events, Requests, Clients, Analytics, Resources, Photos, Offices, PTO Tracker, Activity.

- **Dashboard** - KPIs, alerts, upcoming events w/ RSVP, birthdays, announcements, action items, notifications. Admin: Add Event / Announcement / Task / Urgent Alert buttons.
- **Time Clock** - geofenced clock in/out, live session timer, biweekly pay-period stats (regular/OT/days), punch log, team timelog, per-employee punch detail, manual entry + delete (admin/manager), payroll CSV export.
- **PTO Tracker** - per-employee balance cards with used/remaining bars, policy explainer, office filter, admin adjust + set hire date.
- **Requests** - PTO/Vacation/IT/supply/schedule/training. PTO/Vacation show balance + hours input with over-balance warning. Admin/manager approve/deny with review note; employee auto-notified via inbox banner.
- **Directory** - cards, search, office filter. Admin mode: edit, toggle status, Reset PIN per card.
- **Urgent Alerts** - red flashing banner, admin-posted, dismissible.
- **Photos** - team photo board (5MB max per photo). Note: photos are stored base64 inside the single Firebase state object, so every save re-uploads everything; keep the board light.
- **Offices** - per-office info + notes.
- **Activity log** - sign-ins, punches, request actions with timestamps (last 100).

---

## 9. PIN RESET (known limitation)

PINs live in localStorage per device. "Reset PIN" (Directory, admin mode) only clears the PIN on the device where the button is clicked. If someone is locked out on their own phone, they reset it there (or tap "Skip - set PIN later" when creating). True remote reset would require moving PINs to Firebase (security tradeoff; discuss with Gina first).

---

## 10. STYLE / BRAND

- **Colors:** navy `#1B2A4A`, gold `#B8963E`, cream bg. CSS vars: `--navy --gold --glt --mu --green --red --orange --blue --ln`.
- **Logo:** OGO logo embedded as base64 JPEG in the header/login/PIN screens (~24k chars).
- **Tagline:** "Beyond the Numbers, We're Here for You!"
- **Contacts:** (407) 456-0388 · ogofin.com · Orlando/Clermont/Winter Haven
- **No em-dashes** in any OGO document or email (Gina's standing rule).

---

## 11. HOW TO EDIT THE FILE SAFELY (READ BEFORE EDITING)

The file contains emoji as `🕓`-style surrogate-pair escape TEXT in the source. Editing rules:

1. **NEVER** write the file with Python string literals containing raw emoji or surrogate escapes; `f.write()` can throw `UnicodeEncodeError: surrogates not allowed` and produce a 0-byte file. Read/write with `errors='surrogateescape'` (or read `errors='replace'` for analysis only, never for writing back).
2. New emoji in JS strings: use HTML entities (`&#127965;` etc.), which are ASCII-safe.
3. Make edits as small `str.replace()` operations with an expected-occurrence-count check on each pattern (fail loudly if the count is wrong).
4. After every batch: extract the `<script>` block, run `node --check`, and check for duplicate function names.
5. Best practice used July 7: after editing, run a headless-browser smoke test (login, click all 12 tabs, clock in/out, open the PTO tab cold, delete a seed event and confirm it stays deleted). Firebase CDN is blocked in the sandbox, so the badge will show "Offline" locally; that is expected and fine.
6. Package the result as a ZIP containing **`index.html`** (see Section 3).

Validation snippet:
```python
import re
from collections import Counter
h = open('index.html', encoding='utf-8', errors='replace').read()
fns = re.findall(r'\bfunction (\w+)\(', h)
dups = {k:v for k,v in Counter(fns).items() if v>1}
print("Dups:", dups or "NONE")
sc = h.rfind('<script>'); js = h[sc+8:h.rfind('</script>')]
open('check.js','w',encoding='utf-8').write(js)
# then: node --check check.js
```

---

## 12. OPEN ITEMS / NEXT STEPS

1. **[VERIFY - NEXT SESSION] Deployment.** Confirm https://ogodashboard1.netlify.app loads the portal (not "Page not found") and that the New Request form shows the "Your PTO Balance" line. If not, have Gina re-deploy the ZIP per Section 3.
2. **[VERIFY] Cross-browser sync** after deploy: Chrome + Edge both show the green Live badge and a clock-in on one appears on the other.
3. **[OPTIONAL] Maria Nino hire date** is blank (she is salaried, so PTO works regardless; fill in when known).
4. **[KNOWN LIMITATION] PIN reset** is same-device only (Section 9).
5. **[KNOWN LIMITATION] Photos** inflate every Firebase save (Section 8). If the board grows, consider moving photos to their own path or Firebase Storage.
6. **[NICE TO HAVE] Old date-range PTO requests** (submitted before the hours field existed) count 8 hrs per calendar day including weekends. Admin can compensate via PTO override if it ever matters.
7. **[OPTIONAL] Remote deploys:** if Gina wants Claude to deploy directly in future sessions, set the Claude environment network policy to allow `api.netlify.com` (or all domains) and create a Netlify personal access token. Until then, deploys are manual drag-and-drop.

---

## 13. QUICK CONTEXT FOR NEW SESSION

Gina is non-technical and needs you to DO things, not explain them. Be direct, do the work, verify it, and give her the one link/file she needs. The portal is feature-complete and bug-fixed as of July 7, 2026; the current build lives in `OGO_Portal_Deploy_2.zip` (index.html inside) and is backed up on GitHub (SassyGstar/desktop-tutorial, branch `claude/code-review-demo-prep-ipfez8`). The most likely pending task is verifying the Netlify deploy went through with the correctly named `index.html`.
