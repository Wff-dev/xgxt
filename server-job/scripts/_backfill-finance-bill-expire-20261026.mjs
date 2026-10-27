/**
 * 数据补齐 · 账单到期日（2026-10-26）
 * ============================================================
 *
 * 【为什么要补】
 *   `t_finance_bill.expire_date` 是 2026-10-26 才加的列。存量 62 张账单
 *   （学费 31 / 住宿费 30 / 餐费 1）全是加列之前入账的 → 该列全为 NULL，导致：
 *     · 「账单明细」里餐费/住宿费不再显示「到期 xx」；
 *     · 「费用标准 → 催费设置」的催费名单永远 0 条（判定依据就是这个字段）；
 *     · 「缴费管理」的到期日有值（读的是缴费单），两处对不上。
 *
 * 【补的值从哪来 —— 不是瞎算】
 *   账单 `source_id` 指向它入账时的那张缴费单（`t_finance_fee`），
 *   缴费单上已经有当时算好的 `expire_date`（31 张住宿 + 31 张餐费，
 *   分别在 2027-01-04 / 2027-03-05）。直接把缴费单的到期日搬过来，
 *   等于补回本来就没记的那一列，不改任何业务判断。
 *
 *   只补 fee_type ∈ {住宿费(2), 餐费(3), 保险费(4)} —— 学费/押金/校服/试学费
 *   没有到期概念，保持 NULL（与 calcExpireDate 口径一致）。
 *
 * 【幂等】只更新 expire_date IS NULL 的行，重复跑无副作用。
 *
 * 【用法】
 *   node scripts/_backfill-finance-bill-expire-20261026.mjs            # 预演
 *   node scripts/_backfill-finance-bill-expire-20261026.mjs --apply    # 执行
 */

import 'dotenv/config';
import knex from 'knex';

const APPLY = process.argv.includes('--apply');
const FIN = process.env.DB_NAME_FINANCE || 'sms_finance';

const db = knex({
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: FIN,
    dateStrings: true,
  },
  pool: { min: 0, max: 5 },
});

const TYPE_NAME = { 2: '住宿费', 3: '餐费', 4: '保险费' };

async function main() {
  console.log(`模式：${APPLY ? '★ 写库(--apply)' : '预览（加 --apply 才写库）'}`);

  const rows = await db('t_finance_bill as b')
    .join('t_finance_fee as f', 'f.id', 'b.source_id')
    .where('b.bill_type', 1)
    .where('b.is_deleted', false)
    .whereNull('b.expire_date')
    .whereNotNull('f.expire_date')
    .whereIn('b.fee_type', [2, 3, 4])
    .select(
      'b.id as billId',
      'b.bill_no as billNo',
      'b.fee_type as feeType',
      'b.student_name as studentName',
      'b.amount as amount',
      'f.expire_date as expireDate',
    );

  const total = await db('t_finance_bill')
    .where({ bill_type: 1, is_deleted: false })
    .whereIn('fee_type', [2, 3, 4])
    .count('* as n');
  console.log(`参与催费的账单 ${Number(total[0].n)} 张，其中到期日为空且能对上缴费单的 ${rows.length} 张`);

  const byType = {};
  for (const r of rows) byType[r.feeType] = (byType[r.feeType] || 0) + 1;
  Object.entries(byType).forEach(([t, n]) => console.log(`  ${TYPE_NAME[t] || t}: ${n} 张`));
  rows.slice(0, 5).forEach((r) =>
    console.log(`  示例 ${r.billNo} ${r.studentName} ${TYPE_NAME[r.feeType]} → 到期 ${String(r.expireDate).slice(0, 10)}`),
  );

  const left = await db('t_finance_bill as b')
    .leftJoin('t_finance_fee as f', 'f.id', 'b.source_id')
    .where('b.bill_type', 1)
    .where('b.is_deleted', false)
    .whereNull('b.expire_date')
    .whereIn('b.fee_type', [2, 3, 4])
    .where((q) => q.whereNull('f.expire_date').orWhereNull('f.id'))
    .count('* as n');
  console.log(`补完后仍无到期日（缴费单也没有 / 关联不上）：${Number(left[0].n)} 张`);

  if (!APPLY) {
    console.log('\n（预览模式，未写库）');
    await db.destroy();
    return;
  }

  let done = 0;
  for (const r of rows) {
    done += await db('t_finance_bill')
      .where({ id: r.billId })
      .whereNull('expire_date')
      .update({ expire_date: String(r.expireDate).slice(0, 10), update_time: new Date(), update_by: 'backfill-expire' });
  }
  console.log(`\n★ 已写库：更新 ${done} 张账单的到期日`);
  await db.destroy();
}

main().catch(async (e) => {
  console.error(e);
  await db.destroy().catch(() => {});
  process.exit(1);
});
