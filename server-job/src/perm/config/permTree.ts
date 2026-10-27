/**
 * 权限树定义（职位权限分配 → 板块 / 页面 / 操作）
 *
 * ============================================================
 * 【★ 2026-10-22 重写：权限树 1:1 对齐「系统现在的每一个页面」】
 *
 * 旧版权限树是原型期的 8 个板块（market / teach / train / job / acad / fin /
 * approve / perm）、53 个功能点（「预到校名单」「咨询测试」「试学学费名单」…），
 * 与现在的系统对不上：
 *   · 侧栏现在只有 5 个板块（工作台 / 市场咨询 / 财务管理 / 权限管理 / 教学管理），
 *     其中「教学管理」是 job / edu / class / class-jh 四板块合并后的 13 页；
 *   · 「预到校名单」「咨询测试」「保险费名单」「餐费住宿费缴费名单」这些页面
 *     在系统里已经没有独立入口了。
 *
 * 现在这份定义的做法是【以页面为功能点】：
 *   板块（module） = 页面管理的板块（= 侧栏分组）= 5 个
 *   功能点（item） = 该板块下的一个真实页面（= 侧栏菜单项）= 32 个
 *   动作（action） = 该页面里真实存在的操作 / 按钮
 *
 * 为什么这样最省事也最不容易走偏：
 *   ① 页面清单不在这里重抄一遍 —— 直接来自 `pageRegistry.ts`（页面管理的数据源），
 *      两边永远不会对不上（同一个 path、同一个页面名）；
 *   ② 「功能点 = 页面」之后，页面可见性判定变成一行：该职位在这个页面上
 *      有没有勾到动作（任一个即可见），不再需要「功能点 → menuKey」的换算表；
 *   ③ 每个动作都带 `ops`（该操作对应的后端操作码），权限树与各模块的
 *      `checkPermission('class:student:add')` / `consultPermGate` 直接对得上，
 *      取消勾选后接口真的会 403（见 utils/roleActionOverlay.ts）。
 *
 * ⚠️ 改这里必须同步的三处：
 *   · 页面增删 → `pageRegistry.ts`（两边必须同增同删，否则页面管理/侧栏对不上）
 *   · 动作增删 → 该页面的前端按钮（勾了却点不到的按钮没有意义）
 *   · `ops` 写错 → 界面上能勾，但接口不认（表现为「勾了还是 403」）
 * ============================================================
 */

import { PAGE_REGISTRY, type RegistryPage } from './pageRegistry';

/** 动作基类（与 t_perm_menu_action.base_action 同值） */
export const BASE = {
  VIEW: 1,
  ADD: 2,
  EDIT: 3,
  DEL: 4,
  APPROVE: 5,
  EXPORT: 6,
} as const;

/** 基类中文名（界面上按它分组/着色） */
export const BASE_ACTION_NAME: Record<number, string> = {
  1: '查看',
  2: '新增',
  3: '编辑',
  4: '删除',
  5: '审批',
  6: '导出',
};

export interface PermActionDef {
  /** 动作编码（同一功能点内唯一；也用于拼 `模块:功能点:动作` 权限串） */
  code: string;
  /** 动作中文名（界面显示，必须与页面上的按钮文案对得上） */
  name: string;
  /** 动作基类 1view 2add 3edit 4del 5approve 6export */
  base: number;
  /**
   * 该动作对应的**后端操作码**（可多个）
   *
   * ⚠️ 只有在 `roleActionOverlay.ts` 里登记过的操作码才会被
   *    `resolveActionWithOverlay` 拿去判接口；这里填的码必须是各模块
   *    `checkPermission(...)` / `CONSULT_WRITE_PERM` / `JOB_WRITE_PERM`
   *    里真实出现过的，否则「取消勾选」不会让接口 403。
   * ⚠️ 留空 = 纯前端动作（如「查看明细」抽屉），只影响按钮显隐。
   */
  ops?: string[];
}

export interface PermPageDef {
  /** 页面 key（与 pageRegistry 的一致，仅用于代码里定位，不入库） */
  key: string;
  /** 功能点名 = 页面名 = 侧栏菜单名（入库到 item_name） */
  name: string;
  /** 前端路由（入库到 remark 的展示与页面级判定） */
  path: string;
  /** 该页面对应的页面权限码（页面级可见性用） */
  pageCodes: string[];
  /** 一句话说明（界面副标题） */
  remark?: string;
  actions: PermActionDef[];
}

