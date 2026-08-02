import type { DynamicSignalStatus } from './types';

export interface P20RuntimeDisplay {
  label: string;
  shortLabel: string;
  detail: string;
  tone: 'active' | 'muted';
}

function displayState(
  status: DynamicSignalStatus | null,
  worker: DynamicSignalStatus['worker'] | DynamicSignalStatus['paperWorker'] | undefined,
  enabled: boolean,
  labels: { stopped: string; disabled: string; active: string; idle: string },
): P20RuntimeDisplay {
  if (!status) {
    return { label: '状态加载中', shortLabel: '加载中', detail: '正在读取运行状态', tone: 'muted' };
  }
  if (!worker?.running) {
    return { label: labels.stopped, shortLabel: '已停止', detail: 'Worker 未启动', tone: 'muted' };
  }
  if (!enabled) {
    return { label: labels.disabled, shortLabel: '未启用', detail: 'Worker 已启动，任务处理已关闭', tone: 'muted' };
  }
  if (worker.active) {
    return { label: labels.active, shortLabel: '处理中', detail: '正在处理任务', tone: 'active' };
  }
  return { label: labels.idle, shortLabel: '待命', detail: '能力已启用，等待新任务', tone: 'active' };
}

export function dynamicResolutionDisplay(status: DynamicSignalStatus | null): P20RuntimeDisplay {
  const enabled = Boolean(status?.features.P20_DYNAMIC_RESOLUTION_ENABLED
    && status?.features.P20_RECORD_ENABLED);
  return displayState(status, status?.worker, enabled, {
    stopped: '解析任务已停止',
    disabled: '动态能力未启用',
    active: '正在处理动态任务',
    idle: '动态任务待命',
  });
}

export function dynamicPaperDisplay(status: DynamicSignalStatus | null): P20RuntimeDisplay {
  const enabled = Boolean(status?.features.P20_PAPER_ENABLED
    && status?.features.P20_RECORD_ENABLED);
  return displayState(status, status?.paperWorker, enabled, {
    stopped: '模拟任务已停止',
    disabled: '模拟能力未启用',
    active: '正在处理模拟任务',
    idle: '模拟任务待命',
  });
}
