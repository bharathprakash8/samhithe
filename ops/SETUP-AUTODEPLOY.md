# One-time setup: deploy the Apps Scripts from GitHub (no laptop needed afterwards)

After this, every change to `apps-script/admin/` or `apps-script/booking/` on `main` is deployed to Google
automatically by `.github/workflows/deploy-apps-script.yml`, keeping the same web-app URLs. A health report is
saved to the `ops-status` branch (`ops/status.md`) after each deploy, every 6 hours, and on request.

Do this once, on any computer, signed in as **nidhi@samhithe.in** (about 10 minutes):

1. **Allow the Apps Script API:** open https://script.google.com/home/usersettings and turn
   **Google Apps Script API** to **On**.
2. **Create the deploy credential:** install Node.js (https://nodejs.org, LTS), then in a terminal run
   `npx @google/clasp@2.4.2 login` – a browser opens; sign in as nidhi@samhithe.in and click **Allow**.
   This creates a file called `.clasprc.json` in your home folder
   (Mac: `~/.clasprc.json`, Windows: `C:\Users\<you>\.clasprc.json`).
3. **Store it in GitHub (never anywhere else):** GitHub → bharathprakash8/samhithe → **Settings → Secrets and variables
   → Actions → New repository secret**. Name: `CLASPRC_JSON`. Value: the whole contents of `.clasprc.json`. Save.
   Then delete `.clasprc.json` from the computer.

Security notes
- The secret lets GitHub Actions update and deploy Nidhi's Apps Script projects. It is encrypted, never shown in
  logs, and not available to forks or pull requests from other people.
- To revoke: https://myaccount.google.com/permissions → remove "clasp" (or the Google Apps Script CLI), and delete the
  `CLASPRC_JSON` secret.
