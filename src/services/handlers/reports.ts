import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor, capitalizeFirst, MESES_NOME, CATEGORIAS_CONHECIDAS, normalizarCategoria, parseMesExtrato, CATEGORIA_EMOJI } from "../../utils/formatting";
import { fetchPeriodMetrics } from "../reportService";
import { parseValor } from "../../utils/parseTransaction";
import { recordAction } from "../conversationEngine";
import { checkAndSendOnboardingTip } from "../modules/insightsEngine";
import type { UserRow, ProcessResult } from "../types";

const DESAFIOS: Record<string, string[]> = {
  "Alimentação":  [
    "Cozinhar mais em casa costuma ser o maior corte por aqui.",
    "Delivery acumula rápido — pode valer reduzir.",
    "Planejar o mercado antes evita compras por impulso.",
  ],
  "Transporte":   [
    "Transporte público em alguns dias da semana faz diferença aqui.",
    "Caronas combinadas podem ajudar a reduzir esse gasto.",
    "Distâncias curtas de Uber acumulam mais do que parece.",
  ],
  "Lazer":        [
    "Opções gratuitas de lazer costumam ser mais do que imaginamos.",
    "Às vezes tem assinatura esquecida por aqui — vale checar.",
    "Saídas pagas têm um peso grande no mês.",
  ],
  "Saúde":        [
    "Genéricos podem custar menos sem perder qualidade.",
    "O plano de saúde cobre mais do que parece às vezes.",
  ],
  "Educação":     [
    "Antes de um novo curso, vale terminar os que já começou.",
    "Tem muito conteúdo gratuito de qualidade por aí.",
  ],
  "Moradia":      [
    "Aparelhos em standby consomem mais energia do que parece.",
    "Assinaturas que você menos usa podem estar pesando por aqui.",
  ],
};

export async function handleSaldoCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando saldo", { userId: user.id });

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const metrics = await fetchPeriodMetrics(user.id, inicioMes, fimMes);

  // Renda total = renda fixa cadastrada + renda extra cadastrada + entradas do mês
  const rendaFixa  = Number(user.renda      ?? 0);
  const rendaExtra = Number(user.renda_extra ?? 0);
  const totalRenda = rendaFixa + rendaExtra + metrics.total_entradas;
  const sobrou     = totalRenda - metrics.total_saidas;

  const meses = ["janeiro","fevereiro","março","abril","maio","junho",
                 "julho","agosto","setembro","outubro","novembro","dezembro"];

  // Renda ausente → mostra gastos parciais e captura renda contextualmente
  if (totalRenda === 0) {
    const linhasParcial = [`Gastos de ${meses[now.getMonth()]}/${now.getFullYear()}`, ""];
    if (metrics.gastos_por_categoria.length === 0) {
      linhasParcial.push("Nenhum gasto registrado este mês.");
    } else {
      for (const cat of metrics.gastos_por_categoria) {
        linhasParcial.push(`${cat.categoria}: ${fmtValor(cat.total)}`);
      }
      linhasParcial.push("", `Total: ${fmtValor(metrics.total_saidas)}`);
    }
    linhasParcial.push("", "Quanto você recebe por mês?", "", "Ex:", "• 3000", "• 4500 salário + 500 freelance");

    await pool.query(
      `INSERT INTO pending_actions (user_id, action, step, tx_ids)
       VALUES ($1, 'novo_mes', 'waiting_renda', '[]'::jsonb)
       ON CONFLICT (user_id) DO UPDATE
         SET action = 'novo_mes', step = 'waiting_renda', tx_ids = '[]'::jsonb,
             selected_tx_id = NULL, expires_at = NOW() + INTERVAL '30 minutes'`,
      [user.id]
    );

    try {
      await whatsapp.sendText({ to: telefone, text: linhasParcial.join("\n") });
      log.whatsapp("saldo parcial enviado — aguardando renda", { to: telefone });
    } catch (err) {
      log.error("falha ao enviar saldo parcial", err, { to: telefone });
    }
    return { success: false, userId: user.id, erro: "Aguardando renda" };
  }

  const linhas = [
    `Saldo de ${meses[now.getMonth()]}/${now.getFullYear()}`,
    "",
    `Renda: ${fmtValor(totalRenda)}`,
    `Gastos: ${fmtValor(metrics.total_saidas)}`,
    sobrou >= 0
      ? `💚 Sobrou: ${fmtValor(sobrou)}`
      : `🔴 No vermelho: ${fmtValor(Math.abs(sobrou))} a mais do que entrou`,
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("saldo enviado", { to: telefone, totalRenda, gastos: metrics.total_saidas, sobrou });
  } catch (err) {
    log.error("falha ao enviar saldo", err, { to: telefone });
  }

  recordAction(user.id, "queried_balance");
  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "saldo", totalRenda, gastos: metrics.total_saidas, sobrou },
  };
}

