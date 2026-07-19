-- ============================================================
-- SplitWisely — Schema Supabase (schema dedicado `splitwisely`)
-- Executar no SQL Editor do projeto Supabase PARTILHADO (uma vez).
--
-- Como as outras apps do projeto (Bet4Fun, FestasBV), esta app vive
-- num schema próprio para não colidir com as restantes. Dois cuidados:
--   1. Expor o schema: Project Settings → API → Data API →
--      Exposed schemas → adicionar `splitwisely`
--      (sem isto o PostgREST devolve 403/404).
--   2. NÃO há trigger em auth.users — essa tabela é partilhada por
--      todas as apps. O perfil é criado pela RPC ensure_profile(),
--      chamada pela app no primeiro acesso.
--
-- Contas: o email em settings('admin_email') entra como admin já
-- aprovado; quem foi convidado (adicionado como membro de um grupo pelo
-- seu email) entra também já aprovado; os restantes ficam à espera de
-- aprovação no menu Admin.
-- ============================================================

create schema if not exists splitwisely;

-- ---------- DEFINIÇÕES ----------
create table if not exists splitwisely.settings (
  key text primary key,
  value jsonb not null
);

insert into splitwisely.settings (key, value) values
  ('admin_email', '"diogo.andre.f.silva@gmail.com"'::jsonb)  -- <<< TROCA se preciso
on conflict (key) do nothing;

-- ---------- PERFIS ----------
-- is_admin    -> gere aprovações (menu Admin)
-- is_approved -> pode usar a app; false = ecrã "à espera de aprovação"
create table if not exists splitwisely.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text,
  avatar_url text,
  is_admin boolean not null default false,
  is_approved boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- HELPERS (SECURITY DEFINER evita recursão de RLS) ----------
create or replace function splitwisely.is_admin()
returns boolean
language sql stable security definer
set search_path = splitwisely
as $$
  select exists (select 1 from profiles where id = auth.uid() and is_admin);
$$;

-- pode usar a app? (aprovado ou admin)
create or replace function splitwisely.can_use()
returns boolean
language sql stable security definer
set search_path = splitwisely
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and (is_approved or is_admin)
  );
$$;

-- ---------- INSCRIÇÃO (chamada pela app no login) ----------
-- Cria/atualiza o perfil do utilizador atual e devolve-o. Entra já
-- aprovado quem for o admin (settings('admin_email')) OU quem tiver um
-- convite pendente (foi adicionado como membro de um grupo pelo seu
-- email — ver email_was_invited); os restantes ficam is_approved=false
-- até o admin aprovar. Um utilizador já existente mas ainda por aprovar
-- passa a aprovado se, entretanto, tiver recebido um convite.
create or replace function splitwisely.ensure_profile()
returns jsonb
language plpgsql security definer
set search_path = splitwisely
as $$
declare
  v_uid uuid := auth.uid();
  v_admin_email text;
  v_profile profiles;
begin
  if v_uid is null then raise exception 'Não autenticado'; end if;

  select value #>> '{}' into v_admin_email from settings where key = 'admin_email';

  insert into profiles (id, full_name, email, avatar_url, is_admin, is_approved)
  select u.id,
         coalesce(u.raw_user_meta_data->>'full_name',
                  u.raw_user_meta_data->>'name',
                  split_part(u.email, '@', 1)),
         u.email,
         u.raw_user_meta_data->>'avatar_url',
         coalesce(lower(u.email) = lower(v_admin_email), false),
         coalesce(lower(u.email) = lower(v_admin_email), false)
           or splitwisely.email_was_invited(u.email)
  from auth.users u where u.id = v_uid
  on conflict (id) do update
    set full_name  = excluded.full_name,
        email      = excluded.email,
        avatar_url = excluded.avatar_url,
        -- convite recebido depois do 1.º login aprova a conta agora
        is_approved = profiles.is_approved
                        or splitwisely.email_was_invited(excluded.email);

  select * into v_profile from profiles where id = v_uid;
  return to_jsonb(v_profile);
end;
$$;

-- ---------- APROVAR / REVOGAR (só admin, via menu Admin) ----------
create or replace function splitwisely.approve_user(p_id uuid, p_approved boolean)
returns void
language plpgsql security definer
set search_path = splitwisely
as $$
begin
  if not splitwisely.is_admin() then raise exception 'Apenas admin'; end if;
  -- admins nunca são revogados por aqui (evita o admin trancar-se fora)
  update profiles set is_approved = p_approved
   where id = p_id and not is_admin;
