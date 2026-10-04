// supabase/functions/despesa-ia/index.ts
// SplitWisely — Lê uma despesa descrita por palavras (e, se vier, a fotografia
// do talão) com o Gemini e devolve-a em JSON, pronta para a app mostrar no
// ecrã de confirmação. Nada é gravado aqui: quem grava é sempre a app, depois
// de a pessoa ver (e, se quiser, corrigir) o que a IA percebeu.
//
// Dois modos:
//   'despesa'  dentro de um grupo: a app manda os nomes dos membros e a IA
//              diz quem pagou, por quem se divide e quanto.
//   'grupo'    a partir da página inicial: uma despesa solta que cria o grupo
//              (nome + pessoas) — ou, se o texto o disser claramente, que vai
//              para um dos grupos que a pessoa já tem.
//
// Correção («re-prompt»): com `anterior` (a resposta anterior, já em JSON) e
// `correcao` (o que a pessoa quer mudar), a IA parte da resposta anterior e só
// mexe no que a correção pede. Sem eles, é uma leitura de raiz.
//
// As PESSOAS identificam-se sempre pelo NOME (nunca por ids): a app faz a
// correspondência com os membros, e um nome que não bata com nenhum passa a
// membro novo no ecrã de confirmação.
//
// Chamada pelo browser com o JWT do utilizador (verify_jwt LIGADO no deploy —
// é o gateway que valida). Por cima disso confirma-se que a conta está
// aprovada na SplitWisely (mesma regra da app).
//
// Cada chamada fica registada em `ia_uso.registos` (schema partilhado pelas
// apps do projeto que chamam o Gemini), com tokens, duração e custo estimado
// pela tabela `ia_uso.precos`. Um registo que falhe nunca deita a resposta
// abaixo.
//
// Secrets necessários (Edge Functions -> Secrets):
//   GEMINI_API_KEY   chave do Google AI Studio (já partilhada pelas outras apps)
//   GEMINI_MODEL     (opcional) fixa o modelo preferido
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.)
//
// Deploy: supabase functions deploy despesa-ia

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
const FUNCAO = "despesa-ia";
// abaixo dos ~60s a que o Safari/iOS corta o pedido sem dizer porquê
const TIMEOUT_MS = 45_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Aliases que a Google mantém a apontar para o flash atual. O primeiro que
// responda serve; um 404 (reformado) ou uma sobrecarga passa ao seguinte.
function candidatosModelo(): string[] {
  const pin = Deno.env.get("GEMINI_MODEL");
  const lista = [pin, "gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"]
    .filter((m): m is string => !!m);
  return [...new Set(lista)];
}

// ---------------------------------------------------------------- utilitários
const limpa = (s: unknown, max: number) =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const listaTextos = (raw: unknown, maxN: number, maxLen: number): string[] =>
  (Array.isArray(raw) ? raw : [])
    .map((x) => limpa(x, maxLen))
    .filter(Boolean)
    .slice(0, maxN);

type Cat = { id: string; label: string };
function lerCategorias(raw: unknown): Cat[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((c) => c && typeof c.id === "string" && c.id.trim())
    .slice(0, 80)
    .map((c) => ({ id: limpa(c.id, 30), label: limpa(c.label, 40) }));
}
type GrupoExistente = { id: string; nome: string; membros: string[] };
function lerGrupos(raw: unknown): GrupoExistente[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((g) => g && typeof g.id === "string")
    .slice(0, 30)
    .map((g) => ({ id: limpa(g.id, 10), nome: limpa(g.nome, 60), membros: listaTextos(g.membros, 40, 60) }));
}

// ---------------------------------------------------------------- prompt
const FORMA = (modo: string) => `{${modo === "grupo" ? `
 "grupo": {"existente": string|null, "nome": string|null},
 "pessoas": [string],` : ""}
 "descricao": string,
 "valor": number|null,
 "data": "YYYY-MM-DD"|null,
 "hora": "HH:MM"|null,
 "categoria": string|null,
 "pagamento": "alguem"|"cada_um",
 "pagadores": [{"nome": string, "valor": number|null}],
 "divisao": "normal"|"iguais"|"valores",
 "participantes": [{"nome": string, "valor": number|null}],
 "duvidas": [string]
}`;

