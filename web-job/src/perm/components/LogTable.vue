<script setup lang="ts">
/**
 * 操作日志列表（可复用组件）
 *
 * ============================================================
 * 【为什么抽成组件】
 *   2026-10-26 之前，「权限总览 → 最近操作动态」用的是**另一套取数**：
 *   后端 `ORDER BY log_time DESC LIMIT 6`，前端再 `slice(0, 6)`。
 *   日志量上来后（单日 300+ 条），那 6 条必然全落在同一天，
 *   用户在总览看到的是「只有当天的几条」，而「操作日志」页却能翻
 *   1900+ 条历史 —— 两处老是对不上，反复被当成 bug 反馈。
 *
 *   现在两边**共用本组件**：同一接口（/api/perm/log/list）、
 *   同一套列、同一个分页器、同一个详情弹窗。
 *   口径不可能再分叉，也不存在「摘要版 / 完整版」的区别。
 *
 * ============================================================
 * 【★ 2026-10-26 第二轮：两页只差「时间范围」，不是两套实现】
 *   用户定稿的口径：
 *     · 权限总览 → 最近操作动态：**只显示「今天」的操作记录**
 *       （今天是 10-26 就只出 10-26 的；跨到 10-27 自动只出 10-27 的）
 *     · 操作日志 → 操作日志：**全系统、全时间、全账号**的完整留痕
 *
 *   实现方式：同一个组件，只多一个 `today-only` 开关。
 *   打开后 load() 会给请求补上 startDate = endDate = 今天，
 *   后端 /log/list 本来就支持这两个参数（见 server-job/.../log.route.ts 的
 *   applyFilters），不需要新接口，也不会出现「前端过滤 vs 后端分页」打架
 *   —— 过滤发生在 SQL 里，分页与「共 N 条」都是今日口径的真实值。
 *
 *   ⚠️ 「今天」按**浏览器本地时间**算，不交给数据库 CURDATE()：
 *      用户看到的日期文案与实际查出来的记录必须是同一天。
 *      若部署到别的时区的服务器，CURDATE() 可能比用户早/晚一天，
 *      那才会出现「标题写 10-27、列表却是 10-26」的怪事。
 *
 * ============================================================
 * 【用法】
 *   操作日志页（全时间）：
 *     <LogTable ref="tableRef" title="操作日志" />
 *     —— 还可通过 ref 调 applyFilter('fail') 与上方 KPI 5 卡联动
 *
 *   权限总览（只今天）：
 *     <LogTable title="最近操作动态" :show-export="false" compact today-only>
 *       <template #actions>…「查看全部日志」按钮…</template>
 *     </LogTable>
 *
 * ============================================================
 * 【固定的口径（别改）】
 *   · 日志只读：组件不提供任何增删改入口；
 *   · 筛选全部走服务端（本系统日志在库里，不是原型那种前端数组过滤）；
 *   · 关键字输入 320ms 防抖，模拟原型的 oninput 即时过滤体验。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import type { PermLog } from 'shared-types/perm';
import { exportApi, logApi } from '@/perm/api/perm';
import { useOptionStore } from '@/perm/stores/option';
import ProtoDialog from '@/perm/components/ProtoDialog.vue';
import { toast } from '@/perm/utils/toast';

const props = withDefaults(
  defineProps<{
    /** 卡片标题（总览里叫「最近操作动态」，日志页叫「操作日志」） */
    title?: string;
    /** 是否显示「导出」按钮（总览页不显示，避免和日志页重复） */
    showExport?: boolean;
    /** 紧凑模式：藏起「操作人」下拉，给更窄的容器省宽度 */
    compact?: boolean;
    /**
     * 只查「今天」的记录（权限总览的「最近操作动态」用）
     *
     * · false（默认）= 全时间：操作日志页要的就是完整留痕；
     * · true = 给请求补 startDate = endDate = 今天（浏览器本地日期），
     *   跨天后再进页面会自动跟着变成新的一天，无需手动清缓存。
     */
    todayOnly?: boolean;
    /** 每页条数 */
    pageSize?: number;
  }>(),
  { title: '操作日志', showExport: true, compact: false, todayOnly: false, pageSize: 10 },
);

/** 可选项字典走 Pinia 缓存：整个会话只请求一次 */
const optionStore = useOptionStore();

/* ============================================================
 * 一、数据加载
 * ============================================================ */

const loading = ref(false);
const list = ref<PermLog[]>([]);
const total = ref(0);

const query = reactive({
  page: 1,
  size: props.pageSize,
  keyword: '',
  moduleName: '',
  actionType: '',
  result: '',
  operatorName: '',
  startDate: '',
  endDate: '',
});

