# OGO Staff Portal (Demo Version)

🌐 **[Try it live](https://sassygstar.github.io/sassyg-builds/ogo-staff-portal/)**

A single-file staff portal web app built for a multi-office tax firm. It includes:

- 📋 Dashboard with events, announcements, tasks, and smart alerts
- ⏰ Time clock with office geofencing
- 👥 Staff directory and birthdays
- 📝 PTO / request tracking
- 🎯 **Client Command Center** — one simple flow for every return:
  **Created By → Preparation Status → IRS Status**
  - Preparation Status (Missing Documents, Needs Work, Ready to Send, Client
    Opts Out) and IRS Status (Submitted, Rejected, Resend) change right from
    the list with dropdowns
  - Status cards that filter the list, a "My Work" queue, and automatic alerts
  - Missing-documents checklist per service, a per-client activity log, and a
    record of every status change
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
