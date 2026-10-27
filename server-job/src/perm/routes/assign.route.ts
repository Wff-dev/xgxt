/**
 * 职位权限分配路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/assign
 *
 *  GET  /role-list              左栏职位清单
 *  GET  /tree?roleId=xxx        权限树 + 该职位勾选态 + 实时统计
 *  PUT  /save                   保存（全量覆盖）
 *  POST /copy                   从其他职位复制权限
 *  POST /reset                  清空该职位全部权限
 *
 * ⚠️ 本模块最关键的语义：**应用权限 = 全量覆盖**，不是增量合并。
 *    前端把整棵树的勾选状态一次性提交，后端先按 role_id 清空再插入。
 *    这样才不会出现「取消勾选后权限还在」的幽灵权限。
 * ⚠️ 未勾选即无权限 —— 不提供「拒绝」语义。
 */

import { Router } from 'express';
import { z } from 'zod';
import { BizCode, PermModule, RolePermMap } from 'shared-types/perm';
import { ok } from '../utils/response';
import { db } from '../utils/db';
import { orderRoles } from '../../utils/roleOrder';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import {
  addLog,
  clientIp,
  getRolePermMap,
  getTreeStats,
  loadModules,
  replaceRolePerms,
} from '../services/perm.service';
import { assignScopeOfRole, clearAssignScopeCache, filterPermsByScope, itemTitleOf } from '../services/assignScope';
import { clearRoleDefaultCache } from '../../utils/rolePageDefaults';
import { clearRoleActionCache } from '../../utils/roleActionOverlay';
import { clearRoleGrantedOpsCache } from '../../utils/roleGrantedOps';
import { clearRoleModuleItemsCache } from '../../utils/roleModuleItems';
/* ★ 2026-10-24：动作行保存后与页面台账联动（见 pageActionSync.ts 头注释） */
import { syncRolePageActions } from '../services/pageActionSync';

/**
 * ★★ 2026-10-24 用户口径：「页面管理给了权限，职位权限分配就应该显示出授权来」。
 * 动作行全量覆盖后跑一次联动，保证两个界面永远一致：
 *   · 页面（台账/默认）可见但动作行被清空 → 自动补回「查看」
 *     （页面级开关的最高权威在页面管理 —— 想整个收回一个页面，去页面管理取消勾选；
 *      在分配页里只取消页面内的其他动作，如核对 / 打印 / 审批）。
 *   · 页面不可见但仍有动作行 → 删光（动作行 ⊆ 可见页面）。
 */
async function syncAfterPermSave(roleId: string, operatorId: string): Promise<void> {
  await syncRolePageActions(roleId, operatorId).catch((e: any) => {
    console.error('[pageActionSync] 职位权限分配保存后联动失败：', e?.message || e);
  });
}

/**
 * ★ 2026-10-07 新增：保存权限点后立刻清掉下游缓存
 *
 * 【为什么必须有这一步】
 *   权限点（t_perm_role_perm）在两个地方被当**默认值**用：
 *     ① 职位 → 页面 的默认可见集合（rolePageDefaults.ts，15 秒内存缓存）
 *     ② 职位 → 操作码 的按钮判权叠加（roleActionOverlay.ts，15 秒内存缓存）
 *   缓存 TTL 是 15 秒，但**改完不主动清**的话，管理员会看到
 *   「界面上取消了权限点，页面/按钮却要等十几秒才变」——
 *   实测确认过是 15.1 秒（见 docs/权限控制-端到端验证报告）。
 *   加上这两行后是**即时生效**。
 */
function invalidateAfterPermChange(): void {
  clearRoleDefaultCache();
  clearRoleActionCache();
  // ★ 2026-10-22：权限模块自己的按钮判权走了「全量已授权操作码」，
  //   这份缓存也必须清 —— 否则管理员取消勾选后，按钮要等 15 秒才消失。
  clearRoleGrantedOpsCache();
  clearRoleModuleItemsCache();
  // ★ 2026-10-23：可分配范围（页面上限）也缓存了，一并清 ——
  //   否则刚在页面管理里授权完，分配树还要 8 秒才解锁。
  clearAssignScopeCache();
}

export const assignRouter = Router();

const permKey = (moduleKey: string, itemName: string) => `${moduleKey}||${itemName}`;

