/**
 * 抽视频帧（无 ffmpeg 环境下的兜底方案）
 *
 * 思路：用无头 Edge 打开一个带 <video>+<canvas> 的本地页面，
 *       逐个 currentTime 跳转 → drawImage 到 canvas → 截图落盘。
 * 用法：node tools/_video_frames.mjs "<mp4路径>" <输出目录> [帧数]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MP4 = process.argv[2];
const OUT = process.argv[3] || 'output_frames';
const N = Number(process.argv[4] || 12);

if (!MP4 || !fs.existsSync(MP4)) {
  console.error('找不到视频:', MP4);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const tmpProfile = path.join(os.tmpdir(), `edge-frames-${Date.now()}`);
const htmlPath = path.join(os.tmpdir(), `vid-${Date.now()}.html`);
fs.writeFileSync(
  htmlPath,
  `<!doctype html><html><body style="margin:0;background:#000">
<video id="v" src="file:///${MP4.replace(/\\/g, '/')}" muted preload="auto" style="display:none"></video>
<canvas id="c"></canvas>
<script>
window.__ready = false;
const v = document.getElementById('v');
v.addEventListener('loadedmetadata', () => { window.__ready = true; window.__dur = v.duration; window.__w = v.videoWidth; window.__h = v.videoHeight; });
window.__seek = (t) => new Promise((res) => {
  const done = () => { v.removeEventListener('seeked', done); res(true); };
  v.addEventListener('seeked', done);
  v.currentTime = t;
});
window.__grab = () => {
  const c = document.getElementById('c');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  document.body.style.width = c.width + 'px';
  return true;
};
</script></body></html>`,
);

const proc = spawn(
  EDGE,
  [
    '--headless=new',
    '--remote-debugging-port=9333',
    `--user-data-dir=${tmpProfile}`,
    '--allow-file-access-from-files',
    '--disable-gpu',
    '--window-size=1920,1200',
    `file:///${htmlPath.replace(/\\/g, '/')}`,
  ],
  { stdio: 'ignore', detached: false },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('连不上调试端口');
}

const wsUrl = await getWs();
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};

for (let i = 0; i < 60; i++) {
  if (await ev('window.__ready === true')) break;
  await sleep(500);
}
const dur = await ev('window.__dur');
const w = await ev('window.__w');
const h = await ev('window.__h');
console.log(`时长 ${dur?.toFixed?.(2)}s, ${w}x${h}`);

for (let i = 0; i < N; i++) {
  const t = (dur * (i + 0.5)) / N;
  await ev(`window.__seek(${t})`);
  await sleep(320);
  await ev('window.__grab()');
  await sleep(200);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `${String(i + 1).padStart(2, '0')}_${t.toFixed(1)}s.png`);
  fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  console.log('写入', file);
}

ws.close();
proc.kill();
await sleep(600);
try {
  fs.rmSync(tmpProfile, { recursive: true, force: true });
} catch {}
fs.rmSync(htmlPath, { force: true });
process.exit(0);
