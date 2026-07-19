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

// Pop-up genérico (nova despesa, consulta, série recorrente…). Fecha ao
// gravar/apagar (via refresh -> route), no «Fechar», tocando fora do
// cartão ou com Escape — o retroceder da página fica sempre na lista.
let $modal = null;
function modalKey(e) { if (e.key === "Escape") closeModal(); }
function closeModal() {
  if (!$modal) return;
  $modal.remove();
  $modal = null;
  document.body.classList.remove("modal-open");
  document.removeEventListener("keydown", modalKey);
}
function openModal() {
  closeModal();
  $modal = document.createElement("div");
  $modal.className = "modal-backdrop";
  $modal.innerHTML = `<div class="modal-card"></div>`;
  document.body.appendChild($modal);
  document.body.classList.add("modal-open");
  $modal.addEventListener("click", (e) => { if (e.target === $modal) closeModal(); });
  document.addEventListener("keydown", modalKey);
  return $modal.querySelector(".modal-card");
}
function openRecurringModal(ctx, rec) {
  renderExpenseForm(openModal(), ctx, rec, closeModal, { recurring: true, backLabel: "Fechar" });
}
function openExpenseModal(ctx, x) {
  renderExpenseForm(openModal(), ctx, x, closeModal, { backLabel: "Fechar" });
}

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
  // erros ficam mais tempo no ecrã — há tempo para os ler
  toast._t = setTimeout(() => $toast.classList.add("hidden"), isError ? 7000 : 3500);
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

// Destino do convite por email, escolhido conforme o dispositivo para abrir
// mesmo a app do Gmail (e não só o site). A pessoa entra com a conta Google
// do mesmo email e fica logo ligada ao grupo (e aprovada — ver schema.sql).
// Sendo um site estático sem servidor, o envio é sempre com um clique: não
// dá para enviar sozinho sem backend.
//   • iOS      -> esquema googlegmail:// (abre a app do Gmail)
//   • Android  -> mailto: (abre a app de email pré-definida — Gmail, se for)
//   • Desktop  -> compose do Gmail no browser, em separador novo
// Devolve { href, blank } (blank = abrir em separador novo).
function inviteTarget(member, group) {
  const url = appBaseUrl();
  const to = member.email;
  const subject = `Convite para o SplitWisely — ${group.name}`;
  const body =
`Olá!

Adicionei-te ao grupo «${group.name}» no SplitWisely para acertarmos as contas partilhadas.

Entra aqui com a tua conta Google (usa este mesmo email: ${to}):
${url}

Assim que entrares, ficas logo ligado ao grupo. Até já!`;
  const q = encodeURIComponent;
  const ua = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS
  const isAndroid = /Android/.test(ua);
  if (isIOS)
    return { href: `googlegmail:///co?to=${q(to)}&subject=${q(subject)}&body=${q(body)}`, blank: false };
  if (isAndroid)
    return { href: `mailto:${q(to)}?subject=${q(subject)}&body=${q(body)}`, blank: false };
  return {
    href: `https://mail.google.com/mail/?view=cm&fs=1&to=${q(to)}&su=${q(subject)}&body=${q(body)}`,
    blank: true,
  };
}

// Bloco HTML do botão de convite — só quando o membro tem email e ainda não
// tem conta ligada.
function inviteBlockHtml(member, group) {
  if (member.user_id || !member.email) return "";
  const { href, blank } = inviteTarget(member, group);
  const tgt = blank ? ` target="_blank" rel="noopener"` : "";
  return `
    <a class="btn invite" id="m-invite" href="${esc(href)}"${tgt}>✉️ Convidar por Gmail</a>
    <p class="muted" style="margin:.35rem 0 .8rem;">Abre o Gmail já preenchido com o link. A pessoa
      entra com a conta Google deste email e fica logo ligada ao grupo. Se acabaste de mudar o email,
      grava primeiro.</p>`;
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

// Parte exata (cêntimos fracionários) de cada participante numa despesa.
// Os cêntimos gravados em expense_shares incluem o acerto do maior resto,
// que calha sempre aos mesmos membros; se os saldos somassem esses valores,
// a diferença acumulava despesa após despesa. Nas divisões 'equal'/'weights'
// recalcula-se a fração exata a partir do total ('weights' usa os valores
// gravados como pesos); 'exact' — e despesas de schemas antigos sem
// split_mode — mantém os valores gravados, que são intencionais.
function exactShareCents(x) {
  const shares = x.expense_shares || [];
  const total = toCents(x.amount);
  const out = new Map();

  // divisão por categoria: a parte exata de cada pessoa é a SOMA, por cada
  // categoria em que participa, de (valor da categoria ÷ nº de participantes).
  // Recalcula-se a fração (não se usam os cêntimos gravados, já arredondados
  // por categoria) para o resto do arredondamento não recair sempre nos
  // mesmos e os saldos não desviarem — como em 'equal'/'weights'.
  const catShares = x.expense_category_shares || [];
  const cats = x.expense_categories || [];
  if (catShares.length && cats.length) {
    const catTotal = new Map(cats.map(c => [c.category, toCents(c.amount)]));
    const partsByCat = new Map();
    for (const r of catShares) {
      if (!partsByCat.has(r.category)) partsByCat.set(r.category, []);
      partsByCat.get(r.category).push(r.member_id);
    }
    for (const [cat, ids] of partsByCat) {
      const amt = catTotal.get(cat);
      if (amt == null || ids.length === 0) continue;
      const each = amt / ids.length;
      for (const id of ids) out.set(id, (out.get(id) || 0) + each);
    }
    if (out.size) return out;
  }

  if ((x.split_mode === "equal" || x.split_mode === "weights") && total > 0) {
    const ws = shares.map(s => x.split_mode === "equal" ? 1 : toCents(s.amount));
    const sum = ws.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      shares.forEach((s, i) => out.set(s.member_id, total * ws[i] / sum));
      return out;
    }
  }
  for (const s of shares) out.set(s.member_id, toCents(s.amount));
  return out;
}

// Arredonda um mapa id -> cêntimos fracionários para inteiros preservando a
// soma (maior resto), para que saldos e quotas continuem a bater certo.
function roundPreservingSum(vals) {
  const ids = [...vals.keys()];
  if (ids.length === 0) return new Map();
  const raw = ids.map(id => vals.get(id));
  const target = Math.round(raw.reduce((a, b) => a + b, 0));
  const base = raw.map(v => Math.floor(v + 1e-6));
  let rest = target - base.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - base[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0; k++, rest--) base[order[k % order.length][1]] += 1;
  for (let k = order.length - 1; rest < 0; k = (k || order.length) - 1, rest++) base[order[k][1]] -= 1;
  return new Map(ids.map((id, i) => [id, base[i]]));
}

// Saldos de todos os membros do grupo (id -> cêntimos: + recebe, - deve).
// Pagamentos e acertos entram em cêntimos exatos, as quotas como frações
// exatas, e arredonda-se uma única vez no fim — o desvio fica limitado a
// ±1 cêntimo por membro, em vez de crescer com o número de despesas.
function groupBalancesCents(members, expenses, payments) {
  const bal = new Map(members.map(m => [m.id, 0]));
  const add = (id, v) => { if (bal.has(id)) bal.set(id, bal.get(id) + v); };
  for (const x of expenses) {
    for (const p of x.expense_payers) add(p.member_id, toCents(p.amount));
    for (const [id, v] of exactShareCents(x)) add(id, -v);
  }
  for (const p of payments) {
    add(p.from_member, toCents(p.amount));
    add(p.to_member, -toCents(p.amount));
  }
  return roundPreservingSum(bal);
}

// Sugestões de acerto a partir dos saldos (objeto { memberId: cêntimos }).
// 1.ª passagem: preferências de liquidação (membro «convidado» acerta primeiro
// com o anfitrião — settle_with no membro; só quando um deve e o outro recebe).
// 2.ª passagem: o resto distribui-se pelo algoritmo guloso. Devolve uma lista
// de { from, to, cents } com os membros por objeto.
function settlementsFor(members, balance) {
  const debtors = members.filter(m => balance[m.id] < 0).map(m => ({ m, v: -balance[m.id] }));
  const creditors = members.filter(m => balance[m.id] > 0).map(m => ({ m, v: balance[m.id] }));
  const settlements = [];

  for (const d of debtors) {
    const pref = d.m.settle_with;
    if (!pref || d.v <= 0) continue;
    const c = creditors.find(x => x.m.id === pref && x.v > 0);
    if (!c) continue;
    const pay = Math.min(d.v, c.v);
    settlements.push({ from: d.m, to: c.m, cents: pay });
    d.v -= pay;
    c.v -= pay;
  }

  const dRest = debtors.filter(d => d.v > 0).sort((a, b) => b.v - a.v);
  const cRest = creditors.filter(c => c.v > 0).sort((a, b) => b.v - a.v);
  let di = 0, ci = 0;
  while (di < dRest.length && ci < cRest.length) {
    const pay = Math.min(dRest[di].v, cRest[ci].v);
    if (pay > 0) settlements.push({ from: dRest[di].m, to: cRest[ci].m, cents: pay });
    dRest[di].v -= pay;
    cRest[ci].v -= pay;
    if (dRest[di].v === 0) di++;
    if (cRest[ci].v === 0) ci++;
  }
  return settlements;
}

// ---------------------------------------------------------------- categorias
// Lista fixa de categorias de despesa, cada uma com um ícone simples.
// Na base de dados grava-se só o id (coluna expenses.category, nullable).
const CATEGORIES = [
  { id: "talho",       label: "Talho",       icon: "🥩" },
  { id: "peixe",       label: "Peixe",       icon: "🐟" },
  { id: "mercearia",   label: "Mercearia",   icon: "🛒" },
  { id: "padaria",     label: "Padaria",     icon: "🥖" },
  { id: "cafe",        label: "Café",        icon: "☕" },
  { id: "restaurante", label: "Restaurante", icon: "🍽️" },
  { id: "entradas",    label: "Entradas",    icon: "🧀" },
  { id: "bebidas",     label: "Bebidas",     icon: "🥤" },
  { id: "sobremesas",  label: "Sobremesas",  icon: "🍰" },
  { id: "teatro",      label: "Teatro",      icon: "🎭" },
  { id: "cinema",      label: "Cinema",      icon: "🎬" },
  { id: "prendas",     label: "Prendas",     icon: "🎁" },
  { id: "filhos",      label: "Filhos",      icon: "🧸" },
  { id: "roupa",       label: "Roupa",       icon: "👕" },
  { id: "bricolage",   label: "Bricolage",   icon: "🔨" },
  { id: "mobiliario",  label: "Mobiliário",  icon: "🛋️" },
  { id: "casa",        label: "Casa",        icon: "🏠" },
  { id: "utensilios",  label: "Utensílios",  icon: "🍴" },
  { id: "limpeza",     label: "Limpeza",     icon: "🧼" },
  { id: "saude",       label: "Saúde",       icon: "💊" },
  { id: "transportes", label: "Transportes", icon: "🚗" },
  { id: "viagens",     label: "Viagens",     icon: "✈️" },
  { id: "animais",     label: "Animais",     icon: "🐾" },
  { id: "outros",      label: "Outros",      icon: "📦" },
];

function catOf(id) { return CATEGORIES.find(c => c.id === id) || null; }

// ---- categorias que se aplicam a um grupo.
// groups.categories (jsonb, nullable) guarda os ids das categorias
// escolhidas nas definições do grupo. null/ausente = todas (default).
// Uma lista vazia também vale como «todas» — evita ficar sem categoria
// nenhuma para escolher se, por engano, se desmarcarem todas.
function groupCatIds(group) {
  const sel = group && Array.isArray(group.categories) ? group.categories : null;
  return sel && sel.length ? sel : null; // null = todas
}
function groupCategories(group) {
  const sel = groupCatIds(group);
  if (!sel) return CATEGORIES;
  const set = new Set(sel);
  return CATEGORIES.filter(c => set.has(c.id)); // preserva a ordem base
}

// Ícone redondo da categoria (ou etiqueta apagada se não tiver categoria)
function catIconHtml(id, extra = "") {
  const c = catOf(id);
  if (!c) return `<span class="cat-ico none ${extra}" title="Sem categoria">🏷️</span>`;
  return `<span class="cat-ico ${extra}" title="${esc(c.label)}">${c.icon}</span>`;
}

// ---- fatura repartida por várias categorias.
// Uma despesa pode alocar partes do valor a categorias diferentes; essas
// linhas vivem em expense_categories (expense_id, category, amount) e a
// coluna expenses.category guarda a principal (a de maior valor), para as
// listas e para schemas antigos. Estas funções devolvem as "partes" de
// uma despesa: as linhas repartidas quando existem (2+), senão uma única
// parte com a categoria da despesa (ou "none") e o valor total.
function expenseCatSplits(x) {
  const rows = Array.isArray(x.expense_categories)
    ? x.expense_categories.filter(r => catOf(r.category)) : [];
  if (rows.length >= 2) return rows.map(r => ({ cat: r.category, cents: toCents(r.amount) }));
  return [{ cat: (x.category && catOf(x.category)) ? x.category : "none", cents: toCents(x.amount) }];
}

// Ícone da despesa nas listas: o da categoria principal, com um contador
// por cima quando a fatura está repartida por várias
function expenseCatIconHtml(x, extra = "") {
  const splits = expenseCatSplits(x).filter(s => s.cat !== "none");
  if (splits.length < 2) return catIconHtml(x.category, extra);
  const prim = catOf(x.category) || catOf(splits[0].cat);
  const labels = splits.map(s => catOf(s.cat).label).join(" + ");
  return `<span class="cat-ico multi ${extra}" title="${esc(labels)}">${prim.icon}<span class="cat-multi-badge">${splits.length}</span></span>`;
}

