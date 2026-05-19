'use strict';

const { Resend } = require('resend');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function htmlWrap(content) {
  return `<!DOCTYPE html><html lang="sv"><head><meta charset="UTF-8">
<style>
  body { margin:0; padding:0; background:#f2f1ed; font-family:Arial,sans-serif; }
  .wrap { max-width:560px; margin:32px auto; background:#fff; border-radius:4px; overflow:hidden; }
  .header { background:#1c3c70; padding:28px 32px; }
  .header h1 { margin:0; color:#fff; font-size:22px; letter-spacing:0.04em; }
  .header p { margin:4px 0 0; color:rgba(255,255,255,0.6); font-size:13px; }
  .body { padding:32px; color:#1a1a1a; font-size:15px; line-height:1.6; }
  .body h2 { margin:0 0 20px; font-size:18px; color:#1c3c70; }
  .detail-row { display:flex; padding:10px 0; border-bottom:1px solid #eee; gap:12px; }
  .detail-row:last-child { border-bottom:none; }
  .detail-label { width:110px; flex-shrink:0; font-size:13px; font-weight:600; color:#5a5a5a; text-transform:uppercase; letter-spacing:0.05em; }
  .detail-value { font-size:14px; color:#1a1a1a; font-weight:500; }
  .footer { background:#f7f6f2; padding:20px 32px; font-size:12px; color:#9a9a9a; line-height:1.6; border-top:1px solid #eee; }
  .badge { display:inline-block; background:#c8a84b; color:#1a1a1a; font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; padding:4px 10px; border-radius:2px; margin-bottom:20px; }
</style></head><body>
<div class="wrap">
  <div class="header">
    <h1>BK DÄCK</h1>
    <p>Ringögatan 13 · 417 07 Göteborg · 076-223 28 23</p>
  </div>
  <div class="body">${content}</div>
  <div class="footer">
    BK Däck HB · Ringögatan 13, 417 07 Göteborg · Org.nr 969788-9526<br>
    Frågor? Ring oss på <strong>076-223 28 23</strong> eller svara på detta mail.
  </div>
</div>
</body></html>`;
}

function row(label, value) {
  return `<div class="detail-row"><span class="detail-label">${label}</span><span class="detail-value">${value}</span></div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Ogiltig förfrågan' }) };
  }

  const { name, phone, email, regnr, date, time, service, note } = body;

  if (!name || !phone || !email || !regnr || !date || !time) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Saknade obligatoriska fält' }) };
  }

  const svc      = service || 'Däckskifte';
  const noteStr  = note ? note.trim() : '';
  const custMail = email.trim().toLowerCase();
  const regStr   = regnr.trim().toUpperCase();

  const resend    = new Resend(process.env.RESEND_API_KEY);
  const shopEmail = process.env.SHOP_EMAIL;
  const fromAddr  = process.env.FROM_EMAIL || 'onboarding@resend.dev';

  // ── Mail till verkstaden ─────────────────────────────────────
  if (shopEmail) {
    await resend.emails.send({
      from:    `BK Däck <${fromAddr}>`,
      to:      shopEmail,
      subject: `Ny bokning – ${name}`,
      text:    `Ny bokning via hemsidan.\n\nKund: ${name}\nTelefon: ${phone}\nE-post: ${custMail}\nReg-nr: ${regStr}\nDatum: ${date}\nTid: ${time}\nTjänst: ${svc}${noteStr ? '\nAnteckning: ' + noteStr : ''}`,
      html: htmlWrap(
        `<span class="badge">Ny bokning</span>
         <h2>Ny bokning mottagen</h2>
         ${row('Kund', name)}
         ${row('Telefon', phone)}
         ${row('E-post', custMail)}
         ${row('Reg-nr', regStr)}
         ${row('Datum', date)}
         ${row('Tid', time)}
         ${row('Tjänst', svc)}
         ${noteStr ? row('Anteckning', noteStr) : ''}`
      ),
    });
  }

  // ── Bekräftelse till kunden ──────────────────────────────────
  await resend.emails.send({
    from:    `BK Däck <${fromAddr}>`,
    to:      custMail,
    subject: 'Bokningsbekräftelse – BK Däck',
    text:    `Hej ${name},\n\nTack för din bokning!\n\nTjänst: ${svc}\nDatum: ${date}\nTid: ${time}\nReg-nr: ${regStr}${noteStr ? '\nAnteckning: ' + noteStr : ''}\n\nVi bekräftar din tid via telefon eller SMS.\nFrågor? Ring 076-223 28 23.\n\nMed vänliga hälsningar,\nBK Däck`,
    html: htmlWrap(
      `<h2>Tack för din bokning, ${name.split(' ')[0]}!</h2>
       <p style="color:#5a5a5a;margin-bottom:24px;">Vi har tagit emot din förfrågan och återkommer med bekräftelse via telefon eller SMS.</p>
       ${row('Tjänst', svc)}
       ${row('Datum', date)}
       ${row('Tid', time)}
       ${row('Reg-nr', regStr)}
       ${noteStr ? row('Anteckning', noteStr) : ''}
       <p style="margin-top:28px;font-size:14px;color:#5a5a5a;">Frågor? Ring oss på <strong>076-223 28 23</strong>.</p>`
    ),
  });

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
};
