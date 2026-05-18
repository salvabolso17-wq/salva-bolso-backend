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
                  make_date(
                    EXTRACT(YEAR  FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int,
                    EXTRACT(MONTH FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int,
                    LEAST(EXTRACT(DAY FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int, 28)
                  ),
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
      log.whatsapp("lembretes confirmados (lista)", { to: telefone, userId: user.id, count: items.length, novos: novos.length });
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

  const selectedItems = selectedIndices.map(i => items[i]).map(it => ({ nome: it.nome, valor: it.valor }));

  await pool.query(
    `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
     VALUES ($1, 'dias_recorrentes_batch', 'waiting_dias_batch', $2::jsonb, NOW() + INTERVAL '1 hour')
     ON CONFLICT (user_id) DO UPDATE
       SET action = 'dias_recorrentes_batch', step = 'waiting_dias_batch', tx_ids = $2::jsonb,
           selected_tx_id = NULL, expires_at = NOW() + INTERVAL '1 hour'`,
    [user.id, JSON.stringify({ items: selectedItems })]
  );

  const bullets   = selectedItems.map(it => `• ${capitalizeFirst(it.nome)} ${fmtValor(it.valor)}`).join("\n");
  const diasEx    = [5, 10, 15];
  const exemplo   = selectedItems.map((it, i) => `${it.nome} ${diasEx[i % diasEx.length]}`).join(", ");
  await whatsapp.sendText({
    to:   telefone,
    text: `✅ ${selectedItems.length} anotadas:\n${bullets}\n\n📅 Manda os dias de vencimento assim:\n💡 _${exemplo}_`,
  });

  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "dias_recorrentes_batch_pedido" } };
}

function parseBatchDias(
  texto: string,
  items: { nome: string; valor: number }[]
):
  | { ok: true; dias: number[] }
  | { ok: false; reason: "missing"; missingNames: string[] }
  | { ok: false; reason: "invalid" } {

  const dias: (number | null)[] = items.map(() => null);
  const t = texto.toLowerCase();
  let namedMatched = 0;

  for (let i = 0; i < items.length; i++) {
    const nome = items[i].nome.toLowerCase();
    const idx = t.indexOf(nome);
    if (idx !== -1) {
      const after = t.slice(idx + nome.length, idx + nome.length + 20);
      const m = after.match(/(\d{1,2})/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 1 && n <= 31) {
          dias[i] = n;
          namedMatched++;
        } else {
          return { ok: false, reason: "invalid" };
        }
      }
    }
  }

  if (namedMatched === items.length) {
    return { ok: true, dias: dias as number[] };
  }

  // Fallback ordenado quando nenhum nome casou
  if (namedMatched === 0) {
    const allNums = (texto.match(/\d{1,2}/g) || []).map(s => parseInt(s, 10));
    if (allNums.some(n => n < 1 || n > 31)) return { ok: false, reason: "invalid" };
    if (allNums.length === items.length)    return { ok: true, dias: allNums };
    if (allNums.length < items.length) {
      const missing = items.slice(allNums.length).map(i => i.nome);
      return { ok: false, reason: "missing", missingNames: missing };
    }
    return { ok: false, reason: "invalid" };
  }

  // Match parcial nomeado
  const missingNames = items.filter((_, i) => dias[i] === null).map(it => it.nome);
  return { ok: false, reason: "missing", missingNames };
}

