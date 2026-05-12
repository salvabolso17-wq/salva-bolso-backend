import pool from "../db/client";
import { parseTransaction, parseValor } from "../utils/parseTransaction";
import { fetchPeriodMetrics } from "./reportService";
import { whatsapp } from "./whatsapp";
import { log } from "../utils/logger";
import { buildPlansBlock } from "../utils/plansMessage";
import type { NormalizedMessage } from "../adapters/whatsappAdapters";
import { initSession, getSession, classifyIntent, recordAction, getContextualNextStep, canSendInsight, recordInsightSent, setLastCommand, setLastInstallment, getLastInstallment, setLastGoal, getLastGoal, setLastContext, getLastContext } from "./conversationEngine";

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
  criado_em: Date | null;
}

type ProcessResult =
  | { success: true;  userId: number; transacao: Record<string, unknown>; interpretado: Record<string, unknown> }
  | { success: false; userId?: number; erro: string };

async function findUserByTelefone(telefone: string): Promise<UserRow | null> {
  const normalized = telefone.replace(/[^0-9]/g, "");

  log.user("buscando", { telefone: normalized });

  const result = await pool.query<UserRow>(
    `SELECT id, telefone, nome, renda, renda_extra, subscription_status, trial_ends_at, subscription_expires_at, criado_em FROM users
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
    const ehPergunta     = isCuriosityPhrase(textoNew);

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
      // Guided: welcome sempre igual + convite ou menu dependendo da intenção
      const nome      = firstNameOf(message.pushName);
      const saudacao  = nome ? `Oi, ${nome} 👋` : `Oi 👋`;
      const boas_vindas = [
        saudacao,
        "",
        "Bem-vindo ao Salva Bolso.",
        "",
        "Me manda um gasto pra começar:",
        "50 mercado  •  35 uber  •  120 farmácia",
        "",
        "Você tem 7 dias grátis 🙂",
      ].join("\n");

      try {
        await whatsapp.sendText({ to: message.telefone, text: boas_vindas });
        log.whatsapp("onboarding welcome enviado", { to: message.telefone });
      } catch (err) {
        log.error("falha ao enviar welcome", err, { to: message.telefone });
      }

      if (ehPergunta) {
        try {
          await whatsapp.sendText({ to: message.telefone, text: buildFeaturesMenuText() });
          log.whatsapp("onboarding menu enviado", { to: message.telefone });
        } catch (err) {
          log.error("falha ao enviar menu onboarding", err, { to: message.telefone });
        }
      } else {
        const convite = [
          "Quer que eu te mostre tudo que consigo acompanhar por aqui?",
          "",
          "Pode responder algo como:",
          `• "quero ver"`,
          `• "como funciona?"`,
          `• "me mostra"`,
        ].join("\n");
        try {
          await whatsapp.sendText({ to: message.telefone, text: convite });
          log.whatsapp("onboarding convite enviado", { to: message.telefone });
        } catch (err) {
          log.error("falha ao enviar convite onboarding", err, { to: message.telefone });
        }
      }

      return { success: false, userId: undefined, erro: "Onboarding iniciado" };
    }
  }

  // ── Controle de acesso (trial / active / expired) — modo limitado ────────
  const _ativo = isSubscriptionActive(user);
  log.webhook("controle de acesso", {
    userId:                user.id,
    status:                user.subscription_status,
    trial_ends_at:         user.trial_ends_at?.toISOString() ?? null,
    subscription_expires_at: user.subscription_expires_at?.toISOString() ?? null,
    ativo:                 _ativo,
  });

  if (!_ativo) {
    const textoTrim    = message.texto.trim();
    const comandoBloq  = isBlockedFreemium(textoTrim);
    
    // Leitura básica explícita é permitida. Tudo que altera o banco ou é premium é bloqueado.
    const apenasLeituraBasica = /^(saldo|resumo|hoje|semana|extrato|menu|ajuda)$/i.test(textoTrim) || /^(buscar|extrato)\s+/i.test(textoTrim);

    log.webhook("acesso negado — verificando tipo acesso restrito", { textoTrim, comandoBloq, apenasLeituraBasica });

    if (!apenasLeituraBasica) {
      const expirouEm = user.subscription_expires_at ?? user.trial_ends_at ?? new Date();
      
      let mostrouAvisoInicial = false;
      try {
        mostrouAvisoInicial = await checkAndSendExpirationNotice(user.id, message.telefone, expirouEm);
      } catch (err) {
        log.error("falha no expiracao notice strict", err, { userId: user.id });
      }

      // Se não mostrou o aviso completo agora, mostra as versões curtas
      if (!mostrouAvisoInicial) {
        let txtCurto = "Atenção: acesso limitado.";
        
        if (comandoBloq) {
           txtCurto = `🔒 Função exclusiva do Premium.\n\nhttps://salva-bolso-backend-salvabolso.h5prml.easypanel.host/premium-checkout.html`;
        } else {
           txtCurto = `🔒 Registro de novos gastos disponível no Premium.\n\nhttps://salva-bolso-backend-salvabolso.h5prml.easypanel.host/premium-checkout.html`;
        }
        
        try {
          await whatsapp.sendText({ to: message.telefone, text: txtCurto });
        } catch (err) {
          log.error("falha no envio do block aviso curto", err, { userId: user.id });
        }
      }
      return { success: false, userId: user.id, erro: "Acesso bloqueado pós-trial" };
    }
  }

  // ── Pending action check ──────────────────────────────────────────────────
  const pendingRow = await pool.query<{
    action: "apagar" | "corrigir" | "novo_mes" | "confirmar_recorrente" | "confirmar_recorrente_multi" | "registrar_parcela";
    step: "waiting_selection" | "waiting_selection_multi" | "waiting_new_value" | "waiting_renda" | "waiting_carryover" | "waiting_confirmation" | "waiting_parcela_valor";
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
    } else if (pending.action === "confirmar_recorrente_multi" && pending.step === "waiting_selection_multi") {
      const isNegative = /^(não|nao|n|no|agora\s*não|agora\s*nao|depois|nenhum|nenhuma|nada|por\s+enquanto|dispenso|obrigad[ao])[\?!.]*$/i.test(textoTrim);
      
      if (isNegative) {
        await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
        await whatsapp.sendText({ to: message.telefone, text: "Tudo bem 🙂" });
        return { success: false, userId: user.id, erro: "Recorrentes rejeitados" };
      } else if (isKnownCommand(textoTrim)) {
        await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
      } else {
        return await handleConfirmarRecorrenteMulti(user, message.telefone, textoTrim, pending.tx_ids);
      }
    } else if (pending.step === "waiting_new_value") {
      if (!isKnownCommand(textoTrim)) {
        return await handleCorrigirNovoValor(user, message.telefone, message.texto, pending.selected_tx_id!);
      }
      // Comando reconhecido → cancela pending e continua abaixo
      await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    } else if (pending.step === "waiting_renda") {
      // Skip explícito → cancela e segue
      const skipRenda = /^(n[aã]o\s+sei|n[aã]o\s+tenho|sem\s+renda|pula|pular|depois|n[aã]o\s+quero|prefiro\s+n[aã]o|ignore|ignora|skip)[\?!.]*$/i.test(textoTrim);
      if (skipRenda) {
        await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
        try {
          await whatsapp.sendText({ to: message.telefone, text: "Tudo bem 🙂\nSempre que quiser informar, manda: recebo 3000" });
        } catch (_) { /* silent */ }
        return { success: false, userId: user.id, erro: "renda ignorada pelo usuario" };
      }
      // Gasto explícito cancela o contexto de renda e processa normalmente
      const parsedAsExpense = parseTransaction(textoTrim);
      if (parsedAsExpense && parsedAsExpense.tipo === "saida") {
        await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
        // fall through para registro normal
      } else if (!isKnownCommand(textoTrim)) {
        return await handleNovoMesRenda(user, message.telefone, textoTrim);
      } else {
        await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
      }
    } else if (pending.step === "waiting_carryover") {
      if (textoTrim === "1" || textoTrim === "2") {
        return await handleNovoMesCarryover(user, message.telefone, textoTrim, pending.tx_ids);
      }
      if (!isKnownCommand(textoTrim)) {
        await whatsapp.sendText({ to: message.telefone, text: "Responda:\n1️⃣ Sim\n2️⃣ Não" });
        return { success: false, userId: user.id, erro: "Aguardando escolha carryover" };
      }
      await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    } else if (pending.action === "confirmar_recorrente" && pending.step === "waiting_confirmation") {
      const isAffirmative = /^(sim|s|yes|pode|quero|claro|ótimo|otimo|isso|exato|afirm|ok|beleza|bora|vai|certo|perfeito|tá|ta)[\?!.]*$/i.test(textoTrim);
      const isNegative    = /^(não|nao|n|no|agora\s*não|agora\s*nao|depois|por\s+enquanto|dispenso|obrigad[ao])[\?!.]*$/i.test(textoTrim);

      if (isAffirmative) {
        return await handleConfirmarRecorrente(user, message.telefone, pending.tx_ids);
      }
      if (isNegative || isKnownCommand(textoTrim)) {
        await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
        if (isNegative) {
          await whatsapp.sendText({ to: message.telefone, text: "Tudo bem 🙂" });
          return { success: false, userId: user.id, erro: "Recorrente rejeitado" };
        }
        // Comando reconhecido → cancela pending e continua abaixo
      } else {
        // Nem sim nem não nem comando → reitera a pergunta
        await whatsapp.sendText({
          to:   message.telefone,
          text: "Responde com sim ou não 🙂",
        });
        return { success: false, userId: user.id, erro: "Aguardando confirmação recorrente" };
      }
    } else if (pending.action === "registrar_parcela" && pending.step === "waiting_parcela_valor") {
      if (!isKnownCommand(textoTrim)) {
        return await handleRegistrarParcelaValor(
          user,
          message.telefone,
          textoTrim,
          pending.tx_ids as { item: string; totalParcelas: number; valorTotal: number },
        );
      }
      await pool.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    }
  }

  // ── Conversation Engine — Intent + Context gates ─────────────────────────
  {
    const _session = initSession(user.id);
    const _intent  = classifyIntent(message.texto.trim());
    const _isNew   = !!user.criado_em
      && Date.now() - new Date(user.criado_em).getTime() < 10 * 60 * 1000;

    // Silence new users in onboarding window for casual/unknown messages
    if (_isNew && _session.txCount === 0 && (_intent === "casual" || _intent === "unknown")) {
      log.webhook("conv engine: silencio onboarding", { userId: user.id, intent: _intent });
      return { success: false, userId: user.id, erro: "Conv engine: silencio onboarding" };
    }

    // Guide confused users — show menu or a lighter hint if menu was recent
    if (_intent === "confused") {
      const menuAge = _session.seenMenuAt
        ? Date.now() - _session.seenMenuAt.getTime()
        : Infinity;
      if (menuAge > 3 * 60 * 1000) {
        try {
          await whatsapp.sendText({ to: message.telefone, text: buildFeaturesMenuText() });
          recordAction(user.id, "showed_menu");
          log.whatsapp("conv engine: menu para usuario confuso", { to: message.telefone, userId: user.id });
        } catch (err) {
          log.error("falha ao enviar menu (confuso)", err, { userId: user.id });
        }
      } else {
        try {
          await whatsapp.sendText({
            to:   message.telefone,
            text: "Pode usar naturalmente 🙂\n\nEx:\n• 50 mercado\n• quanto sobrou?\n• resumo\n• ranking",
          });
          log.whatsapp("conv engine: hint leve para usuario confuso", { to: message.telefone, userId: user.id });
        } catch (err) {
          log.error("falha ao enviar hint (confuso)", err, { userId: user.id });
        }
      }
      return { success: false, userId: user.id, erro: "Conv engine: guiou confuso" };
    }

    // For explore intent with recent menu — show next-step suggestion instead of repeating menu
    if (_intent === "explore") {
      const menuAge = _session.seenMenuAt
        ? Date.now() - _session.seenMenuAt.getTime()
        : Infinity;
      if (menuAge < 3 * 60 * 1000) {
        return await handleNextStepSuggestion(user, message.telefone);
      }
      // Menu not recent → fall through to isCuriosityPhrase which will show the menu
    }
  }

  // ── Intenção de histórico/registros — redireciona para extrato ──────────
  if (
    !parseTransaction(message.texto.trim()) &&
    /tudo\s+que\s+(j[aá]\s+)?(anotei|registrei|lan[cç]ei)|ver\s+(meus?\s+)?(registros?|lan[cç]amentos?|hist[oó]rico|anotat?[uú]?)|meus?\s+(lan[cç]amentos?|registros?|hist[oó]rico de\s+gastos?)|hist[oó]rico\s+de\s+gastos?/i.test(message.texto.trim())
  ) {
    const mesAtual = MESES_NOME[new Date().getMonth() + 1];
    return await handleExtratoCommand(user, message.telefone, `extrato ${mesAtual}`);
  }

  // ── Curiosidade sobre funcionalidades (linguagem natural) ────────────────
  if (isCuriosityPhrase(message.texto.trim())) {
    try {
      await whatsapp.sendText({ to: message.telefone, text: buildFeaturesMenuText() });
      recordAction(user.id, "showed_menu");
      log.whatsapp("features menu enviado", { to: message.telefone, userId: user.id });
    } catch (err) {
      log.error("falha ao enviar features menu", err, { userId: user.id });
    }
    return { success: false, userId: user.id, erro: "Features menu enviado" };
  }

  // ── Onboarding: boas-vindas para usuário novo ────────────────────────────
  const ehSaudacaoOuAjuda = /^(oi+|op+a|ol[aá]|ola|e\s*a[ií]|tudo\s*(bem|bom|ok|certo)?|como\s+(tá|vai)|fala|fala\s+(aí|a[ií]|cmg|comigo)|começar|comecar|menu|ajuda|hi|hello|hey|bom\s*dia|boa\s*tarde|boa\s*noite|start)[\?!.]*$/i
    .test(message.texto.trim());

  if (ehSaudacaoOuAjuda) {
    const countRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`,
      [user.id]
    );
    const count = Number(countRow.rows[0].count);

    if (count === 0) {
      // Onboarding enviado há menos de 5 min → silêncio (evita spam de boas-vindas repetidas)
      const criadoHaPouco = user.criado_em
        && (Date.now() - new Date(user.criado_em).getTime()) < 5 * 60 * 1000;
      if (criadoHaPouco) {
        return { success: false, userId: user.id, erro: "Onboarding recente — silencio" };
      }
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
      "Oi 🙂 Pode mandar um gasto ou perguntar sobre o mês.",
      "Olá 👋 Me manda um gasto ou fala o que quer ver.",
      "Oi! Pode registrar um gasto ou pedir o resumo do mês.",
    ];
    await whatsapp.sendText({
      to:   message.telefone,
      text: saudacoes[new Date().getHours() % saudacoes.length],
    });
    return { success: false, userId: user.id, erro: "Saudacao de usuario ativo" };
  }

  // ── Comandos de consulta ──────────────────────────────────────────────────
  if (/^saldo$/i.test(message.texto.trim())) {
    setLastCommand(user.id, "saldo");
    return await handleSaldoCommand(user, message.telefone);
  }
  if (/^resumo$/i.test(message.texto.trim())) {
    setLastCommand(user.id, "resumo");
    return await handleResumoCommand(user, message.telefone);
  }
  if (/^top(\s*gastos)?$/i.test(message.texto.trim())) {
    setLastCommand(user.id, "top_gastos");
    return await handleTopGastosCommand(user, message.telefone);
  }
  if (/^parcelas?$|^parcelamentos?$/i.test(message.texto.trim())) {
    try {
      await whatsapp.sendText({
        to:   message.telefone,
        text: [
          "Pode registrar assim:",
          "",
          "iphone 12x de 755",
          "tv 6x 300",
          "notebook 24 parcelas de 450",
          "",
          "Eu organizo o resto 🙂",
        ].join("\n"),
      });
    } catch (err) {
      log.error("falha ao enviar info parcelas", err, { to: message.telefone });
    }
    return { success: false, userId: user.id, erro: "parcelas info" };
  }
  if (/^limite\s+.+\s+[\d,.]+$/i.test(message.texto.trim())) {
    return await handleLimiteCommand(user, message.telefone, message.texto.trim());
  }
  if (/^hoje$/i.test(message.texto.trim())) {
    setLastCommand(user.id, "hoje");
    return await handleHojeCommand(user, message.telefone);
  }
  if (/^semana$/i.test(message.texto.trim())) {
    setLastCommand(user.id, "semana");
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
    setLastCommand(user.id, "metas");
    return await handleMetasCommand(user, message.telefone);
  }
  if (/^guardar\s+[\d,.]+\s+.+$/i.test(message.texto.trim())) {
    return await handleGuardarCommand(user, message.telefone, message.texto.trim());
  }
  if (/^ranking$/i.test(message.texto.trim())) {
    setLastCommand(user.id, "ranking");
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
    setLastCommand(user.id, "recorrentes");
    return await handleRecorrentesCommand(user, message.telefone);
  }
  if (/^pr[oó]ximas$/i.test(message.texto.trim())) {
    setLastCommand(user.id, "proximas");
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

  // ── Progresso de parcela ─────────────────────────────────────────────────
  // Self-contained: "paguei N de M" / "já paguei N de M"
  // Context-aware : all natural phrasings, require lastInstallment in session or DB
  {
    const t = message.texto.trim();

    // Self-contained explicit form — no session needed
    const pmExplicit = t.match(/^(?:j[aá]\s+)?(?:paguei|quitei)\s+(\d+)\s+de\s+(\d+)[\?!.]*$/i);
    if (pmExplicit) {
      const pago   = parseInt(pmExplicit[1], 10);
      const total  = parseInt(pmExplicit[2], 10);
      const inst   = getLastInstallment(user.id) ?? await getInstallmentFromDb(user.id);
      const faltam = total - pago;

      let txt: string;
      if (inst && inst.totalParcelas === total) {
        txt = faltam > 0
          ? `Perfeito 🙂\nFaltam ${faltam} parcela${faltam > 1 ? "s" : ""} do ${inst.item}.`
          : `Ótimo 🙂\n${inst.item} — quitado!`;
        const newInst = { ...inst, parcelaAtual: pago + 1 };
        setLastInstallment(user.id, newInst);
        if (inst.dbId) {
          await pool.query(
            `UPDATE installments SET parcelas_pagas = $1 WHERE id = $2`,
            [pago, inst.dbId]
          ).catch(() => null);
        }
      } else {
        txt = faltam > 0
          ? `Certo 🙂\n${pago} de ${total} pagas.`
          : `Ótimo 🙂\nQuitado!`;
      }

      try {
        await whatsapp.sendText({ to: message.telefone, text: txt });
      } catch (err) {
        log.error("falha ao enviar progresso parcela", err, { to: message.telefone });
      }
      return { success: false, userId: user.id, erro: "progresso parcela" };
    }

    // Context-aware: any natural phrasing — session first, then DB fallback
    const progress = detectInstallmentProgress(t);
    if (progress !== null) {
      const inst = getLastInstallment(user.id) ?? await getInstallmentFromDb(user.id);

      if (!inst) {
        // Orphan: detected progress phrasing but no installment found anywhere
        try {
          await whatsapp.sendText({
            to:   message.telefone,
            text: "De qual compra? Me manda assim:\n\niphone 12x de 250",
          });
        } catch (err) {
          log.error("falha ao enviar orphan hint", err, { to: message.telefone });
        }
        return { success: false, userId: user.id, erro: "progresso parcela sem contexto" };
      }

      const txt = buildInstallmentProgressText(progress, inst);

      let newParcelaAtual = inst.parcelaAtual;
      if (progress.type === "pago" && progress.pago !== undefined) {
        newParcelaAtual = progress.pago + 1;
      } else if (progress.type === "current") {
        newParcelaAtual = progress.atual + 1;
      }
      setLastInstallment(user.id, { ...inst, parcelaAtual: newParcelaAtual });

      if (inst.dbId && (progress.type === "pago" || progress.type === "current")) {
        const pagas = newParcelaAtual - 1;
        await pool.query(
          `UPDATE installments SET parcelas_pagas = $1 WHERE id = $2`,
          [pagas, inst.dbId]
        ).catch(() => null);
      }

      try {
        await whatsapp.sendText({ to: message.telefone, text: txt });
      } catch (err) {
        log.error("falha ao enviar progresso parcela", err, { to: message.telefone });
      }
      return { success: false, userId: user.id, erro: "progresso parcela" };
    }
  }

  // ── Parcela context follow-ups ───────────────────────────────────────────
  // Responde perguntas sobre a parcela ativa sem exigir frase exata.
  // Só dispara quando o lastContext é "installment" E lastInstallment existe (sessão ou DB).
  {
    const inst = getLastInstallment(user.id) ?? (getLastContext(user.id) === "installment" ? await getInstallmentFromDb(user.id) : null);
    if (inst && getLastContext(user.id) === "installment") {
      const tq = message.texto.trim().toLowerCase();

      type IQ = "total_value" | "remaining_count" | "remaining_value" | "installment_value";
      const iq: IQ | null = (
        /\b(valor\s+total|total\s+da\s+compra|quanto\s+(é|e)\s+(o\s+)?total|qual\s+o\s+total)\b/.test(tq) ? "total_value" :
        /\b(quantas\s+(parcelas\s+)?faltam|quantas\s+(ainda\s+)?restam|quantas\s+ainda\s+(tenho|faltam))\b/.test(tq) ? "remaining_count" :
        /\b(quanto\s+falta\s+pagar|quanto\s+ainda\s+falta\s+pagar|valor\s+restante|quanto\s+falta\s+pra\s+quitar)\b/.test(tq) ? "remaining_value" :
        /^quanto\s+falta[?!.]*$/.test(tq) ? "remaining_value" :
        /\b(valor\s+da\s+parcela|qual\s+(é|e)\s+a\s+parcela|quanto\s+(é|e)\s+cada\s+(uma|parcela)|valor\s+de\s+cada)\b/.test(tq) ? "installment_value" :
        null
      );

      if (iq !== null) {
        const { item, valor, totalParcelas, parcelaAtual } = inst;
        const pagas   = parcelaAtual - 1;
        const faltam  = totalParcelas - pagas;
        const total   = totalParcelas * valor;
        const restante = faltam * valor;

        let txt: string;
        if (iq === "total_value") {
          txt = `${item} — total de ${fmtValor(total)}\n${totalParcelas}× ${fmtValor(valor)}`;
        } else if (iq === "remaining_count") {
          txt = faltam > 0
            ? `Faltam ${faltam} parcela${faltam > 1 ? "s" : ""} do ${item}.`
            : `${item} — quitado!`;
        } else if (iq === "remaining_value") {
          txt = faltam > 0
            ? `Faltam ${fmtValor(restante)} para quitar o ${item}.`
            : `${item} — quitado!`;
        } else {
          txt = `Cada parcela do ${item} é ${fmtValor(valor)}.`;
        }

        try {
          await whatsapp.sendText({ to: message.telefone, text: txt });
        } catch (err) {
          log.error("falha ao enviar parcela follow-up", err, { to: message.telefone });
        }
        return { success: false, userId: user.id, erro: "installment context follow-up" };
      }
    }
  }

  // ── Recurring context follow-ups ─────────────────────────────────────────
  if (getLastContext(user.id) === "recurring") {
    const tq = message.texto.trim().toLowerCase();
    const isQuestion = /(mostr|ver|qua(is|l)|lista|tudo|todos|resumo|meus|outros|quais\s+s[aã]o|quais\s+(eu\s+)?tenho|e\s+os\s+outros)/i.test(tq);
    const temNumero = /\d/.test(tq);
    
    if (isQuestion && !temNumero) {
      setLastCommand(user.id, "recorrentes");
      return await handleRecorrentesCommand(user, message.telefone);
    }
  }

  // ── Intent de meta ───────────────────────────────────────────────────────
  // Intercepta linguagem natural sobre metas antes de chegar no parser de gastos
  {
    const goalIntent = detectGoalIntent(message.texto.trim());
    if (goalIntent !== null) {
      try {
        if (goalIntent.type === "adicionar")       return await handleAddToGoal(user, message.telefone, goalIntent.valor, goalIntent.nome);
        if (goalIntent.type === "criar_sem_valor") return await handleCreateGoalNoValue(user, message.telefone, goalIntent.nome);
        if (goalIntent.type === "progresso")       return await handleGoalProgress(user, message.telefone, goalIntent.nome);
        if (goalIntent.type === "porcentagem")     return await handleGoalPercentage(user, message.telefone);
        if (goalIntent.type === "juntei")          return await handleGoalAmountSaved(user, message.telefone);
      } catch (err) {
        log.error("falha no goal intent", err, { userId: user.id });
      }
    }
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

  // Número puro sem descrição
  let textoParsear = message.texto;
  if (/^\d[\d,.]*$/.test(message.texto.trim())) {
    const cRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`,
      [user.id]
    );
    if (Number(cRow.rows[0].count) === 0) {
      // Onboarding: primeiro contato → assume renda
      textoParsear = message.texto.trim() + " salário";
      log.parser("onboarding: numero puro → renda", { original: message.texto, ajustado: textoParsear });
    } else {
      // Usuário ativo: número sem contexto → pede o que foi
      try {
        await whatsapp.sendText({
          to:   message.telefone,
          text: `Qual foi o gasto?\n\nMe manda assim:\n${message.texto.trim()} mercado`,
        });
      } catch (err) {
        log.error("falha ao pedir descricao numero puro", err, { to: message.telefone });
      }
      return { success: false, userId: user.id, erro: "numero puro sem descricao" };
    }
  }

  log.parser("analisando", { texto: textoParsear });

  // ── Multi-line transactions ───────────────────────────────────────────────
  {
    const linhasMulti = detectMultiLine(message.texto);
    if (linhasMulti) {
      return await handleMultiLineTransactions(user, message.telefone, linhasMulti);
    }
  }

  // Installment pattern takes priority over generic parser
  const installment = detectInstallment(textoParsear);
  if (installment) {
    if (installment.needsParcela) {
      return await handleInstallmentNeedsParcela(user, message.telefone, installment);
    }
    return await handleInstallmentRegistration(user, message.telefone, installment);
  }

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

  // ── Checagem de recorrente duplicado ─────────────────────────────────────
  if (parsed.tipo === "saida") {
    const recMatch = await checkRecorrenteDuplicado(user.id, parsed.descricao, parsed.valor);
    if (recMatch !== null) {
      const { nome, recValor, sameValue } = recMatch;
      if (sameValue) {
        try { await whatsapp.sendText({ to: message.telefone, text: `${nome} já está nos seus recorrentes 🙂` }); } catch (_) { /* silent */ }
        return { success: false, userId: user.id, erro: "gasto duplica recorrente" };
      } else {
        try {
          await whatsapp.sendText({
            to:   message.telefone,
            text: `${nome} já existe por ${fmtValor(recValor)}.\nQuer atualizar para ${fmtValor(parsed.valor)}?`,
          });
          await pool.query(
            `INSERT INTO pending_actions (user_id, action, step, tx_ids)
             VALUES ($1, 'confirmar_recorrente', 'waiting_confirmation', $2::jsonb)
             ON CONFLICT (user_id) DO UPDATE
               SET action = 'confirmar_recorrente', step = 'waiting_confirmation', tx_ids = $2::jsonb,
                   selected_tx_id = NULL, expires_at = NOW() + INTERVAL '10 minutes'`,
            [user.id, JSON.stringify({ update: true, nome: recMatch.nomeOriginal, novoValor: parsed.valor })]
          );
        } catch (err) {
          log.error("falha ao perguntar sobre atualização de recorrente", err, { userId: user.id });
        }
        return { success: false, userId: user.id, erro: "recorrente valor diferente" };
      }
    }
  }

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
    recordAction(user.id, "registered_transaction");
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

  const linhasConfirmacao = parsed.tipo === "entrada"
    ? [`💰 Anotado!\n${fmtValor(parsed.valor)} • ${capitalizeFirst(parsed.descricao)}`]
    : [`✅ Anotado!\n${fmtValor(parsed.valor)} • ${capitalizeFirst(parsed.descricao)}`];

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
    // Session cooldown: no máximo 1 mensagem secundária a cada 10 minutos por sessão.
    setTimeout(async () => {
      try {
        if (!canSendInsight(user.id)) return;

        if (await checkAndSendOnboardingTip(user.id, message.telefone, "saida")) {
          recordInsightSent(user.id); return;
        }
        if (await checkAndSendInsights(user.id, message.telefone, parsed.categoria)) {
          recordInsightSent(user.id); return;
        }
        if (await checkAndSendSmartInsights(user.id, message.telefone, parsed.descricao, parsed.categoria)) {
          recordInsightSent(user.id); return;
        }
        if (await sendContextualMicroInsight(user.id, message.telefone, parsed.categoria)) {
          recordInsightSent(user.id); return;
        }
        if (await checkAndSuggestRecorrente(user.id, message.telefone, parsed.descricao, parsed.valor, parsed.categoria)) {
          recordInsightSent(user.id); return;
        }
        if (await checkAndDetectInstallment(user.id, message.telefone, parsed.descricao, message.texto, parsed.valor)) {
          recordInsightSent(user.id);
        }
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
    linhasParcial.push("", "Quanto você recebe por mês?", "", "Ex:", "• 3000", "• 4500 salário + 500 freelance");

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
      : `🔴 No vermelho: ${fmtValor(Math.abs(sobrou))} a mais do que entrou`,
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("saldo enviado", { to: telefone, totalRenda, gastos: metrics.total_saidas, sobrou });
  } catch (err) {
    log.error("falha ao enviar saldo", err, { to: telefone });
  }

  recordAction(user.id, "queried_balance");
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

  recordAction(user.id, "queried_summary");
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

async function checkRecorrenteDuplicado(
  userId: number,
  descricao: string,
  valor: number,
): Promise<{ nome: string; nomeOriginal: string; recValor: number; sameValue: boolean } | null> {
  try {
    const res = await pool.query<{ nome: string; valor: string }>(
      `SELECT nome, valor FROM recurring_expenses
       WHERE user_id = $1 AND ativo = TRUE
         AND LOWER(TRIM(nome)) = LOWER(TRIM($2))
       LIMIT 1`,
      [userId, descricao]
    );
    if (!res.rows.length) return null;
    const row      = res.rows[0];
    const recValor = parseFloat(row.valor);
    const sameValue = Math.abs(recValor - valor) < 0.50;
    return { nome: capitalizeFirst(row.nome), nomeOriginal: row.nome, recValor, sameValue };
  } catch (err) {
    log.error("checkRecorrenteDuplicado falhou", err, { userId });
    return null;
  }
}

// Coisas que nunca são recorrentes na 1ª ocorrência — exclusão por sinal negativo
const NEVER_RECURRING = [
  "mercado", "supermercado", "minimercado", "atacadão", "atacadao", "assaí", "assai", "hortifruti",
  "padaria", "confeitaria", "açougue", "acougue",
  "restaurante", "lanchonete", "cantina", "bistrô", "bistro",
  "almoço", "almoco", "jantar", "lanche", "pizza", "hamburguer", "marmita", "comida",
  "delivery", "ifood", "rappi", "uber eats", "ubereats",
  "gasolina", "etanol", "combustível", "combustivel", "abastecimento", "gnv",
  "uber", "táxi", "taxi", "99pop", "cabify", "passagem",
  "estacionamento", "pedágio", "pedagio",
  "farmácia", "farmacia", "drogaria", "remédio", "remedio", "medicamento",
  "consulta", "exame", "dentista",
  "compra", "compras", "roupa", "roupas", "sapato", "calçado", "calcado",
  "posto", "oficina", "mecânico", "mecanico", "pneu", "funilaria",
  "cinema", "teatro", "show", "ingresso", "boliche", "karting",
  "hotel", "pousada", "hostel", "airbnb", "viagem",
  "presente",
  // Compras típicas parceladas (nunca são assinaturas mensais)
  "iphone", "ipad", "macbook", "airpods",
  "notebook", "laptop", "computador", "celular", "smartphone",
  "geladeira", "fogão", "fogao", "microondas", "lavadora",
  "televisão", "televisao",
  "sofá", "sofa", "cama", "colchão", "colchao", "móveis", "moveis", "armário", "armario",
  "bicicleta",
];

// Detecta se um gasto tem perfil de recorrente sem depender de lista de serviços
function isLikelyRecurring(descricao: string, valor: number, categoria: string): boolean {
  const desc = descricao.toLowerCase().trim();
  const words = desc.split(/\s+/).filter(w => w.length > 0);

  // Bail imediato: padrões que nunca são assinaturas na 1ª ocorrência
  if (NEVER_RECURRING.some(w => desc.includes(w))) return false;

  let score = 0;

  // Categoria indica recorrência estrutural
  if (["Moradia", "Educação"].includes(categoria)) score += 2;
  else if (["Lazer", "Saúde", "Investimentos"].includes(categoria)) score += 1;

  // Valor com perfil de assinatura: inteiro ou terminando em .90/.99, entre R$9 e R$800
  const cents = Math.round((valor % 1) * 100);
  if ((cents === 0 || cents === 90 || cents === 99) && valor >= 9 && valor <= 800) score += 1;

  // Descrição curta — nomes de serviço são concisos (1–3 palavras)
  if (words.length >= 1 && words.length <= 3) score += 1;

  // Parece nome de marca: inicial maiúscula (Adobe, Netflix) ou camelCase (iCloud, YouTube)
  if (/^[A-Z]/.test(descricao) || /[a-z][A-Z]/.test(descricao)) score += 1;

  return score >= 3;
}

// Detecta recorrentes por sinal contextual (1ª ocorrência) ou por padrão histórico (2+ meses)
async function checkAndSuggestRecorrente(userId: number, telefone: string, descricao: string, valor: number, categoria: string): Promise<boolean> {
  try {
    const descNorm = descricao.toLowerCase().trim();
    const LIFETIME = new Date("2000-01-01");
    const sentinel = `rec_suggest_${descNorm.replace(/\s+/g, "_").slice(0, 40)}`;

    // Não sugerir se já é recorrente cadastrado
    const jaRecorrente = await pool.query(
      `SELECT 1 FROM recurring_expenses WHERE user_id = $1 AND LOWER(nome) = $2 LIMIT 1`,
      [userId, descNorm]
    );
    if (jaRecorrente.rows.length > 0) return false;

    // ── Strategy A: sinais contextuais → pergunta na 1ª ocorrência ───────────
    if (isLikelyRecurring(descricao, valor, categoria)) {
      const inserted = await pool.query(
        `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
        [userId, sentinel, LIFETIME]
      );
      if ((inserted.rowCount ?? 0) === 0) return false;

      const nome = capitalizeFirst(descricao);
      await whatsapp.sendText({
        to:   telefone,
        text: `${nome} aparece todo mês? 🔁`,
      });
      await pool.query(
        `INSERT INTO pending_actions (user_id, action, step, tx_ids)
         VALUES ($1, 'confirmar_recorrente', 'waiting_confirmation', $2::jsonb)
         ON CONFLICT (user_id) DO UPDATE
           SET action = 'confirmar_recorrente', step = 'waiting_confirmation', tx_ids = $2::jsonb,
               selected_tx_id = NULL, expires_at = NOW() + INTERVAL '48 hours'`,
        [userId, JSON.stringify({ nome: descricao, valor, frequencia: "mensal" })]
      );
      log.whatsapp("sugestao recorrente (sinal) enviada", { to: telefone, userId, descricao, categoria });
      return true;
    }

    // ── Strategy B: padrão histórico → mesmo nome em 2+ meses diferentes ─────
    const patternRow = await pool.query<{ meses: string }>(
      `SELECT COUNT(DISTINCT DATE_TRUNC('month', criado_em)) AS meses
       FROM transactions
       WHERE user_id = $1
         AND tipo = 'saida'
         AND LOWER(descricao) = $2
         AND criado_em >= NOW() - INTERVAL '4 months'`,
      [userId, descNorm]
    );
    const mesesDistintos = Number(patternRow.rows[0]?.meses ?? 0);
    if (mesesDistintos < 2) return false;

    const inserted = await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, sentinel, LIFETIME]
    );
    if ((inserted.rowCount ?? 0) === 0) return false;

    const nome = capitalizeFirst(descricao);
    await whatsapp.sendText({
      to:   telefone,
      text: `Percebi que ${nome} aparece todo mês. Isso é recorrente? 🔁`,
    });
    await pool.query(
      `INSERT INTO pending_actions (user_id, action, step, tx_ids)
       VALUES ($1, 'confirmar_recorrente', 'waiting_confirmation', $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE
         SET action = 'confirmar_recorrente', step = 'waiting_confirmation', tx_ids = $2::jsonb,
             selected_tx_id = NULL, expires_at = NOW() + INTERVAL '48 hours'`,
      [userId, JSON.stringify({ nome: descricao, valor, frequencia: "mensal" })]
    );
    log.whatsapp("sugestao recorrente (padrao) enviada", { to: telefone, userId, descricao });
    return true;
  } catch (err) {
    log.error("falha sugestao recorrente", err, { userId });
    return false;
  }
}

async function handleConfirmarRecorrente(user: UserRow, telefone: string, txIds: unknown): Promise<ProcessResult> {
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
        await pool.query(
          `INSERT INTO recurring_expenses (user_id, nome, valor, frequencia)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, nome)
           DO UPDATE SET valor = $3, frequencia = $4, ativo = TRUE`,
          [user.id, item.nome, item.valor, item.frequencia]
        );
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
    await pool.query(
      `INSERT INTO recurring_expenses (user_id, nome, valor, frequencia)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, nome)
       DO UPDATE SET valor = $3, frequencia = $4, ativo = TRUE`,
      [user.id, data.nome, data.valor, data.frequencia]
    );
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
    if (Number(catRow.rows[0].count) >= 4) {
      insight = pick([
        `${categoria} apareceu bastante hoje.`,
        `Bastante ${categoria.toLowerCase()} hoje.`,
      ]);
    }

    // Condição 2: 5+ gastos nas últimas 2h (ritmo acelerado)
    if (!insight) {
      const paceRow = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2`,
        [userId, twoHoursAgo]
      );
      if (Number(paceRow.rows[0].count) >= 5) {
        insight = pick([
          "Bastante saída concentrada hoje 👀",
          "Hoje teve bastante movimento.",
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
    return `${categoria} passou do limite esse mês. ${fmtValor(totalGasto)} de ${fmtValor(valorLimite)}.`;
  }

  if (percentual >= 80 && !marcosSent.has(80)) {
    await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, $2, 80, $3)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, categoria, inicioMes]
    );
    return `${categoria} está em ${percentual}% do limite esse mês. ${fmtValor(totalGasto)} de ${fmtValor(valorLimite)}.`;
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
  const valorLimite = parseValor(match[2]);

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

  recordAction(user.id, "set_limit");

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

async function handleListLimitsCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando list_limites", { userId: user.id });

  const r = await pool.query<{ categoria: string; valor_limite: string }>(
    `SELECT categoria, valor_limite FROM category_limits WHERE user_id = $1 ORDER BY categoria ASC`,
    [user.id]
  );

  let txt: string;
  if (r.rows.length === 0) {
    txt = "Você ainda não tem limites definidos.\n\nEx:\nlimite alimentação 800";
  } else {
    const itens = r.rows.map(row => `• ${row.categoria} — ${fmtValor(Number(row.valor_limite))}`);
    txt = ["Seus limites por categoria:", "", ...itens].join("\n");
  }

  try {
    await whatsapp.sendText({ to: telefone, text: txt });
  } catch (err) {
    log.error("falha ao enviar lista de limites", err, { to: telefone });
  }

  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "list_limites" } };
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
    "Cozinhar mais em casa costuma ser o maior corte por aqui.",
    "Delivery acumula rápido — pode valer reduzir.",
    "Planejar o mercado antes evita compras por impulso.",
  ],
  "Transporte":   [
    "Transporte público em alguns dias da semana faz diferença aqui.",
    "Caronas combinadas podem ajudar a reduzir esse gasto.",
    "Distâncias curtas de Uber acumulam mais do que parece.",
  ],
  "Lazer":        [
    "Opções gratuitas de lazer costumam ser mais do que imaginamos.",
    "Às vezes tem assinatura esquecida por aqui — vale checar.",
    "Saídas pagas têm um peso grande no mês.",
  ],
  "Saúde":        [
    "Genéricos podem custar menos sem perder qualidade.",
    "O plano de saúde cobre mais do que parece às vezes.",
  ],
  "Educação":     [
    "Antes de um novo curso, vale terminar os que já começou.",
    "Tem muito conteúdo gratuito de qualidade por aí.",
  ],
  "Moradia":      [
    "Aparelhos em standby consomem mais energia do que parece.",
    "Assinaturas que você menos usa podem estar pesando por aqui.",
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
    `${emoji} ${top.categoria} — ${fmtValor(top.total)} esse mês`,
    "",
    dica,
    "",
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

  recordAction(user.id, "queried_other");
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

async function handleMetaCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
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
  try {
    await whatsapp.sendText({ to: telefone, text: buildFeaturesMenuText() });
    log.whatsapp("ajuda enviado", { to: telefone });
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
  10: `Para guardar na meta: guardar 200 viagem 🎯`,
  11: `A previsão mostra como o mês vai fechar.`,
  12: `As próximas listam tudo que vence em breve.`,
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
      const texto = `${capitalizeFirst(top.categoria)} liderou o mês até agora 🙂`;
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

  const insightTexto = percentual >= 65
    ? `${categoria} tá puxando bastante esse mês 👀`
    : `${categoria} tá acima da metade dos gastos este mês.`;

  await whatsapp.sendText({ to: telefone, text: insightTexto });
  log.whatsapp("insight enviado", { to: telefone, categoria, percentual, marco });
  return true;
}

// Insights inteligentes baseados em comparação de períodos e padrões de frequência
async function checkAndSendSmartInsights(
  userId: number,
  telefone: string,
  descricao: string,
  categoria: string,
): Promise<boolean> {
  try {
    const now     = new Date();
    const ano     = now.getUTCFullYear();
    const mes     = now.getUTCMonth();
    const dia     = now.getUTCDate();
    const LIFETIME = new Date("2000-01-01");

    const inicioMesAtual       = new Date(Date.UTC(ano, mes, 1));
    const inicioMesAnterior    = new Date(Date.UTC(ano, mes - 1, 1));
    const mesmoPeriodoAnterior = new Date(Date.UTC(ano, mes - 1, dia));

    // Precisa de ao menos 5 saídas para comparações fazerem sentido
    const totalRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`,
      [userId]
    );
    if (Number(totalRow.rows[0].count) < 5) return false;

    function pick(arr: string[]): string { return arr[Math.floor(Math.random() * arr.length)]; }

    async function tryInsight(sentinel: string, mesRef: Date, texto: string): Promise<boolean> {
      const ins = await pool.query(
        `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
        [userId, sentinel, mesRef]
      );
      if ((ins.rowCount ?? 0) === 0) return false;
      await whatsapp.sendText({ to: telefone, text: texto });
      log.whatsapp("smart insight enviado", { to: telefone, userId, sentinel });
      return true;
    }

    // ── 1. Frequência: mesma descrição 3+ vezes nos últimos 30 dias ──────────
    const descNorm = descricao.toLowerCase().trim();
    const freqRow  = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions
       WHERE user_id = $1 AND tipo = 'saida' AND LOWER(descricao) = $2
         AND criado_em >= NOW() - INTERVAL '30 days'`,
      [userId, descNorm]
    );
    if (Number(freqRow.rows[0].count) >= 3) {
      const jaRec = await pool.query(
        `SELECT 1 FROM recurring_expenses WHERE user_id = $1 AND LOWER(nome) = $2 AND ativo = TRUE LIMIT 1`,
        [userId, descNorm]
      );
      if (jaRec.rows.length === 0) {
        const sentinel = `smart_freq_${descNorm.replace(/\W+/g, "_").slice(0, 40)}`;
        const texto = `${capitalizeFirst(descricao)} aparece bastante nos seus gastos recentes.`;
        if (await tryInsight(sentinel, inicioMesAtual, texto)) return true;
      }
    }

    // ── 2–5. Comparação de períodos — só a partir do dia 5 do mês ────────────
    if (dia < 5) return false;

    const [curRow, prevRow, catCurRow, catPrevRow] = await Promise.all([
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM transactions
         WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2`,
        [userId, inicioMesAtual]
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM transactions
         WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2 AND criado_em < $3`,
        [userId, inicioMesAnterior, mesmoPeriodoAnterior]
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM transactions
         WHERE user_id = $1 AND tipo = 'saida' AND LOWER(categoria) = LOWER($2) AND criado_em >= $3`,
        [userId, categoria, inicioMesAtual]
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM transactions
         WHERE user_id = $1 AND tipo = 'saida' AND LOWER(categoria) = LOWER($2)
           AND criado_em >= $3 AND criado_em < $4`,
        [userId, categoria, inicioMesAnterior, mesmoPeriodoAnterior]
      ),
    ]);

    const spendAtual    = Number(curRow.rows[0].total);
    const spendAnterior = Number(prevRow.rows[0].total);
    const catAtual      = Number(catCurRow.rows[0].total);
    const catAnterior   = Number(catPrevRow.rows[0].total);

    // ── 2. Mês mais pesado ────────────────────────────────────────────────────
    if (spendAnterior > 80 && spendAtual > spendAnterior * 1.25) {
      const sentinel = `smart_mes_alto_${mes}_${ano}`;
      const texto = pick([
        "Esse mês está mais pesado que o anterior até aqui.",
        "Esse mês está mais apertado que o anterior.",
      ]);
      if (await tryInsight(sentinel, inicioMesAtual, texto)) return true;
    }

    // ── 3. Mês mais leve ──────────────────────────────────────────────────────
    if (spendAnterior > 80 && spendAtual > 20 && spendAtual < spendAnterior * 0.75) {
      const sentinel = `smart_mes_baixo_${mes}_${ano}`;
      const texto = "Esse mês você está gastando menos que no anterior 🙂";
      if (await tryInsight(sentinel, inicioMesAtual, texto)) return true;
    }

    // ── 4. Categoria subindo ──────────────────────────────────────────────────
    if (catAnterior > 40 && catAtual > catAnterior * 1.35) {
      const catKey   = categoria.replace(/\s+/g, "_").toLowerCase().slice(0, 30);
      const sentinel = `smart_cat_alta_${catKey}_${mes}_${ano}`;
      const texto    = `${categoria} está mais alto esse mês em comparação ao anterior.`;
      if (await tryInsight(sentinel, inicioMesAtual, texto)) return true;
    }

    // ── 5. Categoria melhorando ───────────────────────────────────────────────
    if (catAnterior > 40 && catAtual > 0 && catAtual < catAnterior * 0.65) {
      const catKey   = categoria.replace(/\s+/g, "_").toLowerCase().slice(0, 30);
      const sentinel = `smart_cat_baixa_${catKey}_${mes}_${ano}`;
      const texto    = pick([
        `Esse mês você gastou menos com ${categoria.toLowerCase()} 🙂`,
        `${categoria} mais controlado esse mês 🙂`,
      ]);
      if (await tryInsight(sentinel, inicioMesAtual, texto)) return true;
    }

    return false;
  } catch (err) {
    log.error("falha smart insights", err, { userId });
    return false;
  }
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

// ── Controle de Acesso Pós-Trial ────────────────────────────────────────

function isBlockedFreemium(texto: string): boolean {
  const t = texto.trim().toLowerCase();
  
  if (/^(ranking|comparar|previs[aã]o|categorias|desafio|metas|recorrentes|pr[oó]ximas|top\s*gastos|parcelas|relat[oó]rios?|insights?|apagar|corrigir)$/i.test(t)) return true;
  if (/^(meta|guardar|recorrente|limite)\s+/i.test(t)) return true;
  
  if (/quero\s+apagar|apagar\s+o\s+[uú]ltimo|remover\s+(o\s+)?[uú]ltimo|deletar\s+(o\s+)?[uú]ltimo/.test(t)) return true;
  if (/registrei\s+errado|coloquei\s+errado|lancei\s+errado/.test(t)) return true;
  if (/(qual\s+(é\s+o\s+)?meu\s+maior\s+gasto|onde\s+gastei\s+mais|onde\s+vai\s+(meu\s+)?dinheiro|maior\s+gasto\s+do\s+m[eê]s)/i.test(t)) return true;
  
  if (detectGoalIntent(texto) !== null) return true;
  
  return false;
}

// Envia aviso limpo de expiração apenas uma vez
async function checkAndSendExpirationNotice(userId: number, telefone: string, expirouEm: Date): Promise<boolean> {
  const expirouEmDate = new Date(Date.UTC(expirouEm.getUTCFullYear(), expirouEm.getUTCMonth(), expirouEm.getUTCDate()));

  let fullNovo = false;
  try {
    const ins = await pool.query(
      `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, 'expiracao_aviso_v4', 1, $2::date)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
      [userId, expirouEmDate]
    );
    fullNovo = (ins.rowCount ?? 0) > 0;
  } catch { /* continua */ }

  if (fullNovo) {
    log.webhook("enviando aviso de expiracao LONGO (primeira vez)", { userId });
    const mensagem = `✨ Seu teste grátis terminou.\n\nVocê ainda pode:\n👀 consultar saldo\n📊 visualizar registros do mês\n\nDesbloqueie todos os recursos:\nhttps://salva-bolso-backend-salvabolso.h5prml.easypanel.host/premium-checkout.html`;
    await whatsapp.sendText({ to: telefone, text: mensagem });
    return true;
  }
  
  log.webhook("aviso longo ja foi enviado antes, ignorando para usar o curto", { userId });
  return false;
}

