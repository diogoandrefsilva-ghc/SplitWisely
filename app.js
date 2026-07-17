/* SplitWisely — app de despesas partilhadas (Supabase + JS vanilla) */
"use strict";

// ---------------------------------------------------------------- config
function loadConfig() {
  if (window.APP_CONFIG?.SUPABASE_URL && !window.APP_CONFIG.SUPABASE_URL.includes("O-TEU-PROJETO")) {
    return window.APP_CONFIG;
  }
  try {
    const saved = JSON.parse(localStorage.getItem("splitwisely_config"));
    if (saved?.SUPABASE_URL && saved?.SUPABASE_ANON_KEY) return saved;
  } catch (_) { /* ignore */ }
  return null;
}

const $app = document.getElementById("app");
const $toast = document.getElementById("toast");
const $topbarUser = document.getElementById("topbar-user");

let sb = null;          // cliente supabase
let session = null;     // sessão atual
let profile = null;     // perfil splitwisely (is_admin / is_approved)
let cache = { groups: null };

// Dados do grupo aberto, para trocar de separador sem voltar a pedir tudo
// ao servidor (e sem o ecrã "A carregar grupo…" a piscar).
let groupCache = { id: null, data: null };
function invalidateGroupCache() { groupCache = { id: null, data: null }; }

// Depois de gravar/apagar algo: deita fora a cache e volta a desenhar a vista.
function refresh() { invalidateGroupCache(); route(); }

// ---------------------------------------------------------------- helpers
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, isError = false) {
  $toast.textContent = msg;
  $toast.classList.toggle("error", isError);
  $toast.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => $toast.classList.add("hidden"), 3500);
}

function fmtMoney(cents, currency = "EUR") {
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency })
    .format((cents || 0) / 100);
}

