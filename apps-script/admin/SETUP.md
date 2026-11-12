# Samhithe Admin – backend for www.samhithe.in/admin

Apps Script project **"Samhithe Admin"** in **nidhi@samhithe.in**'s account (separate from "Samhithe Booking").
Live copy of the code: `Code.gs` in this folder. The page is `admin/index.html` (its `ADMIN_API` points at this web app).

- Web app: Execute as **Me (nidhi@samhithe.in)**, access **Anyone** (the page does its own login).
- Advanced service: **Google Calendar API** (added under Services).
- Uses the "Samhithe – Bookings & Availability" sheet and adds tabs: Users, Notes, Message templates,
  Transcript links, Audit log. Transcripts are Nidhi's "Notes by Gemini" docs in Drive (read-only).

## Users
- Users tab: Username, Name, Email, Role (`admin` / `assistant`), Active. Salt/Hash are written by the script – never edit them.
- New user: add a row (no password), then they use "Forgot password / set password" on the login page.
- Assistants don't see intake answers or transcripts.

## Changing the code
1. Edit in script.google.com (signed in as nidhi@samhithe.in), copy the result back here.
2. **Deploy → Manage deployments → ✏️ → Version: New version → add a description (e.g. "v4 – …") → Deploy.**
   The URL stays the same.

## Versions
- v2 – Phase 1 admin portal: login, bookings, families, transcripts
- v3 – Phase 1 final: 30-min transcript cache, better name matching, test helpers removed
- v4 – Phase 2+3: availability, reschedule/cancel with emails, school enquiries, templates, users, speed cache
- v5 – Speed: dashboard data returned with sign-in, single-write user updates
- v6 – Remembered devices: "Keep me signed in" sessions with no expiry, ended by sign-out, password reset/change or deactivation (deployed automatically by the Samhithe Deployer)

## Deploying changes
Push changes to `apps-script/admin/` on `main`. Within about 5 minutes the **Samhithe Deployer** (an Apps Script project in nidhi@samhithe.in's account, see `apps-script/deployer/`) creates a new version named after the latest commit title and moves the existing web-app deployment to it, so the URL never changes. No laptop or manual deploy is needed.
