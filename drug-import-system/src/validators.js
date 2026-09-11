// 药品目录行级校验器（本地校验：格式 / 必填 / 值域 / 文件内重复）
// 字段：药品编码、药品名称、规格、价格、厂家

export const HEADERS = ['药品编码', '药品名称', '规格', '价格', '厂家'];

// 允许的表头别名（精确匹配，避免与“错误说明/错误字段”等标注列冲突）
const ALIASES = {
  '药品编码': '药品编码', '国家药品编码': '药品编码', '国药准字编码': '药品编码', '药品编号': '药品编码', 'drugCode': '药品编码',
  '药品名称': '药品名称', '通用名': '药品名称', '通用名称': '药品名称', '药品通用名': '药品名称', 'drugName': '药品名称',
  '规格': '规格', '剂型规格': '规格', '药品规格': '规格', '制剂规格': '规格', 'spec': '规格',
  '价格': '价格', '采购价': '价格', '采购价格': '价格', '单价': '价格', '中标价': '价格', 'price': '价格',
  '厂家': '厂家', '生产厂家': '厂家', '生产企业': '厂家', '生产企业名称': '厂家', 'manufacturer': '厂家',
};

// 解析表头行 -> { colMap: {标准字段:列索引}, unknowns: [] }
export function parseHeader(headerRow) {
  const colMap = {};
  const unknowns = [];
  (headerRow || []).forEach((cell, idx) => {
    const raw = String(cell ?? '').trim();
    if (!raw) return;
    const std = ALIASES[raw] || ALIASES[raw.toLowerCase()];
    if (std) {
      if (colMap[std] === undefined) colMap[std] = idx;
    } else {
      unknowns.push(raw);
    }
  });
  return { colMap, unknowns };
}

export function missingHeaders(colMap) {
  return HEADERS.filter((h) => colMap[h] === undefined);
}

// 取单元格文本
function cellText(row, idx) {
  if (idx === undefined) return '';
  const v = row[idx];
  if (v === null || v === undefined) return '';
  // ExcelJS 富文本/公式对象兜底
  if (typeof v === 'object') {
    if (v.text !== undefined) return String(v.text).trim();
    if (v.result !== undefined) return String(v.result).trim();
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim();
    return '';
  }
  return String(v).trim();
}

export function extractRow(row, colMap) {
  const out = {};
  for (const h of HEADERS) out[h] = cellText(row, colMap[h]);
  return out;
}

// 32 位确定性哈希（平台模拟与示例数据共用）
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------- 单字段校验 ----------
const RE_HAN = /[一-龥]/;
const RE_NAME = /^[一-龥A-Za-z0-9（）()·・\-\s]{2,50}$/;
// 规格：<剂量数字><单位> [x*<数量><包装单位>] [/<容器单位>]
// 例：250mg*24粒/盒、100ml/瓶、0.5g*12片*2板/盒、3g*10袋、5000单位
const SPEC_UNIT_SRC = '(?:mg|g|ml|μg|ug|IU|单位|片|粒|支|袋|盒|瓶|贴|枚|揿|喷|丸)';
const RE_SPEC = new RegExp(
  '^\\d+(?:\\.\\d+)?\\s*' + SPEC_UNIT_SRC +
  // 可选包装段（可多段，如 *12片*2板）
  '(?:\\s*[x×*]\\s*\\d+\\s*' + SPEC_UNIT_SRC + '?)*' +
  // 可选容器：/盒 /瓶 /袋
  '(?:\\s*\\/\\s*(?:盒|箱|包|板|瓶|支|袋))?\\s*$',
  'i',
);
const RE_SPEC_UNIT_ANY = new RegExp(SPEC_UNIT_SRC, 'i');
const RE_MFR = /^[一-龥A-Za-z0-9（）()·・.\-\s]{2,60}(有限公司|股份有限公司|集团|制药厂|药业|药厂|医药|集团有限公司)$/;
const RE_CODE = /^\d{13}$/;