export async function handleResumoCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando resumo", { userId: user.id });

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const metrics = await fetchPeriodMetrics(user.id, inicioMes, fimMes);

  const meses = ["janeiro","fevereiro","março","abril","maio","junho",
                 "julho","agosto","setembro","outubro","novembro","dezembro"];

  const linhas = [`Resumo de ${meses[now.getMonth()]}/${now.getFullYear()}`, ""];

  if (metrics.gastos_por_categoria.length === 0) {
    linhas.push("Nenhum gasto registrado este mês.");
  } else {
    for (const cat of metrics.gastos_por_categoria) {
      linhas.push(`${cat.categoria}: ${fmtValor(cat.total)}`);
    }
    linhas.push("");
    linhas.push(`Total gasto: ${fmtValor(metrics.total_saidas)}`);
    if (metrics.categoria_top) {
      linhas.push(`Maior categoria: ${metrics.categoria_top}`);
    }
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("resumo enviado", { to: telefone, categorias: metrics.gastos_por_categoria.length });
  } catch (err) {
    log.error("falha ao enviar resumo", err, { to: telefone });
  }

  recordAction(user.id, "queried_summary");
  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "resumo", totalGasto: metrics.total_saidas, categorias: metrics.gastos_por_categoria.length },
  };
}

export async function handleExtratoCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("comando extrato", { userId: user.id, texto });

  const match = texto.match(/^extrato\s+(.+)$/i);
  const parsed = match ? parseMesExtrato(match[1]) : null;

  if (!parsed) {
    await whatsapp.sendText({
      to:   telefone,
      text: "💡 Ex:\nextrato março\nextrato 3\nextrato março/2026",
    });
    return { success: false, userId: user.id, erro: "Mês inválido" };
  }

  const { ano, mes } = parsed;
  const inicio = new Date(Date.UTC(ano, mes - 1, 1));
  const fim    = new Date(Date.UTC(ano, mes, 1));
  const metrics = await fetchPeriodMetrics(user.id, inicio, fim);

  const nomeMes = MESES_NOME[mes];
  const linhas = [`📋 Extrato de ${nomeMes}/${ano}`, ""];

  if (metrics.quantidade_transacoes === 0) {
    linhas.push("Nenhum lançamento neste mês.");
  } else {
    if (metrics.total_entradas > 0) linhas.push(`💰 Entradas: ${fmtValor(metrics.total_entradas)}`);
    linhas.push(`💸 Gastos: ${fmtValor(metrics.total_saidas)}`);
    const sinal = metrics.saldo >= 0 ? "+" : "-";
    linhas.push(`💼 Saldo: ${sinal}${fmtValor(Math.abs(metrics.saldo))}`, "");

    if (metrics.gastos_por_categoria.length > 0) {
      linhas.push("Por categoria:");
      for (const cat of metrics.gastos_por_categoria) {
        const emoji = CATEGORIA_EMOJI[cat.categoria] ?? "•";
        linhas.push(`${emoji} ${cat.categoria} — ${fmtValor(cat.total)}`);
      }
      linhas.push("");
    }

    linhas.push(`${metrics.quantidade_transacoes} transações`);
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("extrato enviado", { to: telefone, ano, mes, transacoes: metrics.quantidade_transacoes });
  } catch (err) {
    log.error("falha ao enviar extrato", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "extrato", ano, mes, transacoes: metrics.quantidade_transacoes },
  };
}

