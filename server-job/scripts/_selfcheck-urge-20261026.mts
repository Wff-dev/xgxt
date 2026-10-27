/**
 * 自检：催费名单（财务账单到期日口径）· 2026-10-26
 * ============================================================
 * 覆盖用户反馈：「教学管理 → 缴费 列表没数据，到了提前天数财务的缴费数据应该出现」
 *
 * 断言四组：
 *   A. 到期日算法（computeExpireDate）—— 月费/年费/续费接续/无标准不瞎算
 *   B. 存量回填幂等（跑两次，第二次 filled = 0）
 *   C. 三部门名单按部门隔离（初高 / 大学各自有数据，不会串）
 *   D. 列表可用性：初高每行 feeId、手机号、家长手机号不为空；
 *      大学行 id 是真实催缴行 id（不以 fin- 合成前缀开头）
 *
 * 跑法：cd server-job && npx tsx scripts/_selfcheck-urge-20261026.mts
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { computeExpireDate } from '../src/finance/services/expire';
import { backfillExpireDates, listUrgeByExpire, getUrgeAheadDays } from '../src/finance/services/urge.service';
import { knexRaw } from '../src/finance/utils/db';

const BASE = 'http://127.0.0.1:8004';
let pass = 0;
const fails: string[] = [];

function ok(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      pass++;
      console.log(`  ✓ ${name}`);
    } catch (e: any) {
      fails.push(`${name} → ${e?.message || e}`);
      console.error(`  ✗ ${name} → ${e?.message || e}`);
    }
  })();
}

async function login(account: string): Promise<string> {
  const r = await fetch(`${BASE}/api/portal/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password: '123456' }),
  });
  const j: any = await r.json();
  assert.ok(j?.data?.token, `登录失败：${j?.message}`);
  return j.data.token;
}

async function getJson(path: string, token: string) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json()) as any;
}

async function main() {
  // ---------- A. 到期日算法 ----------
  console.log('\n[A] 到期日算法');
  await ok('住宿费 3600 元（=1 个月标准价）→ 推 1 个月', () => {
    assert.equal(
      computeExpireDate({ feeType: 2, amount: 360000, payDate: '2026-08-06', stdAmount: 360000 }),
      '2026-09-06',
    );
  });
  await ok('住宿费 7200 元（=2 个月）→ 推 2 个月', () => {
    assert.equal(
      computeExpireDate({ feeType: 2, amount: 720000, payDate: '2026-08-06', stdAmount: 360000 }),
      '2026-10-06',
    );
  });
  await ok('续费接续：上次到期 12-06，本次 08-06 缴 → 从 12-06 往后接（不重叠）', () => {
    assert.equal(
      computeExpireDate({
        feeType: 2,
        amount: 360000,
        payDate: '2026-08-06',
        stdAmount: 360000,
        prevExpire: '2026-12-06',
      }),
      '2027-01-06',
    );
  });
  await ok('保险费按年（标准 300 元 = 1 年）', () => {
    assert.equal(
      computeExpireDate({ feeType: 4, amount: 30000, payDate: '2026-08-06', stdAmount: 30000 }),
      '2027-08-06',
    );
  });
  await ok('保险费不足一个标准价也给 1 年（优惠场景不倒挂）', () => {
    assert.equal(
      computeExpireDate({ feeType: 4, amount: 20000, payDate: '2026-08-06', stdAmount: 30000 }),
      '2027-08-06',
    );
  });
  await ok('学费没有到期概念 → null', () => {
    assert.equal(
      computeExpireDate({ feeType: 1, amount: 1280000, payDate: '2026-08-06', stdAmount: 1280000 }),
      null,
    );
  });
  await ok('该部门没配标准 → null（不瞎算）', () => {
    assert.equal(
      computeExpireDate({ feeType: 2, amount: 120000, payDate: '2026-08-06', stdAmount: 0 }),
      null,
    );
  });
  await ok('月末对齐：1-31 推 1 个月 → 2-28', () => {
    assert.equal(
      computeExpireDate({ feeType: 2, amount: 360000, payDate: '2026-01-31', stdAmount: 360000 }),
      '2026-02-28',
    );
  });

  // ---------- B. 回填幂等 ----------
  console.log('\n[B] 存量回填幂等');
  const first = await backfillExpireDates();
  const second = await backfillExpireDates();
  await ok('第二次回填不再改动任何行（filled = 0）', () => {
    assert.equal(second.filled, 0, `第二次仍补了 ${second.filled} 条`);
  });
  await ok('第一次回填后仍有空到期日的，全部是「缺费用标准」导致的', () => {
    console.log(
      `     第一轮：补齐 ${first.filled} 条，跳过 ${first.skipped} 条` +
        (first.missing.length
          ? `；缺标准：${first.missing.map((m) => `费用${m.feeType}/部门${m.deptCode}`).join('、')}`
          : ''),
    );
  });

  // ---------- C. 名单按部门隔离 ----------
  console.log('\n[C] 名单按部门隔离');
  const ahead = await getUrgeAheadDays();
  const jh = await listUrgeByExpire(ahead, { deptCode: 1 });
  const uni = await listUrgeByExpire(ahead, { deptCode: 2 });
  const job = await listUrgeByExpire(ahead, { deptCode: 3 });
  await ok(`初高部名单非空（实际 ${jh.total} 人）`, () => {
    assert.ok(jh.total > 0, '初高名单为空');
  });
  await ok(`大学部名单非空（实际 ${uni.total} 人）`, () => {
    assert.ok(uni.total > 0, '大学名单为空');
  });
  await ok('初高名单里没有大学部学生（部门不串）', () => {
    assert.ok(jh.rows.every((r) => r.deptCode === 1), '初高名单混入了其他部门');
  });
  await ok('名单里的剩余天数都 ≤ 提前天数（只收快到期/已逾期）', () => {
    for (const r of [...jh.rows, ...uni.rows, ...job.rows]) {
      assert.ok(r.remainDays <= ahead, `${r.studentName} 剩余 ${r.remainDays} 天，超出提前 ${ahead} 天`);
    }
  });

  // ---------- D. 列表可用性（HTTP）----------
  console.log('\n[D] 列表可用性（走真实接口）');
  let token = '';
  await ok(`后端可登录（${BASE}）`, async () => {
    token = await login('sunmin');
  });
  if (token) {
    await ok('初高列表：每行都带台账 feeId（「上传缴费凭证」要它）', async () => {
      const d = await getJson('/api/class-jh/fee/list?page=1&size=20', token);
      assert.equal(d.code, 200, d.message);
      assert.ok(d.data.list.length > 0, '初高列表没有数据');
      const bad = d.data.list.filter((x: any) => !x.feeId);
      assert.equal(bad.length, 0, `${bad.length} 行 feeId 为空（登记缴费会报「缴费单不存在」）`);
    });
    await ok('初高列表：手机号 / 家长手机号不为空（按学号补档案）', async () => {
      const d = await getJson('/api/class-jh/fee/list?page=1&size=20', token);
      const bad = d.data.list.filter((x: any) => !x.phone || !x.parentPhone);
      assert.equal(bad.length, 0, `${bad.length} 行手机号为空`);
    });
    await ok('大学列表：行 id 是真实催缴行（不是 fin- 合成只读 id）', async () => {
      const d = await getJson('/api/class/urge/list?page=1&size=20', token);
      assert.equal(d.code, 200, d.message);
      assert.ok(d.data.list.length > 0, '大学列表没有数据');
      const synth = d.data.list.filter((x: any) => String(x.id).startsWith('fin-'));
      assert.equal(synth.length, 0, `${synth.length} 行是合成 id（登记缴费会失败）`);
    });
    await ok('大学列表：手机号不为空', async () => {
      const d = await getJson('/api/class/urge/list?page=1&size=20', token);
      const bad = d.data.list.filter((x: any) => !x.phone);
      assert.equal(bad.length, 0, `${bad.length} 行手机号为空`);
    });
  }

  await knexRaw.destroy();

  console.log(`\n===== 自检结果：通过 ${pass}，失败 ${fails.length} =====`);
  if (fails.length) {
    for (const f of fails) console.error(' ✗', f);
    // ⚠️ 不用 process.exit(1)：管道输出时进程直接退出会丢掉缓冲区，日志看起来是空的
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('自检异常：', e);
  process.exitCode = 1;
});
