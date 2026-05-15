// Handlers de "recorrentes" — agora delegam pra tabela `lembretes`.
// recurring_expenses está deprecated; queda planejada em 30 dias após cutover.

import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor, capitalizeFirst } from "../../utils/formatting";
import { recordAction, setLastCommand, setLastContext } from "../conversationEngine";
import { checkAndSendOnboardingTip } from "../modules/insightsEngine";
import { resetInactivityNudge } from "../notificationService";
import { iniciarFluxoCriacaoLembrete } from "./lembretes";
import type { UserRow, ProcessResult } from "../types";

// ── Confirmação após "X aparece todo mês? 🔁" → "sim" ──────────────────────────
// Migrado: cria lembrete via fluxo de criação, perguntando o dia de vencimento.
export async function handleConfirmarRecorrente(user: UserRow, telefone: string, txIds: unknown): Promise<ProcessResult> {
  try {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

    // Atualização de valor de recorrente existente (vem do checkRecorrenteDuplicado)
    if (!Array.isArray(txIds) && (txIds as Record<string, unknown>).update === true) {
      const data = txIds as { update: true; nome: string; novoValor: number };
      await pool.query(
        `UPDATE lembretes SET valor = $1, atualizado_em = NOW()
         WHERE user_id = $2 AND LOWER(TRIM(titulo)) = LOWER(TRIM($3))
           AND fixa = TRUE AND status = 'pendente'`,
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

    // Lista (multi-line onboarding) → cria lembretes em lote com dia=hoje BRT
    if (Array.isArray(txIds)) {
      const items = txIds as { nome: string; valor: number; frequencia: string }[];
      for (const item of items) {
        await pool.query(
          `INSERT INTO lembretes (user_id, titulo, valor, dia_vencimento, fixa, proxima_data, status, ultimo_aviso_em)
           SELECT $1, $2, $3,
                  LEAST(EXTRACT(DAY FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int, 28),
                  TRUE,
                  ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '1 month')::date,
                  'pendente',
                  (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
           WHERE NOT EXISTS (
             SELECT 1 FROM lembretes
             WHERE user_id = $1 AND LOWER(titulo) = LOWER($2) AND fixa = TRUE AND status = 'pendente'
           )`,
          [user.id, item.nome, item.valor],
        );
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
        text: `Perfeito 🙂\nVou acompanhar ${nomes} automaticamente. Se algum vencer em outro dia, manda "muda <nome> pra dia X".`,
      });
      log.whatsapp("lembretes confirmados (lista)", { to: telefone, userId: user.id, count: items.length });
      return { success: false, userId: user.id, erro: "Lembretes confirmados (lote)" };
    }

    // Objeto único → pergunta dia via fluxo de criar lembrete
    const data = txIds as { nome: string; valor: number; frequencia: string };
    recordAction(user.id, "created_recurring");
    setLastContext(user.id, "recurring");
    log.webhook("recorrente confirmado — perguntando dia", { userId: user.id, nome: data.nome });
    return await iniciarFluxoCriacaoLembrete(user, telefone, {
      titulo: data.nome,
      valor:  data.valor,
      fixa:   true,
    });
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
  const isTodos = /^(todos?|todas|sim\s+todos?|todos?\s+eles|as\s+duas|os\s+dois|ambos|tudo)[\?!.]*$/i.test(t.trim());
  const isSim = /^(sim|s|yes|pode|quero|claro|ok|beleza|bora|certo|perfeito|tá|ta)[\?!.]*$/i.test(t.trim());

  if (isTodos || isSim) {
    selectedIndices = items.map((_, i) => i);
  } else {
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
    await pool.query(
      `INSERT INTO lembretes (user_id, titulo, valor, dia_vencimento, fixa, proxima_data, status, ultimo_aviso_em)
       SELECT $1, $2, $3,
              LEAST(EXTRACT(DAY FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int, 28),
              TRUE,
              ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '1 month')::date,
              'pendente',
              (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
       WHERE NOT EXISTS (
         SELECT 1 FROM lembretes
         WHERE user_id = $1 AND LOWER(titulo) = LOWER($2) AND fixa = TRUE AND status = 'pendente'
       )`,
      [user.id, item.nome, item.valor],
    );
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
  linhas.push("", `Total fixo por mês: ${fmtValor(totalFixo)}`, "", `Se algum vencer em outro dia, manda "muda <nome> pra dia X".`);

  await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "confirmar_recorrente_multi" } };
}

// ── Listagens — agora lendo `lembretes` ──────────────────────────────────────
export async function handleRecorrentesCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando recorrentes (lembretes)", { userId: user.id });

  const result = await pool.query<{ titulo: string; valor: string; dia_vencimento: number }>(
    `SELECT titulo, valor, dia_vencimento
     FROM lembretes
     WHERE user_id = $1 AND fixa = TRUE AND status = 'pendente'
     ORDER BY proxima_data ASC, id ASC`,
    [user.id]
  );

  if (result.rows.length === 0) {
    await whatsapp.sendText({
      to:   telefone,
      text: "Nenhuma conta fixa ainda.\nPara adicionar: \"lembra de pagar netflix dia 10, 39\"",
    });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "recorrentes", count: 0 } };
  }

  const linhas = ["📌 Seus gastos fixos:", ""];
  let totalMensal = 0;
  for (const row of result.rows) {
    const valor = Number(row.valor);
    totalMensal += valor;
    linhas.push(`• ${capitalizeFirst(row.titulo)} — ${fmtValor(valor)} (dia ${row.dia_vencimento})`);
  }
  linhas.push("", `Total mensal: ${fmtValor(totalMensal)}`);

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("recorrentes (lembretes) enviado", { to: telefone, count: result.rows.length, totalMensal });
  } catch (err) {
    log.error("falha ao enviar recorrentes", err, { to: telefone });
  }
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "recorrentes", count: result.rows.length, totalMensal } };
}

