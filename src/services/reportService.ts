import pool from "../db/client";

export interface CategoryData {
  categoria: string;
  total: number;
  percentual: number;
}

export interface DailyData {
  data: string;
  entradas: number;
  saidas: number;
}

export interface PeriodMetrics {
  total_entradas: number;
  total_saidas: number;
  saldo: number;
  quantidade_transacoes: number;
  categoria_top: string | null;
  gastos_por_categoria: CategoryData[];
  graph_data: DailyData[];
}

export interface ReportData {
  periodo: { inicio: string; fim: string };
  total_entradas: number;
  total_saidas: number;
  saldo: number;
  quantidade_transacoes: number;
  categoria_que_mais_gastou: string | null;
  gastos_por_categoria: CategoryData[];
  comparativo: {
    periodo_anterior: { inicio: string; fim: string };
    total_entradas: number;
    total_saidas: number;
    saldo: number;
    variacao_entradas_percentual: number | null;
    variacao_saidas_percentual: number | null;
    variacao_saldo_percentual: number | null;
  };
  resumo_textual: string;
  graph_data: DailyData[];
}

function calcVariacao(atual: number, anterior: number): number | null {
  if (anterior === 0) return null;
  return Math.round(((atual - anterior) / Math.abs(anterior)) * 10000) / 100;
}

function toDateStr(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function gerarResumo(
  atual: PeriodMetrics,
  anterior: PeriodMetrics,
  tipo: "mensal" | "semanal"
): string {
  const periodo = tipo === "mensal" ? "mês" : "semana";
  const partes: string[] = [];

  if (atual.saldo > 0) {
    partes.push(`Você economizou R$ ${atual.saldo.toFixed(2)} neste ${periodo}.`);
  } else if (atual.saldo < 0) {
    partes.push(`Atenção: seus gastos superaram as entradas em R$ ${Math.abs(atual.saldo).toFixed(2)}.`);
  } else {
    partes.push(`Entradas e saídas ficaram equilibradas neste ${periodo}.`);
  }

  const varSaidas = calcVariacao(atual.total_saidas, anterior.total_saidas);
  if (varSaidas !== null) {
    if (varSaidas > 0) {
      partes.push(`Você gastou ${varSaidas}% a mais que no ${periodo} anterior.`);
    } else if (varSaidas < 0) {
      partes.push(`Você gastou ${Math.abs(varSaidas)}% a menos que no ${periodo} anterior.`);
    } else {
      partes.push(`Seus gastos ficaram estáveis em relação ao ${periodo} anterior.`);
    }
  }

  if (atual.categoria_top) {
    const top = atual.gastos_por_categoria[0];
    partes.push(
      `Maior gasto: ${atual.categoria_top} (R$ ${top.total.toFixed(2)}, ${top.percentual}% do total).`
    );
  }

  return partes.join(" ");
}

export async function fetchPeriodMetrics(
  userId: number,
  inicio: Date,
  fim: Date
): Promise<PeriodMetrics> {
  const [totaisRes, categoriasRes, graphRes] = await Promise.all([
    pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN valor ELSE 0 END), 0) AS total_entradas,
         COALESCE(SUM(CASE WHEN tipo = 'saida'   THEN valor ELSE 0 END), 0) AS total_saidas,
         COUNT(*) AS quantidade_transacoes
       FROM transactions
       WHERE user_id = $1
         AND criado_em >= $2
         AND criado_em < $3`,
      [userId, inicio, fim]
    ),
    pool.query(
      `SELECT
         COALESCE(categoria, 'Sem categoria') AS categoria,
         SUM(valor) AS total
       FROM transactions
       WHERE user_id = $1
         AND tipo = 'saida'
         AND criado_em >= $2
         AND criado_em < $3
       GROUP BY categoria
       ORDER BY total DESC`,
      [userId, inicio, fim]
    ),
    pool.query(
      `SELECT
         DATE_TRUNC('day', criado_em)::DATE AS data,
         COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN valor ELSE 0 END), 0) AS entradas,
         COALESCE(SUM(CASE WHEN tipo = 'saida'   THEN valor ELSE 0 END), 0) AS saidas
       FROM transactions
       WHERE user_id = $1
         AND criado_em >= $2
         AND criado_em < $3
       GROUP BY DATE_TRUNC('day', criado_em)
       ORDER BY data`,
      [userId, inicio, fim]
    ),
  ]);

  const { total_entradas, total_saidas, quantidade_transacoes } = totaisRes.rows[0];
  const totalSaidas = Number(total_saidas);
  const totalEntradas = Number(total_entradas);

  const gastos_por_categoria: CategoryData[] = categoriasRes.rows.map((row) => ({
    categoria: row.categoria,
    total: Number(row.total),
    percentual: totalSaidas > 0
      ? Math.round((Number(row.total) / totalSaidas) * 10000) / 100
      : 0,
  }));

  const graph_data: DailyData[] = graphRes.rows.map((row) => ({
    data: toDateStr(row.data),
    entradas: Number(row.entradas),
    saidas: Number(row.saidas),
  }));

  return {
    total_entradas: totalEntradas,
    total_saidas: totalSaidas,
    saldo: totalEntradas - totalSaidas,
    quantidade_transacoes: Number(quantidade_transacoes),
    categoria_top: gastos_por_categoria[0]?.categoria ?? null,
    gastos_por_categoria,
    graph_data,
  };
}

export async function buildReport(
  userId: number,
  inicioPeriodo: Date,
  fimPeriodo: Date,
  inicioAnterior: Date,
  fimAnterior: Date,
  tipo: "mensal" | "semanal"
): Promise<ReportData> {
  const [atual, anterior] = await Promise.all([
    fetchPeriodMetrics(userId, inicioPeriodo, fimPeriodo),
    fetchPeriodMetrics(userId, inicioAnterior, fimAnterior),
  ]);

  const fimInclusivo = new Date(fimPeriodo);
  fimInclusivo.setUTCDate(fimInclusivo.getUTCDate() - 1);

  const fimAnteriorInclusivo = new Date(fimAnterior);
  fimAnteriorInclusivo.setUTCDate(fimAnteriorInclusivo.getUTCDate() - 1);

  return {
    periodo: {
      inicio: inicioPeriodo.toISOString().slice(0, 10),
      fim: fimInclusivo.toISOString().slice(0, 10),
    },
    total_entradas: atual.total_entradas,
    total_saidas: atual.total_saidas,
    saldo: atual.saldo,
    quantidade_transacoes: atual.quantidade_transacoes,
    categoria_que_mais_gastou: atual.categoria_top,
    gastos_por_categoria: atual.gastos_por_categoria,
    comparativo: {
      periodo_anterior: {
        inicio: inicioAnterior.toISOString().slice(0, 10),
        fim: fimAnteriorInclusivo.toISOString().slice(0, 10),
      },
      total_entradas: anterior.total_entradas,
      total_saidas: anterior.total_saidas,
      saldo: anterior.saldo,
      variacao_entradas_percentual: calcVariacao(atual.total_entradas, anterior.total_entradas),
      variacao_saidas_percentual: calcVariacao(atual.total_saidas, anterior.total_saidas),
      variacao_saldo_percentual: calcVariacao(atual.saldo, anterior.saldo),
    },
    resumo_textual: gerarResumo(atual, anterior, tipo),
    graph_data: atual.graph_data,
  };
}