function toCents(v) {
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function fmtDate(d) {
  if (!d) return "";
  return new Date(d + "T00:00:00").toLocaleDateString("pt-PT", { day: "numeric", month: "short", year: "numeric" });
}

// "Maria Costa Santos" -> "Maria S." (para linhas compactas)
function shortName(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

// Avatar redondo com iniciais, cor estável derivada do nome
const AVATAR_COLORS = ["#0ea5e9", "#8b5cf6", "#f59e0b", "#10b981", "#ef4444",
  "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#d946ef"];
function avatarHtml(name, extra = "") {
  const parts = String(name || "?").trim().split(/\s+/);
  const initials = ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  let h = 0;
  for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="avatar ${extra}" style="background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}">${esc(initials)}</span>`;
}

// URL base da app (sem hash/rota) — o link que se envia no convite.
// Funciona em GitHub Pages num subcaminho (usa origin + pathname).
function appBaseUrl() {
  return location.origin + location.pathname;
}

// Link mailto: para convidar um membro por email. Abre o cliente de email
// já com assunto e corpo preenchidos; a pessoa entra com a conta Google do
// mesmo email e fica logo ligada ao grupo (e aprovada — ver schema.sql).
function inviteMailtoHref(member, group) {
  const url = appBaseUrl();
  const subject = `Convite para o SplitWisely — ${group.name}`;
  const body =
`Olá!

Adicionei-te ao grupo «${group.name}» no SplitWisely para acertarmos as contas partilhadas.

Entra aqui com a tua conta Google (usa este mesmo email: ${member.email}):
${url}

Assim que entrares, ficas logo ligado ao grupo. Até já!`;
  return `mailto:${encodeURIComponent(member.email)}`
    + `?subject=${encodeURIComponent(subject)}`
    + `&body=${encodeURIComponent(body)}`;
}

// Divide `totalCents` por pesos, sem perder cêntimos (maior resto)
function splitByWeights(totalCents, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map(w => totalCents * w / sum);
  const base = raw.map(Math.floor);
  let rest = totalCents - base.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - base[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < rest; k++) base[order[k % order.length][1]] += 1;
  return base;
}

// ---------------------------------------------------------------- setup / auth
function renderSetup() {
  $app.innerHTML = `
    <div class="card" style="max-width:520px;margin:2rem auto;">
      <h1>Configuração inicial</h1>
      <p class="muted">Indica os dados do teu projeto Supabase (Settings → API).
      Ficam guardados apenas neste browser. Em alternativa, cria um ficheiro
      <code>config.js</code> a partir de <code>config.example.js</code>.</p>
      <form id="setup-form">
        <div class="field">
          <label>URL do projeto</label>
          <input name="url" placeholder="https://xyz.supabase.co" required />
        </div>
        <div class="field">
          <label>Chave anon (public)</label>
          <input name="key" placeholder="eyJhbGciOi..." required />
        </div>
        <button type="submit">Guardar e continuar</button>
      </form>
    </div>`;
  document.getElementById("setup-form").onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    localStorage.setItem("splitwisely_config", JSON.stringify({
      SUPABASE_URL: f.get("url").trim().replace(/\/$/, ""),
      SUPABASE_ANON_KEY: f.get("key").trim(),
    }));
    location.reload();
  };
}

function renderLogin() {
  $topbarUser.innerHTML = "";
  $app.innerHTML = `
    <div class="card login-box" style="max-width:460px;margin:2rem auto;">
      <div class="brand-big">💸 SplitWisely</div>
      <p class="muted">Grupos, eventos e despesas partilhadas — quem pagou o quê e quem deve a quem.</p>
      <button class="btn-google" id="btn-google">
        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.2 5.2C41.3 34.9 44 30 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
        Entrar com Google
      </button>
      <p class="muted" style="margin-top:1.4rem;font-size:.78rem;">
        <a href="#" id="reset-config" style="color:inherit;">Alterar configuração do Supabase</a>
      </p>
    </div>`;
  document.getElementById("btn-google").onclick = async () => {
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.origin + location.pathname },
    });
    if (error) toast(error.message, true);
  };
  document.getElementById("reset-config").onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem("splitwisely_config");
    location.reload();
  };
}

function renderTopbar() {
  const u = session?.user;
  if (!u) { $topbarUser.innerHTML = ""; return; }
  const name = u.user_metadata?.full_name || u.email;
  const avatar = u.user_metadata?.avatar_url;
  $topbarUser.innerHTML = `
    ${avatar ? `<img src="${esc(avatar)}" alt="" referrerpolicy="no-referrer" />` : ""}
    <span class="user-name">${esc(name)}</span>
    ${profile?.is_admin ? `<button class="secondary small" id="btn-admin">Admin</button>` : ""}
    <button class="secondary small" id="btn-logout">Sair</button>`;
  document.getElementById("btn-admin")?.addEventListener("click", () => {
    location.hash = "#/admin";
  });
  document.getElementById("btn-logout").onclick = async () => {
    await sb.auth.signOut();
    location.hash = "#/";
  };
}

// Ecrã de espera para contas ainda não aprovadas pelo admin
function renderWaiting() {
  $app.innerHTML = `
    <div class="card" style="max-width:460px;margin:2rem auto;text-align:center;">
      <div style="font-size:2.2rem;">⏳</div>
      <h1>Conta à espera de aprovação</h1>
      <p class="muted">Já entraste com a tua conta Google, mas o administrador
      ainda tem de aprovar o teu acesso. Avisa-o e volta cá depois 🙂</p>
      <div style="display:flex;gap:.6rem;justify-content:center;margin-top:1rem;">
        <button id="btn-recheck">Verificar novamente</button>
        <button class="secondary" id="btn-waiting-logout">Sair</button>
      </div>
    </div>`;
  document.getElementById("btn-recheck").onclick = async () => {
    await initProfile();
    if (canUse()) { toast("Conta aprovada 🎉"); route(); }
    else toast("Ainda não foi aprovada");
  };
  document.getElementById("btn-waiting-logout").onclick = async () => {
    await sb.auth.signOut();
    location.hash = "#/";
  };
}

// ---------------------------------------------------------------- dados
async function fetchGroups() {
  const { data, error } = await sb.from("groups")
    .select("*").order("created_at", { ascending: false });
  if (error) throw error;
  cache.groups = data;
  return data;
}

async function fetchGroupBundle(groupId) {
  const [g, m, e, p] = await Promise.all([
    sb.from("groups").select("*").eq("id", groupId).single(),
    sb.from("group_members").select("*").eq("group_id", groupId).order("created_at"),
    sb.from("expenses")
      .select("*, expense_payers(member_id, amount), expense_shares(member_id, amount)")
      .eq("group_id", groupId)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false }),
    sb.from("payments").select("*").eq("group_id", groupId)
      .order("payment_date", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);
  for (const r of [g, m, e]) if (r.error) throw r.error;
  // A tabela payments pode ainda não existir (schema antigo por atualizar):
  // degrada sem partir a app, só sem a funcionalidade de pagamentos.
  if (p.error) console.warn("payments indisponível:", p.error.message);
  return {
    group: g.data, members: m.data, expenses: e.data,
    payments: p.error ? [] : p.data,
    paymentsReady: !p.error,
  };
}

// ---------------------------------------------------------------- router
function canUse() {
  return !!(profile && (profile.is_approved || profile.is_admin));
}

async function route() {
  if (!session) { renderLogin(); return; }
  renderTopbar();
  if (!profile) await initProfile();
  if (!profile) {
    $app.innerHTML = `<div class="card"><p>Não foi possível carregar o teu perfil.</p>
      <button class="secondary" onclick="location.reload()">Tentar novamente</button></div>`;
    return;
  }
  if (!canUse()) { renderWaiting(); return; }
  const hash = location.hash || "#/";
  const mGroup = hash.match(/^#\/g\/([0-9a-f-]+)(?:\/(\w+))?/i);
  try {
    if (hash.startsWith("#/admin") && profile.is_admin) {
      await renderAdmin();
    } else if (mGroup) {
      await renderGroup(mGroup[1], mGroup[2] || "despesas");
    } else {
      await renderGroups();
    }
  } catch (err) {
    console.error(err);
    $app.innerHTML = `<div class="card"><p>Ocorreu um erro: ${esc(err.message || err)}</p>
      <button class="secondary" onclick="location.hash='#/'">Voltar aos grupos</button></div>`;
  }
}

// ---------------------------------------------------------------- vista: admin
async function renderAdmin() {
  $app.innerHTML = `<div class="loading">A carregar utilizadores…</div>`;
  const { data: users, error } = await sb.from("profiles")
    .select("*").order("created_at");
  if (error) throw error;

  const pending = users.filter(u => !u.is_approved);
  const row = (u) => `
    <li>
      ${avatarHtml(u.full_name || u.email || "?")}
      <div class="item-main">
        <span class="item-title">${esc(u.full_name || u.email || u.id)}
          ${u.is_admin ? `<span class="badge linked">admin</span>` : ""}</span>
        <span class="item-sub">${esc(u.email || "")} · desde ${new Date(u.created_at).toLocaleDateString("pt-PT")}</span>
      </div>
      ${u.is_admin ? "" : u.is_approved
        ? `<button class="danger small" data-revoke="${u.id}">Revogar acesso</button>`
        : `<button class="small" data-approve="${u.id}">Aprovar</button>`}
    </li>`;

  $app.innerHTML = `
    <a class="back-pill" href="#/"><span class="arr">←</span> Grupos</a>
    <div class="header-row" style="margin-top:.4rem;">
      <h1 style="margin:0;">Administração</h1>
    </div>
    <div class="card">
      <h2>À espera de aprovação ${pending.length ? `<span class="badge">${pending.length}</span>` : ""}</h2>
      ${pending.length === 0
        ? `<p class="empty">Ninguém à espera 🎉</p>`
        : `<ul class="list">${pending.map(row).join("")}</ul>`}
    </div>
    <div class="card">
      <h2>Utilizadores com acesso</h2>
      <ul class="list">${users.filter(u => u.is_approved).map(row).join("")}</ul>
    </div>`;

  const setApproved = async (id, approved) => {
    const { error: e } = await sb.rpc("approve_user", { p_id: id, p_approved: approved });
    if (e) return toast(e.message, true);
    toast(approved ? "Utilizador aprovado ✅" : "Acesso revogado");
    renderAdmin();
  };
  $app.querySelectorAll("[data-approve]").forEach(b => {
    b.onclick = () => setApproved(b.dataset.approve, true);
  });
  $app.querySelectorAll("[data-revoke]").forEach(b => {
    b.onclick = () => {
      if (confirm("Revogar o acesso desta pessoa? Deixa de conseguir usar a app até voltares a aprovar.")) {
        setApproved(b.dataset.revoke, false);
      }
    };
  });
}

// ---------------------------------------------------------------- vista: grupos

// Saldo do utilizador em cada grupo onde é membro e última atividade
// (despesa/pagamento mais recente) de cada grupo, para o resumo da home.
// 3 queries no total, a RLS filtra pelos grupos a que tem acesso.
async function fetchMyGroupBalances() {
  const uid = session.user.id;
  const [m, e, p] = await Promise.all([
    sb.from("group_members").select("id, group_id, user_id"),
    sb.from("expenses").select("group_id, created_at, expense_payers(member_id, amount), expense_shares(member_id, amount)"),
    sb.from("payments").select("group_id, created_at, from_member, to_member, amount"),
  ]);
  if (m.error || e.error) return { balances: {}, activity: {} };
  const pays = p.error ? [] : p.data;

  const activity = {};
  const bump = (gid, ts) => {
    const t = Date.parse(ts) || 0;
    if (t > (activity[gid] || 0)) activity[gid] = t;
  };
  for (const x of e.data) bump(x.group_id, x.created_at);
  for (const pay of pays) bump(pay.group_id, pay.created_at);

  const mine = new Map(); // member_id -> group_id (os "eus" de cada grupo)
  for (const mem of m.data) if (mem.user_id === uid) mine.set(mem.id, mem.group_id);

  const balances = {};
  for (const gid of mine.values()) balances[gid] = 0;
  const add = (memberId, cents) => {
    const gid = mine.get(memberId);
    if (gid !== undefined) balances[gid] += cents;
  };
  for (const x of e.data) {
    for (const pp of x.expense_payers) add(pp.member_id, toCents(pp.amount));
    for (const ss of x.expense_shares) add(ss.member_id, -toCents(ss.amount));
  }
  for (const pay of pays) {
    add(pay.from_member, toCents(pay.amount));
    add(pay.to_member, -toCents(pay.amount));
  }
  return { balances, activity };
}

// Grupos favoritos (máx. 4), guardados por utilizador neste browser.
function favsKey() { return `splitwisely_favs_${session.user.id}`; }
function getFavs() {
  try {
    const a = JSON.parse(localStorage.getItem(favsKey()));
    return Array.isArray(a) ? a : [];
  } catch (_) { return []; }
}

async function renderGroups() {
  invalidateGroupCache();
  $app.innerHTML = `<div class="loading">A carregar grupos…</div>`;
  const [groups, { balances, activity }] = await Promise.all([fetchGroups(), fetchMyGroupBalances()]);
  let othersOpen = false;

  const lastAct = (g) => activity[g.id] || Date.parse(g.created_at) || 0;

  // saldo à direita de cada grupo: valor em cima, verbo por baixo (compacto)
  const balanceHtml = (g) => {
    const b = balances[g.id];
    if (b === undefined) return "";
    if (b === 0) return `<span class="item-amount zero">em dia</span>`;
    return `<span class="item-amount ${b > 0 ? "positive" : "negative"}">${fmtMoney(Math.abs(b), g.currency)}</span>
      <span class="bal-label">${b > 0 ? "recebes" : "deves"}</span>`;
  };

  // saldo no rodapé de um card: chip colorido
  const chipBalance = (g) => {
    const b = balances[g.id];
    if (b === undefined) return "";
    if (b === 0) return `<span class="chip zero">✓ em dia</span>`;
    return `<span class="chip ${b > 0 ? "positive" : "negative"}">${b > 0 ? "recebes" : "deves"} ${fmtMoney(Math.abs(b), g.currency)}</span>`;
  };

  // resumo global (soma apenas grupos na mesma moeda, a do 1.º com saldo)
  const mainCur = groups.find(g => balances[g.id])?.currency || "EUR";
  const sameCur = groups.filter(g => g.currency === mainCur && balances[g.id] !== undefined);
  const totPos = sameCur.reduce((a, g) => a + Math.max(balances[g.id], 0), 0);
  const totNeg = sameCur.reduce((a, g) => a - Math.min(balances[g.id], 0), 0);
  const statStrip = groups.length === 0 ? "" : `
    <div class="stat-strip">
      <div class="stat">
        <span class="stat-label">A receber</span>
        <span class="stat-value ${totPos > 0 ? "positive" : "zero"}">${fmtMoney(totPos, mainCur)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">A dever</span>
        <span class="stat-value ${totNeg > 0 ? "negative" : "zero"}">${fmtMoney(totNeg, mainCur)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Grupos</span>
        <span class="stat-value">${groups.length}</span>
      </div>
    </div>`;

  function draw() {
    // até 4 cards em destaque: primeiro os favoritos, depois os grupos
    // com movimentos mais recentes; o resto fica atrás de «Outros grupos»
    const favs = getFavs().filter(id => groups.some(g => g.id === id));
    const byActivity = [...groups].sort((a, b) => lastAct(b) - lastAct(a));
    const featured = favs.map(id => groups.find(g => g.id === id));
    for (const g of byActivity) {
      if (featured.length >= 4) break;
      if (!featured.includes(g)) featured.push(g);
    }
    const others = byActivity.filter(g => !featured.includes(g));

    const starBtn = (g, extra = "") => {
      const isFav = favs.includes(g.id);
      return `<button class="fav-btn ${extra} ${isFav ? "active" : ""}" data-fav="${g.id}"
        title="${isFav ? "Tirar dos favoritos" : "Marcar como favorito"}">${isFav ? "★" : "☆"}</button>`;
    };

    const card = (g) => `
      <div class="group-card" data-goto="${g.id}">
        ${starBtn(g)}
        <span class="group-card-name">${esc(g.name)}</span>
        ${g.description ? `<span class="group-card-desc">${esc(g.description)}</span>` : ""}
        <div class="group-card-foot">${chipBalance(g)}</div>
      </div>`;

    const row = (g) => `
      <li class="group-row">
        <a class="item-link" href="#/g/${g.id}">
          <span class="item-main">
            <span class="item-title">${esc(g.name)}</span>
            ${g.description ? `<span class="item-sub">${esc(g.description)}</span>` : ""}
          </span>
          <span class="item-end">${balanceHtml(g)}</span>
        </a>
        ${starBtn(g, "in-list")}
      </li>`;

    $app.innerHTML = `
      <div class="header-row">
        <h1>Os meus grupos</h1>
        <button id="btn-new-group">+ Novo grupo</button>
      </div>
      <div id="new-group-slot"></div>
      ${statStrip}
      ${groups.length === 0
        ? `<div class="card"><p class="empty">Ainda não tens grupos. Cria o primeiro no botão «+ Novo grupo» 👆</p></div>`
        : `<div class="group-grid">${featured.map(card).join("")}</div>
          ${others.length ? `
            <button class="secondary others-toggle" id="btn-others">
              Outros grupos (${others.length}) <span class="others-arrow">${othersOpen ? "▴" : "▾"}</span>
            </button>
            <div class="card ${othersOpen ? "" : "hidden"}" id="others-card">
              <ul class="list">${others.map(row).join("")}</ul>
            </div>` : ""}`}`;

    // navegação dos cards (a estrela dentro do card não navega)
    $app.querySelectorAll("[data-goto]").forEach(c => {
      c.onclick = (e) => {
        if (e.target.closest(".fav-btn")) return;
        location.hash = `#/g/${c.dataset.goto}`;
      };
    });

    $app.querySelectorAll("[data-fav]").forEach(b => {
      b.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = b.dataset.fav;
        let next = getFavs();
        if (next.includes(id)) next = next.filter(x => x !== id);
        else if (favs.length >= 4) return toast("Só podes ter 4 grupos favoritos — tira um primeiro", true);
        else next.push(id);
        localStorage.setItem(favsKey(), JSON.stringify(next));
        draw();
      };
    });

    $app.querySelector("#btn-others")?.addEventListener("click", () => {
      othersOpen = !othersOpen;
      $app.querySelector("#others-card").classList.toggle("hidden", !othersOpen);
      $app.querySelector(".others-arrow").textContent = othersOpen ? "▴" : "▾";
    });

    bindNewGroup();
  }

  function bindNewGroup() {
  const slot = document.getElementById("new-group-slot");
  const $btnNew = document.getElementById("btn-new-group");

  $btnNew.onclick = () => {
    if (slot.innerHTML) { slot.innerHTML = ""; return; }
    slot.innerHTML = `
      <div class="card">
        <h2>Novo grupo / evento</h2>
        <form id="new-group">
          <div class="row">
            <div class="field" style="flex:3;">
              <label>Nome</label>
              <input name="name" placeholder="Ex.: Férias Algarve 2026" required />
            </div>
            <div class="field" style="flex:1;">
              <label>Moeda</label>
              <select name="currency">
                <option value="EUR" selected>EUR €</option>
                <option value="USD">USD $</option>
                <option value="GBP">GBP £</option>
                <option value="BRL">BRL R$</option>
                <option value="CHF">CHF</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>Descrição (opcional)</label>
            <input name="description" placeholder="Ex.: casa alugada + jantares" />
          </div>
          <label class="check-line">
            <input type="checkbox" name="join" checked />
            Adicionar-me como membro do grupo
          </label>
          <label class="check-line">
            <input type="checkbox" name="use_weights" />
            Divisão por proporções (pesos por pessoa)
            <span class="check-note">por defeito as despesas dividem-se em partes iguais</span>
          </label>
          <div style="margin-top:.8rem;display:flex;gap:.6rem;">
            <button type="submit">Criar grupo</button>
            <button type="button" class="secondary" id="new-group-cancel">Cancelar</button>
          </div>
        </form>
      </div>`;
    slot.querySelector("input[name=name]").focus();
    slot.querySelector("#new-group-cancel").onclick = () => { slot.innerHTML = ""; };

    slot.querySelector("#new-group").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const payload = {
        name: f.get("name").trim(),
        description: f.get("description").trim() || null,
        currency: f.get("currency"),
      };
      if (f.get("use_weights")) payload.use_weights = true;
      let { data: group, error } = await sb.from("groups").insert(payload).select().single();
      // schema antigo sem a coluna use_weights: cria na mesma, mas avisa
      if (error && payload.use_weights && /use_weights/i.test(error.message)) {
        toast("Quotas indisponíveis — corre o schema.sql mais recente no Supabase", true);
        delete payload.use_weights;
        ({ data: group, error } = await sb.from("groups").insert(payload).select().single());
      }
      if (error) return toast(error.message, true);

      if (f.get("join")) {
        const u = session.user;
        const { error: e2 } = await sb.from("group_members").insert({
          group_id: group.id,
          name: u.user_metadata?.full_name || u.email,
          email: u.email,
          user_id: u.id,
        });
        if (e2) toast(e2.message, true);
      }
      location.hash = `#/g/${group.id}/definicoes`;
    };
  };
  }

  draw();
}