end;
$$;

-- Congelar colunas privilegiadas: um UPDATE direto do próprio perfil
-- (nome/avatar) nunca pode mexer em is_admin/is_approved.
create or replace function splitwisely.profiles_guard()
returns trigger
language plpgsql security definer
set search_path = splitwisely
as $$
begin
  -- auth.uid() null = escrita administrativa direta (SQL Editor /
  -- service_role), fora do alcance dos utilizadores da app — passa.
  if auth.uid() is null then return new; end if;
  if (new.is_admin is distinct from old.is_admin
      or new.is_approved is distinct from old.is_approved)
     and not splitwisely.is_admin() then
    -- Exceção: auto-aprovação por convite. Um utilizador pode passar de
    -- is_approved false->true (e SÓ isso — is_admin nunca muda por aqui)
    -- se tiver um convite pendente, i.e. foi adicionado como membro de um
    -- grupo pelo seu email por alguém com acesso a esse grupo. A criação
    -- desses membros já é limitada pela RLS de group_members, por isso
    -- ninguém se aprova sozinho sem ter sido genuinamente convidado.
    if new.is_admin is not distinct from old.is_admin
       and old.is_approved is false and new.is_approved is true
       and splitwisely.email_was_invited(new.email) then
      return new;
    end if;
    new.is_admin := old.is_admin;
    new.is_approved := old.is_approved;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_guard on splitwisely.profiles;
create trigger trg_profiles_guard before update on splitwisely.profiles
  for each row execute function splitwisely.profiles_guard();

-- ---------- GRUPOS / EVENTOS ----------
-- use_weights -> divisão por proporções (pesos por pessoa) ativa neste
-- grupo. Por defeito os grupos dividem em partes iguais.
-- categories  -> ids das categorias que se aplicam a este grupo (as que
-- aparecem ao lançar despesas). null = todas as categorias (default).
create table if not exists splitwisely.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  currency text not null default 'EUR',
  use_weights boolean not null default false,
  categories jsonb,
  created_by uuid not null references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- migração para instalações antigas (re-executar este ficheiro é seguro)
alter table splitwisely.groups
  add column if not exists use_weights boolean not null default false;
alter table splitwisely.groups
  add column if not exists categories jsonb;

-- ---------- MEMBROS DE CADA GRUPO ----------
-- Uma "pessoa" do grupo. Pode estar ligada a um utilizador registado
-- (user_id) ou ser apenas um nome. Se tiver email, é ligada
-- automaticamente quando esse utilizador fizer login (claim_memberships).
-- default_weight  -> proporção default na divisão de despesas (0 = não entra)
-- is_default_payer-> pré-selecionado como pagador nas novas despesas
-- settle_with     -> membro com quem liquida preferencialmente os acertos
--                    (ex.: um convidado acerta primeiro com o anfitrião que
--                    o trouxe, se um deve e o outro tem a receber). Opcional;
--                    null = distribuição normal das sugestões de acerto.
create table if not exists splitwisely.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references splitwisely.groups (id) on delete cascade,
  name text not null,
  email text,
  user_id uuid references auth.users (id) on delete set null,
  default_weight numeric not null default 1 check (default_weight >= 0),
  is_default_payer boolean not null default false,
  settle_with uuid references splitwisely.group_members (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (group_id, user_id)
);

-- migração para instalações antigas (re-executar este ficheiro é seguro)
alter table splitwisely.group_members
  add column if not exists settle_with uuid
    references splitwisely.group_members (id) on delete set null;

-- ---------- CONVITE PENDENTE? ----------
-- Há um convite por email à espera deste endereço, i.e. alguém com acesso
-- a um grupo adicionou-o como membro (por email) e a conta ainda não foi
-- ligada. Usado no login para aprovar automaticamente quem foi convidado
-- (ensure_profile) e para permitir essa auto-aprovação no profiles_guard.
create or replace function splitwisely.email_was_invited(p_email text)
returns boolean
language sql stable security definer
set search_path = splitwisely
as $$
  select p_email is not null and exists (
    select 1 from group_members m
    where m.user_id is null
      and m.email is not null
      and lower(m.email) = lower(p_email)
  );
$$;

