import os

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

CHROMA_DB_PATH = os.environ.get(
    "CHROMA_DB_PATH",
    os.path.join(BASE_DIR, "data", "local-chroma-data"),  # 默认值
)