export interface PermBoardDef {
  moduleKey: string;
  name: string;
  icon: string;
  desc: string;
  sort: number;
  pages: PermPageDef[];
}

/* ============================================================
 * 1. 各页面的操作清单
 *
 * 命名约定：
 *   · 第一个动作恒为 view（查看）—— 页面级可见性的判定就靠它；
 *   · 多个页面上的同名操作沿用同一套 code（add / edit / del / export /
 *     approve / reject），界面读起来一致；
 *   · 页面特有的操作（分配、领取、转正式、末班…）用语义化 camelCase。
 *
 * 清单来源：逐页核对页面源码里的按钮与接口（2026-10-22 首次全量核对；
 *          2026-10-26 二次核对：补宿舍管理四个页签的动作、删掉页面上已不存在的按钮）。
 *
 * 【★ 2026-10-26 二次核对改了什么】
 *   · 宿舍管理 6 → 13 个动作：按「宿舍房间 / 分派宿舍 / 申请审批 / 楼栋设置」
 *     四个页签拆细，补上「删除房间」「分配床位（入住）」「分派宿舍（按班级）」
 *     「驳回调宿申请」「新增/编辑/删除楼栋」—— 这些按钮界面上早就有了，
 *     权限分配里却勾不到（用户 2026-10-26 反馈的正是这一条）。
 *   · 删掉 4 个「幽灵动作」（页面上早已没有对应按钮）：
 *       查看完整手机号（consult）、导出学生 + 转正式（学生档案，转正已改由咨询侧发起）、
 *       导出统计（数据统计页无导出按钮）、查看冻结明细（冻结名单页无明细）。
 *   · 补上 6 个「有按钮没权限项」的动作：补缴学费、查看收款凭证（咨询）、
 *       查看部门详情、分配职位、导出单条日志（权限管理）、标记已就业（学生档案）、
 *       阶段方案设计 / 标记待就业·已就业（班级管理）、提交申请（退费、休学退学）。
 *   · 名称与按钮文案对齐：编辑档案→完善档案、调换宿舍→编辑房间、
 *     发起催费→登记缴费（上传凭证）、结业转就业→升就业/结业转就业。
 *
 *   现口径：5 板块 / 32 页面 / 161 个动作。
 *
 * 【★ 2026-10-26 三次核对：费用标准新增「催费设置」页签】
 *   财务管理 / 费用标准 从 3 个动作 → 5 个动作（多出「查看催费名单」「保存催费设置」）。
 *   ⚠️ 以后凡是页面里**加了页签 / 加了会写库的按钮**，都要回来补一个动作，
 *      否则会出现「界面上有、职位权限分配里勾不到」的缺口（本次用户报的正是这一条）。
 * ============================================================ */

const A = {
  view: (ops?: string[]): PermActionDef => ({ code: 'view', name: '查看', base: BASE.VIEW, ops }),
  add: (name = '新增', ops?: string[]): PermActionDef => ({ code: 'add', name, base: BASE.ADD, ops }),
  edit: (name = '编辑', ops?: string[]): PermActionDef => ({ code: 'edit', name, base: BASE.EDIT, ops }),
  del: (name = '删除', ops?: string[]): PermActionDef => ({ code: 'del', name, base: BASE.DEL, ops }),
  approve: (name = '审批', ops?: string[]): PermActionDef => ({
    code: 'approve',
    name,
    base: BASE.APPROVE,
    ops,
  }),
  reject: (name = '驳回', ops?: string[]): PermActionDef => ({
    code: 'reject',
    name,
    base: BASE.APPROVE,
    ops,
  }),
  export: (name = '导出', ops?: string[]): PermActionDef => ({
    code: 'export',
    name,
    base: BASE.EXPORT,
    ops,
  }),
  act: (code: string, name: string, base: number, ops?: string[]): PermActionDef => ({
    code,
    name,
    base,
    ops,
  }),
};

