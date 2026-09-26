'use strict';

/* ================= 状态 ================= */
const state = {
  tasks: [],
  currentId: null,
  currentTask: null,
  errors: { page: 1, pageSize: 20, total: 0, items: [] },
  filter: { stage: 'all', field: 'all', code: 'all', q: '' },
  evtSource: null,
  pollTimer: null,
  reportLoaded: false
};

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = n => Number(n || 0).toLocaleString('zh-CN');

const STATUS_MAP = {
  created: { cls: 'created', text: '等待处理', run: false },
  parsing: { cls: 'running', text: '解析中', run: true },
  validating: { cls: 'running', text: '校验中', run: true },
  submitting: { cls: 'running', text: '上送中', run: true },
  completed: { cls: 'ok', text: '已完成', run: false },
  completed_with_errors: { cls: 'warn', text: '完成·有异常', run: false },
  failed: { cls: 'error', text: '失败', run: false }
};

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.className = 'toast', 3200);
}

/* ================= 初始化 ================= */
window.addEventListener('DOMContentLoaded', () => {
  initUpload();
  initTabs();
  initFilters();
  loadTasks();
  setInterval(loadTasks, 4000);
});

/* ================= 上传 ================= */
function initUpload() {
  const dz = $('#dropzone');
  const input = $('#fileInput');
  const btn = $('#uploadBtn');
  let selected = null;

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag');
    if (e.dataTransfer.files.length) pickFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if (input.files.length) pickFile(input.files[0]); });

  function pickFile(f) {
    selected = f;
    $('#uploadMsg').textContent = `已选择：${f.name}（${formatSize(f.size)}）`;
    $('#uploadMsg').className = 'upload-msg';
    btn.disabled = false;
    btn.textContent = `开始导入「${f.name.length > 18 ? f.name.slice(0, 18) + '…' : f.name}」`;
  }

  btn.addEventListener('click', async () => {
    if (!selected) return;
    const fd = new FormData();
    fd.append('file', selected);
    btn.disabled = true;
    btn.textContent = '上传中…';
    $('#uploadMsg').textContent = '文件上传中，大文件请稍候…';
    try {
      const resp = await fetch('/api/tasks', { method: 'POST', body: fd });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '上传失败');
      $('#uploadMsg').textContent = '任务已创建，正在后台处理';
      toast('导入任务已创建');
      selected = null;
      input.value = '';
      btn.disabled = true;
      btn.textContent = '选择文件后开始导入';
      await loadTasks();
      selectTask(data.task.id);
    } catch (err) {
      $('#uploadMsg').textContent = err.message;
      $('#uploadMsg').className = 'upload-msg error';
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = '重新开始导入';
    }
  });
}

function formatSize(n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024).toFixed(1) + ' KB';
}

/* ================= 任务列表 ================= */
async function loadTasks() {
  try {
    const resp = await fetch('/api/tasks');
    const data = await resp.json();
    state.tasks = data.tasks || [];
    renderTaskList();
    // 后台轮询时刷新当前任务概览（SSE 失败兜底）
    if (state.currentId && !state.evtSource) {
      const t = state.tasks.find(x => x.id === state.currentId);
      if (t) updateOverview(t);
    }
  } catch (e) { /* 忽略轮询失败 */ }
}

function renderTaskList() {
  const ul = $('#taskList');
  $('#taskCount').textContent = state.tasks.length ? `(${state.tasks.length})` : '';
  if (!state.tasks.length) {
    ul.innerHTML = '<li class="empty">暂无任务</li>';
    return;
  }
  ul.innerHTML = state.tasks.map(t => {
    const st = STATUS_MAP[t.status] || STATUS_MAP.created;
    return `
      <li class="task-item ${t.id === state.currentId ? 'active' : ''}" data-id="${t.id}">
        <div class="ti-top">
          <span class="ti-name" title="${esc(t.fileName)}">${esc(t.fileName)}</span>
          <span class="badge badge-${st.cls}">${st.text}</span>
        </div>
        <div class="ti-meta">
          <span>${t.id}</span>
          <span>${nf(t.totalRows || t.parsedRows)} 行</span>
          <span>${formatTime(t.createdAt)}</span>
        </div>
      </li>`;
  }).join('');
  ul.querySelectorAll('.task-item').forEach(li =>
    li.addEventListener('click', () => selectTask(li.dataset.id)));
}

