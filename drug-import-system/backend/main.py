"""药品目录大批量导入系统 —— API 服务。"""
import json
import os
import threading
import uuid
from datetime import datetime

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from openpyxl import Workbook

from db import get_conn, init_db
from paths import BASE_DIR, EXPORT_DIR, UPLOAD_DIR
from processor import FIELD_ZH, run_task
from sample_data import generate_sample

app = FastAPI(title="药品目录大批量导入系统")

STAGE_ZH = {"local": "本地校验", "platform": "监管平台"}
MAX_UPLOAD = 200 * 1024 * 1024  # 200MB


@app.on_event("startup")
def startup():
    init_db()


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _get_task_or_404(conn, task_id):
    row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row:
        raise HTTPException(404, "任务不存在")
    return dict(row)


# ---------------- 任务 ----------------

@app.post("/api/tasks")
async def create_task(file: UploadFile = File(...)):
    """上传 Excel 并创建导入任务（后台异步处理）。"""
    if not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(400, "仅支持 .xlsx 格式的 Excel 文件")
    task_id = uuid.uuid4().hex[:12]
    path = os.path.join(UPLOAD_DIR, f"{task_id}.xlsx")
    size = 0
    with open(path, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD:
                f.close()
                os.remove(path)
                raise HTTPException(413, "文件超过 200MB 限制")
            f.write(chunk)
    conn = get_conn()
    conn.execute(
        "INSERT INTO tasks (id, filename, status, stage, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?)",
        (task_id, file.filename, "pending", "pending", _now(), _now()))
    conn.commit()
    threading.Thread(target=run_task, args=(task_id, path), daemon=True).start()
    return {"task_id": task_id, "filename": file.filename}


@app.get("/api/tasks")
def list_tasks():
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50").fetchall()
    return {"items": [dict(r) for r in rows]}


@app.get("/api/tasks/{task_id}")
def task_detail(task_id: str):
    return _get_task_or_404(get_conn(), task_id)


@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: str):
    conn = get_conn()
    _get_task_or_404(conn, task_id)
    conn.execute("DELETE FROM errors WHERE task_id=?", (task_id,))
    conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))
    conn.commit()
    for p in (os.path.join(UPLOAD_DIR, f"{task_id}.xlsx"),):
        if os.path.exists(p):
            os.remove(p)
    return {"ok": True}


# ---------------- 异常数据 ----------------

@app.get("/api/tasks/{task_id}/errors")
def list_errors(task_id: str,
                stage: str = Query("", regex="^(|local|platform)$"),
                field: str = "",
                q: str = "",
                page: int = Query(1, ge=1),
                page_size: int = Query(20, ge=1, le=200)):
    """异常行筛选（按阶段/字段/关键字）+ 分页。"""
    conn = get_conn()
    _get_task_or_404(conn, task_id)
    where, args = ["task_id=?"], [task_id]
    if stage:
        where.append("stage=?"); args.append(stage)
    if field:
        where.append("field=?"); args.append(field)
    if q:
        where.append("(row_data LIKE ? OR message LIKE ? OR CAST(row_no AS TEXT) LIKE ?)")
        args += [f"%{q}%", f"%{q}%", q]
    cond = " AND ".join(where)
    total = conn.execute(f"SELECT COUNT(*) c FROM errors WHERE {cond}", args).fetchone()["c"]
    rows = conn.execute(
        f"SELECT * FROM errors WHERE {cond} ORDER BY row_no, id LIMIT ? OFFSET ?",
        args + [page_size, (page - 1) * page_size]).fetchall()
    items = []
    for r in rows:
        d = dict(r)
        d["row_data"] = json.loads(d["row_data"])
        items.append(d)
    return {"total": total, "page": page, "page_size": page_size, "items": items}


