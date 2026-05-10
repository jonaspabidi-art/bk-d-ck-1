'use strict';
require('dotenv').config();

const express      = require('express');
const Database     = require('better-sqlite3');
const cron         = require('node-cron');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const nodemailer   = require('nodemailer');
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

// ── E-post via Nodemailer ────────────────────────────────────────
function createTransporter() {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_APP_PASSWORD;

  if (!user || !pass) return null;

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

async function sendEmail(to, subject, text) {
  const transporter = createTransporter();

  if (!transporter) {
    console.log('[Mail inaktivt – EMAIL_USER/EMAIL_APP_PASSWORD saknas]');
    console.log(`  Till: ${to}\n  Ämne: ${subject}\n  Meddelande: ${text.slice(0, 80)}…`);
    return false;
  }

  try {
    const info = await transporter.sendMail({
      from:    `"BK Däck" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      text,
    });
    console.log('[Mail OK]', info.messageId, '→', to);
    return true;
  } catch (err) {
    console.error('[Mail fel]', err.message);
    return false;
  }
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

  // Notis till butiken
  const shopEmail = process.env.SHOP_EMAIL;
  if (shopEmail) {
    sendEmail(
      shopEmail,
      `Ny bokning #${id} – ${name}`,
      `Ny bokning mottagen via hemsidan.\n\n` +
      `Kund:     ${name}\n` +
      `Telefon:  ${phone}\n` +
      `E-post:   ${email.trim().toLowerCase()}\n` +
      `Reg-nr:   ${regnr.toUpperCase()}\n` +
      `Datum:    ${date}\n` +
      `Tid:      ${time}\n` +
      `Tjänst:   ${service ?? 'Däckskifte'}\n` +
      (note    ? `Anteckning: ${note}\n`    : '') +
      (message ? `Meddelande: ${message}\n` : '') +
      `\nAdminpanel: http://localhost:${PORT}/admin.html`
    );
  }

  // Bekräftelse till kunden
  sendEmail(
    email.trim().toLowerCase(),
    `Bokningsbekräftelse – BK Däck`,
    `Hej ${name},\n\n` +
    `Tack för din bokning hos BK Däck! Vi har mottagit din förfrågan.\n\n` +
    `Tjänst:  ${service ?? 'Däckskifte'}\n` +
    `Datum:   ${date}\n` +
    `Tid:     ${time}\n` +
    `Reg-nr:  ${regnr.toUpperCase()}\n` +
    (note ? `Anteckning: ${note}\n` : '') +
    `\nVi bekräftar din tid via telefon eller SMS.\n` +
    `Frågor? Ring oss på 076-223 28 23.\n\n` +
    `Med vänliga hälsningar,\nBK Däck\nRingögatan 13, 417 07 Göteborg`
  );

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

    sendEmail(
      b.email,
      `Hur gick det hos BK Däck, ${b.name}?`,
      `Hej ${b.name}!\n\n` +
      `Tack för att du besökte BK Däck idag. Vi hoppas att allt gick bra med din ${b.service.toLowerCase()}.\n\n` +
      `Dela gärna din upplevelse – det tar bara en minut:\n${url}\n\n` +
      `Med vänliga hälsningar,\nBK Däck\nRingögatan 13, 417 07 Göteborg\n076-223 28 23`
    );

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
