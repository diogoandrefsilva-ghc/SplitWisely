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
  const [g, m, e] = await Promise.all([
    sb.from("groups").select("*").eq("id", groupId).single(),
    sb.from("group_members").select("*").eq("group_id", groupId).order("created_at"),
    sb.from("expenses")
      .select("*, expense_payers(member_id, amount), expense_shares(member_id, amount)")
      .eq("group_id", groupId)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);
  for (const r of [g, m, e]) if (r.error) throw r.error;
  return { group: g.data, members: m.data, expenses: e.data };
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
      <div style="flex:1;">
        <div style="font-weight:600;">${esc(u.full_name || u.email || u.id)}
          ${u.is_admin ? `<span class="badge linked">admin</span>` : ""}</div>
        <div class="expense-meta">${esc(u.email || "")} · desde ${new Date(u.created_at).toLocaleDateString("pt-PT")}</div>
      </div>
      ${u.is_admin ? "" : u.is_approved
        ? `<button class="danger small" data-revoke="${u.id}">Revogar acesso</button>`
        : `<button class="small" data-approve="${u.id}">Aprovar</button>`}
    </li>`;

  $app.innerHTML = `
    <a class="back-link" href="#/">← Todos os grupos</a>
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
async function renderGroups() {
  $app.innerHTML = `<div class="loading">A carregar grupos…</div>`;
  const groups = await fetchGroups();

  $app.innerHTML = `
    <div class="header-row">
      <h1 style="margin:0;">Os meus grupos</h1>
    </div>
    <div class="card">
      ${groups.length === 0
        ? `<p class="empty">Ainda não tens grupos. Cria o primeiro abaixo 👇</p>`
        : `<ul class="list">${groups.map(g => `
            <li>
              <a class="item-link" href="#/g/${g.id}">${esc(g.name)}</a>
              <span class="badge">${esc(g.currency)}</span>
            </li>`).join("")}</ul>`}
    </div>
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
        <label style="font-weight:400;font-size:.88rem;">
          <input type="checkbox" name="join" checked style="width:auto;margin-right:.4rem;" />
          Adicionar-me como membro do grupo
        </label>
        <div style="margin-top:.8rem;">
          <button type="submit">Criar grupo</button>
        </div>
      </form>
    </div>`;

  document.getElementById("new-group").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { data: group, error } = await sb.from("groups").insert({
      name: f.get("name").trim(),
      description: f.get("description").trim() || null,
      currency: f.get("currency"),
    }).select().single();
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
    location.hash = `#/g/${group.id}/membros`;
  };
}

// ---------------------------------------------------------------- vista: grupo
async function renderGroup(groupId, tab) {
  $app.innerHTML = `<div class="loading">A carregar grupo…</div>`;
  const { group, members, expenses } = await fetchGroupBundle(groupId);
  const isOwner = group.created_by === session.user.id;

  const tabs = [
    ["despesas", "Despesas"],
    ["saldos", "Saldos"],
    ["membros", "Membros"],
    ["definicoes", "Definições"],
  ];

  $app.innerHTML = `
    <a class="back-link" href="#/">← Todos os grupos</a>
    <div class="header-row" style="margin-top:.4rem;">
      <h1 style="margin:0;">${esc(group.name)}</h1>
      <span class="badge">${esc(group.currency)}</span>
    </div>
    ${group.description ? `<p class="muted" style="margin-top:0;">${esc(group.description)}</p>` : ""}
    <div class="tabs">
      ${tabs.map(([id, label]) =>
        `<button data-tab="${id}" class="${id === tab ? "active" : ""}">${label}</button>`).join("")}
    </div>
    <div id="tab-content"></div>`;

  $app.querySelectorAll(".tabs button").forEach(b => {
    b.onclick = () => { location.hash = `#/g/${groupId}/${b.dataset.tab}`; };
  });

  const ctx = { group, members, expenses, isOwner };
  const $c = document.getElementById("tab-content");
  if (tab === "despesas") renderExpensesTab($c, ctx);
  else if (tab === "saldos") renderBalancesTab($c, ctx);
  else if (tab === "membros") renderMembersTab($c, ctx);
  else renderSettingsTab($c, ctx);
}

