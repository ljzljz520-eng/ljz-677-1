// 导入任务管理器：流式读取 Excel → 分批本地校验 → 分批模拟上送监管平台 → 汇总
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import {
  parseHeader, missingHeaders, extractRow, validateRow, duplicateCheck,
} from './validators.js';
import { submitBatch } from './platform_sim.js';
import { readXlsxLastRow } from './xlsxmeta.js';
import { BATCH_SIZE } from './config.js';

// 平台错误码 -> 关联字段（用于前端按字段筛选）
const PLATFORM_FIELD = {
  PLATFORM_CODE_NOT_FOUND: '药品编码',
  PLATFORM_NAME_MISMATCH: '药品名称',
  PLATFORM_MFR_NOT_FILED: '厂家',
  PLATFORM_PRICE_ABNORMAL: '价格',
  PLATFORM_DUPLICATE: '药品编码',
  PLATFORM_NETWORK: '',
};

export const ERROR_CODE_LABEL = {
  CODE_REQUIRED: '编码为空', CODE_FORMAT: '编码格式错误', CODE_PREFIX: '编码前缀非法',
  CODE_CHECKSUM: '编码校验位错误', CODE_DUP_FILE: '文件内重复编码',
  NAME_REQUIRED: '名称为空', NAME_LENGTH: '名称长度异常', NAME_CHARS: '名称含非法字符', NAME_NO_HAN: '名称缺少中文',
  SPEC_REQUIRED: '规格为空', SPEC_LENGTH: '规格过长', SPEC_NO_NUMBER: '规格缺数值',
  SPEC_UNIT: '规格单位非法', SPEC_FORMAT: '规格格式错误',
  PRICE_REQUIRED: '价格为空', PRICE_NUMBER: '价格非数字', PRICE_POSITIVE: '价格必须大于0',
  PRICE_RANGE: '价格超范围', PRICE_DECIMAL: '价格小数位超限',
  MFR_REQUIRED: '厂家为空', MFR_LENGTH: '厂家长度异常', MFR_SUFFIX: '厂家名称不合规',
  PLATFORM_CODE_NOT_FOUND: '平台无编码注册', PLATFORM_NAME_MISMATCH: '备案名称不一致',
  PLATFORM_MFR_NOT_FILED: '厂家未备案', PLATFORM_PRICE_ABNORMAL: '平台价格异常',
  PLATFORM_DUPLICATE: '平台重复上送', PLATFORM_NETWORK: '平台网络超时',
};

