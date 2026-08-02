/* Chroma 控制台 —— 前端逻辑 */

// 启动时一次性缓存全部界面元素，避免热路径上反复 getElementById
const $ = (id) => document.getElementById(id);
const dom = {
  dbSelect: $("dbSelect"),
  btnNewDb: $("btnNewDb"),
  btnDelDb: $("btnDelDb"),
  btnNewCol: $("btnNewCol"),
  btnAddDoc: $("btnAddDoc"),
  btnSearch: $("btnSearch"),
  btnReset: $("btnReset"),
  btnPrev: $("btnPrev"),
  btnNext: $("btnNext"),
  colList: $("colList"),
  colTitle: $("colTitle"),
  colMeta: $("colMeta"),
  thDist: $("thDist"),
  docBody: $("docBody"),
  emptyState: $("emptyState"),
  pageInfo: $("pageInfo"),
  searchInput: $("searchInput"),
  searchMode: $("searchMode"),
  toast: $("toast"),
  loading: $("loading"),
  dbModal: $("dbModal"),
  colModal: $("colModal"),
  docModal: $("docModal"),
  docModalTitle: $("docModalTitle"),
  docForm: $("docForm"),
};

const state = {
  db: null,
  collection: null,
  limit: 10,
  offset: 0,
  total: 0,
  keyword: "",
  mode: "keyword",   // keyword | semantic
  semantic: false,   // 当前列表是否为语义检索结果
  editingId: null,
};

/* ------------------------------ 基础工具 ------------------------------ */
let loadingCount = 0;
function setLoading(on) {
  loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
  dom.loading.hidden = loadingCount === 0;
}

let toastTimer;
function toast(message, isError = false) {
  const el = dom.toast;
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 4200 : 2200);
}

async function api(path, options = {}) {
  setLoading(true);
  try {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  } finally {
    setLoading(false);
  }
}

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const enc = encodeURIComponent;

function openModal(dialog) {
  dialog.showModal();
  dialog.querySelector("input, textarea")?.focus();
}

/* ------------------------------ 数据库 ------------------------------ */
const remember = {
  get: (key) => {
    try { return localStorage.getItem(`chroma.${key}`); } catch { return null; }
  },
  set: (key, value) => {
    try { localStorage.setItem(`chroma.${key}`, value ?? ""); } catch { /* 忽略 */ }
  },
};

