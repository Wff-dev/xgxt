/**
 * CDP 取证：补费金额拆到财务的每一栏（学费/住宿费/餐费/保险费各进各栏）
 *
 * 截图：
 *   30-财务-学员详情-学费缴费记录.png
 *   31-财务-学员详情-住宿费缴费记录.png
 *   32-财务-学员详情-餐费缴费记录.png
 *   33-财务-学员详情-保险费.png
 *   34-财务-学员详情-基础信息.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.resolve(HERE, '..', '输出', '财务补费拆栏取证');
fs.mkdirSync(OUTDIR, { recursive: true });
const BASEWEB = 'http://localhost:5173';
const STUDENT = process.argv[2] || '王海洋';
const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-bill-'));
const child = spawn(
  BROWSER,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=9366',
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
      const r = await fetch('http://127.0.0.1:9366/json/list');
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
  console.log('  shot:', name);
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

/* 登录（财务 周铭） */
await ev(`(() => { try { localStorage.clear(); } catch(e){} return true; })()`);
await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/login` });
await sleep(3200);
await ev(`(() => {
  const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
    d.set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
  const inputs = [...document.querySelectorAll('input')].filter(i => i.type !== 'checkbox');
  if (inputs[0]) set(inputs[0], 'zhoum');
  if (inputs[1]) set(inputs[1], '123456');
})()`);
await sleep(400);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').replace(/\\s/g,'') === '登录'); if (b) b.click(); })()`);
await sleep(4000);
console.log('登录:', (await ev(`(() => !location.hash.includes('/login'))()`)) ? '成功' : '失败');

await send('Page.navigate', { url: `${BASEWEB}/?t=${Date.now()}#/finance/bill` });
await sleep(4500);
await ev(`(() => {
  const st = document.createElement('style');
  st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(st); return true;
})()`);

/* 搜学生 */
await ev(`(() => {
  const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
    d.set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
  const inp = [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null)
    .find(i => (i.placeholder||'').includes('姓名') || (i.placeholder||'').includes('学号') || (i.placeholder||'').includes('搜索'));
  if (inp) set(inp, '${STUDENT}');
  return !!inp;
})()`);
await sleep(600);
await ev(`(() => { const b = [...document.querySelectorAll('button')].filter(x => x.offsetParent !== null)
  .find(x => /查询|搜索/.test((x.innerText||'').replace(/\\s/g,''))); if (b) b.click(); return !!b; })()`);
await sleep(2600);

/* 点该学生那一行的「详情」 */
console.log(
  '点详情:',
  await ev(`(() => {
  const rows = [...document.querySelectorAll('.el-table__row')].filter((r) => r.innerText.includes('${STUDENT}'));
  if (!rows.length) return 'no-row';
  const b = [...rows[0].querySelectorAll('button, a')].find((x) => /详情/.test(x.innerText || ''));
  if (!b) return 'no-btn';
  b.click();
  return rows[0].innerText.replace(/\\s+/g, ' ').slice(0, 80);
})()`),
);
await sleep(2200);

const clickTab = async (label) =>
  ev(`(() => {
  const tabs = [...document.querySelectorAll('.fee-tabs .el-tabs__item')].filter((t) => t.offsetParent !== null);
  const t = tabs.find((x) => (x.innerText || '').trim().startsWith('${label}'));
  if (!t) return 'no-tab: ' + tabs.map((x) => x.innerText.trim()).join('|');
  t.click();
  return 'ok';
})()`);

for (const [label, file] of [
  ['学费缴费记录', '30-财务-学员详情-学费缴费记录.png'],
  ['住宿费缴费记录', '31-财务-学员详情-住宿费缴费记录.png'],
  ['餐费缴费记录', '32-财务-学员详情-餐费缴费记录.png'],
  ['保险费', '33-财务-学员详情-保险费.png'],
]) {
  console.log(label, await clickTab(label));
  await sleep(900);
  await shot(file);
}

console.log('基础信息', await clickTab('基础信息'));
await sleep(800);
await shot('34-财务-学员详情-基础信息.png');

/* 补费单本身还是「一张单、四个分项」：点住宿费那行的「详情」，看缴费单详情 */
console.log('住宿费', await clickTab('住宿费缴费记录'));
await sleep(700);
console.log(
  '点详情›:',
  await ev(`(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null);
  if (!dlg) return 'no-dialog';
  const b = [...dlg.querySelectorAll('button')].find((x) => /详情/.test(x.innerText || ''));
  if (!b) return 'no-btn';
  b.click();
  return 'ok';
})()`),
);
await sleep(2200);
await shot('35-财务-补费单详情-应缴实缴优惠.png');

ws.close();
child.kill();
await sleep(500);
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}
process.exit(0);