export async function handleHojeCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando hoje", { userId: user.id });

  const now      = new Date();
  const inicioDia = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const fimDia    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

  const result = await pool.query<{ descricao: string; valor: string }>(
    `SELECT descricao, valor
     FROM transactions
     WHERE user_id = $1
       AND tipo = 'saida'
       AND criado_em >= $2
       AND criado_em < $3
     ORDER BY criado_em DESC
     LIMIT 10`,
    [user.id, inicioDia, fimDia]
  );

  const linhas = ["Gastos de hoje", ""];

  if (result.rows.length === 0) {
    linhas.push("Nenhum gasto registrado hoje.");
  } else {
    let total = 0;
    for (const row of result.rows) {
      const valor = Number(row.valor);
      total += valor;
      linhas.push(`${row.descricao ?? "Sem descrição"} — R$ ${valor.toFixed(2)}`);
    }
    linhas.push("");
    linhas.push(`Total hoje: R$ ${total.toFixed(2)}`);
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("hoje enviado", { to: telefone, count: result.rows.length });
  } catch (err) {
    log.error("falha ao enviar hoje", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "hoje", count: result.rows.length },
  };
}

export async function handleListarGastosMesCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando listar gastos mes", { userId: user.id });

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const result = await pool.query<{ descricao: string; valor: string; categoria: string }>(
    `SELECT descricao, valor, categoria
     FROM transactions
     WHERE user_id = $1
       AND tipo = 'saida'
       AND criado_em >= $2
       AND criado_em < $3
     ORDER BY criado_em DESC
     LIMIT 50`,
    [user.id, inicioMes, fimMes]
  );

  const meses = ["janeiro","fevereiro","março","abril","maio","junho",
                 "julho","agosto","setembro","outubro","novembro","dezembro"];

  const linhas = [`Gastos de ${meses[now.getMonth()]}/${now.getFullYear()}`, ""];

  if (result.rows.length === 0) {
    linhas.push("Nenhum gasto registrado este mês.");
  } else {
    let total = 0;
    for (const row of result.rows) {
      const valor = Number(row.valor);
      total += valor;
      linhas.push(`${row.descricao ?? "Sem descrição"} — ${fmtValor(valor)}`);
    }
    linhas.push("");
    linhas.push(`Total: ${fmtValor(total)} (${result.rows.length} lançamentos)`);
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("listar gastos mes enviado", { to: telefone, count: result.rows.length });
  } catch (err) {
    log.error("falha ao enviar listar gastos mes", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "listar gastos mes", count: result.rows.length },
  };
}

export async function handleSemanaCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando semana", { userId: user.id });

  const now        = new Date();
  const inicio7d   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6));
  const fimHoje    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

  const result = await pool.query<{ categoria: string; total: string }>(
    `SELECT COALESCE(categoria, 'Outros') AS categoria, SUM(valor) AS total
     FROM transactions
     WHERE user_id = $1
       AND tipo = 'saida'
       AND criado_em >= $2
       AND criado_em < $3
     GROUP BY categoria
     ORDER BY total DESC`,
    [user.id, inicio7d, fimHoje]
  );

  const linhas = ["Gastos da semana", ""];

  if (result.rows.length === 0) {
    linhas.push("Nenhum gasto registrado nesta semana.");
  } else {
    let total = 0;
    for (const row of result.rows) {
      const valor = Number(row.total);
      total += valor;
      linhas.push(`${row.categoria} — R$ ${valor.toFixed(2)}`);
    }
    linhas.push("");
    linhas.push(`Total na semana: R$ ${total.toFixed(2)}`);
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("semana enviado", { to: telefone, categorias: result.rows.length });
  } catch (err) {
    log.error("falha ao enviar semana", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "semana", categorias: result.rows.length },
  };
}

