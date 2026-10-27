/**
 * 后端判权码覆盖检查（只读）
 *
 *   扫 server-job/src 里所有 checkPermission('X') / requirePage('X') / requireAnyPage([...]) / CONSULT_WRITE_PERM 等，
 *   与权限树可勾出来的操作码比对：
 *     · 有判权、但权限树里勾不到  → 管理员管不了（正是「催费设置」那类缺口）
 *
 * 用法：npx tsx scripts/_audit_backend_codes.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { PERM_TREE, PERM_TREE_ACTION_OPS } from '../src/perm/config/permTree';
import { PAGE_PERMISSIONS } from '../src/config/pagePermissions';

const HERE = process.cwd();
const SRC = path.resolve(HERE, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const treeCodes = new Set<string>();
for (const actMap of Object.values(PERM_TREE_ACTION_OPS)) {
  for (const codes of Object.values(actMap)) codes.forEach((c) => treeCodes.add(c));
}
for (const b of PERM_TREE.filter((x) => x.moduleKey === 'perm')) {
  for (const p of b.pages) for (const a of p.actions) treeCodes.add(`perm:${p.name}:${a.code}`);
}
const pageCodes = new Set(PAGE_PERMISSIONS.map((p) => p.code));

/** 收集代码里用到的操作码 */
const hits: Array<{ code: string; file: string; line: number }> = [];
const patterns = [
  /checkPermission\(\s*'([^']+)'/g,
  /requirePage\(\s*'([^']+)'/g,
  /requireAnyPage\(\s*\[\s*([^\]]+)\]/g,
];

for (const file of walk(SRC)) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((ln, i) => {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(ln))) {
        const raw = m[1];
        const codes = raw.includes("'") ? [...raw.matchAll(/'([^']+)'/g)].map((x) => x[1]) : [raw];
        for (const c of codes) {
          hits.push({ code: c.trim(), file: path.relative(SRC, file).replace(/\\/g, '/'), line: i + 1 });
        }
      }
    }
  });
}

const opHits = hits.filter((h) => !/:view$/.test(h.code));
const unmanaged = new Map<string, Array<{ file: string; line: number }>>();
for (const h of opHits) {
  if (treeCodes.has(h.code)) continue;
  if (pageCodes.has(h.code)) continue; // 页面码（requirePage 用）
  const arr = unmanaged.get(h.code) || [];
  arr.push({ file: h.file, line: h.line });
  unmanaged.set(h.code, arr);
}

const out: string[] = [];
out.push(`后端判权调用 ${hits.length} 处 / 去重码 ${new Set(hits.map((h) => h.code)).size} 个`);
out.push(`权限树可勾操作码 ${treeCodes.size} 个 · 页面码 ${pageCodes.size} 个`);
out.push('');
out.push('=== 后端在判、但权限树里勾不到的操作码 ===');
if (!unmanaged.size) out.push('（无）');
for (const [code, list] of [...unmanaged].sort()) {
  out.push(code);
  list.slice(0, 3).forEach((l) => out.push(`    ${l.file}:${l.line}`));
}

const text = out.join('\n');
fs.writeFileSync(path.resolve(HERE, '../输出/_audit_backend_codes.txt'), text, 'utf8');
console.log(text);
process.exit(0);
