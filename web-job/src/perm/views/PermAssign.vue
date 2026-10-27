<script setup lang="ts">
/**
 * 职位权限分配
 *
 * DOM 结构 / class / 文案严格对齐原型《学管系统-权限体系高保真原型.html》：
 *   · 页面主体        → 原型第 2570~2631 行 renderAssign()
 *   · 权限树弹窗      → 原型第 1116~1307 行 openPermTree / renderPermTree / treeSave
 *   · 复制权限        → 原型第 2632~2658 行 copyPermFrom / doCopyPerm
 *   · 全量勾选可见页面  → 原型第 2659~2671 行 resetRolePerm（原「重置为预置」）
 *
 * ⚠️ 样式不写在这里：原型的 <style> 已整体移植到 src/styles/prototype.css 并在
 *    main.ts 全局引入，所以这里只产出与原型【同名同层级】的 DOM。
 * ⚠️ 权限映射 RolePermMap 的 value 是【动作编码】（如 'view'），界面要显示的中文
 *    必须按 actionCode 反查 actionName —— 否则界面上会出现英文编码。
 * ⚠️ 保存语义是【全量覆盖】：提交整棵树的勾选状态，后端先清空再插入。
 *    取消勾选 = 收回权限，系统没有「拒绝」这一层语义。
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import type { CSSProperties } from 'vue';
import type {
  AssignRoleItem,
  AssignScopeInfo,
  PermItem,
  PermModule,
  PermRoleDetail,
  PermTreeStats,
  RolePermMap,
} from 'shared-types/perm';
import { assignApi, roleApi } from '@/perm/api/perm';
import { useUserStore } from '@/perm/stores/user';
import ProtoDialog from '@/perm/components/ProtoDialog.vue';
import ProtoConfirm from '@/perm/components/ProtoConfirm.vue';
import PermItemDialog from '@/perm/components/PermItemDialog.vue';
import { toast } from '@/perm/utils/toast';
import { roleIconOf } from '@/perm/utils/roleIcon';

/* ============================================================
 * 0. 原型常量 / 小工具
 * ============================================================ */

/* ★ 2026-10-26：原来这里抄了一份原型的 ROLE_ICON（键是 R01~R15 短码），
 *   但开发版职位 id 是 UUID，`ROLE_ICON[id]` 永远查不到 → 本页所有职位图标
 *   都退化成同一个 👤。改为与「职位管理」共用 @/perm/utils/roleIcon（按 roleCode 映射）。 */
const roleIcon = roleIconOf;

/** 极简 HTML 转义（职位名 / 功能点名会进 v-html 的标题与明细） */
function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 原型 PKEY：模块key||功能点名 */
const keyOf = (moduleKey: string, itemName: string): string => `${moduleKey}||${itemName}`;

const codesOf = (it: PermItem): string[] => it.actions.map((a) => a.actionCode);

/** 去重合并多个动作编码数组 */
function union(...groups: string[][]): string[] {
  const out: string[] = [];
  groups.forEach((g) => {
    g.forEach((c) => {
      if (!out.includes(c)) out.push(c);
    });
  });
  return out;
}

/* ============================================================
 * 1. 页面数据
 * ============================================================ */

const loading = ref(false);
const saving = ref(false);

/**
 * ⭐ 2026-10-22：本页按钮按「职位权限分配」这个页面在各职位下被勾选的动作来显隐
 *
 *   perm:职位权限分配:editPerm     → 编辑该职位权限 / ＋ 配置权限
 *   perm:职位权限分配:copy         → 从其他职位复制
 *   perm:职位权限分配:resetPrefab  → 全量勾选可见页面
 *   perm:职位权限分配:addItem      → ＋ 新增权限
 *
 * 口径：系统管理员恒有（store 里给通配 perm:*）；其余职位看管理员勾了什么。
 *      —— 没勾的按钮**不渲染**；就算绕过前端调接口，后端用同一个码再拦一次（403）。
 */
const permUser = useUserStore();
const canEditPerm = computed(() => permUser.can('perm:职位权限分配:editPerm'));
const canCopy = computed(() => permUser.can('perm:职位权限分配:copy'));
const canResetPrefab = computed(() => permUser.can('perm:职位权限分配:resetPrefab'));
const canAddItem = computed(() => permUser.can('perm:职位权限分配:addItem'));

const roles = ref<AssignRoleItem[]>([]);
const currentRoleId = ref('');

const modules = ref<PermModule[]>([]);
/** 当前职位已保存的权限（key → 动作编码数组） */
const perms = ref<RolePermMap>({});
const treeStats = ref<PermTreeStats>({ modCount: 0, itemCount: 0, actionCount: 0 });

/** 职位详情（只为取「关联账号数」，与原型 roleUserCount 对应） */
const detail = ref<PermRoleDetail | null>(null);

const currentRole = computed(() => roles.value.find((r) => r.id === currentRoleId.value) || null);
const currentRoleName = computed(() => currentRole.value?.roleName || '');
const userCount = computed(() => detail.value?.userCount ?? 0);

/* ============================================================
 * 2. 树结构整理
 *
 * 接口是扁平结构：PermItem.parentItemName 指向父功能点名。
 * 原型是「模块 → 功能点 → 二级功能点 → 动作」四层 DOM，
 * 这里把扁平数据还原成「模块 → 功能点（含子项）→ 动作组」与原型一一对应。
 * ============================================================ */

interface TreeRow {
  /** 所属模块（子项 key 拼接要用） */
  mod: PermModule;
  /** 本行 key：模块key||功能点名 */
  key: string;
  item: PermItem;
  /** 二级功能点 */
  children: PermItem[];
  /** 本行（含子项）的全部动作编码，去重 */
  codes: string[];
  /**
   * ★ 2026-10-23：本职位能不能分配这一页
   *
   * 由「页面管理 → 职位」里该职位的页面授权决定（后端 assignable）。
   * false = 这一页该职位根本没有 → 勾不动，也不能勾（勾了保存也会被丢掉）。
   */
  assignable: boolean;
}