/** `板块key/页面key` → 该页面的操作清单 */
const PAGE_ACTIONS: Record<string, PermActionDef[]> = {
  /* ==================== 1. 工作台 ==================== */
  'workbench/dashboard': [A.view(), A.act('todo', '处理待办', BASE.EDIT)],

  /* ==================== 2. 市场咨询 ==================== */
  'consult/student': [
    A.view(),
    A.add('新建学生', ['consult:student:add']),
    A.act('edit', '完善档案', BASE.EDIT, ['consult:student:edit']),
    A.act('assign', '分配咨询老师', BASE.EDIT, ['consult:preArrival:assign']),
    A.act('claim', '领取学生', BASE.EDIT, ['consult:preArrival:assign']),
    A.act('interview', '录入面试结果', BASE.ADD, ['consult:test:interview']),
    A.act('enroll', '分配班级', BASE.EDIT, ['consult:student:edit']),
    A.act('toFormal', '转正式', BASE.EDIT, ['consult:fee:formal']),
    A.act('supplement', '补缴学费', BASE.ADD, ['consult:fee:trial', 'consult:fee:formal']),
    A.act('cancelNotEnrolled', '取消未报名', BASE.DEL, ['consult:preArrival:absent']),
    A.act('loss', '标记流失', BASE.EDIT, ['consult:student:edit']),
    A.act('follow', '新增跟进记录', BASE.ADD, ['consult:follow:add']),
  ],
  'consult/fee': [
    A.view(),
    A.act('createTrial', '发起收费·试学费', BASE.ADD, ['consult:fee:trial']),
    A.act('createFormal', '发起收费·正式学费', BASE.ADD, ['consult:fee:formal']),
    A.act('discount', '优惠减免（改实收金额）', BASE.EDIT, ['consult:fee:discount']),
    A.act('supplement', '补费', BASE.ADD, ['consult:fee:trial', 'consult:fee:formal']),
    A.act('uploadVoucher', '上传缴费凭证', BASE.ADD, ['consult:fee:trial', 'consult:fee:formal']),
    A.act('resubmit', '重新提交', BASE.EDIT, ['consult:fee:trial', 'consult:fee:formal']),
    A.act('void', '作废收款单', BASE.DEL),
    A.act('viewPlan', '查看分期计划', BASE.VIEW),
    A.act('viewVoucher', '查看收款凭证', BASE.VIEW),
  ],
  'consult/approve': [
    A.view(),
    A.act('approve', '批准', BASE.APPROVE, ['consult:refund:approve']),
    A.act('reject', '驳回', BASE.APPROVE, ['consult:refund:approve']),
    A.act('detail', '查看审批明细', BASE.VIEW),
  ],
  'consult/refund': [
    A.view(),
    A.act('apply', '发起退费', BASE.ADD, ['consult:refund:apply']),
    A.act('approve', '批准', BASE.APPROVE, ['consult:refund:approve']),
    A.act('reject', '驳回', BASE.APPROVE, ['consult:refund:approve']),
    A.act('detail', '查看退费明细', BASE.VIEW),
  ],
  'consult/loss': [
    A.view(),
    A.act('detail', '查看流失详情', BASE.VIEW),
    A.act('follow', '填写后续跟进计划', BASE.EDIT, ['consult:follow:add']),
  ],

  /* ==================== 3. 财务管理 ==================== */
  'finance/overview': [A.view(), A.act('drill', '下钻查看名单', BASE.VIEW)],
  'finance/fee': [
    A.view(),
    A.act('verify', '核对缴费单', BASE.EDIT, ['finance:fee:verify']),
    A.act('batchVerify', '批量财务核对', BASE.EDIT, ['finance:fee:verify']),
    A.act('reject', '打回缴费单', BASE.APPROVE, ['finance:fee:verify']),
    A.act('viewVoucher', '查看缴费凭证', BASE.VIEW),
  ],
  'finance/freeze': [
    A.view(),
    A.act('unfreeze', '解冻', BASE.EDIT, ['finance:freeze:manage']),
  ],
  'finance/refund': [
    A.view(),
    A.act('pay', '确认出款', BASE.APPROVE, ['finance:refund:pay']),
    A.act('reject', '驳回', BASE.APPROVE, ['finance:refund:pay']),
    A.act('detail', '查看退费明细', BASE.VIEW),
  ],
  'finance/bill': [A.view(), A.act('viewVoucher', '查看凭证', BASE.VIEW)],
  /*
   * ★ 2026-10-26 补：费用标准页新增「催费设置」页签（提前天数 + 催费名单）
   *
   *   页面上多了内容，权限树却没跟着加动作 —— 管理员在「职位权限分配」里
   *   根本勾不到「催费设置」，而财务账号进来却已经能看见、能改（页签写死显示）。
   *   现在按页签拆成两个动作，与接口同码：
   *     查看催费名单  → finance:urge:view   （GET 提前天数 / 名单）
   *     保存催费设置  → finance:urge:manage （POST 提前天数）
   */
  'finance/standard': [
    A.view(),
    A.add('新增标准', ['finance:standard:manage']),
    A.edit('修改金额', ['finance:standard:manage']),
    A.act('urgeView', '查看催费名单', BASE.VIEW, ['finance:urge:view']),
    A.act('urgeSet', '保存催费设置', BASE.EDIT, ['finance:urge:manage']),
  ],

  /* ==================== 4. 权限管理 ==================== */
  'perm/overview': [
    A.view(),
    A.act('viewLog', '查看全部操作日志', BASE.VIEW),
    A.act('exportLog', '导出日志', BASE.EXPORT, ['perm:操作日志:export']),
  ],
  'perm/dept': [
    A.view(),
    A.add('新建部门', ['perm:部门管理:add']),
    A.edit('编辑部门', ['perm:部门管理:edit']),
    A.del('删除部门', ['perm:部门管理:del']),
    A.act('detail', '查看部门详情', BASE.VIEW),
  ],
  'perm/role': [
    A.view(),
    A.add('新建职位', ['perm:职位管理:add']),
    A.edit('编辑职位', ['perm:职位管理:edit']),
    A.del('删除职位', ['perm:职位管理:del']),
    A.act('toggleStatus', '停用/启用职位', BASE.DEL, ['perm:职位管理:edit']),
    A.act('import', '批量导入职位', BASE.ADD, ['perm:职位管理:add']),
    A.export('导出职位', ['perm:职位管理:export']),
  ],
  'perm/user': [
    A.view(),
    A.add('新建账号', ['perm:账号管理:add']),
    A.edit('编辑账号', ['perm:账号管理:edit']),
    A.act('resetPwd', '重置密码', BASE.DEL, ['perm:账号管理:resetPwd']),
    A.act('toggleStatus', '停用/启用账号', BASE.DEL, ['perm:账号管理:edit']),
    A.act('import', '批量导入账号', BASE.ADD, ['perm:账号管理:import']),
    A.act('assignRole', '分配职位', BASE.EDIT, ['perm:账号管理:edit']),
    A.export('导出账号', ['perm:账号管理:export']),
  ],
  'perm/assign': [
    A.view(),
    A.act('editPerm', '编辑职位权限', BASE.EDIT, ['perm:职位权限分配:editPerm']),
    A.act('copy', '从其他职位复制', BASE.EDIT, ['perm:职位权限分配:copy']),
    A.act('resetPrefab', '全量勾选可见页面', BASE.EDIT, ['perm:职位权限分配:resetPrefab']),
    A.act('addItem', '新增权限点', BASE.ADD, ['perm:职位权限分配:addItem']),
  ],
  'perm/page': [
    A.view(),
    A.act('edit', '启用/停用页面', BASE.EDIT, ['perm:页面管理:edit']),
    A.act('restore', '恢复默认页面', BASE.EDIT, ['perm:页面管理:edit']),
  ],
  'perm/log': [
    A.view(),
    A.export('导出日志', ['perm:操作日志:export']),
    A.act('exportOne', '导出单条日志', BASE.EXPORT, ['perm:操作日志:export']),
  ],

  /* ==================== 5. 教学管理（13 页） ==================== */
  'teach/student': [
    A.view(),
    A.add('新增学生', ['class:student:add']),
    A.edit('编辑学生', ['class:student:edit']),
    A.del('删除学生', ['class:student:delete']),
    A.act('upgrade', '升实训/升云', BASE.EDIT, ['class:student:promote']),
    A.act('quit', '发起退学', BASE.EDIT, ['job:leave:apply']),
    A.act('markEmployed', '标记已就业', BASE.EDIT, ['job:empArchive:edit']),
  ],
  'teach/class': [
    A.view(),
    A.add('新增班级', ['class:classInfo:add']),
    A.edit('编辑班级', ['class:classInfo:edit', 'job:class:edit']),
    A.del('删除班级', ['class:classInfo:delete', 'job:class:delete']),
    A.act('handover', '交接班主任/教员', BASE.EDIT, ['class:handover:add']),
    A.act('scheme', '阶段方案设计', BASE.EDIT, ['class:setting:edit', 'classjh:setting:view']),
    A.act('promote', '阶段推进/升实训', BASE.EDIT, ['class:student:promote']),
    A.act('graduate', '升就业/结业转就业', BASE.EDIT, ['job:class:graduate']),
    A.act('employStatus', '标记待就业/已就业', BASE.EDIT, ['job:class:suspend', 'job:class:graduate']),
  ],
  'teach/consult': [
    A.view(),
    A.act('receive', '接收学员', BASE.APPROVE, ['class:consult:approve']),
    A.reject('驳回学员', ['class:consult:approve']),
  ],
  'teach/attendance': [
    A.view(),
    A.act('add', '录入出勤', BASE.ADD, ['class:attendance:add', 'job:attendance:add']),
    A.act('edit', '修改出勤', BASE.EDIT, ['class:attendance:add']),
    A.export('导出出勤', ['class:attendance:export']),
  ],
  'teach/exam': [
    A.view(),
    A.add('新建考试', ['class:exam:add', 'job:exam:add']),
    A.edit('编辑考试', ['class:exam:edit', 'job:exam:edit']),
    A.del('删除考试', ['class:exam:delete', 'job:exam:delete']),
  ],
  'teach/score': [
    A.view(),
    A.act('add', '录入成绩', BASE.ADD, ['class:grade:add', 'class:examScore:add']),
    A.edit('修改成绩', ['class:grade:edit', 'job:exam-score:edit']),
    A.act('promote', '升班/末班', BASE.EDIT, ['class:repeat:add', 'job:exam-score:repeat']),
  ],
  /*
   * ★ 2026-10-26 重写：宿舍管理是「一页四个页签」，权限动作按页签拆细
   *
   *   宿舍房间：新增房间 / 编辑房间 / 删除房间 / 床位（入住、退宿）/ 调宿·退宿申请
   *   分派宿舍：按班级分派（allocate）
   *   申请审批：通过 / 驳回
   *   楼栋设置：新增楼栋 / 编辑楼栋 / 删除楼栋
   *
   *   旧版把「新增房间 / 分派宿舍」合成一个动作、没有「删除房间」「分配床位」
   *   也没有「楼栋设置」三个动作 —— 界面上能点的按钮在权限分配里根本勾不到。
   */
  'teach/dorm': [
    A.view(),
    A.add('新增房间', ['class:dorm:add', 'job:dorm:add']),
    A.edit('编辑房间', ['class:dorm:edit', 'job:dorm:edit']),
    A.del('删除房间', ['class:dorm:edit', 'job:dorm:edit']),
    A.act('bed', '分配床位（入住）', BASE.EDIT, ['class:dorm:edit', 'job:dorm:edit']),
    A.act('checkout', '办理退宿', BASE.EDIT, ['class:dorm:edit', 'job:dorm:edit']),
    A.act('apply', '提交调宿/退宿申请', BASE.ADD, [
      'class:dormApply:add',
      'class:dorm:apply',
      'job:dorm:apply',
    ]),
    A.act('allocate', '分派宿舍（按班级）', BASE.EDIT, ['class:dorm:edit', 'job:dorm:edit']),
    A.act('approve', '审批调宿申请', BASE.APPROVE, ['class:dormApply:approve', 'job:dorm:approve']),
    A.reject('驳回调宿申请', ['class:dormApply:approve', 'job:dorm:approve']),
    A.act('buildAdd', '新增楼栋', BASE.ADD),
    A.act('buildEdit', '编辑楼栋', BASE.EDIT),
    A.act('buildDel', '删除楼栋', BASE.DEL),
  ],
  'teach/fee': [
    A.view(),
    A.act('urge', '登记缴费（上传凭证）', BASE.ADD, ['class:fee:add', 'job:feeCall:add']),
    A.act('transferFinance', '批量转交财务', BASE.EDIT, ['job:feeCall:handle']),
    A.export('导出催费名单', ['class:fee:export']),
  ],
  'teach/refund': [
    A.view(),
    A.act('apply', '发起退费', BASE.ADD, ['class:refund:add', 'job:refund:apply']),
    A.act('submit', '提交申请', BASE.EDIT, ['class:refund:edit', 'job:refund:apply']),
    A.act('approve', '审批通过', BASE.APPROVE, ['class:refund:approve', 'job:refund:approve']),
    A.reject('驳回退费', ['class:refund:approve', 'job:refund:approve']),
    A.act('withdraw', '撤回申请', BASE.EDIT, ['class:refund:edit']),
    A.act('pay', '登记出款', BASE.APPROVE, ['job:refund:approve']),
  ],
  'teach/approval': [
    A.view(),
    A.act('apply', '发起休学/退学申请', BASE.ADD, ['job:leave:apply', 'class:flow:add']),
    A.act('submit', '提交申请', BASE.EDIT, ['class:flow:add', 'job:leave:apply']),
    A.act('approve', '审批通过', BASE.APPROVE, ['job:leave:approve', 'class:flow:approve']),
    A.reject('驳回申请', ['job:leave:approve', 'class:flow:approve']),
    A.act('withdraw', '撤回申请', BASE.EDIT, ['class:flow:add']),
  ],
  'teach/employmentLog': [
    A.view(['job:employmentLog:view']),
    A.add('新建就业日志', ['job:employmentLog:add']),
    A.edit('编辑就业日志', ['job:employmentLog:edit']),
    A.del('删除就业日志', ['job:employmentLog:edit']),
  ],
  'teach/review': [
    A.view(['job:review:view']),
    A.add('新建复盘', ['job:review:add']),
    A.edit('编辑复盘', ['job:review:edit']),
    A.act('uploadAudio', '上传复盘录音', BASE.ADD, ['job:review:add']),
    A.del('删除复盘', ['job:review:edit']),
  ],
  'teach/statistics': [
    A.view(['job:statistics:view']),
    A.act('setTarget', '设置 KPI 目标', BASE.EDIT),
  ],
};

