import pool from "../../db/client";
import { whatsapp } from "../whatsapp";
import { log } from "../../utils/logger";
import { fmtValor, capitalizeFirst } from "../../utils/formatting";
import { fetchPeriodMetrics } from "../reportService";
import { getSession, initSession, getContextualNextStep, type SessionCtx } from "../conversationEngine";
import type { UserRow, ProcessResult } from "../types";

export function isCuriosityPhrase(texto: string): boolean {
  const t = texto.trim();
  if (/\b(saldo|resumo|contas?\s+fix|recorrentes?|metas?|extrato|ranking|parcelas?)\b/i.test(t)) return false;
  if (/^(mostra|mostra\s+a[ií]|explica|me\s+conta|pode\s+falar)[\?!.]*$/i.test(t)) return true;
  return /quero\s+ver|me\s+mostra|como\s+funciona|o\s+que\s+(você|voce|vc)\s+(faz|pode|conseg|d[aá])|o\s+que\s+d[aá]\s+pra\s+fa[çz]|tem\s+mais\s+coisa|quero\s+entender|me\s+explica|o\s+que\s+[eéè]\s+isso|como\s+(uso|usar|fa[çc]o)\b|o\s+que\s+tem\s+(aqui|nesse?\s+bot)?|conta\s+mais|o\s+que\s+voc[eê]\s+conseg|o\s+que\s+mais\s+(posso|d[aá]|consigo)\s+(fazer|ver|usar)|o\s+que\s+(posso|consigo)\s+(fazer|ver|usar)/i.test(t);
}

export function buildFeaturesMenuText(session?: SessionCtx | null): string {
  const usuarioExperiente = (session?.txCount ?? 0) > 10;
  const temRecorrente     = session?.recentActions.includes("created_recurring") ?? false;
  const txCount           = session?.txCount ?? 0;

  const linhas: string[] = [
    "📌 O que posso fazer:",
    "",
    "📊 Saldo e resumo do mês",
    "",
    "💸 Registrar gastos",
  ];

  if (!usuarioExperiente) linhas.push("Ex: mercado, uber, farmácia");

  linhas.push("", "💳 Parcelamentos", "Ex: iPhone 12x de 300", "");

  if (!temRecorrente) {
    linhas.push("🔄 Contas fixas", "Ex: Netflix, aluguel, academia", "");
  }

  linhas.push(
    "⏰ Lembretes de contas",
    "Ex: \"lembra de pagar luz dia 10, 180\"",
    "    \"minhas contas\"  •  \"paguei a luz\"",
    "",
    "🎯 Metas e limites",
    "",
    "✏️ Corrigir ou apagar lançamentos",
    "",
  );

  if (session?.phase === "registering" && txCount > 0) {
    linhas.push(`💡 Você já registrou ${txCount} gasto${txCount > 1 ? "s" : ""} este mês`, "");
  }

  linhas.push("💬 Pode me perguntar do seu jeito 🙂");

  return linhas.join("\n");
}

export function isKnownCommand(texto: string): boolean {
  return /^(saldo|resumo|hoje|semana|ranking|comparar|desafio|previs[aã]o|categorias|ajuda|metas|recorrentes|pr[oó]ximas|apagar|corrigir|top\s*gastos)$/i.test(texto)
      || /^(limite|meta|guardar|recorrente|buscar|extrato)\s+/i.test(texto);
}

// Detecta frases conversacionais/de intenção que NÃO devem virar lançamento automático
const AMBIGUOUS_INTENT_RE = /\bacho\b|\btalvez\b|\bquero\b|\blembr[ae]\b|\blembrar\b|\beconomiz|\bguardar\b|\bjuntar\b|\bplanejo\b|\bpreciso\b|\bobjetivo\b|\bpara\s+(minha|meu)\s/i;

export function isAmbiguousIntent(texto: string): boolean {
  return AMBIGUOUS_INTENT_RE.test(texto.trim());
}

export function buildContextualHint(texto: string, session?: SessionCtx | null): string {
  const t = texto.toLowerCase();
  const ehPergunta    = t.includes("?") || /^(quanto|como|qual|onde|quando|o\s+que|tem\s+algo)\b/.test(t);
  const usuarioAtivo  = (session?.txCount ?? 0) > 0;
  const jaViuSaldo    = session?.recentActions.includes("queried_balance") ?? false;
  const jaCriouMeta   = session?.recentActions.includes("created_goal") ?? false;

  if (!jaViuSaldo && /quanto|sobrou|restou|dispon[ií]vel|\bsaldo\b/.test(t))
    return 'O saldo mostra o que sobrou do mês 💰';
  if (/onde\s+gasto|mais\s+caro|\branking\b/.test(t))
    return 'O ranking mostra onde vai mais o dinheiro 📊';
  if (/meus?\s+gastos?|\bresumo\b|\bm[eê]s\b/.test(t))
    return 'O resumo mostra seus gastos por categoria 🧾';
  if (/\bcontas?\b|recorrente|vencimento|pr[oó]ximas?/.test(t))
    return 'Os recorrentes listam suas contas fixas do mês 🔁';
  if (!jaCriouMeta && /guardar|juntar|economiz|\bmeta\b|objetivo|poupan/.test(t))
    return 'Para criar uma meta:\nguardar 200 viagem 🎯';
  if (/sal[aá]rio|renda|freelance|recebi|ganho|ganhei|entrou/.test(t))
    return 'Para registrar renda:\n+3000 salário';
  if (!ehPergunta && !usuarioAtivo && /dinheiro|gast|paguei|comprei|gastei/.test(t))
    return 'Manda no formato: _valor + descrição_\n💡 _Ex: 50 mercado_ • _35 uber_';
  if (!ehPergunta && usuarioAtivo && /dinheiro|gast|paguei|comprei|gastei/.test(t))
    return 'Manda o valor e a descrição 🙂\n💡 _Ex: 50 mercado_';
  return "Não entendi 🤔 Tenta assim:\n💡 _50 mercado_ (registrar gasto)\n💡 _minhas contas_ (ver lembretes)\n💡 _meus gastos_ (resumo do mês)";
}

export async function handleAjudaCommand(user: UserRow, telefone: string): Promise<ProcessResult> {
  log.webhook("comando ajuda", { userId: user.id });
  try {
    await whatsapp.sendText({ to: telefone, text: buildFeaturesMenuText(getSession(user.id)) });
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

// Mostra dados reais quando o usuário expressa preocupação com gastos
export async function handleSpendingConcern(user: UserRow, telefone: string): Promise<ProcessResult> {
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
export async function handleNextStepSuggestion(user: UserRow, telefone: string): Promise<ProcessResult> {
  const countRow = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`,
    [user.id]
  );
  const txCountDb = Number(countRow.rows[0].count);

  const session = getSession(user.id) ?? await initSession(user.id);
  const text    = getContextualNextStep(session, txCountDb);

  try {
    await whatsapp.sendText({ to: telefone, text });
    log.whatsapp("next_step_suggestion enviado", { to: telefone, userId: user.id, txCountDb, phase: session.phase });
  } catch (err) {
    log.error("falha next_step_suggestion", err, { userId: user.id });
  }
  return { success: false, userId: user.id, erro: "next_step tratado" };
}
