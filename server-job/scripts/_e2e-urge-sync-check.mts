/**
 * 自检：财务核对回写催费 —— **必须就地改状态，不许新增一行**
 * ============================================================
 * 【用户口径（2026-10-23）】
 *   「催费模块，核对完成后催费模块列表中状态改为已核对。
 *     之前看到财务核对一个人的数据后，回写催费**新生成一条**已核对数据，
 *     这样没必要，只要改状态就行。」
 *
 * 【复现的样子】
 *   教学侧催费台账里本来就有「某学生 + 某费用项」一行（演示数据 / 班主任登记），
 *   财务同步过来时按 `source_system + source_id` 匹配不上 → 插成第二行
 *   → 催费页同一个学生的学费出现两条：老的一条「已缴」+ 新的一条「已核对」。
 *   实测（改之前）：初高 27 组、大学 10 组重复。
 *
 * 【本脚本验证的三点】
 *   ① 二级命中：库里已有同科目台账时，同步**不新增行**（行数恒等于 1）
 *   ② 状态搬运：财务核对通过后，那一行**原地变成 3（已核对）**
 *   ③ 三次幂等：同一张单反复同步，行数不涨
 *   ④ 就业链路：财务同步的行落在**统一表** t_uni_fee(job)
 *      （原来裸写 sms_job 老表 → 就业催费页读的是统一表 → 写得进读不回）
 *
 * 【夹具安全】
 *   · 只造「本脚本自己造的 id」，收尾按 id 精确软删（不碰任何业务数据）
 *   · 费用项用 7（押金），与演示数据的 1/2/3 错开，避免误伤
 *
 * 用法（server-job 目录）：
 *   npx tsx scripts/_e2e-urge-sync-check.mts
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// ★ dotenv 必须在动态 import 之前：finance/utils/db.ts 在模块加载那一刻
//   就把 process.env 快照进 knex 配置了，import 之后再 config 等于没配。
dotenv.config({ path: path.join(ROOT, '.env') });

const knex = (await import('knex')).default;

const mkconn = (database: string) =>
  knex({
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD ?? '',
      database,
      charset: 'utf8mb4',
      timezone: '+08:00',
      dateStrings: true,
    },
    pool: { min: 0, max: 3 },
  });

const common = mkconn(process.env.DB_NAME_COMMON || 'sms_common');
const finance = mkconn(process.env.DB_NAME_FINANCE || 'sms_finance');
const job = mkconn(process.env.DB_NAME || 'sms_job');
const cls = mkconn(process.env.DB_NAME_CLASS || 'sms_class');

const { syncFeeToJh, syncFeeToClassUrge, syncFeeToJob } = await import(
  '../src/finance/services/class-sync'
);
const { verifyFee } = await import('../src/finance/services/fee.service');

/* ---------------- 断言器 ---------------- */
const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  —— ' + detail : ''}`);
}
/** 只断言「行为」，不钉内部变量名/行数写法 */
async function rows(sql: string, args: any[] = []) {
  return (await common.raw(sql, args))[0] as any[];
}

const uuid = () => 'TST' + Math.random().toString(36).slice(2, 10).toUpperCase();
const PAY_VERIFIED = 3; // 已核对

/** 收尾要清的东西（按库分组的 id 清单） */
const cleanup: Array<{ db: any; table: string; ids: string[] }> = [];
function track(db: any, table: string, id: string) {
  let g = cleanup.find((x) => x.db === db && x.table === table);
  if (!g) cleanup.push((g = { db, table, ids: [] }));
  g.ids.push(id);
}

/**
 * ★ 2026-10-26 补漏：同步流程会**自己新建行**（`finance-sync` 写的），这些 id
 *   脚本拿不到，只按 tracked id 清理会漏 → 下次跑「前置：原本没有数据」直接红，
 *   而且越跑越多（实测 t_uni_urge 里堆了 11 条 U26001/押金）。
 *   这里按「测试学生 + 费用类型」兜底软删，跑多少次都干净。
 */
