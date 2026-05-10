import pool from "../db/client";
import { parseTransaction } from "../utils/parseTransaction";
import { fetchPeriodMetrics } from "./reportService";
import { whatsapp } from "./whatsapp";
import { log } from "../utils/logger";
import { buildPlansBlock } from "../utils/plansMessage";
import type { NormalizedMessage } from "../adapters/whatsappAdapters";

function firstNameOf(rawName?: string | null): string | null {
  if (!rawName) return null;
  const token = rawName.trim().split(/\s+/)[0];
  return /[a-zA-ZÀ-ÿ]/.test(token) ? token : null;
}

interface UserRow {
  id: number;
  telefone: string;
  nome: string | null;
  renda: string;
  renda_extra: string;
  subscription_status: string;
  trial_ends_at: Date | null;
  subscription_expires_at: Date | null;
}

type ProcessResult =
  | { success: true;  userId: number; transacao: Record<string, unknown>; interpretado: Record<string, unknown> }
  | { success: false; userId?: number; erro: string };

async function findUserByTelefone(telefone: string): Promise<UserRow | null> {
  const normalized = telefone.replace(/[^0-9]/g, "");

  log.user("buscando", { telefone: normalized });

  const result = await pool.query<UserRow>(
    `SELECT id, telefone, nome, renda, renda_extra, subscription_status, trial_ends_at, subscription_expires_at FROM users
     WHERE REGEXP_REPLACE(telefone, '[^0-9]', '', 'g') = $1
        OR RIGHT(REGEXP_REPLACE(telefone, '[^0-9]', '', 'g'), 11) = RIGHT($1, 11)
        OR RIGHT(REGEXP_REPLACE(telefone, '[^0-9]', '', 'g'), 8)  = RIGHT($1, 8)
     LIMIT 1`,
    [normalized]
  );

  const user = result.rows[0] ?? null;

  if (user) {
    log.user("encontrado", { id: user.id, nome: user.nome ?? "sem nome", telefone_db: user.telefone });
  } else {
    log.user("nao encontrado", { telefone: normalized });
  }

  return user;
}