export async function handleRankingCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando ranking", { userId: user.id });

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const meses = ["janeiro","fevereiro","março","abril","maio","junho",
                 "julho","agosto","setembro","outubro","novembro","dezembro"];

  const metrics = await fetchPeriodMetrics(user.id, inicioMes, fimMes);

  if (metrics.gastos_por_categoria.length === 0) {
    await whatsapp.sendText({ to: telefone, text: "Nenhum gasto registrado este mês." });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "ranking", count: 0 } };
  }

  const linhas = [`📊 Ranking de gastos de ${meses[now.getMonth()]}/${now.getFullYear()}`, ""];

  metrics.gastos_por_categoria.forEach((cat, i) => {
    const emoji = CATEGORIA_EMOJI[cat.categoria] ?? "•";
    linhas.push(`${i + 1}. ${emoji} ${cat.categoria} — ${fmtValor(cat.total)}`);
  });

  const top       = metrics.gastos_por_categoria[0];
  const percentTop = metrics.total_saidas > 0
    ? Math.round((top.total / metrics.total_saidas) * 100)
    : 0;

  linhas.push("", "Maior impacto:");
  linhas.push(`${top.categoria} representa ${percentTop}% dos gastos.`);

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("ranking enviado", { to: telefone, categorias: metrics.gastos_por_categoria.length });
  } catch (err) {
    log.error("falha ao enviar ranking", err, { to: telefone });
  }

  recordAction(user.id, "queried_other");
  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "ranking", categorias: metrics.gastos_por_categoria.length },
  };
}

export async function handleCompararCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando comparar", { userId: user.id });

  const now            = new Date();
  const inicioAtual    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimAtual       = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const inicioAnterior = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const fimAnterior    = inicioAtual;

  const [atual, anterior] = await Promise.all([
    fetchPeriodMetrics(user.id, inicioAtual, fimAtual),
    fetchPeriodMetrics(user.id, inicioAnterior, fimAnterior),
  ]);

  if (anterior.total_saidas === 0) {
    await whatsapp.sendText({ to: telefone, text: "Sem dados do mês anterior para comparar." });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "comparar" } };
  }

  // Variações por categoria — filtra ruído (< R$50) e mudanças irrelevantes (< 10%)
  const anteriorMap = new Map(anterior.gastos_por_categoria.map(c => [c.categoria, c.total]));
  type CatChange = { categoria: string; pct: number };
  const mudancas: CatChange[] = [];

  for (const cat of atual.gastos_por_categoria) {
    const antes = anteriorMap.get(cat.categoria) ?? 0;
    if (antes < 50 && cat.total < 50) continue;
    if (antes === 0) continue;
    const pct = Math.round(((cat.total - antes) / antes) * 100);
    if (Math.abs(pct) < 10) continue;
    mudancas.push({ categoria: cat.categoria, pct });
  }

  // Top 3 pelo maior |Δ%|
  mudancas.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  const top3 = mudancas.slice(0, 3);

  const linhas: string[] = ["📈 Comparado ao mês passado:", ""];

  for (const { categoria, pct } of top3) {
    const emoji = CATEGORIA_EMOJI[categoria] ?? "💸";
    linhas.push(`${emoji} ${categoria}:`);
    linhas.push(`${pct >= 0 ? "+" : ""}${pct}%`);
    linhas.push("");
  }

  const diff = atual.total_saidas - anterior.total_saidas;
  if (diff < 0) {
    linhas.push(`💰 Você economizou ${fmtValor(Math.abs(diff))} a mais este mês.`);
  } else if (diff > 0) {
    linhas.push(`📊 Você gastou ${fmtValor(diff)} a mais que no mês passado.`);
  } else {
    linhas.push("✅ Gastos iguais ao mês anterior.");
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n").trimEnd() });
    log.whatsapp("comparar enviado", { to: telefone, diff, mudancas: top3.length });
  } catch (err) {
    log.error("falha ao enviar comparar", err, { to: telefone });
  }

  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "comparar", diff } };
}

