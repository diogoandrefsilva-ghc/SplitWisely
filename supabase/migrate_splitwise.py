#!/usr/bin/env python3
# ============================================================
# SplitWisely — Gerador de migração a partir de um export Splitwise
#
# Lê um CSV exportado de um grupo Splitwise ("Export as spreadsheet")
# e escreve um ficheiro .sql pronto a colar no SQL Editor do Supabase,
# que importa todas as despesas e pagamentos para um grupo JÁ EXISTENTE
# na app (por defeito "Gidos"), com dois membros.
#
# O export do Splitwise (num grupo de 2 pessoas) tem, por linha, o
# *impacto líquido* de cada pessoa nessa transação:  pagou − quota.
# A soma das duas colunas é sempre 0. A partir do custo e desses dois
# líquidos reconstruímos, sem ambiguidade para o SALDO:
#   • pagador  = a pessoa com líquido POSITIVO paga o custo todo;
#   • quota do outro = |líquido negativo| ;  quota do pagador = custo − quota do outro.
# Qualquer decomposição com os mesmos líquidos dá o mesmo saldo, por isso
# esta (um pagador só) reproduz o saldo final ao cêntimo.
#
# Linhas com categoria "Payment" são acertos de contas -> tabela payments
# (from = quem pagou = líquido positivo, to = quem recebeu = líquido negativo).
# Linhas noutra moeda que não a do grupo e o rodapé "Total balance" são ignorados.
#
# Uso:
#   python3 migrate_splitwise.py EXPORT.csv > migrate_gidos.sql
#   python3 migrate_splitwise.py EXPORT.csv --group "Gidos" --currency EUR \
#           --member-a "Diogo" --member-b "Margarida" \
#           --expect-balance-a 24.60 -o migrate_gidos.sql
#
# member-a é a pessoa da 2.ª coluna de líquidos do CSV Splitwise
# (a que aparece por último no cabeçalho — no export "Gidos" é "Diogo Silva").
# expect-balance-a é o saldo final dessa pessoa (positivo = tem a receber);
# o SQL gerado ABORTA a transação se o resultado não bater certo.
# ============================================================
import argparse
import csv
import os
import sys
from decimal import Decimal, InvalidOperation

# Splitwise (EN)  ->  categoria da app (ver CATEGORIES em app.js). Sem entrada = sem categoria.
CATEGORY_MAP = {
    "Groceries": "mercearia",
    "Dining out": "restaurante",
    "Food and drink - Other": "restaurante",
    "Liquor": "outros",
    "Medical expenses": "saude",
    "Cleaning": "casa",
    "Household supplies": "casa",
    "Home - Other": "casa",
    "Rent": "casa",
    "Mortgage": "casa",
    "TV/Phone/Internet": "casa",
    "Furniture": "mobiliario",
    "Maintenance": "bricolage",
    "Gifts": "prendas",
    "Childcare": "filhos",
    "Clothing": "roupa",
    "Movies": "cinema",
    "Car": "transportes",
    "Gas/fuel": "transportes",
    "Bus/train": "transportes",
    "Taxi": "transportes",
    "Parking": "transportes",
    "Transportation - Other": "transportes",
    "Plane": "viagens",
    "Hotel": "viagens",
    "Sports": "outros",
    "Entertainment - Other": "outros",
    "Music": "outros",
    "Electronics": "outros",
    "Games": "outros",
    "Education": "outros",
    "Services": "outros",
    "Insurance": "outros",
    "Taxes": "outros",
    "Life - Other": "outros",
    "General": None,
}

CENT = Decimal("0.01")


def dec(s):
    s = (s or "").strip()
    if s == "":
        return None
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


def sql_str(s):
    return "'" + s.replace("'", "''") + "'"


