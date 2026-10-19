# Samhithe – Child and Family Wellness

Website for [samhithe.in](https://samhithe.in), hosted on GitHub Pages.

## Structure
- `index.html` – the full single-page site (Home, About Nidhi, Services, Contact)
- `apps-script/Code.gs` – Google Apps Script backend for the contact form
- `booking/index.html` – the Book a Session page; embeds the booking Apps Script web app
- `bookings/index.html` – redirects `/bookings` to `/booking/`
- `.nojekyll` – serve files as-is

## Enable GitHub Pages
Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `/ (root)` → Save.
The site goes live at `https://bharathprakash8.github.io/samhithe/`.

## Connect the contact form
1. Deploy `apps-script/Code.gs` as a web app (steps in the file header).
2. Paste the `/exec` URL into `SITE.FORM_ENDPOINT` in `index.html` and commit.

Until then, the form opens a pre-filled email to nidhi@samhithe.in.

## Connect the booking page
Paste the booking script's web-app URL (ends in `/exec`) into `BOOKING_APP_URL` near the bottom of `booking/index.html` and commit.
In that script's `doGet`, add `.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)` so it can show inside the page, and deploy with access set to **Anyone**.
Until the URL is set, the page shows WhatsApp and email buttons instead.

## Point samhithe.in here (when ready)
1. Settings → Pages → Custom domain: `samhithe.in` (this adds a `CNAME` file).
2. At your domain registrar, add A records for `@` → `185.199.108.153`, `185.199.109.153`,
   `185.199.110.153`, `185.199.111.153`, and a CNAME for `www` → `bharathprakash8.github.io`.
3. Once DNS resolves, tick **Enforce HTTPS**.
