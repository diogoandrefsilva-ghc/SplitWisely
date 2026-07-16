# 💸 SplitWisely

App web estilo Splitwise para gerir despesas partilhadas, feita em HTML/JS puro com [Supabase](https://supabase.com) (base de dados + login Google).

## Funcionalidades

- **Grupos / eventos** — cada utilizador cria os grupos que quiser (pode até criar grupos onde não participa: continua a geri-los como criador).
- **Membros por grupo** — pessoas com nome simples ou ligadas a contas Google. Se adicionares alguém com o email, fica automaticamente ligado à conta quando entrar pela primeira vez.
- **Despesas flexíveis** — pagas por **uma ou mais** pessoas e divididas por **uma ou várias**, em partes iguais, por proporção ou valores exatos.
- **Defaults por grupo** — cada membro tem um *peso* default (a proporção com que entra nas divisões) e pode ser marcado como *pagador default*; as novas despesas vêm pré-preenchidas com isso.
- **Saldos e acerto de contas** — quem deve a quem, com sugestões de pagamentos mínimos.

## Configuração (uma vez)

### 1. Criar o projeto Supabase

1. Cria um projeto em [supabase.com](https://supabase.com) (plano gratuito chega).
2. No **SQL Editor**, cola e executa o conteúdo de [`supabase/schema.sql`](supabase/schema.sql). Isto cria as tabelas, os triggers e as políticas de segurança (RLS).

### 2. Ativar o login com Google

1. Na [Google Cloud Console](https://console.cloud.google.com/apis/credentials), cria um **OAuth Client ID** (tipo *Web application*).
   - Em *Authorized redirect URIs* adiciona: `https://O-TEU-PROJETO.supabase.co/auth/v1/callback`
2. No Supabase, vai a **Authentication → Providers → Google**, ativa e cola o *Client ID* e o *Client Secret*.
3. Em **Authentication → URL Configuration**, define o *Site URL* como o endereço onde vais servir a app (ex.: `https://oteusite.github.io/SplitWisely/`) e adiciona-o também aos *Redirect URLs*.

### 3. Ligar a app ao projeto

Copia `config.example.js` para `config.js` e preenche com os valores de **Settings → API** do Supabase:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://xyz.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...",
};
```

(Em alternativa, se não existir `config.js`, a app pede estes valores no primeiro arranque e guarda-os no browser.)

> A chave *anon* é pública por natureza — a segurança dos dados é garantida pelas políticas RLS no schema, não pelo segredo da chave.

### 4. Servir a app

É um site estático — serve como quiseres:

```bash
# localmente
python3 -m http.server 8000
# → http://localhost:8000
```

ou publica no GitHub Pages, Netlify, Vercel, etc. (lembra-te de atualizar o *Site URL* no Supabase).

## Como usar

1. Entra com Google.
2. Cria um grupo (podes escolher não ser membro dele).
3. Na aba **Membros**, adiciona as pessoas: define o **peso** de cada uma (proporção default da divisão) e marca quem é o **pagador default**.
4. Adiciona despesas na aba **Despesas** — vêm pré-preenchidas com os defaults, mas podes ajustar pagadores, participantes e o modo de divisão em cada despesa.
5. A aba **Saldos** mostra quem recebe, quem deve e a forma mais simples de acertar contas.

## Estrutura

| Ficheiro | Descrição |
|---|---|
| `index.html` | página única da app |
| `app.js` | toda a lógica (auth, grupos, despesas, saldos) |
| `styles.css` | estilos (tema claro/escuro automático) |
| `config.example.js` | modelo de configuração |
| `supabase/schema.sql` | tabelas, triggers e políticas RLS |
