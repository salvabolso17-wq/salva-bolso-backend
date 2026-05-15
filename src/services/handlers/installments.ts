import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor, capitalizeFirst } from "../../utils/formatting";
import { parseTransaction, parseValor } from "../../utils/parseTransaction";
import { recordAction, setLastInstallment, getLastInstallment } from "../conversationEngine";
import { checkAndSendOnboardingTip, checkAndSendInsights, checkAndSendSmartInsights } from "../modules/insightsEngine";
import { checkLimiteCategoria } from "./reports";
import { resetInactivityNudge } from "../notificationService";
import type { UserRow, ProcessResult } from "../types";
import type { InstallmentCtx } from "../conversationEngine";

export interface InstallmentInfo {
  item:          string;
  valor:         number;
  totalParcelas: number;
  needsParcela?: boolean;
  valorTotal?:   number;
}

interface InstallmentDbRow {
  id: number;
  nome: string;
  valor_parcela: number;
  total_parcelas: number;
  parcelas_pagas: number;
  valor_total: number;
}

export async function getInstallmentFromDb(userId: number): Promise<InstallmentCtx | null> {
  try {
    const r = await pool.query<InstallmentDbRow>(
      `SELECT id, nome, valor_parcela, total_parcelas, parcelas_pagas, valor_total
       FROM installments
       WHERE user_id = $1 AND ativo = TRUE
       ORDER BY criado_em DESC
       LIMIT 1`,
      [userId]
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return {
      item:          row.nome,
      valor:         Number(row.valor_parcela),
      totalParcelas: row.total_parcelas,
      parcelaAtual:  row.parcelas_pagas + 1,
      dbId:          row.id,
      valorTotal:    Number(row.valor_total),
    };
  } catch {
    return null;
  }
}

export function detectInstallment(texto: string): InstallmentInfo | null {
  const t = texto.trim();

  // Pattern A: "iphone 12x de 755" or "tv 10x 230" — per-installment value given
  let m = t.match(/^(.+?)\s+(\d{1,2})\s*[xX]\s+(?:de\s+)?([\d,.]+)$/i);
  if (m) {
    const item          = m[1].trim();
    const totalParcelas = parseInt(m[2], 10);
    const valor         = parseValor(m[3]);
    if (!(/^\d/.test(item)) && item.length >= 2 && totalParcelas >= 2 && totalParcelas <= 72 && valor > 0) {
      return { item, valor, totalParcelas };
    }
  }

  // Pattern B: "celular 12 parcelas de 300"
  m = t.match(/^(.+?)\s+(\d{1,2})\s+parcelas?\s+de\s+([\d,.]+)$/i);
  if (m) {
    const item          = m[1].trim();
    const totalParcelas = parseInt(m[2], 10);
    const valor         = parseValor(m[3]);
    if (!(/^\d/.test(item)) && item.length >= 2 && totalParcelas >= 2 && totalParcelas <= 72 && valor > 0) {
      return { item, valor, totalParcelas };
    }
  }

  // Pattern C: "iphone 3000 12x" — total given, per-installment unknown → ask
  m = t.match(/^(.+?)\s+([\d,.]+)\s+(\d{1,2})\s*[xX]$/i);
  if (m) {
    const item          = m[1].trim();
    const valorTotal    = parseValor(m[2]);
    const totalParcelas = parseInt(m[3], 10);
    if (!(/^\d/.test(item)) && item.length >= 2 && totalParcelas >= 2 && totalParcelas <= 72 && valorTotal > 0) {
      return { item, valor: 0, totalParcelas, needsParcela: true, valorTotal };
    }
  }

  // Pattern D: "iphone 12x" / "iphone em 12x" — sem valor nenhum → pede valor da parcela
  m = t.match(/^(.+?)\s+(\d{1,2})\s*[xX]$/i);
  if (m) {
    const rawItem       = m[1].trim();
    const item          = rawItem.replace(/\s+(?:em|no|na|de|para|por)\s*$/i, "").trim();
    const totalParcelas = parseInt(m[2], 10);
    if (!(/^\d/.test(item)) && item.length >= 2 && totalParcelas >= 2 && totalParcelas <= 72) {
      return { item, valor: 0, totalParcelas, needsParcela: true };
    }
  }

  return null;
}

// ── Installment progress detector ────────────────────────────────────────────

type ProgressResult =
  | { type: "quitado" }
  | { type: "comecou" }
  | { type: "metade" }
  | { type: "pago";    pago: number; total?: number }
  | { type: "faltam";  faltam: number }
  | { type: "current"; atual: number };

export function detectInstallmentProgress(texto: string): ProgressResult | null {
  const t = texto.trim().toLowerCase();

  // "terminei de pagar", "já quitei", "quitei tudo", "já acabou"
  if (/\b(terminei\s+de\s+pagar|j[aá]\s+quitei\s+tudo|j[aá]\s+quitei|quitei\s+tudo|j[aá]\s+acabou|paguei\s+tudo|acabei\s+de\s+pagar)\b/.test(t)) {
    return { type: "quitado" };
  }

  // "comecei agora", "primeira parcela", "é a primeira"
  if (/\b(comecei\s+agora|paguei\s+a\s+primeira|primeira\s+parcela|[eéè]\s+a\s+primeira)\b/.test(t)) {
    return { type: "comecou" };
  }

  // "já quitei metade", "paguei metade", "tô na metade"
  if (/\b(j[aá]\s+quitei\s+metade|paguei\s+(a\s+)?metade|t[oô]\s+na\s+metade|metade\s+j[aá]\s+pag)\b/.test(t)) {
    return { type: "metade" };
  }

  // "faltam 3", "restam 2", "faltam 2 parcelas"
  let m = t.match(/\b(faltam|restam|falta|resta)\s+(\d+)(\s+parcelas?)?\b/);
  if (m) return { type: "faltam", faltam: parseInt(m[2], 10) };

  // "tô na parcela 6", "estou na 6", "é a 6ª"
  m = t.match(/\b(t[oô]\s+na\s+parcela|estou\s+na\s+parcela|[eéè]\s+a\s+parcela|estou\s+na|t[oô]\s+na)\s+(\d+)/);
  if (m) return { type: "current", atual: parseInt(m[2], 10) };

  m = t.match(/\b[eéè]\s+a\s+(\d+)[aª]?\b/);
  if (m) return { type: "current", atual: parseInt(m[1], 10) };

  // "já paguei N de M", "paguei N de M", "quitei N de M"
  m = t.match(/\b(j[aá]\s+)?(paguei|quitei)\s+(\d+)\s+de\s+(\d+)/);
  if (m) return { type: "pago", pago: parseInt(m[3], 10), total: parseInt(m[4], 10) };

  // "já paguei N parcelas", "paguei N"
  m = t.match(/\b(j[aá]\s+)?(paguei|quitei)\s+(\d+)(\s+parcelas?)?\b/);
  if (m) return { type: "pago", pago: parseInt(m[3], 10) };

  return null;
}

export function buildInstallmentProgressText(result: ProgressResult, inst: { item: string; totalParcelas: number }): string {
  const { item, totalParcelas } = inst;

  switch (result.type) {
    case "quitado":
      return `Ótimo 🙂\n${item} — quitado!`;

    case "comecou":
      return `Perfeito 🙂\nFaltam ${totalParcelas - 1} parcelas do ${item}.`;

    case "metade": {
      const faltam = Math.ceil(totalParcelas / 2);
      return `Certo 🙂\nFaltam mais ou menos ${faltam} parcelas do ${item}.`;
    }

    case "pago": {
      const total = result.total ?? totalParcelas;
      const faltam = total - result.pago;
      if (faltam <= 0) return `Ótimo 🙂\n${item} — quitado!`;
      return `Perfeito 🙂\nFaltam ${faltam} parcela${faltam > 1 ? "s" : ""} do ${item}.`;
    }

    case "faltam":
      return `Certo 🙂\nFaltam ${result.faltam} parcela${result.faltam > 1 ? "s" : ""} do ${item}.`;

    case "current": {
      const faltam = totalParcelas - result.atual;
      if (faltam <= 0) return `Ótimo 🙂\n${item} — quitado!`;
      return `Certo 🙂\nParcela ${result.atual} de ${totalParcelas} — faltam ${faltam}.`;
    }
  }
}

export async function handleInstallmentRegistration(
  user: UserRow,
  telefone: string,
  info: InstallmentInfo,
): Promise<ProcessResult> {
  const { item, valor, totalParcelas } = info;

  // Infer category by re-using existing parser on "valor item"
  const tempParsed = parseTransaction(`${valor} ${item}`);
  const categoria  = tempParsed?.categoria ?? "Outros";
  const descricao  = capitalizeFirst(item);

  const total = valor * totalParcelas;
  log.parser("parcela detectada", { item, valor, totalParcelas, categoria });

  // Save as expense transaction + installment record
  let transacaoRow: Record<string, unknown>;
  try {
    const txResult = await pool.query(
      `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, 'saida', $2, $3, $4)
       RETURNING *`,
      [user.id, valor, categoria, descricao]
    );
    transacaoRow = txResult.rows[0] as Record<string, unknown>;

    const instResult = await pool.query<{ id: number }>(
      `INSERT INTO installments (user_id, nome, valor_total, valor_parcela, total_parcelas, parcelas_pagas, categoria)
       VALUES ($1, $2, $3, $4, $5, 1, $6)
       RETURNING id`,
      [user.id, descricao, total, valor, totalParcelas, categoria]
    );
    const dbId = instResult.rows[0].id;

    recordAction(user.id, "registered_transaction");
    resetInactivityNudge(user.id).catch(() => {});
    setLastInstallment(user.id, { item: descricao, valor, totalParcelas, parcelaAtual: 1, dbId, valorTotal: total });
    log.db("parcela salva", { id: transacaoRow.id, installmentId: dbId, user_id: user.id });
  } catch (err) {
    log.error("falha ao salvar parcela", err, { user_id: user.id });
    return { success: false, userId: user.id, erro: "Erro ao salvar parcela" };
  }

  // Check limit alert
  const aviso = await checkLimiteCategoria(user.id, categoria).catch(() => null);

  // Natural confirmation with installment context
  const linhas = [
    `✅ ${fmtValor(valor)} — ${descricao}`,
    ``,
    `${totalParcelas} parcelas de ${fmtValor(valor)}`,
    `Total: ${fmtValor(total)}`,
  ];
  if (aviso) linhas.push("", aviso);

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("parcela confirmada", { to: telefone, userId: user.id, item, valor, totalParcelas });
  } catch (err) {
    log.error("falha ao confirmar parcela", err, { to: telefone });
  }

  // Insight chain (same gates as regular expenses)
  setTimeout(async () => {
    try {
      const { canSendInsight, recordInsightSent } = await import("../conversationEngine");
      if (!canSendInsight(user.id)) return;
      if (await checkAndSendOnboardingTip(user.id, telefone, "saida")) { recordInsightSent(user.id); return; }
      if (await checkAndSendInsights(user.id, telefone, categoria))    { recordInsightSent(user.id); return; }
      if (await checkAndSendSmartInsights(user.id, telefone, descricao, categoria)) { recordInsightSent(user.id); return; }
    } catch (err) {
      log.error("falha no insight chain (parcela)", err, { userId: user.id });
    }
  }, 1200);

  return {
    success:      true,
    userId:       user.id,
    transacao:    transacaoRow,
    interpretado: { tipo: "parcela", item: descricao, valor, totalParcelas },
  };
}

