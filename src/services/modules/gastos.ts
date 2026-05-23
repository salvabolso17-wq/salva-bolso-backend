import pool from "../../db/client";

export interface FixaRow {
  titulo:         string;
  valor:          number;
  dia_vencimento: number;
}

export interface DiaLancamento {
  id:        number;
  descricao: string;
  valor:     number;
  categoria: string;
  criado_em: Date;
}

export interface CategoriaTotal {
  categoria: string;
  total:     number;
}

export interface ResumoMes {
  ano:                    number;
  mes:                    number;
  fixas:                  FixaRow[];
  dia_a_dia_lancamentos:  DiaLancamento[];
  porCategoriaDiaADia:    CategoriaTotal[];
  total_fixas:            number;
  total_dia:              number;
  total_geral:            number;
  qtd_lancamentos:        number;
  renda:                  number | null;
}

export async function resumoMesAtual(userId: number): Promise<ResumoMes> {
  // Mês BRT atual
  const dateRow = await pool.query<{ ano: number; mes: number }>(
    `SELECT EXTRACT(YEAR  FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int AS ano,
            EXTRACT(MONTH FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int AS mes`
  );
  const { ano, mes } = dateRow.rows[0];

  // 1) Fixas (lembretes pendentes do user) — ordenado por valor desc
  const fixasRes = await pool.query<{ titulo: string; valor: string; dia_vencimento: number }>(
    `SELECT titulo, valor, dia_vencimento
     FROM lembretes
     WHERE user_id = $1 AND fixa = TRUE AND status = 'pendente'
     ORDER BY valor DESC, titulo ASC`,
    [userId]
  );
  const fixas: FixaRow[] = fixasRes.rows.map(r => ({
    titulo:         r.titulo,
    valor:          Number(r.valor),
    dia_vencimento: r.dia_vencimento,
  }));
  const total_fixas = fixas.reduce((s, f) => s + f.valor, 0);

  // 2) Transações do mês (saida) com flag eh_fixa
  const txRes = await pool.query<{
    id: number; descricao: string; valor: string; categoria: string; criado_em: Date; eh_fixa: boolean;
  }>(
    `SELECT t.id, t.descricao, t.valor, t.categoria, t.criado_em,
            EXISTS (
              SELECT 1 FROM lembretes l
              WHERE l.user_id = $1 AND l.fixa = TRUE
                AND LOWER(t.descricao) ILIKE '%' || LOWER(l.titulo) || '%'
            ) AS eh_fixa
     FROM transactions t
     WHERE t.user_id = $1
       AND t.tipo = 'saida'
       AND date_trunc('month', t.criado_em) = date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))
     ORDER BY t.criado_em ASC`,
    [userId]
  );

  const dia_a_dia_lancamentos: DiaLancamento[] = [];
  for (const r of txRes.rows) {
    if (r.eh_fixa) continue;
    dia_a_dia_lancamentos.push({
      id:        r.id,
      descricao: r.descricao ?? "",
      valor:     Number(r.valor),
      categoria: r.categoria ?? "Outros",
      criado_em: r.criado_em,
    });
  }

  const total_dia = dia_a_dia_lancamentos.reduce((s, l) => s + l.valor, 0);

  // 3) Agrupar dia-a-dia por categoria (omitindo total 0)
  const mapaCat = new Map<string, number>();
  for (const l of dia_a_dia_lancamentos) {
    const cat = l.categoria || "Outros";
    mapaCat.set(cat, (mapaCat.get(cat) ?? 0) + l.valor);
  }
  const porCategoriaDiaADia: CategoriaTotal[] = [...mapaCat.entries()]
    .filter(([, total]) => total > 0)
    .map(([categoria, total]) => ({ categoria, total }))
    .sort((a, b) => b.total - a.total);

  // 4) Renda do user
  const userRes = await pool.query<{ renda: string | null }>(
    `SELECT renda FROM users WHERE id = $1`,
    [userId]
  );
  const rendaRaw = userRes.rows[0]?.renda;
  let rendaNum = rendaRaw != null ? Number(rendaRaw) : 0;
  if (rendaNum === 0) {
    const entRes = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(valor), 0) AS total FROM transactions
       WHERE user_id = $1 AND tipo = 'entrada'
         AND date_trunc('month', criado_em AT TIME ZONE 'America/Sao_Paulo') =
             date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')`,
      [userId],
    );
    rendaNum = Number(entRes.rows[0].total);
  }
  const renda: number | null = rendaNum > 0 ? rendaNum : null;

  return {
    ano,
    mes,
    fixas,
    dia_a_dia_lancamentos,
    porCategoriaDiaADia,
    total_fixas,
    total_dia,
    total_geral:     total_fixas + total_dia,
    qtd_lancamentos: fixas.length + dia_a_dia_lancamentos.length,
    renda,
  };
}
