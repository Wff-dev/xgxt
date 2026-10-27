/**
 * 判权改造影响面分析（只读，不改数据）
 *
 * 目的：把 resolveActionWithOverlay 从「差异基线」改成「权限树权威」之前，
 *      先算出全 22 个职位在两种模型下每个操作码的放行差异，
 *      确认不会误伤正常业务。
 *
 * 用法：npx tsx scripts/_audit_perm_authoritative.mts
 */
import { db } from '../src/perm/utils/db';
import { PERM_TREE_ACTION_OPS } from '../src/perm/config/permTree';

/** 操作码 → 拥有它的功能点列表 */
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

interface RoleInfo {
  roleCode: string;
  roleName: string;
  /** module||item -> 该页面已勾选的动作 */
  grantedByItem: Map<string, Set<string>>;
  /** 基线里勾过的三元组 */
  baseline: Set<string>;
}

async function main(): Promise<void> {
  await db.raw('SELECT 1');

  const roles = (await db('t_perm_role')
    .where('is_deleted', false)
    .select('id', 'role_code as roleCode', 'role_name as roleName')) as any[];

  const perms = (await db('t_perm_role_perm as rp')
    .leftJoin('t_perm_role as r', 'r.id', 'rp.role_id')
    .where('rp.is_deleted', false)
    .select(
      'r.role_code as roleCode',
      'rp.module_key as moduleKey',
      'rp.item_name as itemName',
      'rp.action_code as actionCode',
    )) as any[];

  const baselineRows = (await db('t_perm_role_perm_baseline').select(
    'role_code as roleCode',
    'module_key as moduleKey',
    'item_name as itemName',
    'action_code as actionCode',
  )) as any[];

  const byRole = new Map<string, RoleInfo>();
  for (const r of roles) {
    byRole.set(r.roleCode, {
      roleCode: r.roleCode,
      roleName: r.roleName,
      grantedByItem: new Map(),
      baseline: new Set(),
    });
  }
  for (const p of perms) {
    const info = byRole.get(p.roleCode);
    if (!info) continue;
    const itemKey = `${p.moduleKey}||${p.itemName}`;
    let s = info.grantedByItem.get(itemKey);
    if (!s) {
      s = new Set();
      info.grantedByItem.set(itemKey, s);
    }
    s.add(p.actionCode);
  }
  for (const b of baselineRows) {
    const info = byRole.get(b.roleCode);
    if (!info) continue;
    info.baseline.add(`${b.moduleKey}||${b.itemName}||${b.actionCode}`);
  }

  /** 旧模型：静态表 ∪ 新增 − 撤销（这里用「静态放行」= true 模拟最宽松的 job 总闸） */
  const oldModel = (info: RoleInfo, code: string, staticAllow: boolean): boolean => {
    let removed = false;
    let added = false;
    const owners = CODE_OWNERS.get(code) || [];
    for (const itemKey of owners) {
      const actMap = PERM_TREE_ACTION_OPS[itemKey] || {};
      for (const [act, codes] of Object.entries(actMap)) {
        if (!codes.includes(code)) continue;
        const k = `${itemKey}||${act}`;
        const granted = info.grantedByItem.get(itemKey)?.has(act) || false;
        const base = info.baseline.has(k);
        if (granted && !base) added = true;
        if (!granted && base) removed = true;
      }
    }
    if (added) return true;
    if (removed) return false;
    return staticAllow;
  };

  /**
   * 新模型：该职位在「拥有这个码的页面」上有勾选记录 → 权限树是唯一权威；
   *         完全没记录 → 回落静态表。
   */
  const newModel = (info: RoleInfo, code: string, staticAllow: boolean): boolean => {
    const owners = CODE_OWNERS.get(code) || [];
    const configured = owners.filter((k) => info.grantedByItem.has(k));
    if (!configured.length) return staticAllow;
    return configured.some((itemKey) => {
      const actMap = PERM_TREE_ACTION_OPS[itemKey] || {};
      const granted = info.grantedByItem.get(itemKey)!;
      return Object.entries(actMap).some(
        ([act, codes]) => granted.has(act) && codes.includes(code),
      );
    });
  };

  const allCodes = Array.from(CODE_OWNERS.keys()).sort();
  const lines: string[] = [];
  lines.push('| 职位 | 码总数 | 旧模型放行 | 新模型放行 | 新放行(新增权限) | 新拒绝(可能收权) |');
  lines.push('|---|---|---|---|---|---|');

  const suspicious: string[] = [];

  for (const info of byRole.values()) {
    let o = 0;
    let n = 0;
    const gained: string[] = [];
    const lost: string[] = [];
    for (const code of allCodes) {
      const a = oldModel(info, code, true);
      const b = newModel(info, code, true);
      if (a) o++;
      if (b) n++;
      if (!a && b) gained.push(code);
      if (a && !b) lost.push(code);
    }
    lines.push(
      `| ${info.roleName}(${info.roleCode}) | ${allCodes.length} | ${o} | ${n} | ${gained.length} | ${lost.length} |`,
    );
    if (lost.length) {
      suspicious.push(`\n### ${info.roleName}(${info.roleCode}) 新模型下会被拒绝 ${lost.length} 个码`);
      suspicious.push(lost.map((c) => `- ${c}`).join('\n'));
    }
  }

  console.log(lines.join('\n'));
  console.log('\n===== 新模型下会被拒绝的明细（重点核查） =====');
  console.log(suspicious.join('\n') || '（无）');

  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