export async function handleDiasRecorrentesBatch(
  user: UserRow, telefone: string, texto: string, txIdsRaw: unknown
): Promise<ProcessResult> {
  type Item = { nome: string; valor: number };
  const payload = (txIdsRaw ?? {}) as { items?: Item[] };
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    return { success: false, userId: user.id, erro: "items vazio" };
  }

  const parsed = parseBatchDias(texto, items);
  if (!parsed.ok && parsed.reason === "invalid") {
    const diasEx  = [5, 10, 15];
    const exemplo = items.map((it, i) => `${it.nome} ${diasEx[i % diasEx.length]}`).join(", ");
    await whatsapp.sendText({ to: telefone, text: `Esses números não bateram. Manda assim:\n_${exemplo}_` });
    return { success: false, userId: user.id, erro: "dias inválidos" };
  }
  if (!parsed.ok && parsed.reason === "missing") {
    const faltante = parsed.missingNames[0];
    await whatsapp.sendText({ to: telefone, text: `Faltou o dia de *${capitalizeFirst(faltante)}*. Manda só esse: _${faltante} 5_` });
    return { success: false, userId: user.id, erro: "dias faltando" };
  }

  const diasFinais = (parsed as { ok: true; dias: number[] }).dias.map(d => Math.min(d, 28));

  let totalFixo = 0;
  const novos: { lembrete_id: number; titulo: string; valor: number; dia: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const diaClamp = diasFinais[i];
    const r = await pool.query<{ id: number; titulo: string; valor: string; dia_vencimento: number }>(
      `INSERT INTO lembretes (user_id, titulo, valor, dia_vencimento, fixa, proxima_data, status, ultimo_aviso_em)
       SELECT $1::int, $2::text, $3::numeric, $4::int, TRUE,
              make_date(
                EXTRACT(YEAR  FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int,
                EXTRACT(MONTH FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int,
                LEAST($4::int, 28)
              ),
              'pendente',
              (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
       WHERE NOT EXISTS (
         SELECT 1 FROM lembretes
         WHERE user_id = $1::int AND LOWER(titulo) = LOWER($2::text) AND fixa = TRUE AND status = 'pendente'
       )
       RETURNING id, titulo, valor, dia_vencimento`,
      [user.id, item.nome, item.valor, diaClamp]
    );
    if (r.rows[0]) {
      novos.push({
        lembrete_id: r.rows[0].id,
        titulo:      r.rows[0].titulo,
        valor:       Number(r.rows[0].valor),
        dia:         r.rows[0].dia_vencimento,
      });
    }
    totalFixo += item.valor;
  }

  recordAction(user.id, "created_recurring");
  setLastCommand(user.id, "recorrentes");
  setLastContext(user.id, "recurring");

  const { jaVenceuEsteMes } = await import("../modules/lembretes");
  const vencidas = novos.filter(n => jaVenceuEsteMes(n.dia));
  const qtd = items.length;
  const prefixoBatch = `✅ ${qtd} fixas anotadas.\n💰 Total fixo: ${fmtValor(totalFixo)}`;

  if (vencidas.length === 0) {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    await whatsapp.sendText({
      to:   telefone,
      text: `${prefixoBatch}\n\nManda teus gastos do dia:\n🛒 _50 mercado_ • 🚗 _35 uber_`,
    });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "dias_recorrentes_batch_concluido" } };
  }

  if (vencidas.length === 1) {
    const v = vencidas[0];
    await pool.query(
      `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
       VALUES ($1, 'onboarding_fixa_status_vencida_solo', 'waiting_status_vencida', $2::jsonb, NOW() + INTERVAL '1 hour')
       ON CONFLICT (user_id) DO UPDATE
         SET action = 'onboarding_fixa_status_vencida_solo', step = 'waiting_status_vencida', tx_ids = $2::jsonb,
             selected_tx_id = NULL, expires_at = NOW() + INTERVAL '1 hour'`,
      [user.id, JSON.stringify({ lembrete_id: v.lembrete_id, titulo: v.titulo, valor: v.valor, dia: v.dia })]
    );
    await whatsapp.sendText({
      to:   telefone,
      text: `${prefixoBatch}\n\n*${capitalizeFirst(v.titulo)}* (dia ${v.dia}) já venceu esse mês. Já pagou?\n💡 _sim_ • _não_`,
    });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "dias_recorrentes_batch_aguardando_vencida_solo" } };
  }

  // 2+ vencidas
  await pool.query(
    `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
     VALUES ($1, 'onboarding_fixa_status_vencida_batch', 'waiting_status_vencida_batch', $2::jsonb, NOW() + INTERVAL '1 hour')
     ON CONFLICT (user_id) DO UPDATE
       SET action = 'onboarding_fixa_status_vencida_batch', step = 'waiting_status_vencida_batch', tx_ids = $2::jsonb,
           selected_tx_id = NULL, expires_at = NOW() + INTERVAL '1 hour'`,
    [user.id, JSON.stringify(vencidas)]
  );
  const listaNum = vencidas.map((v, i) => `${i + 1}. ${capitalizeFirst(v.titulo)} ${fmtValor(v.valor)} (dia ${v.dia})`).join("\n");
  await whatsapp.sendText({
    to:   telefone,
    text: `${prefixoBatch}\n\nEssas já venceram esse mês — já pagou alguma?\n${listaNum}\n\n💡 Manda os números (ex: _1 e 2_), _todas_ ou _nenhuma_`,
  });
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "dias_recorrentes_batch_aguardando_vencida_batch" } };
}

