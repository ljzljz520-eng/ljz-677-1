'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createTask, getTask, listTasks, emitter, summary } = require('../lib/store');
const { runPipeline } = require('../lib/pipeline');
const { writeErrorWorkbook } = require('../lib/excelReport');
const { FIELD_LABELS, ISSUE_LABELS } = require('../lib/validate');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(file.originalname) || '.xlsx'}`)
  }),
  limits: { fileSize: 60 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') cb(null, true);
    else cb(new Error('仅支持 .xlsx / .xls 格式的 Excel 文件'));
  }
});

/** 任务列表 */
router.get('/', (req, res) => {
  res.json({ tasks: listTasks() });
});

/** 上传并创建导入任务 */
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到上传文件' });
  const task = createTask({ fileName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), fileSize: req.file.size });
  res.status(202).json({ task: summary(task) });
  // 异步启动流水线（响应已返回）
  setImmediate(() => runPipeline(task, req.file.path));
});

/** SSE：实时进度 / 日志 / 状态 */
router.get('/:id/events', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).end();

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('snapshot', { task: fullTask(task) });

  const onEvt = ({ event, data }) => {
    if (event === 'log') send('log', data);
    else if (event === 'done') { send('done', { task: fullTask(task) }); cleanup(); }
    else if (event === 'failed') { send('failed', { task: fullTask(task) }); cleanup(); }
    else send('update', { task: data });
  };
  const channel = `task:${task.id}`;
  emitter.on(channel, onEvt);
  const heartbeat = setInterval(() => res.write(': hb\n\n'), 15000);

  // 任务在 SSE 建立前已结束
  if (['completed', 'completed_with_errors', 'failed'].includes(task.status)) {
    send(task.status === 'failed' ? 'failed' : 'done', { task: fullTask(task) });
  }

  function cleanup() {
    clearInterval(heartbeat);
    emitter.off(channel, onEvt);
  }
  req.on('close', cleanup);
});

/** 异常行筛选（服务端分页） */
router.get('/:id/errors', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const stage = String(req.query.stage || 'all');          // all|local|platform
  const field = String(req.query.field || 'all');          // all|drugCode|...
  const code = String(req.query.code || 'all');             // all|issueCode
  const q = String(req.query.q || '').trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize, 10) || 20));

  const filtered = task.errors.filter(e => {
    if (stage !== 'all' && e.stage !== stage) return false;
    if (field !== 'all' && !e.fields.includes(field)) return false;
    if (code !== 'all' && !e.codes.includes(code)) return false;
    if (q && ![e.drugCode, e.name, e.manufacturer, e.messages.join(' ')].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });

  const total = filtered.length;
  const start = (page - 1) * pageSize;

  // 全量错误代码集合（供前端"错误类型"下拉）
  const allCodes = Array.from(new Set(task.errors.flatMap(e => e.codes))).sort();

  res.json({
    total, page, pageSize,
    items: filtered.slice(start, start + pageSize),
    allCodes,
    issueLabels: ISSUE_LABELS,
    fieldLabels: FIELD_LABELS
  });
});

/** 任务报告 */
router.get('/:id/report', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const total = task.totalRows;
  const pct = n => total ? +((n / total) * 100).toFixed(2) : 0;
  const dur = ms => ({ ms, text: ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} 秒` });

  const issueRows = Object.entries(task.issueBreakdown)
    .map(([code, count]) => ({ code, label: ISSUE_LABELS[code] || code, count, ratio: pct(count) }))
    .sort((a, b) => b.count - a.count);

  const mfrRows = Object.entries(task.manufacturerStats)
    .map(([name, s]) => ({ manufacturer: name, accepted: s.accepted, rejected: s.rejected, total: s.accepted + s.rejected }))
    .sort((a, b) => b.rejected - a.rejected || b.total - a.total);

  res.json({
    task: summary(task),
    overview: {
      totalRows: total,
      localValid: task.validRows,
      localInvalid: task.invalidRows,
      submitted: task.submittedRows,
      accepted: task.acceptedRows,
      rejected: task.rejectedRows,
      totalExceptions: task.invalidRows + task.rejectedRows,
      acceptanceRate: task.submittedRows ? +((task.acceptedRows / task.submittedRows) * 100).toFixed(2) : 0,
      passRate: pct(task.acceptedRows)
    },
    timing: {
      parseValidate: dur(task.stageDurations.parsing || 0),
      submit: dur(task.stageDurations.submitting || 0),
      total: dur(task.totalElapsed || 0),
      throughput: task.stageDurations.parsing
        ? Math.round(total / Math.max(0.001, (task.stageDurations.parsing + (task.stageDurations.submitting || 0)) / 1000))
        : 0
    },
    issueBreakdown: issueRows,
    manufacturerStats: mfrRows.slice(0, 15),
    status: task.status,
    lastError: task.lastError
  });
});

/** 下载异常行修正 Excel */
router.get('/:id/errors/export', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (!task.errors.length) return res.status(404).json({ error: '该任务没有异常行' });

  const fileName = encodeURIComponent(`异常行修正_${task.id}.xlsx`);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename*=UTF-8''${fileName}`,
    'Cache-Control': 'no-store'
  });
  try {
    await writeErrorWorkbook(task, res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: '导出失败：' + err.message });
    else res.end();
  }
});

/** 元数据：错误代码字典（前端筛选下拉用） */
router.get('/:id/meta', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json({ fieldLabels: FIELD_LABELS, issueLabels: ISSUE_LABELS });
});

function fullTask(task) {
  return { ...summary(task), logs: task.logs.slice(-80), errorCount: task.errors.length };
}

module.exports = router;
