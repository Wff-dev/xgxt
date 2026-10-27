<script setup lang="ts">
/**
 * 操作日志
 *
 * 页面结构对齐高保真原型《学管系统-权限体系高保真原型.html》：
 *   · 第 2950~3007 行 renderLogs() —— KPI 5 卡 + 操作日志表
 *
 * ★ 2026-10-26 重构：日志列表（筛选条 / 表格 / 分页 / 详情弹窗）已抽到
 *   `components/LogTable.vue`，与「权限总览 → 最近操作动态」共用同一份实现。
 *   原因：两处原先各写一套取数口径（总览 `LIMIT 6`、日志页分页），
 *   日志量上来后必然对不上。抽成组件后口径唯一，本页只负责 KPI 5 卡 + 联动筛选。
 *
 * ⚠️ 只读页面：日志不提供增删改。写入由后端在关键动作处自动完成，
 *    日志一旦能被前端改写，就不再是「留痕」，而是「可以伪造的记录」。
 */
import { onMounted, ref } from 'vue';
import type { LogOverview } from 'shared-types/perm';
import { logApi } from '@/perm/api/perm';
import LogTable from '@/perm/components/LogTable.vue';

const overview = ref<LogOverview | null>(null);

/** 列表组件的句柄：点 KPI 卡时调它的 applyFilter 做条件筛选 */
const tableRef = ref<InstanceType<typeof LogTable> | null>(null);

async function loadOverview(): Promise<void> {
  try {
    overview.value = await logApi.overview();
  } catch {
    /* 错误已在 request 拦截器里弹过提示 */
  }
}

onMounted(loadOverview);

/** 点 KPI 卡片按条件筛选（原型 5 张卡各自改 LOG_FILTER） */
function filterBy(key: 'all' | 'success' | 'fail' | 'login' | 'approve'): void {
  tableRef.value?.applyFilter(key);
}
</script>

<template>
  <div>
    <!-- ==================== KPI 5 卡（原型 renderLogs 第 2957~2963 行） ==================== -->
    <div class="kpi">
      <div class="k" @click="filterBy('all')">
        <div class="n b">{{ overview?.logTotal ?? '—' }}</div>
        <div class="l">日志总数</div>
      </div>
      <div class="k" @click="filterBy('success')">
        <div class="n g">{{ overview?.successTotal ?? '—' }}</div>
        <div class="l">成功操作</div>
      </div>
      <div class="k" @click="filterBy('fail')">
        <div class="n d">{{ overview?.failTotal ?? '—' }}</div>
        <div class="l">失败操作</div>
      </div>
      <div class="k" @click="filterBy('login')">
        <div class="n w">{{ overview?.loginTotal ?? '—' }}</div>
        <div class="l">登录记录</div>
      </div>
      <div class="k" @click="filterBy('approve')">
        <div class="n p">{{ overview?.approveTotal ?? '—' }}</div>
        <div class="l">审批操作</div>
      </div>
    </div>

    <!-- ==================== 操作日志表（与总览「最近操作动态」同一组件） ==================== -->
    <LogTable ref="tableRef" title="操作日志" />
  </div>
</template>