@app.get("/api/tasks/{task_id}/errors/export")
def export_errors(task_id: str, stage: str = Query("", regex="^(|local|platform)$")):
    """把错误行导出为 Excel，供药师修正后重新导入。"""
    conn = get_conn()
    task = _get_task_or_404(conn, task_id)
    where, args = ["task_id=?"], [task_id]
    if stage:
        where.append("stage=?"); args.append(stage)
    rows = conn.execute(
        f"SELECT * FROM errors WHERE {' AND '.join(where)} ORDER BY row_no, id",
        args).fetchall()
    if not rows:
        raise HTTPException(404, "没有可导出的错误数据")

    wb = Workbook(write_only=True)
    ws = wb.create_sheet("错误明细")
    ws.append(["Excel行号", "错误阶段", "错误字段", "错误类型", "错误说明",
               "药品编码", "药品名称", "规格", "价格", "生产厂家"])
    for r in rows:
        d = json.loads(r["row_data"])
        ws.append([r["row_no"], STAGE_ZH.get(r["stage"], r["stage"]),
                   FIELD_ZH.get(r["field"], r["field"]), r["error_type"], r["message"],
                   d.get("drug_code", ""), d.get("name", ""), d.get("spec", ""),
                   d.get("price", ""), d.get("manufacturer", "")])
    fname = f"errors_{task_id}_{stage or 'all'}.xlsx"
    fpath = os.path.join(EXPORT_DIR, fname)
    wb.save(fpath)
    label = {"": "全部", "local": "本地校验", "platform": "平台驳回"}[stage]
    return FileResponse(fpath, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        filename=f"导入错误明细_{label}_{task['filename']}")


# ---------------- 任务报告 ----------------

@app.get("/api/tasks/{task_id}/report")
def task_report(task_id: str):
    conn = get_conn()
    task = _get_task_or_404(conn, task_id)
    by_stage = {r["stage"]: r["c"] for r in conn.execute(
        "SELECT stage, COUNT(*) c FROM errors WHERE task_id=? GROUP BY stage",
        (task_id,))}
    by_field = [dict(r) for r in conn.execute(
        "SELECT field, COUNT(*) c FROM errors WHERE task_id=? GROUP BY field ORDER BY c DESC",
        (task_id,))]
    by_type = [dict(r) for r in conn.execute(
        "SELECT stage, error_type, COUNT(*) c FROM errors WHERE task_id=?"
        " GROUP BY stage, error_type ORDER BY c DESC", (task_id,))]
    total = task["total_rows"] or 0
    accepted = task["platform_accepted"] or 0
    durations = json.loads(task["durations"] or "{}")
    total_sec = durations.get("总耗时") or 0
    return {
        "task": task,
        "summary": {
            "total_rows": total,
            "local_valid": task["local_valid_rows"],
            "local_errors": task["local_error_rows"],
            "platform_submitted": task["platform_submitted"],
            "platform_accepted": accepted,
            "platform_rejected": task["platform_rejected"],
            "success_rate": round(accepted * 100.0 / total, 2) if total else 0,
            "throughput": round(total / total_sec, 1) if total_sec else 0,
        },
        "durations": durations,
        "error_by_stage": by_stage,
        "error_by_field": by_field,
        "error_by_type": by_type,
    }


# ---------------- 样本与首页 ----------------

@app.get("/api/sample")
def sample(rows: int = Query(50000, ge=1, le=200000),
           error_rate: float = Query(0.06, ge=0, le=0.5)):
    """生成测试用药品目录 Excel（默认 5 万行、6% 异常）。"""
    fpath = os.path.join(EXPORT_DIR, f"sample_{rows}_{uuid.uuid4().hex[:6]}.xlsx")
    generate_sample(fpath, rows, error_rate)
    return FileResponse(fpath, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        filename=f"药品目录样本_{rows}行.xlsx")


@app.get("/", response_class=HTMLResponse)
def index():
    with open(os.path.join(BASE_DIR, "frontend", "index.html"), encoding="utf-8") as f:
        return f.read()
