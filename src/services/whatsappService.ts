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
    return { success: false, erro: `Nenhum usuário com telefone ${message.telefone}` };
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

  // ── Parser ────────────────────────────────────────────────────────────────
  log.parser("analisando", { texto: message.texto });

  const parsed = parseTransaction(message.texto);

  if (!parsed) {
    log.parser("nao reconhecido", { texto: message.texto });

    try {
      const sendResult = await whatsapp.sendText({
        to: message.telefone,
        text: "Não entendi. Tente: '120 mercado', '35 gasolina' ou '500 freelance'",
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
  const emoji  = parsed.tipo === "entrada" ? "+" : "-";
  const sinal  = parsed.tipo === "entrada" ? "Entrada" : "Saída";
  const linhasConfirmacao = [
    `Registrado!`,
    `${emoji} R$ ${parsed.valor.toFixed(2)} | ${sinal}`,
    `Categoria: ${parsed.categoria}`,
    `Desc: ${parsed.descricao}`,
  ];

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
  const totalGasto  = Number(gastoRow.rows[0].total);
  const percentual  = Math.round((totalGasto / valorLimite) * 100);

  if (percentual >= 100) {
    return `Você ultrapassou o limite mensal de ${categoria}: R$ ${totalGasto.toFixed(2)} de R$ ${valorLimite.toFixed(2)} (${percentual}%).`;
  }
  if (percentual >= 80) {
    return `Atenção: você já utilizou R$ ${totalGasto.toFixed(2)} de R$ ${valorLimite.toFixed(2)} do limite mensal de ${categoria} (${percentual}%).`;
  }
  return null;
}

async function handleLimiteCommand(user: UserRow, telefone: string, texto: string): Promise<ProcessResult> {
  log.webhook("comando limite", { userId: user.id, texto });

  const match = texto.match(/^limite\s+(.+?)\s+([\d,.]+)$/i);
  if (!match) {
    await whatsapp.sendText({ to: telefone, text: "Formato inválido. Use: limite alimentação 800" });
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

  return {
    success:      true,
    userId:       user.id,
    transacao:    {},
    interpretado: { comando: "limite", categoria, valorLimite },
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
