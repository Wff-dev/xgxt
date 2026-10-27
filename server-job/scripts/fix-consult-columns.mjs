/**
 * 给咨询库 sms_consult 补「转介绍招生老师」两列（npm run fix:consult）
 *
 * 为什么单独一个脚本、而不是 knex 迁移：
 *   sms_consult.knex_migrations 里记着 8 条 2026-10-02 的一次性迁移，
 *   文件早就删了；一旦给 sms_consult 单开迁移目录，knex 会直接判
 *   「migration directory is corrupt, the following files are missing: …」
 *   所以这个库一直靠脚本补结构，本脚本沿用同一套做法。
 *
 * 幂等：表不存在就跳过，列已存在就跳过，可重复执行。
 *
 * 用法：cd server-job && npm run fix:consult
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const mysql = require(path.join(ROOT, 'node_modules', 'mysql2', 'promise.js'));

const DB = process.env.DB_NAME_CONSULT || 'sms_consult';

/**
 * 需要补列的表 + 列定义（幂等：列已存在就跳过）
 *
 * ★ 2026-10-26 从「只补 t_consult_student」扩成多表，
 *    发起收费那边加了优惠名目（t_consult_fee_order.discount_reason），
 *    以后再有别的表要补列，往这里加一段就行，别再开新脚本。
 */
const TABLES = {
  t_consult_student: [
    ['referrer_name', "varchar(50) DEFAULT NULL COMMENT '招生老师姓名（来源=市场来源时填）'"],
    ['referrer_phone', "varchar(20) DEFAULT NULL COMMENT '招生老师电话（来源=市场来源时随人带出）'"],
    /**
     * ★ 2026-10-26 用户口径：「家长联系人选一下性别，父亲还是母亲」
     *   1 = 父亲，2 = 母亲；家长联系人姓名仍放 parent_contact。
     */
    ['parent_relation', "tinyint(4) DEFAULT NULL COMMENT '家长关系 1父亲 2母亲'"],
    /**
     * ★ 2026-10-26 补：`education`（学历）—— 代码 student.route/service 已在读写，
     *   但本机库缺这一列 → 新建/编辑学生会报 Unknown column。
     *   建库 SQL（sql/init/sms_consult.sql:437）里本来就有，属于「老库没跟上」。
     */
    ['education', "varchar(20) DEFAULT NULL COMMENT '学历（★ 2026-10-22 新建学生时可录入）'"],
  ],
  t_consult_fee_order: [
    /**
     * ★ 2026-10-26 用户口径：「优惠金额要有明确的名目，优惠只能优惠学费」
     *   有优惠（实缴 < 应缴）时必填，取值见 shared-types 的 DISCOUNT_REASONS。
     */
    ['discount_reason', "varchar(50) DEFAULT NULL COMMENT '优惠名目（活动优惠/团报优惠/困难减免…），无优惠为 NULL'"],
    /**
     * ★ 2026-10-26 补：财务核对回写咨询收款单的两个字段。
     *   consult/services/fee-order.service.ts 已在读（详情展示「核对人/核对时间」、
     *   核销前的 orWhereNull('finance_verified_by') 判断），库缺列会直接报 Unknown column。
     */
    ['finance_verified_by', "varchar(50) DEFAULT NULL COMMENT '财务核对人姓名（★ 2026-10-22 从财务侧同步）'"],
    ['finance_verified_time', "datetime DEFAULT NULL COMMENT '财务核对时间（★ 2026-10-22 从财务侧同步）'"],
  ],
  t_consult_refund: [
    /**
     * ★ 2026-10-26 用户报障：「财务驳回之后没办法二次发起退费」
     *
     * 驳回要退回「发起之前的状态」，不能一律退回试学中（待分班的人会被凭空分班）。
     * 发起时把当时的 consult_state 记在这里，驳回时按它回滚。
     * 老单为 NULL → 代码按「有没有 class_id」推断（已分班=试学中，未分班=待分班）。
     */
    ['origin_state', "tinyint(4) DEFAULT NULL COMMENT '发起退费时的学生状态（驳回时回滚依据）'"],
  ],
};

/** 控制台颜色：Windows 传统 cmd 不认 ANSI，会显示成 ←[32m 乱码 → 那时走纯文本 */
const USE_COLOR =
  !process.env.NO_COLOR &&
  !!process.stdout.isTTY &&
  (process.platform !== 'win32' || !!process.env.WT_SESSION || !!process.env.TERM_PROGRAM);
const paint = (code) => (s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const C = {
  ok: paint(32),
  dim: paint(2),
  bad: paint(31),
};

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4',
  });
  try {
    for (const [TABLE, COLUMNS] of Object.entries(TABLES)) {
      const [[t]] = await conn.query(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
        [DB, TABLE],
      );
      if (!Number(t.n)) {
        console.log(C.dim(`  — ${DB}.${TABLE} 不存在，跳过（咨询库没导入时属正常）`));
        continue;
      }

      const [cols] = await conn.query(
        'SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
        [DB, TABLE],
      );
      const have = new Set(cols.map((r) => r.c));

      let added = 0;
      for (const [name, ddl] of COLUMNS) {
        if (have.has(name)) continue;
        await conn.query(`ALTER TABLE \`${DB}\`.\`${TABLE}\` ADD COLUMN \`${name}\` ${ddl}`);
        added++;
      }
      console.log(
        added ? C.ok(`  ✓ ${DB}.${TABLE} 补了 ${added} 列`) : C.dim(`  ✓ ${DB}.${TABLE} 列已齐全`),
      );
    }
  } finally {
    await conn.end().catch(() => {});
  }
})().catch((e) => {
  console.error(C.bad(`  ✗ 咨询库补列失败：${e.message}`));
  process.exitCode = 1;
});