/* ============================================================
 * 1. 左栏职位清单
 *    GET /api/perm/assign/role-list
 * ============================================================ */

assignRouter.get(
  '/role-list',
  wrap(async (_req, res) => {
    const rows = await orderRoles(db('t_perm_role').where('is_deleted', false));
    const depts = await db('t_perm_dept').where('is_deleted', false).select('id', 'dept_name');
    const deptMap = new Map(depts.map((d: any) => [d.id, d.dept_name]));

    res.json(
      ok(
        rows.map((r: any) => ({
          id: r.id,
          roleName: r.role_name,
          roleCode: r.role_code,
          deptName: deptMap.get(r.dept_id) || '—',
          roleType: r.role_type,
          isSys: !!r.is_sys,
          roleStatus: r.role_status,
          permCount: Number(r.perm_count || 0),
        })),
      ),
    );
  }),
);

/* ============================================================
 * 2. 权限树 + 勾选态
 *    GET /api/perm/assign/tree?roleId=R01
 * ============================================================ */

const treeSchema = z.object({ roleId: z.string().min(1, '必须传 roleId') });

assignRouter.get(
  '/tree',
  validate(treeSchema),
  wrap(async (req, res) => {
    const { roleId } = (req as any).validated as { roleId: string };

    const role = await db('t_perm_role').where({ id: roleId, is_deleted: false }).first();
    if (!role) throw new BizError(BizCode.ROLE_NOT_FOUND, '职位不存在');

    const [mods, perms, stats, scope] = await Promise.all([
      loadModules(),
      getRolePermMap(roleId),
      getTreeStats(),
      assignScopeOfRole(roleId),
    ]);

    /**
     * ★ 2026-10-23：勾选态也只回**范围内的**。
     *
     *   库里可能残留「页面已被页面管理关掉、但动作行还在」的历史数据
     *   （如教务老师的班级管理/待接收学员）。这种行如果照原样返回，
     *   前端概览就会把它当成"这职位有这页权限"显示出来 —— 正是用户看到的差异。
     *   这里先滤掉：界面只呈现范围内的事实；脏数据由 scripts/fix-role-perm-scope 清。
     */
    const scopedPerms = filterPermsByScope(perms, scope).perms;

    /**
     * ★ 2026-10-23：可分配范围（页面上限）
     *
     *   「页面管理 → 职位」里没勾的页面，这里一律 assignable=false：
     *   前端不渲染、后端保存时丢弃。想放开 → 先去页面管理给这个职位勾上那一页。
     *   （改这里之前先看 services/assignScope.ts 的说明。）
     */
    let assignableCount = 0;

    // 把勾选态挂到每个功能点上，前端不用再自己算
    const modules: PermModule[] = mods.map((m) => {
      let checkedCount = 0;
      let grantedItemCount = 0;
      const items = m.items.map((it) => {
        const key = permKey(m.moduleKey, it.itemName);
        const checked = scopedPerms[key] || [];
        const assignable = !scope.restricted || scope.allowedItems.has(key);
        if (assignable) assignableCount += 1;
        if (checked.length) {
          checkedCount += checked.length;
          grantedItemCount += 1;
        }
        return { ...it, checked, assignable };
      });
      return { ...m, items, checkedCount, grantedItemCount };
    });

    // 实时统计（弹窗底部）
    const allChecked = new Set<string>();
    let coveredModuleCount = 0;
    Object.keys(scopedPerms).forEach((k) => {
      const codes = scopedPerms[k] || [];
      if (codes.length) coveredModuleCount += 1;
      codes.forEach((c) => allChecked.add(`${k}||${c}`));
    });
    // 覆盖模块数按「模块」去重（不是功能点）
    const coveredModules = new Set(
      Object.keys(scopedPerms)
        .filter((k) => (scopedPerms[k] || []).length)
        .map((k) => k.split('||')[0]),
    );
    coveredModuleCount = coveredModules.size;

    res.json(
      ok({
        role: {
          id: role.id,
          roleName: role.role_name,
          roleCode: role.role_code,
          roleType: role.role_type,
          isSys: !!role.is_sys,
          roleStatus: role.role_status,
        },
        modules,
        perms: scopedPerms,
        stats,
        selected: {
          checkedActionCount: allChecked.size,
          coveredModuleCount,
          totalActionCount: stats.actionCount,
        },
        /** 可分配范围（0 = 不设限）；前端据此决定要不要提示「去页面管理授权」 */
        scope: {
          restricted: scope.restricted,
          allowedCount: scope.restricted ? assignableCount : 0,
          totalCount: stats.itemCount,
        },
      }),
    );
  }),
);