async function loadDatabases(preferred) {
  const { databases, default: def } = await api("/api/databases");
  dom.dbSelect.innerHTML = databases
    .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`)
    .join("");

  const last = remember.get("db");
  state.db = [preferred, state.db, last, def].find((n) => databases.includes(n))
    || databases[0]
    || null;

  dom.dbSelect.value = state.db || "";
  remember.set("db", state.db);
  dom.btnDelDb.disabled = !state.db || state.db === def;
  await loadCollections();
}

/* ------------------------------ 集合 ------------------------------ */
async function loadCollections(preferred) {
  const list = dom.colList;
  if (!state.db) {
    list.innerHTML = '<li class="side-empty">请先创建数据库</li>';
    return selectCollection(null);
  }

  const { collections } = await api(`/api/databases/${enc(state.db)}/collections`);
  if (!collections.length) {
    list.innerHTML = '<div class="side-empty">还没有集合，点击右上角新建。</div>';
    return selectCollection(null);
  }

  const names = collections.map((c) => c.name);
  const last = remember.get(`col.${state.db}`);
  const active = [preferred, state.collection, last].find((n) => names.includes(n))
    || names[0];
  remember.set(`col.${state.db}`, active);

  list.innerHTML = collections
    .map(
      (c) => `
      <li data-name="${esc(c.name)}" class="${c.name === active ? "active" : ""}">
        <span class="col-name" title="${esc(c.name)}">${esc(c.name)}</span>
        <span class="badge">${c.count}</span>
        <button class="del" data-del="${esc(c.name)}" title="删除集合">×</button>
      </li>`
    )
    .join("");

  await selectCollection(active, collections.find((c) => c.name === active));
}

async function selectCollection(name, info) {
  state.collection = name;
  state.offset = 0;
  state.keyword = "";
  state.semantic = false;
  dom.searchInput.value = "";

  const has = Boolean(name);
  for (const el of [dom.btnAddDoc, dom.searchInput, dom.btnSearch, dom.btnReset]) {
    el.disabled = !has;
  }

  dom.colTitle.textContent = name || "未选择集合";
  if (!has) {
    dom.colMeta.textContent = "从左侧选择一个集合开始管理文档";
    renderRows([]);
    dom.pageInfo.textContent = "";
    return;
  }

  const meta = info?.metadata || {};
  const bits = Object.entries(meta).map(([k, v]) => `${k}=${v}`);
  dom.colMeta.textContent =
    `${info?.count ?? 0} 条文档` + (bits.length ? ` · ${bits.join(" · ")}` : "");

  await loadDocuments();
}

/* ------------------------------ 文档 ------------------------------ */
async function loadDocuments() {
  if (!state.collection) return;
  const base = `/api/databases/${enc(state.db)}/collections/${enc(state.collection)}`;

  let data;
  if (state.semantic && state.keyword) {
    data = await api(`${base}/query`, {
      method: "POST",
      body: JSON.stringify({ text: state.keyword, n_results: 20 }),
    });
  } else {
    const query = new URLSearchParams({
      limit: state.limit,
      offset: state.offset,
      q: state.keyword,
    });
    data = await api(`${base}/documents?${query}`);
  }

  state.total = data.total;
  renderRows(data.rows);
  renderPager();
}

function renderRows(rows) {
  dom.thDist.hidden = !state.semantic;

  // 用 DocumentFragment 一次性插入，减少重排
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const meta = row.metadata || {};
    const chips =
      Object.entries(meta)
        .map(([k, v]) => `<span class="meta-chip">${esc(k)}: ${esc(v)}</span>`)
        .join("") || '<span class="sub">—</span>';
    const tr = document.createElement("tr");
    tr.innerHTML = `
        <td class="mono">${esc(row.id)}</td>
        <td><div class="doc-text">${esc(row.document)}</div></td>
        <td>${chips}</td>
        ${state.semantic ? `<td class="mono">${row.distance ?? "—"}</td>` : ""}
        <td class="col-act">
          <button class="link" data-edit="${esc(row.id)}">编辑</button>
          <button class="link danger" data-remove="${esc(row.id)}">删除</button>
        </td>`;
    frag.appendChild(tr);
  }
  dom.docBody.replaceChildren(frag);

  dom.emptyState.hidden = rows.length > 0;
  dom.emptyState.textContent = state.keyword ? "没有匹配的文档" : "暂无数据";
}

function renderPager() {
  if (state.semantic) {
    dom.pageInfo.textContent = `语义检索：返回 ${state.total} 条最相近的结果`;
    dom.btnPrev.disabled = dom.btnNext.disabled = true;
    return;
  }
  const from = state.total === 0 ? 0 : state.offset + 1;
  const to = Math.min(state.offset + state.limit, state.total);
  dom.pageInfo.textContent = `共 ${state.total} 条 · 显示 ${from}-${to}`;
  dom.btnPrev.disabled = state.offset === 0;
  dom.btnNext.disabled = state.offset + state.limit >= state.total;
}

/* ------------------------------ 事件绑定 ------------------------------ */
function bindEvents() {
  // 数据库
  dom.dbSelect.addEventListener("change", async (e) => {
    state.db = e.target.value;
    state.collection = null;
    await withError(() => loadDatabases(state.db));
  });

  dom.btnNewDb.addEventListener("click", () => openModal(dom.dbModal));

  $("dbForm").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    const name = new FormData(e.target).get("name").trim();
    e.target.reset();
    await withError(async () => {
      await api("/api/databases", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      toast(`数据库 ${name} 已创建`);
      state.collection = null;
      await loadDatabases(name);
    });
  });

  dom.btnDelDb.addEventListener("click", async () => {
    if (!confirm(`确定删除数据库「${state.db}」及其全部集合？此操作不可恢复。`)) return;
    await withError(async () => {
      await api(`/api/databases/${enc(state.db)}`, { method: "DELETE" });
      toast("数据库已删除");
      state.db = null;
      state.collection = null;
      await loadDatabases();
    });
  });

  // 集合
  dom.btnNewCol.addEventListener("click", () => {
    if (!state.db) return toast("请先创建数据库", true);
    openModal(dom.colModal);
  });

  $("colForm").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    const form = new FormData(e.target);
    const payload = {
      name: form.get("name").trim(),
      space: form.get("space"),
      metadata: form.get("metadata").trim(),
    };
    e.target.reset();
    await withError(async () => {
      await api(`/api/databases/${enc(state.db)}/collections`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast(`集合 ${payload.name} 已创建`);
      await loadCollections(payload.name);
    });
  });

  dom.colList.addEventListener("click", async (e) => {
    const delName = e.target.dataset.del;
    if (delName) {
      e.stopPropagation();
      if (!confirm(`确定删除集合「${delName}」及其全部文档？`)) return;
      return withError(async () => {
        await api(
          `/api/databases/${enc(state.db)}/collections/${enc(delName)}`,
          { method: "DELETE" }
        );
        toast("集合已删除");
        if (state.collection === delName) state.collection = null;
        await loadCollections();
      });
    }
    const item = e.target.closest("li[data-name]");
    if (!item || item.classList.contains("active")) return;
    await withError(() => loadCollections(item.dataset.name));
  });

  // 检索
  const runSearch = () =>
    withError(async () => {
      state.keyword = dom.searchInput.value.trim();
      state.semantic = state.mode === "semantic" && Boolean(state.keyword);
      state.offset = 0;
      await loadDocuments();
    });

  dom.btnSearch.addEventListener("click", runSearch);
  dom.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  dom.searchMode.addEventListener("change", (e) => {
    state.mode = e.target.value;
    dom.searchInput.placeholder =
      state.mode === "semantic" ? "描述你想找的内容，回车检索…" : "输入关键词后回车检索…";
  });

  dom.btnReset.addEventListener("click", () =>
    withError(async () => {
      dom.searchInput.value = "";
      state.keyword = "";
      state.semantic = false;
      state.offset = 0;
      await loadDocuments();
    })
  );

  dom.btnPrev.addEventListener("click", () =>
    withError(async () => {
      state.offset = Math.max(0, state.offset - state.limit);
      await loadDocuments();
    })
  );

  dom.btnNext.addEventListener("click", () =>
    withError(async () => {
      state.offset += state.limit;
      await loadDocuments();
    })
  );

  // 文档
  dom.btnAddDoc.addEventListener("click", () => {
    state.editingId = null;
    dom.docModalTitle.textContent = "新增文档";
    dom.docForm.reset();
    dom.docForm.elements.id.readOnly = false;
    openModal(dom.docModal);
  });

  dom.docBody.addEventListener("click", async (e) => {
    const editId = e.target.dataset.edit;
    const removeId = e.target.dataset.remove;
    const base = `/api/databases/${enc(state.db)}/collections/${enc(state.collection)}`;

    if (removeId) {
      if (!confirm(`确定删除文档「${removeId}」？`)) return;
      return withError(async () => {
        await api(`${base}/documents/${enc(removeId)}`, { method: "DELETE" });
        toast("文档已删除");
        await refreshAfterWrite();
      });
    }

    if (editId) {
      return withError(async () => {
        const doc = await api(`${base}/documents/${enc(editId)}`);
        state.editingId = editId;
        dom.docModalTitle.textContent = "编辑文档";
        const form = dom.docForm;
        form.elements.id.value = doc.id;
        form.elements.document.value = doc.document || "";
        form.elements.metadata.value = doc.metadata
          ? JSON.stringify(doc.metadata, null, 2)
          : "";
        openModal(dom.docModal);
      });
    }
  });

  dom.docForm.addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    const form = new FormData(e.target);
    const payload = {
      id: form.get("id").trim(),
      document: form.get("document"),
      metadata: form.get("metadata").trim(),
    };
    const base = `/api/databases/${enc(state.db)}/collections/${enc(state.collection)}`;
    const editingId = state.editingId;

    await withError(async () => {
      if (editingId) {
        await api(`${base}/documents/${enc(editingId)}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        toast("已保存");
      } else {
        await api(`${base}/documents`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        toast("文档已新增");
      }
      state.editingId = null;
      await refreshAfterWrite();
    });
  });

  // 弹窗取消
  document.querySelectorAll("[data-close]").forEach((btn) =>
    btn.addEventListener("click", () => btn.closest("dialog").close())
  );
}

/** 写入后刷新：保留当前集合与分页，同时更新左侧计数 */
async function refreshAfterWrite() {
  const keepOffset = state.offset;
  const keepKeyword = state.keyword;
  const keepSemantic = state.semantic;
  const name = state.collection;
  await loadCollections(name);
  state.offset = keepOffset;
  state.keyword = keepKeyword;
  state.semantic = keepSemantic;
  dom.searchInput.value = keepKeyword;
  await loadDocuments();
}

async function withError(fn) {
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ------------------------------ 启动 ------------------------------ */
bindEvents();
withError(() => loadDatabases());