export async function processWhatsAppMessage(message: NormalizedMessage): Promise<ProcessResult> {
  const provider = process.env.WHATSAPP_PROVIDER ?? "mock";
  log.webhook("iniciando processamento", { provider_envio: provider });

  // ── Anti-duplicidade — insere messageId atomicamente ─────────────────────
  if (message.messageId) {
    try {
      const dedup = await pool.query(
        `INSERT INTO processed_messages (message_id, telefone)
         VALUES ($1, $2)
         ON CONFLICT (message_id) DO NOTHING`,
        [message.messageId, message.telefone]
      );

      if (dedup.rowCount === 0) {
        log.duplicate("messageId já processado, descartando", { messageId: message.messageId });
        return { success: false, erro: "Mensagem duplicada" };
      }
    } catch (err) {
      log.error("falha na verificacao de duplicidade, prosseguindo sem dedup", err, { messageId: message.messageId });
    }
  }

  // ── Busca usuário ─────────────────────────────────────────────────────────
  let user: UserRow | null;
  try {
    user = await findUserByTelefone(message.telefone);
  } catch (err) {
    log.error("falha ao buscar usuario no banco", err, { telefone: message.telefone });
    return { success: false, erro: "Erro interno ao buscar usuário" };
  }

  if (!user) {
    const textoNew       = message.texto.trim();
    const parsedFirst    = parseTransaction(textoNew);
    const isCommandFirst = isKnownCommand(textoNew);
    const ehSaudacao     = /^(oi|ol[aá]|ola|começar|comecar|menu|ajuda|hi|hello|hey|bom\s*dia|boa\s*tarde|boa\s*noite|start)$/i.test(textoNew);
    const ehPergunta     = /como\s+(funciona|uso|usar|fa[çc]o)|o\s+que\s+(você|voce|vc)\s+(faz|pode|conseg|d[aá])|me\s+(ajuda|ajude|ensina)|o\s+que\s+[eéè]\s+isso/i.test(textoNew);

    // Qualquer mensagem de texto de um novo usuário entra no fluxo de onboarding

    try {
      const nomeNovo = firstNameOf(message.pushName);
      if (nomeNovo) {
        await pool.query(
          `INSERT INTO users (telefone, nome, trial_ends_at)
           VALUES ($1, $2, NOW() + INTERVAL '7 days')
           ON CONFLICT (telefone) DO UPDATE SET nome = $2 WHERE users.nome IS DISTINCT FROM $2`,
          [message.telefone, nomeNovo]
        );
      } else {
        await pool.query(
          `INSERT INTO users (telefone, trial_ends_at)
           VALUES ($1, NOW() + INTERVAL '7 days')
           ON CONFLICT (telefone) DO NOTHING`,
          [message.telefone]
        );
      }
    } catch (err) {
      log.error("falha ao criar usuario no onboarding", err, { telefone: message.telefone });
      return { success: false, erro: "Erro ao criar usuário" };
    }

    if (parsedFirst || isCommandFirst) {
      // Fast-track: usuário já sabe o que quer → processa direto, sem tutorial
      try {
        user = await findUserByTelefone(message.telefone);
      } catch (err) {
        return { success: false, erro: "Erro ao carregar usuário" };
      }
      if (!user) return { success: false, erro: "Erro ao criar usuário" };
      log.user("fast-track onboarding — processando direto", { telefone: message.telefone, userId: user.id });
      // Continua no fluxo normal abaixo
    } else {
      // Guided: usuário chegou perdido ou curioso → welcome adaptado
      const nome       = firstNameOf(message.pushName);
      const saudacao   = nome ? `Olá, ${nome} 👋` : `Olá 👋`;
      const corpoLinha = ehPergunta
        ? "Registro seus gastos aqui e organizo tudo — sem app, sem planilha."
        : "Pode me mandar seus gastos por aqui mesmo.";
      const boas_vindas = [
        saudacao,
        "",
        corpoLinha,
        "Tipo:",
        "",
        "35 uber  •  50 mercado  •  120 farmácia",
        "",
        "Que eu vou organizando tudo pra você 📝",
        "",
        "Você tem 7 dias grátis pra testar no seu ritmo.",
      ].join("\n");

      try {
        await whatsapp.sendText({ to: message.telefone, text: boas_vindas });
        log.whatsapp("onboarding welcome enviado", { to: message.telefone, tipo: ehPergunta ? "guided" : "greeting" });
      } catch (err) {
        log.error("falha ao enviar welcome", err, { to: message.telefone });
      }

      return { success: false, userId: undefined, erro: "Onboarding iniciado" };
    }
  }

  // ── Controle de acesso (trial / active / expired) ────────────────────────
  if (!isSubscriptionActive(user)) {
    const ehTrialExpirado =
      user.subscription_status === "trial" &&
      !!user.trial_ends_at &&
      new Date(user.trial_ends_at) <= new Date();

    const intro = ehTrialExpirado
      ? "Seu período de teste encerrou.\n\nPara continuar organizando seus gastos, escolha um plano:"
      : "Sua assinatura expirou.\n\nPara continuar usando o Salva Bolso, renove agora:";

    const plansBlock = await buildPlansBlock();
    const corpo = plansBlock || "Entre em contato para assinar.";
    const rodape = "\n\nApós o pagamento, seu acesso é liberado automaticamente.";

    await whatsapp.sendText({ to: message.telefone, text: `${intro}\n\n${corpo}${rodape}` });
    return { success: false, userId: user.id, erro: "Assinatura expirada" };
  }

  // ── Pending action check ──────────────────────────────────────────────────
  const pendingRow = await pool.query<{
    action: "apagar" | "corrigir" | "novo_mes";
    step: "waiting_selection" | "waiting_new_value" | "waiting_renda" | "waiting_carryover";
    tx_ids: unknown;
    selected_tx_id: number | null;
  }>(
    `SELECT action, step, tx_ids, selected_tx_id
     FROM pending_actions
     WHERE user_id = $1 AND expires_at > NOW()`,
    [user.id]
  );

  if (pendingRow.rows.length > 0) {
    const pending   = pendingRow.rows[0];
    const textoTrim = message.texto.trim();

    if (/^cancelar$/i.test(textoTrim)) {
      await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
      await whatsapp.sendText({ to: message.telefone, text: "Ação cancelada." });
      return { success: false, userId: user.id, erro: "Ação cancelada" };
    }

    if (pending.step === "waiting_selection") {
      const txIds = pending.tx_ids as number[];
      const num   = parseInt(textoTrim, 10);
      if (!isNaN(num) && num >= 1 && num <= txIds.length) {
        const txId = txIds[num - 1];
        return pending.action === "apagar"
          ? await handleApagarSelecao(user, message.telefone, txId)
          : await handleCorrigirSelecao(user, message.telefone, txId);
      }
      if (!isKnownCommand(textoTrim)) {
        await whatsapp.sendText({
          to:   message.telefone,
          text: `Envie um número de 1 a ${txIds.length}, ou "cancelar".`,
        });
        return { success: false, userId: user.id, erro: "Aguardando seleção" };
      }
      // Comando reconhecido → cancela pending e continua abaixo
      await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    } else if (pending.step === "waiting_new_value") {
      if (!isKnownCommand(textoTrim)) {
        return await handleCorrigirNovoValor(user, message.telefone, message.texto, pending.selected_tx_id!);
      }
      // Comando reconhecido → cancela pending e continua abaixo
      await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    } else if (pending.step === "waiting_renda") {
      if (!isKnownCommand(textoTrim)) {
        return await handleNovoMesRenda(user, message.telefone, textoTrim);
      }
      await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    } else if (pending.step === "waiting_carryover") {
      if (textoTrim === "1" || textoTrim === "2") {
        return await handleNovoMesCarryover(user, message.telefone, textoTrim, pending.tx_ids);
      }
      if (!isKnownCommand(textoTrim)) {
        await whatsapp.sendText({ to: message.telefone, text: "Responda:\n1️⃣ Sim\n2️⃣ Não" });
        return { success: false, userId: user.id, erro: "Aguardando escolha carryover" };
      }
      await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    }
  }

  // ── Onboarding: boas-vindas para usuário novo ────────────────────────────
  const ehSaudacaoOuAjuda = /^(oi|ol[aá]|ola|começar|comecar|menu|ajuda|hi|hello|hey|bom\s*dia|boa\s*tarde|boa\s*noite|start)$/i
    .test(message.texto.trim());

  if (ehSaudacaoOuAjuda) {
    const countRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`,
      [user.id]
    );
    const count = Number(countRow.rows[0].count);

    if (count === 0) {
      const boas_vindas = [
        "Olá! Me manda um gasto:",
        "35 uber  •  50 mercado  •  120 farmácia 📝",
      ].join("\n");
      try {
        await whatsapp.sendText({ to: message.telefone, text: boas_vindas });
        log.whatsapp("onboarding welcome enviado", { to: message.telefone, userId: user.id });
      } catch (err) {
        log.error("falha ao enviar welcome", err, { to: message.telefone });
      }
      return { success: false, userId: user.id, erro: "Onboarding iniciado" };
    }

    // Usuário ativo pediu ajuda ou menu explicitamente → lista completa
    if (/^(ajuda|menu)$/i.test(message.texto.trim())) {
      return await handleAjudaCommand(user, message.telefone);
    }

    // Saudação social de usuário ativo → resposta natural, sem listar comandos
    const saudacoes = [
      "Olá! Me manda um gasto ou fala 'saldo'.",
      "Oi! Manda um gasto ou 'saldo' pra ver o mês.",
      "Olá! Estou aqui. Manda um gasto ou 'saldo'.",
    ];
    await whatsapp.sendText({
      to:   message.telefone,
      text: saudacoes[new Date().getHours() % saudacoes.length],
    });
    return { success: false, userId: user.id, erro: "Saudacao de usuario ativo" };
  }

  // ── Comandos de consulta ──────────────────────────────────────────────────
  if (/^saldo$/i.test(message.texto.trim())) {
    return await handleSaldoCommand(user, message.telefone);
  }
  if (/^resumo$/i.test(message.texto.trim())) {
    return await handleResumoCommand(user, message.telefone);
  }
  if (/^top\s*gastos$/i.test(message.texto.trim())) {
    return await handleTopGastosCommand(user, message.telefone);
  }
  if (/^limite\s+.+\s+[\d,.]+$/i.test(message.texto.trim())) {
    return await handleLimiteCommand(user, message.telefone, message.texto.trim());
  }
  if (/^hoje$/i.test(message.texto.trim())) {
    return await handleHojeCommand(user, message.telefone);
  }
  if (/^semana$/i.test(message.texto.trim())) {
    return await handleSemanaCommand(user, message.telefone);
  }
  if (/^categorias$/i.test(message.texto.trim())) {
    return await handleCategoriasCommand(user, message.telefone);
  }
  if (/^ajuda$/i.test(message.texto.trim())) {
    return await handleAjudaCommand(user, message.telefone);
  }
  if (/^meta\s+.+\s+[\d,.]+$/i.test(message.texto.trim())) {
    return await handleMetaCommand(user, message.telefone, message.texto.trim());
  }
  if (/^metas$/i.test(message.texto.trim())) {
    return await handleMetasCommand(user, message.telefone);
  }
  if (/^guardar\s+[\d,.]+\s+.+$/i.test(message.texto.trim())) {
    return await handleGuardarCommand(user, message.telefone, message.texto.trim());
  }
  if (/^ranking$/i.test(message.texto.trim())) {
    return await handleRankingCommand(user, message.telefone);
  }
  if (/^comparar$/i.test(message.texto.trim())) {
    return await handleCompararCommand(user, message.telefone);
  }
  if (/^desafio$/i.test(message.texto.trim())) {
    return await handleDesafioCommand(user, message.telefone);
  }
  if (/^previs[aã]o$/i.test(message.texto.trim())) {
    return await handlePrevisaoCommand(user, message.telefone);
  }
  if (/^recorrentes$/i.test(message.texto.trim())) {
    return await handleRecorrentesCommand(user, message.telefone);
  }
  if (/^pr[oó]ximas$/i.test(message.texto.trim())) {
    return await handleProximasCommand(user, message.telefone);
  }
  if (/^buscar\s+.+$/i.test(message.texto.trim())) {
    return await handleBuscarCommand(user, message.telefone, message.texto.trim());
  }
  if (/^recorrente\s+[\d,.]+\s+.+$/i.test(message.texto.trim())) {
    return await handleRecorrenteCommand(user, message.telefone, message.texto.trim());
  }
  if (/^apagar$/i.test(message.texto.trim())) {
    return await handleApagarCommand(user, message.telefone);
  }
  if (/^corrigir$/i.test(message.texto.trim())) {
    return await handleCorrigirCommand(user, message.telefone);
  }
  if (/^extrato\s+.+$/i.test(message.texto.trim())) {
    return await handleExtratoCommand(user, message.telefone, message.texto.trim());
  }

  // ── Interpretação conversacional ─────────────────────────────────────────
  const intentResult = await tryHandleIntent(user, message.telefone, message.texto);
  if (intentResult !== null) return intentResult;

  // ── Proteção contra mensagens ambíguas ───────────────────────────────────
  if (isAmbiguousIntent(message.texto)) {
    await whatsapp.sendText({
      to:   message.telefone,
      text: buildContextualHint(message.texto),
    });
    return { success: false, userId: user.id, erro: "Mensagem ambígua" };
  }

  // ── Parser ────────────────────────────────────────────────────────────────

  // Onboarding step 1: número puro sem palavra-chave → interpretar como renda
  let textoParsear = message.texto;
  if (/^\d[\d,.]*$/.test(message.texto.trim())) {
    const cRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`,
      [user.id]
    );
    if (Number(cRow.rows[0].count) === 0) {
      textoParsear = message.texto.trim() + " salário";
      log.parser("onboarding: numero puro → renda", { original: message.texto, ajustado: textoParsear });
    }
  }

  log.parser("analisando", { texto: textoParsear });

  const parsed = parseTransaction(textoParsear);

  if (!parsed) {
    log.parser("nao reconhecido", { texto: message.texto });

    try {
      const sendResult = await whatsapp.sendText({
        to: message.telefone,
        text: buildContextualHint(message.texto),
      });
      log.whatsapp("erro enviado", { to: message.telefone, success: sendResult.success });
    } catch (err) {
      log.error("falha ao enviar mensagem de erro", err, { to: message.telefone });
    }

    return { success: false, userId: user.id, erro: "Mensagem não reconhecida" };
  }

  log.parser("ok", {
    valor:     parsed.valor,
    categoria: parsed.categoria,
    tipo:      parsed.tipo,
    descricao: parsed.descricao,
  });

  // ── Salvar no banco ───────────────────────────────────────────────────────
  log.db("inserindo transacao", { user_id: user.id, tipo: parsed.tipo, valor: parsed.valor, categoria: parsed.categoria });

  let transacaoRow: Record<string, unknown>;
  try {
    const result = await pool.query(
      `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [user.id, parsed.tipo, parsed.valor, parsed.categoria, parsed.descricao]
    );
    transacaoRow = result.rows[0] as Record<string, unknown>;
    log.db("transacao salva", { id: transacaoRow.id, user_id: user.id });
  } catch (err) {
    log.error("falha ao inserir transacao", err, { user_id: user.id });
    return { success: false, userId: user.id, erro: "Erro ao salvar transação no banco" };
  }

  // ── Enviar confirmação WhatsApp ───────────────────────────────────────────

  // Onboarding step 2: primeira transação é uma entrada → direcionar para o primeiro gasto
  if (parsed.tipo === "entrada") {
    const countRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`,
      [user.id]
    );
    if (Number(countRow.rows[0].count) === 1) {
      const msg = `💰 ${fmtValor(parsed.valor)} registrado.\nQuando quiser, me manda um gasto.`;
      try {
        await whatsapp.sendText({ to: message.telefone, text: msg });
        log.whatsapp("onboarding step2 enviado", { to: message.telefone, userId: user.id });
      } catch (err) {
        log.error("falha ao enviar onboarding step2", err, { to: message.telefone });
      }
      return {
        success:      true,
        userId:       user.id,
        transacao:    transacaoRow,
        interpretado: { valor: parsed.valor, descricao: parsed.descricao, categoria: parsed.categoria, tipo: parsed.tipo },
      };
    }
  }

  const PREFIXOS_CONFIRMACAO = ["Anotado", "Registrado", "Salvo", "Organizado"];
  const prefixo = PREFIXOS_CONFIRMACAO[Math.floor(Math.random() * PREFIXOS_CONFIRMACAO.length)];

  const linhasConfirmacao = parsed.tipo === "entrada"
    ? [`💰 ${fmtValor(parsed.valor)} registrado`]
    : [`✅ ${prefixo}: ${fmtValor(parsed.valor)} — ${capitalizeFirst(parsed.descricao)}`];

  if (parsed.tipo === "saida") {
    const aviso = await checkLimiteCategoria(user.id, parsed.categoria);
    if (aviso) linhasConfirmacao.push("", aviso);
  }

  const confirmacao = linhasConfirmacao.join("\n");

  log.whatsapp("enviando confirmacao", { to: message.telefone });

  try {
    const sendResult = await whatsapp.sendText({ to: message.telefone, text: confirmacao });
    log.whatsapp(sendResult.success ? "enviado" : "falha no envio", {
      to:        message.telefone,
      success:   sendResult.success,
      messageId: sendResult.messageId,
      error:     sendResult.error,
    });
  } catch (err) {
    log.error("excecao ao enviar confirmacao", err, { to: message.telefone });
  }

  if (parsed.tipo === "saida") {
    // Cadeia sequencial com exclusão mútua: só 1 mensagem secundária por gasto.
    // Cada função retorna true se enviou algo — a cadeia para na primeira que disparar.
    setTimeout(async () => {
      try {
        if (await checkAndSendOnboardingTip(user.id, message.telefone, "saida")) return;
        if (await checkAndSendInsights(user.id, message.telefone, parsed.categoria)) return;
        if (await sendContextualMicroInsight(user.id, message.telefone, parsed.categoria)) return;
        if (await checkAndSuggestRecorrente(user.id, message.telefone, parsed.descricao)) return;
        await checkAndDetectInstallment(user.id, message.telefone, parsed.descricao, message.texto, parsed.valor);
      } catch (err) {
        log.error("falha na cadeia de insights pos-gasto", err, { userId: user.id });
      }
    }, 1200);
  }

  return {
    success: true,
    userId: user.id,
    transacao: transacaoRow,
    interpretado: {
      valor:     parsed.valor,
      descricao: parsed.descricao,
      categoria: parsed.categoria,
      tipo:      parsed.tipo,
    },
  };
}