-- ---------- DESPESAS ----------
-- split_mode -> como a despesa foi dividida ('equal' partes iguais,
-- 'weights' proporção por pesos, 'exact' valores exatos). Serve para a
-- app reabrir a despesa no modo em que foi criada; os valores finais
-- por pessoa vivem sempre em expense_shares.
create table if not exists splitwisely.expenses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references splitwisely.groups (id) on delete cascade,
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  expense_date date not null default current_date,
  split_mode text not null default 'exact'
    check (split_mode in ('equal', 'weights', 'exact')),
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- migração para instalações antigas (re-executar este ficheiro é seguro)
alter table splitwisely.expenses
  add column if not exists split_mode text not null default 'exact'
    check (split_mode in ('equal', 'weights', 'exact'));

-- category -> categoria da despesa (talho, mercearia, restaurante, …).
-- A lista de categorias (e o ícone de cada uma) vive na app (CATEGORIES,
-- em app.js); aqui fica só o id em texto, nullable — despesas antigas ou
-- sem categoria ficam a null. A app sugere a categoria automaticamente a
-- partir da descrição e vai aprendendo com as categorizações anteriores.
alter table splitwisely.expenses
  add column if not exists category text;

-- backfill: despesas antigas com as partes todas iguais (± arredondamento
-- de cêntimos) passam a 'equal' — o resultado é o mesmo, mas reabrem no
-- modo «Partes iguais» em vez de «Exatos»
update splitwisely.expenses e
   set split_mode = 'equal'
 where e.split_mode = 'exact'
   and (select max(s.amount) - min(s.amount)
          from splitwisely.expense_shares s
         where s.expense_id = e.id) <= 0.01;