export async function handleDesafioCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando desafio", { userId: user.id });

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const metrics = await fetchPeriodMetrics(user.id, inicioMes, fimMes);

  if (metrics.gastos_por_categoria.length === 0) {
    await whatsapp.sendText({
      to:   telefone,
      text: "Registre todos os gastos de hoje e veja para onde o dinheiro vai.",
    });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "desafio" } };
  }

  // Categoria com maior gasto no mês
  const top      = metrics.gastos_por_categoria[0];
  const economia = Math.round(top.total * 0.10);
  const emoji    = CATEGORIA_EMOJI[top.categoria] ?? "📦";

  const templates = DESAFIOS[top.categoria] ?? [
    `Reduza 10% dos gastos em ${top.categoria} este mês.`,
  ];
  // Escolhe baseado no dia do mês para variar sem ser aleatório
  const dica = templates[now.getUTCDate() % templates.length];

  const linhas = [
    `${emoji} ${top.categoria} — ${fmtValor(top.total)} esse mês`,
    "",
    dica,
    "",
    `Economia possível: ${fmtValor(economia)}`,
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("desafio enviado", { to: telefone, categoria: top.categoria, economia });
  } catch (err) {
    log.error("falha ao enviar desafio", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "desafio", categoria: top.categoria, economia },
  };
}

export async function handlePrevisaoCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando previsao", { userId: user.id });

  const now   = new Date();
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const dia   = now.getUTCDate();

  const inicioMes  = new Date(Date.UTC(year, month, 1));
  const fimMes     = new Date(Date.UTC(year, month + 1, 1));
  const diasNoMes  = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const diasRestantes = diasNoMes - dia;

  const metrics    = await fetchPeriodMetrics(user.id, inicioMes, fimMes);
  const totalGasto = metrics.total_saidas;

  const meses = ["janeiro","fevereiro","março","abril","maio","junho",
                 "julho","agosto","setembro","outubro","novembro","dezembro"];

  if (totalGasto === 0) {
    await whatsapp.sendText({
      to:   telefone,
      text: `📈 Previsão de ${meses[month]}\n\nNenhum gasto registrado ainda.`,
    });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "previsao" } };
  }

  const mediaDiaria  = totalGasto / dia;
  const gastosPrevisto = Math.round(totalGasto + mediaDiaria * diasRestantes);

  const rendaFixa  = Number(user.renda      ?? 0);
  const rendaExtra = Number(user.renda_extra ?? 0);
  const totalRenda = rendaFixa + rendaExtra + metrics.total_entradas;

  const linhas = [
    `📈 Previsão de ${meses[month]}`,
    "",
    `Gastos: ${fmtValor(Math.round(totalGasto))}`,
    `Previsto: ${fmtValor(gastosPrevisto)}`,
  ];

  if (totalRenda > 0) {
    const saldo = totalRenda - gastosPrevisto;
    linhas.push("");
    linhas.push(
      saldo >= 0
        ? `💰 Devem sobrar ${fmtValor(saldo)}`
        : `💸 Podem faltar ${fmtValor(Math.abs(saldo))}`
    );
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("previsao enviada", { to: telefone, gastosPrevisto, totalRenda });
  } catch (err) {
    log.error("falha ao enviar previsao", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "previsao", gastosPrevisto, totalRenda },
  };
}