export async function handleProximasCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando proximas (lembretes)", { userId: user.id });

  const result = await pool.query<{ titulo: string; valor: string; dia_vencimento: number; proxima_data: Date | string }>(
    `SELECT titulo, valor, dia_vencimento, proxima_data
     FROM lembretes
     WHERE user_id = $1 AND fixa = TRUE AND status = 'pendente'
     ORDER BY proxima_data ASC, id ASC`,
    [user.id]
  );

  if (result.rows.length === 0) {
    await whatsapp.sendText({
      to:   telefone,
      text: "Nenhuma conta recorrente cadastrada.\n\n💡 Ex: \"lembra de pagar netflix dia 10, 39\"",
    });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "proximas", count: 0 } };
  }

  const linhas = ["📅 Próximas contas", ""];
  let total = 0;
  for (const row of result.rows) {
    const valor = Number(row.valor);
    total += valor;
    linhas.push(`${capitalizeFirst(row.titulo)} — ${fmtValor(valor)} (dia ${row.dia_vencimento})`);
  }
  linhas.push("", `Total previsto: ${fmtValor(total)}`);

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("proximas (lembretes) enviado", { to: telefone, count: result.rows.length, total });
  } catch (err) {
    log.error("falha ao enviar proximas", err, { to: telefone });
  }
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "proximas", count: result.rows.length, total } };
}

// ── Comando legacy "recorrente <valor> <nome>" — cria lembrete pedindo dia ──
export async function handleRecorrenteCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("comando recorrente (legacy)", { userId: user.id, texto });

  const match = texto.match(/^recorrente\s+([\d,.]+)\s+(.+)$/i);
  if (!match) {
    await whatsapp.sendText({ to: telefone, text: "💡 Ex:\nrecorrente 39 netflix" });
    return { success: false, userId: user.id, erro: "Formato inválido" };
  }

  const valor  = parseFloat(match[1].replace(",", "."));
  const partes = match[2].trim().split(/\s+/);
  const ultima = partes[partes.length - 1].toLowerCase();

  const FREQUENCIAS = ["mensal", "semanal", "anual"];
  let nomePartes = partes;
  if (FREQUENCIAS.includes(ultima)) nomePartes = partes.slice(0, -1);
  if (nomePartes.length === 0) {
    await whatsapp.sendText({ to: telefone, text: "💡 Ex:\nrecorrente 39 netflix" });
    return { success: false, userId: user.id, erro: "Nome ausente" };
  }

  const nomeRaw = nomePartes.join(" ");
  const nome    = nomeRaw.charAt(0).toUpperCase() + nomeRaw.slice(1).toLowerCase();

  recordAction(user.id, "created_recurring");
  setLastCommand(user.id, "recorrentes");

  setTimeout(() => {
    checkAndSendOnboardingTip(user.id, telefone, "recorrente_criado").catch(err =>
      log.error("falha ao verificar onboarding tip recorrente_criado", err, { userId: user.id })
    );
  }, 800);

  // Delega pro fluxo de criação de lembrete — vai perguntar dia
  return await iniciarFluxoCriacaoLembrete(user, telefone, { titulo: nome, valor, fixa: true });
}

