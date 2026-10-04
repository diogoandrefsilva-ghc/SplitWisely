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
// Painel que sobe de baixo, fora do formulário (ex.: «Quem és tu?» do link
// público). Usa o mesmo $modal: fecha com o closeModal, no route() e no
// Escape como os outros pop-ups. Devolve o corpo do painel para preencher.
function openSheet(title) {
  closeModal();
  $modal = document.createElement("div");
  $modal.className = "xp-scrim";
  $modal.innerHTML = `
    <div class="xp-folha entra" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="xp-folha-h">
        <span class="xp-grab"></span>
        <div class="xp-folha-t">
          <h3>${esc(title)}</h3>
          <button type="button" class="xp-folha-ok">Fechar</button>
        </div>
      </div>
      <div class="xp-folha-b"></div>
    </div>`;
  document.body.appendChild($modal);
  document.body.classList.add("modal-open");
  $modal.addEventListener("click", (e) => { if (e.target === $modal) closeModal(); });
  $modal.querySelector(".xp-folha-ok").onclick = closeModal;
  document.addEventListener("keydown", modalKey);
  return $modal.querySelector(".xp-folha-b");
}
function openRecurringModal(ctx, rec) {
  renderExpenseForm(openModal(), ctx, rec, closeModal, { recurring: true, backLabel: "Fechar" });
}
function openExpenseModal(ctx, x) {
  // despesa nova vai direta ao formulário; uma já lançada abre primeiro em
  // consulta (quem pagou e como se divide), e só o «Editar» leva ao formulário
  if (!x) {
    const slot = openModal();
    const form = () => renderExpenseForm(slot, ctx, null, closeModal, {
      backLabel: "Fechar",
      // ✨ no cabeçalho: descrever a despesa por palavras (ou foto) e a IA preenche
      onAi: () => renderAiExpense(slot, { ctx, onClose: closeModal, onBack: form }),
    });
    return form();
  }
  renderExpenseView(openModal(), ctx, x);
}

// Consulta de uma despesa: valor, data/hora, quem pagou e como se divide
function renderExpenseView(slot, ctx, x) {
  const { group, members, myMember } = ctx;
  const cur = group.currency;
  const curto = nomesCurtos(members);
  const nameOf = id => {
    if (myMember && id === myMember.id) return "Tu";
    const m = members.find(mm => mm.id === id);
    return m ? curto(m.name) : "?";
  };
  const fullName = id => members.find(m => m.id === id)?.name || "?";
  // mesma regra de permissão do formulário (espelha a RLS do servidor)
  const canEdit = !group.archived
    && (ctx.myRole === "write_all"
        || (ctx.myRole === "write_own" && x.created_by === session?.user.id));
  const own = x.split_mode === "own";

  const pessoa = (id, cents) => `
    <li class="xv-li">
      ${avatarHtml(fullName(id), "sm")}
      <span class="xv-name">${esc(nameOf(id))}</span>
      <span class="xv-amt">${fmtMoney(cents, cur)}</span>
    </li>`;
  const porValor = rows => [...rows].sort((a, b) => toCents(b.amount) - toCents(a.amount));
  const payers = porValor(x.expense_payers || []).filter(p => toCents(p.amount) > 0);
  const shares = porValor(x.expense_shares || []).filter(p => toCents(p.amount) > 0);
  const modoTxt = own ? "cada um pagou a sua parte"
    : (x.expense_category_shares || []).length ? "por categoria"
    : x.split_mode === "equal" ? "partes iguais"
    : x.split_mode === "weights" ? "por proporção"
    : "valores definidos";

  const cats = expenseCatSplits(x).filter(c => c.cat !== "none");
  const catLine = cats.length >= 2
    ? `<ul class="xv-list">${cats.map(c => `
        <li class="xv-li"><span class="xv-cat">${catGlyph(catOf(c.cat))}</span>
          <span class="xv-name">${esc(catOf(c.cat).label)}</span>
          <span class="xv-amt">${fmtMoney(c.cents, cur)}</span></li>`).join("")}</ul>`
    : "";
  const catTxt = cats.length === 1 ? `${catOf(cats[0].cat).icon} ${catOf(cats[0].cat).label}` : "";
  const hora = x.expense_time ? ` · ${x.expense_time.slice(0, 5)}` : "";

  slot.innerHTML = `
    <div class="expense-detail xp">
      <header class="xp-head">
        <div class="xp-head-bar">
          <button type="button" class="xp-icon-btn" id="xv-back" aria-label="Fechar">${uiIco("x")}</button>
          <span class="xp-head-title">${x.recurring_id ? "Despesa recorrente" : "Despesa"}</span>
          <span class="xp-head-spacer"></span>
        </div>
        <div class="xv-amount">${fmtMoney(toCents(x.amount), cur)}</div>
        <p class="xv-desc">${esc(x.description)}</p>
        <p class="xp-quando">${esc(fmtDate(x.expense_date) + hora)}${catTxt ? ` · ${esc(catTxt)}` : ""}</p>
      </header>
      <div class="xp-body">
        ${own ? "" : `
        <h3 class="xv-h">Quem pagou</h3>
        <ul class="xv-list">${payers.map(p => pessoa(p.member_id, toCents(p.amount))).join("")}</ul>`}
        <h3 class="xv-h">Como se divide <span class="muted">· ${modoTxt}</span></h3>
        <ul class="xv-list">${shares.map(p => pessoa(p.member_id, toCents(p.amount))).join("")}</ul>
        ${catLine ? `<h3 class="xv-h">Categorias</h3>${catLine}` : ""}
        ${x.receipt_path ? `
        <h3 class="xv-h">Fatura</h3>
        <div class="xv-fatura" id="xv-fat"><span class="muted">A abrir a fatura…</span></div>` : ""}
      </div>
      ${canEdit ? `
      <footer class="xp-foot ai-foot">
        ${x.recurring_id ? "" : `<button class="secondary xv-ai" id="xv-ai">${uiIco("sparkle")} Alterar com IA</button>`}
        <button class="xp-cta" id="xv-edit">${uiIco("edit")} Editar</button>
      </footer>` : ""}
    </div>`;

  slot.classList.add("modal-card-flush");
  slot.parentElement?.classList.add("modal-full");
  slot.querySelector("#xv-back").onclick = closeModal;
  // a fatura chega por um link assinado: a imagem abre em tamanho real num
  // separador novo, o PDF no leitor do sistema
  const $fat = slot.querySelector("#xv-fat");
  if ($fat) {
    const falhou = () => { $fat.innerHTML = `<span class="muted">Não foi possível abrir a fatura.</span>`; };
    receiptUrl(x.receipt_path).then(url => {
      if (!$fat.isConnected) return;
      const abrir = `<a class="xv-fat-link" href="${esc(url)}" target="_blank" rel="noopener">${uiIco("doc")} Abrir a fatura${receiptIsPdf(x.receipt_path) ? " (PDF)" : ""}</a>`;
      if (receiptIsPdf(x.receipt_path)) { $fat.innerHTML = abrir; return; }
      $fat.innerHTML = `<a class="xv-fat-img" href="${esc(url)}" target="_blank" rel="noopener"
        title="Abrir em tamanho real"><img src="${esc(url)}" alt="Fatura de ${esc(x.description)}" /></a>`;
      // uma imagem que o browser não sabe mostrar (HEIC fora do Safari)
      // fica só com o link para a descarregar
      $fat.querySelector("img").onerror = () => { $fat.innerHTML = abrir; };
    }).catch(() => { if ($fat.isConnected) falhou(); });
  }
  const view = () => renderExpenseView(slot, ctx, x);
  // ✨ «Alterar com IA»: diz-se o que mudar e confirma-se o antes → depois
  const alterarIA = (onBack) => renderAiExpense(slot, { ctx, alterar: x, onClose: closeModal, onBack });
  const editar = () => {
    // o «Voltar» do formulário regressa a esta consulta
    renderExpenseForm(slot, ctx, x, view, {
      backLabel: "Voltar",
      ...(x.recurring_id ? {} : { onAi: () => alterarIA(editar) }),
    });
  };
  slot.querySelector("#xv-edit")?.addEventListener("click", editar);
  slot.querySelector("#xv-ai")?.addEventListener("click", () => alterarIA(view));
}
function openImportModal(ctx) {
  // o parser vive num ficheiro à parte: sem ele (versão em cache a meio de
  // uma atualização) não se abre o ecrã em vez de rebentar a meio
  if (typeof SWImport === "undefined") return toast("Recarrega a app para importar movimentos", true);
  renderImportForm(openModal(), ctx, closeModal);
}

// ---------------------------------------------------------------- faturas
// A fatura de uma despesa (fotografia do talão ou PDF) vive no bucket
// privado do Supabase Storage, em <group_id>/<expense_id>/<ficheiro>; a
// despesa guarda só o caminho (receipt_path). Vê-a quem tem acesso ao grupo
// e troca-a quem pode editar a despesa — as policies estão no schema.sql.
// Como o bucket é privado, a app mostra-a por um link assinado que dura uma
// hora.
const RECEIPT_BUCKET = "splitwisely-faturas";
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024; // o limite do bucket
const RECEIPT_MAX_PX = 2000;                // chega para ler um talão
const RECEIPT_EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "image/heic": "heic", "image/heif": "heif", "application/pdf": "pdf",
};

function receiptIsPdf(pathOrType) { return /pdf$/i.test(pathOrType || ""); }
function receiptFileOk(file) { return !!file && file.type in RECEIPT_EXT; }

// Uma fotografia de telemóvel tem 3 a 6 MB e 4000 px: para ler um talão
// chegam 2000 px em JPEG, que dá umas centenas de kB. Se o browser não a
// conseguir abrir (um HEIC fora do Safari, por exemplo) segue tal como está.
async function shrinkReceiptImage(file) {
  if (!file.type.startsWith("image/")) return file;
  let img = null, url = null;
  try {
    if (window.createImageBitmap) img = await createImageBitmap(file);
    else {
      url = URL.createObjectURL(file);
      img = await new Promise((ok, ko) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = ko;
        i.src = url;
      });
    }
    const w0 = img.width, h0 = img.height;
    const scale = Math.min(1, RECEIPT_MAX_PX / Math.max(w0, h0));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    const g = canvas.getContext("2d");
    // um PNG com transparência ficava com o fundo preto em JPEG
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(ok => canvas.toBlob(ok, "image/jpeg", 0.82));
    return blob && blob.size < file.size ? blob : file;
  } catch (_) {
    return file;
  } finally {
    img?.close?.();
    if (url) URL.revokeObjectURL(url);
  }
}

// Envia a fatura e devolve o caminho onde ficou. A despesa tem de existir
// já: é por ela que o servidor decide se se pode escrever ali.
async function uploadReceipt(groupId, expenseId, file) {
  const blob = await shrinkReceiptImage(file);
  if (blob.size > RECEIPT_MAX_BYTES) throw new Error("o ficheiro passa dos 10 MB");
  const type = blob.type || file.type;
  const path = `${groupId}/${expenseId}/fatura-${Date.now()}.${RECEIPT_EXT[type] || "jpg"}`;
  const { error } = await sb.storage.from(RECEIPT_BUCKET)
    .upload(path, blob, { contentType: type, cacheControl: "31536000", upsert: false });
  if (error) throw error;
  return path;
}

// Apaga o ficheiro. Não trava nada se falhar: o pior que fica é um ficheiro
// perdido no bucket, sem despesa a apontar para ele.
async function removeReceipt(path) {
  if (!path || !sb) return;
  const { error } = await sb.storage.from(RECEIPT_BUCKET).remove([path]);
  if (error) console.warn("fatura:", error.message);
}

