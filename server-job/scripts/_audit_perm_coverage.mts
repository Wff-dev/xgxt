/**
 * 权限覆盖审计（只读）
 * ============================================================
 * 回答三个问题：
 *   A. 前端用了哪些操作码 → 权限树里有没有对应的「可勾选动作」？
 *      （没有 = 管理员在职位权限分配里管不到它，就是「催费设置」这次的问题）
 *   B. 权限树里的动作 → 前端页面上还能不能找到对应按钮/页签？
 *      （找不到 = 幽灵权限，勾了也没用，误导管理员）
 *   C. 各职位：可见页面 vs 动作行 是否自洽？
 *      可见但一条动作都没有（登录后进去按钮全灰）/ 有动作但页面不可见（越权残留）
 *
 * 用法：npx tsx scripts/_audit_perm_coverage.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { db } from '../src/perm/utils/db';
import { PERM_TREE, PERM_TREE_ACTION_OPS } from '../src/perm/config/permTree';
import { effectiveKeysOfRole } from '../src/utils/rolePageEffective';

const HERE = process.cwd();
const WEB = path.resolve(HERE, '../web-job/src');

/* ---------------- 1. 收集前端用到的操作码 ---------------- */

interface CodeUse {
  code: string;
  file: string;
  line: number;
  kind: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(vue|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const uses: CodeUse[] = [];
const PATTERNS: Array<[RegExp, string]> = [
  [/hasPerm\(\s*'([^']+)'/g, 'hasPerm'],
  [/\bcan\(\s*'([^']+)'/g, 'can'],
  [/canAct\(\s*'([^']+)'/g, 'canAct'],
  [/v-if="[^"]*hasPerm\(\s*'([^']+)'/g, 'v-if'],
];

for (const file of walk(WEB)) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  for (const [re, kind] of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[i]))) {
        uses.push({
          code: m[1],
          file: path.relative(WEB, file).replace(/\\/g, '/'),
          line: i + 1,
          kind,
        });
      }
    }
  }
}

/** 权限树里所有「能勾出操作码」的码 */
const treeCodes = new Set<string>();
for (const actMap of Object.values(PERM_TREE_ACTION_OPS)) {
  for (const codes of Object.values(actMap)) codes.forEach((c) => treeCodes.add(c));
}
/** perm 模块自己的动作码（perm:功能点:动作） */
for (const board of PERM_TREE.filter((b) => b.moduleKey === 'perm')) {
  for (const page of board.pages) {
    for (const act of page.actions) treeCodes.add(`perm:${page.name}:${act.code}`);
  }
}

const unmanaged = new Map<string, CodeUse[]>();
for (const u of uses) {
  if (u.code.includes('*')) continue;
  if (treeCodes.has(u.code)) continue;
  // 页面码（class:xxx:view）不属于按钮级，跳过
  if (/:view$/.test(u.code)) continue;
  const arr = unmanaged.get(u.code) || [];
  arr.push(u);
  unmanaged.set(u.code, arr);
}

/* ---------------- 2. 权限树动作 → 前端有没有对应文案 ---------------- */

function allVueText(): string {
  const parts: string[] = [];
  for (const f of walk(WEB)) {
    if (!f.endsWith('.vue')) continue;
    const src = fs.readFileSync(f, 'utf8');
    const tplEnd = src.indexOf('<script');
    parts.push(tplEnd > 0 ? src.slice(0, tplEnd) : src);
  }
  return parts.join('\n');
}
const TEMPLATE_TEXT = allVueText();

/* ---------------- 3. 职位自洽性 ---------------- */

interface Problem {
  role: string;
  kind: string;
  detail: string;
}

