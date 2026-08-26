// supabase/functions/push-notificar-splitwisely/index.ts
// SplitWisely — Envia notificações Web Push (Notification/Push API).
//
// CHAMA-SE "push-notificar-splitwisely", NÃO "push-notificar": o nome da
// function é único por PROJETO Supabase, e outra app do mesmo projeto
// (SplitBill) já usa "push-notificar"; o FestasBV, pela mesma razão, usa
// "push-notificar-festasbv".
//
// Por agora só um tipo, chamado depois de gravar uma despesa NOVA
// (app.js, notifyExpenseAdded — nunca ao editar, nem nas ocorrências que
// as despesas recorrentes geram sozinhas ao arrancar):
//
//   'despesa_adicionada'  avisa quem foi AFETADO pela despesa e não foi
//                         quem a lançou — pagou alguma coisa ou ficou a
//                         dever alguma coisa. Um payload por pessoa
//                         (`pessoas`), porque o texto muda consoante o
//                         destinatário está ou não incluído na divisão
//                         (`isOwer`) e quantas pessoas são ao todo.
//
// O TEXTO ESCOLHE-SE SEMPRE AQUI (por `tipo`), nunca vem livre do
// cliente — só os nomes/valores são interpolados. O cliente manda os
// NOMES já resolvidos (payerNames, outrosNomes) porque só ele tem acesso
// aos membros do grupo; o servidor só monta a frase.
//
// Segurança: confirma-se que quem chama tem sessão válida e que TODOS os
// alvos (`pessoas[].user_id`) são membros do MESMO grupo (`group_id`) a
// que quem chama também tem acesso — impede mandar um push arbitrário
// para uma conta fora do grupo.
//
// Secrets necessários (Edge Functions -> Secrets):
//   VAPID_PUBLIC_KEY   par de chaves só para Web Push (não é a chave do
//   VAPID_PRIVATE_KEY  Supabase). Partilhado com as outras apps do MESMO
//                      projeto (FestasBV, SplitBill) — se já estiverem
//                      definidos, não é preciso repeti-los. O
//                      VAPID_PUBLIC_KEY do app.js tem de ser exatamente o
//                      mesmo valor.
//   VAPID_SUBJECT      (opcional) "mailto:..."; sem ele usa um valor por omissão
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.)
//
// Deploy: supabase functions deploy push-notificar-splitwisely

import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@splitwisely.app";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const sbHeaders = {
  apikey: SB_SRV,
  Authorization: `Bearer ${SB_SRV}`,
  "Content-Profile": "splitwisely",
  "Accept-Profile": "splitwisely",
  "Content-Type": "application/json",
};

type Sub = { endpoint: string; user_id: string; p256dh: string; auth_key: string };

async function userIdDoToken(auth: string): Promise<string | null> {
  const u = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SRV, Authorization: auth },
  });
  if (!u.ok) return null;
  const j = await u.json();
  return j?.id ?? null;
}

async function podeUsar(uid: string): Promise<boolean> {
  const r = await fetch(
    `${SB_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=is_approved,is_admin`,
    { headers: sbHeaders },
  );
  if (!r.ok) return false;
  const rows = await r.json();
  const p = rows?.[0];
  return !!(p && (p.is_approved || p.is_admin));
}

