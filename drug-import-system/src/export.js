// 异常行 Excel 导出：保留原始数据 + 错误标注，药师改原数据列后可重新上传
import ExcelJS from 'exceljs';
import { HEADERS } from './validators.js';
import { ERROR_CODE_LABEL } from './taskManager.js';

function describe(errs) {
  return errs.map((e) => `【${e.field || '整行'}】${ERROR_CODE_LABEL[e.code] ?? e.code}：${e.msg}`).join('\n');
}

export async function buildErrorWorkbook(task, records, filePath) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: true });
  const ws = wb.addWorksheet('错误行修正');
  ws.columns = [
    { header: '【辅助】原Excel行号', width: 16 },
    ...HEADERS.map((h) => ({ header: h, width: h === '厂家' ? 36 : h === '药品名称' ? 24 : 18 })),
    { header: '【辅助】错误阶段', width: 14 },
    { header: '【辅助】错误字段', width: 18 },
    { header: '【辅助】错误说明', width: 70 },
    { header: '【辅助】是否已修正', width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  try { ws.views[0] = { state: 'frozen', ySplit: 1 }; } catch { /* 冻结窗格不可用时忽略 */ }

  const localFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };
  const platformFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4E5' } };
  const bothFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4EC' } };

  for (const rec of records) {
    const stages = [];
    if (rec.local.length) stages.push('本地校验');
    if (rec.platform.length) stages.push('监管平台');
    const fields = [...new Set([...rec.local, ...rec.platform].map((e) => e.field).filter(Boolean))].join('、');
    const desc = describe([...rec.local, ...rec.platform]);
    const r = ws.addRow([
      rec.rowNo,
      ...HEADERS.map((h) => rec.data[h]),
      stages.join(' + '),
      fields,
      desc,
      '',
    ]);
    const fill = stages.length === 2 ? bothFill : rec.local.length ? localFill : platformFill;
    for (let c = 1; c <= 10; c++) r.getCell(c).fill = fill;
    r.getCell(9).alignment = { wrapText: true, vertical: 'top' };
    r.commit();
  }

  const ws2 = wb.addWorksheet('修正指引');
  ws2.columns = [{ header: '项', width: 18 }, { header: '说明', width: 90 }];
  ws2.getRow(1).font = { bold: true };
  const guide = [
    ['操作方式', '请直接在「错误行修正」表中修改红色/橙色底纹行的药品信息，保存整个文件后重新上传即可。'],
    ['可忽略列', '【辅助】开头的列（原Excel行号、错误阶段、错误字段、错误说明、是否已修正）为标注列，重新上传时系统会自动忽略。'],
    ['编码规则', '药品编码为 8690 开头的13位数字，末位是前12位之和对10取模的校验位。'],
    ['平台类错误', '橙色「监管平台」错误为平台返回，常见原因：编码未注册、备案名称/厂家不符、价格异常或重复上送，请核对后重传。'],
    ['网络超时', 'PLATFORM_NETWORK 为平台网络超时（已自动重试3次），直接重新上传该行即可。'],
    ['表头别名', '系统按表头名称识别列，支持“通用名/通用名称、生产厂家/生产企业、采购价/单价、剂型规格”等常见别名，列顺序不限。'],
  ];
  for (const g of guide) ws2.addRow(g).commit();

  await wb.commit();
  return records.length;
}
