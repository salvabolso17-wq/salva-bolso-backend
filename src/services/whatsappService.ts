import pool from "../db/client";
import { parseTransaction } from "../utils/parseTransaction";
import { fetchPeriodMetrics } from "./reportService";
import { whatsapp } from "./whatsapp";
import { log } from "../utils/logger";
import type { NormalizedMessage } from "../adapters/whatsappAdapters";

interface UserRow {
  id: number;
  telefone: string;
  nome: string | null;
  renda: string;
  renda_extra: string;
}

type ProcessResult =
  | { success: true;  userId: number; transacao: Record<string, unknown>; interpretado: Record<string, unknown> }
  | { success: false; userId?: number; erro: string };

async function findUserByTelefone(telefone: string): Promise<UserRow | null> {
  const normalized = telefone.replace(/[^0-9]/g, "");

  log.user("buscando", { telefone: normalized });

  const result = await pool.query<UserRow>(
    `SELECT id, telefone, nome, renda, renda_extra FROM users
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
    const ehSaudacao = /^(oi|ol[aá]|ola|começar|comecar|menu|ajuda|hi|hello|hey|bom\s*dia|boa\s*tarde|boa\s*noite|start)$/i
      .test(message.texto.trim());

    if (ehSaudacao && isOnboardingEnabled(message.telefone)) {
      log.user("criando usuario via onboarding", { telefone: message.telefone });
      try {
        await pool.query(
          `INSERT INTO users (telefone) VALUES ($1) ON CONFLICT (telefone) DO NOTHING`,
          [message.telefone]
        );
      } catch (err) {
        log.error("falha ao criar usuario no onboarding", err, { telefone: message.telefone });
        return { success: false, erro: "Erro ao criar usuário" };
      }

      const boas_vindas = [
        "👋 Bem-vindo ao Salva Bolso",
        "",
        "Controle seus gastos direto no WhatsApp 💸",
        "",
        "Comece enviando sua renda mensal:",
        "Ex:",
        "3000 salário",
      ].join("\n");

      try {
        await whatsapp.sendText({ to: message.telefone, text: boas_vindas });
        log.whatsapp("onboarding welcome (novo usuario) enviado", { to: message.telefone });
      } catch (err) {
        log.error("falha ao enviar welcome novo usuario", err, { to: message.telefone });
      }

      return { success: false, userId: undefined, erro: "Onboarding novo usuario iniciado" };
    }

    return { success: false, erro: `Nenhum usuário com telefone ${message.telefone}` };
  }

  // ── Pending action check ──────────────────────────────────────────────────
  const pendingRow = await pool.query<{
    action: "apagar" | "corrigir";
    step: "waiting_selection" | "waiting_new_value";
    tx_ids: number[];
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
      const num = parseInt(textoTrim, 10);
      if (!isNaN(num) && num >= 1 && num <= pending.tx_ids.length) {
        const txId = pending.tx_ids[num - 1];
        return pending.action === "apagar"
          ? await handleApagarSelecao(user, message.telefone, txId)
          : await handleCorrigirSelecao(user, message.telefone, txId);
      }
      if (!isKnownCommand(textoTrim)) {
        await whatsapp.sendText({
          to:   message.telefone,
          text: `Envie um número de 1 a ${pending.tx_ids.length}, ou "cancelar".`,
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

    if (count === 0 && isOnboardingEnabled(message.telefone)) {
      const boas_vindas = [
        "👋 Bem-vindo ao Salva Bolso",
        "",
        "Controle seus gastos direto no WhatsApp 💸",
        "",
        "Comece enviando sua renda mensal:",
        "Ex:",
        "3000 salário",
      ].join("\n");
      try {
        await whatsapp.sendText({ to: message.telefone, text: boas_vindas });
        log.whatsapp("onboarding welcome enviado", { to: message.telefone, userId: user.id });
      } catch (err) {
        log.error("falha ao enviar welcome", err, { to: message.telefone });
      }
      return { success: false, userId: user.id, erro: "Onboarding iniciado" };
    }
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
  if (isOnboardingEnabled(message.telefone) && /^\d[\d,.]*$/.test(message.texto.trim())) {
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
  if (parsed.tipo === "entrada" && isOnboardingEnabled(message.telefone)) {
    const countRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`,
      [user.id]
    );
    if (Number(countRow.rows[0].count) === 1) {
      const msg = [
        `💰 Renda registrada: ${fmtValor(parsed.valor)}`,
        "",
        "Agora envie um gasto:",
        "Ex:",
        "120 mercado",
      ].join("\n");
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
    ? [`💰 Entrada registrada: ${fmtValor(parsed.valor)}`, parsed.descricao]
    : [`✅ ${fmtValor(parsed.valor)} • ${parsed.categoria}`, parsed.descricao];

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
    checkAndSendInsights(user.id, message.telefone, parsed.categoria).catch(err =>
      log.error("falha ao verificar insights", err, { userId: user.id })
    );
    setTimeout(() => {
      checkAndSendOnboardingTip(user.id, message.telefone, "saida").catch(err =>
        log.error("falha ao verificar onboarding tip", err, { userId: user.id })
      );
    }, 800);
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

  const linhas = [
    `Saldo de ${meses[now.getMonth()]}/${now.getFullYear()}`,
    "",
    totalRenda > 0
      ? `Renda: R$ ${totalRenda.toFixed(2)}`
      : `Renda: não cadastrada`,
    `Gastos: R$ ${metrics.total_saidas.toFixed(2)}`,
    sobrou >= 0
      ? `Sobrou: R$ ${sobrou.toFixed(2)}`
      : `Sobrou: -R$ ${Math.abs(sobrou).toFixed(2)}`,
  ];

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("saldo enviado", { to: telefone, totalRenda, gastos: metrics.total_saidas, sobrou });
  } catch (err) {
    log.error("falha ao enviar saldo", err, { to: telefone });
  }

  setTimeout(() => {
    checkAndSendOnboardingTip(user.id, telefone, "saldo_usado").catch(err =>
      log.error("falha ao verificar onboarding tip saldo_usado", err, { userId: user.id })
    );
  }, 800);

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
      linhas.push(`${cat.categoria}: R$ ${cat.total.toFixed(2)}`);
    }
    linhas.push("");
    linhas.push(`Total gasto: R$ ${metrics.total_saidas.toFixed(2)}`);
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

