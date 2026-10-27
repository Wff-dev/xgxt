/**
 * 取景：财务账号进「费用标准」页，看「催费设置」页签
 * ============================================================
 * 输出：
 *   输出/催费权限/01-财务-费用标准-默认页签.png
 *   输出/催费权限/02-财务-费用标准-催费设置页签.png
 *   输出/催费权限/03-权限分配-财务-费用标准动作.png
 *
 * 用法：node tools/_shot_urge_perm.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, '输出', '催费权限');
fs.mkdirSync(OUT, { recursive: true });

const BASEWEB = 'http://localhost:5173';
const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!BROWSER) { console.log('NO BROWSER'); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-urge-'));
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9371', '--user-data-dir=' + profile, '--window-size=1520,1060', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9371/json/list');
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

await send('Page.enable');
await send('Runtime.enable');

/* 1. 登录页 → 点「刘会计」快捷账号 → 登录 */
await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/login` });
await sleep(4000);
console.log('点快捷账号：', await clickText('.demo-item', '刘会计'));
await sleep(600);
console.log('点登录：', await clickText('button.submit', '登'));
await sleep(4500);
console.log('当前路由：', await ev('location.hash'));

/* 2. 费用标准页 */
await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/finance/standard` });
await sleep(4500);
console.log('页签：', await ev(`[...document.querySelectorAll('.el-tabs__item')].map(e=>e.innerText.trim()).join(' | ')`));
await shot('01-财务-费用标准-默认页签.png');

/* 3. 切到催费设置 */
console.log('点催费设置：', await clickText('.el-tabs__item', '催费设置'));
await sleep(2500);
await shot('02-财务-费用标准-催费设置页签.png');
console.log('催费页内文本片段：', String(await ev(`(document.querySelector('.urge-card')?.innerText||'').slice(0,120)`)).replace(/\s+/g, ' '));

/* 4. 权限分配页：财务 → 费用标准 的动作 */
await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/perm/assign` });
await sleep(5000);
console.log('点财务职位：', await clickText('.role-item, .role-list li, .el-scrollbar__view li', '财务'));
await sleep(2500);
await shot('03-权限分配-财务.png');

ws.close(); child.kill(); process.exit(0);
