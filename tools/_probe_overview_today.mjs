/**
 * 取证（★ 2026-10-26）：权限总览「最近操作动态」只显示当天；操作日志页仍是全时间
 *
 * 做法：用 .env 的 JWT_SECRET 自签一个 sys_admin token，走 public/_harness_login.html
 *       写入 localStorage（免去在无头浏览器里点登录框输密码），再逐一取数核对。
 * 产出：输出/权限日志当日口径/*.png + 控制台断言
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUTDIR = path.join(ROOT, '输出', '权限日志当日口径');
fs.mkdirSync(OUTDIR, { recursive: true });

const BASEWEB = 'http://localhost:5173';
const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) { console.log('NO BROWSER'); process.exit(1); }

/* ---------- 1. 自签 token ---------- */
const env = fs.readFileSync(path.join(ROOT, 'server-job', '.env'), 'utf8');
const secret = /^JWT_SECRET=(.*)$/m.exec(env)?.[1]?.trim() ?? 'CHANGE_ME_USE_A_RANDOM_SECRET';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'HS256', typ: 'JWT' });
const body = b64({
  // ⚠️ 必须是 t_sys_account 里真实存在的行（门户中间件会回查账号）；
  //    否则 /profile 401 → 前端清 token → 弹回登录页。
  userId: 'U021', roles: ['MODULE_OWNER'], permissions: [], dataScope: 4, deptId: 'D_ADM', deptCode: 1,
  modules: ['perm'], kind: 'module_owner', userName: '林晓',
  accountId: '43575dc6-50ef-05ec-b6b3-dee3cace36e2', account: 'linx', iat: now, exp: now + 7200,
});
const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const TOKEN = `${head}.${body}.${sig}`;

/* ---------- 2. 无头 Edge + CDP ---------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-today-'));
const child = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9366', '--user-data-dir=' + profile, '--window-size=1520,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9366/json/list');
      const page = (await r.json()).find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 浏览器还没起来 */ }
    await sleep(250);
  }
  throw new Error('no target');
}

let ws; let msgId = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = ++msgId; const to = setTimeout(() => rej(new Error('timeout ' + m)), 30000);
  pending.set(id, { res, rej, to });
  ws.send(JSON.stringify({ id, method: m, params: p }));
});
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value;
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, 'base64'));
  console.log('  shot:', name);
};

ws = new WebSocket(await getTarget());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.id && pending.has(m.id)) { const { res, rej, to } = pending.get(m.id); clearTimeout(to); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result); } };
await send('Page.enable'); await send('Runtime.enable');

const TODAY = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
console.log('本地今天 =', TODAY);

/* ---------- 3. 权限总览 ---------- */
/* ---------- 3. 用自签 token 直接进（不产生登录日志，保持库里数据原样） ---------- */
await send('Page.navigate', { url: `${BASEWEB}/_harness_login.html?t=${Date.now()}#${TOKEN}#/perm/overview` });
await sleep(5200);
console.log('落地 URL =', await ev('location.href'), '| token 长度 =', String(await ev("(localStorage.getItem('sms_token')||'').length")));

const overview = await ev(`(() => {
  const card = [...document.querySelectorAll('.card')].find(c => (c.querySelector('.card-h .t')?.innerText || '').includes('最近操作动态'));
  if (!card) return { found: false };
  const head = (card.querySelector('.card-h .t')?.innerText || '').replace(/\\s+/g, ' ').trim();
  const times = [...card.querySelectorAll('tbody tr td:first-child')].map(td => (td.innerText || '').trim()).filter(Boolean);
  return { found: true, head, times, rows: times.length, bodyLen: document.body.innerText.length };
})()`);
console.log('总览卡片标题 =', overview.head);
console.log('总览行数 =', overview.rows);
console.log('总览首行时间 =', overview.times[0], ' 末行时间 =', overview.times[overview.times.length - 1]);
console.log('总览是否全部为今天 =', overview.times.every((t) => t.startsWith(TODAY)) ? '是 ✅' : '否 ❌');
await shot('1-权限总览-最近操作动态-仅当天.png');

/* 首页 KPI 也截一张，确认没被影响 */
const kpi = await ev(`(() => [...document.querySelectorAll('.kpi .k')].map(k => (k.innerText||'').replace(/\\s+/g,' ').trim()).join(' | '))()`);
console.log('总览 KPI =', kpi);

/* ---------- 4. 操作日志页 ---------- */
await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/perm/log` });
await sleep(4200);
const logs = await ev(`(() => {
  const card = [...document.querySelectorAll('.card')].find(c => (c.querySelector('.card-h .t')?.innerText || '').includes('操作日志'));
  if (!card) return { found: false };
  const head = (card.querySelector('.card-h .t')?.innerText || '').replace(/\\s+/g, ' ').trim();
  const times = [...card.querySelectorAll('tbody tr td:first-child')].map(td => (td.innerText || '').trim()).filter(Boolean);
  const kpis = [...document.querySelectorAll('.kpi .k')].map(k => (k.innerText||'').replace(/\\s+/g,' ').trim()).join(' | ');
  return { found: true, head, times, rows: times.length, kpis };
})()`);
console.log('日志页卡片标题 =', logs.head);
console.log('日志页 KPI =', logs.kpis);
console.log('日志页首行 =', logs.times[0], '末行 =', logs.times[logs.times.length - 1]);
console.log('日志页是否含往日记录（应为「是」）=', logs.times.some((t) => !t.startsWith(TODAY)) ? '是 ✅' : '否 ❌');
await shot('2-操作日志-全时间.png');

/* 翻到最后一页看最早一条 */
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim() === '下一页'); if (b) for (let i=0;i<400 && !b.disabled;i++) b.click(); })()`);
await sleep(2600);
const last = await ev(`(() => { const card = [...document.querySelectorAll('.card')].find(c => (c.querySelector('.card-h .t')?.innerText || '').includes('操作日志'));
  return card ? [...card.querySelectorAll('tbody tr td:first-child')].map(td => (td.innerText||'').trim()).filter(Boolean) : []; })()`);
console.log('日志页末页首行 =', last[0], '末行 =', last[last.length - 1]);
await shot('3-操作日志-翻到末页-最早的记录.png');

ws.close(); child.kill(); process.exit(0);
