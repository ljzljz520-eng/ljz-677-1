'use strict';
// 表头映射 + 单行规则校验

const HEADERS = [
  { key: 'drugCode', label: '药品编码', aliases: ['药品编码', '药品编号', '国药准字代码', '编码'] },
  { key: 'name', label: '药品名称', aliases: ['药品名称', '通用名', '名称'] },
  { key: 'spec', label: '规格', aliases: ['规格', '药品规格'] },
  { key: 'price', label: '价格', aliases: ['价格', '单价', '采购价', '中标价'] },
  { key: 'manufacturer', label: '厂家', aliases: ['厂家', '生产厂家', '生产企业', '制造商'] }
];

const FIELD_LABELS = {
  drugCode: '药品编码', name: '药品名称', spec: '规格', price: '价格', manufacturer: '厂家'
};

const ISSUE_LABELS = {
  DRUG_CODE_EMPTY: '药品编码为空',
  DRUG_CODE_FORMAT: '药品编码格式不正确（应为 8-20 位字母/数字）',
  NAME_EMPTY: '药品名称为空',
  NAME_TOO_LONG: '药品名称过长（超过 80 个字符）',
  SPEC_EMPTY: '规格为空',
  SPEC_TOO_LONG: '规格过长（超过 100 个字符）',
  PRICE_EMPTY: '价格为空',
  PRICE_INVALID: '价格不是有效数字',
  PRICE_RANGE: '价格超出合理范围（0.01 ~ 999999.99）',
  MANUFACTURER_EMPTY: '厂家为空',
  // 监管平台返回
  PLATFORM_CODE_NOT_FOUND: '监管平台查无此药品编码',
  PLATFORM_PRICE_MISMATCH: '价格与平台备案价格不一致',
  PLATFORM_MANUFACTURER_MISMATCH: '生产厂家与备案信息不一致',
  PLATFORM_FROZEN: '药品编码已被监管平台冻结/停用',
  PLATFORM_DUPLICATE: '本批次存在重复申报记录',
  PLATFORM_BATCH_FAILED: '批次提交失败（平台暂时不可用）'
};

/** 去除 BOM / 全角空格 / 首尾空白，统一表头匹配 */
function normalizeHeader(h) {
  return String(h == null ? '' : h)
    .replace(/^﻿/, '')
    .replace(/　/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

function buildHeaderMap(headerValues) {
  const map = {};
  const missing = [];
  const normalized = (headerValues || []).map(normalizeHeader);
  for (const h of HEADERS) {
    const idx = normalized.findIndex(v => h.aliases.some(a => normalizeHeader(a) === v));
    if (idx === -1) missing.push(h.label);
    else map[h.key] = idx;
  }
  return { map, missing };
}

function clean(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/　/g, ' ').trim();
}

function parsePrice(text) {
  if (text === '') return null;
  // 允许 ¥、逗号、空格
  const s = text.replace(/[¥￥,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 校验一行，返回错误记录（无错误返回 null）
 * row: { rowNumber, drugCode, name, spec, priceText, manufacturer }
 */
function validateRow(row) {
  const codes = [];
  const fields = [];
  const messages = [];

  const add = (field, code) => {
    codes.push(code);
    if (!fields.includes(field)) fields.push(field);
    messages.push(ISSUE_LABELS[code] || code);
  };

  // 药品编码
  if (!row.drugCode) {
    add('drugCode', 'DRUG_CODE_EMPTY');
  } else if (!/^[A-Za-z0-9]{8,20}$/.test(row.drugCode)) {
    add('drugCode', 'DRUG_CODE_FORMAT');
  }

  // 药品名称
  if (!row.name) {
    add('name', 'NAME_EMPTY');
  } else if (row.name.length > 80) {
    add('name', 'NAME_TOO_LONG');
  }

  // 规格
  if (!row.spec) {
    add('spec', 'SPEC_EMPTY');
  } else if (row.spec.length > 100) {
    add('spec', 'SPEC_TOO_LONG');
  }

  // 价格
  row.price = parsePrice(row.priceText);
  if (row.priceText === '') {
    add('price', 'PRICE_EMPTY');
  } else if (row.price === null) {
    add('price', 'PRICE_INVALID');
  } else if (row.price < 0.01 || row.price > 999999.99) {
    add('price', 'PRICE_RANGE');
  } else {
    row.price = Math.round(row.price * 100) / 100;
  }

  // 厂家
  if (!row.manufacturer) {
    add('manufacturer', 'MANUFACTURER_EMPTY');
  }

  if (!codes.length) return null;
  return {
    rowNumber: row.rowNumber,
    stage: 'local',
    fields,
    codes,
    messages,
    drugCode: row.drugCode,
    name: row.name,
    spec: row.spec,
    price: row.priceText,
    manufacturer: row.manufacturer
  };
}

module.exports = {
  HEADERS, FIELD_LABELS, ISSUE_LABELS,
  normalizeHeader, buildHeaderMap, clean, parsePrice, validateRow
};
