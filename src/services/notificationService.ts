import pool from "../db/client";
import { whatsapp } from "./whatsapp";
import { log } from "../utils/logger";
import { fetchPeriodMetrics } from "./reportService";
import { buildPlansBlock } from "../utils/plansMessage";

const MESES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

const CATEGORY_EMOJI: Record<string, string> = {
  "Alimentação": "🍔", "Transporte": "🚗", "Moradia": "🏠", "Lazer": "🎉",
  "Saúde": "💊", "Educação": "📚", "Vestuário": "👕", "Outros": "📦",
};

function fmtValor(valor: number): string {
  return "R$ " + valor.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// Tenta marcar uma notificação como enviada. Retorna false se já foi enviada (dedup atômico via UNIQUE).
async function tryMarkSent(userId: number, categoria: string, mesRef: Date): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
    [userId, categoria, mesRef]
  );
  return (result.rowCount ?? 0) > 0;
}

function currentWeekStart(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

function currentMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// Nudge de engajamento progressivo: D+1, D+3, D+7, D+14 dias sem registrar gasto.
// Roda 1x/dia às 19h BRT. Após D+14, para até o usuário registrar algo novo.
const INACTIVITY_MARCOS = [1, 3, 7, 14] as const;

function buildInactivityMessage(dias: number): string {
  switch (dias) {
    case 1:
      return "Oi! Tudo bem? 👋\nFaz 1 dia que você não anota nada.\nJá gastou algo hoje? É só me contar.";
    case 3:
      return "3 dias sem dar notícia 😬\nSem registrar, fica difícil saber pra onde foi o dinheiro.\nManda o que gastou que eu organizo pra você.";
    case 7:
      return "⚠️ 1 semana sem registrar.\nEsse é o jeito mais rápido de perder o controle de novo.\nManda o último gasto que você lembra que eu te recoloco no eixo.";
    case 14:
      return "Vou parar de te incomodar por aqui.\nQuando quiser voltar, é só me mandar qualquer gasto.\nTô aqui. 🤝";
    default:
      return "";
  }
}

export async function sendInactivityNotifications(): Promise<{ elegiveis: number; enviados: number }> {
  let elegiveis = 0;
  let enviados = 0;
  try {
    const { rows } = await pool.query<{ id: number; telefone: string; dias_sem_gasto: string | null; ultimo_nudge_em: string | null; ultimo_nudge_dias: number | null }>(`
      SELECT u.id,
             u.telefone,
             (CURRENT_DATE - DATE(MAX(t.criado_em) AT TIME ZONE 'America/Sao_Paulo')) AS dias_sem_gasto,
             u.ultimo_nudge_em::text AS ultimo_nudge_em,
             u.ultimo_nudge_dias
        FROM users u
        JOIN transactions t ON t.user_id = u.id
       GROUP BY u.id, u.telefone, u.ultimo_nudge_em, u.ultimo_nudge_dias
       HAVING (CURRENT_DATE - DATE(MAX(t.criado_em) AT TIME ZONE 'America/Sao_Paulo')) = ANY($1::int[])
    `, [INACTIVITY_MARCOS as unknown as number[]]);

    elegiveis = rows.length;

    for (const user of rows) {
      const dias = Number(user.dias_sem_gasto ?? 0);
      const hojeISO = new Date().toISOString().slice(0, 10);

      // Skip se já nudgeou hoje OU se o último nudge foi exatamente para esse marco
      if (user.ultimo_nudge_em === hojeISO) {
        console.log(`[NUDGE] user=${user.id} dias=${dias} status=skip-ja-hoje`);
        continue;
      }
      if (user.ultimo_nudge_dias === dias) {
        console.log(`[NUDGE] user=${user.id} dias=${dias} status=skip-mesmo-marco`);
        continue;
      }

      const text = buildInactivityMessage(dias);
      if (!text) {
        console.log(`[NUDGE] user=${user.id} dias=${dias} status=skip-marco-invalido`);
        continue;
      }

      try {
        await whatsapp.sendText({ to: user.telefone, text });
        await pool.query(
          `UPDATE users SET ultimo_nudge_em = CURRENT_DATE, ultimo_nudge_dias = $2 WHERE id = $1`,
          [user.id, dias]
        );
        enviados++;
        console.log(`[NUDGE] user=${user.id} dias=${dias} status=enviado`);
        log.whatsapp("notif inatividade enviada", { to: user.telefone, userId: user.id, dias });
      } catch (err) {
        console.log(`[NUDGE] user=${user.id} dias=${dias} status=erro`);
        log.error("falha ao enviar notif inatividade", err, { userId: user.id, dias });
      }
    }
  } catch (err) {
    log.error("falha geral sendInactivityNotifications", err);
  }
  console.log(`[CRON] Inactivity check: ${elegiveis} users elegiveis, ${enviados} mensagens`);
  return { elegiveis, enviados };
}

// Últimos dias do mês para usuários com ≥3 gastos no mês → lembra de ver resumo (máx 1x/mês)
async function sendMonthEndNotifications(): Promise<void> {
  if (new Date().getUTCDate() < 26) return;

  const sentinel = currentMonthStart();

  const { rows } = await pool.query<{ id: number; telefone: string }>(`
    SELECT u.id, u.telefone
    FROM users u
    WHERE (
      SELECT COUNT(*) FROM transactions
      WHERE user_id = u.id AND tipo = 'saida' AND criado_em >= $1
    ) >= 3
    AND NOT EXISTS (
      SELECT 1 FROM sent_insights
      WHERE user_id = u.id AND categoria = 'notif_fim_mes' AND mes_referencia = $1
    )
  `, [sentinel]);

  for (const user of rows) {
    if (!(await tryMarkSent(user.id, "notif_fim_mes", sentinel))) continue;
    try {
      await whatsapp.sendText({
        to:   user.telefone,
        text: "📊 O mês está quase no fim.\n\nEnvie 'resumo' para ver onde você mais gastou.",
      });
      log.whatsapp("notif fim de mes enviada", { to: user.telefone, userId: user.id });
    } catch (err) {
      log.error("falha ao enviar notif fim de mes", err, { userId: user.id });
    }
  }
}

// Meta com < 80% de progresso criada há > 7 dias → incentiva depósito (máx 1x/semana, 1 meta/usuário)
async function sendGoalStagnationNotifications(): Promise<void> {
  const sentinel = currentWeekStart();

  const { rows } = await pool.query<{ id: number; telefone: string; nome: string }>(`
    SELECT DISTINCT ON (u.id) u.id, u.telefone, ug.nome
    FROM users u
    JOIN user_goals ug ON ug.user_id = u.id
    WHERE ug.valor_atual < ug.valor_meta * 0.8
      AND ug.criado_em < NOW() - INTERVAL '7 days'
      AND NOT EXISTS (
        SELECT 1 FROM sent_insights
        WHERE user_id = u.id AND categoria = 'notif_meta_parada' AND mes_referencia = $1
      )
    ORDER BY u.id, (ug.valor_atual / NULLIF(ug.valor_meta, 0)) ASC NULLS LAST
  `, [sentinel]);

  for (const user of rows) {
    if (!(await tryMarkSent(user.id, "notif_meta_parada", sentinel))) continue;
    try {
      await whatsapp.sendText({
        to:   user.telefone,
        text: `🎯 Sua meta "${user.nome}" ainda tem caminho pela frente.\n\n💡 Use:\nguardar 50 ${user.nome}`,
      });
      log.whatsapp("notif meta parada enviada", { to: user.telefone, userId: user.id, meta: user.nome });
    } catch (err) {
      log.error("falha ao enviar notif meta parada", err, { userId: user.id });
    }
  }
}

// Dia 1 do mês: resume o mês anterior com sensação de progresso (máx 1x/mês por usuário)
async function sendMonthlyClosingNotifications(): Promise<void> {
  if (new Date().getUTCDate() !== 1) return;

  const now         = new Date();
  const prevStart   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevEnd     = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const sentinel    = prevStart;
  const mesNome     = MESES[prevStart.getUTCMonth()];

  const { rows } = await pool.query<{ id: number; telefone: string }>(`
    SELECT u.id, u.telefone
    FROM users u
    WHERE (
      SELECT COUNT(*) FROM transactions
      WHERE user_id = u.id AND tipo = 'saida' AND criado_em >= $1 AND criado_em < $2
    ) >= 5
    AND NOT EXISTS (
      SELECT 1 FROM sent_insights
      WHERE user_id = u.id AND categoria = 'notif_fechamento' AND mes_referencia = $1
    )
  `, [prevStart, prevEnd]);

  for (const user of rows) {
    if (!(await tryMarkSent(user.id, "notif_fechamento", sentinel))) continue;
    try {
      const metrics = await fetchPeriodMetrics(user.id, prevStart, prevEnd);
      const top     = metrics.gastos_por_categoria[0];
      const saldo   = metrics.total_entradas - metrics.total_saidas;

      const linhas = [
        `📊 Fechamento de ${mesNome}`,
        "",
        `Entradas: ${fmtValor(metrics.total_entradas)}`,
        `Gastos: ${fmtValor(metrics.total_saidas)}`,
        "",
        saldo >= 0
          ? `💰 Sobraram ${fmtValor(saldo)}`
          : `📉 Saldo: -${fmtValor(Math.abs(saldo))}`,
      ];

      if (top) {
        const emoji = CATEGORY_EMOJI[top.categoria] ?? "💸";
        linhas.push("", "Categoria principal:", `${emoji} ${top.categoria} — ${fmtValor(top.total)}`);
      }

      await whatsapp.sendText({ to: user.telefone, text: linhas.join("\n") });
      log.whatsapp("notif fechamento enviada", { to: user.telefone, userId: user.id, mes: mesNome });
    } catch (err) {
      log.error("falha ao enviar notif fechamento", err, { userId: user.id });
    }
  }
}

// Dia 1 do mês: inicia fluxo interativo para renda + carryover de saldo (máx 1x/mês por usuário)
async function sendNewMonthFlowNotifications(): Promise<void> {
  if (new Date().getUTCDate() !== 1) return;

  const now       = new Date();
  const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const sentinel  = prevStart;
  const mesAtual  = MESES[now.getUTCMonth()];

  const { rows } = await pool.query<{ id: number; telefone: string }>(`
    SELECT u.id, u.telefone
    FROM users u
    WHERE (
      SELECT COUNT(*) FROM transactions
      WHERE user_id = u.id AND criado_em >= $1 AND criado_em < $2
    ) >= 1
    AND NOT EXISTS (
      SELECT 1 FROM sent_insights
      WHERE user_id = u.id AND categoria = 'notif_novo_mes' AND mes_referencia = $1
    )
    AND NOT EXISTS (
      SELECT 1 FROM pending_actions WHERE user_id = u.id
    )
  `, [prevStart, prevEnd]);

  for (const user of rows) {
    if (!(await tryMarkSent(user.id, "notif_novo_mes", sentinel))) continue;

    const inserted = await pool.query(
      `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
       VALUES ($1, 'novo_mes', 'waiting_renda', '[]', NOW() + INTERVAL '24 hours')
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id]
    );
    if ((inserted.rowCount ?? 0) === 0) continue;

    try {
      await whatsapp.sendText({
        to:   user.telefone,
        text: `🌅 Novo mês iniciado!\n\nQual sua renda para ${mesAtual}?`,
      });
      log.whatsapp("notif novo mes enviada", { to: user.telefone, userId: user.id, mes: mesAtual });
    } catch (err) {
      log.error("falha ao enviar notif novo mes", err, { userId: user.id });
    }
  }
}

// Lembretes de vencimento de assinatura: 7d, 3d, dia do vencimento (1x por marco por ciclo)
const SUBSCRIPTION_REMINDERS = [
  { daysAhead: 7, marco: 7 },
  { daysAhead: 3, marco: 3 },
  { daysAhead: 0, marco: 0 },
] as const;

function buildReminderText(daysAhead: number, plansBlock: string): string {
  const intro = daysAhead === 7
    ? "Sua assinatura do Salva Bolso vence em 7 dias.\n\nSe quiser renovar com antecedência:"
    : daysAhead === 3
    ? "Sua assinatura vence em 3 dias.\n\nPara continuar sem interrupção:"
    : "Sua assinatura vence hoje.\n\nSe quiser manter o acesso:";
  return plansBlock ? `${intro}\n\n${plansBlock}` : intro;
}

async function sendSubscriptionReminders(): Promise<void> {
  const plansBlock = await buildPlansBlock();

  for (const { daysAhead, marco } of SUBSCRIPTION_REMINDERS) {
    let rows: { id: number; telefone: string; expires_date: string }[];
    try {
      ({ rows } = await pool.query<{ id: number; telefone: string; expires_date: string }>(
        `SELECT u.id, u.telefone,
                DATE(u.subscription_expires_at AT TIME ZONE 'America/Sao_Paulo')::text AS expires_date
         FROM users u
         WHERE u.subscription_status = 'active'
           AND u.subscription_expires_at IS NOT NULL
           AND DATE(u.subscription_expires_at AT TIME ZONE 'America/Sao_Paulo')
               = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date + ($1 || ' days')::INTERVAL
           AND NOT EXISTS (
             SELECT 1 FROM sent_insights
             WHERE user_id = u.id
               AND categoria = 'sub_reminder'
               AND marco = $2
               AND mes_referencia = DATE(u.subscription_expires_at AT TIME ZONE 'America/Sao_Paulo')
           )`,
        [daysAhead.toString(), marco]
      ));
    } catch (err) {
      log.error(`falha ao buscar usuarios para sub_reminder ${daysAhead}d`, err);
      continue;
    }

    for (const user of rows) {
      try {
        const inserted = await pool.query(
          `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
           VALUES ($1, 'sub_reminder', $2, $3::date)
           ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
          [user.id, marco, user.expires_date]
        );
        if ((inserted.rowCount ?? 0) === 0) continue;

        await whatsapp.sendText({ to: user.telefone, text: buildReminderText(daysAhead, plansBlock) });
        log.whatsapp(`sub_reminder ${daysAhead}d enviado`, { to: user.telefone, userId: user.id });
      } catch (err) {
        log.error(`falha sub_reminder ${daysAhead}d`, err, { userId: user.id });
      }
    }
  }
}