// ---- sugestão automática de categoria a partir da descrição.
// Três fontes de conhecimento, por ordem de força:
//   1. despesas já categorizadas do grupo (descrição igual ganha logo);
//   2. memória local do que o utilizador foi categorizando (localStorage,
//      atualizada em cada gravação — é aqui que a app "vai aprendendo");
//   3. palavras-chave base por categoria, para acertar logo à primeira.
const CAT_KEYWORDS = {
  talho:       ["talho", "carne", "frango", "bife", "bifes", "porco", "vitela", "novilho", "picanha", "entrecosto", "costeletas", "salsichas", "fiambre"],
  peixe:       ["peixe", "peixaria", "bacalhau", "salmao", "sardinha", "sardinhas", "polvo", "dourada", "douradas", "robalo", "atum", "marisco", "camarao", "carapau", "pescada"],
  mercearia:   ["mercearia", "supermercado", "compras", "continente", "pingo", "lidl", "aldi", "intermarche", "auchan", "mercadona", "minipreco", "froiz"],
  padaria:     ["padaria", "pao", "broa", "bolos", "bolo", "croissants", "pastelaria", "pasteis"],
  cafe:        ["cafe", "cafes", "cafetaria", "galao", "bica", "esplanada", "lanche"],
  restaurante: ["restaurante", "jantar", "almoco", "tasca", "tasquinha", "pizzaria", "pizza", "sushi", "hamburgueres", "hamburguer", "churrasqueira", "churrasco", "marisqueira", "brunch", "petiscos", "francesinha", "takeaway"],
  entradas:    ["entrada", "entradas", "queijo", "queijos", "presunto", "enchidos", "chourico", "azeitonas", "couvert", "tabua", "tapas", "aperitivos", "paté", "pate"],
  bebidas:     ["bebida", "bebidas", "cerveja", "cervejas", "vinho", "vinhos", "sumo", "sumos", "refrigerante", "refrigerantes", "coca", "cola", "garrafeira", "aperitivo", "imperial", "sangria", "gin", "whisky", "vodka", "licor", "champanhe", "espumante"],
  sobremesas:  ["sobremesa", "sobremesas", "gelado", "gelados", "gelataria", "doce", "doces", "tarte", "tartes", "mousse", "pudim", "chocolate", "gomas", "bolachas"],
  teatro:      ["teatro", "peca", "espetaculo", "musical", "concerto", "opera"],
  cinema:      ["cinema", "filme", "filmes", "pipocas"],
  prendas:     ["prenda", "prendas", "presente", "presentes", "oferta", "aniversario", "natal"],
  filhos:      ["filhos", "filho", "filha", "escola", "creche", "infantario", "atl", "explicacoes", "fraldas", "brinquedo", "brinquedos", "bebe", "natacao"],
  roupa:       ["roupa", "roupas", "sapatos", "tenis", "calcas", "camisa", "camisola", "vestido", "casaco", "zara", "primark", "decathlon"],
  bricolage:   ["bricolage", "ferramentas", "ferramenta", "tinta", "tintas", "parafusos", "leroy", "merlin", "aki", "bricomarche", "obras", "reparacao"],
  mobiliario:  ["mobiliario", "movel", "moveis", "sofa", "mesa", "cadeira", "cadeiras", "cama", "colchao", "ikea", "conforama", "estante", "armario"],
  casa:        ["casa", "renda", "condominio", "agua", "luz", "eletricidade", "gas", "internet", "seguro"],
  utensilios:  ["utensilio", "utensilios", "panela", "panelas", "tacho", "tachos", "frigideira", "talher", "talheres", "copo", "copos", "prato", "pratos", "loica", "tupperware", "faca", "facas", "jarra"],
  limpeza:     ["limpeza", "detergente", "detergentes", "lixivia", "amaciador", "esfregona", "vassoura", "balde", "esponja", "esponjas", "panos", "desinfetante", "papel", "higienico"],
  saude:       ["farmacia", "medico", "medica", "consulta", "dentista", "hospital", "analises", "medicamentos", "oculos", "fisioterapia"],
  transportes: ["gasolina", "gasoleo", "combustivel", "portagem", "portagens", "estacionamento", "metro", "comboio", "autocarro", "uber", "bolt", "taxi", "oficina", "pneus", "inspecao", "viagem", "viagens"],
  viagens:     ["ferias", "hotel", "alojamento", "airbnb", "voo", "voos", "aviao", "booking", "praia"],
  animais:     ["veterinario", "racao", "gato", "cao", "animal", "animais"],
};

const CAT_STOPWORDS = new Set(["com", "para", "por", "dos", "das", "uma", "uns", "umas", "que", "nos", "nas", "aos", "the"]);

// minúsculas e sem acentos, para comparar descrições de forma robusta
function catNorm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function catTokens(s) {
  return catNorm(s).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !CAT_STOPWORDS.has(w));
}

// memória de aprendizagem: token da descrição -> contagens por categoria
function catMemKey() { return `splitwisely_catmem_${session.user.id}`; }
function loadCatMem() {
  try {
    const m = JSON.parse(localStorage.getItem(catMemKey()));
    return m && typeof m === "object" ? m : {};
  } catch (_) { return {}; }
}

// chamada quando uma despesa é gravada com categoria: reforça a associação
// entre as palavras da descrição e a categoria escolhida
function learnCategory(desc, catId) {
  if (!catId || !catOf(catId)) return;
  const mem = loadCatMem();
  for (const t of catTokens(desc)) {
    const votes = (mem[t] ??= {});
    votes[catId] = Math.min((votes[catId] || 0) + 1, 50); // teto evita dominância eterna
  }
  try { localStorage.setItem(catMemKey(), JSON.stringify(mem)); } catch (_) { /* storage cheio */ }
}

function guessCategory(desc, expenses, allowed) {
  const tokens = catTokens(desc);
  if (tokens.length === 0) return null;
  const score = {};
  // allowed (Set de ids) restringe a sugestão às categorias do grupo;
  // sem ele, todas contam
  const add = (cat, pts) => {
    if (catOf(cat) && (!allowed || allowed.has(cat))) score[cat] = (score[cat] || 0) + pts;
  };

  // 1. histórico do grupo (uma descrição repetida decide de imediato)
  const norm = catNorm(desc).trim();
  for (const x of expenses || []) {
    if (!x.category) continue;
    if (catNorm(x.description).trim() === norm) add(x.category, 100);
    else {
      const xt = new Set(catTokens(x.description));
      for (const t of tokens) if (xt.has(t)) add(x.category, 2);
    }
  }
  // 2. memória local aprendida
  const mem = loadCatMem();
  for (const t of tokens) {
    const votes = mem[t];
    if (votes) for (const [cat, n] of Object.entries(votes)) add(cat, Math.min(n, 5));
  }
  // 3. palavras-chave base
  for (const [cat, words] of Object.entries(CAT_KEYWORDS)) {
    for (const t of tokens) if (words.includes(t)) add(cat, 3);
  }

  let best = null, bestScore = 0;
  for (const [cat, s] of Object.entries(score)) if (s > bestScore) { best = cat; bestScore = s; }
  return best;
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
  // nível 2: + divisão por categoria (quem participa em cada);
  // nível 1: + repartição do valor por categoria; nível 0: base
  const expenseSelect = (level) => {
    let sel = "*, expense_payers(member_id, amount), expense_shares(member_id, amount)";
    if (level >= 1) sel += ", expense_categories(category, amount)";
    if (level >= 2) sel += ", expense_category_shares(category, member_id, amount)";
    return sb.from("expenses").select(sel)
      .eq("group_id", groupId)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false });
  };
  let [g, m, e, p, r] = await Promise.all([
    sb.from("groups").select("*").eq("id", groupId).single(),
    sb.from("group_members").select("*").eq("group_id", groupId).order("created_at"),
    expenseSelect(2),
    sb.from("payments").select("*").eq("group_id", groupId)
      .order("payment_date", { ascending: false })
      .order("created_at", { ascending: false }),
    sb.from("recurring_expenses")
      .select("*, recurring_expense_payers(member_id, amount), recurring_expense_shares(member_id, amount)")
      .eq("group_id", groupId)
      .order("created_at"),
  ]);
  // degrada por escalões conforme o schema: sem a tabela da divisão por
  // categoria cai para a repartição só; sem esta, cai para o base
  if (e.error && /expense_category_shares/i.test(e.error.message)) e = await expenseSelect(1);
  if (e.error && /expense_categories/i.test(e.error.message)) e = await expenseSelect(0);
  for (const rr of [g, m, e]) if (rr.error) throw rr.error;
  // payments e recurring podem ainda não existir (schema antigo por atualizar):
  // degrada sem partir a app, só sem essas funcionalidades.
  if (p.error) console.warn("payments indisponível:", p.error.message);
  if (r.error) console.warn("recurring indisponível:", r.error.message);
  return {
    group: g.data, members: m.data, expenses: e.data,
    payments: p.error ? [] : p.data,
    paymentsReady: !p.error,
    recurring: r.error ? [] : r.data,
    recurringReady: !r.error,
  };
}

// ---------------------------------------------------------------- router
function canUse() {
  return !!(profile && (profile.is_approved || profile.is_admin));
}

// Ecrã de arranque (verde, a full-screen). Fica visível enquanto os dados
// carregam e some assim que a primeira vista fica pronta.
function showSplash() { document.getElementById("splash")?.classList.remove("splash-out"); }
function hideSplash() { document.getElementById("splash")?.classList.add("splash-out"); }

async function route() {
  closeModal();
  try {
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
  } finally {
    hideSplash();
  }
}

// ---------------------------------------------------------------- vista: admin
async function renderAdmin() {
  showSplash();
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
  const [m, e0, p] = await Promise.all([
    sb.from("group_members").select("id, group_id, user_id"),
    sb.from("expenses").select("group_id, created_at, amount, split_mode, expense_payers(member_id, amount), expense_shares(member_id, amount)"),
    sb.from("payments").select("group_id, created_at, from_member, to_member, amount"),
  ]);
  // schemas antigos sem a coluna split_mode: repete o pedido sem ela e as
  // despesas caem no modo 'exact' (valores gravados) no apuramento
  const e = e0.error
    ? await sb.from("expenses").select("group_id, created_at, amount, expense_payers(member_id, amount), expense_shares(member_id, amount)")
    : e0;
  if (m.error || e.error) return { balances: {}, activity: {} };
  const pays = p.error ? [] : p.data;

  const activity = {};
  const bump = (gid, ts) => {
    const t = Date.parse(ts) || 0;
    if (t > (activity[gid] || 0)) activity[gid] = t;
  };
  for (const x of e.data) bump(x.group_id, x.created_at);
  for (const pay of pays) bump(pay.group_id, pay.created_at);

  // o arredondamento final dos saldos precisa do grupo completo, por isso
  // agrupa-se tudo por grupo e tira-se depois o saldo do próprio
  const byGroup = (rows) => {
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r.group_id)) out.set(r.group_id, []);
      out.get(r.group_id).push(r);
    }
    return out;
  };
  const gMembers = byGroup(m.data);
  const gExpenses = byGroup(e.data);
  const gPayments = byGroup(pays);

  const balances = {};
  for (const mem of m.data) {
    if (mem.user_id !== uid) continue;
    const gid = mem.group_id;
    balances[gid] = groupBalancesCents(
      gMembers.get(gid) || [], gExpenses.get(gid) || [], gPayments.get(gid) || []
    ).get(mem.id) ?? 0;
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
  showSplash();
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
      showSplash();
      $app.innerHTML = `<div class="loading">A carregar grupo…</div>`;
    }
    bundle = await fetchGroupBundle(groupId);
    groupCache = { id: groupId, data: bundle };
  }
  const { group, members, expenses, payments, paymentsReady, recurring, recurringReady } = bundle;
  const isOwner = group.created_by === session.user.id;

  // o saldo atual do utilizador vive aqui, alinhado com o título do grupo
  const myMember = members.find(m => m.user_id === session.user.id);
  const myBal = myMember ? (groupBalancesCents(members, expenses, payments).get(myMember.id) ?? 0) : null;
  const headBalance = myBal === null ? "" : `
        <div class="head-balance">
          <span class="head-balance-label">O teu saldo</span>
          <span class="chip ${myBal > 0 ? "positive" : myBal < 0 ? "negative" : "zero"}">
            ${myBal === 0 ? "✓ em dia" : (myBal > 0 ? "+" : "−") + fmtMoney(Math.abs(myBal), group.currency)}
          </span>
        </div>`;

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
        ${headBalance}
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

  const ctx = { group, members, expenses, payments, paymentsReady, recurring, recurringReady, isOwner };
  const $c = document.getElementById("tab-content");
  if (tab === "despesas") renderExpensesTab($c, ctx);
  else if (tab === "saldos") renderBalancesTab($c, ctx);
  else renderSettingsTab($c, ctx);
}

