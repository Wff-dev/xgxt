/**
 * 页面清单一致性（只读）
 *
 *   A. 角色默认页面表里写的页面，权限树里存不存在（写错名字=该页永远不显示）
 *   B. 权限树（页面管理）里的 path，前端路由里有没有
 *   C. 前端路由里带 pageCode 的页面，有没有登记进页面管理（= 管不到的野页面）
 *
 * 用法：npx tsx scripts/_audit_page_registry.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { PERM_TREE } from '../src/perm/config/permTree';
import { ROLE_DEFAULT_PAGES } from '../src/perm/config/roleDefaultPages';

const HERE = process.cwd();
const ROUTER = path.resolve(HERE, '../web-job/src/router/index.ts');

const treeKeys = new Set<string>();
const treePaths = new Map<string, string>();
for (const b of PERM_TREE) {
  for (const p of b.pages) {
    treeKeys.add(`${b.moduleKey}||${p.name}`);
    treePaths.set(p.path, `${b.name} / ${p.name}`);
  }
}

const out: string[] = [];

/* A */
const badDefaults: string[] = [];
for (const [role, list] of Object.entries(ROLE_DEFAULT_PAGES)) {
  for (const k of list as string[]) {
    if (!treeKeys.has(k)) badDefaults.push(`${role} → ${k}`);
  }
}
out.push('=== A. 角色默认页面里不存在的页面 ===');
out.push(badDefaults.length ? badDefaults.join('\n') : '（无）');

/* B / C */
const src = fs.readFileSync(ROUTER, 'utf8');
const routeBlocks = [...src.matchAll(/path:\s*'([^']+)'[\s\S]{0,400}?meta:\s*\{[^}]*pageCode:\s*'([^']+)'/g)].map((m) => ({
  path: m[1],
  pageCode: m[2],
}));

const missingRoute = [...treePaths.entries()].filter(([p]) => !routeBlocks.some((r) => r.path === p));
out.push('');
out.push('=== B. 页面管理里有、前端路由里没有的页面 ===');
out.push(missingRoute.length ? missingRoute.map(([p, n]) => `${n}  ${p}`).join('\n') : '（无）');

const orphan = routeBlocks.filter((r) => !treePaths.has(r.path) && !r.path.startsWith('/:'));
out.push('');
out.push('=== C. 有路由 + 有页面码、但没登记进页面管理的页面 ===');
out.push(orphan.length ? orphan.map((r) => `${r.path}  (${r.pageCode})`).join('\n') : '（无）');

out.push('');
out.push(`统计：权限树 ${treePaths.size} 页 / 路由中带 pageCode 的 ${routeBlocks.length} 条`);

const text = out.join('\n');
fs.writeFileSync(path.resolve(HERE, '../输出/_audit_page_registry.txt'), text, 'utf8');
console.log(text);
process.exit(0);