interface ModuleRow {
  mod: PermModule;
  rows: TreeRow[];
}

const treeRows = computed<ModuleRow[]>(() =>
  modules.value.map((m) => {
    // 只有「顶级功能点的名字」才算父级，避免三级数据互相吞掉
    const topNames = new Set(m.items.filter((x) => !x.parentItemName).map((x) => x.itemName));
    const tops = m.items.filter((x) => !x.parentItemName || !topNames.has(x.parentItemName));
    const rows: TreeRow[] = tops.map((it) => {
      const children = m.items.filter((x) => x.parentItemName === it.itemName);
      return {
        mod: m,
        key: keyOf(m.moduleKey, it.itemName),
        item: it,
        children,
        // ⚠️ 不做并集去重：父项自身 0 个动作 + 2 个子项各 3 个 = 6 个槽位，
        //    去重会让模块总数从 16 掉到 13，与原型 treeStats() 不符。
        codes: [...codesOf(it), ...children.flatMap((c) => codesOf(c))],
        // 未传 = 可以分配（兼容旧接口）；显式 false 才锁
        assignable: it.assignable !== false,
      };
    });
    return { mod: m, rows };
  }),
);

const childKey = (row: TreeRow, c: PermItem): string => keyOf(row.mod.moduleKey, c.itemName);

/* ============================================================
 * 2.5 可分配范围（★ 2026-10-23）
 *
 * 【为什么要这一层】
 *   「职位权限分配」的权限树列出的是**全系统所有页面**。原来每个页面都能勾，
 *   于是给咨询老师勾「审批中心」的动作后，页面管理里这个职位就多出审批中心
 *   —— 而审批中心是咨询经理专属。越权的口子就在这里。
 *
 * 【现在的口径】
 *   一个职位只能在自己**已经获得授权的页面**里分配动作（后端 assignable）。
 *   没授权的页面：灰掉 + 不可勾，并提示去「页面管理 → 职位」授权。
 *   想给职位加页面 → 只能在页面管理里加，分配树不再能"顺带"开页面。
 * ============================================================ */

const scopeInfo = ref<AssignScopeInfo | null>(null);
const scopeRestricted = computed(() => !!scopeInfo.value?.restricted);
/** 灰掉的页数（只算顶级功能点 = 页面） */
const lockedPageCount = computed(() =>
  treeRows.value.reduce((n, mr) => n + mr.rows.filter((r) => !r.assignable).length, 0),
);

/**
 * ★ 2026-10-23：弹窗里**只渲染该职位已获授权的页面**。
 *
 * 用户口径：三个页面（页面管理 / 职位权限分配面板 / 编辑权限弹窗）必须完全一致。
 * 未授权页面在弹窗里也不再「灰着摆一排」，直接不出现 ——
 * 需要知道少了哪些页，看提示条上的「另有 N 页未授权」即可。
 */
const treeRowsVisible = computed<ModuleRow[]>(() =>
  treeRows.value
    .map((mr) => ({ ...mr, rows: mr.rows.filter((r) => r.assignable) }))
    .filter((mr) => mr.rows.length > 0),
);

/** 实际渲染出来的页面数（= 该职位已获授权的页面数，提示条用） */
const allowedPageCount = computed(() =>
  treeRowsVisible.value.reduce((n, mr) => n + mr.rows.length, 0),
);

const assignableByKey = computed<Map<string, boolean>>(() => {
  const m = new Map<string, boolean>();
  treeRows.value.forEach((mr) => {
    mr.rows.forEach((row) => {
      m.set(row.key, row.assignable);
      // 二级功能点跟着父页面的授权走（页面级授权只到页面这一层）
      row.children.forEach((c) => m.set(childKey(row, c), row.assignable));
    });
  });
  return m;
});

/** 某个功能点（页面）能不能分配动作 */
const canAssign = (key: string): boolean => assignableByKey.value.get(key) !== false;

/** 勾到未授权页面时的统一提示 */
function warnLocked(): void {
  toast('该职位还没有这一页的授权，请先到「页面管理 → 职位」里给它授权', 'warn');
}

/** 右侧概览面板：原型 renderAssign() 里模块卡片的数据（用【已保存】的权限算） */
interface SummaryRow {
  key: string;
  name: string;
  remark?: string;
  acts: { code: string; label: string }[];
}
interface SummaryMod {
  key: string;
  icon: string;
  name: string;
  tagClass: string;
  hit: number;
  total: number;
  rows: SummaryRow[];
}

/** 按动作编码反查中文名（原型直接存中文名，开发版存编码，必须反查） */
function codeLabel(row: TreeRow, code: string): string {
  const all = [...row.item.actions, ...row.children.flatMap((c) => c.actions)];
  const hit = all.find((a) => a.actionCode === code);
  return hit ? hit.actionName : code;
}

/** 某行「已保存」的动作（本人 + 子项的并集去重） */
function savedSel(row: TreeRow): string[] {
  return union(
    perms.value[row.key] || [],
    ...row.children.map((c) => perms.value[childKey(row, c)] || []),
  );
}

