import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor } from "../../utils/formatting";
import { fetchPeriodMetrics } from "../reportService";
import { parseValor } from "../../utils/parseTransaction";
import type { UserRow, ProcessResult } from "../types";

export async function handleNovoMesRenda(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("novo_mes renda recebida", { userId: user.id, texto });

  const valor = parseValor(texto.replace(/R\$\s*/i, "").trim());

  if (isNaN(valor) || valor <= 0) {
    await whatsapp.sendText({ to: telefone, text: "💡 Ex:\n3500" });
    return { success: false, userId: user.id, erro: "Valor inválido para renda" };
  }

  const now       = new Date();
  const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const meses     = ["janeiro","fevereiro","março","abril","maio","junho",
                     "julho","agosto","setembro","outubro","novembro","dezembro"];
  const mesPrev   = meses[prevStart.getUTCMonth()];
  const mesAtual  = meses[now.getUTCMonth()];

  // Calcula saldo do mês anterior ANTES de atualizar users.renda
  const metrics       = await fetchPeriodMetrics(user.id, prevStart, prevEnd);
  const rendaAnterior = Number(user.renda ?? 0) + Number(user.renda_extra ?? 0);
  const saldoPrev     = rendaAnterior + metrics.total_entradas - metrics.total_saidas;

  // Atualiza renda para o novo mês
  await pool.query(`UPDATE users SET renda = $1 WHERE id = $2`, [valor, user.id]);

  let resposta: string;

  if (saldoPrev > 0.01) {
    // Guarda saldo em centavos no pending para a próxima etapa
    await pool.query(
      `UPDATE pending_actions
       SET step = 'waiting_carryover',
           tx_ids = $1::jsonb,
           expires_at = NOW() + INTERVAL '24 hours'
       WHERE user_id = $2`,
      [JSON.stringify({ saldo_centavos: Math.round(saldoPrev * 100) }), user.id]
    );
    resposta = [
      "💰 Renda registrada.",
      "",
      `Você terminou ${mesPrev} com:`,
      `+${fmtValor(saldoPrev)}`,
      "",
      `Deseja levar esse saldo para ${mesAtual}?`,
      "",
      "1️⃣ Sim",
      "2️⃣ Não",
    ].join("\n");
  } else {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    resposta = saldoPrev < -0.01
      ? `💰 Renda registrada.\n\n${mesPrev.charAt(0).toUpperCase() + mesPrev.slice(1)} fechou no vermelho.`
      : `💰 Renda registrada.`;
  }

  await whatsapp.sendText({ to: telefone, text: resposta });
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "novo_mes_renda", valor } };
}

export async function handleNovoMesCarryover(
  user: UserRow, telefone: string, escolha: string, txIdsRaw: unknown
): Promise<ProcessResult> {
  log.webhook("novo_mes carryover", { userId: user.id, escolha });

  const saldo = ((txIdsRaw as { saldo_centavos?: number })?.saldo_centavos ?? 0) / 100;
  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

  let msg: string;
  if (escolha === "1" && saldo > 0) {
    await pool.query(
      `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, 'entrada', $2, 'Outros', 'saldo anterior')`,
      [user.id, saldo]
    );
    msg = `✅ ${fmtValor(saldo)} do mês passado adicionados ao saldo. 💰`;
  } else {
    msg = "✅ Ok! Começando o mês do zero. 🚀";
  }

  await whatsapp.sendText({ to: telefone, text: msg });
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "novo_mes_carryover", escolha } };
}
