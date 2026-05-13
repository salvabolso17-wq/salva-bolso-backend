"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateInsights = generateInsights;
const client_1 = __importDefault(require("../db/client"));
// ─── Helpers ──────────────────────────────────────────────────────────────────
const DIAS_SEMANA = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
function round2(n) {
    return Math.round(n * 100) / 100;
}
function classifyScore(score) {
    if (score >= 80)
        return "excelente";
    if (score >= 60)
        return "bom";
    if (score >= 40)
        return "regular";
    if (score >= 20)
        return "atencao";
    return "critico";
}
function diasNoPeriodo(inicio, fim) {
    return Math.max(1, Math.round((fim.getTime() - inicio.getTime()) / 86400000));
}
async function fetchRawData(userId, inicio, fim) {
    const mesRef = inicio.toISOString().slice(0, 10);
    const [totaisRes, catRes, diaRes, goalsRes] = await Promise.all([
        client_1.default.query(`SELECT
         COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN valor ELSE 0 END), 0) AS total_entradas,
         COALESCE(SUM(CASE WHEN tipo = 'saida'   THEN valor ELSE 0 END), 0) AS total_saidas,
         COUNT(*)                                                            AS qtd_transacoes,
         COUNT(CASE WHEN tipo = 'saida' THEN 1 END)                         AS qtd_saidas
       FROM transactions
       WHERE user_id = $1 AND criado_em >= $2 AND criado_em < $3`, [userId, inicio, fim]),
        client_1.default.query(`SELECT
         COALESCE(categoria, 'Sem categoria') AS categoria,
         SUM(valor) AS total,
         COUNT(*)   AS qtd
       FROM transactions
       WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2 AND criado_em < $3
       GROUP BY categoria
       ORDER BY total DESC`, [userId, inicio, fim]),
        client_1.default.query(`SELECT EXTRACT(DOW FROM criado_em)::INT AS dia_num, SUM(valor) AS total
       FROM transactions
       WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2 AND criado_em < $3
       GROUP BY dia_num
       ORDER BY total DESC
       LIMIT 1`, [userId, inicio, fim]),
        client_1.default.query(`SELECT
         fg.categoria,
         fg.valor_meta,
         COALESCE(SUM(t.valor), 0) AS valor_gasto
       FROM financial_goals fg
       LEFT JOIN transactions t
         ON  t.user_id   = fg.user_id
         AND t.categoria = fg.categoria
         AND t.tipo      = 'saida'
         AND DATE_TRUNC('month', t.criado_em) = DATE_TRUNC('month', fg.mes_referencia)
       WHERE fg.user_id = $1
         AND fg.mes_referencia = $2::DATE
       GROUP BY fg.id, fg.categoria, fg.valor_meta`, [userId, mesRef]),
    ]);
    const t = totaisRes.rows[0];
    return {
        total_entradas: Number(t.total_entradas),
        total_saidas: Number(t.total_saidas),
        qtd_transacoes: Number(t.qtd_transacoes),
        qtd_saidas: Number(t.qtd_saidas),
        categorias: catRes.rows.map((r) => ({
            categoria: r.categoria,
            total: Number(r.total),
            qtd: Number(r.qtd),
        })),
        dia_semana_top: diaRes.rows[0] ? Number(diaRes.rows[0].dia_num) : null,
        goals: goalsRes.rows.map((r) => ({
            categoria: r.categoria,
            valor_meta: Number(r.valor_meta),
            valor_gasto: Number(r.valor_gasto),
        })),
    };
}
// ─── Score ────────────────────────────────────────────────────────────────────
function calcScore(curr, prev) {
    const fatores = [];
    // Fator 1 — Taxa de economia (35 pts)
    const taxaEcon = curr.total_entradas > 0
        ? ((curr.total_entradas - curr.total_saidas) / curr.total_entradas) * 100
        : 0;
    let ptsEcon = 0;
    if (taxaEcon >= 30)
        ptsEcon = 35;
    else if (taxaEcon >= 20)
        ptsEcon = 25;
    else if (taxaEcon >= 10)
        ptsEcon = 15;
    else if (taxaEcon >= 0)
        ptsEcon = 5;
    fatores.push({
        fator: "Taxa de economia",
        pontos: ptsEcon,
        max_pontos: 35,
        descricao: `${round2(taxaEcon)}% das entradas foram economizadas`,
    });
    // Fator 2 — Evolução vs período anterior (25 pts)
    let ptsEvol = 0;
    const saidasDiminuiram = prev.total_saidas > 0 && curr.total_saidas < prev.total_saidas;
    const entradasAumentaram = prev.total_entradas > 0 && curr.total_entradas > prev.total_entradas;
    if (saidasDiminuiram)
        ptsEvol += 15;
    if (entradasAumentaram)
        ptsEvol += 10;
    fatores.push({
        fator: "Evolução financeira",
        pontos: ptsEvol,
        max_pontos: 25,
        descricao: [
            saidasDiminuiram ? "gastos reduziram" : "gastos aumentaram",
            entradasAumentaram ? "entradas cresceram" : "entradas estáveis ou menores",
        ].join(", "),
    });
    // Fator 3 — Cumprimento de metas (25 pts)
    let ptsMetas = 10; // neutro quando sem metas
    if (curr.goals.length > 0) {
        const dentro = curr.goals.filter((g) => g.valor_gasto <= g.valor_meta).length;
        const perc = dentro / curr.goals.length;
        ptsMetas = perc === 1 ? 25 : perc >= 0.5 ? 15 : 5;
    }
    fatores.push({
        fator: "Cumprimento de metas",
        pontos: ptsMetas,
        max_pontos: 25,
        descricao: curr.goals.length === 0
            ? "Nenhuma meta definida"
            : `${curr.goals.filter((g) => g.valor_gasto <= g.valor_meta).length}/${curr.goals.length} metas cumpridas`,
    });
    // Fator 4 — Regularidade (15 pts)
    let ptsReg = 0;
    if (curr.qtd_transacoes >= 10)
        ptsReg = 15;
    else if (curr.qtd_transacoes >= 5)
        ptsReg = 10;
    else if (curr.qtd_transacoes >= 1)
        ptsReg = 5;
    fatores.push({
        fator: "Regularidade de uso",
        pontos: ptsReg,
        max_pontos: 15,
        descricao: `${curr.qtd_transacoes} transações no período`,
    });
    const score = fatores.reduce((acc, f) => acc + f.pontos, 0);
    return { score, classificacao: classifyScore(score), fatores };
}
// ─── Insights ─────────────────────────────────────────────────────────────────
function gerarInsights(curr, prev) {
    const insights = [];
    // Saldo positivo
    const saldo = curr.total_entradas - curr.total_saidas;
    if (saldo > 0) {
        insights.push({
            tipo: "positivo",
            titulo: "Saldo positivo",
            descricao: `Você economizou R$ ${saldo.toFixed(2)} neste período.`,
            valor: saldo,
        });
    }
    // Entradas cresceram
    if (prev.total_entradas > 0 && curr.total_entradas > prev.total_entradas) {
        const perc = round2(((curr.total_entradas - prev.total_entradas) / prev.total_entradas) * 100);
        insights.push({
            tipo: "positivo",
            titulo: "Entradas cresceram",
            descricao: `Suas receitas aumentaram ${perc}% em relação ao período anterior.`,
            valor: perc,
        });
    }
    // Gastos diminuíram
    if (prev.total_saidas > 0 && curr.total_saidas < prev.total_saidas) {
        const perc = round2(((prev.total_saidas - curr.total_saidas) / prev.total_saidas) * 100);
        insights.push({
            tipo: "positivo",
            titulo: "Gastos reduziram",
            descricao: `Você gastou ${perc}% menos que no período anterior.`,
            valor: perc,
        });
    }
    // Aumento por categoria
    const prevCatMap = new Map(prev.categorias.map((c) => [c.categoria, c.total]));
    for (const cat of curr.categorias) {
        const anterior = prevCatMap.get(cat.categoria) ?? 0;
        if (anterior === 0)
            continue;
        const perc = ((cat.total - anterior) / anterior) * 100;
        if (perc >= 50) {
            insights.push({
                tipo: "critico",
                titulo: `Gasto crítico em ${cat.categoria}`,
                descricao: `Você gastou ${round2(perc)}% a mais em ${cat.categoria} vs período anterior (R$ ${cat.total.toFixed(2)}).`,
                categoria: cat.categoria,
                valor: round2(perc),
            });
        }
        else if (perc >= 20) {
            insights.push({
                tipo: "alerta",
                titulo: `Gasto aumentou em ${cat.categoria}`,
                descricao: `${cat.categoria} cresceu ${round2(perc)}% vs período anterior (R$ ${cat.total.toFixed(2)}).`,
                categoria: cat.categoria,
                valor: round2(perc),
            });
        }
    }
    // Categoria dominante (> 40% dos gastos)
    if (curr.total_saidas > 0 && curr.categorias.length > 0) {
        const top = curr.categorias[0];
        const perc = (top.total / curr.total_saidas) * 100;
        if (perc > 40) {
            insights.push({
                tipo: "informativo",
                titulo: `${top.categoria} concentra seus gastos`,
                descricao: `${round2(perc)}% de todos os seus gastos foram em ${top.categoria} (R$ ${top.total.toFixed(2)}).`,
                categoria: top.categoria,
                valor: round2(perc),
            });
        }
    }
    // Metas excedidas
    for (const g of curr.goals) {
        if (g.valor_gasto > g.valor_meta) {
            const excesso = round2(g.valor_gasto - g.valor_meta);
            insights.push({
                tipo: "critico",
                titulo: `Meta excedida: ${g.categoria}`,
                descricao: `Você ultrapassou a meta de ${g.categoria} em R$ ${excesso.toFixed(2)}.`,
                categoria: g.categoria,
                valor: excesso,
            });
        }
        else if (g.valor_gasto >= g.valor_meta * 0.8) {
            const perc = round2((g.valor_gasto / g.valor_meta) * 100);
            insights.push({
                tipo: "alerta",
                titulo: `Meta em alerta: ${g.categoria}`,
                descricao: `Você usou ${perc}% da meta de ${g.categoria}.`,
                categoria: g.categoria,
                valor: perc,
            });
        }
    }
    return insights;
}
// ─── Indicadores ─────────────────────────────────────────────────────────────
function calcIndicadores(curr, inicio, fim) {
    const dias = diasNoPeriodo(inicio, fim);
    const taxaEcon = curr.total_entradas > 0
        ? round2(((curr.total_entradas - curr.total_saidas) / curr.total_entradas) * 100)
        : 0;
    return {
        taxa_economia_percentual: taxaEcon,
        media_gastos_diarios: round2(curr.total_saidas / dias),
        dia_semana_maior_gasto: curr.dia_semana_top !== null ? DIAS_SEMANA[curr.dia_semana_top] ?? null : null,
        categoria_mais_frequente: curr.categorias[0]?.categoria ?? null,
        ticket_medio_saida: curr.qtd_saidas > 0 ? round2(curr.total_saidas / curr.qtd_saidas) : 0,
        total_transacoes: curr.qtd_transacoes,
    };
}
// ─── Public API ───────────────────────────────────────────────────────────────
async function generateInsights(userId, inicioPeriodo, fimPeriodo, inicioAnterior, fimAnterior) {
    const [curr, prev] = await Promise.all([
        fetchRawData(userId, inicioPeriodo, fimPeriodo),
        fetchRawData(userId, inicioAnterior, fimAnterior),
    ]);
    const todosInsights = gerarInsights(curr, prev);
    const alertas = todosInsights.filter((i) => i.tipo === "alerta" || i.tipo === "critico");
    const insights_textuais = todosInsights.filter((i) => i.tipo === "positivo" || i.tipo === "informativo");
    const fimInclusivo = new Date(fimPeriodo);
    fimInclusivo.setUTCDate(fimInclusivo.getUTCDate() - 1);
    return {
        periodo: {
            inicio: inicioPeriodo.toISOString().slice(0, 10),
            fim: fimInclusivo.toISOString().slice(0, 10),
        },
        insights_textuais,
        alertas,
        indicadores_financeiros: calcIndicadores(curr, inicioPeriodo, fimPeriodo),
        score_financeiro: calcScore(curr, prev),
    };
}
