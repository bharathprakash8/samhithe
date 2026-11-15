# Samhithe Admin – backend for www.samhithe.in/admin

Apps Script project **"Samhithe Admin"** in **nidhi@samhithe.in**'s account (separate from "Samhithe Booking").
Live copy of the code: `Code.gs` in this folder. The page is `admin/index.html` (its `ADMIN_API` points at this web app).

- Web app: Execute as **Me (nidhi@samhithe.in)**, access **Anyone** (the page does its own login).
- Advanced service: **Google Calendar API** (added under Services).
- Uses the "Samhithe – Bookings & Availability" sheet and adds tabs: Users, Notes, Message templates,
  Transcript links, Audit log – and for the CRM: Clients, Files, Schools, Workshops. Transcripts are Nidhi's
  "Notes by Gemini" docs in Drive (read-only, linked – never copied or moved).

## Users
- Users tab: Username, Name, Email, Role (`admin` / `assistant`), Active. Salt/Hash are written by the script – never edit them.
- New user: add a row (no password), then they use "Forgot password / set password" on the login page.
- Assistants don't see intake answers or transcripts.

## CRM (v7)
Client documents live in Nidhi's Drive under one folder, created on first use:

```
Samhithe CRM/
  Clients/<Child – Parent (#abcd)>/1 Intake & hypotheses · 2 Session notes · 3 Materials · 4 Reports & letters
  Schools/<School (#abcd)>/Agreements · Workshops · Invoices · Other
  Inbox – drop files here      ← anything saved here is moved to the right client (or waits in "To file")
```

- Folders are made only when a client/school gets its first document – never for every enquiry.
- **No duplicate files.** Folders are looked up before they are created (saved ID, then exact name, under a lock).
  Every upload is fingerprinted (MD5): a file already anywhere in Samhithe CRM is not saved again. Template docs are
  made once per client + template + session. The Claude prep pack is one doc per client, overwritten. Inbox files are
  moved, never copied. **More → Drive check** finds duplicates that came in some other way and moves the extra copies
  to Drive's Trash (restorable for 30 days) – only when Nidhi clicks.
- Files Nidhi adds straight into a client folder in Drive show up in the portal automatically.
- Background sync (Inbox auto-filing, noticing new files) runs when the portal is open, at most every 10 minutes.
  No triggers and no new Google permissions are needed.
- Assistants see pipeline, follow-ups and schools, but not documents, uploads, the Claude prep pack, To file or Drive check.
- Reminders on Today: overdue follow-ups, session held but no session notes, intake but no hypotheses, no session in 30 days,
  payment unverified after 48 h, school follow-ups, workshop report not sent after 7 days, workshop fee unpaid after 14 days.
  Each can be hidden with ×.

## Changing the code
1. Edit in script.google.com (signed in as nidhi@samhithe.in), copy the result back here.
2. **Deploy → Manage deployments → ✏️ → Version: New version → add a description (e.g. "v4 – …") → Deploy.**
   The URL stays the same.

## Versions
- v2 – Phase 1 admin portal: login, bookings, families, transcripts
- v3 – Phase 1 final: 30-min transcript cache, better name matching, test helpers removed
- v4 – Phase 2+3: availability, reschedule/cancel with emails, school enquiries, templates, users, speed cache
- v5 – Speed: dashboard data returned with sign-in, single-write user updates
- v7.1–v7.3.1 (15 Nov, deployment versions 7–10) – fixes from live end-to-end and Nidhi-style UX testing
- v7 – CRM: client profiles with Drive documents (upload, templates), pipeline & follow-ups, schools & workshops,
  reminders, Inbox auto-filing, smart search, Claude prep pack, Drive duplicate check
- v6 – Remembered devices: "Keep me signed in" sessions with no expiry, ended by sign-out, password reset/change or deactivation (deployed automatically by the Samhithe Deployer)

## Deploying changes – IMPORTANT (Nov 2026)
The Samhithe Deployer is currently **not working**: its Apps Script project uses Google's hidden default Cloud
project, where the Apps Script API can't be switched on ("Apps Script API has not been used in project 790387317843").
Until it is moved to a standard Google Cloud project, publish backend changes by hand:

1. script.google.com (as nidhi@samhithe.in) → **Samhithe Admin** → Editor → replace `Code.gs` with the file from `main` → Save.
2. **Deploy → Manage deployments → ✏️ → Version: New version →** description → **Deploy**. The URL stays the same.
3. If Google shows "Authorization required", click Review permissions and allow everything (the CRM needs full Drive access).

The page (`admin/index.html`) still updates automatically through GitHub Pages.

## Deploying changes (when the Deployer works again)
Push changes to `apps-script/admin/` on `main`. Within about 5 minutes the **Samhithe Deployer** (an Apps Script project in nidhi@samhithe.in's account, see `apps-script/deployer/`) creates a new version named after the latest commit title and moves the existing web-app deployment to it, so the URL never changes. No laptop or manual deploy is needed.
