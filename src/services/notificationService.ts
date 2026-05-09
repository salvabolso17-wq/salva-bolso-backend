import pool from "../db/client";
import { whatsapp } from "./whatsapp";
import { log } from "../utils/logger";
import { fetchPeriodMetrics } from "./reportService";

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

// Usuários sem registrar gastos há 3–10 dias → nudge leve (máx 1x/semana)
async function sendInactivityNotifications(): Promise<void> {
  const sentinel = currentWeekStart();

  const { rows } = await pool.query<{ id: number; telefone: string }>(`
    SELECT u.id, u.telefone
    FROM users u
    WHERE EXISTS (SELECT 1 FROM transactions WHERE user_id = u.id)
      AND (SELECT MAX(criado_em) FROM transactions WHERE user_id = u.id)
            BETWEEN NOW() - INTERVAL '10 days' AND NOW() - INTERVAL '3 days'
      AND NOT EXISTS (
        SELECT 1 FROM sent_insights
        WHERE user_id = u.id AND categoria = 'notif_inatividade' AND mes_referencia = $1
      )
  `, [sentinel]);

  for (const user of rows) {
    if (!(await tryMarkSent(user.id, "notif_inatividade", sentinel))) continue;
    try {
      await whatsapp.sendText({
        to:   user.telefone,
        text: "👋 Faz alguns dias sem registrar gastos.\n\n💡 Ex:\n120 mercado",
      });
      log.whatsapp("notif inatividade enviada", { to: user.telefone, userId: user.id });
    } catch (err) {
      log.error("falha ao enviar notif inatividade", err, { userId: user.id });
    }
  }
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
        text: "📊 O mês está acabando.\n\nEnvie:\nresumo",
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
    ) >= 3
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

function buildReminderText(daysAhead: number, link: string): string {
  const linkLine = link ? `\n\n👉 ${link}` : "";
  if (daysAhead === 7) {
    return `⏰ Lembrete: sua assinatura do Salva Bolso vence em 7 dias.\n\nRenove agora e continue sem interrupções:${linkLine}`;
  }
  if (daysAhead === 3) {
    return `⚠️ Sua assinatura vence em 3 dias!\n\nNão perca seu acesso ao Salva Bolso:${linkLine}`;
  }
  return `🔴 Sua assinatura vence hoje!\n\nRenove agora para não perder o acesso:${linkLine}`;
}

async function sendSubscriptionReminders(): Promise<void> {
  const link = process.env.PAYMENT_LINK ?? "";

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

        await whatsapp.sendText({ to: user.telefone, text: buildReminderText(daysAhead, link) });
        log.whatsapp(`sub_reminder ${daysAhead}d enviado`, { to: user.telefone, userId: user.id });
      } catch (err) {
        log.error(`falha sub_reminder ${daysAhead}d`, err, { userId: user.id });
      }
    }
  }
}

export async function runDailyNotifications(): Promise<void> {
  log.webhook("iniciando notificações diárias");
  try { await sendSubscriptionReminders(); }            catch (err) { log.error("falha sub reminders", err); }
  try { await sendInactivityNotifications(); }          catch (err) { log.error("falha notif inatividade", err); }
  try { await sendMonthEndNotifications(); }             catch (err) { log.error("falha notif fim mes", err); }
  try { await sendGoalStagnationNotifications(); }       catch (err) { log.error("falha notif meta parada", err); }
  try { await sendMonthlyClosingNotifications(); }       catch (err) { log.error("falha notif fechamento", err); }
  try { await sendNewMonthFlowNotifications(); }         catch (err) { log.error("falha notif novo mes", err); }
  log.webhook("notificações diárias concluídas");
}
