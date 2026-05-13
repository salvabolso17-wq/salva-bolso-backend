"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInstallmentFromDb = getInstallmentFromDb;
exports.detectInstallment = detectInstallment;
exports.detectInstallmentProgress = detectInstallmentProgress;
exports.buildInstallmentProgressText = buildInstallmentProgressText;
exports.handleInstallmentRegistration = handleInstallmentRegistration;
exports.handleInstallmentNeedsParcela = handleInstallmentNeedsParcela;
exports.handleRegistrarParcelaValor = handleRegistrarParcelaValor;
const client_1 = __importDefault(require("../../db/client"));
const whatsapp_1 = require("../whatsapp");
const logger_1 = require("../../utils/logger");
const formatting_1 = require("../../utils/formatting");
const parseTransaction_1 = require("../../utils/parseTransaction");
const conversationEngine_1 = require("../conversationEngine");
const insightsEngine_1 = require("../modules/insightsEngine");
const reports_1 = require("./reports");
async function getInstallmentFromDb(userId) {
    try {
        const r = await client_1.default.query(`SELECT id, nome, valor_parcela, total_parcelas, parcelas_pagas, valor_total
       FROM installments
       WHERE user_id = $1 AND ativo = TRUE
       ORDER BY criado_em DESC
       LIMIT 1`, [userId]);
        if (!r.rows[0])
            return null;
        const row = r.rows[0];
        return {
            item: row.nome,
            valor: Number(row.valor_parcela),
            totalParcelas: row.total_parcelas,
            parcelaAtual: row.parcelas_pagas + 1,
            dbId: row.id,
            valorTotal: Number(row.valor_total),
        };
    }
    catch {
        return null;
    }
}
function detectInstallment(texto) {
    const t = texto.trim();
    // Pattern A: "iphone 12x de 755" or "tv 10x 230" — per-installment value given
    let m = t.match(/^(.+?)\s+(\d{1,2})\s*[xX]\s+(?:de\s+)?([\d,.]+)$/i);
    if (m) {
        const item = m[1].trim();
        const totalParcelas = parseInt(m[2], 10);
        const valor = (0, parseTransaction_1.parseValor)(m[3]);
        if (!(/^\d/.test(item)) && item.length >= 2 && totalParcelas >= 2 && totalParcelas <= 72 && valor > 0) {
            return { item, valor, totalParcelas };
        }
    }
    // Pattern B: "celular 12 parcelas de 300"
    m = t.match(/^(.+?)\s+(\d{1,2})\s+parcelas?\s+de\s+([\d,.]+)$/i);
    if (m) {
        const item = m[1].trim();
        const totalParcelas = parseInt(m[2], 10);
        const valor = (0, parseTransaction_1.parseValor)(m[3]);
        if (!(/^\d/.test(item)) && item.length >= 2 && totalParcelas >= 2 && totalParcelas <= 72 && valor > 0) {
            return { item, valor, totalParcelas };
        }
    }
    // Pattern C: "iphone 3000 12x" — total given, per-installment unknown → ask
    m = t.match(/^(.+?)\s+([\d,.]+)\s+(\d{1,2})\s*[xX]$/i);
    if (m) {
        const item = m[1].trim();
        const valorTotal = (0, parseTransaction_1.parseValor)(m[2]);
        const totalParcelas = parseInt(m[3], 10);
        if (!(/^\d/.test(item)) && item.length >= 2 && totalParcelas >= 2 && totalParcelas <= 72 && valorTotal > 0) {
            return { item, valor: 0, totalParcelas, needsParcela: true, valorTotal };
        }
    }
    // Pattern D: "iphone 12x" / "iphone em 12x" — sem valor nenhum → pede valor da parcela
    m = t.match(/^(.+?)\s+(\d{1,2})\s*[xX]$/i);
    if (m) {
        const rawItem = m[1].trim();
        const item = rawItem.replace(/\s+(?:em|no|na|de|para|por)\s*$/i, "").trim();
        const totalParcelas = parseInt(m[2], 10);
        if (!(/^\d/.test(item)) && item.length >= 2 && totalParcelas >= 2 && totalParcelas <= 72) {
            return { item, valor: 0, totalParcelas, needsParcela: true };
        }
    }
    return null;
}
function detectInstallmentProgress(texto) {
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
    if (m)
        return { type: "faltam", faltam: parseInt(m[2], 10) };
    // "tô na parcela 6", "estou na 6", "é a 6ª"
    m = t.match(/\b(t[oô]\s+na\s+parcela|estou\s+na\s+parcela|[eéè]\s+a\s+parcela|estou\s+na|t[oô]\s+na)\s+(\d+)/);
    if (m)
        return { type: "current", atual: parseInt(m[2], 10) };
    m = t.match(/\b[eéè]\s+a\s+(\d+)[aª]?\b/);
    if (m)
        return { type: "current", atual: parseInt(m[1], 10) };
    // "já paguei N de M", "paguei N de M", "quitei N de M"
    m = t.match(/\b(j[aá]\s+)?(paguei|quitei)\s+(\d+)\s+de\s+(\d+)/);
    if (m)
        return { type: "pago", pago: parseInt(m[3], 10), total: parseInt(m[4], 10) };
    // "já paguei N parcelas", "paguei N"
    m = t.match(/\b(j[aá]\s+)?(paguei|quitei)\s+(\d+)(\s+parcelas?)?\b/);
    if (m)
        return { type: "pago", pago: parseInt(m[3], 10) };
    return null;
}
function buildInstallmentProgressText(result, inst) {
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
            if (faltam <= 0)
                return `Ótimo 🙂\n${item} — quitado!`;
            return `Perfeito 🙂\nFaltam ${faltam} parcela${faltam > 1 ? "s" : ""} do ${item}.`;
        }
        case "faltam":
            return `Certo 🙂\nFaltam ${result.faltam} parcela${result.faltam > 1 ? "s" : ""} do ${item}.`;
        case "current": {
            const faltam = totalParcelas - result.atual;
            if (faltam <= 0)
                return `Ótimo 🙂\n${item} — quitado!`;
            return `Certo 🙂\nParcela ${result.atual} de ${totalParcelas} — faltam ${faltam}.`;
        }
    }
}
async function handleInstallmentRegistration(user, telefone, info) {
    const { item, valor, totalParcelas } = info;
    // Infer category by re-using existing parser on "valor item"
    const tempParsed = (0, parseTransaction_1.parseTransaction)(`${valor} ${item}`);
    const categoria = tempParsed?.categoria ?? "Outros";
    const descricao = (0, formatting_1.capitalizeFirst)(item);
    const total = valor * totalParcelas;
    logger_1.log.parser("parcela detectada", { item, valor, totalParcelas, categoria });
    // Save as expense transaction + installment record
    let transacaoRow;
    try {
        const txResult = await client_1.default.query(`INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, 'saida', $2, $3, $4)
       RETURNING *`, [user.id, valor, categoria, descricao]);
        transacaoRow = txResult.rows[0];
        const instResult = await client_1.default.query(`INSERT INTO installments (user_id, nome, valor_total, valor_parcela, total_parcelas, parcelas_pagas, categoria)
       VALUES ($1, $2, $3, $4, $5, 1, $6)
       RETURNING id`, [user.id, descricao, total, valor, totalParcelas, categoria]);
        const dbId = instResult.rows[0].id;
        (0, conversationEngine_1.recordAction)(user.id, "registered_transaction");
        (0, conversationEngine_1.setLastInstallment)(user.id, { item: descricao, valor, totalParcelas, parcelaAtual: 1, dbId, valorTotal: total });
        logger_1.log.db("parcela salva", { id: transacaoRow.id, installmentId: dbId, user_id: user.id });
    }
    catch (err) {
        logger_1.log.error("falha ao salvar parcela", err, { user_id: user.id });
        return { success: false, userId: user.id, erro: "Erro ao salvar parcela" };
    }
    // Check limit alert
    const aviso = await (0, reports_1.checkLimiteCategoria)(user.id, categoria).catch(() => null);
    // Natural confirmation with installment context
    const linhas = [
        `✅ ${(0, formatting_1.fmtValor)(valor)} — ${descricao}`,
        ``,
        `${totalParcelas} parcelas de ${(0, formatting_1.fmtValor)(valor)}`,
        `Total: ${(0, formatting_1.fmtValor)(total)}`,
    ];
    if (aviso)
        linhas.push("", aviso);
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
        logger_1.log.whatsapp("parcela confirmada", { to: telefone, userId: user.id, item, valor, totalParcelas });
    }
    catch (err) {
        logger_1.log.error("falha ao confirmar parcela", err, { to: telefone });
    }
    // Insight chain (same gates as regular expenses)
    setTimeout(async () => {
        try {
            const { canSendInsight, recordInsightSent } = await Promise.resolve().then(() => __importStar(require("../conversationEngine")));
            if (!canSendInsight(user.id))
                return;
            if (await (0, insightsEngine_1.checkAndSendOnboardingTip)(user.id, telefone, "saida")) {
                recordInsightSent(user.id);
                return;
            }
            if (await (0, insightsEngine_1.checkAndSendInsights)(user.id, telefone, categoria)) {
                recordInsightSent(user.id);
                return;
            }
            if (await (0, insightsEngine_1.checkAndSendSmartInsights)(user.id, telefone, descricao, categoria)) {
                recordInsightSent(user.id);
                return;
            }
        }
        catch (err) {
            logger_1.log.error("falha no insight chain (parcela)", err, { userId: user.id });
        }
    }, 1200);
    return {
        success: true,
        userId: user.id,
        transacao: transacaoRow,
        interpretado: { tipo: "parcela", item: descricao, valor, totalParcelas },
    };
}
async function handleInstallmentNeedsParcela(user, telefone, info) {
    const { item, totalParcelas, valorTotal } = info;
    const descricao = (0, formatting_1.capitalizeFirst)(item);
    const payload = JSON.stringify({ item: descricao, totalParcelas, valorTotal: valorTotal ?? 0 });
    try {
        await client_1.default.query(`INSERT INTO pending_actions (user_id, action, step, tx_ids)
       VALUES ($1, 'registrar_parcela', 'waiting_parcela_valor', $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE
         SET action = 'registrar_parcela', step = 'waiting_parcela_valor', tx_ids = $2::jsonb,
             selected_tx_id = NULL, expires_at = NOW() + INTERVAL '30 minutes'`, [user.id, payload]);
        const valorHint = valorTotal ? ` (total ${(0, formatting_1.fmtValor)(valorTotal)})` : "";
        await whatsapp_1.whatsapp.sendText({
            to: telefone,
            text: `${descricao} — ${totalParcelas}×${valorHint}\n\nQual o valor de cada parcela?`,
        });
    }
    catch (err) {
        logger_1.log.error("falha em handleInstallmentNeedsParcela", err, { userId: user.id });
    }
    return { success: false, userId: user.id, erro: "aguardando valor parcela" };
}
async function handleRegistrarParcelaValor(user, telefone, textoTrim, payload) {
    const valorParcela = (0, parseTransaction_1.parseValor)(textoTrim);
    if (isNaN(valorParcela) || valorParcela <= 0) {
        try {
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: "Quanto é cada parcela? Ex: 250" });
        }
        catch (err) {
            logger_1.log.error("falha ao pedir valor parcela", err, { to: telefone });
        }
        return { success: false, userId: user.id, erro: "valor parcela invalido" };
    }
    const { item, totalParcelas, valorTotal } = payload;
    const total = valorTotal > 0 ? valorTotal : valorParcela * totalParcelas;
    const tempParsed = (0, parseTransaction_1.parseTransaction)(`${valorParcela} ${item}`);
    const categoria = tempParsed?.categoria ?? "Outros";
    const descricao = (0, formatting_1.capitalizeFirst)(item);
    let transacaoRow = {};
    try {
        await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
        const txResult = await client_1.default.query(`INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, 'saida', $2, $3, $4)
       RETURNING *`, [user.id, valorParcela, categoria, descricao]);
        transacaoRow = txResult.rows[0];
        const instResult = await client_1.default.query(`INSERT INTO installments (user_id, nome, valor_total, valor_parcela, total_parcelas, parcelas_pagas, categoria)
       VALUES ($1, $2, $3, $4, $5, 1, $6)
       RETURNING id`, [user.id, descricao, total, valorParcela, totalParcelas, categoria]);
        const dbId = instResult.rows[0].id;
        (0, conversationEngine_1.recordAction)(user.id, "registered_transaction");
        (0, conversationEngine_1.setLastInstallment)(user.id, { item: descricao, valor: valorParcela, totalParcelas, parcelaAtual: 1, dbId, valorTotal: total });
        logger_1.log.db("parcela salva (confirmada)", { installmentId: dbId, user_id: user.id });
    }
    catch (err) {
        logger_1.log.error("falha ao salvar parcela confirmada", err, { user_id: user.id });
        return { success: false, userId: user.id, erro: "Erro ao salvar parcela" };
    }
    const linhas = [
        `✅ ${(0, formatting_1.fmtValor)(valorParcela)} — ${descricao}`,
        ``,
        `${totalParcelas} parcelas de ${(0, formatting_1.fmtValor)(valorParcela)}`,
        `Total: ${(0, formatting_1.fmtValor)(total)}`,
    ];
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    }
    catch (err) {
        logger_1.log.error("falha ao confirmar parcela", err, { to: telefone });
    }
    return {
        success: true,
        userId: user.id,
        transacao: transacaoRow,
        interpretado: { tipo: "parcela", item: descricao, valor: valorParcela, totalParcelas },
    };
}
