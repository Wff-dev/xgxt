/**
 * 探针：财务「费用标准」页的动作行 + 各职位在该页的授权
 * 用法：npx tsx scripts/_probe_urge_perm.mts
 */
import 'dotenv/config';
import { db } from '../src/perm/utils/db';

async function main() {
  const menus = await db('t_perm_menu')
    .where({ is_deleted: false })
    .whereIn('module_key', ['finance'])
    .select('id', 'module_key', 'item_name', 'module_name', 'item_sort', 'remark')
    .orderBy('item_sort');
  console.log('=== finance 板块页面 ===');
  for (const m of menus as any[]) console.log(`${m.id}\t${m.item_name}\t${m.remark || ''}`);

  const stdMenu = (menus as any[]).find((m) => m.item_name === '费用标准');
  if (stdMenu) {
    const acts = await db('t_perm_menu_action')
      .where({ menu_id: stdMenu.id, is_deleted: false })
      .select('action_code', 'action_name', 'base_action', 'action_sort', 'remark')
      .orderBy('action_sort');
    console.log('\n=== 费用标准 动作行 ===');
    for (const a of acts as any[]) console.log(`${a.action_sort}\t${a.action_code}\t${a.action_name}\tbase=${a.base_action}\tops=${a.remark || ''}`);

    const rows = await db('t_perm_role_perm as p')
      .leftJoin('t_perm_role as r', 'r.id', 'p.role_id')
      .where({ 'p.is_deleted': false, 'p.module_key': 'finance', 'p.item_name': '费用标准' })
      .select('r.id as role_id', 'r.role_code', 'r.role_name', 'p.action_code');
    const byRole = new Map<string, { code: string; name: string; acts: string[] }>();
    for (const r of rows as any[]) {
      const k = String(r.role_id);
      const o = byRole.get(k) || { code: r.role_code, name: r.role_name, acts: [] };
      o.acts.push(r.action_code);
      byRole.set(k, o);
    }
    console.log('\n=== 各职位在「费用标准」的授权 ===');
    for (const [id, v] of byRole) console.log(`${v.name}(${v.code}) ${id}\t${v.acts.join(',')}`);
  }

  const roles = await db('t_perm_role')
    .where({ is_deleted: false })
    .select('id', 'role_code', 'role_name', 'perm_count')
    .orderBy('role_code');
  console.log('\n=== 全部职位 ===');
  for (const r of roles as any[]) console.log(`${r.role_name}\t${r.role_code}\tperm=${r.perm_count}\tid=${r.id}`);

  await db.destroy();
}
main().catch(async (e) => {
  console.error(e);
  await db.destroy().catch(() => {});
  process.exit(1);
});
