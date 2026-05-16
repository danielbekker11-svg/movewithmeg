/**
 * Move With Meg — Consultation Booking System
 * Client requests → Meg confirms or declines
 */

require('dotenv').config();
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const cron     = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ─── CONFIG ───────────────────────────────────
const CFG = {
  name:       process.env.YOUR_NAME      || 'Meg',
  email:      process.env.BUSINESS_EMAIL || '',
  phone:      process.env.BUSINESS_PHONE || '',
  instagram:  process.env.BUSINESS_INSTAGRAM || 'movewithmeg',
  adminPass:  process.env.ADMIN_PASSWORD || 'changeme123',
  workDays:   (process.env.WORK_DAYS || '1,2,3,4,5').split(',').map(Number),
  workStart:  process.env.WORK_START || '08:00',
  workEnd:    process.env.WORK_END   || '17:00',
  slotMins:   parseInt(process.env.SLOT_DURATION  || '60'),
  bufferMins: parseInt(process.env.BUFFER_MINUTES || '15'),
  advanceDays:parseInt(process.env.ADVANCE_DAYS   || '30'),
  fromName:   process.env.SMTP_FROM_NAME  || 'Move With Meg',
  fromEmail:  process.env.SMTP_FROM_EMAIL || 'noreply@example.com',
};

// ─── DATABASE ─────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'bookings.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id            TEXT PRIMARY KEY,
    client_name   TEXT NOT NULL,
    client_phone  TEXT NOT NULL,
    client_email  TEXT,
    goal          TEXT,
    date          TEXT NOT NULL,
    time          TEXT NOT NULL,
    status        TEXT DEFAULT 'pending',
    reminder_sent INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_date   ON bookings(date);
  CREATE INDEX IF NOT EXISTS idx_status ON bookings(status);
