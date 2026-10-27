/**
 * CDP 取证：发起收费弹窗 —— 改学费后「应缴不变、实缴 = 应缴 − 优惠」
 *
 * 期望：勾学费(28000) → 学费金额改 26000 → 应缴 28000、实缴 26000、优惠 2000、合计 26000。
 * 用法：node tools/_shot-fee-due-unchanged.mjs [--probe]
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-fee-'));
const child = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9361', '--user-data-dir=' + profile, '--window-size=1520,1060', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let msgId = 0; const pending = new Map();
async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9361/json/list');
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

/* 登录 linx */
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
console.log('登录:', await ev(`(() => !location.hash.includes('/login'))()`) ? '成功' : '失败');

await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/consult/fee` });
await sleep(4000);
if (!(await ev(`(() => location.hash.includes('/consult/fee'))()`))) {
  await ev(`(() => { location.hash = '#/consult/fee'; return true; })()`);
  await sleep(4000);
}
console.log('当前路由:', await ev(`(() => location.hash)()`));
await sleep(2000);

/* 打开「发起收费」弹窗 */
const openBtn = await ev(`(async () => {
  for (let t = 0; t < 12; t++) {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
    const b = btns.find((x) => /发起收费|新增收费|收款/.test((x.innerText || '').replace(/\\s/g, '')));
    if (b) { b.click(); return (b.innerText || '').replace(/\\s/g, ''); }
    await new Promise((r) => setTimeout(r, 900));
  }
  return 'no-button';
})()`);
console.log('打开弹窗按钮:', openBtn);
await sleep(2500);
await ev(`(() => {
  const st = document.createElement('style');
  st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(st); return true;
})()`);

if (PROBE) {
  console.log('弹窗文本:\n' + await ev(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
    if (!dlg) return 'no-dialog';
    return (dlg.innerText || '').slice(0, 1200);
  })()`));
  console.log('表单项标签:', await ev(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
    if (!dlg) return 'no-dialog';
    return JSON.stringify([...dlg.querySelectorAll('.el-form-item__label')].map((l) => (l.innerText || '').trim()));
  })()`));
  console.log('select 数:', await ev(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
    return dlg ? dlg.querySelectorAll('.el-select').length : -1;
  })()`));
  await shot('00-探测-弹窗初始.png');
  ws.close(); child.kill(); process.exit(0);
}

/* 选学生（远程搜索 select：点开 → 输入关键词 → 选第一项） */
await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const sel = dlg.querySelector('.el-select');
  sel.querySelector('.el-select__wrapper, .select-trigger, input').click();
  return true;
})()`);
await sleep(600);
await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const inp = dlg.querySelector('.el-select input');
  const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  d.set.call(inp, '雨');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(1600);
const picked = await ev(`(() => {
  const opts = [...document.querySelectorAll('.el-select-dropdown__item')].filter((o) => o.offsetParent !== null);
  if (!opts.length) return 'no-option';
  const t = opts[0].innerText.replace(/\\s+/g, ' ');
  opts[0].click();
  return t;
})()`);
console.log('选学生:', picked);
await sleep(1200);

/* 勾「学费」（el-checkbox-group 每 tick 会覆盖，单独勾一项即可） */
const checked = await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const box = [...dlg.querySelectorAll('.el-checkbox')].find((c) => (c.innerText || '').includes('学费'));
  if (!box) return 'no-checkbox';
  box.querySelector('.el-checkbox__inner, input').click();
  return box.className;
})()`);
console.log('勾学费:', checked);
await sleep(900);

/* 学费金额改 26000 */
const setTuition = await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const items = [...dlg.querySelectorAll('.el-form-item')];
  const item = items.find((i) => (i.querySelector('.el-form-item__label')?.innerText || '').replace(/\\s/g, '') === '学费金额');
  if (!item) return 'no-item';
  const inp = item.querySelector('input');
  const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  d.set.call(inp, '26000');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  inp.dispatchEvent(new Event('blur', { bubbles: true }));
  return inp.value;
})()`);
console.log('学费金额输入:', setTuition);
await sleep(1000);

/* 优惠名目（有优惠必选，截图完整一点） */
await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const items = [...dlg.querySelectorAll('.el-form-item')];
  const item = items.find((i) => (i.querySelector('.el-form-item__label')?.innerText || '').includes('优惠名目'));
  if (!item) return 'no-reason';
  item.querySelector('.el-select input, .el-select__wrapper').click();
  return 'opened';
})()`);
await sleep(800);
await ev(`(() => {
  const opts = [...document.querySelectorAll('.el-select-dropdown__item')].filter((o) => o.offsetParent !== null);
  const o = opts.find((x) => (x.innerText || '').includes('团报')) || opts[0];
  if (o) o.click();
  return o ? o.innerText.trim() : 'no-option';
})()`);
await sleep(1200);

console.log('金额行:', await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const rows = [...dlg.querySelectorAll('.el-form-item')].map((i) => (i.innerText || '').replace(/\\s+/g, ' ').trim())
    .filter((t) => /应缴金额|实缴金额|优惠金额|合计金额|学费金额/.test(t));
  return JSON.stringify(rows, null, 1);
})()`));
await shot('01-发起收费-应缴不变-实缴优惠联动.png');
ws.close(); child.kill(); process.exit(0);