export async function handleOnboardingFixaStatusBatch(
  user: UserRow, telefone: string, texto: string, itemsRaw: unknown
): Promise<ProcessResult> {
  type Item = { lembrete_id: number; titulo: string; valor: number; dia: number };
  const items = (Array.isArray(itemsRaw) ? itemsRaw : []) as Item[];
  if (items.length === 0) {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    return { success: false, userId: user.id, erro: "items vazio" };
  }

  const t = texto.trim().toLowerCase();
  const isTodas = /^(todas?|todos?|sim|tudo|ambas?|os\s+dois|as\s+duas)[\?!.]*$/i.test(t);
  const isNenhuma = /^(nenhuma|nenhum|n[ãa]o|nao|n)[\?!.]*$/i.test(t);

  let selecionadas: Item[] = [];
  if (isTodas) {
    selecionadas = items.slice();
  } else if (isNenhuma) {
    selecionadas = [];
  } else {
    const nums = (t.match(/\d+/g) || []).map(n => parseInt(n, 10) - 1).filter(i => i >= 0 && i < items.length);
    if (nums.length === 0) {
      await whatsapp.sendText({ to: telefone, text: "Não entendi. Manda os números (ex: _1 e 2_), _todas_ ou _nenhuma_ 🙂" });
      return { success: false, userId: user.id, erro: "resposta inválida status batch" };
    }
    selecionadas = nums.map(i => items[i]);
  }

  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

  if (selecionadas.length > 0) {
    const { marcarPago } = await import("../modules/lembretes");
    for (const sel of selecionadas) {
      try {
        await marcarPago(user.id, sel.lembrete_id);
        await pool.query(
          `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
           VALUES ($1, 'saida', $2, 'Outros', $3)`,
          [user.id, sel.valor, sel.titulo]
        );
      } catch (err) {
        log.error("erro ao marcar fixa vencida (batch) como pago", err, { userId: user.id, lembrete_id: sel.lembrete_id });
      }
    }
  }

  const linhaPagas = selecionadas.length > 0
    ? `✅ Marquei ${selecionadas.map(s => capitalizeFirst(s.titulo)).join(", ")} como pagas.\n\n`
    : "";
  await whatsapp.sendText({
    to:   telefone,
    text: `${linhaPagas}Manda teus gastos do dia:\n🛒 _50 mercado_ • 🚗 _35 uber_`,
  });
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "onboarding_fixa_status_vencida_batch_concluido", marcadas: selecionadas.length } };
}