export async function handleTopGastosCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando top gastos", { userId: user.id });

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const result = await pool.query<{ descricao: string; valor: string }>(
    `SELECT descricao, valor
     FROM transactions
     WHERE user_id = $1
       AND tipo = 'saida'
       AND criado_em >= $2
       AND criado_em < $3
     ORDER BY valor DESC
     LIMIT 5`,
    [user.id, inicioMes, fimMes]
  );

  const meses = ["janeiro","fevereiro","março","abril","maio","junho",
                 "julho","agosto","setembro","outubro","novembro","dezembro"];

  const linhas = [`Maiores gastos de ${meses[now.getMonth()]}/${now.getFullYear()}`, ""];

  if (result.rows.length === 0) {
    linhas.push("Nenhum gasto registrado este mês.");
  } else {
    let somaTop = 0;
    result.rows.forEach((row, i) => {
      const valor = Number(row.valor);
      somaTop += valor;
      const desc = row.descricao ?? "Sem descrição";
      linhas.push(`${i + 1}. ${desc} — R$ ${valor.toFixed(2)}`);
    });
    linhas.push("");
    linhas.push(`Total dos ${result.rows.length} maiores: R$ ${somaTop.toFixed(2)}`);
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("top gastos enviado", { to: telefone, count: result.rows.length });
  } catch (err) {
    log.error("falha ao enviar top gastos", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "top gastos", count: result.rows.length },
  };
}

export async function handleBuscarCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  const termo = texto.replace(/^buscar\s+/i, "").trim();
  log.webhook("comando buscar", { userId: user.id, termo });

  const result = await pool.query<{ descricao: string; valor: string; categoria: string; criado_em: Date }>(
    `SELECT descricao, valor, categoria, criado_em
     FROM transactions
     WHERE user_id = $1
       AND tipo = 'saida'
       AND descricao ILIKE $2
     ORDER BY criado_em DESC
     LIMIT 10`,
    [user.id, `%${termo}%`]
  );

  if (result.rows.length === 0) {
    await whatsapp.sendText({
      to:   telefone,
      text: `🔎 Nenhum gasto encontrado para:\n${termo}`,
    });
    return {
      success:      true,
      userId:       user.id,
      transacao:    {},
      interpretado: { comando: "buscar", termo, count: 0 },
    };
  }

  const linhas = [`🔎 Resultados para "${termo}"`, ""];

  for (const row of result.rows) {
    const data = new Date(row.criado_em);
    const dia  = String(data.getUTCDate()).padStart(2, "0");
    const mes  = String(data.getUTCMonth() + 1).padStart(2, "0");
    linhas.push(`• ${fmtValor(Number(row.valor))} — ${row.categoria}`);
    linhas.push(`${dia}/${mes}`);
    linhas.push("");
  }

  // remove última linha em branco
  if (linhas[linhas.length - 1] === "") linhas.pop();

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("buscar enviado", { to: telefone, termo, count: result.rows.length });
  } catch (err) {
    log.error("falha ao enviar buscar", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "buscar", termo, count: result.rows.length },
  };
}

export async function handleRecorrentesTotalCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  const result = await pool.query<{ titulo: string; valor: string }>(
    `SELECT titulo, valor FROM lembretes
     WHERE user_id = $1 AND fixa = TRUE AND status = 'pendente'
     ORDER BY proxima_data ASC`,
    [user.id]
  );

  if (result.rows.length === 0) {
    await whatsapp.sendText({ to: telefone, text: "Você ainda não tem contas fixas cadastradas." });
    return { success: false, userId: user.id, erro: "Sem recorrentes" };
  }

  const total = result.rows.reduce((sum, row) => sum + Number(row.valor), 0);
  const linhas = [`Total fixo por mês: ${fmtValor(total)}`, ""];
  result.rows.forEach(row => linhas.push(`${row.titulo} — ${fmtValor(Number(row.valor))}`));

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
  } catch (err) {
    log.error("falha ao enviar total recorrentes", err, { to: telefone });
  }
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "total_recorrentes" } };
}

export async function handleCategoriasCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando categorias", { userId: user.id });

  const linhas = [
    "Categorias disponíveis",
    "",
    ...CATEGORIAS_CONHECIDAS.map(c => `${CATEGORIA_EMOJI[c] ?? "•"} ${c}`),
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("categorias enviado", { to: telefone });
  } catch (err) {
    log.error("falha ao enviar categorias", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "categorias" },
  };
}