async function main() {
  const actions = (await db('t_perm_menu_action')
    .where('is_deleted', false)
    .select('menu_id', 'action_code', 'action_name', 'remark')) as any[];
  const menus = (await db('t_perm_menu')
    .where('is_deleted', false)
    .select('id', 'module_key', 'item_name')) as any[];
  const menuOf = new Map(menus.map((m) => [m.id, m]));

  const roles = (await db('t_perm_role')
    .where('is_deleted', false)
    .select('id', 'role_code', 'role_name')) as any[];
  const perms = (await db('t_perm_role_perm')
    .where('is_deleted', false)
    .select('role_id', 'module_key', 'item_name', 'action_code')) as any[];

  const actsByPage = new Map<string, string[]>();
  for (const a of actions) {
    const m = menuOf.get(a.menu_id);
    if (!m) continue;
    const k = `${m.module_key}||${m.item_name}`;
    const arr = actsByPage.get(k) || [];
    arr.push(`${a.action_code}(${a.action_name})`);
    actsByPage.set(k, arr);
  }

  const permsByRole = new Map<string, Set<string>>();
  for (const p of perms) {
    const s = permsByRole.get(String(p.role_id)) || new Set<string>();
    s.add(`${p.module_key}||${p.item_name}`);
    permsByRole.set(String(p.role_id), s);
  }

  const problems: Problem[] = [];
  const summary: string[] = [];

  for (const r of roles) {
    const visible = await effectiveKeysOfRole(String(r.role_code));
    /** 可见页面的 `模块||页面名` */
    const visibleItems = new Set<string>();
    for (const board of PERM_TREE) {
      for (const page of board.pages) {
        if (visible.has(`${board.moduleKey}||${page.path}`)) {
          visibleItems.add(`${board.moduleKey}||${page.name}`);
        }
      }
    }
    const has = permsByRole.get(String(r.id)) || new Set<string>();

    let noAct = 0;
    const noActList: string[] = [];
    for (const k of visibleItems) {
      if (!has.has(k)) {
        noAct++;
        if (noActList.length < 3) noActList.push(k.split('||')[1]);
      }
    }
    let ghost = 0;
    const ghostList: string[] = [];
    for (const k of has) {
      if (!visibleItems.has(k)) {
        ghost++;
        if (ghostList.length < 3) ghostList.push(k.split('||')[1]);
      }
    }

    summary.push(
      `${r.role_name}(${r.role_code}) 可见页 ${visibleItems.size} / 有动作页 ${has.size}` +
        (noAct ? `  ⚠可见无动作 ${noAct}（${noActList.join('、')}…）` : '') +
        (ghost ? `  ⚠有动作但页不可见 ${ghost}（${ghostList.join('、')}…）` : ''),
    );
    if (noAct) problems.push({ role: String(r.role_code), kind: '可见页无动作', detail: `${noAct} 页：${noActList.join('、')}` });
    if (ghost) problems.push({ role: String(r.role_code), kind: '动作残留', detail: `${ghost} 页：${ghostList.join('、')}` });
  }

  /* ---- 输出 ---- */
  const out: string[] = [];
  out.push('========== A. 前端在用、但权限树管不到的操作码 ==========');
  if (!unmanaged.size) out.push('（无）');
  for (const [code, list] of [...unmanaged].sort()) {
    out.push(`${code}`);
    for (const u of list.slice(0, 4)) out.push(`    ${u.file}:${u.line}  [${u.kind}]`);
  }

  out.push('');
  out.push('========== B. 权限树里有、前端找不到按钮文案的动作 ==========');
  const ghosts: string[] = [];
  for (const board of PERM_TREE) {
    for (const page of board.pages) {
      for (const act of page.actions) {
        if (act.code === 'view') continue;
        // 去掉「xx（yy）」括注再匹配
        const plain = act.name.replace(/（.*?）/g, '').trim();
        if (!plain) continue;
        if (TEMPLATE_TEXT.includes(plain)) continue;
        ghosts.push(`${board.name} / ${page.name} / ${act.name}`);
      }
    }
  }
  out.push(ghosts.length ? ghosts.join('\n') : '（无）');

  out.push('');
  out.push('========== C. 各职位自洽性 ==========');
  out.push(summary.join('\n'));

  out.push('');
  out.push('========== D. 统计 ==========');
  out.push(`前端操作码引用 ${uses.length} 处 / 去重 ${new Set(uses.map((u) => u.code)).size} 个`);
  out.push(`权限树可勾操作码 ${treeCodes.size} 个`);
  out.push(`无人管理的码 ${unmanaged.size} 个；幽灵动作 ${ghosts.length} 个`);

  const text = out.join('\n');
  const dest = path.resolve(HERE, '../输出/_audit_perm_coverage.txt');
  fs.writeFileSync(dest, text, 'utf8');
  console.log(text);
  console.log(`\n→ 写入 ${dest}`);
  await db.destroy();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await db.destroy().catch(() => {});
  process.exit(1);
});