function formatTime(iso) {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ================= 选择任务 / SSE ================= */
async function selectTask(id) {
  state.currentId = id;
  state.reportLoaded = false;
  state.errors.page = 1;
  state.filter = { stage: 'all', field: 'all', code: 'all', q: '' };
  $('#fStage').value = 'all'; $('#fField').value = 'all'; $('#fCode').innerHTML = '<option value="all">全部错误类型</option>'; $('#fKeyword').value = '';
  $('#logs').innerHTML = '';
  $('#placeholder').classList.add('hidden');
  $('#detailBody').classList.remove('hidden');
  renderTaskList();
  connectSSE(id);
}

function connectSSE(id) {
  closeStream();
  const es = new EventSource(`/api/tasks/${id}/events`);
  state.evtSource = es;
  let bootstrapped = false;

  const bootstrap = task => {
    if (bootstrapped) return;
    bootstrapped = true;
    state.currentTask = task;
    renderAll(task);
    renderLogs(task.logs || [], true);
    // 已完成的任务直接加载异常表
    if (['completed', 'completed_with_errors', 'failed'].includes(task.status)) {
      loadErrors();
      if ($('.tab.active').dataset.tab === 'report') loadReport();
    }
  };

  es.addEventListener('snapshot', e => bootstrap(JSON.parse(e.data).task));
  es.addEventListener('update', e => {
    const d = JSON.parse(e.data);
    state.currentTask = d.task;
    updateOverview(d.task);
  });
  es.addEventListener('log', e => {
    if (bootstrapped) appendLog(JSON.parse(e.data));
  });
  const finish = e => {
    const d = JSON.parse(e.data);
    bootstrap(d.task);          // 兜底：snapshot 未到达时
    state.currentTask = d.task;
    renderAll(d.task);
    renderLogs(d.task.logs || [], true);
    loadErrors();
    if ($('.tab.active').dataset.tab === 'report') loadReport();
    loadTasks();
    closeStream();
    if (e.type === 'failed') toast('任务失败：' + (d.task.status), true);
    else toast(d.task.status === 'completed' ? '任务已完成' : '任务完成，存在异常行');
  };
  es.addEventListener('done', finish);
  es.addEventListener('failed', finish);
  es.onerror = () => {
    // SSE 断开后退化为 4s 轮询
    closeStream();
    if (!state.pollTimer) {
      state.pollTimer = setInterval(async () => {
        const resp = await fetch(`/api/tasks/${id}/report`).catch(() => null);
        if (!resp || !resp.ok) return;
        const rpt = await resp.json();
        bootstrap(rpt.task);
        updateOverview(rpt.task);
        if (['completed', 'completed_with_errors', 'failed'].includes(rpt.task.status)) {
          clearInterval(state.pollTimer); state.pollTimer = null;
          renderAll(rpt.task);
          loadErrors();
          loadTasks();
        }
      }, 4000);
    }
  };
}

function closeStream() {
  if (state.evtSource) { state.evtSource.close(); state.evtSource = null; }
}

/* ================= 概览渲染 ================= */
function renderAll(task) {
  $('#dFileName').textContent = task.fileName;
  $('#dTaskId').textContent = task.id;
  $('#dCreated').textContent = formatTime(task.createdAt);
  $('#dSize').textContent = formatSize(task.fileSize || 0);
  updateOverview(task);
}

function updateOverview(t) {
  const st = STATUS_MAP[t.status] || STATUS_MAP.created;
  const badge = $('#dStatus');
  badge.textContent = st.text;
  badge.className = 'status-badge ' + (st.run ? 'running' : st.cls);

  const total = t.totalRows || t.parsedRows || 0;
  $('#stTotal').textContent = nf(total);
  $('#stAccepted').textContent = nf(t.acceptedRows);
  $('#stInvalid').textContent = nf(t.invalidRows);
  $('#stRejected').textContent = nf(t.rejectedRows);
  $('#errBadge').textContent = nf((t.invalidRows || 0) + (t.rejectedRows || 0));

  const running = st.run;
  $('#progressStage').textContent = t.stage || '—';
  $('#progressPct').textContent = running && t.indeterminate ? '处理中' : `${t.progress ?? 0}%`;
  $('#progressBar').style.width = (t.indeterminate ? 0 : (t.progress || 0)) + '%';
  $('#progressBarInd').classList.toggle('hidden', !(running && t.indeterminate));

  $('#pmParsed').textContent = nf(t.parsedRows);
  $('#pmValid').textContent = nf(t.validRows);
  $('#pmSubmitted').textContent = nf(t.submittedRows);
  $('#pmAccepted').textContent = nf(t.acceptedRows);

  $('#exportBtn').classList.toggle('disabled-link', (t.invalidRows + t.rejectedRows) === 0);
}

/* ================= 日志 ================= */
function renderLogs(logs, reset) {
  const box = $('#logs');
  if (reset) box.innerHTML = '';
  for (const l of logs || []) appendLog(l, true);
  box.scrollTop = box.scrollHeight;
}
function appendLog(l, noScroll) {
  const box = $('#logs');
  const div = document.createElement('div');
  div.className = 'log-line log-' + (l.level || 'info');
  const time = new Date(l.at);
  div.innerHTML = `<span class="log-time">${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}</span>${esc(l.message)}`;
  box.appendChild(div);
  while (box.childNodes.length > 200) box.removeChild(box.firstChild);
  if (!noScroll) box.scrollTop = box.scrollHeight;
}

/* ================= Tabs ================= */
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
      tab.classList.add('active');
      $('#pane' + (tab.dataset.tab === 'errors' ? 'Errors' : 'Report')).classList.add('active');
      if (tab.dataset.tab === 'errors') loadErrors();
      else loadReport();
    });
  });
}

