# 💸 SplitWisely

App web estilo Splitwise para gerir despesas partilhadas, feita em HTML/JS puro com [Supabase](https://supabase.com) (base de dados + login Google).

## Funcionalidades

- **Contas com aprovação** — o email definido em `admin_email` (no SQL) entra como **admin**; os restantes ficam num ecrã "à espera de aprovação" até o admin os aprovar no menu **Admin**. Assim ninguém entra por maldade e enche a base de dados. Exceção: quem foi **convidado** (adicionado como membro de um grupo pelo seu email) entra já aprovado ao fazer login.
- **Grupos / eventos** — cada utilizador cria os grupos que quiser (pode até criar grupos onde não participa: continua a geri-los como criador).
- **Membros por grupo** — pessoas com nome simples ou ligadas a contas Google. Se adicionares alguém com o email, fica automaticamente ligado à conta quando entrar pela primeira vez — e podes mandar-lhe o convite com um clique em **«Convidar por Gmail»** (abre o Gmail num separador novo, já com o link da app).
- **Despesas flexíveis** — pagas por **uma ou mais** pessoas e divididas por **uma ou várias**, em partes iguais, por proporção ou valores exatos.
- **Categorias com ícones e sugestão automática** — cada despesa pode ter uma categoria (Talho 🥩, Peixe 🐟, Mercearia 🛒, Restaurante 🍽️, Bebidas 🥤, Sobremesas 🍰, Utensílios 🍴, Limpeza 🧼, Cinema 🎬, Prendas 🎁, …). Ao escrever a descrição, a app **sugere logo a categoria** e vai **aprendendo** com as categorizações anteriores (histórico do grupo + memória local do browser). Na lista, cada despesa mostra o ícone da categoria e há chips com o **total por categoria** que servem de filtro ao toque. Nas **Definições** de cada grupo podes escolher **quais as categorias que se aplicam** a esse grupo (por defeito, todas) — só essas aparecem ao lançar despesas.
- **Fatura repartida por várias categorias** — uma despesa pode alocar o valor por **várias categorias** (ex.: 50 € de jantar = 35 € Restaurante + 10 € Bebidas + 5 € Sobremesas). No formulário, «Fatura com várias categorias? Reparte o valor» abre a alocação por categoria (com «Distribuir igualmente»); a soma tem de bater no total. Os totais por categoria (chips, filtros e relatório) contam **cada parte na sua categoria**, e a lista assinala a fatura repartida com um contador no ícone.
- **Defaults por grupo** — cada membro tem um *peso* default (a proporção com que entra nas divisões) e pode ser marcado como *pagador default*; as novas despesas vêm pré-preenchidas com isso.
- **Despesas recorrentes** — ao criar uma despesa escolhes **Ocasional** ou **Recorrente**; na recorrente indicas o **dia do mês** e, se quiseres, uma data para **terminar** (renda, ginásio, subscrições…), com a mesma flexibilidade de divisão das despesas normais. Não há servidor: são **lançadas automaticamente** (no dia marcado, ajustado ao último dia nos meses mais curtos) quando alguém abre a app — sem nunca duplicar, mesmo com várias pessoas a abrir ao mesmo tempo. Os moldes ativos gerem-se também no separador **Definições** do grupo.
- **Saldos e acerto de contas** — quem deve a quem (com o detalhe de *a quem* por baixo do saldo), sugestões de pagamentos mínimos e **registo de pagamentos**: um clique em «Pagar» numa sugestão pré-preenche o pagamento; os pagamentos registados abatem nos saldos e podem ser apagados.
- **Liquidação preferencial** — no detalhe de um membro podes indicar com quem ele **liquida preferencialmente** (opcional). Útil para convidados: se o Y é convidado do X, o Y tem a pagar e o X a receber, os acertos sugerem primeiro Y → X, antes da distribuição normal.
- **PWA para telemóvel** — instalável no ecrã inicial (Android e iOS), abre em ecrã inteiro sem barra do browser, funciona offline para consulta e tem o zoom bloqueado.

## Configuração (uma vez)

Esta app vive num **schema dedicado** (`splitwisely`) dentro do **projeto Supabase partilhado**
pelas outras apps (Bet4Fun, FestasBV…). Não cria triggers em `auth.users` (tabela partilhada):
o perfil é criado pela RPC `ensure_profile()` quando cada pessoa abre a app pela primeira vez.

### 1. Correr o schema no projeto partilhado

1. Abre o projeto Supabase partilhado → **SQL Editor** → cola e executa
   [`supabase/schema.sql`](supabase/schema.sql). Cria o schema `splitwisely` com as tabelas,
   as RPCs (`ensure_profile`, `approve_user`, `claim_memberships`) e as políticas RLS.
2. No seed do ficheiro, confirma o teu Gmail em `admin_email` — esse email entra como
   **admin já aprovado** no 1.º login; os restantes ficam à espera de aprovação. (Para trocar
   depois: `update splitwisely.settings set value='"o-teu@gmail.com"'::jsonb where key='admin_email';`)
3. Se chegaste a correr a versão antiga do schema (em `public`), corre também o bloco de
   **LIMPEZA** comentado no fim do ficheiro.

### 2. Expor o schema `splitwisely` na Data API

**Project Settings → API → Data API → *Exposed schemas*** → adiciona `splitwisely`.
Sem isto o PostgREST devolve 403/404 a todos os pedidos da app.

### 3. Login com Google

O provider Google já está configurado no projeto partilhado (usado pelas outras apps),
por isso só falta autorizar o endereço desta app:

1. Em **Authentication → URL Configuration**, adiciona o endereço onde vais servir a
   SplitWisely (ex.: `https://oteusite.github.io/SplitWisely/`) aos *Redirect URLs*.
   (A app passa `redirectTo` no login, por isso não é preciso mexer no *Site URL*.)
2. *(Só se o Google ainda não estivesse ativo:* na [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   cria um **OAuth Client ID** (tipo *Web application*) com o redirect URI
   `https://O-TEU-PROJETO.supabase.co/auth/v1/callback`, e em
   **Authentication → Providers → Google** ativa e cola o *Client ID* e o *Client Secret*.)*

### 4. Ligar a app ao projeto

Copia `config.example.js` para `config.js` e preenche com os valores de **Settings → API**
do projeto partilhado — são o **mesmo Project URL e a mesma chave `anon`** das outras apps:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://xyz.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...",
};
```

(Em alternativa, se não existir `config.js`, a app pede estes valores no primeiro arranque e guarda-os no browser.)

> A chave *anon* é pública por natureza — a segurança dos dados é garantida pelas políticas RLS no schema, não pelo segredo da chave. **Nunca** uses aqui a chave `service_role`.

### 5. Servir a app

É um site estático — serve como quiseres:

```bash
# localmente
python3 -m http.server 8000
# → http://localhost:8000
```

ou publica no GitHub Pages, Netlify, Vercel, etc. (lembra-te de atualizar o *Site URL* no Supabase).

> **Nota PWA:** o service worker (offline + instalação) só funciona em **HTTPS** ou em `localhost`. Em produção usa sempre HTTPS.

### 6. Instalar no telemóvel

- **Android (Chrome):** abre o site → menu ⋮ → **Adicionar ao ecrã principal** (ou aceita o aviso de instalação).
- **iPhone (Safari):** abre o site → botão de partilha → **Adicionar ao ecrã principal**.

A app abre depois como qualquer outra, em ecrã inteiro e com o ícone próprio.

## Como usar

1. Entra com Google. O email definido em `admin_email` entra logo como **admin**; os
   restantes ficam no ecrã "à espera de aprovação" até o admin os aprovar no menu
   **Admin** (botão na barra de topo, só visível ao admin — também dá para revogar acessos).
2. Cria um grupo (podes escolher não ser membro dele).
3. Na aba **Membros**, adiciona as pessoas: define o **peso** de cada uma (proporção default da divisão) e marca quem é o **pagador default**.
4. Adiciona despesas na aba **Despesas** — vêm pré-preenchidas com os defaults, mas podes ajustar pagadores, participantes e o modo de divisão em cada despesa.
5. A aba **Saldos** mostra quem recebe, quem deve (e a quem) e a forma mais simples de acertar contas.
6. Quando alguém pagar a dívida, regista o pagamento na aba **Saldos** — o botão «Pagar» em cada
   sugestão pré-preenche tudo (ou usa «Registar pagamento» para valores/pessoas à escolha).

> **Já tinhas uma versão anterior do schema?** Volta a correr `supabase/schema.sql` no SQL
> Editor (é idempotente) para apanhar as novidades — a tabela `payments` dos pagamentos, a
> aprovação automática de quem é convidado por email, as **despesas recorrentes** (tabelas
> `recurring_expenses` + a RPC `generate_due_recurring`) e a coluna `settle_with` da
> **liquidação preferencial** nos membros.

## Estrutura

| Ficheiro | Descrição |
|---|---|
| `index.html` | página única da app |
| `app.js` | toda a lógica (auth, grupos, despesas, saldos) |
| `styles.css` | estilos (tema claro/escuro automático) |
| `config.example.js` | modelo de configuração |
| `manifest.webmanifest` | manifesto PWA (nome, ícones, ecrã inteiro) |
| `sw.js` | service worker (cache offline) |
| `icons/` | ícones da app |
| `supabase/schema.sql` | schema `splitwisely`: tabelas, RPCs, aprovação de contas e políticas RLS |
