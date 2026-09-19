/* SplitWisely — bateria de casos do parser de importação
   ====================================================================
   Corre em Node (sem dependências):   node tests/parser-tests.js
   ou no browser, com a app aberta:    SWImportTests.correr()

   Cada caso é uma linha (ou um bloco) de texto e o que se espera que o
   parser perceba dela. Quando aparecer um formato novo que ele não
   apanha, junta-se aqui o caso primeiro — é o que evita que a correção
   de um formato parta outro.
   ==================================================================== */
"use strict";

(function (raiz, definir) {
  const api = definir(typeof require === "function" ? require("../import-parser.js") : raiz.SWImport);
  if (typeof module === "object" && module.exports) module.exports = api;
  else raiz.SWImportTests = api;
})(typeof self !== "undefined" ? self : this, function (SW) {

  const HOJE = "2026-09-17"; // uma quinta-feira, para os casos serem estáveis

  // Um caso: texto -> o que se espera. Só se verifica o que for indicado.
  // esp = { data, desc, cents, estado, aviso: "pedaço do aviso esperado" }
  const CASOS = [
    // ---------------------------------------------------- separadores
    { t: "26/09;Continente;45,30", e: { data: "2026-09-26", desc: "Continente", cents: 4530 } },
    { t: "26/09 / Continente / 45,30", e: { data: "2026-09-26", desc: "Continente", cents: 4530 } },
    { t: "26/09|Continente|45,30", e: { data: "2026-09-26", desc: "Continente", cents: 4530 } },
    { t: "26/09\tContinente\t45,30", e: { data: "2026-09-26", desc: "Continente", cents: 4530 } },
    { t: "26/09 Continente 45,30", e: { data: "2026-09-26", desc: "Continente", cents: 4530 } },
    { t: "26/09   Continente   45,30", e: { data: "2026-09-26", desc: "Continente", cents: 4530 } },
    { t: "26/09 - Continente - 45,30", e: { data: "2026-09-26", desc: "Continente", cents: 4530 } },
    // a ordem dos campos não importa: cada um é reconhecido pela forma
    { t: "Continente 45,30 26/09", e: { data: "2026-09-26", desc: "Continente", cents: 4530 } },
    { t: "45,30 Continente 26/09", e: { data: "2026-09-26", desc: "Continente", cents: 4530 } },
    // descrição com barra não se parte quando o separador do bloco é outro
    { t: "25-09; Jantar Joao/Ana; 30", e: { desc: "Jantar Joao/Ana", cents: 3000 } },

    // -------------------------------------------------------- valores
    { t: "26/09 Ikea 1.234,56", e: { cents: 123456 } },
    { t: "26/09 Ikea 1,234.56", e: { cents: 123456 } },
    { t: "26/09 Ikea 1 234,56", e: { cents: 123456 } },
    { t: "26/09 Ikea 12.345,67", e: { cents: 1234567 } },
    { t: "26/09 Cafe 45.30", e: { cents: 4530 } },
    { t: "26/09 Cafe 45,3", e: { cents: 4530 } },
    { t: "26/09 Cafe 45", e: { cents: 4500 } },
    { t: "26/09 Cafe 45,30 EUR", e: { cents: 4530, desc: "Cafe" } },
    { t: "26/09 Cafe 45,30€", e: { cents: 4530, desc: "Cafe" } },
    { t: "26/09 Cafe €45,30", e: { cents: 4530, desc: "Cafe" } },
    // o número que faz parte da descrição não rouba o lugar ao valor
    { t: "26/09 Almoco 2 pax 30", e: { desc: "Almoco 2 pax", cents: 3000 } },
    { t: "26/09 Bilhetes 2 pessoas 30,00", e: { desc: "Bilhetes 2 pessoas", cents: 3000 } },
    { t: "26/09 Folhas A4 12,50", e: { desc: "Folhas A4", cents: 1250 } },
    // o símbolo da moeda ganha a qualquer outra pista
    { t: "26/09 Gasoleo 60€ no total de 2 depositos", e: { cents: 6000 } },

    // ---------------------------------------------------------- datas
    { t: "2026-09-26 Ikea 45", e: { data: "2026-09-26" } },
    { t: "2026/09/26 Ikea 45", e: { data: "2026-09-26" } },
    { t: "26-09-2026 Ikea 45", e: { data: "2026-09-26" } },
    { t: "26/09/2026 Ikea 45", e: { data: "2026-09-26" } },
    { t: "26.09.2026 Ikea 45", e: { data: "2026-09-26" } },
    { t: "26/09/26 Ikea 45", e: { data: "2026-09-26" } },
    { t: "26-09 Ikea 45", e: { data: "2026-09-26" } },
    { t: "25-set Jantar 12,50", e: { data: "2026-09-25", desc: "Jantar" } },
    { t: "25/set Jantar 12,50", e: { data: "2026-09-25", desc: "Jantar" } },
    { t: "25 set Jantar 12,50", e: { data: "2026-09-25", desc: "Jantar" } },
    { t: "25.set Jantar 12,50", e: { data: "2026-09-25", desc: "Jantar" } },
    { t: "25 de setembro Jantar 12,50", e: { data: "2026-09-25", desc: "Jantar" } },
    { t: "25-Set-2026 Jantar 12,50", e: { data: "2026-09-25" } },
    { t: "25 de setembro de 2026 Jantar 12,50", e: { data: "2026-09-25" } },
    { t: "25 Sep Jantar 12,50", e: { data: "2026-09-25" } },
    { t: "set/25 Jantar 12,50", e: { data: "2026-09-25" } },
    { t: "setembro 25 Jantar 12,50", e: { data: "2026-09-25" } },
    { t: "25 marco Cabeleireiro 20", e: { data: "2026-03-25" } },
    { t: "hoje Cafe 1,20", e: { data: "2026-09-17" } },
    { t: "ontem Cafe 1,20", e: { data: "2026-09-16" } },
    { t: "anteontem Cafe 1,20", e: { data: "2026-09-15" } },
    // sem ano: fica o que põe a data mais perto de hoje
    { t: "20-12 Prendas 80", e: { data: "2025-12-20" } },
    { t: "20-09 Jantar 30", e: { data: "2026-09-20" } },
    // dia > 12 prova dd/mm mesmo sem mais nada no bloco
    { t: "30/09 Renda 500", e: { data: "2026-09-30" } },
    // 31 de setembro não existe: a data não passa, o movimento fica na mesma
    { t: "31/09 Renda 500", e: { cents: 50000, aviso: "data" } },
    { t: "29-02 Cafe 10", e: { cents: 1000, aviso: "data" } },
    // sem data nenhuma: fica hoje, mas avisa
    { t: "Cafe 1,20", e: { data: "2026-09-17", cents: 120, aviso: "sem data" } },

    // ------------------------------------------ ambiguidades do ponto
    // "25.09" sozinho num fim de linha é o valor, não 25 de setembro
    { t: "Cafe 25.09", e: { cents: 2509, desc: "Cafe", aviso: "sem data" } },
    // com um valor a seguir, volta a ser data
    { t: "25.09 Cafe 3,50", e: { data: "2026-09-25", cents: 350 } },

    // --------------------------------- descritivo todo em maiúsculas
    // extrato do banco: aos berros -> capitalizado
    { t: "26/09 CONTINENTE MATOSINHOS 45,30", e: { desc: "Continente Matosinhos" } },
    { t: "26/09 IKEA 45", e: { desc: "Ikea" } },
    { t: "26/09 PINGO DOCE 2 SACOS 12,50", e: { desc: "Pingo Doce 2 Sacos" } },
    // ligações em minúscula no meio do nome, maiúscula se abrirem
    { t: "26/09 CAFE DA AVO 1,20", e: { desc: "Cafe da Avo" } },
    { t: "26/09 PADARIA DA AVÓ 3,90", e: { desc: "Padaria da Avó" } },
    { t: "26/09 DE TUDO UM POUCO 9", e: { desc: "De Tudo um Pouco" } },
    // uma minúscula que seja: as maiúsculas foram escolha de quem escreveu
    { t: "26/09 Jantar no SUSHI 30", e: { desc: "Jantar no SUSHI" } },
    { t: "26/09 Sumo e AGUA 4,50", e: { desc: "Sumo e AGUA" } },
    { t: "26/09 McDonalds 8,90", e: { desc: "McDonalds" } },
    // sem letras nenhumas não há nada a capitalizar
    { t: "26/09 123 45,30", e: { desc: "123" } },

    // --------------------------------- marcas e ruído de extrato bancário
    // marca reconhecida: grafia certa (com o acento que o extrato não tem)
    { t: "26/09 INTERMARCHE 13,29", e: { desc: "Intermarché" } },
    { t: "26/09 ALDI ALCOCHETE 3,30", e: { desc: "Aldi Alcochete" } },
    { t: "26/09 PINGO DOCE MATOSINHOS 12,50", e: { desc: "Pingo Doce Matosinhos" } },
    // marca de várias palavras: a mais comprida ganha (não para em "Continente")
    { t: "26/09 CONTINENTE BOM DIA ALCOCHETE 25,86", e: { desc: "Continente Bom Dia Alcochete" } },
    // localidade duplicada e colada sem espaço (bug do extrato) -> só uma vez
    { t: "26/09 INTERMARCHE ALCOCHETALCOCHETE 13,29", e: { desc: "Intermarché Alcochete" } },
    // a mesma duplicação, mas COM espaço entre as duas
    { t: "26/09 ALDI ALCOCHETE ALCOCHETE 3,30", e: { desc: "Aldi Alcochete" } },
    // propaganda do terminal a seguir à marca: some, e o que ficava depois
    // (só a localidade) sai com ela
    { t: "26/09 LIDL AGRADECE ALCOCHETE 14,86", e: { desc: "Lidl" } },
    // sem marca reconhecida a seguir, "agradece" não é ruído — é só uma
    // palavra qualquer, e não se mexe
    { t: "26/09 MUITO AGRADECE PELA AJUDA 10", e: { desc: "Muito Agradece pela Ajuda" } },
    // sem marca nenhuma no início, o resto capitaliza-se na mesma
    { t: "26/09 H3 LISBOA 1250-133 LISBOA 10,95", e: { desc: "H3 Lisboa 1250-133 Lisboa" } },
    // palavra comprida sem repetição nenhuma não se mexe
    { t: "26/09 SUPERMERCADO 20", e: { desc: "Supermercado" } },

    // ------------------------------------------------- lixo e limpeza
    { t: "- 25-09 Cafe 1,20", e: { desc: "Cafe", cents: 120 } },
    { t: "* 25-09 Cafe 1,20", e: { desc: "Cafe", cents: 120 } },
    { t: "1. 25-09 Cafe 1,20", e: { desc: "Cafe", cents: 120 } },
    { t: "25-09 Cafe 1,20", e: { desc: "Cafe", cents: 120 } },
    { t: "TOTAL 340,20", e: { estado: "ignorada" } },
    { t: "Total do fim de semana: 340,20", e: { estado: "ignorada" } },
    { t: "Comprar pao", e: { estado: "ignorada" } },
    { t: "25/09 Jantar", e: { estado: "erro" } },
    { t: "25/09 45,30", e: { estado: "erro" } },

    // ------------------------------------------------------ overrides
    { t: "05/09 Cafe 1,20", o: { ordem: "mdy" }, e: { data: "2026-05-09" } },
    { t: "26/09 Ikea 1,234", o: { decimal: "," }, e: { cents: 123400, aviso: "milhares" } },
    { t: "26/09 Ikea 1,234", o: { decimal: "." }, e: { cents: 123400 } },
    { t: "26/09 Jantar Joao/Ana 30", o: { sep: "/" }, e: { desc: "Jantar Joao Ana" } },
    { t: "26/09 Jantar Joao/Ana 30", o: { sep: "" }, e: { desc: "Jantar Joao/Ana" } },
  ];

  // Blocos inteiros: aqui o que se testa é a inferência pelo conjunto.
  const BLOCOS = [
    {
      nome: "data de contexto em cabeçalho",
      t: ["25/09", "Cafe 1,20", "Almoco 12,50", "26/09", "Gasoleo 60"].join("\n"),
      e: [
        { estado: "contexto", data: "2026-09-25" },
        { data: "2026-09-25", desc: "Cafe", cents: 120 },
        { data: "2026-09-25", desc: "Almoco", cents: 1250 },
        { estado: "contexto", data: "2026-09-26" },
        { data: "2026-09-26", desc: "Gasoleo", cents: 6000 },
      ],
    },
    {
      nome: "data herdada da linha anterior",
      t: ["25/09 Cafe 1,20", "Almoco 12,50"].join("\n"),
      e: [
        { data: "2026-09-25", cents: 120 },
        { data: "2026-09-25", desc: "Almoco", cents: 1250 },
      ],
    },
    {
      nome: "uma linha prova mm/dd e arrasta o bloco",
      t: ["09/25 Jantar 30", "09/03 Cafe 1,20"].join("\n"),
      dialeto: { ordem: "mdy" },
      e: [
        { data: "2026-09-25", cents: 3000 },
        { data: "2026-09-03", cents: 120 },
      ],
    },
    {
      nome: "bloco com decimal ponto: 1.234 fica ambiguo",
      t: ["26/09 Cafe 12.50", "26/09 Ikea 1.234"].join("\n"),
      dialeto: { decimal: "." },
      e: [
        { cents: 1250 },
        { cents: 123400, aviso: "milhares" },
      ],
    },
    {
      nome: "bloco com decimal virgula: 1.234 e milhares sem duvida",
      t: ["26/09 Cafe 12,50", "26/09 Ikea 1.234"].join("\n"),
      dialeto: { decimal: "," },
      e: [
        { cents: 1250 },
        { cents: 123400, aviso: null },
      ],
    },
    {
      nome: "separador ; detetado no bloco",
      t: ["25/09;Cafe;1,20", "26/09;Almoco;12,50"].join("\n"),
      dialeto: { sep: ";" },
      e: [
        { desc: "Cafe", cents: 120 },
        { desc: "Almoco", cents: 1250 },
      ],
    },
    {
      nome: "separador / detetado no bloco",
      t: ["25-09 / Cafe / 1,20", "26-09 / Almoco / 12,50"].join("\n"),
      dialeto: { sep: "/" },
      e: [
        { desc: "Cafe", cents: 120 },
        { desc: "Almoco", cents: 1250 },
      ],
    },
    {
      // o caso que justifica mascarar antes de partir: a barra é separador
      // de campos E de datas na mesma linha
      nome: "separador / com datas em dd/mm/aaaa",
      t: ["25/09/2026 / Continente / 45,30", "26/09/2026 / Jantar / 62,50"].join("\n"),
      dialeto: { sep: "/" },
      e: [
        { data: "2026-09-25", desc: "Continente", cents: 4530 },
        { data: "2026-09-26", desc: "Jantar", cents: 6250 },
      ],
    },
    {
      // e o mesmo com a vírgula: separador de campos E decimal
      nome: "separador , com decimal ponto",
      t: ["25-09,Cafe,1.20", "26-09,Almoco,12.50"].join("\n"),
      dialeto: { sep: ",", decimal: "." },
      e: [
        { data: "2026-09-25", desc: "Cafe", cents: 120 },
        { data: "2026-09-26", desc: "Almoco", cents: 1250 },
      ],
    },
    {
      nome: "colado do Excel (tabs) com cabecalho e total",
      t: ["Data\tDescricao\tValor", "25/09\tCafe\t1,20", "26/09\tAlmoco\t12,50", "Total\t\t13,70"].join("\n"),
      e: [
        { estado: "ignorada" },
        { desc: "Cafe", cents: 120 },
        { desc: "Almoco", cents: 1250 },
        { estado: "ignorada" },
      ],
    },
    {
      nome: "extrato do banco, tudo em maiusculas",
      t: ["25/09;CONTINENTE MATOSINHOS;45,30",
          "26/09;MB WAY TRF;20,00",
          "27/09;BOMBA DE GASOLINA DA AVENIDA;60,00"].join("\n"),
      e: [
        { desc: "Continente Matosinhos", cents: 4530 },
        { desc: "Mb Way Trf", cents: 2000 },
        { desc: "Bomba de Gasolina da Avenida", cents: 6000 },
      ],
    },
    {
      nome: "linhas vazias e espacos nao contam",
      t: ["", "  ", "25/09 Cafe 1,20", "", "26/09 Almoco 12,50", ""].join("\n"),
      e: [{ cents: 120 }, { cents: 1250 }],
    },
  ];

  // ------------------------------------------------------------- runner

  function conferir(mov, esp) {
    const falhas = [];
    for (const k of ["data", "desc", "cents", "estado"]) {
      if (esp[k] !== undefined && mov[k] !== esp[k])
        falhas.push(k + ": esperava " + JSON.stringify(esp[k]) + ", veio " + JSON.stringify(mov[k]));
    }
    if (esp.aviso !== undefined) {
      const texto = mov.avisos.join(" | ") + " " + (mov.erro || "");
      const tem = esp.aviso === null ? texto.trim() === "" : texto.indexOf(esp.aviso) >= 0;
      if (!tem) falhas.push("avisos: esperava " + JSON.stringify(esp.aviso) + ", veio " + JSON.stringify(texto.trim()));
    }
    return falhas;
  }

  function correr(log) {
    const diz = log || ((s) => console.log(s));
    let ok = 0;
    const erros = [];

    for (const c of CASOS) {
      const opts = Object.assign({ hoje: HOJE }, c.o || {});
      const r = SW.parseMovimentos(c.t, opts);
      const mov = r.linhas[0];
      if (!mov) { erros.push([c.t, ["nenhuma linha devolvida"]]); continue; }
      // quando não se pede um estado, espera-se um movimento aproveitável
      const esp = c.e.estado === undefined ? Object.assign({}, c.e) : c.e;
      const falhas = conferir(mov, esp);
      if (c.e.estado === undefined && (mov.estado === "erro" || mov.estado === "ignorada"))
        falhas.push("estado: veio " + mov.estado + " (" + (mov.erro || "") + ")");
      if (falhas.length) erros.push([JSON.stringify(c.t), falhas]); else ok++;
    }

    for (const b of BLOCOS) {
      const r = SW.parseMovimentos(b.t, { hoje: HOJE });
      const falhas = [];
      if (b.dialeto) for (const k of Object.keys(b.dialeto)) {
        if (r.dialeto[k] !== b.dialeto[k])
          falhas.push("dialeto." + k + ": esperava " + JSON.stringify(b.dialeto[k]) + ", veio " + JSON.stringify(r.dialeto[k]));
      }
      if (r.linhas.length !== b.e.length) falhas.push("linhas: esperava " + b.e.length + ", veio " + r.linhas.length);
      else b.e.forEach((esp, i) => {
        conferir(r.linhas[i], esp).forEach(f => falhas.push("linha " + (i + 1) + " -> " + f));
      });
      if (falhas.length) erros.push(["bloco: " + b.nome, falhas]); else ok++;
    }

    const total = CASOS.length + BLOCOS.length;
    for (const [nome, falhas] of erros) {
      diz("FALHOU  " + nome);
      falhas.forEach(f => diz("         " + f));
    }
    diz((erros.length ? "\n" : "") + ok + "/" + total + " casos passaram"
      + (erros.length ? " — " + erros.length + " a corrigir" : " ✓"));
    return { ok: ok, total: total, erros: erros };
  }

  if (typeof module === "object" && module.exports && require.main === module) {
    const r = correr();
    if (typeof process !== "undefined") process.exitCode = r.erros.length ? 1 : 0;
  }

  return { correr: correr, CASOS: CASOS, BLOCOS: BLOCOS };
});
