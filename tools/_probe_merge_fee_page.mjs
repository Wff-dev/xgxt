/**
 * 合并后冒烟（2026-10-26）：财务「缴费管理」页 + 详情弹窗（FeeDetailDialog 插槽）
 * 冲突解在这里：v-if="canVerifyFee && d?.canVerify" + 双 import
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUTDIR = path.join(ROOT, '输出', '合并冲突取证');
fs.mkdirSync(OUTDIR, { recursive: true });
const BASEWEB = 'http://localhost:5173';
const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) { console.log('NO BROWSER'); process.exit(1); }

const env = fs.readFileSync(path.join(ROOT, 'server-job', '.env'), 'utf8');
const secret = /^JWT_SECRET=(.*)$/m.exec(env)?.[1]?.trim() ?? 'CHANGE_ME_USE_A_RANDOM_SECRET';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'HS256', typ: 'JWT' });
const body = b64({
  userId: process.env.PROBE_USER_ID || 'U016', roles: ['MODULE_OWNER'], permissions: [], dataScope: 4,
  deptId: 'D_FIN', deptCode: 1,
  modules: [process.env.PROBE_MODULE || 'finance'], kind: 'module_owner',
  userName: process.env.PROBE_USER_NAME || '周铭',
  accountId: process.env.PROBE_ACCOUNT_ID || '9e73138b-d35e-de46-9873-3836bed7cd60',
  account: process.env.PROBE_ACCOUNT || 'zhoum', iat: now, exp: now + 7200,
});
const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const TOKEN = `${head}.${body}.${sig}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-fee-'));
const child = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9368', '--user-data-dir=' + profile, '--window-size=1520,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9368/json/list');
      const page = (await r.json()).find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 等浏览器 */ }
    await sleep(250);
  }
  throw new Error('no target');
}

let ws; let msgId = 0; const pending = new Map(); const errors = [];
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
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || 'exception');
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params?.type)) {
    errors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  }
  if (m.id && pending.has(m.id)) { const { res, rej, to } = pending.get(m.id); clearTimeout(to); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result); } };
await send('Page.enable'); await send('Runtime.enable');

await send('Page.navigate', { url: `${BASEWEB}/_harness_login.html?t=${Date.now()}#${TOKEN}#/finance/fee` });
await sleep(6000);

console.log('落地 URL =', await ev('location.href'));
const info = await ev(`(() => {
  const btns = [...document.querySelectorAll('button')].map(b => (b.innerText||'').trim()).filter(Boolean);
  return {
    title: (document.querySelector('.page-title, .card-h .t, h2')?.innerText || '').trim().slice(0, 40),
    hasBatch: btns.some(t => t.includes('批量财务核对')),
    rows: document.querySelectorAll('.el-table__body tbody tr').length,
    pager: (document.querySelector('.pager-bar')?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    firstRowTime: (document.querySelector('.el-table__body tbody tr td:nth-child(2)')?.innerText || '').trim(),
  };
})()`);
console.log('页面信息 =', JSON.stringify(info));
await shot('1-缴费管理页-合并后.png');

/* 打开第一条「详情」，验证 FeeDetailDialog + footer-actions 插槽 */
const opened = await ev(`(() => {
  const rows = [...document.querySelectorAll('.el-table__body tbody tr')];
  if (!rows.length) return '无数据行';
  const btn = [...rows[0].querySelectorAll('button')].find(b => (b.innerText||'').trim() === '详情');
  if (!btn) return '首行没有详情按钮';
  btn.click();
  return '已点击详情';
})()`);
console.log('详情弹窗 =', opened);
await sleep(2200);
const dlg = await ev(`(() => {
  const d = document.querySelector('.el-dialog:not([style*="display: none"])');
  if (!d) return { open: false };
  const footer = (d.querySelector('.el-dialog__footer')?.innerText || '').replace(/\\s+/g, ' ').trim();
  return { open: true, title: (d.querySelector('.el-dialog__title')?.innerText || '').trim(), footer };
})()`);
console.log('弹窗 =', JSON.stringify(dlg));
await shot('2-缴费详情弹窗-footer插槽.png');

console.log('运行时错误 =', errors.length ? errors.slice(0, 5) : '无 ✅');
ws.close(); child.kill(); process.exit(0);
