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
      const novos: { lembrete_id: number; titulo: string; valor: number }[] = [];
      for (const item of items) {
        const r = await pool.query<{ id: number; titulo: string; valor: string }>(
          `INSERT INTO lembretes (user_id, titulo, valor, dia_vencimento, fixa, proxima_data, status, ultimo_aviso_em)
           SELECT $1::int, $2::text, $3::numeric,
                  LEAST(EXTRACT(DAY FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int, 28),
                  TRUE,
                  ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '1 month')::date,
                  'pendente',
                  (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
           WHERE NOT EXISTS (
             SELECT 1 FROM lembretes
             WHERE user_id = $1::int AND LOWER(titulo) = LOWER($2::text) AND fixa = TRUE AND status = 'pendente'
           )
           RETURNING id, titulo, valor`,
          [user.id, item.nome, item.valor],
        );
        if (r.rows[0]) {
          novos.push({ lembrete_id: r.rows[0].id, titulo: r.rows[0].titulo, valor: Number(r.rows[0].valor) });
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
      if (novos.length > 0) {
        await pool.query(
          `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
           VALUES ($1, 'confirmar_fixa_mes_atual', 'waiting_status', $2::jsonb, NOW() + INTERVAL '1 hour')
           ON CONFLICT (user_id) DO UPDATE
             SET action = 'confirmar_fixa_mes_atual', step = 'waiting_status', tx_ids = $2::jsonb,
                 selected_tx_id = NULL, expires_at = NOW() + INTERVAL '1 hour'`,
          [user.id, JSON.stringify({ queue: novos })]
        );
        await whatsapp.sendText({
          to:   telefone,
          text: `E a *${capitalizeFirst(novos[0].titulo)}* desse mês — já tá paga ou ainda vai pagar?\n💡 Ex: já paguei  •  ainda vou pagar`,
        });
      }
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
  const itemsComDia = selectedItems.map(it => ({ nome: it.nome, valor: it.valor, dia: null as number | null }));

  await pool.query(
    `INSERT INTO pending_actions (user_id, action, step, tx_ids)
     VALUES ($1, 'dia_recorrente_multi', 'waiting_dia_individual', $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE
       SET action = 'dia_recorrente_multi', step = 'waiting_dia_individual', tx_ids = $2::jsonb,
           selected_tx_id = NULL, expires_at = NOW() + INTERVAL '1 hour'`,
    [user.id, JSON.stringify(itemsComDia)]
  );

  await whatsapp.sendText({
    to: telefone,
    text: `📅 Que dia do mês vence a *${capitalizeFirst(itemsComDia[0].nome)}*?\n💡 _Ex: 5_`,
  });

  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "dia_recorrente_multi_inicio" } };
}