export async function handleOnboardingFixaStatusVencidaSolo(
  user: UserRow, telefone: string, texto: string, txIdsRaw: unknown
): Promise<ProcessResult> {
  type Payload = { lembrete_id: number; titulo: string; valor: number; dia: number };
  const data = (txIdsRaw ?? {}) as Payload;
  const t = texto.trim();

  const isSim = /(sim|s|paguei|j[áa]\s+paguei|t[áa]\s+pago|pago|quitei)/i.test(t);
  const isNao = /(n[ãa]o|nao|n|ainda|falta|vou\s+pagar|amanh[ãa])/i.test(t);

  if (!isSim && !isNao) {
    await whatsapp.sendText({ to: telefone, text: "Só responde *sim* ou *não* 🙂\n💡 _já paguei_ • _vou pagar_" });
    return { success: false, userId: user.id, erro: "resposta inválida vencida solo (batch)" };
  }

  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

  let linhaPagas = "";
  if (isSim) {
    try {
      const { marcarPago } = await import("../modules/lembretes");
      await marcarPago(user.id, data.lembrete_id);
      await pool.query(
        `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
         VALUES ($1, 'saida', $2, 'Outros', $3)`,
        [user.id, data.valor, data.titulo]
      );
      linhaPagas = `✅ Marquei ${capitalizeFirst(data.titulo)} como paga.\n\n`;
    } catch (err) {
      log.error("erro ao marcar fixa vencida solo (batch) como pago", err, { userId: user.id });
    }
  }

  await whatsapp.sendText({
    to:   telefone,
    text: `${linhaPagas}Manda teus gastos do dia:\n🛒 _50 mercado_ • 🚗 _35 uber_`,
  });
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "onboarding_fixa_status_vencida_solo_concluido", marcou: isSim } };
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

  const linhas = ["📌 Suas contas fixas", ""];
  let totalMensal = 0;
  for (const row of result.rows) {
    const valor = Number(row.valor);
    totalMensal += valor;
    linhas.push(`${capitalizeFirst(row.titulo)} — ${fmtValor(valor)} (dia ${row.dia_vencimento})`);
  }
  linhas.push("", `💰 Total: ${fmtValor(totalMensal)}`);

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
function extractNameFromQuote(q: string): string | null {
  const line = q.split('\n')[0];
  // "⏰ Faltam 3 dias pra vencer Claro —" or "Lembrete: Claro de"
  let m = line.match(/vencer?\s+([A-Za-zÀ-ÿ][\w\s]+?)\s+[—\-(]/i);
  if (m) return m[1].trim();
  // "⚠️ Claro vence AMANHÃ" / "🚨 Claro (R$"
  m = line.match(/^[^A-Za-zÀ-ÿ]*([A-Za-zÀ-ÿ][\w\s]+?)\s+(?:vence|venceu|\()/i);
  if (m) return m[1].trim();
  // "Lembrete: Claro de R$"
  m = line.match(/Lembrete:\s+(.+?)\s+de\s/i);
  if (m) return m[1].trim();
  return null;
}

export async function handlePagarRecorrenteAI(user: UserRow, telefone: string, texto: string, quotedText?: string): Promise<ProcessResult> {
  try {
    // Detecta negação: "Não paguei X" → oferece corrigir, NÃO marca pago
    if (/^\s*(n[ãa]o|nao|n)\s+(paguei|pago|t[áa]\s+pago|quitei|quitada|paga)\b/i.test(texto)) {
      return await ofertarCorrecaoNegacao(user, telefone, texto);
    }
    const nomeQuoted = quotedText ? extractNameFromQuote(quotedText) : null;
    const nome = nomeQuoted ?? extractRecorrenteName(texto);
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
      await whatsapp.sendText({ to: telefone, text: "Não achei. Manda o nome certo.\n💡 _Ex: paguei o aluguel_ • _paguei netflix_" });
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
    const mp = await marcarPago(user.id, row.id);

    const insTx = await pool.query<{ id: number }>(
      `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, 'saida', $2, 'Moradia', $3)
       RETURNING id`,
      [user.id, valor, row.titulo]
    );
    recordAction(user.id, "registered_transaction");
    resetInactivityNudge(user.id).catch(() => {});
    await whatsapp.sendText({ to: telefone, text: `✅ Marquei o pagamento de *${capitalizeFirst(row.titulo)}*.` });
    try {
      await pool.query(
        `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
         VALUES ($1, 'pagamento_recente', 'aguardando_desfazer', $2::jsonb, NOW() + INTERVAL '10 minutes')
         ON CONFLICT (user_id) DO UPDATE
           SET action = 'pagamento_recente', step = 'aguardando_desfazer', tx_ids = $2::jsonb,
               selected_tx_id = NULL, expires_at = NOW() + INTERVAL '10 minutes'`,
        [user.id, JSON.stringify({
          lembrete_pago_id:    row.id,
          transaction_id:      insTx.rows[0].id,
          proximo_lembrete_id: mp?.proximo?.id ?? null,
          titulo:              row.titulo,
          valor,
        })]
      );
    } catch (err) {
      log.error("falha ao gravar pagamento_recente (handlePagarRecorrenteAI)", err, { userId: user.id });
    }
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "pagar_recorrente", nome: row.titulo, valor } };
  } catch (err) {
    log.error("handlePagarRecorrenteAI falhou", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "erro pagar recorrente" };
  }
}

