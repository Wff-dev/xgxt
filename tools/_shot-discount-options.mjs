/**
 * CDP 取证：优惠名目下拉里已去掉「奖学金」（发起收费 + 补费两处共用一份字典）
 *
 * 截图：
 *   20-发起收费-优惠名目-展开.png
 *   21-补费-优惠名目-展开.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.resolve(HERE, '..', '输出', '咨询收费取证');
fs.mkdirSync(OUTDIR, { recursive: true });
const BASEWEB = 'http://localhost:5173';
const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-opt-'));
const child = spawn(
  BROWSER,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=9364',
    '--user-data-dir=' + profile,
    '--window-size=1560,1120',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let msgId = 0;
const pending = new Map();
async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9364/json/list');
      const page = (await r.json()).find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error('no target');
}
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId;
    const to = setTimeout(() => rej(new Error('timeout ' + m)), 30000);
    pending.set(id, { res, rej, to });
    ws.send(JSON.stringify({ id, method: m, params: p }));
  });
const ev = async (x) =>
  (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result
    ?.value;
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, 'base64'));
  console.log('  shot:', path.join(OUTDIR, name));
};

ws = new WebSocket(await getTarget());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
ws.onmessage = (e) => {
  let m;
  try {
    m = JSON.parse(e.data);
  } catch {
    return;
  }
  if (m.id && pending.has(m.id)) {
    const { res, rej, to } = pending.get(m.id);
    clearTimeout(to);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
await send('Page.enable');
await send('Runtime.enable');

/* 登录 */
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
await sleep(4200);
await ev(`(() => {
  const st = document.createElement('style');
  st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(st); return true;
})()`);

/* ---------- A. 发起收费：展开优惠名目下拉 ---------- */
await ev(`(async () => {
  for (let t = 0; t < 12; t++) {
    const bs = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
    const b = bs.find((x) => /发起收费|新增收费|收款/.test((x.innerText || '').replace(/\\s/g, '')));
    if (b) { b.click(); return true; }
    await new Promise((r) => setTimeout(r, 900));
  }
  return false;
})()`);
await sleep(2600);

/* 选学生 */
await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const sel = dlg.querySelector('.el-select');
  sel.querySelector('.el-select__wrapper, .select-trigger, input').click();
  return true;
})()`);
await sleep(700);
await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const inp = dlg.querySelector('.el-select input');
  const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  d.set.call(inp, '邓');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(2600);
let pickedName = await ev(`(() => {
  const opts = [...document.querySelectorAll('.el-select-dropdown__item')].filter((o) => o.offsetParent !== null);
  if (!opts.length) return 'no-option';
  const t = opts[0].innerText.replace(/\\s+/g, ' ');
  opts[0].click();
  return t;
})()`);
if (pickedName === 'no-option') {
  await ev(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
    const inp = dlg.querySelector('.el-select input');
    const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    d.set.call(inp, '杨');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(2600);
  pickedName = await ev(`(() => {
    const opts = [...document.querySelectorAll('.el-select-dropdown__item')].filter((o) => o.offsetParent !== null);
    if (!opts.length) return 'no-option';
    const t = opts[0].innerText.replace(/\\s+/g, ' ');
    opts[0].click();
    return t;
  })()`);
}
console.log('选学生:', pickedName);
await sleep(1400);

/* 勾学费 + 改学费 26000 → 出现优惠名目 */
await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const box = [...dlg.querySelectorAll('.el-checkbox')].find((c) => (c.innerText || '').includes('学费'));
  if (box) box.querySelector('.el-checkbox__inner, input').click();
  return !!box;
})()`);
await sleep(900);
await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const item = [...dlg.querySelectorAll('.el-form-item')].find(
    (i) => (i.querySelector('.el-form-item__label')?.innerText || '').replace(/\\s/g, '') === '学费金额',
  );
  if (!item) return 'no-item';
  const inp = item.querySelector('input');
  const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  d.set.call(inp, '26000');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  inp.dispatchEvent(new Event('blur', { bubbles: true }));
  return inp.value;
})()`);
await sleep(1200);

/* 点开优惠名目下拉（不选，留证据） */
console.log(
  '发起收费·打开名目下拉:',
  await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const item = [...dlg.querySelectorAll('.el-form-item')].find((i) =>
    (i.querySelector('.el-form-item__label')?.innerText || '').includes('优惠名目'),
  );
  if (!item) return 'no-item';
  item.querySelector('.el-select input, .el-select__wrapper').click();
  return 'opened';
})()`),
);
await sleep(900);
console.log(
  '发起收费·名目选项:',
  await ev(`(() => {
  const opts = [...document.querySelectorAll('.el-select-dropdown__item')].filter((o) => o.offsetParent !== null);
  return JSON.stringify(opts.map((o) => (o.innerText || '').trim()));
})()`),
);
await shot('20-发起收费-优惠名目-展开.png');

/* 关掉下拉 + 取消弹窗（先按 Esc，防止 dropdown 残留在左下角） */
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(500);
await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const b = [...dlg.querySelectorAll('button')].find((x) => (x.innerText || '').replace(/\s/g, '') === '取消');
  if (b) b.click();
  return !!b;
})()`);
await sleep(1800);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(600);

/* ---------- B. 补费：展开优惠名目下拉 ---------- */
console.log(
  '点补费:',
  await ev(`(async () => {
  for (let t = 0; t < 12; t++) {
    const bs = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
    const b = bs.find((x) => (x.innerText || '').replace(/\\s/g, '') === '补费');
    if (b) { b.click(); return true; }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
})()`),
);
await sleep(2800);

await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const rows = [...dlg.querySelectorAll('.el-table__body tbody tr')];
  const row = rows.find((r) => (r.innerText || '').includes('学费'));
  if (!row) return 'no-row';
  const inp = row.querySelector('.el-input-number input');
  if (!inp) return 'no-input';
  const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  d.set.call(inp, '27300');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  inp.blur();
  return 'set-27300';
})()`);
await sleep(1400);
console.log(
  '补费·打开名目下拉:',
  await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  const item = [...dlg.querySelectorAll('.el-form-item')].find((i) => (i.innerText || '').includes('优惠名目'));
  if (!item) return 'no-item';
  item.querySelector('.el-select input, .el-select__wrapper').click();
  return 'opened';
})()`),
);
await sleep(900);
console.log(
  '补费·名目选项:',
  await ev(`(() => {
  const opts = [...document.querySelectorAll('.el-select-dropdown__item')].filter((o) => o.offsetParent !== null);
  return JSON.stringify(opts.map((o) => (o.innerText || '').trim()));
})()`),
);
await shot('21-补费-优惠名目-展开.png');

ws.close();
child.kill();
process.exit(0);
