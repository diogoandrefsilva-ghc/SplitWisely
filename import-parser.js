/* SplitWisely — parser de movimentos em texto corrido
   ====================================================================
   Transforma um bloco de texto colado (bloco de notas, Excel, WhatsApp)
   numa lista de movimentos {data, descrição, valor}. Sem IA: regras, com
   inferência do "dialeto" do bloco todo — porque a consistência entre
   linhas é o sinal mais forte que existe para desfazer ambiguidades.

   Ambiguidades que isto tem de resolver:
     "/"  é separador de campos E de datas   -> 25/09/2026 / Continente / 45,30
     ","  é separador de campos E decimal    -> 25-09; Jantar; 12,50
     "."  é decimal, agrupador de milhares E separador de datas

   Ordem de operações (o truque central): nunca se parte a linha crua.
   Primeiro mascara-se a data, depois o valor — as duas coisas com forma
   reconhecível —, e só o que sobra é partido por campos. Assim o "/" de
   dentro de uma data e a "," de dentro de um valor nunca chegam ao split.

   Este ficheiro é uma função pura: não toca em DOM nem em Supabase, para
   poder ser testado à parte (ver tests/parser-tests.js, corre em Node).
   ==================================================================== */
"use strict";

(function (raiz, definir) {
  const api = definir();
  if (typeof module === "object" && module.exports) module.exports = api;
  else raiz.SWImport = api;
})(typeof self !== "undefined" ? self : this, function () {

  // ---------------------------------------------------------------- texto

  const semAcentos = (s) => String(s == null ? "" : s).toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");

  // marcas que substituem a data e o valor depois de encontrados. Não têm
  // dígitos nem letras, por isso não confundem nada do que vem a seguir.
  const M_DATA = "";
  const M_VALOR = "";

  const LETRA = "a-zA-Z\\u00c0-\\u024f";
  const RE_LETRA = new RegExp("[" + LETRA + "]");

  // Uma linha do bloco, já lavada do que é decoração: espaços especiais
  // colados do Excel/web, travessões tipográficos e marcas de lista.
  function limparLinha(s) {
    return String(s == null ? "" : s)
      .replace(/[   ]/g, " ")   // espaços inquebráveis/finos
      .replace(/[‐-―]/g, "-")        // travessões
      .replace(/[‘’“”]/g, "'")
      .replace(/^\s*[-*+•·>]\s+/, "")          // marcas de lista
      .replace(/^\s*\d{1,2}[.)]\s+/, "")       // lista numerada: "1. ", "2) "
      .trim();
  }

  // ---------------------------------------------------------------- datas

  const MESES = {
    jan: 1, janeiro: 1, january: 1,
    fev: 2, fevereiro: 2, feb: 2, february: 2,
    mar: 3, marco: 3, march: 3,
    abr: 4, abril: 4, apr: 4, april: 4,
    mai: 5, maio: 5, may: 5,
    jun: 6, junho: 6, june: 6,
    jul: 7, julho: 7, july: 7,
    ago: 8, agosto: 8, aug: 8, august: 8,
    set: 9, setembro: 9, sep: 9, sept: 9, september: 9,
    out: 10, outubro: 10, oct: 10, october: 10,
    nov: 11, novembro: 11, november: 11,
    dez: 12, dezembro: 12, dec: 12, december: 12,
  };

  // separador entre o dia e o mês-por-nome: "-", "/", ".", espaço ou " de "
  const SEP_NOME = "(?:\\s*[-/.]\\s*|\\s+(?:de\\s+)?)";
  const PALAVRA_MES = "([" + LETRA + "]{3,10})";

  // Por ordem de tentativa: do padrão mais específico para o mais vago, para
  // "25/09/2026" ser apanhado como data completa e não como "25/09" + lixo.
  const PADROES = [
    { tipo: "iso", re: /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g },
    { tipo: "dmy", re: /(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/g },
    { tipo: "nomeY", re: new RegExp("(\\d{1,2})" + SEP_NOME + PALAVRA_MES + "\\.?(" + SEP_NOME + ")(\\d{2,4})", "gi") },
    { tipo: "nome", re: new RegExp("(\\d{1,2})" + SEP_NOME + PALAVRA_MES + "\\.?", "gi") },
    { tipo: "nomeD", re: new RegExp(PALAVRA_MES + "\\.?" + SEP_NOME + "(\\d{1,2})", "gi") },
    { tipo: "dm", re: /(\d{1,2})[-/.](\d{1,2})/g },
    { tipo: "rel", re: /\b(hoje|hj|ontem|anteontem)\b/gi },
  ];

  // A data não pode estar colada a mais dígitos ou letras: em "1.234,56" o
  // "1.23" não é 23 de janeiro, e em "A4.20" não há data nenhuma.
  function fronteiraOk(txt, ini, fim) {
    const antes = ini > 0 ? txt[ini - 1] : "";
    const depois = fim < txt.length ? txt[fim] : "";
    if (antes && (/\d/.test(antes) || RE_LETRA.test(antes))) return false;
    if (depois && (/\d/.test(depois) || RE_LETRA.test(depois))) return false;
    return true;
  }

  const diasNoMes = (a, m) => [31, (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

  // Valida o que se pode validar sem saber ainda a ordem dd/mm do bloco.
  // Devolve os números em bruto; quem decide quem é dia e quem é mês é o
  // montarData(), já com o dialeto na mão.
  function validar(tipo, m) {
    if (tipo === "iso") {
      const ano = +m[1], mes = +m[2], dia = +m[3];
      if (mes < 1 || mes > 12 || dia < 1 || dia > diasNoMes(ano, mes)) return null;
      return { ano: ano, mes: mes, dia: dia };
    }
    if (tipo === "dmy" || tipo === "dm") {
      const a = +m[1], b = +m[2];
      // tem de haver pelo menos uma leitura possível (dd/mm ou mm/dd)
      const podeDM = a >= 1 && a <= 31 && b >= 1 && b <= 12;
      const podeMD = a >= 1 && a <= 12 && b >= 1 && b <= 31;
      if (!podeDM && !podeMD) return null;
      const info = { a: a, b: b, podeDM: podeDM, podeMD: podeMD };
      if (tipo === "dmy") {
        const ano = +m[3];
        info.ano = ano < 100 ? 2000 + ano : ano;
      }
      return info;
    }
    if (tipo === "nomeY" || tipo === "nome" || tipo === "nomeD") {
      const ehD = tipo === "nomeD";
      const dia = +(ehD ? m[2] : m[1]);
      const mes = MESES[semAcentos(ehD ? m[1] : m[2])];
      if (!mes || dia < 1 || dia > 31) return null;
      const info = { dia: dia, mes: mes };
      if (tipo === "nomeY") {
        const ano = +m[4];
        // "25 set 30": um ano de 2 dígitos separado por ESPAÇO é quase
        // sempre o valor da despesa, não o ano. Só conta como ano se vier
        // com separador ("25-set-30") ou se tiver 4 dígitos.
        const sep = m[3] || "";
        if (ano < 100 && !/[-/.]|de/i.test(sep)) return null;
        info.ano = ano < 100 ? 2000 + ano : ano;
      }
      return info;
    }
    if (tipo === "rel") return { rel: semAcentos(m[1]) };
    return null;
  }

  // Primeira data válida da linha, por ordem de especificidade dos padrões.
  function acharData(txt) {
    for (const p of PADROES) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(txt)) !== null) {
        const ini = m.index, fim = ini + m[0].length;
        const info = fronteiraOk(txt, ini, fim) ? validar(p.tipo, m) : null;
        if (!info) { p.re.lastIndex = ini + 1; continue; }
        return Object.assign({ ini: ini, fim: fim, bruto: m[0], tipo: p.tipo }, info);
      }
    }
    return null;
  }

  const iso = (a, m, d) =>
    String(a).padStart(4, "0") + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  const diasEntre = (isoA, isoB) =>
    Math.round((Date.parse(isoA + "T00:00:00Z") - Date.parse(isoB + "T00:00:00Z")) / 86400000);

  function somarDias(isoData, n) {
    const d = new Date(isoData + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Ano em falta. Quem cola isto está a lançar despesas que já fez, por
  // isso o ano corrente só se mantém se não atirar a data para longe no
  // futuro: até um mês à frente passa (uma despesa de amanhã, uma nota
  // escrita adiantada), mais do que isso foi do ano passado ("20-12" lido
  // em setembro é o Natal que passou, não o que vem).
  const FUTURO_OK = 31;
  function inferirAno(dia, mes, hoje) {
    const base = +hoje.slice(0, 4);
    const cabe = (a) => dia <= diasNoMes(a, mes);          // 29-fev não cabe em todos
    if (!cabe(base)) return cabe(base - 1) ? base - 1 : null;
    if (diasEntre(iso(base, mes, dia), hoje) <= FUTURO_OK) return base;
    return cabe(base - 1) ? base - 1 : base;
  }

  // Converte o achado em ISO, já com o dialeto (ordem dd/mm vs mm/dd).
  function montarData(d, ordem, hoje) {
    const avisos = [];
    let ano = d.ano, mes, dia;

    if (d.tipo === "rel") {
      const n = d.rel === "hoje" || d.rel === "hj" ? 0 : d.rel === "ontem" ? -1 : -2;
      return { data: somarDias(hoje, n), avisos: avisos };
    }
    if (d.tipo === "iso") { mes = d.mes; dia = d.dia; }
    else if (d.tipo === "dmy" || d.tipo === "dm") {
      // a ordem do bloco manda, mas só quando a leitura é possível: numa
      // linha "25/09" num bloco mm/dd não há mês 25 — fica dd/mm na mesma
      const usarMD = ordem === "mdy" ? d.podeMD : !d.podeDM;
      dia = usarMD ? d.b : d.a;
      mes = usarMD ? d.a : d.b;
      if (usarMD) avisos.push("lida como mês/dia");
    } else { mes = d.mes; dia = d.dia; }

    if (ano == null) {
      ano = inferirAno(dia, mes, hoje);
      if (ano == null) return { data: null, avisos: ["data inválida"] };
    }
    if (mes < 1 || mes > 12 || dia < 1 || dia > diasNoMes(ano, mes))
      return { data: null, avisos: ["data inválida"] };
    return { data: iso(ano, mes, dia), avisos: avisos };
  }

  // -------------------------------------------------------------- valores

  // Da forma mais específica para a mais simples: "1 234,56", "1.234,56",
  // "1.234", "45,30" e "45". A alternativa com espaço exige casas decimais,
  // senão "Jantar 25 30" virava um número só.
  const RE_VALOR = /\d{1,3}(?: \d{3})+[.,]\d{1,2}|\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+[.,]\d{1,2}|\d+/g;
  const RE_MOEDA_ANTES = /(?:[€$£]|\beur|\beuros?)\s*$/i;
  const RE_MOEDA_DEPOIS = /^\s*(?:[€$£]|eur\b|euros?\b)/i;

  // "1.234,56" -> 123456 cêntimos. `decimal` é o separador decimal do bloco,
  // usado só para decidir o caso genuinamente ambíguo (3 casas exatas).
  function tokenCents(tok, decimal) {
    const t = tok.replace(/ /g, "");
    const temP = t.indexOf(".") >= 0, temV = t.indexOf(",") >= 0;
    let sepDec = null, ambiguo = false;

    if (temP && temV) {
      sepDec = t.lastIndexOf(".") > t.lastIndexOf(",") ? "." : ",";
    } else if (temP || temV) {
      const ch = temP ? "." : ",";
      const partes = t.split(ch);
      const ultima = partes[partes.length - 1].length;
      if (partes.length > 2) sepDec = null;            // 1.234.567 -> milhares
      else if (ultima === 3) {
        sepDec = null;                                 // 1.234 -> milhares
        ambiguo = ch === decimal;                      // ...mas é o decimal do bloco
      } else if (ultima >= 1 && ultima <= 2) sepDec = ch;
      else sepDec = null;
    }

    let limpo;
    if (sepDec) {
      const outro = sepDec === "." ? "," : ".";
      limpo = t.split(outro).join("").replace(sepDec, ".");
    } else {
      limpo = t.replace(/[.,]/g, "");
    }
    const n = Number(limpo);
    if (!isFinite(n)) return null;
    return { cents: Math.round(n * 100), ambiguo: ambiguo };
  }

  // O valor da linha: o número com melhor pontuação. O símbolo da moeda
  // ganha sempre; a seguir vem estar no fim da linha e ter casas decimais.
  function acharValor(txt, decimal) {
    RE_VALOR.lastIndex = 0;
    let m, melhor = null;
    while ((m = RE_VALOR.exec(txt)) !== null) {
      const ini = m.index, fim = ini + m[0].length;
      const antes = txt.slice(0, ini), depois = txt.slice(fim);
      const colado = (antes && RE_LETRA.test(antes[antes.length - 1]))
        || (depois && RE_LETRA.test(depois[0]));
      const moeda = RE_MOEDA_ANTES.test(antes) || RE_MOEDA_DEPOIS.test(depois);
      const v = tokenCents(m[0], decimal);
      if (!v) continue;

      let pontos = 0;
      if (moeda) pontos += 100;
      if (colado && !moeda) pontos -= 50;              // "A4", "2x", "3kg"
      if (/^\s*$/.test(depois)) pontos += 10;          // último da linha
      if (/[.,]\d{1,2}$/.test(m[0])) pontos += 6;      // tem cêntimos
      // empate: fica o mais à direita (o valor costuma vir no fim)
      if (!melhor || pontos >= melhor.pontos) {
        melhor = { ini: ini, fim: fim, bruto: m[0], cents: v.cents, ambiguo: v.ambiguo, moeda: moeda, pontos: pontos };
      }
    }
    return melhor && melhor.cents > 0 ? melhor : null;
  }

  // -------------------------------------------------------------- dialeto

  function mascarar(txt, spans) {
    let out = txt;
    spans.filter(Boolean).sort((a, b) => b.ini - a.ini)
      .forEach(s => { out = out.slice(0, s.ini) + s.marca + out.slice(s.fim); });
    return out;
  }

  // Ordem dd/mm vs mm/dd: procura-se uma PROVA no bloco todo. Um primeiro
  // número > 12 prova dd/mm; um segundo número > 12 prova mm/dd. Sem provas
  // fica dd/mm (estamos em Portugal).
  function farejarOrdem(linhas) {
    let dm = 0, md = 0;
    for (const l of linhas) {
      const d = l.mData;
      if (!d || (d.tipo !== "dmy" && d.tipo !== "dm")) continue;
      if (d.podeDM && !d.podeMD) dm++;
      else if (d.podeMD && !d.podeDM) md++;
    }
    return { ordem: md > 0 && dm === 0 ? "mdy" : "dmy", conflito: md > 0 && dm > 0 };
  }

  // Separador decimal: cada número do bloco vota. Ter os dois separadores é
  // a prova mais forte (o último é o decimal); 1-2 casas vota no que usa;
  // 3 casas exatas é agrupador, logo vota no outro.
  function farejarDecimal(linhas) {
    let pontoVotos = 0, virgulaVotos = 0;
    for (const l of linhas) {
      RE_VALOR.lastIndex = 0;
      let m;
      while ((m = RE_VALOR.exec(l.semData)) !== null) {
        const t = m[0].replace(/ /g, "");
        const temP = t.indexOf(".") >= 0, temV = t.indexOf(",") >= 0;
        if (temP && temV) {
          if (t.lastIndexOf(".") > t.lastIndexOf(",")) pontoVotos += 3; else virgulaVotos += 3;
          continue;
        }
        if (!temP && !temV) continue;
        const ch = temP ? "." : ",";
        const partes = t.split(ch);
        const ultima = partes[partes.length - 1].length;
        if (partes.length === 2 && ultima <= 2) { if (ch === ".") pontoVotos += 2; else virgulaVotos += 2; }
        else if (ultima === 3) { if (ch === ".") virgulaVotos += 1; else pontoVotos += 1; }
      }
    }
    return pontoVotos > virgulaVotos ? "." : ",";
  }

  // Separador de campos, por ordem de preferência. O "/" e a "," só ganham
  // quando aparecem de forma consistente — e já sem datas nem valores pelo
  // meio, que é o que os tornava ambíguos.
  const SEPARADORES = ["\t", ";", "|", "/", ",", "  "];
  const RE_SEP = { "\t": /\t+/, ";": /;/, "|": /\|/, "/": /\//, ",": /,/, "  ": /\s{2,}/ };

  function farejarSep(linhas) {
    const uteis = linhas.filter(l => l.mValor);
    if (!uteis.length) return null;
    for (const s of SEPARADORES) {
      const re = RE_SEP[s];
      const com = uteis.filter(l => re.test(l.resto)).length;
      if (com >= Math.max(1, Math.ceil(uteis.length * 0.6))) return s;
    }
    return null;
  }

  // ------------------------------------------------------------ descrição

  const RE_LIXO_PONTAS = /^[\s\-:;,.|/]+|[\s\-:;,.|/]+$/g;

  function limparDesc(s) {
    return String(s)
      .split(M_DATA).join(" ")
      .split(M_VALOR).join(" ")
      .replace(/[€$£]|\beur\b|\beuros?\b/gi, " ")
      .replace(/\s+/g, " ")
      .replace(RE_LIXO_PONTAS, "")
      .trim();
  }

  // Palavras que, em português, ficam em minúscula no meio de um nome
  // («Café da Avó», não «Café Da Avó»). No princípio da descrição levam
  // maiúscula como qualquer outra.
  const LIGACOES = new Set([
    "de", "da", "do", "das", "dos", "e", "em", "no", "na", "nos", "nas",
    "a", "o", "as", "os", "ao", "aos", "à", "às", "com", "por", "para", "que",
    "um", "uma", "uns", "umas",
  ]);

  /* Descritivo aos berros: os extratos do banco vêm todos em maiúsculas
     («CONTINENTE MATOSINHOS»), e na lista de despesas isso salta à vista
     de mais. Nesse caso capitaliza-se.

     Só quando é TUDO maiúsculas, e é essa a regra que interessa: uma única
     minúscula pelo meio quer dizer que quem escreveu escolheu as maiúsculas
     que lá estão («Jantar no SUSHI», «Prenda p/ MARIA») e não se mexe. */
  function capitalizarBerros(s) {
    if (!/\p{Lu}/u.test(s)) return s;   // não há maiúsculas: nada a fazer
    if (/\p{Ll}/u.test(s)) return s;    // há minúsculas: é mistura, respeita-se
    return s.replace(/\p{L}[\p{L}\p{M}'’]*/gu, (palavra, pos) => {
      const min = palavra.toLowerCase();
      if (pos > 0 && LIGACOES.has(min)) return min;
      return min.charAt(0).toUpperCase() + min.slice(1);
    });
  }

  // linhas que são cabeçalhos de total/resumo e não movimentos
  const RE_IGNORAR = /^(total|totais|soma|subtotal|saldo|resumo)\b/i;

  // ----------------------------------------------------------------- API

  /* parseMovimentos(texto, opts)
       opts.hoje     "YYYY-MM-DD" (para testes; por omissão, hoje)
       opts.ordem    "dmy" | "mdy"      — força a ordem das datas
       opts.decimal  "," | "."          — força o separador decimal
       opts.sep      um de SEPARADORES, ou "" para nenhum, ou null/undefined
                                          para deteção automática
     Devolve { dialeto, linhas }. Cada linha traz o que se percebeu dela e,
     sempre, o texto original — é o que deixa o ecrã de confirmação mostrar
     de onde veio cada movimento. */
  function parseMovimentos(texto, opts) {
    const o = opts || {};
    const hoje = o.hoje || new Date().toISOString().slice(0, 10);

    const linhas = String(texto == null ? "" : texto)
      .replace(/\r\n?/g, "\n").split("\n")
      .map((raw, i) => ({ n: i + 1, raw: raw, txt: limparLinha(raw) }))
      .filter(l => l.txt !== "");

    // 1.ª passagem: onde está a data (ainda sem decidir dia vs mês)
    for (const l of linhas) {
      l.mData = acharData(l.txt);
      l.semData = mascarar(l.txt, [l.mData && { ini: l.mData.ini, fim: l.mData.fim, marca: M_DATA }]);
    }

    const ord = farejarOrdem(linhas);
    const ordem = o.ordem || ord.ordem;
    const decimal = o.decimal || farejarDecimal(linhas);

    // 2.ª passagem: o valor, no que sobrou depois de tirar a data
    for (const l of linhas) {
      l.mValor = acharValor(l.semData, decimal);
      // Recuo: "Café 25.09" não tem valor nenhum se lermos "25.09" como
      // data. Uma data em dd.mm sem mais nada na linha é quase sempre um
      // valor — desfaz-se a data e tenta-se outra vez.
      if (!l.mValor && l.mData && l.mData.tipo === "dm" && l.mData.bruto.indexOf(".") >= 0) {
        const v = acharValor(l.txt, decimal);
        if (v) { l.mData = null; l.semData = l.txt; l.mValor = v; }
      }
      l.resto = mascarar(l.semData, [l.mValor && { ini: l.mValor.ini, fim: l.mValor.fim, marca: M_VALOR }]);
    }

    const sep = o.sep === undefined || o.sep === null ? farejarSep(linhas) : (o.sep || null);

    // 3.ª passagem: descrição, estado e avisos
    const out = [];
    let dataContexto = null;
    for (const l of linhas) {
      const campos = sep ? l.resto.split(RE_SEP[sep]) : [l.resto];
      const desc = capitalizarBerros(
        campos.map(limparDesc).filter(Boolean).join(" ").replace(/\s+/g, " ").trim());

      const mov = {
        n: l.n, raw: l.raw, txt: l.txt,
        data: null, desc: desc, cents: l.mValor ? l.mValor.cents : 0,
        estado: "ok", avisos: [], notas: [], erro: null,
      };

      let d = null;
      if (l.mData) {
        const r = montarData(l.mData, ordem, hoje);
        if (r.data) { d = r.data; mov.avisos.push.apply(mov.avisos, r.avisos); }
        else mov.avisos.push("data não percebida");
      }

      // cabeçalho de data: uma linha só com a data passa a valer para as
      // linhas seguintes ("25/09" e por baixo os movimentos desse dia)
      if (d && !l.mValor && !desc) {
        dataContexto = d;
        mov.data = d;
        mov.estado = "contexto";
        out.push(mov);
        continue;
      }

      if (RE_IGNORAR.test(l.txt)) {
        mov.data = d || dataContexto || hoje;
        mov.estado = "ignorada";
        mov.erro = "linha de total/resumo";
        out.push(mov);
        continue;
      }

      const temDataPropria = !!d;
      if (d) dataContexto = d;
      else if (dataContexto) { d = dataContexto; mov.notas.push("data da linha anterior"); }
      else { d = hoje; if (l.mValor) mov.avisos.push("sem data — ficou hoje"); }
      mov.data = d;

      if (!l.mValor) {
        // com data (própria ou herdada de um cabeçalho) e descrição, isto
        // parece um movimento a que faltou o valor — vale a pena pedir que
        // o escrevam. Sem data nenhuma é só uma nota solta ("comprar pão")
        // ou o cabeçalho de uma tabela: sai da lista sem chatear ninguém.
        const pareceMovimento = !!desc && (temDataPropria || !!dataContexto);
        mov.estado = pareceMovimento ? "erro" : "ignorada";
        mov.erro = pareceMovimento ? "não encontrei o valor" : "não percebi esta linha";
        out.push(mov);
        continue;
      }
      if (l.mValor.ambiguo) mov.avisos.push("milhares ou decimal? confirma o valor");
      if (!desc) { mov.estado = "erro"; mov.erro = "falta a descrição"; }
      out.push(mov);
    }

    // conferência final: o que destoa do resto do bloco merece um olhar
    const validos = out.filter(m => m.estado !== "ignorada" && m.estado !== "contexto" && m.cents > 0);
    if (validos.length >= 4) {
      const datas = validos.map(m => m.data).sort();
      const meio = datas[Math.floor(datas.length / 2)];
      const vals = validos.map(m => m.cents).slice().sort((a, b) => a - b);
      const medianaV = vals[Math.floor(vals.length / 2)];
      for (const m of validos) {
        if (Math.abs(diasEntre(m.data, meio)) > 180) m.avisos.push("data muito longe do resto");
        if (medianaV > 0 && m.cents > medianaV * 50) m.avisos.push("valor muito acima do resto");
      }
    }
    for (const m of out) {
      if (ord.conflito && m.estado !== "ignorada" && m.estado !== "contexto")
        m.avisos.push("datas do bloco não são todas na mesma ordem");
      if (m.estado === "ok" && m.avisos.length) m.estado = "aviso";
    }

    return {
      dialeto: {
        sep: sep, decimal: decimal, ordem: ordem,
        sepAuto: o.sep === undefined || o.sep === null,
        decimalAuto: !o.decimal, ordemAuto: !o.ordem,
        conflitoOrdem: ord.conflito,
      },
      linhas: out,
    };
  }

  // Um valor escrito à mão (no ecrã de confirmação, ao corrigir uma linha):
  // devolve cêntimos, ou 0 se não houver número nenhum.
  function parseValor(txt, decimal) {
    const v = acharValor(String(txt == null ? "" : txt), decimal || ",");
    return v ? v.cents : 0;
  }

  return {
    parseMovimentos: parseMovimentos,
    parseValor: parseValor,
    // expostos para os testes
    _limparLinha: limparLinha, _acharData: acharData, _acharValor: acharValor,
    _capitalizarBerros: capitalizarBerros,
    _tokenCents: tokenCents, _SEPARADORES: SEPARADORES,
  };
});
