/* app.js — Личные финансы (статический сайт, GitHub Pages)
   Хранение: IndexedDB (в браузере пользователя)
   Мульти-пользователь: отдельные данные для каждого профиля
   Пароль: хранится как PBKDF2-хэш (без исходного пароля)
*/

(() => {
  "use strict";

  // ====== Настройки ======
  const DB_NAME = "personal-finance-byn";
  const DB_VERSION = 3;

  const STORE_USERS = "users";
  const STORE_TX = "transactions";
  const STORE_GOALS = "goals";

  const CURRENCY = "BYN";
  const LOCALE = "ru-BY";

  const INCOME_CATEGORIES = ["Зарплата", "Помощь", "Криптовалюта"];
  const EXPENSE_CATEGORIES = ["Еда", "Транспорт", "Подписки", "Жильё", "Развлечения", "Здоровье", "Подарки", "Другое"];

  const ACCOUNTS = ["Наличные", "Карта"];

  // ====== Утилиты ======
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const uid = () =>
    (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);

  const todayISO = () => new Date().toISOString().slice(0, 10);
  const monthKey = (isoDate) => (isoDate || "").slice(0, 7);

  const parseAmount = (s) => {
    if (typeof s !== "string") return NaN;
    const cleaned = s.trim().replace(/\s/g, "").replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : NaN;
  };

  const fmtMoney = (value) => {
    const v = Number(value) || 0;
    try {
      return new Intl.NumberFormat(LOCALE, {
        style: "currency",
        currency: CURRENCY,
        maximumFractionDigits: 2,
      }).format(v);
    } catch {
      return `${v.toFixed(2)} BYN`;
    }
  };

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function humanDate(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    if (Number.isNaN(d.getTime())) return iso;
    try {
      return new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "short", year: "numeric" }).format(d);
    } catch {
      return iso;
    }
  }

  function emojiForCategory(cat) {
    const c = (cat || "").toLowerCase();
    if (c.includes("еда") || c.includes("продукт")) return "🛒";
    if (c.includes("транспорт") || c.includes("такси") || c.includes("метро")) return "🚆";
    if (c.includes("подпис") || c.includes("сервис")) return "🔁";
    if (c.includes("жиль") || c.includes("аренд")) return "🏠";
    if (c.includes("здоров") || c.includes("аптек")) return "🩺";
    if (c.includes("развлеч") || c.includes("кино")) return "🎟️";
    if (c.includes("подар")) return "🎁";
    if (c.includes("крипто")) return "₿";
    return "💳";
  }

  // ====== Пароли (PBKDF2) ======
  function bytesToB64(bytes) {
    let bin = "";
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function pbkdf2Hash(password, saltB64, iterations = 120000) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );
    const salt = b64ToBytes(saltB64);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      keyMaterial,
      256
    );
    return bytesToB64(new Uint8Array(bits));
  }

  function randomSaltB64() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return bytesToB64(b);
  }

  async function setUserPassword(user, password) {
    const salt = randomSaltB64();
    const iterations = 120000;
    const hash = await pbkdf2Hash(password, salt, iterations);
    user.pw = { salt, iterations, hash };
    return user;
  }

  async function verifyUserPassword(user, password) {
    if (!user || !user.pw || !user.pw.hash) return false;
    const { salt, iterations, hash } = user.pw;
    const got = await pbkdf2Hash(password, salt, iterations || 120000);
    return got === hash;
  }

  // ====== IndexedDB ======
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;

        if (!db.objectStoreNames.contains(STORE_USERS)) {
          db.createObjectStore(STORE_USERS, { keyPath: "id" });
        }

        if (!db.objectStoreNames.contains(STORE_TX)) {
          const txStore = db.createObjectStore(STORE_TX, { keyPath: "id" });
          txStore.createIndex("byUser", "userId");
          txStore.createIndex("byUserMonth", ["userId", "month"]);
          txStore.createIndex("byUserDate", ["userId", "date"]);
        } else {
          const txStore = req.transaction.objectStore(STORE_TX);
          if (!txStore.indexNames.contains("byUser")) txStore.createIndex("byUser", "userId");
          if (!txStore.indexNames.contains("byUserMonth")) txStore.createIndex("byUserMonth", ["userId", "month"]);
          if (!txStore.indexNames.contains("byUserDate")) txStore.createIndex("byUserDate", ["userId", "date"]);
        }

        if (!db.objectStoreNames.contains(STORE_GOALS)) {
          const g = db.createObjectStore(STORE_GOALS, { keyPath: "id" });
          g.createIndex("byUser", "userId");
        } else {
          const g = req.transaction.objectStore(STORE_GOALS);
          if (!g.indexNames.contains("byUser")) g.createIndex("byUser", "userId");
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function withStore(db, storeNames, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      const stores = Array.isArray(storeNames)
        ? storeNames.map((n) => tx.objectStore(n))
        : [tx.objectStore(storeNames)];

      let out;
      try {
        out = fn(stores, tx);
      } catch (e) {
        reject(e);
        return;
      }

      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // ====== DB операции ======
  async function dbGetUsers(db) {
    return withStore(db, STORE_USERS, "readonly", ([s]) => reqToPromise(s.getAll()));
  }
  async function dbPutUser(db, user) {
    return withStore(db, STORE_USERS, "readwrite", ([s]) => reqToPromise(s.put(user)));
  }

  async function dbGetAllTxByUser(db, userId) {
    return withStore(db, STORE_TX, "readonly", ([s]) => {
      const idx = s.index("byUser");
      return reqToPromise(idx.getAll(IDBKeyRange.only(userId)));
    });
  }
  async function dbGetTxByUserMonth(db, userId, month) {
    return withStore(db, STORE_TX, "readonly", ([s]) => {
      const idx = s.index("byUserMonth");
      return reqToPromise(idx.getAll(IDBKeyRange.only([userId, month])));
    });
  }
  async function dbPutTx(db, txItem) {
    return withStore(db, STORE_TX, "readwrite", ([s]) => reqToPromise(s.put(txItem)));
  }
  async function dbDeleteTx(db, id) {
    return withStore(db, STORE_TX, "readwrite", ([s]) => reqToPromise(s.delete(id)));
  }

  async function dbGetGoalsByUser(db, userId) {
    return withStore(db, STORE_GOALS, "readonly", ([s]) => {
      const idx = s.index("byUser");
      return reqToPromise(idx.getAll(IDBKeyRange.only(userId)));
    });
  }
  async function dbPutGoal(db, goal) {
    return withStore(db, STORE_GOALS, "readwrite", ([s]) => reqToPromise(s.put(goal)));
  }
  async function dbDeleteGoal(db, id) {
    return withStore(db, STORE_GOALS, "readwrite", ([s]) => reqToPromise(s.delete(id)));
  }

  // ====== Данные ======
  function normalizeTx(raw) {
    const date = raw.date || todayISO();
    const amount = Number(raw.amount) || 0;

    const account = (raw.account || "Карта").trim();
    const safeAccount = ACCOUNTS.includes(account) ? account : "Карта";

    return {
      id: raw.id || uid(),
      userId: raw.userId,
      type: raw.type || "Расход",
      amount,
      category: (raw.category || "Другое").trim(),
      account: safeAccount,
      date,
      month: monthKey(date),
      note: (raw.note || "").trim(),
      createdAt: raw.createdAt || Date.now(),
    };
  }

  function sortTxDesc(arr) {
    return [...arr].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  function sumByCategoryExpense(txs) {
    const map = new Map();
    let total = 0;
    for (const t of txs) {
      if (t.type !== "Расход") continue;
      total += t.amount;
      map.set(t.category, (map.get(t.category) || 0) + t.amount);
    }
    const items = [...map.entries()].map(([category, amount]) => ({ category, amount }));
    items.sort((a, b) => b.amount - a.amount);
    return { items, total };
  }

  function calcAccountBalances(allTx) {
    let cash = 0;
    let card = 0;
    let income = 0;
    let expense = 0;

    for (const t of allTx) {
      const sign = (t.type === "Доход") ? 1 : -1;
      if (t.type === "Доход") income += t.amount;
      if (t.type === "Расход") expense += t.amount;

      if (t.account === "Наличные") cash += sign * t.amount;
      else card += sign * t.amount;
    }
    return { cash, card, income, expense, total: cash + card };
  }

  function calcGoalTotals(goals) {
    let savedCash = 0;
    let savedCard = 0;
    for (const g of goals) {
      savedCash += Number(g.savedCash) || 0;
      savedCard += Number(g.savedCard) || 0;
    }
    return { savedCash, savedCard, total: savedCash + savedCard };
  }

  // ====== UI ======
  const UI = {
    // users
    userSelect: null,
    btnNewUser: null,

    // auth overlay
    authOverlay: null,
    authUserSelect: null,
    authHint: null,
    authLoginBlock: null,
    authSetPwBlock: null,
    authPassword: null,
    authPw1: null,
    authPw2: null,
    btnAuthLogin: null,
    btnAuthCancel: null,
    btnAuthSetPw: null,
    btnAuthCancel2: null,
    newUserName: null,
    newUserPw1: null,
    newUserPw2: null,
    btnAuthCreate: null,
    authError: null,

    // tabs
    tabButtons: null,

    // metrics
    pillState: null,
    metricBalance: null,
    metricMeta: null,
    miniCash: null,
    miniCard: null,
    miniGoals: null,

    // tx list
    periodSelect: null,
    txCount: null,
    txList: null,

    // form
    btnQuickToday: null,
    form: null,
    fType: null,
    fAmount: null,
    fCategory: null,
    fAccount: null,
    fDate: null,
    fNote: null,
    btnSave: null,

    // categories tab
    catsPeriodSelect: null,
    catsList: null,

    // goals tab
    gTitle: null,
    gTarget: null,
    btnAddGoal: null,
    goalsList: null,

    // fx tab
    fxDate: null,
    fxAmount: null,
    fxFrom: null,
    fxTo: null,
    btnFx: null,
    btnFxSwap: null,
    fxResult: null,
  };

  function bindUI() {
    UI.userSelect = $("#userSelect");
    UI.btnNewUser = $("#btnNewUser");


    // auth overlay
    UI.authOverlay = $("#authOverlay");
    UI.authUserSelect = $("#authUserSelect");
    UI.authHint = $("#authHint");
    UI.authLoginBlock = $("#authLoginBlock");
    UI.authSetPwBlock = $("#authSetPwBlock");
    UI.authPassword = $("#authPassword");
    UI.authPw1 = $("#authPw1");
    UI.authPw2 = $("#authPw2");
    UI.btnAuthLogin = $("#btnAuthLogin");
    UI.btnAuthCancel = $("#btnAuthCancel");
    UI.btnAuthSetPw = $("#btnAuthSetPw");
    UI.btnAuthCancel2 = $("#btnAuthCancel2");
    UI.newUserName = $("#newUserName");
    UI.newUserPw1 = $("#newUserPw1");
    UI.newUserPw2 = $("#newUserPw2");
    UI.btnAuthCreate = $("#btnAuthCreate");
    UI.authError = $("#authError");


    UI.tabButtons = $$(".tabBtn");

    UI.pillState = $("#pillState");
    UI.metricBalance = $("#metricBalance");
    UI.metricMeta = $("#metricMeta");
    UI.miniCash = $("#miniCash");
    UI.miniCard = $("#miniCard");
    UI.miniGoals = $("#miniGoals");

    UI.periodSelect = $("#periodSelect");
    UI.txCount = $("#txCount");
    UI.txList = $("#txList");

    UI.btnQuickToday = $("#btnQuickToday");

    UI.form = $("#txForm");
    UI.fType = $("#fType");
    UI.fAmount = $("#fAmount");
    UI.fCategory = $("#fCategory");
    UI.fAccount = $("#fAccount");
    UI.fDate = $("#fDate");
    UI.fNote = $("#fNote");
    UI.btnSave = $("#btnSave");

    UI.catsPeriodSelect = $("#catsPeriodSelect");
    UI.catsList = $("#catsList");

    UI.gTitle = $("#gTitle");
    UI.gTarget = $("#gTarget");
    UI.btnAddGoal = $("#btnAddGoal");
    UI.goalsList = $("#goalsList");

    UI.fxDate = $("#fxDate");
    UI.fxAmount = $("#fxAmount");
    UI.fxFrom = $("#fxFrom");
    UI.fxTo = $("#fxTo");
    UI.btnFx = $("#btnFx");
    UI.btnFxSwap = $("#btnFxSwap");
    UI.fxResult = $("#fxResult");

    if (UI.fDate && !UI.fDate.value) UI.fDate.value = todayISO();
    if (UI.fxDate && !UI.fxDate.value) UI.fxDate.value = todayISO();
  }

  function setPill(balance) {
    if (!UI.pillState) return;
    UI.pillState.classList.remove("pillOk", "pillWarn", "pillBad");

    if (balance > 0.0001) {
      UI.pillState.classList.add("pillOk");
      UI.pillState.textContent = "Плюс";
      return;
    }
    if (balance < -0.0001) {
      UI.pillState.classList.add("pillBad");
      UI.pillState.textContent = "Минус";
      return;
    }
    UI.pillState.classList.add("pillWarn");
    UI.pillState.textContent = "Ноль";
  }

  function renderMetrics(monthTx, allTx, goals) {
    let mIncome = 0;
    let mExpense = 0;
    for (const t of monthTx) {
      if (t.type === "Доход") mIncome += t.amount;
      if (t.type === "Расход") mExpense += t.amount;
    }

    const acc = calcAccountBalances(allTx);
    const g = calcGoalTotals(goals);

    const freeCash = acc.cash - g.savedCash;
    const freeCard = acc.card - g.savedCard;

    UI.metricBalance.textContent = fmtMoney(acc.total);
    UI.metricMeta.textContent = `за месяц: доход ${fmtMoney(mIncome)} · расход ${fmtMoney(mExpense)}`;

    UI.miniCash.textContent = fmtMoney(freeCash);
    UI.miniCard.textContent = fmtMoney(freeCard);
    UI.miniGoals.textContent = fmtMoney(g.total);

    setPill(acc.total);
  }

  function renderTxList(txs) {
    const list = UI.txList;
    list.innerHTML = "";

    if (txs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "note";
      empty.textContent = "Операций пока нет. Добавь первую — и появятся расчёты.";
      list.appendChild(empty);

      UI.txCount.textContent = "0 операций";
      return;
    }

    UI.txCount.textContent = `${txs.length} операций`;

    const sorted = sortTxDesc(txs);

    for (const t of sorted) {
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.id = t.id;

      const left = document.createElement("div");
      left.className = "rowLeft";

      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = emojiForCategory(t.category);

      const textWrap = document.createElement("div");

      const title = document.createElement("div");
      title.className = "rowTitle";
      title.textContent = t.note ? t.note : t.category;

      const sub = document.createElement("div");
      sub.className = "rowSub";
      sub.textContent = `${t.category} · ${t.account} · ${humanDate(t.date)}`;

      textWrap.appendChild(title);
      textWrap.appendChild(sub);

      left.appendChild(avatar);
      left.appendChild(textWrap);

      const right = document.createElement("div");
      right.className = "rowRight";

      const amt = document.createElement("div");
      amt.className = "amt " + (t.type === "Доход" ? "positive" : "negative");
      const sign = t.type === "Доход" ? "+" : "−";
      amt.textContent = `${sign} ${fmtMoney(Math.abs(t.amount))}`;

      const typeTag = document.createElement("div");
      typeTag.className = "tag";
      typeTag.textContent = t.type.toLowerCase();

      const del = document.createElement("button");
      del.className = "btn btnGhost";
      del.type = "button";
      del.textContent = "Удалить";
      del.style.padding = "7px 10px";
      del.addEventListener("click", () => { void removeTx(t.id); });

      right.appendChild(amt);
      right.appendChild(typeTag);
      right.appendChild(del);

      row.appendChild(left);
      row.appendChild(right);

      list.appendChild(row);
    }
  }

  function renderCategories(txs) {
    if (!UI.catsList) return;
    UI.catsList.innerHTML = "";

    const { items, total } = sumByCategoryExpense(txs);

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "note";
      empty.textContent = "Расходов за выбранный период нет.";
      UI.catsList.appendChild(empty);
      return;
    }

    for (const it of items) {
      const row = document.createElement("div");
      row.className = "row";

      const left = document.createElement("div");
      left.className = "rowLeft";

      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = emojiForCategory(it.category);

      const textWrap = document.createElement("div");
      const title = document.createElement("div");
      title.className = "rowTitle";
      title.textContent = it.category;

      const sub = document.createElement("div");
      sub.className = "rowSub";
      const pct = total > 0 ? Math.round((it.amount / total) * 100) : 0;
      sub.textContent = `${pct}% от всех расходов`;

      textWrap.appendChild(title);
      textWrap.appendChild(sub);

      left.appendChild(avatar);
      left.appendChild(textWrap);

      const right = document.createElement("div");
      right.className = "rowRight";

      const amt = document.createElement("div");
      amt.className = "amt negative";
      amt.textContent = fmtMoney(it.amount);

      right.appendChild(amt);

      row.appendChild(left);
      row.appendChild(right);

      UI.catsList.appendChild(row);
    }
  }

  function renderGoals(goals, allTx) {
    if (!UI.goalsList) return;
    UI.goalsList.innerHTML = "";

    if (goals.length === 0) {
      const empty = document.createElement("div");
      empty.className = "note";
      empty.textContent = "Пока нет целей. Добавь первую копилку.";
      UI.goalsList.appendChild(empty);
      return;
    }

    const acc = calcAccountBalances(allTx);
    const totals = calcGoalTotals(goals);
    const freeCash = acc.cash - totals.savedCash;
    const freeCard = acc.card - totals.savedCard;

    const sorted = [...goals].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    for (const g of sorted) {
      const saved = (Number(g.savedCash) || 0) + (Number(g.savedCard) || 0);
      const target = Number(g.target) || 0;
      const pct = target > 0 ? clamp(Math.round((saved / target) * 100), 0, 100) : 0;

      const wrap = document.createElement("div");
      wrap.className = "goalRow";

      const top = document.createElement("div");
      top.className = "goalTop";

      const left = document.createElement("div");
      const t = document.createElement("div");
      t.className = "goalTitle";
      t.textContent = g.title;

      const meta = document.createElement("div");
      meta.className = "goalMeta";
      meta.textContent = `накоплено ${fmtMoney(saved)} из ${fmtMoney(target)} · ${pct}%`;

      left.appendChild(t);
      left.appendChild(meta);

      const del = document.createElement("button");
      del.className = "btn btnGhost";
      del.type = "button";
      del.textContent = "Удалить";
      del.style.padding = "7px 10px";
      del.addEventListener("click", () => { void removeGoal(g.id); });

      top.appendChild(left);
      top.appendChild(del);

      const bar = document.createElement("div");
      bar.className = "bar";
      const barInner = document.createElement("div");
      barInner.style.width = pct + "%";
      bar.appendChild(barInner);

      const actions = document.createElement("div");
      actions.className = "goalActions";

      const fAmount = document.createElement("input");
      fAmount.className = "control";
      fAmount.inputMode = "decimal";
      fAmount.placeholder = "сумма";

      const fAcc = document.createElement("select");
      fAcc.className = "control";
      for (const a of ACCOUNTS) {
        const o = document.createElement("option");
        o.value = a;
        o.textContent = a;
        fAcc.appendChild(o);
      }

      const info = document.createElement("div");
      info.className = "goalMeta";
      info.style.marginTop = "0";
      info.textContent = `доступно: наличные ${fmtMoney(freeCash)} · карта ${fmtMoney(freeCard)}`;

      const btn = document.createElement("button");
      btn.className = "btn btnPrimary";
      btn.type = "button";
      btn.textContent = "Отложить";
      btn.addEventListener("click", () => {
        const amt = parseAmount(fAmount.value || "");
        const accName = fAcc.value;
        void addMoneyToGoal(g.id, amt, accName);
      });

      const fieldAmt = document.createElement("label");
      fieldAmt.className = "field";
      const labAmt = document.createElement("span");
      labAmt.className = "label";
      labAmt.textContent = "Сумма";
      fieldAmt.appendChild(labAmt);
      fieldAmt.appendChild(fAmount);

      const fieldAcc = document.createElement("label");
      fieldAcc.className = "field";
      const labAcc = document.createElement("span");
      labAcc.className = "label";
      labAcc.textContent = "Откуда";
      fieldAcc.appendChild(labAcc);
      fieldAcc.appendChild(fAcc);

      actions.appendChild(fieldAmt);
      actions.appendChild(fieldAcc);
      actions.appendChild(btn);

      wrap.appendChild(top);
      wrap.appendChild(bar);
      wrap.appendChild(actions);
      wrap.appendChild(info);

      UI.goalsList.appendChild(wrap);
    }
  }

  // ====== Категории в форме ======
  function populateCategorySelect(type) {
    const sel = UI.fCategory;
    if (!sel) return;
    sel.innerHTML = "";

    const list = (type === "Доход") ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    for (const c of list) {
      const opt = document.createElement("option");
      opt.textContent = c;
      sel.appendChild(opt);
    }
  }

  function ensureAccountSelect() {
    const sel = UI.fAccount;
    if (!sel) return;
    sel.innerHTML = "";
    for (const a of ACCOUNTS) {
      const opt = document.createElement("option");
      opt.textContent = a;
      sel.appendChild(opt);
    }
  }

  // ====== Вкладки ======
  function showTab(tabId) {
    UI.tabButtons.forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tabId);
    });

    $$("[data-tab-content]").forEach((sec) => {
      const is = sec.getAttribute("data-tab-content") === tabId;
      sec.classList.toggle("tabHidden", !is);
    });
  }

  // ====== Логика приложения ======
  let DB = null;
  let users = [];
  let activeUserId = null;
  const unlockedUsers = new Set();

  function loadActiveUserIdFromLocal() {
    try { return localStorage.getItem("pf_active_user") || null; } catch { return null; }
  }
  function saveActiveUserIdToLocal(id) {
    try { localStorage.setItem("pf_active_user", id); } catch { /* ignore */ }
  }

  function renderUserSelect() {
    const sel = UI.userSelect;
    sel.innerHTML = "";
    for (const u of users) {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = u.name;
      sel.appendChild(opt);
    }
    if (activeUserId) sel.value = activeUserId;
  }

  async function ensureDefaultUser() {
    users = await dbGetUsers(DB);

    if (users.length === 0) {
      const u = { id: uid(), name: "Мой профиль", createdAt: Date.now() };
      await dbPutUser(DB, u);
      users = [u];
    }

    const stored = loadActiveUserIdFromLocal();
    activeUserId = (stored && users.some((u) => u.id === stored)) ? stored : users[0].id;

    renderUserSelect();
    renderAuthUserSelect();

    // Всегда начинаем с экрана выбора профиля
    await showAuthOverlay({ mode: "initial", targetUserId: activeUserId });
    saveActiveUserIdToLocal(activeUserId);
  }

  function renderAuthUserSelect() {
    const sel = UI.authUserSelect;
    if (!sel) return;
    sel.innerHTML = "";
    for (const u of users) {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = u.name;
      sel.appendChild(opt);
    }
    if (activeUserId) sel.value = activeUserId;
  }

  function setAuthError(msg) {
    if (!UI.authError) return;
    UI.authError.textContent = msg || "";
  }

  function lockAppUI(locked) {
    const header = document.querySelector(".top");
    const main = document.querySelector(".wrap");
    if (header) header.classList.toggle("appLocked", !!locked);
    if (main) main.classList.toggle("appLocked", !!locked);
    if (UI.userSelect) UI.userSelect.disabled = !!locked;
    if (UI.btnNewUser) UI.btnNewUser.disabled = !!locked;
  }

  function updateAuthBlocksForUser(userId, mode) {
    const u = users.find((x) => x.id === userId);
    const hasPw = !!(u && u.pw && u.pw.hash);

    setAuthError("");

    const showSet = !hasPw;
    UI.authLoginBlock.classList.toggle("authHidden", showSet);
    UI.authSetPwBlock.classList.toggle("authHidden", !showSet);

    const canCancel = mode !== "initial";
    UI.btnAuthCancel.style.display = canCancel ? "" : "none";
    UI.btnAuthCancel2.style.display = canCancel ? "" : "none";

    UI.authHint.textContent = showSet
      ? `Для профиля "${u ? u.name : ""}" нужно установить пароль`
      : `Введи пароль для профиля "${u ? u.name : ""}"`;

    if (!showSet) {
      UI.authPassword.value = "";
      UI.authPassword.focus();
    } else {
      UI.authPw1.value = "";
      UI.authPw2.value = "";
      UI.authPw1.focus();
    }
  }

  async function showAuthOverlay({ mode, targetUserId }) {
    return new Promise((resolve) => {
      lockAppUI(true);
      UI.authOverlay.classList.remove("authHidden");
      UI.authUserSelect.value = targetUserId || activeUserId || (users[0] ? users[0].id : "");
      updateAuthBlocksForUser(UI.authUserSelect.value, mode);

      const cleanup = () => {
        UI.authOverlay.classList.add("authHidden");
        setAuthError("");
        lockAppUI(false);
        resolve(true);
      };

      const cancelToCurrent = () => {
        UI.authOverlay.classList.add("authHidden");
        setAuthError("");
        lockAppUI(false);
        if (UI.userSelect && activeUserId) UI.userSelect.value = activeUserId;
        resolve(false);
      };

      const onUserChange = () => {
        updateAuthBlocksForUser(UI.authUserSelect.value, mode);
      };

      const onLogin = async () => {
        const userId = UI.authUserSelect.value;
        const u = users.find((x) => x.id === userId);
        if (!u) { setAuthError("Профиль не найден"); return; }

        if (!(u.pw && u.pw.hash)) {
          updateAuthBlocksForUser(userId, mode);
          return;
        }

        const p = UI.authPassword.value || "";
        if (!p) { setAuthError("Введи пароль"); return; }

        const ok = await verifyUserPassword(u, p);
        if (!ok) { setAuthError("Неверный пароль"); return; }

        activeUserId = userId;
        renderUserSelect();
        saveActiveUserIdToLocal(activeUserId);
        cleanup();
        void refresh();
      };

      const onSetPw = async () => {
        const userId = UI.authUserSelect.value;
        const u = users.find((x) => x.id === userId);
        if (!u) { setAuthError("Профиль не найден"); return; }

        const p1 = UI.authPw1.value || "";
        const p2 = UI.authPw2.value || "";
        if (!p1 || !p2) { setAuthError("Заполни оба поля пароля"); return; }
        if (p1 !== p2) { setAuthError("Пароли не совпали"); return; }

        await setUserPassword(u, p1);
        await dbPutUser(DB, u);
        users = await dbGetUsers(DB);
        renderUserSelect();
        renderAuthUserSelect();

        activeUserId = userId;
        saveActiveUserIdToLocal(activeUserId);
        cleanup();
        void refresh();
      };

      const onCreate = async () => {
        const name = (UI.newUserName.value || "").trim();
        const p1 = UI.newUserPw1.value || "";
        const p2 = UI.newUserPw2.value || "";

        if (!name) { setAuthError("Укажи имя профиля"); return; }
        if (!p1 || !p2) { setAuthError("Укажи пароль и повтор"); return; }
        if (p1 !== p2) { setAuthError("Пароли не совпали"); return; }

        const u = { id: uid(), name, createdAt: Date.now() };
        await setUserPassword(u, p1);
        await dbPutUser(DB, u);

        users = await dbGetUsers(DB);
        activeUserId = u.id;

        renderUserSelect();
        renderAuthUserSelect();
        UI.authUserSelect.value = activeUserId;

        UI.newUserName.value = "";
        UI.newUserPw1.value = "";
        UI.newUserPw2.value = "";

        cleanup();
        void refresh();
      };

      // bind one-shot listeners
      UI.authUserSelect.addEventListener("change", onUserChange, { once: false });

      const loginHandler = () => void onLogin();
      const setPwHandler = () => void onSetPw();
      const createHandler = () => void onCreate();
      const cancelHandler = () => cancelToCurrent();

      UI.btnAuthLogin.onclick = loginHandler;
      UI.btnAuthSetPw.onclick = setPwHandler;
      UI.btnAuthCreate.onclick = createHandler;
      UI.btnAuthCancel.onclick = cancelHandler;
      UI.btnAuthCancel2.onclick = cancelHandler;

      // Enter-to-submit
      UI.authPassword.onkeydown = (e) => { if (e.key === "Enter") void onLogin(); };
      UI.authPw2.onkeydown = (e) => { if (e.key === "Enter") void onSetPw(); };
      UI.newUserPw2.onkeydown = (e) => { if (e.key === "Enter") void onCreate(); };
    });
  }

  async function refresh() {
    if (!activeUserId) return;

    const nowMonth = monthKey(todayISO());

    const [allTxRaw, monthTxRaw, goals] = await Promise.all([
      dbGetAllTxByUser(DB, activeUserId),
      dbGetTxByUserMonth(DB, activeUserId, nowMonth),
      dbGetGoalsByUser(DB, activeUserId),
    ]);

    const allTx = allTxRaw.map(normalizeTx);
    const monthTx = monthTxRaw.map(normalizeTx);

    renderMetrics(monthTx, allTx, goals);

    const mode = UI.periodSelect.value;
    renderTxList(mode === "month" ? monthTx : allTx);

    const catsMode = UI.catsPeriodSelect ? UI.catsPeriodSelect.value : "month";
    renderCategories(catsMode === "month" ? monthTx : allTx);

    renderGoals(goals, allTx);
  }

  async function addTxFromForm() {
    if (!activeUserId) return;

    const type = UI.fType.value;
    const amount = parseAmount(UI.fAmount.value || "");
    const category = UI.fCategory.value;
    const account = UI.fAccount.value;
    const date = UI.fDate.value ? UI.fDate.value : todayISO();
    const note = UI.fNote.value || "";

    if (!Number.isFinite(amount) || amount <= 0) {
      alert("Укажи корректную сумму (число больше 0).");
      return;
    }

    const txItem = normalizeTx({
      userId: activeUserId,
      type,
      amount,
      category,
      account,
      date,
      note,
      createdAt: Date.now(),
    });

    await dbPutTx(DB, txItem);

    UI.form.reset();
    UI.fDate.value = todayISO();
    UI.fType.value = "Расход";
    populateCategorySelect("Расход");
    ensureAccountSelect();

    await refresh();
  }

  async function removeTx(id) {
    await dbDeleteTx(DB, id);
    await refresh();
  }

  async function createUser() {
    await showAuthOverlay({ mode: "create", targetUserId: activeUserId || (users[0] ? users[0].id : null) });
  }

  // ====== Копилки ======
  function normalizeGoal(raw) {
    return {
      id: raw.id || uid(),
      userId: raw.userId,
      title: (raw.title || "Цель").trim(),
      target: Number(raw.target) || 0,
      savedCash: Number(raw.savedCash) || 0,
      savedCard: Number(raw.savedCard) || 0,
      createdAt: raw.createdAt || Date.now(),
    };
  }

  async function addGoalFromForm() {
    if (!activeUserId) return;
    const title = (UI.gTitle.value || "").trim();
    const target = parseAmount(UI.gTarget.value || "");

    if (!title) {
      alert("Укажи название цели.");
      return;
    }
    if (!Number.isFinite(target) || target <= 0) {
      alert("Укажи сумму цели (число больше 0).");
      return;
    }

    const g = normalizeGoal({ userId: activeUserId, title, target, createdAt: Date.now() });
    await dbPutGoal(DB, g);

    UI.gTitle.value = "";
    UI.gTarget.value = "";

    await refresh();
  }

  async function removeGoal(id) {
    await dbDeleteGoal(DB, id);
    await refresh();
  }

  async function addMoneyToGoal(goalId, amount, accountName) {
    if (!activeUserId) return;
    if (!Number.isFinite(amount) || amount <= 0) {
      alert("Укажи корректную сумму.");
      return;
    }
    if (!ACCOUNTS.includes(accountName)) {
      alert("Некорректный счёт.");
      return;
    }

    const [allTxRaw, goals] = await Promise.all([
      dbGetAllTxByUser(DB, activeUserId),
      dbGetGoalsByUser(DB, activeUserId),
    ]);

    const allTx = allTxRaw.map(normalizeTx);
    const acc = calcAccountBalances(allTx);
    const totals = calcGoalTotals(goals);
    const freeCash = acc.cash - totals.savedCash;
    const freeCard = acc.card - totals.savedCard;

    const free = (accountName === "Наличные") ? freeCash : freeCard;
    if (amount > free + 1e-9) {
      alert("Недостаточно средств на выбранном счёте.");
      return;
    }

    const goal = goals.find((x) => x.id === goalId);
    if (!goal) return;

    const upd = { ...goal };
    if (accountName === "Наличные") upd.savedCash = (Number(upd.savedCash) || 0) + amount;
    else upd.savedCard = (Number(upd.savedCard) || 0) + amount;

    await dbPutGoal(DB, upd);
    await refresh();
  }

  // ====== Конвертер валют (НБ РБ) ======
  const rateCache = new Map(); // key: date|code -> {scale, rate}

  async function fetchRateFromNBRB(code, ondate) {
    const k = `${ondate}|${code}`;
    if (rateCache.has(k)) return rateCache.get(k);

    // BYN как базовая валюта
    if (code === "BYN") {
      const v = { scale: 1, rate: 1, code: "BYN", date: ondate };
      rateCache.set(k, v);
      return v;
    }

    const url = `https://api.nbrb.by/exrates/rates/${encodeURIComponent(code)}?parammode=2&ondate=${encodeURIComponent(ondate)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("NBRB: " + res.status);
    const data = await res.json();
    const v = {
      code,
      date: (data.Date || ondate).slice(0, 10),
      scale: Number(data.Cur_Scale) || 1,
      rate: Number(data.Cur_OfficialRate) || NaN,
      name: data.Cur_Name || code,
    };
    if (!Number.isFinite(v.rate)) throw new Error("NBRB: bad rate");
    rateCache.set(k, v);
    return v;
  }

  function convertViaBYN(amount, from, to, rFrom, rTo) {
    // r.rate = BYN за r.scale единиц валюты
    const fromPer1 = rFrom.rate / rFrom.scale;
    const toPer1 = rTo.rate / rTo.scale;

    if (from === "BYN") {
      return amount / toPer1;
    }
    if (to === "BYN") {
      return amount * fromPer1;
    }
    const byn = amount * fromPer1;
    return byn / toPer1;
  }

  async function doConvert() {
    const date = (UI.fxDate.value || todayISO()).slice(0, 10);
    const amount = parseAmount(UI.fxAmount.value || "");
    const from = UI.fxFrom.value;
    const to = UI.fxTo.value;

    if (!Number.isFinite(amount)) {
      UI.fxResult.textContent = "Укажи сумму.";
      return;
    }
    if (from === to) {
      UI.fxResult.textContent = `${amount} ${from} = ${amount} ${to}`;
      return;
    }

    UI.fxResult.textContent = "Считаю…";

    try {
      const [rFrom, rTo] = await Promise.all([
        fetchRateFromNBRB(from, date),
        fetchRateFromNBRB(to, date),
      ]);

      const out = convertViaBYN(amount, from, to, rFrom, rTo);

      const outRounded = Math.round(out * 100) / 100;

      const rateFromPer1 = rFrom.code === "BYN" ? 1 : (rFrom.rate / rFrom.scale);
      const rateToPer1 = rTo.code === "BYN" ? 1 : (rTo.rate / rTo.scale);

      UI.fxResult.textContent =
        `${amount} ${from} = ${outRounded.toFixed(2)} ${to}\n` +
        `курс ${date}: 1 ${from} = ${rateFromPer1.toFixed(6)} BYN · 1 ${to} = ${rateToPer1.toFixed(6)} BYN`;
    } catch (e) {
      console.error(e);
      UI.fxResult.textContent = "Не удалось получить курс НБ РБ. Проверь интернет и попробуй ещё раз.";
    }
  }

  // ====== События ======
  function hookEvents() {
    UI.btnNewUser.addEventListener("click", () => void createUser());

    UI.userSelect.addEventListener("change", async () => {
      const nextId = UI.userSelect.value;
      if (!nextId || nextId === activeUserId) return;
      const ok = await showAuthOverlay({ mode: "switch", targetUserId: nextId });
      if (!ok && UI.userSelect && activeUserId) UI.userSelect.value = activeUserId;
    });

    UI.btnSave.addEventListener("click", () => void addTxFromForm());

    UI.btnQuickToday.addEventListener("click", () => {
      UI.fDate.value = todayISO();
    });

    UI.periodSelect.addEventListener("change", () => void refresh());

    UI.fType.addEventListener("change", () => {
      populateCategorySelect(UI.fType.value);
    });

    if (UI.catsPeriodSelect) UI.catsPeriodSelect.addEventListener("change", () => void refresh());

    if (UI.btnAddGoal) UI.btnAddGoal.addEventListener("click", () => void addGoalFromForm());

    if (UI.btnFx) UI.btnFx.addEventListener("click", () => void doConvert());
    if (UI.btnFxSwap) UI.btnFxSwap.addEventListener("click", () => {
      const a = UI.fxFrom.value;
      UI.fxFrom.value = UI.fxTo.value;
      UI.fxTo.value = a;
    });

    UI.tabButtons.forEach((b) => {
      b.addEventListener("click", () => {
        showTab(b.dataset.tab);
      });
    });
  }

  // ====== Старт ======
  async function init() {
    bindUI();
    hookEvents();

    try {
      DB = await openDB();
    } catch (e) {
      console.error(e);
      alert("Не удалось открыть базу IndexedDB. Проверь настройки браузера.");
      return;
    }

    ensureAccountSelect();
    populateCategorySelect("Расход");

    await ensureDefaultUser();
    showTab("tabTx");
    await refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init());
  } else {
    void init();
  }
})();