/* ============================================================
 * 3. 保存权限（全量覆盖）
 *    PUT /api/perm/assign/save   body: { roleId, perms }
 * ============================================================ */

const saveSchema = z.object({
  roleId: z.string().min(1, '必须传 roleId'),
  perms: z.record(z.array(z.string())),
});

assignRouter.put(
  '/save',
  checkPermission('perm:职位权限分配:editPerm'),
  validate(saveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as { roleId: string; perms: RolePermMap };

    const role = await db('t_perm_role').where({ id: body.roleId, is_deleted: false }).first();
    if (!role) throw new BizError(BizCode.ROLE_NOT_FOUND, '职位不存在');

    const before = Number(role.perm_count || 0);

    /**
     * ★ 2026-10-23：保存前按「可分配范围」过滤
     *
     *   前端已经把未授权的页面灰掉了，这里再拦一次是为了防绕过
     *   （直接调接口 / 旧版前端缓存）。被丢弃的都是「该职位在页面管理里
     *   本来就没有这一页」的功能点 —— 勾了也不算，否则就会像咨询老师
     *   那样凭空多出「审批中心」。
     */
    const scope = await assignScopeOfRole(body.roleId);
    const filtered = filterPermsByScope(body.perms, scope);

    const permCount = await replaceRolePerms(
      body.roleId,
      filtered.perms,
      req.user?.userId || 'system',
    );
    // ★ 立刻让下游（页面默认 + 按钮判权）拿到最新权限点
    invalidateAfterPermChange();
    // ★ 2026-10-24：与页面台账联动（页面被授权但动作被清空 → 补回「查看」）
    await syncAfterPermSave(body.roleId, req.user?.userId || 'system');

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '权限变更',
      targetObj: `职位 ${role.role_name}`,
      beforeValue: `权限点 ${before}`,
      afterValue:
        filtered.dropped > 0
          ? `权限点 ${permCount}（忽略 ${filtered.dropped} 个未授权页面：${filtered.droppedItems
              .map(itemTitleOf)
              .join('、')}）`
          : `权限点 ${permCount}`,
      ip: clientIp(req),
    });

    res.json(
      ok(
        { permCount, dropped: filtered.dropped, droppedItems: filtered.droppedItems.map(itemTitleOf) },
        filtered.dropped > 0
          ? `已应用，共 ${permCount} 个权限点；有 ${filtered.dropped} 个页面该职位未获授权，已忽略`
          : `已应用，共 ${permCount} 个权限点`,
      ),
    );
  }),
);

/* ============================================================
 * 4. 复制权限
 *    POST /api/perm/assign/copy   body: { targetRoleId, sourceRoleId }
 * ============================================================ */

