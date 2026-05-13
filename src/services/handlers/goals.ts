import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor } from "../../utils/formatting";
import { parseValor } from "../../utils/parseTransaction";
import { recordAction, setLastGoal, getLastGoal } from "../conversationEngine";
import { checkAndSendOnboardingTip } from "../modules/insightsEngine";
import type { UserRow, ProcessResult } from "../types";

// ── Goal intent detector ──────────────────────────────────────────────────────

type GoalIntent =
  | { type: "adicionar";      valor: number; nome?: string }
  | { type: "criar_sem_valor"; nome: string }
  | { type: "progresso";      nome?: string }
  | { type: "porcentagem" }
  | { type: "juntei" };

export function detectGoalIntent(texto: string): GoalIntent | null {
  const t  = texto.trim();
  const tl = t.toLowerCase();

  // ── criar sem valor ────────────────────────────────────────────────────
  // "guardar dinheiro pro carro", "juntar dinheiro pra viagem"
  let m = tl.match(/^(?:quero\s+)?(?:guard|poup|junt)(?:ar|a)\s+dinheiro\s+(?:na?|no|pra?|para|pro?s?)\s+(.+)$/);
  if (m) return { type: "criar_sem_valor", nome: m[1].trim() };

  // "quero uma meta pro videogame", "criar meta pra carro"
  m = tl.match(/^(?:quero\s+)?(?:criar\s+)?uma?\s+meta\s+(?:pra?|para|pro?)\s+(.+)$/);
  if (m) return { type: "criar_sem_valor", nome: m[1].trim() };

  // ── progresso ──────────────────────────────────────────────────────────
  // "quanto falta?", "quanto falta pra viagem?"
  m = tl.match(/^quanto\s+falta\s*(?:(?:pra?|para|pro?)\s+(.+?))?[?!.]*$/);
  if (m) return { type: "progresso", nome: m[1]?.trim() || undefined };

  // "como tá minha meta?", "como tá a meta de viagem?"
  m = tl.match(/^como\s+t[aá]\s+(?:(?:a|minha?)\s+)?meta(?:\s+(?:de|do?a?)\s+(.+?))?[?!.]*$/);
  if (m) return { type: "progresso", nome: m[1]?.trim() || undefined };

  if (/^como\s+t[aá]\s+(?:o\s+)?meu?\s+objetivo[?!.]*$/.test(tl)) return { type: "progresso" };

  // ── adicionar ─────────────────────────────────────────────────────────
  // "consegui guardar mais 50 pra viagem"
  m = t.match(/^consegui\s+(?:guard|poup|junt|separ|coloc)(?:ar|a)\s+(?:mais\s+)?([\d,.]+)\s*(?:(?:na?|no|pra?|para|pro?|em)\s+(.+))?$/i);
  if (m) return { type: "adicionar", valor: parseValor(m[1]), nome: m[2]?.trim() || undefined };

  // "quero guardar 200", "separa 100 pra viagem", "poupa 150", "guardar 300 na meta viagem"
  m = t.match(/^(?:quero\s+)?(?:guard|poup|junt|separ|coloc|bot|adicion)(?:ar|a)\s+([\d,.]+)\s*(?:(?:na?|no|pra?|para|pro?|em)\s+(.+))?$/i);
  if (m) return { type: "adicionar", valor: parseValor(m[1]), nome: m[2]?.trim() || undefined };

  // "já juntei 300", "guardei 200", "juntei 150 pra viagem"
  m = t.match(/^(?:j[aá]\s+)?(?:guard|poup|junt|separ|coloc)ei\s+([\d,.]+)\s*(?:(?:na?|no|pra?|para|em)\s+(.+))?$/i);
  if (m) return { type: "adicionar", valor: parseValor(m[1]), nome: m[2]?.trim() || undefined };

  // ── consultas de progresso / contexto ─────────────────────────────────
  // "qual porcentagem?", "que percentual?", "qual o percentual?"
  if (/\b(qual\s+(é\s+|é\s+a\s+|a\s+)?porcentagem|que\s+porcentagem|qual\s+o\s+percentual|que\s+percentual)\b[?!.]*/.test(tl)) {
    return { type: "porcentagem" };
  }

  // "quanto já juntei?", "quanto eu já guardei?", "quanto tenho guardado?", "quanto já guardei?"
  if (/^quanto\s+(?:j[aá]\s+)?(juntei|guardei|poupei)[?!.]*$/.test(tl) ||
      /^quanto\s+tenho\s+guardado[?!.]*$/.test(tl) ||
      /^quanto\s+eu\s+j[aá]\s+(juntei|guardei|poupei)[?!.]*$/.test(tl)) {
    return { type: "juntei" };
  }

  return null;
}

