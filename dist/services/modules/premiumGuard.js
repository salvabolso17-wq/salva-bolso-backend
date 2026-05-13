"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSubscriptionActive = isSubscriptionActive;
exports.isBlockedFreemium = isBlockedFreemium;
exports.checkAndSendExpirationNotice = checkAndSendExpirationNotice;
const client_1 = __importDefault(require("../../db/client"));
const whatsapp_1 = require("../whatsapp");
const logger_1 = require("../../utils/logger");
function isSubscriptionActive(user) {
    const status = (user.subscription_status ?? "").trim().toLowerCase();
    if (status === "expired")
        return false;
    if (status === "active") {
        if (!user.subscription_expires_at)
            return true;
        return new Date(user.subscription_expires_at) > new Date();
    }
    if (status === "trial") {
        return !user.trial_ends_at || new Date(user.trial_ends_at) > new Date();
    }
    return false; // qualquer status desconhecido = bloqueado
}
function isBlockedFreemium(texto) {
    const t = texto.trim().toLowerCase();
    if (/^(ranking|comparar|previs[aã]o|categorias|desafio|metas|recorrentes|pr[oó]ximas|top\s*gastos|parcelas|relat[oó]rios?|insights?|apagar|corrigir)$/i.test(t))
        return true;
    if (/^(meta|guardar|recorrente|limite)\s+/i.test(t))
        return true;
    if (/quero\s+apagar|apagar\s+o\s+[uú]ltimo|remover\s+(o\s+)?[uú]ltimo|deletar\s+(o\s+)?[uú]ltimo/.test(t))
        return true;
    if (/registrei\s+errado|coloquei\s+errado|lancei\s+errado/.test(t))
        return true;
    if (/(qual\s+(é\s+o\s+)?meu\s+maior\s+gasto|onde\s+gastei\s+mais|onde\s+vai\s+(meu\s+)?dinheiro|maior\s+gasto\s+do\s+m[eê]s)/i.test(t))
        return true;
    // Import detectGoalIntent inline check — avoids circular import with goals handler
    // We replicate the patterns here to keep modules independent
    if (_goalIntentMatch(texto))
        return true;
    return false;
}
// Inline replication of detectGoalIntent patterns for freemium guard
// (avoids importing from handlers/goals which would create a circular dep)
function _goalIntentMatch(texto) {
    const t = texto.trim();
    const tl = t.toLowerCase();
    if (/^(?:quero\s+)?(?:guard|poup|junt)(?:ar|a)\s+dinheiro\s+(?:na?|no|pra?|para|pro?s?)\s+(.+)$/.test(tl))
        return true;
    if (/^(?:quero\s+)?(?:criar\s+)?uma?\s+meta\s+(?:pra?|para|pro?)\s+(.+)$/.test(tl))
        return true;
    if (/^quanto\s+falta\s*(?:(?:pra?|para|pro?)\s+(.+?))?[?!.]*$/.test(tl))
        return true;
    if (/^como\s+t[aá]\s+(?:(?:a|minha?)\s+)?meta(?:\s+(?:de|do?a?)\s+(.+?))?[?!.]*$/.test(tl))
        return true;
    if (/^como\s+t[aá]\s+(?:o\s+)?meu?\s+objetivo[?!.]*$/.test(tl))
        return true;
    if (/^consegui\s+(?:guard|poup|junt|separ|coloc)(?:ar|a)\s+(?:mais\s+)?([\d,.]+)\s*(?:(?:na?|no|pra?|para|pro?|em)\s+(.+))?$/i.test(t))
        return true;
    if (/^(?:quero\s+)?(?:guard|poup|junt|separ|coloc|bot|adicion)(?:ar|a)\s+([\d,.]+)\s*(?:(?:na?|no|pra?|para|pro?|em)\s+(.+))?$/i.test(t))
        return true;
    if (/^(?:j[aá]\s+)?(?:guard|poup|junt|separ|coloc)ei\s+([\d,.]+)\s*(?:(?:na?|no|pra?|para|em)\s+(.+))?$/i.test(t))
        return true;
    if (/\b(qual\s+(é\s+|é\s+a\s+|a\s+)?porcentagem|que\s+porcentagem|qual\s+o\s+percentual|que\s+percentual)\b[?!.]*/.test(tl))
        return true;
    if (/^quanto\s+(?:j[aá]\s+)?(juntei|guardei|poupei)[?!.]*$/.test(tl))
        return true;
    if (/^quanto\s+tenho\s+guardado[?!.]*$/.test(tl))
        return true;
    if (/^quanto\s+eu\s+j[aá]\s+(juntei|guardei|poupei)[?!.]*$/.test(tl))
        return true;
    return false;
}
// Envia aviso limpo de expiração apenas uma vez
async function checkAndSendExpirationNotice(userId, telefone, expirouEm) {
    const expirouEmDate = new Date(Date.UTC(expirouEm.getUTCFullYear(), expirouEm.getUTCMonth(), expirouEm.getUTCDate()));
    let fullNovo = false;
    try {
        const ins = await client_1.default.query(`INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, 'expiracao_aviso_v4', 1, $2::date)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`, [userId, expirouEmDate]);
        fullNovo = (ins.rowCount ?? 0) > 0;
    }
    catch { /* continua */ }
    if (fullNovo) {
        logger_1.log.webhook("enviando aviso de expiracao LONGO (primeira vez)", { userId });
        const mensagem = `✨ Seu teste grátis terminou.\n\nVocê ainda pode:\n👀 consultar saldo\n📊 visualizar registros do mês\n\nDesbloqueie todos os recursos:\nhttps://salva-bolso-backend-salvabolso.h5prml.easypanel.host/premium-checkout.html`;
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: mensagem });
        return true;
    }
    logger_1.log.webhook("aviso longo ja foi enviado antes, ignorando para usar o curto", { userId });
    return false;
}