export async function handleListLimitsCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando list_limites", { userId: user.id });

  const r = await pool.query<{ categoria: string; valor_limite: string }>(
    `SELECT categoria, valor_limite FROM category_limits WHERE user_id = $1 ORDER BY categoria ASC`,
    [user.id]
  );

  let txt: string;
  if (r.rows.length === 0) {
    txt = "Você ainda não tem limites definidos.\n\nEx:\nlimite alimentação 800";
  } else {
    const itens = r.rows.map(row => `• ${row.categoria} — ${fmtValor(Number(row.valor_limite))}`);
    txt = ["Seus limites por categoria:", "", ...itens].join("\n");
  }

  try {
    await whatsapp.sendText({ to: telefone, text: txt });
  } catch (err) {
    log.error("falha ao enviar lista de limites", err, { to: telefone });
  }

  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "list_limites" } };
}

export async function handleLimiteCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("comando limite", { userId: user.id, texto });

  const match = texto.match(/^limite\s+(.+?)\s+([\d,.]+)$/i);
  if (!match) {
    await whatsapp.sendText({ to: telefone, text: "💡 Ex:\nlimite alimentação 800" });
    return { success: false, userId: user.id, erro: "Formato inválido" };
  }

  const categoria   = normalizarCategoria(match[1]);
  const valorLimite = parseValor(match[2]);

  await pool.query(
    `INSERT INTO category_limits (user_id, categoria, valor_limite)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, categoria)
     DO UPDATE SET valor_limite = $3`,
    [user.id, categoria, valorLimite]
  );

  await whatsapp.sendText({
    to:   telefone,
    text: `Limite da categoria ${categoria} definido em R$ ${valorLimite.toFixed(2)}`,
  });

  recordAction(user.id, "set_limit");

  setTimeout(() => {
    checkAndSendOnboardingTip(user.id, telefone, "limite_criado").catch(err =>
      log.error("falha ao verificar onboarding tip", err, { userId: user.id })
    );
  }, 800);

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "limite", categoria, valorLimite },
  };
}

export async function checkLimiteCategoria(userId: number, categoria: string): Promise<string | null> {
  const limitRow = await pool.query<{ valor_limite: string }>(
    `SELECT valor_limite FROM category_limits
     WHERE user_id = $1 AND LOWER(categoria) = LOWER($2)`,
    [userId, categoria]
  );
  if (limitRow.rows.length === 0) return null;

  const valorLimite = Number(limitRow.rows[0].valor_limite);
  const now         = new Date();
  const inicioMes   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes      = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const gastoRow = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(valor), 0) AS total
     FROM transactions
     WHERE user_id = $1 AND LOWER(categoria) = LOWER($2)
       AND tipo = 'saida' AND criado_em >= $3 AND criado_em < $4`,
    [userId, categoria, inicioMes, fimMes]
  );
  const totalGasto = Number(gastoRow.rows[0].total);
  const percentual = Math.round((totalGasto / valorLimite) * 100);

  if (percentual < 80) return null;

  // Verifica quais marcos já foram enviados este mês
  const sentRow = await pool.query<{ marco: number }>(
    `SELECT marco FROM sent_insights
     WHERE user_id = $1 AND categoria = $2 AND mes_referencia = $3
       AND marco IN (80, 100)`,
    [userId, categoria, inicioMes]
  );
  const marcosSent = new Set(sentRow.rows.map(r => r.marco));

  if (percentual >= 100 && !marcosSent.has(100)) {
    await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, $2, 100, $3)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, categoria, inicioMes]
    );
    return `${categoria} passou do limite esse mês. ${fmtValor(totalGasto)} de ${fmtValor(valorLimite)}.`;
  }

  if (percentual >= 80 && !marcosSent.has(80)) {
    await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, $2, 80, $3)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, categoria, inicioMes]
    );
    return `${categoria} está em ${percentual}% do limite esse mês. ${fmtValor(totalGasto)} de ${fmtValor(valorLimite)}.`;
  }

  return null;
}