// ── Helpers para AI handlers ─────────────────────────────────────────────────
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

// ── Editar via AI ────────────────────────────────────────────────────────────
export async function handleEditarRecorrenteAI(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  try {
    const extracted = extractEditValues(texto);
    if (!extracted || isNaN(extracted.valor) || extracted.valor <= 0) {
      await whatsapp.sendText({ to: telefone, text: "💡 Ex: _aluguel subiu para 1300_" });
      return { success: false, userId: user.id, erro: "formato inválido" };
    }
    const { nome, valor } = extracted;
    const result = await pool.query<{ id: number; titulo: string }>(
      `SELECT id, titulo FROM lembretes
       WHERE user_id = $1 AND fixa = TRUE AND status = 'pendente'
         AND LOWER(titulo) ILIKE LOWER($2)
       ORDER BY titulo ASC LIMIT 1`,
      [user.id, `%${nome}%`]
    );
    if (result.rows.length === 0) {
      await whatsapp.sendText({ to: telefone, text: `Não encontrei _${nome}_ nas contas fixas.\nUse _recorrentes_ para ver a lista.` });
      return { success: false, userId: user.id, erro: "lembrete não encontrado" };
    }
    const row = result.rows[0];
    await pool.query(`UPDATE lembretes SET valor = $1, atualizado_em = NOW() WHERE id = $2`, [valor, row.id]);
    await whatsapp.sendText({ to: telefone, text: `✅ *${capitalizeFirst(row.titulo)}* atualizado para ${fmtValor(valor)}.` });
    recordAction(user.id, "created_recurring");
    setLastContext(user.id, "recurring");
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "editar_recorrente", nome: row.titulo, valor } };
  } catch (err) {
    log.error("handleEditarRecorrenteAI falhou", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "erro editar recorrente" };
  }
}

// ── Apagar via AI (step 1) ───────────────────────────────────────────────────
export async function handleApagarRecorrenteAI(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  try {
    const nome = extractRecorrenteName(texto);
    if (!nome) {
      await whatsapp.sendText({ to: telefone, text: "💡 Ex: _cancelei a netflix_" });
      return { success: false, userId: user.id, erro: "nome não extraído" };
    }
    const result = await pool.query<{ id: number; titulo: string }>(
      `SELECT id, titulo FROM lembretes
       WHERE user_id = $1 AND fixa = TRUE AND status = 'pendente'
         AND LOWER(titulo) ILIKE LOWER($2)
       ORDER BY titulo ASC LIMIT 1`,
      [user.id, `%${nome}%`]
    );
    if (result.rows.length === 0) {
      await whatsapp.sendText({ to: telefone, text: `Não encontrei _${nome}_ nas contas fixas.\nUse _recorrentes_ para ver a lista.` });
      return { success: false, userId: user.id, erro: "lembrete não encontrado" };
    }
    const row = result.rows[0];
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    await pool.query(
      `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
       VALUES ($1, 'apagar_recorrente', 'waiting_confirmation', $2::jsonb, NOW() + INTERVAL '10 minutes')`,
      [user.id, JSON.stringify({ id: row.id, nome: row.titulo })]
    );
    await whatsapp.sendText({ to: telefone, text: `Quer remover *${capitalizeFirst(row.titulo)}* das contas fixas?\n\n_sim_ para confirmar · _não_ para cancelar.` });
    return { success: false, userId: user.id, erro: "aguardando confirmação apagar" };
  } catch (err) {
    log.error("handleApagarRecorrenteAI falhou", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "erro apagar recorrente" };
  }
}