const leakGuard: Array<{ db: any; table: string; where: Record<string, any> }> = [];

/* ============================================================
 * 场景 1：初高（t_uni_fee · edu_stage='jh'）
 * ============================================================ */
async function caseJh() {
  console.log('\n=== 场景1 · 初高：已有同科目台账 → 同步就地改状态 ===');
  const studentNo = 'S20260001'; // 演示数据里的初高学生
  const feeType = 7; // 押金：与演示数据错开

  /**
   * ⚠️ 这里**不做** leakGuard 兜底清理：
   *   `S20260001 / 押金(7)` 在 t_uni_fee 里有演示数据，按学生+科目批量删会误伤。
   *   初高同步本来就是「原地改状态」，不会新建行（实测行数稳定为 1）。
   */

  // 0. 前置：确保该学生该科目只有我们造的那一条
  const pre = await rows(
    'SELECT COUNT(*) c FROM t_uni_fee WHERE edu_stage=? AND student_no=? AND fee_type=? AND is_deleted=0',
    ['jh', studentNo, feeType],
  );
  check('前置：该学生该科目原本没有数据（避免历史脏数据干扰）', Number(pre[0].c) === 0, `现有 ${pre[0].c} 行`);

  // 1. 教学侧已有台账（source_system='local'，待缴）
  const localId = uuid();
  await common('t_uni_fee').insert({
    id: localId,
    edu_stage: 'jh',
    student_id: 'seed-stu-01',
    student_no: studentNo,
    student_name: '王伟',
    fee_type: feeType,
    fee_amount: 50000,
    pay_status: 1,
    source_system: 'local',
    source_id: null,
    is_deleted: false,
    create_by: 'selftest',
    create_time: new Date(),
  });
  track(common, 't_uni_fee', localId);

  // 2. 财务单（照抄一张现有初高单做模板，只改关键列）
  const tpl = (await finance('t_finance_fee').where({ dept_code: 1, is_deleted: false }).first()) as any;
  if (!tpl) {
    check('取到初高财务单模板（用于造夹具）', false, 'sms_finance 里没有 dept_code=1 的单');
    return;
  }
  const feeId = uuid();
  await finance('t_finance_fee').insert({
    ...tpl,
    id: feeId,
    student_no: studentNo,
    dept_code: 1,
    fee_type: feeType,
    amount: 50000,
    pay_status: 2, // 待核对
    is_verified: false,
    voucher_url: null,
    voucher_no: null,
    create_by: 'selftest',
    create_time: new Date(),
  });
  track(finance, 't_finance_fee', feeId);

  // 3. 第一次同步（待核对）→ 应该命中已有台账，只改状态
  await syncFeeToJh(feeId);
  let rs = await rows(
    'SELECT id, pay_status, source_system, source_id FROM t_uni_fee WHERE edu_stage=? AND student_no=? AND fee_type=? AND is_deleted=0',
    ['jh', studentNo, feeType],
  );
  check('初高：同步后该科目仍只有 1 行（没有新增）', rs.length === 1, `实际 ${rs.length} 行`);
  check(
    '初高：命中的就是原来那条台账（id 未变，不是新插的一行）',
    rs.length === 1 && rs[0].id === localId,
    `命中 id=${rs[0]?.id} / 原台账 id=${localId}`,
  );
  check(
    '初高：状态已改成财务口径（待核对 2）',
    Number(rs[0]?.pay_status) === 2,
    `pay_status=${rs[0]?.pay_status}`,
  );
  check(
    '初高：该台账被认领到财务单（source_system/source_id）',
    rs[0]?.source_system === 'finance' && rs[0]?.source_id === feeId,
    `${rs[0]?.source_system}/${rs[0]?.source_id}`,
  );

  // 4. 财务核对通过 → 再同步 → ★ 用户诉求：原记录就地变成「已核对」
  await verifyFee(feeId, { userId: 'selftest', userName: '自检' });
  await syncFeeToJh(feeId);
  rs = await rows(
    'SELECT id, pay_status FROM t_uni_fee WHERE edu_stage=? AND student_no=? AND fee_type=? AND is_deleted=0',
    ['jh', studentNo, feeType],
  );
  check('初高：核对后行数仍是 1（核对不再新生成一条）', rs.length === 1, `实际 ${rs.length} 行`);
  check(
    '★ 初高：核对后该行状态 = 3（已核对）',
    Number(rs[0]?.pay_status) === PAY_VERIFIED,
    `pay_status=${rs[0]?.pay_status}`,
  );

  // 5. 幂等：同一张单再同步两次
  await syncFeeToJh(feeId);
  await syncFeeToJh(feeId);
  rs = await rows(
    'SELECT id FROM t_uni_fee WHERE edu_stage=? AND student_no=? AND fee_type=? AND is_deleted=0',
    ['jh', studentNo, feeType],
  );
  check('初高：反复同步仍只有 1 行（幂等）', rs.length === 1, `实际 ${rs.length} 行`);

  // 清理核对产生的账单
  const bills = (await finance('t_finance_bill').where({ source_id: feeId }).select('id')) as any[];
  for (const b of bills) track(finance, 't_finance_bill', b.id);
}

