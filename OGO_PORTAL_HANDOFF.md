# OGO STAFF PORTAL - PROJECT HANDOFF DOCUMENT

**Last updated:** August 17, 2026
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
| **Netlify site ID** | `aed9ec10-e7fd-4dbd-9159-58f891ca01b1` |
| **Netlify team** | SassyG (gina.altidor@gmail.com) |
| **Firebase project** | `ogo-bulletin-board` |
| **Firebase DB URL** | `https://ogo-bulletin-board-default-rtdb.firebaseio.com` |
| **Firebase data path** | `portals/ogo-v6-final/state` |
| **Admin passcode** | `OGO2026` |
| **PIN storage key** (localStorage) | `ogo_pins_v6f` |
| **User session key** (localStorage) | `ogo_user_v6f` |
| **Apps Script project** | https://script.google.com/home/projects/1-_--qzlMTrFfnsir-AGSOtncbqWxxGNGSAnz5VCsjUy_fWyG9TrqNkH-/edit |
| **GitHub backup** | SassyGstar/desktop-tutorial, branch `claude/code-review-demo-prep-ipfez8` |
| **Build archive** | Deploy zips are saved in Google Drive (search `OGO_Portal_Deploy`) |

### Firebase Rules (CONFIRMED LIVE)
```json
{
  "rules": {
    "boards": { "ogo-main-board": { ".read": true, ".write": true } },
    "portals": { ".read": true, ".write": true }
  }
}
```
Do not tighten these without testing every browser: earlier restrictive rules silently broke sync on Edge while Chrome appeared fine.

---

## 3. CURRENT BUILD & DEPLOY METHOD

**Current build:** `OGO_Portal_Deploy_8.zip` containing a single `index.html` (221,162 bytes, syntax-clean, browser-tested August 17, 2026). Same file is committed to GitHub as `OGO_Portal_V6.html` (filename kept for history continuity; it always holds the latest build).

### CRITICAL DEPLOY RULE
The file inside the deploy MUST be named **`index.html`**. Netlify serves the site homepage only from `index.html`; a file named anything else deploys but produces **"Page not found"** at the main URL. Always package as a ZIP containing `index.html`.

