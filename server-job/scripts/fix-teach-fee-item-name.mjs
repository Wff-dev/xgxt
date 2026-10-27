/**
 * 教学管理「催费」→「缴费」权限库改名（npm run fix:fee-name）
 *
 * ============================================================
 * 【为什么需要这个脚本】
 *   2026-10-26 把教学域的「催费」模块改名为「缴费」时，只改了代码：
 *     · web-job/src/teaching/domainConfig.ts  → 侧栏标题
 *     · server-job/src/perm/config/pageRegistry.ts → 页面管理 / 权限树页面名
 *   但权限数据还在老库里：
 *     · sms_perm.t_perm_menu            item_name = '催费'
 *     · sms_perm.t_perm_role_perm       item_name = '催费'（各职位已授权动作）
 *     · sms_perm.t_perm_role_perm_baseline id / item_name 里都带 '催费'
 *
 *   而「角色默认能看哪些页面」是拿**权限库功能点名**去匹配
 *   `PERM_TREE` 的页面名（rolePageDefaults.deriveDefaultPathsFor）：
 *     页面名「缴费」≠ 库里的「催费」→ 该页面默认不可见
 *     → /api/perm/page/my-paths 不返回 /teaching/fee
 *     → 非管理员账号的侧栏里「缴费」整块消失（管理员有全量兜底，所以看不出来）。
 *
 *   所以改名必须**改代码 + 改权限数据**两件事一起做。本脚本负责后者。
 *
 * 【为什么不用 seed-perm-tree.ts】
 *   那个脚本会重建整棵权限树并重写所有职位的授权/基线，会把管理员
 *   在「职位权限分配」「页面管理」里手工勾过的差异全部抹掉。
 *   这里只做一次定向 UPDATE，保留全部人工授权。
 *
 * 【幂等】
 *   重复执行不会产生重复行：没有「催费」时直接报「已是最新」并退出 0。
 *   若目标「缴费」已被别的活动功能点占用，则中止并返回非 0（不猜、不合并）。
 *
 * 用法：
 *   cd server-job && npm run fix:fee-name
 *   cd server-job && node scripts/fix-teach-fee-item-name.mjs --dry-run
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const mysql = require(path.join(ROOT, 'node_modules', 'mysql2', 'promise.js'));

const DB = process.env.DB_NAME_PERM || 'sms_perm';
const MODULE_KEY = 'teach';
const OLD_NAME = '催费';
const NEW_NAME = '缴费';
const FEE_MENU_ID = 'MN2_teach_08';
const FEE_PAGE_PATH = '/teaching/fee';
const DRY_RUN = process.argv.includes('--dry-run');

/** Windows 传统 cmd 不认 ANSI，走纯文本，避免把一键启动日志刷成乱码 */
const USE_COLOR =
  !process.env.NO_COLOR &&
  !!process.stdout.isTTY &&
  (process.platform !== 'win32' || !!process.env.WT_SESSION || !!process.env.TERM_PROGRAM);