async function handleSaldoCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando saldo", { userId: user.id });

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const metrics = await fetchPeriodMetrics(user.id, inicioMes, fimMes);

  // Renda total = renda fixa cadastrada + renda extra cadastrada + entradas do mês
  const rendaFixa  = Number(user.renda      ?? 0);
  const rendaExtra = Number(user.renda_extra ?? 0);
  const totalRenda = rendaFixa + rendaExtra + metrics.total_entradas;
  const sobrou     = totalRenda - metrics.total_saidas;

  const meses = ["janeiro","fevereiro","março","abril","maio","junho",
                 "julho","agosto","setembro","outubro","novembro","dezembro"];

  // Renda ausente → mostra gastos parciais e captura renda contextualmente
  if (totalRenda === 0) {
    const linhasParcial = [`Gastos de ${meses[now.getMonth()]}/${now.getFullYear()}`, ""];
    if (metrics.gastos_por_categoria.length === 0) {
      linhasParcial.push("Nenhum gasto registrado este mês.");
    } else {
      for (const cat of metrics.gastos_por_categoria) {
        linhasParcial.push(`${cat.categoria}: ${fmtValor(cat.total)}`);
      }
      linhasParcial.push("", `Total: ${fmtValor(metrics.total_saidas)}`);
    }
    linhasParcial.push("", "Para ver o que sobrou, me conta sua renda:");
    linhasParcial.push("Ex: 3000");

    await pool.query(
      `INSERT INTO pending_actions (user_id, action, step, tx_ids)
       VALUES ($1, 'novo_mes', 'waiting_renda', '[]'::jsonb)
       ON CONFLICT (user_id) DO UPDATE
         SET action = 'novo_mes', step = 'waiting_renda', tx_ids = '[]'::jsonb,
             selected_tx_id = NULL, expires_at = NOW() + INTERVAL '30 minutes'`,
      [user.id]
    );

    try {
      await whatsapp.sendText({ to: telefone, text: linhasParcial.join("\n") });
      log.whatsapp("saldo parcial enviado — aguardando renda", { to: telefone });
    } catch (err) {
      log.error("falha ao enviar saldo parcial", err, { to: telefone });
    }
    return { success: false, userId: user.id, erro: "Aguardando renda" };
  }

  const linhas = [
    `Saldo de ${meses[now.getMonth()]}/${now.getFullYear()}`,
    "",
    `Renda: ${fmtValor(totalRenda)}`,
    `Gastos: ${fmtValor(metrics.total_saidas)}`,
    sobrou >= 0
      ? `💚 Sobrou: ${fmtValor(sobrou)}`
      : `⚠️ Deficit: ${fmtValor(Math.abs(sobrou))}`,
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("saldo enviado", { to: telefone, totalRenda, gastos: metrics.total_saidas, sobrou });
  } catch (err) {
    log.error("falha ao enviar saldo", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "saldo", totalRenda, gastos: metrics.total_saidas, sobrou },
  };
}

async function handleResumoCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando resumo", { userId: user.id });

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const metrics = await fetchPeriodMetrics(user.id, inicioMes, fimMes);

  const meses = ["janeiro","fevereiro","março","abril","maio","junho",
                 "julho","agosto","setembro","outubro","novembro","dezembro"];

  const linhas = [`Resumo de ${meses[now.getMonth()]}/${now.getFullYear()}`, ""];

  if (metrics.gastos_por_categoria.length === 0) {
    linhas.push("Nenhum gasto registrado este mês.");
  } else {
    for (const cat of metrics.gastos_por_categoria) {
      linhas.push(`${cat.categoria}: ${fmtValor(cat.total)}`);
    }
    linhas.push("");
    linhas.push(`Total gasto: ${fmtValor(metrics.total_saidas)}`);
    if (metrics.categoria_top) {
      linhas.push(`Maior categoria: ${metrics.categoria_top}`);
    }
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("resumo enviado", { to: telefone, categorias: metrics.gastos_por_categoria.length });
  } catch (err) {
    log.error("falha ao enviar resumo", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "resumo", totalGasto: metrics.total_saidas, categorias: metrics.gastos_por_categoria.length },
  };
}

function fmtValor(valor: number): string {
  return valor % 1 === 0 ? `R$ ${valor.toFixed(0)}` : `R$ ${valor.toFixed(2)}`;
}

function capitalizeFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

const RECURRING_KEYWORDS = [
  "netflix", "spotify", "disney", "prime", "youtube", "globoplay", "hbo",
  "paramount", "deezer", "apple", "icloud",
  "academia", "gym", "pilates", "natacao",
  "aluguel", "condominio", "internet", "banda larga",
  "luz", "energia", "água", "agua", "gas",
  "faculdade", "escola", "mensalidade",
  "seguro", "financiamento",
  "assinatura", "plano",
  "canva", "chatgpt", "openai", "dropbox", "amazon",
];

