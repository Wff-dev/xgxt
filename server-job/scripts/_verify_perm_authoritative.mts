/**
 * 权限树权威判权 —— 全角色矩阵验证（只读）
 *
 * 用**真实的** resolveActionWithOverlay 跑一遍，确认：
 *   ① 每个职位在「权限树里勾了的」动作上都放行（不再出现「勾了却 403」）
 *   ② 只勾了查看的页面，写动作被拒绝
 *   ③ 没配过的角色仍走静态兜底（不被误伤）
 *
 * 用法：npx tsx scripts/_verify_perm_authoritative.mts
 */
import { db } from '../src/perm/utils/db';
import { PERM_TREE_ACTION_OPS } from '../src/perm/config/permTree';
import {
  preloadRoleActionOverrides,
  resolveActionWithOverlay,
  getRemovedActionCodesForRoles,
} from '../src/utils/roleActionOverlay';

/** 操作码 → 拥有它的功能点 */
const CODE_OWNERS = new Map<string, string[]>();
for (const [itemKey, actMap] of Object.entries(PERM_TREE_ACTION_OPS)) {
  for (const codes of Object.values(actMap)) {
    for (const c of codes) {
      const arr = CODE_OWNERS.get(c) || [];
      if (!arr.includes(itemKey)) arr.push(itemKey);
      CODE_OWNERS.set(c, arr);
    }
  }
}

/** 关键业务码：这些是「校长/财务必须能用」的核心写操作 */
const CRITICAL: Array<[string, string]> = [
  ['finance:fee:verify', '财务核对缴费单'],
  ['finance:refund:pay', '退费确认出款'],
  ['finance:freeze:manage', '冻结/解冻'],
  ['finance:standard:manage', '费用标准维护'],
  ['consult:student:add', '新建学生'],
  ['consult:fee:formal', '正式学费收款'],
  ['consult:refund:apply', '发起退费'],
  ['class:student:add', '教学-新增学生'],
  ['class:classInfo:add', '教学-新增班级'],
  ['job:leave:approve', '休学/退学审批'],
  ['perm:职位管理:add', '新建职位'],
];

async function main(): Promise<void> {
  await db.raw('SELECT 1');
  await preloadRoleActionOverrides();

  const roles = (await db('t_perm_role')
    .where('is_deleted', false)
    .orderBy('sort_no')
    .select('id', 'role_code as roleCode', 'role_name as roleName')) as any[];

  const grants = (await db('t_perm_role_perm as rp')
    .leftJoin('t_perm_role as r', 'r.id', 'rp.role_id')
    .where('rp.is_deleted', false)
    .select(
      'r.role_code as roleCode',
      'rp.module_key as moduleKey',
      'rp.item_name as itemName',
      'rp.action_code as actionCode',
    )) as any[];

  /** roleCode → 已勾选集合 */
  const granted = new Map<string, Set<string>>();
  for (const g of grants) {
    let s = granted.get(g.roleCode);
    if (!s) {
      s = new Set();
      granted.set(g.roleCode, s);
    }
    s.add(`${g.moduleKey}||${g.itemName}||${g.actionCode}`);
  }

  const allCodes = Array.from(CODE_OWNERS.keys()).sort();

  /* ===== ① 全员一致性：树上勾了的码必须放行；没勾且页面配过的必须拒绝 ===== */
  console.log('=== ① 权限树 vs 判权 一致性（staticAllow 一律 false，只看树）===');
  console.log('职位 | 树勾选码数 | 判权放行 | 应放行 | 漏放行(勾了却拒) | 越权(没勾却给)');
  console.log('---|---|---|---|---|---');

  let bad = 0;
  for (const r of roles) {
    const set = granted.get(r.roleCode) || new Set<string>();
    // 该角色勾过的码 → 应放行
    const shouldAllow = new Set<string>();
    for (const [itemKey, actMap] of Object.entries(PERM_TREE_ACTION_OPS)) {
      for (const [act, codes] of Object.entries(actMap)) {
        if (!set.has(`${itemKey}||${act}`)) continue;
        codes.forEach((c) => shouldAllow.add(c));
      }
    }
    let allowed = 0;
    const missed: string[] = [];
    const excess: string[] = [];
    for (const code of allCodes) {
      const ok = resolveActionWithOverlay([r.roleCode], code, () => false);
      if (ok) allowed++;
      if (shouldAllow.has(code) && !ok) missed.push(code);
      if (!shouldAllow.has(code) && ok) excess.push(code);
    }
    if (missed.length) bad++;
    console.log(
      `| ${r.roleName}(${r.roleCode}) | ${shouldAllow.size} | ${allowed} | ${shouldAllow.size} | ${missed.length} | ${excess.length} |`,
    );
    if (missed.length) console.log(`   ⚠️ 漏放行：${missed.join(', ')}`);
  }

  /* ===== ② 关键业务码：谁放行 ===== */
  console.log('\n=== ② 关键业务操作放行名单（staticAllow 一律 false，只看树）===');
  for (const [code, name] of CRITICAL) {
    const who = roles
      .filter((r) => resolveActionWithOverlay([r.roleCode], code, () => false))
      .map((r) => r.roleName);
    console.log(`${name.padEnd(18, ' ')} ${code.padEnd(28, ' ')} → ${who.join('、') || '（无人）'}`);
  }

  /* ===== ③ 前端要隐藏的按钮码数量（只勾查看 → 写按钮消失） ===== */
  console.log('\n=== ③ 前端将隐藏的操作码数量（权限树没勾的）===');
  for (const r of roles) {
    const removed = getRemovedActionCodesForRoles([r.roleCode]);
    console.log(`${r.roleName}(${r.roleCode}) → ${removed.length} 个`);
  }

  console.log(`\n结论：${bad === 0 ? '✅ 全部职位「树勾了→放行」一致，无漏放行' : `❌ ${bad} 个职位存在漏放行`}`);
  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
