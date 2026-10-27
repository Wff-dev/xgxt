/**
 * 权限总表生成器（读代码里的权限树 + 库里的职位授权，产出 md / html / json）
 *
 * 用法：cd server-job && npx tsx scripts/gen-perm-doc.ts
 * 产出：../输出/全系统权限总表.md、../输出/权限总表.html、../输出/权限总表.json
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { db } from '../src/perm/utils/db';
import { PERM_TREE, PERM_TREE_STATS, BASE_ACTION_NAME } from '../src/perm/config/permTree';

/** 各页面「动作 → 界面上长什么样」（人工核对，2026-10-26） */
const UI_LABEL: Record<string, string> = {
  'workbench/dashboard|view': '工作台首页可见',
  'workbench/dashboard|todo': '待办清单「处理」',

  'consult/student|view': '进入「学生管理」列表',
  'consult/student|add': '右上「＋ 新建学生」',
  'consult/student|edit': '详情弹窗「完善档案」',
  'consult/student|assign': '行操作「分配」',
  'consult/student|claim': '行操作「领取」',
  'consult/student|interview': '行操作「面试」→ 提交面试结果',
  'consult/student|enroll': '行操作「分配班级」',
  'consult/student|toFormal': '详情弹窗「转正式」',
  'consult/student|supplement': '详情弹窗「补缴」',
  'consult/student|cancelNotEnrolled': '行操作「取消未报名」',
  'consult/student|loss': '行操作「流失」',
  'consult/student|follow': '详情弹窗「新增跟进」',

  'consult/fee|view': '进入「收款与缴费」列表',
  'consult/fee|createTrial': '「＋ 发起收费」→ 试学费',
  'consult/fee|createFormal': '「＋ 发起收费」→ 正式学费',
  'consult/fee|discount': '发起收费弹窗里的「实收金额」',
  'consult/fee|supplement': '行操作「补费」',
  'consult/fee|uploadVoucher': '行操作「上传凭证」',
  'consult/fee|resubmit': '行操作「重新提交」',
  'consult/fee|void': '行操作「作废」',
  'consult/fee|viewPlan': '详情「查看分期计划」',
  'consult/fee|viewVoucher': '详情「查看凭证」',

  'consult/approve|view': '进入「审批中心」',
  'consult/approve|approve': '行操作「批准」',
  'consult/approve|reject': '行操作「驳回」',
  'consult/approve|detail': '「查看审批明细」',

  'consult/refund|view': '进入「退费管理」',
  'consult/refund|apply': '「＋ 发起退费」',
  'consult/refund|approve': '行操作「批准」',
  'consult/refund|reject': '行操作「驳回」',
  'consult/refund|detail': '行操作「明细」',

  'consult/loss|view': '进入「流失记录」',
  'consult/loss|detail': '「查看流失详情」',
  'consult/loss|follow': '「填写后续跟进计划」',

  'finance/overview|view': '进入「财务概览」',
  'finance/overview|drill': '卡片「缴费/退费/冻结/账单」下钻',

  'finance/fee|view': '进入「缴费管理」',
  'finance/fee|verify': '行操作「核对」',
  'finance/fee|batchVerify': '「批量财务核对」',
  'finance/fee|reject': '行操作「打回」',
  'finance/fee|viewVoucher': '「查看大图 / 新窗口打开」',

  'finance/freeze|view': '进入「冻结名单」',
  'finance/freeze|unfreeze': '行操作「解冻」',

  'finance/refund|view': '进入「退费管理」',
  'finance/refund|pay': '行操作「确认出款」',
  'finance/refund|reject': '行操作「驳回」',
  'finance/refund|detail': '行操作「详情」',

  'finance/bill|view': '进入「账单明细」',
  'finance/bill|viewVoucher': '行操作「查看凭证」',

  'finance/standard|view': '进入「费用标准」',
  'finance/standard|add': '「新增标准」',
  'finance/standard|edit': '行操作「修改金额」',

  'perm/overview|view': '进入「权限总览」',
  'perm/overview|viewLog': '「查看全部日志」',
  'perm/overview|exportLog': '「导出此条 / 确认导出」',

  'perm/dept|view': '进入「部门管理」',
  'perm/dept|add': '「＋ 新建部门」',
  'perm/dept|edit': '行操作「编辑」',
  'perm/dept|del': '行操作「删除」',
  'perm/dept|detail': '行操作「详情」',

  'perm/role|view': '进入「职位管理」',
  'perm/role|add': '「＋ 新建职位」',
  'perm/role|edit': '行操作「编辑」',
  'perm/role|del': '行操作「删除」',
  'perm/role|toggleStatus': '行操作「停用 / 启用」',
  'perm/role|import': '「批量导入」',
  'perm/role|export': '「导出」',

  'perm/user|view': '进入「账号管理」',
  'perm/user|add': '「＋ 新建账号」',
  'perm/user|edit': '行操作「编辑」',
  'perm/user|resetPwd': '「重置密码」',
  'perm/user|toggleStatus': '行操作「停用 / 启用」',
  'perm/user|import': '「批量导入」',
  'perm/user|assignRole': '「保存职位分配」',
  'perm/user|export': '「导出」',

  'perm/assign|view': '进入「职位权限分配」',
  'perm/assign|editPerm': '「编辑该职位权限」',
  'perm/assign|copy': '「从其他职位复制」',
  'perm/assign|resetPrefab': '「重置为预置」',
  'perm/assign|addItem': '「+ 新增权限」',

  'perm/page|view': '进入「页面管理」',
  'perm/page|edit': '板块/页面勾选框',
  'perm/page|restore': '「恢复默认」',

  'perm/log|view': '进入「操作日志」',
  'perm/log|export': '「导出 / 确认导出」',
  'perm/log|exportOne': '「导出此条」',

  'teach/student|view': '进入「学生档案」',
  'teach/student|add': '「新增学生」',
  'teach/student|edit': '行操作「编辑」',
  'teach/student|del': '行操作「删除」',
  'teach/student|upgrade': '行操作「升云 / 升实训」',
  'teach/student|quit': '行操作「退学」→ 提交退学申请',
  'teach/student|markEmployed': '行操作「已就业」',

  'teach/class|view': '进入「班级管理」',
  'teach/class|add': '「新增班级」',
  'teach/class|edit': '行操作「编辑」',
  'teach/class|del': '行操作「删除」',
  'teach/class|handover': '行操作「交接」→ 确认交接',
  'teach/class|scheme': '「阶段方案设计」',
  'teach/class|promote': '行操作「升实训」',
  'teach/class|graduate': '行操作「升就业」',
  'teach/class|employStatus': '行操作「待就业 / 已就业」',

  'teach/consult|view': '进入「待接收学员」',
  'teach/consult|receive': '行操作「接收 → 确认接收」',
  'teach/consult|reject': '行操作「驳回 → 确认驳回」',

  'teach/attendance|view': '进入「出勤管理」',
  'teach/attendance|add': '「录入出勤」',
  'teach/attendance|edit': '行操作「修改」',
  'teach/attendance|export': '「导出」',

  'teach/exam|view': '进入「考试管理」',
  'teach/exam|add': '「新建考试」',
  'teach/exam|edit': '行操作「编辑」',
  'teach/exam|del': '行操作「删除」',

  'teach/score|view': '进入「成绩管理」',
  'teach/score|add': '「录入成绩」',
  'teach/score|edit': '行操作「编辑」',
  'teach/score|promote': '行操作「末班 / 升班」',

  'teach/dorm|view': '进入「宿舍管理」',
  'teach/dorm|add': '宿舍房间 → 「新增房间」',
  'teach/dorm|edit': '宿舍房间 → 行操作「编辑」',
  'teach/dorm|del': '宿舍房间 → 行操作「删除」',
  'teach/dorm|bed': '宿舍房间 → 行操作「床位」→ 入住 / 分配',
  'teach/dorm|checkout': '宿舍房间 → 床位抽屉「退宿」',
  'teach/dorm|apply': '「调宿/退宿申请」→ 提交申请',
  'teach/dorm|allocate': '分派宿舍页签 → 行操作「分派」',
  'teach/dorm|approve': '申请审批页签 → 「通过」',
  'teach/dorm|reject': '申请审批页签 → 「驳回」',
  'teach/dorm|buildAdd': '楼栋设置页签 → 「新增楼栋」',
  'teach/dorm|buildEdit': '楼栋设置页签 → 行操作「编辑」',
  'teach/dorm|buildDel': '楼栋设置页签 → 行操作「删除」',

  'teach/fee|view': '进入「催费」',
  'teach/fee|urge': '行操作「上传缴费凭证 / 重新登记」',
  'teach/fee|transferFinance': '「批量上传到财务」',
  'teach/fee|export': '「导出」',

  'teach/refund|view': '进入「退费」',
  'teach/refund|apply': '「发起退费」',
  'teach/refund|submit': '行操作「提交」',
  'teach/refund|approve': '行操作「审批通过」',
  'teach/refund|reject': '行操作「驳回」',
  'teach/refund|withdraw': '行操作「撤回」',
  'teach/refund|pay': '「登记出款」',

  'teach/approval|view': '进入「休学/退学审批」',
  'teach/approval|apply': '「发起申请」',
  'teach/approval|submit': '行操作「提交」',
  'teach/approval|approve': '行操作「审批 → 确认通过」',
  'teach/approval|reject': '行操作「驳回」',
  'teach/approval|withdraw': '行操作「撤回」',

  'teach/employmentLog|view': '进入「就业日志」',
  'teach/employmentLog|add': '「新建就业日志」',
  'teach/employmentLog|edit': '行操作「编辑」',
  'teach/employmentLog|del': '行操作「删除」',

  'teach/review|view': '进入「复盘填写」',
  'teach/review|add': '「新建复盘」',
  'teach/review|edit': '行操作「编辑」',
  'teach/review|uploadAudio': '「上传录音」',
  'teach/review|del': '行操作「删除」',

  'teach/statistics|view': '进入「数据统计」',
  'teach/statistics|setTarget': '「设置目标 → 保存」',
};

