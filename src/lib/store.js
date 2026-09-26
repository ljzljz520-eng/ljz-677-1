'use strict';
// 任务内存存储 + 全局事件总线
const EventEmitter = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** taskId -> task 对象 */
const tasks = new Map();

/** 最大保留任务数（防止长期运行内存膨胀） */
const MAX_TASKS = 20;

function createTask(meta = {}) {
  const id = 'T' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const task = {
    id,
    fileName: meta.fileName || '',
    fileSize: meta.fileSize || 0,
    status: 'created',           // created|parsing|validating|submitting|completed|completed_with_errors|failed
    stage: '等待处理',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    progress: 0,                 // -1 表示不确定进度（解析阶段）
    indeterminate: false,
    totalRows: 0,               // Excel 数据行数（不含表头）
    parsedRows: 0,
    validRows: 0,
    invalidRows: 0,
    submittedRows: 0,
    acceptedRows: 0,
    rejectedRows: 0,
    // 报告明细
    stageDurations: { parsing: 0, validating: 0, submitting: 0 },
    issueBreakdown: {},          // issueCode -> count
    manufacturerStats: {},       // 厂家 -> {accepted, rejected}
    errors: [],                  // 错误行明细（见 validate.js 结构）
    logs: [],
    lastError: null
  };
  tasks.set(id, task);
  if (tasks.size > MAX_TASKS) {
    const oldestKey = tasks.keys().next().value;
    tasks.delete(oldestKey);
  }
  return task;
}

function getTask(id) {
  return tasks.get(id) || null;
}

function listTasks() {
  return Array.from(tasks.values())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(summary);
}

function summary(t) {
  return {
    id: t.id,
    fileName: t.fileName,
    fileSize: t.fileSize,
    status: t.status,
    stage: t.stage,
    progress: t.progress,
    indeterminate: t.indeterminate,
    totalRows: t.totalRows,
    parsedRows: t.parsedRows,
    validRows: t.validRows,
    invalidRows: t.invalidRows,
    submittedRows: t.submittedRows,
    acceptedRows: t.acceptedRows,
    rejectedRows: t.rejectedRows,
    createdAt: t.createdAt,
    finishedAt: t.finishedAt
  };
}

function emit(taskId, event, data) {
  emitter.emit(`task:${taskId}`, { event, data: data || {} });
}

function addLog(task, message, level = 'info') {
  const at = new Date().toISOString();
  task.logs.push({ at, level, message });
  if (task.logs.length > 300) task.logs.splice(0, task.logs.length - 300);
  emit(task.id, 'log', { at, level, message });
}

function bumpIssue(task, code, n = 1) {
  task.issueBreakdown[code] = (task.issueBreakdown[code] || 0) + n;
}

module.exports = {
  emitter, tasks, createTask, getTask, listTasks, summary, emit, addLog, bumpIssue
};
