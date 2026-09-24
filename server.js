import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';
import fs from 'node:fs';

const env = process.env;
const PORT = env.PORT || 3000;
const SITE_URL = env.SITE_URL || `http://localhost:${PORT}`;
const claude = env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const MODEL = env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

/* ---------- Products ----------
   m = price in MILLIONS of DonutSMP money (1€ = 100M, so 25M = 0.25€).
   This store runs on DonutSMP — delivery is done manually by staff in-game. */
const PRODUCTS = {
   1: { name: 'Dragon Head',            m: 25  },
   2: { name: 'Netherite Ingot',        m: 1.2 },
   3: { name: 'Enchanted Golden Apple', m: 1   },
   4: { name: 'Ancient Debris',         m: 1   },
   5: { name: 'Block of Netherite',     m: 30  },
   6: { name: 'Mace',                   m: 2.5 },
   7: { name: 'Gilded Blackstone',      m: 1   },
   8: { name: 'Heavy Core',             m: 3   },
   9: { name: 'Elytra',                 m: 250 },
  10: { name: 'Skeleton Spawner',       m: 4.5 },
};
const VOUCHER_SURCHARGE = 1.2;

/* ---------- Discount ---------- */
const DISCOUNT_FILE = env.DISCOUNT_FILE || 'discount.json';
const DEFAULT_DISCOUNT = { percent: 0, label: '', active: false, scope: 'all', productIds: [], expiresAt: null };
let discount = { ...DEFAULT_DISCOUNT };
try { discount = { ...DEFAULT_DISCOUNT, ...JSON.parse(fs.readFileSync(DISCOUNT_FILE, 'utf8')) }; } catch {}

const saveDiscount = () => fs.writeFileSync(DISCOUNT_FILE, JSON.stringify(discount, null, 2));

function discountLive() {
  if (!discount.active || !discount.percent) return false;
  if (discount.expiresAt && Date.now() >= discount.expiresAt) return false;
  return true;
}
function discountAppliesTo(id) {
  if (!discountLive()) return false;
  if (discount.scope === 'products') return discount.productIds.includes(Number(id));
  return true;
}
function effectiveM(id, baseM) {
  if (!discountAppliesTo(id)) return baseM;
  return Math.round(baseM * (1 - discount.percent / 100) * 100) / 100;
}
function publicDiscount() {
  const live = discountLive();
  return {
    active: live,
    percent: live ? discount.percent : 0,
    label: live ? (discount.label || '') : '',
    scope: discount.scope,
    productIds: discount.productIds,
    expiresAt: discount.expiresAt,
    raw: {
      percent: discount.percent, label: discount.label, active: discount.active,
      scope: discount.scope, productIds: discount.productIds, expiresAt: discount.expiresAt,
    },
  };
}

/* ---------- Database ---------- */
const db = new Database(env.DB_FILE || 'glaze.db');
db.exec(`CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY, items TEXT NOT NULL, total_m REAL NOT NULL, method TEXT NOT NULL,
  status TEXT NOT NULL, mc_name TEXT, discord_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, paid_at TEXT, delivered_at TEXT)`);
const getOrder = id => db.prepare('SELECT * FROM orders WHERE id=?').get(id);

/* ---------- Helpers ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const orderId = () => 'GLZ-' + crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
const itemsText = items => Object.entries(items).map(([i, q]) => `${q}× ${PRODUCTS[i].name}`).join(', ');
const fmtM = n => Number(n).toLocaleString('en', { maximumFractionDigits: 2 }) + 'M';
const fmtEur = m => '€' + (m / 100).toFixed(2);

function parseOrder(b) {
  if (!b || typeof b.items !== 'object' || !b.items) throw new HttpError(400, 'Invalid items');
  const items = {}; let m = 0;
  for (const [id, q] of Object.entries(b.items)) {
    const n = Number(q);
    if (!Object.hasOwn(PRODUCTS, id) || !Number.isInteger(n) || n < 1 || n > 20) throw new HttpError(400, 'Invalid item');
    items[id] = n; m += effectiveM(id, PRODUCTS[id].m) * n;
  }
  m = Math.round(m * 100) / 100;
  if (!m) throw new HttpError(400, 'Cart is empty');
  const mc = String(b.mcName || '').trim(), dc = String(b.discordName || '').trim();
  if (!/^\.?[A-Za-z0-9_]{3,16}$/.test(mc)) throw new HttpError(400, 'Invalid Minecraft name');
  if (!/^[\w.]{2,32}$/.test(dc)) throw new HttpError(400, 'Invalid Discord name');
  return { items, m, mc, dc };
}

/* ---------- Discord ---------- */
async function discordApi(path, body) {
  const r = await fetch('https://discord.com/api/v10' + path, {
    method: 'POST',
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Discord ${r.status}: ${await r.text()}`);
  return r.json();
}
async function ticket(title, text) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_CHANNEL_ID) return console.log(`[ticket] ${title}\n${text}`);
  try {
    const ping = env.DISCORD_STAFF_ROLE_ID ? `<@&${env.DISCORD_STAFF_ROLE_ID}> ` : '';
    const m = await discordApi(`/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
      content: (ping + `**${title}**\n${text}`).slice(0, 1900),
      allowed_mentions: { parse: [], roles: env.DISCORD_STAFF_ROLE_ID ? [env.DISCORD_STAFF_ROLE_ID] : [] },
    });
    await discordApi(`/channels/${env.DISCORD_CHANNEL_ID}/messages/${m.id}/threads`, { name: title.slice(0, 90), auto_archive_duration: 10080 });
  } catch (e) { console.error('Discord error:', e.message); }
}

