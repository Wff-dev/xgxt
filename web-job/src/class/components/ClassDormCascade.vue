<template>
  <div class="class-dorm-cascade">
    <el-select
      v-model="local.building"
      filterable
      placeholder="选择楼号"
      style="width: 100%"
      :disabled="!classesReady || !buildingOptions.length"
      @change="onBuildingChange"
    >
      <el-option v-for="b in buildingOptions" :key="b" :label="b" :value="b" />
    </el-select>

    <el-select
      v-model="local.dormId"
      filterable
      placeholder="选择宿舍号"
      style="width: 100%; margin-top: 8px"
      :disabled="!local.building || !roomOptions.length"
      @change="onRoomChange"
    >
      <el-option v-for="r in roomOptions" :key="r.roomId" :label="r.dormNo" :value="r.roomId" />
    </el-select>

    <el-select
      v-model="local.bedNo"
      filterable
      placeholder="选择床位号"
      style="width: 100%; margin-top: 8px"
      :disabled="!local.dormId || !bedOptions.length"
      @change="onBedChange"
    >
      <el-option
        v-for="b in bedOptions"
        :key="b.bedNo"
        :label="bedOptionLabel(b)"
        :value="b.bedNo"
        :disabled="b.bedStatus === 2"
      />
    </el-select>

    <div v-if="classesReady && !buildingOptions.length" class="cdc-hint">该班级暂无符合条件的宿舍</div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { listDormClassRooms } from '@/teaching/api/dorm';
import type { DormBedRow, DormClassRoomRow, DormStage } from '@/teaching/api/dorm';

/**
 * 班级名下宿舍 三级联动选择器（楼号 → 宿舍号 → 床位号）
 *
 * - 数据源：/api/teaching/dorm/class-rooms（只返回该班级名下、分派到的宿舍）
 * - 按学生性别过滤：男生只出男寝(gender=1)、女生只出女寝(gender=2)；gender=0 的房间不分性别均显示
 * - 已占床位(bedStatus=2) 禁选
 * - 通过 v-model 回传 { building, dormId, dormNo, bedId, bedNo }
 */
export interface ClassDormPick {
  building: string;
  dormId: string;
  dormNo: string;
  bedId: string;
  bedNo: string;
}

const props = defineProps<{
  modelValue: ClassDormPick;
  className: string;
  stage?: DormStage;
  /** 学生性别：1 男 / 2 女 / 0 未知（未知则不过滤男寝女寝） */
  gender?: number;
}>();
const emit = defineEmits<{ 'update:modelValue': [ClassDormPick] }>();

const rooms = ref<DormClassRoomRow[]>([]);
const classesReady = ref(false);

const local = reactive<ClassDormPick>({ ...props.modelValue });

watch(
  () => props.modelValue,
  (v) => {
    local.building = v.building;
    local.dormId = v.dormId;
    local.dormNo = v.dormNo;
    local.bedId = v.bedId;
    local.bedNo = v.bedNo;
  },
  { deep: true },
);

/** 性别过滤：男生只出男寝(gender=1)、女生只出女寝(gender=2)，gender=0 不限制 */
const genderFilter = (r: DormClassRoomRow): boolean => {
  const g = props.gender ?? 0;
  if (!g) return true;
  return r.gender === 0 || r.gender === g;
};

const buildingOptions = computed(() => {
  const seen: string[] = [];
  for (const r of rooms.value) {
    if (r.building && genderFilter(r) && !seen.includes(r.building)) seen.push(r.building);
  }
  return seen;
});

const roomOptions = computed(() =>
  rooms.value.filter((r) => r.building === local.building && genderFilter(r)),
);

const bedOptions = computed(() => {
  const room = rooms.value.find((r) => r.roomId === local.dormId);
  return (room?.beds || []).slice().sort((a, b) => Number(a.bedNo ?? 0) - Number(b.bedNo ?? 0));
});

function emitChange(): void {
  emit('update:modelValue', {
    building: local.building,
    dormId: local.dormId,
    dormNo: local.dormNo,
    bedId: local.bedId,
    bedNo: local.bedNo,
  });
}

function resetDownstream(): void {
  local.dormId = '';
  local.dormNo = '';
  local.bedId = '';
  local.bedNo = '';
}

function onBuildingChange(): void {
  resetDownstream();
  emitChange();
}

function onRoomChange(roomId: string): void {
  const room = rooms.value.find((r) => r.roomId === roomId);
  local.dormNo = room?.dormNo || '';
  local.bedId = '';
  local.bedNo = '';
  emitChange();
}

function onBedChange(bedNo: string): void {
  const bed = bedOptions.value.find((b) => b.bedNo === bedNo);
  local.bedId = bed?.bedId || '';
  emitChange();
}

function bedOptionLabel(b: DormBedRow): string {
  const label = b.bedLabel || b.bedNo;
  return b.bedStatus === 2 && b.studentName ? `${label}（${b.studentName}）` : label;
}

/** 班级变化 → 重新拉名下宿舍（带性别过滤后仅展示对应楼栋） */
watch(
  () => props.className,
  async (cls) => {
    rooms.value = [];
    resetDownstream();
    emitChange();
    classesReady.value = false;
    if (!cls) {
      classesReady.value = true;
      return;
    }
    try {
      const r = await listDormClassRooms({ stage: (props.stage || 'job') as DormStage, className: cls });
      rooms.value = r.rooms || [];
    } catch {
      rooms.value = [];
    } finally {
      classesReady.value = true;
    }
  },
  { immediate: true },
);
</script>

<style scoped>
.cdc-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-2);
}
</style>
