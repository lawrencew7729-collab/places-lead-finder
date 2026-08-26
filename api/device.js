/* ============================================================
   Lead Finder — Device Lock API (R1 TWO-DEVICE CONTRACT, v1.0.2)
   一个账号最多绑定 2 台设备（hard lock）。
   老板意图：客户买一个 account 只许手机+电脑两台用，防跟同行共享。

   Identity : CUSTOMER_TENANT_ID（immutable UUID，server env）
     registry key = lf_dev:<CUSTOMER_TENANT_ID>
     tenantId 缺失 → FAIL CLOSED（not_configured）。
     hostname 不再是身份（可 rebind/redeploy 会重置身份）。
     Legacy 部署（无此 env）保留旧版行为，不在本合约范围。

   Storage : 每个客户独立 dedicated KV store（Vercel KV / Upstash REST）
     env KV_REST_API_URL / KV_REST_API_TOKEN（新版 Vercel KV 自动注入）
     或 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN（旧命名，兼容）
     KV 缺失 → FAIL CLOSED（不降级 open mode）。

   Auth : env APP_PASS — customer access code（16-char，server 端校验）
     缺失 → register FAIL CLOSED。永不进 browser bundle / Git。

   Recovery : 无公开 reset/remove endpoint。device slot 释放 =
     OWNER-CONTROLLED ISOLATED MAINTENANCE —— 直接在 THAT customer 的
     dedicated KV store 上操作（删除/编辑 lf_dev:<tenantId> 记录）。
     无 central shared reset secret。无 browser-accessible admin 机制。

   No automatic eviction : registry 无 TTL；slot 只由 owner 显式释放。

   Probe (provisioning readiness) : mode=probe 返回布尔型锁定状态
     （locked/open/unconfigured · maxDevices · kvConfigured ·
     appPassConfigured · tenantIdConfigured）— 不含任何 secret 值，
     供 provisioning executor 在 CUSTOMER READY 前验证。
   ============================================================ */

const MAX_DEVICES = 2;          // 一账号 2 台设备

function kv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/** Immutable registry identity. Missing tenant id → fail closed. */
function accountKey() {
  const tid = process.env.CUSTOMER_TENANT_ID;
  if (!tid) return null;
  return 'lf_dev:' + tid;
}

function notConfigured(res) {
  return res.json({ allowed: false, reason: 'not_configured' });
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
  // No TTL: registry persists until an explicit owner/admin release (no automatic eviction).
  const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  const j = await r.json();
  if (j.error) throw new Error(`kv set: ${j.error}`);
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
  if (!key || !kv()) return notConfigured(res);
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
  if (!key) return notConfigured(res);
  const expected = process.env.APP_PASS;
  if (!expected) return notConfigured(res); // fail closed: no access code configured
  if (!req.body || req.body.pass !== expected) {
    return res.json({ allowed: false, reason: 'invalid' });
  }
  if (!kv()) return notConfigured(res); // fail closed: no dedicated store configured
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

async function handleProbe(req, res) {
  const key = accountKey();
  const c = kv();
  return res.json({
    mode: !key ? 'unconfigured' : c ? 'locked' : 'open',
    maxDevices: MAX_DEVICES,
    kvConfigured: !!c,
    appPassConfigured: !!process.env.APP_PASS,
    tenantIdConfigured: !!key,
  });
}

export default async function handler(req, res) {
  const key = accountKey();
  const mode = req.query && req.query.mode;
  try {
    switch (mode) {
      case 'check':      return await handleCheck(req, res, key, req.query.id);
      case 'register':   return await handleRegister(req, res, key, req.query.id);
      case 'probe':      return await handleProbe(req, res);
      default:           return res.status(400).json({ error: 'unknown mode' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'internal', detail: String((err && err.message) || err) });
  }
}