/* ================= 异常筛选 ================= */
function initFilters() {
  $('#fStage').addEventListener('change', e => { state.filter.stage = e.target.value; state.errors.page = 1; loadErrors(); });
  $('#fField').addEventListener('change', e => { state.filter.field = e.target.value; state.errors.page = 1; loadErrors(); });
  $('#fCode').addEventListener('change', e => { state.filter.code = e.target.value; state.errors.page = 1; loadErrors(); });
  $('#fSearch').addEventListener('click', () => { state.filter.q = $('#fKeyword').value.trim(); state.errors.page = 1; loadErrors(); });
  $('#fKeyword').addEventListener('keydown', e => { if (e.key === 'Enter') $('#fSearch').click(); });
  $('#fReset').addEventListener('click', () => {
    state.filter = { stage: 'all', field: 'all', code: 'all', q: '' };
    $('#fStage').value = 'all'; $('#fField').value = 'all'; $('#fCode').value = 'all'; $('#fKeyword').value = '';
    state.errors.page = 1;
    loadErrors();
  });
  $('#prevPage').addEventListener('click', () => { if (state.errors.page > 1) { state.errors.page--; loadErrors(); } });
  $('#nextPage').addEventListener('click', () => {
    if (state.errors.page * state.errors.pageSize < state.errors.total) { state.errors.page++; loadErrors(); }
  });
  $('#exportBtn').addEventListener('click', e => {
    if (!state.currentId) return e.preventDefault();
    e.preventDefault();
    window.open(`/api/tasks/${state.currentId}/errors/export`, '_blank');
  });
}

async function loadErrors() {
  if (!state.currentId) return;
  const f = state.filter;
  const qs = new URLSearchParams({ ...f, page: state.errors.page, pageSize: state.errors.pageSize });
  const resp = await fetch(`/api/tasks/${state.currentId}/errors?${qs}`);
  if (!resp.ok) return;
  const data = await resp.json();
  state.errors = { page: data.page, pageSize: data.pageSize, total: data.total, items: data.items };

  // 错误类型下拉：全量代码集合（后端聚合），切换任务时也会重建
  if (data.allCodes && data.issueLabels) {
    const codeSel = $('#fCode');
    codeSel.innerHTML = '<option value="all">全部错误类型</option>' +
      data.allCodes.map(c => `<option value="${c}">${esc(data.issueLabels[c] || c)}</option>`).join('');
    codeSel.value = f.code;
  }

  renderErrors(data.items);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  $('#pageInfo').textContent = `共 ${nf(data.total)} 条异常 · 第 ${data.page}/${pages} 页`;
  $('#prevPage').disabled = data.page <= 1;
  $('#nextPage').disabled = data.page >= pages;
}