/** 服务端分页 → 总页数 */
const totalPages = computed<number>(() => Math.max(1, Math.ceil(total.value / query.size)));

/* ------------------------------------------------------------
 * 「今天」的口径（todayOnly 模式用）
 *
 * 只取浏览器本地日期，不碰数据库 NOW()/CURDATE()：
 * 标题上写的是哪天，查的就必须是哪天，两边必须同源。
 * 日期用本地拼接而不是 toISOString().slice(0,10) ——
 * 后者是 UTC，东八区 00:00~08:00 会退回「昨天」，正好错一整天。
 * ------------------------------------------------------------ */
function localToday(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本次查询实际采用的「今天」，用于卡片副标题（与数据同源） */
const todayLabel = ref<string>(localToday());

/**
 * 操作人下拉候选
 *
 * 全系统留痕后日志里会出现几十个账号，「当前页去重」凑出来的下拉选不全，
 * 所以由后端 `/log/operators` 一次给出全量（按操作次数倒序）。
 */
const operatorNames = ref<string[]>([]);

async function loadOperators(): Promise<void> {
  try {
    const rows = await logApi.operators();
    operatorNames.value = rows.map((r) => r.name);
  } catch {
    /* 字典加载失败不影响列表，下拉退化为「全部操作人」 */
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    /* 每次加载都重新算「今天」：页面开着跨过 00:00 再翻页，
     * 也只会查到新的一天，不会把昨天的记录带出来。 */
    todayLabel.value = localToday();

    const params: Record<string, any> = { ...query };
    if (props.todayOnly) {
      /* 起止都卡在同一天。上限也要给，否则库里万一存在「未来时间」的
       * 脏数据（手工导数/时区错乱）会混进「今天」。 */
      params.startDate = todayLabel.value;
      params.endDate = todayLabel.value;
    }

    const res = await logApi.list(params);
    list.value = res.list;
    total.value = res.total;
  } catch {
    /* 错误已在 request 拦截器里弹过提示 */
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await optionStore.load();
  await Promise.all([load(), props.compact ? Promise.resolve() : loadOperators()]);
});

/** 查询（页码回到第 1 页） */
function search(): void {
  query.page = 1;
  load();
}

/** 关键字输入防抖：原型是 oninput 即时过滤，开发版每次都要请求，加 320ms 防抖 */
let kwTimer: number | undefined;
function onKeywordInput(): void {
  window.clearTimeout(kwTimer);
  kwTimer = window.setTimeout(() => search(), 320);
}

/** 重置筛选 */
function resetQuery(): void {
  Object.assign(query, {
    page: 1,
    keyword: '',
    moduleName: '',
    actionType: '',
    result: '',
    operatorName: '',
    startDate: '',
    endDate: '',
  });
  load();
  toast('已重置筛选', 'warn');
}

function gotoPage(p: number): void {
  if (p < 1 || p > totalPages.value || p === query.page) return;
  query.page = p;
  load();
}

/**
 * 供外部（日志页 KPI 5 卡）联动筛选
 *
 * 原型里点 KPI 卡就是改 LOG_FILTER，这里等价地改 query 后重新查询。
 */
function applyFilter(key: 'all' | 'success' | 'fail' | 'login' | 'approve'): void {
  query.page = 1;
  query.result = '';
  query.actionType = '';
  if (key === 'success') query.result = '成功';
  if (key === 'fail') query.result = '失败';
  if (key === 'login') query.actionType = '登录';
  if (key === 'approve') query.actionType = '审批';
  load();
}

defineExpose({ applyFilter, reload: load });

/* ============================================================
 * 二、表格单元渲染
 * ============================================================ */

/** 操作类型标签配色：新增 g / 删除 d / 审批 w / 修改 b / 登录·登出 p / 其余 n */
function actionTagClass(a: string): string {
  if (a === '新增') return 'tag g';
  if (a === '删除') return 'tag d';
  if (a === '审批') return 'tag w';
  if (a === '修改') return 'tag b';
  if (a === '登录' || a === '登出') return 'tag p';
  return 'tag n';
}

const isFail = (r: string): boolean => r === '失败';

/**
 * 失败原因只取「人能看懂的那半句」
 *
 * ★ 2026-10-26 用户反馈「操作日志里出现一堆字母和符号」：
 *   后端 after_value 的格式是 `操作失败：<原因> | 参数 {"id":"4d4b4781-…"}`，
 *   参数段是给开发排查用的（里面全是 UUID 和字段名），界面上没必要出现。
 *   这里只保留原因；原始值仍完整存在库里，需要排查时查日志详情接口即可。
 */
function failReason(s?: string): string {
  return String(s || '')
    .split(' | 参数 ')[0]
    .trim();
}

/**
 * 所属职位 → 胶囊数组
 * 后端已把编码解析成中文（多职位用「、」分隔），前端只负责拆开渲染。
 */
function roleList(raw?: string): string[] {
  return (raw || '')
    .split('、')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ============================================================
 * 三、日志详情（原型 openLogDetail）
 * ============================================================ */

const detailOpen = ref(false);
const cur = ref<PermLog | null>(null);

/** 极简 HTML 转义（弹窗标题拼接了日志字段，避免把数据当标签渲染） */
function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

const detailTitle = computed(
  () => `日志详情 · <span class="em">${esc(cur.value?.actionType ?? '')}</span>`,
);

async function openDetail(row: PermLog): Promise<void> {
  cur.value = row;
  detailOpen.value = true;
  try {
    cur.value = await logApi.detail(row.id);
  } catch {
    /* 用列表行兜底展示，与原型一致 */
  }
}

const exportOneOpen = ref(false);

function doExportOne(): void {
  exportOneOpen.value = false;
  detailOpen.value = false;
  toast('日志已导出为 PDF');
}

function copyLogId(): void {
  const id = cur.value?.id ?? '';
  try {
    void navigator.clipboard.writeText(id);
  } catch {
    /* 非安全上下文下不可用，忽略即可 */
  }
  detailOpen.value = false;
  toast(`已复制日志编号 ${id}`);
}

/* ============================================================
 * 四、导出（走导出接口，不分页）
 * ============================================================ */

async function doExport(): Promise<void> {
  const hasFilter =
    query.keyword || query.moduleName || query.actionType || query.result || query.operatorName;
  try {
    const res = await exportApi.do({
      resource: 'log',
      scope: hasFilter ? '全部筛选结果' : '全部数据',
      format: 'excel',
      query: { ...query, page: 1, size: 100 },
    });
    toast(`已导出 ${res.total} 条日志`);
  } catch {
    /* 已提示 */
  }
}
</script>

<template>
  <div class="card">
    <div class="card-h">
      <div class="t">
        <span class="bar"></span>{{ props.title }}
        <!-- 总览页只出当天：一枚「今日」胶囊说清范围，
             具体日期放 title 提示里（标题行太长会把右侧筛选条挤到第二行） -->
        <span
          v-if="props.todayOnly"
          class="tag gy"
          :title="`仅显示今天（${todayLabel}）的操作记录，历史记录请到「操作日志」查看`"
        >
          今日 {{ todayLabel }}
        </span>
        <span class="sub">共 {{ total }} 条</span>
      </div>
      <!-- 筛选条顺序与原型一致：搜索 → 全部模块 → 全部操作类型 → 全部操作人 → 全部结果 → 重置 → 导出 -->
      <div class="r">
        <slot name="actions" />
        <input
          v-model="query.keyword"
          class="inp"
          placeholder="搜索操作人 / 操作对象"
          style="width: 190px"
          @input="onKeywordInput"
          @keyup.enter="search"
        />
        <select v-model="query.moduleName" class="inp" @change="search">
          <option value="">全部模块</option>
          <option v-for="m in optionStore.logModules" :key="m.value" :value="m.value">
            {{ m.label }}
          </option>
        </select>
        <select v-model="query.actionType" class="inp" @change="search">
          <option value="">全部操作类型</option>
          <option v-for="a in optionStore.logActionTypes" :key="a.value" :value="a.value">
            {{ a.label }}
          </option>
        </select>
        <select v-if="!props.compact" v-model="query.operatorName" class="inp" @change="search">
          <option value="">全部操作人</option>
          <option v-for="b in operatorNames" :key="b" :value="b">{{ b }}</option>
        </select>
        <select v-model="query.result" class="inp" @change="search">
          <option value="">全部结果</option>
          <option v-for="r in optionStore.logResults" :key="r.value" :value="r.value">
            {{ r.label }}
          </option>
        </select>
        <button class="btn" type="button" @click="resetQuery">重置</button>
        <button v-if="props.showExport" class="btn" type="button" @click="doExport">导出</button>
      </div>
    </div>

    <div class="card-b p0">
      <div class="tb-wrap">
        <table class="tb">
          <thead>
            <tr>
              <!-- 8 列：本系统任何界面都不展示 IP（2026-10-26 按用户要求删除） -->
              <th style="width: 150px">操作时间</th>
              <th style="width: 110px">操作人</th>
              <th style="width: 140px">所属职位</th>
              <th style="width: 110px">操作模块</th>
              <th style="width: 90px">操作类型</th>
              <th style="width: 200px">操作对象</th>
              <th style="width: 90px">结果</th>
              <th style="width: 90px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in list" :key="l.id" style="cursor: pointer" @click="openDetail(l)">
              <td class="desc num">{{ l.logTime }}</td>
              <td><b>{{ l.operatorName }}</b></td>
              <td>
                <!-- `.tags` 用 -8px 外边距把胶囊文字顶回与表头对齐（见 shared-ui.css 注释） -->
                <span v-if="roleList(l.operatorRole).length" class="tags">
                  <span v-for="n in roleList(l.operatorRole)" :key="n" class="tag b">{{ n }}</span>
                </span>
                <span v-else class="desc">—</span>
              </td>
              <td>{{ l.moduleName }}</td>
              <td>
                <span :class="actionTagClass(l.actionType)">{{ l.actionType }}</span>
              </td>
              <td>{{ l.targetObj || '—' }}</td>
              <td>
                <span v-if="!isFail(l.result)" class="tag g">成功</span>
                <span v-else class="tag d">失败</span>
              </td>
              <td>
                <span class="lk" @click.stop="openDetail(l)">详情</span>
              </td>
            </tr>
            <tr v-if="!list.length">
              <td colspan="8">
                <div class="empty">
                  <div class="ic">📜</div>
                  <!-- 空态要说清是「今天没有」还是「没有符合筛选的」，
                       否则总览页显示 0 条时用户会以为日志丢了 -->
                  {{
                    loading
                      ? '加载中…'
                      : props.todayOnly && todayLabel
                        ? `今天（${todayLabel}）还没有操作记录`
                        : '没有符合条件的日志'
                  }}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 服务端分页条（开发版必须保留；用原型风格的 .desc + .btn.sm） -->
      <div
        class="desc"
        style="display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 12px"
      >
        <span>共 {{ total }} 条 · 第 {{ query.page }} / {{ totalPages }} 页</span>
        <button
          class="btn sm"
          type="button"
          :disabled="query.page <= 1"
          @click="gotoPage(query.page - 1)"
        >
          上一页
        </button>
        <button
          class="btn sm"
          type="button"
          :disabled="query.page >= totalPages"
          @click="gotoPage(query.page + 1)"
        >
          下一页
        </button>
      </div>
    </div>

    <!-- ==================== 日志详情 ==================== -->
    <ProtoDialog v-model="detailOpen" :title="detailTitle" size="md">
      <template v-if="cur">
        <div class="fm" style="grid-template-columns: repeat(2, 1fr)">
          <div class="f"><label>日志编号</label><div class="num">{{ cur.id }}</div></div>
          <div class="f"><label>操作时间</label><div class="num">{{ cur.logTime }}</div></div>
          <div class="f"><label>操作人</label><div><b>{{ cur.operatorName }}</b></div></div>
          <div class="f">
            <label>所属职位</label>
            <div>
              <span v-if="cur.operatorRole" class="tag b">{{ cur.operatorRole }}</span>
              <span v-else class="desc">—</span>
            </div>
          </div>
          <div class="f"><label>操作模块</label><div>{{ cur.moduleName }}</div></div>
          <div class="f"><label>操作类型</label><div>{{ cur.actionType }}</div></div>
          <!-- 详情只保留「谁 · 什么时候 · 哪个模块 · 什么类型的操作 · 结果如何」 -->
          <div class="f full">
            <label>操作结果</label>
            <div>
              <span v-if="!isFail(cur.result)" class="tag g">成功</span>
              <span v-else class="tag d">失败</span>
              <span v-if="cur.statusCode" class="desc" style="margin-left: 8px">
                HTTP {{ cur.statusCode }} · {{ cur.durationMs ?? 0 }} ms
              </span>
            </div>
          </div>
        </div>

        <div v-if="isFail(cur.result)" class="notice d mt12">
          ✕<div>{{ failReason(cur.afterValue) || '操作失败，原因未记录' }}</div>
        </div>
      </template>

      <template #footer>
        <div class="lft">日志不可修改、不可删除</div>
        <button class="btn" type="button" @click="detailOpen = false">关闭</button>
        <button class="btn" type="button" @click="exportOneOpen = true">导出此条</button>
        <button class="btn pri" type="button" @click="copyLogId">复制编号</button>
      </template>
    </ProtoDialog>

    <ProtoDialog v-model="exportOneOpen" title="导出单条日志" size="sm">
      <div class="notice i">ℹ<div>将导出为 PDF 格式，包含操作人与时间戳信息。</div></div>
      <template #footer>
        <button class="btn" type="button" @click="exportOneOpen = false">取消</button>
        <button class="btn pri" type="button" @click="doExportOne">确认导出</button>
      </template>
    </ProtoDialog>
  </div>
</template>