const CATEGORIAS_CONHECIDAS = [
  "Alimentação", "Transporte", "Moradia", "Lazer", "Saúde",
  "Educação", "Investimentos", "Receita Extra", "Outros",
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
      text: "🎯 Desafio do dia\n\nRegistre todos os seus gastos de hoje.\nConhecimento é o primeiro passo!",
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

  const row     = result.rows[0];
  const meta    = Number(row.valor_meta);
  const atual   = Number(row.valor_atual);
  const percent = meta > 0 ? Math.round((atual / meta) * 100) : 0;

  const linhas = [
    `🎯 ${fmtValor(valor)} adicionados à meta ${row.nome}`,
    "",
    "Progresso:",
    `${fmtValor(atual)} / ${fmtValor(meta)} (${percent}%)`,
  ];

  if (atual >= meta) {
    linhas.push("", "🏆 Meta concluída!");
  }

  try {
    await whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    log.whatsapp("guardar enviado", { to: telefone, nome: row.nome, atual, meta });
  } catch (err) {
    log.error("falha ao enviar guardar", err, { to: telefone });
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

  const texto = [
    "Comandos disponíveis",
    "",
    "💰 saldo",
    "📊 resumo",
    "📅 hoje",
    "📈 semana",
    "🏆 top gastos",
    "📂 categorias",
    "🎯 metas",
    "📈 previsão",
    "🔁 recorrentes",
    "📅 próximas",
    "🔎 buscar <termo>",
    "❌ apagar",
    "✏️ corrigir",
    "",
    "⚙️ limite alimentação 800",
    "🎯 meta viagem 5000",
    "",
    "Para registrar um gasto:",
    "Ex: 35 gasolina, 120 mercado",
    "",
    "Para registrar uma entrada:",
    "Ex: 1500 salário, 200 freelance",
  ].join("\n");

  try {
    await whatsapp.sendText({ to: telefone, text: texto });
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
  1:  `💡 Envie "saldo" para acompanhar quanto ainda resta no mês.`,
  2:  `📊 Envie "resumo" para ver onde você mais gastou.`,
  3:  `🏆 Envie "ranking" para descobrir suas categorias mais caras.`,
  4:  `🎯 Crie sua primeira meta:\nEx: meta viagem 5000`,
  10: `💡 Use "guardar 200 <nome da meta>" para registrar seu progresso.`,
  11: `📈 Use "comparar" para ver como seus gastos evoluíram mês a mês.`,
  12: `📅 Use "próximas" para ver suas contas recorrentes.`,
};

async function checkAndSendOnboardingTip(userId: number, telefone: string, evento: string): Promise<void> {
  if (!isOnboardingEnabled(telefone)) return;

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
      tipId = 1;   // 1º gasto → saldo
    } else if (n === 8) {
      tipId = 4;   // 8º gasto → criar meta
    } else {
      // ranking: 5+ gastos OU 3+ categorias distintas (o que vier primeiro)
      const catRow = await pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT categoria) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`,
        [userId]
      );
      if (n >= 5 || Number(catRow.rows[0].count) >= 3) tipId = 3;
    }
  } else if (evento === "saldo_usado") {
    tipId = 2;                     // usou saldo → resumo
  } else if (evento === "recorrente_criado") {
    tipId = 12;                    // criou recorrente → próximas
  } else if (evento === "meta_criada") {
    tipId = 10;
  } else if (evento === "limite_criado") {
    tipId = 11;
  }

  if (tipId === null) return;

  const tipText = ONBOARDING_TIPS[tipId];
  if (!tipText) return;

  const inserted = await pool.query(
    `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
     VALUES ($1, 'onboarding', $2, $3)
     ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
    [userId, tipId, LIFETIME]
  );

  if ((inserted.rowCount ?? 0) === 0) return;

  await whatsapp.sendText({ to: telefone, text: tipText });
  log.whatsapp("onboarding tip enviado", { to: telefone, tipId });
}

