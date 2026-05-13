"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCuriosityPhrase = isCuriosityPhrase;
exports.buildFeaturesMenuText = buildFeaturesMenuText;
exports.isKnownCommand = isKnownCommand;
exports.isAmbiguousIntent = isAmbiguousIntent;
exports.buildContextualHint = buildContextualHint;
exports.handleAjudaCommand = handleAjudaCommand;
exports.handleSpendingConcern = handleSpendingConcern;
exports.handleNextStepSuggestion = handleNextStepSuggestion;
const client_1 = __importDefault(require("../../db/client"));
const whatsapp_1 = require("../whatsapp");
const logger_1 = require("../../utils/logger");
const formatting_1 = require("../../utils/formatting");
const reportService_1 = require("../reportService");
const conversationEngine_1 = require("../conversationEngine");
function isCuriosityPhrase(texto) {
    const t = texto.trim();
    if (/^(mostra|mostra\s+a[ií]|explica|me\s+conta|pode\s+falar)[\?!.]*$/i.test(t))
        return true;
    return /quero\s+ver|me\s+mostra|como\s+funciona|o\s+que\s+(você|voce|vc)\s+(faz|pode|conseg|d[aá])|o\s+que\s+d[aá]\s+pra\s+fa[çz]|tem\s+mais\s+coisa|quero\s+entender|me\s+explica|o\s+que\s+[eéè]\s+isso|como\s+(uso|usar|fa[çc]o)\b|o\s+que\s+tem\s+(aqui|nesse?\s+bot)?|conta\s+mais|o\s+que\s+voc[eê]\s+conseg|o\s+que\s+mais\s+(posso|d[aá]|consigo)\s+(fazer|ver|usar)|o\s+que\s+(posso|consigo)\s+(fazer|ver|usar)/i.test(t);
}
function buildFeaturesMenuText() {
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
function isKnownCommand(texto) {
    return /^(saldo|resumo|hoje|semana|ranking|comparar|desafio|previs[aã]o|categorias|ajuda|metas|recorrentes|pr[oó]ximas|apagar|corrigir|top\s*gastos)$/i.test(texto)
        || /^(limite|meta|guardar|recorrente|buscar|extrato)\s+/i.test(texto);
}
// Detecta frases conversacionais/de intenção que NÃO devem virar lançamento automático
const AMBIGUOUS_INTENT_RE = /\bacho\b|\btalvez\b|\bquero\b|\blembr[ae]\b|\blembrar\b|\beconomiz|\bguardar\b|\bjuntar\b|\bplanejo\b|\bpreciso\b|\bobjetivo\b|\bpara\s+(minha|meu)\s/i;
function isAmbiguousIntent(texto) {
    return AMBIGUOUS_INTENT_RE.test(texto.trim());
}
function buildContextualHint(texto) {
    const t = texto.toLowerCase();
    const ehPergunta = t.includes("?") || /^(quanto|como|qual|onde|quando|o\s+que|tem\s+algo)\b/.test(t);
    if (/quanto|sobrou|restou|dispon[ií]vel|\bsaldo\b/.test(t))
        return 'O saldo mostra o que sobrou do mês 💰';
    if (/onde\s+gasto|mais\s+caro|\branking\b/.test(t))
        return 'O ranking mostra onde vai mais o dinheiro 📊';
    if (/meus?\s+gastos?|\bresumo\b|\bm[eê]s\b/.test(t))
        return 'O resumo mostra seus gastos por categoria 🧾';
    if (/\bcontas?\b|recorrente|vencimento|pr[oó]ximas?/.test(t))
        return 'Os recorrentes listam suas contas fixas do mês 🔁';
    if (/guardar|juntar|economiz|\bmeta\b|objetivo|poupan/.test(t))
        return 'Para criar uma meta:\nguardar 200 viagem 🎯';
    if (/sal[aá]rio|renda|freelance|recebi|ganho|ganhei|entrou/.test(t))
        return 'Para registrar renda:\n+3000 salário';
    // Só sugere registro se claramente não for uma pergunta
    if (!ehPergunta && /dinheiro|gast|paguei|comprei|gastei/.test(t))
        return 'Me manda o valor e o que foi:\n50 mercado';
    const fallbacks = [
        "Pode me mandar um gasto ou perguntar sobre o mês.",
        "Me manda o valor e o que foi — ou me pergunta qualquer coisa.",
        "Pode registrar um gasto ou pedir o saldo do mês.",
    ];
    return fallbacks[new Date().getHours() % fallbacks.length];
}
async function handleAjudaCommand(user, telefone) {
    logger_1.log.webhook("comando ajuda", { userId: user.id });
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: buildFeaturesMenuText() });
        logger_1.log.whatsapp("ajuda enviado", { to: telefone });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar ajuda", err, { to: telefone });
    }
    return {
        success: true,
        userId: user.id,
        transacao: {},
        interpretado: { comando: "ajuda" },
    };
}
// Mostra dados reais quando o usuário expressa preocupação com gastos
async function handleSpendingConcern(user, telefone) {
    const now = new Date();
    const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const fimMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const metrics = await (0, reportService_1.fetchPeriodMetrics)(user.id, inicioMes, fimMes);
    if (metrics.total_saidas === 0) {
        await whatsapp_1.whatsapp.sendText({
            to: telefone,
            text: "Ainda não tem gastos registrados este mês.",
        });
        return { success: false, userId: user.id, erro: "spending_concern sem dados" };
    }
    const top = metrics.gastos_por_categoria[0];
    const linhas = [
        `${(0, formatting_1.fmtValor)(metrics.total_saidas)} em gastos esse mês.`,
        `Mais em: ${(0, formatting_1.capitalizeFirst)(top?.categoria ?? "—")} — ${(0, formatting_1.fmtValor)(top?.total ?? 0)}`,
    ];
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
        logger_1.log.whatsapp("spending_concern respondido", { to: telefone, userId: user.id });
    }
    catch (err) {
        logger_1.log.error("falha spending_concern", err, { userId: user.id });
    }
    return { success: false, userId: user.id, erro: "spending_concern tratado" };
}
// Responde "e agora?" / "o que mais posso fazer?" com contexto da sessão atual
async function handleNextStepSuggestion(user, telefone) {
    const countRow = await client_1.default.query(`SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`, [user.id]);
    const txCountDb = Number(countRow.rows[0].count);
    const session = (0, conversationEngine_1.getSession)(user.id) ?? (0, conversationEngine_1.initSession)(user.id);
    const text = (0, conversationEngine_1.getContextualNextStep)(session, txCountDb);
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text });
        logger_1.log.whatsapp("next_step_suggestion enviado", { to: telefone, userId: user.id, txCountDb, phase: session.phase });
    }
    catch (err) {
        logger_1.log.error("falha next_step_suggestion", err, { userId: user.id });
    }
    return { success: false, userId: user.id, erro: "next_step tratado" };
}
