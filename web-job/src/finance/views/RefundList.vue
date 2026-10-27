<template>
  <div class="page-container">
    <!-- ============ 表格区（单卡片通栏，与原型一致）============ -->
    <el-card shadow="never" class="table-card card-flush">
      <!-- 条件行：搜索 + 筛选 + 查询/重置 -->
      <div class="filter-row">
        <el-input
          v-model="query.studentName"
          placeholder="搜索学号 / 姓名"
          clearable
          style="width: 190px"
          @keyup.enter="handleSearch"
        />
        <el-select v-model="query.refundStatus" placeholder="退费状态" clearable style="width: 150px">
          <el-option
            v-for="(name, v) in REFUND_STATUS_NAME"
            :key="v"
            :label="name"
            :value="Number(v)"
          />
        </el-select>
        <el-button type="primary" @click="handleSearch">查询</el-button>
        <el-button @click="handleReset">重置</el-button>
      </div>

      <!-- 工具条：左边「只看待出款」快捷筛选，右边统计 -->
      <div class="table-toolbar">
        <div class="tools">
          <el-button type="warning" @click="handleOnlyPending">只看待出款</el-button>
        </div>
        <div class="tools">
          <span class="stat-line">
            待财务出款 <b>{{ pendingCount }}</b> 笔 · 当前筛选共 <b>{{ total }}</b> 条
          </span>
        </div>
      </div>

      <el-table
        v-loading="loading"
        :data="tableData"
        stripe
        style="width: 100%"
        empty-text="暂无匹配数据"
      >
        <el-table-column prop="orderNo" label="退费单号" width="130" />
        <!--
          ★ 2026-10-22：费用项明细（用户口径「每一个费用项都要在财务那里对应一行」）
          主单一行 + 展开看各费用项金额；出款仍是一次（一笔转账、一张账单）。
        -->
        <el-table-column type="expand" width="34">
          <template #default="{ row }">
            <div class="item-lines">
              <template v-if="row.items && row.items.length">
                <div v-for="it in row.items" :key="it.feeType" class="item-line">
                  <span class="item-name">{{ it.feeTypeName }}</span>
                  <span class="money">{{ formatAmount(it.amount) }}</span>
                </div>
                <div v-if="row.items.length > 1" class="item-line item-total">
                  <span class="item-name">合计</span>
                  <span class="money">{{ formatAmount(row.refundAmount) }}</span>
                </div>
              </template>
              <span v-else class="muted">该单没有费用项明细（改造前推送的存量单，按主项金额计）</span>
            </div>
          </template>
        </el-table-column>
        <!-- 未分班的学生没有学号，显示「—」（与缴费核对台同口径） -->
        <el-table-column label="学号" width="115">
          <template #default="{ row }">{{ dash(row.studentNo) }}</template>
        </el-table-column>
        <el-table-column prop="studentName" label="姓名" width="90" />
        <el-table-column prop="className" label="班级" width="85">
          <template #default="{ row }">{{ dash(row.className) }}</template>
        </el-table-column>
        <el-table-column label="退费项目" width="110" align="center">
          <template #default="{ row }">{{ itemText(row) }}</template>
        </el-table-column>
        <el-table-column label="退费金额" width="120" align="right">
          <template #default="{ row }">
            <span class="money">{{ formatAmount(row.refundAmount) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="审批状态" width="130" align="center">
          <template #default="{ row }">
            <el-tag :type="refundStatusTagType(row.refundStatus)" size="small">
              {{ row.refundStatusName }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="sourceName" label="单据来源" width="110" align="center" />
        <el-table-column label="申请人" width="90">
          <template #default="{ row }">{{ dash(row.applicantName) }}</template>
        </el-table-column>
        <el-table-column label="推送到财务" width="150" align="center">
          <template #default="{ row }">{{ dash(row.pushedTime) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right" align="center">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="handleDetail(row)">详情</el-button>
            <el-button
              v-if="row.canRefund && canPayRefund"
              link
              type="warning"
              size="small"
              @click="handlePay(row)"
            >
              确认出款
            </el-button>
            <el-button
              v-if="row.canRefund && canPayRefund"
              link
              type="danger"
              size="small"
              @click="handleReject(row)"
            >
              驳回
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页文案条（原型 pager：左文案 + 右页码） -->
      <div class="pager-bar">
        <span>共 {{ total }} 条记录，第 {{ query.page }}/{{ totalPages }} 页</span>
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.size"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          layout="sizes, prev, pager, next"
          @size-change="loadData"
          @current-change="loadData"
        />
      </div>
    </el-card>

    <!-- ============ 详情弹窗：含审批链时间轴 ============ -->
    <el-dialog v-model="detailVisible" title="退费单详情" width="700px">
      <template v-if="detail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="退费单号">{{ detail.orderNo }}</el-descriptions-item>
          <el-descriptions-item label="审批状态">
            <el-tag :type="refundStatusTagType(detail.refundStatus)" size="small">
              {{ detail.refundStatusName }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="学号">{{ dash(detail.studentNo) }}</el-descriptions-item>
          <el-descriptions-item label="姓名">{{ detail.studentName }}</el-descriptions-item>
          <el-descriptions-item label="班级">{{ dash(detail.className) }}</el-descriptions-item>
          <el-descriptions-item label="部门">{{ dash(detail.deptName) }}</el-descriptions-item>
          <el-descriptions-item label="退费项目">{{ itemText(detail) }}</el-descriptions-item>
          <el-descriptions-item label="退费金额">
            <span class="amount">{{ formatAmount(detail.refundAmount) }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="单据来源">{{ detail.sourceName }}</el-descriptions-item>
          <el-descriptions-item label="申请人">{{ dash(detail.applicantName) }}</el-descriptions-item>
          <el-descriptions-item label="退费原因" :span="2">{{ detail.refundReason }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.rejectReason" label="驳回原因" :span="2">
            <span class="reject-text">{{ detail.rejectReason }}</span>
          </el-descriptions-item>
        </el-descriptions>

        <!-- ---- ★ 费用项明细（一项一行，金额各自独立）---- -->
        <div class="timeline-title">费用项明细</div>
        <el-table
          v-if="detail.items && detail.items.length"
          :data="detail.items"
          size="small"
          border
          style="width: 100%"
        >
          <el-table-column prop="feeTypeName" label="费用项" width="140" />
          <el-table-column label="退费金额" align="right">
            <template #default="{ row }">
              <span class="money">{{ formatAmount(row.amount) }}</span>
            </template>
          </el-table-column>
        </el-table>
        <div v-else class="muted-line">
          该单没有费用项明细（改造前推送的存量单，按主项金额计）
        </div>

        <!-- ---- 审批链时间轴 ---- -->
        <div class="timeline-title">审批流转记录</div>
        <el-alert
          v-if="detail.sourceModule"
          type="info"
          :closable="false"
          show-icon
          class="src-tip"
          title="该单由上游审批通过后推送：上游只走「学管审批 → 校长审批」两步，财务侧不再重复经理审批 / 教务核算"
        />
        <el-timeline>
          <el-timeline-item
            v-for="step in approvalSteps"
            :key="step.label"
            :type="step.type"
            :hollow="!step.time"
            :timestamp="step.time || '待处理'"
          >
            {{ step.label }}
            <span v-if="step.by" class="by">（{{ step.by }}）</span>
          </el-timeline-item>
        </el-timeline>
      </template>

      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button
          v-if="detail?.canRefund"
          type="warning"
          @click="detail && (detailVisible = false, handlePay(detail))"
        >
          确认出款
        </el-button>
      </template>
    </el-dialog>

    <!-- ============ 出款弹窗 ============ -->
    <el-dialog v-model="payVisible" title="确认出款" width="540px" @closed="resetPayForm">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="出款后不可撤销，将自动生成退费账单并计入账目"
        style="margin-bottom: 12px"
      />
      <el-descriptions v-if="payTarget" :column="2" border size="small" style="margin-bottom: 12px">
        <el-descriptions-item label="退费单号">{{ payTarget.orderNo }}</el-descriptions-item>
        <el-descriptions-item label="学生">{{ payTarget.studentName }}</el-descriptions-item>
        <el-descriptions-item label="退费项目">{{ payTarget.refundTypeName }}</el-descriptions-item>
        <el-descriptions-item label="退费金额">
          <span class="amount">{{ formatAmount(payTarget.refundAmount) }}</span>
        </el-descriptions-item>
      </el-descriptions>

      <el-form label-width="90px">
        <el-form-item label="支付方式">
          <el-select v-model="payMethod" placeholder="请选择" style="width: 100%">
            <el-option v-for="(name, v) in PAY_METHOD_NAME" :key="v" :label="name" :value="Number(v)" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="payRemark" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="如：转账至家长账户" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="payVisible = false">取消</el-button>
        <el-button type="warning" :loading="submitting" @click="confirmPay">确认出款</el-button>
      </template>
    </el-dialog>

    <!-- ============ 驳回弹窗 ============ -->
    <el-dialog v-model="rejectVisible" title="驳回退费单" width="520px" @closed="rejectReason = ''">
      <el-form label-width="80px">
        <el-form-item label="驳回原因" required>
          <el-input
            v-model="rejectReason"
            type="textarea"
            :rows="3"
            maxlength="255"
            show-word-limit
            placeholder="请说明驳回理由"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" @click="confirmReject">确定驳回</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 退费管理
 *
 * ⚠️ 财务在这一页只做「待财务出款」这一步（canRefund 为 true 的行）。
 *    前面的经理审批 / 教务核算 / 校长审批不是财务的活，
 *    但财务要能看到整条链走到哪了 —— 所以详情里做了时间轴。
 */

import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  REFUND_STATUS_NAME,
  PAY_METHOD_NAME,
  PayMethod,
  RefundStatus,
  type RefundListItem,
  type RefundDetail,
  type RefundListQuery,
} from 'shared-types/finance';
import {
  fetchRefundList,
  fetchRefundDetail,
  payRefund,
  rejectRefund,
} from '@/finance/api/finance';
import { formatAmount, refundStatusTagType, dash } from '@/finance/utils/finance';
// ★ 2026-10-26：与后端 finance:refund:pay 同口径 —— 只勾「查看」的职位不显示出款/驳回
import { hasPerm } from '@/store/permission';

/** 有没有「退费出款」操作权 */
const canPayRefund = computed(() => hasPerm('finance:refund:pay'));

/* ---------- 列表 ---------- */

const loading = ref(false);
const tableData = ref<RefundListItem[]>([]);
const total = ref(0);

const query = reactive<RefundListQuery>({
  page: 1,
  size: 20,
  studentNo: undefined,
  studentName: undefined,
  refundStatus: undefined,
});

const pendingCount = computed(
  () => tableData.value.filter((r) => r.canRefund).length,
);

/** 分页总页数（原型 pager 里的「第 N/M 页」） */
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / (query.size || 20))));

async function loadData() {
  loading.value = true;
  try {
    const data = await fetchRefundList(query);
    tableData.value = data.list;
    total.value = data.total;
  } catch (e) {
    console.error('加载退费列表失败', e);
  } finally {
    loading.value = false;
  }
}

function handleSearch() {
  query.page = 1;
  loadData();
}

function handleReset() {
  query.page = 1;
  query.size = 20;
  query.studentNo = undefined;
  query.studentName = undefined;
  query.refundStatus = undefined;
  loadData();
}

function handleOnlyPending() {
  query.refundStatus = RefundStatus.PENDING_FINANCE;
  query.page = 1;
  loadData();
}

/* ---------- 详情 + 审批链 ---------- */

const detailVisible = ref(false);
const detail = ref<RefundDetail | null>(null);

/**
 * 把详情里的时间戳拼成时间轴
 *
 * ★ 2026-10-22 用户反馈修正（截图那个 bug）：
 *   原来不分来源一律按财务那套 6 节点渲染，而上游（教学域）推送的单
 *   只走「学管审批 → 校长审批」两步，财务侧也没有经理审批 / 教务核算
 *   → 时间轴永远有两三个「待处理」，看着像没推过来。
 *
 *   现在分两种口径：
 *     · 上游推送单（sourceModule 有值）→ 只画真实存在的 4 步
 *     · 财务自建单（无 sourceModule）→ 保留原来的 6 步
 */
const approvalSteps = computed(() => {
  const d = detail.value;
  if (!d) return [];

  const done = (t?: string): 'success' | 'primary' => (t ? 'success' : 'primary');

  if (d.sourceModule) {
    return [
      { label: '上游提交申请', time: d.applyTime, by: d.applicantName, type: done(d.applyTime) },
      {
        label: '校长审批通过',
        time: d.principalApproveTime,
        by: d.principalApproveBy,
        type: done(d.principalApproveTime),
      },
      { label: '推送到财务', time: d.pushedTime, by: '', type: done(d.pushedTime) },
      { label: '财务出款', time: d.financePayTime, by: d.financePayBy, type: done(d.financePayTime) },
    ];
  }

  return [
    { label: '班主任提交申请', time: d.applyTime, by: d.applicantName, type: done(d.applyTime) },
    { label: '经理审批', time: d.managerApproveTime, by: d.managerApproveBy, type: done(d.managerApproveTime) },
    { label: '教务核算', time: d.academicCheckTime, by: d.academicCheckBy, type: done(d.academicCheckTime) },
    { label: '校长审批（大额才有）', time: d.principalApproveTime, by: d.principalApproveBy, type: done(d.principalApproveTime) },
    { label: '推送到财务', time: d.pushedTime, by: '', type: done(d.pushedTime) },
    { label: '财务出款', time: d.financePayTime, by: d.financePayBy, type: done(d.financePayTime) },
  ];
});

/**
 * 退费项目展示文案
 *
 * 单项 → 直接显示类型名；多项 → 「学费 等 2 项」（明细在展开行/详情里逐项列出）。
 * 老单（无明细）→ 回落主项 `refundTypeName`。
 */
function itemText(row: any): string {
  const items = (row?.items || []) as Array<{ feeTypeName: string }>;
  if (items.length > 1) return `${items[0].feeTypeName} 等 ${items.length} 项`;
  if (items.length === 1) return items[0].feeTypeName;
  return row?.refundTypeName || '';
}

async function handleDetail(row: RefundListItem) {
  try {
    detail.value = await fetchRefundDetail(row.id);
    detailVisible.value = true;
  } catch (e) {
    console.error('加载退费详情失败', e);
  }
}

/* ---------- 出款 ---------- */

const payVisible = ref(false);
const payTarget = ref<RefundListItem | null>(null);
const payMethod = ref<number | undefined>(PayMethod.TRANSFER);
const payRemark = ref('');
const submitting = ref(false);

function handlePay(row: RefundListItem) {
  payTarget.value = row;
  payMethod.value = PayMethod.TRANSFER;
  payRemark.value = '';
  payVisible.value = true;
}

function resetPayForm() {
  payTarget.value = null;
  payRemark.value = '';
}

async function confirmPay() {
  if (!payTarget.value) return;

  // ⚠️ 二次确认：出款是真金白银，不能点一下就出去
  try {
    await ElMessageBox.confirm(
      `确认向「${payTarget.value.studentName}」出款 ${formatAmount(payTarget.value.refundAmount)} 吗？`,
      '出款二次确认',
      { type: 'warning', confirmButtonText: '确认出款', cancelButtonText: '再想想' },
    );
  } catch {
    return;
  }

  submitting.value = true;
  try {
    const r = await payRefund({
      id: payTarget.value.id,
      payMethod: payMethod.value,
      remark: payRemark.value || undefined,
    });
    ElMessage.success(`出款成功，已生成退费账单 ${r.billNo}`);
    payVisible.value = false;
    loadData();
  } catch (e) {
    // 已统一处理
  } finally {
    submitting.value = false;
  }
}

/* ---------- 驳回 ---------- */

const rejectVisible = ref(false);
const rejectReason = ref('');
const rejectTarget = ref<RefundListItem | null>(null);

function handleReject(row: RefundListItem) {
  rejectTarget.value = row;
  rejectReason.value = '';
  rejectVisible.value = true;
}

async function confirmReject() {
  if (!rejectReason.value.trim()) {
    ElMessage.warning('请填写驳回原因');
    return;
  }
  if (!rejectTarget.value) return;

  submitting.value = true;
  try {
    await rejectRefund({ id: rejectTarget.value.id, rejectReason: rejectReason.value.trim() });
    ElMessage.success('已驳回');
    rejectVisible.value = false;
    loadData();
  } catch (e) {
    // 已统一处理
  } finally {
    submitting.value = false;
  }
}

onMounted(loadData);
</script>

<style scoped>
.page-container {
  padding: 16px;
}

/* 卡片内通栏版式（.filter-row / .table-toolbar / .pager-bar）由 element-theme.css 统一提供 */

.reject-text {
  color: #B22A23;
}

.timeline-title {
  font-size: 14px;
  font-weight: 600;
  margin: 16px 0 12px;
  color: #443432;
}

.by {
  color: #A2938E;
  font-size: 12px;
}

/* ★ 2026-10-22：费用项明细（展开行 / 详情弹窗） */
.item-lines {
  padding: 8px 16px 8px 48px;
}

.item-line {
  display: flex;
  justify-content: space-between;
  max-width: 360px;
  padding: 3px 0;
  font-size: 13px;
  color: #443432;
}

.item-line.item-total {
  border-top: 1px dashed #e4e7ed;
  margin-top: 4px;
  padding-top: 6px;
  font-weight: 600;
}

.item-name {
  color: #6b5b57;
}

.muted {
  color: #A2938E;
  font-size: 13px;
}

.muted-line {
  color: #A2938E;
  font-size: 13px;
  padding: 6px 0;
}

.src-tip {
  margin-bottom: 12px;
}
</style>
