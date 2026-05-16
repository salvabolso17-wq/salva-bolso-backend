import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor, capitalizeFirst } from "../../utils/formatting";
import { parseTransaction, parseValor } from "../../utils/parseTransaction";
import type { UserRow, ProcessResult } from "../types";

export function parseNaturalEdit(
  texto: string,
): { tipo: "corrigir"; descBusca: string; novoValor: number } | { tipo: "apagar"; descBusca: string } | null {
  const t = texto.trim().toLowerCase();

  // "apaga aquele uber", "remove a farmácia", "deleta o mercado"
  const delM = t.match(
    /^(?:apaga[r]?|remove[r]?|deleta[r]?|cancela[r]?)\s+(?:(?:esse[s]?|essa[s]?|aquele[s]?|aquela[s]?|o|a|os|as|um|uma)\s+)?([a-záéíóúãõâêôç][a-záéíóúãõâêôç\s]{0,30}?)[\?!.]*$/i,
  );
  if (delM) {
    const desc = delM[1].trim();
    if (desc.length >= 2 && !/^([uú]ltimo[s]?|[uú]ltima[s]?|gasto[s]?|lan[cç]amento[s]?|item|coisa)$/.test(desc))
      return { tipo: "apagar", descBusca: desc };
  }

  // "corrige o mercado pra 80", "muda a academia para 150"
  const corrM = t.match(
    /(?:corri[gj]e[i]?|muda[r]?|atualiza[r]?)\s+(?:o\s+|a\s+)?([a-záéíóúãõâêôç][a-záéíóúãõâêôç\s]{0,25}?)\s+(?:pra?|para)\s+r?\$?\s*([\d,.]+)/i,
  );
  if (corrM) {
    const valor = parseValor(corrM[2]);
    if (!isNaN(valor) && valor > 0) return { tipo: "corrigir", descBusca: corrM[1].trim(), novoValor: valor };
  }

  // "o valor do aluguel foi 900", "o valor da academia era 150"
  const valM = t.match(
    /o\s+valor\s+d[oa]\s+([a-záéíóúãõâêôç][a-záéíóúãõâêôç\s]{0,25}?)\s+(?:foi|era|[eéè])\s+r?\$?\s*([\d,.]+)/i,
  );
  if (valM) {
    const valor = parseValor(valM[2]);
    if (!isNaN(valor) && valor > 0) return { tipo: "corrigir", descBusca: valM[1].trim(), novoValor: valor };
  }

  // "o ifood era 42 não 32"
  const eraM = t.match(
    /o\s+([a-záéíóúãõâêôç][a-záéíóúãõâêôç\s]{0,25}?)\s+era\s+r?\$?\s*([\d,.]+)\s+(?:n[aã]o|,\s*n[aã]o)/i,
  );
  if (eraM) {
    const valor = parseValor(eraM[2]);
    if (!isNaN(valor) && valor > 0) return { tipo: "corrigir", descBusca: eraM[1].trim(), novoValor: valor };
  }

  return null;
}

export async function findRecentTxByDesc(
  userId: number,
  descBusca: string,
): Promise<{ id: number; descricao: string; valor: number; categoria: string } | "multiple" | null> {
  const desc = descBusca.toLowerCase().trim();

  const exact = await pool.query<{ id: number; descricao: string; valor: string; categoria: string }>(
    `SELECT id, descricao, valor, categoria FROM transactions
     WHERE user_id = $1 AND LOWER(descricao) = $2 AND criado_em >= NOW() - INTERVAL '30 days'
     ORDER BY criado_em DESC LIMIT 2`,
    [userId, desc],
  );
  if (exact.rows.length === 1) {
    const r = exact.rows[0];
    return { id: r.id, descricao: r.descricao, valor: Number(r.valor), categoria: r.categoria };
  }
  if (exact.rows.length > 1) return "multiple";

  const like = await pool.query<{ id: number; descricao: string; valor: string; categoria: string }>(
    `SELECT id, descricao, valor, categoria FROM transactions
     WHERE user_id = $1 AND LOWER(descricao) LIKE $2 AND criado_em >= NOW() - INTERVAL '30 days'
     ORDER BY criado_em DESC LIMIT 2`,
    [userId, `%${desc}%`],
  );
  if (like.rows.length === 1) {
    const r = like.rows[0];
    return { id: r.id, descricao: r.descricao, valor: Number(r.valor), categoria: r.categoria };
  }
  if (like.rows.length > 1) return "multiple";

  return null;
}