// Tem acesso ao grupo: criou-o, ou é membro ligado (user_id na linha).
async function temAcessoAoGrupo(uid: string, groupId: string): Promise<boolean> {
  const [gR, mR] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/groups?id=eq.${encodeURIComponent(groupId)}&select=created_by`, { headers: sbHeaders }),
    fetch(
      `${SB_URL}/rest/v1/group_members?group_id=eq.${encodeURIComponent(groupId)}&user_id=eq.${encodeURIComponent(uid)}&select=id&limit=1`,
      { headers: sbHeaders },
    ),
  ]);
  const gRows = gR.ok ? await gR.json() : [];
  if (gRows?.[0]?.created_by === uid) return true;
  const mRows = mR.ok ? await mR.json() : [];
  return Array.isArray(mRows) && mRows.length > 0;
}

// Quais dos user_ids pedidos são MESMO membros ligados deste grupo — a
// trava a sério contra mandar um push para uma conta fora do grupo.
async function membrosDoGrupo(groupId: string, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const orList = userIds.map((u) => `"${u}"`).join(",");
  const r = await fetch(
    `${SB_URL}/rest/v1/group_members?group_id=eq.${encodeURIComponent(groupId)}&user_id=in.(${orList})&select=user_id`,
    { headers: sbHeaders },
  );
  const rows: { user_id: string }[] = r.ok ? await r.json() : [];
  return new Set(rows.map((x) => x.user_id));
}

async function subscriptionsDe(userIds: string[]): Promise<Sub[]> {
  if (!userIds.length) return [];
  const orList = userIds.map((u) => `"${u}"`).join(",");
  const r = await fetch(
    `${SB_URL}/rest/v1/push_subscriptions?user_id=in.(${orList})&select=endpoint,user_id,p256dh,auth_key`,
    { headers: sbHeaders },
  );
  return r.ok ? await r.json() : [];
}

async function apagarSubsMortas(endpoints: string[]) {
  if (!endpoints.length) return;
  const orMortos = endpoints.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",");
  await fetch(`${SB_URL}/rest/v1/push_subscriptions?endpoint=in.(${orMortos})`, {
    method: "DELETE",
    headers: sbHeaders,
  }).catch(() => {});
}

async function enviarParaSubs(subs: Sub[], payload: string) {
  let enviados = 0;
  let falhados = 0;
  const mortos: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload,
        );
        enviados++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) mortos.push(s.endpoint);
        falhados++;
      }
    }),
  );
  await apagarSubsMortas(mortos);
  return { enviados, falhados };
}

function eurTxt(v: number, moeda = "EUR") {
  try {
    return new Intl.NumberFormat("pt-PT", { style: "currency", currency: moeda }).format(v);
  } catch (_) {
    return `${v.toFixed(2)} ${moeda}`;
  }
}

function joinNames(names: string[]): string {
  const ns = names.filter(Boolean);
  if (ns.length === 0) return "";
  if (ns.length === 1) return ns[0];
  return ns.slice(0, -1).join(", ") + " e " + ns[ns.length - 1];
}

// "António" / "António e João" / "3 pessoas" — nomear até 3 pagadores,
// senão o número (uma frase com seis nomes deixa de se ler de relance).
function payersPhrase(names: string[]): { texto: string; plural: boolean } {
  const ns = names.filter(Boolean);
  if (ns.length <= 3) return { texto: joinNames(ns), plural: ns.length > 1 };
  return { texto: `${ns.length} pessoas`, plural: true };
}

// A pergunta "por quantos se divide" só se responde quando acrescenta
// algo ao que já se disse:
//   2 pessoas   -> nada (o próprio "X pagou Y a Z" já implica os dois)
//   3 pessoas   -> nomeia as outras (cabe, e é mais claro que um número)
//   4 ou mais   -> só o número, com "(estás incluído)" quando for caso disso
function splitClause(totalPessoas: number, isOwer: boolean, outrosNomes: string[]): string {
  if (!totalPessoas || totalPessoas <= 2) return "";
  if (totalPessoas === 3) {
    const nomes = joinNames(outrosNomes);
    return nomes ? ` a dividir com ${nomes}` : ` a dividir por 3${isOwer ? " (estás incluído)" : ""}`;
  }
  return isOwer ? ` a dividir por ${totalPessoas} (estás incluído)` : ` a dividir por ${totalPessoas} pessoas`;
}

type PessoaDespesa = { user_id: string; isOwer?: boolean; outrosNomes?: string[] };

function montarMensagemDespesa(
  payerNames: string[],
  valor: number,
  moeda: string,
  descricao: string,
  totalPessoas: number,
  p: PessoaDespesa,
) {
  const payers = payersPhrase(payerNames);
  const verbo = payers.plural ? "pagaram" : "pagou";
  const clause = splitClause(totalPessoas, !!p.isOwer, p.outrosNomes || []);
  return {
    title: "💸 Nova despesa",
    body: `${payers.texto} ${verbo} ${eurTxt(valor, moeda)} em ${descricao}${clause}.`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    const uid = await userIdDoToken(auth);
    if (!uid) return json({ error: "não autorizado" }, 403);
    if (!(await podeUsar(uid))) return json({ error: "não autorizado" }, 403);

    const {
      tipo, group_id, descricao, valor, moeda, payerNames, totalPessoas, pessoas,
    } = (await req.json()) as {
      tipo?: string;
      group_id?: string;
      descricao?: string;
      valor?: number;
      moeda?: string;
      payerNames?: string[];
      totalPessoas?: number;
      pessoas?: PessoaDespesa[];
    };

    if (tipo !== "despesa_adicionada") return json({ error: "tipo inválido" }, 400);
    if (!group_id) return json({ error: "group_id em falta" }, 400);
    if (!(await temAcessoAoGrupo(uid, group_id))) return json({ error: "sem acesso a este grupo" }, 403);

    const lista = Array.isArray(pessoas) ? pessoas : [];
    if (lista.length === 0) return json({ enviados: 0, falhados: 0 });

    // trava a sério: só se manda para quem É MESMO membro ligado deste
    // grupo — o cliente já filtra, mas o servidor não confia nele às cegas
    const validos = await membrosDoGrupo(group_id, [...new Set(lista.map((p) => p.user_id))]);
    const alvos = lista.filter((p) => validos.has(p.user_id));
    if (alvos.length === 0) return json({ enviados: 0, falhados: 0 });

    const subs = await subscriptionsDe([...new Set(alvos.map((p) => p.user_id))]);

    let enviados = 0;
    let falhados = 0;
    await Promise.all(
      alvos.map(async (p) => {
        const minhas = subs.filter((s) => s.user_id === p.user_id);
        if (!minhas.length) return;
        const payload = JSON.stringify({
          ...montarMensagemDespesa(payerNames || [], valor || 0, moeda || "EUR", descricao || "", totalPessoas || 0, p),
          // relativo ao scope do service worker (sw.js resolve com `new
          // URL(url, self.registration.scope)`) — a app pode viver num
          // subcaminho do GitHub Pages, e "/" saltava para a raiz do domínio
          url: "./",
        });
        const r = await enviarParaSubs(minhas, payload);
        enviados += r.enviados;
        falhados += r.falhados;
      }),
    );

    return json({ enviados, falhados });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
