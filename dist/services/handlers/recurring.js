"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleConfirmarRecorrente = handleConfirmarRecorrente;
exports.handleConfirmarRecorrenteMulti = handleConfirmarRecorrenteMulti;
exports.handleRecorrentesCommand = handleRecorrentesCommand;
exports.handleProximasCommand = handleProximasCommand;
exports.handleRecorrenteCommand = handleRecorrenteCommand;
const client_1 = __importDefault(require("../../db/client"));
const whatsapp_1 = require("../whatsapp");
const logger_1 = require("../../utils/logger");
const formatting_1 = require("../../utils/formatting");
const conversationEngine_1 = require("../conversationEngine");
const recurringDetection_1 = require("../modules/recurringDetection");
const insightsEngine_1 = require("../modules/insightsEngine");
async function handleConfirmarRecorrente(user, telefone, txIds) {
    try {
        await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
        // Atualização de valor de recorrente existente
        if (!Array.isArray(txIds) && txIds.update === true) {
            const data = txIds;
            await client_1.default.query(`UPDATE recurring_expenses SET valor = $1 WHERE user_id = $2 AND LOWER(TRIM(nome)) = LOWER(TRIM($3))`, [data.novoValor, user.id, data.nome]);
            (0, conversationEngine_1.recordAction)(user.id, "created_recurring");
            (0, conversationEngine_1.setLastContext)(user.id, "recurring");
            await whatsapp_1.whatsapp.sendText({
                to: telefone,
                text: `Atualizado 🙂 ${(0, formatting_1.capitalizeFirst)(data.nome)} agora é ${(0, formatting_1.fmtValor)(data.novoValor)} por mês.`,
            });
            return { success: false, userId: user.id, erro: "Recorrente atualizado" };
        }
        // Array → confirmação de lista multi-line
        if (Array.isArray(txIds)) {
            const items = txIds;
            for (const item of items) {
                await (0, recurringDetection_1.upsertRecorrente)(user.id, item.nome, item.valor, item.frequencia);
            }
            (0, conversationEngine_1.recordAction)(user.id, "created_recurring");
            (0, conversationEngine_1.setLastCommand)(user.id, "recorrentes");
            (0, conversationEngine_1.setLastContext)(user.id, "recurring");
            const nomes = items.map(i => (0, formatting_1.capitalizeFirst)(i.nome)).join(", ");
            await whatsapp_1.whatsapp.sendText({
                to: telefone,
                text: `Perfeito 🙂\nVou acompanhar ${nomes} automaticamente.`,
            });
            logger_1.log.whatsapp("recorrentes confirmados (lista)", { to: telefone, userId: user.id, count: items.length });
            return { success: false, userId: user.id, erro: "Recorrentes confirmados" };
        }
        // Objeto único → fluxo original
        const data = txIds;
        await (0, recurringDetection_1.upsertRecorrente)(user.id, data.nome, data.valor, data.frequencia);
        const nome = (0, formatting_1.capitalizeFirst)(data.nome);
        (0, conversationEngine_1.recordAction)(user.id, "created_recurring");
        (0, conversationEngine_1.setLastCommand)(user.id, "recorrentes");
        (0, conversationEngine_1.setLastContext)(user.id, "recurring");
        await whatsapp_1.whatsapp.sendText({
            to: telefone,
            text: `Perfeito 🙂\nVou acompanhar ${nome} automaticamente.`,
        });
        logger_1.log.whatsapp("recorrente confirmado pelo usuario", { to: telefone, userId: user.id, nome: data.nome });
        return { success: false, userId: user.id, erro: "Recorrente confirmado" };
    }
    catch (err) {
        logger_1.log.error("falha ao confirmar recorrente", err, { userId: user.id });
        return { success: false, userId: user.id, erro: "Erro ao criar recorrente" };
    }
}
async function handleConfirmarRecorrenteMulti(user, telefone, texto, txIdsRaw) {
    const items = (Array.isArray(txIdsRaw) ? txIdsRaw : []);
    if (items.length === 0) {
        await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
        return { success: false, userId: user.id, erro: "tx_ids vazio" };
    }
    const t = texto.toLowerCase();
    let selectedIndices = [];
    if (t.includes("todo") || t.includes("tudo") || t.includes("ambos") || t.includes("os dois") || t.includes("as duas") || /^(sim|s|yes|pode|quero|claro|ok|beleza|bora|certo|perfeito|tá|ta)[\?!.]*$/.test(t)) {
        selectedIndices = items.map((_, i) => i);
    }
    else {
        // Parse numbers
        const matches = t.match(/\d+/g);
        if (matches) {
            selectedIndices = matches.map(n => parseInt(n, 10) - 1).filter(i => i >= 0 && i < items.length);
        }
    }
    if (selectedIndices.length === 0) {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: "Não entendi quais. Pode mandar os números? (ex: 1 e 2)\nOu 'nenhum' para pular." });
        return { success: false, userId: user.id, erro: "Aguardando seleção válida" };
    }
    const selectedItems = selectedIndices.map(i => items[i]);
    await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    let totalFixo = 0;
    for (const item of selectedItems) {
        await (0, recurringDetection_1.upsertRecorrente)(user.id, item.nome, item.valor, item.frequencia);
        totalFixo += item.valor;
    }
    (0, conversationEngine_1.recordAction)(user.id, "created_recurring");
    (0, conversationEngine_1.setLastCommand)(user.id, "recorrentes");
    (0, conversationEngine_1.setLastContext)(user.id, "recurring");
    const linhas = ["🔄 Perfeito!", "Vou acompanhar essas contas automaticamente:", ""];
    for (const item of selectedItems) {
        linhas.push(`• ${(0, formatting_1.capitalizeFirst)(item.nome)}`);
    }
    linhas.push("", `Total fixo por mês: ${(0, formatting_1.fmtValor)(totalFixo)}`);
    await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "confirmar_recorrente_multi" } };
}
async function handleRecorrentesCommand(user, telefone) {
    logger_1.log.webhook("comando recorrentes", { userId: user.id });
    const result = await client_1.default.query(`SELECT nome, valor, frequencia
     FROM recurring_expenses
     WHERE user_id = $1 AND ativo = TRUE
     ORDER BY criado_em ASC`, [user.id]);
    if (result.rows.length === 0) {
        await whatsapp_1.whatsapp.sendText({
            to: telefone,
            text: "Nenhum recorrente ainda.\nPara adicionar: recorrente 39 netflix mensal",
        });
        return {
            success: true,
            userId: user.id,
            transacao: {},
            interpretado: { comando: "recorrentes", count: 0 },
        };
    }
    const linhas = ["🔄 Assinaturas e contas fixas", ""];
    let totalMensal = 0;
    for (const row of result.rows) {
        const valor = Number(row.valor);
        totalMensal += valor;
        linhas.push(`${row.nome} — ${(0, formatting_1.fmtValor)(valor)}`);
    }
    linhas.push("", `Total: ${(0, formatting_1.fmtValor)(totalMensal)}/mês`);
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
        logger_1.log.whatsapp("recorrentes enviado", { to: telefone, count: result.rows.length, totalMensal });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar recorrentes", err, { to: telefone });
    }
    return {
        success: true,
        userId: user.id,
        transacao: {},
        interpretado: { comando: "recorrentes", count: result.rows.length, totalMensal },
    };
}
async function handleProximasCommand(user, telefone) {
    logger_1.log.webhook("comando proximas", { userId: user.id });
    const result = await client_1.default.query(`SELECT nome, valor
     FROM recurring_expenses
     WHERE user_id = $1 AND ativo = TRUE
     ORDER BY criado_em ASC`, [user.id]);
    if (result.rows.length === 0) {
        await whatsapp_1.whatsapp.sendText({
            to: telefone,
            text: "Nenhuma conta recorrente cadastrada.\n\n💡 Ex:\nrecorrente 39 netflix mensal",
        });
        return {
            success: true,
            userId: user.id,
            transacao: {},
            interpretado: { comando: "proximas", count: 0 },
        };
    }
    const linhas = ["📅 Próximas contas", ""];
    let total = 0;
    for (const row of result.rows) {
        const valor = Number(row.valor);
        total += valor;
        linhas.push(`${row.nome} — ${(0, formatting_1.fmtValor)(valor)}`);
    }
    linhas.push("", `Total previsto: ${(0, formatting_1.fmtValor)(total)}`);
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
        logger_1.log.whatsapp("proximas enviado", { to: telefone, count: result.rows.length, total });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar proximas", err, { to: telefone });
    }
    return {
        success: true,
        userId: user.id,
        transacao: {},
        interpretado: { comando: "proximas", count: result.rows.length, total },
    };
}
async function handleRecorrenteCommand(user, telefone, texto) {
    logger_1.log.webhook("comando recorrente", { userId: user.id, texto });
    const match = texto.match(/^recorrente\s+([\d,.]+)\s+(.+)$/i);
    if (!match) {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: "💡 Ex:\nrecorrente 39 netflix mensal" });
        return { success: false, userId: user.id, erro: "Formato inválido" };
    }
    const valor = parseFloat(match[1].replace(",", "."));
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
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: "💡 Ex:\nrecorrente 39 netflix mensal" });
        return { success: false, userId: user.id, erro: "Nome ausente" };
    }
    const nomeRaw = nomePartes.join(" ");
    const nome = nomeRaw.charAt(0).toUpperCase() + nomeRaw.slice(1).toLowerCase();
    const freqLabel = frequencia.charAt(0).toUpperCase() + frequencia.slice(1);
    await (0, recurringDetection_1.upsertRecorrente)(user.id, nome, valor, frequencia);
    await whatsapp_1.whatsapp.sendText({
        to: telefone,
        text: `🔁 Gasto recorrente criado\n\n${nome} — ${(0, formatting_1.fmtValor)(valor)}\n${freqLabel}`,
    });
    logger_1.log.whatsapp("recorrente criado", { to: telefone, nome, valor, frequencia });
    (0, conversationEngine_1.recordAction)(user.id, "created_recurring");
    setTimeout(() => {
        (0, insightsEngine_1.checkAndSendOnboardingTip)(user.id, telefone, "recorrente_criado").catch(err => logger_1.log.error("falha ao verificar onboarding tip recorrente_criado", err, { userId: user.id }));
    }, 800);
    return {
        success: true,
        userId: user.id,
        transacao: {},
        interpretado: { comando: "recorrente", nome, valor, frequencia },
    };
}