// Detecta serviços recorrentes conhecidos na 2ª ocorrência — pergunta natural, 1x na vida
async function checkAndSuggestRecorrente(userId: number, telefone: string, descricao: string): Promise<boolean> {
  try {
    const descLower = descricao.toLowerCase();
    const isKnown   = RECURRING_KEYWORDS.some(kw => descLower.includes(kw));
    if (!isKnown) return false;

    const now       = new Date();
    const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const countRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions
       WHERE user_id = $1 AND tipo = 'saida' AND LOWER(descricao) = LOWER($2)
       AND criado_em >= $3 AND criado_em < $4`,
      [userId, descricao, inicioMes, fimMes]
    );
    if (Number(countRow.rows[0].count) < 2) return false;

    const sentinel = `rec_${descLower.replace(/\s+/g, "_").slice(0, 45)}`;
    const LIFETIME = new Date("2000-01-01");
    const inserted = await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, sentinel, LIFETIME]
    );
    if ((inserted.rowCount ?? 0) === 0) return false;

    await whatsapp.sendText({
      to:   telefone,
      text: `${capitalizeFirst(descricao)} costuma aparecer todo mês?`,
    });
    log.whatsapp("sugestao recorrente enviada", { to: telefone, userId, descricao });
    return true;
  } catch (err) {
    log.error("falha sugestao recorrente", err, { userId });
    return false;
  }
}

const INSTALLMENT_KEYWORDS = [
  "iphone", "ipad", "macbook", "airpods",
  "notebook", "laptop", "computador",
  "celular", "smartphone",
  "sofá", "sofa", "cama", "colchão", "colchao", "móveis", "moveis", "armário", "armario",
  "tv", "televisão", "televisao", "geladeira", "fogão", "fogao", "microondas", "lavadora",
  "moto", "carro", "bicicleta",
  "curso", "treinamento",
];

// Detecta parcelamentos explícitos (6x, parcelado, 2/10) ou compras típicas de alto valor
async function checkAndDetectInstallment(
  userId: number, telefone: string, descricao: string, textoOriginal: string, valor: number
): Promise<boolean> {
  try {
    const textoLower = textoOriginal.toLowerCase();
    const descLower  = descricao.toLowerCase();

    // Sinal explícito: "6x", "parcelado/a", "2/10"
    const matchX     = textoLower.match(/\b(\d{1,2})[xX]\b/);
    const hasExplicit = !!matchX
      || /\bparcelad[ao]\b/.test(textoLower)
      || /\b[1-9]\d?\/[1-9]\d?\b/.test(textoLower);

    // Sinal implícito: keyword conhecida + valor relevante
    const hasImplicit = valor > 200 && INSTALLMENT_KEYWORDS.some(kw => descLower.includes(kw));

    if (!hasExplicit && !hasImplicit) return false;

    const sentinel = `inst_${descLower.replace(/\s+/g, "_").slice(0, 45)}`;
    const LIFETIME = new Date("2000-01-01");
    const inserted = await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, sentinel, LIFETIME]
    );
    if ((inserted.rowCount ?? 0) === 0) return false;

    // Mensagem: ecoa número de parcelas se detectado, senão pergunta genérica
    const numParcelas = matchX ? Number(matchX[1]) : null;
    const texto = numParcelas
      ? `Parcelado em ${numParcelas}x?`
      : "Isso foi parcelado?";

    await whatsapp.sendText({ to: telefone, text: texto });
    log.whatsapp("deteccao parcelamento enviada", { to: telefone, userId, descricao, numParcelas });
    return true;
  } catch (err) {
    log.error("falha deteccao parcelamento", err, { userId });
    return false;
  }
}

// Micro insight contextual — raro, leve, observações de hoje apenas
async function sendContextualMicroInsight(userId: number, telefone: string, categoria: string): Promise<boolean> {
  try {
    const now         = new Date();
    const todayUTC    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const tomorrowUTC = new Date(todayUTC.getTime() + 86400000);
    const twoMinsAgo  = new Date(now.getTime() - 120000);
    const twoHoursAgo = new Date(now.getTime() - 7200000);

    // Rapid-fire: 2+ tx nos últimos 2 min → silêncio total
    const rapidRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2`,
      [userId, twoMinsAgo]
    );
    if (Number(rapidRow.rows[0].count) > 1) return false;

    // Máx 1 micro insight por dia por usuário
    const alreadySent = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM sent_insights WHERE user_id = $1 AND categoria = 'micro_dia' AND mes_referencia = $2`,
      [userId, todayUTC]
    );
    if (Number(alreadySent.rows[0].count) > 0) return false;

    function pick(opts: string[]): string { return opts[Math.floor(Math.random() * opts.length)]; }

    let insight: string | null = null;

    // Condição 1: 3+ gastos na mesma categoria hoje
    const catRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions
       WHERE user_id = $1 AND LOWER(categoria) = LOWER($2) AND tipo = 'saida'
         AND criado_em >= $3 AND criado_em < $4`,
      [userId, categoria, todayUTC, tomorrowUTC]
    );
    if (Number(catRow.rows[0].count) >= 3) {
      insight = pick([
        `${categoria} apareceu bastante hoje 😅`,
        `Hoje teve bastante ${categoria.toLowerCase()} 😅`,
      ]);
    }

    // Condição 2: 4+ gastos nas últimas 2h (ritmo acelerado)
    if (!insight) {
      const paceRow = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2`,
        [userId, twoHoursAgo]
      );
      if (Number(paceRow.rows[0].count) >= 4) {
        insight = pick([
          "Hoje teve bastante saída em pouco tempo 👀",
          "Bastante saída concentrada hoje 👀",
        ]);
      }
    }

    if (!insight) return false;

    // Registra dedup — só envia se foi o primeiro a inserir
    const ins = await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, 'micro_dia', 1, $2)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, todayUTC]
    );
    if ((ins.rowCount ?? 0) === 0) return false;

    await whatsapp.sendText({ to: telefone, text: insight });
    log.whatsapp("micro insight enviado", { to: telefone, userId, insight });
    return true;
  } catch (err) {
    log.error("falha micro insight", err, { userId });
    return false;
  }
}

const CATEGORIAS_CONHECIDAS = [
  "Alimentação", "Transporte", "Moradia", "Lazer", "Saúde",
  "Educação", "Vestuário", "Investimentos", "Receita Extra", "Outros",
];

function normalizarCategoria(input: string): string {
  const lower = input.toLowerCase().trim();
  return CATEGORIAS_CONHECIDAS.find(c => c.toLowerCase() === lower)
    ?? (input.charAt(0).toUpperCase() + input.slice(1).toLowerCase());
}

async function checkLimiteCategoria(userId: number, categoria: string): Promise<string | null> {
  const limitRow = await pool.query<{ valor_limite: string }>(
    `SELECT valor_limite FROM category_limits
     WHERE user_id = $1 AND LOWER(categoria) = LOWER($2)`,
    [userId, categoria]
  );
  if (limitRow.rows.length === 0) return null;

  const valorLimite = Number(limitRow.rows[0].valor_limite);
  const now         = new Date();
  const inicioMes   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes      = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const gastoRow = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(valor), 0) AS total
     FROM transactions
     WHERE user_id = $1 AND LOWER(categoria) = LOWER($2)
       AND tipo = 'saida' AND criado_em >= $3 AND criado_em < $4`,
    [userId, categoria, inicioMes, fimMes]
  );
  const totalGasto = Number(gastoRow.rows[0].total);
  const percentual = Math.round((totalGasto / valorLimite) * 100);

  if (percentual < 80) return null;

  // Verifica quais marcos já foram enviados este mês
  const sentRow = await pool.query<{ marco: number }>(
    `SELECT marco FROM sent_insights
     WHERE user_id = $1 AND categoria = $2 AND mes_referencia = $3
       AND marco IN (80, 100)`,
    [userId, categoria, inicioMes]
  );
  const marcosSent = new Set(sentRow.rows.map(r => r.marco));

  if (percentual >= 100 && !marcosSent.has(100)) {
    await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, $2, 100, $3)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, categoria, inicioMes]
    );
    return `🚨 Você ultrapassou o limite mensal de ${categoria}.`;
  }

  if (percentual >= 80 && !marcosSent.has(80)) {
    await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, $2, 80, $3)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, categoria, inicioMes]
    );
    return `⚠️ Limite ${categoria}: ${fmtValor(totalGasto)} / ${fmtValor(valorLimite)} (${percentual}%)`;
  }

  return null;
}

async function handleLimiteCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("comando limite", { userId: user.id, texto });

  const match = texto.match(/^limite\s+(.+?)\s+([\d,.]+)$/i);
  if (!match) {
    await whatsapp.sendText({ to: telefone, text: "💡 Ex:\nlimite alimentação 800" });
    return { success: false, userId: user.id, erro: "Formato inválido" };
  }

  const categoria   = normalizarCategoria(match[1]);
  const valorLimite = parseFloat(match[2].replace(",", "."));

  await pool.query(
    `INSERT INTO category_limits (user_id, categoria, valor_limite)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, categoria)
     DO UPDATE SET valor_limite = $3`,
    [user.id, categoria, valorLimite]
  );

  await whatsapp.sendText({
    to:   telefone,
    text: `Limite da categoria ${categoria} definido em R$ ${valorLimite.toFixed(2)}`,
  });

  setTimeout(() => {
    checkAndSendOnboardingTip(user.id, telefone, "limite_criado").catch(err =>
      log.error("falha ao verificar onboarding tip", err, { userId: user.id })
    );
  }, 800);

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "limite", categoria, valorLimite },
  };
}

async function handleSemanaCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando semana", { userId: user.id });

  const now        = new Date();
  const inicio7d   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6));
  const fimHoje    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

  const result = await pool.query<{ categoria: string; total: string }>(
    `SELECT COALESCE(categoria, 'Outros') AS categoria, SUM(valor) AS total
     FROM transactions
     WHERE user_id = $1
       AND tipo = 'saida'
       AND criado_em >= $2
       AND criado_em < $3
     GROUP BY categoria
     ORDER BY total DESC`,
    [user.id, inicio7d, fimHoje]
  );

  const linhas = ["Gastos da semana", ""];

  if (result.rows.length === 0) {
    linhas.push("Nenhum gasto registrado nesta semana.");
  } else {
    let total = 0;
    for (const row of result.rows) {
      const valor = Number(row.total);
      total += valor;
      linhas.push(`${row.categoria} — R$ ${valor.toFixed(2)}`);
    }
    linhas.push("");
    linhas.push(`Total na semana: R$ ${total.toFixed(2)}`);
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("semana enviado", { to: telefone, categorias: result.rows.length });
  } catch (err) {
    log.error("falha ao enviar semana", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "semana", categorias: result.rows.length },
  };
}

const CATEGORIA_EMOJI: Record<string, string> = {
  "Alimentação":  "🍔",
  "Transporte":   "🚗",
  "Moradia":      "🏠",
  "Lazer":        "🎮",
  "Saúde":        "💊",
  "Educação":     "📚",
  "Vestuário":    "👕",
  "Investimentos":"💰",
  "Receita Extra":"💵",
  "Outros":       "📦",
};

const DESAFIOS: Record<string, string[]> = {
  "Alimentação":  [
    "Cozinhe em casa pelo menos 3 vezes esta semana.",
    "Evite delivery por 5 dias seguidos.",
    "Planeje as refeições antes de ir ao mercado.",
  ],
  "Transporte":   [
    "Use transporte público 2 dias esta semana.",
    "Combine caronas com alguém no trabalho.",
    "Evite Uber em distâncias curtas por 5 dias.",
  ],
  "Lazer":        [
    "Escolha uma opção gratuita de lazer este fim de semana.",
    "Cancele uma assinatura que você usa pouco.",
    "Reduza saídas pagas pela metade esta semana.",
  ],
  "Saúde":        [
    "Pesquise genéricos antes da próxima compra na farmácia.",
    "Use o plano de saúde para evitar consultas avulsas.",
  ],
  "Educação":     [
    "Aproveite o conteúdo gratuito antes de comprar novos cursos.",
    "Finalize um curso que já começou antes de comprar outro.",
  ],
  "Moradia":      [
    "Reduza o consumo de energia desligando aparelhos em standby.",
    "Revise assinaturas de streaming e cancele as menos usadas.",
  ],
};

