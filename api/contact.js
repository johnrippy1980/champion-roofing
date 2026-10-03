// Lead form handler: emails website leads through Resend (2026-10-03).
//
// Replaces FormSubmit (which needed a one time activation click in the
// info@ inbox and sent every lead through a third party). The three lead
// forms (docked form, /contact, /thank-you precursor) post here with the
// same field names they always had: Name, Phone, Email, Service, Property,
// Details, "SMS consent", plus the _honey honeypot.
//
// Env (Vercel project settings):
//   RESEND_API_KEY      required; a Resend key for the localhowl team
//   CONTACT_TO_EMAIL    comma separated recipients (default: the three owners)
//   CONTACT_FROM_EMAIL  sender; the domain must be verified in Resend
//
// Behaviour: a plain HTML form post gets a 303 to /thank-you on success and
// to /contact?error=1 on failure. A fetch/JSON caller gets JSON. The visitor
// gets a short acknowledgement from the same sender; the lead email carries
// the visitor's address as reply-to so the office can answer in one click.

const TO = (process.env.CONTACT_TO_EMAIL ||
  'preston@championroofingok.com,braden@championroofingok.com,mike@championroofingok.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const FROM = process.env.CONTACT_FROM_EMAIL || 'Champion Roofing Website <leads@championroofingok.com>';
const SITE = 'https://championroofingok.com';
const PHONE = '(405) 841-7663';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const line = (v, max) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
const block = (v, max) => String(v ?? '').trim().slice(0, max);

function wantsJson(req) {
  const accept = String(req.headers['accept'] || '');
  const ctype = String(req.headers['content-type'] || '');
  return ctype.includes('application/json') || (accept.includes('application/json') && !accept.includes('text/html'));
}

function redirect(res, to) {
  res.statusCode = 303;
  res.setHeader('Location', to);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function fail(req, res, status, message) {
  if (wantsJson(req)) {
    res.status(status).json({ error: message });
    return;
  }
  redirect(res, `/contact?error=${encodeURIComponent(message)}`);
}

async function send(key, payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = Object.fromEntries(new URLSearchParams(body)); }
  }

  // Honeypot: a real person never fills this. Pretend success so bots learn nothing.
  if (body._honey) return wantsJson(req) ? res.status(200).json({ ok: true }) : redirect(res, '/thank-you');

  const name = line(body.Name ?? body.name, 120);
  const phone = line(body.Phone ?? body.phone, 40);
  const email = line(body.Email ?? body.email, 200);
  const service = line(body.Service ?? body.service, 120);
  const property = line(body.Property ?? body.property ?? body.address, 300);
  const details = block(body.Details ?? body.message ?? body.msg, 5000);
  const sms = line(body['SMS consent'] ?? body.sms, 10) || 'No';
  const page = line(req.headers['referer'] || '', 300);
  const topic = line(body._subject, 120) || 'New roof assessment request';
  const isSubscriber = /subscriber/i.test(topic);

  if (!name) return fail(req, res, 400, 'Please tell us your name.');
  if (!phone && !email) return fail(req, res, 400, 'Please add a phone number or email.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(req, res, 400, 'Please check the email address.');

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('contact: RESEND_API_KEY is not set');
    return fail(req, res, 500, 'The form is temporarily unavailable. Please call ' + PHONE + '.');
  }

  const rows = [
    ['Name', name], ['Phone', phone], ['Email', email], ['What they need', service],
    ['Property', property], ['Text opt in', sms], ['Page', page],
  ].filter(([, v]) => v);
  const html =
    `<h2 style="font-family:sans-serif">${esc(topic)}</h2>` +
    `<table cellpadding="6" style="font-family:sans-serif;font-size:15px">` +
    rows.map(([k, v]) => `<tr><td><b>${k}</b></td><td>${esc(v)}</td></tr>`).join('') +
    `</table><p style="font-family:sans-serif"><b>Details</b></p>` +
    `<p style="font-family:sans-serif;white-space:pre-wrap">${esc(details || '(none)')}</p>` +
    `<p style="font-family:sans-serif;color:#666;font-size:13px">Sent by the lead form on ${SITE}. Reply to this email to answer ${esc(name)} directly.</p>`;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nDetails:\n${details || '(none)'}\n\nSent by the lead form on ${SITE}.`;

  try {
    await send(key, {
      from: FROM,
      to: TO,
      subject: `${topic}: ${name}${service ? ` (${service})` : ''}`,
      html,
      text,
      ...(email ? { reply_to: email } : {}),
    });
  } catch (err) {
    console.error('contact: lead send failed', err);
    return fail(req, res, 502, 'We could not send your request. Please call ' + PHONE + '.');
  }

  // Visitor acknowledgement. Best effort: the lead is already delivered.
  if (email) {
    try {
      await send(key, {
        from: FROM,
        to: [email],
        subject: isSubscriber ? 'You are on the Champion Roofing list' : 'We have your roof assessment request',
        text: isSubscriber
          ? `Hi ${name},\n\nThanks for signing up. We will send occasional roofing tips and storm season reminders for Oklahoma City, nothing more. Reply STOP at any time and we will take you off the list.\n\nChampion Roofing\n${SITE}`
          : `Hi ${name},\n\nThanks, we have your roof assessment request. Someone from the Champion Roofing office will call you during business hours, Monday to Friday 9am to 5pm, to set a time.\n\nIf it is urgent, call ${PHONE}.\n\nChampion Roofing\n${SITE}`,
      });
    } catch (err) {
      console.error('contact: acknowledgement failed', err);
    }
  }

  return wantsJson(req) ? res.status(200).json({ ok: true }) : redirect(res, '/thank-you');
}
