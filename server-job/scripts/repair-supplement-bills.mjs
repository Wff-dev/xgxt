/**
 * 修复：已核对入账的「补费单」没有按分项拆到各栏
 *
 * 背景（2026-10-27 用户录屏反馈）
 *   咨询侧发起补费时只把「合计金额」推给财务，没传 item_detail，
 *   于是财务核对入账只记了 1 条「补学费」账单 → 整笔钱全落在
 *   「学费缴费记录」，住宿费/餐费/保险费三栏永远是 0。
 *
 *   代码已修（consult 侧补传 itemDetail、财务侧按分项拆账），
 *   这个脚本修**历史数据**：把已经核对过的补费单补上 item_detail 并重新拆账。
 *
 * 干什么
 *   1. finance 缴费单（fee_type=8 且已核对）如果 item_detail 为空，
 *      从咨询侧 t_consult_fee_order 回填（同一个 finance_fee_id 对应同一张单）；
 *   2. 该缴费单只有 1 条账单、且账单 fee_type=8（整笔当学费）时：
 *      · 第 1 条账单就地改成第一个分项（保留原账单号，不破坏对账）
 *      · 其余分项插入新账单（新号 ZDxxxx）
 *      · 每条按自己的费用项归组；住宿费/餐费/保险费按缴费完成日算到期日
 *      · 每条备注只写自己那一项（补费分项 i/n｜住宿费 ¥2700.00（6 个月））
 *
 * 用法
 *   node scripts/repair-supplement-bills.mjs            # 只体检，打印将要做什么
 *   node scripts/repair-supplement-bills.mjs --apply    # 真改
 */
import knex from 'knex';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const APPLY = process.argv.includes('--apply');

/* ---------- 读 .env ---------- */
const env = {};
const envPath = path.resolve(process.cwd(), '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const db = knex({
  client: 'mysql2',
  connection: {
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME_FINANCE || 'sms_finance',
  },
});

const FEE_TABLE = 't_finance_fee';
const BILL_TABLE = 't_finance_bill';
const STD_TABLE = 't_finance_fee_standard';
const CONSULT_ORDER = 'sms_consult.t_consult_fee_order';

const TYPE_NAME = {
  1: '学费',
  2: '住宿费',
  3: '餐费',
  4: '保险费',
  5: '试学费',
  6: '押金',
  7: '校服',
  8: '补学费',
};

const yuan = (cent) => (Number(cent || 0) / 100).toFixed(2);

