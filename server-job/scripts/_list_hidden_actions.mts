/**
 * 打印「权限树没勾 → 前端将隐藏」的操作码明细（只读）
 *
 * 用法：npx tsx scripts/_list_hidden_actions.mts
 */
import { db } from '../src/perm/utils/db';
import {
  preloadRoleActionOverrides,
  getRemovedActionCodesForRoles,
} from '../src/utils/roleActionOverlay';

async function main(): Promise<void> {
  await db.raw('SELECT 1');
  await preloadRoleActionOverrides();

  const roles = (await db('t_perm_role')
    .where('is_deleted', false)
    .orderBy('sort_no')
    .select('role_code as roleCode', 'role_name as roleName')) as any[];

  for (const r of roles) {
    const hidden = getRemovedActionCodesForRoles([r.roleCode]);
    if (!hidden.length) continue;
    console.log(`\n### ${r.roleName}(${r.roleCode}) 将隐藏 ${hidden.length} 个操作`);
    hidden.sort().forEach((c) => console.log(`  - ${c}`));
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