// ---------------------------------------------------------------- vista: grupo
async function renderGroup(groupId, tab) {
  if (tab === "membros") tab = "definicoes"; // aba antiga: os membros vivem agora nas definições

  let bundle = groupCache.id === groupId ? groupCache.data : null;
  if (!bundle) {
    // só mostra o ecrã de carregamento quando ainda não estamos dentro do
    // grupo — trocar de separador não deve fazer a página "piscar"
    if (!$app.querySelector(`[data-group-shell="${groupId}"]`)) {
      $app.innerHTML = `<div class="loading">A carregar grupo…</div>`;
    }
    bundle = await fetchGroupBundle(groupId);
    groupCache = { id: groupId, data: bundle };
  }
  const { group, members, expenses, payments, paymentsReady } = bundle;
  const isOwner = group.created_by === session.user.id;

  const tabs = [
    ["despesas", "Despesas"],
    ["saldos", "Saldos"],
    ["definicoes", "Definições"],
  ];

  $app.innerHTML = `
    <div class="page-head" data-group-shell="${group.id}">
      <a class="back-pill" href="#/"><span class="arr">←</span> Grupos</a>
      <div class="header-row">
        <div class="title-line">
          <h1>${esc(group.name)}</h1>
          <span class="badge">${esc(group.currency)}</span>
        </div>
      </div>
      ${group.description ? `<p class="page-desc">${esc(group.description)}</p>` : ""}
    </div>
    <div class="tabs page-tabs">
      ${tabs.map(([id, label]) =>
        `<button data-tab="${id}" class="${id === tab ? "active" : ""}">${label}</button>`).join("")}
    </div>
    <div id="tab-content"></div>`;

  $app.querySelectorAll(".tabs button").forEach(b => {
    b.onclick = () => { location.hash = `#/g/${groupId}/${b.dataset.tab}`; };
  });

  const ctx = { group, members, expenses, payments, paymentsReady, isOwner };
  const $c = document.getElementById("tab-content");
  if (tab === "despesas") renderExpensesTab($c, ctx);
  else if (tab === "saldos") renderBalancesTab($c, ctx);
  else renderSettingsTab($c, ctx);
}