const summary = computed<SummaryMod[]>(() =>
  treeRows.value
    .map((mr) => {
      /**
       * ★ 2026-10-23 用户口径：右栏概览是「**这个职位有什么**」的清单，
       *   不是全系统页面清单。所以只列该职位已获授权的页面（assignable），
       *   其余未授权页一个字都不显示 —— 与「页面管理 → 职位」的勾选结果对齐。
       *   （原来这里把未授权页也列成「○ 出勤管理 未授权」，看着像这职位有这页权限。）
       */
      const rows: SummaryRow[] = mr.rows
        .filter((row) => row.assignable)
        .map((row) => {
          const codes = savedSel(row);
          return {
            key: row.key,
            name: row.item.itemName,
            remark: row.item.remark,
            acts: codes.map((c) => ({ code: c, label: codeLabel(row, c) })),
          };
        });
      const hit = rows.filter((r) => r.acts.length > 0).length;
      // total 仍按该板块的**全部页面数**算，这样右上角显示「2/13」，
      // 与「页面管理」里同一职位的「2/13」完全一致（不是 2/2）。
      const total = mr.rows.length;
      return {
        key: mr.mod.moduleKey,
        icon: mr.mod.moduleIcon,
        name: mr.mod.moduleName,
        hit,
        total,
        tagClass: hit === 0 ? 'gy' : hit === total ? 'g' : 'w',
        rows,
      };
    })
    // 这个职位在某板块一页都没有 → 整个板块不列出
    .filter((m) => m.rows.length > 0),
);

/** 本职位已获授权的页面总数（统计条用，与「页面管理」的 6/32 对得上） */
const summaryPageCount = computed(() =>
  summary.value.reduce((n, m) => n + m.total, 0),
);

/* ============================================================
 * 3. 加载（查询走 assignApi / roleApi）
 * ============================================================ */

async function loadRoles(): Promise<void> {
  try {
    roles.value = await assignApi.roleList();
  } catch {
    /* 错误提示由 @/perm/api/request 统一弹出 */
  }
}

async function loadTree(roleId: string): Promise<void> {
  if (!roleId) return;
  loading.value = true;
  try {
    const res = await assignApi.tree(roleId);
    modules.value = res.modules;
    perms.value = { ...res.perms };
    treeStats.value = res.stats;
    scopeInfo.value = res.scope ?? null;
  } catch {
    /* 已提示 */
  } finally {
    loading.value = false;
  }
}

async function loadDetail(roleId: string): Promise<void> {
  if (!roleId) return;
  try {
    detail.value = await roleApi.detail(roleId);
  } catch {
    detail.value = null;
  }
}

/**
 * 右侧权限内容容器（★ 2026-10-23：右栏改为独立滚动，见 shared-ui.css 的 .split-page）
 * 换职位时把右栏滚回顶部 —— 否则会停在上一个职位滚到的位置，看着像「没切换」。
 */
const rgtEl = ref<HTMLElement | null>(null);
function resetRgtScroll(): void {
  nextTick(() => {
    if (rgtEl.value) rgtEl.value.scrollTop = 0;
  });
}

async function selectRole(roleId: string): Promise<void> {
  if (roleId === currentRoleId.value) return;
  currentRoleId.value = roleId;
  await Promise.all([loadTree(roleId), loadDetail(roleId)]);
  resetRgtScroll();
}

/** 保存 / 复制 / 重置后：职位列表 + 详细权限全部重取 */
async function refresh(): Promise<void> {
  await loadRoles();
  if (!currentRoleId.value && roles.value.length) currentRoleId.value = roles.value[0].id;
  await Promise.all([loadTree(currentRoleId.value), loadDetail(currentRoleId.value)]);
}

onMounted(async () => {
  // ⭐ 按钮判权依赖 store 里的 permissions，先确保拉过一次
  //   （路由守卫通常已拉过，这里只在缺权限时补一次，不会重复请求）
  if (!permUser.permissions.length) {
    await permUser.fetchProfile();
  }
  await loadRoles();
  if (roles.value.length) {
    currentRoleId.value = roles.value[0].id;
    await Promise.all([loadTree(currentRoleId.value), loadDetail(currentRoleId.value)]);
  }
});

/* ============================================================
 * 3.5 新增 / 管理权限点（★ 2026-10-19）
 *
 * 【要解决的事】预置权限树是「系统能力清单」，新部门（招生部）＋新职位
 *   （招生老师）常常需要清单里没有的功能点。这个弹窗让管理员自己加，
 *   加的格式与预置完全一致（板块 → 功能点 → 动作），存完立刻能勾选。
 *
 * ⚠️ 保存后必须重取权限树：模块里多了一个功能点，
 *    `treeRows` / 草稿的 key 集合都变了。
 * ⚠️ 如果权限树弹窗还开着（2026-10-20 起底栏的「新增权限」已删，
 *    但页头 / 工具条两个入口在权限树开着时仍点得到），
 *    要保留用户已经勾好的草稿，只给新功能点补空数组。
 * ============================================================ */

const itemAdminOpen = ref(false);