// ── Negação detectada ("Não paguei X") → oferece corrigir ────────────────────
export async function ofertarCorrecaoNegacao(
  user: UserRow, telefone: string, texto: string
): Promise<ProcessResult> {
  log.webhook("negação detectada", { userId: user.id, texto });
  await pool.query(
    `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
     VALUES ($1, 'aguardando_correcao', 'waiting_corrigir_alvo', $2::jsonb, NOW() + INTERVAL '5 minutes')
     ON CONFLICT (user_id) DO UPDATE
       SET action = 'aguardando_correcao', step = 'waiting_corrigir_alvo', tx_ids = $2::jsonb,
           selected_tx_id = NULL, expires_at = NOW() + INTERVAL '5 minutes'`,
    [user.id, JSON.stringify({ texto_original: texto })]
  );
  await whatsapp.sendText({
    to:   telefone,
    text: "Hmm, entendi que você *não pagou*. Quer que eu corrija algum pagamento marcado por engano?\n💡 _corrigir o aluguel_ • _corrigir mei_",
  });
  return { success: false, userId: user.id, erro: "aguardando correção de negação" };
}

export async function handleAguardandoCorrecao(
  user: UserRow, telefone: string, texto: string
): Promise<ProcessResult> {
  const m = texto.trim().match(/^corrigir\s+(?:o\s+|a\s+|os\s+|as\s+)?(.+?)[\?!.]*$/i);
  if (!m) {
    await whatsapp.sendText({ to: telefone, text: "💡 Manda _corrigir <nome>_ (ex: _corrigir o aluguel_) ou _cancelar_." });
    return { success: false, userId: user.id, erro: "aguardando_correcao input inválido" };
  }
  const alvo = m[1].trim();
  if (alvo.length < 2) {
    await whatsapp.sendText({ to: telefone, text: "💡 Manda _corrigir <nome>_ (ex: _corrigir o aluguel_)." });
    return { success: false, userId: user.id, erro: "alvo muito curto" };
  }

  // Procura lembrete fixo recém-pago compatível
  const lembRes = await pool.query<{ id: number; titulo: string; proxima_data: Date | string; valor: string; atualizado_em: Date }>(
    `SELECT id, titulo, proxima_data, valor, atualizado_em FROM lembretes
     WHERE user_id = $1 AND fixa = TRUE AND status = 'pago'
       AND LOWER(titulo) ILIKE '%' || LOWER($2) || '%'
       AND atualizado_em > NOW() - INTERVAL '2 hours'
     ORDER BY atualizado_em DESC
     LIMIT 1`,
    [user.id, alvo]
  );

  if (lembRes.rows.length === 0) {
    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    await whatsapp.sendText({ to: telefone, text: `Não achei pagamento recente de *${capitalizeFirst(alvo)}*. Use _corrigir_ pra ver a lista de lançamentos.` });
    return { success: false, userId: user.id, erro: "lembrete pago não encontrado" };
  }

  const lembPago = lembRes.rows[0];

  // Encontra a transaction correspondente (mesma janela de tempo)
  const txRes = await pool.query<{ id: number }>(
    `SELECT id FROM transactions
     WHERE user_id = $1 AND tipo = 'saida'
       AND LOWER(descricao) ILIKE '%' || LOWER($2) || '%'
       AND ABS(EXTRACT(EPOCH FROM (criado_em - $3::timestamp))) < 60
     ORDER BY criado_em DESC
     LIMIT 1`,
    [user.id, lembPago.titulo, lembPago.atualizado_em]
  );

  try {
    if (txRes.rows[0]) {
      await pool.query(`DELETE FROM transactions WHERE id = $1 AND user_id = $2`, [txRes.rows[0].id, user.id]);
    }
    await pool.query(
      `UPDATE lembretes SET status = 'pendente', atualizado_em = NOW() WHERE id = $1 AND user_id = $2`,
      [lembPago.id, user.id]
    );
    await pool.query(
      `DELETE FROM lembretes
       WHERE user_id = $1 AND fixa = TRUE AND status = 'pendente'
         AND LOWER(titulo) ILIKE '%' || LOWER($2) || '%'
         AND proxima_data > $3::date`,
      [user.id, lembPago.titulo, String(lembPago.proxima_data).slice(0, 10)]
    );
  } catch (err) {
    log.error("handleAguardandoCorrecao reverter falhou", err, { userId: user.id });
  }

  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
  await whatsapp.sendText({
    to:   telefone,
    text: `✅ Removido. *${capitalizeFirst(lembPago.titulo)}* voltou pra pendente.`,
  });
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "aguardando_correcao_aplicado", lembrete_id: lembPago.id } };
}

