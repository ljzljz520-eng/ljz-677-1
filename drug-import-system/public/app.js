/* 药品目录导入 - 前端逻辑 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  taskId: null,
  snap: null,
  source: null,
  pollTimer: null,
  filters: { stage: '', field: '', code: '', q: '' },
  page: 1,
  pageSize: 50,
  totalErrors: 0,
  facets: null,
};

const DONE = ['completed', 'completed_with_errors', 'failed'];
const STATUS_TEXT = {
  pending: '等待处理', processing: '处理中', completed: '全部成功',
  completed_with_errors: '完成（有异常）', failed: '处理失败',
};

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function setStep(n) {
  document.querySelectorAll('.step').forEach((el) => {
    const i = Number(el.dataset.step);
    el.classList.toggle('active', i === n);
    el.classList.toggle('done', i < n);
  });
}

/* ---------------- 上传 ---------------- */
const dz = $('dropzone');
dz.addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  if (e.target.files[0]) uploadFile(e.target.files[0]);
});
['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.add('drag');
}));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.remove('drag');
}));
dz.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) uploadFile(f);
});

$('sampleBtn').addEventListener('click', () => {
  const rows = $('sampleRows').value;
  toast('正在生成演示样例 Excel…');
  const a = document.createElement('a');
  a.href = `/api/sample?rows=${rows}`;
  a.click();
});

function uploadFile(file) {
  if (!/\.xlsx$/i.test(file.name)) { toast('仅支持 .xlsx 文件'); return; }
  $('pickedName').textContent = `已选择：${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`;
  $('uploadAlert').hidden = true;
  const up = $('uploadProgress');
  up.hidden = false;
  $('upLabel').textContent = `上传中：${file.name}`;
  $('upBar').style.width = '0%';
  $('upPct').textContent = '0%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/imports');
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      $('upBar').style.width = pct + '%';
      $('upPct').textContent = pct + '%';
    }
  };
  xhr.onload = () => {
    let res = {};
    try { res = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 400) {
      $('uploadAlert').textContent = '上传失败：' + (res.error || xhr.statusText);
      $('uploadAlert').hidden = false;
      up.hidden = true;
      return;
    }
    up.hidden = true;
    toast('上传成功，开始分批校验与上送');
    openTask(res.task.id);
  };
  xhr.onerror = () => {
    $('uploadAlert').textContent = '网络错误，上传失败';
    $('uploadAlert').hidden = false;
    up.hidden = true;
  };
  const fd = new FormData();
  fd.append('file', file);
  xhr.send(fd);
}

/* ---------------- 任务 / 进度 ---------------- */
async function openTask(id) {
  state.taskId = id;
  $('uploadCard').style.display = ''; // 保留样例入口
  $('taskCard').hidden = false;
  $('errorsCard').hidden = true;
  $('reportCard').hidden = true;
  setStep(2);
  $('taskCard').scrollIntoView({ behavior: 'smooth' });
  await refreshSnapshot();
  subscribe(id);
  resetFilters();
}

function subscribe(id) {
  state.source?.close();
  clearInterval(state.pollTimer);
  if (window.EventSource) {
    const es = new EventSource(`/api/tasks/${id}/events`);
    state.source = es;
    es.addEventListener('update', (e) => renderSnapshot(JSON.parse(e.data)));
    es.addEventListener('end', () => {
      es.close();
      refreshSnapshot().then(loadHistory);
    });
    es.onerror = () => {
      // SSE 断开后退回轮询
      es.close();
      state.pollTimer = setInterval(async () => {
        await refreshSnapshot();
        if (state.snap && DONE.includes(state.snap.status)) {
          clearInterval(state.pollTimer);
          loadHistory();
        }
      }, 1500);
    };
  } else {
    state.pollTimer = setInterval(refreshSnapshot, 1000);
  }
}

async function refreshSnapshot() {
  if (!state.taskId) return;
  const r = await fetch(`/api/tasks/${state.taskId}`);
  if (!r.ok) return;
  const { task } = await r.json();
  renderSnapshot(task);
}