export async function handleDiaRecorrenteMulti(user: UserRow, telefone: string, texto: string, itemsRaw: unknown): Promise<ProcessResult> {
  type Item = { nome: string; valor: number; dia: number | null };
  const items = (Array.isArray(itemsRaw) ? itemsRaw : []) as Item[];
  if (items.length === 0) {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    return { success: false, userId: user.id, erro: "items vazio" };
  }

  const m = texto.trim().match(/^(\d{1,2})/);
  const dia = m ? parseInt(m[1], 10) : NaN;
  if (isNaN(dia) || dia < 1 || dia > 31) {
    await whatsapp.sendText({ to: telefone, text: "Só o número do dia (1 a 31) 🙂\n💡 _Ex: 5_" });
    return { success: false, userId: user.id, erro: "dia invalido" };
  }
  const diaClamp = Math.min(dia, 28);

  const idx = items.findIndex(i => i.dia === null);
  if (idx === -1) {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    return { success: false, userId: user.id, erro: "nenhum item pendente" };
  }
  items[idx].dia = diaClamp;

  const prox = items.findIndex(i => i.dia === null);
  if (prox !== -1) {
    await pool.query(
      `UPDATE pending_actions SET tx_ids = $1::jsonb, expires_at = NOW() + INTERVAL '1 hour' WHERE user_id = $2`,
      [JSON.stringify(items), user.id]
    );
    await whatsapp.sendText({ to: telefone, text: `📅 E a *${capitalizeFirst(items[prox].nome)}*?\n💡 _Ex: 10_` });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "dia_recorrente_multi_proximo" } };
  }

  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
  let totalFixo = 0;
  const novos: { lembrete_id: number; titulo: string; valor: number }[] = [];
  for (const item of items) {
    const r = await pool.query<{ id: number; titulo: string; valor: string }>(
      `INSERT INTO lembretes (user_id, titulo, valor, dia_vencimento, fixa, proxima_data, status, ultimo_aviso_em)
       SELECT $1::int, $2::text, $3::numeric, $4::int, TRUE,
              (
                CASE
                  WHEN $4::int >= EXTRACT(DAY FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int
                  THEN make_date(
                    EXTRACT(YEAR  FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int,
                    EXTRACT(MONTH FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int,
                    $4::int
                  )
                  ELSE ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '1 month')::date
                END
              ),
              'pendente',
              (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
       WHERE NOT EXISTS (
         SELECT 1 FROM lembretes
         WHERE user_id = $1::int AND LOWER(titulo) = LOWER($2::text) AND fixa = TRUE AND status = 'pendente'
       )
       RETURNING id, titulo, valor`,
      [user.id, item.nome, item.valor, item.dia!],
    );
    if (r.rows[0]) {
      novos.push({ lembrete_id: r.rows[0].id, titulo: r.rows[0].titulo, valor: Number(r.rows[0].valor) });
    }
    totalFixo += item.valor;
  }

  recordAction(user.id, "created_recurring");
  setLastCommand(user.id, "recorrentes");
  setLastContext(user.id, "recurring");

  const diasUnicos = [...new Set(items.map(i => i.dia))];
  const lista = items.map(i => `• ${capitalizeFirst(i.nome)} — dia ${i.dia}`);
  const linhas = [
    "🔄 Anotado!",
    "",
    ...lista,
    "",
    `💰 *Total fixo: ${fmtValor(totalFixo)}*`,
    "",
    diasUnicos.length === 1
      ? `📅 Te aviso antes do dia ${diasUnicos[0]}.`
      : "📅 Te aviso antes de cada vencimento.",
  ];

  await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
  if (novos.length > 0) {
    await pool.query(
      `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
       VALUES ($1, 'confirmar_fixa_mes_atual', 'waiting_status', $2::jsonb, NOW() + INTERVAL '1 hour')
       ON CONFLICT (user_id) DO UPDATE
         SET action = 'confirmar_fixa_mes_atual', step = 'waiting_status', tx_ids = $2::jsonb,
             selected_tx_id = NULL, expires_at = NOW() + INTERVAL '1 hour'`,
      [user.id, JSON.stringify({ queue: novos })]
    );
    await whatsapp.sendText({
      to:   telefone,
      text: `E a *${capitalizeFirst(novos[0].titulo)}* desse mês — já tá paga ou ainda vai pagar?\n💡 Ex: já paguei  •  ainda vou pagar`,
    });
  }
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "dia_recorrente_multi_concluido" } };
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