export async function handleApagarCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando apagar", { userId: user.id });

  const result = await pool.query<{ id: number; tipo: string; valor: string; categoria: string; descricao: string }>(
    `SELECT id, tipo, valor, categoria, descricao
     FROM transactions
     WHERE user_id = $1
     ORDER BY criado_em DESC
     LIMIT 5`,
    [user.id]
  );

  if (result.rows.length === 0) {
    await whatsapp.sendText({ to: telefone, text: "Nenhum lançamento encontrado para remover." });
    return { success: false, userId: user.id, erro: "Sem transações" };
  }

  const txIds = result.rows.map(r => r.id);

  await pool.query(
    `INSERT INTO pending_actions (user_id, action, step, tx_ids)
     VALUES ($1, 'apagar', 'waiting_selection', $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE
       SET action = 'apagar', step = 'waiting_selection', tx_ids = $2::jsonb,
           selected_tx_id = NULL, expires_at = NOW() + INTERVAL '10 minutes'`,
    [user.id, JSON.stringify(txIds)]
  );

  const linhas = ["Qual lançamento deseja remover?", ""];
  result.rows.forEach((row, i) => {
    const desc = row.descricao ?? row.categoria;
    const icon = row.tipo === "entrada" ? "💰" : "💸";
    linhas.push(`${i + 1}. ${icon} ${desc} — ${fmtValor(Number(row.valor))}`);
  });
  linhas.push(``, `Envie o número ou "cancelar".`);

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("apagar step1 enviado", { to: telefone, count: result.rows.length });
  } catch (err) {
    log.error("falha ao enviar apagar step1", err, { to: telefone });
  }

  return { success: false, userId: user.id, erro: "Aguardando seleção" };
}

export async function handleApagarSelecao(user: UserRow, telefone: string, txId: number): Promise<ProcessResult> {
  log.webhook("apagar selecao", { userId: user.id, txId });

  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

  // Captura criado_em da transaction antes de apagar (pra correlacionar com lembrete pago)
  const preRes = await pool.query<{ descricao: string; criado_em: Date }>(
    `SELECT descricao, criado_em FROM transactions WHERE id = $1 AND user_id = $2`,
    [txId, user.id]
  );
  const preDesc      = preRes.rows[0]?.descricao ?? "";
  const preCriadoEm  = preRes.rows[0]?.criado_em ?? null;

  const txResult = await pool.query<{ tipo: string; valor: string; categoria: string; descricao: string }>(
    `DELETE FROM transactions WHERE id = $1 AND user_id = $2 RETURNING tipo, valor, categoria, descricao`,
    [txId, user.id]
  );

  if (txResult.rows.length === 0) {
    await whatsapp.sendText({ to: telefone, text: "Lançamento não encontrado." });
    return { success: false, userId: user.id, erro: "Transação não encontrada" };
  }

  const tx = txResult.rows[0];

  // Reverter lembrete pago associado (se a transaction veio de pagamento de fixa)
  let revertedTitulo: string | null = null;
  if (preDesc && preCriadoEm) {
    try {
      const lembreteRes = await pool.query<{ id: number; titulo: string; proxima_data: Date | string }>(
        `SELECT id, titulo, proxima_data FROM lembretes
         WHERE user_id = $1
           AND fixa = TRUE
           AND status = 'pago'
           AND LOWER(titulo) ILIKE '%' || LOWER($2) || '%'
           AND ABS(EXTRACT(EPOCH FROM (atualizado_em - $3::timestamp))) < 60
         ORDER BY atualizado_em DESC
         LIMIT 1`,
        [user.id, preDesc, preCriadoEm]
      );
      if (lembreteRes.rows[0]) {
        const lembPago = lembreteRes.rows[0];
        await pool.query(
          `UPDATE lembretes SET status = 'pendente', atualizado_em = NOW() WHERE id = $1 AND user_id = $2`,
          [lembPago.id, user.id]
        );
        await pool.query(
          `DELETE FROM lembretes
           WHERE user_id = $1
             AND fixa = TRUE
             AND status = 'pendente'
             AND LOWER(titulo) ILIKE '%' || LOWER($2) || '%'
             AND proxima_data > $3::date`,
          [user.id, lembPago.titulo, String(lembPago.proxima_data).slice(0, 10)]
        );
        revertedTitulo = lembPago.titulo;
      }
    } catch (err) {
      log.error("falha ao reverter lembrete em handleApagarSelecao", err, { userId: user.id, txId });
    }
  }

  const linhas = revertedTitulo
    ? [`✅ Removido. *${capitalizeFirst(revertedTitulo)}* voltou pra pendente.`]
    : [
        "✅ Lançamento removido:",
        "",
        `${tx.descricao ?? tx.categoria} — ${fmtValor(Number(tx.valor))}`,
      ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("apagar confirmado", { to: telefone, txId, revertedLembrete: revertedTitulo });
  } catch (err) {
    log.error("falha ao enviar apagar confirmacao", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "apagar", txId, valor: Number(tx.valor), categoria: tx.categoria, revertedLembrete: revertedTitulo },
  };
}

