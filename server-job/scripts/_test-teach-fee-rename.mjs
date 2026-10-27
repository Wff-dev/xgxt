/**
 * 回归守卫：教学域「催费」→「缴费」改名必须【代码 + 权限数据 + 初始 SQL】三件套同步
 * ============================================================================
 *
 * 背景（2026-10-26）：
 *   用户反馈「我那么大一个催费模块那」——侧栏里「缴费」整块消失。
 *   根因不是前端菜单配置，而是只改了代码里的页面名，没改权限库：
 *     · pageRegistry 页面名 = '缴费'
 *     · sms_perm.t_perm_menu.item_name 还是 '催费'
 *   而「角色默认可见页面」= 用权限库功能点名去匹配 PERM_TREE 页面名
 *   （utils/rolePageDefaults.deriveDefaultPathsFor），名字对不上 →
 *   /api/perm/page/my-paths 不返回 /teaching/fee → 非管理员侧栏少一项。
 *
 * 【本脚本钉住什么】
 *   ① 代码侧：pageRegistry / domainConfig / 侧栏红点 都叫「缴费」；
 *   ② 初始 SQL：新库导入后 t_perm_menu / t_perm_role_perm /
 *      t_perm_role_perm_baseline / t_perm_page 里不能还是「催费」；
 *   ③ 存量库（能连上才查）：四张权限表里不能有活动「催费」残留，
 *      且 MN2_teach_08 必须叫「缴费」、页面台账标题也必须是「缴费」；
 *   ④ 修复脚本：必须同时覆盖上面四张表，避免以后只改一半。
 *
 * 跑法：cd server-job && node scripts/_test-teach-fee-rename.mjs
 *       （数据库连不上时第 ③ 段自动跳过，不影响静态守卫）
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..');
const P = (rel) => path.join(REPO, rel);
const read = (p) => readFileSync(p, 'utf8');

let pass = 0;
let fail = 0;
const lines = [];
const check = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    lines.push(`  ✅ ${label}${extra ? '  —— ' + extra : ''}`);
  } else {
    fail++;
    lines.push(`  ❌ ${label}${extra ? '  —— ' + extra : ''}`);
  }
};

const OLD = '催费';
const NEW = '缴费';

/* ============================================================
 * ① 代码侧：页面注册表 / 教学域配置 / 侧栏红点
 * ============================================================ */
const REG = read(P('server-job/src/perm/config/pageRegistry.ts'));
const DOMAIN = read(P('web-job/src/teaching/domainConfig.ts'));
const APP = read(P('web-job/src/App.vue'));

const feePage = REG.slice(REG.indexOf("path: '/teaching/fee'") - 600, REG.indexOf("path: '/teaching/fee'") + 300);
check('★ pageRegistry：/teaching/fee 页面标题 = 缴费', feePage.includes(`title: '${NEW}'`));
check('★ pageRegistry：/teaching/fee 不再出现标题「催费」', !feePage.includes(`title: '${OLD}'`));

const feeDomain = DOMAIN.slice(DOMAIN.indexOf("key: 'fee'"), DOMAIN.indexOf("key: 'refund'"));
check('★ domainConfig：教学域 fee 菜单标题 = 缴费', feeDomain.includes(`title: '${NEW}'`));
check('★ App.vue：侧栏红点按「缴费」匹配', APP.includes(`child.title === '${NEW}'`));

/* ============================================================
 * ② 初始 SQL：新库导入后必须是新名字
 * ============================================================ */
const SQL = read(P('server-job/sql/init/sms_perm.sql'));
const sqlIssue = [];
if (SQL.includes(`'teach','${OLD}'`)) sqlIssue.push(`t_perm_role_perm/baseline 仍有 'teach','催费'`);
if (SQL.includes(`|teach|${OLD}|`)) sqlIssue.push('基线主键仍有 |teach|催费|');
if (SQL.includes(`,'teach','教学管理','🎓',5,'${OLD}',NULL,8,'/teaching/fee`)) sqlIssue.push('t_perm_menu 主行仍叫催费');
if (SQL.includes(`,'fee','${OLD}','/teaching/fee'`)) sqlIssue.push('t_perm_page 页面标题仍叫催费');
check('★ 初始 SQL：权限库四张表已统一为「缴费」', sqlIssue.length === 0, sqlIssue.join('；') || '无催费残留');
check(
  '★ 初始 SQL：MN2_teach_08 活动主行叫「缴费」',
  SQL.includes(`'MN2_teach_08','2026-10-22 16:12:05','perm-tree-v2',NULL,NULL,0,'teach','教学管理','🎓',5,'${NEW}',NULL,8,'/teaching/fee`),
);

