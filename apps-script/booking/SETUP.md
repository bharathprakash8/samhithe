# Samhithe booking – how it works and how to change it

The booking page (www.samhithe.in/booking) talks to the **Samhithe Booking** Apps Script project in
**nidhi@samhithe.in**'s account. Live copy of the code: `Code.gs` and `appsscript.json` in this folder.

## Where things live (all in nidhi@samhithe.in)
- **Samhithe – Bookings & Availability** (Google Sheet)
  - *Availability*: weekly hours (Day / From / To). Sessions are offered back-to-back inside each block.
  - *Time off*: dates with no sessions.
  - *Settings*: session length, gap, minimum notice, how many days ahead.
  - *Bookings*: every booking, payment-screenshot link, Meet link, Payment Status.
  - *Intake*: first-session answers from the website (also added to the Google Form below).
  - *School enquiries*: call-back requests from preschools / schools.
- **Child & Family Information Form** (Google Form): the intake form. Website intakes are added as responses;
  parents with a response here count as returning.
- **Samhithe – Payment Screenshots** (Drive folder).
- **Google Calendar**: each booking is an event with a Meet link. Anything on the calendar blocks that time.

Sheet changes reach the website within a minute: a background job (`warmSlots`, every minute) refreshes the
cached slot list so the booking page gets a fast answer. If it is ever removed, run `installWarmup` once.

## Booking flow
1. Who's booking: *One-on-one session* or *Preschool or school* (call-back request, no slots).
2. Parent details + "first session" tick → `lookup` (email AND phone must match an earlier intake to skip it;
   ticking "first session" when either already matches shows an error).
3. Date & time → intake (first session only) → UPI payment + screenshot → `book`.

## Changing the code
1. Edit in script.google.com (signed in as nidhi@samhithe.in), then copy the result back into this folder.
2. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.** The web-app URL stays the same.
3. If Google asks for permissions again, run `setup` from the editor and approve.

## First-time setup (only if the project is ever recreated)
1. New Apps Script project "Samhithe Booking"; paste `Code.gs`; show and paste `appsscript.json`.
2. Run `setup` and approve Calendar, Drive, Sheets, Forms and email access.
3. Deploy as Web app (Execute as: Me, Who has access: Anyone) and put the `/exec` URL in `BOOKING_API`
   in `booking/index.html`.
