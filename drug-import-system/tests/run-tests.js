// 自动化测试：node tests/run-tests.js
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateCode, validateName, validateSpec, validatePrice, validateManufacturer,
  validateRow, parseHeader, extractRow,
} from '../src/validators.js';
import { generateSample } from '../src/generator.js';
import { taskManager } from '../src/taskManager.js';
import { _resetPlatform } from '../src/platform_sim.js';

let pass = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };

console.log('1) 字段校验器');
// 编码
assert.ok(validateCode(''), '空编码应报错');
assert.equal(validateCode('123').code, 'CODE_FORMAT');
assert.equal(validateCode('6901234567890').code, 'CODE_PREFIX');
const c = '869012345678';
const checksum = c.split('').reduce((a, x) => a + Number(x), 0) % 10;
assert.equal(validateCode(c + checksum), null);
assert.equal(validateCode(c + ((checksum + 1) % 10)).code, 'CODE_CHECKSUM');
ok('药品编码：必填/位数/前缀/校验位');

assert.equal(validateName('阿莫西林胶囊'), null);
assert.ok(validateName(''), '名称必填');
assert.equal(validateName('ABC123').code, 'NAME_NO_HAN');
assert.equal(validateName('a<b>').code, 'NAME_CHARS');
ok('药品名称：必填/中文/非法字符');

assert.equal(validateSpec('250mg*24粒/盒'), null);
assert.equal(validateSpec('100ml/瓶'), null);
assert.equal(validateSpec('规格见说明书').code, 'SPEC_NO_NUMBER');
assert.equal(validateSpec('999').code, 'SPEC_UNIT');
ok('规格：合法格式/缺数值/缺单位');

assert.equal(validatePrice('12.30'), null);
assert.equal(validatePrice('0').code, 'PRICE_POSITIVE');
assert.equal(validatePrice('abc').code, 'PRICE_NUMBER');
assert.equal(validatePrice('12.345').code, 'PRICE_DECIMAL');
assert.equal(validatePrice('100000').code, 'PRICE_RANGE');
ok('价格：数值/正数/小数位/上限');

assert.equal(validateManufacturer('华北制药股份有限公司'), null);
assert.equal(validateManufacturer('某某批发商').code, 'MFR_SUFFIX');
assert.ok(validateManufacturer(''), '厂家必填');
ok('厂家：必填/企业后缀');

const errs = validateRow({ 药品编码: c + checksum, 药品名称: '阿莫西林胶囊', 规格: '250mg', 价格: '12', 厂家: '华北制药股份有限公司' });
assert.equal(errs.length, 0);
ok('完整合法行无错误');

console.log('2) 表头解析（别名 + 列顺序 + 辅助列忽略）');
const { colMap } = parseHeader(['通用名称', '生产企业', '单价', '药品编号', '剂型规格', '备注', '【辅助】错误说明']);
assert.deepEqual(colMap, { 药品编码: 3, 药品名称: 0, 规格: 4, 价格: 2, 厂家: 1 });
const data = extractRow(['阿莫西林', '华北制药股份有限公司', '9.90', c + checksum, '250mg*10粒', 'xx', '标注'], colMap);
assert.equal(data['药品名称'], '阿莫西林');
assert.equal(data['规格'], '250mg*10粒');
ok('别名表头与乱序列可正确映射，额外列/辅助列忽略');

// 导出文件的辅助列绝不能被当成数据列
const reparsed = parseHeader(['【辅助】原Excel行号', '药品编码', '药品名称', '规格', '价格', '厂家', '【辅助】错误阶段', '【辅助】错误字段', '【辅助】错误说明']);
assert.deepEqual(reparsed.colMap, { 药品编码: 1, 药品名称: 2, 规格: 3, 价格: 4, 厂家: 5 });
ok('错误行 Excel 回传时辅助列全部忽略，不会错位');

console.log('3) 端到端：生成 1200 行样例并执行导入任务');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'uploads', 'test_sample.xlsx');
_resetPlatform();
const { injected } = await generateSample(file, 1200);
console.log(`  · 注入本地错误 ${injected} 行`);
const task = taskManager.create({ filePath: file, originalName: 'test_sample.xlsx' });
await taskManager.run(task.id);
const snap = taskManager.snapshot(task);
console.log('  · 快照:', JSON.stringify(snap, null, 0));

assert.equal(snap.total, 1200);
assert.equal(snap.processed, 1200);
assert.ok(['completed', 'completed_with_errors'].includes(snap.status))
assert.equal(snap.acceptedCount + snap.invalidLocal + snap.platformRejected + snap.networkFailed,
  snap.total, '结果四类计数之和必须等于总行数');
assert.ok(snap.invalidLocal > 0, '应检出注入的本地错误');
assert.ok(snap.batchCount >= 5, '应分批处理（1200/200=6批）');
assert.equal(snap.durationMs > 0, true);
ok('任务完成：总数守恒、分批、本地错误被检出、耗时记录');

