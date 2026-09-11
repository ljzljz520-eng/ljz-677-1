// 示例 Excel 生成器：流式写出 N 行，注入约 8% 的本地可校验错误
import ExcelJS from 'exceljs';

const NAME_SPEC = [
  ['阿莫西林胶囊', '250mg*24粒/盒'], ['头孢克肟分散片', '100mg*6片/盒'],
  ['布洛芬缓释胶囊', '300mg*20粒/盒'], ['硝苯地平控释片', '30mg*7片/盒'],
  ['阿托伐他汀钙片', '20mg*7片/盒'], ['二甲双胍缓释片', '500mg*30片/盒'],
  ['氯雷他定片', '10mg*6片/盒'], ['奥美拉唑肠溶胶囊', '20mg*14粒/瓶'],
  ['苯磺酸氨氯地平片', '5mg*14片/盒'], ['盐酸左氧氟沙星片', '200mg*12片/盒'],
  ['阿司匹林肠溶片', '100mg*30片/盒'], ['蒙脱石散', '3g*10袋/盒'],
  ['复方甘草口服溶液', '100ml/瓶'], ['葡萄糖酸钙锌口服溶液', '10ml*24支/盒'],
  ['蒲地蓝消炎口服液', '10ml*12支/盒'], ['阿卡波糖片', '50mg*30片/盒'],
  ['缬沙坦胶囊', '80mg*7粒/盒'], ['盐酸小檗碱片', '100mg*24片/盒'],
  ['板蓝根颗粒', '10g*20袋/盒'], ['藿香正气水', '10ml*10支/盒'],
];
const MFRS = [
  '华北制药股份有限公司', '石药集团欧意药业有限公司', '扬子江药业集团有限公司',
  '广州白云山医药集团股份有限公司', '云南白药集团股份有限公司', '齐鲁制药有限公司',
  '成都地奥制药集团有限公司', '哈药集团三精制药厂', '江苏恒瑞医药股份有限公司',
  '修正药业集团股份有限公司', '悦康药业集团股份有限公司', '华润三九医药股份有限公司',
];

function rnd(seedObj) {
  // 简单 LCG，保证同一参数生成稳定结果
  seedObj.s = (Math.imul(seedObj.s, 1664525) + 1013904223) >>> 0;
  return seedObj.s / 4294967296;
}

function makeCode(seedObj) {
  let s = '8690';
  for (let i = 0; i < 8; i++) s += Math.floor(rnd(seedObj) * 10);
  const sum = s.split('').reduce((a, c) => a + Number(c), 0);
  return s + (sum % 10);
}

const ERROR_KINDS = 10;

/**
 * @param {string} filePath
 * @param {number} total
 * @param {(info:{row:number,total:number})=>void} [onProgress]
 */
export async function generateSample(filePath, total, onProgress) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: true });
  const ws = wb.addWorksheet('药品目录');
  ws.columns = [
    { header: '药品编码', width: 18 }, { header: '药品名称', width: 24 },
    { header: '规格', width: 18 }, { header: '价格', width: 10 },
    { header: '厂家', width: 34 },
  ];
  ws.getRow(1).font = { bold: true };

  const seed = { s: 20260911 };
  const usedCodes = [];
  let injected = 0;

  // 注意：ExcelJS 流式写入器在「对象式 addRow + 多工作表」组合下有丢行 bug，
  // 这里统一使用数组式 addRow。
  const addDrugRow = (vals) => ws.addRow(vals).commit();
  for (let i = 0; i < total; i++) {
    const [name, spec] = NAME_SPEC[Math.floor(rnd(seed) * NAME_SPEC.length)];
    const mfr = MFRS[Math.floor(rnd(seed) * MFRS.length)];
    let code = makeCode(seed);
    let price = (5 + Math.floor(rnd(seed) * 40000) / 100).toFixed(2);

    // 约 8% 行注入错误
    const inject = rnd(seed) < 0.08;
    let kind = -1;
    if (inject) {
      injected++;
      kind = Math.floor(rnd(seed) * ERROR_KINDS);
      switch (kind) {
        case 0: code = '869' + Math.floor(rnd(seed) * 1e10); break;          // 非13位
        case 1: code = code.slice(0, 12) + ((Number(code[12]) + 1) % 10); break; // 校验位错
        case 2: code = '6901' + code.slice(4); break;                        // 前缀错
        case 3: code = usedCodes.length ? usedCodes[Math.floor(rnd(seed) * usedCodes.length)] : code; break; // 文件内重复
        case 6: price = '0.00'; break;
        case 7: price = price + '5'; break;                                  // 三位小数
        case 9: code = 'ABC' + code.slice(3); break;                         // 含字母
        default: break; // 4=名称空 5=规格错 8=厂家错
      }
      addDrugRow([
        code,
        kind === 4 ? '' : name,
        kind === 5 ? '规格见说明书' : spec,
        price,
        kind === 8 ? '某某药材批发商' : mfr,
      ]);
    } else {
      addDrugRow([code, name, spec, price, mfr]);
    }

    usedCodes.push(code);
    if (onProgress && (i + 1) % 5000 === 0) onProgress({ row: i + 1, total });
  }

  // 附一个“填写说明”工作表
  const ws2 = wb.addWorksheet('填写说明');
  ws2.columns = [{ header: '说明项', width: 20 }, { header: '内容', width: 80 }];
  ws2.getRow(1).font = { bold: true };
  const notes = [
    ['表头', '药品编码 | 药品名称 | 规格 | 价格 | 厂家（首行，顺序可变，允许常见别名）'],
    ['药品编码', '13位数字，8690开头，末位为前12位和 mod 10 的校验位'],
    ['药品名称', '2-50字符，须包含中文通用名'],
    ['规格', '剂量数值+单位，如 250mg*24粒/盒、100ml/瓶'],
    ['价格', '大于0的数字，最多两位小数，上限99999.99'],
    ['厂家', '合法企业全称，以“有限公司/药业/制药厂”等结尾'],
    ['错误修正', '导入后可下载错误行Excel，修改后可重新上传，系统按表头识别'],
  ];
  for (const n of notes) ws2.addRow(n).commit();

  await wb.commit();
  onProgress?.({ row: total, total });
  return { injected };
}