/* ============================================================
 * 2. 组装：板块（页面管理 5 个） × 页面（32 个）
 *
 * ⚠️ 页面清单、名字、路径、权限码**一律取自 pageRegistry**，
 *    本文件只提供「这一页有哪些操作」。这样：
 *      · 页面管理里新增/删除一页 → 权限树自动跟着变（不用改两处）
 *      · 页面改名 → 权限树跟着改名（界面立即一致）
 * ============================================================ */

/** 注册表里没登记操作的页面（理论上不该出现）也至少给一个「查看」 */
function actionsOf(moduleKey: string, page: RegistryPage): PermActionDef[] {
  return PAGE_ACTIONS[`${moduleKey}/${page.key}`] || [A.view()];
}

export const PERM_TREE: PermBoardDef[] = PAGE_REGISTRY.map((board) => ({
  moduleKey: board.moduleKey,
  name: board.moduleName,
  icon: board.moduleIcon,
  desc: board.moduleDesc,
  sort: board.sortNo,
  pages: board.pages.map((p) => ({
    key: p.key,
    name: p.title,
    path: p.path,
    pageCodes: p.pageCodes?.length ? p.pageCodes : p.pageCode ? [p.pageCode] : [],
    remark: p.remark,
    actions: actionsOf(board.moduleKey, p),
  })),
}));