function isSubscriptionActive(user: UserRow): boolean {
  const status = (user.subscription_status ?? "").trim().toLowerCase();

  if (status === "expired") return false;

  if (status === "active") {
    if (!user.subscription_expires_at) return true;
    return new Date(user.subscription_expires_at) > new Date();
  }

  if (status === "trial") {
    return !user.trial_ends_at || new Date(user.trial_ends_at) > new Date();
  }

  return false; // qualquer status desconhecido = bloqueado
}

function isCuriosityPhrase(texto: string): boolean {
  const t = texto.trim();
  if (/^(mostra|mostra\s+a[ií]|explica|me\s+conta|pode\s+falar)[\?!.]*$/i.test(t)) return true;
  return /quero\s+ver|me\s+mostra|como\s+funciona|o\s+que\s+(você|voce|vc)\s+(faz|pode|conseg|d[aá])|o\s+que\s+d[aá]\s+pra\s+fa[çz]|tem\s+mais\s+coisa|quero\s+entender|me\s+explica|o\s+que\s+[eéè]\s+isso|como\s+(uso|usar|fa[çc]o)\b|o\s+que\s+tem\s+(aqui|nesse?\s+bot)?|conta\s+mais|o\s+que\s+voc[eê]\s+conseg|o\s+que\s+mais\s+(posso|d[aá]|consigo)\s+(fazer|ver|usar)|o\s+que\s+(posso|consigo)\s+(fazer|ver|usar)/i.test(t);
}

