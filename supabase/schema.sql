-- ============================================================
-- SplitWisely — Schema Supabase
-- Executar no SQL Editor do teu projeto Supabase (uma vez).
-- ============================================================

-- ---------- PERFIS (espelho de auth.users) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.email,
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do update
    set full_name  = excluded.full_name,
        email      = excluded.email,
        avatar_url = excluded.avatar_url;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- GRUPOS / EVENTOS ----------
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  currency text not null default 'EUR',
  created_by uuid not null references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- ---------- MEMBROS DE CADA GRUPO ----------
-- Uma "pessoa" do grupo. Pode estar ligada a um utilizador registado
-- (user_id) ou ser apenas um nome. Se tiver email, é ligada
-- automaticamente quando esse utilizador fizer login (claim_memberships).
-- default_weight  -> proporção default na divisão de despesas (0 = não entra)
-- is_default_payer-> pré-selecionado como pagador nas novas despesas
create table if not exists public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  name text not null,
  email text,
  user_id uuid references auth.users (id) on delete set null,
  default_weight numeric not null default 1 check (default_weight >= 0),
  is_default_payer boolean not null default false,
  created_at timestamptz not null default now(),
  unique (group_id, user_id)
);

-- ---------- DESPESAS ----------
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  expense_date date not null default current_date,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- Quem pagou (uma ou mais pessoas)
create table if not exists public.expense_payers (
  expense_id uuid not null references public.expenses (id) on delete cascade,
  member_id uuid not null references public.group_members (id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  primary key (expense_id, member_id)
);

-- Por quem se divide (uma ou mais pessoas), já em valor final
create table if not exists public.expense_shares (
  expense_id uuid not null references public.expenses (id) on delete cascade,
  member_id uuid not null references public.group_members (id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  primary key (expense_id, member_id)
);

-- ---------- FUNÇÃO DE ACESSO (evita recursão nas policies) ----------
-- Tem acesso ao grupo: quem o criou (mesmo sem participar) ou quem
-- é membro com conta ligada.
create or replace function public.has_group_access(gid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.groups g
    where g.id = gid and g.created_by = auth.uid()
  )
  or exists (
    select 1 from public.group_members m
    where m.group_id = gid and m.user_id = auth.uid()
  );
$$;

create or replace function public.expense_group(eid uuid)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select group_id from public.expenses where id = eid;
$$;

-- ---------- LIGAR CONVITES POR EMAIL AO FAZER LOGIN ----------
create or replace function public.claim_memberships()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
  my_email text;
begin
  select email into my_email from auth.users where id = auth.uid();
  if my_email is null then
    return 0;
  end if;

  update public.group_members m
     set user_id = auth.uid()
   where m.user_id is null
     and m.email is not null
     and lower(m.email) = lower(my_email)
     and not exists (
       select 1 from public.group_members x
       where x.group_id = m.group_id and x.user_id = auth.uid()
     );
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------- ROW LEVEL SECURITY ----------
alter table public.profiles       enable row level security;
alter table public.groups         enable row level security;
alter table public.group_members  enable row level security;
alter table public.expenses       enable row level security;
alter table public.expense_payers enable row level security;
alter table public.expense_shares enable row level security;

-- Perfis: qualquer utilizador autenticado pode ver nomes/avatares
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (id = auth.uid());

-- Grupos
drop policy if exists "groups_select" on public.groups;
create policy "groups_select" on public.groups
  for select to authenticated using (public.has_group_access(id));

drop policy if exists "groups_insert" on public.groups;
create policy "groups_insert" on public.groups
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "groups_update" on public.groups;
create policy "groups_update" on public.groups
  for update to authenticated using (created_by = auth.uid());

drop policy if exists "groups_delete" on public.groups;
create policy "groups_delete" on public.groups
  for delete to authenticated using (created_by = auth.uid());

-- Membros: quem tem acesso ao grupo gere tudo
drop policy if exists "members_all" on public.group_members;
create policy "members_all" on public.group_members
  for all to authenticated
  using (public.has_group_access(group_id))
  with check (public.has_group_access(group_id));

-- Despesas
drop policy if exists "expenses_all" on public.expenses;
create policy "expenses_all" on public.expenses
  for all to authenticated
  using (public.has_group_access(group_id))
  with check (public.has_group_access(group_id));

drop policy if exists "payers_all" on public.expense_payers;
create policy "payers_all" on public.expense_payers
  for all to authenticated
  using (public.has_group_access(public.expense_group(expense_id)))
  with check (public.has_group_access(public.expense_group(expense_id)));

drop policy if exists "shares_all" on public.expense_shares;
create policy "shares_all" on public.expense_shares
  for all to authenticated
  using (public.has_group_access(public.expense_group(expense_id)))
  with check (public.has_group_access(public.expense_group(expense_id)));

-- ---------- ÍNDICES ----------
create index if not exists idx_members_group  on public.group_members (group_id);
create index if not exists idx_members_user   on public.group_members (user_id);
create index if not exists idx_expenses_group on public.expenses (group_id, expense_date desc);
create index if not exists idx_payers_expense on public.expense_payers (expense_id);
create index if not exists idx_shares_expense on public.expense_shares (expense_id);