// ------------------------------------------------ tab: despesas
function renderExpensesTab($c, ctx) {
  const { group, members, expenses } = ctx;
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

  // linhas agrupadas por mês; a data fica num bloco compacto à esquerda
  const monthLabel = (d) =>
    new Date(d + "T00:00:00").toLocaleDateString("pt-PT", { month: "long", year: "numeric" });
  const dateBlock = (d) => {
    const dt = new Date(d + "T00:00:00");
    return `<span class="date-block"><span class="d">${dt.getDate()}</span>
      <span class="m">${dt.toLocaleDateString("pt-PT", { month: "short" }).replace(".", "")}</span></span>`;
  };

  // filtros da lista: categoria (chips), texto e intervalo de datas.
  // Os totais dos chips são calculados sobre o recorte de texto/datas,
  // por isso mostram quanto foi em cada categoria nesse recorte.
  const catKey = (x) => (x.category && catOf(x.category)) ? x.category : "none";
  const hasCats = expenses.some(x => catKey(x) !== "none");
  const filter = { cat: null, q: "", from: "", to: "" };
  const searching = () => !!(filter.q.trim() || filter.from || filter.to);
  const matches = (x) =>
    (!filter.q.trim() || catNorm(x.description).includes(catNorm(filter.q.trim())))
    && (!filter.from || x.expense_date >= filter.from)
    && (!filter.to || x.expense_date <= filter.to);

  // o shell (filtros) desenha-se uma única vez — só a lista, os chips de
  // categoria e a linha de resultados voltam a desenhar-se, para o input
  // não perder o foco. Pesquisa, datas e categorias vivem num cartão
  // próprio; a lista noutro; a despesa nova/consulta abre em pop-up (FAB).
  $c.innerHTML = `
    ${members.length === 0
      ? `<div class="card"><p class="empty">Adiciona primeiro membros no separador «Definições».</p></div>` : ""}
    ${expenses.length === 0 ? "" : `
    <div class="card" id="expense-filters">
      <div class="filter-bar">
        <div class="search-box">
          <span class="search-ico">🔍</span>
          <input id="f-q" type="search" placeholder="Pesquisar por descrição…" autocomplete="off" />
        </div>
        <button type="button" class="secondary date-toggle" id="f-dates-btn"
          title="Filtrar por intervalo de datas">📅</button>
      </div>
      <div class="date-range hidden" id="f-dates">
        <div class="field"><label>De</label><input type="date" id="f-from" /></div>
        <div class="field"><label>Até</label><input type="date" id="f-to" /></div>
        <button type="button" class="secondary small" id="f-clear">Limpar</button>
      </div>
      ${hasCats ? `<div class="cat-strip in-filters" id="cat-strip"></div>` : ""}
      <p class="filter-result hidden" id="f-result"></p>
    </div>`}
    ${members.length === 0 && expenses.length === 0 ? "" : `
    <div class="card">
      <div id="expense-list"></div>
    </div>`}
    <button class="fab" id="btn-add-expense" title="Nova despesa"
      ${members.length === 0 ? "disabled" : ""}>+</button>`;

  const $list = $c.querySelector("#expense-list");
  const $result = $c.querySelector("#f-result");
  const $catStrip = $c.querySelector("#cat-strip");

  function drawList() {
    if (!$list) return; // grupo ainda sem membros nem despesas
    const base = expenses.filter(matches);

    // chips de categoria (com o total de cada uma dentro do recorte atual)
    // — uma fatura repartida conta cada parte na sua categoria
    if ($catStrip) {
      const catTotals = new Map();
      for (const x of base) for (const s of expenseCatSplits(x))
        catTotals.set(s.cat, (catTotals.get(s.cat) || 0) + s.cents);
      // a categoria filtrada nunca desaparece da fila, mesmo a zeros —
      // senão não havia forma de a desligar
      if (filter.cat && !catTotals.has(filter.cat)) catTotals.set(filter.cat, 0);
      // o total de cada categoria não vai no chip — aparece na linha de
      // resultados (#f-result) por baixo assim que se toca no chip
      const catChip = ([id]) => {
        const c = id === "none" ? { icon: "🏷️", label: "Sem categoria" } : catOf(id);
        return `<button type="button" class="cat-chip ${filter.cat === id ? "active" : ""}" data-catfilter="${id}">
          ${c.icon}<span>${esc(c.label)}</span></button>`;
      };
      $catStrip.innerHTML = [...catTotals.entries()].sort((a, b) => b[1] - a[1]).map(catChip).join("");
      $catStrip.querySelectorAll("[data-catfilter]").forEach(b => {
        b.onclick = () => {
          filter.cat = filter.cat === b.dataset.catfilter ? null : b.dataset.catfilter;
          drawList();
        };
      });
    }

    // com filtro de categoria, uma fatura repartida aparece se tiver essa
    // parte — e no total só conta o valor alocado a essa categoria
    const shown = filter.cat
      ? base.filter(x => expenseCatSplits(x).some(s => s.cat === filter.cat)) : base;
    const filtered = !!filter.cat || searching();
    const totalShown = shown.reduce((a, x) => a + (filter.cat
      ? expenseCatSplits(x).filter(s => s.cat === filter.cat).reduce((s2, s) => s2 + s.cents, 0)
      : toCents(x.amount)), 0);
    // com filtros ativos, o cartão dos filtros mostra o que está à vista
    if ($result) {
      $result.classList.toggle("hidden", !filtered);
      if (filtered) $result.textContent =
        `${shown.length} despesa${shown.length === 1 ? "" : "s"} · ${fmtMoney(totalShown, cur)}`;
    }

    let lastMonth = null;
    const rows = shown.map(x => {
      const payers = x.expense_payers.map(p => memberName(p.member_id)).join(", ");
      const nShares = x.expense_shares.length;
      const m = monthLabel(x.expense_date);
      const head = m !== lastMonth ? `<li class="month-head">${esc(m)}</li>` : "";
      lastMonth = m;
      // fatura repartida: linha miudinha com cada categoria e o seu valor
      const catSplits = expenseCatSplits(x).filter(s => s.cat !== "none");
      const catLine = catSplits.length >= 2
        ? `<span class="item-cats">${catSplits.map(s =>
            `<span class="item-cat">${catOf(s.cat).icon} ${fmtMoney(s.cents, cur)}</span>`).join("")}</span>`
        : "";
      return `${head}
        <li class="clickable" data-open="${x.id}">
          ${dateBlock(x.expense_date)}
          ${expenseCatIconHtml(x)}
          <div class="item-main">
            <span class="item-title">${esc(x.description)}${x.recurring_id ? ` <span class="badge linked" title="Despesa recorrente">🔁</span>` : ""}</span>
            <span class="item-sub">pago por ${esc(payers)} · ${nShares} pessoa${nShares === 1 ? "" : "s"}</span>
            ${catLine}
          </div>
          <div class="item-end">
            <span class="amount">${fmtMoney(toCents(x.amount), cur)}</span>
            ${myImpact(x)}
          </div>
          <span class="chevron">›</span>
        </li>`;
    }).join("");

    $list.innerHTML = shown.length === 0 && members.length > 0
      ? `<p class="empty">${filtered ? "Nenhuma despesa encontrada com estes filtros." : "Sem despesas ainda."}</p>`
      : `<ul class="list">${rows}</ul>`;

    // consulta da despesa em pop-up — fechar devolve à lista tal como estava
    $list.querySelectorAll("[data-open]").forEach(li => {
      li.onclick = () => openExpenseModal(ctx, expenses.find(e => e.id === li.dataset.open));
    });
  }

  $c.querySelector("#btn-add-expense").onclick = () => openExpenseModal(ctx, null);

  // pesquisa por descrição e intervalo de datas (o cartão dos filtros só
  // existe quando há despesas)
  const $q = $c.querySelector("#f-q");
  if ($q) {
    const $from = $c.querySelector("#f-from");
    const $to = $c.querySelector("#f-to");
    const $datesBtn = $c.querySelector("#f-dates-btn");
    const $dates = $c.querySelector("#f-dates");
    // o botão 📅 fica realçado enquanto houver datas aplicadas, mesmo com o
    // painel fechado — para o filtro nunca ficar "escondido" sem se notar
    const syncDatesBtn = () => $datesBtn.classList.toggle("active", !!(filter.from || filter.to));
    $q.oninput = () => { filter.q = $q.value; drawList(); };
    $from.onchange = () => { filter.from = $from.value; syncDatesBtn(); drawList(); };
    $to.onchange = () => { filter.to = $to.value; syncDatesBtn(); drawList(); };
    $datesBtn.onclick = () => $dates.classList.toggle("hidden");
    $c.querySelector("#f-clear").onclick = () => {
      filter.from = filter.to = "";
      $from.value = "";
      $to.value = "";
      syncDatesBtn();
      drawList();
    };
  }

  drawList();
}

