import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor, capitalizeFirst } from "../../utils/formatting";
import { recordAction, setLastCommand, setLastContext } from "../conversationEngine";
import { upsertRecorrente } from "../modules/recurringDetection";
import { checkAndSendOnboardingTip } from "../modules/insightsEngine";
import { resetInactivityNudge } from "../notificationService";
import type { UserRow, ProcessResult } from "../types";

export async function handleConfirmarRecorrente(user: UserRow, telefone: string, txIds: unknown): Promise<ProcessResult> {
  try {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

    // Atualização de valor de recorrente existente
    if (!Array.isArray(txIds) && (txIds as Record<string, unknown>).update === true) {
      const data = txIds as { update: true; nome: string; novoValor: number };
      await pool.query(
        `UPDATE recurring_expenses SET valor = $1 WHERE user_id = $2 AND LOWER(TRIM(nome)) = LOWER(TRIM($3))`,
        [data.novoValor, user.id, data.nome]
      );
      recordAction(user.id, "created_recurring");
      setLastContext(user.id, "recurring");
      await whatsapp.sendText({
        to:   telefone,
        text: `Atualizado 🙂 ${capitalizeFirst(data.nome)} agora é ${fmtValor(data.novoValor)} por mês.`,
      });
      return { success: false, userId: user.id, erro: "Recorrente atualizado" };
    }

    // Array → confirmação de lista multi-line
    if (Array.isArray(txIds)) {
      const items = txIds as { nome: string; valor: number; frequencia: string }[];
      for (const item of items) {
        await upsertRecorrente(user.id, item.nome, item.valor, item.frequencia);
        try {
          await pool.query(
            `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
             VALUES ($1, 'saida', $2, 'Moradia', $3)`,
            [user.id, item.valor, item.nome]
          );
        } catch (e) {
          log.error("erro ao inserir transaction da conta fixa no onboarding", e);
        }
      }
      recordAction(user.id, "created_recurring");
      setLastCommand(user.id, "recorrentes");
      setLastContext(user.id, "recurring");
      const nomes = items.map(i => capitalizeFirst(i.nome)).join(", ");
      await whatsapp.sendText({
        to:   telefone,
        text: `Perfeito 🙂\nVou acompanhar ${nomes} automaticamente.`,
      });
      log.whatsapp("recorrentes confirmados (lista)", { to: telefone, userId: user.id, count: items.length });
      return { success: false, userId: user.id, erro: "Recorrentes confirmados" };
    }

    // Objeto único → fluxo original
    const data = txIds as { nome: string; valor: number; frequencia: string };
    await upsertRecorrente(user.id, data.nome, data.valor, data.frequencia);
    try {
      await pool.query(
        `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
         VALUES ($1, 'saida', $2, 'Moradia', $3)`,
        [user.id, data.valor, data.nome]
      );
    } catch (e) {
      log.error("erro ao inserir transaction da conta fixa no onboarding", e);
    }
    const nome = capitalizeFirst(data.nome);
    recordAction(user.id, "created_recurring");
    setLastCommand(user.id, "recorrentes");
    setLastContext(user.id, "recurring");
    await whatsapp.sendText({
      to:   telefone,
      text: `Perfeito 🙂\nVou acompanhar ${nome} automaticamente.`,
    });
    log.whatsapp("recorrente confirmado pelo usuario", { to: telefone, userId: user.id, nome: data.nome });
    return { success: false, userId: user.id, erro: "Recorrente confirmado" };
  } catch (err) {
    log.error("falha ao confirmar recorrente", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "Erro ao criar recorrente" };
  }
}