export async function handleCorrigirCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando corrigir", { userId: user.id });

  const result = await pool.query<{ id: number; tipo: string; valor: string; categoria: string; descricao: string }>(
    `SELECT id, tipo, valor, categoria, descricao
     FROM transactions
     WHERE user_id = $1
     ORDER BY criado_em DESC
     LIMIT 5`,
    [user.id]
  );

  if (result.rows.length === 0) {
    await whatsapp.sendText({ to: telefone, text: "Nenhum lançamento encontrado para corrigir." });
    return { success: false, userId: user.id, erro: "Sem transações" };
  }

  const txIds = result.rows.map(r => r.id);

  await pool.query(
    `INSERT INTO pending_actions (user_id, action, step, tx_ids)
     VALUES ($1, 'corrigir', 'waiting_selection', $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE
       SET action = 'corrigir', step = 'waiting_selection', tx_ids = $2::jsonb,
           selected_tx_id = NULL, expires_at = NOW() + INTERVAL '10 minutes'`,
    [user.id, JSON.stringify(txIds)]
  );

  const linhas = ["Qual lançamento deseja corrigir?", ""];
  result.rows.forEach((row, i) => {
    const desc = row.descricao ?? row.categoria;
    const icon = row.tipo === "entrada" ? "💰" : "💸";
    linhas.push(`${i + 1}. ${icon} ${desc} — ${fmtValor(Number(row.valor))}`);
  });
  linhas.push(``, `Envie o número ou "cancelar".`);

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("corrigir step1 enviado", { to: telefone, count: result.rows.length });
  } catch (err) {
    log.error("falha ao enviar corrigir step1", err, { to: telefone });
  }

  return { success: false, userId: user.id, erro: "Aguardando seleção" };
}

export async function handleCorrigirSelecao(user: UserRow, telefone: string, txId: number): Promise<ProcessResult> {
  log.webhook("corrigir selecao", { userId: user.id, txId });

  const txResult = await pool.query<{ valor: string; categoria: string; descricao: string }>(
    `SELECT valor, categoria, descricao FROM transactions WHERE id = $1 AND user_id = $2`,
    [txId, user.id]
  );

  if (txResult.rows.length === 0) {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    await whatsapp.sendText({ to: telefone, text: "Lançamento não encontrado." });
    return { success: false, userId: user.id, erro: "Transação não encontrada" };
  }

  const tx = txResult.rows[0];

  await pool.query(
    `UPDATE pending_actions
     SET step = 'waiting_correcao_acao', selected_tx_id = $2, expires_at = NOW() + INTERVAL '10 minutes'
     WHERE user_id = $1`,
    [user.id, txId]
  );

  const desc = tx.descricao ?? tx.categoria;
  const linhas = [
    `O que quer fazer com *${desc}* (${fmtValor(Number(tx.valor))})?`,
    "",
    "1. Editar valor/descrição",
    "2. Apagar lançamento",
    "",
    `💡 Manda o número ou "cancelar"`,
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("corrigir submenu enviado", { to: telefone, txId });
  } catch (err) {
    log.error("falha ao enviar corrigir submenu", err, { to: telefone });
  }

  return { success: false, userId: user.id, erro: "Aguardando escolha corrigir/apagar" };
}

