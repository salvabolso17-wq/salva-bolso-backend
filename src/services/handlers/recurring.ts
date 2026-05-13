import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor, capitalizeFirst } from "../../utils/formatting";
import { recordAction, setLastCommand, setLastContext } from "../conversationEngine";
import { upsertRecorrente } from "../modules/recurringDetection";
import { checkAndSendOnboardingTip } from "../modules/insightsEngine";
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
