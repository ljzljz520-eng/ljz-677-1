"""样本数据生成器：快速产出含可控异常比例的药品目录 Excel。"""
import random

from openpyxl import Workbook

NAMES = ["阿莫西林", "布洛芬", "头孢克肟", "阿奇霉素", "奥美拉唑", "氯雷他定",
         "二甲双胍", "阿托伐他汀", "氨氯地平", "蒙脱石", "对乙酰氨基酚",
         "左氧氟沙星", "甲硝唑", "维生素C", "葡萄糖", "氯化钠", "胰岛素",
         "阿司匹林", "辛伐他汀", "硝苯地平", "奥司他韦", "孟鲁司特"]
FORMS = ["片", "胶囊", "注射液", "颗粒", "分散片", "缓释片", "口服液", "软膏",
         "滴眼液", "喷雾剂", "肠溶片", "干混悬剂"]
MANUS = ["华北制药股份有限公司", "国药集团容生制药有限公司", "广州白云山医药集团股份有限公司",
         "扬子江药业集团有限公司", "石药控股集团有限公司", "哈药集团制药总厂",
         "齐鲁制药有限公司", "江苏恒瑞医药股份有限公司", "修正药业集团股份有限公司",
         "北京同仁堂股份有限公司", "深圳海王药业有限公司", "云南白药集团股份有限公司"]
SPECS = ["0.25g*12片/盒", "0.5g*24粒/盒", "10ml*6支/盒", "0.1g*100片/瓶",
         "2g:0.9g*10袋/盒", "5mg*14片/盒", "250ml:25g/瓶", "0.125g*6袋/盒",
         "20mg*7片/盒", "100IU*1支/盒"]


def generate_sample(path, rows=50000, error_rate=0.06, seed=None):
    rng = random.Random(seed)
    wb = Workbook(write_only=True)
    ws = wb.create_sheet("药品目录")
    ws.append(["药品编码", "药品名称", "规格", "价格", "生产厂家"])

    used_codes = []
    for i in range(rows):
        if rng.random() < 0.7:
            code = f"YP{rng.randint(0, 9999999999):010d}"
        else:
            code = f"国药准字{rng.choice('HZS')}{rng.randint(0, 99999999):08d}"
        name = rng.choice(NAMES) + rng.choice(FORMS)
        spec = rng.choice(SPECS)
        price = round(rng.uniform(1, 800), 2)
        manu = rng.choice(MANUS)

        if rng.random() < error_rate:
            kind = rng.choice(["bad_code", "empty_name", "bad_spec", "bad_price",
                               "bad_manu", "dup_code", "test_manu", "high_price"])
            if kind == "bad_code":
                code = rng.choice(["YP123", "AB12345678", "YP" + "0" * 11, ""])
            elif kind == "empty_name":
                name = ""
            elif kind == "bad_spec":
                spec = rng.choice(["10", "见说明书", ""])
            elif kind == "bad_price":
                price = rng.choice([0, -5, 150000, round(rng.uniform(1, 100), 3), "abc"])
            elif kind == "bad_manu":
                manu = rng.choice(["xx", "", "未知"])
            elif kind == "dup_code" and used_codes:
                code = rng.choice(used_codes)          # 本地能过，平台判重
            elif kind == "test_manu":
                manu = "华东测试药业有限公司"            # 本地能过，平台驳回
            elif kind == "high_price":
                price = round(rng.uniform(50001, 99000), 2)  # 超医保上限

        ws.append([code, name, spec, price, manu])
        used_codes.append(code)
    wb.save(path)
    return path
