"""后台任务处理引擎：解析 Excel → 分批本地校验 → 分批上送监管平台。"""
import json
import time
import traceback
from datetime import datetime

from openpyxl import load_workbook

from db import get_conn
from validator import validate_row
from regulator import submit_batch, BATCH_SIZE as REG_BATCH

LOCAL_BATCH = 1000  # 本地校验每批处理行数

HEADER_ALIASES = {
    "drug_code":    ["药品编码", "编码", "批准文号", "药品编码/批准文号", "货号"],
    "name":         ["药品名称", "名称", "品名", "通用名", "药品通用名"],
    "spec":         ["规格", "药品规格", "包装规格"],
    "price":        ["价格", "零售价", "单价", "售价", "中标价"],
    "manufacturer": ["生产厂家", "厂家", "生产企业", "厂商", "生产厂商"],
}
FIELD_ZH = {"drug_code": "药品编码", "name": "药品名称", "spec": "规格",
            "price": "价格", "manufacturer": "生产厂家"}


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def map_columns(header):
    colmap = {}
    for idx, h in enumerate(header):
        for field, aliases in HEADER_ALIASES.items():
            if h in aliases and field not in colmap:
                colmap[field] = idx
    return colmap


def _flush_errors(conn, task_id, buf):
    if not buf:
        return
    conn.executemany(
        "INSERT INTO errors (task_id,row_no,stage,field,error_type,message,row_data)"
        " VALUES (?,?,?,?,?,?,?)", buf)
    conn.commit()
    buf.clear()


def _update(conn, task_id, **kw):
    sets = ", ".join(f"{k}=?" for k in kw)
    conn.execute(f"UPDATE tasks SET {sets}, updated_at=? WHERE id=?",
                 (*kw.values(), now(), task_id))
    conn.commit()


def run_task(task_id, filepath):
    conn = get_conn()
    t_start = time.time()
    durations = {}
    try:
        # ---------- 解析 ----------
        _update(conn, task_id, status="running", stage="parsing",
                message="正在解析 Excel 文件")
        wb = load_workbook(filepath, read_only=True, data_only=True)
        ws = wb.active
        total = (ws.max_row - 1) if ws.max_row else 0
        if total <= 0:
            # 部分生成器不写维度信息导致 max_row 为空：先快速扫描计数再重新打开
            total = max(0, sum(1 for _ in ws.iter_rows(values_only=True)) - 1)
            wb.close()
            wb = load_workbook(filepath, read_only=True, data_only=True)
            ws = wb.active
        it = ws.iter_rows(values_only=True)
        try:
            header_raw = next(it)
        except StopIteration:
            raise ValueError("Excel 文件为空")
        header = [str(h).strip() if h is not None else "" for h in header_raw]
        colmap = map_columns(header)
        missing = [f for f in FIELD_ZH if f not in colmap]
        if missing:
            raise ValueError("表头缺少必需列：" + "、".join(FIELD_ZH[m] for m in missing))
        _update(conn, task_id, total_rows=total, stage="validating",
                message="本地校验中")

        # ---------- 分批本地校验 ----------
        valid_rows, err_buf = [], []
        processed = 0
        t_val = time.time()
        for raw in it:
            processed += 1
            row_no = processed + 1  # Excel 实际行号（含表头）
            rec = {}
            for f, i in colmap.items():
                v = raw[i] if i < len(raw) else None
                rec[f] = "" if v is None else (v.strip() if isinstance(v, str) else v)
            errs = validate_row(rec)
            if errs:
                row_json = json.dumps({k: str(v) for k, v in rec.items()},
                                      ensure_ascii=False)
                for field, etype, msg in errs:
                    err_buf.append((task_id, row_no, "local", field, etype, msg, row_json))
            else:
                valid_rows.append({
                    "row_no": row_no,
                    "drug_code": str(rec["drug_code"]),
                    "name": str(rec["name"]),
                    "spec": str(rec["spec"]),
                    "price": str(rec["price"]),
                    "manufacturer": str(rec["manufacturer"]),
                })
            if processed % LOCAL_BATCH == 0:
                _flush_errors(conn, task_id, err_buf)
                _update(conn, task_id, processed_rows=processed,
                        local_valid_rows=len(valid_rows),
                        local_error_rows=processed - len(valid_rows),
                        message=f"本地校验中 {processed}/{total or '?'}")
        _flush_errors(conn, task_id, err_buf)
        wb.close()
        durations["本地校验"] = round(time.time() - t_val, 2)
        _update(conn, task_id, processed_rows=processed,
                total_rows=total or processed,
                local_valid_rows=len(valid_rows),
                local_error_rows=processed - len(valid_rows),
                stage="submitting", message="上送监管平台中")

        # ---------- 分批上送监管平台 ----------
        t_sub = time.time()
        seen_codes = set()
        submitted = accepted = rejected = 0
        for i in range(0, len(valid_rows), REG_BATCH):
            batch = valid_rows[i:i + REG_BATCH]
            rejects = submit_batch(batch, seen_codes)
            submitted += len(batch)
            rejected += len(rejects)
            accepted += len(batch) - len(rejects)
            for row, field, etype, msg in rejects:
                err_buf.append((task_id, row["row_no"], "platform", field, etype, msg,
                                json.dumps(row, ensure_ascii=False)))
            _flush_errors(conn, task_id, err_buf)
            _update(conn, task_id, platform_submitted=submitted,
                    platform_accepted=accepted, platform_rejected=rejected,
                    message=f"平台上送中 {submitted}/{len(valid_rows)}")
        durations["平台上送"] = round(time.time() - t_sub, 2)
        durations["总耗时"] = round(time.time() - t_start, 2)

        _update(conn, task_id, status="completed", stage="done",
                message=(f"完成：上送成功 {accepted} 条，本地异常 "
                         f"{processed - len(valid_rows)} 条，平台驳回 {rejected} 条"),
                durations=json.dumps(durations, ensure_ascii=False),
                finished_at=now())
    except Exception as e:
        traceback.print_exc()
        _update(conn, task_id, status="failed", message=f"任务失败：{e}")
