import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
EXPORT_DIR = os.path.join(BASE_DIR, "exports")
DB_PATH = os.path.join(DATA_DIR, "app.db")

for _d in (DATA_DIR, UPLOAD_DIR, EXPORT_DIR):
    os.makedirs(_d, exist_ok=True)