export async function handleConfirmarRecorrenteMulti(user: UserRow, telefone: string, texto: string, txIdsRaw: unknown): Promise<ProcessResult> {
  const items = (Array.isArray(txIdsRaw) ? txIdsRaw : []) as { nome: string; valor: number; frequencia: string }[];
  if (items.length === 0) {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    return { success: false, userId: user.id, erro: "tx_ids vazio" };
  }
  const t = texto.toLowerCase();

  let selectedIndices: number[] = [];

  // Intenção forte de "todos/todas" (ou simulação de "sim" absoluto num contexto onde a lista foi mostrada)
  const isTodos = /^(todos?|todas|sim\s+todos?|todos?\s+eles|as\s+duas|os\s+dois|ambos|tudo)[\?!.]*$/i.test(t.trim());
  const isSim = /^(sim|s|yes|pode|quero|claro|ok|beleza|bora|certo|perfeito|tá|ta)[\?!.]*$/i.test(t.trim());

  if (isTodos || isSim) {
    selectedIndices = items.map((_, i) => i);
  } else {
    // Parse numbers
    const matches = t.match(/\d+/g);
    if (matches) {
       selectedIndices = matches.map(n => parseInt(n, 10) - 1).filter(i => i >= 0 && i < items.length);
    }
  }

  if (selectedIndices.length === 0) {
     await whatsapp.sendText({ to: telefone, text: "Não entendi quais. Pode mandar os números? (ex: 1 e 2)\nOu 'nenhum' para pular." });
     return { success: false, userId: user.id, erro: "Aguardando seleção válida" };
  }

  const selectedItems = selectedIndices.map(i => items[i]);

  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

  let totalFixo = 0;
  for (const item of selectedItems) {
    await upsertRecorrente(user.id, item.nome, item.valor, item.frequencia);
    try {
      await pool.query(
        `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
         VALUES ($1, 'saida', $2, 'Moradia', $3)`,
        [user.id, item.valor, item.nome]
      );
    } catch (e) {
      log.error("erro ao inserir transaction da conta fixa no onboarding", e);
    }
    totalFixo += item.valor;
  }

  recordAction(user.id, "created_recurring");
  setLastCommand(user.id, "recorrentes");
  setLastContext(user.id, "recurring");

  const linhas = ["🔄 Perfeito!", "Vou acompanhar essas contas automaticamente:", ""];
  for (const item of selectedItems) {
    linhas.push(`• ${capitalizeFirst(item.nome)}`);
  }
  linhas.push("", `Total fixo por mês: ${fmtValor(totalFixo)}`);

  await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "confirmar_recorrente_multi" } };
}

export async function handleRecorrentesCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando recorrentes", { userId: user.id });

  const result = await pool.query<{ nome: string; valor: string; frequencia: string }>(
    `SELECT nome, valor, frequencia
     FROM recurring_expenses
     WHERE user_id = $1 AND ativo = TRUE
     ORDER BY criado_em ASC`,
    [user.id]
  );

  if (result.rows.length === 0) {
    await whatsapp.sendText({
      to:   telefone,
      text: "Nenhum recorrente ainda.\nPara adicionar: recorrente 39 netflix mensal",
    });
    return {
      success:      true,
      userId:       user.id,
      transacao:    {},
      interpretado: { comando: "recorrentes", count: 0 },
    };
  }

  const linhas = ["📌 Seus gastos fixos:", ""];
  let totalMensal = 0;

  for (const row of result.rows) {
    const valor = Number(row.valor);
    totalMensal += valor;
    linhas.push(`• ${row.nome} — ${fmtValor(valor)}`);
  }

  linhas.push("", `Total mensal: ${fmtValor(totalMensal)}`);

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("recorrentes enviado", { to: telefone, count: result.rows.length, totalMensal });
  } catch (err) {
    log.error("falha ao enviar recorrentes", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "recorrentes", count: result.rows.length, totalMensal },
  };
}

export async function handleProximasCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando proximas", { userId: user.id });

  const result = await pool.query<{ nome: string; valor: string }>(
    `SELECT nome, valor
     FROM recurring_expenses
     WHERE user_id = $1 AND ativo = TRUE
     ORDER BY criado_em ASC`,
    [user.id]
  );

  if (result.rows.length === 0) {
    await whatsapp.sendText({
      to:   telefone,
      text: "Nenhuma conta recorrente cadastrada.\n\n💡 Ex:\nrecorrente 39 netflix mensal",
    });
    return {
      success:      true,
      userId:       user.id,
      transacao:    {},
      interpretado: { comando: "proximas", count: 0 },
    };
  }

  const linhas = ["📅 Próximas contas", ""];
  let total = 0;

  for (const row of result.rows) {
    const valor = Number(row.valor);
    total += valor;
    linhas.push(`${row.nome} — ${fmtValor(valor)}`);
  }

  linhas.push("", `Total previsto: ${fmtValor(total)}`);

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("proximas enviado", { to: telefone, count: result.rows.length, total });
  } catch (err) {
    log.error("falha ao enviar proximas", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "proximas", count: result.rows.length, total },
  };
}

