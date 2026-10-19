# Samhithe booking: one-time setup (about 10 minutes)

Do this signed in as **nidhi@samhithe.in**. Bookings then land on her calendar, payment screenshots
go to her Drive, and the alert emails reach her.

## 1. Create the script
1. Go to **script.google.com** and click **New project**. Rename it **Samhithe Booking**.
2. Delete everything in `Code.gs` and paste in the contents of `Code.gs` from this folder.
3. Click **Project Settings** (gear icon) and tick **Show "appsscript.json" manifest file in editor**.
   Back in the editor, open `appsscript.json` and replace it with the `appsscript.json` from this folder.

## 2. Check the settings at the top of Code.gs
- `UPI_ID` is already `nidhirao.1997-2@okaxis`.
- `AVAILABILITY_TITLE` is `Session with Nidhi`. Slots are offered only inside calendar blocks with this
  exact title. If there are none, the weekly `HOURS` (Mon–Sat, 10am–6pm) are used instead.
- `MIN_NOTICE_HOURS` (12) and `DAYS_AHEAD` (21) control how soon and how far ahead parents can book.

## 3. Run setup once
1. In the toolbar, choose **setup** in the function dropdown and click **Run**.
2. Click **Review permissions**, choose Nidhi's account, then **Allow**. It asks for Calendar, Drive,
   Sheets and email access because it books sessions, stores screenshots and sends confirmations.
3. The log shows links to the new **Samhithe – Session Bookings** sheet and the
   **Samhithe – Payment Screenshots** folder, plus how many open slots it found.

## 4. Deploy
1. Click **Deploy → New deployment**. Click the gear next to "Select type" and choose **Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**.
3. Copy the **Web app URL** (it ends in `/exec`).

## 5. Connect the website
Paste that URL into `BOOKING_API` near the bottom of `booking/index.html` and commit, or send it to Claude.
The booking page switches from the Google Calendar fallback to the full booking flow.

## Day to day
- **Each booking:** Nidhi gets an email with the payment screenshot attached. She checks the ₹1,000 credit
  and sets **Payment Status** to *Verified* (or *Problem*) in the bookings sheet.
- **Changing hours:** add, move or delete "Session with Nidhi" blocks in Google Calendar. Other events on her
  calendar automatically block those times.
- **Cancelling:** delete the event in Google Calendar (choose to email the guest). The slot reopens on the website.
- **After editing the code:** Deploy → Manage deployments → pencil icon → Version: **New version** → Deploy.
  The URL stays the same.

## Note on the old Google Calendar booking page
The "Session with Nidhi" appointment page lets parents book **without paying**. Once this is live,
remove its link wherever it's shared (Instagram bio, WhatsApp) and point people to www.samhithe.in/booking.