// ── Desfazer pagamento recente ───────────────────────────────────────────────
export async function handleConfirmarDesfazer(
  user: UserRow, telefone: string, texto: string, txIdsRaw: unknown
): Promise<ProcessResult> {
  type Payload = {
    lembrete_pago_id:    number;
    transaction_id:      number;
    proximo_lembrete_id: number | null;
    titulo:              string;
    valor:               number;
  };
  const data = (txIdsRaw ?? {}) as Payload;
  const t = texto.trim();
  const isSim = /(sim|s|isso|exato|por\s+favor|desfaz|pode)/i.test(t);
  const isNao = /(n[ãa]o|nao|deixa|t[áa]\s+certo|ok|tudo\s+bem)/i.test(t);

  if (!isSim && !isNao) {
    await whatsapp.sendText({ to: telefone, text: "Só responde *sim* ou *não* 🙂\n💡 _sim_ • _não_" });
    return { success: false, userId: user.id, erro: "resposta inválida desfazer" };
  }

  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

  if (isSim) {
    try {
      await pool.query(
        `UPDATE lembretes SET status = 'pendente', atualizado_em = NOW()
         WHERE id = $1 AND user_id = $2`,
        [data.lembrete_pago_id, user.id]
      );
      await pool.query(
        `DELETE FROM transactions WHERE id = $1 AND user_id = $2`,
        [data.transaction_id, user.id]
      );
      if (data.proximo_lembrete_id) {
        await pool.query(
          `DELETE FROM lembretes WHERE id = $1 AND user_id = $2`,
          [data.proximo_lembrete_id, user.id]
        );
      }
    } catch (err) {
      log.error("handleConfirmarDesfazer reverter falhou", err, { userId: user.id });
    }
    await whatsapp.sendText({
      to:   telefone,
      text: `✅ Desfeito. *${capitalizeFirst(data.titulo)}* voltou pra pendente.`,
    });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "desfazer_pagamento", lembrete_id: data.lembrete_pago_id } };
  }

  await whatsapp.sendText({
    to:   telefone,
    text: "Beleza, mantive como pago.\n💡 Se precisar corrigir depois, manda _corrigir_",
  });
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "desfazer_recusado" } };
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
      const mp = await marcarPago(user.id, data.lembrete_id);
      await pool.query(
        `UPDATE lembretes SET valor = $1, atualizado_em = NOW() WHERE id = $2 AND user_id = $3`,
        [data.valor_gasto, data.lembrete_id, user.id]
      );
      const ins = await pool.query<{ id: number }>(
        `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
         VALUES ($1, 'saida', $2, $3, $4)
         RETURNING *`,
        [user.id, data.valor_gasto, data.categoria_gasto || 'Moradia', data.titulo]
      );
      recordAction(user.id, "registered_transaction");
      resetInactivityNudge(user.id).catch(() => {});
      await whatsapp.sendText({
        to:   telefone,
        text: `✅ Marquei o pagamento de *${capitalizeFirst(data.titulo)}*.`,
      });
      try {
        const insTxRow = ins.rows[0] as { id: number };
        await pool.query(
          `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
           VALUES ($1, 'pagamento_recente', 'aguardando_desfazer', $2::jsonb, NOW() + INTERVAL '10 minutes')
           ON CONFLICT (user_id) DO UPDATE
             SET action = 'pagamento_recente', step = 'aguardando_desfazer', tx_ids = $2::jsonb,
                 selected_tx_id = NULL, expires_at = NOW() + INTERVAL '10 minutes'`,
          [user.id, JSON.stringify({
            lembrete_pago_id:    data.lembrete_id,
            transaction_id:      insTxRow.id,
            proximo_lembrete_id: mp?.proximo?.id ?? null,
            titulo:              data.titulo,
            valor:               data.valor_gasto,
          })]
        );
      } catch (err) {
        log.error("falha ao gravar pagamento_recente (handleConfirmarPagarFixa)", err, { userId: user.id });
      }
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
        proxStr = `\nPróximo lembrete: dia ${diaNum} de ${MESES[mesNum]}.`;
      }
    }

    await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    await whatsapp.sendText({
      to:   telefone,
      text: `✅ Marquei o pagamento de *${capitalizeFirst(data.titulo)}*.${proxStr}`,
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

// ── Retenção: usuário ativo expressa intenção de cancelar ────────────────────
export async function handleCancelamentoIntent(user: UserRow, telefone: string): Promise<ProcessResult> {
  try {
    const r = await pool.query<{ total: string; soma: string }>(
      `SELECT COUNT(*) as total, COALESCE(SUM(valor),0) as soma FROM transactions WHERE user_id = $1`,
      [user.id]
    );
    const total = Number(r.rows[0].total);
    const soma  = fmtValor(Number(r.rows[0].soma));
    await whatsapp.sendText({
      to:   telefone,
      text: `Que pena que está pensando em cancelar 😔\n\nVocê já registrou *${total} gastos* e acompanhou *${soma}* aqui.\n\nTem algo que não funcionou bem? Posso te ajudar 🙂`,
    });
    await pool.query(
      `INSERT INTO pending_actions (user_id, action, step, tx_ids, expires_at)
       VALUES ($1, 'cancelamento', 'waiting_response', '[]'::jsonb, NOW() + INTERVAL '15 minutes')
       ON CONFLICT (user_id) DO UPDATE
         SET action = 'cancelamento', step = 'waiting_response', tx_ids = '[]'::jsonb,
             selected_tx_id = NULL, expires_at = NOW() + INTERVAL '15 minutes'`,
      [user.id]
    );
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "cancelamento_intent" } };
  } catch (err) {
    log.error("handleCancelamentoIntent falhou", err, { userId: user.id });
    return { success: false, userId: user.id, erro: "erro ao processar intenção de cancelamento" };
  }
}

