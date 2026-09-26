'use strict';
// 异常行 Excel 导出（流式写入，支持 5 万级行）
const ExcelJS = require('exceljs');
const { FIELD_LABELS, ISSUE_LABELS } = require('./validate');

const STAGE_LABEL = { local: '本地校验', platform: '监管平台' };

async function writeErrorWorkbook(task, res) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    useStyles: true,
    useSharedStrings: false
  });
  const ws = wb.addWorksheet('异常行明细');

  const headers = [
    { header: 'Excel行号', key: 'rowNumber', width: 10 },
    { header: '药品编码', key: 'drugCode', width: 22 },
    { header: '药品名称', key: 'name', width: 30 },
    { header: '规格', key: 'spec', width: 22 },
    { header: '价格', key: 'price', width: 12 },
    { header: '厂家', key: 'manufacturer', width: 34 },
    { header: '异常环节', key: 'stage', width: 12 },
    { header: '异常字段', key: 'fields', width: 16 },
    { header: '错误说明', key: 'messages', width: 48 },
    { header: '错误代码', key: 'codes', width: 30 }
  ];
  ws.columns = headers;
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF166A8A' } };
  ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

  for (const e of task.errors) {
    ws.addRow({
      rowNumber: e.rowNumber,
      drugCode: e.drugCode,
      name: e.name,
      spec: e.spec,
      price: e.price,
      manufacturer: e.manufacturer,
      stage: STAGE_LABEL[e.stage] || e.stage,
      fields: e.fields.map(f => FIELD_LABELS[f] || f).join('、'),
      messages: e.messages.join('；'),
      codes: e.codes.join('、')
    }).commit();
  }
  await wb.commit();
}

module.exports = { writeErrorWorkbook, STAGE_LABEL, ISSUE_LABELS };