export async function handleMetaCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("comando meta", { userId: user.id, texto });

  const match = texto.match(/^meta\s+(.+?)\s+([\d,.]+)$/i);
  if (!match) {
    await whatsapp.sendText({ to: telefone, text: "💡 Ex:\nmeta viagem 5000" });
    return { success: false, userId: user.id, erro: "Formato inválido" };
  }

  const nome      = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  const valorMeta = parseValor(match[2]);

  await pool.query(
    `INSERT INTO user_goals (user_id, nome, valor_meta)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, nome)
     DO UPDATE SET valor_meta = $3`,
    [user.id, nome, valorMeta]
  );

  await whatsapp.sendText({
    to:   telefone,
    text: `🎯 Meta criada: ${nome}\nObjetivo: ${fmtValor(valorMeta)}`,
  });

  setLastGoal(user.id, { nome, valorMeta });
  recordAction(user.id, "created_goal");

  setTimeout(() => {
    checkAndSendOnboardingTip(user.id, telefone, "meta_criada").catch(err =>
      log.error("falha ao verificar onboarding tip", err, { userId: user.id })
    );
  }, 800);

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "meta", nome, valorMeta },
  };
}

export async function handleMetasCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando metas", { userId: user.id });

  const result = await pool.query<{ nome: string; valor_meta: string; valor_atual: string }>(
    `SELECT nome, valor_meta, valor_atual
     FROM user_goals
     WHERE user_id = $1
     ORDER BY criado_em ASC`,
    [user.id]
  );

  if (result.rows.length === 0) {
    await whatsapp.sendText({
      to:   telefone,
      text: "Você ainda não tem metas.\n\n💡 Ex:\nmeta viagem 5000",
    });
    return {
      success:      true,
      userId:       user.id,
      transacao:    {},
      interpretado: { comando: "metas", count: 0 },
    };
  }

  const linhas = ["🎯 Suas metas", ""];
  for (const row of result.rows) {
    const meta    = Number(row.valor_meta);
    const atual   = Number(row.valor_atual);
    const percent = meta > 0 ? Math.round((atual / meta) * 100) : 0;
    linhas.push(`${row.nome} — ${fmtValor(atual)} / ${fmtValor(meta)} (${percent}%)`);
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("metas enviado", { to: telefone, count: result.rows.length });
  } catch (err) {
    log.error("falha ao enviar metas", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "metas", count: result.rows.length },
  };
}

export async function handleGuardarCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("comando guardar", { userId: user.id, texto });

  const match = texto.match(/^guardar\s+([\d,.]+)\s+(.+)$/i);
  if (!match) {
    await whatsapp.sendText({ to: telefone, text: "Quando quiser adicionar dinheiro, pode falar algo como:\nguardar 200 viagem 🎯" });
    return { success: false, userId: user.id, erro: "Formato inválido" };
  }

  const valor   = parseValor(match[1]);
  const rawNome = match[2].replace(/^(?:na?|no|em|pra?|para|pro?)\s+/i, "").trim();
  const nome    = rawNome.charAt(0).toUpperCase() + rawNome.slice(1).toLowerCase();

  const result = await pool.query<{ nome: string; valor_meta: string; valor_atual: string }>(
    `UPDATE user_goals
     SET valor_atual = valor_atual + $1
     WHERE user_id = $2 AND LOWER(nome) = LOWER($3)
     RETURNING nome, valor_meta, valor_atual`,
    [valor, user.id, nome]
  );

  if (result.rows.length === 0) {
    await whatsapp.sendText({
      to:   telefone,
      text: `Meta "${nome}" não encontrada.\nCrie com: meta ${nome.toLowerCase()} <valor>`,
    });
    return { success: false, userId: user.id, erro: "Meta não encontrada" };
  }

  const row          = result.rows[0];
  const meta         = Number(row.valor_meta);
  const atual        = Number(row.valor_atual);
  const percent      = meta > 0 ? Math.round((atual / meta) * 100) : 0;
  const acabouAgora  = (atual - valor) < meta && atual >= meta;

  setLastGoal(user.id, { nome: row.nome, valorMeta: meta });

  const linhas = [
    `🎯 ${fmtValor(valor)} adicionados à meta ${row.nome}`,
    "",
    "Progresso:",
    `${fmtValor(atual)} / ${fmtValor(meta)} (${percent}%)`,
  ];

  if (atual >= meta && !acabouAgora) linhas.push("", "✅ Meta já concluída!");

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("guardar enviado", { to: telefone, nome: row.nome, atual, meta });
  } catch (err) {
    log.error("falha ao enviar guardar", err, { to: telefone });
  }

  if (acabouAgora) {
    setTimeout(async () => {
      try {
        const celebracao = [
          `🏆 Meta "${row.nome}" concluída!`,
          "",
          `${fmtValor(meta)} guardados.`,
        ].join("\n");
        await whatsapp.sendText({ to: telefone, text: celebracao });
        log.whatsapp("celebracao meta enviada", { to: telefone, nome: row.nome, meta });
      } catch (err) {
        log.error("falha ao enviar celebracao meta", err, { to: telefone });
      }
    }, 1500);
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "guardar", nome: row.nome, valor, atual, meta },
  };
}