`);

// ─── EMAIL ────────────────────────────────────
// ─── EMAIL via Brevo HTTP API (bypasses SMTP port blocking) ──────────────────
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
if (BREVO_API_KEY) {
  console.log('✓ Email configured via Brevo API');
} else {
  console.log('⚠  Email not configured — set BREVO_API_KEY in Railway Variables');
}

async function sendEmail(to, subject, html) {
  if (!BREVO_API_KEY || !to) return false;
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: CFG.fromName, email: CFG.fromEmail },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Email API error:', err);
      return false;
    }
    console.log('✓ Email sent to', to);
    return true;
  } catch(e) {
    console.error('Email error:', e.message);
    return false;
  }
}

// ─── HELPERS ──────────────────────────────────
function toMins(t) { const [h,m]=t.split(':').map(Number); return h*60+m; }
function fromMins(m) { return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; }
function fmt12(t) { const [h,m]=t.split(':').map(Number); return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`; }
function fmtDate(s) {
  return new Date(s+'T00:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
}

function getAvailableSlots(dateStr) {
  const date = new Date(dateStr+'T00:00:00');
  const dow  = date.getDay();
  if (!CFG.workDays.includes(dow)) return [];

  const today = new Date(); today.setHours(0,0,0,0);
  if (date < today) return [];

  // All possible slots
  const slots = [];
  const start = toMins(CFG.workStart);
  const end   = toMins(CFG.workEnd);
  for (let m = start; m + CFG.slotMins <= end; m += CFG.slotMins) slots.push(m);

  // Booked slots
  const booked = db.prepare(
    "SELECT time FROM bookings WHERE date=? AND status IN ('pending','confirmed')"
  ).all(dateStr).map(b => toMins(b.time));

  const now = new Date();
  return slots.filter(s => {
    // Hide past slots if today
    if (date.toDateString() === now.toDateString()) {
      if (s < now.getHours()*60 + now.getMinutes() + 60) return false;
    }
    // Check conflicts
    for (const b of booked) {
      if (s < b + CFG.slotMins + CFG.bufferMins && s + CFG.slotMins + CFG.bufferMins > b) return false;
    }
    return true;
  }).map(m => ({ value: fromMins(m), label: fmt12(fromMins(m)) }));
}

// ─── EMAIL TEMPLATES ──────────────────────────
function layout(body) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:540px;margin:0 auto;padding:24px;background:#f9f6f3;">
  <div style="background:#fff;border-radius:14px;padding:32px;border:1px solid #ede8e0;">
    <div style="text-align:center;padding-bottom:20px;margin-bottom:24px;border-bottom:1px solid #ede8e0;">
      <div style="font-size:22px;font-weight:700;color:#6b4c3b;letter-spacing:.04em;">MOVE WITH MEG</div>
      <div style="font-size:13px;color:#b08070;margin-top:4px;letter-spacing:.06em;">BIOKINETICS & WELLNESS</div>
    </div>
    ${body}
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid #ede8e0;font-size:13px;color:#b08070;text-align:center;">
      ${CFG.phone ? `<div>${CFG.phone}</div>` : ''}
      ${CFG.email ? `<div>${CFG.email}</div>` : ''}
      <div style="margin-top:6px;">@${CFG.instagram}</div>
    </div>
  </div>
</div>`;
}

function detailTable(b) {
  return `<table style="width:100%;border-collapse:collapse;background:#f9f6f3;border-radius:8px;margin:16px 0;">
    <tr><td style="padding:11px 14px;font-size:13px;color:#b08070;width:110px;">Service</td>
        <td style="padding:11px 14px;font-size:14px;font-weight:600;color:#3d2c24;">Initial Consultation</td></tr>
    <tr style="border-top:1px solid #ede8e0;">
        <td style="padding:11px 14px;font-size:13px;color:#b08070;">Date</td>
        <td style="padding:11px 14px;font-size:14px;font-weight:600;color:#3d2c24;">${fmtDate(b.date)}</td></tr>
    <tr style="border-top:1px solid #ede8e0;">
        <td style="padding:11px 14px;font-size:13px;color:#b08070;">Time</td>
        <td style="padding:11px 14px;font-size:14px;font-weight:600;color:#3d2c24;">${fmt12(b.time)}</td></tr>
    ${b.goal ? `<tr style="border-top:1px solid #ede8e0;">
        <td style="padding:11px 14px;font-size:13px;color:#b08070;vertical-align:top;">Goal</td>
        <td style="padding:11px 14px;font-size:14px;color:#3d2c24;">${b.goal}</td></tr>` : ''}
  </table>`;
}

function emailToMeg(b) {
  return layout(`
    <h2 style="font-size:20px;font-weight:600;color:#3d2c24;margin:0 0 12px;">New consultation request</h2>
    <p style="color:#6b4c3b;margin:0 0 4px;">From: <strong>${b.client_name}</strong></p>
    <p style="color:#6b4c3b;margin:0 0 4px;">Phone: <a href="tel:${b.client_phone}" style="color:#c9856a;font-weight:600;">${b.client_phone}</a></p>
    ${b.client_email ? `<p style="color:#6b4c3b;margin:0 0 16px;">Email: ${b.client_email}</p>` : '<div style="margin-bottom:16px;"></div>'}
    ${detailTable(b)}
    <a href="${PUBLIC_URL}/admin" style="display:inline-block;background:#6b4c3b;color:#fff;padding:13px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Open Dashboard →</a>
  `);
}

function emailConfirmed(b) {
  return layout(`
    <h2 style="font-size:22px;font-weight:600;color:#3d2c24;margin:0 0 10px;">You're booked in! ✓</h2>
    <p style="color:#6b4c3b;margin:0 0 16px;">Hi ${b.client_name}! ${CFG.name} is looking forward to meeting you.</p>
    ${detailTable(b)}
    <p style="color:#b08070;font-size:14px;margin:0;">Need to reschedule? Please get in touch: <strong>${CFG.phone || CFG.email}</strong></p>
  `);
}

function emailDeclined(b) {
  return layout(`
    <h2 style="font-size:22px;font-weight:600;color:#3d2c24;margin:0 0 10px;">Booking update</h2>
    <p style="color:#6b4c3b;margin:0 0 16px;">Hi ${b.client_name}, unfortunately that time slot isn't available. Please request a different time.</p>
    ${detailTable(b)}
    <a href="${PUBLIC_URL}" style="display:inline-block;background:#6b4c3b;color:#fff;padding:13px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Choose Another Time →</a>
  `);
}

function emailReminder(b) {
  return layout(`
    <h2 style="font-size:22px;font-weight:600;color:#3d2c24;margin:0 0 10px;">See you tomorrow! 👋</h2>
    <p style="color:#6b4c3b;margin:0 0 16px;">Hi ${b.client_name}, just a reminder about your consultation tomorrow with ${CFG.name}.</p>
    ${detailTable(b)}
    <p style="color:#b08070;font-size:14px;">Can't make it? Please let ${CFG.name} know: <strong>${CFG.phone || CFG.email}</strong></p>
  `);
}

// ─── MIDDLEWARE ────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  const t = req.headers['x-admin-token'] || req.query.token;
  if (t !== CFG.adminPass) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── PUBLIC API ───────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({
    name:        CFG.name,
    instagram:   CFG.instagram,
    phone:       CFG.phone,
    workDays:    CFG.workDays,
    advanceDays: CFG.advanceDays,
  });
});

app.get('/api/slots/:date', (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
  res.json({ slots: getAvailableSlots(date) });
});

app.post('/api/book', async (req, res) => {
  const { client_name, client_phone, client_email, goal, date, time } = req.body;
  if (!client_name?.trim())  return res.status(400).json({ error: 'Please enter your name.' });
  if (!client_phone?.trim()) return res.status(400).json({ error: 'Please enter your phone number.' });
  if (!date) return res.status(400).json({ error: 'Please choose a date.' });
  if (!time) return res.status(400).json({ error: 'Please choose a time.' });

  // Re-check availability
  const slots = getAvailableSlots(date).map(s => s.value);
  if (!slots.includes(time)) {
    return res.status(409).json({ error: 'That slot was just taken. Please choose another time.' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO bookings (id, client_name, client_phone, client_email, goal, date, time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, client_name.trim(), client_phone.trim(),
         (client_email||'').trim().toLowerCase(), (goal||'').trim(), date, time);

  const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);

  // Notify Meg
  if (CFG.email) {
    sendEmail(CFG.email,
      `New booking request — ${client_name} — ${fmtDate(date)}`,
      emailToMeg(booking)
    );
  }

  res.json({ success: true, dateFormatted: fmtDate(date), timeFormatted: fmt12(time) });
});

// ─── ADMIN API ────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === CFG.adminPass) {
    res.json({ success: true, token: CFG.adminPass });
  } else {
    res.status(401).json({ error: 'Wrong password.' });
  }
});

app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const fmt = b => ({ ...b, dateFormatted: fmtDate(b.date), timeFormatted: fmt12(b.time) });

  res.json({
    stats: {
      pending:   db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status='pending'").get().c,
      today:     db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status='confirmed' AND date=?").get(today).c,
      thisWeek:  db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status='confirmed' AND date>=? AND date<=date(?,'+'||7||' days')").get(today,today).c,
      allTime:   db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status='confirmed'").get().c,
    },
    pending:   db.prepare("SELECT * FROM bookings WHERE status='pending'   ORDER BY date,time").all().map(fmt),
    confirmed: db.prepare("SELECT * FROM bookings WHERE status='confirmed' AND date>=? ORDER BY date,time").all(today).map(fmt),
    past:      db.prepare("SELECT * FROM bookings WHERE status='confirmed' AND date<? ORDER BY date DESC,time DESC LIMIT 50").all(today).map(fmt),
    declined:  db.prepare("SELECT * FROM bookings WHERE status='declined'  ORDER BY created_at DESC LIMIT 30").all().map(fmt),
  });
});

app.post('/api/admin/confirm/:id', requireAdmin, async (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE bookings SET status='confirmed' WHERE id=?").run(b.id);
  if (b.client_email) {
    sendEmail(b.client_email, `You're booked in! — ${fmtDate(b.date)} at ${fmt12(b.time)}`, emailConfirmed(b));
  }
  res.json({ success: true });
});