export async function handleRecorrenteCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("comando recorrente", { userId: user.id, texto });

  const match = texto.match(/^recorrente\s+([\d,.]+)\s+(.+)$/i);
  if (!match) {
    await whatsapp.sendText({ to: telefone, text: "💡 Ex:\nrecorrente 39 netflix mensal" });
    return { success: false, userId: user.id, erro: "Formato inválido" };
  }

  const valor  = parseFloat(match[1].replace(",", "."));
  const partes = match[2].trim().split(/\s+/);
  const ultima = partes[partes.length - 1].toLowerCase();

  const FREQUENCIAS = ["mensal", "semanal", "anual"];
  let frequencia = "mensal";
  let nomePartes = partes;

  if (FREQUENCIAS.includes(ultima)) {
    frequencia = ultima;
    nomePartes = partes.slice(0, -1);
  }

  if (nomePartes.length === 0) {
    await whatsapp.sendText({ to: telefone, text: "💡 Ex:\nrecorrente 39 netflix mensal" });
    return { success: false, userId: user.id, erro: "Nome ausente" };
  }

  const nomeRaw = nomePartes.join(" ");
  const nome    = nomeRaw.charAt(0).toUpperCase() + nomeRaw.slice(1).toLowerCase();
  const freqLabel = frequencia.charAt(0).toUpperCase() + frequencia.slice(1);

  await upsertRecorrente(user.id, nome, valor, frequencia);

  await whatsapp.sendText({
    to:   telefone,
    text: `🔁 Gasto recorrente criado\n\n${nome} — ${fmtValor(valor)}\n${freqLabel}`,
  });

  log.whatsapp("recorrente criado", { to: telefone, nome, valor, frequencia });
  recordAction(user.id, "created_recurring");

  setTimeout(() => {
    checkAndSendOnboardingTip(user.id, telefone, "recorrente_criado").catch(err =>
      log.error("falha ao verificar onboarding tip recorrente_criado", err, { userId: user.id })
    );
  }, 800);

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "recorrente", nome, valor, frequencia },
  };
}

// ── Helpers internos ──────────────────────────────────────────────────────────

function extractEditValues(texto: string): { nome: string; valor: number } | null {
  const t = texto.trim();
  const m1 = t.match(/^(.+?)\s+(?:subiu|passou|ficou|mudou|vale)\s+(?:para\s+)?([\d,.]+)/i);
  if (m1) return { nome: m1[1].trim(), valor: parseFloat(m1[2].replace(",", ".")) };
  const m2 = t.match(/^(.+?)\s+agora\s+[eé]\s+([\d,.]+)/i);
  if (m2) return { nome: m2[1].trim(), valor: parseFloat(m2[2].replace(",", ".")) };
  const m3 = t.match(/(?:mudar?|atualizar?|editar?|alterar?)\s+(.+?)\s+(?:para|p\/)\s*([\d,.]+)/i);
  if (m3) return { nome: m3[1].trim(), valor: parseFloat(m3[2].replace(",", ".")) };
  return null;
}

function extractRecorrenteName(texto: string): string | null {
  const t = texto.trim();
  const m1 = t.match(/(?:cancelei?|parei?|encerrei?|removi?|apaguei?|exclu[ií]|paguei?|quitei?|liquidei?|j[aá]\s+paguei?)\s+(?:a\s+|o\s+|as\s+|os\s+)?(.+?)[\?!.]*$/i);
  if (m1) return m1[1].trim();
  const m2 = t.match(/^(.+?)\s+(?:subiu|passou|ficou|agora\s+[eé]|mudou|foi\s+cancel)/i);
  if (m2) return m2[1].trim();
  return null;
}

// ── Editar recorrente ─────────────────────────────────────────────────────────

export async function handleEditarRecorrenteAI(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  try {
    const extracted = extractEditValues(texto);
    if (!extracted || isNaN(extracted.valor) || extracted.valor <= 0) {
      await whatsapp.sendText({ to: telefone, text: "💡 Ex: _aluguel subiu para 1300_" });
      return { success: false, userId: user.id, erro: "formato inválido" };
    }
    const { nome, valor } = extracted;
    const result = await pool.query<{ id: number; nome: string }>(
      `SELECT id, nome FROM recurring_expenses
       WHERE user_id = $1 AND ativo = TRUE AND LOWER(nome) ILIKE LOWER($2)
       ORDER BY nome ASC LIMIT 1`,
      [user.id, `%${nome}%`]
    );
    if (result.rows.length === 0) {
      await whatsapp.sendText({ to: telefone, text: `Não encontrei _${nome}_ nas contas fixas.\nUse _recorrentes_ para ver a lista.` });
      return { success: false, userId: user.id, erro: "recorrente não encontrado" };
    }
    const row = result.rows[0];
    await pool.query(`UPDATE recurring_expenses SET valor = $1 WHERE id = $2`, [valor, row.id]);
    await whatsapp.sendText({ to: telefone, text: `✅ *${capitalizeFirst(row.nome)}* atualizado para ${fmtValor(valor)}.` });
    recordAction(user.id, "created_recurring");
    setLastContext(user.id, "recurring");
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "editar_recorrente", nome: row.nome, valor } };
  } catch (err) {
    log.error("handleEditarRecorrenteAI falhou", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "erro editar recorrente" };
  }
}

// ── Apagar recorrente (step 1 — pede confirmação) ─────────────────────────────

