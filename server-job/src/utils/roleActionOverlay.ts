/**
 * 角色 → 操作码 叠加层（**按钮级 + 接口级**打通 legacy 四板块 ← 权限树）
 *
 * ============================================================
 * 【解决什么问题】
 *   「职位权限分配」页面（/perm/assign）维护的是 `sms_perm.t_perm_role_perm`
 *   —— 一棵**权限树**，命名体系是
 *     `module_key`（market/teach/train/job/acad/fin/approve/perm）
 *     + 中文功能点（如「学生基础数据」）
 *     + 英文动作码（如 create / uploadAttend / submitApply）
 *
 *   而 legacy 四个板块（实训 job / 教务 edu / 班级 class / 班级初高 classjh）
 *   的按钮与接口判权用的是**另一套操作码**：
 *     `class:student:add` / `class:grade:add` / `edu:student:edit` …
 *     （前端 `can('class:student:add')`，后端 `checkPermission('class:student:add')`）
 *
 *   两套命名**没有任何一列能对上**（`class` 不是树里的模块名，
 *   树里的动作叫 `create` 而操作码里叫 `add`）→ 于是「权限树改了，
 *   按钮/接口不动」，管理员在界面上取消了某动作，按钮照样在、接口照样通。
 *
 * 【本文件做什么】
 *   ① 维护一张**显式映射表** `PERM_POINT_TO_ACTION_CODES`：
 *        树上的 (module, item, action)  →  若干个 legacy 操作码
 *   ② 用**权限树权威**模型把「管理员实际勾了什么」落到接口判权上。
 *
 * ============================================================
 * 【★★ 判权模型（2026-10-26 重写：权限树权威）】
 *
 *   逐角色判定，任一角色放行即放行：
 *
 *     该职位在「码所属页面」上没配过  → 走各模块的静态兜底表（存量零影响）
 *     配过 且 勾了这个动作            → 放行
 *     配过 但 没勾（如只勾了查看）    → 本角色拒绝 → 写接口 403
 *
 *   ⚠️ 为什么要改（2026-10-26 用户报障）：
 *     旧版是「差异存储」—— 只把**相对基线快照的改动**叠加到静态表上。
 *     基线是本功能启用那一刻的快照，因此「树里本来就勾着的动作」不算改动
 *     → 不授权 → 掉回静态表。而静态表只登记了少数岗位
 *     （财务 FIN_ROLE_OPERATIONS 只有 FIN_STAFF / SYS_ADMIN），于是：
 *       校长 159 个动作全勾了 → 点「财务核对」仍然弹「您没有该操作的权限」。
 *     用户的预期很明确：**页面管理和职位权限分配给完了，就该能操作；
 *     只给查看就只能查看。** 因此判权必须以权限树为唯一权威。
 *
 *   ⚠️ 旧版担心的「误伤」（校长在 teach 下只勾 view/export 会丢 9 个按钮）
 *      现在不再是问题 —— 用户已经把该给的都给了；而且这正是
 *      「没勾就是不能操作」的预期语义。名单见
 *      `scripts/_audit_perm_authoritative.mts` 的对照输出。
 *
 * ============================================================
 * 【降级原则】
 *   ⚠️ 与 rolePageLedger 一样：查库失败 / 无缓存 → 当作「没配过」，
 *      原样返回静态表。绝不能因为权限表抖一下就让全站按钮消失、接口全 403。
 * ============================================================
 */

import { db } from '../perm/utils/db';
import { PERM_TREE, PERM_TREE_ACTION_OPS } from '../perm/config/permTree';

/* ============================================================
 * 1. 映射表：(module||item) → { 树上动作码 → legacy 操作码[] }
 * ============================================================ */

/**
 * 维护提示：
 *   · key 一律 `module_key||item_name`（与 `t_perm_menu` 的列口径一致）
 *   · value 的 key 是 `t_perm_menu_action.action_code`
 *   · value 的值是该动作对应的一到多个 legacy 操作码
 *     （一个动作对应多码：如「录入成绩」在前端叫 `class:grade:add`、
 *       后端叫 `class:examScore:add`，两套码都要给到）
 *   · **只登记能明确对应的**；对应不上的动作不写 → 该动作不影响按钮
 */