// ------------------------------------------------ tab: despesas
function renderExpensesTab($c, ctx) {
  const { group, members, expenses } = ctx;
  const memberName = id => members.find(m => m.id === id)?.name || "?";

  $c.innerHTML = `
    <div class="card">
      <div class="header-row">
        <h2 style="margin:0;">Despesas</h2>
        <button id="btn-add-expense" ${members.length === 0 ? "disabled" : ""}>+ Nova despesa</button>
      </div>
      ${members.length === 0 ? `<p class="empty">Adiciona primeiro membros na aba «Membros».</p>` : ""}
      <div id="expense-form-slot"></div>
      ${expenses.length === 0 && members.length > 0
        ? `<p class="empty">Sem despesas ainda.</p>`
        : `<ul class="list">${expenses.map(x => {
            const payers = x.expense_payers.map(p => memberName(p.member_id)).join(", ");
            const nShares = x.expense_shares.length;
            return `<li>
              <div style="flex:1;">
                <div style="font-weight:600;">${esc(x.description)}</div>
                <div class="expense-meta">${fmtDate(x.expense_date)} · pago por ${esc(payers)} · dividido por ${nShares} pessoa${nShares === 1 ? "" : "s"}</div>
              </div>
              <span class="amount">${fmtMoney(toCents(x.amount), group.currency)}</span>
              <button class="secondary small" data-edit="${x.id}">Editar</button>
              <button class="danger small" data-del="${x.id}">✕</button>
            </li>`;
          }).join("")}</ul>`}
    </div>`;

  const slot = $c.querySelector("#expense-form-slot");
  $c.querySelector("#btn-add-expense")?.addEventListener("click", () => {
    renderExpenseForm(slot, ctx, null);
  });
  $c.querySelectorAll("[data-edit]").forEach(b => {
    b.onclick = () => {
      const x = expenses.find(e => e.id === b.dataset.edit);
      renderExpenseForm(slot, ctx, x);
      slot.scrollIntoView({ behavior: "smooth", block: "center" });
    };
  });
  $c.querySelectorAll("[data-del]").forEach(b => {
    b.onclick = async () => {
      if (!confirm("Apagar esta despesa?")) return;
      const { error } = await sb.from("expenses").delete().eq("id", b.dataset.del);
      if (error) return toast(error.message, true);
      toast("Despesa apagada");
      route();
    };
  });
}