-- Quem pagou (uma ou mais pessoas)
create table if not exists splitwisely.expense_payers (
  expense_id uuid not null references splitwisely.expenses (id) on delete cascade,
  member_id uuid not null references splitwisely.group_members (id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  primary key (expense_id, member_id)
);

-- Por quem se divide (uma ou mais pessoas), já em valor final
create table if not exists splitwisely.expense_shares (
  expense_id uuid not null references splitwisely.expenses (id) on delete cascade,
  member_id uuid not null references splitwisely.group_members (id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  primary key (expense_id, member_id)
);

-- Fatura repartida por várias categorias (opcional). Cada linha aloca uma
-- parte do valor da despesa a uma categoria; a soma das linhas iguala o
-- total (validado na app). Despesas com 0 ou 1 categoria não têm linhas
-- aqui — chega a coluna expenses.category, que numa fatura repartida
-- guarda a categoria principal (a de maior valor), para as listas e para
-- schemas antigos. (Adicionada depois: o ficheiro é idempotente, basta
-- voltar a corrê-lo todo no SQL Editor.)
create table if not exists splitwisely.expense_categories (
  expense_id uuid not null references splitwisely.expenses (id) on delete cascade,
  category text not null,
  amount numeric(12,2) not null check (amount >= 0),
  primary key (expense_id, category)
);

-- ---------- PAGAMENTOS (acertos de contas) ----------
-- Registo de "X pagou Y€ a Z" para acertar contas. Entra nos saldos:
-- quem paga fica com saldo mais positivo, quem recebe mais negativo.
-- (Adicionado depois da 1.ª versão: o ficheiro é idempotente, basta
-- voltar a corrê-lo todo no SQL Editor para criar esta tabela.)
create table if not exists splitwisely.payments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references splitwisely.groups (id) on delete cascade,
  from_member uuid not null references splitwisely.group_members (id) on delete cascade,
  to_member uuid not null references splitwisely.group_members (id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  payment_date date not null default current_date,
  note text,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  check (from_member <> to_member)
);

-- ---------- FUNÇÃO DE ACESSO (evita recursão nas policies) ----------
-- Tem acesso ao grupo: quem o criou (mesmo sem participar) ou quem
-- é membro com conta ligada.
create or replace function splitwisely.has_group_access(gid uuid)
returns boolean
language sql stable security definer
set search_path = splitwisely
as $$
  select exists (
    select 1 from groups g
    where g.id = gid and g.created_by = auth.uid()
  )
  or exists (
    select 1 from group_members m
    where m.group_id = gid and m.user_id = auth.uid()
  );
$$;

create or replace function splitwisely.expense_group(eid uuid)
returns uuid
language sql stable security definer
set search_path = splitwisely
as $$
  select group_id from expenses where id = eid;
$$;

-- ---------- LIGAR CONVITES POR EMAIL AO FAZER LOGIN ----------
create or replace function splitwisely.claim_memberships()
returns integer
language plpgsql security definer
set search_path = splitwisely
as $$
declare
  n integer;
  my_email text;
begin
  if not splitwisely.can_use() then return 0; end if;

  select email into my_email from auth.users where id = auth.uid();
  if my_email is null then
    return 0;
  end if;

  update group_members m
     set user_id = auth.uid()
   where m.user_id is null
     and m.email is not null
     and lower(m.email) = lower(my_email)
     and not exists (
       select 1 from group_members x
       where x.group_id = m.group_id and x.user_id = auth.uid()
     );
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------- ROW LEVEL SECURITY ----------
-- Tudo gated por can_use(): quem não está aprovado não vê nem escreve nada.
alter table splitwisely.settings       enable row level security;
alter table splitwisely.profiles       enable row level security;
alter table splitwisely.groups         enable row level security;
alter table splitwisely.group_members  enable row level security;
alter table splitwisely.expenses       enable row level security;
alter table splitwisely.expense_payers enable row level security;
alter table splitwisely.expense_shares enable row level security;
alter table splitwisely.expense_categories enable row level security;
alter table splitwisely.payments       enable row level security;

-- settings: sem policies — invisível via API (admin_email fica privado)

-- Perfis: cada um vê o seu (para saber se está aprovado); admin vê todos
-- (menu Admin). UPDATE só do próprio; flags congeladas pelo trigger.
drop policy if exists "profiles_select" on splitwisely.profiles;
create policy "profiles_select" on splitwisely.profiles
  for select to authenticated
  using (id = auth.uid() or splitwisely.is_admin());

drop policy if exists "profiles_update_own" on splitwisely.profiles;
create policy "profiles_update_own" on splitwisely.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Grupos
-- NOTA: o SELECT verifica created_by diretamente na linha (além de
-- has_group_access) porque o INSERT ... RETURNING da app também passa
-- por esta política — e has_group_access(), sendo STABLE, ainda não
-- "vê" o grupo acabado de inserir no mesmo statement.
drop policy if exists "groups_select" on splitwisely.groups;
create policy "groups_select" on splitwisely.groups
  for select to authenticated
  using (splitwisely.can_use()
         and (created_by = auth.uid() or splitwisely.has_group_access(id)));

drop policy if exists "groups_insert" on splitwisely.groups;
create policy "groups_insert" on splitwisely.groups
  for insert to authenticated
  with check (splitwisely.can_use() and created_by = auth.uid());

drop policy if exists "groups_update" on splitwisely.groups;
create policy "groups_update" on splitwisely.groups
  for update to authenticated
  using (splitwisely.can_use() and created_by = auth.uid());

drop policy if exists "groups_delete" on splitwisely.groups;
create policy "groups_delete" on splitwisely.groups
  for delete to authenticated
  using (splitwisely.can_use() and created_by = auth.uid());

-- Membros: quem tem acesso ao grupo gere tudo
drop policy if exists "members_all" on splitwisely.group_members;
create policy "members_all" on splitwisely.group_members
  for all to authenticated
  using (splitwisely.can_use() and splitwisely.has_group_access(group_id))
  with check (splitwisely.can_use() and splitwisely.has_group_access(group_id));

-- Despesas
drop policy if exists "expenses_all" on splitwisely.expenses;
create policy "expenses_all" on splitwisely.expenses
  for all to authenticated
  using (splitwisely.can_use() and splitwisely.has_group_access(group_id))
  with check (splitwisely.can_use() and splitwisely.has_group_access(group_id));

drop policy if exists "payers_all" on splitwisely.expense_payers;
create policy "payers_all" on splitwisely.expense_payers
  for all to authenticated
  using (splitwisely.can_use() and splitwisely.has_group_access(splitwisely.expense_group(expense_id)))
  with check (splitwisely.can_use() and splitwisely.has_group_access(splitwisely.expense_group(expense_id)));

drop policy if exists "shares_all" on splitwisely.expense_shares;
create policy "shares_all" on splitwisely.expense_shares
  for all to authenticated
  using (splitwisely.can_use() and splitwisely.has_group_access(splitwisely.expense_group(expense_id)))
  with check (splitwisely.can_use() and splitwisely.has_group_access(splitwisely.expense_group(expense_id)));

drop policy if exists "expense_categories_all" on splitwisely.expense_categories;
create policy "expense_categories_all" on splitwisely.expense_categories
  for all to authenticated
  using (splitwisely.can_use() and splitwisely.has_group_access(splitwisely.expense_group(expense_id)))
  with check (splitwisely.can_use() and splitwisely.has_group_access(splitwisely.expense_group(expense_id)));

-- Pagamentos: quem tem acesso ao grupo gere tudo
drop policy if exists "payments_all" on splitwisely.payments;
create policy "payments_all" on splitwisely.payments
  for all to authenticated
  using (splitwisely.can_use() and splitwisely.has_group_access(group_id))
  with check (splitwisely.can_use() and splitwisely.has_group_access(group_id));

-- ---------- ÍNDICES ----------
create index if not exists idx_members_group  on splitwisely.group_members (group_id);
create index if not exists idx_members_user   on splitwisely.group_members (user_id);
create index if not exists idx_expenses_group on splitwisely.expenses (group_id, expense_date desc);
create index if not exists idx_payers_expense on splitwisely.expense_payers (expense_id);
create index if not exists idx_shares_expense on splitwisely.expense_shares (expense_id);
create index if not exists idx_cats_expense   on splitwisely.expense_categories (expense_id);
create index if not exists idx_payments_group on splitwisely.payments (group_id, payment_date desc);

-- ---------- GRANTS ----------
-- A RLS acima é que filtra as linhas; aqui é só o acesso base.
grant usage on schema splitwisely to anon, authenticated;
grant select, update on splitwisely.profiles to authenticated;
grant select, insert, update, delete
  on splitwisely.groups, splitwisely.group_members, splitwisely.expenses,
     splitwisely.expense_payers, splitwisely.expense_shares,
     splitwisely.expense_categories, splitwisely.payments
  to authenticated;
grant execute on all functions in schema splitwisely to authenticated;

-- ============================================================
-- DESPESAS RECORRENTES (moldes mensais)
-- Um "molde" que gera uma despesa por mês, num dado dia, para um grupo.
-- Não há servidor próprio: a app chama a RPC generate_due_recurring() ao
-- arrancar, que materializa as despesas em atraso. É idempotente — cada
-- despesa gerada fica ligada ao molde por (recurring_id, recurring_period)
-- e um índice único impede duplicados, mesmo com dois membros a abrir a app
-- ao mesmo tempo. Re-correr este ficheiro é seguro.
-- ============================================================
create table if not exists splitwisely.recurring_expenses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references splitwisely.groups (id) on delete cascade,
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  category text,
  split_mode text not null default 'exact'
    check (split_mode in ('equal', 'weights', 'exact')),
  day_of_month int not null check (day_of_month between 1 and 31),
  start_date date not null default current_date,
  end_date date,
  active boolean not null default true,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- Quem paga / por quem se divide, tal como nas despesas normais, mas no molde.
-- Os valores são copiados para a despesa de cada mês (montante fixo mensal).
create table if not exists splitwisely.recurring_expense_payers (
  recurring_id uuid not null references splitwisely.recurring_expenses (id) on delete cascade,
  member_id uuid not null references splitwisely.group_members (id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  primary key (recurring_id, member_id)
);
create table if not exists splitwisely.recurring_expense_shares (
  recurring_id uuid not null references splitwisely.recurring_expenses (id) on delete cascade,
  member_id uuid not null references splitwisely.group_members (id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  primary key (recurring_id, member_id)
);

-- Liga a despesa gerada ao molde e ao mês (período) que representa.
alter table splitwisely.expenses
  add column if not exists recurring_id uuid references splitwisely.recurring_expenses (id) on delete set null;
alter table splitwisely.expenses
  add column if not exists recurring_period date;
create unique index if not exists uq_expenses_recurring_period
  on splitwisely.expenses (recurring_id, recurring_period)
  where recurring_id is not null;

-- grupo de um molde (evita recursão nas policies dos filhos, como expense_group)
create or replace function splitwisely.recurring_group(rid uuid)
returns uuid
language sql stable security definer
set search_path = splitwisely
as $$
  select group_id from recurring_expenses where id = rid;
$$;

-- Materializa as despesas recorrentes em atraso dos grupos a que o utilizador
-- tem acesso. Para cada molde ativo gera uma despesa por mês, do mês de
-- start_date até ao mês atual, no dia indicado (ajustado ao último dia do mês
-- nos meses mais curtos — dia 31 em fevereiro cai no último dia), desde que a
-- data já tenha chegado e esteja dentro de [start_date, end_date].
-- Idempotente: o ON CONFLICT não duplica. Devolve quantas despesas criou.
create or replace function splitwisely.generate_due_recurring()
returns integer
language plpgsql security definer
set search_path = splitwisely
as $$
declare
  r record;
  m date;                                                -- 1.º dia do mês a processar
  last_m date := date_trunc('month', current_date)::date;
  dim int;                                               -- dias do mês m
  occ date;                                              -- data da ocorrência nesse mês
  new_id uuid;
  n int := 0;
begin
  if not splitwisely.can_use() then return 0; end if;

  for r in
    select * from recurring_expenses
     where active and splitwisely.has_group_access(group_id)
  loop
    m := date_trunc('month', r.start_date)::date;
    while m <= last_m loop
      dim := extract(day from (m + interval '1 month' - interval '1 day'))::int;
      occ := m + (least(r.day_of_month, dim) - 1);
      if occ >= r.start_date and occ <= current_date
         and (r.end_date is null or occ <= r.end_date) then
        new_id := null;
        insert into expenses (group_id, description, amount, expense_date,
                              split_mode, category, created_by,
                              recurring_id, recurring_period)
        values (r.group_id, r.description, r.amount, occ,
                r.split_mode, r.category, r.created_by, r.id, m)
        on conflict (recurring_id, recurring_period) where recurring_id is not null
        do nothing
        returning id into new_id;

        if new_id is not null then
          insert into expense_payers (expense_id, member_id, amount)
            select new_id, member_id, amount
              from recurring_expense_payers where recurring_id = r.id;
          insert into expense_shares (expense_id, member_id, amount)
            select new_id, member_id, amount
              from recurring_expense_shares where recurring_id = r.id;
          n := n + 1;
        end if;
      end if;
      m := (m + interval '1 month')::date;
    end loop;
  end loop;
  return n;
end;
$$;

-- RLS: como as despesas, tudo gated por can_use() + acesso ao grupo
alter table splitwisely.recurring_expenses       enable row level security;
alter table splitwisely.recurring_expense_payers enable row level security;
alter table splitwisely.recurring_expense_shares enable row level security;

drop policy if exists "recurring_all" on splitwisely.recurring_expenses;
create policy "recurring_all" on splitwisely.recurring_expenses
  for all to authenticated
  using (splitwisely.can_use() and splitwisely.has_group_access(group_id))
  with check (splitwisely.can_use() and splitwisely.has_group_access(group_id));

drop policy if exists "recurring_payers_all" on splitwisely.recurring_expense_payers;
create policy "recurring_payers_all" on splitwisely.recurring_expense_payers
  for all to authenticated
  using (splitwisely.can_use() and splitwisely.has_group_access(splitwisely.recurring_group(recurring_id)))
  with check (splitwisely.can_use() and splitwisely.has_group_access(splitwisely.recurring_group(recurring_id)));

drop policy if exists "recurring_shares_all" on splitwisely.recurring_expense_shares;
create policy "recurring_shares_all" on splitwisely.recurring_expense_shares
  for all to authenticated
  using (splitwisely.can_use() and splitwisely.has_group_access(splitwisely.recurring_group(recurring_id)))
  with check (splitwisely.can_use() and splitwisely.has_group_access(splitwisely.recurring_group(recurring_id)));

create index if not exists idx_recurring_group   on splitwisely.recurring_expenses (group_id);
create index if not exists idx_rec_payers         on splitwisely.recurring_expense_payers (recurring_id);
create index if not exists idx_rec_shares         on splitwisely.recurring_expense_shares (recurring_id);
create index if not exists idx_expenses_recurring on splitwisely.expenses (recurring_id);

grant select, insert, update, delete
  on splitwisely.recurring_expenses, splitwisely.recurring_expense_payers,
     splitwisely.recurring_expense_shares
  to authenticated;
grant execute on all functions in schema splitwisely to authenticated;

-- Recarrega a cache de schema do PostgREST já — sem isto, colunas novas
-- (ex.: group_members.settle_with) podem demorar a aparecer na Data API
-- e a app dá «Could not find the column ... in the schema cache».
notify pgrst, 'reload schema';

-- ============================================================
-- LIMPEZA (opcional): se chegaste a correr a versão ANTIGA deste
-- schema (que criava tudo em `public` + trigger em auth.users),
-- descomenta e corre este bloco UMA vez para a remover:
--
-- drop trigger if exists on_auth_user_created on auth.users;
-- drop function if exists public.handle_new_user();
-- drop function if exists public.claim_memberships();
-- drop function if exists public.has_group_access(uuid);
-- drop function if exists public.expense_group(uuid);
-- drop table if exists public.expense_shares;
-- drop table if exists public.expense_payers;
-- drop table if exists public.expenses;
-- drop table if exists public.group_members;
-- drop table if exists public.groups;
-- drop table if exists public.profiles;
-- ============================================================
