# Samhithe – Child and Family Wellness

Website for [samhithe.in](https://samhithe.in), hosted on GitHub Pages.

## Structure
- `index.html` – the full single-page site (Home, About Nidhi, Services, Contact)
- `apps-script/Code.gs` – Google Apps Script backend for the contact form
- `booking/index.html` – the Book a Session page; the Book a Session flow
- `bookings/index.html` – redirects `/bookings` to `/booking/`
- `.nojekyll` – serve files as-is

## Enable GitHub Pages
Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `/ (root)` → Save.
The site goes live at `https://bharathprakash8.github.io/samhithe/`.

## Connect the contact form
1. Deploy `apps-script/Code.gs` as a web app (steps in the file header).
2. Paste the `/exec` URL into `SITE.FORM_ENDPOINT` in `index.html` and commit.

Until then, the form opens a pre-filled email to nidhi@samhithe.in.

## Booking page
`booking/index.html` is the full booking flow: date-wise slots, parent and child details, UPI payment
(QR code `booking/upi-qr.png`, PhonePe and Google Pay buttons) and a required payment screenshot.
The calendar is booked only when the form is submitted with the screenshot.

It runs on the Apps Script in `apps-script/booking/`. Follow `apps-script/booking/SETUP.md`, then paste the
web-app URL into `BOOKING_API` in `booking/index.html`. Until then the page the Book a Session flow.
Preview the flow with sample data at `/booking/?demo=1`.

## Point samhithe.in here (when ready)
1. Settings → Pages → Custom domain: `samhithe.in` (this adds a `CNAME` file).
2. At your domain registrar, add A records for `@` → `185.199.108.153`, `185.199.109.153`,
   `185.199.110.153`, `185.199.111.153`, and a CNAME for `www` → `bharathprakash8.github.io`.
3. Once DNS resolves, tick **Enforce HTTPS**.