async function handleDesafioCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando desafio", { userId: user.id });

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const metrics = await fetchPeriodMetrics(user.id, inicioMes, fimMes);

  if (metrics.gastos_por_categoria.length === 0) {
    await whatsapp.sendText({
      to:   telefone,
      text: "Registre todos os gastos de hoje e veja para onde o dinheiro vai.",
    });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "desafio" } };
  }

  // Categoria com maior gasto no mês
  const top      = metrics.gastos_por_categoria[0];
  const economia = Math.round(top.total * 0.10);
  const emoji    = CATEGORIA_EMOJI[top.categoria] ?? "📦";

  const templates = DESAFIOS[top.categoria] ?? [
    `Reduza 10% dos gastos em ${top.categoria} este mês.`,
  ];
  // Escolhe baseado no dia do mês para variar sem ser aleatório
  const dica = templates[now.getUTCDate() % templates.length];

  const linhas = [
    "🎯 Desafio da semana",
    "",
    `${emoji} ${dica}`,
    "",
    `Categoria em foco: ${top.categoria}`,
    `Gasto atual: ${fmtValor(top.total)}`,
    `Economia possível: ${fmtValor(economia)}`,
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("desafio enviado", { to: telefone, categoria: top.categoria, economia });
  } catch (err) {
    log.error("falha ao enviar desafio", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "desafio", categoria: top.categoria, economia },
  };
}

async function handleCompararCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando comparar", { userId: user.id });

  const now            = new Date();
  const inicioAtual    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimAtual       = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const inicioAnterior = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const fimAnterior    = inicioAtual;

  const [atual, anterior] = await Promise.all([
    fetchPeriodMetrics(user.id, inicioAtual, fimAtual),
    fetchPeriodMetrics(user.id, inicioAnterior, fimAnterior),
  ]);

  if (anterior.total_saidas === 0) {
    await whatsapp.sendText({ to: telefone, text: "Sem dados do mês anterior para comparar." });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "comparar" } };
  }

  // Variações por categoria — filtra ruído (< R$50) e mudanças irrelevantes (< 10%)
  const anteriorMap = new Map(anterior.gastos_por_categoria.map(c => [c.categoria, c.total]));
  type CatChange = { categoria: string; pct: number };
  const mudancas: CatChange[] = [];

  for (const cat of atual.gastos_por_categoria) {
    const antes = anteriorMap.get(cat.categoria) ?? 0;
    if (antes < 50 && cat.total < 50) continue;
    if (antes === 0) continue;
    const pct = Math.round(((cat.total - antes) / antes) * 100);
    if (Math.abs(pct) < 10) continue;
    mudancas.push({ categoria: cat.categoria, pct });
  }

  // Top 3 pelo maior |Δ%|
  mudancas.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  const top3 = mudancas.slice(0, 3);

  const linhas: string[] = ["📈 Comparado ao mês passado:", ""];

  for (const { categoria, pct } of top3) {
    const emoji = CATEGORIA_EMOJI[categoria] ?? "💸";
    linhas.push(`${emoji} ${categoria}:`);
    linhas.push(`${pct >= 0 ? "+" : ""}${pct}%`);
    linhas.push("");
  }

  const diff = atual.total_saidas - anterior.total_saidas;
  if (diff < 0) {
    linhas.push(`💰 Você economizou ${fmtValor(Math.abs(diff))} a mais este mês.`);
  } else if (diff > 0) {
    linhas.push(`📊 Você gastou ${fmtValor(diff)} a mais que no mês passado.`);
  } else {
    linhas.push("✅ Gastos iguais ao mês anterior.");
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n").trimEnd() });
    log.whatsapp("comparar enviado", { to: telefone, diff, mudancas: top3.length });
  } catch (err) {
    log.error("falha ao enviar comparar", err, { to: telefone });
  }

  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "comparar", diff } };
}

async function handleRankingCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando ranking", { userId: user.id });

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const meses = ["janeiro","fevereiro","março","abril","maio","junho",
                 "julho","agosto","setembro","outubro","novembro","dezembro"];

  const metrics = await fetchPeriodMetrics(user.id, inicioMes, fimMes);

  if (metrics.gastos_por_categoria.length === 0) {
    await whatsapp.sendText({ to: telefone, text: "Nenhum gasto registrado este mês." });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "ranking", count: 0 } };
  }

  const linhas = [`📊 Ranking de gastos de ${meses[now.getMonth()]}/${now.getFullYear()}`, ""];

  metrics.gastos_por_categoria.forEach((cat, i) => {
    const emoji = CATEGORIA_EMOJI[cat.categoria] ?? "•";
    linhas.push(`${i + 1}. ${emoji} ${cat.categoria} — ${fmtValor(cat.total)}`);
  });

  const top       = metrics.gastos_por_categoria[0];
  const percentTop = metrics.total_saidas > 0
    ? Math.round((top.total / metrics.total_saidas) * 100)
    : 0;

  linhas.push("", "Maior impacto:");
  linhas.push(`${top.categoria} representa ${percentTop}% dos gastos.`);

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("ranking enviado", { to: telefone, categorias: metrics.gastos_por_categoria.length });
  } catch (err) {
    log.error("falha ao enviar ranking", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "ranking", categorias: metrics.gastos_por_categoria.length },
  };
}

async function handleGuardarCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("comando guardar", { userId: user.id, texto });

  const match = texto.match(/^guardar\s+([\d,.]+)\s+(.+)$/i);
  if (!match) {
    await whatsapp.sendText({ to: telefone, text: "💡 Ex:\nguardar 200 viagem" });
    return { success: false, userId: user.id, erro: "Formato inválido" };
  }

  const valor = parseFloat(match[1].replace(",", "."));
  const nome  = match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase();

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

async function handleMetaCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("comando meta", { userId: user.id, texto });

  const match = texto.match(/^meta\s+(.+?)\s+([\d,.]+)$/i);
  if (!match) {
    await whatsapp.sendText({ to: telefone, text: "💡 Ex:\nmeta viagem 5000" });
    return { success: false, userId: user.id, erro: "Formato inválido" };
  }

  const nome      = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  const valorMeta = parseFloat(match[2].replace(",", "."));

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

async function handleMetasCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
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