// Link assinado (1 hora), guardado uns minutos para reabrir a mesma fatura
// sem voltar a pedir outro
const receiptUrls = new Map();
async function receiptUrl(path) {
  const hit = receiptUrls.get(path);
  if (hit && hit.until > Date.now()) return hit.url;
  const { data, error } = await sb.storage.from(RECEIPT_BUCKET).createSignedUrl(path, 3600);
  if (error) throw error;
  receiptUrls.set(path, { url: data.signedUrl, until: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
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

// "2026-08-25" -> "25 ago" (etiquetas curtas nos atalhos de data)
function fmtDiaMes(d) {
  if (!d) return "";
  const dt = new Date(d + "T00:00:00");
  return `${dt.getDate()} ${dt.toLocaleDateString("pt-PT", { month: "short" }).replace(/\.$/, "")}`;
}

// "Maria Costa Santos" -> "Maria S." (para linhas compactas)
function shortName(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

// Avatar redondo com iniciais, cor estável derivada do nome
// (tons do azulejo, todos com contraste para as iniciais a branco)
const AVATAR_COLORS = ["#2b44c4", "#b4462f", "#127368", "#9a6412", "#6d3fb8",
  "#1d6a8c", "#a8325e", "#3f6212", "#4338ca", "#b45309"];
function avatarHtml(name, extra = "") {
  const parts = String(name || "?").trim().split(/\s+/);
  const initials = ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  let h = 0;
  for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="avatar ${extra}" style="background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}">${esc(initials)}</span>`;
}

// Avatares sobrepostos (até `max`, depois «+N»)
function avatarStackHtml(names, max = 3, extra = "") {
  const shown = names.slice(0, max).map(n => avatarHtml(n, extra)).join("");
  const more = names.length - max;
  return `<span class="avatar-stack">${shown}${more > 0
    ? `<span class="avatar avatar-more ${extra}">+${more}</span>` : ""}</span>`;
}

// Nomes curtos: só o primeiro nome, a não ser que haja mais do que um
// «João» no grupo — aí juntam-se nomes até se distinguirem («João Paulo»
// e «João Pedro»), em vez de abreviar para iniciais iguais
function nomesCurtos(members) {
  const words = n => String(n || "?").trim().split(/\s+/);
  const names = [...new Set(members.map(m => String(m.name || "?").trim()))];
  const map = new Map();
  for (const name of names) {
    const w = words(name);
    const rivals = names.filter(o => o !== name && words(o)[0].toLowerCase() === w[0].toLowerCase());
    let k = 1;
    while (k < w.length && rivals.some(o =>
      words(o).slice(0, k).join(" ").toLowerCase() === w.slice(0, k).join(" ").toLowerCase())) k++;
    // «Maria Costa Santos» vs «Maria Costa Silva»: basta o primeiro e o
    // último quando o último os distingue
    const firstLast = w.length > 2 ? `${w[0]} ${w[w.length - 1]}` : null;
    const shortened = w.slice(0, k).join(" ");
    map.set(name, k > 2 && firstLast && !rivals.some(o => {
      const ow = words(o); return `${ow[0]} ${ow[ow.length - 1]}`.toLowerCase() === firstLast.toLowerCase();
    }) ? firstLast : shortened);
  }
  return n => map.get(String(n || "?").trim()) ?? words(n)[0];
}

// Ícones da interface (traço, herdam a cor). O emoji fica só nas
// categorias, onde é conteúdo.
const UI_ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  filter: '<path d="M4 6.5h16M7 12h10M10 17.5h4"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  clipboard: '<path d="M9 4h6v3H9z"/><path d="M15 5.5h2.5A1.5 1.5 0 0 1 19 7v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V7a1.5 1.5 0 0 1 1.5-1.5H9"/><path d="M8.5 12h7"/><path d="M8.5 15.5h4.5"/>',
  receipt: '<path d="M6 3.5h12a1 1 0 0 1 1 1v16l-2.5-1.5-2.5 1.5-2-1.5-2 1.5-2.5-1.5L5 20.5v-16a1 1 0 0 1 1-1z"/><path d="M9 8.5h6M9 12h6"/>',
  scale: '<path d="M12 4v16M8 20h8M5 7h14"/><path d="M5 7l-2.5 6a2.5 2.5 0 0 0 5 0zM19 7l-2.5 6a2.5 2.5 0 0 0 5 0z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  logout: '<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M10 16l-4-4 4-4"/><path d="M6 12h10"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/>',
  doc: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5M9 13h6M9 16.5h4"/>',
  repeat: '<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.6"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  clip: '<path d="m20.5 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/>',
  sparkle: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  camera: '<path d="M4.5 7.5h3l1.6-2.5h5.8l1.6 2.5h3A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V9a1.5 1.5 0 0 1 1.5-1.5Z"/><circle cx="12" cy="13.3" r="3.6"/>',
};
function uiIco(name, cls = "") {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI_ICONS[name]}</svg>`;
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

// ---------------------------------------------------------------- notificações push
// Web Push (Notification/Push API), sem servidor próprio de mensagens: o
// browser gera uma "subscription" (endpoint+chaves) que se guarda em
// push_subscriptions, ligada à CONTA (user_id) que a ativou. A Edge
// Function push-notificar-splitwisely resolve os destinatários por
// user_id e manda o push a cada dispositivo subscrito.
//
// Um disparo, chamado depois de gravar uma despesa NOVA (doSave, mais
// abaixo): avisa quem foi AFETADO — pagou algo ou ficou a dever algo — e
// não foi quem a lançou. Fire-and-forget: nunca atrasa nem faz falhar a
// gravação da despesa.
//
// Sem a migração (tabela push_subscriptions em falta) ou sem suporte do
// browser, tudo isto degrada em silêncio (catch) — a app funciona à
// mesma, só sem notificações.

// Par de chaves só para Web Push (não é a chave do Supabase) — o mesmo
// par usado pelas outras apps deste projeto Supabase partilhado
// (FestasBV, SplitBill); não precisa de se repetir por app, só o secret
// VAPID_PRIVATE_KEY do lado da Edge Function.
const VAPID_PUBLIC_KEY = "BFiwf_z5NJzkXFP6gzxS_naH9cNC2MfCEmejJf32MID8Y_1i49cb8sGINYhH-aFAZmFQLf3V__2ZyeotQIZYQ0U";

// A app instalada no ecrã principal (PWA "standalone")? No iOS, Web Push
// só existe nesse modo — numa aba normal do Safari o PushManager nem
// existe, por mais atualizado que o iOS esteja.
function emStandalone() {
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
    || window.navigator.standalone === true;
}
function pushSuportado() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function pushSubscricaoAtual() {
  if (!pushSuportado()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch (_) { return null; }
}
async function pushAtivar() {
  if (!pushSuportado()) { toast("Este browser não suporta notificações push", true); return false; }
  if (!session) return false;
  try {
    const permissao = await Notification.requestPermission();
    if (permissao !== "granted") { toast("Permissão de notificações recusada", true); return false; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    const js = sub.toJSON();
    const { error } = await sb.from("push_subscriptions").upsert({
      endpoint: sub.endpoint,
      user_id: session.user.id,
      p256dh: js.keys.p256dh,
      auth_key: js.keys.auth,
    }, { onConflict: "endpoint" });
    if (error) throw error;
    toast("✓ Notificações ativadas neste dispositivo");
    return true;
  } catch (e) {
    toast("Não foi possível ativar as notificações: " + e.message, true);
    return false;
  }
}
async function pushDesativar() {
  try {
    const sub = await pushSubscricaoAtual();
    if (sub) {
      await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      await sub.unsubscribe();
    }
    toast("Notificações desativadas neste dispositivo");
  } catch (_) { /* melhor deixar como está do que falhar a meio */ }
}

// Chama a Edge Function push-notificar-splitwisely — o texto da
// notificação escolhe-se sempre no servidor (por `tipo`), nunca vem
// livre do cliente; aqui só se manda o que o servidor precisa de saber
// (nomes já resolvidos, valores, destinatários).
async function sbEnviarPush(tipo, payload) {
  if (!session) return null;
  try {
    const { data, error } = await sb.functions.invoke("push-notificar-splitwisely", {
      body: { tipo, ...payload },
    });
    if (error) { console.warn("push:", error.message); return null; }
    return data;
  } catch (e) { console.warn("push:", e.message); return null; }
}

// Sugestão automática de ativação, logo a seguir ao login (chamada de
// runStartupChores). Não é "obrigatório" no sentido técnico — nenhum
// browser deixa um site ativar notificações sem um clique do utilizador
// — mas isto tira o clique de ter de descobrir o botão nas Definições, e
// volta a perguntar em toda a abertura da app enquanto a pessoa não
// decidir («Agora não»/«Ativar»). Permissão já concedida (por este
// caminho ou por outro) subscreve logo, sem mostrar nada; já recusada, o
// browser nem deixava voltar a perguntar, por isso também não se mostra
// nada.
async function pushSugerirAtivacao() {
  if (!pushSuportado()) return;
  if (Notification.permission === "denied") return;
  if (Notification.permission === "granted") {
    const sub = await pushSubscricaoAtual();
    if (!sub) await pushAtivar();
    return;
  }
  if ($modal) return; // não interromper um pop-up já aberto
  const avisoIOS = !emStandalone() && /iPhone|iPad|iPod/.test(navigator.userAgent);
  const $c = openModal();
  $c.innerHTML = `
    <h2 style="margin:0 0 .5rem;">🔔 Ativar notificações?</h2>
    <p class="muted">Recebe um aviso quando alguém lançar uma despesa em que estejas incluído
      (pagaste algo ou ficaste a dever algo) e que não tenhas sido tu a lançar.</p>
    ${avisoIOS ? `<p class="muted">No iPhone/iPad só funciona depois de instalares a app no ecrã
      principal (Partilhar → Adicionar ao Ecrã Principal).</p>` : ""}
    <div class="row" style="margin-top:1rem;">
      <button class="secondary" id="push-prompt-no">Agora não</button>
      <button id="push-prompt-yes">🔔 Ativar</button>
    </div>`;
  $c.querySelector("#push-prompt-no").onclick = closeModal;
  $c.querySelector("#push-prompt-yes").onclick = async () => { await pushAtivar(); closeModal(); };
}

// Ecrã de Conta — acessível pelo botão ⚙️ na barra de topo. Por agora só
// tem as notificações push; é o sítio onde caberia crescer com mais
// preferências pessoais no futuro.
async function openAccountModal() {
  const $c = openModal();
  const draw = async () => {
    const suportado = pushSuportado();
    const sub = suportado ? await pushSubscricaoAtual() : null;
    const ativo = !!sub;
    const u = session.user;
    const nota = !suportado
      ? (/iPhone|iPad|iPod/.test(navigator.userAgent) && !emStandalone()
          ? "No iPhone/iPad só funciona depois de instalares a app no ecrã principal (Partilhar → Adicionar ao Ecrã Principal)."
          : "Este browser não suporta notificações push.")
      : "Recebe um aviso quando alguém lançar uma despesa que te afete (pagaste algo ou ficaste a dever algo) e que não tenhas sido tu a lançar.";
    $c.innerHTML = `
      <h2 style="margin:0 0 .3rem;">Conta</h2>
      <p class="muted" style="margin-bottom:1rem;">${esc(u.user_metadata?.full_name || u.email)} · ${esc(u.email)}</p>
      <label class="toggle-card ${ativo ? "on" : ""}">
        <span class="toggle-card-ico" aria-hidden="true">🔔</span>
        <span class="toggle-card-body">
          <span class="toggle-card-title">Notificações push</span>
          <span class="toggle-card-note">${nota}</span>
        </span>
        ${suportado ? `
        <span class="switch">
          <input type="checkbox" id="push-switch" ${ativo ? "checked" : ""} />
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </span>` : ""}
      </label>
      <div class="modal-actions">
        <button class="secondary" id="account-close">Fechar</button>
        <button class="danger" id="account-logout">${uiIco("logout")} Sair da conta</button>
      </div>`;
    $c.querySelector("#account-close").onclick = closeModal;
    $c.querySelector("#account-logout").onclick = async () => {
      closeModal();
      await sb.auth.signOut();
      location.hash = "#/";
    };
    const $sw = $c.querySelector("#push-switch");
    if ($sw) $sw.onchange = async () => {
      $sw.disabled = true;
      if ($sw.checked) await pushAtivar(); else await pushDesativar();
      await draw();
    };
  };
  await draw();
}

// Depois de gravar uma despesa NOVA (nunca ao editar, nem numa ocorrência
// gerada sozinha por uma série recorrente): avisa quem foi afetado e não
// foi quem a lançou — pagou algo (payerRows) ou ficou a dever algo
// (shareRows). Fire-and-forget.
async function notifyExpenseAdded(group, members, desc, totalCents, payerRows, shareRows) {
  try {
    const myUid = session.user.id;
    const byId = new Map(members.map(m => [m.id, m]));
    const payerNames = payerRows.map(r => byId.get(r.member_id)?.name).filter(Boolean);
    const shareIds = shareRows.map(r => r.member_id);
    const shareIdSet = new Set(shareIds);

    const affectedIds = new Set([...payerRows.map(r => r.member_id), ...shareIds]);
    const pessoas = [...affectedIds]
      .map(id => byId.get(id))
      .filter(m => m && m.user_id && m.user_id !== myUid)
      .map(m => ({
        user_id: m.user_id,
        isOwer: shareIdSet.has(m.id),
        // as outras pessoas da divisão, à parte deste destinatário — é o
        // que deixa o servidor nomeá-las em vez de só contar (ver a Edge
        // Function, splitClause)
        outrosNomes: shareIds.filter(id => id !== m.id).map(id => byId.get(id)?.name).filter(Boolean),
      }));
    if (!pessoas.length) return;

    await sbEnviarPush("despesa_adicionada", {
      group_id: group.id,
      descricao: desc,
      valor: totalCents / 100,
      moeda: group.currency,
      payerNames,
      totalPessoas: shareIds.length,
      pessoas,
    });
  } catch (e) { console.warn("notifyExpenseAdded:", e); }
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
    // «cada um pagou o seu» é só registo: ninguém fica a dever a ninguém.
    // (Gravam-se pagos = quotas, que já dava zero; saltar é a garantia.)
    if (x.split_mode === "own") continue;
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

// ------------------------------------------------------------ permissões
// O que a conta ligada a um membro pode fazer no grupo (coluna
// group_members.role). O default é 'write_all' (edita tudo), para o
// comportamento de sempre; a RLS no schema é que impõe isto no servidor.
const MEMBER_ROLES = {
  read:      { label: "Só leitura",                  short: "Leitura",  icon: "👁️" },
  write_own: { label: "Lança e edita só as suas despesas", short: "Próprias", icon: "✏️" },
  write_all: { label: "Lança e edita todas as despesas",   short: "Todas",    icon: "🛠️" },
};

// ---------------------------------------------------------------- categorias
// Lista fixa de categorias de despesa, cada uma com um ícone simples.
// Na base de dados grava-se só o id (coluna expenses.category, nullable).
// tone: a cor do quadrado onde o ícone aparece nas listas (ver .ct-* no CSS)
const CATEGORIES = [
  { id: "talho",       label: "Talho",       icon: "🥩", tone: "rose" },
  { id: "peixe",       label: "Peixe",       icon: "🐟", tone: "sky" },
  { id: "mercearia",   label: "Mercearia",   icon: "🛒", tone: "teal" },
  { id: "padaria",     label: "Padaria",     icon: "🥖", tone: "sand" },
  { id: "cafe",        label: "Café",        icon: "☕", tone: "sand" },
  { id: "restaurante", label: "Restaurante", icon: "🍽️", tone: "rose" },
  { id: "entradas",    label: "Entradas",    icon: "🧀", tone: "sand" },
  { id: "bebidas",     label: "Bebidas",     icon: "🍺🍷", tone: "berry", duo: true },
  { id: "sobremesas",  label: "Sobremesas",  icon: "🍰", tone: "berry" },
  { id: "teatro",      label: "Teatro",      icon: "🎭", tone: "violet" },
  { id: "cinema",      label: "Cinema",      icon: "🎬", tone: "violet" },
  { id: "noite",       label: "Vida noturna", icon: "🪩", tone: "cobalt" },
  { id: "prendas",     label: "Prendas",     icon: "🎁", tone: "berry" },
  { id: "filhos",      label: "Filhos",      icon: "🧸", tone: "sky" },
  { id: "roupa",       label: "Roupa",       icon: "👕", tone: "violet" },
  { id: "bricolage",   label: "Bricolage",   icon: "🔨", tone: "sand" },
  { id: "mobiliario",  label: "Mobiliário",  icon: "🛋️", tone: "teal" },
  { id: "casa",        label: "Casa",        icon: "🏠", tone: "teal" },
  { id: "utensilios",  label: "Utensílios",  icon: "🍴", tone: "cobalt" },
  { id: "limpeza",     label: "Limpeza",     icon: "🧼", tone: "sky" },
  { id: "saude",       label: "Saúde",       icon: "💊", tone: "teal" },
  { id: "transportes", label: "Transportes", icon: "🚗", tone: "cobalt" },
  { id: "viagens",     label: "Viagens",     icon: "✈️", tone: "ochre" },
  { id: "animais",     label: "Animais",     icon: "🐾", tone: "sand" },
  { id: "outros",      label: "Outros",      icon: "📦", tone: "slate" },
];

function catOf(id) { return CATEGORIES.find(c => c.id === id) || null; }

// O emoji da categoria dentro de um azulejo. Um ícone de dois emojis
// (duo, ex.: Bebidas 🍺🍷) vai mais pequeno e encavalitado (.cat-duo),
// para caber no mesmo quadrado que os outros; em texto corrido usa-se
// c.icon tal e qual.
function catGlyph(c) {
  return c.duo ? `<span class="cat-duo">${[...c.icon].map(g => `<span>${g}</span>`).join("")}</span>` : c.icon;
}

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
  return `<span class="cat-ico ct-${c.tone} ${extra}" title="${esc(c.label)}">${catGlyph(c)}</span>`;
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

// A parte exata (cêntimos fracionários) de um membro numa despesa, repartida
// pelas categorias (Map cat -> cêntimos). Com divisão por categoria conta o
// valor de cada categoria em que participa ÷ nº de participantes (o mesmo
// critério de exactShareCents); senão, a sua parte total distribui-se pelas
// partes da fatura na proporção do valor de cada uma. Soma sempre o mesmo
// que exactShareCents(x).get(memberId).
function memberCatShareCents(x, memberId) {
  const out = new Map();
  const add = (cat, v) => {
    const k = catOf(cat) ? cat : "none";
    out.set(k, (out.get(k) || 0) + v);
  };
  const catShares = x.expense_category_shares || [];
  const cats = x.expense_categories || [];
  if (catShares.length && cats.length) {
    const catTotal = new Map(cats.map(c => [c.category, toCents(c.amount)]));
    const partsByCat = new Map();
    for (const r of catShares) {
      if (!partsByCat.has(r.category)) partsByCat.set(r.category, []);
      partsByCat.get(r.category).push(r.member_id);
    }
    let used = false;
    for (const [cat, ids] of partsByCat) {
      const amt = catTotal.get(cat);
      if (amt == null || ids.length === 0) continue;
      used = true;
      if (ids.includes(memberId)) add(cat, amt / ids.length);
    }
    if (used) return out;
  }
  const mine = exactShareCents(x).get(memberId) || 0;
  if (!mine) return out;
  const splits = expenseCatSplits(x);
  const tot = splits.reduce((a, s) => a + s.cents, 0);
  if (tot <= 0) { add(splits[0].cat, mine); return out; }
  for (const s of splits) add(s.cat, mine * s.cents / tot);
  return out;
}

// Ícone da despesa nas listas: o da categoria principal, com um contador
// por cima quando a fatura está repartida por várias
function expenseCatIconHtml(x, extra = "") {
  const splits = expenseCatSplits(x).filter(s => s.cat !== "none");
  if (splits.length < 2) return catIconHtml(x.category, extra);
  const prim = catOf(x.category) || catOf(splits[0].cat);
  const labels = splits.map(s => catOf(s.cat).label).join(" + ");
  return `<span class="cat-ico multi ct-${prim.tone} ${extra}" title="${esc(labels)}">${catGlyph(prim)}<span class="cat-multi-badge">${splits.length}</span></span>`;
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
  noite:       ["noite", "noitada", "discoteca", "discotecas", "disco", "bar", "bares", "pub", "pubs", "club", "clube", "festa", "festas", "shot", "shots", "cocktail", "cocktails", "lounge", "karaoke", "danca", "rave", "bengaleiro"],
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
      <div class="brand-big">
        <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M10.6 2.6a8.4 8.4 0 0 0 0 16.8z" fill="currentColor"/><path d="M13.4 5.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" opacity=".55"/></svg></span>
        <h1>SplitWisely</h1>
      </div>
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
  const avatar = u.user_metadata?.avatar_url;
  // a fotografia da conta Google é o próprio botão da Conta (sem ela, uma
  // silhueta — a roda dentada fica para as Definições do grupo); o «Sair»
  // vive lá dentro, no ecrã da Conta
  $topbarUser.innerHTML = `
    ${profile?.is_admin ? `<button type="button" class="hero-btn round" id="btn-admin" aria-label="Admin" title="Admin">${uiIco("shield")}</button>` : ""}
    <button type="button" class="hero-btn round account-btn" id="btn-account" aria-label="Conta e notificações" title="Conta e notificações">
      ${avatar ? `<img src="${esc(avatar)}" alt="" referrerpolicy="no-referrer" />` : uiIco("user")}
    </button>`;
  document.getElementById("btn-account").onclick = () => openAccountModal();
  document.getElementById("btn-admin")?.addEventListener("click", () => {
    location.hash = "#/admin";
  });
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
    if (canUse()) {
      toast("Conta aprovada 🎉");
      await route();
      // acabou de ganhar acesso: agora sim, ligar convites e gerar recorrentes
      choresRun = false;
      runStartupChores();
    } else toast("Ainda não foi aprovada");
  };
  document.getElementById("btn-waiting-logout").onclick = async () => {
    await sb.auth.signOut();
    location.hash = "#/";
  };
}

// ---------------------------------------------------------------- dados

// ---- o que o cálculo de saldos precisa de ler ----------------------------
// O exactShareCents() escolhe o ramo de cálculo consoante os campos que a
// despesa traz: com a divisão por categoria recalcula a fração exata de cada
// pessoa; sem ela cai nos cêntimos gravados (já arredondados). Ou seja, duas
// vistas que peçam colunas diferentes calculam saldos diferentes para as
// MESMAS despesas — era o que acontecia entre a home e a página do grupo.
//
// Por isso a lista de tabelas-filhas vive aqui, num sítio só, e as duas
// vistas usam-na. Os níveis existem apenas para degradar em schemas antigos
// que ainda não tenham as tabelas da divisão por categoria — e degradam da
// mesma maneira nos dois lados, portanto continuam a bater certo.
const BALANCE_JOINS = [
  "expense_payers(member_id, amount), expense_shares(member_id, amount)",
  "expense_categories(category, amount)",
  "expense_category_shares(category, member_id, amount)",
];
function balanceJoins(level) {
  return BALANCE_JOINS.slice(0, level + 1).join(", ");
}

// Corre uma query de despesas descendo de escalão quando o schema ainda não
// tem as tabelas da divisão por categoria (ou a coluna split_mode).
// `build(level, withMode)` devolve a query pronta a aguardar.
async function selectExpensesDegrading(build) {
  let r = await build(2, true);
  if (r.error && /expense_category_shares/i.test(r.error.message)) r = await build(1, true);
  if (r.error && /expense_categories/i.test(r.error.message)) r = await build(0, true);
  // sem split_mode as despesas caem no modo 'exact' (valores gravados) — nas
  // duas vistas ao mesmo tempo, porque nenhuma delas passa a ter a coluna
  if (r.error && /split_mode/i.test(r.error.message)) r = await build(0, false);
  return r;
}

// Traz TODAS as linhas de uma query, aos pedaços. O PostgREST corta a
// resposta no `max-rows` do projeto sem dar erro — e um corte silencioso a
// meio das despesas dava saldos errados, diferentes entre a home (que pede
// as despesas de todos os grupos de uma vez, logo bate no limite muito
// antes) e a página do grupo.
//
// INVARIANTE: PAGE tem de ser MENOR do que o `max-rows` configurado no
// Supabase (hoje 10000). A paragem do ciclo é "veio menos do que pedi, logo
// acabou" — se PAGE fosse igual ou maior que o max-rows, uma página cheia
// cortada pelo servidor parecia o fim dos dados e voltávamos a truncar em
// silêncio. Se algum dia baixares o max-rows abaixo de 5000, baixa isto
// também. Com 5000 a esmagadora maioria dos casos resolve-se num só pedido.
const PAGE = 5000;
async function fetchAllRows(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const r = await build(from, from + PAGE - 1);
    if (r.error) return { data: null, error: r.error };
    out.push(...r.data);
    if (r.data.length < PAGE) return { data: out, error: null };
  }
}

async function fetchGroups() {
  const { data, error } = await sb.from("groups")
    .select("*").order("created_at", { ascending: false });
  if (error) throw error;
  cache.groups = data;
  return data;
}

// ---- movimentos por ver ---------------------------------------------------
// A lista de despesas assinala o que apareceu ou mudou desde a última vez
// que ESTA pessoa consultou ESTE grupo. O carimbo dessa consulta vive em
// group_reads (uma linha por pessoa e grupo — ver schema.sql).
//
// O carimbo é escrito à ENTRADA do grupo, mas os selos têm de aguentar-se
// durante toda a visita: cada gravação chama refresh(), que deita fora a
// cache do grupo e volta a ler tudo — e leria já o carimbo novo. Por isso o
// valor da visita fica aqui em memória e é ele que manda enquanto se está
// dentro do grupo. Fechar a app a meio da visita não perde nada: o carimbo
// já foi escrito à entrada.
let groupSeen = { id: null, ts: null };

// Marca o grupo como visto agora. Ninguém espera por isto: se falhar (rede
// em baixo, schema por atualizar) o pior que acontece é os mesmos
// movimentos voltarem a aparecer assinalados na próxima visita.
//
// O carimbo é 'now' — o literal do Postgres para o instante da transação —
// e não a hora deste dispositivo: é com as datas das despesas que ele vai
// ser comparado, e essas vêm do relógio do servidor. Um telemóvel com a
// hora adiantada dez minutos deixaria de assinalar o que se passou nesses
// dez minutos.
function markGroupSeen(groupId, bundle) {
  sb.from("group_reads")
    .upsert({ user_id: session.user.id, group_id: groupId, last_seen_at: "now" },
            { onConflict: "user_id,group_id" })
    .select("last_seen_at").single()
    .then(({ data, error }) => {
      if (error) { console.warn("group_reads:", error.message); return; }
      // a cache do grupo sobrevive à ida à home e volta: sem atualizar aqui o
      // carimbo, reentrar no grupo assinalava outra vez os mesmos movimentos
      if (data) bundle.lastSeen = Date.parse(data.last_seen_at) || bundle.lastSeen;
    });
}

async function fetchGroupBundle(groupId) {
  // as colunas do cálculo vêm do balanceJoins() — as mesmas que a home usa
  const expenseSelect = (level) =>
    fetchAllRows((from, to) =>
      sb.from("expenses").select(`*, ${balanceJoins(level)}`)
        .eq("group_id", groupId)
        .order("expense_date", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id")                       // desempate estável para a paginação
        .range(from, to));
  let [g, m, e, p, r, s] = await Promise.all([
    sb.from("groups").select("*").eq("id", groupId).single(),
    fetchAllRows((from, to) =>
      sb.from("group_members").select("*").eq("group_id", groupId)
        .order("created_at").order("id").range(from, to)),
    selectExpensesDegrading(expenseSelect),
    fetchAllRows((from, to) =>
      sb.from("payments").select("*").eq("group_id", groupId)
        .order("payment_date", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)),
    sb.from("recurring_expenses")
      .select("*, recurring_expense_payers(member_id, amount), recurring_expense_shares(member_id, amount)")
      .eq("group_id", groupId)
      .order("created_at"),
    sb.from("group_reads").select("last_seen_at")
      .eq("group_id", groupId).eq("user_id", session.user.id).maybeSingle(),
  ]);
  for (const rr of [g, m, e]) if (rr.error) throw rr.error;
  // payments e recurring podem ainda não existir (schema antigo por atualizar):
  // degrada sem partir a app, só sem essas funcionalidades.
  if (p.error) console.warn("payments indisponível:", p.error.message);
  if (r.error) console.warn("recurring indisponível:", r.error.message);
  if (s.error) console.warn("group_reads indisponível:", s.error.message);
  // dentro do mesmo dia, a mais recente primeiro: pela hora da despesa ou,
  // sem hora, pela hora a que foi registada
  const horaDe = x => x.expense_time
    || new Date(x.created_at).toTimeString().slice(0, 8);
  e.data.sort((a, b) => a.expense_date !== b.expense_date
    ? (a.expense_date < b.expense_date ? 1 : -1)
    : horaDe(b).localeCompare(horaDe(a)));
  return {
    group: g.data, members: m.data, expenses: e.data,
    payments: p.error ? [] : p.data,
    paymentsReady: !p.error,
    recurring: r.error ? [] : r.data,
    recurringReady: !r.error,
    // null = primeira consulta deste grupo (ou schema antigo): nada a assinalar
    lastSeen: s.error ? null : (Date.parse(s.data?.last_seen_at) || null),
  };
}

// ---------------------------------------------------------------- router
function canUse() {
  return !!(profile && (profile.is_approved || profile.is_admin));
}

// Ecrã de arranque (cobalto, a full-screen). Fica visível enquanto os dados
// carregam e some assim que a primeira vista fica pronta.
function showSplash() { document.getElementById("splash")?.classList.remove("splash-out"); }
function hideSplash() { document.getElementById("splash")?.classList.add("splash-out"); }

async function route() {
  closeModal();
  try {
    // link público de consulta (#/p/<token>): abre com ou sem sessão — quem
    // o recebe não precisa de conta (ver renderPublicGroup)
    const mPub = (location.hash || "").match(/^#\/p\/([\w-]+)(?:\/(\w+))?/);
    if (mPub) {
      groupSeen = { id: null, ts: null };
      renderTopbar();
      try {
        await renderPublicGroup(mPub[1], mPub[2]);
      } catch (err) {
        console.error(err);
        $app.innerHTML = `<div class="card public-dead">
          <div class="public-dead-ico">📡</div>
          <h1>Não deu para abrir o link</h1>
          <p class="muted">${esc(err.message || err)}</p>
          <button class="secondary" onclick="location.reload()">Tentar novamente</button></div>`;
      }
      return;
    }
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
    // sair do grupo fecha a visita: voltar a entrar volta a carimbar e a
    // assinalar só o que mudou entretanto
    if (groupSeen.id && groupSeen.id !== mGroup?.[1]) groupSeen = { id: null, ts: null };
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
// A RLS filtra pelos grupos a que tem acesso.
//
// As despesas são pedidas com EXATAMENTE as mesmas tabelas-filhas que a
// página do grupo (balanceJoins) e passam pelo mesmo groupBalancesCents():
// para o mesmo universo de despesas, o saldo que aparece aqui é o mesmo que
// aparece lá dentro. Antes faltavam aqui as tabelas da divisão por categoria
// e essas despesas eram somadas pelos cêntimos já arredondados — o desvio
// acumulava despesa após despesa e as duas vistas divergiam.
async function fetchMyGroupBalances() {
  const uid = session.user.id;
  const expenseSelect = (level, withMode) =>
    fetchAllRows((from, to) =>
      sb.from("expenses")
        .select(`group_id, created_at, amount${withMode ? ", split_mode" : ""}, ${balanceJoins(level)}`)
        .order("id")                       // desempate estável para a paginação
        .range(from, to));
  const [m, e, p] = await Promise.all([
    // paginado como o resto: o roundPreservingSum final corre sobre os
    // membros do grupo, e uma lista truncada dava saldos errados
    fetchAllRows((from, to) =>
      sb.from("group_members").select("id, group_id, user_id, name").order("id").range(from, to)),
    selectExpensesDegrading(expenseSelect),
    fetchAllRows((from, to) =>
      sb.from("payments").select("group_id, created_at, from_member, to_member, amount")
        .order("id").range(from, to)),
  ]);
  if (m.error || e.error) return { balances: {}, activity: {}, people: {} };
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
  // nomes de quem está em cada grupo, para os avatares dos cards da home
  // (pela ordem de entrada — o PostgREST devolve-os ordenados pelo id)
  const people = {};
  for (const [gid, rows] of gMembers)
    people[gid] = [...rows].sort((x, y) => (y.user_id === uid) - (x.user_id === uid)).map(r => r.name);
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
  return { balances, activity, people };
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
  const [groups, { balances, activity, people }] = await Promise.all([fetchGroups(), fetchMyGroupBalances()]);
  let othersOpen = false;
  let archivedOpen = false;

  const lastAct = (g) => activity[g.id] || Date.parse(g.created_at) || 0;

  // saldo à direita de cada grupo: valor em cima, verbo por baixo (compacto)
  const balanceHtml = (g) => {
    const b = balances[g.id];
    if (b === undefined) return "";
    if (b === 0) return `<span class="item-amount zero">em dia</span>`;
    return `<span class="item-amount ${b > 0 ? "positive" : "negative"}">${fmtMoney(Math.abs(b), g.currency)}</span>
      <span class="bal-label">${b > 0 ? "recebes" : "deves"}</span>`;
  };

  // grupos ativos vs em histórico (arquivados). Os ativos aparecem em cards
  // (destaque) + «Outros grupos»; os arquivados numa lista compacta à parte.
  const activeGroups = groups.filter(g => !g.archived);
  const archivedGroups = groups.filter(g => g.archived);

  // resumo global (soma apenas grupos ativos na mesma moeda, a do 1.º com saldo)
  const mainCur = activeGroups.find(g => balances[g.id])?.currency || "EUR";
  const sameCur = activeGroups.filter(g => g.currency === mainCur && balances[g.id] !== undefined);
  const totPos = sameCur.reduce((a, g) => a + Math.max(balances[g.id], 0), 0);
  const totNeg = sameCur.reduce((a, g) => a - Math.min(balances[g.id], 0), 0);
  const net = totPos - totNeg;
  // cabeçalho cobalto: o saldo global em grande, a receber e a dever por baixo
  const hero = `
    <section class="hero home-hero">
      <p class="hero-label">${activeGroups.length
        ? `Saldo global · ${activeGroups.length} grupo${activeGroups.length === 1 ? "" : "s"} ativo${activeGroups.length === 1 ? "" : "s"}`
        : "Saldo global"}</p>
      <div class="hero-amount">${net > 0 ? "+" : net < 0 ? "−" : ""}${fmtMoney(Math.abs(net), mainCur)}</div>
      <div class="hero-stats">
        <div class="hero-stat"><span>A receber</span><strong>${fmtMoney(totPos, mainCur)}</strong></div>
        <div class="hero-stat"><span>A dever</span><strong>${fmtMoney(totNeg, mainCur)}</strong></div>
      </div>
    </section>`;

  // cada grupo tem o seu azulejo: cor e padrão estáveis, tirados do id
  const tileOf = (id) => {
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const mix = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; // baralha os bits
    return `tone-${h % 6} motif-${(mix >>> 13) % 4}`;
  };

  function draw() {
    // até 4 cards em destaque: primeiro os favoritos, depois os grupos
    // com movimentos mais recentes; o resto fica atrás de «Outros grupos».
    // Os grupos em histórico não entram nos destaques — vão para a lista
    // «Histórico» no fim.
    const favs = getFavs().filter(id => activeGroups.some(g => g.id === id));
    const byActivity = [...activeGroups].sort((a, b) => lastAct(b) - lastAct(a));
    const featured = favs.map(id => activeGroups.find(g => g.id === id));
    for (const g of byActivity) {
      if (featured.length >= 4) break;
      if (!featured.includes(g)) featured.push(g);
    }
    const others = byActivity.filter(g => !featured.includes(g));
    const archivedSorted = [...archivedGroups].sort((a, b) => lastAct(b) - lastAct(a));

    const starBtn = (g, extra = "") => {
      const isFav = favs.includes(g.id);
      const label = isFav ? "Tirar dos favoritos" : "Marcar como favorito";
      return `<button type="button" class="fav-btn ${extra} ${isFav ? "active" : ""}" data-fav="${g.id}"
        aria-label="${label}" title="${label}">${uiIco("star")}</button>`;
    };

    // saldo no rodapé de um card: valor em cima, verbo por baixo
    const cardBalance = (g) => {
      const b = balances[g.id];
      if (b === undefined) return "";
      if (b === 0) return `<span class="gc-bal zero">${uiIco("check")} em dia</span>`;
      return `<span class="gc-bal ${b > 0 ? "positive" : "negative"}">
        <strong>${fmtMoney(Math.abs(b), g.currency)}</strong><small>${b > 0 ? "recebes" : "deves"}</small></span>`;
    };

    const card = (g) => `
      <div class="group-card">
        <div class="gc-band ${tileOf(g.id)}"></div>
        ${starBtn(g)}
        <div class="gc-body">
          <a class="group-card-name" href="#/g/${g.id}">${esc(g.name)}</a>
          ${g.description ? `<span class="group-card-desc">${esc(g.description)}</span>` : ""}
          <div class="group-card-foot">
            ${avatarStackHtml(people[g.id] || [], 2, "xs")}
            ${cardBalance(g)}
          </div>
        </div>
      </div>`;

    const row = (g) => `
      <li class="group-row">
        <a class="item-link" href="#/g/${g.id}">
          <span class="row-tile ${tileOf(g.id)}"></span>
          <span class="item-main">
            <span class="item-title">${esc(g.name)}</span>
            ${g.description ? `<span class="item-sub">${esc(g.description)}</span>` : ""}
          </span>
          <span class="item-end">${balanceHtml(g)}</span>
        </a>
        ${starBtn(g, "in-list")}
      </li>`;

    // linha de um grupo em histórico: sem estrela (favoritos são só ativos)
    // e com o azulejo apagado
    const archivedRow = (g) => `
      <li class="group-row archived-row">
        <a class="item-link" href="#/g/${g.id}">
          <span class="row-tile ${tileOf(g.id)}"></span>
          <span class="item-main">
            <span class="item-title">${esc(g.name)}</span>
            ${g.description ? `<span class="item-sub">${esc(g.description)}</span>` : ""}
          </span>
          <span class="item-end">${balanceHtml(g)}</span>
        </a>
      </li>`;

    // «Outros grupos» e «Histórico»: uma linha que abre a lista por baixo
    const toggleRow = (id, icon, label, n, open) => `
      <button type="button" class="list-toggle ${open ? "open" : ""}" id="${id}" aria-expanded="${open}">
        <span class="lt-ico">${uiIco(icon)}</span>
        <span class="lt-label">${label}</span>
        <span class="lt-count">${n}</span>
        ${uiIco("down", "lt-chev")}
      </button>`;

    const activeSection = activeGroups.length === 0
      ? (archivedGroups.length
          ? `<div class="card"><p class="empty">Não tens grupos ativos. Os teus grupos estão em histórico, abaixo.</p></div>`
          : "")
      : `<div class="group-grid">${featured.map(card).join("")}</div>
          ${others.length ? `
            ${toggleRow("btn-others", "grid", "Outros grupos", others.length, othersOpen)}
            <div class="card list-card ${othersOpen ? "" : "hidden"}" id="others-card">
              <ul class="list">${others.map(row).join("")}</ul>
            </div>` : ""}`;

    const archivedSection = archivedGroups.length ? `
      ${toggleRow("btn-archived", "archive", "Histórico", archivedGroups.length, archivedOpen)}
      <div class="card list-card ${archivedOpen ? "" : "hidden"}" id="archived-card">
        <ul class="list">${archivedSorted.map(archivedRow).join("")}</ul>
      </div>` : "";

    $app.innerHTML = `
      ${hero}
      <div class="header-row">
        <h1>Os meus grupos</h1>
        <div class="header-actions">
          <button type="button" class="outline ai-home-btn" id="btn-ai-expense" title="Descreve uma despesa e a IA cria o grupo e a divisão">${uiIco("sparkle")} Despesa com IA</button>
          <button type="button" class="outline" id="btn-new-group">${uiIco("plus")} Novo grupo</button>
        </div>
      </div>
      <div id="new-group-slot"></div>
      ${groups.length === 0
        ? `<div class="card"><p class="empty">Ainda não tens grupos. Cria o primeiro em «Novo grupo», aqui em cima.</p></div>`
        : activeSection + archivedSection}`;

    // o card todo navega (o link do nome estica-se por cima dele, ver
    // .group-card-name::after); a estrela fica por cima e não navega
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

    $app.querySelector("#btn-others")?.addEventListener("click", (ev) => {
      othersOpen = !othersOpen;
      $app.querySelector("#others-card").classList.toggle("hidden", !othersOpen);
      ev.currentTarget.classList.toggle("open", othersOpen);
      ev.currentTarget.setAttribute("aria-expanded", othersOpen);
    });

    $app.querySelector("#btn-archived")?.addEventListener("click", (ev) => {
      archivedOpen = !archivedOpen;
      $app.querySelector("#archived-card").classList.toggle("hidden", !archivedOpen);
      ev.currentTarget.classList.toggle("open", archivedOpen);
      ev.currentTarget.setAttribute("aria-expanded", archivedOpen);
    });

    bindNewGroup();
    // despesa solta descrita por palavras: a IA cria o grupo e a divisão
    $app.querySelector("#btn-ai-expense").onclick = () =>
      renderAiExpense(openModal(), { onClose: closeModal });
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
        // o criador entra com acesso total (os restantes membros entram como
        // só-leitura por defeito) — funcionalmente o criador é sempre write_all,
        // mas gravar o role certo evita um badge de «leitura» enganador nele
        const memberPayload = {
          group_id: group.id,
          name: u.user_metadata?.full_name || u.email,
          email: u.email,
          user_id: u.id,
          role: "write_all",
        };
        let { error: e2 } = await sb.from("group_members").insert(memberPayload);
        // schema antigo sem a coluna role: cria na mesma (sem o role)
        if (e2 && /(\brole\b|column .*role)/i.test(e2.message)) {
          delete memberPayload.role;
          ({ error: e2 } = await sb.from("group_members").insert(memberPayload));
        }
        if (e2) toast(e2.message, true);
      }
      location.hash = `#/g/${group.id}/definicoes`;
    };
  };
  }

  draw();
}

// ---------------------------------------------------------------- vista: grupo
// Cabeçalho cobalto do grupo (vista normal e link público): voltar e ações
// em cima; nome e descrição; por baixo o saldo de «quem está a ver» e, à
// direita, a quem deve (só quando deve). Quem não tem saldo — um criador que
// não participa, ou o link público sem nome escolhido — vê o total gasto.
// `compact` tira os números: nos Saldos já estão em grande no 1.º cartão.
function groupHeroHtml(bundle, myMember, { shell, back = "", actions = "", compact = false }) {
  const { group, members, expenses, payments } = bundle;
  const cur = group.currency;
  const total = expenses.reduce((a, x) => a + toCents(x.amount), 0);
  const balances = groupBalancesCents(members, expenses, payments);
  const myBal = myMember ? (balances.get(myMember.id) ?? 0) : null;
  // a quem devo (as mesmas sugestões de acerto dos Saldos); a receber, nada
  const curto = nomesCurtos(members);
  const owe = myBal < 0
    ? settlementsFor(members, Object.fromEntries(balances)).filter(s => s.from.id === myMember.id)
    : [];
  return `
    <section class="hero group-hero ${compact ? "compact" : ""}" ${shell}>
      ${back || actions ? `<div class="hero-bar">${back}<span class="hero-actions">${actions}</span></div>` : ""}
      <div class="gh-title">
        <h1>${esc(group.name)}</h1>
        ${cur !== "EUR" ? `<span class="hero-badge">${esc(cur)}</span>` : ""}
        ${group.archived ? `<span class="hero-badge">${uiIco("archive")} Histórico</span>` : ""}
      </div>
      ${group.description ? `<p class="gh-desc">${esc(group.description)}</p>` : ""}
      ${compact ? "" : `<div class="gh-stats">
        ${myMember ? `
        <div class="gh-stat">
          <span>O teu saldo</span>
          <strong class="gh-bal">${myBal === 0 ? "Em dia" : (myBal > 0 ? "+" : "−") + fmtMoney(Math.abs(myBal), cur)}</strong>
        </div>
        ${owe.length ? `<div class="gh-stat gh-right gh-owe">
          <span>Deves a</span>
          ${(owe.length > 2 ? owe.slice(0, 1) : owe).map(s =>
            `<strong><b>${esc(curto(s.to.name))}</b> ${fmtMoney(s.cents, cur)}</strong>`).join("")}
          ${owe.length > 2 ? `<strong>+ ${owe.length - 1} pessoas</strong>` : ""}
        </div>` : ""}` : `
        <div class="gh-stat gh-right">
          <span>Total do grupo</span>
          <strong>${fmtMoney(total, cur)}</strong>
        </div>`}
      </div>`}
    </section>`;
}

// A descrição do grupo fica numa só linha: se não couber, a letra encolhe
// até um mínimo; só aí (descrições mesmo longas) volta a partir em duas.
const GH_DESC_MAX = 15, GH_DESC_MIN = 11; // px
function fitGroupDesc() {
  const el = document.querySelector(".gh-desc");
  if (!el) return;
  el.classList.remove("wrap");
  let size = GH_DESC_MAX;
  el.style.fontSize = size + "px";
  while (el.scrollWidth > el.clientWidth && size > GH_DESC_MIN) {
    size -= 0.5;
    el.style.fontSize = size + "px";
  }
  if (el.scrollWidth > el.clientWidth) el.classList.add("wrap");
}
window.addEventListener("resize", fitGroupDesc);

// Barra de baixo dentro do grupo: Despesas · (meio) · Saldos. No meio vai o
// «+» que lança uma despesa nova em qualquer separador (só a quem pode
// escrever) ou, no link público, o «Quem és tu?» (publicMeBtnHtml).
function groupNavHtml(base, tab, center = "") {
  const item = (id, icon, label) => `
    <a href="${base}/${id}" class="${tab === id ? "on" : ""}" ${tab === id ? `aria-current="page"` : ""}>
      ${uiIco(icon)}<span>${label}</span></a>`;
  return `
    <nav class="bottom-nav" aria-label="Separadores do grupo">
      <div class="bn-inner ${center ? "" : "no-add"}">
        ${item("despesas", "receipt", "Despesas")}
        ${center}
        ${item("saldos", "scale", "Saldos")}
      </div>
    </nav>`;
}
function addExpenseBtnHtml(disabled) {
  return `<button type="button" class="bn-add" id="btn-add-expense" aria-label="Nova despesa"
    title="Nova despesa" ${disabled ? "disabled" : ""}>${uiIco("plus")}</button>`;
}

// Botão dos filtros da lista de despesas, no cabeçalho: os filtros vivem
// recolhidos (ver renderExpensesTab) e este botão abre-os e fecha-os.
function filtersBtnHtml() {
  return `<button type="button" class="hero-btn round filters-btn" id="btn-filters"
    aria-label="Pesquisar e filtrar" title="Pesquisar e filtrar" aria-expanded="false"
    aria-controls="f-panel">${uiIco("filter")}</button>`;
}

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
  // primeira entrada nesta visita: guarda o carimbo da consulta ANTERIOR (é
  // com ele que a lista assinala) e marca já o grupo como visto
  if (groupSeen.id !== groupId) {
    groupSeen = { id: groupId, ts: bundle.lastSeen };
    markGroupSeen(groupId, bundle);
  }
  const { group, members, expenses, payments, paymentsReady, recurring, recurringReady } = bundle;
  const isOwner = group.created_by === session.user.id;
  const isArchived = !!group.archived;

  const myMember = members.find(m => m.user_id === session.user.id);

  // permissão do utilizador atual neste grupo: o criador tem sempre acesso
  // total; os restantes herdam o role da sua linha de membro (schema antigo
  // sem a coluna => 'write_all', o comportamento de sempre). Espelha o que a
  // RLS impõe no servidor (ver my_role() no schema.sql).
  const myRole = isOwner ? "write_all" : (myMember?.role || "write_all");
  // grupo em histórico (arquivado): os dados ficam congelados — ninguém
  // lança/edita despesas, pagamentos, membros ou moldes. Espelha a RLS
  // (ver group_archived() no schema.sql). Só o criador pode reativá-lo.
  const archived = !!group.archived;
  const canWrite = myRole !== "read" && !archived; // pode lançar/registar

  const ctx = { group, members, expenses, payments, paymentsReady, recurring, recurringReady, isOwner, myMember, myRole, canWrite, archived, lastSeen: groupSeen.ts };

  // as Definições abrem pela roda dentada do cabeçalho; Despesas e Saldos
  // vivem na barra de baixo, ao alcance do polegar. Nas Despesas, os filtros
  // abrem pelo botão ao lado da roda dentada.
  const back = `<a class="hero-btn back" href="#/">${uiIco("back")} Grupos</a>`;
  const actions = `${tab === "despesas" && expenses.length ? filtersBtnHtml() : ""}
    <a class="hero-btn round ${tab === "definicoes" ? "on" : ""}" href="#/g/${group.id}/definicoes"
    aria-label="Definições do grupo" title="Definições do grupo" ${tab === "definicoes" ? `aria-current="page"` : ""}>${uiIco("gear")}</a>`;
  $app.innerHTML = `
    ${groupHeroHtml(bundle, myMember, { shell: `data-group-shell="${group.id}"`, back, actions, compact: tab !== "despesas" })}
    ${isArchived ? `<p class="archived-note">Este grupo está em <strong>histórico</strong> — os dados estão bloqueados. ${isOwner ? "Reativa-o nas <strong>Definições</strong> para voltar a lançar despesas." : "Só o criador o pode reativar."}</p>` : ""}
    <div id="tab-content"></div>
    ${groupNavHtml(`#/g/${group.id}`, tab, canWrite ? addExpenseBtnHtml(members.length === 0) : "")}`;
  fitGroupDesc();
  const $add = document.getElementById("btn-add-expense");
  if ($add) $add.onclick = () => openExpenseModal(ctx, null);

  const $c = document.getElementById("tab-content");
  if (tab === "despesas") renderExpensesTab($c, ctx);
  else if (tab === "saldos") renderBalancesTab($c, ctx);
  else renderSettingsTab($c, ctx);
}

// ---------------------------------------------------------------- vista: link público
// Consulta de um grupo por link, sem login (#/p/<token>) — para quem não
// quer criar conta (a malta de uma despedida de solteiro, por exemplo). O
// criador gera o link nas Definições (renderShareLinkSection). Os dados vêm
// todos da RPC public_group_view, que valida o token e a validade no
// servidor e não devolve emails nem contas. A vista reaproveita os
// separadores Despesas e Saldos (e a consulta da despesa) do grupo normal,
// com um contexto só de leitura.
let publicCache = { token: null, data: null };

// «Quem és tu?» — escolha opcional de quem abre o link, só para a vista
// destacar o seu saldo e a sua parte. Fica neste browser, por link, e não
// abre nada a mais: os dados são os mesmos para toda a gente.
function publicMeKey(token) { return `splitwisely_pub_me_${token}`; }
function getPublicMe(token) {
  try { return localStorage.getItem(publicMeKey(token)); } catch (_) { return null; }
}
function setPublicMe(token, memberId) {
  try {
    if (memberId) localStorage.setItem(publicMeKey(token), memberId);
    else localStorage.removeItem(publicMeKey(token));
  } catch (_) { /* modo privado: fica só para esta visita */ }
}

// No meio da barra de baixo (onde no grupo normal está o «+»): o avatar de
// quem se escolheu, com o nome por baixo — ou, por escolher, a silhueta.
function publicMeBtnHtml(members, me) {
  const curto = nomesCurtos(members);
  return `
    <button type="button" class="bn-me" id="btn-pub-me"
      aria-label="${me ? `Quem és tu? Escolhido: ${esc(me.name)}` : "Quem és tu?"}" aria-haspopup="dialog">
      <span class="bn-me-disc">${me ? avatarHtml(me.name) : uiIco("user")}</span>
      <span class="bn-me-lbl">${me ? esc(curto(me.name)) : "Quem és tu?"}</span>
    </button>`;
}

// Lista de pessoas do grupo num painel que sobe de baixo; tocar num nome
// escolhe-o (e volta a desenhar a vista com o saldo dessa pessoa).
function openPublicMeSheet(token, members, me) {
  const $b = openSheet("Quem és tu?");
  $b.innerHTML = `
    <p class="xp-folha-sub">Escolhe o teu nome para veres o teu saldo e a tua parte em cada despesa.
      Fica guardado só neste browser.</p>
    <div class="xp-people pub-me-list">
      ${members.map(m => `
        <div class="xp-p ${m.id === me?.id ? "on" : ""}">
          <button type="button" class="xp-p-hit" data-me="${m.id}" aria-pressed="${m.id === me?.id}">
            ${avatarHtml(m.name)}
            <span class="xp-p-n">${esc(m.name)}</span>
            <span class="xp-p-c">${m.id === me?.id ? uiIco("check", "xp-ico") : ""}</span>
          </button>
        </div>`).join("")}
    </div>
    ${me ? `<button type="button" class="xp-link" data-me="">Não estou na lista</button>` : ""}`;
  $b.querySelectorAll("[data-me]").forEach(btn => {
    btn.onclick = () => { setPublicMe(token, btn.dataset.me); route(); };
  });
}

// "2026-10-10T17:32:00+00:00" -> "10 out 2026, 18:32" (hora local; como o
// fmtDiaMes, o mês curto escreve-se à mão — o pt-PT dava "10/10/2026")
function fmtDateTime(ts) {
  const d = new Date(ts);
  const mes = d.toLocaleDateString("pt-PT", { month: "short" }).replace(/\.$/, "");
  const hora = d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  return `${d.getDate()} ${mes} ${d.getFullYear()}, ${hora}`;
}

async function renderPublicGroup(token, tab) {
  if (tab !== "saldos") tab = "despesas";

  let bundle = publicCache.token === token ? publicCache.data : null;
  if (!bundle) {
    if (!$app.querySelector(`[data-public-shell="${token}"]`)) {
      showSplash();
      $app.innerHTML = `<div class="loading">A carregar grupo…</div>`;
    }
    const { data, error } = await sb.rpc("public_group_view", { p_token: token });
    // schema sem a função: para quem abre, é como um link que não existe
    if (error && /public_group_view/i.test(error.message)) bundle = { status: "invalid" };
    else if (error) throw error;
    else bundle = data;
    if (bundle?.status === "ok") publicCache = { token, data: bundle };
  }

  // sem sessão, a barra de topo fica com um «Entrar» para quem tem conta — e,
  // nas Despesas, com o botão dos filtros, que não tem cabeçalho onde morar
  // (sem o «Grupos» de voltar, era uma linha inteira só para ele)
  const withFilters = bundle?.status === "ok" && tab === "despesas" && bundle.expenses.length > 0;
  if (!session) {
    $topbarUser.innerHTML = `${withFilters ? filtersBtnHtml() : ""}
      <button class="secondary small" id="btn-pub-login">Entrar</button>`;
    document.getElementById("btn-pub-login").onclick = () => { location.hash = "#/"; };
  }

  if (bundle?.status !== "ok") {
    const expired = bundle?.status === "expired";
    $app.innerHTML = `
      <div class="card public-dead">
        <div class="public-dead-ico">${expired ? "⌛" : "🔗"}</div>
        <h1>${expired ? "Este link expirou" : "Link inválido"}</h1>
        <p class="muted">${expired
          ? `Deixou de valer a ${esc(fmtDateTime(bundle.expires_at))}.`
          : "Este link não existe ou foi desligado por quem o criou."}
          Pede um link novo a quem to enviou.</p>
      </div>`;
    return;
  }

  const { group, members, expenses, payments } = bundle;
  const meId = getPublicMe(token);
  const myMember = members.find(m => m.id === meId) || null;

  $app.innerHTML = `
    ${groupHeroHtml(bundle, myMember, {
      shell: `data-public-shell="${token}"`,
      back: session ? `<a class="hero-btn back" href="#/">${uiIco("back")} Grupos</a>` : "",
      actions: session && withFilters ? filtersBtnHtml() : "",
      compact: tab === "saldos",
    })}
    <div id="tab-content"></div>
    ${groupNavHtml(`#/p/${token}`, tab, members.length ? publicMeBtnHtml(members, myMember) : "")}`;
  fitGroupDesc();
  const $me = document.getElementById("btn-pub-me");
  if ($me) $me.onclick = () => openPublicMeSheet(token, members, myMember);

  // contexto só de leitura: sem escrita, sem carimbo de «visto», sem moldes
  const ctx = {
    group, members, expenses, payments, paymentsReady: true,
    recurring: [], recurringReady: false,
    isOwner: false, myMember, myRole: "read", canWrite: false,
    archived: !!group.archived, lastSeen: null, publicView: true,
  };
  const $c = document.getElementById("tab-content");
  if (tab === "saldos") renderBalancesTab($c, ctx);
  else renderExpensesTab($c, ctx);
}

// ------------------------------------------------ tab: despesas
function renderExpensesTab($c, ctx) {
  const { group, members, expenses, myMember } = ctx;
  const curto = nomesCurtos(members);
  const nameOf = id => curto(members.find(m => m.id === id)?.name || "?");
  const juntar = arr => arr.length <= 1 ? arr.join("")
    : `${arr.slice(0, -1).join(", ")} e ${arr[arr.length - 1]}`;
  const cur = group.currency;

  // a minha parte e o que paguei numa despesa (em cêntimos)
  const myShare = (x) => !myMember ? 0 : x.expense_shares.filter(s => s.member_id === myMember.id)
    .reduce((a, s) => a + toCents(s.amount), 0);
  const myPaid = (x) => !myMember ? 0 : x.expense_payers.filter(p => p.member_id === myMember.id)
    .reduce((a, p) => a + toCents(p.amount), 0);

  // efeito líquido da despesa no utilizador: o que pagou menos a sua parte
  const myImpact = (x) => {
    if (!myMember) return "";
    const share = myShare(x);
    // «cada um pagou o seu» não mexe no saldo: mostra-se só o que coube ao
    // próprio, a cinzento e sem sinal — é o que gastou, não o que deve
    if (x.split_mode === "own") return share > 0
      ? `<span class="my-impact neutral" title="A tua parte (só registo, não mexe no saldo)">a tua parte ${fmtMoney(share, cur)}</span>`
      : "";
    const paid = myPaid(x);
    const net = paid - share;
    if (net === 0 && paid === 0) return "";
    return `<span class="my-impact ${net >= 0 ? "positive" : "negative"}">
      ${net > 0 ? "+" : net < 0 ? "−" : ""}${fmtMoney(Math.abs(net), cur)}</span>`;
  };

  // quem pagou, como se diz: «Ana pagou», «Pagaste tu», «Tu e Ana pagaram»
  const whoPaid = (x) => {
    if (x.split_mode === "own") return "Cada um pagou o seu";
    const ids = x.expense_payers.map(p => p.member_id);
    const mine = !!myMember && ids.includes(myMember.id);
    const others = ids.filter(id => id !== myMember?.id).map(nameOf);
    if (mine && others.length === 0) return "Pagaste tu";
    if (mine) return `Tu e ${juntar(others)} pagaram`;
    return `${juntar(others)} ${others.length === 1 ? "pagou" : "pagaram"}`;
  };

  // movimentos por ver desde a última consulta a este grupo (ctx.lastSeen —
  // ver markGroupSeen). Um movimento é "novo" OU "alterado", nunca os dois:
  // a criação ganha. As alterações do próprio não se assinalam — a lista
  // serve para dar por aquilo que os OUTROS mexeram —, e sem carimbo
  // (primeira consulta, ou schema por atualizar) não se assinala nada, para
  // a lista não acender de uma ponta à outra. (No link público não há sessão
  // nem carimbo: nunca se chega a comparar com o uid.)
  const uid = session?.user.id;
  const freshOf = (x) => {
    if (!ctx.lastSeen) return "";
    if ((Date.parse(x.created_at) || 0) > ctx.lastSeen)
      return x.created_by === uid ? "" : "novo";
    // updated_at só existe depois da migração; sem ela fica tudo por
    // assinalar, em vez de tudo assinalado
    if ((Date.parse(x.updated_at) || 0) > ctx.lastSeen && x.updated_by !== uid)
      return "alterado";
    return "";
  };

  // a lista agrupa-se por dia: «Seg, 28 set» (com o ano quando não é o atual)
  const thisYear = new Date().getFullYear();
  const dayLabel = (d) => {
    const dt = new Date(d + "T00:00:00");
    // o pt-PT dá o dia por extenso («segunda»): ficam as três primeiras
    const wd = dt.toLocaleDateString("pt-PT", { weekday: "long" }).slice(0, 3);
    const yr = dt.getFullYear() !== thisYear ? ` ${dt.getFullYear()}` : "";
    return `${wd.charAt(0).toUpperCase()}${wd.slice(1)}, ${fmtDiaMes(d)}${yr}`;
  };

  // filtros da lista: categoria (chips), texto, intervalo de datas e as
  // despesas que me tocam. Os totais dos chips são calculados sobre o
  // recorte dos outros filtros, por isso mostram quanto foi em cada
  // categoria nesse recorte.
  const catKey = (x) => (x.category && catOf(x.category)) ? x.category : "none";
  const hasCats = expenses.some(x => catKey(x) !== "none");
  // As que me tocam só se escolhem quando se sabe quem sou (no link
  // público, depois do «Quem és tu?»):
  //  «Onde entro» — tenho parte nela ou paguei-a;
  //  «A liquidar» — mexe no meu saldo: o que paguei não bate com a minha
  //  parte. «Cada um pagou o seu» entra na primeira e nunca na segunda.
  const filter = { cat: null, q: "", from: "", to: "", who: "" };
  const imIn = (x) => myShare(x) > 0 || myPaid(x) > 0;
  const toSettle = (x) => x.split_mode !== "own" && myPaid(x) !== myShare(x);
  const searching = () => !!(filter.q.trim() || filter.from || filter.to || filter.who);
  const matches = (x) =>
    (!filter.q.trim() || catNorm(x.description).includes(catNorm(filter.q.trim())))
    && (!filter.from || x.expense_date >= filter.from)
    && (!filter.to || x.expense_date <= filter.to)
    && (filter.who !== "in" || imIn(x))
    && (filter.who !== "settle" || toSettle(x));

  // aviso do que há por ver — conta o grupo todo, não o recorte dos
  // filtros: um movimento novo com data antiga fica lá em baixo na lista
  // (ordenada por data da despesa) e passava despercebido
  const nFresh = expenses.filter(x => freshOf(x)).length;
  const freshNote = nFresh === 0 ? "" :
    `<p class="fresh-note"><span class="fresh-dot"></span>${nFresh} movimento${nFresh === 1 ? "" : "s"}
      ${nFresh === 1 ? "novo ou alterado" : "novos ou alterados"} desde a tua última visita</p>`;

  // o shell (filtros) desenha-se uma única vez — só a lista, os chips de
  // categoria e a linha de resultados voltam a desenhar-se, para o input
  // não perder o foco. Os filtros ficam recolhidos para a lista ter o ecrã
  // todo: abrem pelo botão do cabeçalho (filtersBtnHtml), e a linha de
  // resultados fica à vista mesmo com eles fechados. A despesa nova abre
  // pelo «+» da barra de baixo; a consulta abre em pop-up.
  $c.innerHTML = `
    ${members.length === 0
      ? `<div class="card"><p class="empty">${ctx.publicView
          ? "Este grupo ainda não tem membros."
          : "Adiciona primeiro membros nas Definições (a roda dentada, lá em cima)."}</p></div>` : ""}
    ${expenses.length === 0 ? (members.length === 0 ? "" : `
    <div class="card empty-card">
      <p class="empty">Ainda não há despesas.${ctx.canWrite
        ? " Toca no <strong>+</strong> para lançar a primeira — ou cola vários movimentos de uma vez." : ""}</p>
      ${ctx.canWrite ? `<button type="button" class="secondary" id="btn-import">${uiIco("clipboard")} Colar movimentos</button>` : ""}
    </div>`) : `
    ${freshNote}
    <div class="exp-tools hidden" id="f-panel">
      <div class="filter-bar">
        <label class="search-box">
          ${uiIco("search", "search-ico")}
          <input id="f-q" type="search" placeholder="Pesquisar despesas" aria-label="Pesquisar despesas" autocomplete="off" />
        </label>
        <button type="button" class="tool-btn date-toggle" id="f-dates-btn"
          aria-label="Filtrar por datas" title="Filtrar por intervalo de datas">${uiIco("calendar")}</button>
        ${ctx.canWrite ? `<button type="button" class="tool-btn" id="btn-import"
          aria-label="Colar vários movimentos" title="Colar vários movimentos">${uiIco("clipboard")}</button>` : ""}
      </div>
      ${myMember ? `
      <div class="xp-seg sm who-seg" role="group" aria-label="Que despesas mostrar">
        <button type="button" class="on" data-who="" aria-pressed="true">Todas</button>
        <button type="button" data-who="in" aria-pressed="false"
          title="Despesas em que tens parte ou que pagaste">Onde entro</button>
        <button type="button" data-who="settle" aria-pressed="false"
          title="Despesas que mexem no teu saldo (fica de fora o «cada um pagou o seu»)">A liquidar</button>
      </div>` : ""}
      <div class="date-range hidden" id="f-dates">
        <div class="field"><label for="f-from">De</label><input type="date" id="f-from" /></div>
        <div class="field"><label for="f-to">Até</label><input type="date" id="f-to" /></div>
        <button type="button" class="secondary small" id="f-clear">Limpar</button>
      </div>
      ${hasCats ? `<div class="cat-strip in-filters" id="cat-strip"></div>` : ""}
    </div>
    <p class="filter-result hidden" id="f-result"></p>
    <div class="card exp-card">
      <div id="expense-list"></div>
    </div>`}`;

  const $list = $c.querySelector("#expense-list");
  const $result = $c.querySelector("#f-result");
  const $catStrip = $c.querySelector("#cat-strip");
  const $panel = $c.querySelector("#f-panel");
  const $fBtn = document.getElementById("btn-filters");

  function drawList() {
    if (!$list) return; // grupo ainda sem despesas
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
      $catStrip.innerHTML = `<button type="button" class="cat-chip all ${filter.cat ? "" : "active"}" data-catfilter="">Todas</button>`
        + [...catTotals.entries()].sort((a, b) => b[1] - a[1]).map(catChip).join("");
      $catStrip.querySelectorAll("[data-catfilter]").forEach(b => {
        b.onclick = () => {
          const id = b.dataset.catfilter || null;
          filter.cat = filter.cat === id ? null : id;
          drawList();
        };
      });
    }

    // com filtro de categoria, uma fatura repartida aparece se tiver essa
    // parte — e no total só conta o valor alocado a essa categoria
    const shown = filter.cat
      ? base.filter(x => expenseCatSplits(x).some(s => s.cat === filter.cat)) : base;
    const filtered = !!filter.cat || searching();
    const centsOf = (x) => filter.cat
      ? expenseCatSplits(x).filter(s => s.cat === filter.cat).reduce((s2, s) => s2 + s.cents, 0)
      : toCents(x.amount);
    const totalShown = shown.reduce((a, x) => a + centsOf(x), 0);
    // com filtros ativos, a linha por baixo dos filtros diz o que está à vista
    // (e o botão do cabeçalho leva um ponto, para o filtro nunca ficar
    // escondido com o painel fechado)
    if ($result) {
      $result.classList.toggle("hidden", !filtered);
      if (filtered) $result.textContent =
        `${shown.length} despesa${shown.length === 1 ? "" : "s"} · ${fmtMoney(totalShown, cur)}`;
    }
    $fBtn?.classList.toggle("has-filter", filtered);

    // total de cada dia (do que está à vista), para o cabeçalho do dia
    const dayTotals = new Map();
    for (const x of shown) dayTotals.set(x.expense_date, (dayTotals.get(x.expense_date) || 0) + centsOf(x));

    let lastDay = null;
    const rows = shown.map(x => {
      const nShares = x.expense_shares.length;
      // a dividir por todos não precisa de dizer quantos são
      const porTodos = members.length > 0 && members.every(m => x.expense_shares.some(s => s.member_id === m.id));
      const head = x.expense_date !== lastDay
        ? `<li class="day-head"><span>${esc(dayLabel(x.expense_date))}</span>
            <span>${fmtMoney(dayTotals.get(x.expense_date), cur)}</span></li>` : "";
      lastDay = x.expense_date;
      // fatura repartida: linha miudinha com cada categoria e o seu valor
      const catSplits = expenseCatSplits(x).filter(s => s.cat !== "none");
      const catLine = catSplits.length >= 2
        ? `<span class="item-cats">${catSplits.map(s =>
            `<span class="item-cat">${catOf(s.cat).icon} ${fmtMoney(s.cents, cur)}</span>`).join("")}</span>`
        : "";
      const fresh = freshOf(x);
      const freshBadge = fresh
        ? `<span class="badge fresh-${fresh}" title="${fresh === "novo"
            ? "Lançada desde a tua última visita" : "Alterada desde a tua última visita"}">${fresh}</span>`
        : "";
      return `${head}
        <li class="exp-row clickable" data-open="${x.id}">
          ${expenseCatIconHtml(x)}
          <div class="item-main">
            <span class="item-title-line">
              <span class="item-title">${esc(x.description)}</span>${freshBadge}${x.recurring_id
                ? `<span class="badge linked" title="Despesa recorrente">${uiIco("repeat")}</span>` : ""}${x.receipt_path
                ? `<span class="badge linked" title="Tem fatura">${uiIco("clip")}</span>` : ""}
            </span>
            <span class="item-sub">${x.expense_time ? `${x.expense_time.slice(0, 5)} · ` : ""}${esc(whoPaid(x))}${porTodos ? "" : ` · ${nShares} pessoa${nShares === 1 ? "" : "s"}`}</span>
            ${catLine}
          </div>
          <div class="item-end">
            <span class="amount">${fmtMoney(toCents(x.amount), cur)}</span>
            ${myImpact(x)}
          </div>
        </li>`;
    }).join("");

    $list.innerHTML = shown.length === 0
      ? `<p class="empty">Nenhuma despesa encontrada com estes filtros.</p>`
      : `<ul class="list exp-list">${rows}</ul>`;

    // consulta da despesa em pop-up — fechar devolve à lista tal como estava
    $list.querySelectorAll("[data-open]").forEach(li => {
      li.onclick = () => openExpenseModal(ctx, expenses.find(e => e.id === li.dataset.open));
    });
  }

  const $impBtn = $c.querySelector("#btn-import");
  if ($impBtn) $impBtn.onclick = () => openImportModal(ctx);

  // abrir/fechar os filtros (sem o botão no cabeçalho, ficam à vista)
  if ($panel) {
    if (!$fBtn) $panel.classList.remove("hidden");
    else $fBtn.onclick = () => {
      const open = !$panel.classList.toggle("hidden");
      $fBtn.classList.toggle("on", open);
      $fBtn.setAttribute("aria-expanded", String(open));
      // no link público o botão vive na barra de topo, que fica sempre à
      // vista: aberto a meio da lista, sobe até aos filtros
      const topbarH = document.querySelector(".topbar")?.offsetHeight || 0;
      if (open && $panel.getBoundingClientRect().top < topbarH) window.scrollTo({ top: 0, behavior: "smooth" });
    };
  }

  // pesquisa por descrição e intervalo de datas (os filtros só existem
  // quando há despesas)
  const $q = $c.querySelector("#f-q");
  if ($q) {
    const $from = $c.querySelector("#f-from");
    const $to = $c.querySelector("#f-to");
    const $datesBtn = $c.querySelector("#f-dates-btn");
    const $dates = $c.querySelector("#f-dates");
    // o botão das datas fica realçado enquanto houver datas aplicadas, mesmo
    // com o painel fechado — para o filtro nunca ficar "escondido" sem se notar
    const syncDatesBtn = () => $datesBtn.classList.toggle("active", !!(filter.from || filter.to));
    $q.oninput = () => { filter.q = $q.value; drawList(); };
    $c.querySelectorAll("[data-who]").forEach(b => {
      b.onclick = () => {
        filter.who = b.dataset.who;
        $c.querySelectorAll("[data-who]").forEach(o => {
          o.classList.toggle("on", o === b);
          o.setAttribute("aria-pressed", String(o === b));
        });
        drawList();
      };
    });
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
  // true enquanto doSave() está a gravar: bloqueia o formulário para um
  // duplo-clique/duplo-toque (ou uma ligação lenta) não inserir a despesa 2x
  let saving = false;
  let entregue = false; // gravou e o ecrã passou para o onSaved

  // permissão de escrita nesta despesa (espelha a RLS do servidor):
  //  'write_all' edita qualquer uma; 'write_own' só as que criou; 'read'
  //  nenhuma. Sem permissão, o formulário abre em modo consulta (inerte).
  const myUid = session?.user.id; // sem sessão (link público) o myRole é 'read'
  const canEdit = !ctx.group.archived
    && (ctx.myRole === "write_all"
        || (ctx.myRole === "write_own" && (!existing || existing.created_by === myUid)));
  const readOnly = !canEdit;

  // pagadores/quotas do registo existente — vêm das tabelas próprias do molde
  // quando é recorrente, das da despesa quando é normal
  const exPayers = existing ? (isRecurringRecord ? existing.recurring_expense_payers : existing.expense_payers) : [];
  const exShares = existing ? (isRecurringRecord ? existing.recurring_expense_shares : existing.expense_shares) : [];

  // «cada um pagou o seu» grava como pagadores os próprios participantes —
  // ao reabrir, não servem de pagadores se se mudar para outro modo: aí
  // volta-se ao default (quem lança a despesa)
  const exOwn = !!existing && existing.split_mode === "own";

  // estado inicial: quem insere a despesa é o pagador pré-selecionado
  const { myMember } = ctx;
  const initPayers = existing && !exOwn
    ? exPayers.map(p => p.member_id)
    : [myMember ? myMember.id : members[0].id];

  const initPayerAmounts = {};
  if (existing && !exOwn) exPayers.forEach(p => { initPayerAmounts[p.member_id] = toCents(p.amount); });

  const initShares = {};
  if (existing) exShares.forEach(s => { initShares[s.member_id] = toCents(s.amount); });

  // ao reabrir uma despesa, volta ao modo em que foi gravada (split_mode);
  // despesas de schemas antigos sem a coluna caem no modo "exatos", o
  // único sempre fiel aos valores gravados
  const initMode = existing
    ? (existing.split_mode === "weights" && !useWeights ? "exact" : (existing.split_mode || "exact"))
    : (useWeights ? "weights" : "equal");
  // o modo a que se volta ao desligar «cada um pagou o seu»
  const initDivMode = initMode !== "own" ? initMode : (useWeights ? "weights" : "equal");

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
    desc: existing?.description || "",
    date: existing?.expense_date || new Date().toISOString().slice(0, 10),
    // hora (HH:MM); despesas antigas sem hora ficam em branco
    time: existing ? (existing.expense_time || "").slice(0, 5)
      : new Date().toTimeString().slice(0, 5),
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
    // equal | weights | exact | own («cada um pagou o seu»: só se escolhe
    // quem entra, cada um pagou a sua parte e ninguém fica a dever nada)
    mode: initMode,
    divMode: initDivMode,
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
    // fatura: a que já está gravada (caminho no bucket), a que se escolheu
    // agora e ainda não subiu, e se a gravada é para tirar. Só sobe ao
    // gravar — a despesa tem de existir primeiro.
    receiptPath: (!isRecurringRecord && existing?.receipt_path) || null,
    receiptFile: null,
    receiptDrop: false,
  };
  let receiptPreview = null; // object URL da imagem escolhida, para a prévia

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

  // dividir por categoria está ativo? (fatura repartida + opção ligada;
  // em «cada um pagou o seu» não há divisão nenhuma)
  const catDividing = () => !!(state.catSplit && state.catDivide && state.mode !== "own");

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
    // «cada um pagou o seu» grava partes iguais: é só a quota de referência
    const ws = state.mode === "weights" ? ids.map(id => state.weights[id] || 0) : ids.map(() => 1);
    const parts = splitByWeights(state.totalCents, ws);
    return Object.fromEntries(ids.map((id, i) => [id, parts[i]]));
  }

  // o que cada um pagou ({ memberId: cêntimos }). Em «cada um pagou o seu»
  // cada participante pagou exatamente a sua parte — e o saldo fica a zero
  function paidCents() {
    if (state.mode === "own") return computedShares();
    return Object.fromEntries([...state.payers].map(id => [id, state.payerAmounts[id] || 0]));
  }

  function distributePayersEqually() {
    const ids = [...state.payers];
    const parts = splitByWeights(state.totalCents, ids.map(() => 1));
    state.payerAmounts = Object.fromEntries(ids.map((id, i) => [id, parts[i]]));
  }
  // Pré-preenchimento vindo da IA (ver renderAiExpense): numa despesa nova
  // é o que a IA leu; numa já gravada («Alterar com IA») só o que muda. Só
  // toca no que vem — o resto fica com os defaults (ou com o que está gravado).
  const pre = opts.prefill && !isRecurringRecord ? opts.prefill : null;
  if (pre) {
    // categoria nova: a repartição por várias categorias deixa de valer
    if (pre.catReset) { state.catSplit = null; state.catDivide = false; state.catParts = {}; state.category = null; state.catManual = true; }
    // divisão nova: a divisão por categoria também
    if (pre.divReset) state.catDivide = false;
    if (pre.desc) state.desc = pre.desc;
    if (pre.totalCents > 0) state.totalCents = pre.totalCents;
    if (pre.date) state.date = pre.date;
    if (pre.time !== undefined) state.time = pre.time || "";
    if (pre.category && catOf(pre.category)) { state.category = pre.category; state.catManual = true; }
    if (pre.payers?.length) state.payers = new Set(pre.payers);
    if (pre.participants?.length) state.participants = new Set(pre.participants);
    if (["equal", "weights", "exact", "own"].includes(pre.mode)) {
      state.mode = pre.mode;
      if (pre.mode !== "own") state.divMode = pre.mode;
    }
    if (pre.exact) state.exact = { ...pre.exact };
    if (pre.receiptFile) {
      state.receiptFile = pre.receiptFile;
      if (pre.receiptFile.type?.startsWith("image/")) receiptPreview = URL.createObjectURL(pre.receiptFile);
    }
  }
  if (!existing || exOwn) distributePayersEqually();
  if (pre?.payerAmounts) state.payerAmounts = { ...pre.payerAmounts };

  // Ao mexer numa despesa já gravada (juntar um pagador ou alguém à
  // divisão, mudar o total), o normal era recalcular tudo — e perdiam-se
  // os valores acertados à mão. Agora pergunta-se uma vez: recalcular, ou
  // manter o que lá está e acertar à mão (a pessoa nova entra com 0).
  // A resposta vale até se fechar o formulário.
  let ajuste = null;    // null (ainda não se perguntou) | "recalc" | "manter"
  let pergunta = null;  // { recalc, manter } enquanto a pergunta está aberta

  // fixa as quotas atuais como valores exatos (só nos modos calculados)
  function congelarQuotas() {
    if (state.mode !== "equal" && state.mode !== "weights") return;
    if (catDividing()) return;
    state.exact = computedShares();
    state.mode = state.divMode = "exact";
  }

  // `mexe`: a alteração muda valores que já lá estavam? Só então se pergunta.
  function decidir(mexe, recalc, manter) {
    const modo = ajuste || (existing && !readOnly && mexe ? null : "recalc");
    if (modo === "recalc") recalc();
    else if (modo === "manter") manter();
    else {
      pergunta = { recalc, manter };
      document.addEventListener("keydown", onEsc, true);
    }
    draw();
  }

  // compara as quotas de quem já entrava antes e depois de `fn`
  function quotasMudam(fn) {
    const antes = computedShares();
    const guardado = new Set(state.participants);
    fn();
    const depois = computedShares();
    state.participants = guardado;
    return Object.keys(antes).some(id => id in depois && depois[id] !== antes[id]);
  }

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


  // Apagar o registo aberto (despesa, ocorrência de série ou molde).
  async function doDelete() {
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
      await removeReceipt(existing.receipt_path);
      const { error } = await sb.from("expenses").delete().eq("id", existing.id);
      if (error) return toast(error.message, true);
      toast("Ocorrência apagada");
      return refresh();
    }
    if (!confirm("Apagar esta despesa?")) return;
    // a fatura sai primeiro: sem a despesa, o servidor já não deixa apagá-la
    await removeReceipt(existing.receipt_path);
    const { error } = await sb.from("expenses").delete().eq("id", existing.id);
    if (error) return toast(error.message, true);
    toast("Despesa apagada");
    refresh();
  }

  // Fatura: sobe depois de a despesa estar gravada (é ela que dá licença
  // para escrever naquela pasta do bucket) e só então se aponta a despesa
  // para o ficheiro. A antiga sai no fim, quando já não é precisa. Devolve
  // false se alguma coisa falhou — a despesa em si já ficou gravada.
  async function saveReceipt(expenseId) {
    const old = state.receiptPath;
    const drop = state.receiptDrop && !!old;
    if (!state.receiptFile && !drop) return true;
    let path = null;
    if (state.receiptFile) {
      try {
        path = await uploadReceipt(group.id, expenseId, state.receiptFile);
      } catch (e) {
        toast(`Despesa gravada, mas a fatura não foi enviada: ${e.message || e}`, true);
        return false;
      }
    }
    const { error } = await sb.from("expenses").update({ receipt_path: path }).eq("id", expenseId);
    if (error) {
      await removeReceipt(path);
      toast(/receipt_path/i.test(error.message)
        ? "Fatura não gravada — corre o schema.sql mais recente no Supabase" : error.message, true);
      return false;
    }
    if (old && old !== path) await removeReceipt(old);
    return true;
  }

  // Validar e gravar. As validações que falham levam o utilizador ao
  // sítio onde se corrigem (goToSection), definido por cada desenho do
  // formulário.
  async function doSave() {
    if (saving) return; // já há um registo em curso — ignora o clique repetido
    saving = true;
    draw();
    try {
      await doSaveInner();
    } finally {
      saving = false;
      // com onSaved o ecrã já passou a outro (o resumo da IA): não o tapa
      if (!entregue) draw();
    }
  }

  async function doSaveInner() {
    const desc = state.desc.trim();
    const date = state.date;
    const shares2 = computedShares();
    const paid2 = paidCents();
    const paidSum2 = Object.values(paid2).reduce((a, b) => a + b, 0);
    const shareSum2 = Object.values(shares2).reduce((a, b) => a + b, 0);
    const own = state.mode === "own";

    const fail = (section, msg) => { goToSection(section); toast(msg, true); };
    // schema por atualizar: o check de split_mode ainda não conhece 'own'
    const errTxt = (error) => own && /split_mode/i.test(error.message)
      ? "«Cada um pagou o seu» precisa do schema.sql mais recente no Supabase" : error.message;
    if (!desc) return fail("dados", "Falta a descrição");
    if (state.totalCents <= 0) return fail("dados", "O valor tem de ser maior que zero");
    if (own) {
      // só se escolhe quem entra, e é no pop-up «Quem pagou»
      if (Object.keys(shares2).length === 0) return fail("pagou", "Escolhe quem entra nesta despesa");
    } else {
      if (state.payers.size === 0) return fail("pagou", "Escolhe quem pagou");
      if (paidSum2 !== state.totalCents) return fail("pagou", "Os valores pagos não somam o total");
      if (Object.keys(shares2).length === 0) return fail("divide", "Escolhe por quem se divide");
    }
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
      if (catSum !== state.totalCents) return fail("cat", "Os valores das categorias não somam o total da fatura");
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
      if (rErr) return toast(errTxt(rErr), true);
      const rPayerRows = Object.entries(paid2).filter(([, c]) => c > 0)
        .map(([id, c]) => ({ recurring_id: rec.id, member_id: id, amount: (c / 100).toFixed(2) }));
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
      const pRows = Object.entries(paid2).filter(([, c]) => c > 0)
        .map(([id, c]) => ({ expense_id: existing.id, member_id: id, amount: (c / 100).toFixed(2) }));
      const sRows = Object.entries(shares2).filter(([, c]) => c > 0)
        .map(([id, c]) => ({ expense_id: existing.id, member_id: id, amount: (c / 100).toFixed(2) }));
      const pi1 = await sb.from("expense_payers").insert(pRows);
      const pi2 = await sb.from("expense_shares").insert(sRows);
      if (pi1.error || pi2.error) return toast((pi1.error || pi2.error).message, true);

      if (catId) learnCategory(desc, catId);
      try { await sb.rpc("generate_due_recurring"); } catch (_) { /* schema sem RPC */ }
      if (await saveReceipt(existing.id)) toast("Despesa convertida em recorrente");
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
        if (error) return toast(errTxt(error), true);
        await sb.from("recurring_expense_payers").delete().eq("recurring_id", existing.id);
        await sb.from("recurring_expense_shares").delete().eq("recurring_id", existing.id);
      } else {
        const { data, error } = await sb.from("recurring_expenses").insert(rpayload).select().single();
        if (error) return toast(errTxt(error), true);
        recId = data.id;
      }
      const rPayerRows = Object.entries(paid2)
        .filter(([, c]) => c > 0)
        .map(([id, c]) => ({ recurring_id: recId, member_id: id, amount: (c / 100).toFixed(2) }));
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
      expense_time: state.time || null,
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
      if (/expense_time/i.test(error.message) && "expense_time" in payload) {
        toast("Hora não gravada — corre o schema.sql mais recente no Supabase", true);
        delete payload.expense_time;
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
      // rede de segurança do lado do servidor (uq_expenses_no_instant_duplicate):
      // a mesma despesa já foi gravada há segundos — não insere outra vez
      if (error?.code === "23505") return toast("Já registaste esta despesa há poucos segundos — não foi duplicada.", true);
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

    const payerRows = Object.entries(paid2)
      .filter(([, c]) => c > 0)
      .map(([id, c]) => ({ expense_id: expenseId, member_id: id, amount: (c / 100).toFixed(2) }));
    const shareRows = Object.entries(shares2)
      .filter(([, c]) => c > 0)
      .map(([id, c]) => ({ expense_id: expenseId, member_id: id, amount: (c / 100).toFixed(2) }));

    const i1 = await sb.from("expense_payers").insert(payerRows);
    const i2 = await sb.from("expense_shares").insert(shareRows);
    if (i1.error || i2.error) return toast((i1.error || i2.error).message, true);

    // «cada um pagou o seu» não deixa ninguém a dever nada: não há de que avisar
    if (!existing && !own) notifyExpenseAdded(group, members, desc, state.totalCents, payerRows, shareRows);

    if (await saveReceipt(expenseId)) toast(existing ? "Despesa atualizada" : "Despesa adicionada");
    if (opts.onSaved) { entregue = true; opts.onSaved(expenseId); }
    else refresh();
  }

  // ------------------------------------------------------------- ecrã (C)
  // Uma superfície só. Nada de cartões dentro de cartões: o valor é
  // tipografia sobre um cabeçalho da cor da marca e o resto separa-se por
  // filetes e espaço. Ícones desenhados (não emoji) na interface — o emoji
  // fica só onde é conteúdo, nas categorias.
  //
  // O ecrã nunca muda: descrição, valor, data e quatro linhas que dizem o
  // que vai ser gravado — quem pagou, divisão, categoria e repetição. Cada
  // linha abre um pop-up que sobe de baixo com essa decisão isolada. Por
  // omissão a despesa fica em nome de quem a lança e divide-se pelo normal
  // do grupo, por isso o caminho normal é escrever e «Registar».

  const ICONS = {
    back: '<path d="M15 19 8 12l7-7"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
    users: '<circle cx="9.2" cy="8" r="3.4"/><path d="M2.6 19.5a6.6 6.6 0 0 1 13.2 0"/><path d="M16.2 5.3a3.4 3.4 0 0 1 0 5.4"/><path d="M17.6 13.9a6.6 6.6 0 0 1 3.8 5.6"/>',
    tag: '<path d="M20.4 13.6 13 21a1.8 1.8 0 0 1-2.5 0L3 13.5V4.5A1.5 1.5 0 0 1 4.5 3h9l6.9 6.9a2.6 2.6 0 0 1 0 3.7Z"/><circle cx="8" cy="8" r="1.3"/>',
    repeat: '<path d="M4 10V9a4 4 0 0 1 4-4h9"/><path d="m14 2 3 3-3 3"/><path d="M20 14v1a4 4 0 0 1-4 4H7"/><path d="m10 22-3-3 3-3"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
    trash: '<path d="M4 7h16"/><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.5 7 7.6 20h8.8L17.5 7"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.6"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    clip: UI_ICONS.clip,
    doc: UI_ICONS.doc,
    camera: '<path d="M4.5 7.5h3l1.6-2.5h5.8l1.6 2.5h3A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V9a1.5 1.5 0 0 1 1.5-1.5Z"/><circle cx="12" cy="13.3" r="3.6"/>',
  };
  const ico = (n, cls = "") =>
    `<svg class="xp-ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
  const SIMBOLO = { EUR: "€", USD: "$", GBP: "£", BRL: "R$" };

  // ---- pop-ups: cada decisão vive num painel que sobe de baixo
  let folha = null;      // pagou | divide | cat | repetir
  let folhaNova = false; // primeira pintura do painel: só aí é que anima
  let folhaScroll = 0;   // mantém o scroll do painel entre redesenhos
  const FOLHA_TITULO = {
    pagou: "Quem pagou", divide: "Como se divide",
    cat: "Categoria", repetir: "Repetição", fatura: "Fatura",
  };
  function onEsc(e) {
    // fecha o pop-up antes de o Escape chegar ao modal e fechar tudo
    if (e.key !== "Escape") return;
    e.stopPropagation();
    e.preventDefault();
    if (pergunta) return cancelarPergunta();
    fecharFolha();
  }
  // fechar a pergunta sem responder: a alteração não se faz
  function cancelarPergunta() {
    pergunta = null;
    if (!folha) document.removeEventListener("keydown", onEsc, true);
    draw();
  }
  function abrirFolha(id) {
    if (!folha) document.addEventListener("keydown", onEsc, true);
    folha = id;
    folhaNova = true;
    folhaScroll = 0;
    draw();
  }
  function fecharFolha() {
    document.removeEventListener("keydown", onEsc, true);
    folha = null;
    draw();
  }
  function responder(escolha) {
    const p = pergunta;
    pergunta = null;
    if (!folha) document.removeEventListener("keydown", onEsc, true);
    if (!p) return draw();
    ajuste = escolha;
    p[escolha]();
    draw();
  }
  // sair do formulário com um pop-up aberto não pode deixar o listener solto
  const sair = () => {
    if (saving) return; // não fecha o formulário a meio de uma gravação
    document.removeEventListener("keydown", onEsc, true);
    close();
  };

  // uma validação que falha abre o pop-up onde se corrige
  const SECTION_FOLHA = { cat: "cat", pagou: "pagou", divide: "divide" };
  function goToSection(sec) {
    if (sec === "dados") {
      fecharFolha();
      const $a = slot.querySelector(state.desc.trim() ? "#x-amount" : "#x-desc");
      $a?.focus();
      return;
    }
    abrirFolha(SECTION_FOLHA[sec] || "pagou");
  }

  const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const curto = nomesCurtos(members);

  // Proporção entre dois em percentagem — é assim que se pensa nela
  // (0,55 e 0,45 dá «55/45», e não uma razão reduzida como «11 : 9»).
  function proporcao(a, b) {
    const total = a + b;
    if (!(total > 0) || a < 0 || b < 0) return null;
    const p = Math.round((a / total) * 100);
    return `${p}/${100 - p}`;
  }

  // Data: em vez de redesenhar o ecrã (que destruía o campo nativo aberto e,
  // no iOS, deixava o ecrã em branco), acerta-se só o que muda nos atalhos.
  function pintarDatas() {
    const outra = state.date !== today && state.date !== ontem;
    slot.querySelectorAll(".xp-seg [data-date]").forEach(b =>
      b.classList.toggle("on", !outra && b.dataset.date === state.date));
    const $o = slot.querySelector(".xp-seg-o:not(.xp-hora)");
    if ($o) {
      $o.classList.toggle("on", outra);
      const $s = $o.querySelector("small");
      if ($s) $s.textContent = outra ? fmtDiaMes(state.date) : "escolher";
      const $i = $o.querySelector("input");
      if ($i) $i.value = state.date; // o calendário abre sempre na data atual
    }
  }

  function draw() {
    if (isOccurrence && !occChoiceDone) return drawOccChoice();
    const cur = group.currency;
    const shares = computedShares();
    const paidSum = Object.values(paidCents()).reduce((a, b) => a + b, 0);
    const shareSum = Object.values(shares).reduce((a, b) => a + b, 0);
    const own = state.mode === "own";
    const catUsed = Object.values(state.catSplit || {}).reduce((a, c) => a + c, 0);
    const catsChosen = Object.keys(state.catSplit || {}).length;

    const okValor = !!state.desc.trim() && state.totalCents > 0;
    const okCat = !state.catSplit || catsChosen === 0 || catUsed === state.totalCents;
    const okPaid = state.totalCents > 0 && paidSum === state.totalCents;
    const semGente = catDividing()
      ? catEntries().filter(([c]) => ![...(state.catParts[c] || [])].some(id => members.some(m => m.id === id))).map(([c]) => catOf(c).label)
      : [];
    const okDivide = state.totalCents > 0 && shareSum === state.totalCents && semGente.length === 0;

    const catList = groupCategories(group).slice();
    for (const id of (state.catSplit ? Object.keys(state.catSplit) : (state.category ? [state.category] : []))) {
      if (!catList.some(c => c.id === id)) {
        const extraCat = catOf(id);
        if (extraCat) catList.push(extraCat);
      }
    }
    const catOn = (id) => state.catSplit ? (id in state.catSplit) : state.category === id;

    const nameOf = id => members.find(m => m.id === id)?.name || "?";
    const joinNames = arr => arr.length <= 1 ? arr.join("")
      : `${arr.slice(0, -1).join(", ")} e ${arr[arr.length - 1]}`;
    const aviso = (ok, txt) => ok ? "" : `<p class="xp-aviso">${txt}</p>`;

    // -------------------------------------------------------------- datas
    const outraData = state.date !== today && state.date !== ontem;
    const datas = state.recurring ? `
      <p class="xp-quando">${ico("repeat")} Todo o mês no dia ${state.dayOfMonth}</p>` : `
      <div class="xp-seg" role="group" aria-label="Data">
        <button type="button" class="${state.date === today ? "on" : ""}" data-date="${today}">
          Hoje<small>${fmtDiaMes(today)}</small></button>
        <button type="button" class="${state.date === ontem ? "on" : ""}" data-date="${ontem}">
          Ontem<small>${fmtDiaMes(ontem)}</small></button>
        <label class="xp-seg-o ${outraData ? "on" : ""}">
          <span>Outra</span>
          <small>${outraData ? fmtDiaMes(state.date) : "escolher"}</small>
          <input id="x-date" type="date" value="${esc(state.date)}" aria-label="Outra data" />
        </label>
        <label class="xp-seg-o xp-hora">
          <span>Hora</span>
          <small>${state.time || "—"}</small>
          <input id="x-time" type="time" value="${esc(state.time)}" aria-label="Hora" />
        </label>
      </div>`;

    // ---------------------------------------------------------- cabeçalho
    const titulo = !existing ? (state.recurring ? "Nova recorrente" : "Nova despesa")
      : (isRecurringRecord || isOccurrence) ? "Despesa recorrente" : "Despesa";

    const cabecalho = `
      <header class="xp-head">
        <div class="xp-head-bar">
          <button type="button" class="xp-icon-btn" id="x-back" aria-label="${esc(opts.backLabel || "Voltar")}" ${saving ? "disabled" : ""}>${ico("back")}</button>
          <span class="xp-head-title">${esc(titulo)}</span>
          ${opts.onAi && !readOnly && !state.recurring && !isRecurringRecord && !isOccurrence
            ? `<button type="button" class="xp-icon-btn xp-ai-btn" id="x-ai" aria-label="${existing ? "Alterar com IA" : "Preencher com IA"}" title="${existing ? "Alterar com IA" : "Descrever com IA"}" ${saving ? "disabled" : ""}>${uiIco("sparkle")}</button>`
            : `<span class="xp-head-spacer"></span>`}
        </div>
        <div class="xp-amount">
          <input id="x-amount" type="text" inputmode="decimal" placeholder="0,00" enterkeyhint="done"
            value="${state.totalCents ? (state.totalCents / 100).toFixed(2).replace(".", ",") : ""}" ${readOnly ? "readonly" : ""} />
          <span class="xp-cur">${esc(SIMBOLO[cur] || cur)}</span>
        </div>
        <input id="x-desc" class="xp-desc" value="${esc(state.desc)}"
          placeholder="Em que foi?" ${readOnly ? "readonly" : ""} />
        ${readOnly
          ? `<p class="xp-quando">${esc(state.recurring ? `Todo o mês no dia ${state.dayOfMonth}` : fmtDate(state.date) + (state.time ? ` · ${state.time}` : ""))}</p>`
          : datas}
      </header>`;

    // ------------------------------------------------- as quatro decisões
    const paidTxt = own ? "Cada um o seu"
      : state.payers.size === 0 ? "Por escolher"
      : state.payers.size === 1 ? curto(nameOf([...state.payers][0]))
      : joinNames([...state.payers].map(id => curto(nameOf(id))));

    const idsDiv = Object.keys(shares);
    const dois = idsDiv.length === 2;
    let divTxt;
    if (own) divTxt = "Não se divide";
    else if (catDividing()) divTxt = "Por categoria";
    else if (idsDiv.length === 0) divTxt = "Por escolher";
    else if (state.mode === "weights") {
      const r = dois ? proporcao(state.weights[idsDiv[0]] || 0, state.weights[idsDiv[1]] || 0) : null;
      divTxt = r ? `Proporção ${r}` : "Por proporção";
    } else if (state.mode === "exact") divTxt = "Valores exatos";
    else divTxt = idsDiv.length === members.length ? "Igual, entre todos" : `Igual, entre ${idsDiv.length}`;

    const catTxt = state.catSplit
      ? (catEntries().map(([id]) => `${catOf(id).icon} ${catOf(id).label}`).join(" · ") || "Repartida")
      : (state.category ? `${catOf(state.category).icon} ${catOf(state.category).label}` : "Nenhuma");

    const repTxt = isOccurrence ? "Parte de uma série"
      : state.recurring ? `Todo o mês, dia ${state.dayOfMonth}` : "Uma vez";

    // a fatura é da despesa: um molde recorrente não tem (ao converter uma
    // despesa, a despesa fica — e a fatura com ela)
    const comFatura = !isRecurringRecord && !(state.recurring && !converting);
    const temFatura = !!state.receiptFile || (!!state.receiptPath && !state.receiptDrop);
    const fatPdf = state.receiptFile ? receiptIsPdf(state.receiptFile.type) : receiptIsPdf(state.receiptPath);
    const fatTxt = !temFatura ? "Nenhuma"
      : state.receiptFile ? (fatPdf ? "PDF por enviar" : "Imagem por enviar")
      : (fatPdf ? "PDF anexado" : "Imagem anexada");

    const linha = (alvo, icone, k, v, ok, off) => `
      <button type="button" class="xp-row ${ok ? "" : "warn"}" ${off || readOnly ? "disabled" : `data-folha="${alvo}"`}>
        ${ico(icone, "xp-row-ico")}
        <span class="xp-row-k">${k}</span>
        <span class="xp-row-v">${v}</span>
        ${off || readOnly ? "" : ico("chev", "xp-row-chev")}
      </button>`;

    // prévia: avatares de quem entra + o que fica a cada um
    const vals = idsDiv.map(id => shares[id] || 0);
    const iguais = vals.length > 0 && vals.every(v => Math.abs(v - vals[0]) <= 1);
    let previaTxt = "";
    if (own) {
      // quanto pagou cada um não se sabe nem interessa: fica só o registo
      if (idsDiv.length) previaTxt = "Fica só o registo — <strong>não mexe nos saldos</strong>";
    } else if (idsDiv.length && state.totalCents > 0) {
      previaTxt = iguais ? `<strong>${fmtMoney(vals[0], cur)}</strong> cada`
        : idsDiv.length <= 3
          // com duas ou três pessoas cabe dizer quanto fica a cada uma
          ? idsDiv.map(id => `${esc(curto(nameOf(id)))} <strong>${fmtMoney(shares[id] || 0, cur)}</strong>`).join(" · ")
          : `divide-se por <strong>${idsDiv.length}</strong>`;
    }
    const previa = previaTxt ? `
      <div class="xp-previa">
        <div class="xp-avatars">
          ${members.filter(m => idsDiv.includes(m.id)).slice(0, 5).map(m => avatarHtml(m.name, "small")).join("")}
          ${idsDiv.length > 5 ? `<span class="xp-avatar-mais">+${idsDiv.length - 5}</span>` : ""}
        </div>
        <span class="xp-previa-txt">${previaTxt}</span>
      </div>` : "";

    const decisoes = `
      <div class="xp-rows">
        ${linha("pagou", "user", "Quem pagou", esc(paidTxt), okPaid)}
        ${linha("divide", "users", "Divisão", esc(divTxt), own || okDivide, own)}
        ${linha("cat", "tag", "Categoria", esc(catTxt), okCat)}
        ${linha("repetir", "repeat", "Repete-se", esc(repTxt), true, isOccurrence)}
        ${comFatura ? linha("fatura", "clip", "Fatura", esc(fatTxt), true) : ""}
      </div>
      ${previa}`;

    // ---------------------------------------- conteúdo de cada pop-up
    // Com um campo à direita (proporção, valores exatos) o nome não tem
    // espaço para o valor ao lado: nesse caso ele passa a segunda linha.
    const pessoa = (m, { on, attr, input, val }) => `
      <div class="xp-p ${on ? "on" : ""}">
        <button type="button" class="xp-p-hit" ${attr} aria-pressed="${on}">
          ${avatarHtml(m.name)}
          <span class="xp-p-n">${esc(m.name)}${input && val ? `<small>${val}</small>` : ""}</span>
          ${val && !input ? `<span class="xp-p-v">${val}</span>` : ""}
          <span class="xp-p-c">${on ? ico("check") : ""}</span>
        </button>
        ${input || ""}
      </div>`;

    const multiPayers = state.payers.size > 1;
    // «cada um pagou o seu» decide-se aqui, porque responde a «quem pagou?»:
    // nesse modo só se escolhe quem entra e a linha da divisão fica inerte
    const segPagou = `
      <div class="xp-seg sm" role="group" aria-label="Como se pagou">
        <button type="button" class="${own ? "" : "on"}" data-own="0">Alguém pagou</button>
        <button type="button" class="${own ? "on" : ""}" data-own="1">Cada um o seu</button>
      </div>`;
    const corpoPagou = () => own ? `
      ${aviso(idsDiv.length > 0, "Escolhe quem entra nesta despesa")}
      ${segPagou}
      <p class="xp-folha-sub">Cada um pagou a sua parte: a despesa fica registada e ninguém fica a dever nada.</p>
      <div class="xp-folha-act">
        <span class="xp-folha-sub">Quem entra nesta despesa</span>
        <span>
          <button type="button" class="xp-link sm" id="x-part-all">Todos</button>
          <button type="button" class="xp-link sm" id="x-part-none">Nenhum</button>
        </span>
      </div>
      <div class="xp-people">
        ${members.map(m => pessoa(m, { on: state.participants.has(m.id), attr: `data-part="${m.id}"` })).join("")}
      </div>` : `
      ${aviso(okPaid || state.totalCents === 0, `${fmtMoney(paidSum, cur)} de ${fmtMoney(state.totalCents, cur)} atribuídos`)}
      ${segPagou}
      <p class="xp-folha-sub">Toca em quem pôs o dinheiro. Podem ser várias pessoas.</p>
      <div class="xp-people">
        ${members.map(m => pessoa(m, {
          on: state.payers.has(m.id),
          attr: `data-payer="${m.id}"`,
          val: state.payers.has(m.id) && !multiPayers ? fmtMoney(state.totalCents, cur) : "",
          input: state.payers.has(m.id) && multiPayers
            ? `<input class="xp-p-in" type="number" inputmode="decimal" step="0.01" min="0"
                 data-payer-amount="${m.id}" value="${((state.payerAmounts[m.id] || 0) / 100).toFixed(2)}" />`
            : "",
        })).join("")}
      </div>
      ${multiPayers ? `<button type="button" class="xp-link" id="x-dist-payers">Dividir o total igualmente pelos pagadores</button>` : ""}`;

    const corpoDivide = () => catDividing() ? `
      ${aviso(semGente.length === 0, `Falta escolher quem participa em: ${esc(semGente.join(", "))}`)}
      <label class="xp-check">
        <input type="checkbox" id="x-cat-divide" checked />
        <span>Dividir cada categoria por pessoas diferentes</span>
      </label>
      <div class="xp-catdiv">
        ${catList.filter(c => c.id in state.catSplit).map(c => {
          const cents = state.catSplit[c.id] || 0;
          const set = state.catParts[c.id] || new Set();
          const n = members.filter(m => set.has(m.id)).length;
          const each = n > 0 ? (cents % n === 0 ? fmtMoney(cents / n, cur) : "≈ " + fmtMoney(Math.round(cents / n), cur)) : "";
          return `<div class="xp-catdiv-b">
            <div class="xp-catdiv-h"><span>${c.icon} ${esc(c.label)}</span><span>${fmtMoney(cents, cur)}</span></div>
            <div class="xp-chips">
              ${members.map(m => `
                <label class="xp-chip ${set.has(m.id) ? "on" : ""}">
                  <input type="checkbox" data-catpart-cat="${c.id}" data-catpart-mem="${m.id}" ${set.has(m.id) ? "checked" : ""} />
                  <span>${esc(curto(m.name))}</span>
                </label>`).join("")}
            </div>
            <p class="xp-catdiv-f ${n === 0 ? "warn" : ""}">${n === 0
              ? "Escolhe quem participa" : `${n} pessoa${n === 1 ? "" : "s"} · ${each} cada`}</p>
          </div>`;
        }).join("")}
      </div>` : `
      ${aviso(okDivide || state.totalCents === 0, `${fmtMoney(shareSum, cur)} de ${fmtMoney(state.totalCents, cur)} divididos`)}
      <div class="xp-seg sm" role="group" aria-label="Modo de divisão">
        <button type="button" class="${state.mode === "equal" ? "on" : ""}" data-mode="equal">Partes iguais</button>
        ${useWeights ? `<button type="button" class="${state.mode === "weights" ? "on" : ""}" data-mode="weights">Proporção</button>` : ""}
        <button type="button" class="${state.mode === "exact" ? "on" : ""}" data-mode="exact">Exatos</button>
      </div>
      <div class="xp-folha-act">
        <span class="xp-folha-sub">Quem entra nesta despesa</span>
        <span>
          <button type="button" class="xp-link sm" id="x-part-all">Todos</button>
          <button type="button" class="xp-link sm" id="x-part-none">Nenhum</button>
        </span>
      </div>
      <div class="xp-people">
        ${members.map(m => {
          const on = state.participants.has(m.id);
          let input = "";
          if (on && state.mode === "weights") {
            input = `<input class="xp-p-in" type="number" inputmode="decimal" step="0.1" min="0"
              data-weight="${m.id}" value="${state.weights[m.id] ?? 0}" />`;
          } else if (on && state.mode === "exact") {
            input = `<input class="xp-p-in" type="number" inputmode="decimal" step="0.01" min="0"
              data-exact="${m.id}" value="${((state.exact[m.id] || 0) / 100).toFixed(2)}" />`;
          }
          return pessoa(m, {
            on, attr: `data-part="${m.id}"`, input,
            val: on && state.mode !== "exact" ? fmtMoney(shares[m.id] || 0, cur) : "",
          });
        }).join("")}
      </div>
      ${state.catSplit ? `
        <label class="xp-check">
          <input type="checkbox" id="x-cat-divide" />
          <span>Dividir cada categoria por pessoas diferentes
            <small>ex.: o vinho só entre os adultos</small></span>
        </label>` : ""}`;

    const corpoCat = () => `
      ${aviso(okCat, `${fmtMoney(catUsed, cur)} de ${fmtMoney(state.totalCents, cur)} atribuídos às categorias`)}
      ${state.catAuto && state.category ? `<p class="xp-folha-sub">Sugerida a partir da descrição — muda se não for.</p>` : ""}
      <div class="xp-cats">
        ${catList.map(c => `
          <button type="button" class="xp-cat ${catOn(c.id) ? "on" : ""}" data-cat="${c.id}">
            <span class="xp-cat-ico ct-${c.tone}">${catGlyph(c)}</span>
            <span class="xp-cat-lb">${esc(c.label)}</span>
            ${state.catSplit && catOn(c.id) ? `<span class="xp-cat-v">${fmtMoney(state.catSplit[c.id] || 0, cur)}</span>` : ""}
          </button>`).join("")}
      </div>
      ${!state.catSplit ? (state.recurring ? "" : `
        <button type="button" class="xp-link" id="x-cat-multi">Repartir a fatura por várias categorias</button>`) : `
        <div class="xp-catsplit">
          ${catList.filter(c => c.id in state.catSplit).map(c => `
            <label class="xp-catsplit-l">
              <span>${c.icon} ${esc(c.label)}</span>
              <input type="number" inputmode="decimal" step="0.01" min="0" data-catamount="${c.id}"
                value="${((state.catSplit[c.id] || 0) / 100).toFixed(2)}" />
            </label>`).join("")}
          ${catsChosen === 0 ? `<p class="xp-nota">Toca nas categorias em cima para as juntar à fatura</p>` : ""}
          <div class="xp-catsplit-a">
            <button type="button" class="xp-link sm" id="x-cat-dist">Distribuir igualmente</button>
            <button type="button" class="xp-link sm" id="x-cat-single">Uma só categoria</button>
          </div>
        </div>`}`;

    const corpoRepetir = () => `
      ${isRecurringRecord ? `<p class="xp-folha-sub">Esta é a série. As alterações valem para as próximas ocorrências.</p>` : `
        <label class="xp-check big">
          <input type="checkbox" data-type="${state.recurring ? "occ" : "rec"}" ${state.recurring ? "checked" : ""} />
          <span>Repete-se todos os meses
            <small>Renda, ginásio, subscrições — a app lança sozinha.</small></span>
        </label>`}
      ${state.recurring ? `
        <div class="xp-rec">
          <label class="xp-field">
            <span>Dia do mês</span>
            <input id="x-dom" type="number" inputmode="numeric" min="1" max="31" value="${state.dayOfMonth}" />
          </label>
          <label class="xp-field">
            <span>Termina em</span>
            <input id="x-end" type="date" min="${today}" value="${esc(state.endDate)}" />
          </label>
        </div>
        <label class="xp-check">
          <input type="checkbox" id="x-active" ${state.active ? "checked" : ""} />
          <span>Série ativa
            <small>Lançada no dia marcado (ajustado ao último dia nos meses mais curtos).</small></span>
        </label>` : ""}`;

    // os campos de ficheiro ficam por cima dos botões (transparentes): no iOS
    // um <input type=file> escondido nem sempre abre pelo <label>
    const fatBtn = (icone, txt, accept, extra = "") => `
      <label class="xp-fat-btn">
        ${ico(icone)}<span>${txt}</span>
        <input class="xp-fat-in" type="file" accept="${accept}" ${extra} data-fatura aria-label="${txt}" />
      </label>`;
    const corpoFatura = () => !temFatura ? `
      <p class="xp-folha-sub">Fotografa o talão ou junta o PDF da fatura. Fica com a despesa, à vista de quem está no grupo.</p>
      <div class="xp-fat-acoes">
        ${fatBtn("camera", "Tirar fotografia", "image/*", 'capture="environment"')}
        ${fatBtn("clip", "Escolher ficheiro", "image/*,application/pdf")}
      </div>
      <p class="xp-nota">Imagem ou PDF, até 10 MB. As fotografias são reduzidas antes de seguir.</p>` : `
      ${state.receiptFile ? `<p class="xp-folha-sub">Segue quando gravares a despesa.</p>` : ""}
      <div class="xp-fat-prev">
        ${fatPdf
          ? `<div class="xp-fat-doc">${ico("doc")}<span>${esc(state.receiptFile?.name || "Fatura em PDF")}</span></div>`
          : `<img id="x-fat-img" alt="Fatura" ${state.receiptFile && receiptPreview ? `src="${receiptPreview}"` : ""} />`}
      </div>
      <div class="xp-fat-acoes">
        ${fatBtn("clip", "Trocar", "image/*,application/pdf")}
        <button type="button" class="xp-fat-btn del" id="x-fat-del">${ico("trash")}<span>Remover</span></button>
      </div>`;

    const CORPOS = { pagou: corpoPagou, divide: corpoDivide, cat: corpoCat, repetir: corpoRepetir, fatura: corpoFatura };

    const popup = folha ? `
      <div class="xp-scrim" id="x-scrim">
        <div class="xp-folha ${folhaNova ? "entra" : ""}" role="dialog" aria-modal="true" aria-label="${FOLHA_TITULO[folha]}">
          <div class="xp-folha-h">
            <span class="xp-grab"></span>
            <div class="xp-folha-t">
              <h3>${FOLHA_TITULO[folha]}</h3>
              <button type="button" class="xp-folha-ok" id="x-folha-ok">Concluir</button>
            </div>
          </div>
          <div class="xp-folha-b" id="x-folha-b">${CORPOS[folha]()}</div>
        </div>
      </div>` : "";

    // ------------------------------------------------- avisos de contexto
    const contexto = readOnly ? `
      <div class="xp-note gold">${ico("eye")}
        <span>${ctx.publicView
          ? "Estás a ver por um link público — só consulta."
          : ctx.myRole === "read"
          ? "Tens acesso de leitura a este grupo — podes consultar mas não alterar."
          : "Só podes editar as despesas que criaste. Esta é de outra pessoa."}</span>
      </div>` : isRecurringRecord ? `
      <div class="xp-note">${ico("repeat")}
        <span>${existing
          ? "Estás a editar a série: as alterações valem para as próximas ocorrências."
          : "Vai repetir-se todos os meses e ser lançada automaticamente."}</span>
      </div>` : isOccurrence ? `
      <div class="xp-note">${ico("repeat")}
        <span>Só esta ocorrência de ${esc(fmtDate(existing.expense_date))} — a série fica como está.</span>
      </div>` : "";

    const acao = converting && state.recurring ? "Tornar recorrente"
      : existing ? "Guardar alterações"
      : (state.recurring ? "Criar recorrente" : "Registar");

    slot.innerHTML = `
    <div class="expense-detail xp">
      ${cabecalho}
      <div class="xp-body"${readOnly || saving ? " inert" : ""}>
        ${contexto}
        ${decisoes}
        ${existing && !readOnly ? `
          <button type="button" class="xp-del" id="x-del" ${saving ? "disabled" : ""}>${ico("trash")} Apagar despesa</button>` : ""}
      </div>
      ${readOnly ? "" : `
      <footer class="xp-foot">
        <button class="xp-cta" id="x-save" ${okValor && !saving ? "" : "disabled"}>${saving ? "A guardar…" : acao}</button>
      </footer>`}
      ${popup}
      ${pergunta ? `
      <div class="xp-scrim xp-ask-scrim" id="x-ask-scrim">
        <div class="xp-ask" role="alertdialog" aria-modal="true" aria-labelledby="x-ask-t">
          <h3 id="x-ask-t">Recalcular os valores?</h3>
          <p>Esta alteração mexe no que já estava gravado. Podes recalcular tudo,
            ou manter os valores como estão e acertar tu à mão — quem entra de novo fica com 0.</p>
          <button type="button" class="xp-cta" data-ajuste="manter">Manter e acertar à mão</button>
          <button type="button" class="xp-link wide" data-ajuste="recalc">Recalcular tudo</button>
          <button type="button" class="xp-link wide xp-ask-no" id="x-ask-cancel">Cancelar</button>
        </div>
      </div>` : ""}
    </div>`;

    // o painel só anima ao abrir; depois disso mantém a posição de scroll
    const $fb = slot.querySelector("#x-folha-b");
    if ($fb && !folhaNova) $fb.scrollTop = folhaScroll;
    if ($fb) $fb.addEventListener("scroll", () => { folhaScroll = $fb.scrollTop; }, { passive: true });
    folhaNova = false;
    slot.parentElement?.classList.toggle("folha-aberta", !!folha);

    // -------------------------------------------------------------- eventos
    slot.querySelector("#x-back").onclick = sair;
    slot.querySelector("#x-save")?.addEventListener("click", doSave);
    slot.querySelector("#x-ai")?.addEventListener("click", () => {
      if (saving) return;
      document.removeEventListener("keydown", onEsc, true);
      opts.onAi();
    });
    slot.querySelector("#x-del")?.addEventListener("click", doDelete);
    slot.querySelectorAll("[data-folha]").forEach(b => { b.onclick = () => abrirFolha(b.dataset.folha); });
    slot.querySelector("#x-folha-ok")?.addEventListener("click", fecharFolha);
    slot.querySelector("#x-scrim")?.addEventListener("click", (e) => { if (e.target.id === "x-scrim") fecharFolha(); });
    slot.querySelectorAll("[data-ajuste]").forEach(b => { b.onclick = () => responder(b.dataset.ajuste); });
    slot.querySelector("#x-ask-cancel")?.addEventListener("click", cancelarPergunta);
    slot.querySelector("#x-ask-scrim")?.addEventListener("click", (e) => { if (e.target.id === "x-ask-scrim") cancelarPergunta(); });

    const $desc = slot.querySelector("#x-desc");
    if ($desc) $desc.oninput = () => {
      state.desc = $desc.value;
      // sugestão de categoria enquanto se escreve, sem redesenhar (o campo
      // perderia o foco): atualiza-se só a linha do resumo
      if (!state.catManual && !state.catSplit) {
        const allowedIds = groupCatIds(group);
        const g = guessCategory(state.desc, ctx.expenses, allowedIds ? new Set(allowedIds) : null);
        if (g !== state.category) {
          state.category = g;
          state.catAuto = !!g;
          const $v = slot.querySelector('[data-folha="cat"] .xp-row-v');
          if ($v) $v.textContent = g ? `${catOf(g).icon} ${catOf(g).label}` : "Nenhuma";
        }
      }
      const $cta = slot.querySelector("#x-save");
      if ($cta) $cta.disabled = saving || !(state.desc.trim() && state.totalCents > 0);
    };
    const $amount = slot.querySelector("#x-amount");
    if ($amount) $amount.onchange = () => {
      const novo = toCents($amount.value);
      if (novo === state.totalCents) return;
      // com um só pagador e uma só pessoa não há nada para acertar à mão
      const calcula = (state.mode === "equal" || state.mode === "weights") && !catDividing();
      const mexe = state.totalCents > 0
        && (state.payers.size > 1 || (calcula && Object.keys(computedShares()).length > 1));
      decidir(mexe,
        () => { state.totalCents = novo; distributePayersEqually(); },
        () => { congelarQuotas(); state.totalCents = novo; });
    };

    slot.querySelectorAll("[data-date]").forEach(b => {
      b.onclick = () => { state.date = b.dataset.date; pintarDatas(); };
    });
    const $date = slot.querySelector("#x-date");
    if ($date) {
      // o campo cobre o terceiro botão: tocar nele abre o calendário nativo
      $date.onclick = () => { try { $date.showPicker(); } catch (_) { /* sem showPicker */ } };
      $date.onchange = () => {
        if (!$date.value) return;
        state.date = $date.value;
        pintarDatas();
      };
    }
    const $time = slot.querySelector("#x-time");
    if ($time) {
      $time.onclick = () => { try { $time.showPicker(); } catch (_) { /* sem showPicker */ } };
      $time.onchange = () => {
        state.time = $time.value;
        const $s = $time.closest("label").querySelector("small");
        if ($s) $s.textContent = state.time || "—";
      };
    }
    // fatura: escolher, trocar ou tirar (só sobe ao gravar)
    slot.querySelectorAll("[data-fatura]").forEach(inp => {
      inp.onchange = () => {
        const f = inp.files?.[0];
        if (!f) return;
        if (!receiptFileOk(f)) return toast("A fatura tem de ser uma imagem (JPG, PNG, WebP, HEIC) ou um PDF", true);
        if (receiptIsPdf(f.type) && f.size > RECEIPT_MAX_BYTES) return toast("O PDF passa dos 10 MB", true);
        if (receiptPreview) URL.revokeObjectURL(receiptPreview);
        receiptPreview = f.type.startsWith("image/") ? URL.createObjectURL(f) : null;
        state.receiptFile = f;
        draw();
      };
    });
    slot.querySelector("#x-fat-del")?.addEventListener("click", () => {
      if (receiptPreview) URL.revokeObjectURL(receiptPreview);
      receiptPreview = null;
      state.receiptFile = null;
      state.receiptDrop = !!state.receiptPath;
      draw();
    });
    // a gravada mostra-se pelo link assinado (o bucket é privado)
    const $fatImg = slot.querySelector("#x-fat-img");
    if ($fatImg) {
      // uma imagem que o browser não sabe mostrar (HEIC fora do Safari)
      $fatImg.onerror = () => {
        $fatImg.outerHTML = `<div class="xp-fat-doc">${ico("doc")}<span>${esc(state.receiptFile?.name || "Imagem anexada")}</span></div>`;
      };
      if (!state.receiptFile && state.receiptPath) receiptUrl(state.receiptPath)
        .then(url => { if ($fatImg.isConnected) $fatImg.src = url; })
        .catch(() => { $fatImg.alt = "Não foi possível abrir a fatura"; });
    }

    const $dom = slot.querySelector("#x-dom");
    if ($dom) $dom.onchange = () => {
      state.dayOfMonth = Math.min(31, Math.max(1, parseInt($dom.value, 10) || 1));
      draw();
    };
    const $end = slot.querySelector("#x-end");
    if ($end) $end.onchange = () => { state.endDate = $end.value; };
    const $active = slot.querySelector("#x-active");
    if ($active) $active.onchange = () => { state.active = $active.checked; draw(); };

    slot.querySelectorAll("[data-type]").forEach(cb => {
      cb.onchange = () => {
        state.recurring = cb.dataset.type === "rec";
        // um molde tem uma categoria só: a fatura repartida colapsa na principal
        if (state.recurring && state.catSplit) {
          state.category = primaryCategory();
          state.catSplit = null;
          state.catDivide = false;
        }
        draw();
      };
    });

    slot.querySelectorAll("[data-cat]").forEach(b => {
      b.onclick = () => {
        const id = b.dataset.cat;
        if (state.catSplit) {
          if (id in state.catSplit) { delete state.catSplit[id]; delete state.catParts[id]; }
          else {
            const usado = Object.values(state.catSplit).reduce((a, c) => a + c, 0);
            state.catSplit[id] = Math.max(state.totalCents - usado, 0);
            state.catParts[id] = new Set(state.participants);
          }
        } else {
          state.category = state.category === id ? null : id;
        }
        state.catManual = true;
        state.catAuto = false;
        draw();
      };
    });
    slot.querySelector("#x-cat-multi")?.addEventListener("click", () => {
      state.catSplit = state.category ? { [state.category]: state.totalCents } : {};
      state.catManual = true;
      state.catAuto = false;
      draw();
    });
    slot.querySelector("#x-cat-single")?.addEventListener("click", () => {
      state.category = primaryCategory(); // fica a de maior valor
      state.catSplit = null;
      state.catDivide = false;
      draw();
    });
    slot.querySelector("#x-cat-dist")?.addEventListener("click", () => {
      const ids = Object.keys(state.catSplit);
      if (ids.length) {
        const partes = splitByWeights(state.totalCents, ids.map(() => 1));
        ids.forEach((id, i) => { state.catSplit[id] = partes[i]; });
      }
      draw();
    });
    slot.querySelectorAll("[data-catamount]").forEach(inp => {
      inp.onchange = () => { state.catSplit[inp.dataset.catamount] = toCents(inp.value); draw(); };
    });
    slot.querySelector("#x-cat-divide")?.addEventListener("change", (e) => {
      state.catDivide = e.target.checked;
      if (state.catDivide) for (const id of Object.keys(state.catSplit))
        if (!state.catParts[id]) state.catParts[id] = new Set(state.participants);
      draw();
    });
    slot.querySelectorAll("[data-catpart-cat]").forEach(cb => {
      cb.onchange = () => {
        const set = (state.catParts[cb.dataset.catpartCat] ??= new Set());
        cb.checked ? set.add(cb.dataset.catpartMem) : set.delete(cb.dataset.catpartMem);
        draw();
      };
    });

    slot.querySelectorAll("[data-payer]").forEach(b => {
      b.onclick = () => {
        const id = b.dataset.payer;
        const sai = state.payers.has(id);
        const alternar = () => { sai ? state.payers.delete(id) : state.payers.add(id); };
        // juntar alguém mexe em quem já pagava; tirar mexe se ficar alguém
        const mexe = state.totalCents > 0 && state.payers.size > (sai ? 1 : 0);
        decidir(mexe,
          () => { alternar(); distributePayersEqually(); },
          () => {
            alternar();
            if (sai) delete state.payerAmounts[id];
            else state.payerAmounts[id] = 0;
          });
      };
    });
    slot.querySelectorAll("[data-payer-amount]").forEach(inp => {
      inp.onchange = () => { state.payerAmounts[inp.dataset.payerAmount] = toCents(inp.value); draw(); };
    });
    slot.querySelector("#x-dist-payers")?.addEventListener("click", () => { distributePayersEqually(); draw(); });

    slot.querySelectorAll("[data-mode]").forEach(b => {
      b.onclick = () => { state.mode = b.dataset.mode; state.divMode = state.mode; draw(); };
    });
    // ligar/desligar «cada um pagou o seu»: os pagadores e o modo de divisão
    // ficam guardados e voltam tal como estavam ao desligar
    slot.querySelectorAll("[data-own]").forEach(b => {
      b.onclick = () => {
        state.mode = b.dataset.own === "1" ? "own" : state.divMode;
        draw();
      };
    });
    slot.querySelectorAll("[data-part]").forEach(b => {
      b.onclick = () => {
        const id = b.dataset.part;
        const sai = state.participants.has(id);
        const alternar = () => { sai ? state.participants.delete(id) : state.participants.add(id); };
        const calcula = (state.mode === "equal" || state.mode === "weights") && !catDividing();
        decidir(calcula && quotasMudam(alternar), alternar, () => {
          congelarQuotas();
          alternar();
          if (sai) delete state.exact[id];
          else if (state.mode === "exact") state.exact[id] = 0;
        });
      };
    });
    slot.querySelector("#x-part-all")?.addEventListener("click", () => {
      const todos = () => members.forEach(m => state.participants.add(m.id));
      const calcula = (state.mode === "equal" || state.mode === "weights") && !catDividing();
      decidir(calcula && quotasMudam(todos), todos, () => {
        congelarQuotas();
        for (const m of members) {
          if (state.participants.has(m.id)) continue;
          state.participants.add(m.id);
          if (state.mode === "exact") state.exact[m.id] = 0;
        }
      });
    });
    slot.querySelector("#x-part-none")?.addEventListener("click", () => { state.participants.clear(); draw(); });
    slot.querySelectorAll("[data-weight]").forEach(inp => {
      inp.onchange = () => { state.weights[inp.dataset.weight] = parseFloat(inp.value) || 0; draw(); };
    });
    slot.querySelectorAll("[data-exact]").forEach(inp => {
      inp.onchange = () => { state.exact[inp.dataset.exact] = toCents(inp.value); draw(); };
    });
  }

  // o formulário traz o seu próprio cabeçalho e margens: o cartão do
  // pop-up cede-lhe o espaço todo e, no telemóvel, o ecrã inteiro
  slot.classList.add("modal-card-flush");
  slot.parentElement?.classList.add("modal-full");

  draw();
  // «Registar» no ecrã de confirmação da IA: grava logo, com as validações
  // de sempre — se alguma falhar, fica-se aqui no formulário, no sítio onde
  // se corrige
  if (opts.autoSave && pre && !readOnly) doSave();
}

// ------------------------------------------- despesa com IA (texto ou foto)
// Descreve-se a despesa como se fala («jantar de ontem no sushi, 84 €, paguei
// eu, dividido pelos 4 menos a Rita») — e, se houver, junta-se a foto do
// talão. A Edge Function `despesa-ia` pede ao Gemini um JSON com o que
// percebeu (e regista a chamada em ia_uso.registos); nada se grava sem passar
// pelo ecrã de confirmação, que mostra tudo o que vai ficar e deixa:
//   · Registar   grava já (uma despesa: pelo formulário de sempre, com as
//                validações de sempre — se alguma falhar, fica-se no
//                formulário a corrigir; várias: todas de uma vez)
//   · Editar     abre o formulário normal, já preenchido
//   · Corrigir   manda uma correção por palavras e a IA parte da resposta
//                anterior («afinal foi o João que pagou»)
//   · Recomeçar  volta ao texto (que se mantém) para uma leitura de raiz
//
// O texto pode trazer VÁRIAS despesas («jantar 80 € e gasolina 45 €»): o
// resumo mostra uma por cartão, cada uma com a sua divisão, e dá para tirar
// ou editar uma a uma antes de registar as restantes de uma vez.
//
// Três sítios:
//   · dentro de um grupo, pelo ✨ do formulário da despesa nova (ctx dado);
//   · na página inicial, «Despesa com IA»: despesas soltas que CRIAM o grupo
//     (nome + pessoas) — ou, se o texto o disser, vão para um grupo que já
//     existe;
//   · numa despesa já registada, «Alterar com IA» (opts.alterar): diz-se o
//     que mudar («afinal foram 92 €, e a Rita também entrou») e o resumo
//     mostra o antes → depois; gravar só mexe no que mudou.
//
// As pessoas vêm da IA pelo NOME. Faz-se a correspondência com os membros
// aqui (sem acentos nem maiúsculas, primeiro nome quando é único); quem não
// bate com ninguém fica de fora, com aviso no resumo.
const AI_FN = "despesa-ia";
const AI_MAX_BYTES = 6 * 1024 * 1024;

const aiNorm = s => catNorm(s).trim().replace(/\s+/g, " ");
function aiMatchMember(name, members) {
  const n = aiNorm(name);
  if (!n) return null;
  const exact = members.find(m => aiNorm(m.name) === n);
  if (exact) return exact;
  const one = arr => arr.length === 1 ? arr[0] : null;
  return one(members.filter(m => aiNorm(m.name).split(" ")[0] === n.split(" ")[0]))
    || one(members.filter(m => aiNorm(m.name).startsWith(n) || n.startsWith(aiNorm(m.name))));
}

// imagem reduzida como a da fatura (~2000 px JPEG); PDF segue tal e qual
async function aiFileToBase64(file) {
  const blob = await shrinkReceiptImage(file);
  if (blob.size > AI_MAX_BYTES) throw new Error("O ficheiro é demasiado grande para a IA (máx. 6 MB)");
  const image = await new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] || "");
    r.onerror = () => ko(r.error);
    r.readAsDataURL(blob);
  });
  return { image, mime: blob.type || file.type || "image/jpeg" };
}

async function aiInvoke(body) {
  const { data, error } = await sb.functions.invoke(AI_FN, { body });
  if (error) {
    let msg = error.message;
    try {
      if (error.context?.status === 404) msg = "A função de IA (despesa-ia) ainda não está publicada no Supabase";
      else {
        const j = await error.context?.json?.();
        if (j?.error) msg = j.error;
      }
    } catch (_) { /* fica a mensagem genérica */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  if (!data?.resultado || typeof data.resultado !== "object") throw new Error("A IA não devolveu nada que se perceba");
  return data.resultado;
}

// Converte a resposta da IA no pré-preenchimento do formulário de despesa
// (os mesmos campos do state de renderExpenseForm). `members` pode ser de um
// grupo que ainda não existe (ids provisórios) — o resumo mostra-se igual.
function aiPlan(r, members, group, meId) {
  const avisos = [];
  const cents = v => (v === null || v === undefined || v === "" || !isFinite(Number(v))) ? null : Math.round(Number(v) * 100);
  const totalCents = Math.max(0, cents(r.valor) || 0);
  const desconhecidos = new Set();
  const resolve = (list) => {
    const ids = [], amounts = {};
    for (const it of Array.isArray(list) ? list : []) {
      const nome = typeof it === "string" ? it : it?.nome;
      const m = aiMatchMember(nome, members);
      if (!m) { if (nome) desconhecidos.add(String(nome)); continue; }
      if (ids.includes(m.id)) continue;
      ids.push(m.id);
      amounts[m.id] = cents(it?.valor);
    }
    return { ids, amounts };
  };
  const useWeights = !!group.use_weights;
  const weightOf = id => Number(members.find(m => m.id === id)?.default_weight ?? 1) || 0;
  const defaultParts = useWeights
    ? members.filter(m => (Number(m.default_weight ?? 1) || 0) > 0).map(m => m.id)
    : members.map(m => m.id);
  const fallbackPayer = meId || members[0]?.id;

  const plan = {
    desc: String(r.descricao || "").trim().slice(0, 120),
    totalCents,
    date: /^\d{4}-\d{2}-\d{2}$/.test(r.data || "") ? r.data : null,
    category: r.categoria && catOf(r.categoria) && groupCategories(group).some(c => c.id === r.categoria)
      ? r.categoria : null,
    mode: useWeights ? "weights" : "equal",
    payers: [], payerAmounts: {}, participants: [], exact: null,
  };
  if (/^\d{2}:\d{2}$/.test(r.hora || "")) plan.time = r.hora;
  else if (plan.date && plan.date !== new Date().toISOString().slice(0, 10)) plan.time = ""; // hora de agora não serve noutro dia

  const own = r.pagamento === "cada_um";
  const part = resolve(r.participantes);

  // ---- quem pagou
  if (!own) {
    const pay = resolve(r.pagadores);
    if (!pay.ids.length && fallbackPayer) pay.ids.push(fallbackPayer);
    plan.payers = pay.ids;
    const known = pay.ids.filter(id => pay.amounts[id] != null);
    const knownSum = known.reduce((a, id) => a + pay.amounts[id], 0);
    const unknown = pay.ids.filter(id => pay.amounts[id] == null);
    let amounts = null;
    if (pay.ids.length === 1) amounts = { [pay.ids[0]]: totalCents };
    else if (unknown.length && knownSum <= totalCents) {
      const rest = splitByWeights(totalCents - knownSum, unknown.map(() => 1));
      amounts = Object.fromEntries(pay.ids.map(id => [id, pay.amounts[id] ?? rest[unknown.indexOf(id)]]));
    } else if (!unknown.length && knownSum === totalCents) amounts = { ...pay.amounts };
    if (!amounts) {
      const eq = splitByWeights(totalCents, pay.ids.map(() => 1));
      amounts = Object.fromEntries(pay.ids.map((id, i) => [id, eq[i]]));
      if (totalCents) avisos.push("O que cada um pagou não somava o total — ficou repartido em partes iguais.");
    }
    plan.payerAmounts = amounts;
  }

  // ---- divisão
  if (own) {
    plan.mode = "own";
    plan.participants = part.ids.length ? part.ids : members.map(m => m.id);
  } else if (r.divisao === "valores" && part.ids.length) {
    const vals = part.ids.map(id => part.amounts[id]);
    if (vals.every(v => v != null) && vals.reduce((a, b) => a + b, 0) === totalCents) {
      plan.mode = "exact";
      plan.exact = { ...part.amounts };
    } else {
      plan.mode = "equal";
      if (totalCents) avisos.push("Os valores por pessoa não somavam o total — ficou em partes iguais.");
    }
    plan.participants = part.ids;
  } else if (r.divisao === "iguais" && part.ids.length) {
    plan.mode = "equal";
    plan.participants = part.ids;
  } else {
    // «normal»: a divisão habitual do grupo, só entre quem a IA listou
    plan.participants = part.ids.length ? part.ids : defaultParts;
    if (plan.mode === "weights" && !plan.participants.some(id => weightOf(id) > 0)) plan.mode = "equal";
  }

  for (const n of desconhecidos) avisos.push(`«${n}» não é membro do grupo — ficou de fora.`);
  if (!totalCents) avisos.push("Falta o valor — escreve-o em «Editar».");
  if (!plan.desc) avisos.push("Falta a descrição — escreve-a em «Editar».");
  plan.avisos = avisos;
  plan.duvidas = (Array.isArray(r.duvidas) ? r.duvidas : []).map(String).filter(Boolean).slice(0, 3);
  return plan;
}

// quota de cada um, para o resumo (as mesmas regras do formulário)
function aiPlanShares(plan, members) {
  const ids = plan.participants;
  if (plan.mode === "exact") return Object.fromEntries(ids.map(id => [id, plan.exact?.[id] || 0]));
  const w = plan.mode === "weights"
    ? ids.map(id => Number(members.find(m => m.id === id)?.default_weight ?? 1) || 0)
    : ids.map(() => 1);
  const parts = splitByWeights(plan.totalCents, w);
  return Object.fromEntries(ids.map((id, i) => [id, parts[i]]));
}

// Contexto de grupo igual ao de renderGroup (permissões incluídas)
function aiGroupCtx(bundle) {
  const { group, members } = bundle;
  const isOwner = group.created_by === session.user.id;
  const myMember = members.find(m => m.user_id === session.user.id);
  const myRole = isOwner ? "write_all" : (myMember?.role || "write_all");
  const canWrite = myRole !== "read" && !group.archived;
  return { ...bundle, isOwner, myMember, myRole, canWrite, archived: !!group.archived, lastSeen: null };
}

// Uma despesa gravada no formato que a IA lê e devolve (modo «alterar»)
function aiExpenseToAtual(x, members) {
  const nome = id => members.find(m => m.id === id)?.name || "?";
  const own = x.split_mode === "own";
  const exact = x.split_mode === "exact";
  return {
    descricao: x.description,
    valor: toCents(x.amount) / 100,
    data: x.expense_date,
    hora: x.expense_time ? x.expense_time.slice(0, 5) : null,
    categoria: x.category || null,
    pagamento: own ? "cada_um" : "alguem",
    pagadores: own ? [] : (x.expense_payers || [])
      .filter(p => toCents(p.amount) > 0)
      .map(p => ({ nome: nome(p.member_id), valor: toCents(p.amount) / 100 })),
    divisao: exact ? "valores" : x.split_mode === "weights" ? "normal" : "iguais",
    participantes: (x.expense_shares || [])
      .filter(s => toCents(s.amount) > 0 || own)
      .map(s => ({ nome: nome(s.member_id), valor: exact ? toCents(s.amount) / 100 : null })),
    duvidas: [],
  };
}

// O que muda entre dois planos (antes → depois). Devolve as linhas para o
// resumo e o pré-preenchimento só com o que mudou — o resto do formulário
// fica como está gravado (fatura repartida, divisão por categoria, …).
function aiPlanDiff(antes, depois, members, cur, meId) {
  const curto = nomesCurtos(members);
  const nm = id => id === meId ? "Tu" : curto(members.find(m => m.id === id)?.name || "?");
  const lista = arr => arr.length <= 1 ? arr.join("")
    : `${arr.slice(0, -1).join(", ")} e ${arr[arr.length - 1]}`;
  const hoje = new Date().toISOString().slice(0, 10);
  const pagos = p => p.mode === "own" ? "cada um o seu"
    : lista(p.payers.map(id => p.payers.length > 1 ? `${nm(id)} ${fmtMoney(p.payerAmounts[id] || 0, cur)}` : nm(id)));
  const sharesKey = p => JSON.stringify(Object.entries(aiPlanShares(p, members)).filter(([, c]) => c > 0).sort());
  const payKey = p => p.mode === "own" ? "own" : JSON.stringify(Object.entries(p.payerAmounts).filter(([, c]) => c > 0).sort());
  const divTxt = p => {
    const sh = aiPlanShares(p, members);
    const ids = p.participants;
    if (p.mode === "exact") return lista(ids.map(id => `${nm(id)} ${fmtMoney(sh[id] || 0, cur)}`));
    const quem = ids.length === members.length ? "todos" : lista(ids.map(nm));
    return `${p.mode === "weights" ? "por proporção" : p.mode === "own" ? "cada um o seu" : "igual"} entre ${quem}`;
  };
  const catTxt = id => id ? `${catOf(id).icon} ${catOf(id).label}` : "Nenhuma";
  const linhas = [];
  const pre = {};
  const mudou = (k, a, d) => linhas.push({ k, a, d });
  if (antes.desc !== depois.desc && depois.desc) { mudou("Descrição", antes.desc, depois.desc); pre.desc = depois.desc; }
  const totalMuda = antes.totalCents !== depois.totalCents && depois.totalCents > 0;
  if (totalMuda) { mudou("Valor", fmtMoney(antes.totalCents, cur), fmtMoney(depois.totalCents, cur)); pre.totalCents = depois.totalCents; }
  if ((antes.date || hoje) !== (depois.date || hoje)) {
    mudou("Data", fmtDate(antes.date || hoje), fmtDate(depois.date || hoje));
    pre.date = depois.date || hoje;
  }
  if ((antes.time || "") !== (depois.time || "") && "time" in depois) {
    mudou("Hora", antes.time || "—", depois.time || "—");
    pre.time = depois.time || "";
  }
  if ((antes.category || null) !== (depois.category || null)) {
    mudou("Categoria", catTxt(antes.category), catTxt(depois.category));
    pre.category = depois.category;
    pre.catReset = true;
  }
  if (totalMuda || payKey(antes) !== payKey(depois)) {
    if (pagos(antes) !== pagos(depois)) mudou("Quem pagou", pagos(antes), pagos(depois));
    Object.assign(pre, { payers: depois.payers, payerAmounts: depois.mode === "own" ? null : depois.payerAmounts, mode: depois.mode });
  }
  if (totalMuda || antes.mode !== depois.mode || sharesKey(antes) !== sharesKey(depois)) {
    if (divTxt(antes) !== divTxt(depois) || antes.mode !== depois.mode) mudou("Divisão", divTxt(antes), divTxt(depois));
    Object.assign(pre, { mode: depois.mode, participants: depois.participants, exact: depois.exact, divReset: true });
  }
  return { linhas, pre };
}

// Grava uma despesa nova diretamente (várias despesas de uma vez, sem passar
// pelo formulário). `pre` é o pré-preenchimento já com os ids verdadeiros.
// Devolve { erro } ou { payerRows, shareRows } (para o aviso do lote).
async function aiInsertExpense(ctx, pre, createdAt) {
  const { group, members } = ctx;
  const own = pre.mode === "own";
  const shares = aiPlanShares(pre, members);
  const paid = own ? shares : (pre.payerAmounts || {});
  const soma = o => Object.values(o).reduce((a, c) => a + c, 0);
  if (!pre.desc || !(pre.totalCents > 0)) return { erro: "falta a descrição ou o valor" };
  if (!Object.keys(shares).length || soma(shares) !== pre.totalCents) return { erro: "a divisão não soma o total" };
  if (!own && soma(paid) !== pre.totalCents) return { erro: "o que foi pago não soma o total" };

  const payload = {
    group_id: group.id,
    description: pre.desc,
    amount: (pre.totalCents / 100).toFixed(2),
    expense_date: pre.date || new Date().toISOString().slice(0, 10),
    expense_time: "time" in pre ? (pre.time || null) : new Date().toTimeString().slice(0, 5),
    split_mode: pre.mode,
    category: pre.category || null,
  };
  if (createdAt) payload.created_at = createdAt;
  // schema antigo sem alguma das colunas: grava sem ela
  const semColuna = (error) => {
    if (!error) return false;
    for (const col of ["split_mode", "expense_time", "category"]) {
      if (new RegExp(col, "i").test(error.message) && col in payload) { delete payload[col]; return true; }
    }
    return false;
  };
  let { data, error } = await sb.from("expenses").insert(payload).select().single();
  while (semColuna(error)) ({ data, error } = await sb.from("expenses").insert(payload).select().single());
  if (error) return { erro: error.code === "23505" ? "já existe uma despesa igual no grupo" : error.message };

  const rows = o => Object.entries(o).filter(([, c]) => c > 0)
    .map(([id, c]) => ({ expense_id: data.id, member_id: id, amount: (c / 100).toFixed(2) }));
  const payerRows = rows(paid), shareRows = rows(shares);
  const i1 = await sb.from("expense_payers").insert(payerRows);
  const i2 = await sb.from("expense_shares").insert(shareRows);
  if (i1.error || i2.error) {
    // sem transação no PostgREST: uma despesa sem quotas estragava os saldos
    await sb.from("expenses").delete().eq("id", data.id);
    return { erro: (i1.error || i2.error).message };
  }
  if (pre.category) learnCategory(pre.desc, pre.category);
  return { payerRows: own ? [] : payerRows, shareRows: own ? [] : shareRows };
}

// opts: { ctx } dentro de um grupo; sem ctx é a despesa solta da página
// inicial; { ctx, alterar: despesa } para mudar uma despesa já registada.
// onClose fecha tudo; onBack (opcional) volta ao ecrã de onde se veio.
function renderAiExpense(slot, opts) {
  const inGroup = !!opts.ctx;
  const alterar = inGroup && opts.alterar ? opts.alterar : null;
  const me = session.user;
  const meName = opts.ctx?.myMember?.name || me.user_metadata?.full_name || me.email;
  const hojeISO = () => new Date().toISOString().slice(0, 10);
  const st = {
    fase: "texto",          // texto | lendo | resumo
    texto: "",
    file: null, preview: null,
    erro: "",
    // a última resposta da IA (vai como `anterior` na correção): no modo
    // «alterar» é a despesa; nos outros { grupo, pessoas, despesas, duvidas }
    res: null,
    plans: [],              // o que vai ser gravado (aiPlan), uma por despesa
    incl: [],               // despesas marcadas para registar (várias)
    feitas: 0,              // despesas já gravadas a partir deste ecrã
    correcao: "",
    // despesa solta: o grupo de destino
    alvo: null,             // { tipo: "novo", nome, pessoas: [{ id, name, email, me }] } | { tipo: "existente", ctx }
    criado: null,           // { ctx, idMap } depois de o grupo novo ser criado
    ocupado: false,
  };
  const despesasDe = res => alterar ? [res] : (Array.isArray(res?.despesas) ? res.despesas : []);

  // dados de contexto para a despesa solta (grupos e pessoas conhecidas)
  let contexto = null;
  async function carregarContexto() {
    if (contexto) return contexto;
    const [groups, m, book] = await Promise.all([
      cache.groups ? Promise.resolve(cache.groups) : fetchGroups(),
      fetchAllRows((from, to) => sb.from("group_members").select("group_id, name").order("id").range(from, to)),
      loadPeopleBook(),
    ]);
    const nomes = {};
    for (const r of m.data || []) (nomes[r.group_id] ??= []).push(r.name);
    const ativos = groups.filter(g => !g.archived).slice(0, 30);
    contexto = {
      grupos: ativos.map((g, i) => ({ key: `g${i + 1}`, id: g.id, nome: g.name, membros: nomes[g.id] || [] })),
      book: book || [],
    };
    return contexto;
  }

  const voltar = () => {
    if (st.preview) URL.revokeObjectURL(st.preview);
    if (st.feitas) return terminar();
    (opts.onBack || opts.onClose)();
  };

  // ------------------------------------------------------------ chamar a IA
  async function ler({ corrigir = false } = {}) {
    if (!st.texto.trim() && !st.file) {
      st.erro = alterar ? "Diz o que queres mudar." : "Escreve a despesa ou junta uma fotografia.";
      return draw();
    }
    if (corrigir && !st.correcao.trim()) return;
    const voltarA = st.fase;
    st.fase = "lendo"; st.erro = ""; draw();
    try {
      const hoje = new Date();
      const body = {
        modo: alterar ? "alterar" : inGroup ? "despesa" : "grupo",
        texto: st.texto.trim(),
        hoje: hoje.toISOString().slice(0, 10),
        hora: hoje.toTimeString().slice(0, 5),
        eu: meName,
        moeda: opts.ctx?.group.currency || "EUR",
      };
      if (inGroup) {
        const { group, members } = opts.ctx;
        body.categorias = groupCategories(group).map(c => ({ id: c.id, label: c.label }));
        body.membros = members.map(m => m.name);
        body.grupo_nome = group.name;
        body.divisao_normal = group.use_weights ? "proporcao" : "iguais";
        if (alterar) body.atual = aiExpenseToAtual(alterar, members);
      } else {
        const c = await carregarContexto();
        body.categorias = CATEGORIES.map(c2 => ({ id: c2.id, label: c2.label }));
        body.grupos = c.grupos.map(g => ({ id: g.key, nome: g.nome, membros: g.membros }));
        body.conhecidos = c.book.slice(0, 80).map(p => p.name);
      }
      if (st.file) Object.assign(body, await aiFileToBase64(st.file));
      if (corrigir && st.res) { body.anterior = st.res; body.correcao = st.correcao.trim(); }
      let res = await aiInvoke(body);
      // resposta à moda antiga (a despesa solta no topo): embrulha-se
      if (!alterar && !Array.isArray(res.despesas)) {
        const { grupo, pessoas, ...d } = res;
        res = { grupo, pessoas, despesas: [d], duvidas: [] };
      }
      if (!despesasDe(res).length) throw new Error("A IA não encontrou nenhuma despesa no texto");
      st.res = res;
      st.correcao = "";
      if (!inGroup && !st.criado) await escolherAlvo(res);
      replan();
      st.fase = "resumo";
    } catch (e) {
      st.erro = e.message || String(e);
      st.fase = voltarA === "resumo" ? "resumo" : "texto";
    }
    if (slot.isConnected) draw();
  }

  // despesa solta: grupo existente (se a IA o reconheceu e se pode lançar
  // lá) ou grupo novo com as pessoas que a IA listou
  async function escolherAlvo(res) {
    const c = await carregarContexto();
    const g = c.grupos.find(x => x.key === res?.grupo?.existente);
    if (g) {
      try {
        const ctx = aiGroupCtx(await fetchGroupBundle(g.id));
        if (ctx.canWrite && ctx.members.length) { st.alvo = { tipo: "existente", ctx }; return; }
        st.erro = `Não podes lançar despesas em «${g.nome}» — vai para um grupo novo.`;
      } catch (_) { /* cai no grupo novo */ }
    }
    alvoNovo(res, st.alvo?.tipo === "novo" ? st.alvo.nome : null);
  }
  function alvoNovo(res, nomeAtual) {
    const c = contexto || { book: [] };
    const nomes = [];
    const junta = n => {
      const s = String(n || "").trim().slice(0, 60);
      if (s && !nomes.some(x => aiNorm(x) === aiNorm(s))) nomes.push(s);
    };
    junta(meName);
    (res.pessoas || []).forEach(junta);
    // quem aparece a pagar ou na divisão mas faltou em «pessoas»
    for (const d of despesasDe(res)) {
      [...(d.pagadores || []), ...(d.participantes || [])].forEach(p => {
        if (!aiMatchMember(p?.nome, nomes.map(n => ({ name: n })))) junta(p?.nome);
      });
    }
    const pessoas = nomes.map((name, i) => {
      const isMe = i === 0;
      const known = isMe ? null : c.book.find(p => p.normName === aiNorm(name));
      return { id: `novo:${i}`, name, email: isMe ? me.email : (known?.email || null), me: isMe, default_weight: 1 };
    });
    const d0 = despesasDe(res)[0];
    st.alvo = { tipo: "novo", nome: (nomeAtual || res?.grupo?.nome || d0?.descricao || "Novo grupo").slice(0, 60), pessoas };
  }

  // Refaz os planos a partir da resposta e do grupo de destino. Só acontece
  // quando chega uma resposta ou se troca de grupo: mudar o nome de uma
  // pessoa do grupo novo não mexe na divisão (os ids provisórios ficam).
  function replan() {
    const { group, members, meId } = alvoAtual();
    st.plans = despesasDe(st.res).map(d => aiPlan(d, members, group, meId));
    // uma despesa sem valor ou descrição não entra no lote (edita-se à parte)
    st.incl = st.plans.map(p => p.totalCents > 0 && !!p.desc);
  }

  // o grupo e os membros que o resumo está a usar
  function alvoAtual() {
    if (inGroup) return { group: opts.ctx.group, members: opts.ctx.members, meId: opts.ctx.myMember?.id };
    if (st.alvo.tipo === "existente") {
      const ctx = st.alvo.ctx;
      return { group: ctx.group, members: ctx.members, meId: ctx.myMember?.id };
    }
    return { group: { currency: "EUR", use_weights: false, categories: null }, members: st.alvo.pessoas, meId: "novo:0" };
  }

  // ------------------------------------------------------------- gravar
  // Cria (uma vez só) o grupo novo e os membros e devolve { ctx, idMap } —
  // idMap traduz os ids provisórios do resumo para os verdadeiros.
  async function prepararGrupo() {
    if (inGroup) return { ctx: opts.ctx, idMap: null };
    if (st.alvo.tipo === "existente") return { ctx: st.alvo.ctx, idMap: null };
    if (st.criado) return st.criado;
    const nome = st.alvo.nome.trim();
    if (!nome) throw new Error("Dá um nome ao grupo");
    const { data: group, error } = await sb.from("groups").insert({ name: nome, currency: "EUR" }).select().single();
    if (error) throw error;
    const idMap = {};
    for (const p of st.alvo.pessoas) {
      const row = { group_id: group.id, name: p.name.trim() || "?", email: p.email || null };
      if (p.me) Object.assign(row, { user_id: me.id, email: me.email, role: "write_all" });
      let { data, error: e2 } = await sb.from("group_members").insert(row).select().single();
      // schema antigo sem a coluna role
      if (e2 && p.me && /(\brole\b|column .*role)/i.test(e2.message)) {
        delete row.role;
        ({ data, error: e2 } = await sb.from("group_members").insert(row).select().single());
      }
      if (e2) throw e2;
      idMap[p.id] = data.id;
    }
    cache.groups = null;
    st.criado = { ctx: aiGroupCtx(await fetchGroupBundle(group.id)), idMap };
    return st.criado;
  }

  function prefillDe(plan, idMap, comFatura) {
    const t = id => (idMap ? idMap[id] : id);
    const mapObj = o => o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [t(k), v])) : null;
    return {
      desc: plan.desc, totalCents: plan.totalCents, date: plan.date, category: plan.category,
      ...("time" in plan ? { time: plan.time } : {}),
      mode: plan.mode,
      payers: plan.payers.map(t), payerAmounts: plan.mode === "own" ? null : mapObj(plan.payerAmounts),
      participants: plan.participants.map(t), exact: mapObj(plan.exact),
      receiptFile: comFatura && st.file && receiptFileOk(st.file) ? st.file : null,
    };
  }

  // terminou: dentro do grupo redesenha-o; fora, vai para o grupo
  function terminar(ctx) {
    const gid = ctx?.group.id || st.criado?.ctx.group.id || (st.alvo?.tipo === "existente" ? st.alvo.ctx.group.id : null);
    if (inGroup || !gid) return refresh();
    const h = `#/g/${gid}/despesas`;
    if (location.hash === h) refresh(); else location.hash = h;
  }

  // abre o formulário com a despesa i (ou a única) — a gravar já ou a editar
  async function seguir(autoSave, i = 0) {
    if (st.ocupado) return;
    const plan = st.plans[i];
    const varias = st.plans.length > 1;
    st.ocupado = true; draw();
    let prep;
    try {
      prep = await prepararGrupo();
    } catch (e) {
      st.ocupado = false;
      toast(e.message || String(e), true);
      return draw();
    }
    // o «Voltar» do formulário regressa a este resumo (o grupo novo, se foi
    // criado, fica criado — o resumo passa a usá-lo)
    const back = () => { st.ocupado = false; draw(); };
    const onSaved = varias
      ? () => {
          // esta já está: sai do lote e volta-se ao resumo com as restantes
          st.feitas++;
          st.res = { ...st.res, despesas: despesasDe(st.res).filter((_, k) => k !== i) };
          st.plans.splice(i, 1);
          st.incl.splice(i, 1);
          st.ocupado = false;
          if (!st.plans.length) return terminar(prep.ctx);
          invalidateGroupCache();
          draw();
        }
      : () => terminar(prep.ctx);
    renderExpenseForm(slot, prep.ctx, null, back, {
      prefill: prefillDe(plan, prep.idMap, !varias),
      autoSave,
      backLabel: "Voltar",
      onSaved,
    });
  }

  // várias despesas: grava as marcadas de uma vez, com um aviso só
  async function registarTodas() {
    if (st.ocupado) return;
    const idx = st.plans.map((_, i) => i).filter(i => st.incl[i]);
    if (!idx.length) return toast("Marca pelo menos uma despesa", true);
    st.ocupado = true; draw();
    let prep;
    try {
      prep = await prepararGrupo();
    } catch (e) {
      st.ocupado = false;
      toast(e.message || String(e), true);
      return draw();
    }
    const { ctx } = prep;
    const gravadas = [], falhas = [];
    const pagos = {}, quotas = {};
    const agora = Date.now();
    for (const [n, i] of idx.entries()) {
      const pre = prefillDe(st.plans[i], prep.idMap, false);
      // o índice anti-duplicado do servidor: afasta o carimbo de criação de
      // duas despesas iguais no mesmo lote (como na importação)
      const igual = idx.slice(0, n).some(j => st.plans[j].desc === pre.desc && st.plans[j].totalCents === pre.totalCents);
      const r = await aiInsertExpense(ctx, pre, igual ? new Date(agora - (n + 1) * 61000).toISOString() : null);
      if (r.erro) { falhas.push({ i, erro: r.erro }); continue; }
      gravadas.push(i);
      for (const row of r.payerRows) pagos[row.member_id] = (pagos[row.member_id] || 0) + toCents(row.amount);
      for (const row of r.shareRows) quotas[row.member_id] = (quotas[row.member_id] || 0) + toCents(row.amount);
    }
    if (gravadas.length && Object.keys(quotas).length) {
      const descs = gravadas.map(i => st.plans[i].desc);
      const total = Object.values(quotas).reduce((a, c) => a + c, 0);
      const toRows = o => Object.entries(o).map(([id, c]) => ({ member_id: id, amount: (c / 100).toFixed(2) }));
      notifyExpenseAdded(ctx.group, ctx.members,
        descs.length === 1 ? descs[0] : `${descs.length} despesas (${descs.slice(0, 3).join(", ")}${descs.length > 3 ? ", …" : ""})`,
        total, toRows(pagos), toRows(quotas));
    }
    st.feitas += gravadas.length;
    st.ocupado = false;
    if (!falhas.length) {
      toast(gravadas.length === 1 ? "Despesa adicionada" : `${gravadas.length} despesas adicionadas`);
      return terminar(ctx);
    }
    // o que falhou fica no resumo para se editar à parte
    const ficam = new Set(falhas.map(f => f.i));
    st.res = { ...st.res, despesas: despesasDe(st.res).filter((_, k) => ficam.has(k)) };
    st.plans = st.plans.filter((_, k) => ficam.has(k));
    st.incl = st.plans.map(() => false);
    st.erro = falhas.map(f => f.erro).filter((e, k, a) => a.indexOf(e) === k).join("; ");
    toast(`${gravadas.length} gravadas, ${falhas.length} por gravar`, true);
    invalidateGroupCache();
    draw();
  }

  // modo «alterar»: o plano da despesa como está, para comparar
  function diffAlterar() {
    const { group, members, meId } = alvoAtual();
    const antes = aiPlan(aiExpenseToAtual(alterar, members), members, group, meId);
    // a hora gravada conta sempre (o aiPlan só a guarda quando vem)
    antes.time = alterar.expense_time ? alterar.expense_time.slice(0, 5) : "";
    const depois = st.plans[0];
    if (!("time" in depois)) depois.time = antes.time;
    return aiPlanDiff(antes, depois, members, group.currency, meId);
  }
  function guardarAlteracao(autoSave) {
    const { pre } = diffAlterar();
    if (st.file && receiptFileOk(st.file)) pre.receiptFile = st.file;
    renderExpenseForm(slot, opts.ctx, alterar, () => draw(), {
      prefill: pre, autoSave, backLabel: "Voltar",
    });
  }

  // ------------------------------------------------------------- ecrãs
  // depois de gravada alguma despesa do lote, sair já não volta ao formulário
  const backBtn = () => `<button type="button" class="xp-icon-btn" id="ai-back" aria-label="${opts.onBack && !st.feitas ? "Voltar" : "Fechar"}">${uiIco(opts.onBack && !st.feitas ? "back" : "x")}</button>`;
  // ------------------------------------------------------------- ecrãs
  function draw() {
    slot.classList.add("modal-card-flush");
    slot.parentElement?.classList.add("modal-full");
    const titulo = alterar ? "Alterar com IA" : inGroup ? `Despesa com IA · ${opts.ctx.group.name}` : "Despesa com IA";
    const cabecalho = (sub, t = titulo) => `
      <header class="xp-head ai-head">
        <div class="xp-head-bar">
          ${backBtn()}
          <span class="xp-head-title">${esc(t)}</span>
          <span class="xp-head-spacer"></span>
        </div>
        ${sub}
      </header>`;

    if (st.fase === "lendo") {
      slot.innerHTML = `
        <div class="xp ai">
          ${cabecalho(`<p class="ai-lead">${uiIco("sparkle")} ${alterar ? "A aplicar a alteração…" : "A ler a despesa…"}</p>`)}
          <div class="xp-body ai-lendo"><div class="spinner" role="status" aria-label="A ler"></div>
            <p class="muted">${st.file ? "A olhar para a imagem e para o texto." : alterar ? "A ver o que muda." : "A perceber quem pagou e como se divide."}</p></div>
        </div>`;
      slot.querySelector("#ai-back").onclick = voltar;
      return;
    }

    if (st.fase === "texto") return drawTexto(cabecalho);
    return drawResumo();
  }

  function drawTexto(cabecalho) {
    const exemplos = alterar
      ? ["Afinal foram 92 €", "A Rita também entrou", "Foi o João que pagou", "Foi no sábado"]
      : inGroup
        ? ["Jantar de ontem no sushi, 84 €, paguei eu, dividido por todos menos a Rita",
           "Supermercado 62,40 € pago pelo João e gasolina 45 € paga por mim, tudo a meias"]
        : ["Jantar no Porto com a Ana, o Rui e a Marta: 120 €, paguei eu, partes iguais",
           "Viagem ao Gerês com o Rui e a Ana: gasolina 70 € (Rui), casa 240 € (eu), supermercado 58 € (Ana)"];
    const lead = alterar
      ? `Diz o que queres mudar em <strong>${esc(alterar.description)}</strong> (${esc(fmtMoney(toCents(alterar.amount), opts.ctx.group.currency))}).`
      : `Diz por palavras tuas o que foi, quanto, quem pagou e por quem se divide — podem ser várias despesas de uma vez${inGroup ? "" : ", e a IA cria o grupo"}. Podes juntar a foto do talão.`;
    slot.innerHTML = `
      <div class="xp ai">
        ${cabecalho(`<p class="ai-lead">${lead}</p>`)}
        <div class="xp-body">
          <textarea id="ai-texto" class="ai-texto" rows="5" maxlength="2000"
            placeholder="Ex.: ${esc(exemplos[0])}">${esc(st.texto)}</textarea>
          ${alterar ? `<div class="ai-exemplos chips">
            ${exemplos.map((e, i) => `<button type="button" class="ai-ex" data-ex="${i}">${esc(e)}</button>`).join("")}
          </div>` : ""}
          <div class="ai-anexo">
            ${st.file ? `
              <div class="ai-anexo-f">
                ${st.preview ? `<img src="${st.preview}" alt="" />` : uiIco("doc")}
                <span>${esc(st.file.name || "Imagem")}</span>
                <button type="button" class="link-btn" id="ai-file-del">Tirar</button>
              </div>` : `
              <label class="ai-anexo-btn">${uiIco("camera")} Fotografar talão
                <input type="file" accept="image/*" capture="environment" data-ai-file hidden /></label>
              <label class="ai-anexo-btn">${uiIco("clip")} Escolher ficheiro
                <input type="file" accept="image/*,application/pdf" data-ai-file hidden /></label>`}
          </div>
          ${st.erro ? `<p class="xp-aviso">${esc(st.erro)}</p>` : ""}
          <p class="ai-nota muted">Nada fica gravado sem confirmares no passo seguinte.</p>
        </div>
        <footer class="xp-foot">
          <button class="xp-cta" id="ai-ler">${uiIco("sparkle")} ${alterar ? "Alterar com IA" : "Ler com IA"}</button>
        </footer>
      </div>`;
    slot.querySelector("#ai-back").onclick = voltar;
    const $t = slot.querySelector("#ai-texto");
    $t.oninput = () => { st.texto = $t.value; };
    $t.onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ler(); };
    setTimeout(() => $t.focus(), 50);
    slot.querySelectorAll("[data-ex]").forEach(b => b.onclick = () => {
      st.texto = exemplos[+b.dataset.ex]; $t.value = st.texto; $t.focus();
    });
    slot.querySelectorAll("[data-ai-file]").forEach(inp => inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) return;
      if (!(f.type.startsWith("image/") || f.type === "application/pdf")) return toast("Tem de ser uma imagem ou um PDF", true);
      if (f.type === "application/pdf" && f.size > AI_MAX_BYTES) return toast("O PDF passa dos 6 MB", true);
      if (st.preview) URL.revokeObjectURL(st.preview);
      st.file = f;
      st.preview = f.type.startsWith("image/") ? URL.createObjectURL(f) : null;
      draw();
    });
    slot.querySelector("#ai-file-del")?.addEventListener("click", () => {
      if (st.preview) URL.revokeObjectURL(st.preview);
      st.file = null; st.preview = null; draw();
    });
    slot.querySelector("#ai-ler").onclick = () => ler();
  }

  function drawResumo() {
    const { group, members, meId } = alvoAtual();
    const plans = st.plans;
    const varias = plans.length > 1;
    const cur = group.currency || "EUR";
    const curto = nomesCurtos(members);
    const nameOf = id => id === meId ? "Tu" : curto(members.find(m => m.id === id)?.name || "?");
    const fullName = id => members.find(m => m.id === id)?.name || "?";
    const pessoa = (id, cents) => `
      <li class="xv-li">${avatarHtml(fullName(id), "sm")}
        <span class="xv-name">${esc(nameOf(id))}</span>
        ${cents == null ? "" : `<span class="xv-amt">${fmtMoney(cents, cur)}</span>`}</li>`;
    const modoTxt = plan => plan.mode === "own" ? "cada um pagou a sua parte"
      : plan.mode === "exact" ? "valores definidos"
      : plan.mode === "weights" ? "por proporção"
      : plan.participants.length === members.length ? "partes iguais, entre todos" : `partes iguais, entre ${plan.participants.length}`;
    const quandoTxt = plan => {
      const cat = plan.category ? catOf(plan.category) : null;
      return esc(fmtDate(plan.date || hojeISO()) + (plan.time ? ` · ${plan.time}` : ""))
        + (cat ? ` · ${esc(`${cat.icon} ${cat.label}`)}` : "");
    };
    const avisosHtml = arr => arr.length ? `<ul class="ai-avisos">${arr.map(a => `<li>${esc(a)}</li>`).join("")}</ul>` : "";
    const detalhe = plan => {
      const shares = aiPlanShares(plan, members);
      return `${plan.mode === "own" ? "" : `
        <h3 class="xv-h">Quem pagou</h3>
        <ul class="xv-list">${plan.payers.map(id => pessoa(id, plan.payerAmounts[id])).join("")}</ul>`}
        <h3 class="xv-h">Como se divide <span class="muted">· ${esc(modoTxt(plan))}</span></h3>
        <ul class="xv-list">${plan.participants.map(id => pessoa(id, plan.mode === "own" ? null : shares[id])).join("")}</ul>`;
    };

    // ---- o grupo (despesa solta)
    let grupoHtml = "";
    if (!inGroup && st.criado) {
      grupoHtml = `
        <div class="ai-grupo">
          <div class="ai-grupo-l"><span class="muted">Grupo criado</span><strong>${esc(st.criado.ctx.group.name)}</strong></div>
        </div>`;
    } else if (!inGroup && st.alvo.tipo === "existente") {
      grupoHtml = `
        <div class="ai-grupo">
          <div class="ai-grupo-l"><span class="muted">Vai para o grupo</span><strong>${esc(st.alvo.ctx.group.name)}</strong></div>
          <button type="button" class="link-btn" id="ai-grupo-novo">Criar grupo novo</button>
        </div>`;
    } else if (!inGroup) {
      grupoHtml = `
        <div class="ai-grupo novo">
          <label class="field"><span class="muted">Grupo novo</span>
            <input id="ai-grupo-nome" value="${esc(st.alvo.nome)}" maxlength="60" placeholder="Nome do grupo" /></label>
          <p class="ai-grupo-sub muted">Pessoas — toca num nome para o mudar:</p>
          <ul class="ai-pessoas">
            ${st.alvo.pessoas.map((p, i) => `
              <li>${avatarHtml(p.name, "sm")}
                ${p.me ? `<span class="ai-p-nome">${esc(p.name)} <span class="muted">(tu)</span></span>`
                  : `<input class="ai-p-input" data-pessoa="${i}" value="${esc(p.name)}" maxlength="60" />`}
                ${!p.me && p.email ? `<span class="ai-p-mail" title="${esc(p.email)}">${uiIco("user")}</span>` : ""}
              </li>`).join("")}
          </ul>
        </div>`;
    }
    const geral = !alterar && Array.isArray(st.res?.duvidas) ? st.res.duvidas.map(String).filter(Boolean).slice(0, 3) : [];

    // ---- cabeçalho e corpo, conforme o caso
    let head, corpo, foot;
    const corrigir = `
      <div class="ai-corrigir">
        <label for="ai-corr" class="xv-h">Não é bem isto? Diz o que mudar</label>
        <div class="ai-corr-row">
          <input id="ai-corr" value="${esc(st.correcao)}" maxlength="600"
            placeholder="${alterar ? "Ex.: a hora estava certa, não mudes" : varias ? "Ex.: a gasolina foi só entre mim e o Rui" : "Ex.: afinal foi o João que pagou"}" enterkeyhint="send" />
          <button type="button" id="ai-corr-ok" ${st.correcao.trim() ? "" : "disabled"}>Corrigir</button>
        </div>
        ${st.erro ? `<p class="xp-aviso">${esc(st.erro)}</p>` : ""}
        <button type="button" class="link-btn" id="ai-recomecar">${uiIco("repeat")} Recomeçar com outro texto</button>
      </div>`;

    if (alterar) {
      const plan = plans[0];
      const { linhas } = diffAlterar();
      head = `
        <div class="xv-amount">${plan.totalCents ? fmtMoney(plan.totalCents, cur) : "—"}</div>
        <p class="xv-desc">${esc(plan.desc || alterar.description)}</p>
        <p class="xp-quando">${quandoTxt(plan)}</p>`;
      corpo = `
        ${avisosHtml([...plan.avisos, ...plan.duvidas])}
        <h3 class="xv-h">O que muda</h3>
        ${linhas.length ? `<ul class="ai-diff">${linhas.map(l => `
          <li><span class="ai-diff-k">${esc(l.k)}</span>
            <span class="ai-diff-v"><s>${esc(l.a)}</s><span class="ai-diff-arr">→</span><strong>${esc(l.d)}</strong></span></li>`).join("")}</ul>`
          : `<p class="muted">A IA não encontrou nada para mudar. Corrige o pedido em baixo ou recomeça.</p>`}
        ${st.file ? `<p class="ai-nota muted">${uiIco("clip")} A ${st.file.type === "application/pdf" ? "fatura em PDF" : "fotografia"} passa a ser a fatura da despesa.</p>` : ""}
        ${detalhe(plan)}`;
      foot = `
        <button class="secondary" id="ai-editar" ${st.ocupado ? "disabled" : ""}>${uiIco("edit")} Editar</button>
        <button class="xp-cta" id="ai-ok" ${st.ocupado || (!linhas.length && !st.file) ? "disabled" : ""}>Guardar alterações</button>`;
    } else if (!varias) {
      const plan = plans[0];
      head = `
        <div class="xv-amount">${plan.totalCents ? fmtMoney(plan.totalCents, cur) : "—"}</div>
        <p class="xv-desc">${esc(plan.desc || "Sem descrição")}</p>
        <p class="xp-quando">${quandoTxt(plan)}</p>`;
      corpo = `
        ${grupoHtml}
        ${avisosHtml([...geral, ...plan.avisos, ...plan.duvidas])}
        ${detalhe(plan)}
        ${st.file ? `<p class="ai-nota muted">${uiIco("clip")} A ${st.file.type === "application/pdf" ? "fatura em PDF" : "fotografia"} fica anexada à despesa.</p>` : ""}`;
      const criar = !inGroup && st.alvo.tipo === "novo" && !st.criado;
      foot = `
        <button class="secondary" id="ai-editar" ${st.ocupado ? "disabled" : ""}>${uiIco("edit")} Editar</button>
        <button class="xp-cta" id="ai-ok" ${st.ocupado || !plan.totalCents || !plan.desc ? "disabled" : ""}>
          ${st.ocupado ? "A preparar…" : criar ? "Criar grupo e registar" : "Registar"}</button>`;
    } else {
      const n = st.incl.filter(Boolean).length;
      const total = plans.reduce((a, p, i) => a + (st.incl[i] ? p.totalCents : 0), 0);
      head = `
        <div class="xv-amount">${fmtMoney(total, cur)}</div>
        <p class="xv-desc">${plans.length} despesas</p>
        <p class="xp-quando">${n === plans.length ? "todas marcadas para registar" : `${n} de ${plans.length} marcadas`}</p>`;
      const cartao = (plan, i) => {
        const ok = plan.totalCents > 0 && !!plan.desc;
        const shares = aiPlanShares(plan, members);
        const vals = plan.participants.map(id => shares[id] || 0);
        const iguais = vals.length && vals.every(v => Math.abs(v - vals[0]) <= 1);
        const pagou = plan.mode === "own" ? "Cada um pagou o seu"
          : `Pagou ${plan.payers.map(id => plan.payers.length > 1 ? `${nameOf(id)} ${fmtMoney(plan.payerAmounts[id] || 0, cur)}` : nameOf(id)).join(", ")}`;
        const div = plan.mode === "own" ? `entre ${plan.participants.length}`
          : plan.mode === "exact" ? plan.participants.map(id => `${nameOf(id)} ${fmtMoney(shares[id] || 0, cur)}`).join(" · ")
          : `${plan.participants.length === members.length ? "Entre todos" : plan.participants.map(nameOf).join(", ")}${iguais && plan.totalCents ? ` · ${fmtMoney(vals[0], cur)} cada` : ""}`;
        return `
          <li class="ai-card ${st.incl[i] ? "on" : ""}">
            <label class="ai-card-top">
              <input type="checkbox" data-incl="${i}" ${st.incl[i] ? "checked" : ""} ${ok ? "" : "disabled"} />
              <span class="ai-card-t">
                <strong>${esc(plan.desc || "Sem descrição")}</strong>
                <small>${quandoTxt(plan)}</small>
              </span>
              <span class="ai-card-v">${plan.totalCents ? fmtMoney(plan.totalCents, cur) : "—"}</span>
            </label>
            <p class="ai-card-l">${esc(pagou)}</p>
            <p class="ai-card-l muted">${esc(div)}</p>
            ${avisosHtml([...plan.avisos, ...plan.duvidas])}
            <button type="button" class="link-btn" data-editar="${i}">${uiIco("edit")} Editar esta${ok ? "" : " (para a poder registar)"}</button>
          </li>`;
      };
      corpo = `
        ${grupoHtml}
        ${avisosHtml(geral)}
        ${st.feitas ? `<p class="ai-nota muted">${uiIco("check")} ${st.feitas === 1 ? "Uma já está gravada" : `${st.feitas} já estão gravadas`}.</p>` : ""}
        <ul class="ai-cards">${plans.map(cartao).join("")}</ul>
        ${st.file ? `<p class="ai-nota muted">Com várias despesas, a fotografia não fica anexada — junta-a depois à que for, em «Editar».</p>` : ""}`;
      const criar = !inGroup && st.alvo.tipo === "novo" && !st.criado;
      foot = `
        <button class="xp-cta" id="ai-todas" ${st.ocupado || !n ? "disabled" : ""}>
          ${st.ocupado ? "A gravar…" : `${criar ? "Criar grupo e registar" : "Registar"} ${n === 1 ? "1 despesa" : `${n} despesas`}`}</button>`;
    }

    slot.innerHTML = `
      <div class="xp ai">
        <header class="xp-head ai-head">
          <div class="xp-head-bar">
            ${backBtn()}
            <span class="xp-head-title">${alterar ? "O que a IA vai mudar" : "O que a IA percebeu"}</span>
            <span class="xp-head-spacer"></span>
          </div>
          ${head}
        </header>
        <div class="xp-body">
          ${corpo}
          ${corrigir}
        </div>
        <footer class="xp-foot ai-foot">${foot}</footer>
      </div>`;

    slot.querySelector("#ai-back").onclick = voltar;
    const $corr = slot.querySelector("#ai-corr");
    const $corrOk = slot.querySelector("#ai-corr-ok");
    $corr.oninput = () => { st.correcao = $corr.value; $corrOk.disabled = !st.correcao.trim(); };
    $corr.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); ler({ corrigir: true }); } };
    $corrOk.onclick = () => ler({ corrigir: true });
    slot.querySelector("#ai-recomecar").onclick = () => { st.fase = "texto"; st.erro = ""; draw(); };
    if (alterar) {
      slot.querySelector("#ai-editar").onclick = () => guardarAlteracao(false);
      slot.querySelector("#ai-ok").onclick = () => guardarAlteracao(true);
    } else {
      slot.querySelector("#ai-editar")?.addEventListener("click", () => seguir(false));
      slot.querySelector("#ai-ok")?.addEventListener("click", () => seguir(true));
      slot.querySelector("#ai-todas")?.addEventListener("click", registarTodas);
      slot.querySelectorAll("[data-editar]").forEach(b => b.onclick = () => seguir(false, +b.dataset.editar));
      slot.querySelectorAll("[data-incl]").forEach(cb => cb.onchange = () => { st.incl[+cb.dataset.incl] = cb.checked; draw(); });
    }
    slot.querySelector("#ai-grupo-novo")?.addEventListener("click", () => { alvoNovo(st.res, null); replan(); draw(); });
    const $gn = slot.querySelector("#ai-grupo-nome");
    if ($gn) $gn.oninput = () => { st.alvo.nome = $gn.value; };
    // mudar o nome de uma pessoa só muda o nome: a divisão mantém-se
    slot.querySelectorAll("[data-pessoa]").forEach(inp => {
      inp.onchange = () => {
        const p = st.alvo.pessoas[+inp.dataset.pessoa];
        const novo = inp.value.trim();
        if (!novo || novo === p.name) { inp.value = p.name; return; }
        // numa correção a IA parte da resposta anterior: leva já o nome novo
        // (a divisão do resumo não se mexe — vive nos planos, por ids)
        const ren = x => (x && aiNorm(x.nome) === aiNorm(p.name) ? { ...x, nome: novo } : x);
        st.res = {
          ...st.res,
          pessoas: (st.res.pessoas || []).map(n => (aiNorm(n) === aiNorm(p.name) ? novo : n)),
          despesas: despesasDe(st.res).map(d => ({
            ...d,
            pagadores: (d.pagadores || []).map(ren),
            participantes: (d.participantes || []).map(ren),
          })),
        };
        const known = (contexto?.book || []).find(b => b.normName === aiNorm(novo));
        p.name = novo;
        p.email = known?.email || null;
        draw();
      };
    });
  }

  draw();
}