/* ============================================================
 * 场景 2：大学（t_uni_urge · 催费副本）
 * ============================================================ */
async function caseClassUrge() {
  console.log('\n=== 场景2 · 大学：已有同科目台账 → 同步就地改状态 ===');
  /**
   * ⚠️ 学生必须从**统一表** t_uni_student 取：
   *    同步链路里的 findClassStudent / findJobStudent 走的是切读层（统一表），
   *    从 sms_class / sms_job 老表取到的学号在统一表里查不到 → 同步 silently return
   *    （try/catch 吞异常 + 学号查不到直接 return，看起来像「同步没生效」）。
   */
  const stu = (
    await rows(
      "SELECT id, student_no, student_name FROM t_uni_student WHERE edu_stage='class' AND is_deleted=0 AND student_no NOT LIKE '%TST%' ORDER BY student_no LIMIT 1",
    )
  )[0];
  if (!stu?.student_no) {
    check('取到大学学生（用于造夹具）', false);
    return;
  }
  const studentNo = String(stu.student_no);
  const feeType = 7;

  // ★ 同步流程可能自己插行（id 脚本拿不到），按「学生+科目+写入方=finance-sync」兜底清理，
  //   否则下次跑的「前置：原本没有数据」直接红，而且越堆越多。
  leakGuard.push({
    db: common,
    table: 't_uni_urge',
    where: { student_no: studentNo, fee_type: feeType, update_by: 'finance-sync' },
  });

  const pre = await rows(
    'SELECT COUNT(*) c FROM t_uni_urge WHERE student_no=? AND fee_type=? AND is_deleted=0',
    [studentNo, feeType],
  );
  check('前置：该学生该科目原本没有数据', Number(pre[0].c) === 0, `现有 ${pre[0].c} 行`);

  const localId = uuid();
  await common('t_uni_urge').insert({
    id: localId,
    edu_stage: 'class',
    student_id: stu.id,
    student_no: studentNo,
    student_name: stu.student_name,
    fee_type: feeType,
    amount: 50000,
    pay_status: 1,
    // expire_date 是 NOT NULL 且无默认值（大学的缴费必有到期日）
    expire_date: '2026-12-31',
    // sync_status / urge_count / expire_date 都是 NOT NULL 且无默认值
    sync_status: 2,
    urge_count: 0,
    source_system: 'edu',
    source_id: uuid(),
    is_deleted: false,
    create_by: 'selftest',
    create_time: new Date(),
  });
  track(common, 't_uni_urge', localId);

  const tpl = (await finance('t_finance_fee').where({ dept_code: 2, is_deleted: false }).first()) as any;
  if (!tpl) {
    check('取到大学财务单模板', false, 'sms_finance 里没有 dept_code=2 的单');
    return;
  }
  const feeId = uuid();
  await finance('t_finance_fee').insert({
    ...tpl,
    id: feeId,
    student_no: studentNo,
    dept_code: 2,
    fee_type: feeType,
    amount: 50000,
    pay_status: 2,
    is_verified: false,
    voucher_url: null,
    voucher_no: null,
    create_by: 'selftest',
    create_time: new Date(),
  });
  track(finance, 't_finance_fee', feeId);

  await syncFeeToClassUrge(feeId);
  let rs = await rows(
    'SELECT id, pay_status FROM t_uni_urge WHERE student_no=? AND fee_type=? AND is_deleted=0',
    [studentNo, feeType],
  );
  check('大学：同步后仍只有 1 行', rs.length === 1, `实际 ${rs.length} 行`);
  check('大学：状态 = 财务口径（待核对 2）', Number(rs[0]?.pay_status) === 2, `pay_status=${rs[0]?.pay_status}`);

  await verifyFee(feeId, { userId: 'selftest', userName: '自检' });
  await syncFeeToClassUrge(feeId);
  rs = await rows('SELECT id, pay_status FROM t_uni_urge WHERE student_no=? AND fee_type=? AND is_deleted=0', [
    studentNo,
    feeType,
  ]);
  check('大学：核对后行数仍是 1', rs.length === 1, `实际 ${rs.length} 行`);
  check(
    '★ 大学：核对后该行状态 = 3（已核对）',
    Number(rs[0]?.pay_status) === PAY_VERIFIED,
    `pay_status=${rs[0]?.pay_status}`,
  );

  const bills = (await finance('t_finance_bill').where({ source_id: feeId }).select('id')) as any[];
  for (const b of bills) track(finance, 't_finance_bill', b.id);
}