function montarPrompt(p: {
  modo: string; texto: string; hoje: string; hora: string; eu: string; moeda: string;
  cats: Cat[]; membros: string[]; divisaoNormal: string; grupoNome: string;
  grupos: GrupoExistente[]; conhecidos: string[]; temImagem: boolean;
  anterior: unknown; correcao: string;
}): string {
  const grupoModo = p.modo === "grupo";
  const pessoasRegra = grupoModo
    ? `- "pessoas": TODAS as pessoas envolvidas na despesa (quem pagou e quem
  entra na divisão), incluindo quem está a escrever (refere-te a essa pessoa
  como "${p.eu}"). Se o texto disser só "nós os 4" sem nomes, inventa nomes
  provisórios "Pessoa 2", "Pessoa 3", … e diz isso em "duvidas".
- Os nomes em "pagadores" e "participantes" têm de ser EXATAMENTE nomes de
  "pessoas".${p.conhecidos.length ? `
- Pessoas que quem escreve já conhece (de outros grupos). Se o texto se
  referir a uma delas (mesmo só pelo primeiro nome ou por um diminutivo
  óbvio), usa o nome EXATAMENTE como está aqui:
${p.conhecidos.map((n) => `  · ${n}`).join("\n")}` : ""}
- "grupo": a despesa vai para um grupo. Se o texto disser claramente que é
  de um destes grupos que já existem, põe em "existente" o id dele (ex.:
  "g2"), "nome" null, e usa em "pessoas" os nomes EXATAMENTE como estão nos
  membros desse grupo (podes acrescentar pessoas que não estejam lá):
${p.grupos.length ? p.grupos.map((g) => `  · ${g.id} — ${g.nome}${g.membros.length ? ` (membros: ${g.membros.join(", ")})` : ""}`).join("\n") : "  (nenhum)"}
  Caso contrário "existente" é null e "nome" é um nome curto e simpático para
  um grupo novo, a partir do contexto (ex.: "Jantar Sushi Porto",
  "Fim de semana Gerês"). Nunca uses um grupo existente só por palpite.`
    : `- As pessoas deste grupo ("${p.grupoNome}") são EXATAMENTE estas (quem
  está a escrever é "${p.eu}"):
${p.membros.map((n) => `  · ${n}`).join("\n")}
  Usa SEMPRE estes nomes tal e qual (resolve primeiros nomes, diminutivos e
  "eu"/"paguei" para o nome certo). Se o texto falar de alguém que não está
  na lista, usa o nome como vier escrito e diz isso em "duvidas".`;

  const base = `És o assistente da app SplitWisely (despesas partilhadas, Portugal).
Quem escreve é "${p.eu}". Hoje é ${p.hoje}${p.hora ? `, ${p.hora}` : ""}. Moeda: ${p.moeda}.
${p.temImagem ? "Vem também uma imagem/PDF (talão, fatura, print): usa-a para o valor, a data, a hora e a descrição (nome da loja/restaurante), e o texto para quem pagou e como se divide.\n" : ""}
Lê a despesa e devolve APENAS um objeto JSON com esta forma exata:
${FORMA(p.modo)}

Regras:
${pessoasRegra}
- "descricao": curta e clara, em português, como se escreveria na app
  (ex.: "Jantar no Sushi Lab", "Gasolina", "Supermercado Continente").
- "valor": o total da despesa em ${p.moeda} (número, ponto decimal). Se o
  texto der valores por pessoa ("10 € cada, éramos 4"), soma. null se não
  houver forma de saber.
- "data": a data da despesa. "ontem", "sábado passado", "dia 3" resolvem-se
  a partir de hoje (${p.hoje}). null se não se disser nada (a app usa hoje).
- "hora": só se for dita ou estiver no talão; senão null.
- "categoria": EXATAMENTE um destes ids, ou null se nenhum encaixar:
${p.cats.map((c) => `  · ${c.id} — ${c.label}`).join("\n")}
- "pagamento": "alguem" quando uma ou mais pessoas pagaram por todos;
  "cada_um" quando cada um pagou a sua parte (não há nada a acertar).
- "pagadores": quem pagou e quanto. Uma pessoa só → valor = o total (ou
  null). Várias → o valor de cada uma, se se souber; null nos que não se
  souber (a app reparte o resto em partes iguais). Em "cada_um", [].
  Se não se disser quem pagou, assume "${p.eu}".
- "divisao": "normal" quando não se diz nada de especial sobre a divisão
  (a app aplica a divisão habitual${grupoModo ? "" : ` do grupo: ${p.divisaoNormal}`});
  "iguais" quando se diz que é em partes iguais entre certas pessoas;
  "valores" quando há valores concretos por pessoa ("eu 20, o João 30").
- "participantes": quem entra na divisão. Em "normal"${grupoModo ? "" : " com o grupo todo"}
  podes listar ${grupoModo ? "todas as pessoas" : "todos os membros, ou [] para o grupo inteiro"}.
  Se alguém fica de fora ("menos a Ana", "a Rita não comeu"), não o
  incluas e usa "iguais". Em "valores", põe o valor de cada um (têm de
  somar o total); nos outros modos valor = null.
- "duvidas": frases curtas (máx. 3) sobre o que ficou por perceber ou o que
  assumiste sem certeza. [] se estiver tudo claro.
- Não inventes valores: na dúvida, null e uma linha em "duvidas".
Responde só com o JSON.`;

  if (p.anterior && p.correcao) {
    return `${base}

Texto original de quem escreve:
"""${p.texto || "(sem texto — só a imagem)"}"""

Já tinhas respondido isto:
${JSON.stringify(p.anterior)}

A pessoa pede esta correção:
"""${p.correcao}"""

Devolve a resposta COMPLETA corrigida: aplica a correção e mantém tudo o resto
como estava na resposta anterior.`;
  }
  return `${base}

Texto de quem escreve:
"""${p.texto || "(sem texto — lê tudo da imagem)"}"""`;
}