function renderErrors(items) {
  const tb = $('#errorsBody');
  if (!items.length) {
    tb.innerHTML = '<tr><td colspan="8" class="table-empty">没有符合条件的异常行 🎉</td></tr>';
    return;
  }
  tb.innerHTML = items.map(e => `
    <tr>
      <td class="num">${e.rowNumber}</td>
      <td class="cell-code">${esc(e.drugCode) || '—'}</td>
      <td class="cell-name" title="${esc(e.name)}">${esc(e.name) || '—'}</td>
      <td>${esc(e.spec) || '—'}</td>
      <td class="num">${esc(e.price) || '—'}</td>
      <td class="cell-mfr" title="${esc(e.manufacturer)}">${esc(e.manufacturer) || '—'}</td>
      <td><span class="tag tag-${e.stage}">${e.stage === 'local' ? '本地校验' : '监管平台'}</span></td>
      <td class="err-msg">${e.messages.map(esc).join('；')}</td>
    </tr>`).join('');
}

/* ================= 任务报告 ================= */
async function loadReport() {
  if (!state.currentId) return;
  const box = $('#reportBody');
  box.innerHTML = '<p class="muted">报告生成中…</p>';
  const resp = await fetch(`/api/tasks/${state.currentId}/report`);
  if (!resp.ok) { box.innerHTML = '<p class="muted">报告暂不可用</p>'; return; }
  const r = await resp.json();

  const o = r.overview;
  const issueMax = Math.max(1, ...r.issueBreakdown.map(x => x.count));
  const mfrMax = Math.max(1, ...r.manufacturerStats.map(x => x.rejected));

  box.innerHTML = `
    <div class="rpt-section">
      <h3>处理概览</h3>
      <div class="report-grid">
        ${rptItem(o.totalRows, 'Excel 总行数')}
        ${rptItem(o.accepted, '平台最终受理')}
        ${rptItem(o.localInvalid, '本地校验拦截')}
        ${rptItem(o.rejected, '平台驳回')}
        ${rptItem(o.passRate + '%', '总体通过率')}
        ${rptItem(o.acceptanceRate + '%', '上送受理率')}
        ${rptItem(r.timing.throughput + ' 行/秒', '处理吞吐')}
        ${rptItem(r.timing.total.text, '总耗时')}
      </div>
    </div>
    <div class="rpt-section">
      <h3>阶段耗时</h3>
      <div class="report-grid">
        ${rptItem(r.timing.parseValidate.text, '解析 + 本地校验')}
        ${rptItem(r.timing.submit.text, '监管平台上送')}
      </div>
    </div>
    <div class="rpt-section">
      <h3>异常类型分布（Top 项）</h3>
      ${r.issueBreakdown.length ? r.issueBreakdown.slice(0, 12).map(x => barRow(x.label, x.count, issueMax, x.ratio)).join('') : '<p class="muted">无异常</p>'}
    </div>
    <div class="rpt-section">
      <h3>厂家上送情况（按驳回数排序，前 10）</h3>
      <div class="table-wrap">
        <table class="report-table">
          <thead><tr><th>生产厂家</th><th class="num">受理</th><th class="num">驳回</th><th class="num">受理率</th></tr></thead>
          <tbody>
            ${r.manufacturerStats.slice(0, 10).map(m => {
              const rate = m.total ? Math.round(m.accepted / m.total * 100) : 0;
              return `<tr><td title="${esc(m.manufacturer)}">${esc(m.manufacturer)}</td><td class="num">${nf(m.accepted)}</td><td class="num" style="color:${m.rejected ? 'var(--platform)' : 'inherit'}">${nf(m.rejected)}</td><td class="num">${rate}%</td></tr>`;
            }).join('') || '<tr><td colspan="4" class="table-empty">暂无数据</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    ${r.status === 'failed' ? `<div class="rpt-section"><p style="color:var(--danger)">失败原因：${esc(r.lastError || '')}</p></div>` : ''}
  `;
}

function rptItem(v, l) {
  return `<div class="rpt-item"><div class="v">${typeof v === 'number' ? nf(v) : v}</div><div class="l">${l}</div></div>`;
}
function barRow(label, count, max, ratio) {
  const pct = Math.max(2, Math.round(count / max * 100));
  const color = label.includes('平台') ? 'var(--platform)' : label.includes('厂家') ? '#c47f2e' : 'var(--warn)';
  return `<div class="barrow">
    <span class="bl" title="${esc(label)}">${esc(label)}</span>
    <span class="tt"><span class="bf" style="width:${pct}%;background:${color}"></span></span>
    <span class="bv">${nf(count)} · ${ratio}%</span>
  </div>`;
}
