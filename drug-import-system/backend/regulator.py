"""模拟监管平台：批量上送、确定性驳回规则、模拟网络延迟。"""
import hashlib
import time

BATCH_SIZE = 2000                 # 每批上送条数
NETWORK_LATENCY = 0.15            # 每批模拟网络耗时（秒）
MAX_REIMBURSE_PRICE = 50000       # 医保支付上限（元）


def _bucket(code: str) -> int:
    return hashlib.md5(code.encode("utf-8")).digest()[0] % 50


def submit_batch(rows, seen_codes):
    """审核一批药品，返回 [(row, field, error_type, message), ...] 驳回列表。

    规则（模拟真实监管平台行为，全部确定性、可复现）：
      1. 编码与已上送记录重复        → 驳回
      2. 厂家含「测试」              → 未在平台备案
      3. 价格超过医保支付上限 5 万   → 价格异常
      4. 哈希抽检 2%                 → 编码与厂家绑定关系不存在
    """
    time.sleep(NETWORK_LATENCY)
    rejects = []
    for r in rows:
        code = r["drug_code"]
        if code in seen_codes:
            rejects.append((r, "drug_code", "平台驳回", "药品编码重复，平台已存在该药品"))
            continue
        seen_codes.add(code)
        if "测试" in r["manufacturer"]:
            rejects.append((r, "manufacturer", "平台驳回", "生产厂家未在监管平台备案"))
        elif float(r["price"]) > MAX_REIMBURSE_PRICE:
            rejects.append((r, "price", "平台驳回", "价格超过医保支付上限（50000元）"))
        elif _bucket(code) == 0:
            rejects.append((r, "drug_code", "平台抽检", "模拟平台抽检：编码与厂家绑定关系不存在"))
    return rejects
