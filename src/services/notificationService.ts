import pool from "../db/client";
import { whatsapp } from "./whatsapp";
import { log } from "../utils/logger";

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

export async function runDailyNotifications(): Promise<void> {
  log.webhook("iniciando notificações diárias");
  try { await sendInactivityNotifications(); }    catch (err) { log.error("falha notif inatividade", err); }
  try { await sendMonthEndNotifications(); }       catch (err) { log.error("falha notif fim mes", err); }
  try { await sendGoalStagnationNotifications(); } catch (err) { log.error("falha notif meta parada", err); }
  log.webhook("notificações diárias concluídas");
}