// Formulário de despesa (nova ou edição), com defaults do grupo
function renderExpenseForm(slot, ctx, existing) {
  const { group, members } = ctx;

  // estado inicial: defaults do grupo ou valores da despesa em edição
  const defaultPayers = members.filter(m => m.is_default_payer).map(m => m.id);
  const myMember = members.find(m => m.user_id === session.user.id);
  const initPayers = existing
    ? existing.expense_payers.map(p => p.member_id)
    : (defaultPayers.length ? defaultPayers : (myMember ? [myMember.id] : [members[0].id]));

  const initPayerAmounts = {};
  if (existing) existing.expense_payers.forEach(p => { initPayerAmounts[p.member_id] = toCents(p.amount); });

  const initShares = {};
  if (existing) existing.expense_shares.forEach(s => { initShares[s.member_id] = toCents(s.amount); });

  const state = {
    mode: existing ? "exact" : "weights", // equal | weights | exact
    totalCents: existing ? toCents(existing.amount) : 0,
    payers: new Set(initPayers),
    payerAmounts: { ...initPayerAmounts },
    participants: new Set(existing
      ? existing.expense_shares.map(s => s.member_id)
      : members.filter(m => Number(m.default_weight) > 0).map(m => m.id)),
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

    slot.innerHTML = `
    <div class="card" style="background:var(--bg);">
      <h2>${existing ? "Editar despesa" : "Nova despesa"}</h2>
      <div class="row">
        <div class="field" style="flex:3;">
          <label>Descrição</label>
          <input id="x-desc" value="${esc(existing?.description || "")}" placeholder="Ex.: Jantar no restaurante" />
        </div>
        <div class="field">
          <label>Valor (${esc(group.currency)})</label>
          <input id="x-amount" type="number" step="0.01" min="0" value="${state.totalCents ? (state.totalCents / 100).toFixed(2) : ""}" />
        </div>
        <div class="field">
          <label>Data</label>
          <input id="x-date" type="date" value="${esc(existing?.expense_date || new Date().toISOString().slice(0, 10))}" />
        </div>
      </div>

      <h2 style="margin-top:.6rem;">Quem pagou ${okPaid ? "✅" : `<span class="muted">(${fmtMoney(paidSum, group.currency)} de ${fmtMoney(state.totalCents, group.currency)})</span>`}</h2>
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
      <button class="secondary small" id="x-dist-payers" style="margin-top:.4rem;">Distribuir igualmente pelos pagadores</button>

      <h2 style="margin-top:1rem;">Como se divide ${okShare ? "✅" : `<span class="muted">(${fmtMoney(shareSum, group.currency)} de ${fmtMoney(state.totalCents, group.currency)})</span>`}</h2>
      <div class="tabs" style="margin-bottom:.6rem;">
        <button data-mode="equal" class="${state.mode === "equal" ? "active" : ""}">Partes iguais</button>
        <button data-mode="weights" class="${state.mode === "weights" ? "active" : ""}">Proporção (default do grupo)</button>
        <button data-mode="exact" class="${state.mode === "exact" ? "active" : ""}">Valores exatos</button>
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
            <td style="text-align:right;" class="amount">${inShare ? fmtMoney(shares[m.id] || 0, group.currency) : "—"}</td>
          </tr>`;
        }).join("")}
      </table>

      <div style="margin-top:1rem;display:flex;gap:.6rem;">
        <button id="x-save">${existing ? "Guardar alterações" : "Adicionar despesa"}</button>
        <button class="secondary" id="x-cancel">Cancelar</button>
      </div>
    </div>`;

    // ---- listeners
    slot.querySelector("#x-amount").onchange = (e) => {
      state.totalCents = toCents(e.target.value);
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
    slot.querySelector("#x-dist-payers").onclick = () => { distributePayersEqually(); draw(); };

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

    slot.querySelector("#x-cancel").onclick = () => { slot.innerHTML = ""; };

    slot.querySelector("#x-save").onclick = async () => {
      const desc = slot.querySelector("#x-desc").value.trim();
      const date = slot.querySelector("#x-date").value;
      const shares2 = computedShares();
      const paidSum2 = [...state.payers].reduce((a, id) => a + (state.payerAmounts[id] || 0), 0);
      const shareSum2 = Object.values(shares2).reduce((a, b) => a + b, 0);

      if (!desc) return toast("Falta a descrição", true);
      if (state.totalCents <= 0) return toast("O valor tem de ser maior que zero", true);
      if (state.payers.size === 0) return toast("Escolhe quem pagou", true);
      if (paidSum2 !== state.totalCents) return toast("Os valores pagos não somam o total", true);
      if (Object.keys(shares2).length === 0) return toast("Escolhe por quem se divide", true);
      if (shareSum2 !== state.totalCents) return toast("A divisão não soma o total", true);

      const payload = {
        group_id: group.id,
        description: desc,
        amount: (state.totalCents / 100).toFixed(2),
        expense_date: date || new Date().toISOString().slice(0, 10),
      };

      let expenseId = existing?.id;
      if (existing) {
        const { error } = await sb.from("expenses").update(payload).eq("id", existing.id);
        if (error) return toast(error.message, true);
        const d1 = await sb.from("expense_payers").delete().eq("expense_id", existing.id);
        const d2 = await sb.from("expense_shares").delete().eq("expense_id", existing.id);
        if (d1.error || d2.error) return toast((d1.error || d2.error).message, true);
      } else {
        const { data, error } = await sb.from("expenses").insert(payload).select().single();
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
      route();
    };
  }

  draw();
}

// ------------------------------------------------ tab: saldos
function renderBalancesTab($c, ctx) {
  const { group, members, expenses } = ctx;

  const balance = Object.fromEntries(members.map(m => [m.id, 0])); // cêntimos: + recebe, - deve
  for (const x of expenses) {
    for (const p of x.expense_payers) if (p.member_id in balance) balance[p.member_id] += toCents(p.amount);
    for (const s of x.expense_shares) if (s.member_id in balance) balance[s.member_id] -= toCents(s.amount);
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

  const total = expenses.reduce((a, x) => a + toCents(x.amount), 0);

  $c.innerHTML = `
    <div class="card">
      <h2>Saldos <span class="muted" style="font-weight:400;">· total gasto: ${fmtMoney(total, group.currency)}</span></h2>
      ${members.length === 0 ? `<p class="empty">Sem membros.</p>` : `
      <ul class="list">
        ${members.map(m => {
          const b = balance[m.id];
          return `<li>
            <span>${esc(m.name)}</span>
            <span class="amount ${b > 0 ? "positive" : b < 0 ? "negative" : ""}">
              ${b === 0 ? "✔ em dia" : (b > 0 ? "recebe " : "deve ") + fmtMoney(Math.abs(b), group.currency)}
            </span>
          </li>`;
        }).join("")}
      </ul>`}
    </div>
    <div class="card">
      <h2>Como acertar contas</h2>
      ${settlements.length === 0
        ? `<p class="empty">Está tudo em dia 🎉</p>`
        : settlements.map(s => `
          <div class="settle-line">
            <strong>${esc(s.from.name)}</strong>
            <span class="settle-arrow">paga →</span>
            <strong>${esc(s.to.name)}</strong>
            <span class="amount" style="margin-left:auto;">${fmtMoney(s.cents, group.currency)}</span>
          </div>`).join("")}
    </div>`;
}

// ------------------------------------------------ tab: membros
function renderMembersTab($c, ctx) {
  const { members } = ctx;

  $c.innerHTML = `
    <div class="card">
      <h2>Membros</h2>
      <p class="muted">O <strong>peso</strong> define a proporção default na divisão das despesas
      (0 = não entra por defeito). O <strong>pagador default</strong> fica pré-selecionado nas novas despesas.
      Se indicares um email, a pessoa fica ligada à conta dela quando entrar com Google.</p>
      ${members.length === 0 ? `<p class="empty">Ainda sem membros.</p>` : `
      <table class="split-table">
        <tr><th>Nome</th><th>Peso</th><th>Pagador default</th><th></th></tr>
        ${members.map(m => `
          <tr>
            <td>
              ${esc(m.name)}
              ${m.user_id ? `<span class="badge linked">conta ligada</span>` : m.email ? `<span class="badge">convite: ${esc(m.email)}</span>` : ""}
            </td>
            <td><input type="number" step="0.1" min="0" data-mw="${m.id}" value="${m.default_weight}" style="max-width:90px;" /></td>
            <td style="text-align:center;"><input type="checkbox" data-mp="${m.id}" ${m.is_default_payer ? "checked" : ""} /></td>
            <td style="text-align:right;"><button class="danger small" data-mdel="${m.id}">✕</button></td>
          </tr>`).join("")}
      </table>`}
    </div>
    <div class="card">
      <h2>Adicionar pessoa</h2>
      <form id="new-member">
        <div class="row">
          <div class="field"><label>Nome</label><input name="name" required placeholder="Ex.: Maria" /></div>
          <div class="field"><label>Email (opcional, para ligar à conta)</label><input name="email" type="email" placeholder="maria@gmail.com" /></div>
          <div class="field" style="max-width:110px;"><label>Peso</label><input name="weight" type="number" step="0.1" min="0" value="1" /></div>
        </div>
        <button type="submit">Adicionar</button>
      </form>
    </div>`;

  $c.querySelectorAll("[data-mw]").forEach(inp => {
    inp.onchange = async () => {
      const { error } = await sb.from("group_members")
        .update({ default_weight: parseFloat(inp.value) || 0 })
        .eq("id", inp.dataset.mw);
      error ? toast(error.message, true) : toast("Peso atualizado");
    };
  });
  $c.querySelectorAll("[data-mp]").forEach(cb => {
    cb.onchange = async () => {
      const { error } = await sb.from("group_members")
        .update({ is_default_payer: cb.checked })
        .eq("id", cb.dataset.mp);
      error ? toast(error.message, true) : toast("Default atualizado");
    };
  });
  $c.querySelectorAll("[data-mdel]").forEach(b => {
    b.onclick = async () => {
      if (!confirm("Remover esta pessoa? As despesas em que participa perdem essa linha.")) return;
      const { error } = await sb.from("group_members").delete().eq("id", b.dataset.mdel);
      if (error) return toast(error.message, true);
      toast("Pessoa removida");
      route();
    };
  });

  document.getElementById("new-member").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { error } = await sb.from("group_members").insert({
      group_id: ctx.group.id,
      name: f.get("name").trim(),
      email: f.get("email").trim() || null,
      default_weight: parseFloat(f.get("weight")) || 0,
    });
    if (error) return toast(error.message, true);
    toast("Pessoa adicionada");
    route();
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
        ${isOwner ? `<button type="submit">Guardar</button>` : ""}
      </form>
    </div>
    ${isOwner ? `
    <div class="card">
      <h2>Zona de perigo</h2>
      <button class="danger" id="btn-del-group">Apagar grupo e todas as despesas</button>
    </div>` : ""}`;

  if (!isOwner) return;

  document.getElementById("edit-group").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { error } = await sb.from("groups").update({
      name: f.get("name").trim(),
      description: f.get("description").trim() || null,
      currency: f.get("currency"),
    }).eq("id", group.id);
    if (error) return toast(error.message, true);
    toast("Grupo atualizado");
    route();
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
// várias apps) e liga convites por email se a conta estiver aprovada.
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
