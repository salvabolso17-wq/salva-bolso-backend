import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor, capitalizeFirst } from "../../utils/formatting";
import { diasAteVencimento, type LembreteRow } from "../modules/lembretes";

function msgD3(titulo: string, valor: number, dia: number): string {
  return `⏰ Faltam 3 dias pra vencer ${capitalizeFirst(titulo)} — ${fmtValor(valor)}.\nVence dia ${dia}.`;
}
function msgD2(titulo: string, valor: number, dia: number): string {
  return `Lembrete: ${capitalizeFirst(titulo)} de ${fmtValor(valor)} vence depois de amanhã (dia ${dia}).`;
}
function msgD1(titulo: string, valor: number): string {
  return `⚠️ ${capitalizeFirst(titulo)} vence AMANHÃ — ${fmtValor(valor)}.\nQuando pagar, é só me falar: "paguei a ${titulo.toLowerCase()}".`;
}
function msgAtrasado(titulo: string): string {
  return `🚨 ${capitalizeFirst(titulo)} venceu ontem. Já pagou?\nSe sim, manda "paguei a ${titulo.toLowerCase()}".`;
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
              OR l.ultimo_aviso_em < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)`,
    );
    candidatos = r.rowCount ?? 0;

    for (const l of r.rows) {
      const dias = diasAteVencimento(l.proxima_data);
      const valor = Number(l.valor);
      let texto: string | null = null;
      if (dias === 3)      texto = msgD3(l.titulo, valor, l.dia_vencimento);
      else if (dias === 2) texto = msgD2(l.titulo, valor, l.dia_vencimento);
      else if (dias === 1) texto = msgD1(l.titulo, valor);
      else if (dias <= -1) texto = msgAtrasado(l.titulo);
      else if (dias === 0) continue;
      else continue;

      try {
        await whatsapp.sendText({ to: l.telefone, text: texto });
        await pool.query(
          `UPDATE lembretes SET ultimo_aviso_em = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date, atualizado_em = NOW() WHERE id = $1`,
          [l.id],
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