function toDateStr(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function parseItems(raw) {
  if (!raw) return [];
  let arr = [];
  try {
    arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((i) => i && Number(i.feeType) > 0 && Number(i.amount) > 0)
    .map((i) => {
      const amount = Number(i.amount) || 0;
      const std = i.standardAmount != null ? Number(i.standardAmount) : amount;
      return {
        feeType: Number(i.feeType),
        feeTypeName: i.feeTypeName || TYPE_NAME[Number(i.feeType)] || '',
        amount,
        standardAmount: std,
        discount: i.discount != null ? Number(i.discount) : Math.max(0, std - amount),
        discountReason: i.discountReason || '',
        months: i.months != null ? Number(i.months) : null,
      };
    });
}

/** 与 src/finance/utils/orderNo.ts 同规则：ZD + 年 + 4 位，号一旦发出永久占位（含软删） */
async function nextBillNo() {
  const head = `ZD${new Date().getFullYear()}`;
  const row = await db(BILL_TABLE).where('bill_no', 'like', `${head}%`).orderBy('bill_no', 'desc').first('bill_no');
  let seq = 1;
  if (row && row.bill_no) {
    const n = parseInt(String(row.bill_no).slice(head.length), 10);
    if (!Number.isNaN(n)) seq = n + 1;
  }
  return { head, seq };
}

/**
 * 号段分配器
 *
 * ⚠️ 不能在 for 循环里反复调 nextBillNo()：事务里刚插入的账单还没提交，
 *    下一次查 max 还是老值 → 两条拿到同一个号 → `Duplicate entry ... uk_bill_no`。
 *    所以一次取到起始号，之后在内存里自增。
 */
async function allocBillNos(count) {
  const { head, seq } = await nextBillNo();
  return Array.from({ length: count }, (_, i) => `${head}${String(seq + i).padStart(4, '0')}`);
}

async function standardOf(feeType, deptCode) {
  const row = await db(STD_TABLE)
    .where({ fee_type: feeType, dept_code: deptCode ?? 1, is_deleted: false })
    .first();
  return Number(row?.amount) || 0;
}

/** 到期日：学费没有时间限制；住宿/餐费按月、保险按年，从缴费完成日（核对入账日）起算 */
async function expireOf(part, billDate, studentId, feeType, deptCode) {
  const unit = feeType === 2 || feeType === 3 ? 'M' : feeType === 4 ? 'Y' : null;
  if (!unit) return null;

  let months = 0;
  if (part.months && part.months > 0) {
    months = unit === 'Y' ? part.months * 12 : part.months;
  } else {
    const std = await standardOf(feeType, deptCode);
    if (std <= 0) return null;
    let units = Math.floor(part.amount / std);
    if (units < 1) units = 1;
    months = unit === 'Y' ? units * 12 : units;
  }

  // 续费接续：该生该费用已有到期日且晚于本次缴费日 → 从旧到期日往后延
  const prev = await db(BILL_TABLE)
    .where({ student_id: studentId, fee_type: feeType, is_deleted: false, bill_type: 1 })
    .whereNotNull('expire_date')
    .max('expire_date as d')
    .first();
  const prevDate = toDateStr(prev?.d);
  const base = prevDate && prevDate > billDate ? prevDate : billDate;
  return addMonths(base, months);
}

function partText(p, i, n) {
  return (
    `补费分项 ${i + 1}/${n}｜${TYPE_NAME[p.feeType] || p.feeTypeName} ¥${yuan(p.amount)}` +
    (p.months ? `（${p.months} 个月）` : '') +
    (p.discount > 0
      ? `（应缴 ¥${yuan(p.standardAmount)}，优惠 ¥${yuan(p.discount)}${p.discountReason ? `·${p.discountReason}` : ''}）`
      : '')
  );
}

const fees = await db(FEE_TABLE)
  .where({ fee_type: 8, is_verified: true, is_deleted: false })
  .select('*')
  .orderBy('create_time', 'asc');

console.log(`待检查的补费单：${fees.length} 张${APPLY ? '（--apply 真改）' : '（只体检）'}`);

let fixed = 0;
let skipped = 0;

for (const fee of fees) {
  let items = parseItems(fee.item_detail);
  let fromConsult = false;
  if (!items.length) {
    const order = await db(CONSULT_ORDER).where({ finance_fee_id: fee.id }).first('order_no', 'item_detail');
    items = parseItems(order?.item_detail);
    fromConsult = items.length > 0;
  }

  const bills = await db(BILL_TABLE)
    .where({ source_id: fee.id, bill_type: 1, is_deleted: false })
    .select('*')
    .orderBy('bill_no', 'asc');

  if (items.length <= 1) {
    console.log(`· ${fee.student_name} ${fee.voucher_no || fee.id.slice(0, 8)}：明细不足 2 项，跳过`);
    skipped++;
    continue;
  }

  const sum = items.reduce((s, i) => s + i.amount, 0);
  if (sum !== Number(fee.amount)) {
    console.log(
      `· ${fee.student_name}：明细合计 ¥${yuan(sum)} ≠ 单据金额 ¥${yuan(fee.amount)}，跳过（要人工核）`,
    );
    skipped++;
    continue;
  }

  /**
   * 应缴金额也要按分项汇总
   *
   * 老单子没传明细，财务按「第一项（补学费）的标准价」兜底 → 应缴 = 实缴 = 31400，
   * 明细里却是 学费 28000 + 住宿 2700 + 餐费 850 + 保险 150 = 31700，差 300 的优惠看不见。
   */
  const stdSum = items.reduce((s, i) => s + i.standardAmount, 0);
  const patch = {};
  if (!parseItems(fee.item_detail).length) {
    patch.item_detail = JSON.stringify(
      items.map((i) => ({
        feeType: i.feeType,
        feeTypeName: i.feeTypeName,
        amount: i.amount,
        standardAmount: i.standardAmount,
        discount: i.discount,
        ...(i.discountReason ? { discountReason: i.discountReason } : {}),
        ...(i.months ? { months: i.months } : {}),
      })),
    );
    console.log('   回填缴费单 item_detail（财务详情页也能看到 4 个分项）');
  }
  if (stdSum > 0 && Number(fee.standard_amount ?? 0) !== stdSum) {
    patch.standard_amount = stdSum;
    console.log(
      `   应缴 ${yuan(fee.standard_amount)} → ${yuan(stdSum)}（优惠 ${yuan(Math.max(0, stdSum - sum))}）`,
    );
  }
  if (APPLY && Object.keys(patch).length) {
    await db(FEE_TABLE).where({ id: fee.id }).update(patch);
  }

  if (bills.length !== 1) {
    console.log(`· ${fee.student_name}：已有 ${bills.length} 条账单（已拆过），只补明细/应缴`);
    skipped++;
    continue;
  }

  const bill = bills[0];
  const billDate = toDateStr(bill.bill_date) || toDateStr(fee.pay_date) || toDateStr(new Date());
  console.log(
    `→ ${fee.student_name} ${bill.bill_no}：1 条 ¥${yuan(bill.amount)}（${TYPE_NAME[bill.fee_type]}）` +
      ` 拆成 ${items.length} 条（明细来源：${fromConsult ? '咨询单回填' : '财务单已有'}）`,
  );

  // 预演要写的账单
  const plan = [];
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    const exp = await expireOf(p, billDate, fee.student_id, p.feeType, fee.dept_code);
    plan.push({ ...p, expireDate: exp, text: partText(p, i, items.length) });
    console.log(
      `      ${i + 1}. ${TYPE_NAME[p.feeType]} ¥${yuan(p.amount)}${exp ? `，到期 ${exp}` : '，无到期日'}`,
    );
  }

  if (!APPLY) continue;

  const extraNos = await allocBillNos(plan.length - 1);

  await db.transaction(async (trx) => {
    // ① 第 1 条账单就地改成第一个分项（保留原账单号）
    const first = plan[0];
    await trx(BILL_TABLE)
      .where({ id: bill.id })
      .update({
        fee_type: first.feeType,
        amount: first.amount,
        expire_date: first.expireDate,
        remark: `${first.text}${fee.voucher_url ? '' : ' · 无电子凭证（现金/线下收款）'}`,
      });

    // ② 其余分项插入新账单
    for (let i = 1; i < plan.length; i++) {
      const p = plan[i];
      const billNo = extraNos[i - 1];
      await trx(BILL_TABLE).insert({
        id: randomUUID(),
        create_time: bill.create_time ?? new Date(),
        create_by: bill.create_by ?? null,
        is_deleted: false,
        bill_no: billNo,
        bill_type: 1,
        source_id: fee.id,
        source_no: bill.source_no ?? null,
        student_id: fee.student_id,
        student_no: fee.student_no,
        student_name: fee.student_name,
        class_id: fee.class_id ?? null,
        class_name: fee.class_name ?? null,
        dept_code: fee.dept_code ?? null,
        head_teacher_name: fee.head_teacher_name ?? null,
        fee_type: p.feeType,
        amount: p.amount,
        bill_date: billDate,
        expire_date: p.expireDate,
        operator_id: bill.operator_id ?? null,
        operator_name: bill.operator_name ?? null,
        voucher_no: bill.voucher_no ?? null,
        pay_method: null,
        remark: `${p.text}${fee.voucher_url ? '' : ' · 无电子凭证（现金/线下收款）'}`,
      });
      console.log(`      插入 ${billNo}（${TYPE_NAME[p.feeType]} ¥${yuan(p.amount)}）`);
    }
  });

  fixed++;
}

console.log(`\n完成：修复 ${fixed} 张，跳过 ${skipped} 张${APPLY ? '' : '（未改动任何数据，加 --apply 才写库）'}`);
await db.destroy();
process.exit(0);