function buildFeaturesMenuText(): string {
  return [
    "📌 O que posso fazer:",
    "",
    "📊 Saldo e resumo do mês",
    "",
    "💸 Registrar gastos",
    "Ex: mercado, uber, farmácia",
    "",
    "💳 Parcelamentos",
    "Ex: iPhone 12x de 300",
    "",
    "🔄 Contas fixas",
    "Ex: Netflix, aluguel, academia",
    "",
    "🎯 Metas e limites",
    "",
    "✏️ Corrigir ou apagar lançamentos",
    "",
    "💬 Pode me perguntar do seu jeito 🙂",
  ].join("\n");
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
  const linhas = [
    `${fmtValor(metrics.total_saidas)} em gastos esse mês.`,
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

// Responde "e agora?" / "o que mais posso fazer?" com contexto da sessão atual
async function handleNextStepSuggestion(user: UserRow, telefone: string): Promise<ProcessResult> {
  const countRow = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`,
    [user.id]
  );
  const txCountDb = Number(countRow.rows[0].count);

  const session = getSession(user.id) ?? initSession(user.id);
  const text    = getContextualNextStep(session, txCountDb);

  try {
    await whatsapp.sendText({ to: telefone, text });
    log.whatsapp("next_step_suggestion enviado", { to: telefone, userId: user.id, txCountDb, phase: session.phase });
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

  // Correção ou deleção por linguagem natural (sem guard !temNumero — captura frases com valor)
  const _naturalEdit = parseNaturalEdit(texto.trim());
  if (_naturalEdit) {
    if (_naturalEdit.tipo === "corrigir") {
      return await handleNaturalCorrection(user, telefone, _naturalEdit.descBusca, _naturalEdit.novoValor);
    } else {
      return await handleNaturalDelete(user, telefone, _naturalEdit.descBusca);
    }
  }

  // Confusão leve → resposta curta, sem menu
  if (
    !temNumero &&
    /n[aã]o\s+(estou?|t[oô]|to)\s+entendendo|n[aã]o\s+entendi|entendi\s+foi\s+nada|n[aã]o\s+(sei|entendo)\s+(nada|nada\s+disso)|como\s+assim|n[aã]o\s+peguei/.test(t)
  ) {
    const guia = [
      "Pode usar o SalvaBolso de forma bem simples 🙂",
      "",
      "Ex:",
      "• 50 mercado",
      "• quanto sobrou?",
      "• resumo",
      "• ranking",
    ].join("\n");
    try {
      await whatsapp.sendText({ to: telefone, text: guia });
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
    const acks = ["Bom sinal.", "Vai acumulando.", "Dias leves também contam."];
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

  // "como tá meu mês?" / "como está o mês?" / "como anda a situação?" → resumo
  if (
    !temNumero &&
    /como\s+(t[aá]|est[aá]|anda|foi|ficou)\s+(meu|o|a\s+minha\s+)?(m[eê]s|financ|conta|situac|semana)/i.test(t)
  ) {
    return await handleResumoCommand(user, telefone);
  }

  // "quanto gastei hoje?" → hoje
  if (
    !temNumero &&
    /quanto\s+(gastei|gasto|saiu|foi)\s+(hoje|de\s+hoje|nesse?\s+dia)/i.test(t)
  ) {
    return await handleHojeCommand(user, telefone);
  }

  // "qual meu maior gasto?" / "onde gastei mais?" / "onde vai meu dinheiro?" → ranking
  if (
    !temNumero &&
    /(qual\s+(é\s+o\s+)?meu\s+maior\s+gasto|onde\s+gastei\s+mais|onde\s+vai\s+(meu\s+)?dinheiro|maior\s+gasto\s+do\s+m[eê]s|onde\s+(gasto|t[oô])\s+gastando\s+mais|cat[eé]goria\s+mais\s+(cara|alta|pesada))/i.test(t)
  ) {
    return await handleRankingCommand(user, telefone);
  }

  // "tem algo pesado esse mês?" / "tem algo caro?" → spending concern
  if (
    !temNumero &&
    /(tem\s+algo\s+(pesado|caro|alto|excessivo|demais)|o\s+que\s+(t[aá]|est[aá])\s+(pesando|alto|caro|pesad[ao])|t[aá]\s+(pesado|caro|alto)|o\s+que\s+t[aá]\s+pesando)/i.test(t)
  ) {
    return await handleSpendingConcern(user, telefone);
  }

  // "quanto sobrou esse mês?" / "como tá o saldo?" → saldo
  if (
    !temNumero &&
    /(como\s+(t[aá]|est[aá]|anda)\s+o\s+(saldo|dinheiro|que\s+sobrou)|quanto\s+sobrou\s+(esse|este|no)\s+m[eê]s)/i.test(t)
  ) {
    return await handleSaldoCommand(user, telefone);
  }

  // ── Follow-up contextual ──────────────────────────────────────────────────
  // Interpreta frases curtas/ambíguas com base no último comando mostrado.

  const _sessCtx = getSession(user.id);
  const _lastCmd = _sessCtx?.lastCommand ?? "";

  // "quais eu tenho?" / "o que eu tenho?" / "quantos tenho?" → contexto do último comando
  if (
    !temNumero &&
    /^(quais?\s+(eu\s+)?tenho|o\s+que\s+eu\s+tenho|quantos?\s+(eu\s+)?tenho|tenho\s+algum[ao]?)[\?!.]*$/i.test(t)
  ) {
    if (/recorrente|proxima/.test(_lastCmd)) {
      setLastCommand(user.id, "recorrentes");
      return await handleRecorrentesCommand(user, telefone);
    }
    if (/meta/.test(_lastCmd)) {
      setLastCommand(user.id, "metas");
      return await handleMetasCommand(user, telefone);
    }
    // Default: recorrentes (pergunta mais comum fora de contexto)
    setLastCommand(user.id, "recorrentes");
    return await handleRecorrentesCommand(user, telefone);
  }

  // "meus gastos" / "minha situação" → resumo do mês
  if (
    !temNumero &&
    /^(meus?\s+gastos?|minha\s+situa[çc][aã]o|meu\s+financeiro|como\s+t[aá]\s+meu\s+dinheiro)[\?!.]*$/i.test(t)
  ) {
    setLastCommand(user.id, "resumo");
    return await handleResumoCommand(user, telefone);
  }

  // "meus recorrentes" / "minhas metas" → shortcuts naturais
  if (
    !temNumero &&
    /^(meus?\s+recorrentes?|minhas?\s+recorrentes?|recorrentes?\s+que\s+eu\s+tenho)[\?!.]*$/i.test(t)
  ) {
    setLastCommand(user.id, "recorrentes");
    return await handleRecorrentesCommand(user, telefone);
  }

  if (
    !temNumero &&
    /^(e\s+)?(minhas?\s+metas?|meus?\s+objetivos?|metas?\s+que\s+eu\s+tenho|metas?|objetivos?|sonhos?|o\s+que\s+(estou?|t[oô])\s+guardando|quanto\s+(guardei|juntei|pousei|economizei\s+at[eé]?\s+agora)|onde\s+est[aã]o\s+(minhas?\s+)?metas?|quais?\s+(s[aã]o\s+)?(minhas?\s+)?metas?)[\?!.]*$/i.test(t)
  ) {
    setLastCommand(user.id, "metas");
    return await handleMetasCommand(user, telefone);
  }

  // "quanto gasto com recorrentes?", "qual o total de recorrentes?", "quanto são os recorrentes?"
  if (
    !temNumero &&
    /quanto\s+(eu\s+)?(gasto|pago)\s+(com\s+)?recorrentes?|total\s+de\s+recorrentes?|quanto\s+s[aã]o\s+(os\s+)?recorrentes?|quanto\s+(custa|custam)\s+(os\s+)?recorrentes?/.test(t)
  ) {
    return await handleRecorrentesTotalCommand(user, telefone);
  }

  // "quanto gasto por mês?" sem mencionar recorrentes — usa lastContext para desambiguar
  if (
    !temNumero &&
    /quanto\s+(eu\s+)?(gasto|pago|saem?|[eéè])\s+por\s+m[eê]s[?!.]*$/.test(t) &&
    getLastContext(user.id) === "recurring"
  ) {
    return await handleRecorrentesTotalCommand(user, telefone);
  }

  // "extrato" / "ver extrato" / "meu extrato" → extrato do mês atual
  if (
    !temNumero &&
    /^(extrato|ver\s+extrato|meu\s+extrato|quero\s+(ver\s+)?o?\s*extrato)[\?!.]*$/i.test(t)
  ) {
    const mesAtual = MESES_NOME[new Date().getMonth() + 1];
    return await handleExtratoCommand(user, telefone, `extrato ${mesAtual}`);
  }

  // "buscar" / "buscar gastos" / "quero buscar" → pede o termo
  if (
    !temNumero &&
    /^(buscar(\s+gastos?)?|quero\s+buscar|quero\s+procurar|procurar\s+gastos?)[\?!.]*$/i.test(t)
  ) {
    try {
      await whatsapp.sendText({
        to:   telefone,
        text: "O que quer buscar?\n\nEx: buscar mercado",
      });
    } catch (err) {
      log.error("falha ao enviar hint buscar", err, { userId: user.id });
    }
    return { success: false, userId: user.id, erro: "buscar sem termo" };
  }

  // "meus limites" / "quero ver meu limite" / "quais limites tenho" → lista limites
  if (
    !temNumero &&
    /meus?\s+limites?|quero\s+(ver\s+)?(meu[s]?\s+)?limites?|quais?\s+(limites?\s+)?(eu\s+)?tenho|ver\s+limites?/i.test(t)
  ) {
    return await handleListLimitsCommand(user, telefone);
  }

  // Atualização de renda via linguagem natural: "minha renda é 4000", "recebo 3000", "meu salário mudou"
  if (/recebo\s+[\d]|minha\s+renda\s+[eéè\s]|meu\s+sal[aá]rio\s+(mudou|[eéè\s]|[eé]\s)|ganho\s+[\d]|renda\s+de\s+[\d]|sal[aá]rio\s+de\s+[\d]/i.test(t)) {
    const m = t.match(/[\d][0-9.,]*/);
    if (m) {
      const novaRenda = parseValor(m[0]);
      if (novaRenda > 0) {
        try {
          await pool.query(`UPDATE users SET renda = $1 WHERE id = $2`, [novaRenda, user.id]);
          const fmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(novaRenda);
          await whatsapp.sendText({ to: telefone, text: `Anotado 🙂 Renda atualizada para ${fmt}.` });
          log.whatsapp("renda atualizada via intent", { to: telefone, userId: user.id, novaRenda });
        } catch (err) {
          log.error("falha ao atualizar renda via intent", err, { userId: user.id });
        }
        return { success: false, userId: user.id, erro: "renda atualizada" };
      }
    }
  }

  return null;
}

// ── Multi-line transaction parser ────────────────────────────────────────────

function looksLikeTransactionLine(linha: string): boolean {
  const t = linha.trim();
  if (!t || t.length < 2) return false;
  // Starts with a digit: "40 netflix", "30,50 mercado"
  if (/^[\d]/.test(t)) return true;
  // Income: "+3000" or "+ 500"
  if (/^\+\s*[\d]/.test(t)) return true;
  // Common expense/income verbs
  if (/^(gastei|paguei|pago|comprei|tomei|saiu|custou|recebi|salario|salário|renda|entrada|freelance|bonus|bônus)\s/i.test(t)) return true;
  // Installment: "item Nx de valor" or "item N parcelas de valor"
  if (/^.+\s+\d{1,2}[xX]\s+[\d,.]+$/i.test(t)) return true;
  if (/^.+\s+\d{1,2}\s+parcelas?\s+de\s+[\d,.]+$/i.test(t)) return true;
  // Description before value: "Mercado 120", "Sorvete 38", "Disney Plus 34"
  if (/^[a-zA-ZÀ-ÿ][\w\sÀ-ÿ]+\s+[\d,.]+$/.test(t)) return true;
  return false;
}

function detectMultiLine(texto: string): string[] | null {
  const linhas = texto
    .split(/\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);
  if (linhas.length < 2) return null;
  if (!linhas.every(looksLikeTransactionLine)) return null;
  return linhas;
}

async function handleMultiLineTransactions(
  user: UserRow,
  telefone: string,
  linhas: string[],
): Promise<ProcessResult> {
  type Resultado = { descricao: string; valor: number; tipo: string; categoria: string };
  const resultados: Resultado[] = [];
  const falhas: string[]        = [];

  for (const linha of linhas) {
    try {
      // Installment line: "iphone 12x de 345"
      const inst = detectInstallment(linha);
      if (inst && !inst.needsParcela) {
        const { item, valor, totalParcelas } = inst;
        const total      = valor * totalParcelas;
        const tempParsed = parseTransaction(`${valor} ${item}`);
        const categoria  = tempParsed?.categoria ?? "Outros";
        const descricao  = capitalizeFirst(item);
        await pool.query(
          `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao) VALUES ($1, 'saida', $2, $3, $4)`,
          [user.id, valor, categoria, descricao]
        );
        const instResult = await pool.query<{ id: number }>(
          `INSERT INTO installments (user_id, nome, valor_total, valor_parcela, total_parcelas, parcelas_pagas, categoria)
           VALUES ($1, $2, $3, $4, $5, 1, $6) RETURNING id`,
          [user.id, descricao, total, valor, totalParcelas, categoria]
        );
        const dbId = instResult.rows[0].id;
        setLastInstallment(user.id, { item: descricao, valor, totalParcelas, parcelaAtual: 1, dbId, valorTotal: total });
        recordAction(user.id, "registered_transaction");
        resultados.push({ descricao: `${descricao} (${totalParcelas}×)`, valor, tipo: "saida", categoria });
        continue;
      }

      // Regular expense / income
      const parsed = parseTransaction(linha);
      if (!parsed) { falhas.push(linha); continue; }

      // Skip if matches a recurring expense (same check as single-line path)
      if (parsed.tipo === "saida") {
        const recMatch = await checkRecorrenteDuplicado(user.id, parsed.descricao, parsed.valor);
        if (recMatch !== null) {
          resultados.push({ descricao: `${recMatch.nome} (recorrente)`, valor: parsed.valor, tipo: "saida", categoria: parsed.categoria });
          continue;
        }
      }

      await pool.query(
        `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao) VALUES ($1, $2, $3, $4, $5)`,
        [user.id, parsed.tipo, parsed.valor, parsed.categoria, parsed.descricao]
      );
      recordAction(user.id, "registered_transaction");
      resultados.push({ descricao: parsed.descricao, valor: parsed.valor, tipo: parsed.tipo, categoria: parsed.categoria });
    } catch (err) {
      log.error("falha ao processar linha multilinha", err, { linha, userId: user.id });
      falhas.push(linha);
    }
  }

  if (resultados.length === 0) {
    await whatsapp.sendText({ to: telefone, text: "Não consegui interpretar. Tenta uma linha por vez?" });
    return { success: false, userId: user.id, erro: "multilinha: nenhuma linha processada" };
  }

  const itens = resultados.map(r => {
    const sinal = r.tipo === "entrada" ? "+" : "";
    return `• ${sinal}${fmtValor(r.valor)} — ${r.descricao}`;
  });

  const header = resultados.length === 1
    ? "✅ Anotado!"
    : `✅ ${resultados.length} anotados:`;

  const partes = [header, "", ...itens];
  if (falhas.length > 0) {
    partes.push("", `Não entendi: ${falhas.join(", ")}`);
  }

  try {
    await whatsapp.sendText({ to: telefone, text: partes.join("\n") });
  } catch (err) {
    log.error("falha ao enviar confirmação multilinha", err, { to: telefone });
  }

  // Verifica recorrentes nos itens de saída — sem gate de cooldown (lista é sinal explícito)
  const saidas = resultados.filter(r => r.tipo === "saida");
  if (saidas.length >= 2) {
    setTimeout(async () => {
      try {
        // Tenta individual (serviços óbvios: netflix, spotify etc.)
        let disparou = false;
        for (const r of saidas) {
          if (await checkAndSuggestRecorrente(user.id, telefone, r.descricao, r.valor, r.categoria)) {
            recordInsightSent(user.id);
            disparou = true;
            break;
          }
        }

        // Fallback genérico: pergunta sobre a lista toda com numeração
        if (!disparou) {
          const listaOpcoes = saidas.map((r, i) => `${i + 1}. ${r.descricao}`).join("\n");
          await whatsapp.sendText({ 
            to: telefone, 
            text: `Quais desses gastos acontecem todo mês? (ex: 1 e 3, ou todos)\n\n${listaOpcoes}` 
          });
          const payload = saidas.map(r => ({ nome: r.descricao, valor: r.valor, frequencia: "mensal" }));
          await pool.query(
            `INSERT INTO pending_actions (user_id, action, step, tx_ids)
             VALUES ($1, 'confirmar_recorrente_multi', 'waiting_selection_multi', $2::jsonb)
             ON CONFLICT (user_id) DO UPDATE
               SET action = 'confirmar_recorrente_multi', step = 'waiting_selection_multi', tx_ids = $2::jsonb,
                   selected_tx_id = NULL, expires_at = NOW() + INTERVAL '48 hours'`,
            [user.id, JSON.stringify(payload)]
          );
          recordInsightSent(user.id);
        }
      } catch (err) {
        log.error("falha ao verificar recorrentes multilinha", err, { userId: user.id });
      }
    }, 1200);
  }

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "multilinha", count: resultados.length },
  };
}

// ── DB fallback for installment context ──────────────────────────────────────

interface InstallmentDbRow {
  id: number;
  nome: string;
  valor_parcela: number;
  total_parcelas: number;
  parcelas_pagas: number;
  valor_total: number;
}

async function getInstallmentFromDb(userId: number): Promise<import("./conversationEngine").InstallmentCtx | null> {
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

async function handleInstallmentNeedsParcela(
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
             selected_tx_id = NULL, expires_at = NOW() + INTERVAL '10 minutes'`,
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

async function handleRegistrarParcelaValor(
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

async function handleConfirmarRecorrenteMulti(user: UserRow, telefone: string, texto: string, txIdsRaw: unknown): Promise<ProcessResult> {
  const items = txIdsRaw as { nome: string; valor: number; frequencia: string }[];
  const t = texto.toLowerCase();
  
  let selectedIndices: number[] = [];
  
  if (t.includes("todo") || t.includes("tudo") || t.includes("ambos") || t.includes("os dois") || t.includes("as duas")) {
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
    await pool.query(
      `INSERT INTO recurring_expenses (user_id, nome, valor, frequencia)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, nome)
       DO UPDATE SET valor = $3, frequencia = $4, ativo = TRUE`,
      [user.id, item.nome, item.valor, item.frequencia]
    );
    totalFixo += item.valor;
  }
  
  recordAction(user.id, "created_recurring");
  setLastCommand(user.id, "recorrentes");
  setLastContext(user.id, "recurring");
  
  const linhas = ["📌 Recorrentes salvos.", ""];
  for (const item of selectedItems) {
    linhas.push(`• ${capitalizeFirst(item.nome)} — ${fmtValor(item.valor)}`);
  }
  linhas.push("", `Total mensal fixo:`);
  linhas.push(fmtValor(totalFixo));
  
  await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "confirmar_recorrente_multi" } };
}

