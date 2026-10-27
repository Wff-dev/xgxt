/**
 * 取景：账单明细的「到期」小字 + 催费名单（把提前天数临时调到 120 天看好效果，截完恢复 15）
 * 用法：node tools/_shot_finance_expire.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mysql from '../server-job/node_modules/mysql2/promise.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, '输出', '催费权限');
fs.mkdirSync(OUT, { recursive: true });
const BASEWEB = 'http://localhost:5173';
const API = 'http://127.0.0.1:8004';

/* ---------- 自签财务 token（改提前天数用） ---------- */
const envText = fs.readFileSync(path.join(ROOT, 'server-job', '.env'), 'utf8');
const env = Object.fromEntries(envText.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => {
  const i = l.indexOf('=');
  return [l.slice(0, i), l.slice(i + 1).trim()];
}));
const conn = await mysql.createConnection({
  host: env.DB_HOST || 'localhost', port: Number(env.DB_PORT || 3306),
  user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME || 'sms_job',
});
const [[acc]] = await conn.query("SELECT id,account,user_name,modules FROM sms_portal.t_sys_account WHERE account='liukj'");
await conn.end();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'HS256', typ: 'JWT' });
const body = b64({
  userId: acc.id, roles: ['SYS_STAFF'], permissions: [], dataScope: 3,
  modules: JSON.parse(acc.modules), kind: 'module_owner', userName: acc.user_name,
  accountId: acc.id, account: acc.account, iat: now, exp: now + 3600,
});
const sig = createHmac('sha256', env.JWT_SECRET).update(`${head}.${body}`).digest('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = `${head}.${body}.${sig}`;
const setDays = (days) =>
  fetch(`${API}/api/finance/urge/ahead-days`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ days }),
  }).then((r) => r.json());

/* ---------- 浏览器 ---------- */
const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-exp-'));
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9373', '--user-data-dir=' + profile, '--window-size=1520,1060', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9373/json/list');
      const p = (await r.json()).find((t) => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* 等浏览器 */ }
    await sleep(250);
  }
  throw new Error('no target');
}
let ws; let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => {
  const i = ++id; const to = setTimeout(() => rej(new Error('timeout ' + m)), 30000);
  pending.set(i, { res, rej, to });
  ws.send(JSON.stringify({ id: i, method: m, params: p }));
});
ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const { res, rej, to } = pending.get(m.id); clearTimeout(to); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value;
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('保存', name);
};
const clickText = async (sel, text) => ev(`(() => {
  const el = [...document.querySelectorAll('${sel}')].find((e) => (e.innerText || '').includes('${text}'));
  if (!el) return false; el.click(); return true;
})()`);

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/login` });
await sleep(4000);
await clickText('.demo-item', '刘会计');
await sleep(600);
await clickText('button.submit', '登');
await sleep(4500);

/* ① 账单明细：看「到期」 */
await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/finance/bill` });
await sleep(4500);
console.log('账单页含「到期」：', await ev(`document.body.innerText.includes('到期')`));
await shot('05-账单明细-到期日.png');

/* ② 催费名单：临时 120 天 */
console.log('临时设 120 天：', (await setDays(120))?.message);
await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/finance/standard` });
await sleep(4000);
await clickText('.el-tabs__item', '催费设置');
await sleep(2500);
await shot('06-催费名单-临近到期示例.png');
console.log('名单条数文案：', String(await ev(`(document.querySelector('.up-sub')?.innerText || '')`)));

console.log('恢复 15 天：', (await setDays(15))?.message);
ws.close(); child.kill(); process.exit(0);