// Formulário de despesa (nova ou edição), com defaults do grupo.
// Dividido em secções (Dados / Quem pagou / Divisão) para não ficar
// um formulário interminável no telemóvel. `onClose` devolve à lista.
function renderExpenseForm(slot, ctx, existing, onClose, opts = {}) {
  const { group, members } = ctx;
  // isRecurringRecord: o registo aberto é um molde recorrente (vs despesa
  // normal) — fixa de que tabelas se lê o `existing`. O TIPO em si (ocasional/
  // recorrente) é escolhido no formulário e vive em state.recurring; só é
  // editável ao criar (uma despesa não se converte em molde e vice-versa).
  const isRecurringRecord = !!opts.recurring;
  // isOccurrence: despesa normal já lançada por um molde recorrente (tem
  // recurring_id). Não é o molde — é uma ocorrência de um certo mês. Já é
  // recorrente, logo não se «converte» outra vez nem mostra o seletor.
  const isOccurrence = !!existing && !isRecurringRecord && !!existing.recurring_id;
  // o molde a que a ocorrência pertence, para o atalho «gerir série»
  const parentRec = isOccurrence ? (ctx.recurring || []).find(r => r.id === existing.recurring_id) : null;
  // ao editar uma despesa ocasional (SEM molde) e ligar «Recorrente»,
  // estamos a convertê-la; uma ocorrência já ligada nunca converte.
  const converting = !!existing && !isRecurringRecord && !existing.recurring_id;
  const today = new Date().toISOString().slice(0, 10);
  const close = onClose || (() => { slot.innerHTML = ""; });
  const useWeights = !!group.use_weights; // opção do grupo: divisão por proporções

  // pagadores/quotas do registo existente — vêm das tabelas próprias do molde
  // quando é recorrente, das da despesa quando é normal
  const exPayers = existing ? (isRecurringRecord ? existing.recurring_expense_payers : existing.expense_payers) : [];
  const exShares = existing ? (isRecurringRecord ? existing.recurring_expense_shares : existing.expense_shares) : [];

  // estado inicial: quem insere a despesa é o pagador pré-selecionado
  const myMember = members.find(m => m.user_id === session.user.id);
  const initPayers = existing
    ? exPayers.map(p => p.member_id)
    : [myMember ? myMember.id : members[0].id];

  const initPayerAmounts = {};
  if (existing) exPayers.forEach(p => { initPayerAmounts[p.member_id] = toCents(p.amount); });

  const initShares = {};
  if (existing) exShares.forEach(s => { initShares[s.member_id] = toCents(s.amount); });

  // ao reabrir uma despesa, volta ao modo em que foi gravada (split_mode);
  // despesas de schemas antigos sem a coluna caem no modo "exatos", o
  // único sempre fiel aos valores gravados
  const initMode = existing
    ? (existing.split_mode === "weights" && !useWeights ? "exact" : (existing.split_mode || "exact"))
    : (useWeights ? "weights" : "equal");

  // fatura repartida por categorias: linhas gravadas em expense_categories
  // (só nas despesas normais; os moldes recorrentes têm uma categoria só)
  const exCats = (existing && !isRecurringRecord && Array.isArray(existing.expense_categories))
    ? existing.expense_categories.filter(r => catOf(r.category)) : [];
  const catSplitInit = exCats.length >= 2
    ? Object.fromEntries(exCats.map(r => [r.category, toCents(r.amount)])) : null;

  const initParticipants = existing
    ? exShares.map(s => s.member_id)
    : useWeights
      ? members.filter(m => Number(m.default_weight) > 0).map(m => m.id)
      : members.map(m => m.id);

  // divisão do custo por categoria: quem participa em cada uma (partes
  // iguais dentro da categoria). Vem de expense_category_shares quando
  // existe; a sua presença é que liga o modo "dividir por categoria".
  const exCatShares = (existing && !isRecurringRecord && Array.isArray(existing.expense_category_shares))
    ? existing.expense_category_shares.filter(r => catOf(r.category)) : [];
  const initCatParts = {};
  if (catSplitInit) {
    const byCat = {};
    for (const r of exCatShares) (byCat[r.category] ??= []).push(r.member_id);
    for (const cat of Object.keys(catSplitInit)) {
      initCatParts[cat] = new Set(byCat[cat]?.length ? byCat[cat] : initParticipants);
    }
  }

  const state = {
    section: "dados", // dados | pagou | divide
    desc: existing?.description || "",
    date: existing?.expense_date || new Date().toISOString().slice(0, 10),
    category: existing?.category && catOf(existing.category) ? existing.category : null,
    // repartição do valor por categoria ({catId: cêntimos}); null = uma só
    catSplit: catSplitInit,
    // dividir o custo de cada categoria por pessoas diferentes (partes
    // iguais dentro de cada). Só faz sentido com catSplit ativo.
    catDivide: exCatShares.length > 0,
    catParts: initCatParts, // { catId: Set(memberIds) }
    // escolhida à mão? enquanto for false, a sugestão automática (a partir
    // da descrição) pode ir atualizando a categoria à medida que se escreve
    catManual: !!(existing && (existing.category || exCats.length)),
    catAuto: false,
    mode: initMode, // equal | weights | exact
    totalCents: existing ? toCents(existing.amount) : 0,
    payers: new Set(initPayers),
    payerAmounts: { ...initPayerAmounts },
    participants: new Set(initParticipants),
    weights: Object.fromEntries(members.map(m => [m.id, Number(m.default_weight) || 0])),
    exact: { ...initShares },
    // tipo escolhido no formulário (ocasional vs recorrente)
    recurring: isRecurringRecord,
    // campos do molde recorrente (só usados quando state.recurring)
    // ao converter uma despesa, o dia default é o dia da própria despesa
    dayOfMonth: existing && isRecurringRecord ? existing.day_of_month
      : (existing ? new Date(existing.expense_date + "T00:00:00").getDate() : new Date().getDate()),
    startDate: existing && isRecurringRecord ? existing.start_date : today,
    endDate: existing && isRecurringRecord ? (existing.end_date || "") : "",
    active: existing && isRecurringRecord ? !!existing.active : true,
  };

  // partes da fatura por categoria com valor > 0 (modo repartido)
  const catEntries = () => state.catSplit
    ? Object.entries(state.catSplit).filter(([, c]) => c > 0) : [];
  // categoria "principal" — a única (modo normal) ou a de maior valor no
  // modo repartido; vai para expenses.category (listas e schemas antigos)
  const primaryCategory = () => {
    if (!state.catSplit) return state.category;
    const e = catEntries().sort((a, b) => b[1] - a[1]);
    return e.length ? e[0][0] : null;
  };

  // dividir por categoria está ativo? (fatura repartida + opção ligada)
  const catDividing = () => !!(state.catSplit && state.catDivide);

  // divisão do custo de cada categoria por quem participa (partes iguais):
  // devolve { catId: { memberId: cêntimos } }. A soma de cada categoria é
  // exatamente o valor dessa categoria.
  function perCategoryShares() {
    const out = {};
    for (const [cat, cents] of catEntries()) {
      const ids = [...(state.catParts[cat] || [])].filter(id => members.some(m => m.id === id));
      if (ids.length === 0 || cents <= 0) { out[cat] = {}; continue; }
      const parts = splitByWeights(cents, ids.map(() => 1));
      out[cat] = Object.fromEntries(ids.map((id, i) => [id, parts[i]]));
    }
    return out;
  }

  function computedShares() {
    // dividir por categoria: soma, por pessoa, a sua parte em cada categoria
    if (catDividing()) {
      const agg = {};
      const per = perCategoryShares();
      for (const byMem of Object.values(per))
        for (const [id, c] of Object.entries(byMem)) agg[id] = (agg[id] || 0) + c;
      return agg;
    }
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

  // Uma ocorrência de série abre primeiro num ecrã de escolha — o utilizador
  // toma consciência de que é recorrente e decide: gerir a série (pop-up) ou
  // editar só esta ocorrência. Só depois disso o formulário fica editável.
  let occChoiceDone = false;
  function drawOccChoice() {
    slot.innerHTML = `
    <div class="expense-detail">
      <div class="form-head">
        <button class="back-pill" id="x-back"><span class="arr">←</span> ${esc(opts.backLabel || "Despesas")}</button>
        <h2 style="margin:0;">Despesa recorrente</h2>
      </div>
      <div class="rec-banner">
        <span class="rec-ico">🔁</span>
        <div class="rec-banner-text">
          <strong>${esc(existing.description)} · ${fmtMoney(toCents(existing.amount), group.currency)}</strong>
          <span>Lançada automaticamente pela série recorrente${parentRec ? ` (todo o mês no dia ${parentRec.day_of_month})` : ""}.</span>
        </div>
      </div>
      <div class="rec-choice">
        ${parentRec ? `
        <button type="button" class="rec-choice-btn" id="x-open-serie">
          <span class="rec-ico">🔁</span>
          <span class="rec-choice-text">
            <strong>Gerir a série</strong>
            <span>Valor, dia do mês, divisão, pausar ou terminar — vale para as próximas ocorrências.</span>
          </span>
          <span class="chevron">›</span>
        </button>` : ""}
        <button type="button" class="rec-choice-btn" id="x-edit-occ">
          <span class="rec-ico">✏️</span>
          <span class="rec-choice-text">
            <strong>Editar só esta ocorrência</strong>
            <span>Muda apenas a despesa de ${esc(fmtDate(existing.expense_date))} — as próximas continuam como estão.</span>
          </span>
          <span class="chevron">›</span>
        </button>
      </div>
    </div>`;
    slot.querySelector("#x-back").onclick = close;
    slot.querySelector("#x-open-serie")?.addEventListener("click", () => openRecurringModal(ctx, parentRec));
    slot.querySelector("#x-edit-occ").onclick = () => { occChoiceDone = true; draw(); };
  }

  function draw() {
    if (isOccurrence && !occChoiceDone) return drawOccChoice();
    const shares = computedShares();
    const paidSum = [...state.payers].reduce((a, id) => a + (state.payerAmounts[id] || 0), 0);
    const shareSum = Object.values(shares).reduce((a, b) => a + b, 0);
    const okPaid = paidSum === state.totalCents && state.totalCents > 0;
    const okShare = shareSum === state.totalCents && state.totalCents > 0;
    const okDados = !!state.desc.trim() && state.totalCents > 0;
    const cur = group.currency;

    const amountField = `
      <div class="field">
        <label>Valor (${esc(cur)})</label>
        <input id="x-amount" type="number" step="0.01" min="0" value="${state.totalCents ? (state.totalCents / 100).toFixed(2) : ""}" />
      </div>`;
    // topo do formulário: como se identifica/escolhe o tipo da despesa.
    //  · molde recorrente (a editar a série)  -> aviso fixo
    //  · ocorrência de uma série              -> aviso + atalho «gerir série»
    //  · despesa ocasional (nova/convertível) -> seletor Ocasional/Recorrente
    let typeHeader;
    if (isRecurringRecord) {
      typeHeader = `
        <div class="rec-banner">
          <span class="rec-ico">🔁</span>
          <div class="rec-banner-text">
            <strong>Despesa recorrente</strong>
            <span>${existing
              ? "Repete-se todos os meses. As alterações valem para as próximas ocorrências."
              : "Vai repetir-se todos os meses e ser lançada automaticamente."}</span>
          </div>
        </div>`;
    } else if (isOccurrence) {
      typeHeader = `
        <div class="rec-banner">
          <span class="rec-ico">✏️</span>
          <div class="rec-banner-text">
            <strong>A editar só esta ocorrência</strong>
            <span>Muda apenas a despesa de ${esc(fmtDate(existing.expense_date))} — a série e as próximas ficam como estão.</span>
          </div>
        </div>`;
    } else if (!existing) {
      // criar de raiz: escolher o tipo à cabeça faz sentido
      typeHeader = `
        <div class="tabs type-toggle" style="margin-bottom:.7rem;">
          <button type="button" data-type="occ" class="${state.recurring ? "" : "active"}">Ocasional</button>
          <button type="button" data-type="rec" class="${state.recurring ? "active" : ""}">Recorrente</button>
        </div>`;
    } else if (state.recurring) {
      // conversão ligada: banner claro do que vai acontecer + cancelar
      typeHeader = `
        <div class="rec-banner">
          <span class="rec-ico">🔁</span>
          <div class="rec-banner-text">
            <strong>A tornar recorrente</strong>
            <span>Passa a repetir-se todos os meses — esta despesa fica como a primeira ocorrência da série.</span>
          </div>
          <button type="button" class="secondary small" id="x-cancel-convert">Cancelar</button>
        </div>`;
    } else {
      // despesa ocasional existente: oferta de conversão como ação explícita
      // (o antigo seletor Ocasional/Recorrente parecia um filtro e confundia)
      typeHeader = `
        <button type="button" class="rec-choice-btn" id="x-convert" style="margin-bottom:.8rem;">
          <span class="rec-ico">🔁</span>
          <span class="rec-choice-text">
            <strong>Tornar recorrente</strong>
            <span>Repetir esta despesa automaticamente todos os meses.</span>
          </span>
          <span class="chevron">›</span>
        </button>`;
    }
    // recorrente: dia do mês + terminar em (>= hoje) + ativa;  ocasional: data
    const scheduleFields = state.recurring ? `
      <div class="row">
        ${amountField}
        <div class="field">
          <label>Dia do mês</label>
          <input id="x-dom" type="number" min="1" max="31" value="${state.dayOfMonth}" />
        </div>
      </div>
      <div class="row">
        <div class="field"><label>Terminar em (opcional)</label>
          <input id="x-end" type="date" min="${today}" value="${esc(state.endDate)}" /></div>
        <label class="check-line" style="flex:1;align-items:center;">
          <input type="checkbox" id="x-active" ${state.active ? "checked" : ""} /> Ativa
        </label>
      </div>
      <p class="check-note" style="margin-top:-.3rem;">Repete-se todo o mês neste dia (ajustado ao último dia nos meses mais curtos).
        É lançada automaticamente quando alguém abre a app.</p>` : `
      <div class="row">
        ${amountField}
        <div class="field">
          <label>Data</label>
          <input id="x-date" type="date" value="${esc(state.date)}" />
        </div>
      </div>`;

    // categorias a mostrar: as que se aplicam ao grupo (definições). Se a
    // despesa já usa categorias fora dessa lista (grupo restringido depois
    // de gravada), mantêm-se visíveis para não se perderem ao editar.
    const catList = groupCategories(group).slice();
    for (const id of (state.catSplit ? Object.keys(state.catSplit) : (state.category ? [state.category] : []))) {
      if (!catList.some(c => c.id === id)) {
        const extraCat = catOf(id);
        if (extraCat) catList.push(extraCat);
      }
    }
    // chip aceso: a categoria única, ou cada uma das partes da repartição
    const catOn = (id) => state.catSplit ? (id in state.catSplit) : state.category === id;

    // bloco da fatura repartida (por baixo dos chips): um input de valor por
    // categoria escolhida + estado da alocação. Os moldes recorrentes ficam
    // fora disto — têm sempre uma categoria única.
    const catUsed = Object.values(state.catSplit || {}).reduce((a, c) => a + c, 0);
    const catSplitBlock = !state.catSplit
      ? (state.recurring ? "" : `<button type="button" class="link-btn" id="x-cat-multi">Fatura com várias categorias? Reparte o valor</button>`)
      : `
        <div class="cat-split">
          ${catList.filter(c => c.id in state.catSplit).map(c => `
            <div class="cat-split-line">
              <span class="cat-split-name">${c.icon} ${esc(c.label)}</span>
              <input type="number" step="0.01" min="0" data-catamount="${c.id}"
                value="${((state.catSplit[c.id] || 0) / 100).toFixed(2)}" />
            </div>`).join("")}
          ${Object.keys(state.catSplit).length === 0
            ? `<p class="form-status neutral">Toca nas categorias em cima para as juntar à fatura</p>`
            : catUsed === state.totalCents ? ""
            : `<p class="form-status">${fmtMoney(catUsed, cur)} de ${fmtMoney(state.totalCents, cur)} atribuídos</p>`}
          <div class="cat-split-actions">
            <button type="button" class="secondary small" id="x-cat-dist">Distribuir igualmente</button>
            <button type="button" class="secondary small" id="x-cat-single">Voltar a uma só categoria</button>
          </div>
        </div>`;

    const sections = {
      dados: `
        ${typeHeader}
        <div class="field">
          <label>Descrição</label>
          <input id="x-desc" value="${esc(state.desc)}" placeholder="Ex.: Jantar no restaurante" />
        </div>
        ${scheduleFields}
        <div class="field" style="margin-bottom:.3rem;">
          <label>Categoria${state.catSplit ? "s" : ""} <span class="cat-hint" id="x-cat-hint">${state.catAuto && state.category ? "· sugerida automaticamente" : ""}</span></label>
          <div class="cat-row" id="x-cat-row">
            ${catList.map(c => `
              <button type="button" class="cat-chip ${catOn(c.id) ? "active" : ""}" data-cat="${c.id}">
                ${c.icon}<span>${esc(c.label)}</span>
              </button>`).join("")}
          </div>
          ${catSplitBlock}
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
        ${state.catSplit ? `
          <label class="check-line" style="margin-bottom:.7rem;">
            <input type="checkbox" id="x-cat-divide" ${state.catDivide ? "checked" : ""} />
            Dividir cada categoria por pessoas diferentes
            <span class="check-note">cada categoria divide-se em partes iguais por quem participa nela</span>
          </label>` : ""}
        ${catDividing() ? `
          <div class="cat-div-list">
            ${catList.filter(c => c.id in state.catSplit).map(c => {
              const cents = state.catSplit[c.id] || 0;
              const set = state.catParts[c.id] || new Set();
              const n = members.filter(m => set.has(m.id)).length;
              const each = n > 0 ? (cents % n === 0 ? fmtMoney(cents / n, cur) : "≈ " + fmtMoney(Math.round(cents / n), cur)) : "";
              return `<div class="cat-div">
                <div class="cat-div-head">${c.icon} ${esc(c.label)} <span class="cat-div-val">· ${fmtMoney(cents, cur)}</span></div>
                <div class="cat-pick">
                  ${members.map(m => {
                    const on = set.has(m.id);
                    return `<label class="cat-pick-item ${on ? "on" : ""}">
                      <input type="checkbox" data-catpart-cat="${c.id}" data-catpart-mem="${m.id}" ${on ? "checked" : ""} />
                      <span>${esc(m.name)}</span>
                    </label>`;
                  }).join("")}
                </div>
                <div class="cat-div-foot ${n === 0 ? "warn" : ""}">${n === 0
                  ? "Escolhe quem participa nesta categoria"
                  : `${n} pessoa${n === 1 ? "" : "s"} · ${each} cada`}</div>
              </div>`;
            }).join("")}
          </div>` : `
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
          </table>`}`,
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
      if (catDividing()) {
        divTxt = ", dividido por categoria";
      } else if (shareIds.length > 0) {
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
        <button class="back-pill" id="x-back"><span class="arr">←</span> ${esc(opts.backLabel || "Despesas")}</button>
        <h2 style="margin:0;">${!existing ? "Nova despesa"
          : (isRecurringRecord || isOccurrence) ? "Despesa recorrente"
          : "Detalhe da despesa"}</h2>
      </div>
      <div class="tabs form-tabs">
        ${secTab("dados", "Dados", okDados)}
        ${secTab("pagou", "Quem pagou", okPaid)}
        ${secTab("divide", "Divisão", okShare)}
      </div>
      <div class="form-section">${sections[state.section]}</div>
      ${summary}
      <div class="form-actions">
        <button id="x-save">${converting && state.recurring ? "Tornar recorrente"
          : existing ? "Guardar alterações"
          : (state.recurring ? "Criar recorrente" : "Adicionar despesa")}</button>
        ${existing ? `<button class="danger" id="x-del">Apagar</button>` : ""}
      </div>
    </div>`;

    // ---- listeners
    slot.querySelector("#x-back").onclick = close;
    slot.querySelectorAll("[data-sec]").forEach(b => {
      b.onclick = () => { state.section = b.dataset.sec; draw(); };
    });
    slot.querySelectorAll("[data-type]").forEach(b => {
      b.onclick = () => {
        const rec = b.dataset.type === "rec";
        if (rec === state.recurring) return;
        state.recurring = rec;
        draw();
      };
    });
    // conversão de despesa ocasional existente em recorrente (liga/cancela)
    slot.querySelector("#x-convert")?.addEventListener("click", () => {
      state.recurring = true;
      // os moldes recorrentes têm uma categoria única — uma fatura
      // repartida colapsa na categoria principal ao converter
      if (state.catSplit) { state.category = primaryCategory(); state.catSplit = null; }
      draw();
    });
    slot.querySelector("#x-cancel-convert")?.addEventListener("click", () => { state.recurring = false; draw(); });
    const $desc = slot.querySelector("#x-desc");
    if ($desc) $desc.oninput = () => {
      state.desc = $desc.value;
      // sugestão automática de categoria enquanto se escreve — atualiza os
      // chips diretamente (sem draw()) para o input não perder o foco
      if (!state.catManual && !state.catSplit) {
        const allowedIds = groupCatIds(group);
        const g = guessCategory(state.desc, ctx.expenses, allowedIds ? new Set(allowedIds) : null);
        if (g !== state.category) {
          state.category = g;
          state.catAuto = !!g;
          slot.querySelectorAll("[data-cat]").forEach(b =>
            b.classList.toggle("active", b.dataset.cat === g));
          const $hint = slot.querySelector("#x-cat-hint");
          if ($hint) $hint.textContent = g ? "· sugerida automaticamente" : "";
          scrollCatIntoView();
        }
      }
    };
    const $date = slot.querySelector("#x-date");
    if ($date) $date.onchange = () => { state.date = $date.value; };
    const $dom = slot.querySelector("#x-dom");
    if ($dom) $dom.onchange = () => {
      state.dayOfMonth = Math.min(31, Math.max(1, parseInt($dom.value, 10) || 1));
      $dom.value = state.dayOfMonth;
    };
    const $end = slot.querySelector("#x-end");
    if ($end) $end.onchange = () => { state.endDate = $end.value; };
    const $active = slot.querySelector("#x-active");
    if ($active) $active.onchange = () => { state.active = $active.checked; };
    const $amount = slot.querySelector("#x-amount");
    if ($amount) $amount.onchange = () => {
      state.totalCents = toCents($amount.value);
      distributePayersEqually();
      draw();
    };

    // garante que o chip da categoria ativa fica visível na fila com scroll
    function scrollCatIntoView() {
      const active = slot.querySelector("#x-cat-row .cat-chip.active");
      if (active) active.parentElement.scrollLeft = Math.max(0, active.offsetLeft - 12);
    }
    slot.querySelectorAll("[data-cat]").forEach(b => {
      b.onclick = () => {
        const id = b.dataset.cat;
        if (state.catSplit) {
          // modo repartido: o chip junta/tira a categoria da fatura; ao
          // juntar, leva logo o valor que falta atribuir
          if (id in state.catSplit) { delete state.catSplit[id]; delete state.catParts[id]; }
          else {
            const used = Object.values(state.catSplit).reduce((a, c) => a + c, 0);
            state.catSplit[id] = Math.max(state.totalCents - used, 0);
            // participantes default da categoria nova: quem já entra na despesa
            state.catParts[id] = new Set(state.participants);
          }
        } else {
          // tocar no chip ativo tira a categoria; noutro, troca
          state.category = state.category === id ? null : id;
        }
        state.catManual = true;
        state.catAuto = false;
        draw();
      };
    });
    // fatura repartida: ativar/desativar o modo e editar as alocações
    slot.querySelector("#x-cat-multi")?.addEventListener("click", () => {
      state.catSplit = state.category ? { [state.category]: state.totalCents } : {};
      state.catManual = true;
      state.catAuto = false;
      draw();
    });
    slot.querySelector("#x-cat-single")?.addEventListener("click", () => {
      state.category = primaryCategory(); // fica a de maior valor
      state.catSplit = null;
      draw();
    });
    slot.querySelector("#x-cat-dist")?.addEventListener("click", () => {
      const ids = Object.keys(state.catSplit);
      if (ids.length) {
        const parts = splitByWeights(state.totalCents, ids.map(() => 1));
        ids.forEach((id, i) => { state.catSplit[id] = parts[i]; });
      }
      draw();
    });
    slot.querySelectorAll("[data-catamount]").forEach(inp => {
      inp.onchange = () => {
        state.catSplit[inp.dataset.catamount] = toCents(inp.value);
        draw();
      };
    });
    // dividir por categoria: ligar/desligar e escolher quem participa em cada
    slot.querySelector("#x-cat-divide")?.addEventListener("click", (e) => {
      state.catDivide = e.target.checked;
      // ao ligar, garante que cada categoria tem um conjunto de participantes
      // (default: quem entra na despesa)
      if (state.catDivide) for (const id of Object.keys(state.catSplit))
        if (!state.catParts[id]) state.catParts[id] = new Set(state.participants);
      draw();
    });
    slot.querySelectorAll("[data-catpart-cat]").forEach(cb => {
      cb.onchange = () => {
        const cat = cb.dataset.catpartCat, mem = cb.dataset.catpartMem;
        const set = (state.catParts[cat] ??= new Set());
        cb.checked ? set.add(mem) : set.delete(mem);
        draw();
      };
    });
    if (state.section === "dados") scrollCatIntoView();

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
      if (isRecurringRecord) {
        if (!confirm("Apagar esta despesa recorrente? As despesas já lançadas mantêm-se — só deixa de lançar novas.")) return;
        const { error } = await sb.from("recurring_expenses").delete().eq("id", existing.id);
        if (error) return toast(error.message, true);
        toast("Recorrente apagada");
        return refresh();
      }
      if (isOccurrence) {
        if (!confirm("Apagar esta ocorrência? Faz parte de uma despesa recorrente e pode voltar a ser lançada automaticamente. "
          + "Para parar de vez, apaga ou pausa a série nas Definições.")) return;
        const { error } = await sb.from("expenses").delete().eq("id", existing.id);
        if (error) return toast(error.message, true);
        toast("Ocorrência apagada");
        return refresh();
      }
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
      // dividir por categoria: cada categoria com valor precisa de alguém
      if (catDividing()) {
        const semGente = catEntries()
          .filter(([cat]) => ![...(state.catParts[cat] || [])].some(id => members.some(m => m.id === id)))
          .map(([cat]) => catOf(cat).label);
        if (semGente.length) return fail("divide", `Escolhe quem participa em: ${semGente.join(", ")}`);
      }
      if (shareSum2 !== state.totalCents) return fail("divide", "A divisão não soma o total");

      // fatura repartida por categorias: a alocação tem de somar o total
      // (sem nenhuma categoria escolhida, a despesa fica sem categoria)
      const catRows = catEntries();
      if (state.catSplit && catRows.length > 0) {
        const catSum = catRows.reduce((a, [, c]) => a + c, 0);
        if (catSum !== state.totalCents) return fail("dados", "Os valores das categorias não somam o total da fatura");
      }
      // o que vai para expenses.category: a única, ou a principal da repartição
      const catId = primaryCategory();
      // linhas da divisão por categoria (só quando está ativa)
      const catShareRows = [];
      if (catDividing()) {
        const per = perCategoryShares();
        for (const [cat, byMem] of Object.entries(per))
          for (const [mem, c] of Object.entries(byMem))
            if (c > 0) catShareRows.push({ category: cat, member_id: mem, amount: (c / 100).toFixed(2) });
      }

      // ----- converter uma despesa ocasional em recorrente daí para a frente -----
      // cria um molde a partir desta despesa e liga-a como 1.ª ocorrência (o
      // índice único impede que a geração a duplique). Guarda: não pode existir
      // outra despesa com a mesma descrição em data POSTERIOR, senão a geração
      // criaria duplicados dos meses que já foram lançados à mão.
      if (state.recurring && converting) {
        if (state.dayOfMonth < 1 || state.dayOfMonth > 31) return fail("dados", "Dia do mês tem de ser entre 1 e 31");
        if (state.endDate && state.endDate < today) return fail("dados", "A data de fim não pode ser anterior a hoje");

        const { data: later, error: qErr } = await sb.from("expenses")
          .select("id, expense_date")
          .eq("group_id", group.id)
          .eq("description", desc)
          .gt("expense_date", existing.expense_date)
          .order("expense_date").limit(1);
        if (qErr) return toast(qErr.message, true);
        if (later && later.length) {
          return fail("dados", `Já existe uma despesa «${desc}» em ${fmtDate(later[0].expense_date)}, posterior a esta. `
            + "Apaga-a ou muda a descrição antes de tornar recorrente (senão ficavam duplicadas).");
        }

        const period = existing.expense_date.slice(0, 8) + "01"; // 1.º dia do mês (YYYY-MM-01)
        // 1) cria o molde a partir dos valores atuais do formulário
        const rpayload = {
          group_id: group.id, description: desc, amount: (state.totalCents / 100).toFixed(2),
          category: catId, split_mode: state.mode, day_of_month: state.dayOfMonth,
          start_date: period, end_date: state.endDate || null, active: state.active,
        };
        const { data: rec, error: rErr } = await sb.from("recurring_expenses").insert(rpayload).select().single();
        if (rErr) return toast(rErr.message, true);
        const rPayerRows = [...state.payers].filter(id => (state.payerAmounts[id] || 0) > 0)
          .map(id => ({ recurring_id: rec.id, member_id: id, amount: (state.payerAmounts[id] / 100).toFixed(2) }));
        const rShareRows = Object.entries(shares2).filter(([, c]) => c > 0)
          .map(([id, c]) => ({ recurring_id: rec.id, member_id: id, amount: (c / 100).toFixed(2) }));
        const re1 = await sb.from("recurring_expense_payers").insert(rPayerRows);
        const re2 = await sb.from("recurring_expense_shares").insert(rShareRows);
        if (re1.error || re2.error) return toast((re1.error || re2.error).message, true);

        // 2) atualiza a despesa (aplica edições) e liga-a ao molde como 1.ª ocorrência
        const { error: uErr } = await sb.from("expenses").update({
          description: desc, amount: (state.totalCents / 100).toFixed(2),
          split_mode: state.mode, category: catId,
          recurring_id: rec.id, recurring_period: period,
        }).eq("id", existing.id);
        if (uErr) return toast(uErr.message, true);
        await sb.from("expense_payers").delete().eq("expense_id", existing.id);
        await sb.from("expense_shares").delete().eq("expense_id", existing.id);
        // a 1.ª ocorrência fica com a categoria única do molde — limpa uma
        // eventual repartição/divisão antiga (erros ignorados: schema sem a tabela)
        await sb.from("expense_categories").delete().eq("expense_id", existing.id);
        await sb.from("expense_category_shares").delete().eq("expense_id", existing.id);
        const pRows = [...state.payers].filter(id => (state.payerAmounts[id] || 0) > 0)
          .map(id => ({ expense_id: existing.id, member_id: id, amount: (state.payerAmounts[id] / 100).toFixed(2) }));
        const sRows = Object.entries(shares2).filter(([, c]) => c > 0)
          .map(([id, c]) => ({ expense_id: existing.id, member_id: id, amount: (c / 100).toFixed(2) }));
        const pi1 = await sb.from("expense_payers").insert(pRows);
        const pi2 = await sb.from("expense_shares").insert(sRows);
        if (pi1.error || pi2.error) return toast((pi1.error || pi2.error).message, true);

        if (catId) learnCategory(desc, catId);
        try { await sb.rpc("generate_due_recurring"); } catch (_) { /* schema sem RPC */ }
        toast("Despesa convertida em recorrente");
        return refresh();
      }

      // ----- molde recorrente: grava em recurring_* e materializa já -----
      if (state.recurring) {
        if (state.dayOfMonth < 1 || state.dayOfMonth > 31) return fail("dados", "Dia do mês tem de ser entre 1 e 31");
        if (state.endDate && state.endDate < today) return fail("dados", "A data de fim não pode ser anterior a hoje");

        const rpayload = {
          group_id: group.id,
          description: desc,
          amount: (state.totalCents / 100).toFixed(2),
          category: catId,
          split_mode: state.mode,
          day_of_month: state.dayOfMonth,
          start_date: state.startDate,
          end_date: state.endDate || null,
          active: state.active,
        };
        let recId = existing?.id;
        if (existing) {
          const { error } = await sb.from("recurring_expenses").update(rpayload).eq("id", existing.id);
          if (error) return toast(error.message, true);
          await sb.from("recurring_expense_payers").delete().eq("recurring_id", existing.id);
          await sb.from("recurring_expense_shares").delete().eq("recurring_id", existing.id);
        } else {
          const { data, error } = await sb.from("recurring_expenses").insert(rpayload).select().single();
          if (error) return toast(error.message, true);
          recId = data.id;
        }
        const rPayerRows = [...state.payers]
          .filter(id => (state.payerAmounts[id] || 0) > 0)
          .map(id => ({ recurring_id: recId, member_id: id, amount: (state.payerAmounts[id] / 100).toFixed(2) }));
        const rShareRows = Object.entries(shares2)
          .filter(([, c]) => c > 0)
          .map(([id, c]) => ({ recurring_id: recId, member_id: id, amount: (c / 100).toFixed(2) }));
        const e1 = await sb.from("recurring_expense_payers").insert(rPayerRows);
        const e2 = await sb.from("recurring_expense_shares").insert(rShareRows);
        if (e1.error || e2.error) return toast((e1.error || e2.error).message, true);

        if (catId) learnCategory(desc, catId);
        // materializa já as ocorrências em atraso deste molde (idempotente)
        try { await sb.rpc("generate_due_recurring"); } catch (_) { /* schema sem RPC */ }
        toast(existing ? "Despesa recorrente atualizada" : "Despesa recorrente criada");
        return refresh();
      }

      const payload = {
        group_id: group.id,
        description: desc,
        amount: (state.totalCents / 100).toFixed(2),
        expense_date: date || new Date().toISOString().slice(0, 10),
        // dividir por categoria produz valores por pessoa arbitrários: grava
        // como "exact" para reabrir fiel mesmo sem a tabela da divisão
        split_mode: catDividing() ? "exact" : state.mode,
        category: catId,
      };

      // schema antigo sem as colunas split_mode/category: grava na mesma
      // sem esses campos (o PostgREST acusa uma coluna em falta de cada vez)
      const stripMissingCol = (error) => {
        if (!error) return false;
        if (/split_mode/i.test(error.message) && "split_mode" in payload) {
          toast("Modo de divisão não gravado — corre o schema.sql mais recente no Supabase", true);
          delete payload.split_mode;
          return true;
        }
        if (/category/i.test(error.message) && "category" in payload) {
          toast("Categoria não gravada — corre o schema.sql mais recente no Supabase", true);
          delete payload.category;
          return true;
        }
        return false;
      };

      let expenseId = existing?.id;
      if (existing) {
        let { error } = await sb.from("expenses").update(payload).eq("id", existing.id);
        while (stripMissingCol(error)) ({ error } = await sb.from("expenses").update(payload).eq("id", existing.id));
        if (error) return toast(error.message, true);
        const d1 = await sb.from("expense_payers").delete().eq("expense_id", existing.id);
        const d2 = await sb.from("expense_shares").delete().eq("expense_id", existing.id);
        if (d1.error || d2.error) return toast((d1.error || d2.error).message, true);
      } else {
        let { data, error } = await sb.from("expenses").insert(payload).select().single();
        while (stripMissingCol(error)) ({ data, error } = await sb.from("expenses").insert(payload).select().single());
        if (error) return toast(error.message, true);
        expenseId = data.id;
      }

      // aprender: reforça a ligação descrição -> categoria para as próximas
      // sugestões automáticas ficarem cada vez mais certeiras (na fatura
      // repartida aprende-se a principal)
      if (catId) learnCategory(desc, catId);

      // fatura repartida: substitui as linhas em expense_categories (com 0
      // ou 1 categoria não há linhas — a coluna category chega). Schema
      // antigo sem a tabela: degrada com aviso, a despesa fica na principal.
      const catInsRows = catRows.length >= 2
        ? catRows.map(([id, c]) => ({ expense_id: expenseId, category: id, amount: (c / 100).toFixed(2) }))
        : [];
      const dc = await sb.from("expense_categories").delete().eq("expense_id", expenseId);
      const catsMissing = !!dc.error && /expense_categories/i.test(dc.error.message);
      if (dc.error && !catsMissing) return toast(dc.error.message, true);
      if (catInsRows.length && !catsMissing) {
        const ic = await sb.from("expense_categories").insert(catInsRows);
        if (ic.error) return toast(ic.error.message, true);
      }
      if (catInsRows.length && catsMissing) {
        toast("Repartição por categorias não gravada — corre o schema.sql mais recente no Supabase", true);
      }

      // divisão do custo por categoria (quem participa em cada): substitui as
      // linhas. Sem esta divisão não há linhas — expense_shares (a soma) chega.
      const catShareInsRows = catShareRows.map(r => ({ expense_id: expenseId, ...r }));
      const ds = await sb.from("expense_category_shares").delete().eq("expense_id", expenseId);
      const catShMissing = !!ds.error && /expense_category_shares/i.test(ds.error.message);
      if (ds.error && !catShMissing) return toast(ds.error.message, true);
      if (catShareInsRows.length && !catShMissing) {
        const is = await sb.from("expense_category_shares").insert(catShareInsRows);
        if (is.error) return toast(is.error.message, true);
      }
      if (catShareInsRows.length && catShMissing) {
        toast("Divisão por categoria não gravada — corre o schema.sql mais recente no Supabase", true);
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

  // cêntimos: + recebe, - deve (pagamentos já feitos incluídos)
  const balance = Object.fromEntries(groupBalancesCents(members, expenses, payments));

  // sugestões de acerto (preferências de liquidação + algoritmo guloso)
  const settlements = settlementsFor(members, balance);

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
  const myMember = members.find(m => m.user_id === session.user.id);

  // intervalo de datas do resumo: recorta o total, as quotas e o gráfico.
  // Os saldos e os acertos ficam sempre sobre tudo — dívida é dívida.
  const period = { from: "", to: "" };

  // Em cada cartão, o que é do próprio utilizador fica sempre visível; só o
  // que é dos outros (saldos, acertos, pagamentos, quotas) fica atrás de um
  // «Ver … dos outros (N) ▾». Um criador que não é membro do grupo não tem
  // "próprio": vê tudo sempre visível, sem botão de colapsar.
  const isMineS = (s) => !!myMember && (s.from.id === myMember.id || s.to.id === myMember.id);
  const isMineP = (p) => !!myMember && (p.from_member === myMember.id || p.to_member === myMember.id);
  const mySettles = settlements.map((s, i) => [s, i]).filter(([s]) => !myMember || isMineS(s));
  const otherSettles = myMember ? settlements.map((s, i) => [s, i]).filter(([s]) => !isMineS(s)) : [];
  const myPayments = payments.filter(p => !myMember || isMineP(p));
  const otherPayments = myMember ? payments.filter(p => !isMineP(p)) : [];
  const mineMembers = myMember ? [myMember] : members;
  const otherMembers = myMember ? members.filter(m => m.id !== myMember.id) : [];
  // quotas por pessoa: sem "próprio" mostra toda a gente (senão só os outros)
  const quotaMembers = myMember ? otherMembers : members;

  // linha de acerto (o índice aponta para settlements, para o «Pagar» pré-preencher)
  const settleLine = ([s, i]) => `
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
    </div>`;

  const paymentLi = (p) => `
    <li>
      <div class="item-main">
        <span class="item-title payment-line">
          ${esc(memberName(p.from_member))} <span class="settle-arrow">→</span> ${esc(memberName(p.to_member))}
        </span>
        <span class="item-sub">${fmtDate(p.payment_date)}${p.note ? ` · ${esc(p.note)}` : ""}</span>
      </div>
      <span class="amount">${fmtMoney(toCents(p.amount), cur)}</span>
      <button class="ghost small" data-pdel="${p.id}" title="Apagar pagamento">✕</button>
    </li>`;

  // linha de saldo de um membro (com detalhe expansível se deve/recebe de vários)
  const balanceLi = (m) => {
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
  };

  // cartão com o do próprio sempre visível + o dos outros atrás do colapsar
  const card = (title, id, mine, others, othersCount, othersLabel, action = "") => `
    <div class="card">
      <div class="card-title-row"><h2>${title}</h2>${action}</div>
      ${mine}
      ${othersCount > 0 ? `
        <button type="button" class="collapse-toggle" data-collapse="${id}">
          <span>${othersLabel} <span class="muted">(${othersCount})</span></span>
          <span class="collapse-arrow">▾</span>
        </button>
        <div class="collapse-body hidden" data-body="${id}">${others}</div>` : ""}
    </div>`;

  // ---- Resumo dos gastos: total + a tua quota + gráfico sempre visíveis;
  // a quota por pessoa (dos outros) fica no colapsável ----
  const resumoCard = `
    <div class="card">
      <div class="card-title-row">
        <h2>Resumo dos gastos</h2>
        <div class="title-actions">
          <button type="button" class="secondary small" id="bp-report">📄 Relatório</button>
          <button type="button" class="secondary small date-toggle-txt" id="bp-toggle">📅 Período</button>
        </div>
      </div>
      <div class="date-range hidden" id="bp-range">
        <div class="field"><label>De</label><input type="date" id="bp-from" /></div>
        <div class="field"><label>Até</label><input type="date" id="bp-to" /></div>
        <button type="button" class="secondary small" id="bp-clear">Limpar</button>
      </div>
      <div id="balance-summary"></div>
      ${quotaMembers.length === 0 ? "" : myMember ? `
        <button type="button" class="collapse-toggle" data-collapse="resumo">
          <span>Quota por pessoa <span class="muted">(${quotaMembers.length})</span></span>
          <span class="collapse-arrow">▾</span>
        </button>
        <div class="collapse-body hidden" data-body="resumo"><div id="balance-quotas"></div></div>`
        : `<div id="balance-quotas" style="margin-top:.6rem;"></div>`}
    </div>`;

  // ---- Saldos ----
  const saldosMine = members.length === 0
    ? `<p class="empty">Sem membros.</p>`
    : `<ul class="list balances">${mineMembers.map(balanceLi).join("")}</ul>`;
  const saldosOthers = `<ul class="list balances">${otherMembers.map(balanceLi).join("")}</ul>`;

  // ---- Como acertar contas ----
  const acertosMine = mySettles.length
    ? mySettles.map(settleLine).join("")
    : `<p class="empty">${settlements.length && myMember
        ? "Não tens contas por acertar 🎉" : "Está tudo em dia 🎉"}</p>`;
  const acertosOthers = otherSettles.map(settleLine).join("");

  // ---- Pagamentos ----
  const pagAction = paymentsReady
    ? `<button type="button" class="secondary small" id="btn-add-payment">+ Registar</button>` : "";
  const pagMine = !paymentsReady
    ? `<p class="muted">Para ativar o registo de pagamentos, corre a versão mais
      recente de <code>supabase/schema.sql</code> no SQL Editor do Supabase.</p>`
    : `
      <div id="payment-form-slot"></div>
      ${myPayments.length
        ? `<ul class="list">${myPayments.map(paymentLi).join("")}</ul>`
        : `<p class="empty">${payments.length && myMember
            ? "Ainda não tens pagamentos teus registados." : "Ainda não há pagamentos registados."}</p>`}
      ${totalPaid > 0 ? `<p class="muted" style="text-align:right;margin:.5rem 0 0;">total acertado no grupo: ${fmtMoney(totalPaid, cur)}</p>` : ""}`;
  const pagOthers = `<ul class="list">${otherPayments.map(paymentLi).join("")}</ul>`;

  $c.innerHTML = `
    ${resumoCard}
    ${card("Saldos", "saldos", saldosMine, saldosOthers, otherMembers.length, "Ver saldos dos outros")}
    ${card("Como acertar contas", "acertos", acertosMine, acertosOthers, otherSettles.length, "Ver acertos entre os outros")}
    ${card("Pagamentos", "pagamentos", pagMine, pagOthers, otherPayments.length, "Ver pagamentos dos outros", pagAction)}`;

  // abrir/fechar a parte "dos outros" de cada cartão
  $c.querySelectorAll(".collapse-toggle").forEach(btn => {
    btn.onclick = () => {
      $c.querySelector(`[data-body="${btn.dataset.collapse}"]`).classList.toggle("hidden");
      btn.classList.toggle("open");
    };
  });

  // expandir/encolher o detalhe de um saldo com várias pessoas
  $c.querySelectorAll("[data-bal]").forEach(li => {
    li.onclick = () => {
      $c.querySelector(`[data-bdetail="${li.dataset.bal}"]`).classList.toggle("hidden");
      li.classList.toggle("open");
      li.querySelector(".expand-arrow")?.classList.toggle("open");
    };
  });

  // ---- resumo dos gastos: total, quota por pessoa e mini gráfico mensal ----
  const $sum = $c.querySelector("#balance-summary");
  const $quotas = $c.querySelector("#balance-quotas");

  function drawSummary() {
    const xs = expenses.filter(x =>
      (!period.from || x.expense_date >= period.from) && (!period.to || x.expense_date <= period.to));
    const active = !!(period.from || period.to);
    const total = xs.reduce((a, x) => a + toCents(x.amount), 0);

    // quota (a parte que coube a cada um) e pago (o que cada um adiantou);
    // as quotas somam frações exatas e arredondam uma única vez no fim
    const paid = {};
    for (const m of members) paid[m.id] = 0;
    const exact = new Map(members.map(m => [m.id, 0]));
    for (const x of xs) {
      for (const p of x.expense_payers) if (p.member_id in paid) paid[p.member_id] += toCents(p.amount);
      for (const [id, v] of exactShareCents(x)) if (exact.has(id)) exact.set(id, exact.get(id) + v);
    }
    const share = Object.fromEntries(roundPreservingSum(exact));

    // gastos por mês para o mini gráfico, com os meses sem despesas a zero
    const byMonth = new Map();
    for (const x of xs) {
      const ym = x.expense_date.slice(0, 7);
      byMonth.set(ym, (byMonth.get(ym) || 0) + toCents(x.amount));
    }
    let chart = "";
    if (byMonth.size >= 2) {
      const keys = [...byMonth.keys()].sort();
      const months = [];
      let [y, mo] = keys[0].split("-").map(Number);
      const [ey, emo] = keys[keys.length - 1].split("-").map(Number);
      while (y < ey || (y === ey && mo <= emo)) {
        const ym = `${y}-${String(mo).padStart(2, "0")}`;
        months.push([ym, byMonth.get(ym) || 0]);
        if (++mo > 12) { mo = 1; y++; }
      }
      const bars = months.slice(-12); // no máximo o último ano de barras
      const max = Math.max(...bars.map(b => b[1]), 1);
      const multiYear = new Set(bars.map(([ym]) => ym.slice(0, 4))).size > 1;
      const lbl = (ym) => {
        const d = new Date(ym + "-01T00:00:00");
        const m2 = d.toLocaleDateString("pt-PT", { month: "short" }).replace(".", "");
        return multiYear ? `${m2} ${String(d.getFullYear()).slice(2)}` : m2;
      };
      chart = `<div class="mini-chart">${bars.map(([ym, c]) => `
        <div class="mc-col" title="${lbl(ym)}: ${fmtMoney(c, cur)}">
          ${bars.length <= 8 ? `<span class="mc-val">${c ? Math.round(c / 100) : ""}</span>` : ""}
          <div class="mc-bar-wrap"><div class="mc-bar" style="height:${Math.max(3, Math.round(c / max * 100))}%"></div></div>
          <span class="mc-lbl">${lbl(ym)}</span>
        </div>`).join("")}</div>`;
    }

    // sempre visível: total do grupo + a tua quota (do período) + gráfico
    $sum.innerHTML = `
      <div class="stat-strip in-card">
        <div class="stat">
          <span class="stat-label">Total do grupo</span>
          <span class="stat-value">${fmtMoney(total, cur)}</span>
        </div>
        ${myMember ? `
        <div class="stat">
          <span class="stat-label">A tua quota</span>
          <span class="stat-value">${fmtMoney(share[myMember.id] || 0, cur)}</span>
        </div>` : ""}
      </div>
      ${active ? `<p class="muted period-note">período: ${period.from ? fmtDate(period.from) : "início"} → ${period.to ? fmtDate(period.to) : "hoje"}</p>` : ""}
      ${chart}`;

    // colapsável: a quota por pessoa dos outros (a do próprio já está em cima)
    if ($quotas) {
      const maxShare = Math.max(...quotaMembers.map(m => share[m.id]), 1);
      const rows = [...quotaMembers].sort((a, b) => share[b.id] - share[a.id]).map(m => {
        const s = share[m.id], p = paid[m.id];
        const pct = total > 0 ? Math.round(s / total * 100) : 0;
        return `<div class="quota-row">
          ${avatarHtml(m.name)}
          <div class="quota-main">
            <div class="quota-top">
              <span class="quota-name">${esc(m.name)}</span>
              <span class="quota-amt">${fmtMoney(s, cur)}</span>
            </div>
            <div class="quota-bar"><div class="quota-fill" style="width:${Math.round(s / maxShare * 100)}%"></div></div>
            <div class="quota-foot">
              <span>${pct}% do total</span>
              <span>pagou ${fmtMoney(p, cur)}</span>
            </div>
          </div>
        </div>`;
      }).join("");
      $quotas.innerHTML = xs.length === 0
        ? `<p class="empty">Sem despesas ${active ? "neste período" : "ainda"}.</p>`
        : `<p class="muted quota-hint">Quota por pessoa — a parte das despesas que coube a cada um.</p>${rows}`;
    }
  }

  const $bpToggle = $c.querySelector("#bp-toggle");
  const $bpRange = $c.querySelector("#bp-range");
  const $bpFrom = $c.querySelector("#bp-from");
  const $bpTo = $c.querySelector("#bp-to");
  // como nas despesas: o botão fica realçado enquanto o período estiver ativo
  const syncPeriodBtn = () => $bpToggle.classList.toggle("active", !!(period.from || period.to));
  $c.querySelector("#bp-report").onclick = () => gerarRelatorioGrupo(ctx);
  $bpToggle.onclick = () => $bpRange.classList.toggle("hidden");
  $bpFrom.onchange = () => { period.from = $bpFrom.value; syncPeriodBtn(); drawSummary(); };
  $bpTo.onchange = () => { period.to = $bpTo.value; syncPeriodBtn(); drawSummary(); };
  $c.querySelector("#bp-clear").onclick = () => {
    period.from = period.to = "";
    $bpFrom.value = "";
    $bpTo.value = "";
    syncPeriodBtn();
    drawSummary();
  };
  drawSummary();

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

// ------------------------------------------------ relatório do grupo (imprimível / PDF)
// Abre uma janela sobreposta com o relatório num iframe e um botão para
// imprimir / guardar como PDF (mesmo padrão do SplitBill).
function abrirRelatorio(html, titulo) {
  const docHtml = `<!DOCTYPE html><html lang="pt"><head><meta charset="UTF-8"><title>${esc(titulo)}</title>
    <style>
      * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
      @media print { body { margin: 0; } }
      body { margin: 0; background: #fff; color: #14212b;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
      table { border-collapse: collapse; width: 100%; }
      /* não partir uma linha entre páginas e repetir o cabeçalho da tabela
         no topo de cada página quando ela se estende por várias */
      tr { page-break-inside: avoid; break-inside: avoid; }
      thead { display: table-header-group; }
      /* manter o título colado à tabela e, nos quadros curtos, não deixar o
         título/cabeçalho numa página e o conteúdo noutra. Num quadro maior
         que uma página (ex.: Despesas) o browser ignora o "avoid" e parte-o
         na mesma, mas o cabeçalho da tabela repete-se por causa do acima. */
      h2.rpt-sec { font-size: 12px; font-weight: 800; color: #0b5f47;
        text-transform: uppercase; letter-spacing: 1px; margin: 26px 0 8px;
        page-break-after: avoid; break-after: avoid; }
      .rpt-block { page-break-inside: avoid; break-inside: avoid; }
    </style>
  </head><body>${html}</body></html>`;

  document.getElementById("rptOverlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "rptOverlay";
  ov.style.cssText = "position:fixed;inset:0;z-index:99999;background:#3a4a44;display:flex;flex-direction:column";
  // barra de topo: «voltar» à esquerda, nome do ficheiro no meio (truncado) e
  // «guardar PDF» à direita — os botões nunca encolhem, o nome cede o espaço.
  ov.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#0b5f47;color:#fff;flex:0 0 auto">
      <button id="rptClose" title="Voltar" style="flex:0 0 auto;background:rgba(255,255,255,.16);border:none;color:#fff;font-size:18px;line-height:1;padding:9px 14px;border-radius:8px;cursor:pointer">←</button>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;font-size:13px">${esc(titulo)}</span>
      <button id="rptPrint" style="flex:0 0 auto;background:#0f9d76;border:none;color:#fff;font-size:14px;padding:9px 14px;border-radius:8px;cursor:pointer;white-space:nowrap">🖨 Guardar PDF</button>
    </div>
    <iframe id="rptFrame" style="flex:1 1 auto;border:0;width:100%;background:#fff"></iframe>`;
  document.body.appendChild(ov);

  // Fechar também com o botão «voltar» do telemóvel / gesto de retroceder:
  // empurra um estado no histórico e fecha quando esse estado é retirado.
  const onPop = () => { ov.remove(); window.removeEventListener("popstate", onPop); };
  window.addEventListener("popstate", onPop);
  history.pushState({ swRelatorio: 1 }, "");

  const frame = ov.querySelector("#rptFrame");
  frame.srcdoc = docHtml;
  ov.querySelector("#rptClose").onclick = () => history.back();
  ov.querySelector("#rptPrint").onclick = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  };
}

// Constrói e mostra o relatório completo de um grupo: resumo, quota por
// pessoa, saldos, acertos, total por categoria, despesas e pagamentos.
function gerarRelatorioGrupo(ctx) {
  const { group, members, expenses, payments } = ctx;
  const cur = group.currency;
  const memberName = id => members.find(m => m.id === id)?.name || "?";

  const total = expenses.reduce((a, x) => a + toCents(x.amount), 0);
  const balance = Object.fromEntries(groupBalancesCents(members, expenses, payments));
  const settlements = settlementsFor(members, balance);

  // quota (parte que coube a cada um) e pago (o que cada um adiantou)
  const paid = {};
  const exact = new Map(members.map(m => [m.id, 0]));
  for (const m of members) paid[m.id] = 0;
  for (const x of expenses) {
    for (const p of x.expense_payers) if (p.member_id in paid) paid[p.member_id] += toCents(p.amount);
    for (const [id, v] of exactShareCents(x)) if (exact.has(id)) exact.set(id, exact.get(id) + v);
  }
  const share = Object.fromEntries(roundPreservingSum(exact));

  // total por categoria (as despesas sem categoria vão para «Sem categoria»;
  // uma fatura repartida soma cada parte na respetiva categoria)
  const byCat = new Map();
  for (const x of expenses) for (const s of expenseCatSplits(x)) {
    const e = byCat.get(s.cat) || { cents: 0, n: 0 };
    e.cents += s.cents;
    e.n += 1;
    byCat.set(s.cat, e);
  }
  const cats = [...byCat.entries()].sort((a, b) => b[1].cents - a[1].cents);

  const zebra = i => (i % 2 === 0 ? "#fff" : "#f4f7f6");
  const td = "padding:8px 12px;";
  const th = (align = "left") => `padding:9px 12px;text-align:${align};`;

  // ---- cabeçalho ----
  const dataStr = new Date().toLocaleDateString("pt-PT", { day: "2-digit", month: "long", year: "numeric" });
  const cabecalho = `
    <div style="background:#0b5f47;color:#fff;padding:22px 26px;border-radius:12px;display:flex;justify-content:space-between;align-items:center;gap:16px;">
      <div>
        <div style="font-size:13px;opacity:.7;font-weight:600;">💸 SplitWisely</div>
        <div style="font-size:22px;font-weight:800;margin-top:2px;">${esc(group.name)}</div>
        ${group.description ? `<div style="font-size:14px;opacity:.9;margin-top:4px;">${esc(group.description)}</div>` : ""}
        <div style="font-size:12px;opacity:.6;margin-top:6px;">Relatório de ${dataStr}</div>
      </div>
      <div style="text-align:right;flex:0 0 auto;">
        <div style="font-size:11px;opacity:.6;">Total do grupo</div>
        <div style="font-size:26px;font-weight:800;color:#37d39e;">${fmtMoney(total, cur)}</div>
        <div style="font-size:11px;opacity:.6;margin-top:4px;">${expenses.length} despesa${expenses.length === 1 ? "" : "s"} · ${members.length} membro${members.length === 1 ? "" : "s"}</div>
      </div>
    </div>`;

  // ---- quota por pessoa ---- (membros por ordem alfabética)
  const byName = (a, b) => a.name.localeCompare(b.name, "pt", { sensitivity: "base" });
  const quotaRows = [...members].sort(byName).map((m, i) => {
    const pct = total > 0 ? Math.round(share[m.id] / total * 100) : 0;
    return `<tr style="background:${zebra(i)}">
      <td style="${td}font-weight:600;">${esc(m.name)}</td>
      <td style="${td}text-align:right;">${fmtMoney(share[m.id] || 0, cur)}</td>
      <td style="${td}text-align:center;color:#66788a;">${pct}%</td>
      <td style="${td}text-align:right;color:#0d8f6c;font-weight:700;">${fmtMoney(paid[m.id] || 0, cur)}</td>
    </tr>`;
  }).join("");
  const quotaSec = members.length === 0 ? "" : `
    <h2 class="rpt-sec">👥 Quota por pessoa</h2>
    <table style="border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);font-size:13px;">
      <thead><tr style="background:#0f9d76;color:#fff;">
        <th style="${th()}">Membro</th><th style="${th("right")}">Quota</th>
        <th style="${th("center")}">% total</th><th style="${th("right")}">Adiantou</th>
      </tr></thead>
      <tbody>${quotaRows}</tbody>
      <tfoot><tr style="background:#eef2f0;font-weight:800;">
        <td style="${td}">Total</td>
        <td style="${td}text-align:right;">${fmtMoney(total, cur)}</td>
        <td></td>
        <td style="${td}text-align:right;color:#0d8f6c;">${fmtMoney(total, cur)}</td>
      </tr></tfoot>
    </table>`;

  // ---- saldos ---- (membros por ordem alfabética)
  const balRows = [...members].sort(byName).map((m, i) => {
    const b = balance[m.id];
    const txt = b === 0 ? "✓ em dia" : (b > 0 ? "recebe " : "deve ") + fmtMoney(Math.abs(b), cur);
    const cor = b > 0 ? "#0d8f6c" : b < 0 ? "#d43333" : "#66788a";
    return `<tr style="background:${zebra(i)}">
      <td style="${td}font-weight:600;">${esc(m.name)}</td>
      <td style="${td}text-align:right;font-weight:700;color:${cor};">${txt}</td>
    </tr>`;
  }).join("");
  const saldosSec = members.length === 0 ? "" : `
    <h2 class="rpt-sec">⚖️ Saldos</h2>
    <table style="border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);font-size:13px;">
      <thead><tr style="background:#0f9d76;color:#fff;">
        <th style="${th()}">Membro</th><th style="${th("right")}">Saldo</th>
      </tr></thead>
      <tbody>${balRows}</tbody>
    </table>`;

  // ---- como acertar contas ----
  const acertosSec = `
    <h2 class="rpt-sec">🤝 Como acertar contas</h2>
    ${settlements.length === 0
      ? `<p style="color:#0d8f6c;font-weight:600;font-size:13px;">Está tudo em dia 🎉</p>`
      : `<table style="border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);font-size:13px;">
          <thead><tr style="background:#0f9d76;color:#fff;">
            <th style="${th()}">Quem paga</th><th style="${th()}">Recebe</th><th style="${th("right")}">Valor</th>
          </tr></thead>
          <tbody>${[...settlements].sort((a, b) => byName(a.from, b.from) || byName(a.to, b.to)).map((s, i) => `
            <tr style="background:${zebra(i)}">
              <td style="${td}font-weight:600;">${esc(s.from.name)}</td>
              <td style="${td}">${esc(s.to.name)}</td>
              <td style="${td}text-align:right;font-weight:700;color:#0f9d76;">${fmtMoney(s.cents, cur)}</td>
            </tr>`).join("")}</tbody>
        </table>`}`;

  // ---- total por categoria ----
  const catSec = cats.length === 0 ? "" : `
    <h2 class="rpt-sec">🏷️ Total por categoria</h2>
    <table style="border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);font-size:13px;">
      <thead><tr style="background:#0b5f47;color:#fff;">
        <th style="${th()}">Categoria</th>
        <th style="${th("center")}">% total</th><th style="${th("right")}">Total</th>
      </tr></thead>
      <tbody>${cats.map(([id, e], i) => {
        const c = catOf(id);
        const label = c ? `${c.icon} ${c.label}` : "📦 Sem categoria";
        const pct = total > 0 ? Math.round(e.cents / total * 100) : 0;
        return `<tr style="background:${zebra(i)}">
          <td style="${td}font-weight:600;">${esc(label)}</td>
          <td style="${td}text-align:center;color:#66788a;">${pct}%</td>
          <td style="${td}text-align:right;font-weight:700;color:#0f9d76;">${fmtMoney(e.cents, cur)}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>`;

  // ---- despesas ----
  // data compacta (dia/mês abreviado, ex.: 18/jul) para ganhar espaço e
  // reduzir as quebras de linha nas restantes colunas
  const shortDate = d => {
    const dt = new Date(d + "T00:00:00");
    const mes = dt.toLocaleDateString("pt-PT", { month: "short" }).replace(".", "");
    return `${dt.getDate()}/${mes}`;
  };
  const despRows = [...expenses]
    .sort((a, b) => (a.expense_date < b.expense_date ? 1 : a.expense_date > b.expense_date ? -1 : 0))
    .map((x, i) => {
      // categoria(s) numa coluna à parte: ícone(s) da(s) parte(s) da despesa
      // (uma fatura repartida por categorias mostra vários)
      const cats = expenseCatSplits(x).filter(s => s.cat !== "none").map(s => catOf(s.cat).icon).join(" ");
      const quem = x.expense_payers.map(p => memberName(p.member_id)).join(", ") || "—";
      return `<tr style="background:${zebra(i)}">
        <td style="${td}color:#66788a;white-space:nowrap;">${shortDate(x.expense_date)}</td>
        <td style="${td}font-weight:600;">${esc(x.description || "—")}</td>
        <td style="${td}text-align:center;white-space:nowrap;">${cats || `<span style="color:#c2c9cf;">—</span>`}</td>
        <td style="${td}color:#4a534e;font-size:12px;">${esc(quem)}</td>
        <td style="${td}text-align:right;font-weight:700;color:#0f9d76;">${fmtMoney(toCents(x.amount), cur)}</td>
      </tr>`;
    }).join("");
  const despSec = expenses.length === 0 ? "" : `
    <h2 class="rpt-sec">🧾 Despesas</h2>
    <table style="border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);font-size:12.5px;">
      <thead><tr style="background:#0b5f47;color:#fff;">
        <th style="${th()}">Data</th><th style="${th()}">Descrição</th>
        <th style="${th("center")}">Cat.</th><th style="${th()}">Quem pagou</th><th style="${th("right")}">Valor</th>
      </tr></thead>
      <tbody>${despRows}</tbody>
    </table>`;

  // ---- pagamentos registados ----
  const pagSec = payments.length === 0 ? "" : `
    <h2 class="rpt-sec">💸 Pagamentos registados</h2>
    <table style="border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);font-size:13px;">
      <thead><tr style="background:#0f9d76;color:#fff;">
        <th style="${th()}">De</th><th style="${th()}">Para</th>
        <th style="${th()}">Data</th><th style="${th("right")}">Valor</th>
      </tr></thead>
      <tbody>${[...payments]
        .sort((a, b) => (a.payment_date < b.payment_date ? 1 : -1))
        .map((p, i) => `<tr style="background:${zebra(i)}">
          <td style="${td}font-weight:600;">${esc(memberName(p.from_member))}</td>
          <td style="${td}">${esc(memberName(p.to_member))}</td>
          <td style="${td}color:#66788a;">${fmtDate(p.payment_date)}${p.note ? ` · ${esc(p.note)}` : ""}</td>
          <td style="${td}text-align:right;font-weight:700;color:#0f9d76;">${fmtMoney(toCents(p.amount), cur)}</td>
        </tr>`).join("")}</tbody>
    </table>`;

  // cada quadro num bloco que o browser tenta manter na mesma página (título
  // + tabela juntos); ver o CSS de impressão em abrirRelatorio()
  const bloco = s => s ? `<section class="rpt-block">${s}</section>` : "";
  const html = `<div style="max-width:720px;margin:0 auto;padding:28px 24px 48px;">
    ${cabecalho}${bloco(despSec)}${bloco(catSec)}${bloco(quotaSec)}${bloco(saldosSec)}${bloco(acertosSec)}${bloco(pagSec)}
  </div>`;

  const nomeFicheiro = `relatorio_${(group.name || "grupo").toLowerCase().replace(/[^\wà-ÿ]+/gi, "_").replace(/^_+|_+$/g, "")}.pdf`;
  abrirRelatorio(html, nomeFicheiro);
}

// Faz um membro recém-criado «herdar» as despesas já existentes do grupo:
// re-divide cada despesa (e cada molde recorrente) para o incluir. O novo
// membro entra com uma parte MÉDIA (total ÷ nº de participantes atuais) e as
// partes dos restantes mantêm a proporção relativa — por isso uma divisão em
// partes iguais continua igual (todos, incluindo o novo, ficam com a mesma
// fatia) e uma divisão por proporção/exata mantém-se proporcional. Não mexe
// em despesas onde o membro já participe, nem em despesas sem valor.
// Devolve { expenses, recurring, error } com o que foi alterado.
async function inheritExistingExpenses(newMemberId, ctx) {
  const { expenses = [], recurring = [] } = ctx;
  let changedEx = 0, changedRec = 0, firstError = null;

  // pesos = parte atual de cada participante em cêntimos; o novo membro
  // entra com a média dessas partes. Devolve as novas linhas ou null se não
  // houver nada a mudar (sem participantes, sem valor, ou já lá está).
  const rebuild = (shareRows, amount) => {
    const total = toCents(amount);
    const ids = shareRows.map(s => s.member_id);
    if (total <= 0 || ids.length === 0 || ids.includes(newMemberId)) return null;
    const base = shareRows.map(s => toCents(s.amount));
    const sum = base.reduce((a, b) => a + b, 0);
    if (sum <= 0) return null;
    const parts = splitByWeights(total, [...base, sum / ids.length]);
    return [...ids, newMemberId].map((id, i) => ({ member_id: id, amount: (parts[i] / 100).toFixed(2) }));
  };

  for (const x of expenses) {
    const rows = rebuild(x.expense_shares || [], x.amount);
    if (!rows) continue;
    const del = await sb.from("expense_shares").delete().eq("expense_id", x.id);
    if (del.error) { firstError = firstError || del.error; continue; }
    const ins = await sb.from("expense_shares")
      .insert(rows.map(r => ({ ...r, expense_id: x.id })));
    if (ins.error) { firstError = firstError || ins.error; continue; }
    changedEx++;
  }

  // moldes recorrentes: as próximas ocorrências passam a incluir o membro
  for (const r of recurring) {
    const rows = rebuild(r.recurring_expense_shares || [], r.amount);
    if (!rows) continue;
    const del = await sb.from("recurring_expense_shares").delete().eq("recurring_id", r.id);
    if (del.error) { firstError = firstError || del.error; continue; }
    const ins = await sb.from("recurring_expense_shares")
      .insert(rows.map(r2 => ({ ...r2, recurring_id: r.id })));
    if (ins.error) { firstError = firstError || ins.error; continue; }
    changedRec++;
  }

  return { expenses: changedEx, recurring: changedRec, error: firstError };
}

// ------------------------------------------------ secção: membros (dentro das definições)
function renderMembersSection($c, ctx) {
  const { members } = ctx;
  const useWeights = !!ctx.group.use_weights;

  const inviteHint = `Se indicares um email, toca no membro e usa
       <strong>«Convidar por Gmail»</strong> para lhe mandar o link da app. Ao
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
        ${(ctx.expenses?.length || ctx.recurring?.length) ? `
        <label class="check-line" style="align-items:flex-start;">
          <input type="checkbox" name="inherit" style="margin-top:.15rem;" />
          <span>Herdar as despesas já existentes — todas as despesas do grupo
            (e os moldes recorrentes) passam a incluir esta pessoa, re-divididas
            para lhe dar uma parte.</span>
        </label>` : ""}
        <button type="submit">Adicionar</button>
      </form>
    </div>
    </div>`;

  const $wrap = $c.querySelector("#members-list-wrap");
  const $slot = $c.querySelector("#member-detail-slot");

  // detalhe de um membro: esconde a lista, mostra o formulário de edição
  function openMember(m) {
    const others = members.filter(x => x.id !== m.id);
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
        ${inviteBlockHtml(m, ctx.group)}
        ${useWeights ? `<div class="field" style="max-width:120px;"><label>Peso</label>
          <input id="m-weight" type="number" step="0.1" min="0" value="${m.default_weight}" /></div>` : ""}
        ${others.length ? `
        <div class="field"><label>Liquida preferencialmente com (opcional)</label>
          <select id="m-settle">
            <option value="">— sem preferência —</option>
            ${others.map(o => `<option value="${o.id}" ${m.settle_with === o.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}
          </select></div>
        <p class="muted" style="margin:-.3rem 0 .7rem;">Útil para convidados: se ${esc(shortName(m.name))}
          tiver a pagar e a pessoa escolhida a receber, o acerto de contas sugere primeiro
          que liquide com ela, antes da distribuição normal.</p>` : ""}
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
      const $settle = $slot.querySelector("#m-settle");
      if ($settle) payload.settle_with = $settle.value || null;
      let { error } = await sb.from("group_members").update(payload).eq("id", m.id);
      // schema antigo sem a coluna settle_with: grava o resto na mesma —
      // e o aviso fica no ecrã (sem ser tapado pelo toast de sucesso)
      let settleWarn = false;
      if (error && "settle_with" in payload && /settle_with/i.test(error.message)) {
        settleWarn = true;
        delete payload.settle_with;
        ({ error } = await sb.from("group_members").update(payload).eq("id", m.id));
      }
      if (error) return toast(error.message, true);
      if (settleWarn) {
        toast("Membro atualizado, mas a preferência de liquidação NÃO ficou gravada — "
          + "corre o schema.sql mais recente no SQL Editor do Supabase", true);
      } else {
        toast("Membro atualizado");
      }
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
    const inherit = !!f.get("inherit");
    const { data: created, error } = await sb.from("group_members").insert({
      group_id: ctx.group.id,
      name: f.get("name").trim(),
      email: f.get("email").trim() || null,
      // sem campo de peso (grupos de partes iguais) fica 1, para o caso
      // de a divisão por proporções vir a ser ativada mais tarde
      default_weight: f.get("weight") == null ? 1 : (parseFloat(f.get("weight")) || 0),
    }).select().single();
    if (error) return toast(error.message, true);

    // herdar as despesas já existentes, se o utilizador o pediu
    if (inherit && created) {
      const res = await inheritExistingExpenses(created.id, ctx);
      if (res.error) {
        toast("Pessoa adicionada, mas nem todas as despesas foram herdadas: "
          + res.error.message, true);
      } else if (res.expenses || res.recurring) {
        const bits = [];
        if (res.expenses) bits.push(`${res.expenses} despesa${res.expenses > 1 ? "s" : ""}`);
        if (res.recurring) bits.push(`${res.recurring} recorrente${res.recurring > 1 ? "s" : ""}`);
        toast(`Pessoa adicionada e a herdar ${bits.join(" e ")} ✓`);
      } else {
        toast("Pessoa adicionada");
      }
    } else {
      toast("Pessoa adicionada");
    }
    refresh();
  };
}

// ------------------------------------------------ tab: definições
// próxima ocorrência (>= hoje) de um molde recorrente, ou null se em pausa/terminado
function nextRecurringDate(r) {
  if (!r.active) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(r.start_date + "T00:00:00");
  const end = r.end_date ? new Date(r.end_date + "T00:00:00") : null;
  const from = today > start ? today : start;
  let y = from.getFullYear(), mo = from.getMonth();
  for (let i = 0; i < 25; i++) {
    const dim = new Date(y, mo + 1, 0).getDate(); // último dia do mês
    const occ = new Date(y, mo, Math.min(r.day_of_month, dim)); occ.setHours(0, 0, 0, 0);
    if (occ >= today && occ >= start && (!end || occ <= end)) return occ;
    if (end && occ > end) return null;
    if (++mo > 11) { mo = 0; y++; }
  }
  return null;
}

// secção «Despesas recorrentes» (dentro das Definições do grupo)
function renderRecurringSection($c, ctx) {
  const { group, members, recurring, recurringReady } = ctx;
  const cur = group.currency;
  const memberName = id => members.find(m => m.id === id)?.name || "?";

  if (!recurringReady) {
    $c.innerHTML = `<div class="card"><h2>Despesas recorrentes</h2>
      <p class="empty">Indisponível — corre o <code>schema.sql</code> mais recente no Supabase para ativar.</p></div>`;
    return;
  }

  const modeTxt = m => m === "weights" ? "por proporção" : m === "exact" ? "valores exatos" : "partes iguais";

  function draw() {
    const rows = (recurring || []).map(r => {
      const payers = (r.recurring_expense_payers || []).map(p => shortName(memberName(p.member_id))).join(", ");
      const next = nextRecurringDate(r);
      const sub = r.active
        ? (next ? `próxima: ${fmtDate(next.toISOString().slice(0, 10))}` : "sem próximas ocorrências")
        : "em pausa";
      return `<li class="clickable" data-open="${r.id}">
          <span class="date-block"><span class="m">dia</span><span class="d">${r.day_of_month}</span></span>
          ${catIconHtml(r.category)}
          <div class="item-main">
            <span class="item-title">${esc(r.description)}${r.active ? "" : ' <span class="badge">pausada</span>'}</span>
            <span class="item-sub">pago por ${esc(payers || "?")} · ${modeTxt(r.split_mode)} · ${esc(sub)}</span>
          </div>
          <div class="item-end"><span class="amount">${fmtMoney(toCents(r.amount), cur)}</span></div>
          <span class="chevron">›</span>
        </li>`;
    }).join("");

    $c.innerHTML = `
      <div class="card">
        <div class="header-row">
          <h2 style="margin:0;">Despesas recorrentes ${recurring.length ? `<span class="muted">· ${recurring.length}</span>` : ""}</h2>
          <button id="btn-add-rec" ${members.length === 0 ? "disabled" : ""}>+ Nova</button>
        </div>
        <p class="muted" style="margin-top:-.4rem;">Repetem-se todos os meses num certo dia (renda, ginásio, subscrições…).
          São lançadas automaticamente quando alguém abre a app.</p>
        ${members.length === 0 ? `<p class="empty">Adiciona primeiro membros em baixo.</p>` : ""}
        ${recurring.length === 0 && members.length > 0
          ? `<p class="empty">Sem despesas recorrentes ainda.</p>`
          : `<ul class="list">${rows}</ul>`}
      </div>`;

    // criar/editar abre no mesmo pop-up usado a partir da lista de despesas
    $c.querySelector("#btn-add-rec")?.addEventListener("click", () => openRecurringModal(ctx, null));
    $c.querySelectorAll("[data-open]").forEach(li => {
      li.onclick = () => openRecurringModal(ctx, recurring.find(x => x.id === li.dataset.open));
    });
  }
  draw();
}

function renderSettingsTab($c, ctx) {
  const { group, isOwner } = ctx;
  const selectedCats = groupCatIds(group); // null = todas

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
        <div class="field" style="margin-top:.4rem;">
          <label>Categorias do grupo
            <span class="check-note" style="display:block;margin-top:.15rem;">as que aparecem ao lançar despesas neste grupo — por defeito, todas</span>
          </label>
          <div class="cat-pick" id="group-cats">
            ${CATEGORIES.map(c => {
              const on = !selectedCats || selectedCats.includes(c.id);
              return `<label class="cat-pick-item ${on ? "on" : ""}">
                <input type="checkbox" name="categories" value="${c.id}" ${on ? "checked" : ""} ${isOwner ? "" : "disabled"} />
                <span>${c.icon} ${esc(c.label)}</span>
              </label>`;
            }).join("")}
          </div>
          ${isOwner ? `<div class="cat-pick-actions">
            <button type="button" class="secondary small" id="cats-all">Todas</button>
            <button type="button" class="secondary small" id="cats-none">Nenhuma</button>
          </div>` : ""}
        </div>
        ${isOwner ? `<button type="submit" id="btn-save-group" style="margin-top:.6rem;">Guardar definições</button>` : ""}
      </form>
    </div>
    <div id="members-section"></div>
    <div id="recurring-section"></div>
    ${isOwner ? `
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

  // despesas recorrentes — geríveis por qualquer membro, como as despesas
  renderRecurringSection($c.querySelector("#recurring-section"), ctx);

  if (!isOwner) return;

  // ligar/desligar a checkbox mostra logo (ou esconde) os pesos nos
  // membros em baixo, sem esperar pelo «Guardar definições»
  $c.querySelector('input[name="use_weights"]').onchange = (e) => {
    drawMembers(e.target.checked);
    if (e.target.checked) toast("Carrega em «Guardar definições» e define os pesos na lista de membros");
  };

  // seletor de categorias do grupo: realce visual + atalhos Todas/Nenhuma
  const catBoxes = () => Array.from($c.querySelectorAll('#group-cats input[name="categories"]'));
  const syncCatItem = (box) => box.closest(".cat-pick-item")?.classList.toggle("on", box.checked);
  catBoxes().forEach(box => { box.onchange = () => syncCatItem(box); });
  $c.querySelector("#cats-all").onclick = () => catBoxes().forEach(b => { b.checked = true; syncCatItem(b); });
  $c.querySelector("#cats-none").onclick = () => catBoxes().forEach(b => { b.checked = false; syncCatItem(b); });

  document.getElementById("edit-group").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    // categorias escolhidas: todas marcadas (ou nenhuma) => null = «todas»,
    // para não guardar uma lista à toa e manter o default limpo
    const chosen = f.getAll("categories");
    const cats = (chosen.length === 0 || chosen.length === CATEGORIES.length) ? null : chosen;
    const payload = {
      name: f.get("name").trim(),
      description: f.get("description").trim() || null,
      currency: f.get("currency"),
      use_weights: !!f.get("use_weights"),
      categories: cats,
    };
    let { error } = await sb.from("groups").update(payload).eq("id", group.id);
    // schema antigo sem a coluna categories: guarda o resto na mesma
    if (error && /categories/i.test(error.message)) {
      if (cats) toast("Categorias por grupo indisponíveis — corre o schema.sql mais recente no Supabase", true);
      delete payload.categories;
      ({ error } = await sb.from("groups").update(payload).eq("id", group.id));
    }
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
    // Materializa despesas recorrentes em atraso (idempotente). Sem servidor:
    // corre sempre que alguém abre a app. Degrada em silêncio se a RPC ainda
    // não existir (schema antigo por atualizar).
    try {
      const { data: gen } = await sb.rpc("generate_due_recurring");
      if (gen > 0) toast(`${gen} despesa${gen === 1 ? "" : "s"} recorrente${gen === 1 ? "" : "s"} lançada${gen === 1 ? "" : "s"} 🔁`);
    } catch (_) { /* schema sem recorrentes */ }
  }
}

async function main() {
  const cfg = loadConfig();
  if (!cfg) { hideSplash(); renderSetup(); return; }

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