export async function handleAddToGoal(
  user: UserRow,
  telefone: string,
  valor: number,
  nomeHint?: string,
): Promise<ProcessResult> {
  type GoalRow = { nome: string; valor_meta: string; valor_atual: string };

  let goalRow: GoalRow | null = null;

  if (nomeHint) {
    const r = await pool.query<GoalRow>(
      `SELECT nome, valor_meta, valor_atual FROM user_goals
       WHERE user_id = $1 AND LOWER(nome) ILIKE '%' || LOWER($2) || '%'
       ORDER BY criado_em ASC LIMIT 1`,
      [user.id, nomeHint]
    );
    goalRow = r.rows[0] ?? null;

    if (!goalRow) {
      await whatsapp.sendText({ to: telefone, text: `Meta "${nomeHint}" não encontrada.\nCrie assim: meta ${nomeHint} 5000` });
      return { success: false, userId: user.id, erro: "Meta não encontrada" };
    }
  } else {
    // No name given — check how many goals the user has before assuming anything
    const r = await pool.query<GoalRow>(
      `SELECT nome, valor_meta, valor_atual FROM user_goals WHERE user_id = $1 ORDER BY criado_em ASC`,
      [user.id]
    );

    if (r.rows.length === 0) {
      await whatsapp.sendText({ to: telefone, text: `Você não tem metas ainda.\nCrie assim: meta viagem 5000 🎯` });
      return { success: false, userId: user.id, erro: "Sem metas" };
    }

    if (r.rows.length === 1) {
      goalRow = r.rows[0];
    } else {
      // Multiple goals — always ask to avoid adding to the wrong one
      const lista = r.rows.map(row => `• ${row.nome}`).join("\n");
      await whatsapp.sendText({ to: telefone, text: `Para qual meta?\n${lista}\n\nEx: guardar ${Math.round(valor)} ${r.rows[0].nome.toLowerCase()}` });
      return { success: false, userId: user.id, erro: "ambiguous goal" };
    }
  }

  const result = await pool.query<GoalRow>(
    `UPDATE user_goals SET valor_atual = valor_atual + $1
     WHERE user_id = $2 AND LOWER(nome) = LOWER($3)
     RETURNING nome, valor_meta, valor_atual`,
    [valor, user.id, goalRow.nome]
  );

  if (result.rows.length === 0) {
    await whatsapp.sendText({ to: telefone, text: "Algo deu errado. Tenta de novo?" });
    return { success: false, userId: user.id, erro: "Goal update failed" };
  }

  const row    = result.rows[0];
  const meta   = Number(row.valor_meta);
  const atual  = Number(row.valor_atual);
  const percent  = meta > 0 ? Math.round((atual / meta) * 100) : 0;
  const concluiu = meta > 0 && (atual - valor) < meta && atual >= meta;

  setLastGoal(user.id, { nome: row.nome, valorMeta: meta });
  recordAction(user.id, "created_goal");

  const linhas: string[] = [`✅ ${fmtValor(valor)} adicionados — ${row.nome}`];
  if (meta > 0) {
    linhas.push("", `${fmtValor(atual)} de ${fmtValor(meta)} (${percent}%)`);
  } else {
    linhas.push("", `Total guardado: ${fmtValor(atual)}`);
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
  } catch (err) {
    log.error("falha ao enviar add to goal", err, { to: telefone });
  }

  if (concluiu) {
    setTimeout(async () => {
      try {
        await whatsapp.sendText({ to: telefone, text: `🏆 Meta "${row.nome}" concluída!\n\n${fmtValor(meta)} guardados.` });
      } catch (err) {
        log.error("falha ao enviar celebracao meta", err, { to: telefone });
      }
    }, 1500);
  }

  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "adicionar_meta", nome: row.nome, valor, atual, meta } };
}

