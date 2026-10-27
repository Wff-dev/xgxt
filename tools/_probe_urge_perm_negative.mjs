/**
 * 负向实测：撤掉财务职位的「查看催费名单」→ 接口应当立刻 403；恢复后 → 200。
 * 只动 t_perm_role_perm 的两行，跑完自动还原（finally）。
 *
 * 用法：node tools/_probe_urge_perm_negative.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mysql from '../server-job/node_modules/mysql2/promise.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = 'http://127.0.0.1:8004';
const ROLE_ID = 'R09'; // 财务

const envText = fs.readFileSync(path.join(ROOT, 'server-job', '.env'), 'utf8');
const env = Object.fromEntries(
  envText.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1).trim()];
  }),
);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const conn = await mysql.createConnection({
  host: env.DB_HOST || 'localhost',
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME || 'sms_job',
});

const [acc] = await conn.query(
  "SELECT id, account, user_name, modules FROM sms_portal.t_sys_account WHERE account='liukj' AND is_deleted=0",
);
const u = acc[0];
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'HS256', typ: 'JWT' });
const body = b64({
  userId: u.id, roles: ['SYS_STAFF'], permissions: [], dataScope: 3,
  modules: Array.isArray(u.modules) ? u.modules : JSON.parse(u.modules || '[]'),
  kind: 'module_owner', userName: u.user_name, accountId: u.id, account: u.account,
  iat: now, exp: now + 3600,
});
const sig = createHmac('sha256', env.JWT_SECRET || '').update(`${head}.${body}`).digest('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = `${head}.${body}.${sig}`;

const probe = async () =>
  (await fetch(`${API}/api/finance/urge/ahead-days`, { headers: { Authorization: `Bearer ${token}` } })).status;

const [backup] = await conn.query(
  'SELECT * FROM sms_perm.t_perm_role_perm WHERE role_id=? AND module_key=? AND item_name=? AND action_code IN (?,?) AND is_deleted=0',
  [ROLE_ID, 'finance', '费用标准', 'urgeView', 'urgeSet'],
);
fs.writeFileSync(path.join(ROOT, '输出', '_urge_perm_rows_backup.json'), JSON.stringify(backup, null, 2), 'utf8');

const before = await probe();
console.log(`① 现状（勾着）→ HTTP ${before}`);

await conn.query(
  'DELETE FROM sms_perm.t_perm_role_perm WHERE role_id=? AND module_key=? AND item_name=? AND action_code=?',
  [ROLE_ID, 'finance', '费用标准', 'urgeView'],
);
console.log('② 已删除「查看催费名单」授权行，等待缓存过期（≤15s）…');

let after = 0;
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  after = await probe();
  if (after === 403) break;
}
console.log(`③ 撤销后 → HTTP ${after}${after === 403 ? '（预期，接口已拒绝）' : '（异常：仍然放行）'}`);

// 还原（只补缺失的行：删除时只删了 urgeView，urgeSet 还在，直接插入会撞主键）
const [alive] = await conn.query(
  'SELECT action_code FROM sms_perm.t_perm_role_perm WHERE role_id=? AND module_key=? AND item_name=? AND is_deleted=0',
  [ROLE_ID, 'finance', '费用标准'],
);
const aliveSet = new Set(alive.map((r) => r.action_code));
for (const row of backup) {
  if (aliveSet.has(row.action_code)) continue;
  const cols = Object.keys(row);
  await conn.query(
    `INSERT INTO sms_perm.t_perm_role_perm (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    cols.map((c) => (typeof row[c] === 'string' && /T.*Z$/.test(row[c]) ? row[c].slice(0, 19).replace('T', ' ') : row[c])),
  );
}
console.log('④ 已按备份还原授权行');

let restored = 0;
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  restored = await probe();
  if (restored === 200) break;
}
console.log(`⑤ 还原后 → HTTP ${restored}${restored === 200 ? '（预期，恢复可用）' : '（异常：仍然 403）'}`);

await conn.end();
