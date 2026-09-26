'use strict';
// 在线生成示例 Excel（流式下载，供演示使用）
const express = require('express');
const path = require('path');
const ExcelJS = require('exceljs');
const { WHITELIST, hash32 } = require('../lib/platform');

const router = express.Router();

const NON_WHITELIST = ['康泰小药厂', '仁济堂制药作坊', '西部生化制剂厂', '辽北中药加工厂',
  '东海县药材公司加工厂', '金穗保健品厂', '恒山民间膏药社', '新区灌装厂'];
const DRUG_WORDS = ['阿莫西林胶囊', '布洛芬缓释胶囊', '头孢克肟分散片', '硝苯地平控释片', '二甲双胍片',
  '阿托伐他汀钙片', '奥美拉唑肠溶胶囊', '氯雷他定片', '维生素C注射液', '葡萄糖酸钙口服液',
  '复方甘草片', '板蓝根颗粒', '藿香正气水', '连花清瘟胶囊', '云南白药气雾剂'];
const SPECS = ['0.25g*24粒', '0.3g*12片*2板', '100mg*30片', '5ml:0.1g*10支', '10mg*7片',
  '20mg*14粒', '1g*20袋', '0.5g*100片', '10ml*6支', '0.125g*12包'];

function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

router.get('/sample', async (req, res) => {
  const rows = Math.min(50000, Math.max(100, parseInt(req.query.rows, 10) || 50000));
  const fileName = encodeURIComponent(`药品目录示例_${rows}行.xlsx`);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename*=UTF-8''${fileName}`,
    'Cache-Control': 'no-store'
  });
  try {
    const rand = mulberry(20260926);
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: false, useSharedStrings: false });
    const ws = wb.addWorksheet('药品目录');
    ws.columns = [
      { header: '药品编码', key: 'drugCode', width: 16 },
      { header: '药品名称', key: 'name', width: 24 },
      { header: '规格', key: 'spec', width: 18 },
      { header: '价格', key: 'price', width: 10 },
      { header: '厂家', key: 'manufacturer', width: 34 }
    ];
    ws.getRow(1).font = { bold: true };

    for (let i = 1; i <= rows; i++) {
      const r = {
        drugCode: 'H' + (20000000 + i).toString(),
        name: DRUG_WORDS[i % DRUG_WORDS.length] + (i % 3 === 0 ? `（${(i % 9) + 1}号）` : ''),
        spec: SPECS[i % SPECS.length],
        price: ((rand() * 180) + 1.5).toFixed(2),
        manufacturer: rand() < 0.9 ? WHITELIST[i % WHITELIST.length] : NON_WHITELIST[i % NON_WHITELIST.length]
      };
      const x = rand();
      if (x < 0.006) r.drugCode = '';
      else if (x < 0.011) r.drugCode = 'H-' + i + '!';
      else if (x < 0.017) r.name = '';
      else if (x < 0.022) r.spec = '';
      else if (x < 0.027) r.price = i % 2 ? '' : '面议';
      else if (x < 0.031) r.price = '-5.00';
      else if (x < 0.035) r.manufacturer = '';
      if (rand() < 0.006 && i > 100) r.drugCode = 'H' + (20000000 + (i - 50)).toString();
      if (rand() < 0.002) {
        for (let k = 0; k < 50; k++) {
          const c = 'H' + (20000000 + i + k * 7919).toString();
          if (hash32(c) % 100 === 1) { r.drugCode = c; break; }
        }
      }
      ws.addRow(r).commit();
      if (i % 5000 === 0) {
        // 让出事件循环，保持响应活性
        await new Promise(r2 => setImmediate(r2));
      }
    }
    await wb.commit();
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

module.exports = router;
