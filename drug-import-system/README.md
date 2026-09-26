# 药品目录大批量导入系统

药师上传 5 万行 Excel → 后端分批校验（编码/名称/规格/价格/厂家）→ 模拟上送监管平台 → 平台驳回行可下载修正。前端实时展示导入进度、异常筛选与任务报告。

## 运行

```bash
pip install -r requirements.txt
cd backend
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
```

浏览器打开 http://localhost:8000

## 功能

| 模块 | 说明 |
|---|---|
| 上传 | 拖拽/选择 .xlsx，支持 5 万+ 行，XHR 上传进度条 |
| 本地校验 | 分批 1000 行：编码格式（YP+10位 / 国药准字）、名称长度、规格单位、价格范围与精度、厂家合法性 |
| 平台上送 | 模拟监管平台，分批 2000 行 + 网络延迟；驳回规则：编码重复、厂家未备案、超医保支付上限、2% 哈希抽检 |
| 错误回执 | 按阶段/字段/关键字筛选，导出 Excel（全部/仅本地/仅平台）供修正后重新导入 |
| 任务报告 | 成功率、吞吐、各阶段耗时、异常字段/类型分布图 |
| 样本生成 | `/api/sample?rows=50000&error_rate=0.06` 一键生成含典型错误的测试文件 |

## API

- `POST /api/tasks` 上传文件创建任务
- `GET /api/tasks` / `GET /api/tasks/{id}` 任务列表/详情（进度轮询）
- `GET /api/tasks/{id}/errors?stage=&field=&q=&page=` 异常筛选
- `GET /api/tasks/{id}/errors/export?stage=` 错误 Excel 下载
- `GET /api/tasks/{id}/report` 任务报告
- `DELETE /api/tasks/{id}` 删除任务
