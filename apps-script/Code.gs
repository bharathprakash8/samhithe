/**
 * Samhithe – Contact form backend (Google Apps Script)
 *
 * The website itself is hosted on GitHub Pages. This script only receives
 * Contact-page messages, saves them to a Google Sheet and emails you.
 *
 * SETUP
 * 1. script.google.com → open your "Samhithe Website" project (or create one).
 * 2. Replace Code.gs with this file.
 * 3. Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone → Deploy.
 * 4. Copy the /exec URL and paste it into SITE.FORM_ENDPOINT in index.html.
 *
 * The first message creates a sheet called "Samhithe – Website Enquiries" in your Drive.
 */
function doPost(e) {
  try {
    submitContact((e && e.parameter) || {});
    return ContentService.createTextOutput('ok');
  } catch (err) {
    return ContentService.createTextOutput('error: ' + err.message);
  }
}

function submitContact(p) {
  p = p || {};
  if (p.website) return 'ok';                                   // spam trap
  if (!p.name || !p.message || (!p.email && !p.phone)) throw new Error('Missing details');

  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('ENQUIRY_SHEET_ID'), ss;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Samhithe – Website Enquiries');
    const sh = ss.getSheets()[0];
    sh.setName('Enquiries');
    sh.appendRow(['Received', 'I am a', 'Name', 'Email', 'WhatsApp / phone', "Child's age", 'Message', 'Replied?']);
    sh.setFrozenRows(1);
    props.setProperty('ENQUIRY_SHEET_ID', ss.getId());
  }
  const clean = v => String(v || '').slice(0, 2000);
  ss.getSheetByName('Enquiries').appendRow([new Date(), clean(p.role), clean(p.name), clean(p.email),
    "'" + clean(p.phone), clean(p.age), clean(p.message), 'No']);

  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    replyTo: p.email || undefined,
    subject: 'New website enquiry: ' + clean(p.name) + ' (' + clean(p.role) + ')',
    body: 'I am a: ' + clean(p.role) + '\nName: ' + clean(p.name) + '\nEmail: ' + (clean(p.email) || '-') +
      '\nWhatsApp / phone: ' + (clean(p.phone) || '-') + "\nChild's age: " + (clean(p.age) || '-') +
      '\n\nMessage:\n' + clean(p.message) + '\n\nAll enquiries: ' + ss.getUrl(),
  });
  return 'ok';
}