/**
 * ★ 2026-10-22：映射表不再手写，改为**由权限树定义派生**
 *
 * 旧版这里是一张手抄的大表（8 板块 53 功能点 → 各模块操作码），
 * 每加一个功能点就要记得来登记一次 —— 2026-10-07 就因为漏登记 6 个
 * train 功能点，出现「权限树改了、按钮和接口都不动」。
 *
 * 现在权限树本身（`perm/config/permTree.ts`）的每个动作都带 `ops`，
 * 这张表直接从它派生：
 *   键盘输入 → t_perm_menu（界面） 与 操作码（判权）**同源**，不可能漂移。
 */
export const PERM_POINT_TO_ACTION_CODES: Record<string, Record<string, string[]>> =
  PERM_TREE_ACTION_OPS;

/* ============================================================
 * 2. 权限管理模块（perm）—— **同名映射**
 *
 *   树上的模块 key 就叫 `perm`，操作码格式天然同构：
 *     · perm||职位管理||add          → perm:职位管理:add
 *     · perm||职位权限分配||editPerm → perm:职位权限分配:editPerm
 *   所以这里只需要「每个页面有哪些动作」，同样从权限树派生。
 * ============================================================ */

const PERM_MODULE_ACTIONS: Record<string, string[]> = Object.fromEntries(
  PERM_TREE.filter((b) => b.moduleKey === 'perm').flatMap((b) =>
    b.pages.map((p) => [`perm||${p.name}`, p.actions.map((a) => a.code)] as [string, string[]]),
  ),
);

/** 把 `perm||功能点||动作` 拼成权限管理自己的操作码 */
function permCodeOf(itemKey: string, action: string): string {
  const item = itemKey.split('||')[1];
  return `perm:${item}:${action}`;
}

/* ============================================================
 * 2.5 ★ 反向索引：操作码 → 拥有它的功能点（module||item）
 *
 * 【为什么需要】
 *   判权时要回答一个问题：「给这个操作码的那些页面里，当前职位到底配过没有？」
 *     · 配过 → 以权限树为准（勾了才放行）
 *     · 从没配过 → 回落到各模块的静态表（老账号零影响）
 *   没有这张反向表，就只能盲猜 owner，判权会漏。
 *
 * ⚠️ 同一个操作码可能被多个页面共用（如 `job:refund:apply` 同时挂
 *    「退费」和「休学/退学审批」），所以 value 是数组，判定时取「任一」。
 * ============================================================ */
const CODE_OWNERS: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  const add = (itemKey: string, code: string): void => {
    const arr = m.get(code);
    if (!arr) {
      m.set(code, [itemKey]);
      return;
    }
    if (!arr.includes(itemKey)) arr.push(itemKey);
  };
  for (const [itemKey, actMap] of Object.entries(PERM_POINT_TO_ACTION_CODES)) {
    for (const codes of Object.values(actMap)) codes.forEach((c) => add(itemKey, c));
  }
  for (const [itemKey, actions] of Object.entries(PERM_MODULE_ACTIONS)) {
    actions.forEach((a) => add(itemKey, permCodeOf(itemKey, a)));
  }
  return m;
})();

/**
 * 永远放行的职位（不受权限树收权影响）
 *
 * ⚠️ 系统管理员必须在这里：否则哪天管理员手滑把自己的「职位权限分配」
 *    取消勾选，就再也进不去权限管理页，只能改数据库救回来。
 */
const ALWAYS_ALLOW_ROLES = new Set(['SYS_ADMIN']);

/* ============================================================
 * 3. 基线表（快照）
 * ============================================================ */

const BASELINE_TABLE = 't_perm_role_perm_baseline';

let baselineEnsured: Promise<void> | null = null;

/**
 * 建基线表，并**在第一次使用时**把当前权限树全量灌进去。
 *
 * ⚠️ 幂等：表里已有数据就什么都不做。
 * ⚠️ 「基线」的语义 = 本功能启用那一刻，权限树的既有状态。
 *    想重置基线（把当前状态重新认定为基线）：
 *      DELETE FROM sms_perm.t_perm_role_perm_baseline; 然后重启后端。
 */