async function checkAndSendInsights(userId: number, telefone: string, categoria: string): Promise<void> {
  const countRow = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`,
    [userId]
  );
  // Durante onboarding aguarda 10 gastos para não sobrepor as dicas progressivas; fora do onboarding: 3
  const insightThreshold = isOnboardingEnabled(telefone) ? 10 : 3;
  if (Number(countRow.rows[0].count) < insightThreshold) return;

  const now       = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fimMes    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const metrics = await fetchPeriodMetrics(userId, inicioMes, fimMes);
  if (metrics.total_saidas === 0) return;

  const catRow = metrics.gastos_por_categoria.find(
    c => c.categoria.toLowerCase() === categoria.toLowerCase()
  );
  if (!catRow) return;

  const percentual = Math.round((catRow.total / metrics.total_saidas) * 100);
  if (percentual < 50) return;

  const marco  = 50;
  const mesRef = inicioMes;

  const inserted = await pool.query(
    `INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`,
    [userId, categoria, marco, mesRef]
  );

  if ((inserted.rowCount ?? 0) === 0) return;

  await whatsapp.sendText({
    to:   telefone,
    text: `📊 ${categoria} representa ${percentual}% dos seus gastos do mês.`,
  });

  log.whatsapp("insight enviado", { to: telefone, categoria, percentual, marco });
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
      text: "Nenhum recorrente cadastrado.\n\n💡 Ex:\nrecorrente 39 netflix mensal",
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

function isOnboardingEnabled(telefone: string): boolean {
  const raw = process.env.ONBOARDING_WHITELIST ?? "";
  if (!raw.trim()) return false;
  const normalized = telefone.replace(/\D/g, "");
  return raw.split(",")
    .map(n => n.trim().replace(/\D/g, ""))
    .some(n => n && (normalized.endsWith(n) || n.endsWith(normalized)));
}

function isKnownCommand(texto: string): boolean {
  return /^(saldo|resumo|hoje|semana|ranking|comparar|desafio|previs[aã]o|categorias|ajuda|metas|recorrentes|pr[oó]ximas|apagar|corrigir|top\s*gastos)$/i.test(texto)
      || /^(limite|meta|guardar|recorrente|buscar)\s+/i.test(texto);
}

// Detecta frases conversacionais/de intenção que NÃO devem virar lançamento automático
const AMBIGUOUS_INTENT_RE = /\bacho\b|\btalvez\b|\bquero\b|\blembr[ae]\b|\blembrar\b|\beconomiz|\bguardar\b|\bjuntar\b|\bplanejo\b|\bpreciso\b|\bobjetivo\b|\bpara\s+(minha|meu)\s/i;

function isAmbiguousIntent(texto: string): boolean {
  return AMBIGUOUS_INTENT_RE.test(texto.trim());
}

function buildContextualHint(texto: string): string {
  const t = texto.toLowerCase();
  // Contexto de consulta → sugere comando
  if (/quanto|sobrou|restou|dispon[ií]vel|\bsaldo\b/.test(t))      return "💡 Use:\nsaldo";
  if (/onde\s+gasto|mais\s+caro|\branking\b/.test(t))               return "💡 Use:\nranking";
  if (/meus?\s+gastos?|\bresumo\b/.test(t))                         return "💡 Use:\nresumo";
  if (/\bcontas?\b|recorrente|vencimento|pr[oó]ximas?/.test(t))     return "💡 Use:\npróximas";
  // Contexto de movimentação
  if (/guardar|juntar|economiz|\bmeta\b|objetivo|poupan/.test(t))   return "💡 Ex:\nguardar 200 viagem";
  if (/sal[aá]rio|renda|freelance|recebi|ganho|ganhei|entrou/.test(t)) return "💡 Ex:\n+250 salário";
  return "💡 Ex:\n120 mercado";
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
