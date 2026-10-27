/**
 * 端到端判权探测（只读，靠「参数错误」与「无权限」区分）
 *
 * 判定口径：
 *   403 + "您没有该操作的权限"  → 权限被拒
 *   其它（200/400/业务码）      → 权限已通过（后面是参数校验或业务报错）
 *
 * 用法：node scripts/_probe_perm_e2e.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8004';
const PWD = '123456';

const PROBES = [
  ['qiansy', '校长', 'POST', '/api/finance/fee/verify', '财务核对', 'OK'],
  ['liukj', '财务', 'POST', '/api/finance/fee/verify', '财务核对', 'OK'],
  ['qiansy', '校长', 'POST', '/api/finance/refund/pay', '退费出款', 'OK'],
  ['liukj', '财务', 'POST', '/api/finance/freeze/unfreeze', '解冻', 'OK'],
  ['lilx', '咨询老师', 'POST', '/api/consult/student/add', '新建学生', 'OK'],
  ['qiansy', '校长', 'POST', '/api/consult/fee/formal', '正式学费收款', 'OK'],
  ['leiyx', '班主任(高中部)', 'POST', '/api/class/student/add', '教学-新增学生', 'OK'],
  ['leiyx', '班主任(高中部)', 'POST', '/api/job/student-leave/approve', '休学审批', 'DENY'],
  ['congym', '学管主任', 'POST', '/api/job/student-leave/approve', '休学审批', 'OK'],
  ['zhengym', '教务老师', 'POST', '/api/edu/student/add', '教务-新增学员', 'OK'],
  ['zhouj', '就业老师', 'POST', '/api/job/review/add', '新建复盘', 'OK'],
  ['linx', '系统管理员', 'POST', '/api/perm/role/create', '新建职位', 'OK'],
];

async function login(account) {
  const r = await fetch(`${BASE}/api/portal/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password: PWD }),
  });
  const j = await r.json();
  if (!j?.data?.token) throw new Error(`登录失败 ${account}: ${j?.message}`);
  return j.data.token;
}

async function main() {
  const tokens = new Map();
  let pass = 0;
  let fail = 0;

  console.log('账号 | 角色 | 操作 | 期望 | 实际 | 结论');
  console.log('---|---|---|---|---|---');

  for (const [account, roleName, method, path, label, expect] of PROBES) {
    if (!tokens.has(account)) tokens.set(account, await login(account));
    const token = tokens.get(account);

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    const body = await res.text();
    const denied = res.status === 403;
    const got = denied ? 'DENY' : 'OK';
    const ok = got === expect ? '✅' : '❌';
    if (got === expect) pass++;
    else fail++;
    const msg = (() => {
      try {
        return JSON.parse(body).message || '';
      } catch {
        return body.slice(0, 40);
      }
    })();
    console.log(
      `${account} | ${roleName} | ${label} | ${expect} | ${got}(${res.status}) | ${ok} ${msg}`,
    );
  }

  console.log(`\n合计：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
