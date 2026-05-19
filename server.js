'use strict';
require('dotenv').config();

const express      = require('express');
const Database     = require('better-sqlite3');
const cron         = require('node-cron');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const { Resend }   = require('resend');
const path         = require('path');

const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';

// ── Database ────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'bookings.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    phone           TEXT    NOT NULL,
    regnr           TEXT    NOT NULL,
    date            TEXT    NOT NULL,
    time            TEXT    NOT NULL,
    service         TEXT    NOT NULL DEFAULT 'Däckskifte',
    note            TEXT    DEFAULT '',
    message         TEXT    DEFAULT '',
    status          TEXT    NOT NULL DEFAULT 'pending',
    review_sent     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL
      DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
  )
`);

// Migration: lägg till email-kolumn om den saknas (befintliga databaser)
try { db.exec(`ALTER TABLE bookings ADD COLUMN email TEXT NOT NULL DEFAULT ''`); } catch {}

// ── Admin password ───────────────────────────────────────────────
let adminPasswordHash = null;

async function initAdminPassword() {
  if (process.env.ADMIN_PASSWORD_HASH) {
    adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
    console.log('  Admin: lösenord laddas från ADMIN_PASSWORD_HASH');
    return;
  }
  const plain = process.env.ADMIN_PASSWORD || 'bkdaeck2024';
  adminPasswordHash = await bcrypt.hash(plain, 10);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('  OBS: ADMIN_PASSWORD inte satt – använder standardlösenord "bkdaeck2024"');
  } else {
    console.log('  Tips: spara i .env → ADMIN_PASSWORD_HASH=' + adminPasswordHash);
  }
}

// ── E-post via Resend ────────────────────────────────────────────
async function sendEmail(to, subject, text, html) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log('[Mail inaktivt – RESEND_API_KEY saknas]');
    console.log(`  Till: ${to}\n  Ämne: ${subject}\n  Meddelande: ${text.slice(0, 80)}…`);
    return false;
  }

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from:    'BK Däck <onboarding@resend.dev>',
      to,
      subject,
      text,
      ...(html ? { html } : {}),
    });

    if (error) {
      console.error('[Mail fel]', error.message);
      return false;
    }

    console.log('[Mail OK]', data.id, '→', to);
    return true;
  } catch (err) {
    console.error('[Mail fel]', err.message);
    return false;
  }
}

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

// ── Express ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── Auth middleware ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// ── POST /api/bookings ───────────────────────────────────────────
app.post('/api/bookings', (req, res) => {
  const { name, phone, email, regnr, date, time, service, note, message } = req.body ?? {};

  if (!name || !phone || !email || !regnr || !date || !time) {
    return res.status(400).json({ error: 'Saknade obligatoriska fält' });
  }

  const result = db.prepare(`
    INSERT INTO bookings (name, phone, email, regnr, date, time, service, note, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    phone.trim(),
    email.trim().toLowerCase(),
    regnr.trim().toUpperCase(),
    date,
    time,
    service ?? 'Däckskifte',
    note ?? '',
    message ?? ''
  );

  const id = result.lastInsertRowid;
  console.log(`[Bokning #${id}] ${name} | ${date} kl ${time} | ${regnr}`);

  const svc     = service ?? 'Däckskifte';
  const custMail = email.trim().toLowerCase();
  const noteStr  = note    ? note.trim()    : '';
  const msgStr   = message ? message.trim() : '';

  // ── Notis till butiken ───────────────────────────────────────
  const shopEmail = process.env.SHOP_EMAIL;
  if (shopEmail) {
    const shopText =
      `Ny bokning #${id} via hemsidan.\n\n` +
      `Kund:     ${name}\nTelefon:  ${phone}\nE-post:   ${custMail}\n` +
      `Reg-nr:   ${regnr.toUpperCase()}\nDatum:    ${date}\nTid:      ${time}\n` +
      `Tjänst:   ${svc}\n` +
      (noteStr ? `Anteckning: ${noteStr}\n` : '') +
      (msgStr  ? `Meddelande: ${msgStr}\n`  : '');

    const shopHtml = htmlWrap(
      `<span class="badge">Ny bokning #${id}</span>
       <h2>Ny bokning mottagen</h2>
       ${row('Kund', name)}
       ${row('Telefon', phone)}
       ${row('E-post', custMail)}
       ${row('Reg-nr', regnr.toUpperCase())}
       ${row('Datum', date)}
       ${row('Tid', time)}
       ${row('Tjänst', svc)}
       ${noteStr ? row('Anteckning', noteStr) : ''}
       ${msgStr  ? row('Meddelande', msgStr)  : ''}`
    );

    sendEmail(shopEmail, `Ny bokning #${id} – ${name}`, shopText, shopHtml);
  }

  // ── Bekräftelse till kunden ──────────────────────────────────
  const custText =
    `Hej ${name},\n\nTack för din bokning hos BK Däck!\n\n` +
    `Tjänst: ${svc}\nDatum:  ${date}\nTid:    ${time}\nReg-nr: ${regnr.toUpperCase()}\n` +
    (noteStr ? `Anteckning: ${noteStr}\n` : '') +
    `\nVi bekräftar din tid via telefon eller SMS.\n` +
    `Frågor? Ring oss på 076-223 28 23.\n\nMed vänliga hälsningar,\nBK Däck`;

  const custHtml = htmlWrap(
    `<h2>Tack för din bokning, ${name.split(' ')[0]}!</h2>
     <p style="color:#5a5a5a;margin-bottom:24px;">Vi har tagit emot din förfrågan och återkommer med bekräftelse via telefon eller SMS.</p>
     ${row('Tjänst', svc)}
     ${row('Datum', date)}
     ${row('Tid', time)}
     ${row('Reg-nr', regnr.toUpperCase())}
     ${noteStr ? row('Anteckning', noteStr) : ''}
     <p style="margin-top:28px;font-size:14px;color:#5a5a5a;">Frågor? Ring oss på <strong>076-223 28 23</strong>.</p>`
  );

  sendEmail(custMail, `Bokningsbekräftelse – BK Däck`, custText, custHtml);

  res.json({ ok: true, id });
});

