# 药品目录大批量导入系统

药师上传数万行药品 Excel，后端**流式分批**校验「药品编码 / 名称 / 规格 / 价格 / 厂家」，
再模拟批量上送监管平台；平台返回的错误行可下载 Excel 修正后重传。
前端实时展示导入进度、异常多维筛选与任务报告。

## 技术栈

- **后端**：Node.js 原生 `http` + `busboy`（上传）+ `exceljs`（流式读写 xlsx），无 Web 框架
- **前端**：原生 HTML/CSS/JS（无需构建），`XMLHttpRequest` 上传进度 + `EventSource(SSE)` 实时进度，断连自动降级轮询
- **零数据库**：任务保存在进程内存，错误行 Map 按行号索引（适合演示/单机部署；生产可换 Redis/PG）

## 快速开始

```bash
npm install
npm start          # http://localhost:3000
npm test           # 26 项自动化检查（字段校验 + 1200 行端到端 + 导出）
```

1. 打开首页，点「下载 5 万行演示样例」（系统自动生成，约 8% 行被注入各类错误）
2. 拖拽或选择样例上传，观察实时进度（总行数 / 已处理 / 校验通过 / 平台受理 / 各类异常）
3. 完成后进入「异常筛选」：按**阶段（本地/平台）、字段、错误类型、关键字**筛选，分页浏览
4. 点「下载错误行」得到带标注的 Excel，直接在原数据列修改后保存
5. 将修正后的文件重新上传，辅助标注列自动忽略，形成**闭环**

## 校验规则（本地）

| 字段 | 规则 |
|---|---|
| 药品编码 | 13 位数字、`8690` 前缀、末位为前 12 位之和 mod 10 的校验位、**文件内去重** |
| 药品名称 | 2–50 字符、含中文通用名、允许字符白名单 |
| 规格 | 剂量+合法单位（mg/ml/g/IU/片/粒/支/袋…），支持 `*包装数`、`/盒/瓶`，如 `250mg*24粒/盒` |
| 价格 | 正数、≤99999.99、最多两位小数 |
| 厂家 | 2–60 字符、以「有限公司/药业/制药厂/集团」等企业后缀结尾 |

表头按**名称识别**（支持 `通用名/通用名称、生产企业、采购价/单价、剂型规格、药品编号` 等别名），
列顺序不限，未识别列自动忽略并在任务页提示。

## 监管平台模拟（`src/platform_sim.js`）

按编码确定性哈希产生稳定结果，无需穷举药品库：

- `PLATFORM_CODE_NOT_FOUND` 编码未注册（1.2%）
- `PLATFORM_NAME_MISMATCH` 与备案通用名不一致（1.2%，附备案名）
- `PLATFORM_MFR_NOT_FILED` 厂家未备案/不符（1.5%，附备案厂家）
- `PLATFORM_PRICE_ABNORMAL` 价格偏离平台指导价（1.8%，附指导价）
- `PLATFORM_DUPLICATE` 重复上送（平台跨任务保留已收录编码）
- 网络超时（0.4%）**自动重试 3 次**（指数退避），仍失败标记 `PLATFORM_NETWORK`

接入真实平台时只需替换 `submitBatch()`（加签/HTTPS/熔断）。

## 关键设计

- **流式管线**：`WorkbookReader` 逐行读取 → 每 `BATCH_SIZE=200` 行攒批 → 异步上送；5 万行峰值内存约 200–250 MB
- **行数预扫描**（`src/xlsxmeta.js`）：直接解压 zip 内 `sheet1.xml` 读取 dimension / 统计 `<row>`，
  解决流式写出文件无 dimension 导致无法显示百分比的问题（零第三方依赖，Node 内置 zlib）
- **计数守恒**：`受理成功 + 本地异常 + 平台退回 + 网络超时 = 总行数`，测试中强断言
- **错误行 Excel**：保留原始 5 列数据 + `【辅助】` 标注列（原行号/阶段/字段/说明/是否修正），
  底纹区分本地(红)/平台(橙)/双重(粉)，重传时辅助列精确忽略，**绝不与数据列错位**
- **SSE**：每批处理完推送一次快照；连接断开前端自动切 1.5s 轮询

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/sample?rows=50000` | 生成并下载演示样例（100–100000） |
| POST | `/api/imports` | multipart 上传 .xlsx（字段名 `file`，≤60MB），返回任务 |
| GET | `/api/tasks` | 最近任务列表 |
| GET | `/api/tasks/:id` | 任务快照（轮询） |
| GET | `/api/tasks/:id/events` | SSE 实时进度（`update`/`end`） |
| GET | `/api/tasks/:id/errors` | 异常分页筛选（`stage/field/code/q/page/pageSize`） |
| GET | `/api/tasks/:id/errors.xlsx` | 下载错误行（带同样筛选参数） |
| GET | `/api/tasks/:id/report` | 聚合报告（通过率/Top错误/字段分布） |
| GET | `/api/meta` | 错误码中文标签等元数据 |

## 目录

```
src/
  server.js        HTTP 路由/上传/SSE
  taskManager.js   任务生命周期：流式读取→分批校验→分批上送→汇总/筛选/报告
  validators.js    字段规则 + 表头别名 + 文件内重复
  platform_sim.js  监管平台模拟
  generator.js     演示样例流式生成
  export.js        错误行修正 Excel
  xlsxmeta.js      xlsx 行数预扫描
  config.js        参数
public/            前端（无构建）
tests/run-tests.js 自动化测试
```