app.post('/api/admin/decline/:id', requireAdmin, async (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE bookings SET status='declined' WHERE id=?").run(b.id);
  if (b.client_email) {
    sendEmail(b.client_email, `Booking update — Move With Meg`, emailDeclined(b));
  }
  res.json({ success: true });
});

app.post('/api/admin/cancel/:id', requireAdmin, (req, res) => {
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM bookings ORDER BY date DESC, time DESC').all();
  const headers = ['Name','Phone','Email','Goal','Date','Time','Status','Submitted'];
  const csv = [headers.join(','), ...rows.map(b => [
    b.client_name, b.client_phone, b.client_email||'',
    (b.goal||'').replace(/"/g,'""'), b.date, b.time, b.status, b.created_at
  ].map(x=>`"${String(x||'').replace(/"/g,'""')}"`).join(','))].join('\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="bookings-${new Date().toISOString().split('T')[0]}.csv"`);
  res.send(csv);
});

// ─── ROUTES ───────────────────────────────────
app.get('/',      (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'public','admin.html')));

// ─── REMINDER CRON ────────────────────────────
cron.schedule('*/10 * * * *', async () => {
  if (!BREVO_API_KEY) return;
  const now      = new Date();
  const tomorrow = new Date(now.getTime()+24*3600000).toISOString().split('T')[0];
  const due = db.prepare(
    "SELECT * FROM bookings WHERE status='confirmed' AND reminder_sent=0 AND date=? AND client_email!=''"
  ).all(tomorrow);
  for (const b of due) {
    const diff = (new Date(`${b.date}T${b.time}:00`) - now) / 3600000;
    if (diff <= 24 && diff >= 23) {
      const sent = await sendEmail(b.client_email, `Reminder: consultation tomorrow — Move With Meg`, emailReminder(b));
      if (sent) db.prepare('UPDATE bookings SET reminder_sent=1 WHERE id=?').run(b.id);
    }
  }
});

// ─── START ────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✓ Move With Meg booking system`);
  console.log(`  ✓ Booking page: ${PUBLIC_URL}`);
  console.log(`  ✓ Dashboard:    ${PUBLIC_URL}/admin`);
  console.log(`  ✓ Email:        ${BREVO_API_KEY ? 'configured' : 'not configured'}\n`);
});