export function validateCode(code) {
  if (!code) return { code: 'CODE_REQUIRED', msg: '药品编码不能为空' };
  if (!RE_CODE.test(code)) return { code: 'CODE_FORMAT', msg: '药品编码必须为13位数字' };
  if (!code.startsWith('8690')) return { code: 'CODE_PREFIX', msg: '药品编码前缀非法，应以 8690 开头（国家药品编码段）' };
  // 末位校验位：前12位数字和 mod 10
  const sum = code.slice(0, 12).split('').reduce((a, c) => a + Number(c), 0);
  if (Number(code[12]) !== sum % 10) return { code: 'CODE_CHECKSUM', msg: `校验位错误，应为 ${sum % 10}` };
  return null;
}

export function validateName(name) {
  if (!name) return { code: 'NAME_REQUIRED', msg: '药品名称不能为空' };
  if (name.length < 2 || name.length > 50) return { code: 'NAME_LENGTH', msg: '药品名称长度应在 2-50 个字符之间' };
  if (!RE_NAME.test(name)) return { code: 'NAME_CHARS', msg: '药品名称含非法字符' };
  if (!RE_HAN.test(name)) return { code: 'NAME_NO_HAN', msg: '药品名称应包含中文通用名' };
  return null;
}

export function validateSpec(spec) {
  if (!spec) return { code: 'SPEC_REQUIRED', msg: '规格不能为空' };
  if (spec.length > 40) return { code: 'SPEC_LENGTH', msg: '规格过长（>40字符）' };
  if (!/\d/.test(spec)) return { code: 'SPEC_NO_NUMBER', msg: '规格必须包含剂量数值' };
  if (!RE_SPEC_UNIT_ANY.test(spec))
    return { code: 'SPEC_UNIT', msg: '规格缺少合法计量单位（如 mg/ml/片/支…）' };
  if (!RE_SPEC.test(spec))
    return { code: 'SPEC_FORMAT', msg: '规格格式不正确，示例：250mg*12片/盒、100ml/瓶' };
  return null;
}

export function validatePrice(priceText) {
  if (!priceText) return { code: 'PRICE_REQUIRED', msg: '价格不能为空' };
  if (!/^-?\d+(\.\d+)?$/.test(priceText)) return { code: 'PRICE_NUMBER', msg: '价格必须为数字' };
  const price = Number(priceText);
  if (price <= 0) return { code: 'PRICE_POSITIVE', msg: '价格必须大于 0' };
  if (price > 99999.99) return { code: 'PRICE_RANGE', msg: '价格超出上限 99999.99' };
  if (priceText.includes('.') && priceText.split('.')[1].length > 2)
    return { code: 'PRICE_DECIMAL', msg: '价格最多保留两位小数' };
  return null;
}

export function validateManufacturer(mfr) {
  if (!mfr) return { code: 'MFR_REQUIRED', msg: '厂家不能为空' };
  if (mfr.length < 2 || mfr.length > 60) return { code: 'MFR_LENGTH', msg: '厂家名称长度应在 2-60 个字符之间' };
  if (!RE_MFR.test(mfr)) return { code: 'MFR_SUFFIX', msg: '厂家名称应以“有限公司/药业/制药厂”等合法企业后缀结尾' };
  return null;
}

const FIELD_VALIDATORS = {
  '药品编码': validateCode,
  '药品名称': validateName,
  '规格': validateSpec,
  '价格': validatePrice,
  '厂家': validateManufacturer,
};

// 校验单行（不含跨行业务校验）
// 返回错误数组：[{ field, code, msg }]
export function validateRow(data) {
  const errors = [];
  for (const field of HEADERS) {
    const e = FIELD_VALIDATORS[field](data[field]);
    if (e) errors.push({ field, ...e });
  }
  return errors;
}

// ---------- 文件内重复编码检测 ----------
// seen: Map<code, firstRowNo>，由批处理器维护
export function duplicateCheck(data, seen, rowNo) {
  const code = data['药品编码'];
  if (!code || !RE_CODE.test(code)) return null; // 格式错误已由行校验报错
  if (seen.has(code)) return { field: '药品编码', code: 'CODE_DUP_FILE', msg: `文件内重复编码，首次出现于第 ${seen.get(code)} 行` };
  seen.set(code, rowNo);
  return null;
}