// ------------------------------------- importar movimentos (texto colado)
// Cola-se o que estava escrito no bloco de notas e a app faz o resto: o
// parser (import-parser.js) tira de cada linha a data, a descrição e o
// valor, e este ecrã mostra o que percebeu — linha a linha, tudo editável
// — antes de gravar seja o que for. Por baixo de cada movimento fica o
// texto original, que é o que deixa conferir sem reler o bloco de notas.
//
// Os defaults são os de sempre: a despesa fica em nome de quem importa e
// divide-se pelo normal do grupo. Quem pagou e como se divide escolhe-se
// uma vez, em cima, e vale para o lote todo — os ajustes que sobram são
// por linha (data, descrição, valor, categoria).
function renderImportForm(slot, ctx, onClose) {
  const { group, members, expenses } = ctx;
  const cur = group.currency;
  const hoje = new Date().toISOString().slice(0, 10);
  const close = onClose || (() => { slot.innerHTML = ""; });
  const useWeights = !!group.use_weights;
  const myMember = members.find(m => m.user_id === session.user.id);
  const catsDoGrupo = groupCategories(group);
  const catsPermitidas = new Set(catsDoGrupo.map(c => c.id));

  const ICONS_IM = {
    back: '<path d="M15 19 8 12l7-7"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
    users: '<circle cx="9.2" cy="8" r="3.4"/><path d="M2.6 19.5a6.6 6.6 0 0 1 13.2 0"/><path d="M16.2 5.3a3.4 3.4 0 0 1 0 5.4"/><path d="M17.6 13.9a6.6 6.6 0 0 1 3.8 5.6"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  };
  const ico = (n, cls = "") =>
    `<svg class="xp-ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS_IM[n]}</svg>`;
  const SIMBOLO_IM = { EUR: "€", USD: "$", GBP: "£", BRL: "R$" };
  const curto = nomesCurtos(members);
  const nomeDe = id => members.find(m => m.id === id)?.name || "?";

  const state = {
    fase: "colar",          // colar | confirmar
    texto: "",
    // dialeto: null = deteção automática; um valor = escolha à mão
    sep: null, decimal: null, ordem: null,
    dialeto: null,
    movs: [],
    payers: new Set([myMember ? myMember.id : members[0].id]),
    mode: useWeights ? "weights" : "equal",
    participants: new Set(useWeights
      ? members.filter(m => Number(m.default_weight) > 0).map(m => m.id)
      : members.map(m => m.id)),
    weights: Object.fromEntries(members.map(m => [m.id, Number(m.default_weight) || 0])),
    folha: null,            // pagou | divide | cat
    folhaIdx: -1,           // linha a que pertence o pop-up da categoria
    importando: false,
    feitos: 0,
    falhas: [],
  };

  // ------------------------------------------------------- ler o texto

  // chave de comparação de movimentos: é o que define "a mesma despesa"
  // para efeitos de duplicados (data + descrição + valor)
  const chave = (data, desc, cents) => `${data}|${catNorm(desc).trim()}|${cents}`;
  const jaNoGrupo = new Set(expenses.map(x =>
    chave(x.expense_date, x.description, toCents(x.amount))));

  function analisar() {
    const r = SWImport.parseMovimentos(state.texto, {
      hoje,
      sep: state.sep,
      decimal: state.decimal || undefined,
      ordem: state.ordem || undefined,
    });
    state.dialeto = r.dialeto;
    state.movs = r.linhas
      // os cabeçalhos de data já fizeram o seu trabalho (passaram a data às
      // linhas de baixo): não são movimentos e não vão para a lista
      .filter(l => l.estado !== "contexto")
      .map(l => ({
        raw: l.txt, data: l.data || hoje, desc: l.desc, cents: l.cents,
        estado: l.estado, avisos: l.avisos, notas: l.notas, erro: l.erro,
        cat: guessCategory(l.desc, expenses, catsPermitidas),
        catManual: false, tocado: false, incluir: false,
      }));
    reavaliar();
  }

  // Passa a lista toda a pente fino: duplicados e o que entra por omissão.
  // Duplicados contam-se contra o que já está no grupo (esses ficam de fora,
  // porque o caso normal é ter-se colado duas vezes) e contra a própria
  // lista (dois cafés iguais no mesmo dia são legítimos — fica só o aviso).
  // Corre outra vez a cada correção: preencher o valor que faltava faz a
  // linha entrar sozinha, e uma linha que passe a bater numa já existente
  // sai. Quem mexeu à mão no visto (tocado) manda sempre.
  function reavaliar() {
    const vistos = new Set();
    for (const m of state.movs) {
      const k = chave(m.data, m.desc, m.cents);
      m.dup = jaNoGrupo.has(k);
      m.repetida = vistos.has(k);
      vistos.add(k);
      if (!m.tocado) m.incluir = !m.dup && m.estado !== "ignorada" && valido(m);
    }
  }

  const valido = m => !!(m.data && m.desc.trim() && m.cents > 0);
  const escolhidos = () => state.movs.filter(m => m.incluir && valido(m));
  const totalCents = () => escolhidos().reduce((a, m) => a + m.cents, 0);

  // ------------------------------------------------- quotas de cada linha

  const participantes = () => members.filter(m => state.participants.has(m.id));
  const pesoDe = m => state.mode === "weights" ? (Number(state.weights[m.id]) || 0) : 1;

  function quotasDe(cents) {
    const ps = participantes();
    const partes = splitByWeights(cents, ps.map(pesoDe));
    const out = {};
    ps.forEach((m, i) => { if (partes[i] > 0) out[m.id] = partes[i]; });
    return out;
  }
  function pagosDe(cents) {
    const ids = [...state.payers];
    const partes = splitByWeights(cents, ids.map(() => 1));
    const out = {};
    ids.forEach((id, i) => { if (partes[i] > 0) out[id] = partes[i]; });
    return out;
  }
  const okPagou = () => state.payers.size > 0;
  const okDivide = () => participantes().length > 0
    && participantes().reduce((a, m) => a + pesoDe(m), 0) > 0;

  // ------------------------------------------------------------ gravar

  async function gravar(m, createdAt) {
    const payload = {
      group_id: group.id,
      description: m.desc.trim(),
      amount: (m.cents / 100).toFixed(2),
      expense_date: m.data,
      split_mode: state.mode,
      category: m.cat,
    };
    // repetição exata dentro do mesmo lote: afasta-se o carimbo de criação
    // para não bater no índice anti-duplicado do servidor (ver gravarTudo)
    if (createdAt) payload.created_at = createdAt;

    // schema antigo sem split_mode/category: grava sem esses campos
    const semColuna = (error) => {
      if (!error) return false;
      if (/split_mode/i.test(error.message) && "split_mode" in payload) { delete payload.split_mode; return true; }
      if (/category/i.test(error.message) && "category" in payload) { delete payload.category; return true; }
      return false;
    };

    let { data, error } = await sb.from("expenses").insert(payload).select().single();
    while (semColuna(error)) ({ data, error } = await sb.from("expenses").insert(payload).select().single());
    if (error) return error.code === "23505"
      ? "já existe uma despesa igual no grupo"
      : error.message;

    const pagos = pagosDe(m.cents);
    const quotas = quotasDe(m.cents);
    const payerRows = Object.entries(pagos).map(([id, c]) =>
      ({ expense_id: data.id, member_id: id, amount: (c / 100).toFixed(2) }));
    const shareRows = Object.entries(quotas).map(([id, c]) =>
      ({ expense_id: data.id, member_id: id, amount: (c / 100).toFixed(2) }));
    const i1 = await sb.from("expense_payers").insert(payerRows);
    const i2 = await sb.from("expense_shares").insert(shareRows);
    if (i1.error || i2.error) {
      // o PostgREST não dá transação: uma despesa sem quotas estragava os
      // saldos, por isso desfaz-se esta linha e segue-se para a seguinte
      await sb.from("expenses").delete().eq("id", data.id);
      return (i1.error || i2.error).message;
    }
    if (m.cat) learnCategory(m.desc, m.cat);
    return null;
  }

  async function gravarTudo() {
    const lista = escolhidos();
    if (!lista.length || state.importando) return;
    if (!okPagou()) { abrirFolha("pagou"); return toast("Escolhe quem pagou", true); }
    if (!okDivide()) { abrirFolha("divide"); return toast("Escolhe por quem se divide", true); }

    state.importando = true;
    state.feitos = 0;
    state.falhas = [];
    desenhar();

    // O servidor tem um índice que impede a mesma despesa (grupo, descrição,
    // valor, data, autor) de entrar duas vezes no mesmo minuto — a rede de
    // segurança contra o duplo-clique. Num lote, duas linhas rigorosamente
    // iguais são deliberadas (foram confirmadas neste ecrã), por isso o
    // carimbo de criação de cada repetição recua um minuto: o índice deixa
    // passar e o instante da importação continua a ser o de agora.
    const repetidas = new Map();
    const agora = Date.now();

    for (const m of lista) {
      const k = chave(m.data, m.desc, m.cents);
      const n = repetidas.get(k) || 0;
      repetidas.set(k, n + 1);
      const erro = await gravar(m, n ? new Date(agora - n * 61000).toISOString() : null);
      if (erro) { m.falhou = erro; state.falhas.push(m); } else { m.gravado = true; }
      state.feitos++;
      const $cta = slot.querySelector("#i-cta");
      if ($cta) $cta.textContent = `A importar… ${state.feitos}/${lista.length}`;
    }

    const gravados = lista.filter(m => m.gravado);
    if (gravados.length) {
      // um aviso só para o lote todo: doze notificações seguidas seriam
      // ruído (quem pagou e a divisão são os mesmos em todas as linhas)
      const total = gravados.reduce((a, m) => a + m.cents, 0);
      const desc = gravados.length === 1
        ? gravados[0].desc
        : `${gravados.length} movimentos importados`;
      notifyExpenseAdded(group, members, desc, total,
        Object.entries(pagosDe(total)).map(([id, c]) => ({ member_id: id, amount: (c / 100).toFixed(2) })),
        Object.entries(quotasDe(total)).map(([id, c]) => ({ member_id: id, amount: (c / 100).toFixed(2) })));
    }

    state.importando = false;
    if (!state.falhas.length) {
      toast(gravados.length === 1 ? "Movimento importado" : `${gravados.length} movimentos importados`);
      return refresh();
    }
    // alguma linha ficou por gravar: o ecrã fica aberto com o que falta
    state.movs = state.movs.filter(m => !m.gravado);
    reavaliar();
    toast(`${gravados.length} importados, ${state.falhas.length} por gravar`, true);
    invalidateGroupCache();
    desenhar();
  }

  // ------------------------------------------------------------ pop-ups

  function abrirFolha(id, idx) {
    state.folha = id;
    state.folhaIdx = idx == null ? -1 : idx;
    document.addEventListener("keydown", onEsc, true);
    desenhar();
  }
  function fecharFolha() {
    document.removeEventListener("keydown", onEsc, true);
    state.folha = null;
    state.folhaIdx = -1;
    desenhar();
  }
  function onEsc(e) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    fecharFolha();
  }
  const sair = () => {
    if (state.importando) return;
    document.removeEventListener("keydown", onEsc, true);
    close();
  };

  // ------------------------------------------------------------ desenho

  const badge = (cls, txt, titulo) =>
    `<span class="im-flag ${cls}"${titulo ? ` title="${esc(titulo)}"` : ""}>${esc(txt)}</span>`;

  function cardHtml(m, i) {
    const c = m.cat ? catOf(m.cat) : null;
    const ignorada = m.estado === "ignorada";
    const flags = [];
    if (m.falhou) flags.push(badge("erro", "não gravou", m.falhou));
    if (m.erro) flags.push(badge(ignorada ? "" : "erro", m.erro));
    if (m.dup) flags.push(badge("dup", "já existe no grupo"));
    else if (m.repetida) flags.push(badge("dup", "repetida nesta lista"));
    for (const a of m.avisos) flags.push(badge("aviso", a));
    for (const n of m.notas) flags.push(badge("nota", n));

    const estado = m.falhou || !valido(m) ? "erro" : ignorada ? "ign"
      : m.dup ? "dup" : m.avisos.length ? "aviso" : "ok";

    return `
      <div class="im-mov ${m.incluir ? "on" : "off"} ${estado}" data-i="${i}">
        <button type="button" class="im-chk" data-tog="${i}" aria-pressed="${m.incluir}"
          aria-label="${m.incluir ? "Não importar esta linha" : "Importar esta linha"}">${m.incluir ? ico("check") : ""}</button>
        <div class="im-corpo">
          <div class="im-l1">
            <input type="date" class="im-data" data-data="${i}" value="${esc(m.data)}" aria-label="Data" />
            <span class="im-valor">
              <input type="text" inputmode="decimal" data-val="${i}" aria-label="Valor"
                value="${m.cents ? (m.cents / 100).toFixed(2).replace(".", ",") : ""}" placeholder="0,00" />
              <span>${esc(SIMBOLO_IM[cur] || cur)}</span>
            </span>
          </div>
          <input type="text" class="im-desc" data-desc="${i}" value="${esc(m.desc)}"
            placeholder="Em que foi?" aria-label="Descrição" />
          <div class="im-l3">
            <button type="button" class="im-cat" data-cat="${i}">
              ${c ? `${c.icon} ${esc(c.label)}` : "🏷️ Sem categoria"}
            </button>
            ${flags.join("")}
          </div>
          <p class="im-raw" title="Texto original">${esc(m.raw)}</p>
        </div>
      </div>`;
  }

  function listaHtml() {
    if (!state.movs.length) {
      return `<p class="empty">Não encontrei movimentos neste texto. Volta atrás e confere
        se cada linha tem pelo menos uma descrição e um valor.</p>`;
    }
    return state.movs.map(cardHtml).join("");
  }

  function corpoPagou() {
    return `
      <p class="xp-folha-sub">Vale para os ${state.movs.length} movimentos. Com mais do que
        uma pessoa, cada despesa fica dividida em partes iguais entre elas.</p>
      <div class="xp-people">
        ${members.map(m => {
          const on = state.payers.has(m.id);
          return `
            <div class="xp-p ${on ? "on" : ""}">
              <button type="button" class="xp-p-hit" data-payer="${m.id}" aria-pressed="${on}">
                ${avatarHtml(m.name)}
                <span class="xp-p-n">${esc(m.name)}</span>
                <span class="xp-p-c">${on ? ico("check") : ""}</span>
              </button>
            </div>`;
        }).join("")}
      </div>`;
  }

  function corpoDivide() {
    const quotas = quotasDe(10000); // prévia sobre 100 € — dá a proporção
    return `
      ${okDivide() ? "" : `<p class="xp-aviso">Escolhe por quem se divide</p>`}
      ${useWeights ? `
        <div class="xp-seg sm" role="group" aria-label="Modo de divisão">
          <button type="button" class="${state.mode === "equal" ? "on" : ""}" data-mode="equal">Partes iguais</button>
          <button type="button" class="${state.mode === "weights" ? "on" : ""}" data-mode="weights">Proporção</button>
        </div>` : ""}
      <div class="xp-folha-act">
        <span class="xp-folha-sub">Quem entra nestes movimentos</span>
        <span>
          <button type="button" class="xp-link sm" id="i-part-all">Todos</button>
          <button type="button" class="xp-link sm" id="i-part-none">Nenhum</button>
        </span>
      </div>
      <div class="xp-people">
        ${members.map(m => {
          const on = state.participants.has(m.id);
          const input = on && state.mode === "weights"
            ? `<input class="xp-p-in" type="number" inputmode="decimal" step="0.1" min="0"
                data-weight="${m.id}" value="${state.weights[m.id] ?? 0}" />` : "";
          const val = on ? `${((quotas[m.id] || 0) / 100).toFixed(0)}%` : "";
          return `
            <div class="xp-p ${on ? "on" : ""}">
              <button type="button" class="xp-p-hit" data-part="${m.id}" aria-pressed="${on}">
                ${avatarHtml(m.name)}
                <span class="xp-p-n">${esc(m.name)}${input && val ? `<small>${val}</small>` : ""}</span>
                ${val && !input ? `<span class="xp-p-v">${val}</span>` : ""}
                <span class="xp-p-c">${on ? ico("check") : ""}</span>
              </button>
              ${input}
            </div>`;
        }).join("")}
      </div>`;
  }

  function corpoCat() {
    const m = state.movs[state.folhaIdx];
    if (!m) return "";
    return `
      <p class="xp-folha-sub">${esc(m.desc || "Esta linha")} — sugerida a partir da descrição.</p>
      <div class="xp-cats">
        ${catsDoGrupo.map(c => `
          <button type="button" class="xp-cat ${m.cat === c.id ? "on" : ""}" data-pick="${c.id}">
            <span class="xp-cat-ico ct-${c.tone}">${catGlyph(c)}</span>
            <span class="xp-cat-lb">${esc(c.label)}</span>
          </button>`).join("")}
      </div>
      <button type="button" class="xp-link" id="i-cat-none">Sem categoria</button>`;
  }

  const TITULO_FOLHA = { pagou: "Quem pagou", divide: "Como se divide", cat: "Categoria" };
  const CORPOS = { pagou: corpoPagou, divide: corpoDivide, cat: corpoCat };

  function dialetoHtml() {
    const d = state.dialeto || {};
    const opcoesSep = [
      ["auto", "automático"], [";", "ponto e vírgula"], ["/", "barra"], ["|", "barra vertical"],
      ["\t", "tabulação"], [",", "vírgula"], ["  ", "espaços"], ["", "nenhum"],
    ];
    const nomeSep = (v) => (opcoesSep.find(o => o[0] === v) || ["", "nenhum"])[1];
    const valorSep = state.sep === null ? "auto" : state.sep;
    return `
      <div class="im-dial">
        <label><span>Datas</span>
          <select data-dial="ordem">
            <option value="dmy" ${d.ordem === "dmy" ? "selected" : ""}>dia/mês</option>
            <option value="mdy" ${d.ordem === "mdy" ? "selected" : ""}>mês/dia</option>
          </select>
        </label>
        <label><span>Decimal</span>
          <select data-dial="decimal">
            <option value="," ${d.decimal === "," ? "selected" : ""}>vírgula</option>
            <option value="." ${d.decimal === "." ? "selected" : ""}>ponto</option>
          </select>
        </label>
        <label><span>Separador</span>
          <select data-dial="sep">
            ${opcoesSep.map(([v, n]) => `<option value="${esc(v)}" ${valorSep === v ? "selected" : ""}>
              ${esc(v === "auto" ? `automático (${nomeSep(d.sep === null ? "" : d.sep)})` : n)}</option>`).join("")}
          </select>
        </label>
      </div>`;
  }

  function desenhar() {
    const n = escolhidos().length;
    const total = totalCents();
    const comProblema = state.movs.filter(m => m.incluir && !valido(m)).length;

    const cabecalho = `
      <header class="xp-head">
        <div class="xp-head-bar">
          <button type="button" class="xp-icon-btn" id="i-back" aria-label="Voltar"
            ${state.importando ? "disabled" : ""}>${ico("back")}</button>
          <span class="xp-head-title">Importar movimentos</span>
          <span class="xp-head-spacer"></span>
        </div>
        ${state.fase === "colar" ? `
          <p class="im-lead">Cola o que tens escrito — uma linha por movimento, com a data,
            o que foi e quanto custou. Confirmas tudo no ecrã a seguir.</p>`
        : `
          <p class="im-lead"><strong>${state.movs.length}</strong> linha${state.movs.length === 1 ? "" : "s"} lida${state.movs.length === 1 ? "" : "s"}.
            Confere o que ficou e corrige o que for preciso.</p>
          ${dialetoHtml()}`}
      </header>`;

    const corpo = state.fase === "colar" ? `
      <div class="xp-body">
        <textarea id="i-txt" class="im-txt" rows="9" spellcheck="false"
          placeholder="25/09; Continente; 45,30&#10;26-09 Jantar 12,50&#10;ontem Café 1,20">${esc(state.texto)}</textarea>
        <div class="xp-note">
          <span>Aceita <strong>;</strong> <strong>/</strong> <strong>|</strong>, tabulações ou só espaços;
            cêntimos com vírgula ou ponto; datas como <strong>26/09</strong>, <strong>25-set</strong>,
            <strong>2026-09-26</strong>, <strong>hoje</strong> ou <strong>ontem</strong>.
            Uma linha só com a data (ex.: «25/09») passa a valer para as de baixo.</span>
        </div>
      </div>`
    : `
      <div class="xp-body"${state.importando ? " inert" : ""}>
        <div class="xp-rows">
          <button type="button" class="xp-row ${okPagou() ? "" : "warn"}" data-folha="pagou">
            ${ico("user", "xp-row-ico")}
            <span class="xp-row-k">Quem pagou</span>
            <span class="xp-row-v">${esc(state.payers.size === 0 ? "Por escolher"
              : [...state.payers].map(id => curto(nomeDe(id))).join(", "))}</span>
            ${ico("chev", "xp-row-chev")}
          </button>
          <button type="button" class="xp-row ${okDivide() ? "" : "warn"}" data-folha="divide">
            ${ico("users", "xp-row-ico")}
            <span class="xp-row-k">Divisão</span>
            <span class="xp-row-v">${esc(!okDivide() ? "Por escolher"
              : state.mode === "weights" ? `Proporção, entre ${participantes().length}`
              : participantes().length === members.length ? "Igual, entre todos"
              : `Igual, entre ${participantes().length}`)}</span>
            ${ico("chev", "xp-row-chev")}
          </button>
        </div>
        <div class="im-lista" id="i-lista">${listaHtml()}</div>
        ${comProblema ? `<p class="xp-aviso">${comProblema} linha${comProblema === 1 ? "" : "s"}
          por completar — falta a descrição ou o valor.</p>` : ""}
      </div>`;

    const cta = state.fase === "colar"
      ? `<button class="xp-cta" id="i-cta" ${state.texto.trim() ? "" : "disabled"}>Analisar</button>`
      : `<button class="xp-cta" id="i-cta" ${n && !state.importando ? "" : "disabled"}>${state.importando
          ? `A importar… ${state.feitos}/${escolhidos().length}`
          : n ? `Importar ${n} movimento${n === 1 ? "" : "s"} · ${fmtMoney(total, cur)}`
              : "Nada por importar"}</button>`;

    const popup = state.folha ? `
      <div class="xp-scrim" id="i-scrim">
        <div class="xp-folha entra" role="dialog" aria-modal="true" aria-label="${TITULO_FOLHA[state.folha]}">
          <div class="xp-folha-h">
            <span class="xp-grab"></span>
            <div class="xp-folha-t">
              <h3>${TITULO_FOLHA[state.folha]}</h3>
              <button type="button" class="xp-folha-ok" id="i-folha-ok">Concluir</button>
            </div>
          </div>
          <div class="xp-folha-b">${CORPOS[state.folha]()}</div>
        </div>
      </div>` : "";

    slot.innerHTML = `
      <div class="expense-detail xp im">
        ${cabecalho}
        ${corpo}
        <footer class="xp-foot">${cta}</footer>
        ${popup}
      </div>`;
    slot.parentElement?.classList.toggle("folha-aberta", !!state.folha);
    ligar();
  }

  // Só a lista e o botão: usado quando se mexe numa linha, para não perder
  // o scroll nem o foco de quem está a corrigir o ecrã todo.
  function repintarLista() {
    const $l = slot.querySelector("#i-lista");
    if (!$l) return desenhar();
    $l.innerHTML = listaHtml();
    const n = escolhidos().length;
    const $cta = slot.querySelector("#i-cta");
    if ($cta) {
      $cta.disabled = !n || state.importando;
      $cta.textContent = n
        ? `Importar ${n} movimento${n === 1 ? "" : "s"} · ${fmtMoney(totalCents(), cur)}`
        : "Nada por importar";
    }
    ligarLista();
  }

  function ligarLista() {
    slot.querySelectorAll("[data-tog]").forEach(b => {
      b.onclick = () => {
        const m = state.movs[+b.dataset.tog];
        m.incluir = !m.incluir;
        m.tocado = true;
        repintarLista();
      };
    });
    slot.querySelectorAll("[data-data]").forEach(inp => {
      inp.onchange = () => {
        const m = state.movs[+inp.dataset.data];
        if (inp.value) m.data = inp.value;
        reavaliar();
        repintarLista();
      };
    });
    slot.querySelectorAll("[data-val]").forEach(inp => {
      inp.onchange = () => {
        const m = state.movs[+inp.dataset.val];
        m.cents = SWImport.parseValor(inp.value, (state.dialeto || {}).decimal);
        if (m.cents > 0 && m.erro === "não encontrei o valor") m.erro = null;
        reavaliar();
        repintarLista();
      };
    });
    slot.querySelectorAll("[data-desc]").forEach(inp => {
      // a sugestão de categoria acompanha a escrita, mas o ecrã não se
      // redesenha enquanto se escreve (perdia-se o foco a cada tecla)
      inp.oninput = () => {
        const m = state.movs[+inp.dataset.desc];
        m.desc = inp.value;
        if (!m.catManual) {
          m.cat = guessCategory(m.desc, expenses, catsPermitidas);
          const c = m.cat ? catOf(m.cat) : null;
          const $b = slot.querySelector(`[data-cat="${inp.dataset.desc}"]`);
          if ($b) $b.innerHTML = c ? `${c.icon} ${esc(c.label)}` : "🏷️ Sem categoria";
        }
      };
      inp.onchange = () => { reavaliar(); repintarLista(); };
    });
    slot.querySelectorAll("[data-cat]").forEach(b => {
      b.onclick = () => abrirFolha("cat", +b.dataset.cat);
    });
  }

  function ligar() {
    slot.querySelector("#i-back").onclick = () => {
      if (state.fase === "confirmar") { state.fase = "colar"; return desenhar(); }
      sair();
    };
    slot.querySelector("#i-cta").onclick = () => {
      if (state.fase === "colar") {
        analisar();
        state.fase = "confirmar";
        return desenhar();
      }
      gravarTudo();
    };

    const $txt = slot.querySelector("#i-txt");
    if ($txt) {
      $txt.oninput = () => {
        state.texto = $txt.value;
        const $cta = slot.querySelector("#i-cta");
        if ($cta) $cta.disabled = !state.texto.trim();
      };
      $txt.focus();
    }

    slot.querySelectorAll("[data-dial]").forEach(sel => {
      sel.onchange = () => {
        const v = sel.value;
        if (sel.dataset.dial === "sep") state.sep = v === "auto" ? null : v;
        else state[sel.dataset.dial] = v;
        // reler tudo com o dialeto novo: as correções à mão perdem-se, mas
        // é isso mesmo que se quer — mudou a leitura do bloco inteiro
        analisar();
        desenhar();
      };
    });

    slot.querySelectorAll("[data-folha]").forEach(b => { b.onclick = () => abrirFolha(b.dataset.folha); });
    slot.querySelector("#i-folha-ok")?.addEventListener("click", fecharFolha);
    slot.querySelector("#i-scrim")?.addEventListener("click", (e) => {
      if (e.target.id === "i-scrim") fecharFolha();
    });

    slot.querySelectorAll("[data-payer]").forEach(b => {
      b.onclick = () => {
        const id = b.dataset.payer;
        state.payers.has(id) ? state.payers.delete(id) : state.payers.add(id);
        desenhar();
      };
    });
    slot.querySelectorAll("[data-mode]").forEach(b => {
      b.onclick = () => { state.mode = b.dataset.mode; desenhar(); };
    });
    slot.querySelectorAll("[data-part]").forEach(b => {
      b.onclick = () => {
        const id = b.dataset.part;
        state.participants.has(id) ? state.participants.delete(id) : state.participants.add(id);
        desenhar();
      };
    });
    slot.querySelector("#i-part-all")?.addEventListener("click", () => {
      members.forEach(m => state.participants.add(m.id));
      desenhar();
    });
    slot.querySelector("#i-part-none")?.addEventListener("click", () => {
      state.participants.clear();
      desenhar();
    });
    slot.querySelectorAll("[data-weight]").forEach(inp => {
      inp.onchange = () => { state.weights[inp.dataset.weight] = parseFloat(inp.value) || 0; desenhar(); };
    });
    slot.querySelectorAll("[data-pick]").forEach(b => {
      b.onclick = () => {
        const m = state.movs[state.folhaIdx];
        if (!m) return;
        m.cat = m.cat === b.dataset.pick ? null : b.dataset.pick;
        m.catManual = true;
        desenhar();
      };
    });
    slot.querySelector("#i-cat-none")?.addEventListener("click", () => {
      const m = state.movs[state.folhaIdx];
      if (m) { m.cat = null; m.catManual = true; }
      fecharFolha();
    });

    if (state.fase === "confirmar") ligarLista();
  }

  slot.classList.add("modal-card-flush");
  slot.parentElement?.classList.add("modal-full");
  desenhar();
}