function renderSnapshot(s) {
  state.snap = s;
  $('taskFileName').textContent = `· ${s.originalName}`;
  const processing = s.status === 'processing' || s.status === 'pending';
  const dot = $('stageDot');
  dot.className = 'stage-dot' + (s.status === 'failed' ? ' err' : DONE.includes(s.status) && s.status !== 'completed_with_errors' ? ' ok' : '');
  if (DONE.includes(s.status) && s.errorRows > 0) dot.className = 'stage-dot err';
  $('stageText').textContent = s.status === 'failed' ? '处理失败' : s.stage;
  const created = new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false });
  $('taskMeta').textContent =
    `任务ID ${s.id} · ${STATUS_TEXT[s.status] || s.status} · 创建于 ${created}` +
    (s.finishedAt ? ` · 耗时 ${(s.durationMs / 1000).toFixed(1)}s` : '');

  const pct = s.percent;
  const bar = $('mainBar').parentElement;
  bar.classList.toggle('indeterminate', processing && s.total === 0);
  $('mainBar').style.width = (processing && s.total === 0 ? 40 : pct) + '%';
  $('mainPct').textContent = processing && s.total === 0 ? '准备中…' : pct + '%';

  $('stTotal').textContent = fmt(s.total);
  $('stProcessed').textContent = fmt(s.processed);
  $('stAccepted').textContent = fmt(s.acceptedCount);
  $('stValid').textContent = fmt(s.validCount);
  $('stLocalErr').textContent = fmt(s.invalidLocal);
  $('stPlatErr').textContent = fmt(s.platformRejected);
  $('stNetErr').textContent = fmt(s.networkFailed);

  $('fatalAlert').hidden = s.status !== 'failed';
  $('fatalAlert').textContent = s.fatalMessage || '';
  const hw = $('headerWarn');
  if (s.headerWarnings?.length) {
    hw.hidden = false;
    hw.innerHTML = `表头中存在未识别列（已忽略）：<b>${esc(s.headerWarnings.join('、'))}</b>`;
  } else hw.hidden = true;

  $('doneActions').hidden = !DONE.includes(s.status);
  if (DONE.includes(s.status)) {
    setStep(s.errorRows ? 3 : 4);
    if (s.status === 'completed') $('goErrorsBtn').textContent = '无异常，查看任务报告 →';
    else $('goErrorsBtn').textContent = `查看 ${fmt(s.errorRows)} 行异常并筛选 →`;
    loadReport();
    loadHistory();
  }
}

const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');

$('newTaskBtn').addEventListener('click', resetView);
$('reimportBtn').addEventListener('click', resetView);
function resetView() {
  setStep(1);
  $('fileInput').value = '';
  $('pickedName').textContent = '';
  $('uploadProgress').hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('goErrorsBtn').addEventListener('click', async () => {
  if (state.snap && state.snap.errorRows === 0) { showReport(); return; }
  await showErrors();
});
$('goReportBtn').addEventListener('click', showReport);

/* ---------------- 异常筛选 ---------------- */
function resetFilters() {
  state.filters = { stage: '', field: '', code: '', q: '' };
  state.page = 1;
  $('fieldFilter').value = '';
  $('codeFilter').value = '';
  $('qFilter').value = '';
  document.querySelectorAll('#stageSeg button').forEach((b) => b.classList.toggle('on', b.dataset.val === ''));
}

async function showErrors() {
  $('errorsCard').hidden = false;
  $('reportCard').hidden = true;
  setStep(3);
  $('errorsCard').scrollIntoView({ behavior: 'smooth' });
  await loadErrors();
}

document.querySelectorAll('#stageSeg button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#stageSeg button').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    state.filters.stage = btn.dataset.val;
    state.page = 1;
    loadErrors();
  });
});
$('fieldFilter').addEventListener('change', (e) => { state.filters.field = e.target.value; state.page = 1; loadErrors(); });
$('codeFilter').addEventListener('change', (e) => { state.filters.code = e.target.value; state.page = 1; loadErrors(); });
$('clearFilterBtn').addEventListener('click', () => { resetFilters(); loadErrors(); });
let qTimer;
$('qFilter').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); state.page = 1; loadErrors(); }, 300);
});
$('prevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; loadErrors(); } });
$('nextPage').addEventListener('click', () => {
  if (state.page * state.pageSize < state.totalErrors) { state.page++; loadErrors(); }
});
$('pageSize').addEventListener('change', (e) => { state.pageSize = Number(e.target.value); state.page = 1; loadErrors(); });

function qs(extra = {}) {
  const f = { ...state.filters, ...extra };
  return new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '')).toString();
}

async function loadErrors() {
  if (!state.taskId) return;
  const url = `/api/tasks/${state.taskId}/errors?${qs({ page: state.page, pageSize: state.pageSize })}`;
  const r = await fetch(url);
  if (!r.ok) return;
  const data = await r.json();
  state.totalErrors = data.total;
  state.facets = data.facets;
  renderFacets(data.facets);
  renderErrors(data.items);
  const pages = Math.max(1, Math.ceil(data.total / state.pageSize));
  $('pageInfo').textContent = `当前筛选命中 ${fmt(data.total)} 行异常`;
  $('pageNum').textContent = `${data.page} / ${pages}`;
  $('prevPage').disabled = data.page <= 1;
  $('nextPage').disabled = data.page >= pages;
}

