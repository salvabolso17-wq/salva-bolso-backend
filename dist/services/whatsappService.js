"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processWhatsAppMessage = processWhatsAppMessage;
const client_1 = __importDefault(require("../db/client"));
const parseTransaction_1 = require("../utils/parseTransaction");
const whatsapp_1 = require("./whatsapp");
const logger_1 = require("../utils/logger");
const conversationEngine_1 = require("./conversationEngine");
const formatting_1 = require("../utils/formatting");
// ── Modules ───────────────────────────────────────────────────────────────────
const premiumGuard_1 = require("./modules/premiumGuard");
const menuBuilder_1 = require("./modules/menuBuilder");
const recurringDetection_1 = require("./modules/recurringDetection");
const insightsEngine_1 = require("./modules/insightsEngine");
const onboarding_1 = require("./modules/onboarding");
// ── Handlers ──────────────────────────────────────────────────────────────────
const reports_1 = require("./handlers/reports");
const goals_1 = require("./handlers/goals");
const transactions_1 = require("./handlers/transactions");
const recurring_1 = require("./handlers/recurring");
const installments_1 = require("./handlers/installments");
const multiline_1 = require("./handlers/multiline");
function firstNameOf(rawName) {
    if (!rawName)
        return null;
    const token = rawName.trim().split(/\s+/)[0];
    return /[a-zA-ZÀ-ÿ]/.test(token) ? token : null;
}
async function findUserByTelefone(telefone) {
    const normalized = telefone.replace(/[^0-9]/g, "");
    logger_1.log.user("buscando", { telefone: normalized });
    const result = await client_1.default.query(`SELECT id, telefone, nome, renda, renda_extra, subscription_status, trial_ends_at, subscription_expires_at, criado_em FROM users
     WHERE REGEXP_REPLACE(telefone, '[^0-9]', '', 'g') = $1
        OR RIGHT(REGEXP_REPLACE(telefone, '[^0-9]', '', 'g'), 11) = RIGHT($1, 11)
        OR RIGHT(REGEXP_REPLACE(telefone, '[^0-9]', '', 'g'), 8)  = RIGHT($1, 8)
     LIMIT 1`, [normalized]);
    const user = result.rows[0] ?? null;
    if (user) {
        logger_1.log.user("encontrado", { id: user.id, nome: user.nome ?? "sem nome", telefone_db: user.telefone });
    }
    else {
        logger_1.log.user("nao encontrado", { telefone: normalized });
    }
    return user;
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
async function checkAndDetectInstallment(userId, telefone, descricao, textoOriginal, valor) {
    try {
        const textoLower = textoOriginal.toLowerCase();
        const descLower = descricao.toLowerCase();
        // Sinal explícito: "6x", "parcelado/a", "2/10"
        const matchX = textoLower.match(/\b(\d{1,2})[xX]\b/);
        const hasExplicit = !!matchX
            || /\bparcelad[ao]\b/.test(textoLower)
            || /\b[1-9]\d?\/[1-9]\d?\b/.test(textoLower);
        // Sinal implícito: keyword conhecida + valor relevante
        const hasImplicit = valor > 200 && INSTALLMENT_KEYWORDS.some(kw => descLower.includes(kw));
        if (!hasExplicit && !hasImplicit)
            return false;
        const sentinel = `inst_${descLower.replace(/\s+/g, "_").slice(0, 45)}`;
        const LIFETIME = new Date("2000-01-01");
        const inserted = await client_1.default.query(`INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`, [userId, sentinel, LIFETIME]);
        if ((inserted.rowCount ?? 0) === 0)
            return false;
        // Mensagem: ecoa número de parcelas se detectado, senão pergunta genérica
        const numParcelas = matchX ? Number(matchX[1]) : null;
        const texto = numParcelas
            ? `Parcelado em ${numParcelas}x?`
            : "Isso foi parcelado?";
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: texto });
        logger_1.log.whatsapp("deteccao parcelamento enviada", { to: telefone, userId, descricao, numParcelas });
        return true;
    }
    catch (err) {
        logger_1.log.error("falha deteccao parcelamento", err, { userId });
        return false;
    }
}
// Interpreta intenção conversacional antes de cair no parser ou no hint genérico
async function tryHandleIntent(user, telefone, texto) {
    const t = texto.trim().toLowerCase();
    const temNumero = /\d/.test(t);
    // "?" / "??" / ponto de interrogação solto → guia próximo passo
    if (/^[?\s!.]+$/.test(t)) {
        return await (0, menuBuilder_1.handleNextStepSuggestion)(user, telefone);
    }
    // "o que é isso?" → explica o bot
    if (!temNumero && /^(que\s+[eéè]\s+isso|o\s+que\s+[eéè]\s+isso)[\?!.]*$/.test(t)) {
        return await (0, menuBuilder_1.handleAjudaCommand)(user, telefone);
    }
    // Correção ou deleção por linguagem natural (sem guard !temNumero — captura frases com valor)
    const _naturalEdit = (0, transactions_1.parseNaturalEdit)(texto.trim());
    if (_naturalEdit) {
        if (_naturalEdit.tipo === "corrigir") {
            return await (0, transactions_1.handleNaturalCorrection)(user, telefone, _naturalEdit.descBusca, _naturalEdit.novoValor);
        }
        else {
            return await (0, transactions_1.handleNaturalDelete)(user, telefone, _naturalEdit.descBusca);
        }
    }
    // Confusão leve → resposta curta, sem menu
    if (!temNumero &&
        /n[aã]o\s+(estou?|t[oô]|to)\s+entendendo|n[aã]o\s+entendi|entendi\s+foi\s+nada|n[aã]o\s+(sei|entendo)\s+(nada|nada\s+disso)|como\s+assim|n[aã]o\s+peguei/.test(t)) {
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
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: guia });
        }
        catch (err) {
            logger_1.log.error("falha light_confusion", err, { userId: user.id });
        }
        return { success: false, userId: user.id, erro: "light_confusion tratada" };
    }
    // Intenção de ajuda
    if (!temNumero &&
        /^(preciso\s+de\s+(ajuda|help|suporte)|me\s+(ajuda|ajude|ensina|ensine)|como\s+(funciona|uso|usar|fa[çc]o)|o\s+que\s+(posso|d[aá]|consigo)\s+(fazer|ver|usar)|n[aã]o\s+sei(\s+o\s+que\s+fazer)?(\s+por\s+onde\s+come[çc]ar)?|o\s+que\s+tem\s+(aqui|nesse\s+bot)|quero\s+(aprender|entender|saber\s+mais))[\?!.]*$/.test(t)) {
        return await (0, menuBuilder_1.handleAjudaCommand)(user, telefone);
    }
    // Preocupação com gastos → mostra dado real do mês
    if (!temNumero &&
        /acho\s+que\s+gastei\s+(muito|demais)|(estou?|t[oô])\s+gastando\s+(muito|demais)|(estou?\s+|t[oô]\s+|to\s+)?no\s+vermelho|gastei\s+(demais|muito)/.test(t)) {
        return await (0, menuBuilder_1.handleSpendingConcern)(user, telefone);
    }
    // Incerteza / "e agora?"
    if (!temNumero &&
        /^(e\s+agora|e\s+a[ií]|o\s+que\s+fa[çc]o(\s+agora)?|o\s+que\s+(fazer|devo\s+fazer)|o\s+que\s+(você|voce|vc)\s+(sugere|recomenda))[\?!.]*$/.test(t)) {
        return await (0, menuBuilder_1.handleNextStepSuggestion)(user, telefone);
    }
    // Intenção de melhora financeira → mostra contexto real do mês
    if (!temNumero &&
        /preciso\s+(economizar|cortar|reduzir|gastar\s+menos)|quero\s+(economizar|cortar|gastar\s+menos|melhorar(\s+meus\s+gastos|\s+minhas\s+finan[çc]as)?)|como\s+(melhoro|corto|reduzo|controlo\s+melhor|gastar\s+menos)/.test(t)) {
        return await (0, menuBuilder_1.handleSpendingConcern)(user, telefone);
    }
    // Pressão financeira / desabafo → dados sem julgamento
    if (!temNumero &&
        /t[oô]\s+(no\s+limite|apertad[ao]|tenso|zerado|pelado)|(m[eê]s|semana)\s+(dif[ií]cil|pesad[ao]|complicad[ao])|pouco\s+dinheiro|sem\s+dinheiro|t[oô]\s+endividad[ao]/.test(t)) {
        return await (0, menuBuilder_1.handleSpendingConcern)(user, telefone);
    }
    // Exagero emocional / perda de controle → dados sem julgamento
    if (!temNumero &&
        /acho\s+que\s+(exagerei|exager[ao]|foi\s+demais)|perdi\s+(o\s+)?controle|(saiu|t[aá])\s+(fora|do)\s+controle|t[oô]\s+preocupado\s+(com\s+os?\s+gastos?|com\s+dinheiro)/.test(t)) {
        return await (0, menuBuilder_1.handleSpendingConcern)(user, telefone);
    }
    // Continuidade: quer continuar, ver mais ou registrar outro
    if (!temNumero &&
        /mais\s+alguma\s+coisa|tem\s+mais|algo\s+mais|quero\s+(registrar|ver|fazer)\s+(outro|mais|algo)|o\s+que\s+(mais\s+)?(posso|d[aá])\s+(ver|consultar|fazer)/.test(t)) {
        return await (0, menuBuilder_1.handleNextStepSuggestion)(user, telefone);
    }
    // Dia positivo / gastou pouco → ack leve, sem exagero
    if (!temNumero &&
        /hoje\s+(foi\s+)?(bom|tranquilo|leve|econ[oô]mico)|gastei\s+(pouco|bem\s+pouco|quase\s+nada)|economizei\s+(hoje|bastante)/.test(t)) {
        const acks = ["Bom sinal.", "Vai acumulando.", "Dias leves também contam."];
        const pick = acks[new Date().getHours() % acks.length];
        try {
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: pick });
            logger_1.log.whatsapp("positive_ack enviado", { to: telefone, userId: user.id });
        }
        catch (err) {
            logger_1.log.error("falha positive_ack", err, { userId: user.id });
        }
        return { success: false, userId: user.id, erro: "positive_ack tratado" };
    }
    // Recusa / agradecimento → encerra naturalmente sem insistir
    if (!temNumero &&
        /^(n[aã]o\s+quero(\s+ver\s+\S+)?|n[aã]o\s+agora|depois|por\s+enquanto\s+n[aã]o|obrigad[ao]|brigad[ao]|valeu|tudo\s+bem|td\s+bem|blz)[\?!.]*$/.test(t)) {
        const acks = ["Tudo bem.", "Ok. 👋", "Tranquilo."];
        const pick = acks[new Date().getHours() % acks.length];
        try {
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: pick });
            logger_1.log.whatsapp("ack conversacional enviado", { to: telefone, userId: user.id });
        }
        catch (err) {
            logger_1.log.error("falha ack conversacional", err, { userId: user.id });
        }
        return { success: false, userId: user.id, erro: "ack reconhecido" };
    }
    // Consulta de saldo via linguagem natural
    if (!temNumero &&
        /quanto\s+(tenho|sobrou|resta|restou|tenho\s+de\s+saldo)|quanto\s+gastei\s+(esse|este|no)\s+m[eê]s|o\s+que\s+sobrou|quanto\s+est[aá]\s+sobrando/.test(t)) {
        return await (0, reports_1.handleSaldoCommand)(user, telefone);
    }
    // Consulta de gastos via linguagem natural
    if (!temNumero &&
        /(me\s+mostra|ver|quero\s+ver|mostrar)\s+(meus?\s+gastos?|o\s+resumo)|meus?\s+gastos?\s+(do\s+m[eê]s|de\s+hoje|essa\s+semana)/.test(t)) {
        return await (0, reports_1.handleResumoCommand)(user, telefone);
    }
    // Intenção de apagar via linguagem natural
    if (!temNumero &&
        /quero\s+apagar|apagar\s+o\s+[uú]ltimo|remover\s+(o\s+)?[uú]ltimo|deletar\s+(o\s+)?[uú]ltimo/.test(t)) {
        return await (0, transactions_1.handleApagarCommand)(user, telefone);
    }
    // Erro no registro → orienta corrigir
    if (!temNumero &&
        /registrei\s+errado|coloquei\s+errado|lancei\s+errado|esqueci\s+de\s+registrar|n[aã]o\s+registrei/.test(t)) {
        try {
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: "Para corrigir um valor, manda: corrigir\nPara apagar um lançamento: apagar" });
            logger_1.log.whatsapp("orientacao corrigir enviada", { to: telefone, userId: user.id });
        }
        catch (err) {
            logger_1.log.error("falha orientacao corrigir", err, { userId: user.id });
        }
        return { success: false, userId: user.id, erro: "orientacao corrigir" };
    }
    // Ack positivo de economia
    if (!temNumero &&
        /t[oô]\s+economizando|estou?\s+economizando|consegui\s+economizar|economizei\s+(bem|bastante|muito)/.test(t)) {
        const acks = ["Bom. Vai acumulando.", "Cada real conta.", "Vai acumulando."];
        const pick = acks[new Date().getHours() % acks.length];
        try {
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: pick });
            logger_1.log.whatsapp("positive_eco_ack enviado", { to: telefone, userId: user.id });
        }
        catch (err) {
            logger_1.log.error("falha positive_eco_ack", err, { userId: user.id });
        }
        return { success: false, userId: user.id, erro: "positive_eco_ack" };
    }
    // "como tá meu mês?" / "como está o mês?" / "como anda a situação?" → resumo
    if (!temNumero &&
        /como\s+(t[aá]|est[aá]|anda|foi|ficou)\s+(meu|o|a\s+minha\s+)?(m[eê]s|financ|conta|situac|semana)/i.test(t)) {
        return await (0, reports_1.handleResumoCommand)(user, telefone);
    }
    // "quanto gastei hoje?" → hoje
    if (!temNumero &&
        /quanto\s+(gastei|gasto|saiu|foi)\s+(hoje|de\s+hoje|nesse?\s+dia)/i.test(t)) {
        return await (0, reports_1.handleHojeCommand)(user, telefone);
    }
    // "qual meu maior gasto?" / "onde gastei mais?" / "onde vai meu dinheiro?" → ranking
    if (!temNumero &&
        /(qual\s+(é\s+o\s+)?meu\s+maior\s+gasto|onde\s+gastei\s+mais|onde\s+vai\s+(meu\s+)?dinheiro|maior\s+gasto\s+do\s+m[eê]s|onde\s+(gasto|t[oô])\s+gastando\s+mais|cat[eé]goria\s+mais\s+(cara|alta|pesada))/i.test(t)) {
        return await (0, reports_1.handleRankingCommand)(user, telefone);
    }
    // "tem algo pesado esse mês?" / "tem algo caro?" → spending concern
    if (!temNumero &&
        /(tem\s+algo\s+(pesado|caro|alto|excessivo|demais)|o\s+que\s+(t[aá]|est[aá])\s+(pesando|alto|caro|pesad[ao])|t[aá]\s+(pesado|caro|alto)|o\s+que\s+t[aá]\s+pesando)/i.test(t)) {
        return await (0, menuBuilder_1.handleSpendingConcern)(user, telefone);
    }
    // "quanto sobrou esse mês?" / "como tá o saldo?" → saldo
    if (!temNumero &&
        /(como\s+(t[aá]|est[aá]|anda)\s+o\s+(saldo|dinheiro|que\s+sobrou)|quanto\s+sobrou\s+(esse|este|no)\s+m[eê]s)/i.test(t)) {
        return await (0, reports_1.handleSaldoCommand)(user, telefone);
    }
    // ── Follow-up contextual ──────────────────────────────────────────────────
    // Interpreta frases curtas/ambíguas com base no último comando mostrado.
    const _sessCtx = (0, conversationEngine_1.getSession)(user.id);
    const _lastCmd = _sessCtx?.lastCommand ?? "";
    // "quais eu tenho?" / "o que eu tenho?" / "quantos tenho?" → contexto do último comando
    if (!temNumero &&
        /^(quais?\s+(eu\s+)?tenho|o\s+que\s+eu\s+tenho|quantos?\s+(eu\s+)?tenho|tenho\s+algum[ao]?)[\?!.]*$/i.test(t)) {
        if (/recorrente|proxima/.test(_lastCmd)) {
            (0, conversationEngine_1.setLastCommand)(user.id, "recorrentes");
            return await (0, recurring_1.handleRecorrentesCommand)(user, telefone);
        }
        if (/meta/.test(_lastCmd)) {
            (0, conversationEngine_1.setLastCommand)(user.id, "metas");
            return await (0, goals_1.handleMetasCommand)(user, telefone);
        }
        // Default: recorrentes (pergunta mais comum fora de contexto)
        (0, conversationEngine_1.setLastCommand)(user.id, "recorrentes");
        return await (0, recurring_1.handleRecorrentesCommand)(user, telefone);
    }
    // "meus gastos" / "minha situação" → resumo do mês
    if (!temNumero &&
        /^(meus?\s+gastos?|minha\s+situa[çc][aã]o|meu\s+financeiro|como\s+t[aá]\s+meu\s+dinheiro)[\?!.]*$/i.test(t)) {
        (0, conversationEngine_1.setLastCommand)(user.id, "resumo");
        return await (0, reports_1.handleResumoCommand)(user, telefone);
    }
    // "meus recorrentes" / "minhas metas" → shortcuts naturais
    if (!temNumero &&
        /^(meus?\s+recorrentes?|minhas?\s+recorrentes?|recorrentes?\s+que\s+eu\s+tenho)[\?!.]*$/i.test(t)) {
        (0, conversationEngine_1.setLastCommand)(user.id, "recorrentes");
        return await (0, recurring_1.handleRecorrentesCommand)(user, telefone);
    }
    if (!temNumero &&
        /^(e\s+)?(minhas?\s+metas?|meus?\s+objetivos?|metas?\s+que\s+eu\s+tenho|metas?|objetivos?|sonhos?|o\s+que\s+(estou?|t[oô])\s+guardando|quanto\s+(guardei|juntei|pousei|economizei\s+at[eé]?\s+agora)|onde\s+est[aã]o\s+(minhas?\s+)?metas?|quais?\s+(s[aã]o\s+)?(minhas?\s+)?metas?)[\?!.]*$/i.test(t)) {
        (0, conversationEngine_1.setLastCommand)(user.id, "metas");
        return await (0, goals_1.handleMetasCommand)(user, telefone);
    }
    // "quanto gasto com recorrentes?", "qual o total de recorrentes?", "quanto são os recorrentes?"
    if (!temNumero &&
        /quanto\s+(eu\s+)?(gasto|pago)\s+(com\s+)?recorrentes?|total\s+de\s+recorrentes?|quanto\s+s[aã]o\s+(os\s+)?recorrentes?|quanto\s+(custa|custam)\s+(os\s+)?recorrentes?/.test(t)) {
        return await (0, reports_1.handleRecorrentesTotalCommand)(user, telefone);
    }
    // "quanto gasto por mês?" sem mencionar recorrentes — usa lastContext para desambiguar
    if (!temNumero &&
        /quanto\s+(eu\s+)?(gasto|pago|saem?|[eéè])\s+por\s+m[eê]s[?!.]*$/.test(t) &&
        (0, conversationEngine_1.getLastContext)(user.id) === "recurring") {
        return await (0, reports_1.handleRecorrentesTotalCommand)(user, telefone);
    }
    // "extrato" / "ver extrato" / "meu extrato" → extrato do mês atual
    if (!temNumero &&
        /^(extrato|ver\s+extrato|meu\s+extrato|quero\s+(ver\s+)?o?\s*extrato)[\?!.]*$/i.test(t)) {
        const mesAtual = formatting_1.MESES_NOME[new Date().getMonth() + 1];
        return await (0, reports_1.handleExtratoCommand)(user, telefone, `extrato ${mesAtual}`);
    }
    // "buscar" / "buscar gastos" / "quero buscar" → pede o termo
    if (!temNumero &&
        /^(buscar(\s+gastos?)?|quero\s+buscar|quero\s+procurar|procurar\s+gastos?)[\?!.]*$/i.test(t)) {
        try {
            await whatsapp_1.whatsapp.sendText({
                to: telefone,
                text: "O que quer buscar?\n\nEx: buscar mercado",
            });
        }
        catch (err) {
            logger_1.log.error("falha ao enviar hint buscar", err, { userId: user.id });
        }
        return { success: false, userId: user.id, erro: "buscar sem termo" };
    }
    // "meus limites" / "quero ver meu limite" / "quais limites tenho" → lista limites
    if (!temNumero &&
        /meus?\s+limites?|quero\s+(ver\s+)?(meu[s]?\s+)?limites?|quais?\s+(limites?\s+)?(eu\s+)?tenho|ver\s+limites?/i.test(t)) {
        return await (0, reports_1.handleListLimitsCommand)(user, telefone);
    }
    // Atualização de renda via linguagem natural: "minha renda é 4000", "recebo 3000", "meu salário mudou"
    if (/recebo\s+[\d]|minha\s+renda\s+[eéè\s]|meu\s+sal[aá]rio\s+(mudou|[eéè\s]|[eé]\s)|ganho\s+[\d]|renda\s+de\s+[\d]|sal[aá]rio\s+de\s+[\d]/i.test(t)) {
        const m = t.match(/[\d][0-9.,]*/);
        if (m) {
            const novaRenda = (0, parseTransaction_1.parseValor)(m[0]);
            if (novaRenda > 0) {
                try {
                    await client_1.default.query(`UPDATE users SET renda = $1 WHERE id = $2`, [novaRenda, user.id]);
                    const fmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(novaRenda);
                    await whatsapp_1.whatsapp.sendText({ to: telefone, text: `Anotado 🙂 Renda atualizada para ${fmt}.` });
                    logger_1.log.whatsapp("renda atualizada via intent", { to: telefone, userId: user.id, novaRenda });
                }
                catch (err) {
                    logger_1.log.error("falha ao atualizar renda via intent", err, { userId: user.id });
                }
                return { success: false, userId: user.id, erro: "renda atualizada" };
            }
        }
    }
    return null;
}
async function processWhatsAppMessage(message) {
    const provider = process.env.WHATSAPP_PROVIDER ?? "mock";
    logger_1.log.webhook("iniciando processamento", { provider_envio: provider });
    // ── Anti-duplicidade — insere messageId atomicamente ─────────────────────
    if (message.messageId) {
        try {
            const dedup = await client_1.default.query(`INSERT INTO processed_messages (message_id, telefone)
         VALUES ($1, $2)
         ON CONFLICT (message_id) DO NOTHING`, [message.messageId, message.telefone]);
            if (dedup.rowCount === 0) {
                logger_1.log.duplicate("messageId já processado, descartando", { messageId: message.messageId });
                return { success: false, erro: "Mensagem duplicada" };
            }
        }
        catch (err) {
            logger_1.log.error("falha na verificacao de duplicidade, prosseguindo sem dedup", err, { messageId: message.messageId });
        }
    }
    // ── Busca usuário ─────────────────────────────────────────────────────────
    let user;
    try {
        user = await findUserByTelefone(message.telefone);
    }
    catch (err) {
        logger_1.log.error("falha ao buscar usuario no banco", err, { telefone: message.telefone });
        return { success: false, erro: "Erro interno ao buscar usuário" };
    }
    if (!user) {
        const textoNew = message.texto.trim();
        const parsedFirst = (0, parseTransaction_1.parseTransaction)(textoNew);
        const isCommandFirst = (0, menuBuilder_1.isKnownCommand)(textoNew);
        try {
            const nomeNovo = firstNameOf(message.pushName);
            if (nomeNovo) {
                const insertRes = await client_1.default.query(`INSERT INTO users (telefone, nome, trial_ends_at)
           VALUES ($1, $2, NOW() + INTERVAL '7 days')
           ON CONFLICT (telefone) DO UPDATE SET nome = $2 WHERE users.nome IS DISTINCT FROM $2
           RETURNING id`, [message.telefone, nomeNovo]);
                user = insertRes.rows[0];
            }
            else {
                const insertRes = await client_1.default.query(`INSERT INTO users (telefone, trial_ends_at)
           VALUES ($1, NOW() + INTERVAL '7 days')
           ON CONFLICT (telefone) DO NOTHING
           RETURNING id`, [message.telefone]);
                user = insertRes.rows[0];
            }
        }
        catch (err) {
            logger_1.log.error("falha ao criar usuario no onboarding", err, { telefone: message.telefone });
            return { success: false, erro: "Erro ao criar usuário" };
        }
        if (!user) {
            // Just in case it existed but `ON CONFLICT DO NOTHING` returned nothing (shouldn't happen with our query, but good to be safe)
            try {
                user = await findUserByTelefone(message.telefone);
            }
            catch (e) { }
            if (!user)
                return { success: false, erro: "Erro ao carregar usuário" };
        }
        if (parsedFirst || isCommandFirst) {
            // Fast-track: usuário já sabe o que quer → processa direto, sem tutorial
            logger_1.log.user("fast-track onboarding — processando direto", { telefone: message.telefone, userId: user.id });
            // Continua no fluxo normal abaixo
        }
        else {
            // Flow guiado: Boas-vindas -> pede renda
            const nome = firstNameOf(message.pushName);
            const saudacao = nome ? `Oi, ${nome}! 👋` : `Oi! 👋`;
            const boas_vindas = [
                saudacao,
                "Bem-vindo ao *Salva Bolso*! ✨",
                "",
                "Para eu te ajudar a controlar seu dinheiro, qual a sua *renda mensal aproximada*? 💰",
                "",
                "💡 _Ex: 3500_",
                "",
                "_(Se não quiser informar agora, é só mandar 'pular' ⏭️)_"
            ].join("\n");
            await client_1.default.query(`INSERT INTO pending_actions (user_id, action, step, tx_ids)
         VALUES ($1, 'onboarding', 'waiting_onboarding_renda', '[]'::jsonb)
         ON CONFLICT (user_id) DO UPDATE
           SET action = 'onboarding', step = 'waiting_onboarding_renda', tx_ids = '[]'::jsonb,
               selected_tx_id = NULL, expires_at = NOW() + INTERVAL '1 hour'`, [user.id]);
            try {
                await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: boas_vindas });
                logger_1.log.whatsapp("onboarding guiado welcome enviado", { to: message.telefone });
            }
            catch (err) {
                logger_1.log.error("falha ao enviar welcome guiado", err, { to: message.telefone });
            }
            return { success: false, userId: user.id, erro: "Onboarding guiado iniciado" };
        }
    }
    // ── Controle de acesso (trial / active / expired) — modo limitado ────────
    const _ativo = (0, premiumGuard_1.isSubscriptionActive)(user);
    logger_1.log.webhook("controle de acesso", {
        userId: user.id,
        status: user.subscription_status,
        trial_ends_at: user.trial_ends_at?.toISOString() ?? null,
        subscription_expires_at: user.subscription_expires_at?.toISOString() ?? null,
        ativo: _ativo,
    });
    if (!_ativo) {
        const textoTrim = message.texto.trim();
        const comandoBloq = (0, premiumGuard_1.isBlockedFreemium)(textoTrim);
        // Leitura básica explícita é permitida. Tudo que altera o banco ou é premium é bloqueado.
        const apenasLeituraBasica = /^(saldo|resumo|hoje|semana|extrato|menu|ajuda)$/i.test(textoTrim) || /^(buscar|extrato)\s+/i.test(textoTrim);
        logger_1.log.webhook("acesso negado — verificando tipo acesso restrito", { textoTrim, comandoBloq, apenasLeituraBasica });
        if (!apenasLeituraBasica) {
            const expirouEm = user.subscription_expires_at ?? user.trial_ends_at ?? new Date();
            let mostrouAvisoInicial = false;
            try {
                mostrouAvisoInicial = await (0, premiumGuard_1.checkAndSendExpirationNotice)(user.id, message.telefone, expirouEm);
            }
            catch (err) {
                logger_1.log.error("falha no expiracao notice strict", err, { userId: user.id });
            }
            // Se não mostrou o aviso completo agora, mostra as versões curtas
            if (!mostrouAvisoInicial) {
                let txtCurto = "Atenção: acesso limitado.";
                if (comandoBloq) {
                    txtCurto = `🔒 Função exclusiva do Premium.\n\nhttps://salva-bolso-backend-salvabolso.h5prml.easypanel.host/premium-checkout.html`;
                }
                else {
                    txtCurto = `🔒 Registro de novos gastos disponível no Premium.\n\nhttps://salva-bolso-backend-salvabolso.h5prml.easypanel.host/premium-checkout.html`;
                }
                try {
                    await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: txtCurto });
                }
                catch (err) {
                    logger_1.log.error("falha no envio do block aviso curto", err, { userId: user.id });
                }
            }
            return { success: false, userId: user.id, erro: "Acesso bloqueado pós-trial" };
        }
    }
    // ── Pending action check ──────────────────────────────────────────────────
    const pendingRow = await client_1.default.query(`SELECT action, step, tx_ids, selected_tx_id
     FROM pending_actions
     WHERE user_id = $1 AND expires_at > NOW()`, [user.id]);
    if (pendingRow.rows.length > 0) {
        const pending = pendingRow.rows[0];
        const textoTrim = message.texto.trim();
        // Skip onboarding cancel - users shouldn't "cancel" the guided onboarding using the command, they can "pular" instead, which is handled in the handler
        if (/^cancelar$/i.test(textoTrim) && pending.action !== "onboarding") {
            await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
            await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: "Ação cancelada." });
            return { success: false, userId: user.id, erro: "Ação cancelada" };
        }
        if (pending.action === "onboarding" && pending.step === "waiting_onboarding_renda") {
            return await (0, onboarding_1.handleOnboardingRenda)(user, message.telefone, textoTrim);
        }
        else if (pending.action === "onboarding" && pending.step === "waiting_onboarding_fixas") {
            return await (0, onboarding_1.handleOnboardingFixas)(user, message.telefone, textoTrim);
        }
        else if (pending.step === "waiting_selection") {
            const txIds = pending.tx_ids;
            const num = parseInt(textoTrim, 10);
            if (!isNaN(num) && num >= 1 && num <= txIds.length) {
                const txId = txIds[num - 1];
                return pending.action === "apagar"
                    ? await (0, transactions_1.handleApagarSelecao)(user, message.telefone, txId)
                    : await (0, transactions_1.handleCorrigirSelecao)(user, message.telefone, txId);
            }
            if (!(0, menuBuilder_1.isKnownCommand)(textoTrim)) {
                await whatsapp_1.whatsapp.sendText({
                    to: message.telefone,
                    text: `Envie um número de 1 a ${txIds.length}, ou "cancelar".`,
                });
                return { success: false, userId: user.id, erro: "Aguardando seleção" };
            }
            // Comando reconhecido → cancela pending e continua abaixo
            await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
        }
        else if (pending.action === "confirmar_recorrente_multi" && pending.step === "waiting_selection_multi") {
            const isNegative = /^(não|nao|n|no|agora\s*não|agora\s*nao|depois|nenhum|nenhuma|nada|por\s+enquanto|dispenso|obrigad[ao])[\?!.]*$/i.test(textoTrim);
            if (isNegative) {
                await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
                await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: "Tudo bem 🙂" });
                return { success: false, userId: user.id, erro: "Recorrentes rejeitados" };
            }
            else if ((0, menuBuilder_1.isKnownCommand)(textoTrim)) {
                await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
            }
            else {
                return await (0, recurring_1.handleConfirmarRecorrenteMulti)(user, message.telefone, textoTrim, pending.tx_ids);
            }
        }
        else if (pending.step === "waiting_new_value") {
            if (!(0, menuBuilder_1.isKnownCommand)(textoTrim)) {
                return await (0, transactions_1.handleCorrigirNovoValor)(user, message.telefone, message.texto, pending.selected_tx_id);
            }
            // Comando reconhecido → cancela pending e continua abaixo
            await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
        }
        else if (pending.step === "waiting_renda") {
            // Skip explícito → cancela e segue
            const skipRenda = /^(n[aã]o\s+sei|n[aã]o\s+tenho|sem\s+renda|pula|pular|depois|n[aã]o\s+quero|prefiro\s+n[aã]o|ignore|ignora|skip)[\?!.]*$/i.test(textoTrim);
            if (skipRenda) {
                await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
                try {
                    await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: "Tudo bem 🙂\nSempre que quiser informar, manda: recebo 3000" });
                }
                catch (_) { /* silent */ }
                return { success: false, userId: user.id, erro: "renda ignorada pelo usuario" };
            }
            // Gasto explícito (com descrição) cancela o contexto de renda e processa normalmente
            // Número puro (ex: "3000") é renda, não gasto — cai em handleNovoMesRenda abaixo
            const parsedAsExpense = (0, parseTransaction_1.parseTransaction)(textoTrim);
            const isPureNumber = /^\d[\d,.]*$/.test(textoTrim);
            if (parsedAsExpense && parsedAsExpense.tipo === "saida" && !isPureNumber) {
                await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
                // fall through para registro normal
            }
            else if (!(0, menuBuilder_1.isKnownCommand)(textoTrim)) {
                return await (0, onboarding_1.handleNovoMesRenda)(user, message.telefone, textoTrim);
            }
            else {
                await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
            }
        }
        else if (pending.step === "waiting_carryover") {
            if (textoTrim === "1" || textoTrim === "2") {
                return await (0, onboarding_1.handleNovoMesCarryover)(user, message.telefone, textoTrim, pending.tx_ids);
            }
            if (!(0, menuBuilder_1.isKnownCommand)(textoTrim)) {
                await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: "Responda:\n1️⃣ Sim\n2️⃣ Não" });
                return { success: false, userId: user.id, erro: "Aguardando escolha carryover" };
            }
            await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
        }
        else if (pending.action === "confirmar_recorrente" && pending.step === "waiting_confirmation") {
            const isAffirmative = /^(sim|s|yes|pode|quero|claro|ótimo|otimo|isso|exato|afirm|ok|beleza|bora|vai|certo|perfeito|tá|ta|todos|tudo|todas)[\?!.]*$/i.test(textoTrim);
            const isNegative = /^(não|nao|n|no|agora\s*não|agora\s*nao|depois|por\s+enquanto|dispenso|obrigad[ao])[\?!.]*$/i.test(textoTrim);
            if (isAffirmative) {
                return await (0, recurring_1.handleConfirmarRecorrente)(user, message.telefone, pending.tx_ids);
            }
            if (isNegative || (0, menuBuilder_1.isKnownCommand)(textoTrim)) {
                await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
                if (isNegative) {
                    await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: "Tudo bem 🙂" });
                    return { success: false, userId: user.id, erro: "Recorrente rejeitado" };
                }
                // Comando reconhecido → cancela pending e continua abaixo
            }
            else {
                // Nem sim nem não nem comando → reitera a pergunta
                await whatsapp_1.whatsapp.sendText({
                    to: message.telefone,
                    text: "Responde com sim ou não 🙂",
                });
                return { success: false, userId: user.id, erro: "Aguardando confirmação recorrente" };
            }
        }
        else if (pending.action === "registrar_parcela" && pending.step === "waiting_parcela_valor") {
            if (!(0, menuBuilder_1.isKnownCommand)(textoTrim)) {
                return await (0, installments_1.handleRegistrarParcelaValor)(user, message.telefone, textoTrim, pending.tx_ids);
            }
            await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
        }
    }
    // ── Conversation Engine — Intent + Context gates ─────────────────────────
    {
        const _session = (0, conversationEngine_1.initSession)(user.id);
        const _intent = (0, conversationEngine_1.classifyIntent)(message.texto.trim());
        const _isNew = !!user.criado_em
            && Date.now() - new Date(user.criado_em).getTime() < 10 * 60 * 1000;
        // Silence new users in onboarding window for pure chit-chat only
        // "unknown" is intentionally excluded — unknown messages may be installments or natural-language expenses
        if (_isNew && _session.txCount === 0 && _intent === "casual") {
            logger_1.log.webhook("conv engine: silencio onboarding", { userId: user.id, intent: _intent });
            return { success: false, userId: user.id, erro: "Conv engine: silencio onboarding" };
        }
        // Guide confused users — show menu or a lighter hint if menu was recent
        if (_intent === "confused") {
            const menuAge = _session.seenMenuAt
                ? Date.now() - _session.seenMenuAt.getTime()
                : Infinity;
            if (menuAge > 3 * 60 * 1000) {
                try {
                    await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: (0, menuBuilder_1.buildFeaturesMenuText)() });
                    (0, conversationEngine_1.recordAction)(user.id, "showed_menu");
                    logger_1.log.whatsapp("conv engine: menu para usuario confuso", { to: message.telefone, userId: user.id });
                }
                catch (err) {
                    logger_1.log.error("falha ao enviar menu (confuso)", err, { userId: user.id });
                }
            }
            else {
                try {
                    await whatsapp_1.whatsapp.sendText({
                        to: message.telefone,
                        text: "Pode usar naturalmente 🙂\n\nEx:\n• 50 mercado\n• quanto sobrou?\n• resumo\n• ranking",
                    });
                    logger_1.log.whatsapp("conv engine: hint leve para usuario confuso", { to: message.telefone, userId: user.id });
                }
                catch (err) {
                    logger_1.log.error("falha ao enviar hint (confuso)", err, { userId: user.id });
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
                return await (0, menuBuilder_1.handleNextStepSuggestion)(user, message.telefone);
            }
            // Menu not recent → fall through to isCuriosityPhrase which will show the menu
        }
    }
    // ── Intenção de histórico/registros — redireciona para extrato ──────────
    if (!(0, parseTransaction_1.parseTransaction)(message.texto.trim()) &&
        /tudo\s+que\s+(j[aá]\s+)?(anotei|registrei|lan[cç]ei)|ver\s+(meus?\s+)?(registros?|lan[cç]amentos?|hist[oó]rico|anotat?[uú]?)|meus?\s+(lan[cç]amentos?|registros?|hist[oó]rico de\s+gastos?)|hist[oó]rico\s+de\s+gastos?/i.test(message.texto.trim())) {
        const mesAtual = formatting_1.MESES_NOME[new Date().getMonth() + 1];
        return await (0, reports_1.handleExtratoCommand)(user, message.telefone, `extrato ${mesAtual}`);
    }
    // ── Curiosidade sobre funcionalidades (linguagem natural) ────────────────
    if ((0, menuBuilder_1.isCuriosityPhrase)(message.texto.trim())) {
        try {
            await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: (0, menuBuilder_1.buildFeaturesMenuText)() });
            (0, conversationEngine_1.recordAction)(user.id, "showed_menu");
            logger_1.log.whatsapp("features menu enviado", { to: message.telefone, userId: user.id });
        }
        catch (err) {
            logger_1.log.error("falha ao enviar features menu", err, { userId: user.id });
        }
        return { success: false, userId: user.id, erro: "Features menu enviado" };
    }
    // ── Onboarding: boas-vindas para usuário novo ────────────────────────────
    const ehSaudacaoOuAjuda = /^(oi+|op+a|ol[aá]|ola|e\s*a[ií]|tudo\s*(bem|bom|ok|certo)?|como\s+(tá|vai)|fala|fala\s+(aí|a[ií]|cmg|comigo)|começar|comecar|menu|ajuda|hi|hello|hey|bom\s*dia|boa\s*tarde|boa\s*noite|start)[\?!.]*$/i
        .test(message.texto.trim());
    if (ehSaudacaoOuAjuda) {
        const countRow = await client_1.default.query(`SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`, [user.id]);
        const count = Number(countRow.rows[0].count);
        if (count === 0) {
            // Onboarding enviado há menos de 5 min → silêncio (evita spam de boas-vindas repetidas)
            const criadoHaPouco = user.criado_em
                && (Date.now() - new Date(user.criado_em).getTime()) < 2 * 60 * 1000;
            if (criadoHaPouco) {
                return { success: false, userId: user.id, erro: "Onboarding recente — silencio" };
            }
            const boas_vindas = [
                "Olá! Me manda um gasto:",
                "35 uber  •  50 mercado  •  120 farmácia 📝",
            ].join("\n");
            try {
                await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: boas_vindas });
                logger_1.log.whatsapp("onboarding welcome enviado", { to: message.telefone, userId: user.id });
            }
            catch (err) {
                logger_1.log.error("falha ao enviar welcome", err, { to: message.telefone });
            }
            return { success: false, userId: user.id, erro: "Onboarding iniciado" };
        }
        // Usuário ativo pediu ajuda ou menu explicitamente → lista completa
        if (/^(ajuda|menu)$/i.test(message.texto.trim())) {
            return await (0, menuBuilder_1.handleAjudaCommand)(user, message.telefone);
        }
        // Saudação social de usuário ativo → resposta natural, sem listar comandos
        const saudacoes = [
            "Oi 🙂 Pode mandar um gasto ou perguntar sobre o mês.",
            "Olá 👋 Me manda um gasto ou fala o que quer ver.",
            "Oi! Pode registrar um gasto ou pedir o resumo do mês.",
        ];
        await whatsapp_1.whatsapp.sendText({
            to: message.telefone,
            text: saudacoes[new Date().getHours() % saudacoes.length],
        });
        return { success: false, userId: user.id, erro: "Saudacao de usuario ativo" };
    }
    // ── Comandos de consulta ──────────────────────────────────────────────────
    if (/^saldo$/i.test(message.texto.trim())) {
        (0, conversationEngine_1.setLastCommand)(user.id, "saldo");
        return await (0, reports_1.handleSaldoCommand)(user, message.telefone);
    }
    if (/^resumo$/i.test(message.texto.trim())) {
        (0, conversationEngine_1.setLastCommand)(user.id, "resumo");
        return await (0, reports_1.handleResumoCommand)(user, message.telefone);
    }
    if (/^top(\s*gastos)?$/i.test(message.texto.trim())) {
        (0, conversationEngine_1.setLastCommand)(user.id, "top_gastos");
        return await (0, reports_1.handleTopGastosCommand)(user, message.telefone);
    }
    if (/^parcelas?$|^parcelamentos?$/i.test(message.texto.trim())) {
        try {
            await whatsapp_1.whatsapp.sendText({
                to: message.telefone,
                text: [
                    "Pode registrar assim:",
                    "",
                    "iphone 12x de 755",
                    "tv 6x 300",
                    "notebook 24 parcelas de 450",
                    "",
                    "",
                    "Eu organizo o resto 🙂",
                ].join("\n"),
            });
        }
        catch (err) {
            logger_1.log.error("falha ao enviar info parcelas", err, { to: message.telefone });
        }
        return { success: false, userId: user.id, erro: "parcelas info" };
    }
    if (/^limite\s+.+\s+[\d,.]+$/i.test(message.texto.trim())) {
        return await (0, reports_1.handleLimiteCommand)(user, message.telefone, message.texto.trim());
    }
    if (/^hoje$/i.test(message.texto.trim())) {
        (0, conversationEngine_1.setLastCommand)(user.id, "hoje");
        return await (0, reports_1.handleHojeCommand)(user, message.telefone);
    }
    if (/^semana$/i.test(message.texto.trim())) {
        (0, conversationEngine_1.setLastCommand)(user.id, "semana");
        return await (0, reports_1.handleSemanaCommand)(user, message.telefone);
    }
    if (/^categorias$/i.test(message.texto.trim())) {
        return await (0, reports_1.handleCategoriasCommand)(user, message.telefone);
    }
    if (/^ajuda$/i.test(message.texto.trim())) {
        return await (0, menuBuilder_1.handleAjudaCommand)(user, message.telefone);
    }
    if (/^meta\s+.+\s+[\d,.]+$/i.test(message.texto.trim())) {
        return await (0, goals_1.handleMetaCommand)(user, message.telefone, message.texto.trim());
    }
    if (/^metas$/i.test(message.texto.trim())) {
        (0, conversationEngine_1.setLastCommand)(user.id, "metas");
        return await (0, goals_1.handleMetasCommand)(user, message.telefone);
    }
    if (/^guardar\s+[\d,.]+\s+.+$/i.test(message.texto.trim())) {
        return await (0, goals_1.handleGuardarCommand)(user, message.telefone, message.texto.trim());
    }
    if (/^ranking$/i.test(message.texto.trim())) {
        (0, conversationEngine_1.setLastCommand)(user.id, "ranking");
        return await (0, reports_1.handleRankingCommand)(user, message.telefone);
    }
    if (/^comparar$/i.test(message.texto.trim())) {
        return await (0, reports_1.handleCompararCommand)(user, message.telefone);
    }
    if (/^desafio$/i.test(message.texto.trim())) {
        return await (0, reports_1.handleDesafioCommand)(user, message.telefone);
    }
    if (/^previs[aã]o$/i.test(message.texto.trim())) {
        return await (0, reports_1.handlePrevisaoCommand)(user, message.telefone);
    }
    if (/^recorrentes$/i.test(message.texto.trim())) {
        (0, conversationEngine_1.setLastCommand)(user.id, "recorrentes");
        return await (0, recurring_1.handleRecorrentesCommand)(user, message.telefone);
    }
    if (/^pr[oó]ximas$/i.test(message.texto.trim())) {
        (0, conversationEngine_1.setLastCommand)(user.id, "proximas");
        return await (0, recurring_1.handleProximasCommand)(user, message.telefone);
    }
    if (/^buscar\s+.+$/i.test(message.texto.trim())) {
        return await (0, reports_1.handleBuscarCommand)(user, message.telefone, message.texto.trim());
    }
    if (/^recorrente\s+[\d,.]+\s+.+$/i.test(message.texto.trim())) {
        return await (0, recurring_1.handleRecorrenteCommand)(user, message.telefone, message.texto.trim());
    }
    if (/^apagar$/i.test(message.texto.trim())) {
        return await (0, transactions_1.handleApagarCommand)(user, message.telefone);
    }
    if (/^corrigir$/i.test(message.texto.trim())) {
        return await (0, transactions_1.handleCorrigirCommand)(user, message.telefone);
    }
    if (/^extrato\s+.+$/i.test(message.texto.trim())) {
        return await (0, reports_1.handleExtratoCommand)(user, message.telefone, message.texto.trim());
    }
    // ── Progresso de parcela ─────────────────────────────────────────────────
    // Self-contained: "paguei N de M" / "já paguei N de M"
    // Context-aware : all natural phrasings, require lastInstallment in session or DB
    {
        const t = message.texto.trim();
        // Self-contained explicit form — no session needed
        const pmExplicit = t.match(/^(?:j[aá]\s+)?(?:paguei|quitei)\s+(\d+)\s+de\s+(\d+)[\?!.]*$/i);
        if (pmExplicit) {
            const pago = parseInt(pmExplicit[1], 10);
            const total = parseInt(pmExplicit[2], 10);
            const inst = (0, conversationEngine_1.getLastInstallment)(user.id) ?? await (0, installments_1.getInstallmentFromDb)(user.id);
            const faltam = total - pago;
            let txt;
            if (inst && inst.totalParcelas === total) {
                txt = faltam > 0
                    ? `Perfeito 🙂\nFaltam ${faltam} parcela${faltam > 1 ? "s" : ""} do ${inst.item}.`
                    : `Ótimo 🙂\n${inst.item} — quitado!`;
                const newInst = { ...inst, parcelaAtual: pago + 1 };
                (0, conversationEngine_1.setLastInstallment)(user.id, newInst);
                if (inst.dbId) {
                    await client_1.default.query(`UPDATE installments SET parcelas_pagas = $1 WHERE id = $2`, [pago, inst.dbId]).catch(() => null);
                }
            }
            else {
                txt = faltam > 0
                    ? `Certo 🙂\n${pago} de ${total} pagas.`
                    : `Ótimo 🙂\nQuitado!`;
            }
            try {
                await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: txt });
            }
            catch (err) {
                logger_1.log.error("falha ao enviar progresso parcela", err, { to: message.telefone });
            }
            return { success: false, userId: user.id, erro: "progresso parcela" };
        }
        // Context-aware: any natural phrasing — session first, then DB fallback
        const progress = (0, installments_1.detectInstallmentProgress)(t);
        if (progress !== null) {
            const inst = (0, conversationEngine_1.getLastInstallment)(user.id) ?? await (0, installments_1.getInstallmentFromDb)(user.id);
            if (!inst) {
                // Orphan: detected progress phrasing but no installment found anywhere
                try {
                    await whatsapp_1.whatsapp.sendText({
                        to: message.telefone,
                        text: "De qual compra? Me manda assim:\n\niphone 12x de 250",
                    });
                }
                catch (err) {
                    logger_1.log.error("falha ao enviar orphan hint", err, { to: message.telefone });
                }
                return { success: false, userId: user.id, erro: "progresso parcela sem contexto" };
            }
            const txt = (0, installments_1.buildInstallmentProgressText)(progress, inst);
            let newParcelaAtual = inst.parcelaAtual;
            if (progress.type === "pago" && progress.pago !== undefined) {
                newParcelaAtual = progress.pago + 1;
            }
            else if (progress.type === "current") {
                newParcelaAtual = progress.atual + 1;
            }
            (0, conversationEngine_1.setLastInstallment)(user.id, { ...inst, parcelaAtual: newParcelaAtual });
            if (inst.dbId && (progress.type === "pago" || progress.type === "current")) {
                const pagas = newParcelaAtual - 1;
                await client_1.default.query(`UPDATE installments SET parcelas_pagas = $1 WHERE id = $2`, [pagas, inst.dbId]).catch(() => null);
            }
            try {
                await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: txt });
            }
            catch (err) {
                logger_1.log.error("falha ao enviar progresso parcela", err, { to: message.telefone });
            }
            return { success: false, userId: user.id, erro: "progresso parcela" };
        }
    }
    // ── Parcela context follow-ups ───────────────────────────────────────────
    // Responde perguntas sobre a parcela ativa sem exigir frase exata.
    // Só dispara quando o lastContext é "installment" E lastInstallment existe (sessão ou DB).
    {
        const inst = (0, conversationEngine_1.getLastInstallment)(user.id) ?? ((0, conversationEngine_1.getLastContext)(user.id) === "installment" ? await (0, installments_1.getInstallmentFromDb)(user.id) : null);
        if (inst && (0, conversationEngine_1.getLastContext)(user.id) === "installment") {
            const tq = message.texto.trim().toLowerCase();
            const iq = (/\b(valor\s+total|total\s+da\s+compra|quanto\s+(é|e)\s+(o\s+)?total|qual\s+o\s+total)\b/.test(tq) ? "total_value" :
                /\b(quantas\s+(parcelas\s+)?faltam|quantas\s+(ainda\s+)?restam|quantas\s+ainda\s+(tenho|faltam))\b/.test(tq) ? "remaining_count" :
                    /\b(quanto\s+falta\s+pagar|quanto\s+ainda\s+falta\s+pagar|valor\s+restante|quanto\s+falta\s+pra\s+quitar)\b/.test(tq) ? "remaining_value" :
                        /^quanto\s+falta[?!.]*$/.test(tq) ? "remaining_value" :
                            /\b(valor\s+da\s+parcela|qual\s+(é|e)\s+a\s+parcela|quanto\s+(é|e)\s+cada\s+(uma|parcela)|valor\s+de\s+cada)\b/.test(tq) ? "installment_value" :
                                null);
            if (iq !== null) {
                const { item, valor, totalParcelas, parcelaAtual } = inst;
                const pagas = parcelaAtual - 1;
                const faltam = totalParcelas - pagas;
                const total = totalParcelas * valor;
                const restante = faltam * valor;
                let txt;
                if (iq === "total_value") {
                    txt = `${item} — total de ${(0, formatting_1.fmtValor)(total)}\n${totalParcelas}× ${(0, formatting_1.fmtValor)(valor)}`;
                }
                else if (iq === "remaining_count") {
                    txt = faltam > 0
                        ? `Faltam ${faltam} parcela${faltam > 1 ? "s" : ""} do ${item}.`
                        : `${item} — quitado!`;
                }
                else if (iq === "remaining_value") {
                    txt = faltam > 0
                        ? `Faltam ${(0, formatting_1.fmtValor)(restante)} para quitar o ${item}.`
                        : `${item} — quitado!`;
                }
                else {
                    txt = `Cada parcela do ${item} é ${(0, formatting_1.fmtValor)(valor)}.`;
                }
                try {
                    await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: txt });
                }
                catch (err) {
                    logger_1.log.error("falha ao enviar parcela follow-up", err, { to: message.telefone });
                }
                return { success: false, userId: user.id, erro: "installment context follow-up" };
            }
        }
    }
    // ── Recurring context follow-ups ─────────────────────────────────────────
    if ((0, conversationEngine_1.getLastContext)(user.id) === "recurring") {
        const tq = message.texto.trim().toLowerCase();
        const isQuestion = /(mostr|ver|qua(is|l)|lista|tudo|todos|resumo|meus|outros|quais\s+s[aã]o|quais\s+(eu\s+)?tenho|e\s+os\s+outros)/i.test(tq);
        const temNumero = /\d/.test(tq);
        if (isQuestion && !temNumero) {
            (0, conversationEngine_1.setLastCommand)(user.id, "recorrentes");
            return await (0, recurring_1.handleRecorrentesCommand)(user, message.telefone);
        }
    }
    // ── Intent de meta ───────────────────────────────────────────────────────
    // Intercepta linguagem natural sobre metas antes de chegar no parser de gastos
    {
        const goalIntent = (0, goals_1.detectGoalIntent)(message.texto.trim());
        if (goalIntent !== null) {
            try {
                if (goalIntent.type === "adicionar")
                    return await (0, goals_1.handleAddToGoal)(user, message.telefone, goalIntent.valor, goalIntent.nome);
                if (goalIntent.type === "criar_sem_valor")
                    return await (0, goals_1.handleCreateGoalNoValue)(user, message.telefone, goalIntent.nome);
                if (goalIntent.type === "progresso")
                    return await (0, goals_1.handleGoalProgress)(user, message.telefone, goalIntent.nome);
                if (goalIntent.type === "porcentagem")
                    return await (0, goals_1.handleGoalPercentage)(user, message.telefone);
                if (goalIntent.type === "juntei")
                    return await (0, goals_1.handleGoalAmountSaved)(user, message.telefone);
            }
            catch (err) {
                logger_1.log.error("falha no goal intent", err, { userId: user.id });
            }
        }
    }
    // ── Interpretação conversacional ─────────────────────────────────────────
    const intentResult = await tryHandleIntent(user, message.telefone, message.texto);
    if (intentResult !== null)
        return intentResult;
    // ── Proteção contra mensagens ambíguas ───────────────────────────────────
    if ((0, menuBuilder_1.isAmbiguousIntent)(message.texto)) {
        await whatsapp_1.whatsapp.sendText({
            to: message.telefone,
            text: (0, menuBuilder_1.buildContextualHint)(message.texto),
        });
        return { success: false, userId: user.id, erro: "Mensagem ambígua" };
    }
    // ── Parser ────────────────────────────────────────────────────────────────
    // Número puro sem descrição
    let textoParsear = message.texto;
    if (/^\d[\d,.]*$/.test(message.texto.trim())) {
        const cRow = await client_1.default.query(`SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`, [user.id]);
        if (Number(cRow.rows[0].count) === 0) {
            // Onboarding: primeiro contato → assume renda
            textoParsear = message.texto.trim() + " salário";
            logger_1.log.parser("onboarding: numero puro → renda", { original: message.texto, ajustado: textoParsear });
        }
        else {
            // Usuário ativo: número sem contexto → pede o que foi
            try {
                await whatsapp_1.whatsapp.sendText({
                    to: message.telefone,
                    text: `Qual foi o gasto?\n\nMe manda assim:\n${message.texto.trim()} mercado`,
                });
            }
            catch (err) {
                logger_1.log.error("falha ao pedir descricao numero puro", err, { to: message.telefone });
            }
            return { success: false, userId: user.id, erro: "numero puro sem descricao" };
        }
    }
    logger_1.log.parser("analisando", { texto: textoParsear });
    // ── Multi-line transactions ───────────────────────────────────────────────
    {
        const linhasMulti = (0, multiline_1.detectMultiLine)(message.texto);
        if (linhasMulti) {
            return await (0, multiline_1.handleMultiLineTransactions)(user, message.telefone, linhasMulti);
        }
    }
    // Installment pattern takes priority over generic parser
    const installment = (0, installments_1.detectInstallment)(textoParsear);
    if (installment) {
        if (installment.needsParcela) {
            return await (0, installments_1.handleInstallmentNeedsParcela)(user, message.telefone, installment);
        }
        return await (0, installments_1.handleInstallmentRegistration)(user, message.telefone, installment);
    }
    // Guard: frases com intenção futura/condicional não devem ser registradas como gastos
    if (/\d/.test(textoParsear) &&
        /\b(tenho\s+que\s+pagar|vou\s+pagar|preciso\s+pagar|falta\s+pagar|ainda\s+n[aã]o\s+paguei|a\s+pagar\b)\b/i.test(textoParsear)) {
        logger_1.log.parser("mencao futura ignorada", { texto: textoParsear });
        return { success: false, userId: user.id, erro: "mencao futura ignorada" };
    }
    const parsed = (0, parseTransaction_1.parseTransaction)(textoParsear);
    if (!parsed) {
        logger_1.log.parser("nao reconhecido", { texto: message.texto });
        try {
            const sendResult = await whatsapp_1.whatsapp.sendText({
                to: message.telefone,
                text: (0, menuBuilder_1.buildContextualHint)(message.texto),
            });
            logger_1.log.whatsapp("erro enviado", { to: message.telefone, success: sendResult.success });
        }
        catch (err) {
            logger_1.log.error("falha ao enviar mensagem de erro", err, { to: message.telefone });
        }
        return { success: false, userId: user.id, erro: "Mensagem não reconhecida" };
    }
    logger_1.log.parser("ok", {
        valor: parsed.valor,
        categoria: parsed.categoria,
        tipo: parsed.tipo,
        descricao: parsed.descricao,
    });
    // ── Checagem de recorrente duplicado ─────────────────────────────────────
    if (parsed.tipo === "saida") {
        const recMatch = await (0, recurringDetection_1.checkRecorrenteDuplicado)(user.id, parsed.descricao, parsed.valor);
        if (recMatch !== null) {
            const { nome, recValor, sameValue } = recMatch;
            if (sameValue) {
                try {
                    await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: `${nome} já está nas suas contas fixas 🙂` });
                }
                catch (_) { /* silent */ }
                return { success: false, userId: user.id, erro: "gasto duplica recorrente" };
            }
            else {
                try {
                    await whatsapp_1.whatsapp.sendText({
                        to: message.telefone,
                        text: `${nome} já existe por ${(0, formatting_1.fmtValor)(recValor)}.\nQuer atualizar para ${(0, formatting_1.fmtValor)(parsed.valor)}?`,
                    });
                    await client_1.default.query(`INSERT INTO pending_actions (user_id, action, step, tx_ids)
             VALUES ($1, 'confirmar_recorrente', 'waiting_confirmation', $2::jsonb)
             ON CONFLICT (user_id) DO UPDATE
               SET action = 'confirmar_recorrente', step = 'waiting_confirmation', tx_ids = $2::jsonb,
                   selected_tx_id = NULL, expires_at = NOW() + INTERVAL '10 minutes'`, [user.id, JSON.stringify({ update: true, nome: recMatch.nomeOriginal, novoValor: parsed.valor })]);
                }
                catch (err) {
                    logger_1.log.error("falha ao perguntar sobre atualização de recorrente", err, { userId: user.id });
                }
                return { success: false, userId: user.id, erro: "recorrente valor diferente" };
            }
        }
    }
    // ── Salvar no banco ───────────────────────────────────────────────────────
    logger_1.log.db("inserindo transacao", { user_id: user.id, tipo: parsed.tipo, valor: parsed.valor, categoria: parsed.categoria });
    let transacaoRow;
    try {
        const result = await client_1.default.query(`INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`, [user.id, parsed.tipo, parsed.valor, parsed.categoria, parsed.descricao]);
        transacaoRow = result.rows[0];
        logger_1.log.db("transacao salva", { id: transacaoRow.id, user_id: user.id });
        (0, conversationEngine_1.recordAction)(user.id, "registered_transaction");
    }
    catch (err) {
        logger_1.log.error("falha ao inserir transacao", err, { user_id: user.id });
        return { success: false, userId: user.id, erro: "Erro ao salvar transação no banco" };
    }
    // ── Enviar confirmação WhatsApp ───────────────────────────────────────────
    // Onboarding step 2: primeira transação é uma entrada → direcionar para o primeiro gasto
    if (parsed.tipo === "entrada") {
        const countRow = await client_1.default.query(`SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1`, [user.id]);
        if (Number(countRow.rows[0].count) === 1) {
            const msg = `💰 ${(0, formatting_1.fmtValor)(parsed.valor)} registrado.\nQuando quiser, me manda um gasto.`;
            try {
                await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: msg });
                logger_1.log.whatsapp("onboarding step2 enviado", { to: message.telefone, userId: user.id });
            }
            catch (err) {
                logger_1.log.error("falha ao enviar onboarding step2", err, { to: message.telefone });
            }
            return {
                success: true,
                userId: user.id,
                transacao: transacaoRow,
                interpretado: { valor: parsed.valor, descricao: parsed.descricao, categoria: parsed.categoria, tipo: parsed.tipo },
            };
        }
    }
    const linhasConfirmacao = parsed.tipo === "entrada"
        ? [`💰 Anotado!\n${(0, formatting_1.fmtValor)(parsed.valor)} • ${(0, formatting_1.capitalizeFirst)(parsed.descricao)}`]
        : [`✅ Anotado!\n${(0, formatting_1.fmtValor)(parsed.valor)} • ${(0, formatting_1.capitalizeFirst)(parsed.descricao)}`];
    if (parsed.tipo === "saida") {
        const aviso = await (0, reports_1.checkLimiteCategoria)(user.id, parsed.categoria);
        if (aviso)
            linhasConfirmacao.push("", aviso);
    }
    const confirmacao = linhasConfirmacao.join("\n");
    logger_1.log.whatsapp("enviando confirmacao", { to: message.telefone });
    try {
        const sendResult = await whatsapp_1.whatsapp.sendText({ to: message.telefone, text: confirmacao });
        logger_1.log.whatsapp(sendResult.success ? "enviado" : "falha no envio", {
            to: message.telefone,
            success: sendResult.success,
            messageId: sendResult.messageId,
            error: sendResult.error,
        });
    }
    catch (err) {
        logger_1.log.error("excecao ao enviar confirmacao", err, { to: message.telefone });
    }
    if (parsed.tipo === "saida") {
        // Cadeia sequencial com exclusão mútua: só 1 mensagem secundária por gasto.
        // Cada função retorna true se enviou algo — a cadeia para na primeira que disparar.
        // Session cooldown: no máximo 1 mensagem secundária a cada 10 minutos por sessão.
        setTimeout(async () => {
            try {
                if (!(0, conversationEngine_1.canSendInsight)(user.id))
                    return;
                if (await (0, insightsEngine_1.checkAndSendOnboardingTip)(user.id, message.telefone, "saida")) {
                    (0, conversationEngine_1.recordInsightSent)(user.id);
                    return;
                }
                if (await (0, insightsEngine_1.checkAndSendInsights)(user.id, message.telefone, parsed.categoria)) {
                    (0, conversationEngine_1.recordInsightSent)(user.id);
                    return;
                }
                if (await (0, insightsEngine_1.checkAndSendSmartInsights)(user.id, message.telefone, parsed.descricao, parsed.categoria)) {
                    (0, conversationEngine_1.recordInsightSent)(user.id);
                    return;
                }
                if (await (0, insightsEngine_1.sendContextualMicroInsight)(user.id, message.telefone, parsed.categoria)) {
                    (0, conversationEngine_1.recordInsightSent)(user.id);
                    return;
                }
                if (await (0, recurringDetection_1.checkAndSuggestRecorrente)(user.id, message.telefone, parsed.descricao, parsed.valor, parsed.categoria, message.texto)) {
                    (0, conversationEngine_1.recordInsightSent)(user.id);
                    return;
                }
                if (await checkAndDetectInstallment(user.id, message.telefone, parsed.descricao, message.texto, parsed.valor)) {
                    (0, conversationEngine_1.recordInsightSent)(user.id);
                }
            }
            catch (err) {
                logger_1.log.error("falha na cadeia de insights pos-gasto", err, { userId: user.id });
            }
        }, 1200);
    }
    return {
        success: true,
        userId: user.id,
        transacao: transacaoRow,
        interpretado: {
            valor: parsed.valor,
            descricao: parsed.descricao,
            categoria: parsed.categoria,
            tipo: parsed.tipo,
        },
    };
}