async function main() {
  const roles = (await db('t_perm_role')
    .where('is_deleted', false)
    .select('id', 'role_code', 'role_name', 'is_sys', 'perm_count')
    .orderBy('sort_no')) as any[];

  const rolePerms = (await db('t_perm_role_perm')
    .where('is_deleted', false)
    .select('role_id', 'module_key', 'item_name', 'action_code')) as any[];

  const roleName = new Map<string, string>(roles.map((r) => [String(r.id), r.role_name]));
  /** 'mod||item||code' → 职位名[] */
  const who = new Map<string, string[]>();
  /** 'mod||item' → 职位名[]（能看见这页） */
  const pageWho = new Map<string, Set<string>>();
  for (const p of rolePerms) {
    const rn = roleName.get(String(p.role_id)) || String(p.role_id);
    const k = `${p.module_key}||${p.item_name}||${p.action_code}`;
    const arr = who.get(k) || [];
    if (!arr.includes(rn)) arr.push(rn);
    who.set(k, arr);
    const pk = `${p.module_key}||${p.item_name}`;
    const s = pageWho.get(pk) || new Set<string>();
    s.add(rn);
    pageWho.set(pk, s);
  }

  /* ---------- 组装数据 ---------- */
  const data = {
    generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    stats: PERM_TREE_STATS,
    roleCount: roles.length,
    boards: PERM_TREE.map((b) => ({
      moduleKey: b.moduleKey,
      name: b.name,
      icon: b.icon,
      desc: b.desc,
      pages: b.pages.map((p) => ({
        key: p.key,
        name: p.name,
        path: p.path,
        remark: p.remark,
        pageCodes: p.pageCodes,
        actions: p.actions.map((a) => ({
          code: a.code,
          name: a.name,
          base: a.base,
          baseName: BASE_ACTION_NAME[a.base],
          ops: a.ops || [],
          ui: UI_LABEL[`${b.moduleKey}/${p.key}|${a.code}`] || '',
          roles: who.get(`${b.moduleKey}||${p.name}||${a.code}`) || [],
        })),
      })),
    })),
    roles: roles.map((r) => ({
      code: r.role_code,
      name: r.role_name,
      isSys: !!r.is_sys,
      permCount: r.perm_count,
      pages: PERM_TREE.flatMap((b) =>
        b.pages
          .map((p) => ({
            moduleName: b.name,
            pageName: p.name,
            actions: p.actions
              .filter((a) =>
                (who.get(`${b.moduleKey}||${p.name}||${a.code}`) || []).includes(r.role_name),
              )
              .map((a) => a.name),
          }))
          .filter((x) => x.actions.length > 0),
      ),
    })),
  };

  const dir = resolve(process.cwd(), '../输出');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, '权限总表.json'), JSON.stringify(data, null, 2), 'utf8');

  /* ---------- Markdown ---------- */
  const L: string[] = [];
  L.push('# 良志学管系统 · 全系统权限总表');
  L.push('');
  L.push(`> 生成时间：${data.generatedAt}　｜　数据口径：**代码里的权限树 + 权限库实时授权**`);
  L.push('> 来源：`server-job/src/perm/config/permTree.ts`（动作定义）、`pageRegistry.ts`（页面台账）、');
  L.push('> `sms_perm.t_perm_menu / t_perm_menu_action / t_perm_role_perm`（界面显示与授权）');
  L.push('');
  L.push(
    `**规模：${data.stats.modCount} 个板块 · ${data.stats.itemCount} 个页面 · ${data.stats.actionCount} 个动作 · ${data.roleCount} 个职位**`,
  );
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 一、板块与页面总览');
  L.push('');
  L.push('| 板块 | 页面 | 路由 | 动作数 | 能看见的职位数 |');
  L.push('|---|---|---|---|---|');
  for (const b of data.boards) {
    for (const p of b.pages) {
      L.push(
        `| ${b.icon} ${b.name} | ${p.name} | \`${p.path}\` | ${p.actions.length} | ${(pageWho.get(`${b.moduleKey}||${p.name}`) || new Set()).size} |`,
      );
    }
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 二、逐页面动作明细（含：按钮位置 / 后端操作码 / 已授权职位）');
  for (const b of data.boards) {
    L.push('');
    L.push(`### ${b.icon} ${b.name}（${b.pages.length} 页）`);
    for (const p of b.pages) {
      L.push('');
      L.push(`#### ${p.name}　\`${p.path}\``);
      if (p.remark) L.push(`> ${p.remark}`);
      L.push('');
      L.push('| # | 动作 | 类型 | 界面上在哪 | 后端操作码 | 已授权职位 |');
      L.push('|---|---|---|---|---|---|');
      p.actions.forEach((a, i) => {
        L.push(
          `| ${i + 1} | **${a.name}** | ${a.baseName} | ${a.ui || '—'} | ${a.ops.length ? a.ops.map((o) => '`' + o + '`').join('<br>') : '（界面级）'} | ${a.roles.length ? a.roles.join('、') : '**（无）**'} |`,
        );
      });
    }
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 三、按职位看：这个职位能做哪些操作');
  for (const r of data.roles) {
    L.push('');
    L.push(`### ${r.name}${r.isSys ? '' : '（自建）'}　\`${r.code}\`　共 ${r.permCount} 个权限点`);
    if (!r.pages.length) {
      L.push('');
      L.push('*（无任何动作授权）*');
      continue;
    }
    for (const pg of r.pages) {
      L.push(`- **${pg.moduleName} · ${pg.pageName}**（${pg.actions.length}）：${pg.actions.join('、')}`);
    }
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 四、对账发现的口径差异（需要拍板）');
  L.push('');
  L.push('> 这些不是「漏了」，而是**界面判定与权限树勾选对不上**，属于业务口径问题，先列出来不动数据。');
  L.push('');
  L.push('| # | 现象 | 位置 | 建议 |');
  L.push('|---|---|---|---|');
  L.push(
    '| 1 | 「审批调宿申请 / 驳回调宿申请」17 个职位都勾着，但界面只对 **教务老师 / 校长 / 学管主任 / 系统管理员** 显示「申请审批」页签 | `TeachingDorm.vue` 的 `canApproveDorm` | 二者取一：收紧授权（只留 4 类职位），或放开页签给更多职位 |',
  );
  L.push(
    '| 2 | 「分派宿舍 / 楼栋设置」两个页签对**教员**是显示的（隐藏逻辑只判「纯班主任」），但业务上这两项归教务 / 学管 | `TeachingDorm.vue` 的 `isOnlyHeadTeacher` | 本轮授权已按「非教学岗」发放；建议前端把这两个页签的判定改成「角色白名单」 |',
  );
  L.push(
    '| 3 | 教学管理 13 页的**后端操作码只挂在旧接口**（`/api/job/*` `/api/class/*` `/api/class-jh/*`）。统一页走 `/api/teaching/*`，那边只有页面级 `requireAnyPage` + 只读/审批只写两道闸 | `server-job/src/app.ts` | 取消某个动作的勾选后**按钮会消失、统一页接口不会 403**。要真正「取消即 403」，需给 `/api/teaching/*` 补动作级拦截（单独排期） |',
  );
  L.push(
    '| 4 | 「新增楼栋 / 编辑楼栋 / 删除楼栋」三个动作是**界面级**（无独立接口码） | `teaching/dorm/building.route.ts` | 同上；楼栋写接口目前靠只读管理员 / 审批只写两道闸保护 |',
  );
  L.push('');
  L.push('**市场咨询 / 财务管理 / 权限管理** 三个板块的动作与接口码基本 1:1 对得上（少数为纯界面动作）');
  L.push('（`checkPermission(...)` / `requireActionCode(...)` 都能在代码里找到同名码），无需额外处理。');
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 五、维护说明');
  L.push('');
  L.push('| 想改什么 | 改哪里 | 之后跑什么 |');
  L.push('|---|---|---|');
  L.push('| 页面增删 | `perm/config/pageRegistry.ts` + 前端 `config/menu.ts`（两边同增同删） | `npm run seed:perm-pages` |');
  L.push('| 页面里的操作（按钮）增删改名 | `perm/config/permTree.ts` 的 `PAGE_ACTIONS` | `npm run sync:perm-tree:apply` |');
  L.push('| 职位授权 | 界面「权限管理 → 职位权限分配」 | 无需命令，保存即生效 |');
  L.push('| 新建职位时的默认页 | `perm/config/roleDefaultPages.ts` | `npm run seed:perm-tree:apply` |');
  L.push('');
  L.push('> `sync:perm-tree:apply` 是**增量同步**（只补新页面/新动作、改名的就地改、删掉的逻辑删），');
  L.push('> 不会像 `seed:perm-tree:apply` 那样重建整棵树、抹掉管理员手工勾过的差异。');
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 六、本轮（2026-10-26）改了什么');
  L.push('');
  L.push('| 改动 | 数量 | 说明 |');
  L.push('|---|---|---|');
  L.push('| 新增动作 | 18 | 界面上早有按钮、权限分配里勾不到的 |');
  L.push('| 动作改名 | 10 | 让名字与按钮文案一致（如「调换宿舍」→「编辑房间」） |');
  L.push('| 删除动作 | 5 | 页面上已无对应按钮的幽灵项：查看完整手机号、导出学生、转正式、导出统计、查看冻结明细 |');
  L.push('| 补职位授权 | 189 条 / 21 个职位 | 只给「原来就能看见这页」的职位，不越权发放 |');
  L.push('| 补基线 | 189 条 | 保证以后在界面上取消勾选能真正撤销 |');
  L.push('');
  L.push('**宿舍管理是重点**：6 → 13 个动作，按四个页签拆细 ——');
  L.push('');
  L.push('| 页签 | 动作 |');
  L.push('|---|---|');
  L.push('| 宿舍房间 | 新增房间 / 编辑房间 / 删除房间 / 分配床位（入住）/ 办理退宿 / 提交调宿·退宿申请 |');
  L.push('| 分派宿舍 | 分派宿舍（按班级） |');
  L.push('| 申请审批 | 审批调宿申请 / 驳回调宿申请 |');
  L.push('| 楼栋设置 | 新增楼栋 / 编辑楼栋 / 删除楼栋 |');
  L.push('');
  L.push('**教务老师**：权限点 16 → 22（你截图里对不上的那 6 个，补在这里）。');
  L.push('');
  L.push('> 备份：`backup_perm_tree_20261026.json`（权限四张表全量快照，出问题可回灌）。');
  L.push('');
  writeFileSync(resolve(dir, '全系统权限总表.md'), L.join('\n'), 'utf8');

  console.log('OK ->', resolve(dir, '全系统权限总表.md'));
  console.log('OK ->', resolve(dir, '权限总表.json'));
  console.log(
    `板块 ${data.stats.modCount} / 页面 ${data.stats.itemCount} / 动作 ${data.stats.actionCount} / 职位 ${data.roleCount}`,
  );
  await db.destroy();
}

main().catch(async (e) => {
  console.error('FAIL:', e?.message || e);
  await db.destroy().catch(() => {});
  process.exit(1);
});