function renderFacets(f) {
  $('cntAll').textContent = `(${f.total})`;
  $('cntLocal').textContent = `(${f.stages.local})`;
  $('cntPlatform').textContent = `(${f.stages.platform})`;

  // 错误类型下拉（合并 local/platform code 统计）
  const cur = state.filters.code;
  const sel = $('codeFilter');
  const labels = window.ERROR_LABELS || {};
  const opts = ['<option value="">全部错误类型</option>']
    .concat(Object.entries(f.codes).sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `<option value="${esc(code)}">${esc(labels[code] || code)}（${fmt(n)}）</option>`));
  sel.innerHTML = opts.join('');
  sel.value = cur;
}

function renderErrors(items) {
  const tb = $('errTbody');
  if (!items.length) {
    tb.innerHTML = `<tr><td colspan="7"><div class="empty-state"><span class="big">✓</span>当前筛选条件下没有异常行</div></td></tr>`;
    return;
  }
  tb.innerHTML = items.map((rec) => {
    const msgs = [
      ...rec.local.map((e) => `<p class="msg-item"><span class="tag local">本地</span><b>${esc(e.field || '整行')}</b>：${esc(e.msg)}</p>`),
      ...rec.platform.map((e) => `<p class="msg-item"><span class="tag platform">平台</span>${e.field ? `<b>${esc(e.field)}</b>：` : ''}${esc(e.msg)}</p>`),
    ].join('');
    const d = rec.data;
    return `<tr>
      <td class="col-row">${rec.rowNo}</td>
      <td class="code-cell">${esc(d['药品编码'])}</td>
      <td>${esc(d['药品名称'])}</td>
      <td>${esc(d['规格'])}</td>
      <td>${esc(d['价格'])}</td>
      <td>${esc(d['厂家'])}</td>
      <td class="col-msg">${msgs}</td>
    </tr>`;
  }).join('');
}

$('dlErrBtn').addEventListener('click', () => downloadErrors(true));
$('dlAllErrBtn').addEventListener('click', () => downloadErrors(false));
function downloadErrors(withFilter) {
  const query = withFilter ? qs() : '';
  const a = document.createElement('a');
  a.href = `/api/tasks/${state.taskId}/errors.xlsx?${query}`;
  a.click();
  toast('正在生成错误行 Excel…');
}

/* ---------------- 报告 ---------------- */
async function showReport() {
  $('errorsCard').hidden = true;
  $('reportCard').hidden = false;
  setStep(4);
  $('reportCard').scrollIntoView({ behavior: 'smooth' });
  await loadReport(true);
}

async function loadReport(force = false) {
  if (!state.taskId) return;
  if (!force && $('reportCard').hidden) return;
  const r = await fetch(`/api/tasks/${state.taskId}/report`);
  if (!r.ok) return;
  const { report: rp } = await r.json();
  renderReport(rp);
}