export async function handleApagarRecorrenteAI(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  try {
    const nome = extractRecorrenteName(texto);
    if (!nome) {
      await whatsapp.sendText({ to: telefone, text: "💡 Ex: _cancelei a netflix_" });
      return { success: false, userId: user.id, erro: "nome não extraído" };
    }
    const result = await pool.query<{ id: number; nome: string }>(
      `SELECT id, nome FROM recurring_expenses
       WHERE user_id = $1 AND ativo = TRUE AND LOWER(nome) ILIKE LOWER($2)
       ORDER BY nome ASC LIMIT 1`,
      [user.id, `%${nome}%`]
    );
    if (result.rows.length === 0) {
      await whatsapp.sendText({ to: telefone, text: `Não encontrei _${nome}_ nas contas fixas.\nUse _recorrentes_ para ver a lista.` });
      return { success: false, userId: user.id, erro: "recorrente não encontrado" };
    }
    const row = result.rows[0];
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    await pool.query(
      `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
       VALUES ($1, 'apagar_recorrente', 'waiting_confirmation', $2::jsonb, NOW() + INTERVAL '10 minutes')`,
      [user.id, JSON.stringify({ id: row.id, nome: row.nome })]
    );
    await whatsapp.sendText({ to: telefone, text: `Quer remover *${capitalizeFirst(row.nome)}* das contas fixas?\n\n_sim_ para confirmar · _não_ para cancelar.` });
    return { success: false, userId: user.id, erro: "aguardando confirmação apagar" };
  } catch (err) {
    log.error("handleApagarRecorrenteAI falhou", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "erro apagar recorrente" };
  }
}

// ── Apagar recorrente (step 2 — processa confirmação) ────────────────────────

export async function handleConfirmarApagarRecorrente(user: UserRow, telefone: string, texto: string, txIdsRaw: unknown): Promise<ProcessResult> {
  const data = txIdsRaw as { id: number; nome: string };
  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
  const isSim = /^(sim|s|yes|pode|ok|beleza|claro|certo|confirma)[\?!.]*$/i.test(texto.trim());
  if (!isSim) {
    await whatsapp.sendText({ to: telefone, text: "Ok, mantive! 🙂" });
    return { success: false, userId: user.id, erro: "apagar cancelado" };
  }
  try {
    await pool.query(`UPDATE recurring_expenses SET ativo = FALSE WHERE id = $1 AND user_id = $2`, [data.id, user.id]);
    await whatsapp.sendText({ to: telefone, text: `✅ *${capitalizeFirst(data.nome)}* removido das contas fixas.` });
    setLastContext(user.id, "recurring");
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "apagar_recorrente", nome: data.nome } };
  } catch (err) {
    log.error("handleConfirmarApagarRecorrente falhou", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "erro ao apagar recorrente" };
  }
}

// ── Pagar recorrente (marcar como pago este mês) ──────────────────────────────

export async function handlePagarRecorrenteAI(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  try {
    const nome = extractRecorrenteName(texto);
    if (!nome) {
      await whatsapp.sendText({ to: telefone, text: "💡 Ex: _já paguei o aluguel_" });
      return { success: false, userId: user.id, erro: "nome não extraído" };
    }
    const result = await pool.query<{ id: number; nome: string; valor: string }>(
      `SELECT id, nome, valor FROM recurring_expenses
       WHERE user_id = $1 AND ativo = TRUE AND LOWER(nome) ILIKE LOWER($2)
       ORDER BY nome ASC LIMIT 1`,
      [user.id, `%${nome}%`]
    );
    if (result.rows.length === 0) {
      await whatsapp.sendText({ to: telefone, text: `Não encontrei _${nome}_ nas contas fixas.\nUse _recorrentes_ para ver a lista.` });
      return { success: false, userId: user.id, erro: "recorrente não encontrado" };
    }
    const row = result.rows[0];
    const valor = Number(row.valor);
    const existing = await pool.query(
      `SELECT id FROM transactions
       WHERE user_id = $1 AND tipo = 'saida'
         AND LOWER(descricao) ILIKE LOWER($2)
         AND created_at >= date_trunc('month', NOW())`,
      [user.id, `%${row.nome}%`]
    );
    if (existing.rows.length > 0) {
      await whatsapp.sendText({ to: telefone, text: `*${capitalizeFirst(row.nome)}* já está registrado este mês. 💡 Use _extrato_ para conferir.` });
      return { success: false, userId: user.id, erro: "já registrado este mês" };
    }
    await pool.query(
      `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, 'saida', $2, 'Moradia', $3)`,
      [user.id, valor, row.nome]
    );
    recordAction(user.id, "registered_transaction");
    resetInactivityNudge(user.id).catch(() => {});
    await whatsapp.sendText({ to: telefone, text: `✅ *${capitalizeFirst(row.nome)}* (${fmtValor(valor)}) registrado como pago.` });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "pagar_recorrente", nome: row.nome, valor } };
  } catch (err) {
    log.error("handlePagarRecorrenteAI falhou", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "erro pagar recorrente" };
  }
}
