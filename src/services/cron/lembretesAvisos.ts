import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor, capitalizeFirst } from "../../utils/formatting";
import { diasAteVencimento, type LembreteRow } from "../modules/lembretes";

const CTA_LEVE = "\n💡 Quando pagar, manda *já paguei* que eu marco.";
const CTA_FORTE = "\nJá pagou? Responde *já paguei* que eu marco 💪";

function msgD3(titulo: string, valor: number, dia: number): string {
  return `⏰ Faltam 3 dias pra vencer ${capitalizeFirst(titulo)} — ${fmtValor(valor)}.\nVence dia ${dia}.${CTA_LEVE}`;
}
function msgD2(titulo: string, valor: number, dia: number): string {
  return `Lembrete: ${capitalizeFirst(titulo)} de ${fmtValor(valor)} vence depois de amanhã (dia ${dia}).${CTA_LEVE}`;
}
function msgD1(titulo: string, valor: number): string {
  return `⚠️ ${capitalizeFirst(titulo)} vence AMANHÃ — ${fmtValor(valor)}.${CTA_FORTE}`;
}
function msgD0(titulo: string, valor: number): string {
  return `🔔 Hoje vence *${capitalizeFirst(titulo)} ${fmtValor(valor)}*.${CTA_FORTE}`;
}
function msgAtrasado(titulo: string, valor: number): string {
  return `🚨 ${capitalizeFirst(titulo)} (${fmtValor(valor)}) venceu ontem.${CTA_FORTE}`;
}

export async function executarAvisos(): Promise<{ candidatos: number; enviados: number }> {
  let candidatos = 0;
  let enviados = 0;
  try {
    const r = await pool.query<LembreteRow & { telefone: string }>(
      `SELECT l.*, u.telefone
       FROM lembretes l
       JOIN users u ON u.id = l.user_id
       WHERE l.status = 'pendente'
         AND l.proxima_data BETWEEN
              ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date - 1)
              AND ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date + 3)
         AND (l.ultimo_aviso_em IS NULL
              OR l.ultimo_aviso_em < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
         AND (
           (u.subscription_status = 'trial'  AND u.trial_ends_at > NOW())
           OR
           (u.subscription_status = 'active' AND u.subscription_expires_at > NOW())
         )`,
    );
    candidatos = r.rowCount ?? 0;

    for (const l of r.rows) {
      const dias = diasAteVencimento(l.proxima_data);
      const valor = Number(l.valor);
      let texto: string | null = null;
      if (dias === 3)      texto = msgD3(l.titulo, valor, l.dia_vencimento);
      else if (dias === 2) texto = msgD2(l.titulo, valor, l.dia_vencimento);
      else if (dias === 1) texto = msgD1(l.titulo, valor);
      else if (dias === 0) texto = msgD0(l.titulo, valor);
      else if (dias <= -1) texto = msgAtrasado(l.titulo, valor);
      else continue;

      try {
        await whatsapp.sendText({ to: l.telefone, text: texto });
        await pool.query(
          `UPDATE lembretes SET ultimo_aviso_em = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date, atualizado_em = NOW() WHERE id = $1`,
          [l.id],
        );
        await pool.query(
          `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
           VALUES ($1, 'aguardando_pagamento_aviso', 'waiting_paguei', $2::jsonb, NOW() + INTERVAL '48 hours')
           ON CONFLICT (user_id) DO UPDATE
             SET action = 'aguardando_pagamento_aviso', step = 'waiting_paguei', tx_ids = $2::jsonb,
                 selected_tx_id = NULL, expires_at = NOW() + INTERVAL '48 hours'`,
          [l.user_id, JSON.stringify({ lembrete_id: l.id, titulo: l.titulo, valor, sent_at: new Date().toISOString() })]
        );
        enviados += 1;
        log.whatsapp("lembrete aviso enviado", { id: l.id, userId: l.user_id, dias });
      } catch (err) {
        log.error("falha aviso lembrete", err, { id: l.id, userId: l.user_id });
      }
    }
  } catch (err) {
    log.error("executarAvisos falhou", err);
  }
  return { candidatos, enviados };
}