// ------------------------------------------------ tab: despesas
function renderExpensesTab($c, ctx) {
  const { group, members, expenses, payments } = ctx;
  const memberName = id => members.find(m => m.id === id)?.name || "?";
  const myMember = members.find(m => m.user_id === session.user.id);
  const cur = group.currency;

  // efeito líquido da despesa no utilizador: o que pagou menos a sua parte
  const myImpact = (x) => {
    if (!myMember) return "";
    const paid = x.expense_payers.filter(p => p.member_id === myMember.id)
      .reduce((a, p) => a + toCents(p.amount), 0);
    const share = x.expense_shares.filter(s => s.member_id === myMember.id)
      .reduce((a, s) => a + toCents(s.amount), 0);
    const net = paid - share;
    if (net === 0 && paid === 0) return "";
    return `<span class="my-impact ${net >= 0 ? "positive" : "negative"}">
      ${net > 0 ? "+" : ""}${fmtMoney(net, cur)}</span>`;
  };

  // resumo: total do grupo + o meu saldo (despesas e pagamentos)
  const total = expenses.reduce((a, x) => a + toCents(x.amount), 0);
  let myBalance = 0;
  if (myMember) {
    for (const x of expenses) {
      for (const p of x.expense_payers) if (p.member_id === myMember.id) myBalance += toCents(p.amount);
      for (const s of x.expense_shares) if (s.member_id === myMember.id) myBalance -= toCents(s.amount);
    }
    for (const p of payments) {
      if (p.from_member === myMember.id) myBalance += toCents(p.amount);
      if (p.to_member === myMember.id) myBalance -= toCents(p.amount);
    }
  }
  const statStrip = members.length === 0 ? "" : `
    <div class="stat-strip">
      <div class="stat">
        <span class="stat-label">Total do grupo</span>
        <span class="stat-value">${fmtMoney(total, cur)}</span>
      </div>
      ${myMember ? `
      <div class="stat">
        <span class="stat-label">O teu saldo</span>
        <span class="stat-value ${myBalance > 0 ? "positive" : myBalance < 0 ? "negative" : "zero"}">
          ${myBalance === 0 ? "em dia" : (myBalance > 0 ? "+" : "−") + fmtMoney(Math.abs(myBalance), cur)}</span>
      </div>` : ""}
    </div>`;

  // linhas agrupadas por mês; a data fica num bloco compacto à esquerda
  const monthLabel = (d) =>
    new Date(d + "T00:00:00").toLocaleDateString("pt-PT", { month: "long", year: "numeric" });
  const dateBlock = (d) => {
    const dt = new Date(d + "T00:00:00");
    return `<span class="date-block"><span class="d">${dt.getDate()}</span>
      <span class="m">${dt.toLocaleDateString("pt-PT", { month: "short" }).replace(".", "")}</span></span>`;
  };

  let lastMonth = null;
  const rows = expenses.map(x => {
    const payers = x.expense_payers.map(p => memberName(p.member_id)).join(", ");
    const nShares = x.expense_shares.length;
    const m = monthLabel(x.expense_date);
    const head = m !== lastMonth ? `<li class="month-head">${esc(m)}</li>` : "";
    lastMonth = m;
    return `${head}
      <li class="clickable" data-open="${x.id}">
        ${dateBlock(x.expense_date)}
        <div class="item-main">
          <span class="item-title">${esc(x.description)}</span>
          <span class="item-sub">pago por ${esc(payers)} · ${nShares} pessoa${nShares === 1 ? "" : "s"}</span>
        </div>
        <div class="item-end">
          <span class="amount">${fmtMoney(toCents(x.amount), cur)}</span>
          ${myImpact(x)}
        </div>
        <span class="chevron">›</span>
      </li>`;
  }).join("");

  $c.innerHTML = `
    ${statStrip}
    <div class="card">
      <div class="header-row" id="expense-list-head">
        <h2 style="margin:0;">Despesas ${expenses.length ? `<span class="muted">· ${expenses.length}</span>` : ""}</h2>
        <button id="btn-add-expense" ${members.length === 0 ? "disabled" : ""}>+ Nova despesa</button>
      </div>
      ${members.length === 0 ? `<p class="empty">Adiciona primeiro membros no separador «Definições».</p>` : ""}
      <div id="expense-form-slot"></div>
      <div id="expense-list">
      ${expenses.length === 0 && members.length > 0
        ? `<p class="empty">Sem despesas ainda.</p>`
        : `<ul class="list">${rows}</ul>`}
      </div>
    </div>`;

  const slot = $c.querySelector("#expense-form-slot");
  const $list = $c.querySelector("#expense-list");
  const $head = $c.querySelector("#expense-list-head");

  // abre o "detalhe" da despesa: esconde a lista, mostra o formulário
  const openForm = (x) => {
    $list.style.display = "none";
    $head.style.display = "none";
    renderExpenseForm(slot, ctx, x, () => {
      slot.innerHTML = "";
      $list.style.display = "";
      $head.style.display = "";
    });
    slot.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  $c.querySelector("#btn-add-expense")?.addEventListener("click", () => openForm(null));
  $c.querySelectorAll("[data-open]").forEach(li => {
    li.onclick = () => openForm(expenses.find(e => e.id === li.dataset.open));
  });
}

// Formulário de despesa (nova ou edição), com defaults do grupo.
// Dividido em secções (Dados / Quem pagou / Divisão) para não ficar
// um formulário interminável no telemóvel. `onClose` devolve à lista.
function renderExpenseForm(slot, ctx, existing, onClose) {
  const { group, members } = ctx;
  const close = onClose || (() => { slot.innerHTML = ""; });
  const useWeights = !!group.use_weights; // opção do grupo: divisão por proporções

  // estado inicial: quem insere a despesa é o pagador pré-selecionado
  const myMember = members.find(m => m.user_id === session.user.id);
  const initPayers = existing
    ? existing.expense_payers.map(p => p.member_id)
    : [myMember ? myMember.id : members[0].id];

  const initPayerAmounts = {};
  if (existing) existing.expense_payers.forEach(p => { initPayerAmounts[p.member_id] = toCents(p.amount); });

  const initShares = {};
  if (existing) existing.expense_shares.forEach(s => { initShares[s.member_id] = toCents(s.amount); });

  // ao reabrir uma despesa, volta ao modo em que foi gravada (split_mode);
  // despesas de schemas antigos sem a coluna caem no modo "exatos", o
  // único sempre fiel aos valores gravados
  const initMode = existing
    ? (existing.split_mode === "weights" && !useWeights ? "exact" : (existing.split_mode || "exact"))
    : (useWeights ? "weights" : "equal");

  const state = {
    section: "dados", // dados | pagou | divide
    desc: existing?.description || "",
    date: existing?.expense_date || new Date().toISOString().slice(0, 10),
    mode: initMode, // equal | weights | exact
    totalCents: existing ? toCents(existing.amount) : 0,
    payers: new Set(initPayers),
    payerAmounts: { ...initPayerAmounts },
    participants: new Set(existing
      ? existing.expense_shares.map(s => s.member_id)
      : useWeights
        ? members.filter(m => Number(m.default_weight) > 0).map(m => m.id)
        : members.map(m => m.id)),
    weights: Object.fromEntries(members.map(m => [m.id, Number(m.default_weight) || 0])),
    exact: { ...initShares },
  };

  function computedShares() {
    const ids = members.filter(m => state.participants.has(m.id)).map(m => m.id);
    if (ids.length === 0) return {};
    if (state.mode === "exact") {
      return Object.fromEntries(ids.map(id => [id, state.exact[id] || 0]));
    }
    const ws = state.mode === "equal" ? ids.map(() => 1) : ids.map(id => state.weights[id] || 0);
    const parts = splitByWeights(state.totalCents, ws);
    return Object.fromEntries(ids.map((id, i) => [id, parts[i]]));
  }

  function distributePayersEqually() {
    const ids = [...state.payers];
    const parts = splitByWeights(state.totalCents, ids.map(() => 1));
    state.payerAmounts = Object.fromEntries(ids.map((id, i) => [id, parts[i]]));
  }
  if (!existing) distributePayersEqually();

  function draw() {
    const shares = computedShares();
    const paidSum = [...state.payers].reduce((a, id) => a + (state.payerAmounts[id] || 0), 0);
    const shareSum = Object.values(shares).reduce((a, b) => a + b, 0);
    const okPaid = paidSum === state.totalCents && state.totalCents > 0;
    const okShare = shareSum === state.totalCents && state.totalCents > 0;
    const okDados = !!state.desc.trim() && state.totalCents > 0;
    const cur = group.currency;

    const sections = {
      dados: `
        <div class="field">
          <label>Descrição</label>
          <input id="x-desc" value="${esc(state.desc)}" placeholder="Ex.: Jantar no restaurante" />
        </div>
        <div class="row">
          <div class="field">
            <label>Valor (${esc(cur)})</label>
            <input id="x-amount" type="number" step="0.01" min="0" value="${state.totalCents ? (state.totalCents / 100).toFixed(2) : ""}" />
          </div>
          <div class="field">
            <label>Data</label>
            <input id="x-date" type="date" value="${esc(state.date)}" />
          </div>
        </div>`,
      pagou: `
        ${okPaid ? "" : state.totalCents === 0
          ? `<p class="form-status neutral">Indica primeiro o valor na secção «Dados»</p>`
          : `<p class="form-status">${fmtMoney(paidSum, cur)} de ${fmtMoney(state.totalCents, cur)} atribuídos</p>`}
        <table class="split-table">
          ${members.map(m => `
            <tr>
              <td style="width:30px;"><input type="checkbox" data-payer="${m.id}" ${state.payers.has(m.id) ? "checked" : ""} /></td>
              <td>${esc(m.name)}</td>
              <td style="width:130px;">
                <input type="number" step="0.01" min="0" data-payer-amount="${m.id}"
                  value="${state.payers.has(m.id) ? ((state.payerAmounts[m.id] || 0) / 100).toFixed(2) : ""}"
                  ${state.payers.has(m.id) ? "" : "disabled"} />
              </td>
            </tr>`).join("")}
        </table>
        <button class="secondary small" id="x-dist-payers" style="margin-top:.6rem;">Distribuir igualmente pelos pagadores</button>`,
      divide: `
        ${okShare ? "" : state.totalCents === 0
          ? `<p class="form-status neutral">Indica primeiro o valor na secção «Dados»</p>`
          : `<p class="form-status">${fmtMoney(shareSum, cur)} de ${fmtMoney(state.totalCents, cur)} divididos</p>`}
        <div class="tabs" style="margin-bottom:.6rem;">
          <button data-mode="equal" class="${state.mode === "equal" ? "active" : ""}">Partes iguais</button>
          ${useWeights ? `<button data-mode="weights" class="${state.mode === "weights" ? "active" : ""}">Proporção</button>` : ""}
          <button data-mode="exact" class="${state.mode === "exact" ? "active" : ""}">Exatos</button>
        </div>
        <table class="split-table">
          <tr><th></th><th>Pessoa</th><th>${state.mode === "weights" ? "Peso" : state.mode === "exact" ? "Valor" : ""}</th><th style="text-align:right;">Fica com</th></tr>
          ${members.map(m => {
            const inShare = state.participants.has(m.id);
            let ctrl = "";
            if (state.mode === "weights") {
              ctrl = `<input type="number" step="0.1" min="0" data-weight="${m.id}" value="${state.weights[m.id] ?? 0}" ${inShare ? "" : "disabled"} />`;
            } else if (state.mode === "exact") {
              ctrl = `<input type="number" step="0.01" min="0" data-exact="${m.id}" value="${inShare ? ((state.exact[m.id] || 0) / 100).toFixed(2) : ""}" ${inShare ? "" : "disabled"} />`;
            }
            return `<tr>
              <td style="width:30px;"><input type="checkbox" data-part="${m.id}" ${inShare ? "checked" : ""} /></td>
              <td>${esc(m.name)}</td>
              <td style="width:130px;">${ctrl}</td>
              <td style="text-align:right;" class="amount">${inShare ? fmtMoney(shares[m.id] || 0, cur) : "—"}</td>
            </tr>`;
          }).join("")}
        </table>`,
    };

    // frase-resumo do que vai ser gravado: quem pagou e como se divide
    const nameOf = id => shortName(members.find(m => m.id === id)?.name || "?");
    const joinNames = arr => arr.length <= 1 ? arr.join("")
      : `${arr.slice(0, -1).join(", ")} e ${arr[arr.length - 1]}`;
    let summary = "";
    if (state.totalCents > 0 && state.payers.size > 0) {
      const payerIds = [...state.payers];
      const paidTxt = joinNames(payerIds.map(id =>
        `<strong>${esc(nameOf(id))}</strong> pagou ${fmtMoney(state.payerAmounts[id] || 0, cur)}`));
      const shareIds = Object.keys(shares);
      let divTxt = "";
      if (shareIds.length > 0) {
        let modeTxt = state.mode === "equal" ? "em partes iguais"
          : state.mode === "weights" ? "por proporção" : "em valores exatos";
        // despesas antigas sem split_mode reabrem em "exatos"; se as partes
        // forem todas iguais (± arredondamento) a frase natural é "partes iguais"
        if (state.mode === "exact") {
          const vals = Object.values(shares);
          if (vals.length > 1 && vals.every(v => Math.abs(v - vals[0]) <= 1)) modeTxt = "em partes iguais";
        }
        const who = shareIds.length === members.length
          ? "todos os elementos do grupo"
          : joinNames(shareIds.map(id => `<strong>${esc(nameOf(id))}</strong>`));
        divTxt = `, dividido ${modeTxt} por ${who}`;
      }
      summary = `<p class="form-summary">${paidTxt}${divTxt}.</p>`;
    }

    const secTab = (id, label, ok) =>
      `<button data-sec="${id}" class="${state.section === id ? "active" : ""}">${label}${ok ? ' <span class="tab-ok">✓</span>' : ""}</button>`;

    slot.innerHTML = `
    <div class="expense-detail">
      <div class="form-head">
        <button class="back-pill" id="x-back"><span class="arr">←</span> Despesas</button>
        <h2 style="margin:0;">${existing ? "Detalhe da despesa" : "Nova despesa"}</h2>
      </div>
      <div class="tabs form-tabs">
        ${secTab("dados", "Dados", okDados)}
        ${secTab("pagou", "Quem pagou", okPaid)}
        ${secTab("divide", "Divisão", okShare)}
      </div>
      <div class="form-section">${sections[state.section]}</div>
      ${summary}
      <div class="form-actions">
        <button id="x-save">${existing ? "Guardar alterações" : "Adicionar despesa"}</button>
        ${existing ? `<button class="danger" id="x-del">Apagar</button>` : ""}
      </div>
    </div>`;

    // ---- listeners
    slot.querySelector("#x-back").onclick = close;
    slot.querySelectorAll("[data-sec]").forEach(b => {
      b.onclick = () => { state.section = b.dataset.sec; draw(); };
    });

    const $desc = slot.querySelector("#x-desc");
    if ($desc) $desc.oninput = () => { state.desc = $desc.value; };
    const $date = slot.querySelector("#x-date");
    if ($date) $date.onchange = () => { state.date = $date.value; };
    const $amount = slot.querySelector("#x-amount");
    if ($amount) $amount.onchange = () => {
      state.totalCents = toCents($amount.value);
      distributePayersEqually();
      draw();
    };

    slot.querySelectorAll("[data-payer]").forEach(cb => {
      cb.onchange = () => {
        cb.checked ? state.payers.add(cb.dataset.payer) : state.payers.delete(cb.dataset.payer);
        distributePayersEqually();
        draw();
      };
    });
    slot.querySelectorAll("[data-payer-amount]").forEach(inp => {
      inp.onchange = () => {
        state.payerAmounts[inp.dataset.payerAmount] = toCents(inp.value);
        draw();
      };
    });
    const $dist = slot.querySelector("#x-dist-payers");
    if ($dist) $dist.onclick = () => { distributePayersEqually(); draw(); };

    slot.querySelectorAll("[data-mode]").forEach(b => {
      b.onclick = () => { state.mode = b.dataset.mode; draw(); };
    });
    slot.querySelectorAll("[data-part]").forEach(cb => {
      cb.onchange = () => {
        cb.checked ? state.participants.add(cb.dataset.part) : state.participants.delete(cb.dataset.part);
        draw();
      };
    });
    slot.querySelectorAll("[data-weight]").forEach(inp => {
      inp.onchange = () => {
        state.weights[inp.dataset.weight] = parseFloat(inp.value) || 0;
        draw();
      };
    });
    slot.querySelectorAll("[data-exact]").forEach(inp => {
      inp.onchange = () => {
        state.exact[inp.dataset.exact] = toCents(inp.value);
        draw();
      };
    });

    slot.querySelector("#x-del")?.addEventListener("click", async () => {
      if (!confirm("Apagar esta despesa?")) return;
      const { error } = await sb.from("expenses").delete().eq("id", existing.id);
      if (error) return toast(error.message, true);
      toast("Despesa apagada");
      refresh();
    });

    slot.querySelector("#x-save").onclick = async () => {
      const desc = state.desc.trim();
      const date = state.date;
      const shares2 = computedShares();
      const paidSum2 = [...state.payers].reduce((a, id) => a + (state.payerAmounts[id] || 0), 0);
      const shareSum2 = Object.values(shares2).reduce((a, b) => a + b, 0);

      const fail = (section, msg) => { state.section = section; draw(); toast(msg, true); };
      if (!desc) return fail("dados", "Falta a descrição");
      if (state.totalCents <= 0) return fail("dados", "O valor tem de ser maior que zero");
      if (state.payers.size === 0) return fail("pagou", "Escolhe quem pagou");
      if (paidSum2 !== state.totalCents) return fail("pagou", "Os valores pagos não somam o total");
      if (Object.keys(shares2).length === 0) return fail("divide", "Escolhe por quem se divide");
      if (shareSum2 !== state.totalCents) return fail("divide", "A divisão não soma o total");

      const payload = {
        group_id: group.id,
        description: desc,
        amount: (state.totalCents / 100).toFixed(2),
        expense_date: date || new Date().toISOString().slice(0, 10),
        split_mode: state.mode,
      };

      // schema antigo sem a coluna split_mode: grava na mesma sem o modo
      const stripSplitMode = (error) => {
        if (!error || !/split_mode/i.test(error.message)) return false;
        toast("Modo de divisão não gravado — corre o schema.sql mais recente no Supabase", true);
        delete payload.split_mode;
        return true;
      };

      let expenseId = existing?.id;
      if (existing) {
        let { error } = await sb.from("expenses").update(payload).eq("id", existing.id);
        if (stripSplitMode(error)) ({ error } = await sb.from("expenses").update(payload).eq("id", existing.id));
        if (error) return toast(error.message, true);
        const d1 = await sb.from("expense_payers").delete().eq("expense_id", existing.id);
        const d2 = await sb.from("expense_shares").delete().eq("expense_id", existing.id);
        if (d1.error || d2.error) return toast((d1.error || d2.error).message, true);
      } else {
        let { data, error } = await sb.from("expenses").insert(payload).select().single();
        if (stripSplitMode(error)) ({ data, error } = await sb.from("expenses").insert(payload).select().single());
        if (error) return toast(error.message, true);
        expenseId = data.id;
      }

      const payerRows = [...state.payers]
        .filter(id => (state.payerAmounts[id] || 0) > 0)
        .map(id => ({ expense_id: expenseId, member_id: id, amount: (state.payerAmounts[id] / 100).toFixed(2) }));
      const shareRows = Object.entries(shares2)
        .filter(([, c]) => c > 0)
        .map(([id, c]) => ({ expense_id: expenseId, member_id: id, amount: (c / 100).toFixed(2) }));

      const i1 = await sb.from("expense_payers").insert(payerRows);
      const i2 = await sb.from("expense_shares").insert(shareRows);
      if (i1.error || i2.error) return toast((i1.error || i2.error).message, true);

      toast(existing ? "Despesa atualizada" : "Despesa adicionada");
      refresh();
    };
  }

  draw();
}

// ------------------------------------------------ tab: saldos
function renderBalancesTab($c, ctx) {
  const { group, members, expenses, payments, paymentsReady } = ctx;
  const cur = group.currency;
  const memberName = id => members.find(m => m.id === id)?.name || "?";

  const balance = Object.fromEntries(members.map(m => [m.id, 0])); // cêntimos: + recebe, - deve
  for (const x of expenses) {
    for (const p of x.expense_payers) if (p.member_id in balance) balance[p.member_id] += toCents(p.amount);
    for (const s of x.expense_shares) if (s.member_id in balance) balance[s.member_id] -= toCents(s.amount);
  }
  // pagamentos já feitos: quem pagou fica menos devedor, quem recebeu menos credor
  for (const p of payments) {
    if (p.from_member in balance) balance[p.from_member] += toCents(p.amount);
    if (p.to_member in balance) balance[p.to_member] -= toCents(p.amount);
  }

  // sugestões de acerto (algoritmo guloso)
  const debtors = members.filter(m => balance[m.id] < 0).map(m => ({ m, v: -balance[m.id] })).sort((a, b) => b.v - a.v);
  const creditors = members.filter(m => balance[m.id] > 0).map(m => ({ m, v: balance[m.id] })).sort((a, b) => b.v - a.v);
  const settlements = [];
  let di = 0, ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const pay = Math.min(debtors[di].v, creditors[ci].v);
    if (pay > 0) settlements.push({ from: debtors[di].m, to: creditors[ci].m, cents: pay });
    debtors[di].v -= pay;
    creditors[ci].v -= pay;
    if (debtors[di].v === 0) di++;
    if (creditors[ci].v === 0) ci++;
  }

  // a quem deve / de quem recebe cada pessoa (para a linha secundária)
  const owesTo = {}, getsFrom = {};
  for (const s of settlements) {
    (owesTo[s.from.id] ??= []).push({ name: s.to.name, cents: s.cents });
    (getsFrom[s.to.id] ??= []).push({ name: s.from.name, cents: s.cents });
  }
  // sublinha: 1 pessoa mostra o nome; várias ficam «deve a N pessoas ▾»
  // e a linha expande ao toque com o detalhe de cada uma
  const subline = (mId, b) => {
    const list = b < 0 ? owesTo[mId] : b > 0 ? getsFrom[mId] : null;
    if (!list?.length) return "";
    const verb = b < 0 ? "deve a" : "recebe de";
    if (list.length === 1) return `<span class="item-sub">${verb} ${esc(list[0].name)}</span>`;
    return `<span class="item-sub">${verb} ${list.length} pessoas <span class="expand-arrow">▾</span></span>`;
  };

  const totalPaid = payments.reduce((a, p) => a + toCents(p.amount), 0);

  $c.innerHTML = `
    <div class="card">
      <h2>Saldos</h2>
      ${members.length === 0 ? `<p class="empty">Sem membros.</p>` : `
      <ul class="list balances">
        ${members.map(m => {
          const b = balance[m.id];
          const list = b < 0 ? owesTo[m.id] : b > 0 ? getsFrom[m.id] : null;
          const expandable = (list?.length || 0) > 1;
          return `<li class="${expandable ? "clickable" : ""}" ${expandable ? `data-bal="${m.id}"` : ""}>
            ${avatarHtml(m.name)}
            <div class="item-main">
              <span class="item-title">${esc(m.name)}</span>
              ${subline(m.id, b)}
            </div>
            <span class="chip ${b > 0 ? "positive" : b < 0 ? "negative" : "zero"}">
              ${b === 0 ? "✓ em dia" : (b > 0 ? "recebe " : "deve ") + fmtMoney(Math.abs(b), cur)}
            </span>
          </li>
          ${expandable ? `<li class="balance-detail hidden" data-bdetail="${m.id}">
            <ul class="detail-list">
              ${list.map(x => `<li>
                <span>${b < 0 ? "a" : "de"} ${esc(x.name)}</span>
                <span class="amount">${fmtMoney(x.cents, cur)}</span>
              </li>`).join("")}
            </ul>
          </li>` : ""}`;
        }).join("")}
      </ul>`}
    </div>

    <div class="card">
      <h2>Como acertar contas</h2>
      ${settlements.length === 0
        ? `<p class="empty">Está tudo em dia 🎉</p>`
        : settlements.map((s, i) => `
          <div class="settle-line">
            <span class="settle-avatars">
              ${avatarHtml(s.from.name)}${avatarHtml(s.to.name)}
            </span>
            <div class="item-main">
              <span class="item-title">${esc(shortName(s.from.name))} <span class="settle-arrow">→</span> ${esc(shortName(s.to.name))}</span>
            </div>
            <span class="settle-right">
              <span class="amount">${fmtMoney(s.cents, cur)}</span>
              ${paymentsReady ? `<button class="small" data-settle="${i}">Pagar</button>` : ""}
            </span>
          </div>`).join("")}
    </div>

    <div class="card">
      <div class="card-title-row">
        <h2>Pagamentos</h2>
        ${paymentsReady ? `<button class="secondary small" id="btn-add-payment">+ Registar</button>` : ""}
      </div>
      ${!paymentsReady ? `<p class="muted">Para ativar o registo de pagamentos, corre a versão mais
        recente de <code>supabase/schema.sql</code> no SQL Editor do Supabase.</p>` : `
      <div id="payment-form-slot"></div>
      ${payments.length === 0
        ? `<p class="empty">Ainda não há pagamentos registados.</p>`
        : `<ul class="list">
            ${payments.map(p => `
              <li>
                <div class="item-main">
                  <span class="item-title payment-line">
                    ${esc(memberName(p.from_member))} <span class="settle-arrow">→</span> ${esc(memberName(p.to_member))}
                  </span>
                  <span class="item-sub">${fmtDate(p.payment_date)}${p.note ? ` · ${esc(p.note)}` : ""}</span>
                </div>
                <span class="amount">${fmtMoney(toCents(p.amount), cur)}</span>
                <button class="ghost small" data-pdel="${p.id}" title="Apagar pagamento">✕</button>
              </li>`).join("")}
          </ul>
          ${totalPaid > 0 ? `<p class="muted" style="text-align:right;margin:.5rem 0 0;">total acertado: ${fmtMoney(totalPaid, cur)}</p>` : ""}`}`}
    </div>`;

  // expandir/encolher o detalhe de um saldo com várias pessoas
  $c.querySelectorAll("[data-bal]").forEach(li => {
    li.onclick = () => {
      $c.querySelector(`[data-bdetail="${li.dataset.bal}"]`).classList.toggle("hidden");
      li.classList.toggle("open");
      li.querySelector(".expand-arrow")?.classList.toggle("open");
    };
  });

  if (!paymentsReady) return;

  const slot = $c.querySelector("#payment-form-slot");

  function paymentForm(prefill) {
    slot.innerHTML = `
      <div class="card inner-card">
        <h2>Registar pagamento</h2>
        <div class="row">
          <div class="field"><label>Quem paga</label>
            <select id="p-from">${members.map(m =>
              `<option value="${m.id}" ${prefill?.from === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
          </div>
          <div class="field"><label>Recebe</label>
            <select id="p-to">${members.map(m =>
              `<option value="${m.id}" ${prefill?.to === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
          </div>
        </div>
        <div class="row">
          <div class="field"><label>Valor (${esc(cur)})</label>
            <input id="p-amount" type="number" step="0.01" min="0"
              value="${prefill ? (prefill.cents / 100).toFixed(2) : ""}" />
          </div>
          <div class="field"><label>Data</label>
            <input id="p-date" type="date" value="${new Date().toISOString().slice(0, 10)}" />
          </div>
        </div>
        <div class="field"><label>Nota (opcional)</label>
          <input id="p-note" placeholder="Ex.: MB Way" /></div>
        <div style="display:flex;gap:.6rem;">
          <button id="p-save">Guardar pagamento</button>
          <button class="secondary" id="p-cancel">Cancelar</button>
        </div>
      </div>`;
    slot.scrollIntoView({ behavior: "smooth", block: "center" });

    slot.querySelector("#p-cancel").onclick = () => { slot.innerHTML = ""; };
    slot.querySelector("#p-save").onclick = async () => {
      const from = slot.querySelector("#p-from").value;
      const to = slot.querySelector("#p-to").value;
      const cents = toCents(slot.querySelector("#p-amount").value);
      if (from === to) return toast("Quem paga e quem recebe têm de ser pessoas diferentes", true);
      if (cents <= 0) return toast("O valor tem de ser maior que zero", true);
      const { error } = await sb.from("payments").insert({
        group_id: group.id,
        from_member: from,
        to_member: to,
        amount: (cents / 100).toFixed(2),
        payment_date: slot.querySelector("#p-date").value || new Date().toISOString().slice(0, 10),
        note: slot.querySelector("#p-note").value.trim() || null,
      });
      if (error) return toast(error.message, true);
      toast("Pagamento registado 💸");
      refresh();
    };
  }

  $c.querySelector("#btn-add-payment")?.addEventListener("click", () => paymentForm(null));
  $c.querySelectorAll("[data-settle]").forEach(b => {
    b.onclick = () => {
      const s = settlements[Number(b.dataset.settle)];
      paymentForm({ from: s.from.id, to: s.to.id, cents: s.cents });
    };
  });
  $c.querySelectorAll("[data-pdel]").forEach(b => {
    b.onclick = async () => {
      if (!confirm("Apagar este pagamento? O saldo volta a refletir a dívida.")) return;
      const { error } = await sb.from("payments").delete().eq("id", b.dataset.pdel);
      if (error) return toast(error.message, true);
      toast("Pagamento apagado");
      refresh();
    };
  });
}

// ------------------------------------------------ secção: membros (dentro das definições)
function renderMembersSection($c, ctx) {
  const { members } = ctx;
  const useWeights = !!ctx.group.use_weights;

  const inviteHint = `Se indicares um email, toca no membro e usa
       <strong>«Convidar por email»</strong> para lhe mandar o link da app. Ao
       entrar com a conta Google desse email, a pessoa fica logo ligada ao grupo
       e com acesso aprovado — sem esperar por aprovação do admin.`;
  const hint = useWeights
    ? `<p>O <strong>peso</strong> define a proporção default na divisão das despesas
       (0 = não entra por defeito). As alterações ao peso <strong>gravam-se
       automaticamente</strong>. ${inviteHint} Toca num membro para editar o nome
       e o email ou para o remover.</p>`
    : `<p>${inviteHint} As despesas dividem-se em partes iguais — podes ativar a divisão
       por proporções na opção «Divisão por proporções» acima. Toca num membro
       para editar o nome e o email ou para o remover.</p>`;

  $c.innerHTML = `
    <div id="member-detail-slot"></div>
    <div id="members-list-wrap">
    <div class="card">
      <h2>Membros ${members.length ? `<span class="muted">· ${members.length}</span>` : ""}</h2>
      <details class="hint">
        <summary>${useWeights ? "Para que serve o peso?" : "Como funcionam os convites por email?"}</summary>
        ${hint}
      </details>
      ${members.length === 0 ? `<p class="empty">Ainda sem membros.</p>` : `
      <ul class="list">
        ${members.map(m => `
          <li class="clickable" data-member="${m.id}">
            ${avatarHtml(m.name)}
            <div class="item-main">
              <span class="item-title">${esc(m.name)}</span>
              ${m.user_id ? `<span class="item-sub"><span class="badge linked">conta ligada</span></span>`
                : m.email ? `<span class="item-sub">convite: ${esc(m.email)}</span>` : ""}
            </div>
            <div class="member-controls">
              ${useWeights ? `<label class="ctl"><span>Peso</span>
                <input type="number" step="0.1" min="0" data-mw="${m.id}" value="${m.default_weight}" /></label>` : ""}
            </div>
            <span class="chevron">›</span>
          </li>`).join("")}
      </ul>`}
    </div>
    <div class="card">
      <h2>Adicionar pessoa</h2>
      <form id="new-member">
        <div class="row">
          <div class="field" style="flex:2;"><label>Nome</label><input name="name" required placeholder="Ex.: Maria" /></div>
          <div class="field" style="flex:2;"><label>Email (opcional)</label><input name="email" type="email" placeholder="maria@gmail.com" /></div>
          ${useWeights ? `<div class="field" style="max-width:90px;"><label>Peso</label>
            <input name="weight" type="number" step="0.1" min="0" value="1" /></div>` : ""}
        </div>
        <button type="submit">Adicionar</button>
      </form>
    </div>
    </div>`;

  const $wrap = $c.querySelector("#members-list-wrap");
  const $slot = $c.querySelector("#member-detail-slot");

  // detalhe de um membro: esconde a lista, mostra o formulário de edição
  function openMember(m) {
    $wrap.style.display = "none";
    $slot.innerHTML = `
      <div class="card">
        <div class="form-head">
          <button class="back-pill" id="m-back"><span class="arr">←</span> Membros</button>
          <h2 style="margin:0;">Detalhe do membro</h2>
        </div>
        <div class="field"><label>Nome</label>
          <input id="m-name" value="${esc(m.name)}" required /></div>
        <div class="field"><label>Email</label>
          <input id="m-email" type="email" value="${esc(m.email || "")}"
            placeholder="liga a pessoa à conta Google dela" ${m.user_id ? "disabled" : ""} /></div>
        ${m.user_id ? `<p class="muted" style="margin:-.3rem 0 .7rem;">Esta pessoa já entrou com a
          conta Google dela <span class="badge linked">conta ligada</span> — o email já não se altera.</p>` : ""}
        ${!m.user_id && m.email ? `
          <a class="btn invite" id="m-invite" href="${esc(inviteMailtoHref(m, ctx.group))}">✉️ Convidar por email</a>
          <p class="muted" style="margin:.35rem 0 .8rem;">Abre o teu email já preenchido com o link. A pessoa
            entra com a conta Google deste email e fica logo ligada ao grupo. Se acabaste de mudar o email,
            grava primeiro.</p>` : ""}
        ${useWeights ? `<div class="field" style="max-width:120px;"><label>Peso</label>
          <input id="m-weight" type="number" step="0.1" min="0" value="${m.default_weight}" /></div>` : ""}
        <div class="form-actions">
          <button id="m-save">Guardar</button>
          <button class="danger" id="m-del">Remover do grupo</button>
        </div>
      </div>`;
    $slot.scrollIntoView({ behavior: "smooth", block: "start" });

    const close = () => { $slot.innerHTML = ""; $wrap.style.display = ""; };
    $slot.querySelector("#m-back").onclick = close;

    $slot.querySelector("#m-save").onclick = async () => {
      const name = $slot.querySelector("#m-name").value.trim();
      if (!name) return toast("O nome não pode ficar vazio", true);
      const payload = { name };
      if (!m.user_id) payload.email = $slot.querySelector("#m-email").value.trim() || null;
      if (useWeights) payload.default_weight = parseFloat($slot.querySelector("#m-weight").value) || 0;
      const { error } = await sb.from("group_members").update(payload).eq("id", m.id);
      if (error) return toast(error.message, true);
      toast("Membro atualizado");
      refresh();
    };

    $slot.querySelector("#m-del").onclick = async () => {
      if (!confirm(`Remover ${m.name} do grupo? As despesas em que participa perdem essa linha.`)) return;
      const { error } = await sb.from("group_members").delete().eq("id", m.id);
      if (error) return toast(error.message, true);
      toast("Pessoa removida");
      refresh();
    };
  }

  $c.querySelectorAll("[data-member]").forEach(li => {
    li.onclick = (e) => {
      // mexer no peso inline não deve abrir o detalhe
      if (e.target.closest("[data-mw]")) return;
      openMember(members.find(m => m.id === li.dataset.member));
    };
  });

  $c.querySelectorAll("[data-mw]").forEach(inp => {
    inp.onchange = async () => {
      const { error } = await sb.from("group_members")
        .update({ default_weight: parseFloat(inp.value) || 0 })
        .eq("id", inp.dataset.mw);
      if (error) return toast(error.message, true);
      // atualiza também a cache do grupo, para os outros separadores
      // verem já o peso novo sem ir de novo ao servidor
      const mem = members.find(m => m.id === inp.dataset.mw);
      if (mem) mem.default_weight = parseFloat(inp.value) || 0;
      // feedback visível de que o valor ficou logo gravado na BD
      inp.classList.add("saved");
      setTimeout(() => inp.classList.remove("saved"), 1500);
      toast("Peso guardado automaticamente ✓");
    };
  });

  $c.querySelector("#new-member").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { error } = await sb.from("group_members").insert({
      group_id: ctx.group.id,
      name: f.get("name").trim(),
      email: f.get("email").trim() || null,
      // sem campo de peso (grupos de partes iguais) fica 1, para o caso
      // de a divisão por proporções vir a ser ativada mais tarde
      default_weight: f.get("weight") == null ? 1 : (parseFloat(f.get("weight")) || 0),
    });
    if (error) return toast(error.message, true);
    toast("Pessoa adicionada");
    refresh();
  };
}

// ------------------------------------------------ tab: definições
function renderSettingsTab($c, ctx) {
  const { group, isOwner } = ctx;

  $c.innerHTML = `
    <div class="card">
      <h2>Definições do grupo</h2>
      ${isOwner ? "" : `<p class="muted">Só quem criou o grupo pode alterar estas definições.</p>`}
      <form id="edit-group">
        <div class="row">
          <div class="field" style="flex:3;"><label>Nome</label>
            <input name="name" value="${esc(group.name)}" ${isOwner ? "" : "disabled"} required /></div>
          <div class="field"><label>Moeda</label>
            <select name="currency" ${isOwner ? "" : "disabled"}>
              ${["EUR", "USD", "GBP", "BRL", "CHF"].map(c =>
                `<option value="${c}" ${group.currency === c ? "selected" : ""}>${c}</option>`).join("")}
            </select></div>
        </div>
        <div class="field"><label>Descrição</label>
          <input name="description" value="${esc(group.description || "")}" ${isOwner ? "" : "disabled"} /></div>
        <label class="check-line">
          <input type="checkbox" name="use_weights" ${group.use_weights ? "checked" : ""} ${isOwner ? "" : "disabled"} />
          Divisão por proporções (pesos por pessoa)
          <span class="check-note">ligado, cada pessoa tem um peso na lista de membros em baixo;
            desligado, as despesas dividem-se em partes iguais</span>
        </label>
      </form>
    </div>
    <div id="members-section"></div>
    ${isOwner ? `
    <button type="submit" form="edit-group" id="btn-save-group" style="width:100%;margin-bottom:.8rem;">Guardar definições</button>
    <div class="card">
      <h2>Zona de perigo</h2>
      <button class="danger" id="btn-del-group">Apagar grupo e todas as despesas</button>
    </div>` : ""}`;

  // os membros gerem-se aqui, logo abaixo das definições — a opção da
  // divisão por proporções mexe na forma como se definem (o peso)
  const drawMembers = (useWeights) => renderMembersSection(
    $c.querySelector("#members-section"),
    { ...ctx, group: { ...ctx.group, use_weights: useWeights } });
  drawMembers(!!group.use_weights);

  if (!isOwner) return;

  // ligar/desligar a checkbox mostra logo (ou esconde) os pesos nos
  // membros em baixo, sem esperar pelo «Guardar definições»
  $c.querySelector('input[name="use_weights"]').onchange = (e) => {
    drawMembers(e.target.checked);
    if (e.target.checked) toast("Define os pesos em baixo e carrega em «Guardar definições»");
  };

  document.getElementById("edit-group").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const payload = {
      name: f.get("name").trim(),
      description: f.get("description").trim() || null,
      currency: f.get("currency"),
      use_weights: !!f.get("use_weights"),
    };
    let { error } = await sb.from("groups").update(payload).eq("id", group.id);
    // schema antigo sem a coluna use_weights: guarda o resto na mesma
    if (error && /use_weights/i.test(error.message)) {
      if (payload.use_weights) toast("Quotas indisponíveis — corre o schema.sql mais recente no Supabase", true);
      delete payload.use_weights;
      ({ error } = await sb.from("groups").update(payload).eq("id", group.id));
    }
    if (error) return toast(error.message, true);
    toast("Grupo atualizado");
    refresh();
  };

  document.getElementById("btn-del-group").onclick = async () => {
    if (!confirm(`Apagar o grupo «${group.name}» e TODAS as despesas? Não há volta atrás.`)) return;
    const { error } = await sb.from("groups").delete().eq("id", group.id);
    if (error) return toast(error.message, true);
    toast("Grupo apagado");
    location.hash = "#/";
  };
}

// ---------------------------------------------------------------- arranque

// Garante o perfil no schema splitwisely (RPC ensure_profile — não há
// trigger em auth.users porque o projeto Supabase é partilhado por
// várias apps; quem foi convidado por email entra já aprovado) e liga os
// convites por email aos grupos se a conta estiver aprovada.
async function initProfile() {
  const { data, error } = await sb.rpc("ensure_profile");
  if (error) {
    console.error(error);
    toast(error.message, true);
    profile = null;
    return;
  }
  profile = data;
  if (canUse()) {
    const { data: n } = await sb.rpc("claim_memberships");
    if (n > 0) toast(`Foste ligado a ${n} grupo${n === 1 ? "" : "s"} onde te tinham convidado 🎉`);
  }
}

async function main() {
  const cfg = loadConfig();
  if (!cfg) { renderSetup(); return; }

  // A app vive no schema `splitwisely` (projeto Supabase partilhado
  // com as outras apps). O schema tem de estar exposto na Data API.
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    db: { schema: "splitwisely" },
  });

  const { data } = await sb.auth.getSession();
  session = data.session;

  sb.auth.onAuthStateChange(async (event, s) => {
    const wasLoggedOut = !session;
    session = s;
    if (event === "SIGNED_IN" && wasLoggedOut) {
      await initProfile();
      route();
    } else if (event === "SIGNED_OUT") {
      profile = null;
      route();
    }
  });

  if (session) await initProfile();

  window.addEventListener("hashchange", route);
  route();
}

main();