/** 全部页面（拍平） */
export const PERM_TREE_PAGES: Array<PermPageDef & { moduleKey: string; moduleName: string }> =
  PERM_TREE.flatMap((b) =>
    b.pages.map((p) => ({ ...p, moduleKey: b.moduleKey, moduleName: b.name })),
  );

/** `板块key||页面名` → 页面定义 */
export const PERM_PAGE_BY_ITEM: Map<string, PermPageDef & { moduleKey: string }> = new Map(
  PERM_TREE_PAGES.map((p) => [`${p.moduleKey}||${p.name}`, p]),
);

/** 路径 → 页面定义（页面级可见性/守卫用） */
export const PERM_PAGE_BY_PATH: Map<string, PermPageDef & { moduleKey: string }> = new Map(
  PERM_TREE_PAGES.map((p) => [p.path, p]),
);

/** 统计：板块数 / 功能点数 / 动作数 */
export const PERM_TREE_STATS = {
  modCount: PERM_TREE.length,
  itemCount: PERM_TREE.reduce((n, b) => n + b.pages.length, 0),
  actionCount: PERM_TREE.reduce(
    (n, b) => n + b.pages.reduce((m, p) => m + p.actions.length, 0),
    0,
  ),
};

/**
 * 动作 → 操作码映射（给 roleActionOverlay 用）
 *
 * 形状与旧的 `PERM_POINT_TO_ACTION_CODES` 完全一致：
 *   { '模块key||页面名': { 动作编码: [操作码...] } }
 * 只收录**登记了 ops** 的动作（没 ops 的动作是纯前端动作，不影响接口）。
 */
export const PERM_TREE_ACTION_OPS: Record<string, Record<string, string[]>> = (() => {
  const out: Record<string, Record<string, string[]>> = {};
  for (const board of PERM_TREE) {
    for (const page of board.pages) {
      const itemKey = `${board.moduleKey}||${page.name}`;
      for (const act of page.actions) {
        if (!act.ops?.length) continue;
        const bucket = out[itemKey] || (out[itemKey] = {});
        bucket[act.code] = act.ops;
      }
    }
  }
  return out;
})();