async function handleAjudaCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando ajuda", { userId: user.id });

  const nRow = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`,
    [user.id]
  );
  const n = Number(nRow.rows[0].count);

  let linhas: string[];

  if (n < 5) {
    linhas = [
      "É bem simples! Basta enviar o valor e o que foi:",
      "",
      "50 mercado",
      "35 gasolina",
      "120 farmácia",
      "+3000 salário",
      "",
      "Para consultar:",
      "saldo — como está o mês",
      "resumo — gastos por categoria",
      "hoje — o que gastei hoje",
    ];
  } else if (n < 15) {
    linhas = [
      "Para registrar: 50 mercado  •  +3000 salário",
      "",
      "Consultas:",
      "saldo  •  resumo  •  hoje  •  semana",
      "ranking  •  previsão",
      "",
      "Extras:",
      "meta viagem 5000",
      "limite alimentação 800",
    ];
  } else {
    linhas = [
      "Para registrar: 50 mercado  •  +3000 salário",
      "",
      "Consultas:",
      "saldo  •  resumo  •  hoje  •  semana",
      "ranking  •  previsão  •  categorias",
      "recorrentes  •  próximas  •  buscar <termo>",
      "apagar  •  corrigir",
      "",
      "Extras:",
      "meta viagem 5000  •  guardar 200 viagem",
      "limite alimentação 800  •  recorrente 39 netflix mensal",
    ];
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("ajuda enviado", { to: telefone, n });
  } catch (err) {
    log.error("falha ao enviar ajuda", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "ajuda" },
  };
}

async function handleCategoriasCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando categorias", { userId: user.id });

  const linhas = [
    "Categorias disponíveis",
    "",
    ...CATEGORIAS_CONHECIDAS.map(c => `${CATEGORIA_EMOJI[c] ?? "•"} ${c}`),
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("categorias enviado", { to: telefone });
  } catch (err) {
    log.error("falha ao enviar categorias", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "categorias" },
  };
}

async function handleHojeCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando hoje", { userId: user.id });

  const now      = new Date();
  const inicioDia = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const fimDia    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

  const result = await pool.query<{ descricao: string; valor: string }>(
    `SELECT descricao, valor
     FROM transactions
     WHERE user_id = $1
       AND tipo = 'saida'
       AND criado_em >= $2
       AND criado_em < $3
     ORDER BY criado_em DESC
     LIMIT 10`,
    [user.id, inicioDia, fimDia]
  );

  const linhas = ["Gastos de hoje", ""];

  if (result.rows.length === 0) {
    linhas.push("Nenhum gasto registrado hoje.");
  } else {
    let total = 0;
    for (const row of result.rows) {
      const valor = Number(row.valor);
      total += valor;
      linhas.push(`${row.descricao ?? "Sem descrição"} — R$ ${valor.toFixed(2)}`);
    }
    linhas.push("");
    linhas.push(`Total hoje: R$ ${total.toFixed(2)}`);
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("hoje enviado", { to: telefone, count: result.rows.length });
  } catch (err) {
    log.error("falha ao enviar hoje", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "hoje", count: result.rows.length },
  };
}

const ONBOARDING_TIPS: Record<number, string> = {
  1:  `Perfeito. Vou organizando tudo por aqui pra você 👌`,
  10: `Para depositar na meta, manda: guardar 200 viagem 🎯`,
  11: `Com isso definido, "previsão" mostra como o mês vai fechar.`,
  12: `Para ver todas as contas fixas, manda "próximas".`,
};

async function checkAndSendOnboardingTip(userId: number, telefone: string, evento: string): Promise<boolean> {
  // mes_referencia fixo como sentinel de lifetime (não se repete mensalmente)
  const LIFETIME = new Date("2000-01-01");

  let tipId: number | null = null;

  if (evento === "saida") {
    const countRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`,
      [userId]
    );
    const n = Number(countRow.rows[0].count);
    if (n === 1) {
      tipId = 1;
    } else if (n >= 7) {
      // Aha moment: só dispara com contexto real (3+ categorias distintas)
      const catRow = await pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT categoria) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`,
        [userId]
      );
      if (Number(catRow.rows[0].count) < 3) return false; // contexto fraco → silêncio

      const now       = new Date();
      const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const metrics   = await fetchPeriodMetrics(userId, inicioMes, fimMes);

      if (!metrics.total_saidas || !metrics.gastos_por_categoria[0]) return false;

      const inserted = await pool.query(
        `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
         VALUES ($1, 'aha_moment', 4, $2)
         ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
        [userId, LIFETIME]
      );
      if ((inserted.rowCount ?? 0) === 0) return false;

      const top   = metrics.gastos_por_categoria[0];
      const texto = [
        `Você já registrou ${fmtValor(metrics.total_saidas)} esse mês.`,
        `${capitalizeFirst(top.categoria)} apareceu bastante até agora.`,
      ].join("\n");
      await whatsapp.sendText({ to: telefone, text: texto });
      log.whatsapp("aha moment enviado", { to: telefone, userId, totalSaidas: metrics.total_saidas });
      return true;
    }
  } else if (evento === "recorrente_criado") {
    tipId = 12;                    // criou recorrente → próximas
  } else if (evento === "meta_criada") {
    tipId = 10;
  } else if (evento === "limite_criado") {
    tipId = 11;
  }

  if (tipId === null) return false;

  const tipText = ONBOARDING_TIPS[tipId];
  if (!tipText) return false;

  const inserted = await pool.query(
    `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
     VALUES ($1, 'onboarding', $2, $3)
     ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
    [userId, tipId, LIFETIME]
  );

  if ((inserted.rowCount ?? 0) === 0) return false;

  await whatsapp.sendText({ to: telefone, text: tipText });
  log.whatsapp("onboarding tip enviado", { to: telefone, tipId });
  return true;
}

async function checkAndSendInsights(userId: number, telefone: string, categoria: string): Promise<boolean> {
  const countRow = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`,
    [userId]
  );
  const insightThreshold = 10;
  if (Number(countRow.rows[0].count) < insightThreshold) return false;

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const metrics = await fetchPeriodMetrics(userId, inicioMes, fimMes);
  if (metrics.total_saidas === 0) return false;

  const catRow = metrics.gastos_por_categoria.find(
    c => c.categoria.toLowerCase() === categoria.toLowerCase()
  );
  if (!catRow) return false;

  const percentual = Math.round((catRow.total / metrics.total_saidas) * 100);
  if (percentual < 50) return false;

  const marco  = 50;
  const mesRef = inicioMes;

  const inserted = await pool.query(
    `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
    [userId, categoria, marco, mesRef]
  );

  if ((inserted.rowCount ?? 0) === 0) return false;

  await whatsapp.sendText({
    to:   telefone,
    text: `📊 ${categoria} representa ${percentual}% dos seus gastos do mês.`,
  });

  log.whatsapp("insight enviado", { to: telefone, categoria, percentual, marco });
  return true;
}

async function handlePrevisaoCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando previsao", { userId: user.id });

  const now   = new Date();
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const dia   = now.getUTCDate();

  const inicioMes  = new Date(Date.UTC(year, month, 1));
  const fimMes     = new Date(Date.UTC(year, month + 1, 1));
  const diasNoMes  = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const diasRestantes = diasNoMes - dia;

  const metrics    = await fetchPeriodMetrics(user.id, inicioMes, fimMes);
  const totalGasto = metrics.total_saidas;

  const meses = ["janeiro","fevereiro","março","abril","maio","junho",
                 "julho","agosto","setembro","outubro","novembro","dezembro"];

  if (totalGasto === 0) {
    await whatsapp.sendText({
      to:   telefone,
      text: `📈 Previsão de ${meses[month]}\n\nNenhum gasto registrado ainda.`,
    });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "previsao" } };
  }

  const mediaDiaria  = totalGasto / dia;
  const gastosPrevisto = Math.round(totalGasto + mediaDiaria * diasRestantes);

  const rendaFixa  = Number(user.renda      ?? 0);
  const rendaExtra = Number(user.renda_extra ?? 0);
  const totalRenda = rendaFixa + rendaExtra + metrics.total_entradas;

  const linhas = [
    `📈 Previsão de ${meses[month]}`,
    "",
    `Gastos: ${fmtValor(Math.round(totalGasto))}`,
    `Previsto: ${fmtValor(gastosPrevisto)}`,
  ];

  if (totalRenda > 0) {
    const saldo = totalRenda - gastosPrevisto;
    linhas.push("");
    linhas.push(
      saldo >= 0
        ? `💰 Devem sobrar ${fmtValor(saldo)}`
        : `💸 Podem faltar ${fmtValor(Math.abs(saldo))}`
    );
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("previsao enviada", { to: telefone, gastosPrevisto, totalRenda });
  } catch (err) {
    log.error("falha ao enviar previsao", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "previsao", gastosPrevisto, totalRenda },
  };
}

async function handleRecorrenteCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
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

  await pool.query(
    `INSERT INTO recurring_expenses (user_id, nome, valor, frequencia)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, nome)
     DO UPDATE SET valor = $3, frequencia = $4, ativo = TRUE`,
    [user.id, nome, valor, frequencia]
  );

  await whatsapp.sendText({
    to:   telefone,
    text: `🔁 Gasto recorrente criado\n\n${nome} — ${fmtValor(valor)}\n${freqLabel}`,
  });

  log.whatsapp("recorrente criado", { to: telefone, nome, valor, frequencia });

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

async function handleBuscarCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  const termo = texto.replace(/^buscar\s+/i, "").trim();
  log.webhook("comando buscar", { userId: user.id, termo });

  const result = await pool.query<{ descricao: string; valor: string; categoria: string; criado_em: Date }>(
    `SELECT descricao, valor, categoria, criado_em
     FROM transactions
     WHERE user_id = $1
       AND tipo = 'saida'
       AND descricao ILIKE $2
     ORDER BY criado_em DESC
     LIMIT 10`,
    [user.id, `%${termo}%`]
  );

  if (result.rows.length === 0) {
    await whatsapp.sendText({
      to:   telefone,
      text: `🔎 Nenhum gasto encontrado para:\n${termo}`,
    });
    return {
      success:      true,
      userId:       user.id,
      transacao:    {},
      interpretado: { comando: "buscar", termo, count: 0 },
    };
  }

  const linhas = [`🔎 Resultados para "${termo}"`, ""];

  for (const row of result.rows) {
    const data = new Date(row.criado_em);
    const dia  = String(data.getUTCDate()).padStart(2, "0");
    const mes  = String(data.getUTCMonth() + 1).padStart(2, "0");
    linhas.push(`• ${fmtValor(Number(row.valor))} — ${row.categoria}`);
    linhas.push(`${dia}/${mes}`);
    linhas.push("");
  }

  // remove última linha em branco
  if (linhas[linhas.length - 1] === "") linhas.pop();

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("buscar enviado", { to: telefone, termo, count: result.rows.length });
  } catch (err) {
    log.error("falha ao enviar buscar", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "buscar", termo, count: result.rows.length },
  };
}

async function handleProximasCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
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

async function handleRecorrentesCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
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

  const linhas = ["🔁 Seus recorrentes", ""];
  let totalMensal = 0;

  for (const row of result.rows) {
    const valor = Number(row.valor);
    totalMensal += valor;
    linhas.push(`${row.nome} — ${fmtValor(valor)}`);
  }

  linhas.push("", `Total: ${fmtValor(totalMensal)}/mês`);

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

const MESES_PT: Record<string, number> = {
  janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};
const MESES_NOME = ["", "janeiro", "fevereiro", "março", "abril", "maio", "junho",
                    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function parseMesExtrato(raw: string): { ano: number; mes: number } | null {
  const agora = new Date();
  const texto = raw.toLowerCase().trim();

  // "março/2026" | "3/2026" | "03/26"
  const mAno = texto.match(/^(.+?)\/(\d{2,4})$/);
  if (mAno) {
    let ano = parseInt(mAno[2]);
    if (ano < 100) ano += 2000;
    const nome = mAno[1].trim();
    const mes  = MESES_PT[nome] ?? (parseInt(nome) || null);
    if (mes && mes >= 1 && mes <= 12) return { ano, mes };
  }

  // só nome ou número
  const mes = MESES_PT[texto] ?? (parseInt(texto) || null);
  if (mes && mes >= 1 && mes <= 12) return { ano: agora.getFullYear(), mes };
  return null;
}

async function handleExtratoCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("comando extrato", { userId: user.id, texto });

  const match = texto.match(/^extrato\s+(.+)$/i);
  const parsed = match ? parseMesExtrato(match[1]) : null;

  if (!parsed) {
    await whatsapp.sendText({
      to:   telefone,
      text: "💡 Ex:\nextrato março\nextrato 3\nextrato março/2026",
    });
    return { success: false, userId: user.id, erro: "Mês inválido" };
  }

  const { ano, mes } = parsed;
  const inicio = new Date(Date.UTC(ano, mes - 1, 1));
  const fim    = new Date(Date.UTC(ano, mes, 1));
  const metrics = await fetchPeriodMetrics(user.id, inicio, fim);

  const nomeMes = MESES_NOME[mes];
  const linhas = [`📋 Extrato de ${nomeMes}/${ano}`, ""];

  if (metrics.quantidade_transacoes === 0) {
    linhas.push("Nenhum lançamento neste mês.");
  } else {
    if (metrics.total_entradas > 0) linhas.push(`💰 Entradas: ${fmtValor(metrics.total_entradas)}`);
    linhas.push(`💸 Gastos: ${fmtValor(metrics.total_saidas)}`);
    const sinal = metrics.saldo >= 0 ? "+" : "-";
    linhas.push(`💼 Saldo: ${sinal}${fmtValor(Math.abs(metrics.saldo))}`, "");

    if (metrics.gastos_por_categoria.length > 0) {
      linhas.push("Por categoria:");
      for (const cat of metrics.gastos_por_categoria) {
        const emoji = CATEGORIA_EMOJI[cat.categoria] ?? "•";
        linhas.push(`${emoji} ${cat.categoria} — ${fmtValor(cat.total)}`);
      }
      linhas.push("");
    }

    linhas.push(`${metrics.quantidade_transacoes} transações`);
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("extrato enviado", { to: telefone, ano, mes, transacoes: metrics.quantidade_transacoes });
  } catch (err) {
    log.error("falha ao enviar extrato", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "extrato", ano, mes, transacoes: metrics.quantidade_transacoes },
  };
}

function isSubscriptionActive(user: UserRow): boolean {
  if (user.subscription_status === "active") {
    if (!user.subscription_expires_at) return true;
    return new Date(user.subscription_expires_at) > new Date();
  }
  if (user.subscription_status === "trial") {
    return !user.trial_ends_at || new Date(user.trial_ends_at) > new Date();
  }
  return false;
}


function isKnownCommand(texto: string): boolean {
  return /^(saldo|resumo|hoje|semana|ranking|comparar|desafio|previs[aã]o|categorias|ajuda|metas|recorrentes|pr[oó]ximas|apagar|corrigir|top\s*gastos)$/i.test(texto)
      || /^(limite|meta|guardar|recorrente|buscar|extrato)\s+/i.test(texto);
}

// Mostra dados reais quando o usuário expressa preocupação com gastos
async function handleSpendingConcern(user: UserRow, telefone: string): Promise<ProcessResult> {
  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const metrics   = await fetchPeriodMetrics(user.id, inicioMes, fimMes);

  if (metrics.total_saidas === 0) {
    await whatsapp.sendText({
      to:   telefone,
      text: "Ainda não tem gastos registrados este mês.",
    });
    return { success: false, userId: user.id, erro: "spending_concern sem dados" };
  }

  const top = metrics.gastos_por_categoria[0];
  const acks = ["Olha como tá o mês:", "Aqui tá o que foi registrado:", "Veja o que tá até agora:"];
  const linhas = [
    acks[new Date().getHours() % acks.length],
    "",
    `${fmtValor(metrics.total_saidas)} gastos esse mês.`,
    `Mais em: ${capitalizeFirst(top?.categoria ?? "—")} — ${fmtValor(top?.total ?? 0)}`,
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("spending_concern respondido", { to: telefone, userId: user.id });
  } catch (err) {
    log.error("falha spending_concern", err, { userId: user.id });
  }
  return { success: false, userId: user.id, erro: "spending_concern tratado" };
}

// Responde "e agora?" com dado real ou orientação mínima
async function handleNextStepSuggestion(user: UserRow, telefone: string): Promise<ProcessResult> {
  const countRow = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`,
    [user.id]
  );
  const count = Number(countRow.rows[0].count);

  let text: string;
  if (count === 0) {
    text = "Começa mandando um gasto:\n35 uber, 50 mercado 📝";
  } else if (count <= 3) {
    text = 'Continue registrando. Quando quiser ver o mês, manda "saldo".';
  } else {
    const now       = new Date();
    const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const metrics   = await fetchPeriodMetrics(user.id, inicioMes, fimMes);
    if (metrics.total_saidas > 0 && metrics.gastos_por_categoria.length > 0) {
      const top = metrics.gastos_por_categoria[0];
      text = `${fmtValor(metrics.total_saidas)} gastos esse mês. Maior: ${top.categoria}.`;
    } else {
      text = '"saldo" mostra como o mês tá ficando.';
    }
  }

  try {
    await whatsapp.sendText({ to: telefone, text });
    log.whatsapp("next_step_suggestion enviado", { to: telefone, userId: user.id, count });
  } catch (err) {
    log.error("falha next_step_suggestion", err, { userId: user.id });
  }
  return { success: false, userId: user.id, erro: "next_step tratado" };
}

