/**
 * 实测：财务「催费设置」权限链路（只读探针，不改业务数据）
 * ============================================================
 * 1) 用门户账号自签 token（与登录同一套 payload / JWT_SECRET）
 * 2) 财务账号：读提前天数 / 读催费名单 / 存提前天数 → 期望 200
 * 3) 项目经理账号：读催费名单 → 期望 403（不是财务账号，且无该码）
 * 4) 财务账号的 my-pages → 期望 permissions 里出现 finance:urge:view / finance:urge:manage
 *
 * 用法：node tools/_probe_urge_perm_api.mjs
 * 输出：控制台（不含密码、不含 token 全文）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mysql from '../server-job/node_modules/mysql2/promise.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = process.env.API_BASE || 'http://127.0.0.1:8004';

const envText = fs.readFileSync(path.join(ROOT, 'server-job', '.env'), 'utf8');
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).trim()];
    }),
);

const b64 = (o) =>
  Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function sign(user) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    userId: user.id,
    roles: ['SYS_STAFF'],
    permissions: [],
    dataScope: 3,
    modules: (Array.isArray(user.modules) ? user.modules : JSON.parse(user.modules || '[]')),
    kind: 'module_owner',
    userName: user.user_name,
    accountId: user.id,
    account: user.account,
    iat: now,
    exp: now + 3600,
  });
  const sig = createHmac('sha256', env.JWT_SECRET || '')
    .update(`${head}.${body}`)
    .digest('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${head}.${body}.${sig}`;
}

async function call(token, method, url, body) {
  const r = await fetch(API + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch { /* 可能是空响应 */ }
  return { status: r.status, json };
}

const conn = await mysql.createConnection({
  host: env.DB_HOST || 'localhost',
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME || 'sms_portal',
});

const [rows] = await conn.query(
  "SELECT id, account, user_name, modules FROM sms_portal.t_sys_account WHERE account IN ('liukj','zhouj') AND is_deleted=0",
);
await conn.end();

const byAccount = new Map(rows.map((r) => [r.account, r]));
const out = [];
const log = (s) => { out.push(s); console.log(s); };

for (const [account, label] of [['liukj', '财务'], ['zhouj', '项目经理']]) {
  const u = byAccount.get(account);
  if (!u) { log(`!! 账号 ${account} 不存在`); continue; }
  const token = sign(u);
  log(`\n===== ${label}（${account}，modules=${u.modules}）=====`);

  const mp = await call(token, 'GET', '/api/job/auth/my-pages');
  const perms = mp.json?.data?.permissions || [];
  log(`my-pages ${mp.status} · 页面 ${(mp.json?.data?.pages || []).length} 个 · 权限码 ${perms.length} 个`);
  log(`  含 finance:urge:view = ${perms.includes('finance:urge:view')} / finance:urge:manage = ${perms.includes('finance:urge:manage')}`);

  const g1 = await call(token, 'GET', '/api/finance/urge/ahead-days');
  log(`GET  ahead-days → ${g1.status} ${g1.status === 200 ? `days=${g1.json?.data?.days}` : g1.json?.message || ''}`);

  const g2 = await call(token, 'GET', '/api/finance/urge/list');
  log(`GET  urge/list  → ${g2.status} ${g2.status === 200 ? `共 ${g2.json?.data?.total} 条` : g2.json?.message || ''}`);

  const p1 = await call(token, 'POST', '/api/finance/urge/ahead-days', { days: 15 });
  log(`POST ahead-days → ${p1.status} ${p1.status === 200 ? p1.json?.message : p1.json?.message || ''}`);
}

fs.writeFileSync(path.join(ROOT, '输出', '_probe_urge_perm_api.txt'), out.join('\n'), 'utf8');
