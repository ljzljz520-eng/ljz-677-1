"""本地校验规则：药品编码 / 名称 / 规格 / 价格 / 生产厂家。"""
import re

CODE_PATTERNS = [
    re.compile(r"^YP\d{10}$"),                      # 院内编码：YP + 10位数字
    re.compile(r"^国药准字[HZS]\d{8}$"),             # 国药准字 H/Z/S + 8位数字
]
SPEC_UNITS = ("mg", "g", "ml", "μg", "IU", "iu", "片", "粒", "支", "瓶", "袋",
              "丸", "贴", "单位", "万单位", "%")
MAX_PRICE = 100000  # 本地价格上限（元）


def _s(v):
    return "" if v is None else str(v).strip()


def validate_row(row):
    """返回 [(field, error_type, message), ...]，空列表表示通过。"""
    errs = []

    # ---- 药品编码 ----
    code = _s(row.get("drug_code"))
    if not code:
        errs.append(("drug_code", "必填缺失", "药品编码不能为空"))
    elif not any(p.match(code) for p in CODE_PATTERNS):
        errs.append(("drug_code", "格式错误",
                     "编码须为「YP+10位数字」或「国药准字H/Z/S+8位数字」"))

    # ---- 药品名称 ----
    name = _s(row.get("name"))
    if not name:
        errs.append(("name", "必填缺失", "药品名称不能为空"))
    elif not (2 <= len(name) <= 100):
        errs.append(("name", "长度异常", "药品名称长度须在 2~100 字符之间"))

    # ---- 规格 ----
    spec = _s(row.get("spec"))
    if not spec:
        errs.append(("spec", "必填缺失", "规格不能为空"))
    elif len(spec) > 50:
        errs.append(("spec", "长度异常", "规格长度不能超过 50 字符"))
    elif not (re.search(r"\d", spec) and any(u in spec for u in SPEC_UNITS)):
        errs.append(("spec", "格式错误", "规格须包含数值与单位，如 0.25g、10ml、100mg*12片"))

    # ---- 价格 ----
    price_raw = _s(row.get("price"))
    if not price_raw:
        errs.append(("price", "必填缺失", "价格不能为空"))
    else:
        try:
            price = float(price_raw)
            if price <= 0:
                errs.append(("price", "取值异常", "价格必须大于 0"))
            elif price > MAX_PRICE:
                errs.append(("price", "取值异常", f"价格超过上限 {MAX_PRICE} 元"))
            else:
                s = price_raw.lower()
                if "e" not in s and "." in s and len(s.split(".")[1]) > 2:
                    errs.append(("price", "精度异常", "价格最多保留两位小数"))
        except ValueError:
            errs.append(("price", "格式错误", "价格必须为数字"))

    # ---- 生产厂家 ----
    manu = _s(row.get("manufacturer"))
    if not manu:
        errs.append(("manufacturer", "必填缺失", "生产厂家不能为空"))
    elif len(manu) < 4:
        errs.append(("manufacturer", "长度异常", "厂家名称至少 4 个字符"))
    elif not re.search(r"(公司|厂|企业|集团|制药)", manu):
        errs.append(("manufacturer", "格式错误", "厂家名称须包含 公司/厂/制药 等字样"))

    return errs
