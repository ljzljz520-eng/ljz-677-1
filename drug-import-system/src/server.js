// HTTP 服务：静态页面 + 上传/任务/SSE/异常/下载/报告 API
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import busboy from 'busboy';
import {
  PORT, MAX_UPLOAD_MB, DIR_UPLOAD,
} from './config.js';
import { taskManager, ERROR_CODE_LABEL } from './taskManager.js';
import { generateSample } from './generator.js';
import { buildErrorWorkbook } from './export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

await fs.mkdir(DIR_UPLOAD, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function safeName(name) {
  return String(name || 'file.xlsx')
    .replace(/[\x00-\x1f\x7f\\/:*?"<>|]+/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(-120);
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

// ---- 上传 ----
function handleUpload(req, res) {
  const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
  let task = null;
  let tooBig = false;
  let savedTo = '';
  let rejected = false;

  bb.on('file', (fieldname, file, info) => {
    const originalName = safeName(info.filename);
    if (!/\.xlsx$/i.test(originalName)) {
      file.resume();
      rejected = true;
      return sendJson(res, 400, { error: '仅支持 .xlsx 格式文件（请用 Excel 另存为 xlsx）' });
    }
    savedTo = path.join(DIR_UPLOAD, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}__${originalName}`);
    const writeStream = createWriteStream(savedTo);
    task = taskManager.create({ filePath: savedTo, originalName });
    file.pipe(writeStream);
    file.on('limit', () => { tooBig = true; file.destroy(); });
  });

  bb.on('error', () => { if (!rejected) sendJson(res, 400, { error: '上传内容解析失败' }); });
  bb.on('close', () => {
    if (!task) { if (!rejected) sendJson(res, 400, { error: '未检测到上传文件（字段名需为 file）' }); return; }
    if (tooBig) {
      fs.unlink(savedTo).catch(() => {});
      taskManager.tasks.delete(task.id);
      return sendJson(res, 413, { error: `文件超过 ${MAX_UPLOAD_MB}MB 限制` });
    }
    sendJson(res, 202, { task: taskManager.snapshot(task) });
    taskManager.run(task.id).catch((e) => taskManager.failTask(task, e.message));
  });

  req.pipe(bb);
}

// ---- SSE 进度推送 ----
function handleSSE(req, res, id) {
  const t = taskManager.get(id);
  if (!t) return sendJson(res, 404, { error: '任务不存在' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const send = (snap) => res.write(`event: update\ndata: ${JSON.stringify(snap)}\n\n`);
  send(taskManager.snapshot(t));

  const done = (cur) => ['completed', 'completed_with_errors', 'failed'].includes(cur.status);
  const onUpdate = (tid) => {
    if (tid !== id) return;
    const cur = taskManager.get(id);
    send(taskManager.snapshot(cur));
    if (done(cur)) { res.write('event: end\ndata: {}\n\n'); cleanup(); res.end(); }
  };
  const hb = setInterval(() => res.write(': ping\n\n'), 15000);
  const cleanup = () => { clearInterval(hb); taskManager.off('update', onUpdate); req.off('close', onClose); };
  const onClose = () => cleanup();
  req.on('close', onClose);
  taskManager.on('update', onUpdate);
  if (done(t)) setTimeout(() => { res.write('event: end\ndata: {}\n\n'); cleanup(); res.end(); }, 200);
}

function parseFilters(sp) {
  return {
    stage: sp.get('stage') || '',
    field: sp.get('field') || '',
    code: sp.get('code') || '',
    q: sp.get('q') || '',
  };
}

const server = http.createServer(async (req, res) => {
  const u = new NodeURL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  try {
    if (req.method === 'POST' && p === '/api/sample') {
      const rows = Math.min(100000, Math.max(100, Number(u.searchParams.get('rows')) || 50000));
      const filePath = path.join(DIR_UPLOAD, `sample_${Date.now()}.xlsx`);
      await generateSample(filePath, rows);
      res.writeHead(200, {
        'Content-Type': MIME['.xlsx'],
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`药品目录导入样例_${rows}行.xlsx`)}`,
      });
      const data = await fs.readFile(filePath);
      res.end(data);
      fs.unlink(filePath).catch(() => {});
      return;
    }

    if (req.method === 'GET' && p === '/api/meta') {
      return sendJson(res, 200, {
        batchSize: 200,
        errorCodeLabels: ERROR_CODE_LABEL,
      });
    }

    if (req.method === 'POST' && p === '/api/imports') return handleUpload(req, res);

    if (req.method === 'GET' && p === '/api/tasks') {
      return sendJson(res, 200, { tasks: taskManager.list() });
    }

    const mTask = p.match(/^\/api\/tasks\/([a-f0-9]+)(\/(events|errors(\.xlsx)?|report))?$/);
    if (mTask && req.method === 'GET') {
      const [, id, , action] = mTask;
      const t = taskManager.get(id);
      if (!t) return sendJson(res, 404, { error: '任务不存在（服务可能已重启）' });

      if (!action) return sendJson(res, 200, { task: taskManager.snapshot(t) });
      if (action === 'events') return handleSSE(req, res, id);

      if (action === 'report') {
        return sendJson(res, 200, { report: taskManager.report(t) });
      }

      if (action === 'errors') {
        const filters = parseFilters(u.searchParams);
        const all = taskManager.filterErrors(t, filters);
        const page = Math.max(1, Number(u.searchParams.get('page')) || 1);
        const pageSize = Math.min(200, Math.max(10, Number(u.searchParams.get('pageSize')) || 50));
        const items = all.slice((page - 1) * pageSize, page * pageSize);
        return sendJson(res, 200, {
          items, page, pageSize, total: all.length,
          facets: taskManager.facets(t),
        });
      }

      if (action === 'errors.xlsx') {
        const filters = parseFilters(u.searchParams);
        const records = taskManager.filterErrors(t, filters);
        if (!records.length) return sendJson(res, 400, { error: '当前筛选条件下没有错误行' });
        const outPath = path.join(DIR_UPLOAD, `errors_${id}_${Date.now()}.xlsx`);
        await buildErrorWorkbook(t, records, outPath);
        res.writeHead(200, {
          'Content-Type': MIME['.xlsx'],
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`导入错误行_${t.originalName.replace(/\.xlsx$/i, '')}.xlsx`)}`,
        });
        const data = await fs.readFile(outPath);
        res.end(data);
        fs.unlink(outPath).catch(() => {});
        return;
      }
    }

    if (req.method === 'GET') return serveStatic(req, res, p.startsWith('/api') ? '/__404__' : p);
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`药品目录大批量导入系统已启动: http://localhost:${PORT}`);
});