// Interpreta intenção conversacional antes de cair no parser ou no hint genérico
async function tryHandleIntent(user: UserRow, telefone: string, texto: string): Promise<ProcessResult | null> {
  const t         = texto.trim().toLowerCase();
  const temNumero = /\d/.test(t);

  // "?" / "??" / ponto de interrogação solto → guia próximo passo
  if (/^[?\s!.]+$/.test(t)) {
    return await handleNextStepSuggestion(user, telefone);
  }

  // "o que é isso?" → explica o bot
  if (!temNumero && /^(que\s+[eéè]\s+isso|o\s+que\s+[eéè]\s+isso)[\?!.]*$/.test(t)) {
    return await handleAjudaCommand(user, telefone);
  }

  // Confusão leve → resposta curta, sem menu
  if (
    !temNumero &&
    /n[aã]o\s+(estou?|t[oô]|to)\s+entendendo|n[aã]o\s+entendi|entendi\s+foi\s+nada|n[aã]o\s+(sei|entendo)\s+(nada|nada\s+disso)|como\s+assim|n[aã]o\s+peguei/.test(t)
  ) {
    const respostas = [
      "Não peguei muito bem 😅 Me manda um gasto ou diz o que quer ver.",
      "Hmm, não entendi. Manda um gasto ou me faz uma pergunta.",
      "Não captei. Manda um gasto — 35 uber, ou diz o que precisa.",
    ];
    try {
      await whatsapp.sendText({ to: telefone, text: respostas[new Date().getHours() % respostas.length] });
    } catch (err) {
      log.error("falha light_confusion", err, { userId: user.id });
    }
    return { success: false, userId: user.id, erro: "light_confusion tratada" };
  }

  // Intenção de ajuda
  if (
    !temNumero &&
    /^(preciso\s+de\s+(ajuda|help|suporte)|me\s+(ajuda|ajude|ensina|ensine)|como\s+(funciona|uso|usar|fa[çc]o)|o\s+que\s+(posso|d[aá]|consigo)\s+(fazer|ver|usar)|n[aã]o\s+sei(\s+o\s+que\s+fazer)?(\s+por\s+onde\s+come[çc]ar)?|o\s+que\s+tem\s+(aqui|nesse\s+bot)|quero\s+(aprender|entender|saber\s+mais))[\?!.]*$/.test(t)
  ) {
    return await handleAjudaCommand(user, telefone);
  }

  // Preocupação com gastos → mostra dado real do mês
  if (
    !temNumero &&
    /acho\s+que\s+gastei\s+(muito|demais)|(estou?|t[oô])\s+gastando\s+(muito|demais)|(estou?\s+|t[oô]\s+|to\s+)?no\s+vermelho|gastei\s+(demais|muito)/.test(t)
  ) {
    return await handleSpendingConcern(user, telefone);
  }

  // Incerteza / "e agora?"
  if (
    !temNumero &&
    /^(e\s+agora|e\s+a[ií]|o\s+que\s+fa[çc]o(\s+agora)?|o\s+que\s+(fazer|devo\s+fazer)|o\s+que\s+(você|voce|vc)\s+(sugere|recomenda))[\?!.]*$/.test(t)
  ) {
    return await handleNextStepSuggestion(user, telefone);
  }

  // Intenção de melhora financeira → mostra contexto real do mês
  if (
    !temNumero &&
    /preciso\s+(economizar|cortar|reduzir|gastar\s+menos)|quero\s+(economizar|cortar|gastar\s+menos|melhorar(\s+meus\s+gastos|\s+minhas\s+finan[çc]as)?)|como\s+(melhoro|corto|reduzo|controlo\s+melhor|gastar\s+menos)/.test(t)
  ) {
    return await handleSpendingConcern(user, telefone);
  }

  // Pressão financeira / desabafo → dados sem julgamento
  if (
    !temNumero &&
    /t[oô]\s+(no\s+limite|apertad[ao]|tenso|zerado|pelado)|(m[eê]s|semana)\s+(dif[ií]cil|pesad[ao]|complicad[ao])|pouco\s+dinheiro|sem\s+dinheiro|t[oô]\s+endividad[ao]/.test(t)
  ) {
    return await handleSpendingConcern(user, telefone);
  }

  // Exagero emocional / perda de controle → dados sem julgamento
  if (
    !temNumero &&
    /acho\s+que\s+(exagerei|exager[ao]|foi\s+demais)|perdi\s+(o\s+)?controle|(saiu|t[aá])\s+(fora|do)\s+controle|t[oô]\s+preocupado\s+(com\s+os?\s+gastos?|com\s+dinheiro)/.test(t)
  ) {
    return await handleSpendingConcern(user, telefone);
  }

  // Continuidade: quer continuar, ver mais ou registrar outro
  if (
    !temNumero &&
    /mais\s+alguma\s+coisa|tem\s+mais|algo\s+mais|quero\s+(registrar|ver|fazer)\s+(outro|mais|algo)|o\s+que\s+(mais\s+)?(posso|d[aá])\s+(ver|consultar|fazer)/.test(t)
  ) {
    return await handleNextStepSuggestion(user, telefone);
  }

  // Dia positivo / gastou pouco → ack leve, sem exagero
  if (
    !temNumero &&
    /hoje\s+(foi\s+)?(bom|tranquilo|leve|econ[oô]mico)|gastei\s+(pouco|bem\s+pouco|quase\s+nada)|economizei\s+(hoje|bastante)/.test(t)
  ) {
    const acks = ["Bom sinal.", "Isso. Vai acumulando.", "Dias assim fazem diferença."];
    const pick  = acks[new Date().getHours() % acks.length];
    try {
      await whatsapp.sendText({ to: telefone, text: pick });
      log.whatsapp("positive_ack enviado", { to: telefone, userId: user.id });
    } catch (err) {
      log.error("falha positive_ack", err, { userId: user.id });
    }
    return { success: false, userId: user.id, erro: "positive_ack tratado" };
  }

  // Recusa / agradecimento → encerra naturalmente sem insistir
  if (
    !temNumero &&
    /^(n[aã]o\s+quero(\s+ver\s+\S+)?|n[aã]o\s+agora|depois|por\s+enquanto\s+n[aã]o|obrigad[ao]|brigad[ao]|valeu|tudo\s+bem|td\s+bem|blz)[\?!.]*$/.test(t)
  ) {
    const acks = ["Tudo bem.", "Ok. 👋", "Tranquilo."];
    const pick  = acks[new Date().getHours() % acks.length];
    try {
      await whatsapp.sendText({ to: telefone, text: pick });
      log.whatsapp("ack conversacional enviado", { to: telefone, userId: user.id });
    } catch (err) {
      log.error("falha ack conversacional", err, { userId: user.id });
    }
    return { success: false, userId: user.id, erro: "ack reconhecido" };
  }

  // Consulta de saldo via linguagem natural
  if (
    !temNumero &&
    /quanto\s+(tenho|sobrou|resta|restou|tenho\s+de\s+saldo)|quanto\s+gastei\s+(esse|este|no)\s+m[eê]s|o\s+que\s+sobrou|quanto\s+est[aá]\s+sobrando/.test(t)
  ) {
    return await handleSaldoCommand(user, telefone);
  }

  // Consulta de gastos via linguagem natural
  if (
    !temNumero &&
    /(me\s+mostra|ver|quero\s+ver|mostrar)\s+(meus?\s+gastos?|o\s+resumo)|meus?\s+gastos?\s+(do\s+m[eê]s|de\s+hoje|essa\s+semana)/.test(t)
  ) {
    return await handleResumoCommand(user, telefone);
  }

  // Intenção de apagar via linguagem natural
  if (
    !temNumero &&
    /quero\s+apagar|apagar\s+o\s+[uú]ltimo|remover\s+(o\s+)?[uú]ltimo|deletar\s+(o\s+)?[uú]ltimo/.test(t)
  ) {
    return await handleApagarCommand(user, telefone);
  }

  // Erro no registro → orienta corrigir
  if (
    !temNumero &&
    /registrei\s+errado|coloquei\s+errado|lancei\s+errado|esqueci\s+de\s+registrar|n[aã]o\s+registrei/.test(t)
  ) {
    try {
      await whatsapp.sendText({ to: telefone, text: "Para corrigir um valor, manda: corrigir\nPara apagar um lançamento: apagar" });
      log.whatsapp("orientacao corrigir enviada", { to: telefone, userId: user.id });
    } catch (err) {
      log.error("falha orientacao corrigir", err, { userId: user.id });
    }
    return { success: false, userId: user.id, erro: "orientacao corrigir" };
  }

  // Ack positivo de economia
  if (
    !temNumero &&
    /t[oô]\s+economizando|estou?\s+economizando|consegui\s+economizar|economizei\s+(bem|bastante|muito)/.test(t)
  ) {
    const acks = ["Bom. Vai acumulando.", "Cada real conta.", "Vai acumulando."];
    const pick  = acks[new Date().getHours() % acks.length];
    try {
      await whatsapp.sendText({ to: telefone, text: pick });
      log.whatsapp("positive_eco_ack enviado", { to: telefone, userId: user.id });
    } catch (err) {
      log.error("falha positive_eco_ack", err, { userId: user.id });
    }
    return { success: false, userId: user.id, erro: "positive_eco_ack" };
  }

  return null;
}