/* ============================================================
 * 场景 3：就业（t_uni_fee · edu_stage='job'）
 *   ★ 额外验证：同步落到**统一表**（原来裸写 sms_job 老表 → 催费页读不到）
 * ============================================================ */
async function caseJob() {
  console.log('\n=== 场景3 · 就业：统一表落库 + 就地改状态 ===');
  // ⚠️ 同样从统一表取学生（理由见场景2）
  const stu = (
    await rows(
      "SELECT id, student_no, student_name FROM t_uni_student WHERE edu_stage='job' AND is_deleted=0 AND student_no NOT LIKE '%TST%' ORDER BY student_no LIMIT 1",
    )
  )[0];
  if (!stu?.student_no) {
    check('取到就业学生（用于造夹具）', false);
    return;
  }
  const studentNo = String(stu.student_no);
  const feeType = 7;

  /**
   * ⚠️ 这里**不做** leakGuard 兜底清理：
   *   就业同步也是「原地改状态」，实测行数稳定为 1；按学生+科目批量删有误伤风险。
   */

  const pre = await rows(
    'SELECT COUNT(*) c FROM t_uni_fee WHERE edu_stage=? AND student_no=? AND fee_type=? AND is_deleted=0',
    ['job', studentNo, feeType],
  );
  check('前置：该学生该科目原本没有数据', Number(pre[0].c) === 0, `现有 ${pre[0].c} 行`);

  const localId = uuid();
  await common('t_uni_fee').insert({
    id: localId,
    edu_stage: 'job',
    student_id: stu.id,
    student_no: studentNo,
    student_name: stu.student_name,
    fee_type: feeType,
    fee_amount: 50000,
    pay_status: 1,
    call_status: 1,
    source_system: 'manual',
    source_id: null,
    is_deleted: false,
    create_by: 'selftest',
    create_time: new Date(),
  });
  track(common, 't_uni_fee', localId);

  const tpl = (await finance('t_finance_fee').where({ dept_code: 3, is_deleted: false }).first()) as any;
  if (!tpl) {
    check('取到就业财务单模板', false, 'sms_finance 里没有 dept_code=3 的单');
    return;
  }
  const feeId = uuid();
  await finance('t_finance_fee').insert({
    ...tpl,
    id: feeId,
    student_no: studentNo,
    dept_code: 3,
    fee_type: feeType,
    amount: 50000,
    pay_status: 2,
    is_verified: false,
    voucher_url: null,
    voucher_no: null,
    create_by: 'selftest',
    create_time: new Date(),
  });
  track(finance, 't_finance_fee', feeId);

  await syncFeeToJob(feeId);
  let rs = await rows(
    'SELECT id, pay_status, source_system FROM t_uni_fee WHERE edu_stage=? AND student_no=? AND fee_type=? AND is_deleted=0',
    ['job', studentNo, feeType],
  );
  check('就业：同步后仍只有 1 行', rs.length === 1, `实际 ${rs.length} 行`);
  check(
    '就业：同步落在**统一表** t_uni_fee（job）—— 催费页读得到',
    rs.length === 1 && rs[0].source_system === 'finance',
    `source_system=${rs[0]?.source_system}`,
  );
  check('就业：状态 = 财务口径（待核对 2）', Number(rs[0]?.pay_status) === 2, `pay_status=${rs[0]?.pay_status}`);

  await verifyFee(feeId, { userId: 'selftest', userName: '自检' });
  await syncFeeToJob(feeId);
  rs = await rows(
    'SELECT id, pay_status, call_status FROM t_uni_fee WHERE edu_stage=? AND student_no=? AND fee_type=? AND is_deleted=0',
    ['job', studentNo, feeType],
  );
  check('就业：核对后行数仍是 1', rs.length === 1, `实际 ${rs.length} 行`);
  check(
    '★ 就业：核对后该行状态 = 3（已核对）',
    Number(rs[0]?.pay_status) === PAY_VERIFIED,
    `pay_status=${rs[0]?.pay_status}`,
  );

  const bills = (await finance('t_finance_bill').where({ source_id: feeId }).select('id')) as any[];
  for (const b of bills) track(finance, 't_finance_bill', b.id);
}

