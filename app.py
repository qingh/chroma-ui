"""Chroma 可视化管理台 —— Flask 后端

提供数据库 / 集合 / 文档三级的增删改查 REST 接口，前端为单页应用。
运行： python app.py   然后访问 http://127.0.0.1:5000
"""

import json
import os
import threading
from typing import Any

import chromadb
from chromadb.api import AdminAPI, ClientAPI
from chromadb.api.types import WhereDocument
from chromadb.config import DEFAULT_TENANT, Settings
from chromadb.errors import ChromaError, NotFoundError
from flask import Flask, jsonify, render_template, request
from flask.json.provider import DefaultJSONProvider

from config import CHROMA_DB_PATH

DEFAULT_DB = "default_database"

# 在 chromadb 初始化前确保目录存在，避免底层 IO 报错
os.makedirs(CHROMA_DB_PATH, exist_ok=True)

SETTINGS = Settings(
    is_persistent=True,
    persist_directory=CHROMA_DB_PATH,
    anonymized_telemetry=False,
)


class UTF8JSONProvider(DefaultJSONProvider):
    """让 jsonify 直接输出 UTF-8 中文，不转义为 \\uXXXX。"""

    ensure_ascii = False


app = Flask(__name__)
app.json = UTF8JSONProvider(app)

_clients: dict[str, ClientAPI] = {}
_admin: AdminAPI | None = None
_lock = threading.Lock()


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


# --------------------------------------------------------------------------- #
# Chroma 客户端管理
# --------------------------------------------------------------------------- #
def get_admin() -> AdminAPI:
    """惰性初始化 AdminClient（进程内单例）。"""
    global _admin
    if _admin is None:
        with _lock:
            if _admin is None:
                _admin = chromadb.AdminClient(SETTINGS)
    return _admin


def get_client(database: str) -> ClientAPI:
    """按数据库名缓存 PersistentClient，使用双重检查减少锁竞争。"""
    client = _clients.get(database)
    if client is not None:
        return client
    with _lock:
        client = _clients.get(database)
        if client is None:
            client = chromadb.PersistentClient(
                path=CHROMA_DB_PATH, settings=SETTINGS, database=database
            )
            _clients[database] = client
        return client


def get_collection(database: str, name: str) -> chromadb.Collection:
    try:
        return get_client(database).get_collection(name)
    except NotFoundError as exc:
        raise ApiError(f"集合不存在或无法打开：{name}", 404) from exc
    except ChromaError as exc:
        raise ApiError(f"无法打开集合 {name}：{exc}", 400) from exc


# --------------------------------------------------------------------------- #
# 工具函数
# --------------------------------------------------------------------------- #
def body() -> Any:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


MetadataValue = str | int | float | bool


def parse_metadata(raw: Any) -> dict[str, MetadataValue] | None:
    """接受 dict 或 JSON 字符串，返回 chroma 可用的 metadata 或 None。"""
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ApiError(f"元数据不是合法的 JSON：{exc}") from exc
    if not isinstance(raw, dict):
        raise ApiError('元数据必须是 JSON 对象，例如 {"source": "web"}')
    if not raw:
        return None
    clean: dict[str, MetadataValue] = {}
    for key, value in raw.items():
        if value is None:
            continue
        if not isinstance(value, (str, int, float, bool)):
            raise ApiError(f"元数据字段 “{key}” 只能是字符串/数字/布尔值")
        clean[str(key)] = value
    return clean or None


def rows_from_get(result: Any, *, include_distance: bool = False) -> list[dict[str, Any]]:
    """把 chroma get/query 返回值拍平成行；可选附带距离字段。"""
    ids = result.get("ids") or []
    docs = result.get("documents") or []
    metas = result.get("metadatas") or []
    dists = (result.get("distances") or []) if include_distance else None
    out: list[dict[str, Any]] = []
    for i, doc_id in enumerate(ids):
        row: dict[str, Any] = {
            "id": doc_id,
            "document": docs[i] if i < len(docs) else None,
            "metadata": metas[i] if i < len(metas) else None,
        }
        if dists is not None and i < len(dists) and dists[i] is not None:
            row["distance"] = round(float(dists[i]), 4)
        out.append(row)
    return out


