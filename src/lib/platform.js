'use strict';
// 监管平台上送模拟器：对一批药品记录做确定性校验并返回逐条结果
// 真实环境应替换为 HTTP 客户端调用监管开放接口

const WHITELIST = [
  '华润医药控股有限公司', '石药集团有限公司', '扬子江药业集团有限公司',
  '广州白云山医药集团股份有限公司', '云南白药集团股份有限公司', '齐鲁制药有限公司',
  '恒瑞医药股份有限公司', '修正药业集团股份有限公司', '华北制药股份有限公司',
  '华东医药股份有限公司', '哈药集团有限公司', '正大天晴药业集团股份有限公司'
];

// 简单稳定 hash（FNV-1a 32bit），保证同一条记录每次上送结果一致
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0);
}

function normMfr(s) {
  return String(s || '').replace(/[\s（）()股份有限集团公司集团]/g, '');
}

function manufacturerMatched(mfr) {
  const n = normMfr(mfr);
  if (!n) return false;
  return WHITELIST.some(w => {
    const wn = normMfr(w);
    return wn.includes(n) || n.includes(wn);
  });
}

/**
 * 模拟一次平台批量提交
 * @param {Array} rows  本地校验通过的行
 * @param {object} opts { batchIndex, attempt, seenCodes:Set }
 * @returns {{ status:'ok'|'transient', results:Array<{rowNumber,accepted,reason?}> }}
 */
function submitBatch(rows, opts = {}) {
  const { batchIndex = 0, attempt = 1, seenCodes = new Set() } = opts;

  // 演示：第 7 批首次提交时平台暂时不可用，重试即恢复
  if (batchIndex === 6 && attempt === 1) {
    return { status: 'transient', httpStatus: 503, message: '监管平台暂时不可用（HTTP 503）', results: [] };
  }

  const results = rows.map(r => {
    const h = hash32(r.drugCode);
    const bucket = h % 100;
    let reason = null;

    // 批次内重复申报
    if (seenCodes.has(r.drugCode)) {
      reason = 'PLATFORM_DUPLICATE';
    } else if (bucket < 1) {
      reason = 'PLATFORM_CODE_NOT_FOUND';
    } else if (bucket < 2) {
      reason = 'PLATFORM_FROZEN';
    } else if (bucket < 4) {
      // 价格备案不一致（确定性，约 2%）
      reason = 'PLATFORM_PRICE_MISMATCH';
    } else if (!manufacturerMatched(r.manufacturer) && bucket < 50) {
      // 非备案厂家：高概率被拒，体现"厂家"校验维度
      reason = 'PLATFORM_MANUFACTURER_MISMATCH';
    }
    seenCodes.add(r.drugCode);

    return reason
      ? { rowNumber: r.rowNumber, accepted: false, reason }
      : { rowNumber: r.rowNumber, accepted: true };
  });

  return { status: 'ok', httpStatus: 200, results };
}

module.exports = { submitBatch, manufacturerMatched, WHITELIST, hash32 };