export async function handleCorrigirAcao(user: UserRow, telefone: string, texto: string, txId: number): Promise<ProcessResult> {
  const t = texto.trim();
  if (/^1[\?!.]*$/.test(t) || /^editar/i.test(t)) {
    const txResult = await pool.query<{ valor: string; categoria: string; descricao: string }>(
      `SELECT valor, categoria, descricao FROM transactions WHERE id = $1 AND user_id = $2`,
      [txId, user.id]
    );
    if (txResult.rows.length === 0) {
      await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
      await whatsapp.sendText({ to: telefone, text: "Lançamento não encontrado." });
      return { success: false, userId: user.id, erro: "Transação não encontrada" };
    }
    const tx = txResult.rows[0];
    await pool.query(
      `UPDATE pending_actions
       SET step = 'waiting_new_value', expires_at = NOW() + INTERVAL '10 minutes'
       WHERE user_id = $1`,
      [user.id]
    );
    const linhas = [
      "Envie o novo valor e descrição.",
      `Ex: ${fmtValor(Number(tx.valor))} ${tx.descricao ?? tx.categoria}`,
      "",
      `Ou "cancelar" para desistir.`,
    ];
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    return { success: false, userId: user.id, erro: "Aguardando novo valor" };
  }
  if (/^2[\?!.]*$/.test(t) || /^apagar/i.test(t)) {
    return await handleApagarSelecao(user, telefone, txId);
  }
  await whatsapp.sendText({ to: telefone, text: `💡 Manda *1* (editar) ou *2* (apagar). Ou "cancelar".` });
  return { success: false, userId: user.id, erro: "escolha corrigir/apagar inválida" };
}

export async function handleCorrigirNovoValor(user: UserRow, telefone: string, texto: string, txId: number): Promise<ProcessResult> {
  log.webhook("corrigir novo valor", { userId: user.id, txId, texto });

  const parsed = parseTransaction(texto);

  if (!parsed) {
    await whatsapp.sendText({
      to:   telefone,
      text: `💡 Ex:\n50 mercado\n\nou "cancelar"`,
    });
    return { success: false, userId: user.id, erro: "Input inválido para correção" };
  }

  await pool.query(
    `UPDATE transactions SET valor = $1, categoria = $2, descricao = $3, tipo = $4
     WHERE id = $5 AND user_id = $6`,
    [parsed.valor, parsed.categoria, parsed.descricao, parsed.tipo, txId, user.id]
  );

  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

  const linhas = [
    "✅ Lançamento atualizado:",
    "",
    `${parsed.descricao ?? parsed.categoria} — ${fmtValor(parsed.valor)}`,
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("corrigir confirmado", { to: telefone, txId, valor: parsed.valor });
  } catch (err) {
    log.error("falha ao enviar corrigir confirmacao", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "corrigir", txId, valor: parsed.valor, categoria: parsed.categoria },
  };
}

export async function handleNaturalCorrection(
  user: UserRow, telefone: string, descBusca: string, novoValor: number,
): Promise<ProcessResult> {
  try {
    const tx = await findRecentTxByDesc(user.id, descBusca);
    if (tx === null || tx === "multiple") return await handleCorrigirCommand(user, telefone);
    await pool.query(
      `UPDATE transactions SET valor = $1 WHERE id = $2 AND user_id = $3`,
      [novoValor, tx.id, user.id],
    );
    const nome = capitalizeFirst(tx.descricao);
    try {
      await whatsapp.sendText({ to: telefone, text: `✅ ${nome} atualizado para ${fmtValor(novoValor)}.` });
      log.whatsapp("corrigir_natural ok", { to: telefone, userId: user.id, txId: tx.id, novoValor });
    } catch (err) {
      log.error("falha ao confirmar corrigir_natural", err, { userId: user.id });
    }
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "corrigir_natural", txId: tx.id, novoValor } };
  } catch (err) {
    log.error("falha handleNaturalCorrection", err, { userId: user.id });
    return await handleCorrigirCommand(user, telefone);
  }
}

export async function handleNaturalDelete(
  user: UserRow, telefone: string, descBusca: string,
): Promise<ProcessResult> {
  try {
    const tx = await findRecentTxByDesc(user.id, descBusca);
    if (tx === null || tx === "multiple") return await handleApagarCommand(user, telefone);
    await pool.query(`DELETE FROM transactions WHERE id = $1 AND user_id = $2`, [tx.id, user.id]);
    const nome = capitalizeFirst(tx.descricao);
    try {
      await whatsapp.sendText({ to: telefone, text: `Pronto, ${nome} removido.` });
      log.whatsapp("apagar_natural ok", { to: telefone, userId: user.id, txId: tx.id });
    } catch (err) {
      log.error("falha ao confirmar apagar_natural", err, { userId: user.id });
    }
    return { success: false, userId: user.id, erro: "apagar_natural_ok" };
  } catch (err) {
    log.error("falha handleNaturalDelete", err, { userId: user.id });
    return await handleApagarCommand(user, telefone);
  }
}