@app.errorhandler(ApiError)
def _handle_api_error(exc: ApiError):
    return jsonify({"error": exc.message}), exc.status


@app.errorhandler(Exception)
def _handle_error(exc: Exception):
    if request.path.startswith("/api/"):
        app.logger.exception("接口异常")
        return jsonify({"error": f"{type(exc).__name__}: {exc}"}), 500
    raise exc


# --------------------------------------------------------------------------- #
# 页面
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return render_template("index.html", data_dir=CHROMA_DB_PATH)


# --------------------------------------------------------------------------- #
# 数据库
# --------------------------------------------------------------------------- #
@app.get("/api/databases")
def list_databases():
    dbs = get_admin().list_databases(tenant=DEFAULT_TENANT)
    names = sorted({d["name"] if isinstance(d, dict) else d.name for d in dbs})
    return jsonify(
        {"databases": names, "default": DEFAULT_DB, "data_dir": CHROMA_DB_PATH}
    )


@app.post("/api/databases")
def create_database():
    name = (body().get("name") or "").strip()
    if not name:
        raise ApiError("请填写数据库名称")
    try:
        get_admin().create_database(name, tenant=DEFAULT_TENANT)
    except Exception as exc:
        raise ApiError(f"创建失败：{exc}") from exc
    return jsonify({"name": name}), 201


@app.delete("/api/databases/<name>")
def delete_database(name):
    if name == DEFAULT_DB:
        raise ApiError("默认数据库不可删除")
    try:
        get_admin().delete_database(name, tenant=DEFAULT_TENANT)
    except Exception as exc:
        raise ApiError(f"删除失败：{exc}") from exc
    with _lock:
        _clients.pop(name, None)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# 集合
# --------------------------------------------------------------------------- #
@app.get("/api/databases/<db>/collections")
def list_collections(db):
    """列出集合。list_collections 已经返回带 metadata 的 Collection 对象，无需再次 get_collection。"""
    client = get_client(db)
    items = [
        {
            "name": col.name,
            "count": col.count(),
            "metadata": col.metadata or {},
        }
        for col in client.list_collections()
    ]
    items.sort(key=lambda x: x["name"])
    return jsonify({"collections": items})


@app.post("/api/databases/<db>/collections")
def create_collection(db):
    payload = body()
    name = (payload.get("name") or "").strip()
    if not name:
        raise ApiError("请填写集合名称")
    metadata = parse_metadata(payload.get("metadata")) or {}
    space = (payload.get("space") or "").strip()
    if space:
        metadata["hnsw:space"] = space
    try:
        get_client(db).create_collection(name=name, metadata=metadata)
    except Exception as exc:
        raise ApiError(f"创建失败：{exc}") from exc
    return jsonify({"name": name}), 201


