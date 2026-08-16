/* ============================================================
   Lead Finder — Device Lock API
   一个账号最多绑定 2 台设备（hard lock）。
   老板意图：客户买一个 account 只许手机+电脑两台用，防跟同行共享。

   Storage : Vercel KV (Upstash Redis REST)
     env UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
     （Vercel dashboard → Storage → KV 创建后自动注入）

   卖家管理 :
     env DEVICE_ADMIN_SECRET  — reset / remove 的钥匙（客户换机/清缓存被锁时解锁用）
     env APP_PASS             — 部署密码，server 端兜底校验（防 F12 改前端绕过）

   Fallback : 未配置 KV → open mode（不锁，保持原行为，兼容客户版未配 KV 的部署）

   Key 隔离 : lf_dev:<host> — 每个部署（subdomain）独立，客户之间互不影响
   ============================================================ */

const MAX_DEVICES = 2;          // 一账号 2 台设备
const TTL = 90 * 24 * 60 * 60;  // 90 天未活跃自动释放名额

function kv() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

async function kvGet(key) {
  const c = kv();
  if (!c) return null;
  const r = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${c.token}` },
  });
  const j = await r.json();
  if (j.error) throw new Error(`kv get: ${j.error}`);
  return j.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, value) {
  const c = kv();
  if (!c) return;
  const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}?EX=${TTL}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  const j = await r.json();
  if (j.error) throw new Error(`kv set: ${j.error}`);
}

function accountKey(req) {
  return 'lf_dev:' + (req.headers['x-forwarded-host'] || req.headers.host || 'default');
}

function labelFromUA(ua = '') {
  const s = String(ua);
  let os = 'Other';
  if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS/.test(s)) os = 'macOS';
  else if (/iPhone|iPad/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Linux/.test(s)) os = 'Linux';
  let br = 'Browser';
  if (/Edg\//.test(s)) br = 'Edge';
  else if (/Chrome\//.test(s)) br = 'Chrome';
  else if (/Safari\//.test(s)) br = 'Safari';
  else if (/Firefox\//.test(s)) br = 'Firefox';
  return `${br} · ${os}`;
}

async function handleCheck(req, res, key, id) {
  if (!kv()) return res.json({ allowed: true, mode: 'open' });
  const rec = await kvGet(key);
  const devs = rec && Array.isArray(rec.devices) ? rec.devices : [];
  const known = devs.find((d) => d.id === id);
  if (known) {
    known.lastSeen = Date.now();
    await kvSet(key, rec);
    return res.json({ allowed: true, devices: devs.length, max: MAX_DEVICES });
  }
  return res.json({ allowed: false, reason: 'not_registered', devices: devs.length, max: MAX_DEVICES });
}

async function handleRegister(req, res, key, id) {
  if (!id) return res.status(400).json({ error: 'missing device id' });
  const expected = process.env.APP_PASS;
  if (expected && (!req.body || req.body.pass !== expected)) {
    return res.json({ allowed: false, reason: 'invalid' });
  }
  if (!kv()) return res.json({ allowed: true, mode: 'open' });
  const rec = (await kvGet(key)) || { devices: [] };
  if (!Array.isArray(rec.devices)) rec.devices = [];
  const devs = rec.devices;
  const known = devs.find((d) => d.id === id);
  if (known) {
    known.lastSeen = Date.now();
    if (req.body && req.body.label) known.label = req.body.label;
  } else {
    if (devs.length >= MAX_DEVICES) {
      return res.json({
        allowed: false,
        reason: 'limit',
        devices: devs.map((d) => ({ label: d.label, firstSeen: d.firstSeen })),
        max: MAX_DEVICES,
      });
    }
    devs.push({
      id,
      label: (req.body && req.body.label) || labelFromUA(req.headers['user-agent']),
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });
  }
  await kvSet(key, rec);
  return res.json({ allowed: true, devices: devs.length, max: MAX_DEVICES });
}

function isAdmin(req) {
  const secret = process.env.DEVICE_ADMIN_SECRET;
  if (!secret) return false;
  return !!(req.query && req.query.admin === secret);
}

async function handleReset(req, res, key) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });
  await kvSet(key, { devices: [] });
  return res.json({ ok: true, cleared: true });
}

async function handleRemove(req, res, key) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'missing id' });
  const rec = (await kvGet(key)) || { devices: [] };
  if (!Array.isArray(rec.devices)) rec.devices = [];
  rec.devices = rec.devices.filter((d) => d.id !== id);
  await kvSet(key, rec);
  return res.json({ ok: true, remaining: rec.devices.length });
}

export default async function handler(req, res) {
  const key = accountKey(req);
  const mode = req.query && req.query.mode;
  try {
    switch (mode) {
      case 'check':      return await handleCheck(req, res, key, req.query.id);
      case 'register':   return await handleRegister(req, res, key, req.query.id);
      case 'reset':      return await handleReset(req, res, key);
      case 'remove':     return await handleRemove(req, res, key);
      default:           return res.status(400).json({ error: 'unknown mode' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'internal', detail: String((err && err.message) || err) });
  }
}