// ---------------------------------------------------------------- acesso
async function quemChama(auth: string): Promise<{ uid: string | null; email: string | null }> {
  const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_SRV, Authorization: auth } });
  if (!u.ok) return { uid: null, email: null };
  const j = await u.json();
  return { uid: j?.id ?? null, email: (j?.email ?? "").toLowerCase() || null };
}
async function podeUsar(uid: string): Promise<boolean> {
  const r = await fetch(
    `${SB_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=is_approved,is_admin`,
    { headers: { apikey: SB_SRV, Authorization: `Bearer ${SB_SRV}`, "Accept-Profile": "splitwisely" } },
  );
  if (!r.ok) return false;
  const p = (await r.json())?.[0];
  return !!(p && (p.is_approved || p.is_admin));
}

// ---------------------------------------------------------------- registo
const iaHeaders = {
  apikey: SB_SRV, Authorization: `Bearer ${SB_SRV}`,
  "Accept-Profile": "ia_uso", "Content-Profile": "ia_uso",
  "Content-Type": "application/json",
};
type Usage = { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };

// Custo pela tabela ia_uso.precos (linha do modelo, ou a de recurso "*").
async function custoEstimado(modelo: string | null, u: Usage | null): Promise<number | null> {
  if (!modelo || !u) return null;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/precos?modelo=in.(${encodeURIComponent(`"${modelo}","*"`)})&select=*`,
      { headers: iaHeaders },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const p = rows.find((x: any) => x.modelo === modelo) ?? rows.find((x: any) => x.modelo === "*");
    if (!p) return null;
    const ent = (u.promptTokenCount ?? 0) * Number(p.eur_entrada_1m);
    const sai = (u.candidatesTokenCount ?? 0) * Number(p.eur_saida_1m);
    const pen = (u.thoughtsTokenCount ?? 0) * Number(p.eur_pensamento_1m ?? p.eur_saida_1m);
    return Math.round(((ent + sai + pen) / 1_000_000) * 1e6) / 1e6;
  } catch (_) {
    return null;
  }
}

async function registarIaUso(
  estado: "ok" | "erro", quem: string | null, modelo: string | null, ms: number,
  detalhe: Record<string, unknown>, usage: Usage | null = null, erro: string | null = null,
): Promise<void> {
  try {
    const custo = await custoEstimado(modelo, usage);
    await fetch(`${SB_URL}/rest/v1/registos`, {
      method: "POST",
      headers: { ...iaHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({
        app: "splitwisely", funcao: FUNCAO, estado, modelo,
        pesquisa_web: false,
        tokens_entrada: usage?.promptTokenCount ?? null,
        tokens_saida: usage?.candidatesTokenCount ?? null,
        tokens_pensamento: usage?.thoughtsTokenCount ?? null,
        tokens_total: usage?.totalTokenCount ?? null,
        custo_estimado_eur: custo,
        duracao_ms: ms,
        quem,
        erro: erro ? erro.slice(0, 500) : null,
        detalhe: { ...detalhe, ms, ...(usage ? { usageMetadata: usage } : {}), custo_estimado_eur: custo },
      }),
    });
  } catch (_) {
    // nunca deita a resposta abaixo
  }
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  const inicio = Date.now();
  let quem: string | null = null;
  let detalhe: Record<string, unknown> = {};
  let modelo: string | null = null;

  try {
    const { uid, email } = await quemChama(req.headers.get("Authorization") ?? "");
    quem = email;
    if (!uid || !(await podeUsar(uid))) return json({ error: "não autorizado" }, 403);

    const b = await req.json();
    const modo = b.modo === "grupo" ? "grupo" : "despesa";
    const texto = String(b.texto ?? "").trim().slice(0, 2000);
    const image = typeof b.image === "string" && b.image ? b.image : null;
    if (image && image.length > 8_000_000) return json({ error: "a imagem é demasiado grande" }, 400);
    if (!texto && !image) return json({ error: "escreve a despesa ou junta uma imagem" }, 400);
    const anterior = b.anterior && typeof b.anterior === "object" ? b.anterior : null;
    const correcao = limpa(b.correcao, 600);
    const cats = lerCategorias(b.categorias);
    const membros = listaTextos(b.membros, 60, 60);
    if (modo === "despesa" && !membros.length) return json({ error: "o grupo não tem membros" }, 400);

    const prompt = montarPrompt({
      modo, texto,
      hoje: /^\d{4}-\d{2}-\d{2}$/.test(b.hoje) ? b.hoje : new Date().toISOString().slice(0, 10),
      hora: /^\d{2}:\d{2}$/.test(b.hora ?? "") ? b.hora : "",
      eu: limpa(b.eu, 60) || "Eu",
      moeda: limpa(b.moeda, 5) || "EUR",
      cats, membros,
      divisaoNormal: b.divisao_normal === "proporcao" ? "por proporções (pesos de cada membro)" : "partes iguais por todos",
      grupoNome: limpa(b.grupo_nome, 60),
      grupos: lerGrupos(b.grupos),
      conhecidos: listaTextos(b.conhecidos, 80, 60),
      temImagem: !!image,
      anterior, correcao,
    });
    detalhe = {
      modo, correcao: !!(anterior && correcao), imagem: !!image,
      ...(image ? { mime: limpa(b.mime, 40) } : {}),
      chars_texto: texto.length, membros: membros.length,
    };

    const parts: unknown[] = [];
    if (image) parts.push({ inline_data: { mime_type: limpa(b.mime, 40) || "image/jpeg", data: image } });
    parts.push({ text: prompt });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const chamar = (m: string, semThinking: boolean) => {
      const generationConfig: Record<string, unknown> = { response_mime_type: "application/json", temperature: 0 };
      // o thinking dos 2.5 custa segundos e tokens; aqui não é preciso
      if (semThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      return fetch(`${GAPI}/models/${m}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ contents: [{ parts }], generationConfig }),
      });
    };
    const transitorio = (s: number) => s === 429 || s === 500 || s === 503;

    let g: Response | null = null;
    const tentativas: string[] = [];
    for (const m of candidatosModelo()) {
      if (ctrl.signal.aborted) break;
      modelo = m;
      g = await chamar(m, true);
      // vários modelos recusam o thinkingBudget:0 com um 400 genérico
      if (g.status === 400) g = await chamar(m, false);
      if (transitorio(g.status)) {
        await new Promise((r) => setTimeout(r, 700));
        g = await chamar(m, false);
      }
      tentativas.push(`${m}:${g.status}`);
      if (g.ok) break;
      if (g.status !== 404 && !transitorio(g.status)) break; // erro definitivo
    }
    clearTimeout(timer);
    detalhe.tentativas = tentativas;

    if (!g || !g.ok) {
      const status = g?.status ?? 502;
      let msg = "";
      try { msg = (await g?.json())?.error?.message ?? ""; } catch (_) { /**/ }
      await registarIaUso("erro", quem, modelo, Date.now() - inicio, detalhe, null, msg || `HTTP ${status}`);
      if (transitorio(status)) {
        return json({ error: "a IA está com muita procura agora — espera um minuto e tenta outra vez" }, 503);
      }
      return json({ error: `a IA não respondeu (${status})${msg ? ": " + msg.slice(0, 160) : ""}` }, 502);
    }

    const gd = await g.json();
    const usage: Usage | null = gd?.usageMetadata ?? null;
    const cand = gd?.candidates?.[0];
    const motivo = String(cand?.finishReason ?? "");
    const text = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
    if (!text) {
      const erro = `o modelo não devolveu resposta (${motivo || "vazia"})`;
      await registarIaUso("erro", quem, modelo, Date.now() - inicio, { ...detalhe, finishReason: motivo || null }, usage, erro);
      return json({ error: `${erro} — tenta outra vez` }, 502);
    }
    let parsed: any;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch (_) {
      await registarIaUso("erro", quem, modelo, Date.now() - inicio, { ...detalhe, finishReason: motivo || null }, usage, "resposta ilegível do modelo");
      return json({ error: "a resposta da IA veio ilegível — tenta outra vez" }, 502);
    }
    if (Array.isArray(parsed)) parsed = parsed[0] ?? {};

    await registarIaUso("ok", quem, modelo, Date.now() - inicio, {
      ...detalhe,
      valor: typeof parsed?.valor === "number" ? parsed.valor : null,
      duvidas: Array.isArray(parsed?.duvidas) ? parsed.duvidas.length : 0,
    }, usage);
    return json({ resultado: parsed, modelo });
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      await registarIaUso("erro", quem, modelo, Date.now() - inicio, { ...detalhe, passo: "timeout" }, null, "timeout");
      return json({ error: "a IA demorou demasiado — tenta outra vez (ou com uma foto mais leve)" }, 504);
    }
    await registarIaUso("erro", quem, modelo, Date.now() - inicio, { ...detalhe, passo: "excecao" }, null, err.message);
    return json({ error: err.message }, 500);
  }
});