@app.delete("/api/databases/<db>/collections/<name>")
def delete_collection(db, name):
    try:
        get_client(db).delete_collection(name)
    except Exception as exc:
        raise ApiError(f"删除失败：{exc}") from exc
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# 文档
# --------------------------------------------------------------------------- #
@app.get("/api/databases/<db>/collections/<name>/documents")
def list_documents(db, name):
    col = get_collection(db, name)
    limit = max(1, min(int(request.args.get("limit", 10)), 100))
    offset = max(0, int(request.args.get("offset", 0)))
    keyword = (request.args.get("q") or "").strip()

    where_doc: WhereDocument | None = {"$contains": keyword} if keyword else None
    if keyword:
        total = len(col.get(where_document=where_doc, include=[]).get("ids") or [])
    else:
        total = col.count()

    result = col.get(
        where_document=where_doc,
        limit=limit,
        offset=offset,
        include=["documents", "metadatas"],
    )
    return jsonify(
        {
            "rows": rows_from_get(result),
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


@app.get("/api/databases/<db>/collections/<name>/documents/<path:doc_id>")
def get_document(db, name, doc_id):
    col = get_collection(db, name)
    rows = rows_from_get(col.get(ids=[doc_id], include=["documents", "metadatas"]))
    if not rows:
        raise ApiError(f"文档不存在：{doc_id}", 404)
    return jsonify(rows[0])


@app.post("/api/databases/<db>/collections/<name>/documents")
def add_document(db, name):
    col = get_collection(db, name)
    payload = body()
    doc_id = (payload.get("id") or "").strip()
    document = payload.get("document") or ""
    if not doc_id:
        raise ApiError("请填写文档 ID")
    if not document.strip():
        raise ApiError("请填写文档内容")
    metadata = parse_metadata(payload.get("metadata"))

    existing = col.get(ids=[doc_id], include=[]).get("ids") or []
    if existing:
        raise ApiError(f"文档 ID 已存在：{doc_id}")
    col.add(
        ids=[doc_id], documents=[document], metadatas=[metadata] if metadata else None
    )
    return jsonify({"id": doc_id}), 201


@app.put("/api/databases/<db>/collections/<name>/documents/<path:doc_id>")
def update_document(db, name, doc_id):
    col = get_collection(db, name)
    payload = body()
    new_id = (payload.get("id") or doc_id).strip()
    document = payload.get("document") or ""
    if not document.strip():
        raise ApiError("请填写文档内容")
    metadata = parse_metadata(payload.get("metadata"))

    if new_id != doc_id and col.get(ids=[new_id], include=[]).get("ids"):
        raise ApiError(f"文档 ID 已存在：{new_id}")

    # 先取旧值，delete + add 失败时尝试回滚，避免集合处于不一致状态
    old = rows_from_get(col.get(ids=[doc_id], include=["documents", "metadatas"]))
    if not old:
        raise ApiError(f"文档不存在：{doc_id}", 404)
    old_doc, old_meta = old[0]["document"], old[0]["metadata"]

    col.delete(ids=[doc_id])
    try:
        col.add(
            ids=[new_id],
            documents=[document],
            metadatas=[metadata] if metadata else None,
        )
    except Exception:
        # 回滚：把旧文档按原 ID 写回
        try:
            col.add(
                ids=[doc_id],
                documents=[old_doc] if old_doc is not None else [""],
                metadatas=[old_meta] if old_meta else None,
            )
        except Exception:
            app.logger.exception("回滚文档失败：%s", doc_id)
        raise
    return jsonify({"id": new_id})


@app.delete("/api/databases/<db>/collections/<name>/documents/<path:doc_id>")
def delete_document(db, name, doc_id):
    get_collection(db, name).delete(ids=[doc_id])
    return jsonify({"ok": True})


@app.post("/api/databases/<db>/collections/<name>/query")
def query_documents(db, name):
    col = get_collection(db, name)
    payload = body()
    text = (payload.get("text") or "").strip()
    if not text:
        raise ApiError("请输入检索内容")
    n_results = max(1, min(int(payload.get("n_results") or 10), 50))
    # 不超过集合实际大小，避免 chroma 报错
    n_results = min(n_results, max(col.count(), 1))

    res = col.query(
        query_texts=[text],
        n_results=n_results,
        include=["documents", "metadatas", "distances"],
    )
    # query 返回二维数组（外层是 query 列表），取第一条
    flat = {
        "ids": res.get("ids", [[]])[0] if res.get("ids") else [],
        "documents": (res.get("documents") or [[]])[0],
        "metadatas": (res.get("metadatas") or [[]])[0],
        "distances": (res.get("distances") or [[]])[0],
    }
    rows = rows_from_get(flat, include_distance=True)
    return jsonify({"rows": rows, "total": len(rows), "limit": n_results, "offset": 0})


if __name__ == "__main__":
    print(f" * Chroma 数据目录: {CHROMA_DB_PATH}")
    app.run(host="127.0.0.1", port=5000, debug=True)
