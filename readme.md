# Chroma 控制台

基于 Flask 的 Chroma 可视化管理界面，支持**数据库 → 集合 → 文档**三级的增删改查。

## 安装

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 运行

```bash
.venv/bin/python app.py
```

打开 http://127.0.0.1:5000 即可。数据默认持久化在 `./data/local-chroma-data`，
可通过环境变量 `CHROMA_DB_PATH` 指定其他目录；删除该目录即可重置全部数据。

## 功能

| 层级 | 能力 |
| --- | --- |
| 数据库 | 新建、切换、删除（`default_database` 受保护） |
| 集合 | 新建（可选 cosine / l2 / ip 距离度量与元数据）、删除、文档计数 |
| 文档 | 新增、编辑（含改 ID）、删除、分页浏览 |
| 检索 | 关键词包含匹配；语义检索（向量相似度，显示距离） |

文档写入时由 Chroma 内置的 embedding 模型自动生成向量，首次使用会下载模型。

## REST 接口

```
GET    /api/databases
POST   /api/databases                                    {name}
DELETE /api/databases/<db>

GET    /api/databases/<db>/collections
POST   /api/databases/<db>/collections                   {name, space?, metadata?}
DELETE /api/databases/<db>/collections/<col>

GET    /api/databases/<db>/collections/<col>/documents?limit&offset&q
GET    /api/databases/<db>/collections/<col>/documents/<id>
POST   /api/databases/<db>/collections/<col>/documents   {id, document, metadata?}
PUT    /api/databases/<db>/collections/<col>/documents/<id>
DELETE /api/databases/<db>/collections/<col>/documents/<id>
POST   /api/databases/<db>/collections/<col>/query       {text, n_results?}
```

## 文件结构

```
app.py                Flask 后端与 REST 接口
templates/index.html  单页界面
static/style.css      样式
static/app.js         前端逻辑
1.py                  最初的 Chroma 上手示例
```