assignRouter.post(
  '/copy',
  checkPermission('perm:职位权限分配:copy'),
  validate(
    z.object({
      targetRoleId: z.string().min(1, '必须传 targetRoleId'),
      sourceRoleId: z.string().min(1, '必须传 sourceRoleId'),
    }),
  ),
  wrap(async (req, res) => {
    const { targetRoleId, sourceRoleId } = (req as any).validated as {
      targetRoleId: string;
      sourceRoleId: string;
    };

    if (targetRoleId === sourceRoleId) {
      throw new BizError(BizCode.PARAM_ERROR, '来源职位与目标职位不能是同一个');
    }

    const [target, source] = await Promise.all([
      db('t_perm_role').where({ id: targetRoleId, is_deleted: false }).first(),
      db('t_perm_role').where({ id: sourceRoleId, is_deleted: false }).first(),
    ]);
    if (!target) throw new BizError(BizCode.ROLE_NOT_FOUND, '目标职位不存在');
    if (!source) throw new BizError(BizCode.ROLE_NOT_FOUND, '来源职位不存在');

    const perms = await getRolePermMap(sourceRoleId);
    if (!Object.keys(perms).some((k) => (perms[k] || []).length)) {
      throw new BizError(BizCode.PERM_SAVE_EMPTY, `来源职位「${source.role_name}」没有任何权限可复制`);
    }

    /**
     * ★ 2026-10-23：复制也要守「目标职位的页面上限」
     *
     *   来源职位权限更全（如咨询经理有审批中心、目标咨询老师没有），
     *   直接整份复制过去就又造出一个越权页面。所以按目标职位的范围过滤：
     *   只复制它已经有授权的那些页面，其余的忽略并在返回里说清楚。
     */
    const scope = await assignScopeOfRole(targetRoleId);
    const filtered = filterPermsByScope(perms, scope);
    if (!Object.keys(filtered.perms).some((k) => (filtered.perms[k] || []).length)) {
      throw new BizError(
        BizCode.PERM_SAVE_EMPTY,
        `目标职位「${target.role_name}」没有任何已授权的页面，无法复制；请先在「页面管理 → 职位」里给它授权页面`,
      );
    }

    const permCount = await replaceRolePerms(
      targetRoleId,
      filtered.perms,
      req.user?.userId || 'system',
    );
    invalidateAfterPermChange();
    // ★ 2026-10-24：复制授权后同样与页面台账联动
    await syncAfterPermSave(targetRoleId, req.user?.userId || 'system');

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '权限变更',
      targetObj: `职位 ${target.role_name}`,
      beforeValue: `权限点 ${target.perm_count}`,
      afterValue:
        filtered.dropped > 0
          ? `复制自「${source.role_name}」，权限点 ${permCount}（忽略 ${filtered.dropped} 个未授权页面）`
          : `复制自「${source.role_name}」，权限点 ${permCount}`,
      ip: clientIp(req),
    });

    res.json(
      ok(
        {
          permCount,
          sourceRoleName: source.role_name,
          dropped: filtered.dropped,
          droppedItems: filtered.droppedItems.map(itemTitleOf),
        },
        filtered.dropped > 0
          ? `已复制权限 ${permCount} 个权限点；有 ${filtered.dropped} 个页面目标职位未获授权，已跳过`
          : `已复制权限，共 ${permCount} 个权限点`,
      ),
    );
  }),
);

/* ============================================================
 * 5. 恢复默认 / 清空
 *    POST /api/perm/assign/reset   body: { roleId, mode }
 *
 * ⚠️ mode = 'clear'（默认）清空为 0；
 *          'full' 恢复「全模块全动作」（仅调试用，正式环境不建议暴露）。
 * ============================================================ */

assignRouter.post(
  '/reset',
  checkPermission('perm:职位权限分配:resetPrefab'),
  validate(
    z.object({
      roleId: z.string().min(1, '必须传 roleId'),
      mode: z.enum(['clear', 'full']).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const { roleId, mode } = (req as any).validated as { roleId: string; mode?: 'clear' | 'full' };

    const role = await db('t_perm_role').where({ id: roleId, is_deleted: false }).first();
    if (!role) throw new BizError(BizCode.ROLE_NOT_FOUND, '职位不存在');

    let perms: RolePermMap = {};
    if (mode === 'full') {
      const mods = await loadModules();
      mods.forEach((m) => {
        m.items.forEach((it) => {
          perms[permKey(m.moduleKey, it.itemName)] = it.actions.map((a) => a.actionCode);
        });
      });
      /**
       * ★ 2026-10-23：「全量赋予」也只在本职位已授权的页面里全量。
       *   否则一次「重置」就把审批中心之类的页面塞给咨询老师，
       *   与「分配树里点不到」自相矛盾。
       */
      perms = filterPermsByScope(perms, await assignScopeOfRole(roleId)).perms;
    }

    const before = Number(role.perm_count || 0);
    const permCount = await replaceRolePerms(roleId, perms, req.user?.userId || 'system');
    invalidateAfterPermChange();
    // ★ 2026-10-24：重置/全量赋予后同样与页面台账联动
    await syncAfterPermSave(roleId, req.user?.userId || 'system');

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '权限变更',
      targetObj: `职位 ${role.role_name}`,
      beforeValue: `权限点 ${before}`,
      afterValue: mode === 'full' ? `已全量赋予，权限点 ${permCount}` : '已清空权限',
      ip: clientIp(req),
    });

    res.json(ok({ permCount }, mode === 'full' ? '已赋予全部权限' : '已清空该职位的权限'));
  }),
);

export default assignRouter;