// Detecta frases conversacionais/de intenção que NÃO devem virar lançamento automático
const AMBIGUOUS_INTENT_RE = /\bacho\b|\btalvez\b|\bquero\b|\blembr[ae]\b|\blembrar\b|\beconomiz|\bguardar\b|\bjuntar\b|\bplanejo\b|\bpreciso\b|\bobjetivo\b|\bpara\s+(minha|meu)\s/i;

function isAmbiguousIntent(texto: string): boolean {
  return AMBIGUOUS_INTENT_RE.test(texto.trim());
}

function buildContextualHint(texto: string): string {
  const t = texto.toLowerCase();
  if (/quanto|sobrou|restou|dispon[ií]vel|\bsaldo\b/.test(t))         return '"saldo" mostra como o mês tá ficando. 💰';
  if (/onde\s+gasto|mais\s+caro|\branking\b/.test(t))                  return '"ranking" mostra onde vai mais. 📊';
  if (/meus?\s+gastos?|\bresumo\b/.test(t))                            return '"resumo" mostra por categoria.';
  if (/\bcontas?\b|recorrente|vencimento|pr[oó]ximas?/.test(t))        return '"próximas" lista as contas fixas.';
  if (/guardar|juntar|economiz|\bmeta\b|objetivo|poupan/.test(t))      return 'Para criar uma meta:\nguardar 200 viagem 🎯';
  if (/sal[aá]rio|renda|freelance|recebi|ganho|ganhei|entrou/.test(t)) return 'Para registrar renda:\n+3000 salário';
  if (/dinheiro|gast|paguei|comprei|gastei/.test(t))                   return 'Me manda o valor e o que foi:\n50 mercado';
  const fallbacks = [
    "Não peguei bem. Manda um gasto ou um comando.",
    "Não entendi 😅 Me manda: 50 mercado",
    "Não reconheci. Me manda um gasto: 50 mercado",
  ];
  return fallbacks[new Date().getHours() % fallbacks.length];
}

async function handleApagarCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
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

async function handleApagarSelecao(user: UserRow, telefone: string, txId: number): Promise<ProcessResult> {
  log.webhook("apagar selecao", { userId: user.id, txId });

  await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);

  const txResult = await pool.query<{ tipo: string; valor: string; categoria: string; descricao: string }>(
    `DELETE FROM transactions WHERE id = $1 AND user_id = $2 RETURNING tipo, valor, categoria, descricao`,
    [txId, user.id]
  );

  if (txResult.rows.length === 0) {
    await whatsapp.sendText({ to: telefone, text: "Lançamento não encontrado." });
    return { success: false, userId: user.id, erro: "Transação não encontrada" };
  }

  const tx = txResult.rows[0];
  const linhas = [
    "✅ Lançamento removido:",
    "",
    `${tx.descricao ?? tx.categoria} — ${fmtValor(Number(tx.valor))}`,
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("apagar confirmado", { to: telefone, txId });
  } catch (err) {
    log.error("falha ao enviar apagar confirmacao", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "apagar", txId, valor: Number(tx.valor), categoria: tx.categoria },
  };
}

async function handleCorrigirCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
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

async function handleCorrigirSelecao(user: UserRow, telefone: string, txId: number): Promise<ProcessResult> {
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
     SET step = 'waiting_new_value', selected_tx_id = $2, expires_at = NOW() + INTERVAL '10 minutes'
     WHERE user_id = $1`,
    [user.id, txId]
  );

  const linhas = [
    "Envie o novo valor e descrição.",
    `Ex: ${fmtValor(Number(tx.valor))} ${tx.descricao ?? tx.categoria}`,
    "",
    `Ou "cancelar" para desistir.`,
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("corrigir step2 enviado", { to: telefone, txId });
  } catch (err) {
    log.error("falha ao enviar corrigir step2", err, { to: telefone });
  }

  return { success: false, userId: user.id, erro: "Aguardando novo valor" };
}

async function handleCorrigirNovoValor(user: UserRow, telefone: string, texto: string, txId: number): Promise<ProcessResult> {
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

async function handleNovoMesRenda(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("novo_mes renda recebida", { userId: user.id, texto });

  const valor = parseFloat(
    texto.replace(/R\$\s*/i, "").replace(/\./g, "").replace(",", ".").trim()
  );

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

async function handleNovoMesCarryover(
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

async function handleTopGastosCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando top gastos", { userId: user.id });

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const result = await pool.query<{ descricao: string; valor: string }>(
    `SELECT descricao, valor
     FROM transactions
     WHERE user_id = $1
       AND tipo = 'saida'
       AND criado_em >= $2
       AND criado_em < $3
     ORDER BY valor DESC
     LIMIT 5`,
    [user.id, inicioMes, fimMes]
  );

  const meses = ["janeiro","fevereiro","março","abril","maio","junho",
                 "julho","agosto","setembro","outubro","novembro","dezembro"];

  const linhas = [`Maiores gastos de ${meses[now.getMonth()]}/${now.getFullYear()}`, ""];

  if (result.rows.length === 0) {
    linhas.push("Nenhum gasto registrado este mês.");
  } else {
    let somaTop = 0;
    result.rows.forEach((row, i) => {
      const valor = Number(row.valor);
      somaTop += valor;
      const desc = row.descricao ?? "Sem descrição";
      linhas.push(`${i + 1}. ${desc} — R$ ${valor.toFixed(2)}`);
    });
    linhas.push("");
    linhas.push(`Total dos ${result.rows.length} maiores: R$ ${somaTop.toFixed(2)}`);
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("top gastos enviado", { to: telefone, count: result.rows.length });
  } catch (err) {
    log.error("falha ao enviar top gastos", err, { to: telefone });
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "top gastos", count: result.rows.length },
  };
}
