'use strict';
// 导入流水线：流式解析 Excel（与本地校验交替进行）→ 分批模拟上送监管平台
const ExcelJS = require('exceljs');
const { buildHeaderMap, clean, validateRow, ISSUE_LABELS } = require('./validate');
const { submitBatch } = require('./platform');
const { emit, addLog, bumpIssue, summary } = require('./store');

const VALIDATE_CHUNK = 500;
const SUBMIT_BATCH = 500;
const MAX_ROWS = 50000;
const YIELD_EVERY = 500;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let yieldCounter = 0;
async function maybeYield() {
  if (++yieldCounter % YIELD_EVERY === 0) await sleep(0);
}

async function runPipeline(task, filePath) {
  task.startedAt = new Date().toISOString();
  addLog(task, `任务已创建，开始读取文件：${task.fileName}`);

  const tTotal = Date.now();
  try {
    // ---------- 阶段一+二：流式解析 + 本地校验 ----------
    const t0 = Date.now();
    const validRows = await parseAndValidate(task, filePath);
    task.stageDurations.parsing = Date.now() - t0; // 解析与校验融合计时
    addLog(task, `本地校验完成：共 ${task.totalRows.toLocaleString()} 行，通过 ${task.validRows.toLocaleString()} 行，异常 ${task.invalidRows.toLocaleString()} 行`);

    // ---------- 阶段三：分批上送监管平台 ----------
    task.status = 'submitting';
    task.stage = '上送监管平台';
    task.indeterminate = false;
    task.progress = 75;
    emit(task.id, 'update', summary(task));

    const t1 = Date.now();
    await submitAll(task, validRows);
    task.stageDurations.submitting = Date.now() - t1;

    // ---------- 汇总 ----------
    task.progress = 100;
    task.finishedAt = new Date().toISOString();
    task.totalElapsed = Date.now() - tTotal;
    const hasErrors = task.invalidRows + task.rejectedRows > 0;
    task.status = hasErrors ? 'completed_with_errors' : 'completed';
    task.stage = hasErrors ? '已完成（存在异常）' : '已完成';
    addLog(task,
      `任务结束：受理 ${task.acceptedRows.toLocaleString()} 行，异常 ${(task.invalidRows + task.rejectedRows).toLocaleString()} 行（本地校验 ${task.invalidRows.toLocaleString()} / 平台驳回 ${task.rejectedRows.toLocaleString()}）`,
      hasErrors ? 'warn' : 'info');
    emit(task.id, 'done', summary(task));
  } catch (err) {
    task.finishedAt = new Date().toISOString();
    task.status = 'failed';
    task.stage = '任务失败';
    task.lastError = err.message;
    addLog(task, `任务失败：${err.message}`, 'error');
    emit(task.id, 'failed', summary(task));
  }
}

/** 流式解析，每 500 行成块进行本地校验（解析期间总量未知，使用不确定进度） */
async function parseAndValidate(task, filePath) {
  task.status = 'parsing';
  task.stage = '解析 Excel 表头';
  task.indeterminate = true;
  emit(task.id, 'update', summary(task));

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore'
  });

  let headerResolved = false;
  let colMap = null;
  const validRows = [];
  let chunk = [];
  let worksheetName = '';

  const flushChunk = async () => {
    if (!chunk.length) return;
    const t0 = Date.now();
    for (const row of chunk) {
      const errRec = validateRow(row);
      if (errRec) {
        task.errors.push(errRec);
        task.invalidRows++;
        for (const code of errRec.codes) bumpIssue(task, code);
      } else {
        validRows.push({
          rowNumber: row.rowNumber,
          drugCode: row.drugCode,
          name: row.name,
          spec: row.spec,
          price: row.price,
          manufacturer: row.manufacturer
        });
        task.validRows++;
      }
      await maybeYield();
    }
    task.stageDurations.validating += Date.now() - t0;
    chunk = [];
  };

  for await (const worksheet of reader) {
    worksheetName = worksheet.name;
    for await (const rawRow of worksheet) {
      const values = rawRow.values; // 1 起始稀疏数组

      if (!headerResolved) {
        const cells = [];
        if (Array.isArray(values)) for (let i = 1; i < values.length; i++) cells.push(values[i]);
        const { map, missing } = buildHeaderMap(cells);
        if (missing.length) {
          throw new Error(`Excel 表头缺少必需列：${missing.join('、')}（需要：药品编码 / 药品名称 / 规格 / 价格 / 厂家）`);
        }
        colMap = map;
        headerResolved = true;
        addLog(task, `识别工作表「${worksheetName}」，表头校验通过，开始逐行处理`);
        task.status = 'validating';
        task.stage = '解析并本地校验';
        emit(task.id, 'update', summary(task));
        continue;
      }

      const get = key => {
        const idx = colMap[key];
        if (idx === undefined || !Array.isArray(values)) return '';
        const v = values[idx + 1];
        if (v === undefined || v === null) return '';
        return clean(typeof v === 'object' && v.text ? v.text : (v.richText ? '' : v));
      };

      const row = {
        rowNumber: rawRow.number,
        drugCode: get('drugCode'),
        name: get('name'),
        spec: get('spec'),
        priceText: get('price'),
        manufacturer: get('manufacturer')
      };

      // 整行空白跳过
      if (!row.drugCode && !row.name && !row.spec && !row.priceText && !row.manufacturer) continue;

      task.parsedRows++;
      if (task.parsedRows > MAX_ROWS) {
        throw new Error(`数据行数超过上限 ${MAX_ROWS.toLocaleString()} 行，请拆分文件后重新导入`);
      }
      chunk.push(row);
      if (chunk.length >= VALIDATE_CHUNK) await flushChunk();

      if (task.parsedRows % 2000 === 0) {
        addLog(task, `已读取并校验 ${task.parsedRows.toLocaleString()} 行（异常 ${task.invalidRows.toLocaleString()}）…`);
        emit(task.id, 'update', summary(task));
      }
      await maybeYield();
    }
  }

  if (!headerResolved) throw new Error('未在 Excel 中找到有效表头行');
  await flushChunk();

  task.totalRows = task.parsedRows;
  task.indeterminate = false;
  task.progress = 75;
  task.stage = '本地校验完成';
  emit(task.id, 'update', summary(task));
  return validRows;
}