// ── POST /api/admin/login ────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body ?? {};
  if (!password || !adminPasswordHash) return res.status(401).json({ error: 'Fel lösenord' });

  const match = await bcrypt.compare(password, adminPasswordHash);
  if (!match) return res.status(401).json({ error: 'Fel lösenord' });

  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

// ── GET /api/admin/bookings ──────────────────────────────────────
app.get('/api/admin/bookings', requireAuth, (req, res) => {
  const { status, date } = req.query;
  let query = 'SELECT * FROM bookings WHERE 1=1';
  const params = [];

  if (status && status !== 'all') { query += ' AND status = ?'; params.push(status); }
  if (date)                       { query += ' AND date = ?';   params.push(date);   }

  query += ' ORDER BY date ASC, time ASC';
  res.json(db.prepare(query).all(...params));
});

// ── PATCH /api/admin/bookings/:id/status ────────────────────────
app.patch('/api/admin/bookings/:id/status', requireAuth, (req, res) => {
  const { status } = req.body ?? {};
  const allowed = ['pending', 'confirmed', 'completed', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Ogiltigt status' });

  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, Number(req.params.id));
  res.json({ ok: true });
});

// ── DELETE /api/admin/bookings/:id ──────────────────────────────
app.delete('/api/admin/bookings/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM bookings WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ── Cron: review-mail ~1h efter bokad tid ────────────────────────
cron.schedule('* * * * *', () => {
  const due = db.prepare(`
    SELECT * FROM bookings
    WHERE review_sent = 0
      AND status != 'cancelled'
      AND datetime(date || ' ' || time, '+60 minutes')
            <= datetime('now', 'localtime')
  `).all();

  for (const b of due) {
    const url = process.env.GOOGLE_REVIEW_URL
      ?? 'https://search.google.com/local/writereview?placeid=YOUR_PLACE_ID';

    const reviewText =
      `Hej ${b.name}!\n\nTack för att du besökte BK Däck. Vi hoppas att allt gick bra.\n\n` +
      `Dela gärna din upplevelse – det tar bara en minut:\n${url}\n\n` +
      `Med vänliga hälsningar,\nBK Däck`;

    const reviewHtml = htmlWrap(
      `<h2>Hur gick det, ${b.name.split(' ')[0]}?</h2>
       <p style="color:#5a5a5a;margin-bottom:24px;">Tack för att du besökte BK Däck! Vi hoppas att du är nöjd med din <strong>${b.service.toLowerCase()}</strong>.</p>
       <p style="margin-bottom:28px;">Har du en minut? Lämna gärna ett omdöme på Google — det hjälper oss och andra kunder.</p>
       <a href="${url}" style="display:inline-block;background:#1c3c70;color:#fff;text-decoration:none;padding:14px 28px;font-weight:700;font-size:14px;letter-spacing:0.05em;border-radius:4px;">Skriv ett omdöme →</a>`
    );

    sendEmail(b.email, `Hur gick det hos BK Däck, ${b.name}?`, reviewText, reviewHtml);

    db.prepare('UPDATE bookings SET review_sent = 1 WHERE id = ?').run(b.id);
    console.log(`[Review-mail] Skickat → ${b.name} (bokning #${b.id})`);
  }
});

// ── Start ────────────────────────────────────────────────────────
initAdminPassword().then(() => {
  app.listen(PORT, () => {
    console.log(`\nBK Däck server → http://localhost:${PORT}`);
    if (!process.env.EMAIL_USER)
      console.warn('  OBS: EMAIL_USER saknas – e-post inaktiverat');
    if (JWT_SECRET === 'change-this-secret')
      console.warn('  OBS: JWT_SECRET är standardvärdet – sätt en hemlig nyckel i .env\n');
  });
});
