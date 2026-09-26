'use strict';
// 生成 5 万行示例导入文件（含约 4% 本地异常 + 若干平台可驳回数据，便于演示全流程）
// 用法：node scripts/gen-sample.js [行数] [输出路径]
const path = require('path');
const ExcelJS = require('exceljs');
const { WHITELIST, hash32 } = require('../src/lib/platform');

const NON_WHITELIST = [
  '康泰小药厂', '仁济堂制药作坊', '西部生化制剂厂', '辽北中药加工厂',
  '东海县药材公司加工厂', '金穗保健品厂', '恒山民间膏药社', '新区灌装厂'
];
const DRUG_WORDS = ['阿莫西林胶囊', '布洛芬缓释胶囊', '头孢克肟分散片', '硝苯地平控释片', '二甲双胍片',
  '阿托伐他汀钙片', '奥美拉唑肠溶胶囊', '氯雷他定片', '维生素C注射液', '葡萄糖酸钙口服液',
  '复方甘草片', '板蓝根颗粒', '藿香正气水', '连花清瘟胶囊', '云南白药气雾剂'];
const SPECS = ['0.25g*24粒', '0.3g*12片*2板', '100mg*30片', '5ml:0.1g*10支', '10mg*7片',
  '20mg*14粒', '1g*20袋', '0.5g*100片', '10ml*6支', '0.125g*12包'];

// 简单确定性伪随机
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const rows = Number(process.argv[2] || 50000);
  const out = process.argv[3] || path.join(__dirname, '..', 'uploads', `sample-${rows}.xlsx`);
  const rand = mulberry(20260926);

  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: out, useStyles: false, useSharedStrings: false });
  const ws = wb.addWorksheet('药品目录');
  ws.columns = [
    { header: '药品编码', key: 'drugCode', width: 16 },
    { header: '药品名称', key: 'name', width: 24 },
    { header: '规格', key: 'spec', width: 18 },
    { header: '价格', key: 'price', width: 10 },
    { header: '厂家', key: 'manufacturer', width: 34 }
  ];
  ws.getRow(1).font = { bold: true };

  let injected = 0;
  for (let i = 1; i <= rows; i++) {
    const code = 'H' + (20000000 + i).toString(); // 9 位
    const r = {
      drugCode: code,
      name: DRUG_WORDS[i % DRUG_WORDS.length] + (i % 3 === 0 ? `（${(i % 9) + 1}号）` : ''),
      spec: SPECS[i % SPECS.length],
      price: ((rand() * 180) + 1.5).toFixed(2),
      manufacturer: rand() < 0.9 ? WHITELIST[i % WHITELIST.length] : NON_WHITELIST[i % NON_WHITELIST.length]
    };
    const x = rand();
    // ---- 注入本地校验异常（约 3.5%）----
    if (x < 0.006) { r.drugCode = ''; injected++; }
    else if (x < 0.011) { r.drugCode = 'H-' + i + '!'; injected++; } // 非法字符
    else if (x < 0.017) { r.name = ''; injected++; }
    else if (x < 0.022) { r.spec = ''; injected++; }
    else if (x < 0.027) { r.price = i % 2 ? '' : '面议'; injected++; }
    else if (x < 0.031) { r.price = '-5.00'; injected++; }
    else if (x < 0.035) { r.manufacturer = ''; injected++; }

    // ---- 注入可被平台识别的场景 ----
    // 重复编码（约 0.6%）：直接复用前面的编码 → PLATFORM_DUPLICATE
    if (rand() < 0.006 && i > 100) r.drugCode = 'H' + (20000000 + (i - 50)).toString();
    // 个别冻结编码：通过 hash 无法直接构造，随机改写尾部数字使 bucket 落入 1
    if (rand() < 0.002) {
      let n = i;
      for (let k = 0; k < 50; k++) {
        const c = 'H' + (20000000 + n + k * 7919).toString();
        if (hash32(c) % 100 === 1) { r.drugCode = c; break; }
      }
    }

    ws.addRow(r).commit();
    if (i % 10000 === 0) console.error(`生成中 ${i}/${rows}`);
  }
  await wb.commit();
  console.log(`已生成 ${rows} 行示例文件：${out}（注入本地异常约 ${injected} 行）`);
}

main().catch(e => { console.error(e); process.exit(1); });