/** 分批上送监管平台，瞬时故障自动重试 1 次 */
async function submitAll(task, validRows) {
  const totalBatches = Math.max(1, Math.ceil(validRows.length / SUBMIT_BATCH));
  const seenCodes = new Set();

  for (let b = 0; b < totalBatches; b++) {
    const batch = validRows.slice(b * SUBMIT_BATCH, (b + 1) * SUBMIT_BATCH);
    if (!batch.length) continue;

    const byRow = new Map(batch.map(x => [x.rowNumber, x]));

    let attempt = 1;
    let resp;
    for (;;) {
      resp = submitBatch(batch, { batchIndex: b, attempt, seenCodes });
      if (resp.status !== 'transient') break;
      addLog(task, `第 ${b + 1}/${totalBatches} 批上送失败：${resp.message}，3 秒后自动重试（第 ${attempt} 次）`, 'warn');
      emit(task.id, 'update', summary(task));
      await sleep(3000);
      attempt++;
      if (attempt > 2) throw new Error(`第 ${b + 1} 批多次重试仍失败，请稍后重新导入`);
    }

    for (const r of resp.results) {
      task.submittedRows++;
      const src = byRow.get(r.rowNumber);
      if (r.accepted) {
        task.acceptedRows++;
        tallyMfr(task, src.manufacturer, true);
      } else {
        task.rejectedRows++;
        bumpIssue(task, r.reason);
        tallyMfr(task, src.manufacturer, false);
        const field = reasonToField(r.reason);
        task.errors.push({
          rowNumber: src.rowNumber,
          stage: 'platform',
          fields: [field],
          codes: [r.reason],
          messages: [ISSUE_LABELS[r.reason] || r.reason],
          drugCode: src.drugCode,
          name: src.name,
          spec: src.spec,
          price: String(src.price),
          manufacturer: src.manufacturer
        });
      }
    }

    task.progress = 75 + Math.round(((b + 1) / totalBatches) * 25);
    if ((b + 1) % 5 === 0 || b + 1 === totalBatches) {
      addLog(task, `上送进度 ${b + 1}/${totalBatches} 批 · 累计受理 ${task.acceptedRows.toLocaleString()} / 驳回 ${task.rejectedRows.toLocaleString()}`);
    }
    emit(task.id, 'update', summary(task));
    await sleep(80); // 模拟平台网络耗时，使进度可视化
  }
  task.errors.sort((a, b) => a.rowNumber - b.rowNumber);
}

function reasonToField(reason) {
  switch (reason) {
    case 'PLATFORM_PRICE_MISMATCH':
      return 'price';
    case 'PLATFORM_MANUFACTURER_MISMATCH':
      return 'manufacturer';
    default:
      return 'drugCode';
  }
}

function tallyMfr(task, mfr, accepted) {
  const s = task.manufacturerStats[mfr] || { accepted: 0, rejected: 0 };
  if (accepted) s.accepted++; else s.rejected++;
  task.manufacturerStats[mfr] = s;
}

module.exports = { runPipeline };