/* ---------- Fulfilment (mark as delivered after manual in-game delivery) ---------- */
async function fulfil(id) {
  const claimed = db.prepare("UPDATE orders SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('awaiting_donut','awaiting_voucher')").run(id);
  if (!claimed.changes) return;
  const o = getOrder(id), items = JSON.parse(o.items);
  db.prepare("UPDATE orders SET status='delivered', delivered_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
  await ticket(`✅ Delivered ${id}`,
    `Items: ${itemsText(items)}\nAmount: ${fmtM(o.total_m)}\nMethod: ${o.method}\nMinecraft: ${o.mc_name}\nDiscord: ${o.discord_name}`);
}

/* ---------- App ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], scriptSrcAttr: ["'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ['https://fonts.gstatic.com'],
  connectSrc: ["'self'"], imgSrc: ["'self'", 'data:'] } } }));
app.use(cors({ origin: SITE_URL, credentials: false }));
app.use(express.json({ limit: '20kb' }));
app.use(express.static('public'));

const limit = n => rateLimit({ windowMs: 60_000, limit: n, standardHeaders: true, legacyHeaders: false });

app.get('/api/products', (req, res) => res.json(
  Object.entries(PRODUCTS).map(([id, p]) => ({
    id: +id, name: p.name, m: p.m, effM: effectiveM(id, p.m),
    discounted: discountAppliesTo(id),
  }))
));

app.get('/api/discount', (req, res) => res.json(publicDiscount()));

const sseClients = new Set();
function broadcastDiscount() {
  const msg = `data: ${JSON.stringify(publicDiscount())}\n\n`;
  for (const c of sseClients) try { c.write(msg); } catch {}
}
app.get('/api/discount/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify(publicDiscount())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});
setInterval(() => { for (const c of sseClients) try { c.write(': ping\n\n'); } catch {} }, 25000);

let lastLive = discountLive();
setInterval(() => {
  const live = discountLive();
  if (live !== lastLive) { lastLive = live; broadcastDiscount(); console.log(`[discount] ${live ? 'live' : 'expired'}`); }
}, 10_000);

/* ---------- Orders ---------- */
app.post('/api/orders/donut', limit(10), async (req, res) => {
  const { items, m, mc, dc } = parseOrder(req.body);
  const id = orderId();
  db.prepare('INSERT INTO orders(id,items,total_m,method,status,mc_name,discord_name) VALUES(?,?,?,?,?,?,?)')
    .run(id, JSON.stringify(items), m, 'donut', 'awaiting_donut', mc, dc);
  await ticket(`🍩 New order ${id} — awaiting DonutSMP money`,
    `Items: ${itemsText(items)}\nAmount: ${fmtM(m)}\nMinecraft: ${mc}\nDiscord: ${dc}`);
  res.json({ orderId: id, amountM: m });
});

app.post('/api/orders/voucher', limit(10), async (req, res) => {
  const { items, m, mc, dc } = parseOrder(req.body);
  const totalM = Math.round(m * VOUCHER_SURCHARGE * 100) / 100;
  const id = orderId();
  db.prepare('INSERT INTO orders(id,items,total_m,method,status,mc_name,discord_name) VALUES(?,?,?,?,?,?,?)')
    .run(id, JSON.stringify(items), totalM, 'giftcard', 'awaiting_voucher', mc, dc);
  await ticket(`🎟️ New order ${id} — awaiting gift card`,
    `Items: ${itemsText(items)}\nGift card value: ${fmtEur(totalM)} (incl. +20% surcharge)\nMinecraft: ${mc}\nDiscord: ${dc}`);
  res.json({ orderId: id, amountM: totalM, amountEur: Number((totalM / 100).toFixed(2)) });
});

app.get('/api/orders/:id', limit(30), (req, res) => {
  const o = getOrder(req.params.id);
  res.json({ status: o ? o.status : 'unknown' });
});

/* ---------- AI support ---------- */
const SUPPORT_PROMPT = `You are the support assistant of GLAZE, a Minecraft item store for DonutSMP. Be short and friendly (max 3 sentences).
Store facts:
- GLAZE sells Minecraft items, blocks and spawners on DonutSMP.
- The normal payment method is DonutSMP money at a rate of 1€ = 100M.
- Gift cards (Amazon, Google Play, Paysafecard, etc.) are accepted on request with a 20% surcharge, arranged on Discord.
- Payment is handled manually by a staff member through a Discord ticket; staff needs some time to answer.
- Delivery is done manually by staff in-game on DonutSMP — never ask for account credentials.
- No credit card, PayPal or Google Pay is accepted.
Never promise refunds, delivery times or prices you don't know.
Find out what the problem is. Once you understand it, tell the user to press the "Send to team" button. Reply in the user's language.`;
const cleanMsgs = m => {
  const out = (Array.isArray(m) ? m : []).slice(-10)
    .filter(x => x && ['user', 'assistant'].includes(x.role) && typeof x.content === 'string' && x.content.trim())
    .map(x => ({ role: x.role, content: x.content.slice(0, 500) }));
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
};
const ask = async (system, messages, max = 300) => {
  const r = await claude.messages.create({ model: MODEL, max_tokens: max, system, messages });
  return r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
};

app.post('/api/support/chat', limit(12), async (req, res) => {
  const messages = cleanMsgs(req.body.messages);
  if (!messages.length) throw new HttpError(400, 'No message');
  if (!claude) return res.json({ reply: "Thanks! Press \"Send to team\" so the staff can reach you on Discord." });
  res.json({ reply: await ask(SUPPORT_PROMPT, messages) });
});

app.post('/api/support/ticket', limit(5), async (req, res) => {
  const dc = String(req.body.discordName || '').trim(), mc = String(req.body.mcName || '-').trim().slice(0, 20);
  if (!/^[\w.]{2,32}$/.test(dc)) throw new HttpError(400, 'Invalid Discord name');
  const messages = cleanMsgs(req.body.messages);
  if (!messages.length) throw new HttpError(400, 'No conversation');
  let summary = messages.filter(m => m.role === 'user').map(m => m.content).join(' | ').slice(0, 600);
  if (claude) try { summary = await ask('Summarize this support chat in 2 sentences and start with a category in brackets, e.g. [Payment].', messages, 200); } catch {}
  const id = 'T-' + crypto.randomBytes(2).toString('hex').toUpperCase();
  await ticket(`🎫 Support ${id}`, `Discord: ${dc}\nMinecraft: ${mc}\n${summary}`);
  res.json({ ticketId: id });
});

/* ---------- Admin ---------- */
const admin = (req, res, next) => {
  const a = Buffer.from(String(req.get('x-admin-token') || '')), b = Buffer.from(env.ADMIN_TOKEN || '');
  if (!b.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.post('/api/admin/discount', admin, (req, res) => {
  const body = req.body || {};
  const percent = Math.max(0, Math.min(90, Math.round(Number(body.percent) || 0)));
  const label = String(body.label || '').slice(0, 40);
  const scope = body.scope === 'products' ? 'products' : 'all';
  const productIds = Array.isArray(body.productIds)
    ? body.productIds.map(Number).filter(n => Object.hasOwn(PRODUCTS, n))
    : [];
  const expiresAt = body.expiresAt ? Number(body.expiresAt) : null;
  const active = !!body.active && percent > 0;
  const finalScope = (scope === 'products' && productIds.length === 0) ? 'all' : scope;

  discount = {
    percent, label, active,
    scope: finalScope,
    productIds: finalScope === 'products' ? productIds : [],
    expiresAt: active ? expiresAt : null,
  };
  saveDiscount();
  lastLive = discountLive();
  broadcastDiscount();
  console.log(`[discount] ${discount.active ? `-${percent}% ${label} · ${finalScope === 'products' ? productIds.length + ' product(s)' : 'all'} · ${expiresAt ? 'until ' + new Date(expiresAt).toISOString() : 'no expiry'}` : 'off'}`);
  res.json({ ok: true, discount: publicDiscount() });
});

app.get('/api/admin/orders', admin, (req, res) => res.json(db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all()));
app.post('/api/admin/orders/:id/paid', admin, async (req, res) => {
  if (!getOrder(req.params.id)) throw new HttpError(404, 'Order not found');
  await fulfil(req.params.id);
  res.json({ ok: true });
});

/* ---------- Errors + 404 + Health ---------- */
app.use((err, req, res, next) => {
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err instanceof HttpError ? err.message : 'Server error' });
});
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* ---------- Start ---------- */
const server = app.listen(PORT, () => console.log(`GLAZE backend on ${SITE_URL}`));
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));