async function onItemSaved(): Promise<void> {
  if (!currentRoleId.value) return;
  const draftBefore = treeOpen.value ? { ...draft.value } : null;
  try {
    const res = await assignApi.tree(currentRoleId.value);
    modules.value = res.modules;
    perms.value = { ...res.perms };
    treeStats.value = res.stats;
    scopeInfo.value = res.scope ?? null;
    if (treeOpen.value && draftBefore) {
      const next: Record<string, string[]> = {};
      modules.value.forEach((m) =>
        m.items.forEach((it) => {
          const k = keyOf(m.moduleKey, it.itemName);
          next[k] = k in draftBefore ? [...draftBefore[k]] : [...(perms.value[k] || [])];
        }),
      );
      setDraft(next);
    }
    await loadRoles();
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 4. 权限树弹窗（原型 TREE_DRAFT / renderPermTree / treeAct / treeItem / treeMod）
 * ============================================================ */

const treeOpen = ref(false);
const treeMode = ref<'edit' | 'view'>('edit');
const treeView = computed(() => treeMode.value === 'view');

/** 草稿：key → 动作编码数组（只在弹窗内改动，点保存才落库） */
const draft = ref<Record<string, string[]>>({});
/** 各模块折叠态（原型 .ch.hide） */
const collapsed = ref<Record<string, boolean>>({});

const getDraft = (key: string): string[] => draft.value[key] || [];

function setDraft(next: Record<string, string[]>): void {
  draft.value = next;
}

/**
 * 某行「草稿中」的动作（自身 + 各子项，保留各自条目）
 * ⚠️ 不去重 —— 口径与 row.codes / RoleManage 的 rowCheckedCount 保持一致。
 */
function rowSel(row: TreeRow): string[] {
  return [
    ...getDraft(row.key),
    ...row.children.flatMap((c) => getDraft(childKey(row, c))),
  ];
}

/**
 * ★ 2026-10-23：模块内的统计只算**可分配**的页面。
 *   锁定的页面（该职位没有这一页的授权）不参与「全选 / 取消全选」的判断，
 *   否则会出现「明明全勾了，按钮还显示全选」的怪状态。
 */
const modAll = (mr: ModuleRow): number =>
  mr.rows.reduce((s, r) => s + (r.assignable ? r.codes.length : 0), 0);
const modGot = (mr: ModuleRow): number =>
  mr.rows.reduce((s, r) => s + (r.assignable ? rowSel(r).length : 0), 0);
const modOn = (mr: ModuleRow): boolean => {
  const all = modAll(mr);
  return all > 0 && modGot(mr) === all;
};

/** 底部「已勾选 N 项动作 · 覆盖 M 个模块」（只算可分配部分，与保存结果一致） */
const treeStat = computed(() => {
  let n = 0;
  let m = 0;
  treeRows.value.forEach((mr) => {
    let c = 0;
    mr.rows.forEach((r) => {
      if (r.assignable) c += rowSel(r).length;
    });
    if (c > 0) m++;
    n += c;
  });
  return { n, m };
});

const treeTitle = computed(() => {
  const name = esc(currentRoleName.value);
  return treeView.value
    ? `查看权限 · <span class="em">${name}</span> <span class="tag n">只读模式</span>`
    : `编辑权限 · <span class="em">${name}</span> <span class="tag n">改动需点击「保存」生效</span>`;
});

/** 只读模式下复选框不可点（原型用 pointerEvents:none 而不是 disabled，视觉不变） */
const roStyle = computed<CSSProperties | undefined>(() =>
  treeView.value ? { pointerEvents: 'none', cursor: 'default' } : undefined,
);

/** 原型 openPermTree() */
function openTree(mode: 'edit' | 'view'): void {
  if (!currentRoleId.value) {
    toast('请先在左侧选择一个职位', 'warn');
    return;
  }
  // 草稿只按「树上真实存在的功能点」铺满（原型 TREE_DRAFT 同样只由 PERM_TREE 生成），
  // 这样保存时是全量覆盖，树上已删除的历史权限会被自然清掉。
  const next: Record<string, string[]> = {};
  modules.value.forEach((m) =>
    m.items.forEach((it) => {
      const k = keyOf(m.moduleKey, it.itemName);
      next[k] = [...(perms.value[k] || [])];
    }),
  );
  setDraft(next);
  collapsed.value = {};
  treeMode.value = mode;
  treeOpen.value = true;
}

function toggleMod(moduleKey: string): void {
  collapsed.value = { ...collapsed.value, [moduleKey]: !collapsed.value[moduleKey] };
}

/** 原型 treeAct()：单个动作标签勾选 */
function toggleAct(key: string, code: string): void {
  if (treeView.value) return;
  // ★ 未授权页面（该职位在页面管理里没有这一页）不许勾，勾了也不会生效
  if (!canAssign(key)) {
    warnLocked();
    return;
  }
  const arr = [...getDraft(key)];
  const i = arr.indexOf(code);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(code);
  setDraft({ ...draft.value, [key]: arr });
}

/** 原型 treeItem()：整行勾选（本行 + 全部子项一起） */
function onItemChange(row: TreeRow, e: Event): void {
  if (treeView.value) return;
  if (!row.assignable) {
    // disabled 的复选框正常点不中，这里兜住键盘/脚本触发的情况
    (e.target as HTMLInputElement).checked = rowSel(row).length > 0;
    warnLocked();
    return;
  }
  const on = (e.target as HTMLInputElement).checked;
  const next = { ...draft.value };
  next[row.key] = on ? codesOf(row.item) : [];
  row.children.forEach((c) => (next[childKey(row, c)] = on ? codesOf(c) : []));
  setDraft(next);
}

/** 子功能点整行勾选（原型 treeItem() 的 '::' 分支） */
function onChildChange(row: TreeRow, c: PermItem, e: Event): void {
  if (treeView.value) return;
  const k = childKey(row, c);
  if (!canAssign(k)) {
    (e.target as HTMLInputElement).checked = getDraft(k).length > 0;
    warnLocked();
    return;
  }
  const on = (e.target as HTMLInputElement).checked;
  setDraft({ ...draft.value, [childKey(row, c)]: on ? codesOf(c) : [] });
}

/**
 * 原型 treeMod()：模块整行勾选（on=true 全勾 / false 全清）
 * ★ 2026-10-20：原来是绑在模块左侧方块上的 `@change`（要靠 `e.target.checked`），
 *   用户删掉方块改成右侧文字之后就没有 checkbox 事件了，改成直接收一个布尔值。
 */
function setModAll(mr: ModuleRow, on: boolean): void {
  if (treeView.value) return;
  if (modAll(mr) === 0) {
    warnLocked();
    return;
  }
  const next = { ...draft.value };
  mr.rows.forEach((row) => {
    // 锁定的页面不动（它们根本不该被写入）
    if (!row.assignable) return;
    next[row.key] = on ? codesOf(row.item) : [];
    row.children.forEach((c) => (next[childKey(row, c)] = on ? codesOf(c) : []));
  });
  setDraft(next);
}

/** ◆ 模块行右侧「全选 / 取消全选」文字：按当前状态切换本模块的全部动作 */
function toggleModAll(mr: ModuleRow): void {
  setModAll(mr, !modOn(mr));
}

/**
 * 原型 treeSelectAll()：底部「全选」——把树里全部模块的动作一次勾满。
 * ★ 2026-10-20：底部那个叫「取消」的按钮（treeSelectAll(false)，取消全部勾选）
 *   已按用户要求删掉 —— 它和「一键清空」功能重复，还和右侧真正关闭弹窗的
 *   「取消」撞名，一屏两个「取消」让人分不清。清空请走「一键清空」（带二次确认）。
 */
function treeSelectAll(): void {
  if (treeView.value) return;
  const next = { ...draft.value };
  treeRows.value.forEach((mr) =>
    mr.rows.forEach((row) => {
      // ★ 未授权页面跳过：它们不在这个职位的可分配范围里
      if (!row.assignable) return;
      next[row.key] = codesOf(row.item);
      row.children.forEach((c) => (next[childKey(row, c)] = codesOf(c)));
    }),
  );
  setDraft(next);
  const skipped = lockedPageCount.value;
  toast(
    skipped
      ? `已全选可分配的权限；${skipped} 个页面该职位未获授权，已跳过`
      : '已全选全部权限',
    'warn',
  );
}

/* ---- 一键清空（原型 treeClear：先确认，再清空草稿，仍需点保存才生效） ---- */
const clearOpen = ref(false);

function treeClearAsk(): void {
  if (treeView.value) return;
  clearOpen.value = true;
}

function doTreeClear(): void {
  clearOpen.value = false;
  const next = { ...draft.value };
  Object.keys(next).forEach((k) => (next[k] = []));
  setDraft(next);
  toast('已清空，请点击保存生效', 'warn');
}

/* ---- 保存（原型 treeSave：确认 → 落库） ---- */
const saveOpen = ref(false);

function treeSaveAsk(): void {
  saveOpen.value = true;
}

const saveDetail = computed<{ k: string; v: string }[]>(() => [
  { k: '职位', v: esc(currentRoleName.value) },
  { k: '勾选动作', v: `<b>${treeStat.value.n}</b> 项` },
  { k: '影响账号', v: `<b>${userCount.value}</b> 个账号` },
]);

async function doSaveTree(): Promise<void> {
  saveOpen.value = false;
  if (!currentRoleId.value) return;
  saving.value = true;
  try {
    const payload: RolePermMap = {};
    Object.keys(draft.value).forEach((k) => {
      // ★ 未授权页面不提交（后端也会再过滤一次，这里让 payload 干净）
      if (!canAssign(k)) return;
      const v = draft.value[k] || [];
      if (v.length) payload[k] = [...v];
    });
    const res = await assignApi.save(currentRoleId.value, payload);
    treeOpen.value = false;
    const dropped = res.dropped || 0;
    toast(
      dropped
        ? `已保存 ${res.permCount} 项权限；${dropped} 个未授权页面被忽略（${(res.droppedItems || []).join('、')}）`
        : `已保存 ${res.permCount} 项权限，${userCount.value} 个账号已生效`,
      dropped ? 'warn' : 'ok',
    );
    await refresh();
  } catch {
    /* 已提示 */
  } finally {
    saving.value = false;
  }
}

/* ============================================================
 * 5. 从其他职位复制（原型 copyPermFrom / doCopyPerm）
 * ============================================================ */

const copyOpen = ref(false);
const copySourceId = ref('');
const copyConfirmOpen = ref(false);

const copyCandidates = computed(() => roles.value.filter((r) => r.id !== currentRoleId.value));
const copySource = computed(() => roles.value.find((r) => r.id === copySourceId.value) || null);

const copyTitle = computed(
  () => `从其他职位复制权限 <span class="tag n">目标：${esc(currentRoleName.value)}</span>`,
);

const copyDetail = computed<{ k: string; v: string }[]>(() => {
  const s = copySource.value;
  const t = currentRole.value;
  if (!s || !t) return [];
  return [
    { k: '来源职位', v: `${esc(s.roleName)} · ${s.permCount} 项` },
    { k: '目标职位', v: `${esc(t.roleName)} · 现有 ${t.permCount} 项` },
    { k: '复制后', v: `目标职位权限变为 <b>${s.permCount}</b> 项` },
    { k: '影响账号', v: `${userCount.value} 人` },
  ];
});

function openCopy(): void {
  if (!currentRoleId.value) {
    toast('请先在左侧选择一个职位', 'warn');
    return;
  }
  copySourceId.value = '';
  copyOpen.value = true;
}

function pickCopySource(id: string): void {
  copySourceId.value = id;
  copyConfirmOpen.value = true;
}

async function doCopy(): Promise<void> {
  copyConfirmOpen.value = false;
  if (!currentRoleId.value || !copySourceId.value) return;
  const targetName = currentRoleName.value;
  try {
    const res = await assignApi.copy(currentRoleId.value, copySourceId.value);
    copyOpen.value = false;
    const dropped = res.dropped || 0;
    toast(
      dropped
        ? `已复制 ${res.permCount} 项权限到「${targetName}」；${dropped} 个页面目标职位未获授权，已跳过`
        : `已从「${res.sourceRoleName}」复制 ${res.permCount} 项权限到「${targetName}」`,
      dropped ? 'warn' : 'ok',
    );
    await refresh();
  } catch {
    /* 已提示 */
  }
}

/* ============================================================
 * 6. 全量勾选可见页面（原型 resetRolePerm）
 * ============================================================ */

const resetOpen = ref(false);

const resetDetail = computed<{ k: string; v: string }[]>(() => [
  { k: '当前权限', v: `${currentRole.value?.permCount ?? 0} 项` },
  { k: '重置后', v: '恢复全部模块权限' },
  { k: '影响账号', v: `${userCount.value} 人` },
]);

async function doReset(): Promise<void> {
  resetOpen.value = false;
  if (!currentRoleId.value) return;
  const name = currentRoleName.value;
  try {
    await assignApi.reset(currentRoleId.value, 'full');
    toast(`已把「${name}」可见页面里的动作全部勾上`, 'warn');
    await refresh();
  } catch {
    /* 已提示 */
  }
}

/* ★ 2026-10-20 按用户要求删除「查看账号」入口：
     本页是"配置职位权限"的地方，看这个职位下有哪些账号属于「部门管理 / 账号管理」的职责，
     夹在「配置权限 / 从其他职位复制」旁边容易被误点。
     入口、弹窗、状态、openRoleUsers() 一并删除（无其他调用方）。
     关联账号数仍在职位信息行「{{ currentRole.deptName }} · 关联账号 {{ userCount }} 人」展示。 */
</script>

<template>
  <div class="split-page">
    <!-- ==================== 主体（原型 #page-assign） ==================== -->
    <!-- ★ 2026-10-23：根节点加 .split-page —— 整页锁高，左职位列表固定、右权限内容自己滚 -->
    <div class="card">
      <div class="card-h">
        <div class="t"><span class="bar"></span>职位权限分配</div>
        <div class="r">
          <!-- ★ 2026-10-26：按钮变多后这行说明在 1520 宽下被挤成两行；
               缩短文案并禁止换行，保持工具条单行 -->
          <span class="desc" style="white-space: nowrap">选职位 → 勾权限 → 保存</span>
          <button class="btn" type="button" @click="openTree('view')">全屏查看</button>
          <!-- ⭐ 2026-10-22：以下三个按钮按「职位权限分配」页被勾选的动作显隐 -->
          <button v-if="canResetPrefab" class="btn" type="button" @click="resetOpen = true">
            全量勾选可见页面
          </button>
          <button v-if="canAddItem" class="btn wn" type="button" @click="itemAdminOpen = true">
            ＋ 新增权限
          </button>
          <button v-if="canEditPerm" class="btn pri" type="button" @click="openTree('edit')">
            编辑该职位权限
          </button>
        </div>
      </div>

      <div class="card-b">
        <div class="split">
          <!-- ---------- 左：职位列表 ---------- -->
          <div class="lft">
            <div class="desc" style="padding: 4px 6px 7px">职位列表（{{ roles.length }}）</div>
            <div v-if="loading && !roles.length" class="empty">
              <div class="ic">⏳</div>
              加载中…
            </div>
            <div v-else-if="!roles.length" class="empty">
              <div class="ic">🎭</div>
              暂无职位
            </div>
            <template v-else>
              <div
                v-for="r in roles"
                :key="r.id"
                class="rl-item"
                :class="{ on: r.id === currentRoleId }"
                @click="selectRole(r.id)"
              >
                <span>{{ roleIcon(r) }} {{ r.roleName }}</span><span class="cnt">{{ r.permCount }}</span>
              </div>
            </template>
          </div>

          <!-- ---------- 右：权限概览 ---------- -->
          <div ref="rgtEl" class="rgt">
            <template v-if="currentRole">
              <div
                style="
                  display: flex;
                  align-items: center;
                  gap: 10px;
                  margin-bottom: 12px;
                  padding-bottom: 11px;
                  border-bottom: 1px solid var(--line2);
                "
              >
                <div
                  style="
                    width: 36px;
                    height: 36px;
                    border-radius: 10px;
                    background: var(--brand-l);
                    display: grid;
                    place-items: center;
                    font-size: 17px;
                  "
                >
                  {{ roleIcon(currentRole) }}
                </div>
                <div>
                  <div style="font-weight: 600; font-size: 14px">
                    {{ currentRole.roleName }}
                  </div>
                  <div class="desc">{{ currentRole.deptName }} · 关联账号 {{ userCount }} 人</div>
                </div>
                <div style="margin-left: auto; text-align: right">
                  <div style="font-size: 19px; font-weight: 700; color: var(--brand)">
                    {{ currentRole.permCount }}
                  </div>
                  <div class="desc">已授权动作</div>
                </div>
              </div>

              <div class="perm-tools">
                <button v-if="canEditPerm" class="btn xs" type="button" @click="openTree('edit')">
                  ＋ 配置权限
                </button>
                <button v-if="canCopy" class="btn xs" type="button" @click="openCopy">
                  从其他职位复制
                </button>
                <!-- ★ 2026-10-20 按用户要求删掉这里的「查看账号」按钮；
                     同轮删掉「＋ 新增权限」：本页顶部工具条（全量勾选可见页面 / ＋ 新增权限 / 编辑该职位权限）已有入口，
                     这个位置离「配置权限」太近，容易点错成"加权限点"而不是"配权限"。 -->
                <!-- ★ 2026-10-23：统计口径改为「本职位」。
                     原来写「共 5 个模块 / 146 个权限点」是**全系统**的总量，
                     而这个职位其实只有 2 个模块 / 6 个页面 —— 用户看到
                     "5 个模块"会以为财务、权限、教学也在里面（正是误会来源）。
                     全系统总量仍然保留在括号里，方便对照。 -->
                <span class="cl">
                  本职位 {{ summary.length }} 个板块 / {{ summaryPageCount }} 个页面
                  <span class="desc" style="margin-left: 6px">
                    （全系统 {{ treeStats.modCount }} 个板块 / {{ treeStats.itemCount }} 个页面）
                  </span>
                </span>
              </div>

              <div v-if="loading" class="empty">
                <div class="ic">⏳</div>
                加载中…
              </div>
              <div v-else-if="!summary.length" class="empty">
                <div class="ic">🗂️</div>
                <template v-if="scopeRestricted">
                  该职位还没有任何页面授权，请先到「页面管理 → 职位」里给它勾上页面
                </template>
                <template v-else>暂无权限数据</template>
              </div>

              <template v-else>
                <div
                  v-for="m in summary"
                  :key="m.key"
                  style="border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px; overflow: hidden"
                >
                  <div style="padding: 8px 11px; background: #FAF7F4; display: flex; align-items: center; gap: 8px">
                    <span style="font-size: 13px">{{ m.icon }}</span>
                    <b style="font-size: 12.5px">{{ m.name }}</b>
                    <span class="tag" :class="m.tagClass">{{ m.hit }}/{{ m.total }}</span>
                    <span class="lk" style="margin-left: auto" @click="openTree(canEditPerm ? 'edit' : 'view')">
                      {{ canEditPerm ? '编辑' : '查看' }}
                    </span>
                  </div>
                  <div style="padding: 9px 11px">
                    <div
                      v-for="row in m.rows"
                      :key="row.key"
                      style="display: flex; gap: 8px; margin-bottom: 6px; align-items: flex-start"
                    >
                      <div
                        style="min-width: 132px; font-size: 12.5px"
                        :style="{ color: row.acts.length ? 'var(--tx)' : 'var(--tx3)' }"
                      >
                        {{ row.acts.length ? '●' : '○' }} {{ row.name }}
                      </div>
                      <div style="flex: 1">
                        <template v-if="row.acts.length">
                          <span
                            v-for="a in row.acts"
                            :key="a.code"
                            class="tag b"
                            style="margin: 0 3px 3px 0"
                          >
                            {{ a.label }}
                          </span>
                        </template>
                        <span v-else class="desc">未授权</span>
                      </div>
                    </div>
                    <div v-for="row in m.rows.filter((x) => x.remark)" :key="`n-${row.key}`" class="desc">
                      ※ {{ row.remark }}
                    </div>
                  </div>
                </div>
              </template>
            </template>

            <div v-else class="empty">
              <div class="ic">👈</div>
              请在左侧选择一个职位
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 权限树弹窗（原型 openPermTree） ==================== -->
    <ProtoDialog v-model="treeOpen" :title="treeTitle" size="lg">
      <div class="notice i mb12">
        ℹ
        <div>
          <b>两种勾选方式：</b>① 点功能点左侧的<b>方框</b>可一次性勾选该功能点的全部动作；
          ② 也可<b>单独点击下方任意一个动作标签</b>（如「查看」「新建」「编辑」），自由组合勾选其中一项或几项。
          勾选后点<b>保存</b>即生效。
        </div>
      </div>

      <!-- ★ 2026-10-23：可分配范围提示（未授权页面不出现，避免"这职位好像有这页"的错觉） -->
      <div v-if="scopeRestricted && lockedPageCount > 0" class="notice w mb12">
        🔒
        <div>
          <b>这里只显示「{{ currentRoleName }}」已经获授权的页面（{{ allowedPageCount }} 个）。</b>
          另有 {{ lockedPageCount }} 个页面该职位还没有授权，<b>已隐藏</b>。
          本页决定的是「页面里能点哪些按钮」，页面本身归「页面管理」管。
          要给「{{ currentRoleName }}」增加页面，请先到
          <a
            href="#/perm/page"
            target="_blank"
            style="color: var(--brand); text-decoration: underline; font-weight: 600"
          >页面管理 → 职位</a>
          里给它勾上，再回来配置具体操作。
        </div>
      </div>

      <div>
        <div class="tree">
          <div v-for="mr in treeRowsVisible" :key="mr.mod.moduleKey" class="mod">
            <div class="n">
              <span class="cx" @click="toggleMod(mr.mod.moduleKey)">
                {{ collapsed[mr.mod.moduleKey] ? '▸' : '▾' }}
              </span>
              <span class="nm" @click="toggleMod(mr.mod.moduleKey)">
                {{ mr.mod.moduleIcon }} {{ mr.mod.moduleName }}
              </span>
              <!-- ★ 2026-10-20 按用户要求：模块标题左侧那个「整模块全选」方块已删除，
                   改成右侧的文字「全选 / 取消全选」（点一下切换本模块的全部动作）。
                   只读模式（查看权限）下不渲染 —— 点了也不能改，摆着只会误导。 -->
              <span
                v-if="!treeView && modAll(mr) > 0"
                class="mod-all"
                :class="{ on: modOn(mr) }"
                @click="toggleModAll(mr)"
              >
                {{ modOn(mr) ? '取消全选' : '全选' }}
              </span>
              <span class="cnt">{{ modGot(mr) }}/{{ modAll(mr) }}</span>
            </div>

            <div class="ch" :class="{ hide: collapsed[mr.mod.moduleKey] }">
              <template v-for="row in mr.rows" :key="row.key">
                <div
                  class="n"
                  :class="{ locked: !row.assignable }"
                  :style="row.children.length ? { fontWeight: 600 } : undefined"
                >
                  <input
                    type="checkbox"
                    :checked="rowSel(row).length > 0"
                    :disabled="!row.assignable"
                    :style="roStyle"
                    @change="onItemChange(row, $event)"
                  />
                  <span class="nm">{{ row.item.itemName }}</span>
                  <span v-if="row.item.isCustom" class="tag b" style="flex: none; margin-left: 4px">自建</span>
                  <!-- ★ 2026-10-23：未授权页面已整行不渲染，这里不再需要「🔒 未授权」标记 -->
                  <span class="cnt">{{ rowSel(row).length }}/{{ row.codes.length }}</span>
                </div>

                <div v-if="row.item.actions.length" class="acts-g">
                  <span
                    v-for="a in row.item.actions"
                    :key="a.actionCode"
                    class="act"
                    :class="{
                      on: getDraft(row.key).includes(a.actionCode),
                      ro: treeView,
                      off: !row.assignable,
                    }"
                    @click="toggleAct(row.key, a.actionCode)"
                  >
                    <i class="bx"></i>{{ a.actionName }}
                  </span>
                </div>

                <template v-for="c in row.children" :key="childKey(row, c)">
                  <div class="n" :class="{ locked: !row.assignable }" style="padding-left: 18px">
                    <input
                      type="checkbox"
                      :checked="getDraft(childKey(row, c)).length > 0"
                      :disabled="!row.assignable"
                      :style="roStyle"
                      @change="onChildChange(row, c, $event)"
                    />
                    <span class="nm">{{ c.itemName }}</span>
                    <span class="cnt">{{ getDraft(childKey(row, c)).length }}/{{ c.actions.length }}</span>
                  </div>
                  <div class="acts-g">
                    <span
                      v-for="a in c.actions"
                      :key="a.actionCode"
                      class="act"
                      :class="{
                        on: getDraft(childKey(row, c)).includes(a.actionCode),
                        ro: treeView,
                        off: !row.assignable,
                      }"
                      @click="toggleAct(childKey(row, c), a.actionCode)"
                    >
                      <i class="bx"></i>{{ a.actionName }}
                    </span>
                  </div>
                </template>

                <div
                  v-if="row.item.remark"
                  class="desc"
                  style="padding-left: 22px; margin-bottom: 5px"
                >
                  ※ {{ row.item.remark }}
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="lft">
          已勾选 <b style="color: var(--brand)">{{ treeStat.n }}</b> 项动作 · 覆盖
          <b style="color: var(--brand)">{{ treeStat.m }}</b> 个模块
        </div>
        <template v-if="!treeView">
          <!-- ★ 2026-10-20 按用户要求，底栏从 6 个按钮收敛到 4 个：
               · 删掉「＋ 新增权限」—— 页头/工具条已有同一入口，弹窗里再放一个容易
                 在半勾选状态下误开另一个弹窗，改权限点的场景也不该发生在配权限时。
               · 删掉原来那个叫「取消」的（treeSelectAll(false)，取消全部勾选）——
                 它和「一键清空」功能重复，又和右侧真正关闭弹窗的「取消」撞名。
               现在：全选 / 一键清空 / 取消（关弹窗）/ 保存权限 -->
          <button class="btn" type="button" @click="treeSelectAll()">全选</button>
          <button class="btn" type="button" @click="treeClearAsk">一键清空</button>
          <button class="btn" type="button" @click="treeOpen = false">取消</button>
          <button class="btn pri" type="button" :disabled="saving" @click="treeSaveAsk">保存权限</button>
        </template>
        <button v-else class="btn" type="button" @click="treeOpen = false">关闭</button>
      </template>
    </ProtoDialog>

    <!-- ==================== 从其他职位复制（原型 copyPermFrom） ==================== -->
    <ProtoDialog v-model="copyOpen" :title="copyTitle" size="md">
      <div class="notice w mb12">⚠<div>复制将<b>覆盖</b>目标职位当前的权限配置，请谨慎操作。</div></div>
      <div style="border: 1px solid var(--line); border-radius: 9px; padding: 9px; max-height: 320px; overflow-y: auto">
        <div v-for="r in copyCandidates" :key="r.id" class="rl-item" @click="pickCopySource(r.id)">
          <span>{{ roleIcon(r) }} {{ r.roleName }}</span>
          <span class="cnt">{{ r.permCount }} 项权限</span>
        </div>
        <div v-if="!copyCandidates.length" class="empty">
          <div class="ic">🎭</div>
          没有可复制的其他职位
        </div>
      </div>
      <div class="notice i mt12">ℹ<div>复制后两职位权限完全一致，后续可再单独微调。</div></div>

      <template #footer>
        <button class="btn" type="button" @click="copyOpen = false">取消</button>
      </template>
    </ProtoDialog>

    <!-- ★ 2026-10-20 「查看账号」弹窗整块删除（入口已删，无其他调用方） -->

    <!-- ==================== 确认框（原型 confirmDlg） ==================== -->
    <ProtoConfirm
      v-model="copyConfirmOpen"
      title="复制权限确认"
      icon="📋"
      :msg="`确认将「${copySource?.roleName || ''}」的权限复制到「${currentRoleName}」？`"
      :detail="copyDetail"
      warn="目标职位原有权限将被完全覆盖。"
      ok-text="确认复制"
      @ok="doCopy"
    />

    <ProtoConfirm
      v-model="resetOpen"
      title="全量勾选可见页面"
      icon="↩"
      icon-bg="var(--warn-l)"
      :msg="`确认把「${currentRoleName}」在已授权页面里的全部动作都勾上？`"
      desc="只在该职位<b>已经能看到的页面</b>范围内勾选，不会额外开放新页面。适合页面授权刚调整完、想把动作一次补全的场景。"
      :detail="resetDetail"
      warn="勾选后该职位在这些页面里拥有全部操作权限（含删除、导出等）；原有的自定义调整会被覆盖且无法撤销。"
      ok-text="确认勾选"
      ok-class="wn"
      @ok="doReset"
    />

    <ProtoConfirm
      v-model="clearOpen"
      title="清空权限"
      icon="🗑"
      icon-bg="var(--dg-l)"
      msg="确认清空该职位的全部权限？"
      :desc="`当前共勾选 <b>${treeStat.n}</b> 项动作，清空后该职位将没有任何功能可用。`"
      warn="清空后职位下的账号登录将看不到任何菜单，请谨慎操作。"
      ok-text="确认清空"
      ok-class="dg"
      @ok="doTreeClear"
    />

    <ProtoConfirm
      v-model="saveOpen"
      title="保存权限配置"
      icon="💾"
      :msg="`确认保存 ${currentRoleName} 的权限配置？`"
      :detail="saveDetail"
      tip="保存后立即生效，相关账号下次刷新页面即可看到新菜单。"
      ok-text="确认保存"
      @ok="doSaveTree"
    />

    <!-- ==================== 新增/维护权限点（自建权限） ==================== -->
    <PermItemDialog v-model="itemAdminOpen" @saved="onItemSaved" />
  </div>
</template>
