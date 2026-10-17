# Samhithe – Child and Family Wellness

Website for [samhithe.in](https://samhithe.in), hosted on GitHub Pages.

## Structure
- `index.html` – the full single-page site (Home, About Nidhi, Services, Contact)
- `apps-script/Code.gs` – Google Apps Script backend for the contact form
- `.nojekyll` – serve files as-is

## Enable GitHub Pages
Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `/ (root)` → Save.
The site goes live at `https://bharathprakash8.github.io/samhithe/`.

## Connect the contact form
1. Deploy `apps-script/Code.gs` as a web app (steps in the file header).
2. Paste the `/exec` URL into `SITE.FORM_ENDPOINT` in `index.html` and commit.

Until then, the form opens a pre-filled email to nidhi@samhithe.in.

## Point samhithe.in here (when ready)
1. Settings → Pages → Custom domain: `samhithe.in` (this adds a `CNAME` file).
2. At your domain registrar, add A records for `@` → `185.199.108.153`, `185.199.109.153`,
   `185.199.110.153`, `185.199.111.153`, and a CNAME for `www` → `bharathprakash8.github.io`.
3. Once DNS resolves, tick **Enforce HTTPS**.
