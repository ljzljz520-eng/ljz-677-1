# 药品目录大批量导入平台

药师上传数万行药品目录 Excel，后端**流式解析 → 分批本地校验 → 分批模拟上送监管平台**，
平台/本地返回的错误行可**筛选、分页、下载修正表**；前端实时展示导入进度、异常筛选与任务报告。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Node.js + Express | 单进程异步流水线 |
| Excel | ExcelJS Stream Reader / Writer | 流式读写，5 万行常驻内存 ≈ 120MB |
| 上传 | Multer | 磁盘暂存，≤ 60MB / 仅 .xlsx/.xls |
| 实时 | SSE（Server-Sent Events） | 进度/日志推送，断线自动降级 4s 轮询 |
| 前端 | 原生 HTML + CSS + ES2017（无构建） | 静态托管在 Express |
| 存储 | 内存（保留最近 20 个任务） | 演示实现，可平滑替换为 Redis/DB |

## 快速开始

```bash
npm install
npm start                      # http://localhost:3000

# 可选：命令行生成示例 Excel（含可复现的异常数据）
npm run sample -- 50000        # 生成 uploads/sample-50000.xlsx
```

也可以直接在页面上点击「下载 5 万行示例 Excel」（`GET /api/sample?rows=50000`）。

## 导入文件格式

首个工作表、首行表头，必须包含五列（列名容忍 BOM / 全角空格 / 常见别名）：

| 列 | 别名 | 本地校验规则 |
|---|---|---|
| 药品编码 | 药品编号 / 国药准字代码 | 非空；8–20 位字母数字 |
| 药品名称 | 通用名 | 非空；≤ 80 字符 |
| 规格 | 药品规格 | 非空；≤ 100 字符 |
| 价格 | 单价 / 采购价 / 中标价 | 非空；数字（容忍 ¥ ￥ , 空格）；0.01–999999.99 |
| 厂家 | 生产厂家 / 生产企业 | 非空 |

## 处理流水线

```
上传 (Multer 落盘)
  └─ 阶段①② 流式解析 + 每 500 行一块本地校验   → 进度不确定（滑动动画）+ 已读行数
       └─ 阶段③ 每 500 行一批上送监管平台      → 75% → 100% 确定进度
            ├─ 平台返回 200 + 逐条受理/驳回结果
            ├─ 第 7 批首次返回 HTTP 503 → 3 秒后自动重试（演示故障恢复）
            └─ 汇总：completed / completed_with_errors / failed
```

监管平台模拟器（`src/lib/platform.js`）的**确定性**规则（同一编码每次结果一致）：

- 批次内重复编码 → `PLATFORM_DUPLICATE`
- hash 桶 0：查无此编码；桶 1：编码冻结/停用；桶 2–3：价格备案不一致
- 厂家不在 12 家备案企业名单内 → 高概率 `PLATFORM_MANUFACTURER_MISMATCH`

## 异常行回收修正

- 页面「异常筛选」：按 **环节（本地/平台）、字段、错误类型、关键字** 组合筛选 + 分页
- 「下载异常行修正表」导出 Excel：含原始 5 列值 + Excel 行号 + 异常环节 + 异常字段 + 错误说明 + 错误代码
- 药师在表中直接修改后，重新上传即创建新任务（修正后编码一致，平台结果可复现）

## 任务报告

总行数 / 本地拦截 / 平台受理与驳回 / 通过率 / 上送受理率 / 各阶段耗时与吞吐 /
异常类型分布条形图 / 各厂家受理-驳回 Top 榜。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks` | 任务列表（摘要） |
| POST | `/api/tasks` | multipart 上传 Excel，202 返回任务并异步开跑 |
| GET | `/api/tasks/:id/events` | SSE：snapshot/update/log/done/failed + 15s 心跳 |
| GET | `/api/tasks/:id/errors` | 异常分页筛选 `stage/field/code/q/page/pageSize` |
| GET | `/api/tasks/:id/report` | 任务报告 |
| GET | `/api/tasks/:id/errors/export` | 下载异常修正 Excel |
| GET | `/api/sample?rows=N` | 流式生成示例 Excel（N ≤ 50000） |

## 目录结构

```
server.js                 Express 入口
src/lib/store.js          内存任务表 + 事件总线
src/lib/validate.js       表头映射 + 单行规则校验 + 错误字典
src/lib/platform.js       监管平台上送模拟器（确定性 + 瞬时故障）
src/lib/pipeline.js       解析/校验/上送流水线
src/lib/excelReport.js    异常行 Excel 流式导出
src/routes/tasks.js       任务相关路由
src/routes/sample.js      示例文件生成路由
scripts/gen-sample.js     命令行示例生成器
public/                   前端（index.html / app.js / styles.css）
```

## 性能参考（本机）

5 万行 / 1.7MB 文件：解析+校验 ≈ 6 秒，上送 97 批 ≈ 10 秒，进程 RSS ≈ 120MB。