function renderReport(r) {
  const total = r.total || 0;
  const seg = (n, cls, label) => total && n > 0
    ? `<div class="${cls}" style="width:${(n / total * 100).toFixed(2)}%" title="${label} ${fmt(n)}">${n / total > 0.07 ? fmt(n) : ''}</div>` : '';
  $('reportBody').innerHTML = `
    <div class="report-grid">
      <div class="rbox"><div class="n" style="color:var(--ok)">${fmt(r.acceptedCount)}</div><div class="l">平台受理成功（通过率 ${r.passRate}%）</div></div>
      <div class="rbox"><div class="n" style="color:var(--err)">${fmt(r.invalidLocal)}</div><div class="l">本地校验异常（占 ${r.localErrorRate}%）</div></div>
      <div class="rbox"><div class="n" style="color:var(--rej)">${fmt(r.platformRejected)}</div><div class="l">监管平台退回（退回率 ${r.platformRejectRate}%）</div></div>
      <div class="rbox"><div class="n" style="color:var(--net)">${fmt(r.networkFailed)}</div><div class="l">网络超时（重试3次仍失败）</div></div>
    </div>

    <div class="rsec">
      <h3>行数构成</h3>
      <div class="rate-bar">
        ${seg(r.acceptedCount, 'rb-ok', '成功')}
        ${seg(r.invalidLocal, 'rb-local', '本地异常')}
        ${seg(r.platformRejected, 'rb-plat', '平台退回')}
        ${seg(r.networkFailed, 'rb-net', '网络超时')}
      </div>
      <p class="muted" style="margin-top:6px">
        总计 ${fmt(total)} 行 · 空行跳过 ${fmt(r.emptyRows)} · 分 ${fmt(r.batchCount)} 批处理（每批 200 行）· 状态：
        <span class="badge ${r.status}">${STATUS_TEXT[r.status] || r.status}</span>
      </p>
    </div>

    <div class="rsec">
      <h3>任务信息</h3>
      <div class="meta-grid">
        <div>文件名：<b>${esc(r.originalName)}</b></div>
        <div>工作表：${esc(r.sheetName || '-')}</div>
        <div>任务ID：${r.id}</div>
        <div>创建时间：${new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })}</div>
        <div>开始时间：${r.startedAt ? new Date(r.startedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}</div>
        <div>完成时间：${r.finishedAt ? new Date(r.finishedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}</div>
        <div>处理耗时：<b>${(r.durationMs / 1000).toFixed(1)} 秒</b></div>
        <div>本地通过/上送：${fmt(r.validCount)}</div>
        <div>异常行数合计：<b style="color:var(--err)">${fmt(r.errorRows)}</b></div>
      </div>
    </div>

    <div class="rsec">
      <h3>高频错误类型 Top 10</h3>
      <table class="mini-table">
        <thead><tr><th>错误码</th><th>错误类型</th><th style="text-align:right">次数</th><th style="width:32%">占比</th></tr></thead>
        <tbody>${
          r.topErrors.slice(0, 10).map((e) => {
            const pct = total ? (e.count / total * 100) : 0;
            return `<tr><td class="muted">${esc(e.code)}</td><td>${esc(e.label)}</td>
              <td class="num">${fmt(e.count)}</td>
              <td><div class="rate-bar" style="height:14px"><div class="rb-local" style="width:${Math.max(pct * 5, 2)}%"></div></div>
              <span class="muted">${pct.toFixed(2)}%</span></td></tr>`;
          }).join('') || '<tr><td colspan="4" class="muted">无错误</td></tr>'
        }</tbody>
      </table>
    </div>

    <div class="rsec">
      <h3>异常字段分布</h3>
      <table class="mini-table">
        <thead><tr><th>字段</th><th style="text-align:right">异常次数</th></tr></thead>
        <tbody>${
          r.topFields.map((f) => `<tr><td>${esc(f.label)}</td><td class="num">${fmt(f.count)}</td></tr>`).join('')
          || '<tr><td colspan="2" class="muted">无</td></tr>'
        }</tbody>
      </table>
    </div>`;
}

$('reportJsonBtn').addEventListener('click', async () => {
  const r = await fetch(`/api/tasks/${state.taskId}/report`);
  const { report } = await r.json();
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `导入任务报告_${state.taskId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ---------------- 历史任务 ---------------- */
async function loadHistory() {
  const r = await fetch('/api/tasks');
  if (!r.ok) return;
  const { tasks } = await r.json();
  if (!tasks.length) return;
  $('historyCard').hidden = false;
  $('histTbody').innerHTML = tasks.slice(0, 10).map((t) => `
    <tr>
      <td title="${esc(t.originalName)}">${esc(t.originalName)}<div class="muted">${fmt(t.total)} 行</div></td>
      <td><span class="badge ${t.status}">${STATUS_TEXT[t.status] || t.status}</span></td>
      <td style="min-width:120px">
        <div class="rate-bar" style="height:10px"><div class="rb-ok" style="width:${t.percent}%"></div></div>
        <span class="muted">${t.percent}%</span>
      </td>
      <td><span style="color:var(--ok)">${fmt(t.acceptedCount)}</span> /
          <span style="color:var(--err)">${fmt(t.errorRows)}</span></td>
      <td>${t.finishedAt ? (t.durationMs / 1000).toFixed(1) + 's' : '-'}</td>
      <td class="muted">${new Date(t.createdAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
      <td>${t.id === state.taskId ? '<span class="muted">当前</span>'
        : `<button class="btn sm" onclick="window.__open('${t.id}')">打开</button>`}</td>
    </tr>`).join('');
}
window.__open = (id) => { openTask(id); };

/* ---------------- 元数据 / 历史任务 ---------------- */
window.ERROR_LABELS = {};
fetch('/api/meta')
  .then((r) => r.json())
  .then((m) => { window.ERROR_LABELS = m.errorCodeLabels || {}; })
  .catch(() => {});
loadHistory();
