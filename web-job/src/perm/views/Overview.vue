<script setup lang="ts">
/**
 * 权限总览
 *
 * 页面结构对齐高保真原型《学管系统-权限体系高保真原型.html》：
 *   · 第 1439~1469 行 renderHome() —— KPI 4 卡 + 最近操作动态
 *
 * ★ 2026-10-26 本轮改动（用户第 3 次反馈后定稿）：
 *   「最近操作动态」原来是一张**摘要卡**（后端 `LIMIT 6`，前端再 `slice(0,6)`），
 *   日志量上来后那 6 条必然全落在同一天 —— 用户在总览看到的是「只有当天的几条」，
 *   而「操作日志」页却能翻 1900+ 条历史，两处口径对不上，反复被当成 bug。
 *
 *   现在**直接复用 `<LogTable>` 组件**：与操作日志页同一个接口、同一套列、
 *   同一个分页器，还能按关键词 / 模块 / 类型 / 结果筛选，点行看详情。
 *   只有「导出」按钮不在这里出现（日志页已有，避免重复入口）。
 *
 * ★★ 2026-10-26 第二轮（用户定稿口径，别再改回去）：
 *   总览的「最近操作动态」**只显示今天**的操作记录：
 *     · 今天是 10-26 → 列表里只有 10-26 的；明天打开 → 只有 10-27 的；
 *     · 没有任何「保留最近 N 条 / 最近 7 天」的缓冲口径，就是「当天」。
 *   完整历史（全时间、全账号）在「操作日志」页看，
 *   所以这里保留「查看全部日志」跳转按钮 —— 两个页面的职责一分为二：
 *     总览 = 今天发生了什么；日志页 = 历史上都发生过什么。
 *   实现上只给 <LogTable> 加 `today-only`，组件内部补 startDate/endDate，
 *   并没有第二套取数逻辑（详见 components/LogTable.vue 顶部注释）。
 *
 * 样式不写在这里：原型的 <style> 已整体移植到全局样式（main.ts 引入），
 * 这里只产出与原型同名同层级的 DOM。
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { PERM_ROUTE } from '@/perm/utils/links';
import type { PermOverview } from 'shared-types/perm';
import { overviewApi } from '@/perm/api/perm';
import LogTable from '@/perm/components/LogTable.vue';

const router = useRouter();

const loading = ref(false);
const data = ref<PermOverview | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await overviewApi.get();
  } catch {
    /* 错误已在 request 拦截器里弹过提示 */
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function go(path: string): void {
  void router.push(path);
}
</script>

<template>
  <div>
    <!-- ==================== KPI 4 卡（原型 renderHome 第 1447~1452 行） ==================== -->
    <div class="kpi">
      <div class="k" @click="go(PERM_ROUTE.role)">
        <div class="n b">{{ data?.roleTotal ?? '—' }}</div>
        <div class="l">👥 职位总数 <span class="tag g">启用 {{ data?.roleEnabled ?? 0 }}</span></div>
      </div>
      <div class="k" @click="go(PERM_ROUTE.user)">
        <div class="n g">{{ data?.userTotal ?? '—' }}</div>
        <div class="l">🙋 账号总数 <span class="tag b">正常 {{ data?.userNormal ?? 0 }}</span></div>
      </div>
      <div class="k" @click="go(PERM_ROUTE.assign)">
        <div class="n p">{{ data?.permPointTotal ?? '—' }}</div>
        <div class="l">🔑 可配置权限点</div>
      </div>
      <div class="k" @click="go(PERM_ROUTE.dept)">
        <div class="n w">{{ data?.deptTotal ?? '—' }}</div>
        <div class="l">🏢 部门数</div>
      </div>
    </div>

    <!-- ==================== 最近操作动态 = 只含「今天」的日志（与日志页共用组件） ==================== -->
    <LogTable title="最近操作动态" :show-export="false" compact today-only>
      <template #actions>
        <button class="btn sm" type="button" @click="go(PERM_ROUTE.log)">查看全部日志</button>
      </template>
    </LogTable>
  </div>
</template>
