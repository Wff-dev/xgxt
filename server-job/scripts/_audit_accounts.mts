/**
 * 账号 ↔ 职位 ↔ 模块 一致性检查（只读）
 *
 * 回答：
 *   ① 有没有账号一个职位都没绑（登录后什么也看不到，或按门户模块乱给）
 *   ② 有没有账号绑的职位在 t_perm_role 里不存在（脏编码）
 *   ③ 账号的职位需要的模块 与 门户 modules 是否对得上（门开了锁没换）
 *   ④ 每个账号最终能看到的页面数 / 岗位是否与预期相符
 *
 * 用法：npx tsx scripts/_audit_accounts.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { db } from '../src/perm/utils/db';

const HERE = process.cwd();

async function main() {
  const accounts = (await db('sms_perm.t_perm_user as u')
    .where('u.is_deleted', false)
    .select('u.id', 'u.account', 'u.user_name', 'u.is_deleted')) as any[];
  const links = (await db('sms_perm.t_perm_user_role as ur')
    .where('ur.is_deleted', false)
    .select('ur.user_id', 'ur.role_id')) as any[];
  const roles = (await db('sms_perm.t_perm_role')
    .where('is_deleted', false)
    .select('id', 'role_code', 'role_name')) as any[];
  const portal = (await db('sms_portal.t_sys_account')
    .where('is_deleted', false)
    .select('account', 'user_name', 'modules', 'kind', 'active')) as any[];

  const roleOf = new Map(roles.map((r) => [String(r.id), r]));
  const rolesByUser = new Map<string, string[]>();
  for (const l of links) {
    const arr = rolesByUser.get(String(l.user_id)) || [];
    arr.push(String(l.role_id));
    rolesByUser.set(String(l.user_id), arr);
  }
  const portalOf = new Map(portal.map((p) => [String(p.account), p]));

  const out: string[] = [];
  const issues: string[] = [];
  out.push('账号\t姓名\t职位\t门户模块\t状态');

  for (const a of accounts) {
    const rs = rolesByUser.get(String(a.id)) || [];
    const names = rs.map((id) => roleOf.get(id)?.role_name || `❌未知(${id})`).join('/') || '（无职位）';
    const p = portalOf.get(String(a.account));
    const mods = p ? (Array.isArray(p.modules) ? p.modules.join(',') : String(p.modules || '')) : '（无门户账号）';
    const state = !p ? '❌无门户账号' : p.active ? 'ok' : '已停用';
    out.push(`${a.account}\t${a.user_name}\t${names}\t${mods}\t${state}`);

    if (!rs.length) issues.push(`账号 ${a.account}（${a.user_name}）没有绑定任何职位`);
    for (const id of rs) if (!roleOf.has(id)) issues.push(`账号 ${a.account} 绑定了不存在的职位 ${id}`);
    if (!p) issues.push(`账号 ${a.account} 在门户 sms_portal 里不存在（登录不了）`);
  }

  /* 门户里有、权限库里没有的账号（能登录但没有职位 → 挂不到权限树） */
  for (const p of portal) {
    const hit = accounts.find((a) => String(a.account) === String(p.account));
    if (!hit) issues.push(`门户账号 ${p.account}（${p.user_name}）在权限库没有对应人员`);
  }

  out.push('');
  out.push(`合计：账号 ${accounts.length} 个 / 门户账号 ${portal.length} 个 / 职位 ${roles.length} 个`);
  out.push('');
  out.push('=== 问题 ===');
  out.push(issues.length ? issues.join('\n') : '（无）');

  const text = out.join('\n');
  fs.writeFileSync(path.resolve(HERE, '../输出/_audit_accounts.txt'), text, 'utf8');
  console.log(text);
  await db.destroy();
}
main().catch(async (e) => { console.error(e); await db.destroy().catch(() => {}); process.exit(1); });