async function ensureBaselineTable(): Promise<void> {
  if (baselineEnsured) return baselineEnsured;

  baselineEnsured = (async () => {
    await db.raw(`
      CREATE TABLE IF NOT EXISTS ${BASELINE_TABLE} (
        id VARCHAR(191) NOT NULL PRIMARY KEY,
        role_code VARCHAR(64) NOT NULL,
        module_key VARCHAR(32) NOT NULL,
        item_name VARCHAR(64) NOT NULL,
        action_code VARCHAR(64) NOT NULL,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_role (role_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [cnt] = (await db.raw(`SELECT COUNT(*) AS c FROM ${BASELINE_TABLE}`)) as any;
    if (Number(cnt?.[0]?.c || 0) > 0) return; // 已有基线 → 不覆盖

    // 首次：把当前权限树全量快照为基线
    await db.raw(`
      INSERT IGNORE INTO ${BASELINE_TABLE} (id, role_code, module_key, item_name, action_code)
      SELECT CONCAT(r.role_code, '|', rp.module_key, '|', rp.item_name, '|', rp.action_code),
             r.role_code, rp.module_key, rp.item_name, rp.action_code
      FROM t_perm_role_perm rp
      JOIN t_perm_role r ON r.id = rp.role_id
      WHERE rp.is_deleted = 0 AND r.is_deleted = 0
    `);

    // eslint-disable-next-line no-console
    console.log(`[权限] 已建立「按钮权限」基线快照（${BASELINE_TABLE}）`);
  })().catch((e) => {
    // 建表失败 → 关闭本次的 ensure，下次重试；但不影响主流程（会降级为「无覆盖」）
    baselineEnsured = null;
    throw e;
  });

  return baselineEnsured;
}

/* ============================================================
 * 4. 读取（带 15 秒内存缓存）
 * ============================================================ */

export interface RoleActionOverride {
  /** 该角色在权限树里「有记录」的功能点（module||item） */
  touchedItems: Set<string>;
  /** 现在勾选的三元组（module||item||action） */
  granted: Set<string>;
  /** 基线里勾选的三元组 */
  baselineGranted: Set<string>;
  /** ★ 预计算：「新增授权」映射出的操作码（供同步判定用，避免每请求重算） */
  addedCodes?: Set<string>;
  /** ★ 预计算：「撤销授权」映射出的操作码 */
  removedCodes?: Set<string>;
  /**
   * ★★ 2026-10-26：当前勾选状态映射出的**全部**操作码（不看基线）。
   *
   * 判权已改为「权限树权威」模型（见 §7）：该职位在某个页面上只要有勾选记录，
   * 这个页面上的操作就以**这里**为准 —— 在集合里 = 允许操作，不在 = 拒绝。
   */
  grantedCodes: Set<string>;
}

const CACHE_TTL_MS = 15_000;

let cache: { at: number; map: Map<string, RoleActionOverride> } | null = null;

/** 清缓存（权限管理保存角色权限后调用，让按钮/接口判定立刻生效） */
export function clearRoleActionCache(): void {
  cache = null;
}

/**
 * 读全部「角色 → 权限点」明细 + 基线，按 **role_code** 聚合。
 *
 * ⚠️ key 用 role_code：运行时 `req.user.roles` 是一串 role_code，
 *    role_id 是权限库主键，两者靠 t_perm_role 关联。
 */
export async function loadRoleActionOverrides(
  force = false,
): Promise<Map<string, RoleActionOverride>> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;

  const map = new Map<string, RoleActionOverride>();
  try {
    await ensureBaselineTable();

    const rows = await db('t_perm_role_perm as rp')
      .leftJoin('t_perm_role as r', 'r.id', 'rp.role_id')
      .where('rp.is_deleted', false)
      .andWhere('r.is_deleted', false)
      .select(
        'r.role_code as roleCode',
        'rp.module_key as moduleKey',
        'rp.item_name as itemName',
        'rp.action_code as actionCode',
      );

    for (const row of rows as any[]) {
      const code = String(row.roleCode || '');
      const mod = String(row.moduleKey || '');
      const item = String(row.itemName || '');
      const act = String(row.actionCode || '');
      if (!code || !mod || !item || !act) continue;

      let ov = map.get(code);
      if (!ov) {
        ov = {
        touchedItems: new Set(),
        granted: new Set(),
        baselineGranted: new Set(),
        grantedCodes: new Set(),
      };
        map.set(code, ov);
      }
      ov.touchedItems.add(`${mod}||${item}`);
      ov.granted.add(`${mod}||${item}||${act}`);
    }

    /* ---- 基线 ---- */
    const baseRows = await db(BASELINE_TABLE).select(
      'role_code as roleCode',
      'module_key as moduleKey',
      'item_name as itemName',
      'action_code as actionCode',
    );
    for (const row of baseRows as any[]) {
      const code = String(row.roleCode || '');
      if (!code) continue;
      let ov = map.get(code);
      if (!ov) {
        ov = {
        touchedItems: new Set(),
        granted: new Set(),
        baselineGranted: new Set(),
        grantedCodes: new Set(),
      };
        map.set(code, ov);
      }
      ov.baselineGranted.add(
        `${row.moduleKey}||${row.itemName}||${row.actionCode}`,
      );
    }

    /* ---- ★ 预计算「新增 / 撤销」的操作码（供各业务模块同步判定）---- */
    /* ---- ★★ 2026-10-26：再预计算「当前实际勾选」映射出的全部操作码 ---- */
    for (const ov of map.values()) {
      const d = diffOfOverride(ov);
      ov.addedCodes = new Set(d.added);
      ov.removedCodes = new Set(d.removed);
      ov.grantedCodes = grantedCodesOf(ov);
    }
  } catch {
    /**
     * ⚠️ 查库失败 → 当作「没有任何覆盖」放行（与 rolePageLedger 同一降级原则）。
     *    权限表抖一下，按钮不该跟着消失、接口不该全 403。
     */
    cache = { at: Date.now(), map: new Map() };
    return cache.map;
  }

  cache = { at: Date.now(), map };
  return map;
}

/** 取单个角色的权限点覆盖 */
export async function getRoleActionOverride(roleCode: string): Promise<RoleActionOverride | null> {
  const map = await loadRoleActionOverrides();
  return map.get(roleCode) || null;
}

/* ============================================================
 * 5. 叠加到操作码（差异存储）
 * ============================================================ */

/** 把「差异」换算成操作码：changed 里的三元组 → 它们映射出的操作码 */
function codesOfChanged(
  changed: (actSet: Set<string>) => Set<string>,
  ov: RoleActionOverride,
): string[] {
  const out: string[] = [];

  const collect = (itemKey: string, actMap: Record<string, string[]>): void => {
    changed(new Set(Object.keys(actMap).map((a) => `${itemKey}||${a}`))).forEach((k) => {
      const act = k.split('||')[2];
      const codes = actMap[act];
      if (codes) codes.forEach((c) => out.push(c));
    });
  };

  for (const [itemKey, actMap] of Object.entries(PERM_POINT_TO_ACTION_CODES)) {
    collect(itemKey, actMap);
  }
  for (const [itemKey, actions] of Object.entries(PERM_MODULE_ACTIONS)) {
    collect(itemKey, Object.fromEntries(actions.map((a) => [a, [permCodeOf(itemKey, a)]])) as any);
  }
  return out;
}

/**
 * ★★ 当前勾选状态 → 操作码（**不看基线**，只看此刻树里勾了什么）
 *
 * 这是「权限树权威」模型的数据基础：把该职位勾过的每个动作都换算成
 * 后端的操作码，得到一张白名单。
 */
function grantedCodesOf(ov: RoleActionOverride): Set<string> {
  const out = new Set<string>();

  const collect = (itemKey: string, actMap: Record<string, string[]>): void => {
    for (const [act, codes] of Object.entries(actMap)) {
      if (!ov.granted.has(`${itemKey}||${act}`)) continue;
      codes.forEach((c) => out.add(c));
    }
  };

  for (const [itemKey, actMap] of Object.entries(PERM_POINT_TO_ACTION_CODES)) {
    collect(itemKey, actMap);
  }
  for (const [itemKey, actions] of Object.entries(PERM_MODULE_ACTIONS)) {
    collect(itemKey, Object.fromEntries(actions.map((a) => [a, [permCodeOf(itemKey, a)]])) as any);
  }
  return out;
}

/**
 * 该职位在「拥有这个操作码的页面」上有没有配置记录？
 *
 * true  = 配过 → 权限树是唯一权威（勾了才给，没勾就收）
 * false = 没配过 → 交回各模块的静态表（保证没配过的老账号不被误伤）
 */
function isConfigured(
  ov: RoleActionOverride | null | undefined,
  actionCode: string,
): boolean {
  if (!ov) return false;
  const owners = CODE_OWNERS.get(actionCode);
  if (!owners || !owners.length) return false;
  return owners.some((k) => ov.touchedItems.has(k));
}

/**
 * 把权限树的状态叠加到 legacy 操作码列表上（**权限树权威版**）。
 *
 * 语义（2026-10-26 重写，替换原「差异基线」语义）：
 *   · 该职位在码所属页面上**没配过** → 原样返回静态表（零影响）
 *   · 配过 → 静态表只保留「树上没登记过的码」（未登记 = 界面上没得勾，
 *            不能因为没勾选就收回），有登记的码一律以树为准
 *
 * @param baseCodes 该角色的静态兜底操作码（ROLE_OPERATION_PERMISSIONS）
 * @param ov        该角色的权限点覆盖（null = 树里没有这个角色 → 不干预）
 */
export function overlayActionCodes(
  baseCodes: string[],
  ov: RoleActionOverride | null,
): string[] {
  if (!ov || ov.touchedItems.size === 0) return baseCodes;

  const granted = ov.grantedCodes || (ov.grantedCodes = grantedCodesOf(ov));
  const set = new Set<string>();

  for (const c of baseCodes) {
    const owners = CODE_OWNERS.get(c);
    // 树上没有登记这个码（界面上勾不到）→ 保留静态表结论，不受勾选影响
    if (!owners || !owners.length) {
      set.add(c);
      continue;
    }
    // 树上登记过、但当前职位在这个页面上没配过 → 同样保留静态表结论
    if (!owners.some((k) => ov!.touchedItems.has(k))) {
      set.add(c);
      continue;
    }
    // 配过 → 勾了才留
    if (granted.has(c)) set.add(c);
  }

  // 树上新勾出来的码（静态表里本来没有的），补进去
  granted.forEach((c) => set.add(c));

  return Array.from(set);
}

/* ============================================================
 * 6. 诊断用：算出某角色的「新增 / 撤销」明细（不改数据）
 * ============================================================ */

export function diffOfOverride(ov: RoleActionOverride | null): { added: string[]; removed: string[] } {
  if (!ov) return { added: [], removed: [] };
  const added = codesOfChanged(
    (keys) =>
      new Set(Array.from(keys).filter((k) => ov.granted.has(k) && !ov.baselineGranted.has(k))),
    ov,
  );
  const removed = codesOfChanged(
    (keys) =>
      new Set(Array.from(keys).filter((k) => !ov.granted.has(k) && ov.baselineGranted.has(k))),
    ov,
  );
  return { added: Array.from(new Set(added)), removed: Array.from(new Set(removed)) };
}

/* ============================================================
 * 7. ★ 同步判定接口（给各业务模块的【后端接口判权】用）
 *
 *   背景：四个 legacy 模块（class / class-jh / consult / finance）的接口
 *   判权各写各的（角色白名单 / 正则策略表 / 操作码表），都**不读权限树**。
 *   结果：管理员在「职位权限分配」里取消了某动作 → 按钮没了，
 *        但直接敲接口仍然成功（前后端不一致）。
 *
 *   本节提供 3 个函数，让这些模块用**最小改动**接入：
 *     · preloadRoleActionOverrides() —— 中间件里 await 一下，保证缓存新鲜
 *     · resolveActionWithOverlay()   —— 把「显式撤销 / 显式授权」叠加到
 *                                       模块自己的静态判权之上
 *
 *   ⚠️ 全部是「差异存储」语义：没被管理员改动过的码，行为与从前**完全一致**。
 * ============================================================ */

/** 读内存缓存里的某角色覆盖（缓存未就绪 → null = 不干预，交静态表） */
export function getOverrideSync(roleCode: string): RoleActionOverride | null {
  return cache ? cache.map.get(roleCode) || null : null;
}

/**
 * 预热内存缓存。
 *
 * 15s TTL 内是纯内存读（零查库成本），所以可以在**每个鉴权中间件**里 await；
 * 「职位权限分配」保存时会 `clearRoleActionCache()`，下一请求即重新加载 → 即时生效。
 */
export async function preloadRoleActionOverrides(): Promise<void> {
  try {
    await loadRoleActionOverrides();
  } catch {
    /* 降级：查不到就当作「无覆盖」，绝不因为权限库抖动拦掉正常业务 */
  }
}

/* ★ 2026-10-26：addedCodesOf / removedCodesOf 随「差异基线」判权一起下线。
 *   现在判权只看 grantedCodes（当前勾选），不再需要「相对基线的差异」。
 *   `diffOfOverride` 仍保留，用于诊断脚本对比「树 vs 基线」。 */

/**
 * ★★ 统一收口入口：**权限树权威**判权（2026-10-26 重写）。
 *
 * 【旧语义及它的问题】
 *   旧版只把「相对基线快照的改动」叠加到静态表上：
 *     新增授权 → 放行 / 显式撤销 → 拒绝 / 没动过 → 静态表
 *   基线是本功能启用那一刻的快照，所以「树里本来就勾着的动作」不算改动
 *   → 不会授权 → 掉回静态表。而静态表只登记了少数岗位
 *   （财务 FIN_ROLE_OPERATIONS 只有 FIN_STAFF / SYS_ADMIN），
 *   于是「校长 159 个动作全勾了，点财务核对依旧 403」。
 *
 * 【新语义】逐角色判定，任一角色放行即放行（与各模块原有 hasAnyRole 口径一致）：
 *
 *   for each role:
 *     · SYS_ADMIN                              → 直接放行（防止管理员把自己锁死）
 *     · 该职位在「码所属页面」上**没配过**     → 走模块静态判权 staticAllow(role)
 *     · 配过 且 勾了这个动作                   → 放行
 *     · 配过 但 没勾这个动作（如只勾了查看）   → 本角色不放行
 *
 *   一句话：管理员配过的页面，以权限树为准；没配过的，保持各模块原有默认。
 *   这样「页面管理 + 职位权限分配」给全了，登录后就能真的操作，
 *   而只给「查看」的职位只能看、写接口会 403。
 *
 * @param roleCodes    用户拥有的角色码（role_code，如 RM_PRINCIPAL）
 * @param actionCode   本次要判的操作码（如 finance:fee:verify）
 * @param staticAllow  模块自己的静态判权：该角色是否被允许（未配置时的兜底）
 */
export function resolveActionWithOverlay(
  roleCodes: string[] | undefined,
  actionCode: string,
  staticAllow: (roleCode: string) => boolean,
): boolean {
  const roles = Array.isArray(roleCodes) ? roleCodes : [];
  let allow = false;
  for (const role of roles) {
    if (ALWAYS_ALLOW_ROLES.has(role)) return true;

    const ov = cache ? cache.map.get(role) : null;
    if (!isConfigured(ov, actionCode)) {
      // 该职位没配过这个页面 → 各模块静态表说了算（存量账号零影响）
      if (staticAllow(role)) allow = true;
      continue;
    }
    // 配过 → 以权限树为准
    const granted = ov!.grantedCodes || (ov!.grantedCodes = grantedCodesOf(ov!));
    if (granted.has(actionCode)) return true;
  }
  return allow;
}

/* ============================================================
 * 8. ★ 前端按钮显隐用：取「权限树明确没给」的操作码
 *
 *   背景：job/edu 板块的按钮默认显隐由「角色」决定（各页面自己写死的
 *   角色白名单，如 `canInitiate = TEACH_HEAD`）。
 *   管理员在「职位权限分配」里**没勾**某个动作时，对应按钮要跟着消失，
 *   否则用户点了就吃 403 红字（这正是用户报障的现象）。
 *
 *   ★ 2026-10-26 语义对齐后端：不再只看「相对基线的撤销」，
 *     而是「该页面配过 && 这个动作没勾」→ 收。与 §7 的判权完全同源，
 *     避免「按钮在但接口 403」或「按钮没了但接口能通」。
 *
 *   ⚠️ 配过的页面里，**树上没登记的动作**不收（界面上勾不到，不能怪用户）。
 * ============================================================ */
export function getRemovedActionCodesForRoles(roleCodes: string[] | undefined): string[] {
  const roles = Array.isArray(roleCodes) ? roleCodes : [];
  const set = new Set<string>();

  for (const role of roles) {
    if (ALWAYS_ALLOW_ROLES.has(role)) continue;
    const ov = cache ? cache.map.get(role) : null;
    if (!ov || ov.touchedItems.size === 0) continue;

    const granted = ov.grantedCodes || (ov.grantedCodes = grantedCodesOf(ov));

    /**
     * ⚠️ 必须**按操作码**判定，不能按「动作」判定：
     *   一个码常常由同一页面的多个动作共同映射
     *   （如 `job:dorm:edit` ← 编辑房间 / 删除房间 / 分配床位 / 分派宿舍）。
     *   按动作逐个累加会把「只勾了其中两个」误判成「这个码没有」，
     *   于是按钮被隐藏、接口其实放行 —— 两边打架。
     *   正确口径：码所属页面配过 && 这个码不在 grantedCodes 里 → 才是真的没给。
     */
    for (const [code, owners] of CODE_OWNERS) {
      if (granted.has(code)) continue;
      if (!owners.some((k) => ov.touchedItems.has(k))) continue;
      set.add(code);
    }
  }
  return Array.from(set);
}
