// 监管平台上送模拟器
// 真实系统中此处替换为 HTTP 客户端（签名、加签、重试、熔断）。
// 模拟行为：网络超时（可重试）、未注册编码、名称/厂家备案不一致、价格异常、平台重复上送。

import { hash32 } from './validators.js';
import { PLATFORM_TIMEOUT_RATE, BATCH_DELAY_MS } from './config.js';

const NAME_POOL = [
  '阿莫西林胶囊', '头孢克肟分散片', '布洛芬缓释胶囊', '硝苯地平控释片', '阿托伐他汀钙片',
  '二甲双胍缓释片', '氯雷他定片', '奥美拉唑肠溶胶囊', '氨氯地平片', '左氧氟沙星片',
  '阿司匹林肠溶片', '蒙脱石散', '复方甘草口服溶液', '葡萄糖酸钙锌口服溶液', '蒲地蓝消炎口服液',
  '阿卡波糖片', '缬沙坦胶囊', '盐酸小檗碱片', '板蓝根颗粒', '藿香正气水',
];
const MFR_POOL = [
  '华北制药股份有限公司', '石药集团欧意药业有限公司', '扬子江药业集团有限公司',
  '广州白云山医药集团股份有限公司', '云南白药集团股份有限公司', '齐鲁制药有限公司',
  '成都地奥制药集团有限公司', '哈药集团三精制药厂', '江苏恒瑞医药股份有限公司',
  '修正药业集团股份有限公司',
];

// 平台已收录编码（跨任务保留，模拟真实平台状态）
const platformAccepted = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function r0(code, salt) {
  return hash32(`${salt}:${code}`) % 1000;
}

/**
 * 批量上送
 * @param rows 仅本地校验通过的行：[{rowNo, data: {药品编码,...}}]
 * @param attempt 第几次尝试（1 开始）
 * @returns {{results: Array, networkErrors: Array}}
 *   results: {rowNo, accepted, code?, msg?}
 *   networkErrors: 超时的 rowNo（调用方应重试）
 */
export async function submitBatch(rows, attempt = 1) {
  await sleep(BATCH_DELAY_MS); // 模拟网络/平台耗时

  const networkErrors = [];
  const results = [];

  for (const row of rows) {
    const { rowNo, data } = row;
    const code = data['药品编码'];

    // 0. 网络超时：按尝试次数变化，重试后可恢复
    if (r0(code + `#a${attempt}`, 'timeout') < PLATFORM_TIMEOUT_RATE * 1000) {
      networkErrors.push(rowNo);
      continue;
    }

    // 1. 编码未在监管平台注册（1.2%）
    if (r0(code, 'registered') < 12) {
      results.push({ rowNo, accepted: false, code: 'PLATFORM_CODE_NOT_FOUND', msg: '监管平台无此药品编码注册信息' });
      continue;
    }

    // 2. 名称与备案通用名不一致（1.2%）
    if (r0(code, 'name') < 12) {
      const expected = NAME_POOL[hash32('n:' + code) % NAME_POOL.length];
      results.push({ rowNo, accepted: false, code: 'PLATFORM_NAME_MISMATCH', msg: `与平台备案名称不一致，备案为「${expected}」` });
      continue;
    }

    // 3. 厂家未备案 / 备案信息不符（1.5%）
    if (r0(code, 'mfr') < 15) {
      const expected = MFR_POOL[hash32('m:' + code) % MFR_POOL.length];
      results.push({ rowNo, accepted: false, code: 'PLATFORM_MFR_NOT_FILED', msg: `生产企业未在平台备案或与备案不符，备案为「${expected}」` });
      continue;
    }

    // 4. 价格异常：平台指导价区间（约 1.8% 触发）
    if (r0(code, 'price') < 18) {
      const ref = 10 + (hash32('p:' + code) % 89000) / 100; // 10.00 ~ 899.99
      const price = Number(data['价格']);
      if (price > ref * 1.8 || price < ref * 0.55) {
        results.push({
          rowNo, accepted: false, code: 'PLATFORM_PRICE_ABNORMAL',
          msg: `价格异常：上送 ${price.toFixed(2)}，平台指导价约 ${ref.toFixed(2)}`,
        });
        continue;
      }
    }

    // 5. 平台重复上送：平台已收录的编码，约 1.2% 判定重复（真实平台对重复上送通常会退回）
    if (platformAccepted.has(code) && r0(code, 'dup') < 12) {
      results.push({ rowNo, accepted: false, code: 'PLATFORM_DUPLICATE', msg: '该编码平台已收录，重复上送；变更信息请走变更接口' });
      continue;
    }

    platformAccepted.add(code);
    results.push({ rowNo, accepted: true });
  }

  return { results, networkErrors };
}

// 仅供测试/重置
export function _resetPlatform() {
  platformAccepted.clear();
}