### How Gina deploys
1. Download the deploy ZIP
2. Go to https://app.netlify.com/drop
3. Drag the ZIP onto the page (do not unzip it)
4. Choose to update the existing **`ogodashboard1`** site (never create a new site; that changes the team's URL)
5. Verify at https://ogodashboard1.netlify.app

### Note on automated deploys
A Netlify MCP connector is now available and authenticates as Gina. Read operations work (project lookup, user, deploy status). The `deploy-site` write operation accepts only a `siteId` with **no directory parameter**, so there is no way to confirm which folder it would upload. It was deliberately NOT used against the live site: if it uploads the session's repo directory instead of the build folder, it would replace the staff portal with unrelated files. If automating this later, first point it at a throwaway site and inspect what lands there.

### Sandbox network note
Netlify domains (`netlify.app`, `api.netlify.com`) are blocked by the agent proxy, so Claude cannot download the live site or deploy over plain HTTPS. Google Drive and Gmail connectors DO work and are the reliable way to hand files to Claude (upload the zip to Drive, Claude downloads it by file ID).

---

## 4. AUGUST 17, 2026 CHANGES

### Events replaced (per Gina's Eventbrite emails)
All four retired 2026 seed events (OGO Team Retreat, Spring Floral Networking, Black & White, Golden ChopStix Gala) were removed and replaced with five current events, ids 121-125:

| id | Date | Event |
|----|------|-------|
| 121 | 2026-09-08 | 74th Orlando Networking Event (Green and Gold Edition), 5:30-9:30 PM, Paddywagon Irish Pub Dr. Phillips |
| 122 | 2026-11-25 | I'm in. Ultimate Friends & Family Birthday & Gaming Decades Extravaganza, 7:00 PM, Arcade Time Entertainment |
| 123 | 2027-01-12 | Orlando Networking Event (75th Edition), 5:30 PM, venue TBD |
| 124 | 2027-04-13 | Orlando Networking Event (76th Edition), 5:30 PM, venue TBD |
| 125 | 2027-05-15 | 17th Annual Black and White Weekend for BASE Camp, 8:00 PM, Rosen Plaza Hotel |

**Why this needed a migration, not just a file edit:** events live in Firebase, not in the HTML. Editing the seed array alone does nothing to data already in the cloud. A one-time migration in `fbMerge`, gated by `S.eventsSync !== '2026-08-17'`, clears `S.events`, resets `S.rsvps` (old RSVPs pointed at deleted event ids), clears `S.removedSeeds.events`, installs the new seed list, stamps `S.eventsSync`, and calls `fbSave()` once after `fbLock` is released. Verified: stale cloud data containing the old events is wiped, and a second sync round is stable.

**To replace events again:** update the seed array in `makeDefault()` AND bump the `eventsSync` date string in `fbMerge`. Both, or the change will not reach devices that already have data.

### Bug fixes
1. **Pay periods ran out on September 26, 2026.** `getPPs()` generated a fixed 14 periods from the 2026-03-15 anchor. After the last one, `currPP()` silently fell back to the March 15 period, so from Sept 27 onward the Time Clock would have shown the wrong period and everyone's hours would have looked empty. Now generates biweekly periods from the anchor through one year past today (regenerated on every call, so it never expires). Labels now include the year.
2. **Overtime was calculated wrong.** Regular/OT split used 80 hours per biweekly period. Federal FLSA overtime is over 40 hours per **workweek**. A 50-hour week followed by a 30-hour week reported 0 overtime when 10 hours were owed. New `calcRegOT(entries, activeMs)` groups entries into Sunday-start workweeks and sums `min(week,40)` as regular and `max(0,week-40)` as overtime. Used by both the personal pay-period stats and the payroll table. Verified: 50h+30h now reports 70 regular / 10 overtime; a 35h week reports no false overtime.
3. **Forgotten clock-outs silently inflated totals.** An employee who never clocked out kept accumulating hours forever with no signal. The team log now shows a red warning with the running total (for example "⚠ 52h 0m") once an open session passes 16 hours, instead of a plain "Active" badge. Display only, no data is altered.

### Verified working, unchanged
PTO math was audited across all 11 employees and is correct: salaried 80h, hourly past their 1-year anniversary 80h, hourly in first year 40h, probation 0h, and no-hire-date handled. Approved PTO deducts by hours, pending requests correctly do NOT deduct, and old requests without an hours value still fall back to 8 hours per calendar day. Time clock records every employee (11 rows in both the team log and payroll table), clock in/out writes correct local dates and durations.

---

## 5. ARCHITECTURE (critical before editing)

**Single source of truth:** ALL data lives in one JS object `S`, pushed to ONE Firebase path as one object.

- `fbSave()` - clones `S`, strips UI-only fields (activeOffice/activeSection/adminMode), pushes via `fbRef.set(data)`.
- `fbMerge(remote)` - rebuilds `S` from `makeDefault()` + remote data + preserved UI state, re-seeds employees/events (honoring `S.removedSeeds`), runs the one-time roster sync (`S.rosterSync`) and event refresh (`S.eventsSync`), then `renderAll()`.
- `connectFB()` - initializes Firebase, subscribes `.on('value')`.

**DO NOT reintroduce `fbUpdate`, `fbPush`, `fbRemove`, or `fbRef.child()`.** Those caused the original sync failures. Only `fbSave()` / `fbMerge()`.

**Migration pattern (important):** any change to data that already exists in Firebase needs a one-time gate inside `fbMerge` (`S.rosterSync`, `S.eventsSync`). Mutate `S`, set a flag, and call `fbSave()` AFTER `fbLock=false` (fbSave is a no-op while `fbLock` is true).

**Time clock:** `S.tc = {entries:{}, active:{}}`. `S.tc.active['emp_5']` holds the clock-in timestamp; on clock-out a completed entry moves to `S.tc.entries['emp_5']`. Timestamps are locked at punch time. Entry dates use `ldate()` (local Florida date, not UTC).

**Pay periods:** biweekly, anchored 2026-03-15, generated through one year ahead. Overtime is weekly (over 40h, Sunday-start weeks).

**PINs:** localStorage ONLY (never Firebase), per device.

**Firebase quirk:** Firebase strips empty arrays/objects on save. `makeDefault()` restores missing keys on merge; keep all access guarded (`S.x || []`).

---

## 6. EMPLOYEES (11, with verified roster data)

| id | Name | Role | Office | Hire Date | PTO Type | PTO |
|----|------|------|--------|-----------|----------|-----|
| 1 | LeBrun Alexis | Admin (CEO) | Orlando | 2017-02-17 | Salaried | 80h |
| 2 | Vestin Paul (Jean) | Manager | Winter Haven | 2025-07-01 | Salaried | 80h |
| 3 | Brandy Alexis | Staff (Head Marketing) | Orlando | 2025-06-02 | Hourly | 80h |
| 4 | Berline Jolimer | Admin (HR) | Orlando | 2025-07-01 | Hourly | 80h |
| 5 | Gina Altidor | Admin (Ops) | Orlando | 2018-01-01 | Salaried | 80h |
| 6 | Frances Torres | Manager (Team Lead) | Clermont | 2025-03-28 | Salaried | 80h |
| 7 | Guiovan Galarza | Staff | Orlando | 2025-10-13 | Hourly | 40h |
| 8 | Bianca Sanchez | Staff | Clermont | 2025-10-09 | Hourly | 40h |
| 9 | Clariluz Graham | Staff | Winter Haven | 2025-11-19 | Hourly | 40h |
| 10 | Giovanni LeBrun Alexis | Staff (Bookkeeping) | Orlando | 2024-12-02 | Hourly | 80h |
| 11 | Maria Nino | Staff (Marketing Specialist) | Clermont | (blank) | Salaried | 80h |

**Hardcoded roles** (`ROLES`): LeBrun/Berline/Gina = Admin; Vestin/Frances = Manager; everyone else = Staff.

**Note:** Guiovan, Bianca, and Clariluz cross their 1-year anniversaries in October and November 2026 and will move from 40h to 80h automatically.

### Office geofence (500m radius)
- **Orlando:** 28.4842556, -81.4575523 · 5401 S. Kirkman Rd Suite 405, Orlando FL 32819
- **Clermont:** 28.5488526, -81.7283544 · 1200 Oakley Seaver Dr #213, Clermont FL 34711
- **Winter Haven:** 28.0216089, -81.7333756 · 99 6th St SW Suite 201, Winter Haven FL 33880

Admins bypass the geofence. If the browser cannot supply a location, clock-in is ALLOWED with a "Location unavailable" note (intentional fallback, not a bug).

---

## 7. PTO POLICY

**Salaried/Exempt** (Gina, Vestin, Frances, Maria, LeBrun): 80 hours upfront annually, resets Jan 1.

**Hourly/Non-Exempt** (Brandy, Berline, Guiovan, Bianca, Clariluz, Giovanni): 0 during 90-day probation, 40 hours after probation (first year), 80 hours after the 1-year anniversary, resets Jan 1.

**Implementation:** `PTO_SAL` / `PTO_HR` list who is which (by exact name). `getPTOInfo(emp)` computes type/total/status from `emp.hireDate`. `getPTOUsed(name)` sums approved PTO/Vacation for the current year using the request's `ptoHours` when present, else 8 hours per calendar day. `S.ptoOverrides[name]` allows admin adjustment via the PTO tab.

---

## 8. FEATURES

**Sections:** Dashboard, Time Clock, Directory, Events, Requests, Clients, Analytics, Resources, Photos, Offices, PTO Tracker, Activity.

Time Clock includes geofenced punches, live session timer, pay-period stats (regular/overtime/days), personal punch log, team timelog for all staff, per-employee punch detail, manual entry and delete (admin/manager), and payroll CSV export. Requests show live PTO balance with an over-balance warning. Directory has admin edit / status toggle / Reset PIN. Photos, Offices notes, Urgent Alerts, per-employee Inbox, and a 100-entry Activity log round it out.

---

## 9. KNOWN LIMITATIONS

1. **PIN reset is same-device only.** PINs live in localStorage, so an admin clicking Reset PIN only clears it on that device. The user resets on their own device. Moving PINs to Firebase would fix it but puts PINs in the cloud (discuss first).
2. **Photos bloat every save.** Photos are base64 inside the single state object, so each save re-uploads all of them. Keep the board light or move photos to their own path/Storage.
3. **Overtime shows for salaried staff too.** The payroll table computes overtime for everyone; exempt salaried employees would not normally be paid overtime. Cosmetic today, but worth hiding for `PTO_SAL` names if payroll uses this export directly.
4. **Old PTO requests** (submitted before the hours field existed) count 8 hours per calendar day including weekends. Admin can compensate via PTO override.
5. **Pay period anchor is 2026-03-15.** If OGO changes its payroll calendar, update that anchor date in `getPPs()`.

---

## 10. HOW TO EDIT THE FILE SAFELY (READ BEFORE EDITING)

1. Non-ASCII characters are stored as `\uXXXX` **escape text**, not real characters (for example `\u2013`, not an en dash). String matching against the file MUST use the escape text or the match silently fails. New strings should follow the same convention.
2. Never write the file from Python with raw emoji or surrogate escapes in literals; use `errors='surrogateescape'` on both read and write.
3. Make edits as small `str.replace()` operations with an **expected-occurrence count check** on every pattern, and fail loudly if the count is wrong. For a large block (like the events array), locate it by slicing between anchors rather than retyping it.
4. After every batch: extract the last `<script>` block, run `node --check`, and check for duplicate function names.
5. Then run a headless browser test: log in, click all 12 tabs, clock in/out, open the PTO tab cold, and exercise whatever you changed. The Firebase CDN is blocked in the sandbox, so the badge reads "Offline" locally; that is expected.
6. Package as a ZIP containing `index.html`.

Validation snippet:
```python
import re
from collections import Counter
h = open('index.html', encoding='utf-8', errors='replace').read()
fns = re.findall(r'\bfunction (\w+)\(', h)
print("Dups:", {k:v for k,v in Counter(fns).items() if v>1} or "NONE")
sc = h.rfind('<script>'); js = h[sc+8:h.rfind('</script>')]
open('check.js','w',encoding='utf-8').write(js)
# then: node --check check.js
```

---

## 11. OPEN ITEMS / NEXT STEPS

1. **[ACTION - GINA] Deploy `OGO_Portal_Deploy_8.zip`** via app.netlify.com/drop, updating the `ogodashboard1` site.
2. **[VERIFY] After deploy:** Events tab shows the five new events and none of the old ones; Time Clock pay period reads "Aug 16 - Aug 29, 2026"; check on a second browser that the old events do not reappear.
3. **[OPTIONAL] Tax deadlines as portal events.** Gina's Google Calendar has Sep 15 2026 (Q3 estimated + extended S-Corp/Partnership final), Oct 15 2026 (extended individual final), and Jan 15 2027 (Q4 estimated). Not added yet; offered and awaiting a decision.
4. **[OPTIONAL] Maria Nino hire date** is blank (salaried, so PTO is unaffected).
5. **[SUGGESTED] Overtime visibility for salaried staff** (see Limitations #3).
6. **[SUGGESTED] Auto-close or prompt for forgotten clock-outs.** Currently flagged visually after 16 hours; an admin still has to fix it with a manual entry.

---

## 12. QUICK CONTEXT FOR NEW SESSION

Gina is non-technical and needs you to DO things, not explain them. Be direct, do the work, verify it, and give her the one link or file she needs. The portal is feature-complete, bug-fixed, and browser-tested as of August 17, 2026. If she references a file on her own computer (a `C:\Users\...` path), you cannot read it: ask her to upload it to the chat, or check Google Drive, where deploy zips are archived.