interface InstallmentInfo {
  item:          string;
  valor:         number;
  totalParcelas: number;
  needsParcela?: boolean;
  valorTotal?:   number;
}

function detectInstallment(texto: string): InstallmentInfo | null {
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

function detectInstallmentProgress(texto: string): ProgressResult | null {
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

function buildInstallmentProgressText(result: ProgressResult, inst: { item: string; totalParcelas: number }): string {
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

// ── Goal intent detector ──────────────────────────────────────────────────────

type GoalIntent =
  | { type: "adicionar";      valor: number; nome?: string }
  | { type: "criar_sem_valor"; nome: string }
  | { type: "progresso";      nome?: string }
  | { type: "porcentagem" }
  | { type: "juntei" };

function detectGoalIntent(texto: string): GoalIntent | null {
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

async function handleAddToGoal(
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

async function handleGoalProgress(
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

async function handleCreateGoalNoValue(
  user: UserRow,
  telefone: string,
  nome: string,
): Promise<ProcessResult> {
  const nomeFormatado = nome.charAt(0).toUpperCase() + nome.slice(1).toLowerCase();
  const txt = `Perfeito 🙂\nQual o valor que quer guardar pro ${nomeFormatado}?\n\nEx: meta ${nome.toLowerCase()} 15000`;
  await whatsapp.sendText({ to: telefone, text: txt });
  return { success: false, userId: user.id, erro: "goal without value" };
}

async function handleGoalPercentage(user: UserRow, telefone: string): Promise<ProcessResult> {
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

async function handleGoalAmountSaved(user: UserRow, telefone: string): Promise<ProcessResult> {
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

async function handleRecorrentesTotalCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  const result = await pool.query<{ nome: string; valor: string }>(
    `SELECT nome, valor FROM recurring_expenses WHERE user_id = $1 AND ativo = TRUE ORDER BY criado_em ASC`,
    [user.id]
  );

  if (result.rows.length === 0) {
    await whatsapp.sendText({ to: telefone, text: "Você não tem recorrentes cadastrados." });
    return { success: false, userId: user.id, erro: "Sem recorrentes" };
  }

  const total = result.rows.reduce((sum, row) => sum + Number(row.valor), 0);
  const linhas = [`Total em recorrentes: ${fmtValor(total)}`, ""];
  result.rows.forEach(row => linhas.push(`${row.nome} — ${fmtValor(Number(row.valor))}`));

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
  } catch (err) {
    log.error("falha ao enviar total recorrentes", err, { to: telefone });
  }
  return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "total_recorrentes" } };
}

async function handleInstallmentRegistration(
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

// Detecta frases conversacionais/de intenção que NÃO devem virar lançamento automático
const AMBIGUOUS_INTENT_RE = /\bacho\b|\btalvez\b|\bquero\b|\blembr[ae]\b|\blembrar\b|\beconomiz|\bguardar\b|\bjuntar\b|\bplanejo\b|\bpreciso\b|\bobjetivo\b|\bpara\s+(minha|meu)\s/i;

function isAmbiguousIntent(texto: string): boolean {
  return AMBIGUOUS_INTENT_RE.test(texto.trim());
}

function buildContextualHint(texto: string): string {
  const t = texto.toLowerCase();
  const ehPergunta = t.includes("?") || /^(quanto|como|qual|onde|quando|o\s+que|tem\s+algo)\b/.test(t);

  if (/quanto|sobrou|restou|dispon[ií]vel|\bsaldo\b/.test(t))         return 'O saldo mostra o que sobrou do mês 💰';
  if (/onde\s+gasto|mais\s+caro|\branking\b/.test(t))                  return 'O ranking mostra onde vai mais o dinheiro 📊';
  if (/meus?\s+gastos?|\bresumo\b|\bm[eê]s\b/.test(t))                return 'O resumo mostra seus gastos por categoria 🧾';
  if (/\bcontas?\b|recorrente|vencimento|pr[oó]ximas?/.test(t))        return 'Os recorrentes listam suas contas fixas do mês 🔁';
  if (/guardar|juntar|economiz|\bmeta\b|objetivo|poupan/.test(t))      return 'Para criar uma meta:\nguardar 200 viagem 🎯';
  if (/sal[aá]rio|renda|freelance|recebi|ganho|ganhei|entrou/.test(t)) return 'Para registrar renda:\n+3000 salário';
  // Só sugere registro se claramente não for uma pergunta
  if (!ehPergunta && /dinheiro|gast|paguei|comprei|gastei/.test(t))    return 'Me manda o valor e o que foi:\n50 mercado';
  const fallbacks = [
    "Pode me mandar um gasto ou perguntar sobre o mês.",
    "Me manda o valor e o que foi — ou me pergunta qualquer coisa.",
    "Pode registrar um gasto ou pedir o saldo do mês.",
  ];
  return fallbacks[new Date().getHours() % fallbacks.length];
}

// ── Edição natural de lançamentos ─────────────────────────────────────────────

function parseNaturalEdit(
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

async function findRecentTxByDesc(
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

async function handleNaturalCorrection(
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

async function handleNaturalDelete(
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
