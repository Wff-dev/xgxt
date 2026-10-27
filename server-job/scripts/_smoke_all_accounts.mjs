/**
 * 全账号回归（只读）：确认改动后每个账号仍能正常登录、拿到页面与操作码，
 * 且关键写接口不再是「勾了却 403」。
 *
 * 用法：node scripts/_smoke_all_accounts.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8004';
const PWD = '123456';

/** 每个账号挑一个「它应该能操作」的写接口做探测（{} 触发参数校验即可） */
const WRITE_PROBE = {
  qiansy: ['POST', '/api/finance/fee/verify'],
  liukj: ['POST', '/api/finance/fee/verify'],
  zhoum: ['POST', '/api/finance/fee/verify'],
  lilx: ['POST', '/api/consult/student/add'],
  zhangls: ['POST', '/api/consult/student/add'],
  wangjl: ['POST', '/api/consult/student/add'],
  leiyx: ['POST', '/api/class/student/add'],
  zhanght: ['POST', '/api/class/student/add'],
  fengcx: ['POST', '/api/class/student/add'],
  gaowb: ['POST', '/api/class/student/add'],
  liuzq: ['POST', '/api/class/student/add'],
  renwj: ['POST', '/api/class/student/add'],
  hanxy: ['POST', '/api/class/student/add'],
  mengxh: ['POST', '/api/class/student/add'],
  zhaomx: ['POST', '/api/class/student/add'],
  congym: ['POST', '/api/job/student-leave/approve'],
  jicl: ['POST', '/api/job/student-leave/approve'],
  pengyq: ['POST', '/api/job/student-leave/approve'],
  kangzy: ['POST', '/api/job/student-leave/approve'],
  qizy: ['POST', '/api/job/student-leave/approve'],
  // chenxf（陈晓峰）密码与演示口令不同，登录不通，跳过（非权限问题）
  sunjl: ['POST', '/api/job/attendance/save'],
  sunmin: ['POST', '/api/job/attendance/save'],
  zhouj: ['POST', '/api/job/review/add'],
  zhengym: ['POST', '/api/edu/student/add'],
  linx: ['GET', '/api/perm/role/list'],
};

async function login(account) {
  const r = await fetch(`${BASE}/api/portal/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password: PWD }),
  });
  const j = await r.json();
  if (!j?.data?.token) throw new Error(`登录失败 ${account}: ${j?.message || r.status}`);
  return j.data.token;
}

async function main() {
  let fail = 0;
  console.log('账号 | 角色 | 页面数 | 操作码数 | 写接口探测 | 结论');
  console.log('---|---|---|---|---|---');

  for (const [account, probe] of Object.entries(WRITE_PROBE)) {
    let token;
    try {
      token = await login(account);
    } catch (e) {
      console.log(`${account} | - | - | - | - | ❌ ${e.message}`);
      fail++;
      continue;
    }

    const mp = await fetch(`${BASE}/api/job/auth/my-pages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const mpJson = await mp.json();
    const d = mpJson.data || {};
    const pageCount = (d.pages || []).length;
    const permCount = (d.permissions || []).length;

    const [method, path] = probe;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: method === 'GET' ? undefined : '{}',
    });

    const denied = res.status === 403;
    /**
     * 页面数只作参考、不作判据：
     *   财务 / 咨询 / 系统管理员 没有 job 模块 → /api/job/auth/my-pages 本来就是 0，
     *   它们的页面在各自模块自己的清单里（finance / consult / perm）。
     * 真正的判据只有一条：**它自己的写接口不该 403**。
     */
    const ok = !denied;
    if (!ok) fail++;

    console.log(
      `${account} | ${(d.roles || []).join(',')} | ${pageCount} | ${permCount} | ${method} ${path} → ${res.status} | ${ok ? '✅' : '❌'}`,
    );
  }

  console.log(`\n合计：${Object.keys(WRITE_PROBE).length - fail} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
