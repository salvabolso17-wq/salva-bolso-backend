"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseNaturalEdit = parseNaturalEdit;
exports.findRecentTxByDesc = findRecentTxByDesc;
exports.handleApagarCommand = handleApagarCommand;
exports.handleApagarSelecao = handleApagarSelecao;
exports.handleCorrigirCommand = handleCorrigirCommand;
exports.handleCorrigirSelecao = handleCorrigirSelecao;
exports.handleCorrigirNovoValor = handleCorrigirNovoValor;
exports.handleNaturalCorrection = handleNaturalCorrection;
exports.handleNaturalDelete = handleNaturalDelete;
const client_1 = __importDefault(require("../../db/client"));
const whatsapp_1 = require("../whatsapp");
const logger_1 = require("../../utils/logger");
const formatting_1 = require("../../utils/formatting");
const parseTransaction_1 = require("../../utils/parseTransaction");
function parseNaturalEdit(texto) {
    const t = texto.trim().toLowerCase();
    // "apaga aquele uber", "remove a farmácia", "deleta o mercado"
    const delM = t.match(/^(?:apaga[r]?|remove[r]?|deleta[r]?|cancela[r]?)\s+(?:(?:esse[s]?|essa[s]?|aquele[s]?|aquela[s]?|o|a|os|as|um|uma)\s+)?([a-záéíóúãõâêôç][a-záéíóúãõâêôç\s]{0,30}?)[\?!.]*$/i);
    if (delM) {
        const desc = delM[1].trim();
        if (desc.length >= 2 && !/^([uú]ltimo[s]?|[uú]ltima[s]?|gasto[s]?|lan[cç]amento[s]?|item|coisa)$/.test(desc))
            return { tipo: "apagar", descBusca: desc };
    }
    // "corrige o mercado pra 80", "muda a academia para 150"
    const corrM = t.match(/(?:corri[gj]e[i]?|muda[r]?|atualiza[r]?)\s+(?:o\s+|a\s+)?([a-záéíóúãõâêôç][a-záéíóúãõâêôç\s]{0,25}?)\s+(?:pra?|para)\s+r?\$?\s*([\d,.]+)/i);
    if (corrM) {
        const valor = (0, parseTransaction_1.parseValor)(corrM[2]);
        if (!isNaN(valor) && valor > 0)
            return { tipo: "corrigir", descBusca: corrM[1].trim(), novoValor: valor };
    }
    // "o valor do aluguel foi 900", "o valor da academia era 150"
    const valM = t.match(/o\s+valor\s+d[oa]\s+([a-záéíóúãõâêôç][a-záéíóúãõâêôç\s]{0,25}?)\s+(?:foi|era|[eéè])\s+r?\$?\s*([\d,.]+)/i);
    if (valM) {
        const valor = (0, parseTransaction_1.parseValor)(valM[2]);
        if (!isNaN(valor) && valor > 0)
            return { tipo: "corrigir", descBusca: valM[1].trim(), novoValor: valor };
    }
    // "o ifood era 42 não 32"
    const eraM = t.match(/o\s+([a-záéíóúãõâêôç][a-záéíóúãõâêôç\s]{0,25}?)\s+era\s+r?\$?\s*([\d,.]+)\s+(?:n[aã]o|,\s*n[aã]o)/i);
    if (eraM) {
        const valor = (0, parseTransaction_1.parseValor)(eraM[2]);
        if (!isNaN(valor) && valor > 0)
            return { tipo: "corrigir", descBusca: eraM[1].trim(), novoValor: valor };
    }
    return null;
}
async function findRecentTxByDesc(userId, descBusca) {
    const desc = descBusca.toLowerCase().trim();
    const exact = await client_1.default.query(`SELECT id, descricao, valor, categoria FROM transactions
     WHERE user_id = $1 AND LOWER(descricao) = $2 AND criado_em >= NOW() - INTERVAL '30 days'
     ORDER BY criado_em DESC LIMIT 2`, [userId, desc]);
    if (exact.rows.length === 1) {
        const r = exact.rows[0];
        return { id: r.id, descricao: r.descricao, valor: Number(r.valor), categoria: r.categoria };
    }
    if (exact.rows.length > 1)
        return "multiple";
    const like = await client_1.default.query(`SELECT id, descricao, valor, categoria FROM transactions
     WHERE user_id = $1 AND LOWER(descricao) LIKE $2 AND criado_em >= NOW() - INTERVAL '30 days'
     ORDER BY criado_em DESC LIMIT 2`, [userId, `%${desc}%`]);
    if (like.rows.length === 1) {
        const r = like.rows[0];
        return { id: r.id, descricao: r.descricao, valor: Number(r.valor), categoria: r.categoria };
    }
    if (like.rows.length > 1)
        return "multiple";
    return null;
}
async function handleApagarCommand(user, telefone) {
    logger_1.log.webhook("comando apagar", { userId: user.id });
    const result = await client_1.default.query(`SELECT id, tipo, valor, categoria, descricao
     FROM transactions
     WHERE user_id = $1
     ORDER BY criado_em DESC
     LIMIT 5`, [user.id]);
    if (result.rows.length === 0) {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: "Nenhum lançamento encontrado para remover." });
        return { success: false, userId: user.id, erro: "Sem transações" };
    }
    const txIds = result.rows.map(r => r.id);
    await client_1.default.query(`INSERT INTO pending_actions (user_id, action, step, tx_ids)
     VALUES ($1, 'apagar', 'waiting_selection', $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE
       SET action = 'apagar', step = 'waiting_selection', tx_ids = $2::jsonb,
           selected_tx_id = NULL, expires_at = NOW() + INTERVAL '10 minutes'`, [user.id, JSON.stringify(txIds)]);
    const linhas = ["Qual lançamento deseja remover?", ""];
    result.rows.forEach((row, i) => {
        const desc = row.descricao ?? row.categoria;
        const icon = row.tipo === "entrada" ? "💰" : "💸";
        linhas.push(`${i + 1}. ${icon} ${desc} — ${(0, formatting_1.fmtValor)(Number(row.valor))}`);
    });
    linhas.push(``, `Envie o número ou "cancelar".`);
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
        logger_1.log.whatsapp("apagar step1 enviado", { to: telefone, count: result.rows.length });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar apagar step1", err, { to: telefone });
    }
    return { success: false, userId: user.id, erro: "Aguardando seleção" };
}
async function handleApagarSelecao(user, telefone, txId) {
    logger_1.log.webhook("apagar selecao", { userId: user.id, txId });
    await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    const txResult = await client_1.default.query(`DELETE FROM transactions WHERE id = $1 AND user_id = $2 RETURNING tipo, valor, categoria, descricao`, [txId, user.id]);
    if (txResult.rows.length === 0) {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: "Lançamento não encontrado." });
        return { success: false, userId: user.id, erro: "Transação não encontrada" };
    }
    const tx = txResult.rows[0];
    const linhas = [
        "✅ Lançamento removido:",
        "",
        `${tx.descricao ?? tx.categoria} — ${(0, formatting_1.fmtValor)(Number(tx.valor))}`,
    ];
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
        logger_1.log.whatsapp("apagar confirmado", { to: telefone, txId });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar apagar confirmacao", err, { to: telefone });
    }
    return {
        success: true,
        userId: user.id,
        transacao: {},
        interpretado: { comando: "apagar", txId, valor: Number(tx.valor), categoria: tx.categoria },
    };
}
async function handleCorrigirCommand(user, telefone) {
    logger_1.log.webhook("comando corrigir", { userId: user.id });
    const result = await client_1.default.query(`SELECT id, tipo, valor, categoria, descricao
     FROM transactions
     WHERE user_id = $1
     ORDER BY criado_em DESC
     LIMIT 5`, [user.id]);
    if (result.rows.length === 0) {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: "Nenhum lançamento encontrado para corrigir." });
        return { success: false, userId: user.id, erro: "Sem transações" };
    }
    const txIds = result.rows.map(r => r.id);
    await client_1.default.query(`INSERT INTO pending_actions (user_id, action, step, tx_ids)
     VALUES ($1, 'corrigir', 'waiting_selection', $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE
       SET action = 'corrigir', step = 'waiting_selection', tx_ids = $2::jsonb,
           selected_tx_id = NULL, expires_at = NOW() + INTERVAL '10 minutes'`, [user.id, JSON.stringify(txIds)]);
    const linhas = ["Qual lançamento deseja corrigir?", ""];
    result.rows.forEach((row, i) => {
        const desc = row.descricao ?? row.categoria;
        const icon = row.tipo === "entrada" ? "💰" : "💸";
        linhas.push(`${i + 1}. ${icon} ${desc} — ${(0, formatting_1.fmtValor)(Number(row.valor))}`);
    });
    linhas.push(``, `Envie o número ou "cancelar".`);
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
        logger_1.log.whatsapp("corrigir step1 enviado", { to: telefone, count: result.rows.length });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar corrigir step1", err, { to: telefone });
    }
    return { success: false, userId: user.id, erro: "Aguardando seleção" };
}
async function handleCorrigirSelecao(user, telefone, txId) {
    logger_1.log.webhook("corrigir selecao", { userId: user.id, txId });
    const txResult = await client_1.default.query(`SELECT valor, categoria, descricao FROM transactions WHERE id = $1 AND user_id = $2`, [txId, user.id]);
    if (txResult.rows.length === 0) {
        await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: "Lançamento não encontrado." });
        return { success: false, userId: user.id, erro: "Transação não encontrada" };
    }
    const tx = txResult.rows[0];
    await client_1.default.query(`UPDATE pending_actions
     SET step = 'waiting_new_value', selected_tx_id = $2, expires_at = NOW() + INTERVAL '10 minutes'
     WHERE user_id = $1`, [user.id, txId]);
    const linhas = [
        "Envie o novo valor e descrição.",
        `Ex: ${(0, formatting_1.fmtValor)(Number(tx.valor))} ${tx.descricao ?? tx.categoria}`,
        "",
        `Ou "cancelar" para desistir.`,
    ];
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
        logger_1.log.whatsapp("corrigir step2 enviado", { to: telefone, txId });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar corrigir step2", err, { to: telefone });
    }
    return { success: false, userId: user.id, erro: "Aguardando novo valor" };
}
async function handleCorrigirNovoValor(user, telefone, texto, txId) {
    logger_1.log.webhook("corrigir novo valor", { userId: user.id, txId, texto });
    const parsed = (0, parseTransaction_1.parseTransaction)(texto);
    if (!parsed) {
        await whatsapp_1.whatsapp.sendText({
            to: telefone,
            text: `💡 Ex:\n50 mercado\n\nou "cancelar"`,
        });
        return { success: false, userId: user.id, erro: "Input inválido para correção" };
    }
    await client_1.default.query(`UPDATE transactions SET valor = $1, categoria = $2, descricao = $3, tipo = $4
     WHERE id = $5 AND user_id = $6`, [parsed.valor, parsed.categoria, parsed.descricao, parsed.tipo, txId, user.id]);
    await client_1.default.query(`DELETE FROM pending_actions WHERE user_id = $1`, [user.id]);
    const linhas = [
        "✅ Lançamento atualizado:",
        "",
        `${parsed.descricao ?? parsed.categoria} — ${(0, formatting_1.fmtValor)(parsed.valor)}`,
    ];
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
        logger_1.log.whatsapp("corrigir confirmado", { to: telefone, txId, valor: parsed.valor });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar corrigir confirmacao", err, { to: telefone });
    }
    return {
        success: true,
        userId: user.id,
        transacao: {},
        interpretado: { comando: "corrigir", txId, valor: parsed.valor, categoria: parsed.categoria },
    };
}
async function handleNaturalCorrection(user, telefone, descBusca, novoValor) {
    try {
        const tx = await findRecentTxByDesc(user.id, descBusca);
        if (tx === null || tx === "multiple")
            return await handleCorrigirCommand(user, telefone);
        await client_1.default.query(`UPDATE transactions SET valor = $1 WHERE id = $2 AND user_id = $3`, [novoValor, tx.id, user.id]);
        const nome = (0, formatting_1.capitalizeFirst)(tx.descricao);
        try {
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: `✅ ${nome} atualizado para ${(0, formatting_1.fmtValor)(novoValor)}.` });
            logger_1.log.whatsapp("corrigir_natural ok", { to: telefone, userId: user.id, txId: tx.id, novoValor });
        }
        catch (err) {
            logger_1.log.error("falha ao confirmar corrigir_natural", err, { userId: user.id });
        }
        return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "corrigir_natural", txId: tx.id, novoValor } };
    }
    catch (err) {
        logger_1.log.error("falha handleNaturalCorrection", err, { userId: user.id });
        return await handleCorrigirCommand(user, telefone);
    }
}
async function handleNaturalDelete(user, telefone, descBusca) {
    try {
        const tx = await findRecentTxByDesc(user.id, descBusca);
        if (tx === null || tx === "multiple")
            return await handleApagarCommand(user, telefone);
        await client_1.default.query(`DELETE FROM transactions WHERE id = $1 AND user_id = $2`, [tx.id, user.id]);
        const nome = (0, formatting_1.capitalizeFirst)(tx.descricao);
        try {
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: `Pronto, ${nome} removido.` });
            logger_1.log.whatsapp("apagar_natural ok", { to: telefone, userId: user.id, txId: tx.id });
        }
        catch (err) {
            logger_1.log.error("falha ao confirmar apagar_natural", err, { userId: user.id });
        }
        return { success: false, userId: user.id, erro: "apagar_natural_ok" };
    }
    catch (err) {
        logger_1.log.error("falha handleNaturalDelete", err, { userId: user.id });
        return await handleApagarCommand(user, telefone);
    }
}