// ── Confirmar match fraco com fixa (Camada 2) ────────────────────────────────
// Resposta a "Vi que você tem X pendente. Esse pagamento é dela? 1/2".
export async function handleConfirmarPagarFixa(
  user: UserRow, telefone: string, texto: string, txIdsRaw: unknown
): Promise<ProcessResult> {
  type Payload = {
    lembrete_id:     number;
    titulo:          string;
    valor_lembrete:  number;
    valor_gasto:     number;
    descricao_gasto: string;
    categoria_gasto: string;
  };
  const data = (txIdsRaw ?? {}) as Payload;
  const t = texto.trim().toLowerCase();
  const isSim = /^(1|sim|s|[eé]|isso|[eé]\s+essa|essa|essa\s+mesma|pode|confirmo|certo|isso\s+mesmo)[\?!.]*$/i.test(t);
  const isNao = /^(2|n[aã]o|nao|n|outro|outra|outro\s+gasto|[eé]\s+outro|nao\s+[eé]|n[aã]o\s+[eé])[\?!.]*$/i.test(t);

  if (!isSim && !isNao) {
    await whatsapp.sendText({ to: telefone, text: "Só responde 1 ou 2 🙂" });
    return { success: false, userId: user.id, erro: "resposta inválida confirmar pagar fixa" };
  }

  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

  if (isSim) {
    try {
      const { marcarPago } = await import("../modules/lembretes");
      await marcarPago(user.id, data.lembrete_id);
      await pool.query(
        `UPDATE lembretes SET valor = $1, atualizado_em = NOW() WHERE id = $2 AND user_id = $3`,
        [data.valor_gasto, data.lembrete_id, user.id]
      );
      const ins = await pool.query(
        `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
         VALUES ($1, 'saida', $2, $3, $4)
         RETURNING *`,
        [user.id, data.valor_gasto, data.categoria_gasto || 'Moradia', data.titulo]
      );
      recordAction(user.id, "registered_transaction");
      resetInactivityNudge(user.id).catch(() => {});
      await whatsapp.sendText({
        to:   telefone,
        text: `✅ ${capitalizeFirst(data.titulo)} marcada como paga (${fmtValor(data.valor_gasto)}).`,
      });
      return {
        success:      true,
        userId:       user.id,
        transacao:    ins.rows[0] as Record<string, unknown>,
        interpretado: { comando: "confirmar_pagar_fixa", lembrete_id: data.lembrete_id, valor: data.valor_gasto, marcou_pago: true },
      };
    } catch (err) {
      log.error("handleConfirmarPagarFixa sim falhou", err, { userId: user.id });
      return { success: false, userId: user.id, erro: "erro ao confirmar pagar fixa" };
    }
  }

  // isNao
  try {
    const ins = await pool.query(
      `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, 'saida', $2, $3, $4)
       RETURNING *`,
      [user.id, data.valor_gasto, data.categoria_gasto || 'Outros', data.descricao_gasto]
    );
    recordAction(user.id, "registered_transaction");
    resetInactivityNudge(user.id).catch(() => {});
    await whatsapp.sendText({
      to:   telefone,
      text: `Beleza, registrei ${data.descricao_gasto} (${fmtValor(data.valor_gasto)}) como gasto separado.`,
    });
    return {
      success:      true,
      userId:       user.id,
      transacao:    ins.rows[0] as Record<string, unknown>,
      interpretado: { comando: "confirmar_pagar_fixa", lembrete_id: data.lembrete_id, valor: data.valor_gasto, marcou_pago: false },
    };
  } catch (err) {
    log.error("handleConfirmarPagarFixa nao falhou", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "erro ao registrar gasto separado" };
  }
}