export async function handleInstallmentNeedsParcela(
  user: UserRow,
  telefone: string,
  info: InstallmentInfo,
): Promise<ProcessResult> {
  const { item, totalParcelas, valorTotal } = info;
  const descricao = capitalizeFirst(item);

  const payload = JSON.stringify({ item: descricao, totalParcelas, valorTotal: valorTotal ?? 0 });

  try {
    await pool.query(
      `INSERT INTO pending_actions (user_id, action, step, tx_ids)
       VALUES ($1, 'registrar_parcela', 'waiting_parcela_valor', $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE
         SET action = 'registrar_parcela', step = 'waiting_parcela_valor', tx_ids = $2::jsonb,
             selected_tx_id = NULL, expires_at = NOW() + INTERVAL '30 minutes'`,
      [user.id, payload]
    );
    const valorHint = valorTotal ? ` (total ${fmtValor(valorTotal)})` : "";
    await whatsapp.sendText({
      to:   telefone,
      text: `${descricao} — ${totalParcelas}×${valorHint}\n\nQual o valor de cada parcela?`,
    });
  } catch (err) {
    log.error("falha em handleInstallmentNeedsParcela", err, { userId: user.id });
  }

  return { success: false, userId: user.id, erro: "aguardando valor parcela" };
}

export async function handleRegistrarParcelaValor(
  user: UserRow,
  telefone: string,
  textoTrim: string,
  payload: { item: string; totalParcelas: number; valorTotal: number },
): Promise<ProcessResult> {
  const valorParcela = parseValor(textoTrim);

  if (isNaN(valorParcela) || valorParcela <= 0) {
    try {
      await whatsapp.sendText({ to: telefone, text: "Quanto é cada parcela? Ex: 250" });
    } catch (err) {
      log.error("falha ao pedir valor parcela", err, { to: telefone });
    }
    return { success: false, userId: user.id, erro: "valor parcela invalido" };
  }

  const { item, totalParcelas, valorTotal } = payload;
  const total      = valorTotal > 0 ? valorTotal : valorParcela * totalParcelas;
  const tempParsed = parseTransaction(`${valorParcela} ${item}`);
  const categoria  = tempParsed?.categoria ?? "Outros";
  const descricao  = capitalizeFirst(item);

  let transacaoRow: Record<string, unknown> = {};
  try {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

    const txResult = await pool.query(
      `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, 'saida', $2, $3, $4)
       RETURNING *`,
      [user.id, valorParcela, categoria, descricao]
    );
    transacaoRow = txResult.rows[0] as Record<string, unknown>;

    const instResult = await pool.query<{ id: number }>(
      `INSERT INTO installments (user_id, nome, valor_total, valor_parcela, total_parcelas, parcelas_pagas, categoria)
       VALUES ($1, $2, $3, $4, $5, 1, $6)
       RETURNING id`,
      [user.id, descricao, total, valorParcela, totalParcelas, categoria]
    );
    const dbId = instResult.rows[0].id;

    recordAction(user.id, "registered_transaction");
    resetInactivityNudge(user.id).catch(() => {});
    setLastInstallment(user.id, { item: descricao, valor: valorParcela, totalParcelas, parcelaAtual: 1, dbId, valorTotal: total });
    log.db("parcela salva (confirmada)", { installmentId: dbId, user_id: user.id });
  } catch (err) {
    log.error("falha ao salvar parcela confirmada", err, { user_id: user.id });
    return { success: false, userId: user.id, erro: "Erro ao salvar parcela" };
  }

  const linhas = [
    `✅ ${fmtValor(valorParcela)} — ${descricao}`,
    ``,
    `${totalParcelas} parcelas de ${fmtValor(valorParcela)}`,
    `Total: ${fmtValor(total)}`,
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
  } catch (err) {
    log.error("falha ao confirmar parcela", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    transacaoRow,
    interpretado: { tipo: "parcela", item: descricao, valor: valorParcela, totalParcelas },
  };
}
