/**
 * CDP 取证：补费弹窗里住宿费按月补（450 × 月数）
 *
 * 期望：住宿费行「应补 2700（450 × 6 个月）」+ 本次补缴只读金额 + 住宿月数可改；
 *      把月数改成 3 → 住宿费 ¥1350.00，合计跟着变。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.resolve(HERE, '..', '输出', '咨询收费取证');
fs.mkdirSync(OUTDIR, { recursive: true });
const PROBE = process.argv.includes('--probe');
const BASEWEB = 'http://localhost:5173';
const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-supp-'));
const child = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9362', '--user-data-dir=' + profile, '--window-size=1520,1060', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let msgId = 0; const pending = new Map();
async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9362/json/list');
      const page = (await r.json()).find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('no target');
}
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = ++msgId; const to = setTimeout(() => rej(new Error('timeout ' + m)), 30000);
  pending.set(id, { res, rej, to });
  ws.send(JSON.stringify({ id, method: m, params: p }));
});
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value;
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, 'base64'));
  console.log('  shot:', path.join(OUTDIR, name));
};

ws = new WebSocket(await getTarget());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const { res, rej, to } = pending.get(m.id);
    clearTimeout(to); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
await send('Page.enable'); await send('Runtime.enable');

/* 登录 zhangls（咨询顾问） */
await ev(`(() => { try { localStorage.clear(); } catch(e){} return true; })()`);
await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/login` });
await sleep(3200);
await ev(`(() => {
  const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
    d.set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
  const inputs = [...document.querySelectorAll('input')].filter(i => i.type !== 'checkbox');
  if (inputs[0]) set(inputs[0], 'zhangls');
  if (inputs[1]) set(inputs[1], '123456');
})()`);
await sleep(400);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').replace(/\\s/g,'') === '登录'); if (b) b.click(); })()`);
await sleep(3800);
console.log('登录:', (await ev(`(() => !location.hash.includes('/login'))()`)) ? '成功' : '失败');

await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/consult/fee` });
await sleep(4000);
if (!(await ev(`(() => location.hash.includes('/consult/fee'))()`))) {
  await ev(`(() => { location.hash = '#/consult/fee'; return true; })()`);
  await sleep(4000);
}
await ev(`(() => {
  const st = document.createElement('style');
  st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(st); return true;
})()`);

/* 先看列表里有没有「补费」按钮 */
const btns = await ev(`(() => {
  const bs = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
  return JSON.stringify([...new Set(bs.map((b) => (b.innerText || '').replace(/\\s/g, '')))].filter(Boolean));
})()`);
console.log('页面按钮:', btns);

const clicked = await ev(`(async () => {
  for (let t = 0; t < 10; t++) {
    const bs = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
    const b = bs.find((x) => (x.innerText || '').replace(/\\s/g, '') === '补费');
    if (b) { b.click(); return true; }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
})()`);
console.log('点补费:', clicked);
await sleep(2600);

const dlgText = await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  return dlg ? (dlg.innerText || '').replace(/\\n{2,}/g, '\\n').slice(0, 1400) : 'no-dialog';
})()`);
console.log('弹窗内容:\n' + dlgText);

if (PROBE) {
  await shot('10-补费-住宿按月-初始.png');
  ws.close(); child.kill(); process.exit(0);
}

/* 把住宿月数改成 3 */
const monthRes = await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  if (!dlg) return 'no-dialog';
  const rows = [...dlg.querySelectorAll('.el-table__body tbody tr')];
  const row = rows.find((r) => (r.innerText || '').includes('住宿费'));
  if (!row) return 'no-row:' + rows.map((r) => (r.innerText || '').replace(/\\s+/g, ' ')).join(' | ');
  const inp = row.querySelector('.el-input-number input');
  if (!inp) return 'no-input';
  const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  d.set.call(inp, '3');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  inp.blur();
  return 'set-3';
})()`);
console.log('改住宿月数:', monthRes);
await sleep(1200);

console.log('明细行:', await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  return JSON.stringify([...dlg.querySelectorAll('.el-table__body tbody tr')].map((r) => (r.innerText || '').replace(/\\s+/g, ' ').trim()), null, 1);
})()`));
console.log('合计:', await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const item = [...dlg.querySelectorAll('.el-form-item')].find((i) => (i.innerText || '').includes('补费合计'));
  return item ? (item.innerText || '').replace(/\\s+/g, ' ').trim() : 'no-item';
})()`));
await shot('11-补费-住宿按月-改成3个月.png');
ws.close(); child.kill(); process.exit(0);