export async function handleGoalProgress(
  user: UserRow,
  telefone: string,
  nomeHint?: string,
): Promise<ProcessResult> {
  type GoalRow = { nome: string; valor_meta: string; valor_atual: string };

  const showGoal = (row: GoalRow): string => {
    const meta   = Number(row.valor_meta);
    const atual  = Number(row.valor_atual);
    const percent = meta > 0 ? Math.round((atual / meta) * 100) : 0;
    const falta  = meta > atual ? meta - atual : 0;
    if (meta > 0) {
      return `${row.nome} — ${fmtValor(atual)} de ${fmtValor(meta)} (${percent}%)\n${falta > 0 ? `Faltam ${fmtValor(falta)}` : "Concluída ✅"}`;
    }
    return `${row.nome} — ${fmtValor(atual)} guardados`;
  };

  if (nomeHint) {
    const r = await pool.query<GoalRow>(
      `SELECT nome, valor_meta, valor_atual FROM user_goals
       WHERE user_id = $1 AND LOWER(nome) ILIKE '%' || LOWER($2) || '%'
       ORDER BY criado_em ASC LIMIT 1`,
      [user.id, nomeHint]
    );
    if (!r.rows[0]) {
      await whatsapp.sendText({ to: telefone, text: `Meta "${nomeHint}" não encontrada.` });
      return { success: false, userId: user.id, erro: "Meta não encontrada" };
    }
    await whatsapp.sendText({ to: telefone, text: showGoal(r.rows[0]) });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "progresso_meta", nome: r.rows[0].nome } };
  }

  // Try lastGoal in session
  const last = getLastGoal(user.id);
  if (last) {
    const r = await pool.query<GoalRow>(
      `SELECT nome, valor_meta, valor_atual FROM user_goals WHERE user_id = $1 AND LOWER(nome) = LOWER($2) LIMIT 1`,
      [user.id, last.nome]
    );
    if (r.rows[0]) {
      await whatsapp.sendText({ to: telefone, text: showGoal(r.rows[0]) });
      return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "progresso_meta", nome: r.rows[0].nome } };
    }
  }

  // Fallback: show all metas
  return await handleMetasCommand(user, telefone);
}

export async function handleCreateGoalNoValue(
  user: UserRow,
  telefone: string,
  nome: string,
): Promise<ProcessResult> {
  const nomeFormatado = nome.charAt(0).toUpperCase() + nome.slice(1).toLowerCase();
  const txt = `Perfeito 🙂\nQual o valor que quer guardar pro ${nomeFormatado}?\n\nEx: meta ${nome.toLowerCase()} 15000`;
  await whatsapp.sendText({ to: telefone, text: txt });
  return { success: false, userId: user.id, erro: "goal without value" };
}

export async function handleGoalPercentage(user: UserRow, telefone: string): Promise<ProcessResult> {
  const last = getLastGoal(user.id);
  if (!last) return await handleMetasCommand(user, telefone);

  const r = await pool.query<{ nome: string; valor_meta: string; valor_atual: string }>(
    `SELECT nome, valor_meta, valor_atual FROM user_goals WHERE user_id = $1 AND LOWER(nome) = LOWER($2) LIMIT 1`,
    [user.id, last.nome]
  );
  if (!r.rows[0]) return await handleMetasCommand(user, telefone);

  const row     = r.rows[0];
  const meta    = Number(row.valor_meta);
  const atual   = Number(row.valor_atual);
  const percent = meta > 0 ? Math.round((atual / meta) * 100) : 0;

  const txt = meta > 0
    ? `${row.nome} — ${percent}% concluída\n${fmtValor(atual)} de ${fmtValor(meta)}`
    : `${row.nome} — ${fmtValor(atual)} guardados (sem valor-alvo definido)`;

  try {
    await whatsapp.sendText({ to: telefone, text: txt });
  } catch (err) {
    log.error("falha ao enviar porcentagem meta", err, { to: telefone });
  }
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "porcentagem_meta", nome: row.nome } };
}

export async function handleGoalAmountSaved(user: UserRow, telefone: string): Promise<ProcessResult> {
  const last = getLastGoal(user.id);
  if (!last) return await handleMetasCommand(user, telefone);

  const r = await pool.query<{ nome: string; valor_meta: string; valor_atual: string }>(
    `SELECT nome, valor_meta, valor_atual FROM user_goals WHERE user_id = $1 AND LOWER(nome) = LOWER($2) LIMIT 1`,
    [user.id, last.nome]
  );
  if (!r.rows[0]) return await handleMetasCommand(user, telefone);

  const row     = r.rows[0];
  const meta    = Number(row.valor_meta);
  const atual   = Number(row.valor_atual);
  const percent = meta > 0 ? Math.round((atual / meta) * 100) : 0;

  const txt = meta > 0
    ? `${row.nome} — ${fmtValor(atual)} guardados (${percent}%)`
    : `${row.nome} — ${fmtValor(atual)} guardados`;

  try {
    await whatsapp.sendText({ to: telefone, text: txt });
  } catch (err) {
    log.error("falha ao enviar juntei meta", err, { to: telefone });
  }
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "juntei_meta", nome: row.nome } };
}
