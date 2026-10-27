/**
 * 页面 × 动作 对照（只读）：权限树里每个动作，在它所属页面文件里找不找得到对应按钮文案
 *
 * 精确做法：
 *   权限树 page.path → router/index.ts 里该 path 的 component → 真实 .vue 文件
 *   → 在该文件 template 里找动作名（按「·」「/」「（」拆词，任一命中即算找到）
 *
 * 用途：找出「权限树里有、界面上没有」的幽灵动作 —— 管理员勾了也没用，容易误导。
 *
 * 用法：npx tsx scripts/_audit_page_actions.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { PERM_TREE } from '../src/perm/config/permTree';

const HERE = process.cwd();
const WEB = path.resolve(HERE, '../web-job/src');
const ROUTER = path.join(WEB, 'router/index.ts');

const routerSrc = fs.readFileSync(ROUTER, 'utf8');

/** 逐块解析 router：{ path, component } */
interface RouteInfo { path: string; file?: string }
const routes: RouteInfo[] = [];
{
  const blocks = routerSrc.split(/\n\s*\{\s*\n/);
  for (const b of blocks) {
    const p = /path:\s*'([^']+)'/.exec(b)?.[1];
    if (!p) continue;
    const c = /component:\s*\(\)\s*=>\s*import\(\s*'([^']+)'\s*\)/.exec(b)?.[1];
    routes.push({ path: p, file: c });
  }
}

function resolveVue(importPath?: string): string | null {
  if (!importPath) return null;
  const rel = importPath.replace(/^@\//, '');
  const p = path.join(WEB, rel);
  return fs.existsSync(p) ? p : null;
}

function templateOf(file: string): string {
  const src = fs.readFileSync(file, 'utf8');
  const end = src.indexOf('<script');
  return end > 0 ? src.slice(0, end) : src;
}

/** 模块目录（页面找不到时兜底搜索的区域） */
const MODULE_DIR: Record<string, string> = {
  workbench: path.join(WEB, 'views'),
  consult: path.join(WEB, 'consult'),
  finance: path.join(WEB, 'finance'),
  perm: path.join(WEB, 'perm'),
  teach: path.join(WEB, 'teaching'),
};

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

/** 动作名拆词：「交接班主任/教员」→ [交接, 班主任, 教员]；「升实训/升云」等 */
function keywordsOf(name: string): string[] {
  const plain = name.replace(/（.*?）/g, '').trim();
  const frags = plain
    .split(/[\/·、,，]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const cands = new Set<string>(frags);
  // 中文动作名多为「动词+宾语」：取前 2 / 3 字当按钮文案（核对缴费单 → 核对）
  if (plain.length >= 4) cands.add(plain.slice(0, 3));
  if (plain.length >= 3) cands.add(plain.slice(0, 2));
  return [...cands];
}

const out: string[] = [];
let ghost = 0;
let checked = 0;

for (const board of PERM_TREE) {
  for (const page of board.pages) {
    const route = routes.find((r) => r.path === page.path);
    const file = resolveVue(route?.file);
    const isPageFile = !!file;
    // 页面文件模板 + 同模块目录（页签内容常拆在子组件里）
    let haystack = file ? templateOf(file) : '';
    if (!isPageFile) {
      for (const f of walk(MODULE_DIR[board.moduleKey] || '')) haystack += '\n' + templateOf(f);
    }
    // 有页面文件时，也要看同模块子组件（hub 页把内容拆出去的情况）
    const moduleAll = walk(MODULE_DIR[board.moduleKey] || '')
      .map((f) => templateOf(f))
      .join('\n');

    for (const act of page.actions) {
      if (act.code === 'view') continue;
      checked++;
      const kws = keywordsOf(act.name);
      if (!kws.length) continue;
      const hitSelf = kws.some((k) => haystack.includes(k));
      const hitModule = !hitSelf && kws.some((k) => moduleAll.includes(k));
      if (hitSelf || hitModule) continue;
      ghost++;
      out.push(
        `${board.name} / ${page.name} / ${act.name}${file ? '' : '  ⚠页面文件未找到'}`,
      );
    }
  }
}

const text = [
  `核对动作 ${checked} 个（跳过「查看」）；找不到按钮文案的 ${ghost} 个`,
  '',
  ghost ? out.join('\n') : '（无）',
].join('\n');
fs.writeFileSync(path.resolve(HERE, '../输出/_audit_page_actions.txt'), text, 'utf8');
console.log(text);
process.exit(0);
