/**
 * 取景：系统管理员 → 权限管理 → 职位权限分配 → 财务 → 财务管理（含费用标准）
 * 用法：node tools/_shot_perm_assign_finance.mjs
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-perm-'));
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9372', '--user-data-dir=' + profile, '--window-size=1520,1200', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9372/json/list');
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
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('保存', name);
};
const clickText = async (sel, text) => ev(`(() => {
  const el = [...document.querySelectorAll('${sel}')].find((e) => (e.innerText || '').includes('${text}'));
  if (!el) return false; el.click(); return true;
})()`);

await send('Page.enable');
await send('Runtime.enable');

await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/login` });
await sleep(4000);
console.log('点快捷账号 林晓：', await clickText('.demo-item', '林晓'));
await sleep(600);
console.log('点登录：', await clickText('button.submit', '登'));
await sleep(4500);

await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/perm/assign` });
await sleep(5000);
console.log('选财务职位：', await clickText('.rl-item', '财务'));
await sleep(2500);
await shot('03-权限分配-财务-费用标准.png');

/* 把「费用标准」这一页滚到视野内再截一张局部 */
await ev(`(() => {
  const heads = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.innerText||'').trim() === '费用标准');
  const h = heads[heads.length - 1];
  if (h) h.scrollIntoView({ block: 'center' });
  return !!h;
})()`);
await sleep(1200);
await shot('04-权限分配-财务-费用标准-局部.png');

console.log('页面上出现的动作文案：', String(await ev(`(() => {
  const t = document.body.innerText;
  return ['催费设置', '查看催费名单', '保存催费设置'].map(k => k + '=' + t.includes(k)).join(' ');
})()`)));

ws.close(); child.kill(); process.exit(0);
