/**
 * 迁移：把咨询库（sms_consult）缺的 5 个列补齐 —— 跨库执行，必须写库名前缀
 *
 * 【为什么需要这条】
 *   `20261022_001_add_consult_education_finance_verified.js` 本来要加这些列，
 *   但它跑在 **sms_job** 连接上、又没写库名前缀：
 *   `hasTable('t_consult_student')` 在 sms_job 里恒为 false →
 *   迁移「执行成功」却一列都没加（静默 no-op）。
 *   于是 `npm run db:schema-diff` 一直报：
 *     t_consult_fee_order 缺 finance_verified_by / finance_verified_time / discount_reason
 *     t_consult_student   缺 education / parent_relation
 *
 * 【为什么用原生 SQL 而不是 knex.schema】
 *   knex 的 `withSchema('sms_consult').hasColumn()` 在 MySQL 下仍会生成
 *   `show columns from `t_consult_student``（不带库名）→ 直接报
 *   「Table 'sms_job.t_consult_student' doesn't exist」。
 *   所以这里：列是否存在用 information_schema 查，改表用带库名的 ALTER。
 *
 * 【列定义来源】照抄 `sql/init/sms_consult.sql`，COMMENT 一字不改，方便对账。
 * 老机器：本迁移补齐；新机器：init SQL 建表时已有这些列，本迁移自动跳过。
 */

const CONSULT = 'sms_consult';

const COLUMNS = [
  {
    table: 't_consult_student',
    column: 'education',
    add: "`education` varchar(20) DEFAULT NULL COMMENT '学历（★ 2026-10-22 新建学生时可录入）'",
  },
  {
    table: 't_consult_student',
    column: 'parent_relation',
    add: "`parent_relation` tinyint(4) DEFAULT NULL COMMENT '家长关系 1父亲 2母亲（2026-10-26 新增）'",
  },
  {
    table: 't_consult_fee_order',
    column: 'finance_verified_by',
    add: "`finance_verified_by` varchar(50) DEFAULT NULL COMMENT '财务核对人姓名（★ 2026-10-22 从财务侧同步）'",
  },
  {
    table: 't_consult_fee_order',
    column: 'finance_verified_time',
    add: "`finance_verified_time` datetime DEFAULT NULL COMMENT '财务核对时间（★ 2026-10-22 从财务侧同步）'",
  },
  {
    table: 't_consult_fee_order',
    column: 'discount_reason',
    add: "`discount_reason` varchar(50) DEFAULT NULL COMMENT '★ 2026-10-26 优惠名目（奖学金/活动优惠/困难减免…），无优惠为 NULL'",
  },
];

async function hasColumn(knex, table, column) {
  const [rows] = await knex.raw(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [CONSULT, table, column],
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function hasTable(knex, table) {
  const [rows] = await knex.raw(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1',
    [CONSULT, table],
  );
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  for (const item of COLUMNS) {
    if (!(await hasTable(knex, item.table))) continue;
    if (await hasColumn(knex, item.table, item.column)) continue;
    await knex.raw(`ALTER TABLE \`${CONSULT}\`.\`${item.table}\` ADD COLUMN ${item.add}`);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function down(knex) {
  for (const item of [...COLUMNS].reverse()) {
    if (!(await hasTable(knex, item.table))) continue;
    if (!(await hasColumn(knex, item.table, item.column))) continue;
    await knex.raw(`ALTER TABLE \`${CONSULT}\`.\`${item.table}\` DROP COLUMN \`${item.column}\``);
  }
};
