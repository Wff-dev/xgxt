/**
 * 权限树「增量同步」脚本（不清空、不重建，可重复执行）
 * ============================================================
 *
 * 【和 seed-perm-tree.ts 的区别】
 *   `seed:perm-tree:apply` 是**重建**：把旧树整棵逻辑删除 → 按 permTree.ts 重新灌
 *   → 各职位初始授权全部按「默认页面 + 全勾」重拍，管理员手工勾过的差异会被抹掉。
 *   本脚本是**增量合并**，只动「代码里变了的那部分」：
 *     ① 新页面 / 新动作 → 插入（is_deleted=0）
 *     ② 动作改名 / 基类变化 → 就地更新（**action_code 不变，授权不丢**）
 *     ③ 代码里已删除的动作 → 逻辑删除，并同步逻辑删除各职位的授权行
 *     ④ 对「本次新增的动作」按下面的策略给职位补授权 + 补基线
 *   其余行一律不碰，管理员已有的勾选原样保留。
 *
 * 【为什么要补基线 t_perm_role_perm_baseline】
 *   roleActionOverlay 用的是「差异存储」：
 *      最终操作码 = 静态兜底 ∪ (现在勾了 − 基线勾过) − (基线勾过 − 现在没勾)
 *   新动作如果只写 role_perm 不写基线，会被算成「新增授权」（多给），
 *   以后管理员取消勾选时又会因为基线里没有它而撤销不掉。
 *   → 所以「补授权」和「补基线」必须成对写入。
 *
 * 【新增动作授权策略（可改这里）】
 *   · 默认：凡是**能看见该页面**（在该页已有任一动作）的职位，都补上；
 *   · 例外：`NEW_ACTION_DENY` 里点名的「页面 + 动作 → 纯教学岗不给」，
 *     用于「楼栋设置」「分派宿舍」这类只该归教务/学管的口径。
 *
 * 【用法】
 *   cd server-job
 *   npx tsx scripts/sync-perm-tree-actions.ts            # 只打印计划（不动库）
 *   npx tsx scripts/sync-perm-tree-actions.ts --apply    # 真正写库
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { db } from '../src/perm/utils/db';
import { PERM_TREE, PERM_TREE_STATS } from '../src/perm/config/permTree';

const APPLY = process.argv.includes('--apply');
const NOW = new Date();

/* ============================================================
 * 新增动作的职位授权策略
 * ============================================================ */

/** 纯教学岗（班主任 / 教员 / 助教）：不参与楼栋字典与班级分派 */
const PURE_TEACH_ROLE_PREFIX = ['TEACH_HEAD', 'TEACH_TUTOR', 'TEACH_ASSIST', 'BZR_', 'JY_', 'ZJ_'];

/**
 * `板块key||页面名` → 不给「纯教学岗」的动作码
 *
 * 依据（2026-10-26 核对前端）：
 *   · 宿舍管理的「分派宿舍」「楼栋设置」两个页签对纯班主任是隐藏的
 *     （TeachingDorm.vue 的 isOnlyHeadTeacher）；
 *   · 楼栋字典属于基础数据，归教务 / 学管 / 校方维护。
 */
const NEW_ACTION_DENY: Record<string, string[]> = {
  'teach||宿舍管理': ['allocate', 'buildAdd', 'buildEdit', 'buildDel'],
};

function isPureTeach(roleCode: string): boolean {
  return PURE_TEACH_ROLE_PREFIX.some((p) => roleCode.startsWith(p));
}

/* ============================================================ */

interface MenuRow {
  id: string;
  module_key: string;
  item_name: string;
  is_custom: number;
}
interface ActionRow {
  id: string;
  menu_id: string;
  action_code: string;
  action_name: string;
  base_action: number;
  action_sort?: number;
  remark?: string | null;
}
interface RoleRow {
  id: string;
  role_code: string;
  role_name: string;
}