// ------------------------------------------------ tab: saldos
function renderBalancesTab($c, ctx) {
  const { group, members, expenses, payments, paymentsReady } = ctx;
  const cur = group.currency;

  // cêntimos: + recebe, - deve (pagamentos já feitos incluídos)
  const balance = Object.fromEntries(groupBalancesCents(members, expenses, payments));

  // sugestões de acerto (preferências de liquidação + algoritmo guloso)
  const settlements = settlementsFor(members, balance);

  const { myMember } = ctx;
  const curto = nomesCurtos(members);
  const isMe = (id) => !!myMember && id === myMember.id;
  // nas frases, o próprio é «tu» («Rui → tu», «Tu → Ana»)
  const quem = (m, inicio = false) => isMe(m.id) ? (inicio ? "Tu" : "tu") : curto(m.name);

  // a quem deve / de quem recebe cada pessoa (detalhe ao tocar na linha)
  const owesTo = {}, getsFrom = {};
  for (const s of settlements) {
    (owesTo[s.from.id] ??= []).push({ name: quem(s.to), cents: s.cents });
    (getsFrom[s.to.id] ??= []).push({ name: quem(s.from), cents: s.cents });
  }

  const totalPaid = payments.reduce((a, p) => a + toCents(p.amount), 0);

  // intervalo de datas do resumo: recorta o total, as quotas e o gráfico.
  // Os saldos e os acertos ficam sempre sobre tudo — dívida é dívida.
  const period = { from: "", to: "" };

  // Nos acertos, nos pagamentos e nas quotas, o que é do próprio fica sempre
  // visível; o que é dos outros fica atrás de um «Ver … dos outros (N) ▾».
  // Um criador que não é membro do grupo não tem "próprio": vê tudo sempre
  // visível, sem botão de colapsar.
  const isMineS = (s) => !!myMember && (s.from.id === myMember.id || s.to.id === myMember.id);
  const isMineP = (p) => !!myMember && (p.from_member === myMember.id || p.to_member === myMember.id);
  const mySettles = settlements.map((s, i) => [s, i]).filter(([s]) => !myMember || isMineS(s));
  const otherSettles = myMember ? settlements.map((s, i) => [s, i]).filter(([s]) => !isMineS(s)) : [];
  const myPayments = payments.filter(p => !myMember || isMineP(p));
  const otherPayments = myMember ? payments.filter(p => !isMineP(p)) : [];
  const otherMembers = myMember ? members.filter(m => m.id !== myMember.id) : [];
  // quotas por pessoa: sem "próprio" mostra toda a gente (senão só os outros)
  const quotaMembers = myMember ? otherMembers : members;

  // linha de acerto (o índice aponta para settlements, para o «Registar»
  // pré-preencher o pagamento)
  const settleLine = ([s, i]) => `
    <div class="settle-line">
      <span class="settle-avatars">
        ${avatarHtml(s.from.name)}${avatarHtml(s.to.name)}
      </span>
      <div class="item-main">
        <span class="item-title">${esc(quem(s.from, true))} <span class="settle-arrow">→</span> ${esc(quem(s.to))}</span>
      </div>
      <span class="amount">${fmtMoney(s.cents, cur)}</span>
      ${paymentsReady && ctx.canWrite ? `<button type="button" class="small soft" data-settle="${i}">Registar</button>` : ""}
    </div>`;

  const paymentLi = (p) => {
    const from = members.find(m => m.id === p.from_member);
    const to = members.find(m => m.id === p.to_member);
    return `
    <li>
      <div class="item-main">
        <span class="item-title payment-line">
          ${esc(from ? quem(from, true) : "?")} <span class="settle-arrow">→</span> ${esc(to ? quem(to) : "?")}
        </span>
        <span class="item-sub">${fmtDate(p.payment_date)}${p.note ? ` · ${esc(p.note)}` : ""}</span>
      </div>
      <span class="amount">${fmtMoney(toCents(p.amount), cur)}</span>
      ${ctx.canWrite ? `<button type="button" class="ghost small" data-pdel="${p.id}" aria-label="Apagar pagamento" title="Apagar pagamento">${uiIco("x")}</button>` : ""}
    </li>`;
  };

  // ---- Quem deve / quem recebe: uma barra por pessoa, para os dois lados de um
  // eixo (à esquerda quem deve, à direita quem recebe), na mesma escala.
  // Tocar numa linha mostra a quem deve / de quem recebe.
  const maxNeg = Math.max(0, ...members.map(m => -balance[m.id]));
  const maxPos = Math.max(0, ...members.map(m => balance[m.id]));
  const span = maxNeg + maxPos;
  const axis = span ? (maxNeg / span) * 100 : 50;
  const num = (c) => new Intl.NumberFormat("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c / 100);
  const barRow = (m) => {
    const b = balance[m.id];
    const list = b < 0 ? owesTo[m.id] : b > 0 ? getsFrom[m.id] : null;
    const expandable = (list?.length || 0) > 0;
    const w = span ? Math.abs(b) / span * 100 : 0;
    const bar = b > 0 ? `<span class="bb-bar pos" style="left:${axis}%;width:${w}%"></span>`
      : b < 0 ? `<span class="bb-bar neg" style="right:${100 - axis}%;width:${w}%"></span>` : "";
    return `
      <li class="bb-row ${expandable ? "clickable" : ""}" ${expandable ? `data-bal="${m.id}"` : ""}>
        <span class="bb-who">${avatarHtml(m.name, "sm")}<span class="bb-name">${esc(isMe(m.id) ? "Tu" : curto(m.name))}</span></span>
        <span class="bb-track" aria-hidden="true"><span class="bb-axis" style="left:${axis}%"></span>${bar}</span>
        <span class="bb-val ${b > 0 ? "positive" : b < 0 ? "negative" : "zero"}">${b === 0 ? "em dia" : (b > 0 ? "+" : "−") + num(Math.abs(b))}</span>
      </li>
      ${expandable ? `<li class="balance-detail hidden" data-bdetail="${m.id}">
        <ul class="detail-list">
          ${list.map(x => `<li>
            <span>${b < 0 ? "deve a" : "recebe de"} ${esc(x.name)}</span>
            <span class="amount">${fmtMoney(x.cents, cur)}</span>
          </li>`).join("")}
        </ul>
      </li>` : ""}`;
  };
  const byBalance = [...members].sort((a, b) => balance[b.id] - balance[a.id]);
  const barsCard = members.length === 0 ? "" : `
    <div class="card">
      <div class="card-title-row"><h2>Quem deve / quem recebe</h2></div>
      <ul class="list bal-bars">${byBalance.map(barRow).join("")}</ul>
    </div>`;

  // cartão com o do próprio sempre visível + o dos outros atrás do colapsar
  const card = (title, id, mine, others, othersCount, othersLabel, action = "", sub = "") => `
    <div class="card">
      <div class="card-title-row"><h2>${title}</h2>${action}</div>
      ${sub ? `<p class="card-sub">${sub}</p>` : ""}
      ${mine}
      ${othersCount > 0 ? `
        <button type="button" class="collapse-toggle" data-collapse="${id}">
          <span>${othersLabel} <span class="muted">(${othersCount})</span></span>
          ${uiIco("down", "collapse-arrow")}
        </button>
        <div class="collapse-body hidden" data-body="${id}">${others}</div>` : ""}
    </div>`;

  // ---- O teu saldo (em grande) + resumo dos gastos: total, a tua quota e
  // gráfico sempre visíveis; a quota por pessoa dos outros fica no colapsável
  const myBal = myMember ? balance[myMember.id] : 0;
  const nCount = myMember ? (myBal < 0 ? owesTo[myMember.id] : getsFrom[myMember.id])?.length || 0 : 0;
  const recebido = myMember ? payments.filter(p => p.to_member === myMember.id).reduce((a, p) => a + toCents(p.amount), 0) : 0;
  const pago = myMember ? payments.filter(p => p.from_member === myMember.id).reduce((a, p) => a + toCents(p.amount), 0) : 0;
  const balSub = !myMember ? ""
    : myBal > 0 ? `Recebes de ${nCount} pessoa${nCount === 1 ? "" : "s"}${recebido ? ` · já recebeste ${fmtMoney(recebido, cur)}` : ""}`
    : myBal < 0 ? `Deves a ${nCount} pessoa${nCount === 1 ? "" : "s"}${pago ? ` · já pagaste ${fmtMoney(pago, cur)}` : ""}`
    : "Não deves nada a ninguém e ninguém te deve nada";
  const resumoCard = `
    <div class="card bal-card">
      <div class="card-title-row">
        <span class="bal-label">${myMember ? "O teu saldo" : "Resumo dos gastos"}</span>
        <div class="title-actions">
          <button type="button" class="pill-btn" id="bp-report">${uiIco("doc")} Relatório</button>
          <button type="button" class="pill-btn date-toggle-txt" id="bp-toggle">${uiIco("calendar")} Período</button>
        </div>
      </div>
      ${myMember ? `
      <div class="bal-big ${myBal > 0 ? "positive" : myBal < 0 ? "negative" : "zero"}">${myBal === 0 ? "Em dia" : (myBal > 0 ? "+" : "−") + fmtMoney(Math.abs(myBal), cur)}</div>
      <p class="bal-sub">${balSub}</p>` : ""}
      <div class="date-range hidden" id="bp-range">
        <div class="field"><label for="bp-from">De</label><input type="date" id="bp-from" /></div>
        <div class="field"><label for="bp-to">Até</label><input type="date" id="bp-to" /></div>
        <button type="button" class="secondary small" id="bp-clear">Limpar</button>
      </div>
      <div id="balance-summary"></div>
      ${quotaMembers.length === 0 ? "" : myMember ? `
        <button type="button" class="collapse-toggle" data-collapse="resumo">
          <span>Quota por pessoa <span class="muted">(${quotaMembers.length})</span></span>
          ${uiIco("down", "collapse-arrow")}
        </button>
        <div class="collapse-body hidden" data-body="resumo"><div id="balance-quotas"></div></div>`
        : `<div id="balance-quotas" style="margin-top:.6rem;"></div>`}
    </div>`;

  // ---- Como acertar contas ----
  const acertosMine = mySettles.length
    ? mySettles.map(settleLine).join("")
    : `<p class="empty">${settlements.length && myMember
        ? "Não tens contas por acertar 🎉" : "Está tudo em dia 🎉"}</p>`;
  const acertosOthers = otherSettles.map(settleLine).join("");
  const acertosSub = settlements.length
    ? `${settlements.length} pagamento${settlements.length === 1 ? "" : "s"} e ficam todos em dia` : "";

  // ---- Por categoria ---- (o quadro do relatório): o total do grupo em
  // cada categoria ou só a minha parte. Só aparece se houver despesas com
  // categoria — com tudo em «Sem categoria» não diz nada.
  const hasCats = expenses.some(x => expenseCatSplits(x).some(s => s.cat !== "none"));
  let catView = "group";
  const catsCard = !hasCats ? "" : `
    <div class="card">
      <div class="card-title-row"><h2>Por categoria</h2></div>
      ${myMember ? `
      <div class="xp-seg sm who-seg" role="group" aria-label="Totais por categoria">
        <button type="button" class="on" data-catview="group" aria-pressed="true">Do grupo</button>
        <button type="button" data-catview="me" aria-pressed="false">A minha parte</button>
      </div>` : ""}
      <div id="balance-cats"></div>
    </div>`;

  // ---- Pagamentos ----
  const pagAction = paymentsReady && ctx.canWrite
    ? `<button type="button" class="pill-btn" id="btn-add-payment">${uiIco("plus")} Registar</button>` : "";
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
    ${card("Como acertar", "acertos", acertosMine, acertosOthers, otherSettles.length, "Ver acertos entre os outros", "", acertosSub)}
    ${catsCard}
    ${barsCard}
    ${card("Pagamentos", "pagamentos", pagMine, pagOthers, otherPayments.length, "Ver pagamentos dos outros", pagAction)}`;

  // abrir/fechar a parte "dos outros" de cada cartão
  $c.querySelectorAll(".collapse-toggle").forEach(btn => {
    btn.onclick = () => {
      $c.querySelector(`[data-body="${btn.dataset.collapse}"]`).classList.toggle("hidden");
      btn.classList.toggle("open");
    };
  });

  // expandir/encolher o detalhe de um saldo (a quem deve / de quem recebe)
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
    const keys = [...byMonth.keys()].sort();
    const months = [];
    if (keys.length) {
      let [y, mo] = keys[0].split("-").map(Number);
      const [ey, emo] = keys[keys.length - 1].split("-").map(Number);
      while (y < ey || (y === ey && mo <= emo)) {
        const ym = `${y}-${String(mo).padStart(2, "0")}`;
        months.push([ym, byMonth.get(ym) || 0]);
        if (++mo > 12) { mo = 1; y++; }
      }
    }
    // o gráfico só vale a pena num grupo que gasta ao longo do tempo: pelo
    // menos 3 meses seguidos com despesas (um jantar ou uma viagem não chega)
    let run = 0, bestRun = 0;
    for (const [, c] of months) { run = c ? run + 1 : 0; bestRun = Math.max(bestRun, run); }
    if (bestRun >= 3) {
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

    drawCats(xs, share, active);
  }

  // ---- por categoria: o total do grupo (cada parte de uma fatura repartida
  // na sua categoria) ou a minha parte, distribuída pelas mesmas categorias.
  // Segue o período do resumo, como as quotas.
  const $cats = $c.querySelector("#balance-cats");
  function drawCats(xs, share, active) {
    if (!$cats) return;
    const mine = catView === "me" && !!myMember;
    const byCat = new Map(); // cat -> { cents, n }
    if (mine) {
      const exactCat = new Map();
      const nCat = new Map();
      for (const x of xs) for (const [cat, v] of memberCatShareCents(x, myMember.id)) {
        if (v <= 0) continue;
        exactCat.set(cat, (exactCat.get(cat) || 0) + v);
        nCat.set(cat, (nCat.get(cat) || 0) + 1);
      }
      // arredonda uma vez no fim e acerta o cêntimo que sobre na maior
      // categoria, para o total bater com «A tua quota» lá em cima
      const rounded = roundPreservingSum(exactCat);
      const diff = (share[myMember.id] || 0) - [...rounded.values()].reduce((a, b) => a + b, 0);
      if (diff && rounded.size) {
        const top = [...rounded.entries()].sort((a, b) => b[1] - a[1])[0][0];
        rounded.set(top, rounded.get(top) + diff);
      }
      for (const [cat, cents] of rounded) byCat.set(cat, { cents, n: nCat.get(cat) });
    } else {
      for (const x of xs) for (const s of expenseCatSplits(x)) {
        const e = byCat.get(s.cat) || { cents: 0, n: 0 };
        e.cents += s.cents;
        e.n += 1;
        byCat.set(s.cat, e);
      }
    }
    const cats = [...byCat.entries()].filter(([, e]) => e.cents > 0).sort((a, b) => b[1].cents - a[1].cents);
    const total = cats.reduce((a, [, e]) => a + e.cents, 0);
    const pct = (c) => total > 0 ? Math.round(c / total * 100) : 0;
    const periodo = active
      ? ` · ${period.from ? fmtDate(period.from) : "início"} → ${period.to ? fmtDate(period.to) : "hoje"}` : "";

    if (cats.length === 0) {
      $cats.innerHTML = `<p class="empty">${mine
        ? `Não tens parte em despesas ${active ? "neste período" : "ainda"}.`
        : `Sem despesas ${active ? "neste período" : "ainda"}.`}</p>`;
      return;
    }
    $cats.innerHTML = `
      <p class="card-sub">${mine ? "A tua parte" : "Total do grupo"}: <strong>${fmtMoney(total, cur)}</strong>${periodo}</p>
      ${cats.map(([id, e]) => {
        const c = catOf(id);
        return `<div class="quota-row cat-row">
          ${catIconHtml(id === "none" ? null : id)}
          <div class="quota-main">
            <div class="quota-top">
              <span class="quota-name">${esc(c ? c.label : "Sem categoria")}</span>
              <span class="quota-amt">${fmtMoney(e.cents, cur)}</span>
            </div>
            <div class="quota-bar"><div class="quota-fill" style="width:${pct(e.cents)}%"></div></div>
            <div class="quota-foot">
              <span>${pct(e.cents)}% ${mine ? "da tua parte" : "do total"}</span>
              <span>${e.n} despesa${e.n === 1 ? "" : "s"}</span>
            </div>
          </div>
        </div>`;
      }).join("")}`;
  }
  $c.querySelectorAll("[data-catview]").forEach(b => {
    b.onclick = () => {
      catView = b.dataset.catview;
      $c.querySelectorAll("[data-catview]").forEach(o => {
        o.classList.toggle("on", o === b);
        o.setAttribute("aria-pressed", String(o === b));
      });
      drawSummary();
    };
  });

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
// imprimir / guardar como PDF (mesmo padrão do SplitBill). O aspeto segue o
// da app (Azulejo): cobalto, cartões brancos sobre fundo claro, as mesmas
// fontes e os mesmos quadrados coloridos das categorias.
function abrirRelatorio(html, titulo) {
  // o iframe é srcdoc: as fontes vão por URL absoluto, para não depender da
  // base que o browser lhe atribui
  const font = f => new URL(`fonts/${f}`, location.href).href;
  const azulejo = getComputedStyle(document.documentElement).getPropertyValue("--azulejo").trim() || "none";
  const docHtml = `<!DOCTYPE html><html lang="pt"><head><meta charset="UTF-8"><title>${esc(titulo)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      @font-face { font-family: "Bricolage Grotesque"; font-weight: 500 800; font-display: swap;
        src: url("${font("bricolage-grotesque.woff2")}") format("woff2"); }
      @font-face { font-family: "Figtree"; font-weight: 400 800; font-display: swap;
        src: url("${font("figtree.woff2")}") format("woff2"); }
      * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
      @page { margin: 12mm; }
      @media print { body { margin: 0; background: #fff !important; } .r-wrap { padding: 0 !important; } }
      body { margin: 0; background: #f4f6fb; color: #0e1a3a;
        font-family: "Figtree", system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 13px; }
      .r-wrap { max-width: 720px; margin: 0 auto; padding: 20px 16px 48px; }
      .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .pos { color: #2140c8; } .neg { color: #c2410c; } .muted { color: #5b6785; }

      /* cabeçalho cobalto com o padrão de azulejo, como o da app */
      .r-hero { position: relative; background: #2140c8; color: #fff; border-radius: 22px;
        padding: 20px 20px 18px; overflow: hidden; }
      .r-hero::before { content: ""; position: absolute; inset: 0; background: ${azulejo} 0 0 / 44px 44px; opacity: .55; }
      .r-hero > * { position: relative; }
      .r-brand { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; opacity: .75; }
      .r-name { font-family: "Bricolage Grotesque", "Figtree", sans-serif; font-size: 24px; font-weight: 700;
        letter-spacing: -.02em; line-height: 1.15; margin-top: 4px; }
      .r-desc { font-size: 13px; opacity: .88; margin-top: 3px; }
      .r-total-label { font-size: 12px; font-weight: 600; opacity: .85; margin-top: 16px; }
      .r-total { font-family: "Bricolage Grotesque", "Figtree", sans-serif; font-size: 38px; font-weight: 700;
        letter-spacing: -.035em; line-height: 1.05; }
      .r-stats { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 2fr); gap: 8px; margin-top: 14px; }
      .r-stat { background: rgba(255,255,255,.14); border-radius: 14px; padding: 8px 11px; min-width: 0; }
      .r-stat span { display: block; font-size: 11px; font-weight: 600; opacity: .85; }
      .r-stat strong { display: block; font-size: 15px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      h2.r-sec { font-size: 11px; font-weight: 700; color: #5b6785; text-transform: uppercase;
        letter-spacing: .07em; margin: 24px 4px 8px; page-break-after: avoid; break-after: avoid; }
      .r-card { background: #fff; border-radius: 18px; padding: 4px 14px;
        box-shadow: 0 1px 2px rgba(14,26,58,.06), 0 8px 20px -12px rgba(14,26,58,.22); }
      @media print { .r-card { box-shadow: none; border: 1px solid #dde2ee; } }
      .r-block { page-break-inside: avoid; break-inside: avoid; }

      /* linhas ao estilo das listas da app */
      .r-row { display: flex; align-items: center; gap: 11px; padding: 9px 0;
        page-break-inside: avoid; break-inside: avoid; }
      .r-row + .r-row { border-top: 1px solid #e9ecf4; }
      .r-main { flex: 1; min-width: 0; }
      .r-title { font-weight: 650; font-size: 13.5px; line-height: 1.3; }
      .r-sub { font-size: 11.5px; color: #5b6785; line-height: 1.35; margin-top: 1px; }
      .r-sub b { color: #0e1a3a; font-weight: 650; }
      .r-sub .nw { white-space: nowrap; }
      .r-cats { font-size: 11px; color: #5b6785; margin-top: 1px; }
      .r-end { flex: none; text-align: right; font-weight: 750; font-size: 13.5px; }
      .r-end small { display: block; font-size: 11px; font-weight: 600; color: #5b6785; }
      .r-day { display: flex; justify-content: space-between; gap: 8px; padding: 12px 0 4px;
        font-size: 11px; font-weight: 700; color: #5b6785; text-transform: uppercase; letter-spacing: .05em;
        page-break-after: avoid; break-after: avoid; }
      .r-day + .r-row { border-top: none; }
      .r-row + .r-day { border-top: 1px solid #e9ecf4; margin-top: 2px; }

      .cat-ico { flex: none; width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center;
        background: var(--ct, #f3f5fa); border-radius: 11px; font-size: 18px; line-height: 1; position: relative; }
      .cat-ico.none { opacity: .4; background: none; border: 1.5px dashed #dde2ee; filter: grayscale(1); }
      .cat-duo { display: inline-flex; align-items: center; font-size: .8em; line-height: 1; }
      .cat-duo > span + span { margin-left: -.3em; }
      .cat-multi-badge { position: absolute; right: -4px; bottom: -4px; background: #2140c8; color: #fff;
        border-radius: 999px; font-size: 9px; line-height: 1; padding: 2px 4px; font-weight: 700; }
      .ct-rose { --ct: #fbe9e4; } .ct-teal { --ct: #e3f3ef; } .ct-cobalt { --ct: #e8ecfb; }
      .ct-violet { --ct: #f0eafb; } .ct-sand { --ct: #f8eedc; } .ct-sky { --ct: #e3f1f8; }
      .ct-berry { --ct: #fbe7ee; } .ct-ochre { --ct: #fff1cc; } .ct-slate { --ct: #eceff5; }

      .r-av { flex: none; width: 32px; height: 32px; border-radius: 50%; background: #e8ecfb; color: #2140c8;
        display: inline-flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; }
      .r-chip { display: inline-block; border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 700; }
      .r-chip.pos { background: rgba(33,64,200,.09); } .r-chip.neg { background: rgba(194,65,12,.09); }
      .r-chip.zero { background: rgba(91,103,133,.10); color: #5b6785; }
      .r-bar { height: 5px; border-radius: 99px; background: #e9ecf4; margin-top: 5px; overflow: hidden; }
      .r-bar i { display: block; height: 100%; background: #2140c8; border-radius: 99px; }
      .r-arrow { color: #5b6785; font-weight: 600; }
      .r-foot { display: flex; justify-content: space-between; padding: 10px 0; border-top: 1px solid #dde2ee;
        font-weight: 800; }
      .r-ok { color: #2140c8; font-weight: 650; padding: 12px 0; }
      .r-footer { text-align: center; font-size: 11px; color: #5b6785; margin-top: 28px; }
    </style>
  </head><body>${html}</body></html>`;

  document.getElementById("rptOverlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "rptOverlay";
  ov.style.cssText = "position:fixed;inset:0;z-index:99999;background:#f4f6fb;display:flex;flex-direction:column";
  // barra de topo: «voltar» à esquerda, nome do ficheiro no meio (truncado) e
  // «guardar PDF» à direita — os botões nunca encolhem, o nome cede o espaço.
  ov.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;padding-top:max(10px, env(safe-area-inset-top));background:#2140c8;color:#fff;flex:0 0 auto;font-family:var(--font-body)">
      <button id="rptClose" title="Voltar" aria-label="Voltar" style="flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;background:rgba(255,255,255,.14);border:none;color:#fff;border-radius:50%;cursor:pointer;box-shadow:none;padding:0">${uiIco("back")}</button>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:14px">${esc(titulo)}</span>
      <button id="rptPrint" style="flex:0 0 auto;background:#f2b33d;border:none;color:#0e1a3a;font-weight:700;font-size:14px;padding:10px 16px;border-radius:999px;cursor:pointer;white-space:nowrap;box-shadow:none">Guardar PDF</button>
    </div>
    <iframe id="rptFrame" style="flex:1 1 auto;border:0;width:100%;background:#f4f6fb"></iframe>`;
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

// «Quem pagou» de uma despesa, resumido para o relatório (HTML já escapado).
// - cada um pagou o seu: só a nota e, se as partes forem iguais (±1 cêntimo),
//   quanto coube a cada um;
// - um pagador: o nome;
// - vários: até três, cada um com o seu valor; mais do que isso, os que
//   pagaram valores diferentes e os «restantes» que pagaram todos o mesmo
//   (ou, sem valor comum, os dois maiores e o total dos restantes).
function quemPagouRelatorio(x, memberName, cur) {
  const money = c => `<span class="num">${fmtMoney(c, cur)}</span>`;
  const quase = (a, b) => Math.abs(a - b) <= 1;
  const pessoas = n => `<span class="nw">${n} pessoa${n === 1 ? "" : "s"}</span>`;

  if (x.split_mode === "own") {
    const vals = x.expense_shares.map(s => toCents(s.amount));
    const n = vals.length;
    const iguais = n > 1 && vals.every(v => quase(v, vals[0]));
    const cada = iguais ? ` · <span class="nw"><b>${money(Math.round(toCents(x.amount) / n))}</b> cada</span>` : "";
    return `Cada um pagou a sua parte · ${pessoas(n)}${cada}`;
  }

  const divide = ` · ${pessoas(x.expense_shares.length)}`;
  const payers = x.expense_payers
    .map(p => ({ nome: esc(memberName(p.member_id)), c: toCents(p.amount) }))
    .sort((a, b) => b.c - a.c);
  if (payers.length === 0) return "—";
  if (payers.length === 1) return `<b>${payers[0].nome}</b> pagou${divide}`;

  const item = p => `<span class="nw"><b>${p.nome}</b> ${money(p.c)}</span>`;
  if (payers.every(p => quase(p.c, payers[0].c))) {
    const quem = payers.length <= 3
      ? payers.map(p => `<b>${p.nome}</b>`).join(", ").replace(/, (?!.*, )/, " e ")
      : `${payers.length} pessoas`;
    return `${quem} pagaram ${money(payers[0].c)} cada${divide}`;
  }
  if (payers.length <= 3) return `${payers.map(item).join(" · ")}${divide}`;

  // o valor que mais gente pagou (±1 cêntimo) fica como «restantes»
  let comum = null;
  for (const p of payers) {
    const n = payers.filter(q => quase(q.c, p.c)).length;
    if (n >= 2 && (!comum || n > comum.n)) comum = { c: p.c, n };
  }
  if (comum) {
    const aParte = payers.filter(p => !quase(p.c, comum.c));
    return `${aParte.map(item).join(" · ")} · <span class="nw"><b>Restantes (${comum.n})</b> ${money(comum.c)} cada</span>${divide}`;
  }
  const resto = payers.slice(2);
  return `${payers.slice(0, 2).map(item).join(" · ")} · <span class="nw"><b>Restantes (${resto.length})</b> ${money(resto.reduce((a, p) => a + p.c, 0))}</span>${divide}`;
}

// Constrói e mostra o relatório completo de um grupo: resumo, despesas,
// total por categoria, quota por pessoa, saldos, acertos e pagamentos.
function gerarRelatorioGrupo(ctx) {
  const { group, members, expenses, payments } = ctx;
  const cur = group.currency;
  const memberName = id => members.find(m => m.id === id)?.name || "?";
  const money = c => `<span class="num">${fmtMoney(c, cur)}</span>`;
  const inicial = nome => esc((nome || "?").trim().charAt(0).toUpperCase());

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
  const byName = (a, b) => a.name.localeCompare(b.name, "pt", { sensitivity: "base" });
  const pct = c => (total > 0 ? Math.round(c / total * 100) : 0);

  // ---- cabeçalho ----
  const dataStr = new Date().toLocaleDateString("pt-PT", { day: "numeric", month: "long", year: "numeric" });
  const datas = expenses.map(x => x.expense_date).sort();
  const periodo = datas.length === 0 ? "—"
    : datas[0] === datas[datas.length - 1] ? fmtDiaMes(datas[0])
    : `${fmtDiaMes(datas[0])} – ${fmtDiaMes(datas[datas.length - 1])}`;
  const cabecalho = `
    <header class="r-hero">
      <div class="r-brand">SplitWisely · Relatório de ${esc(dataStr)}</div>
      <div class="r-name">${esc(group.name)}</div>
      ${group.description ? `<div class="r-desc">${esc(group.description)}</div>` : ""}
      <div class="r-total-label">Total do grupo</div>
      <div class="r-total num">${fmtMoney(total, cur)}</div>
      <div class="r-stats">
        <div class="r-stat"><span>Despesas</span><strong>${expenses.length}</strong></div>
        <div class="r-stat"><span>Membros</span><strong>${members.length}</strong></div>
        <div class="r-stat"><span>Período</span><strong>${esc(periodo)}</strong></div>
      </div>
    </header>`;

  // ---- despesas ---- agrupadas por dia, como na lista da app
  const dayLabel = d => {
    const dt = new Date(d + "T00:00:00");
    const wd = dt.toLocaleDateString("pt-PT", { weekday: "long" }).slice(0, 3);
    return `${wd}, ${fmtDiaMes(d)}${dt.getFullYear() !== new Date().getFullYear() ? ` ${dt.getFullYear()}` : ""}`;
  };
  const ordenadas = [...expenses]
    .sort((a, b) => (a.expense_date < b.expense_date ? 1 : a.expense_date > b.expense_date ? -1 : 0));
  const dayTotals = new Map();
  for (const x of ordenadas) dayTotals.set(x.expense_date, (dayTotals.get(x.expense_date) || 0) + toCents(x.amount));
  let lastDay = null;
  const despRows = ordenadas.map(x => {
    const head = x.expense_date !== lastDay
      ? `<div class="r-day"><span>${esc(dayLabel(x.expense_date))}</span><span class="num">${fmtMoney(dayTotals.get(x.expense_date), cur)}</span></div>`
      : "";
    lastDay = x.expense_date;
    const splits = expenseCatSplits(x).filter(s => s.cat !== "none");
    const catLine = splits.length >= 2
      ? `<div class="r-cats">${splits.map(s => `${catOf(s.cat).icon} ${money(s.cents)}`).join(" &nbsp; ")}</div>` : "";
    return `${head}
      <div class="r-row">
        ${expenseCatIconHtml(x)}
        <div class="r-main">
          <div class="r-title">${esc(x.description || "—")}</div>
          <div class="r-sub">${quemPagouRelatorio(x, memberName, cur)}</div>
          ${catLine}
        </div>
        <div class="r-end num">${fmtMoney(toCents(x.amount), cur)}</div>
      </div>`;
  }).join("");
  const despSec = expenses.length === 0 ? "" : `
    <h2 class="r-sec">Despesas</h2>
    <div class="r-card">${despRows}</div>`;

  // ---- total por categoria ----
  const catSec = cats.length === 0 ? "" : `
    <h2 class="r-sec">Por categoria</h2>
    <div class="r-card">${cats.map(([id, e]) => {
      const c = catOf(id);
      return `<div class="r-row">
        ${catIconHtml(id === "none" ? null : id)}
        <div class="r-main">
          <div class="r-title">${esc(c ? c.label : "Sem categoria")}</div>
          <div class="r-bar"><i style="width:${pct(e.cents)}%"></i></div>
        </div>
        <div class="r-end num">${fmtMoney(e.cents, cur)}<small>${pct(e.cents)}%</small></div>
      </div>`;
    }).join("")}</div>`;

  // ---- quota por pessoa ---- (membros por ordem alfabética)
  const quotaSec = members.length === 0 ? "" : `
    <h2 class="r-sec">Quota por pessoa</h2>
    <div class="r-card">${[...members].sort(byName).map(m => `
      <div class="r-row">
        <span class="r-av">${inicial(m.name)}</span>
        <div class="r-main">
          <div class="r-title">${esc(m.name)}</div>
          <div class="r-sub">Adiantou <b>${money(paid[m.id] || 0)}</b></div>
        </div>
        <div class="r-end num">${fmtMoney(share[m.id] || 0, cur)}<small>${pct(share[m.id] || 0)}% do total</small></div>
      </div>`).join("")}
      <div class="r-foot"><span>Total</span><span class="num">${fmtMoney(total, cur)}</span></div>
    </div>`;

  // ---- saldos ---- (membros por ordem alfabética)
  const saldosSec = members.length === 0 ? "" : `
    <h2 class="r-sec">Saldos</h2>
    <div class="r-card">${[...members].sort(byName).map(m => {
      const b = balance[m.id];
      const chip = b === 0 ? `<span class="r-chip zero">em dia</span>`
        : `<span class="r-chip ${b > 0 ? "pos" : "neg"} num">${b > 0 ? "recebe " : "deve "}${fmtMoney(Math.abs(b), cur)}</span>`;
      return `<div class="r-row">
        <span class="r-av">${inicial(m.name)}</span>
        <div class="r-main"><div class="r-title">${esc(m.name)}</div></div>
        ${chip}
      </div>`;
    }).join("")}</div>`;

  // ---- como acertar contas ----
  const acertosSec = `
    <h2 class="r-sec">Como acertar contas</h2>
    <div class="r-card">${settlements.length === 0
      ? `<div class="r-ok">Está tudo em dia 🎉</div>`
      : [...settlements].sort((a, b) => byName(a.from, b.from) || byName(a.to, b.to)).map(s => `
        <div class="r-row">
          <span class="r-av">${inicial(s.from.name)}</span>
          <div class="r-main">
            <div class="r-title">${esc(s.from.name)} <span class="r-arrow">→</span> ${esc(s.to.name)}</div>
          </div>
          <div class="r-end num neg">${fmtMoney(s.cents, cur)}</div>
        </div>`).join("")}</div>`;

  // ---- pagamentos registados ----
  const pagSec = payments.length === 0 ? "" : `
    <h2 class="r-sec">Pagamentos registados</h2>
    <div class="r-card">${[...payments]
      .sort((a, b) => (a.payment_date < b.payment_date ? 1 : -1))
      .map(p => `<div class="r-row">
        <span class="r-av">${inicial(memberName(p.from_member))}</span>
        <div class="r-main">
          <div class="r-title">${esc(memberName(p.from_member))} <span class="r-arrow">→</span> ${esc(memberName(p.to_member))}</div>
          <div class="r-sub">${fmtDate(p.payment_date)}${p.note ? ` · ${esc(p.note)}` : ""}</div>
        </div>
        <div class="r-end num pos">${fmtMoney(toCents(p.amount), cur)}</div>
      </div>`).join("")}</div>`;

  // cada quadro curto num bloco que o browser tenta manter na mesma página
  // (título + cartão juntos); o das despesas pode ocupar várias páginas e
  // parte-se entre linhas
  const bloco = s => s ? `<section class="r-block">${s}</section>` : "";
  const html = `<div class="r-wrap">
    ${cabecalho}${despSec ? `<section>${despSec}</section>` : ""}${bloco(catSec)}${bloco(quotaSec)}${bloco(saldosSec)}${bloco(acertosSec)}${bloco(pagSec)}
    <div class="r-footer">Gerado pela SplitWisely</div>
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
// em despesas onde o membro já participe, nem em despesas sem valor, nem nas
// de «cada um pagou o seu» — aí entra quem lá esteve, e meter o novo membro
// só nas quotas deixava-o a dever o que não gastou.
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
    if (x.split_mode === "own") continue;
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
    if (r.split_mode === "own") continue;
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

// ------------------------------------------------ sugestões de pessoas (membros)
// Pessoas que já estão na base de dados, para as pôr num grupo sem voltar a
// escrever o email. Vem só do que a RLS deixa ver: os membros com email dos
// grupos a que tens acesso — e, para o admin, também as contas registadas:
// as da SplitWisely (profiles) e as das outras apps do projeto partilhado
// (RPC admin_known_people, que lê auth.users e só responde ao admin).
// Ninguém fica a conhecer emails de grupos que não são seus.
// Carrega-se à primeira vez que se foca um campo e serve a secção dos membros
// enquanto estiver aberta — cada vez que se desenha, volta a ir buscar, para
// apanhar quem entretanto foi adicionado (aqui ou noutro grupo).
let peopleBook = null;
function invalidatePeopleBook() { peopleBook = null; }
function loadPeopleBook() {
  if (!peopleBook) peopleBook = fetchPeopleBook().catch(err => {
    console.error(err);
    peopleBook = null;  // sem sugestões desta vez; tenta de novo no próximo foco
    return [];
  });
  return peopleBook;
}
async function fetchPeopleBook() {
  const none = { data: [] };
  const [m, p, a] = await Promise.all([
    fetchAllRows((from, to) =>
      sb.from("group_members").select("name, email, created_at")
        .not("email", "is", null).order("id").range(from, to)),
    profile?.is_admin
      ? sb.from("profiles").select("full_name, email").not("email", "is", null)
      : none,
    // schema antigo sem a RPC: o erro ignora-se e ficam só os profiles
    profile?.is_admin ? sb.rpc("admin_known_people") : none,
  ]);
  if (m.error) throw m.error;

  // um registo por email (sem olhar a maiúsculas). O nome é o da vez mais
  // recente em que a pessoa entrou num grupo — é o nome que tu lhe dás —, e
  // só na falta disso o da conta Google. Ordena-se pelos grupos em comum.
  const byKey = new Map();
  for (const r of m.data) {
    const email = r.email.trim();
    const key = email.toLowerCase();
    if (!key) continue;
    const cur = byKey.get(key);
    if (!cur) byKey.set(key, { key, email, name: r.name, at: r.created_at, groups: 1 });
    else {
      cur.groups++;
      if (r.created_at > cur.at) Object.assign(cur, { email, name: r.name, at: r.created_at });
    }
  }
  const accounts = [
    ...(p.data || []).map(u => ({ name: u.full_name, email: u.email })),
    ...(a.error ? [] : a.data || []),
  ];
  for (const u of accounts) {
    const key = (u.email || "").trim().toLowerCase();
    if (key && !byKey.has(key)) {
      byKey.set(key, { key, email: u.email.trim(), name: u.name || key.split("@")[0], groups: 0 });
    }
  }
  return [...byKey.values()]
    .map(x => ({ ...x, normName: catNorm(x.name).trim().replace(/\s+/g, " ") }))
    .sort((a, b) => b.groups - a.groups || a.normName.localeCompare(b.normName));
}

// Até 6 pessoas que batem com o que se escreveu: início de qualquer palavra
// do nome (sem acentos) ou qualquer pedaço do email. Fica de fora quem já
// está no grupo (exclude = emails em minúsculas) e o email escrito por
// inteiro — já está escolhido, não há nada a sugerir. Com hint (o nome do
// membro que se está a editar), quem tem um nome parecido vem primeiro.
function matchPeople(book, q, exclude, hint) {
  const nq = catNorm(q).trim();
  const found = book.filter(p => !exclude.has(p.key) && p.key !== nq && (!nq
      || p.normName.startsWith(nq)
      || p.normName.split(" ").some(w => w.startsWith(nq))
      || p.key.includes(nq)));
  // sort estável: entre parecidos (e entre os outros) mantém-se a ordem do livro
  if (hint) found.sort((a, b) => nameLikeness(b, hint) - nameLikeness(a, hint));
  return found.slice(0, 6);
}

// Quanto uma pessoa do livro se parece com o nome de um membro: 2 = o mesmo
// nome (sem acentos nem maiúsculas), 1 = partilham uma palavra do nome
// («Maria» e «Maria Costa») ou o email começa por ela, 0 = nada a ver.
const NAME_LINKS = new Set(["das", "dos", "del"]);
function nameLikeness(p, name) {
  const n = catNorm(name).trim().replace(/\s+/g, " ");
  if (!n) return 0;
  if (p.normName === n) return 2;
  const words = new Set(p.normName.split(" "));
  const local = p.key.split("@")[0];
  return n.split(" ").some(t => t.length >= 3 && !NAME_LINKS.has(t)
    && (words.has(t) || local.startsWith(t))) ? 1 : 0;
}

// Liga a lista de sugestões $box a um ou mais campos. A lista vive no fluxo
// da página, logo por baixo dos campos, e não por cima deles: os cartões têm
// overflow e cortavam um menu flutuante.
// fields: [{ el, minChars }] — minChars 0 abre a lista logo ao focar.
// onPick(pessoa, campo) preenche o formulário.
// hint: nome do membro que se está a editar. Com o campo ainda vazio, quem
// tem esse nome aparece logo, sem tocar no campo — o membro criado só com
// nome num grupo encontra o email que já se lhe deu noutro.
function attachPeopleSuggest($box, fields, exclude, onPick, { hint } = {}) {
  let items = [], active = -1, $cur = null;

  const close = () => {
    $box.hidden = true;
    $box.innerHTML = "";
    items = []; active = -1;
    fields.forEach(f => f.el.setAttribute("aria-expanded", "false"));
  };
  const paint = () => $box.querySelectorAll("[data-i]")
    .forEach((b, i) => b.classList.toggle("active", i === active));
  const pick = (i) => {
    const p = items[i], $in = $cur;
    close();
    if (p) onPick(p, $in);
  };
  const render = (list, caption = "") => {
    items = list; active = -1;
    $box.innerHTML = (caption ? `<div class="ps-caption">${esc(caption)}</div>` : "")
      + list.map((p, i) => `
      <button type="button" class="ps-item" role="option" data-i="${i}">
        ${avatarHtml(p.name, "small")}
        <span class="item-main">
          <span class="item-title">${esc(p.name)}</span>
          <span class="item-sub">${esc(p.email)}</span>
        </span>
      </button>`).join("");
    $box.hidden = false;
  };
  const show = async (f) => {
    $cur = f.el;
    const book = await loadPeopleBook();
    if (document.activeElement !== f.el) return;  // saiu do campo entretanto
    const q = f.el.value;
    if (q.trim().length < f.minChars) return close();
    const list = matchPeople(book, q, exclude, hint);
    if (!list.length) return close();
    render(list);
    f.el.setAttribute("aria-expanded", "true");
  };

  // mousedown sem default: tocar numa sugestão não tira o foco ao campo
  // (senão o blur fechava a lista antes de o clique chegar)
  $box.addEventListener("mousedown", e => e.preventDefault());
  $box.addEventListener("click", e => {
    const b = e.target.closest("[data-i]");
    if (b) pick(+b.dataset.i);
  });

  for (const f of fields) {
    f.el.setAttribute("autocomplete", "off");  // a lista do browser tapava esta
    f.el.setAttribute("role", "combobox");
    f.el.setAttribute("aria-autocomplete", "list");
    f.el.setAttribute("aria-controls", $box.id);
    f.el.setAttribute("aria-expanded", "false");
    f.el.addEventListener("focus", () => show(f));
    f.el.addEventListener("input", () => show(f));
    f.el.addEventListener("blur", close);
    f.el.addEventListener("keydown", e => {
      if ($box.hidden || $cur !== f.el) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = items.length;
        active = e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n;
        paint();
      } else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();  // escolhe a sugestão em vez de submeter o formulário
        pick(active);
      } else if (e.key === "Escape") {
        e.stopPropagation();  // num pop-up, o Escape fecha só a lista
        close();
      }
    });
  }

  // pré-preenchimento: campo vazio e alguém com este nome já tem email
  if (hint) loadPeopleBook().then(book => {
    const f = fields[0];
    if (!f.el.isConnected || f.el.value.trim() || document.activeElement === f.el) return;
    const list = book.filter(p => !exclude.has(p.key) && nameLikeness(p, hint) > 0)
      .sort((a, b) => nameLikeness(b, hint) - nameLikeness(a, hint))
      .slice(0, 3);
    if (!list.length) return;
    $cur = f.el;
    render(list, list.length > 1 ? "É uma destas pessoas? Toca para usar o email."
                                 : "É esta pessoa? Toca para usar o email.");
  });
}

// ------------------------------------------------ secção: membros (dentro das definições)
function renderMembersSection($c, ctx) {
  const { members } = ctx;
  const useWeights = !!ctx.group.use_weights;
  invalidatePeopleBook();  // sugestões frescas a cada vez que a secção se desenha
  // emails de quem já está no grupo: esses não se sugerem outra vez
  const inGroup = new Set(members.map(m => (m.email || "").trim().toLowerCase()).filter(Boolean));

  // permissões de cada membro no grupo (o que a conta ligada pode fazer).
  // 'write_all' é o default (edita tudo) e não mostra badge — só se destacam
  // os acessos restringidos. Só o criador do grupo pode alterar isto.
  const roleMeta = (r) => MEMBER_ROLES[r] || MEMBER_ROLES.write_all;
  const roleBadge = (m) => {
    const r = m.role || "write_all";
    if (r === "write_all") return "";
    const meta = roleMeta(r);
    return ` <span class="role-badge role-${r}" title="${esc(meta.label)}">${meta.icon} ${esc(meta.short)}</span>`;
  };

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
              <span class="item-title">${esc(m.name)}${roleBadge(m)}</span>
              ${m.user_id ? `<span class="item-sub"><span class="badge linked">conta ligada</span></span>`
                : m.email ? `<span class="item-sub">convite: ${esc(m.email)}</span>` : ""}
            </div>
            <div class="member-controls">
              ${useWeights ? `<label class="ctl"><span>Peso</span>
                <input type="number" step="0.1" min="0" data-mw="${m.id}" value="${m.default_weight}" ${ctx.canWrite ? "" : "disabled"} /></label>` : ""}
            </div>
            <span class="chevron">›</span>
          </li>`).join("")}
      </ul>`}
    </div>
    ${ctx.canWrite ? `
    <div class="card">
      <h2>Adicionar pessoa</h2>
      <form id="new-member">
        <div class="row">
          <div class="field" style="flex:2;"><label>Nome</label><input name="name" required placeholder="Ex.: Maria" /></div>
          <div class="field" style="flex:2;"><label>Email (opcional)</label><input name="email" type="email" placeholder="maria@gmail.com" /></div>
          ${useWeights ? `<div class="field" style="max-width:90px;"><label>Peso</label>
            <input name="weight" type="number" step="0.1" min="0" value="1" /></div>` : ""}
        </div>
        <div class="people-suggest" id="nm-suggest" role="listbox" aria-label="Pessoas que já estão na app" hidden></div>
        ${(ctx.expenses?.length || ctx.recurring?.length) ? `
        <label class="check-line" style="align-items:flex-start;">
          <input type="checkbox" name="inherit" style="margin-top:.15rem;" />
          <span>Herdar as despesas já existentes — todas as despesas do grupo
            (e os moldes recorrentes) passam a incluir esta pessoa, re-divididas
            para lhe dar uma parte.</span>
        </label>` : ""}
        <button type="submit">Adicionar</button>
        ${ctx.isOwner ? `<p class="check-note" style="margin:.5rem 0 0;">Entra como
          <strong>só-leitura</strong> por defeito — depois, no detalhe do membro, dá-lhe
          acesso para lançar/editar despesas se quiseres.</p>` : ""}
      </form>
    </div>` : ""}
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
        ${ctx.canWrite ? "" : `<div class="ro-banner"><span class="ro-ico" aria-hidden="true">👁️</span>
          <span>Tens acesso de leitura — podes consultar o membro mas não o alterar.</span></div>`}
        <div class="field"><label>Nome</label>
          <input id="m-name" value="${esc(m.name)}" required ${ctx.canWrite ? "" : "disabled"} /></div>
        <div class="field"><label>Email</label>
          <input id="m-email" type="email" value="${esc(m.email || "")}"
            placeholder="liga a pessoa à conta Google dela" ${m.user_id || !ctx.canWrite ? "disabled" : ""} /></div>
        <div class="people-suggest" id="m-suggest" role="listbox" aria-label="Pessoas que já estão na app" hidden></div>
        ${m.user_id ? `<p class="muted" style="margin:-.3rem 0 .7rem;">Esta pessoa já entrou com a
          conta Google dela <span class="badge linked">conta ligada</span> — o email já não se altera.</p>` : ""}
        ${inviteBlockHtml(m, ctx.group)}
        ${ctx.isOwner ? `
        <div class="field"><label>Permissões neste grupo</label>
          <select id="m-role">
            ${["write_all", "write_own", "read"].map(r => {
              const meta = MEMBER_ROLES[r];
              const cur = (m.role || "write_all") === r;
              return `<option value="${r}" ${cur ? "selected" : ""}>${meta.icon} ${esc(meta.label)}</option>`;
            }).join("")}
          </select></div>
        <p class="muted" style="margin:-.3rem 0 .7rem;">Aplica-se à conta ligada a este membro:
          <strong>Só leitura</strong> consulta mas não altera; <strong>só as suas</strong> lança
          despesas e edita as que criou; <strong>todas</strong> edita qualquer despesa. Só tu
          (criador do grupo) podes alterar isto.</p>` : ""}
        ${useWeights ? `<div class="field" style="max-width:120px;"><label>Peso</label>
          <input id="m-weight" type="number" step="0.1" min="0" value="${m.default_weight}" ${ctx.canWrite ? "" : "disabled"} /></div>` : ""}
        ${others.length ? `
        <div class="field"><label>Liquida preferencialmente com (opcional)</label>
          <select id="m-settle" ${ctx.canWrite ? "" : "disabled"}>
            <option value="">— sem preferência —</option>
            ${others.map(o => `<option value="${o.id}" ${m.settle_with === o.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}
          </select></div>
        <p class="muted" style="margin:-.3rem 0 .7rem;">Útil para convidados: se ${esc(shortName(m.name))}
          tiver a pagar e a pessoa escolhida a receber, o acerto de contas sugere primeiro
          que liquide com ela, antes da distribuição normal.</p>` : ""}
        ${ctx.canWrite ? `
        <div class="form-actions">
          <button id="m-save">Guardar</button>
          <button class="danger" id="m-del">Remover do grupo</button>
        </div>` : ""}
      </div>`;
    $slot.scrollIntoView({ behavior: "smooth", block: "start" });

    const close = () => { $slot.innerHTML = ""; $wrap.style.display = ""; };
    $slot.querySelector("#m-back").onclick = close;

    // email ainda editável (sem conta ligada): sugere quem já está na app,
    // a começar por quem tem o mesmo nome que este membro
    const $mEmail = $slot.querySelector("#m-email");
    if (!$mEmail.disabled) {
      attachPeopleSuggest($slot.querySelector("#m-suggest"), [{ el: $mEmail, minChars: 0 }],
        inGroup, (p) => { $mEmail.value = p.email; }, { hint: m.name });
    }

    const $mSave = $slot.querySelector("#m-save");
    if ($mSave) $mSave.onclick = async () => {
      const name = $slot.querySelector("#m-name").value.trim();
      if (!name) return toast("O nome não pode ficar vazio", true);
      const payload = { name };
      if (!m.user_id) payload.email = $slot.querySelector("#m-email").value.trim() || null;
      if (useWeights) payload.default_weight = parseFloat($slot.querySelector("#m-weight").value) || 0;
      const $settle = $slot.querySelector("#m-settle");
      if ($settle) payload.settle_with = $settle.value || null;
      // role só o criador do grupo o pode definir (o seletor só existe para ele)
      const $role = $slot.querySelector("#m-role");
      if ($role) payload.role = $role.value;
      let { error } = await sb.from("group_members").update(payload).eq("id", m.id);
      // schema antigo sem a coluna settle_with/role: grava o resto na mesma —
      // e o aviso fica no ecrã (sem ser tapado pelo toast de sucesso)
      let settleWarn = false, roleWarn = false;
      if (error && "role" in payload && /(\brole\b|column .*role)/i.test(error.message)) {
        roleWarn = true;
        delete payload.role;
        ({ error } = await sb.from("group_members").update(payload).eq("id", m.id));
      }
      if (error && "settle_with" in payload && /settle_with/i.test(error.message)) {
        settleWarn = true;
        delete payload.settle_with;
        ({ error } = await sb.from("group_members").update(payload).eq("id", m.id));
      }
      if (error) return toast(error.message, true);
      if (roleWarn) {
        toast("Membro atualizado, mas as PERMISSÕES não ficaram gravadas — "
          + "corre o schema.sql mais recente no SQL Editor do Supabase", true);
      } else if (settleWarn) {
        toast("Membro atualizado, mas a preferência de liquidação NÃO ficou gravada — "
          + "corre o schema.sql mais recente no SQL Editor do Supabase", true);
      } else {
        toast("Membro atualizado");
      }
      refresh();
    };

    const $mDel = $slot.querySelector("#m-del");
    if ($mDel) $mDel.onclick = async () => {
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

  const $newMember = $c.querySelector("#new-member");
  if ($newMember) {
    // nome ou email de alguém que já está noutro grupo: um toque preenche os dois
    const $name = $newMember.querySelector('[name="name"]');
    const $email = $newMember.querySelector('[name="email"]');
    attachPeopleSuggest($c.querySelector("#nm-suggest"),
      [{ el: $name, minChars: 1 }, { el: $email, minChars: 0 }], inGroup,
      (p, $from) => {
        $email.value = p.email;
        // escolhida a partir do nome, fica o nome da sugestão; a partir do
        // email, manda o nome que já lá estava (só se preenche se vazio)
        if ($from === $name || !$name.value.trim()) $name.value = p.name;
      });
  }
  if ($newMember) $newMember.onsubmit = async (e) => {
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
      const quem = r.split_mode === "own"
        ? `cada um pagou o seu (${esc(payers)})`
        : `pago por ${esc(payers || "?")} · ${modeTxt(r.split_mode)}`;
      const next = nextRecurringDate(r);
      const sub = r.active
        ? (next ? `próxima: ${fmtDate(next.toISOString().slice(0, 10))}` : "sem próximas ocorrências")
        : "em pausa";
      return `<li class="clickable" data-open="${r.id}">
          <span class="date-block"><span class="m">dia</span><span class="d">${r.day_of_month}</span></span>
          ${catIconHtml(r.category)}
          <div class="item-main">
            <span class="item-title">${esc(r.description)}${r.active ? "" : ' <span class="badge">pausada</span>'}</span>
            <span class="item-sub">${quem} · ${esc(sub)}</span>
          </div>
          <div class="item-end"><span class="amount">${fmtMoney(toCents(r.amount), cur)}</span></div>
          <span class="chevron">›</span>
        </li>`;
    }).join("");

    $c.innerHTML = `
      <div class="card">
        <div class="header-row">
          <h2 style="margin:0;">Despesas recorrentes ${recurring.length ? `<span class="muted">· ${recurring.length}</span>` : ""}</h2>
          ${ctx.canWrite ? `<button id="btn-add-rec" ${members.length === 0 ? "disabled" : ""}>+ Nova</button>` : ""}
        </div>
        <p class="muted" style="margin-top:-.4rem;">Repetem-se todos os meses num certo dia (renda, ginásio, subscrições…).
          São lançadas automaticamente quando alguém abre a app.</p>
        ${members.length === 0 ? `<p class="empty">Adiciona primeiro membros em baixo.</p>` : ""}
        ${recurring.length === 0 && members.length > 0
          ? `<p class="empty">Sem despesas recorrentes ainda.</p>`
          : `<ul class="list compact">${rows}</ul>`}
      </div>`;

    // criar/editar abre no mesmo pop-up usado a partir da lista de despesas
    $c.querySelector("#btn-add-rec")?.addEventListener("click", () => openRecurringModal(ctx, null));
    $c.querySelectorAll("[data-open]").forEach(li => {
      li.onclick = () => openRecurringModal(ctx, recurring.find(x => x.id === li.dataset.open));
    });
  }
  draw();
}

// ------------------------------------------------ link público (só o criador)
// Um link de consulta do grupo, sem login, com validade — ver
// group_share_links no schema.sql e renderPublicGroup. Um link por grupo:
// mudar a validade mantém o endereço (quem já o tem continua a usá-lo);
// desligar apaga-o, e o seguinte nasce com outro endereço.
const SHARE_VALIDITY = [
  ["1", "24 horas"], ["7", "7 dias"], ["30", "30 dias"], ["90", "3 meses"], ["date", "Até ao dia…"],
];

async function renderShareLinkSection($el, ctx) {
  const { group } = ctx;
  const head = `<h2>🔗 Link público</h2>
    <p class="muted">Para quem não tem conta: quem abrir o link vê as despesas e os saldos
      do grupo, sem login e sem poder alterar nada. Os emails não aparecem.</p>`;
  $el.innerHTML = `<div class="card">${head}<p class="muted">A carregar…</p></div>`;

  const { data, error } = await sb.from("group_share_links")
    .select("token, expires_at").eq("group_id", group.id).maybeSingle();
  if (error) {
    console.warn("group_share_links:", error.message);
    $el.innerHTML = `<div class="card">${head}<p class="hint">Indisponível — corre o
      <code>supabase/schema.sql</code> mais recente no Supabase.</p></div>`;
    return;
  }
  let link = data;
  let busy = false;

  // validade escolhida -> instante em que expira (null = escolha inválida).
  // «Até ao dia…» vale até ao fim desse dia, na hora deste dispositivo.
  const expiryOf = (choice, day) => {
    if (choice !== "date") return new Date(Date.now() + Number(choice) * 86400000);
    if (!day) return null;
    const d = new Date(day + "T23:59:59");
    return d > new Date() ? d : null;
  };

  const draw = () => {
    const live = !!link && Date.parse(link.expires_at) > Date.now();
    const url = link ? `${appBaseUrl()}#/p/${link.token}` : "";
    const today = new Date().toISOString().slice(0, 10);
    $el.innerHTML = `
      <div class="card share-card">
        ${head}
        ${link ? `
          <div class="share-url ${live ? "" : "dead"}">
            <input id="sl-url" readonly value="${esc(url)}" aria-label="Link público" />
            ${live ? `<button type="button" class="secondary small" id="sl-copy">Copiar</button>` : ""}
          </div>
          <p class="share-state ${live ? "" : "dead"}">${live
            ? `Válido até <strong>${esc(fmtDateTime(link.expires_at))}</strong>.`
            : `Expirou a <strong>${esc(fmtDateTime(link.expires_at))}</strong> — quem o abre só vê um aviso.`}</p>
          ${live && navigator.share ? `<button type="button" class="share-btn" id="sl-share">Partilhar link</button>` : ""}` : ""}
        <div class="row share-validity">
          <div class="field">
            <label for="sl-valid">${!link ? "Validade" : live ? "Nova validade, a contar de agora" : "Reativar por"}</label>
            <select id="sl-valid">${SHARE_VALIDITY.map(([v, l]) =>
              `<option value="${v}" ${v === "30" ? "selected" : ""}>${l}</option>`).join("")}</select>
          </div>
          <div class="field hidden" id="sl-day-field">
            <label for="sl-day">Dia</label>
            <input type="date" id="sl-day" min="${today}" />
          </div>
        </div>
        <div class="share-actions">
          <button type="button" id="sl-save" ${live ? `class="secondary"` : ""}>${
            !link ? "Criar link" : live ? "Mudar validade" : "Reativar link"}</button>
          ${link ? `<button type="button" class="danger" id="sl-del">Desligar link</button>` : ""}
        </div>
      </div>`;

    const $valid = $el.querySelector("#sl-valid");
    const $dayField = $el.querySelector("#sl-day-field");
    $valid.onchange = () => $dayField.classList.toggle("hidden", $valid.value !== "date");

    const $url = $el.querySelector("#sl-url");
    if ($url) $url.onfocus = () => $url.select();

    $el.querySelector("#sl-copy")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
        toast("Link copiado 📋");
      } catch (_) {
        // sem acesso à área de transferência (http, browser antigo): fica
        // selecionado para copiar à mão
        $url.focus();
        $url.select();
        toast("Copia o link selecionado");
      }
    });
    $el.querySelector("#sl-share")?.addEventListener("click", () => {
      navigator.share({
        title: group.name,
        text: `Despesas e saldos do grupo «${group.name}» no SplitWisely (só consulta, sem login).`,
        url,
      }).catch(() => { /* partilha cancelada */ });
    });

    $el.querySelector("#sl-save").onclick = async () => {
      if (busy) return;
      const when = expiryOf($valid.value, $el.querySelector("#sl-day").value);
      if (!when) return toast("Escolhe um dia a partir de hoje", true);
      busy = true;
      const expires_at = when.toISOString();
      // o token nasce no servidor (trigger share_links_guard) e não muda
      // quando se mexe na validade
      const q = link
        ? sb.from("group_share_links").update({ expires_at }).eq("group_id", group.id)
        : sb.from("group_share_links").insert({ group_id: group.id, expires_at });
      const { data: saved, error: err } = await q.select("token, expires_at").single();
      busy = false;
      if (err) return toast(err.message, true);
      const created = !link;
      link = saved;
      draw();
      toast(created ? "Link criado — copia-o e partilha 🔗" : "Validade atualizada");
    };

    $el.querySelector("#sl-del")?.addEventListener("click", async () => {
      if (busy) return;
      if (!confirm("Desligar o link? Quem o tiver deixa de conseguir abrir o grupo. Se criares outro, o endereço muda.")) return;
      busy = true;
      const { error: err } = await sb.from("group_share_links").delete().eq("group_id", group.id);
      busy = false;
      if (err) return toast(err.message, true);
      link = null;
      draw();
      toast("Link desligado");
    });
  };
  draw();
}

function renderSettingsTab($c, ctx) {
  const { group, isOwner } = ctx;
  const archived = !!group.archived;
  // só o criador altera as definições — e um grupo em histórico fica congelado
  const editable = isOwner && !archived;
  const selectedCats = groupCatIds(group); // null = todas

  // contas saldadas? (todos os saldos a zero) — condição para passar a histórico
  const settled = [...groupBalancesCents(ctx.members, ctx.expenses, ctx.payments).values()]
    .every(c => c === 0);

  $c.innerHTML = `
    <div class="card">
      <h2>Definições do grupo</h2>
      ${archived
        ? `<p class="muted">Grupo em histórico: as definições estão bloqueadas. Reativa-o em «Histórico», mais abaixo, para as poderes alterar.</p>`
        : (isOwner ? "" : `<p class="muted">Só quem criou o grupo pode alterar estas definições.</p>`)}
      <form id="edit-group">
        <div class="row">
          <div class="field" style="flex:3;"><label>Nome</label>
            <input name="name" value="${esc(group.name)}" ${editable ? "" : "disabled"} required /></div>
          <div class="field"><label>Moeda</label>
            <select name="currency" ${editable ? "" : "disabled"}>
              ${["EUR", "USD", "GBP", "BRL", "CHF"].map(c =>
                `<option value="${c}" ${group.currency === c ? "selected" : ""}>${c}</option>`).join("")}
            </select></div>
        </div>
        <div class="field"><label>Descrição</label>
          <textarea name="description" id="group-desc" rows="1" ${editable ? "" : "disabled"}>${esc(group.description || "")}</textarea></div>

        <label class="toggle-card ${group.use_weights ? "on" : ""}" id="weights-card">
          <span class="toggle-card-ico" aria-hidden="true">⚖️</span>
          <span class="toggle-card-body">
            <span class="toggle-card-title">Divisão por proporções</span>
            <span class="toggle-card-note">Cada pessoa entra com um <strong>peso</strong> próprio na
              divisão (define-se na lista de membros, em baixo). Desligado, as despesas dividem-se
              em partes iguais.</span>
          </span>
          <span class="switch">
            <input type="checkbox" name="use_weights" ${group.use_weights ? "checked" : ""} ${editable ? "" : "disabled"} />
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </span>
        </label>

        <details class="cat-collapse" id="group-cats-collapse">
          <summary class="cat-collapse-summary">
            <span class="cat-collapse-ico" aria-hidden="true">🏷️</span>
            <span class="cat-collapse-titles">
              <span class="cat-collapse-title">Categorias do grupo</span>
              <span class="cat-collapse-sub">as que aparecem ao lançar despesas — por defeito, todas</span>
            </span>
            <span class="cat-collapse-count" id="cat-count"></span>
            <span class="cat-collapse-chev" aria-hidden="true">▾</span>
          </summary>
          <div class="cat-collapse-body">
            <div class="cat-pick" id="group-cats">
              ${CATEGORIES.map(c => {
                const on = !selectedCats || selectedCats.includes(c.id);
                return `<label class="cat-pick-item ${on ? "on" : ""}">
                  <input type="checkbox" name="categories" value="${c.id}" ${on ? "checked" : ""} ${editable ? "" : "disabled"} />
                  <span>${c.icon} ${esc(c.label)}</span>
                </label>`;
              }).join("")}
            </div>
            ${editable ? `<div class="cat-pick-actions">
              <button type="button" class="secondary small" id="cats-all">Todas</button>
              <button type="button" class="secondary small" id="cats-none">Nenhuma</button>
            </div>` : ""}
          </div>
        </details>

        ${editable ? `<button type="submit" id="btn-save-group" style="margin-top:.6rem;">Guardar definições</button>` : ""}
      </form>
    </div>
    <div id="members-section"></div>
    ${isOwner ? `<div id="share-link-section"></div>` : ""}
    <div id="recurring-section"></div>
    ${isOwner ? `
    <div class="card">
      <h2>Histórico</h2>
      ${archived
        ? `<p class="muted">Este grupo está em histórico: os dados estão congelados.
             Reativa-o para voltar a lançar despesas, pagamentos e alterar membros.</p>
           <button class="secondary" id="btn-unarchive">↩︎ Reativar grupo</button>`
        : `<p class="muted">Quando o evento terminar e as contas estiverem saldadas, passa o
             grupo a histórico. Fica visível numa lista compacta no ecrã principal, com os dados
             bloqueados. Podes reativá-lo a qualquer momento.</p>
           <button class="secondary" id="btn-archive" ${settled ? "" : "disabled"}>📕 Passar a histórico</button>
           ${settled ? "" : `<p class="hint">Só podes passar a histórico com todas as contas saldadas (saldos a zero).</p>`}`}
    </div>
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

  // link público de consulta — só o criador (vale também em histórico: é só leitura)
  if (isOwner) renderShareLinkSection($c.querySelector("#share-link-section"), ctx);

  // despesas recorrentes — geríveis por qualquer membro, como as despesas
  renderRecurringSection($c.querySelector("#recurring-section"), ctx);

  // descrição: caixa que cresce para baixo quando o texto não cabe numa linha
  const $desc = $c.querySelector("#group-desc");
  if ($desc) {
    const growDesc = () => { $desc.style.height = "auto"; $desc.style.height = $desc.scrollHeight + "px"; };
    $desc.addEventListener("input", growDesc);
    // ajusta à altura do conteúdo já no arranque (e após o layout assentar)
    growDesc();
    requestAnimationFrame(growDesc);
  }

  // contagem de categorias ativas no resumo do colapsável (todos veem)
  const catBoxes = () => Array.from($c.querySelectorAll('#group-cats input[name="categories"]'));
  const updateCatCount = () => {
    const n = catBoxes().filter(b => b.checked).length;
    const $cnt = $c.querySelector("#cat-count");
    if ($cnt) $cnt.textContent = n === CATEGORIES.length ? "Todas" : `${n}/${CATEGORIES.length}`;
  };
  updateCatCount();

  if (!isOwner) return;

  // passar a histórico / reativar — só o criador. Disponível mesmo com o
  // grupo já arquivado (é onde vive o botão de reativar).
  $c.querySelector("#btn-archive")?.addEventListener("click", async () => {
    if (!confirm(`Passar «${group.name}» a histórico? Os dados ficam bloqueados até reativares.`)) return;
    const { error } = await sb.from("groups").update({ archived: true }).eq("id", group.id);
    if (error) return toast(/archived/i.test(error.message)
      ? "Histórico indisponível — corre o schema.sql mais recente no Supabase" : error.message, true);
    toast("Grupo passado a histórico 📕");
    refresh();
  });
  $c.querySelector("#btn-unarchive")?.addEventListener("click", async () => {
    const { error } = await sb.from("groups").update({ archived: false }).eq("id", group.id);
    if (error) return toast(error.message, true);
    toast("Grupo reativado");
    refresh();
  });

  // as definições em si só se editam com o grupo ativo (não em histórico)
  if (editable) {
  // ligar/desligar a checkbox mostra logo (ou esconde) os pesos nos
  // membros em baixo, sem esperar pelo «Guardar definições»; e acende o cartão
  $c.querySelector('input[name="use_weights"]').onchange = (e) => {
    $c.querySelector("#weights-card")?.classList.toggle("on", e.target.checked);
    drawMembers(e.target.checked);
    if (e.target.checked) toast("Carrega em «Guardar definições» e define os pesos na lista de membros");
  };

  // seletor de categorias do grupo: realce visual + atalhos Todas/Nenhuma
  const syncCatItem = (box) => box.closest(".cat-pick-item")?.classList.toggle("on", box.checked);
  catBoxes().forEach(box => { box.onchange = () => { syncCatItem(box); updateCatCount(); }; });
  $c.querySelector("#cats-all").onclick = () => { catBoxes().forEach(b => { b.checked = true; syncCatItem(b); }); updateCatCount(); };
  $c.querySelector("#cats-none").onclick = () => { catBoxes().forEach(b => { b.checked = false; syncCatItem(b); }); updateCatCount(); };

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
  } // fim do bloco editable

  document.getElementById("btn-del-group").onclick = async () => {
    if (!confirm(`Apagar o grupo «${group.name}» e TODAS as despesas? Não há volta atrás.`)) return;
    // as faturas saem antes: apagado o grupo, já não há despesa que dê
    // licença para mexer nelas (num grupo em histórico o servidor não deixa
    // e ficam no bucket)
    const faturas = ctx.expenses.map(x => x.receipt_path).filter(Boolean);
    if (faturas.length) {
      const { error: fErr } = await sb.storage.from(RECEIPT_BUCKET).remove(faturas);
      if (fErr) console.warn("faturas:", fErr.message);
    }
    const { error } = await sb.from("groups").delete().eq("id", group.id);
    if (error) return toast(error.message, true);
    toast("Grupo apagado");
    location.hash = "#/";
  };
}

// ---------------------------------------------------------------- arranque

// Garante o perfil no schema splitwisely (RPC ensure_profile — não há
// trigger em auth.users porque o projeto Supabase é partilhado por
// várias apps; quem foi convidado por email entra já aprovado). É a única
// coisa que a 1.ª vista precisa de saber do servidor antes de desenhar
// (o canUse() decide entre a app e o ecrã «à espera de aprovação»).
async function initProfile() {
  const { data, error } = await sb.rpc("ensure_profile");
  if (error) {
    console.error(error);
    toast(error.message, true);
    profile = null;
    return;
  }
  profile = data;
}

// Tarefas de arranque que NÃO são precisas para desenhar a 1.ª vista:
// ligar aos grupos os convites feitos por email (claim_memberships) e
// materializar as despesas recorrentes em atraso (generate_due_recurring).
// Corriam em série dentro do initProfile(), antes de qualquer render — duas
// idas ao servidor a segurar o arranque, sendo que a segunda percorre mês a
// mês todos os moldes ativos em cada abertura da app. Agora correm depois de
// a 1.ª vista já estar no ecrã e, se mexeram mesmo em dados, a vista é
// redesenhada por cima. O cálculo é exatamente o mesmo — muda só o momento
// em que estes dados entram (e no caso normal, sem nada por ligar nem por
// gerar, não muda nada de todo).
let choresRun = false;
async function runStartupChores() {
  if (choresRun || !canUse()) return;
  choresRun = true;
  let changed = false;

  // correm fora do caminho crítico e ninguém espera por elas: se falharem
  // (rede em baixo, schema antigo) ficam para a próxima abertura, em silêncio
  try {
    const { data: n } = await sb.rpc("claim_memberships");
    if (n > 0) {
      changed = true;
      toast(`Foste ligado a ${n} grupo${n === 1 ? "" : "s"} onde te tinham convidado 🎉`);
    }
  } catch (e) { console.warn("claim_memberships:", e); }

  // depois do claim (e não em paralelo): um grupo acabado de ligar à conta
  // também tem moldes recorrentes em atraso para gerar
  try {
    const { data: gen } = await sb.rpc("generate_due_recurring");
    if (gen > 0) {
      changed = true;
      toast(`${gen} despesa${gen === 1 ? "" : "s"} recorrente${gen === 1 ? "" : "s"} lançada${gen === 1 ? "" : "s"} 🔁`);
    }
  } catch (e) { console.warn("generate_due_recurring:", e); }

  // só redesenha se houve mesmo dados novos — e nunca por cima de um pop-up
  // aberto (o aviso já foi dado; entra na próxima navegação)
  if (changed && !$modal) refresh();

  pushSugerirAtivacao();
}

// Versão nova detetada pelo service worker (ver sw.js): a cache já ficou
// atualizada, falta trocar o código que está a correr. Recarrega quando não
// há nada aberto por gravar; caso contrário avisa e entra ao reabrir.
let updateSeen = false;
function watchForUpdates() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type !== "update-ready" || updateSeen) return;
    updateSeen = true;
    if ($modal) { toast("Há uma versão nova — entra quando reabrires a app"); return; }
    toast("A atualizar para a versão nova…");
    setTimeout(() => location.reload(), 1200);
  });
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
      await route();
      runStartupChores();
    } else if (event === "SIGNED_OUT") {
      profile = null;
      choresRun = false;
      route();
    }
  });

  if (session) await initProfile();

  window.addEventListener("hashchange", route);
  watchForUpdates();
  // as tarefas de arranque só depois de a 1.ª vista estar desenhada
  await route();
  runStartupChores();
}

main();