const paint = (code) => (s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = { ok: paint(32), bad: paint(31), dim: paint(2) };

/** 统计各表里还叫「催费」的行数 */
async function countOld(conn) {
  const q = async (sql, params = []) => {
    const [[r]] = await conn.query(sql, params);
    return Number(r.n);
  };
  return {
    menu: await q(
      `SELECT COUNT(*) AS n FROM \`${DB}\`.t_perm_menu
        WHERE module_key = ? AND item_name = ? AND is_deleted = 0`,
      [MODULE_KEY, OLD_NAME],
    ),
    menuChild: await q(
      `SELECT COUNT(*) AS n FROM \`${DB}\`.t_perm_menu
        WHERE module_key = ? AND parent_item_name = ? AND is_deleted = 0`,
      [MODULE_KEY, OLD_NAME],
    ),
    rolePerm: await q(
      `SELECT COUNT(*) AS n FROM \`${DB}\`.t_perm_role_perm
        WHERE module_key = ? AND item_name = ? AND is_deleted = 0`,
      [MODULE_KEY, OLD_NAME],
    ),
    baseline: await q(
      `SELECT COUNT(*) AS n FROM \`${DB}\`.t_perm_role_perm_baseline
        WHERE module_key = ? AND item_name = ?`,
      [MODULE_KEY, OLD_NAME],
    ),
  };
}

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4',
  });

  try {
    /* ---------- 0. 表不存在 → 权限库尚未初始化，跳过（不是错误） ---------- */
    const [[exists]] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = ? AND table_name = 't_perm_menu'`,
      [DB],
    );
    if (!Number(exists.n)) {
      console.log(C.dim(`  — ${DB}.t_perm_menu 不存在，跳过（权限库未初始化时属正常）`));
      return;
    }

    const before = await countOld(conn);

    /* ---------- 1. 冲突检查：目标名不能被别的活动功能点占着 ---------- */
    const [targets] = await conn.query(
      `SELECT id, item_name FROM \`${DB}\`.t_perm_menu
        WHERE module_key = ? AND item_name = ? AND is_deleted = 0`,
      [MODULE_KEY, NEW_NAME],
    );
    const foreignTarget = targets.find((r) => r.id !== FEE_MENU_ID);
    if (foreignTarget) {
      console.error(
        C.bad(
          `  ✗ 「${MODULE_KEY}」下已有活动功能点「${NEW_NAME}」（id=${foreignTarget.id}），` +
            `与待改名的 ${FEE_MENU_ID} 冲突。为避免合并错权限，本脚本中止；请先人工确认。`,
        ),
      );
      process.exitCode = 1;
      return;
    }

    /* ---------- 2. 基线主键冲突检查（id 里带功能点名） ---------- */
    const [oldBase] = await conn.query(
      `SELECT id FROM \`${DB}\`.t_perm_role_perm_baseline
        WHERE module_key = ? AND (item_name = ? OR id LIKE ?)`,
      [MODULE_KEY, OLD_NAME, `%|${MODULE_KEY}|${OLD_NAME}|%`],
    );
    const [allBase] = await conn.query(
      `SELECT id FROM \`${DB}\`.t_perm_role_perm_baseline`,
    );
    const existingIds = new Set(allBase.map((r) => r.id));
    const nextId = (id) => id.split(`|${MODULE_KEY}|${OLD_NAME}|`).join(`|${MODULE_KEY}|${NEW_NAME}|`);
    const collision = oldBase.map((r) => nextId(r.id)).find((id) => existingIds.has(id));
    if (collision) {
      console.error(
        C.bad(`  ✗ 基线主键改名后会与已有行冲突：${collision}。本脚本中止，请先人工确认。`),
      );
      process.exitCode = 1;
      return;
    }

    /* ---------- 3. 没事可做 → 幂等退出 ---------- */
    if (!before.menu && !before.menuChild && !before.rolePerm && !before.baseline) {
      const [[page]] = await conn.query(
        `SELECT page_title FROM \`${DB}\`.t_perm_page
          WHERE module_key = ? AND page_path = ? AND is_deleted = 0 LIMIT 1`,
        [MODULE_KEY, FEE_PAGE_PATH],
      );
      if (page && page.page_title !== NEW_NAME) {
        if (!DRY_RUN) {
          await conn.query(
            `UPDATE \`${DB}\`.t_perm_page SET page_title = ?, update_time = NOW(), update_by = 'fix-fee-name'
              WHERE module_key = ? AND page_path = ? AND is_deleted = 0`,
            [NEW_NAME, MODULE_KEY, FEE_PAGE_PATH],
          );
        }
        console.log(C.ok(`  ✓ 权限数据已改名；页面台账标题已补正为「${NEW_NAME}」`));
      } else {
        console.log(C.dim(`  ✓ 权限数据已是最新（无「${OLD_NAME}」残留），无需处理`));
      }
      return;
    }

    console.log(
      DRY_RUN
        ? C.dim(`  · 预演（--dry-run，不写库）：待改名 ${JSON.stringify(before)}`)
        : `  待改名：menu=${before.menu} childRef=${before.menuChild} rolePerm=${before.rolePerm} baseline=${before.baseline}`,
    );
    if (DRY_RUN) return;

    /* ---------- 4. 事务内定向改名 ---------- */
    await conn.beginTransaction();
    try {
      // 4.1 功能点本身（只动活动行；历史逻辑删除行保持原样，便于追溯）
      if (before.menu) {
        await conn.query(
          `UPDATE \`${DB}\`.t_perm_menu
              SET item_name = ?, update_time = NOW(), update_by = 'fix-fee-name'
            WHERE module_key = ? AND item_name = ? AND is_deleted = 0`,
          [NEW_NAME, MODULE_KEY, OLD_NAME],
        );
      }

      // 4.2 自建子功能点若把老名字当父节点，一并改
      if (before.menuChild) {
        await conn.query(
          `UPDATE \`${DB}\`.t_perm_menu
              SET parent_item_name = ?, update_time = NOW(), update_by = 'fix-fee-name'
            WHERE module_key = ? AND parent_item_name = ? AND is_deleted = 0`,
          [NEW_NAME, MODULE_KEY, OLD_NAME],
        );
      }

      // 4.3 各职位已授予的动作行（改名不丢授权）
      if (before.rolePerm) {
        await conn.query(
          `UPDATE \`${DB}\`.t_perm_role_perm
              SET item_name = ?, update_time = NOW(), update_by = 'fix-fee-name'
            WHERE module_key = ? AND item_name = ? AND is_deleted = 0`,
          [NEW_NAME, MODULE_KEY, OLD_NAME],
        );
      }

      // 4.4 按钮级基线（差异存储的「原值」）
      if (before.baseline) {
        await conn.query(
          `UPDATE \`${DB}\`.t_perm_role_perm_baseline
              SET item_name = ?
            WHERE module_key = ? AND item_name = ?`,
          [NEW_NAME, MODULE_KEY, OLD_NAME],
        );
        await conn.query(
          `UPDATE \`${DB}\`.t_perm_role_perm_baseline
              SET id = REPLACE(id, ?, ?)
            WHERE module_key = ? AND id LIKE ?`,
          [
            `|${MODULE_KEY}|${OLD_NAME}|`,
            `|${MODULE_KEY}|${NEW_NAME}|`,
            MODULE_KEY,
            `%|${MODULE_KEY}|${OLD_NAME}|%`,
          ],
        );
      }

      // 4.5 页面台账标题（page.service.syncRegistry 通常已补，这里兜底）
      await conn.query(
        `UPDATE \`${DB}\`.t_perm_page
            SET page_title = ?, update_time = NOW(), update_by = 'fix-fee-name'
          WHERE module_key = ? AND page_path = ? AND is_deleted = 0`,
        [NEW_NAME, MODULE_KEY, FEE_PAGE_PATH],
      );

      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    }

    const after = await countOld(conn);
    console.log(
      C.ok(
        `  ✓ 「${OLD_NAME}」→「${NEW_NAME}」完成：menu=${before.menu}→${after.menu} ` +
          `rolePerm=${before.rolePerm}→${after.rolePerm} ` +
          `baseline=${before.baseline}→${after.baseline}`,
      ),
    );

    /* ---------- 5. 结果校验 ---------- */
    const problems = [];
    if (after.menu) problems.push(`t_perm_menu 仍有 ${after.menu} 行`);
    if (after.menuChild) problems.push(`t_perm_menu.parent_item_name 仍有 ${after.menuChild} 行`);
    if (after.rolePerm) problems.push(`t_perm_role_perm 仍有 ${after.rolePerm} 行`);
    if (after.baseline) problems.push(`t_perm_role_perm_baseline 仍有 ${after.baseline} 行`);
    if (problems.length) {
      throw new Error(`改名后仍有残留：${problems.join('；')}`);
    }

    /*
     * 缓存与登录态提示：
     *   后端 rolePageDefaults / roleModuleItems 有 15s 缓存，前端 my-paths 也在登录时拉取。
     *   已经登录的账号需要点「刷新权限」或重新登录，侧栏才会重新计算。
     */
    console.log(
      C.dim('  · 已登录账号请点顶栏「刷新权限」或重新登录，侧栏才会按新页面名重算。'),
    );
  } finally {
    await conn.end().catch(() => {});
  }
})().catch((e) => {
  console.error(C.bad('\n  ✗ 教学缴费权限改名失败：' + (e.message || e) + '\n'));
  process.exitCode = 1;
});