// ── Confirmar apagar (step 2) ────────────────────────────────────────────────
export async function handleConfirmarApagarRecorrente(user: UserRow, telefone: string, texto: string, txIdsRaw: unknown): Promise<ProcessResult> {
  const data = txIdsRaw as { id: number; nome: string };
  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
  const isSim = /^(sim|s|yes|pode|ok|beleza|claro|certo|confirma)[\?!.]*$/i.test(texto.trim());
  if (!isSim) {
    await whatsapp.sendText({ to: telefone, text: "Ok, mantive! 🙂" });
    return { success: false, userId: user.id, erro: "apagar cancelado" };
  }
  try {
    await pool.query(`UPDATE lembretes SET status = 'cancelado', atualizado_em = NOW() WHERE id = $1 AND user_id = $2`, [data.id, user.id]);
    await whatsapp.sendText({ to: telefone, text: `✅ *${capitalizeFirst(data.nome)}* removido das contas fixas.` });
    setLastContext(user.id, "recurring");
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "apagar_recorrente", nome: data.nome } };
  } catch (err) {
    log.error("handleConfirmarApagarRecorrente falhou", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "erro ao apagar recorrente" };
  }
}

// ── Pagar via AI ─────────────────────────────────────────────────────────────
// Marca lembrete pendente como pago. Se fixa, cria automaticamente o próximo mês
// via marcarPago. Também registra a transação correspondente.
export async function handlePagarRecorrenteAI(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  try {
    const nome = extractRecorrenteName(texto);
    if (!nome) {
      await whatsapp.sendText({ to: telefone, text: "💡 Ex: _já paguei o aluguel_" });
      return { success: false, userId: user.id, erro: "nome não extraído" };
    }
    const result = await pool.query<{ id: number; titulo: string; valor: string }>(
      `SELECT id, titulo, valor FROM lembretes
       WHERE user_id = $1 AND fixa = TRUE AND status = 'pendente'
         AND LOWER(titulo) ILIKE LOWER($2)
       ORDER BY proxima_data ASC LIMIT 1`,
      [user.id, `%${nome}%`]
    );
    if (result.rows.length === 0) {
      await whatsapp.sendText({ to: telefone, text: `Não encontrei _${nome}_ nas contas fixas.\nUse _recorrentes_ para ver a lista.` });
      return { success: false, userId: user.id, erro: "lembrete não encontrado" };
    }
    const row = result.rows[0];
    const valor = Number(row.valor);

    const existing = await pool.query(
      `SELECT id FROM transactions
       WHERE user_id = $1 AND tipo = 'saida'
         AND LOWER(descricao) ILIKE LOWER($2)
         AND criado_em >= date_trunc('month', NOW())`,
      [user.id, `%${row.titulo}%`]
    );
    if (existing.rows.length > 0) {
      await whatsapp.sendText({ to: telefone, text: `*${capitalizeFirst(row.titulo)}* já está registrado este mês. 💡 Use _extrato_ para conferir.` });
      return { success: false, userId: user.id, erro: "já registrado este mês" };
    }

    // Marca pendente → pago e cria o próximo mês (lógica em modules/lembretes.ts)
    const { marcarPago } = await import("../modules/lembretes");
    await marcarPago(user.id, row.id);

    await pool.query(
      `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, 'saida', $2, 'Moradia', $3)`,
      [user.id, valor, row.titulo]
    );
    recordAction(user.id, "registered_transaction");
    resetInactivityNudge(user.id).catch(() => {});
    await whatsapp.sendText({ to: telefone, text: `✅ *${capitalizeFirst(row.titulo)}* (${fmtValor(valor)}) registrado como pago.` });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "pagar_recorrente", nome: row.titulo, valor } };
  } catch (err) {
    log.error("handlePagarRecorrenteAI falhou", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "erro pagar recorrente" };
  }
}