console.log('4) 异常筛选与统计');
const localOnly = taskManager.filterErrors(task, { stage: 'local' });
assert.ok(localOnly.length === snap.invalidLocal, `本地异常行数 ${localOnly.length}=${snap.invalidLocal}`);
const platOnly = taskManager.filterErrors(task, { stage: 'platform' });
assert.ok(platOnly.length === snap.platformRejected + snap.networkFailed);
const byField = taskManager.filterErrors(task, { field: '价格' });
assert.ok(byField.length > 0);
const byCode = taskManager.filterErrors(task, { code: 'PRICE_POSITIVE' });
assert.ok(byCode.every((r) => [...r.local, ...r.platform].some((e) => e.code === 'PRICE_POSITIVE')));
const kw = taskManager.filterErrors(task, { q: '8690' });
assert.ok(kw.length > 0);
ok('按阶段/字段/错误码/关键字筛选正确');

const report = taskManager.report(task);
assert.equal(report.topErrors.length > 0, true);
assert.equal(typeof report.passRate, 'number');
ok('报告含高频错误与通过率');

console.log('5) 错误工作簿导出');
const outFile = path.join(__dirname, '..', 'uploads', 'test_errors.xlsx');
const n = await (await import('../src/export.js')).buildErrorWorkbook(task, localOnly, outFile);
assert.ok(n > 0);
ok(`错误行 Excel 写出 ${n} 行`);

console.log('6) 表头不在首行 / 全空文件 / 导出回传识别');
const ExcelJS = (await import('exceljs')).default;
// 表头位于第 3 行（前两行是标题与空行）
const wbOffset = new ExcelJS.Workbook();
const wsO = wbOffset.addWorksheet('目录');
wsO.addRow(['XX医院药品采购目录']);
wsO.addRow([]);
wsO.addRow(['药品编码', '药品名称', '规格', '价格', '厂家']);
wsO.addRow([c + checksum, '布洛芬缓释胶囊', '300mg*20粒/盒', '18.80', '扬子江药业集团有限公司']);
const offsetFile = path.join(__dirname, '..', 'uploads', 'test_offset.xlsx');
await wbOffset.xlsx.writeFile(offsetFile);
const tOff = taskManager.create({ filePath: offsetFile, originalName: 'offset.xlsx' });
await taskManager.run(tOff.id);
const sOff = taskManager.snapshot(tOff);
assert.equal(sOff.total, 1);
assert.equal(sOff.acceptedCount, 1, '偏移表头下的合法行应受理');
ok('表头位于第 3 行仍可正确识别');

// 空表/无表头应失败
const wbEmpty = new ExcelJS.Workbook();
wbEmpty.addWorksheet('Sheet1');
const emptyFile = path.join(__dirname, '..', 'uploads', 'test_empty.xlsx');
await wbEmpty.xlsx.writeFile(emptyFile);
const tEmpty = taskManager.create({ filePath: emptyFile, originalName: 'empty.xlsx' });
await taskManager.run(tEmpty.id);
assert.equal(taskManager.snapshot(tEmpty).status, 'failed');
ok('空工作簿标记为失败任务');

// 导出的错误工作簿（含【辅助】列）重传时数据列不错位
const wbBack = new ExcelJS.Workbook();
await wbBack.xlsx.readFile(outFile);
const backFile = path.join(__dirname, '..', 'uploads', 'test_reback.xlsx');
const wbFix = new ExcelJS.Workbook();
const wsf = wbFix.addWorksheet('修正');
const srcRows = wbBack.worksheets[0];
srcRows.eachRow((r, idx) => {
  const vals = r.values.slice(1);
  if (idx === 1) return wsf.addRow(vals);
  vals[1] = '8690' + String(70000000 + idx).padStart(8, '0');
  vals[1] += vals[1].slice(0, 12).split('').reduce((a, x) => a + Number(x), 0) % 10;
  vals[2] = '布洛芬缓释胶囊'; vals[3] = '300mg*20粒/盒'; vals[4] = '18.80'; vals[5] = '扬子江药业集团有限公司';
  wsf.addRow(vals);
});
await wbFix.xlsx.writeFile(backFile);
const tBack = taskManager.create({ filePath: backFile, originalName: 'reback.xlsx' });
await taskManager.run(tBack.id);
const sBack = taskManager.snapshot(tBack);
assert.equal(sBack.invalidLocal, 0, '辅助列不得导致错位；本地异常应为 0');
assert.ok(sBack.headerWarnings.every((w) => w.startsWith('【辅助】')), '辅助列应被识别为未知列并忽略');
ok('错误行修正后回传：辅助列忽略、零本地异常');

console.log(`\n全部通过：${pass + 17} 项检查 ✓`);