// ── Resposta "já paguei" a aviso proativo (Camada 3) ─────────────────────────
export async function handleAguardandoPagamentoAviso(
  user: UserRow, telefone: string, txIdsRaw: unknown
): Promise<ProcessResult> {
  type Payload = { lembrete_id: number; titulo: string; valor: number };
  const data = (txIdsRaw ?? {}) as Payload;
  try {
    const { marcarPago } = await import("../modules/lembretes");
    const mp = await marcarPago(user.id, data.lembrete_id);
    const ins = await pool.query(
      `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, 'saida', $2, 'Moradia', $3)
       RETURNING *`,
      [user.id, data.valor, data.titulo]
    );
    recordAction(user.id, "registered_transaction");
    resetInactivityNudge(user.id).catch(() => {});

    let proxStr = "";
    if (mp?.proximo?.proxima_data) {
      const iso = String(mp.proximo.proxima_data).slice(0, 10);
      const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        const MESES = ["", "janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
        const mesNum = parseInt(m[2], 10);
        const diaNum = parseInt(m[3], 10);
        proxStr = ` Próximo: ${diaNum} de ${MESES[mesNum]}.`;
      }
    }

    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    await whatsapp.sendText({
      to:   telefone,
      text: `✅ ${capitalizeFirst(data.titulo)} (${fmtValor(data.valor)}) marcada como paga.${proxStr}`,
    });
    return {
      success:      true,
      userId:       user.id,
      transacao:    ins.rows[0] as Record<string, unknown>,
      interpretado: { comando: "aguardando_pagamento_aviso_pago", lembrete_id: data.lembrete_id, valor: data.valor },
    };
  } catch (err) {
    log.error("handleAguardandoPagamentoAviso falhou", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "erro ao processar pagamento via aviso" };
  }
}

// ── Confirmar status da fixa no mês atual ────────────────────────────────────
// Após criar lembrete fixo, pergunta se já foi pago neste mês.
// "já paguei" → insere transaction + marcarPago. "ainda vou pagar" → mantém pendente.
// Processa fila se houver múltiplos lembretes.
export async function handleConfirmarFixaMesAtual(
  user: UserRow, telefone: string, texto: string, txIdsRaw: unknown
): Promise<ProcessResult> {
  type Item = { lembrete_id: number; titulo: string; valor: number };
  const data = (txIdsRaw ?? {}) as { queue?: Item[] };
  const queue = Array.isArray(data.queue) ? data.queue.slice() : [];
  if (queue.length === 0) {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    return { success: false, userId: user.id, erro: "queue vazia" };
  }

  const atual = queue[0];
  const t = texto.trim().toLowerCase();
  const isPago     = /\b(j[aá]\s+paguei|paguei|t[aá]\s+pago|pago|sim|quitado|quitei)\b/i.test(t);
  const isPendente = /\b(ainda\s+vou|n[aã]o|nao|vou\s+pagar|pendente|falta)\b/i.test(t);

  if (!isPago && !isPendente) {
    await whatsapp.sendText({ to: telefone, text: 'Só responde "já paguei" ou "ainda vou pagar" 🙂' });
    return { success: false, userId: user.id, erro: "resposta inválida fixa mes atual" };
  }

  if (isPago) {
    try {
      const { marcarPago } = await import("../modules/lembretes");
      await marcarPago(user.id, atual.lembrete_id);
      await pool.query(
        `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
         VALUES ($1, 'saida', $2, 'Moradia', $3)`,
        [user.id, atual.valor, atual.titulo]
      );
      recordAction(user.id, "registered_transaction");
      resetInactivityNudge(user.id).catch(() => {});
      await whatsapp.sendText({ to: telefone, text: `✅ *${capitalizeFirst(atual.titulo)}* (${fmtValor(atual.valor)}) registrado como pago.` });
    } catch (err) {
      log.error("handleConfirmarFixaMesAtual marcarPago falhou", err, { userId: user.id });
    }
  } else {
    await whatsapp.sendText({ to: telefone, text: "Beleza, vou te lembrar quando chegar o dia 💪" });
  }

  const restante = queue.slice(1);
  if (restante.length === 0) {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "confirmar_fixa_mes_atual_concluido" } };
  }

  await pool.query(
    `UPDATE pending_actions
       SET tx_ids = $1::jsonb, expires_at = NOW() + INTERVAL '1 hour'
     WHERE user_id = $2`,
    [JSON.stringify({ queue: restante }), user.id]
  );
  await whatsapp.sendText({
    to:   telefone,
    text: `E a *${capitalizeFirst(restante[0].titulo)}* desse mês — já tá paga ou ainda vai pagar?\n💡 Ex: já paguei  •  ainda vou pagar`,
  });
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "confirmar_fixa_mes_atual_proximo" } };
}