/* ---------------- 主流程 ---------------- */
try {
  await caseJh();
  await caseClassUrge();
  await caseJob();
} catch (e) {
  check(`脚本抛异常：${(e as Error).message}`, false);
  console.error(e);
} finally {
  // ★ 夹具清理：只软删本脚本自己造的 id
  for (const g of cleanup) {
    if (!g.ids.length) continue;
    try {
      await g.db(g.table).whereIn('id', g.ids).update({ is_deleted: true, update_by: 'selftest-cleanup' });
    } catch (e) {
      console.warn(`  清理 ${g.table} 失败：${(e as Error).message}`);
    }
  }
  console.log(
    `\n已清理夹具 ${cleanup.reduce((n, g) => n + g.ids.length, 0)} 条：` +
      cleanup.map((g) => `${g.table}×${g.ids.length}`).join(' , '),
  );
  // 兜底：同步流程自己插的行（按学生+科目+写入方）
  for (const g of leakGuard) {
    try {
      const n = await g.db(g.table)
        .where(g.where)
        .update({ is_deleted: true, update_by: 'selftest-cleanup' });
      if (n) console.log(`  兜底清理 ${g.table} ${n} 条（${JSON.stringify(g.where)}）`);
    } catch (e) {
      console.warn(`  兜底清理 ${g.table} 失败：${(e as Error).message}`);
    }
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== 结果：${pass}/${results.length} 通过 =====`);
  results.filter((r) => !r.ok).forEach((r) => console.log(`  失败：${r.name}`));

  await Promise.all([common.destroy(), finance.destroy(), job.destroy(), cls.destroy()]);
  process.exit(pass === results.length ? 0 : 1);
}
