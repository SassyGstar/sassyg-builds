# OGO Staff Portal (Demo Version)

🌐 **[Try it live](https://sassygstar.github.io/sassyg-builds/ogo-staff-portal/)**

A single-file staff portal web app built for a multi-office tax firm. It includes:

- 📋 Dashboard with events, announcements, tasks, and smart alerts
- ⏰ Time clock with office geofencing
- 👥 Staff directory and birthdays
- 📝 PTO / request tracking
- 🎯 **Client Command Center** — one record per client and tax year that shows
  where the file stands, what is missing, who owns it, and what happens next:
  - 14 standard workflow stages, each with one meaning, a target number of days,
    and the roles allowed to move a client into it
  - Red / yellow / green missing-information checklists for each service, with
    when the client was last asked
  - "My Work" daily queue, a "Waiting On" board (client, staff, review, IRS),
    and alerts generated automatically
  - Required fields, format checks (phone, ZIP, SSN last 4, EIN), duplicate-client
    detection, and prior-year change review
  - One activity log per client with pinnable notes, handoffs that the
    receiving employee must accept, and a record of views and changes
  - Document register with standard file names, payment holds, management
    reports, and an intake CSV import
- 📊 Analytics
- 🔄 Optional real-time sync across devices (Firebase)

## Try it

Just open `index.html` in any web browser — no installation needed.

- Pick any name and click **Enter Portal**
- Admin passcode for this demo: `DEMO1234`
- Sign in as **Alex Rivera** or **Jordan Blake** (Administrators) to see every
  Command Center tab, including Management and Setup

## About this demo

All names, phone numbers, emails, birthdays, and clients in this version are
**fictional sample data**. The Firebase configuration is a placeholder — to
enable live sync, create your own free Firebase project and paste your own
config into `FB_CONFIG` near the top of the script. Without it, the app runs
happily in offline mode and saves everything in your browser.