// Lembretes de fim do trial: 3d e 0d antes de expirar (1x por marco, via sent_insights)
const TRIAL_REMINDERS = [
  { daysAhead: 2, marco: 102 },
  { daysAhead: 0, marco: 100 },
] as const;

function buildTrialReminderText(daysAhead: number, plansBlock: string): string {
  const intro = daysAhead === 2
    ? "Seu período de teste termina em 2 dias.\n\nSe quiser continuar organizando seus gastos:"
    : "Seu período de teste termina hoje.\n\nPara continuar usando o Salva Bolso:";
  return plansBlock ? `${intro}\n\n${plansBlock}` : intro;
}

async function sendTrialReminders(): Promise<void> {
  const plansBlock = await buildPlansBlock();

  for (const { daysAhead, marco } of TRIAL_REMINDERS) {
    let rows: { id: number; telefone: string; trial_date: string }[];
    try {
      ({ rows } = await pool.query<{ id: number; telefone: string; trial_date: string }>(
        `SELECT u.id, u.telefone,
                DATE(u.trial_ends_at AT TIME ZONE 'America/Sao_Paulo')::text AS trial_date
         FROM users u
         WHERE u.subscription_status = 'trial'
           AND u.trial_ends_at IS NOT NULL
           AND DATE(u.trial_ends_at AT TIME ZONE 'America/Sao_Paulo')
               = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date + ($1 || ' days')::INTERVAL
           AND NOT EXISTS (
             SELECT 1 FROM sent_insights
             WHERE user_id = u.id
               AND categoria = 'trial_reminder'
               AND marco = $2
               AND mes_referencia = DATE(u.trial_ends_at AT TIME ZONE 'America/Sao_Paulo')
           )`,
        [daysAhead.toString(), marco]
      ));
    } catch (err) {
      log.error(`falha ao buscar usuarios para trial_reminder ${daysAhead}d`, err);
      continue;
    }

    for (const user of rows) {
      try {
        const inserted = await pool.query(
          `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
           VALUES ($1, 'trial_reminder', $2, $3::date)
           ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
          [user.id, marco, user.trial_date]
        );
        if ((inserted.rowCount ?? 0) === 0) continue;

        await whatsapp.sendText({ to: user.telefone, text: buildTrialReminderText(daysAhead, plansBlock) });
        log.whatsapp(`trial_reminder ${daysAhead}d enviado`, { to: user.telefone, userId: user.id });
      } catch (err) {
        log.error(`falha trial_reminder ${daysAhead}d`, err, { userId: user.id });
      }
    }
  }
}

// Dia 25: alerta proativo de recorrentes do próximo mês (diferente de "próximas" que é sob demanda)
async function sendRecorrentesAlert(): Promise<void> {
  if (new Date().getUTCDate() !== 25) return;
  const sentinel = currentMonthStart();

  const { rows } = await pool.query<{ id: number; telefone: string }>(`
    SELECT DISTINCT u.id, u.telefone
    FROM users u
    WHERE (u.subscription_status = 'active' OR (u.subscription_status = 'trial' AND u.trial_ends_at > NOW()))
      AND EXISTS (SELECT 1 FROM recurring_expenses WHERE user_id = u.id AND ativo = TRUE)
      AND NOT EXISTS (
        SELECT 1 FROM sent_insights
        WHERE user_id = u.id AND categoria = 'alerta_recorrentes' AND mes_referencia = $1
      )
  `, [sentinel]);

  for (const user of rows) {
    if (!(await tryMarkSent(user.id, "alerta_recorrentes", sentinel))) continue;
    try {
      const recRows = await pool.query<{ nome: string; valor: string }>(
        `SELECT nome, valor FROM recurring_expenses WHERE user_id = $1 AND ativo = TRUE ORDER BY valor DESC`,
        [user.id]
      );
      const total = recRows.rows.reduce((s, r) => s + Number(r.valor), 0);
      const lista = recRows.rows.map(r => `• ${r.nome} — R$ ${Number(r.valor).toFixed(2)}`).join("\n");

      await whatsapp.sendText({
        to: user.telefone,
        text: [
          "📋 Contas do próximo mês",
          "",
          lista,
          "",
          `Total previsto: R$ ${total.toFixed(2)}/mês`,
          "",
          'Envie "próximas" para detalhes.',
        ].join("\n"),
      });
      log.whatsapp("alerta recorrentes enviado", { to: user.telefone, userId: user.id, total });
    } catch (err) {
      log.error("falha ao enviar alerta recorrentes", err, { userId: user.id });
    }
  }
}

async function sendMonthlyBillsReminder(): Promise<void> {
  if (new Date().getUTCDate() !== 1) return;
  const sentinel = currentMonthStart();

  const { rows } = await pool.query<{ id: number; telefone: string }>(`
    SELECT DISTINCT u.id, u.telefone
    FROM users u
    WHERE (u.subscription_status = 'active' OR (u.subscription_status = 'trial' AND u.trial_ends_at > NOW()))
      AND EXISTS (SELECT 1 FROM recurring_expenses WHERE user_id = u.id AND ativo = TRUE)
      AND NOT EXISTS (
        SELECT 1 FROM sent_insights
        WHERE user_id = u.id AND categoria = 'lembrete_contas_mes' AND mes_referencia = $1
      )
  `, [sentinel]);

  for (const user of rows) {
    if (!(await tryMarkSent(user.id, "lembrete_contas_mes", sentinel))) continue;
    try {
      const recRows = await pool.query<{ nome: string; valor: string }>(
        `SELECT nome, valor FROM recurring_expenses WHERE user_id = $1 AND ativo = TRUE ORDER BY valor DESC`,
        [user.id]
      );
      const total = recRows.rows.reduce((s, r) => s + Number(r.valor), 0);
      const lista = recRows.rows.map(r => `• ${r.nome} — R$ ${Number(r.valor).toFixed(2)}`).join("\n");

      await whatsapp.sendText({
        to: user.telefone,
        text: [
          "📅 Suas contas deste mês:",
          "",
          lista,
          "",
          `Total: R$ ${total.toFixed(2)}`,
        ].join("\n"),
      });
      log.whatsapp("lembrete contas mes enviado", { to: user.telefone, userId: user.id });
    } catch (err) {
      log.error("falha lembrete contas mes", err, { userId: user.id });
    }
  }
}

// Dia 1: score financeiro mensal — enviado junto ao fechamento
async function sendMonthlyScore(): Promise<void> {
  if (new Date().getUTCDate() !== 1) return;
  const now       = new Date();
  const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const sentinel  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 2)); // dia 2 do mês anterior = sentinela única

  const { rows } = await pool.query<{ id: number; telefone: string; renda: string; renda_extra: string }>(`
    SELECT u.id, u.telefone, u.renda, u.renda_extra
    FROM users u
    WHERE (u.subscription_status = 'active' OR (u.subscription_status = 'trial' AND u.trial_ends_at > NOW()))
      AND (SELECT COUNT(*) FROM transactions WHERE user_id = u.id AND tipo = 'saida' AND criado_em >= $1 AND criado_em < $2) >= 8
      AND NOT EXISTS (
        SELECT 1 FROM sent_insights
        WHERE user_id = u.id AND categoria = 'score_mensal' AND mes_referencia = $1
      )
  `, [prevStart, prevEnd]);

  for (const user of rows) {
    try {
      const inserted = await pool.query(
        `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
         VALUES ($1, 'score_mensal', 1, $2)
         ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
        [user.id, prevStart]
      );
      if ((inserted.rowCount ?? 0) === 0) continue;

      // Coleta dados para o score
      const [totaisRes, limRes, metasRes, recRes, txRes] = await Promise.all([
        pool.query<{ entradas: string; saidas: string }>(
          `SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN valor ELSE 0 END),0) AS entradas,
                  COALESCE(SUM(CASE WHEN tipo='saida'   THEN valor ELSE 0 END),0) AS saidas
           FROM transactions WHERE user_id = $1 AND criado_em >= $2 AND criado_em < $3`,
          [user.id, prevStart, prevEnd]
        ),
        pool.query<{ excedidos: string }>(
          `SELECT COUNT(*) AS excedidos FROM category_limits cl
           WHERE cl.user_id = $1
             AND (SELECT COALESCE(SUM(valor),0) FROM transactions
                  WHERE user_id = $1 AND LOWER(categoria) = LOWER(cl.categoria)
                    AND tipo='saida' AND criado_em >= $2 AND criado_em < $3) > cl.valor_limite`,
          [user.id, prevStart, prevEnd]
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM user_goals WHERE user_id = $1 AND valor_atual > 0`,
          [user.id]
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM recurring_expenses WHERE user_id = $1 AND ativo = TRUE`,
          [user.id]
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM transactions
           WHERE user_id = $1 AND tipo='saida' AND criado_em >= $2 AND criado_em < $3`,
          [user.id, prevStart, prevEnd]
        ),
      ]);

      const saidas    = Number(totaisRes.rows[0].saidas);
      const entradas  = Number(totaisRes.rows[0].entradas);
      const rendaFixa = Number(user.renda ?? 0) + Number(user.renda_extra ?? 0);
      const rendaTotal = rendaFixa + entradas;
      const excedidos  = Number(limRes.rows[0].excedidos);
      const temMetas   = Number(metasRes.rows[0].count) > 0;
      const temRec     = Number(recRes.rows[0].count) > 0;
      const txCount    = Number(txRes.rows[0].count);

      let score = 0;
      const criterios: string[] = [];

      if (rendaTotal > 0 && saidas <= rendaTotal) {
        score += 3; criterios.push("✅ Ficou dentro do orçamento");
      } else {
        criterios.push("⚠️ Gastos acima da renda");
      }
      if (excedidos === 0 && (await pool.query(`SELECT COUNT(*) AS c FROM category_limits WHERE user_id = $1`, [user.id])).rows[0].c > 0) {
        score += 2; criterios.push("✅ Nenhum limite excedido");
      } else if (excedidos > 0) {
        criterios.push(`⚠️ ${excedidos} limite(s) ultrapassado(s)`);
      }
      if (temMetas) { score += 2; criterios.push("✅ Metas ativas"); }
      if (txCount >= 10) { score += 2; criterios.push("✅ Controle consistente"); }
      else if (txCount >= 5) { score += 1; criterios.push("✅ Bom registro de gastos"); }
      if (temRec) { score += 1; criterios.push("✅ Recorrentes organizados"); }

      const nivel = score >= 8 ? "🌟 Excelente" : score >= 6 ? "👍 Bom" : score >= 4 ? "📈 Em progresso" : "💪 Continue tentando";

      await whatsapp.sendText({
        to: user.telefone,
        text: [
          `⭐ Score financeiro do mês: ${score}/10`,
          `${nivel}`,
          "",
          ...criterios,
        ].join("\n"),
      });
      log.whatsapp("score mensal enviado", { to: user.telefone, userId: user.id, score });
    } catch (err) {
      log.error("falha ao enviar score mensal", err, { userId: user.id });
    }
  }
}

// Segunda-feira 9h: push semanal com comparativo real (diferente do comando "semana" que é sob demanda)
export async function runWeeklyNotifications(): Promise<void> {
  // Semana anterior: de segunda a domingo passados
  const now    = new Date();
  const nowBR  = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const dow    = nowBR.getDay(); // 1 = monday
  if (dow !== 1) return; // garante que só roda na segunda (proteção extra)

  const semIni  = new Date(Date.UTC(nowBR.getFullYear(), nowBR.getMonth(), nowBR.getDate() - 7));
  const semFim  = new Date(Date.UTC(nowBR.getFullYear(), nowBR.getMonth(), nowBR.getDate()));
  const antIni  = new Date(Date.UTC(nowBR.getFullYear(), nowBR.getMonth(), nowBR.getDate() - 14));
  const sentinel = semIni;

  const { rows } = await pool.query<{ id: number; telefone: string }>(`
    SELECT u.id, u.telefone
    FROM users u
    WHERE (u.subscription_status = 'active' OR (u.subscription_status = 'trial' AND u.trial_ends_at > NOW()))
      AND (SELECT COUNT(*) FROM transactions WHERE user_id = u.id AND tipo='saida' AND criado_em >= $1 AND criado_em < $2) >= 2
      AND (SELECT COUNT(*) FROM transactions WHERE user_id = u.id) >= 5
      AND NOT EXISTS (
        SELECT 1 FROM sent_insights
        WHERE user_id = u.id AND categoria = 'relatorio_semanal' AND mes_referencia = $3
      )
  `, [semIni, semFim, sentinel]);

  for (const user of rows) {
    try {
      const inserted = await pool.query(
        `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
         VALUES ($1, 'relatorio_semanal', 1, $2)
         ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
        [user.id, sentinel]
      );
      if ((inserted.rowCount ?? 0) === 0) continue;

      const [cur, prev] = await Promise.all([
        pool.query<{ total: string; categoria: string }>(
          `SELECT COALESCE(SUM(valor),0)::text AS total,
                  (SELECT COALESCE(categoria,'Outros') FROM transactions
                   WHERE user_id = $1 AND tipo='saida' AND criado_em >= $2 AND criado_em < $3
                   GROUP BY categoria ORDER BY SUM(valor) DESC LIMIT 1) AS categoria
           FROM transactions WHERE user_id = $1 AND tipo='saida' AND criado_em >= $2 AND criado_em < $3`,
          [user.id, semIni, semFim]
        ),
        pool.query<{ total: string }>(
          `SELECT COALESCE(SUM(valor),0)::text AS total FROM transactions
           WHERE user_id = $1 AND tipo='saida' AND criado_em >= $2 AND criado_em < $3`,
          [user.id, antIni, semIni]
        ),
      ]);

      const totalSem  = Number(cur.rows[0]?.total ?? 0);
      const totalAnt  = Number(prev.rows[0]?.total ?? 0);
      const topCat    = cur.rows[0]?.categoria ?? null;
      const emoji     = { "Alimentação":"🍔","Transporte":"🚗","Moradia":"🏠","Lazer":"🎮",
                          "Saúde":"💊","Educação":"📚","Outros":"📦" }[topCat ?? ""] ?? "💸";

      let comparativo = "";
      if (totalAnt > 0) {
        const pct = Math.round(((totalSem - totalAnt) / totalAnt) * 100);
        comparativo = pct > 0
          ? `📈 ${pct}% a mais que na semana anterior`
          : pct < 0
          ? `📉 ${Math.abs(pct)}% a menos que na semana anterior`
          : "➡️ Igual à semana anterior";
      }

      const linhas = [
        "📊 Resumo da semana",
        "",
        `💸 Total gasto: R$ ${totalSem.toFixed(2)}`,
      ];
      if (comparativo) linhas.push(comparativo);
      if (topCat) linhas.push("", `${emoji} Maior gasto: ${topCat}`);
      linhas.push("", 'Envie "resumo" para ver por categoria.');

      await whatsapp.sendText({ to: user.telefone, text: linhas.join("\n") });
      log.whatsapp("push semanal enviado", { to: user.telefone, userId: user.id, totalSem });
    } catch (err) {
      log.error("falha ao enviar push semanal", err, { userId: user.id });
    }
  }
}

// Usuários criados há ~24h que não interagiram recentemente (onboarding_nudge)
async function sendPostOnboardingNudge(): Promise<void> {
  // Marco simples do dia atual para evitar duplicidade
  const sentinel = new Date();
  sentinel.setUTCHours(0, 0, 0, 0);

  const { rows } = await pool.query<{ id: number; telefone: string }>(`
    SELECT u.id, u.telefone
    FROM users u
    WHERE u.criado_em BETWEEN NOW() - INTERVAL '48 hours' AND NOW() - INTERVAL '24 hours'
      AND (
        (SELECT MAX(criado_em) FROM transactions WHERE user_id = u.id) IS NULL
        OR
        (SELECT MAX(criado_em) FROM transactions WHERE user_id = u.id) < NOW() - INTERVAL '24 hours'
      )
      AND NOT EXISTS (
        SELECT 1 FROM sent_insights
        WHERE user_id = u.id AND categoria = 'notif_onboarding_nudge'
      )
  `);

  for (const user of rows) {
    if (!(await tryMarkSent(user.id, "notif_onboarding_nudge", sentinel))) continue;
    try {
      const msg = [
        "👋 Como foi seu dia hoje?",
        "",
        "Pode me mandar qualquer gasto que eu organizo tudo pra você 🙂"
      ].join("\n");
      await whatsapp.sendText({ to: user.telefone, text: msg });
      log.whatsapp("notif onboarding nudge enviada", { to: user.telefone, userId: user.id });
    } catch (err) {
      log.error("falha ao enviar notif onboarding nudge", err, { userId: user.id });
    }
  }
}

export async function runDailyNotifications(): Promise<void> {
  log.webhook("iniciando notificações diárias");
  try { await sendPostOnboardingNudge(); }              catch (err) { log.error("falha nudge onboarding", err); }
  try { await sendSubscriptionReminders(); }            catch (err) { log.error("falha sub reminders", err); }
  try { await sendTrialReminders(); }                   catch (err) { log.error("falha trial reminders", err); }
  try { await sendRecorrentesAlert(); }                 catch (err) { log.error("falha alerta recorrentes", err); }
  try { await sendMonthlyBillsReminder(); }             catch (err) { log.error("falha lembrete contas mes", err); }
  try { await sendMonthEndNotifications(); }             catch (err) { log.error("falha notif fim mes", err); }
  try { await sendGoalStagnationNotifications(); }       catch (err) { log.error("falha notif meta parada", err); }
  try { await sendMonthlyClosingNotifications(); }       catch (err) { log.error("falha notif fechamento", err); }
  try { await sendMonthlyScore(); }                     catch (err) { log.error("falha score mensal", err); }
  try { await sendNewMonthFlowNotifications(); }         catch (err) { log.error("falha notif novo mes", err); }
  log.webhook("notificações diárias concluídas");
}