async function main() {
  console.log(`模式：${APPLY ? '★ 写库(--apply)' : '预览（加 --apply 才写库）'}`);
  console.log(
    `代码里的权限树：${PERM_TREE_STATS.modCount} 板块 / ${PERM_TREE_STATS.itemCount} 页面 / ${PERM_TREE_STATS.actionCount} 动作\n`,
  );

  const menus = (await db('t_perm_menu')
    .where('is_deleted', false)
    .select('id', 'module_key', 'item_name', 'is_custom')) as MenuRow[];
  const menuByKey = new Map<string, MenuRow>();
  for (const m of menus) {
    const k = `${m.module_key}||${m.item_name}`;
    if (!menuByKey.has(k)) menuByKey.set(k, m);
  }

  const actions = (await db('t_perm_menu_action')
    .where('is_deleted', false)
    .select('id', 'menu_id', 'action_code', 'action_name', 'base_action', 'action_sort', 'remark')) as ActionRow[];
  const actByKey = new Map<string, ActionRow>();
  for (const a of actions) {
    const k = `${a.menu_id}||${a.action_code}`;
    if (!actByKey.has(k)) actByKey.set(k, a);
  }

  const newMenus: Record<string, unknown>[] = [];
  const newActions: Record<string, unknown>[] = [];
  const renamed: { id: string; menu_id: string; code: string; from: string; to: string }[] = [];
  const baseChanged: { id: string; from: number; to: number }[] = [];
  /** 动作排序对齐（新动作插进来后，旧行 action_sort 会撞号，统一按代码顺序重排） */
  const sortChanged: { id: string; from: number; to: number }[] = [];
  /** remark 里存的是 ops（操作码），代码里改了就同步 */
  const remarkChanged: { id: string; to: string | null }[] = [];
  const keepActionIds = new Set<string>();
  const keepMenuIds = new Set<string>();

  /** 本次新增的动作：`板块||页面` → 动作码[]（后面按它补授权） */
  const addedByPage = new Map<string, string[]>();

  for (let bi = 0; bi < PERM_TREE.length; bi++) {
    const board = PERM_TREE[bi];
    for (let pi = 0; pi < board.pages.length; pi++) {
      const page = board.pages[pi];
      const pageKey = `${board.moduleKey}||${page.name}`;
      const exist = menuByKey.get(pageKey);

      let menuId: string;
      if (exist) {
        menuId = exist.id;
        keepMenuIds.add(menuId);
      } else {
        menuId = `MN2_${board.moduleKey}_${String(pi + 1).padStart(2, '0')}`;
        const dup = await db('t_perm_menu').where({ id: menuId }).first();
        if (dup) menuId = `${menuId}_${Date.now().toString(36).slice(-4)}`;
        newMenus.push({
          id: menuId,
          create_time: NOW,
          create_by: 'sync-perm-tree',
          is_deleted: false,
          module_key: board.moduleKey,
          module_name: board.name,
          module_icon: board.icon,
          module_sort: board.sort ?? bi + 1,
          item_name: page.name,
          parent_item_name: null,
          item_sort: pi + 1,
          remark: `${page.path}${page.remark ? ` · ${page.remark}` : ''}`,
          is_custom: false,
        });
        console.log(`  + 页面 ${board.name} / ${page.name}`);
      }

      for (let ai = 0; ai < page.actions.length; ai++) {
        const act = page.actions[ai];
        const key = `${menuId}||${act.code}`;
        const old = actByKey.get(key);
        if (old) {
          keepActionIds.add(old.id);
          if (old.action_name !== act.name) {
            renamed.push({
              id: old.id,
              menu_id: menuId,
              code: act.code,
              from: old.action_name,
              to: act.name,
            });
          }
          if (Number(old.base_action) !== act.base) {
            baseChanged.push({ id: old.id, from: Number(old.base_action), to: act.base });
          }
          const newRemark = act.ops?.length ? act.ops.join(' / ') : null;
          if ((old.remark || null) !== newRemark) remarkChanged.push({ id: old.id, to: newRemark });
          const oldSort = Number((old as any).action_sort ?? 0);
          if (oldSort !== ai + 1) {
            sortChanged.push({ id: old.id, from: oldSort, to: ai + 1 });
          }
          continue;
        }
        let id = `MA2_${board.moduleKey}_${String(pi + 1).padStart(2, '0')}_${String(ai + 1).padStart(2, '0')}`;
        const dup = await db('t_perm_menu_action').where({ id }).first();
        if (dup) id = `${id}_${Date.now().toString(36).slice(-4)}`;
        newActions.push({
          id,
          create_time: NOW,
          create_by: 'sync-perm-tree',
          is_deleted: false,
          menu_id: menuId,
          action_code: act.code,
          action_name: act.name,
          base_action: act.base,
          action_sort: ai + 1,
          remark: act.ops?.length ? act.ops.join(' / ') : null,
        });
        const arr = addedByPage.get(pageKey) || [];
        arr.push(act.code);
        addedByPage.set(pageKey, arr);
        console.log(`  + 动作 ${board.name} / ${page.name} / ${act.name}`);
      }
    }
  }

  /* ---------- 代码里已不存在的动作 → 逻辑删除 ---------- */
  const removed: { id: string; menu_id: string; action_code: string; action_name: string }[] = [];
  for (const a of actions) {
    if (keepActionIds.has(a.id)) continue;
    // 只处理「属于代码树页面」下的多余动作；代码树里没有的页面（历史/自建）一概不动
    if (!keepMenuIds.has(a.menu_id)) continue;
    removed.push({ id: a.id, menu_id: a.menu_id, action_code: a.action_code, action_name: a.action_name });
    console.log(`  - 动作（代码里已无）${a.action_code} / ${a.action_name}`);
  }

  /* ---------- 职位与已有授权 ---------- */
  const roles = (await db('t_perm_role')
    .where('is_deleted', false)
    .select('id', 'role_code', 'role_name')) as RoleRow[];

  const rolePerms = (await db('t_perm_role_perm')
    .where('is_deleted', false)
    .select('role_id', 'module_key', 'item_name', 'action_code')) as {
    role_id: string;
    module_key: string;
    item_name: string;
    action_code: string;
  }[];

  /** roleId → Set<'模块||页面'>（有任一动作 = 能看见这页） */
  const pageOfRole = new Map<string, Set<string>>();
  for (const p of rolePerms) {
    const s = pageOfRole.get(p.role_id) || new Set<string>();
    s.add(`${p.module_key}||${p.item_name}`);
    pageOfRole.set(p.role_id, s);
  }

  const baseRows = (await db('t_perm_role_perm_baseline').select(
    'role_code',
    'module_key',
    'item_name',
    'action_code',
  )) as { role_code: string; module_key: string; item_name: string; action_code: string }[];
  const baseSet = new Set(
    baseRows.map((b) => `${b.role_code}||${b.module_key}||${b.item_name}||${b.action_code}`),
  );

  const grants: { role_id: string; menu_id: string; module_key: string; item_name: string; action_code: string }[] =
    [];
  const grantsBase: {
    id: string;
    role_code: string;
    module_key: string;
    item_name: string;
    action_code: string;
  }[] = [];

  for (const [pageKey, codes] of addedByPage) {
    const [moduleKey, itemName] = pageKey.split('||');
    const menu = newMenus.find((m: any) => m.module_key === moduleKey && m.item_name === itemName);
    const menuId = menu ? String((menu as any).id) : menuByKey.get(pageKey)?.id || '';
    const deny = NEW_ACTION_DENY[pageKey] || [];
    for (const role of roles) {
      if (!pageOfRole.get(role.id)?.has(pageKey)) continue; // 没这页权限 → 不给
      for (const code of codes) {
        if (deny.includes(code) && isPureTeach(role.role_code)) continue;
        grants.push({ role_id: role.id, menu_id: menuId, module_key: moduleKey, item_name: itemName, action_code: code });
        const bkey = `${role.role_code}||${moduleKey}||${itemName}||${code}`;
        if (!baseSet.has(bkey)) {
          grantsBase.push({
            id: randomUUID(),
            role_code: role.role_code,
            module_key: moduleKey,
            item_name: itemName,
            action_code: code,
          });
          baseSet.add(bkey);
        }
      }
    }
  }

  /* ---------- 打印计划 ---------- */
  console.log('\n===== 计划 =====');
  console.log(`新增页面：${newMenus.length}`);
  console.log(`新增动作：${newActions.length}`);
  console.log(`动作改名：${renamed.length}`);
  for (const r of renamed) console.log(`    · ${r.code}: ${r.from} → ${r.to}`);
  console.log(`基类变化：${baseChanged.length}`);
  console.log(`动作排序对齐：${sortChanged.length}`);
  console.log(`操作码备注更新：${remarkChanged.length}`);
  console.log(`删除动作（代码里已无）：${removed.length}`);
  console.log(`补职位授权：${grants.length} 条（涉及 ${new Set(grants.map((g) => g.role_id)).size} 个职位）`);
  console.log(`补基线：${grantsBase.length} 条`);

  if (!APPLY) {
    console.log('\n（预览模式，未写库。加 --apply 执行）');
    await db.destroy();
    return;
  }

  await db.transaction(async (trx) => {
    if (newMenus.length) await trx('t_perm_menu').insert(newMenus);
    if (newActions.length) await trx('t_perm_menu_action').insert(newActions);

    for (const r of renamed) {
      await trx('t_perm_menu_action')
        .where({ id: r.id })
        .update({ action_name: r.to, update_time: NOW });
      // 授权行里冗余存了 action_name（页面显示读的是它），一起改
      await trx('t_perm_role_perm')
        .where({ menu_id: r.menu_id, action_code: r.code, is_deleted: false })
        .update({ action_name: r.to, update_time: NOW });
    }
    for (const b of baseChanged) {
      await trx('t_perm_menu_action').where({ id: b.id }).update({ base_action: b.to, update_time: NOW });
    }
    for (const r of remarkChanged) {
      await trx('t_perm_menu_action').where({ id: r.id }).update({ remark: r.to, update_time: NOW });
    }
    for (const s of sortChanged) {
      await trx('t_perm_menu_action').where({ id: s.id }).update({ action_sort: s.to, update_time: NOW });
    }

    if (removed.length) {
      await trx('t_perm_menu_action')
        .whereIn(
          'id',
          removed.map((r) => r.id),
        )
        .update({ is_deleted: true, update_time: NOW });
      for (const r of removed) {
        await trx('t_perm_role_perm')
          .where({ menu_id: r.menu_id, action_code: r.action_code, is_deleted: false })
          .update({ is_deleted: true, update_time: NOW });
      }
    }

    if (grants.length) {
      const actMeta = new Map<string, { name: string; base: number }>();
      for (const a of newActions as any[]) {
        actMeta.set(`${a.menu_id}||${a.action_code}`, { name: a.action_name, base: a.base_action });
      }
      const rows = grants.map((g) => {
        const meta = actMeta.get(`${g.menu_id}||${g.action_code}`);
        return {
          id: randomUUID(),
          create_time: NOW,
          create_by: 'sync-perm-tree',
          is_deleted: false,
          role_id: g.role_id,
          menu_id: g.menu_id,
          module_key: g.module_key,
          item_name: g.item_name,
          action_code: g.action_code,
          action_name: meta?.name || g.action_code,
          base_action: meta?.base ?? 3,
        };
      });
      for (let i = 0; i < rows.length; i += 200) {
        await trx('t_perm_role_perm').insert(rows.slice(i, i + 200));
      }
    }
    if (grantsBase.length) {
      for (let i = 0; i < grantsBase.length; i += 200) {
        await trx('t_perm_role_perm_baseline').insert(grantsBase.slice(i, i + 200));
      }
    }
  });

  /* ---------- 重算 perm_count ---------- */
  for (const role of roles) {
    const n = Number(
      (
        (await db('t_perm_role_perm')
          .where({ role_id: role.id, is_deleted: false })
          .count({ n: '*' } as any)) as any[]
      )[0]?.n || 0,
    );
    await db('t_perm_role').where({ id: role.id }).update({ perm_count: n });
  }

  console.log('\n★ 已写库，perm_count 已重算');
  await db.destroy();
}

main().catch(async (e) => {
  console.error('FAIL:', e?.message || e);
  await db.destroy().catch(() => {});
  process.exit(1);
});
