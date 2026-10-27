/**
 * 前端操作码清单对比：改动前（纯静态表）vs 改动后（权限树权威）
 *
 * 用途：确认「给前端下发的 permissions 列表」没有被意外收走关键码，
 *      以及哪些码新增（= 以前缺权限的账号现在能操作了）。
 *
 * 用法：npx tsx scripts/_diff_op_codes.mts
 */
import { db } from '../src/perm/utils/db';
import { getUserOperationPermissionsBase, getUserOperationPermissions } from '../src/utils/pagePermissionSource';
import { preloadRoleActionOverrides } from '../src/utils/roleActionOverlay';

async function main(): Promise<void> {
  await db.raw('SELECT 1');
  await preloadRoleActionOverrides();

  const roles = (await db('t_perm_role')
    .where('is_deleted', false)
    .orderBy('sort_no')
    .select('role_code as roleCode', 'role_name as roleName')) as any[];

  console.log('职位 | 改动前 | 改动后 | 新增 | 减少');
  console.log('---|---|---|---|---');

  for (const r of roles) {
    const before = new Set(getUserOperationPermissionsBase([r.roleCode]));
    const after = new Set(await getUserOperationPermissions([r.roleCode]));
    const added = Array.from(after).filter((c) => !before.has(c)).sort();
    const lost = Array.from(before).filter((c) => !after.has(c)).sort();
    console.log(
      `| ${r.roleName}(${r.roleCode}) | ${before.size} | ${after.size} | ${added.length} | ${lost.length} |`,
    );
    if (added.length) console.log(`    + ${added.join(', ')}`);
    if (lost.length) console.log(`    - ${lost.join(', ')}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
