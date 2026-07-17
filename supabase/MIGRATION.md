# Importar do Splitwise → SplitWisely

Ferramenta para migrar o histórico de um grupo do **Splitwise** para um grupo
já existente na SplitWisely (Supabase). Feita para o grupo **Gidos** (Diogo +
Margarida), mas serve qualquer grupo de **2 pessoas**.

## Como funciona (validação de coerência)

O export do Splitwise («Export as spreadsheet») tem, por linha, o **impacto
líquido** de cada pessoa nessa transação — `pagou − quota`. Num grupo de duas
pessoas as duas colunas somam sempre **0**. A partir do custo e desses dois
líquidos reconstruímos, sem ambiguidade **para o saldo**:

- **pagador** = a pessoa com líquido **positivo** paga o custo todo;
- **quota do outro** = o seu líquido negativo (em valor absoluto);
- **quota do pagador** = `custo − quota do outro`.

Qualquer decomposição com os mesmos líquidos dá o mesmo saldo, por isso esta
(um pagador só por despesa) **reproduz o saldo final ao cêntimo**. As linhas de
categoria `Payment` são acertos de contas e vão para a tabela `payments`
(`from` = quem pagou, `to` = quem recebeu). Linhas noutra moeda que não a do
grupo (ex.: `USD`) e o rodapé `Total balance` são ignorados.

O SQL gerado corre numa **transação única** e no fim **recalcula o saldo**; se
não bater certo com o valor esperado (`--expect-balance-a`), faz **rollback** —
ou entra tudo, ou nada.

## Passos

1. No Splitwise, exporta o grupo para CSV (colunas
   `Date,Description,Category,Cost,Currency,<PessoaB>,<PessoaA>`).

2. Garante que o **grupo e os dois membros já existem** na app (a importação
   liga-se a eles pelo nome; não cria nada disso).

3. Gera o SQL:

   ```bash
   python3 supabase/migrate_splitwise.py EXPORT.csv \
     --group "Gidos" --currency EUR \
     --member-a "Diogo" --member-b "Margarida" \
     --expect-balance-a 24.60 \
     -o migrate_gidos.sql
   ```

   - `--member-a` é a pessoa da **última** coluna de líquidos do CSV.
   - `--expect-balance-a` é o saldo final dessa pessoa (**+** = tem a receber).
     No export de exemplo o Diogo tem +24,60 (a Margarida deve-lhe 24,60 €).

   Se houver **outros grupos com pessoas do mesmo nome**, fixa os UUIDs em vez
   de resolver por nome (o script verifica que cada membro pertence mesmo ao
   grupo e aborta caso contrário):

   ```bash
   python3 supabase/migrate_splitwise.py EXPORT.csv \
     --group-id      c36e5a26-8b18-4259-99e2-d3fdb9c871bb \
     --member-a-id   e4f18919-648a-45e8-ba37-54b2f43b2e81 \
     --member-b-id   d34d1d69-4fbe-445d-83fa-0bafdd6a62b2 \
     --expect-balance-a 24.60 -o migrate_gidos.sql
   ```

4. Abre o **SQL Editor** do Supabase, cola o conteúdo de `migrate_gidos.sql` e
   executa. No fim aparece um `NOTICE` com as contagens e o saldo reconstruído.
   Volta a correr é seguro: um *guard* aborta se o grupo já tiver despesas ou
   pagamentos (para não duplicar).

## Notas

- **Categorias**: as do Splitwise (EN) são mapeadas para as da app (ver
  `CATEGORY_MAP` no script). `General` fica sem categoria. Ajusta o mapa se
  quiseres outra correspondência.
- **Modo de divisão**: as despesas entram como `exact` (quotas em valor
  exato), por isso reabrem com os valores corretos independentemente dos pesos
  do grupo. Os pesos (0,55 / 0,45) aplicam-se às despesas **novas** daqui para a
  frente.
- O `migrate_*.sql` gerado contém o histórico financeiro completo — está no
  `.gitignore` de propósito. Guarda-o em sítio privado; não o comites.