def sql_cat(cat):
    mapped = CATEGORY_MAP.get(cat, None)
    return sql_str(mapped) if mapped else "null"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", help="CSV exportado do Splitwise")
    ap.add_argument("-o", "--out", help="ficheiro .sql de saída (default: stdout)")
    ap.add_argument("--group", default="Gidos", help="nome do grupo na app")
    ap.add_argument("--currency", default="EUR", help="moeda do grupo; outras linhas são ignoradas")
    ap.add_argument("--member-a", default="Diogo",
                    help="nome (prefixo) do membro da 2.ª coluna de líquidos")
    ap.add_argument("--member-b", default="Margarida",
                    help="nome (prefixo) do membro da 1.ª coluna de líquidos")
    ap.add_argument("--expect-balance-a", type=Decimal, default=None,
                    help="saldo final esperado do member-a (+ = a receber); valida e aborta se não bater")
    args = ap.parse_args()

    rows = []
    with open(args.csv, newline="", encoding="utf-8") as f:
        r = csv.reader(f)
        header = next(r)
        # Date,Description,Category,Cost,Currency,<B>,<A>
        for raw in r:
            if not raw or all((c or "").strip() == "" for c in raw):
                continue
            date, desc, cat, cost, cur, nb, na = (raw + [""] * 7)[:7]
            desc = desc.strip()
            if desc == "Total balance":
                continue
            if cur.strip() != args.currency:
                continue
            cost, nb, na = dec(cost), dec(nb), dec(na)
            if cost is None or na is None or nb is None:
                sys.stderr.write(f"AVISO: linha ignorada (valores em falta): {raw}\n")
                continue
            rows.append((date.strip(), desc, cat.strip(), cost, nb, na))

    expenses, payments = [], []
    bal_a = Decimal("0")  # saldo do member-a reconstruído (deve dar expect-balance-a)

    for date, desc, cat, cost, net_b, net_a in rows:
        if abs(net_a + net_b) > CENT:
            sys.stderr.write(f"AVISO: linha não fecha a zero: {desc} {net_a} {net_b}\n")
        bal_a += net_a
        if cat == "Payment":
            # from = líquido positivo (quem pagou), to = líquido negativo
            from_a = net_a > 0
            payments.append((date, desc, cost, from_a))
        else:
            # pagador = líquido positivo paga o custo todo
            a_pays = net_a > 0
            paid_a = cost if a_pays else Decimal("0")
            paid_b = cost if not a_pays else Decimal("0")
            share_a = paid_a - net_a          # sempre >= 0 e <= cost
            share_b = paid_b - net_b
            expenses.append((date, desc, cat, cost, paid_a, paid_b, share_a, share_b))

    out = open(args.out, "w", encoding="utf-8") if args.out else sys.stdout

    def w(line=""):
        out.write(line + "\n")

    ga = args.member_a
    gb = args.member_b
    w("-- ============================================================")
    w(f"-- SplitWisely — importação Splitwise -> grupo \"{args.group}\"")
    w(f"-- Gerado por supabase/migrate_splitwise.py a partir de: {os.path.basename(args.csv)}")
    w(f"-- Despesas: {len(expenses)}   Pagamentos: {len(payments)}   Moeda: {args.currency}")
    w("--")
    w("-- COMO CORRER: cola tudo no SQL Editor do Supabase e executa.")
    w("-- É uma transação única: ou entra tudo, ou nada (a validação final")
    w("-- do saldo aborta e faz rollback se algo não bater certo).")
    w("-- Pré-requisito: o grupo e os dois membros já existem na app.")
    w("-- ============================================================")
    w("begin;")
    w("")
    w("do $migrate$")
    w("declare")
    w("  g_id     uuid;")
    w("  m_a      uuid;  -- " + ga)
    w("  m_b      uuid;  -- " + gb)
    w("  n_exp    int;")
    w("  n_pay    int;")
    w("  bal_a    numeric;")
    w("begin")
    w("  -- ---- resolver o grupo e os membros (por nome) ----")
    w(f"  select id into g_id from splitwisely.groups")
    w(f"   where lower(name) = lower({sql_str(args.group)}) order by created_at limit 1;")
    w("  if g_id is null then")
    w(f"    raise exception 'Grupo % não encontrado. Cria-o na app antes de importar.', {sql_str(args.group)};")
    w("  end if;")
    w("")
    w(f"  select id into m_a from splitwisely.group_members")
    w(f"   where group_id = g_id and lower(name) like lower({sql_str(args.member_a + '%')}) order by created_at limit 1;")
    w(f"  select id into m_b from splitwisely.group_members")
    w(f"   where group_id = g_id and lower(name) like lower({sql_str(args.member_b + '%')}) order by created_at limit 1;")
    w("  if m_a is null or m_b is null then")
    w(f"    raise exception 'Membros % / % não encontrados no grupo %.', {sql_str(args.member_a)}, {sql_str(args.member_b)}, {sql_str(args.group)};")
    w("  end if;")
    w("")
    w("  -- ---- guarda contra dupla importação ----")
    w("  select count(*) into n_exp from splitwisely.expenses where group_id = g_id;")
    w("  select count(*) into n_pay from splitwisely.payments where group_id = g_id;")
    w("  if n_exp > 0 or n_pay > 0 then")
    w("    raise exception 'O grupo % já tem % despesas e % pagamentos. Aborto para não duplicar (apaga-os antes de re-importar).', "
      + f"{sql_str(args.group)}, n_exp, n_pay;")
    w("  end if;")
    w("")
    w("  -- ---- staging temporário (uma linha por transação) ----")
    w("  create temp table _mig (")
    w("    id          uuid not null default gen_random_uuid(),")
    w("    kind        text not null,")
    w("    edate       date not null,")
    w("    descr       text not null,")
    w("    category    text,")
    w("    cost        numeric(12,2) not null,")
    w("    paid_a      numeric(12,2) not null default 0,")
    w("    paid_b      numeric(12,2) not null default 0,")
    w("    share_a     numeric(12,2) not null default 0,")
    w("    share_b     numeric(12,2) not null default 0,")
    w("    from_a      boolean")
    w("  ) on commit drop;")
    w("")

    # -------- despesas --------
    w("  insert into _mig (kind, edate, descr, category, cost, paid_a, paid_b, share_a, share_b) values")
    for i, (date, desc, cat, cost, pa, pb, sa, sb) in enumerate(expenses):
        sep = "," if i < len(expenses) - 1 else ";"
        w(f"    ('expense', DATE {sql_str(date)}, {sql_str(desc)}, {sql_cat(cat)}, "
          f"{cost}, {pa}, {pb}, {sa}, {sb}){sep}")
    w("")

    # -------- pagamentos --------
    if payments:
        w("  insert into _mig (kind, edate, descr, cost, from_a) values")
        for i, (date, desc, cost, from_a) in enumerate(payments):
            sep = "," if i < len(payments) - 1 else ";"
            w(f"    ('payment', DATE {sql_str(date)}, {sql_str(desc)}, {cost}, {str(from_a).lower()}){sep}")
        w("")

    # -------- expandir para as tabelas reais --------
    w("  -- ---- despesas ----")
    w("  insert into splitwisely.expenses (id, group_id, description, amount, expense_date, split_mode, category)")
    w("    select id, g_id, descr, cost, edate, 'exact', category from _mig where kind = 'expense';")
    w("")
    w("  -- ---- quem pagou (um pagador por despesa, o custo todo) ----")
    w("  insert into splitwisely.expense_payers (expense_id, member_id, amount)")
    w("    select id, m_a, paid_a from _mig where kind = 'expense' and paid_a > 0")
    w("    union all")
    w("    select id, m_b, paid_b from _mig where kind = 'expense' and paid_b > 0;")
    w("")
    w("  -- ---- quotas (só as > 0) ----")
    w("  insert into splitwisely.expense_shares (expense_id, member_id, amount)")
    w("    select id, m_a, share_a from _mig where kind = 'expense' and share_a > 0")
    w("    union all")
    w("    select id, m_b, share_b from _mig where kind = 'expense' and share_b > 0;")
    w("")
    w("  -- ---- pagamentos (acertos de contas) ----")
    w("  insert into splitwisely.payments (group_id, from_member, to_member, amount, payment_date, note)")
    w("    select g_id,")
    w("           case when from_a then m_a else m_b end,")
    w("           case when from_a then m_b else m_a end,")
    w("           cost, edate, descr")
    w("      from _mig where kind = 'payment';")
    w("")
    w("  -- ---- validação: saldo reconstruído do " + ga + " ----")
    w("  -- saldo = pagou − quota + pagamentos_feitos − pagamentos_recebidos")
    w("  select")
    w("      coalesce((select sum(ep.amount) from splitwisely.expense_payers ep")
    w("                  join splitwisely.expenses e on e.id = ep.expense_id")
    w("                 where e.group_id = g_id and ep.member_id = m_a), 0)")
    w("    - coalesce((select sum(es.amount) from splitwisely.expense_shares es")
    w("                  join splitwisely.expenses e on e.id = es.expense_id")
    w("                 where e.group_id = g_id and es.member_id = m_a), 0)")
    w("    + coalesce((select sum(p.amount) from splitwisely.payments p")
    w("                 where p.group_id = g_id and p.from_member = m_a), 0)")
    w("    - coalesce((select sum(p.amount) from splitwisely.payments p")
    w("                 where p.group_id = g_id and p.to_member = m_a), 0)")
    w("    into bal_a;")
    w("  raise notice 'Importado: % despesas, % pagamentos. Saldo %: % (positivo = a receber).', "
      + f"(select count(*) from _mig where kind='expense'), (select count(*) from _mig where kind='payment'), {sql_str(ga)}, bal_a;")
    if args.expect_balance_a is not None:
        w(f"  if abs(bal_a - ({args.expect_balance_a})) > 0.01 then")
        w(f"    raise exception 'Saldo reconstruído (%) != esperado ({args.expect_balance_a}). Rollback.', bal_a;")
        w("  end if;")
    w("end;")
    w("$migrate$;")
    w("")
    w("commit;")

    if args.out:
        out.close()
        sys.stderr.write(f"Escrito {args.out}: {len(expenses)} despesas, {len(payments)} pagamentos.\n")


if __name__ == "__main__":
    main()
