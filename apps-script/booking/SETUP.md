# Samhithe booking – how it works and how to change it

The booking page (www.samhithe.in/booking) talks to the **Samhithe Booking** Apps Script project in
**nidhi@samhithe.in**'s account. Live copy of the code: `Code.gs` and `appsscript.json` in this folder.

## Where things live (all in nidhi@samhithe.in)
- **Samhithe – Bookings & Availability** (Google Sheet)
  - *Availability*: weekly hours (Day / From / To). Sessions are offered back-to-back inside each block.
  - *Time off*: dates with no sessions.
  - *Settings*: session length, gap, minimum notice, how many days ahead.
  - *Bookings*: every booking, payment-screenshot link, Meet link, Payment Status.
  - *Intake*: every child & family intake – website answers plus the answers copied over from the old Google
    Form (column *Source*). Returning parents are recognised from this tab.
  - *School enquiries*: call-back requests from preschools / schools.
- **Child & Family Information Form** (old Google Form): retired. Its answers were copied into the *Intake* tab
  with `copyOldFormToIntake` (safe to run again; it skips anything already copied).
- **Samhithe – Payment Screenshots** (Drive folder).
- **Google Calendar**: each booking is an event with a Meet link. Anything on the calendar blocks that time.

A background job (`warmSlots`, every minute) does two things: it finishes recent bookings (saves the intake
row, sends the parent's confirmation email and Nidhi's alert) and refreshes the cached slot list, so sheet
changes reach the website within a minute. A booking confirms in a few seconds; the emails follow within a
minute. If the job is ever removed, run `installWarmup` once.

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
2. Run `setup` and approve Calendar, Drive, Sheets and email access, then run `installWarmup`.
3. Deploy as Web app (Execute as: Me, Who has access: Anyone) and put the `/exec` URL in `BOOKING_API`
   in `booking/index.html`.
