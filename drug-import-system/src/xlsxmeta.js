// 轻量读取 xlsx 数据行数：定位 zip 内 xl/worksheets/sheet1.xml 并直接 inflate
// 流式 ZIP 写出的 local file header 中 compSize=0（data descriptor 模式），
// 因此不依赖长度字段，直接对 deflate 流解压到自然结束（Node zlib 忽略尾部多余字节）。
import { createReadStream } from 'node:fs';
import zlib from 'node:zlib';

const INFLATE_CAP = 64 * 1024 * 1024;

function readWhole(filePath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    createReadStream(filePath)
      .on('data', (b) => chunks.push(b))
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function locateEntryOffset(buf, suffix) {
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) { off++; continue; }
    const compression = buf.readUInt16LE(off + 8);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const nameStart = off + 30;
    const name = buf.slice(nameStart, nameStart + nameLen).toString('utf8');
    const dataStart = nameStart + nameLen + extraLen;
    if (compression === 8 && name.endsWith(suffix)) return dataStart;
    // compSize 可能为 0（data descriptor），无法靠长度跳转：
    // 这里只需要找到第一个匹配条目，继续逐个扫描即可。
    off = dataStart;
  }
  return -1;
}

function inflateFrom(buf, start) {
  return new Promise((resolve, reject) => {
    const ds = zlib.createInflateRaw();
    const out = [];
    let size = 0;
    let settled = false;
    const done = (truncated) => {
      if (settled) return;
      settled = true;
      resolve({ buf: Buffer.concat(out), truncated });
      ds.destroy();
    };
    ds.on('data', (d) => {
      out.push(d); size += d.length;
      if (size >= INFLATE_CAP) done(true);
    });
    ds.on('end', () => done(false));
    ds.on('error', (e) => {
      // 尾部多喂字节导致的 EOF/PENDING 错误可忽略
      if (out.length && /unexpected end of (zlib )?stream|invalid stored block lengths/i.test(String(e?.message))) {
        done(false);
      } else if (out.length) {
        done(false);
      } else reject(e);
    });
    ds.end(buf.slice(start));
  });
}

export async function readXlsxLastRow(filePath) {
  try {
    const zip = await readWhole(filePath);
    const offset = locateEntryOffset(zip, 'xl/worksheets/sheet1.xml');
    if (offset < 0) return { lastRow: null, reliable: false };
    const { buf: xmlBuf } = await inflateFrom(zip, offset);
    const xml = xmlBuf.toString('utf8');

    const m = xml.match(/<dimension[^>]*ref="(?:[A-Z]+\d+):[A-Z]+(\d+)"/);
    if (m) return { lastRow: Number(m[1]), reliable: true };

    // 无 dimension（ExcelJS 流式写出）：统计最后一个行号
    let max = 0;
    for (const mm of xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) max = Math.max(max, Number(mm[1]));
    return { lastRow: max || null, reliable: max > 0 };
  } catch {
    return { lastRow: null, reliable: false };
  }
}