/* ============================================================
 * ③ 修复脚本：四张表一个都不能漏（否则改名只成功一半）
 * ============================================================ */
const FIX = read(P('server-job/scripts/fix-teach-fee-item-name.mjs'));
check(
  '★ 修复脚本：覆盖 menu / role_perm / baseline / page 四张表',
  ['t_perm_menu', 't_perm_role_perm', 't_perm_role_perm_baseline', 't_perm_page'].every((t) => FIX.includes(t)),
);
check(
  '★ 修复脚本：基线主键跟着改名（|teach|催费| → |teach|缴费|）',
  FIX.includes('REPLACE(id') && FIX.includes('|${MODULE_KEY}|${OLD_NAME}|') && FIX.includes('|${MODULE_KEY}|${NEW_NAME}|'),
);

/* ============================================================
 * ④ 存量库：四张表不能有活动「催费」残留（连不上就跳过）
 * ============================================================ */
const mysql = require(path.join(ROOT, 'node_modules', 'mysql2', 'promise.js'));
const DB = process.env.DB_NAME_PERM || 'sms_perm';

const conn = await mysql
  .createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
    charset: 'utf8mb4',
    connectTimeout: 3000,
  })
  .catch(() => null);

if (!conn) {
  lines.push('  ⏭️  数据库连不上，跳过存量库检查（静态守卫已覆盖代码与初始 SQL）');
} else {
  try {
    const q = async (sql, params = []) => {
      const [[r]] = await conn.query(sql, params);
      return Number(r.n);
    };
    const staleMenu = await q(
      `SELECT COUNT(*) AS n FROM t_perm_menu WHERE module_key='teach' AND item_name=? AND is_deleted=0`,
      [OLD],
    );
    const staleRolePerm = await q(
      `SELECT COUNT(*) AS n FROM t_perm_role_perm WHERE module_key='teach' AND item_name=? AND is_deleted=0`,
      [OLD],
    );
    const staleBase = await q(
      `SELECT COUNT(*) AS n FROM t_perm_role_perm_baseline WHERE module_key='teach' AND item_name=?`,
      [OLD],
    );
    const staleBaseId = await q(
      `SELECT COUNT(*) AS n FROM t_perm_role_perm_baseline WHERE id LIKE ?`,
      [`%|teach|${OLD}|%`],
    );
    check(
      '★ 存量库：t_perm_menu / role_perm / baseline 无活动「催费」残留',
      staleMenu + staleRolePerm + staleBase + staleBaseId === 0,
      `menu=${staleMenu} rolePerm=${staleRolePerm} baseline=${staleBase} baseId=${staleBaseId}`,
    );

    const [[menu]] = await conn.query(
      `SELECT item_name FROM t_perm_menu WHERE id='MN2_teach_08' AND is_deleted=0`,
    );
    check('★ 存量库：MN2_teach_08 活动主行 = 缴费', menu?.item_name === NEW, menu?.item_name || '未找到');

    const [[page]] = await conn.query(
      `SELECT page_title FROM t_perm_page WHERE module_key='teach' AND page_path='/teaching/fee' AND is_deleted=0 LIMIT 1`,
    );
    check('★ 存量库：t_perm_page /teaching/fee 标题 = 缴费', page?.page_title === NEW, page?.page_title || '未找到');

    // 至少一个非管理员职位仍有该页授权；否则改名成功但用户依旧看不到
    const granted = await q(
      `SELECT COUNT(DISTINCT role_id) AS n FROM t_perm_role_perm
        WHERE module_key='teach' AND item_name=? AND is_deleted=0`,
      [NEW],
    );
    check('★ 存量库：已有职位在「缴费」下保留授权（改名不丢授权）', granted > 0, `${granted} 个职位`);
  } finally {
    await conn.end().catch(() => {});
  }
}

/* ============================================================
 * 汇总
 * ============================================================ */
console.log(lines.join('\n'));
console.log(`\n${fail === 0 ? '✓' : '✗'} 教学缴费改名回归：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