class TaskManager extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
  }

  create({ filePath, originalName, totalHint = null }) {
    const id = crypto.randomBytes(8).toString('hex');
    const task = {
      id,
      filePath,
      originalName,
      status: 'pending',           // pending | processing | completed | completed_with_errors | failed
      stage: '等待处理',
      fatalMessage: null,
      headerWarnings: [],
      missingHeaders: [],
      sheetName: '',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      durationMs: 0,
      total: totalHint ?? 0,
      processed: 0,
      emptyRows: 0,
      validCount: 0,               // 本地校验通过
      invalidLocal: 0,             // 本地校验未通过（行）
      acceptedCount: 0,           // 平台受理成功
      platformRejected: 0,        // 平台业务拒绝（行）
      networkFailed: 0,           // 重试后仍超时（行）
      batchCount: 0,
      // rowNo -> { rowNo, data, local:[{field,code,msg}], platform:[{field,code,msg}] }
      errors: new Map(),
    };
    this.tasks.set(id, task);
    return task;
  }

  get(id) {
    return this.tasks.get(id);
  }

  list() {
    return [...this.tasks.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((t) => this.snapshot(t));
  }

  // 轻量快照（SSE / 列表 / 轮询）
  snapshot(t) {
    return {
      id: t.id, originalName: t.originalName, status: t.status, stage: t.stage,
      fatalMessage: t.fatalMessage, headerWarnings: t.headerWarnings, missingHeaders: t.missingHeaders,
      sheetName: t.sheetName,
      createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt, durationMs: t.durationMs,
      total: t.total, processed: t.processed, emptyRows: t.emptyRows,
      validCount: t.validCount, invalidLocal: t.invalidLocal,
      acceptedCount: t.acceptedCount, platformRejected: t.platformRejected, networkFailed: t.networkFailed,
      batchCount: t.batchCount, errorRows: t.errors.size,
      percent: t.total ? Math.min(100, Math.round((t.processed / t.total) * 100)) : 0,
    };
  }

  failTask(t, message) {
    t.status = 'failed';
    t.stage = '处理失败';
    t.fatalMessage = message;
    t.finishedAt = new Date().toISOString();
    t.durationMs = t.startedAt ? Date.parse(t.finishedAt) - Date.parse(t.startedAt) : 0;
    this.emit('update', t.id);
  }

  async run(id) {
    const t = this.tasks.get(id);
    if (!t || t.status === 'processing') return;
    t.status = 'processing';
    t.startedAt = new Date().toISOString();
    t.stage = '扫描 Excel 行数';
    this.emit('update', id);

    // 预扫描总行数（流式文件无 dimension 时回退为统计 <row> 标签）
    try {
      const { lastRow } = await readXlsxLastRow(t.filePath);
      if (lastRow) t.total = Math.max(0, lastRow - 1); // 去掉表头
    } catch { /* 预扫描失败则边处理边计数 */ }

    let reader;
    try {
      reader = new ExcelJS.stream.xlsx.WorkbookReader(t.filePath, {});
    } catch (e) {
      return this.failTask(t, `无法读取 Excel 文件：${e.message}`);
    }

    try {
      let sheetSeen = false;
      let colMap = null;
      const seenCodes = new Map();
      let pending = []; // 本批待上送行 {rowNo, data}

      for await (const worksheet of reader) {
        if (sheetSeen) continue; // 仅处理第一个工作表
        sheetSeen = true;
        t.sheetName = worksheet.name || 'Sheet1';

        for await (const row of worksheet) {
          const values = (row.values || []).slice(1); // 去掉 1-based 占位 null

          if (!colMap) {
            // 表头允许出现在前 10 行内（容忍标题行/空行）
            if (row.number > 10) {
              this.failTask(t, '未找到表头行，请使用标准模板（药品编码 / 药品名称 / 规格 / 价格 / 厂家）');
              await reader.destroy?.();
              return;
            }
            const { colMap: map, unknowns } = parseHeader(values);
            if (missingHeaders(map).length) continue; // 还没碰到表头行
            colMap = map;
            t.headerWarnings = unknowns;
            t.headerRowNo = row.number;
            t.stage = '分批校验并上送';
            this.emit('update', id);
            continue;
          }

          const data = extractRow(values, colMap);
          const blank = Object.values(data).every((v) => v === '');
          if (blank) { t.emptyRows++; continue; }
          const rowNo = row.number;

          // ---- 本地行校验 ----
          const fieldErrors = validateRow(data);
          const dup = duplicateCheck(data, seenCodes, rowNo);
          if (dup) fieldErrors.push(dup);

          if (fieldErrors.length) {
            t.invalidLocal++;
            t.errors.set(rowNo, { rowNo, data, local: fieldErrors, platform: [] });
          } else {
            t.validCount++;
            pending.push({ rowNo, data });
          }
          t.processed++;

          if (pending.length >= BATCH_SIZE) {
            const batch = pending;
            pending = [];
            await this._submitWithRetry(t, batch);
            t.batchCount++;
            t.stage = `分批校验并上送中（第 ${t.batchCount} 批，约 ${Math.round((t.processed / Math.max(1, t.total)) * 100)}%）`;
            this.emit('update', id);
          }
        }
      }

      if (!sheetSeen) { this.failTask(t, 'Excel 中没有任何工作表'); return; }
      if (colMap === null) { this.failTask(t, '未找到表头行，请使用标准模板（首行为表头）'); return; }

      // 收尾批次
      if (pending.length) {
        await this._submitWithRetry(t, pending);
        pending = [];
        t.batchCount++;
      }

      // 以实际读取为准（预扫描可能把空行也算入），保证计数守恒
      t.total = t.processed + t.emptyRows;
      t.status = t.errors.size ? 'completed_with_errors' : 'completed';
      t.stage = '处理完成';
      t.finishedAt = new Date().toISOString();
      t.durationMs = Date.parse(t.finishedAt) - Date.parse(t.startedAt);
      this.emit('update', id);
    } catch (e) {
      this.failTask(t, `解析 Excel 失败：${e.message}`);
    }
  }

  async _submitWithRetry(t, batch) {
    let attempt = 1;
    let pendingRows = batch;
    const byNo = new Map(batch.map((r) => [r.rowNo, r]));

    while (true) {
      const { results, networkErrors } = await submitBatch(pendingRows, attempt);
      for (const r of results) {
        if (r.accepted) {
          t.acceptedCount++;
        } else {
          t.platformRejected++;
          const src = byNo.get(r.rowNo);
          const rec = t.errors.get(r.rowNo) ?? { rowNo: r.rowNo, data: src.data, local: [], platform: [] };
          rec.platform.push({ field: PLATFORM_FIELD[r.code] ?? '', code: r.code, msg: r.msg });
          t.errors.set(r.rowNo, rec);
        }
      }
      if (!networkErrors.length || attempt >= 3) {
        if (networkErrors.length) {
          t.networkFailed += networkErrors.length;
          for (const rowNo of networkErrors) {
            const src = byNo.get(rowNo);
            const rec = t.errors.get(rowNo) ?? { rowNo, data: src.data, local: [], platform: [] };
            rec.platform.push({ field: '', code: 'PLATFORM_NETWORK', msg: '监管平台网络超时，重试 3 次仍失败，请稍后重新上送' });
            t.errors.set(rowNo, rec);
          }
        }
        break;
      }
      pendingRows = networkErrors.map((n) => byNo.get(n));
      attempt++;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  // ---------- 异常查询 ----------
  filterErrors(t, { stage = '', field = '', code = '', q = '' } = {}) {
    const kw = q.trim().toLowerCase();
    const out = [];
    for (const rec of t.errors.values()) {
      const pool = stage === 'local' ? rec.local : stage === 'platform' ? rec.platform : [...rec.local, ...rec.platform];
      if (stage === 'local' && !rec.local.length) continue;
      if (stage === 'platform' && !rec.platform.length) continue;
      if (field && !pool.some((e) => e.field === field)) continue;
      if (code && !pool.some((e) => e.code === code)) continue;
      if (kw) {
        const hay = [rec.rowNo, ...Object.values(rec.data), ...pool.map((e) => e.msg + e.code)]
          .join(' ').toLowerCase();
        if (!hay.includes(kw)) continue;
      }
      out.push(rec);
    }
    return out;
  }

  facets(t) {
    const stages = { local: 0, platform: 0 };
    const fields = {};
    const codes = {};
    const bump = (m, k) => { m[k] = (m[k] ?? 0) + 1; };
    for (const rec of t.errors.values()) {
      if (rec.local.length) stages.local++;
      if (rec.platform.length) stages.platform++;
      for (const e of rec.local) { if (e.field) bump(fields, e.field); bump(codes, e.code); }
      for (const e of rec.platform) { if (e.field) bump(fields, e.field); bump(codes, e.code); }
    }
    return { stages, fields, codes, total: t.errors.size };
  }

  report(t) {
    const f = this.facets(t);
    const topErrors = Object.entries(f.codes)
      .map(([code, count]) => ({ code, label: ERROR_CODE_LABEL[code] ?? code, count }))
      .sort((a, b) => b.count - a.count);
    const fieldLabels = {
      '药品编码': '药品编码', '药品名称': '药品名称', '规格': '规格', '价格': '价格', '厂家': '厂家', '': '整行/网络',
    };
    const topFields = Object.entries(f.fields)
      .map(([field, count]) => ({ field, label: fieldLabels[field] ?? field, count }))
      .sort((a, b) => b.count - a.count);
    const s = this.snapshot(t);
    const passRate = t.total ? (t.acceptedCount / t.total) * 100 : 0;
    return {
      ...s,
      facets: f,
      topErrors,
      topFields,
      passRate: Math.round(passRate * 100) / 100,
      localErrorRate: t.total ? Math.round((t.invalidLocal / t.total) * 10000) / 100 : 0,
      platformRejectRate: t.validCount ? Math.round((t.platformRejected / t.validCount) * 10000) / 100 : 0,
    };
  }
}

export const taskManager = new TaskManager();
