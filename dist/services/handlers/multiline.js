"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.looksLikeTransactionLine = looksLikeTransactionLine;
exports.detectMultiLine = detectMultiLine;
exports.handleMultiLineTransactions = handleMultiLineTransactions;
const client_1 = __importDefault(require("../../db/client"));
const whatsapp_1 = require("../whatsapp");
const logger_1 = require("../../utils/logger");
const formatting_1 = require("../../utils/formatting");
const parseTransaction_1 = require("../../utils/parseTransaction");
const conversationEngine_1 = require("../conversationEngine");
const recurringDetection_1 = require("../modules/recurringDetection");
const installments_1 = require("./installments");
function looksLikeTransactionLine(linha) {
    const t = linha.trim();
    if (!t || t.length < 2)
        return false;
    // Starts with a digit: "40 netflix", "30,50 mercado"
    if (/^[\d]/.test(t))
        return true;
    // Income: "+3000" or "+ 500"
    if (/^\+\s*[\d]/.test(t))
        return true;
    // Common expense/income verbs
    if (/^(gastei|paguei|pago|comprei|tomei|saiu|custou|recebi|salario|salário|renda|entrada|freelance|bonus|bônus)\s/i.test(t))
        return true;
    // Installment: "item Nx de valor" or "item N parcelas de valor"
    if (/^.+\s+\d{1,2}[xX]\s+[\d,.]+$/i.test(t))
        return true;
    if (/^.+\s+\d{1,2}\s+parcelas?\s+de\s+[\d,.]+$/i.test(t))
        return true;
    // Description before value: "Mercado 120", "Sorvete 38", "Disney Plus 34"
    if (/^[a-zA-ZÀ-ÿ][\w\sÀ-ÿ]+\s+[\d,.]+$/.test(t))
        return true;
    return false;
}
function detectMultiLine(texto) {
    const linhas = texto
        .split(/\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0);
    if (linhas.length < 2)
        return null;
    if (!linhas.every(looksLikeTransactionLine))
        return null;
    return linhas;
}
async function handleMultiLineTransactions(user, telefone, linhas) {
    const resultados = [];
    const falhas = [];
    for (const linha of linhas) {
        try {
            // Installment line: "iphone 12x de 345"
            const inst = (0, installments_1.detectInstallment)(linha);
            if (inst && !inst.needsParcela) {
                const { item, valor, totalParcelas } = inst;
                const total = valor * totalParcelas;
                const tempParsed = (0, parseTransaction_1.parseTransaction)(`${valor} ${item}`);
                const categoria = tempParsed?.categoria ?? "Outros";
                const descricao = (0, formatting_1.capitalizeFirst)(item);
                await client_1.default.query(`INSERT INTO transactions (user_id, tipo, valor, categoria, descricao) VALUES ($1, 'saida', $2, $3, $4)`, [user.id, valor, categoria, descricao]);
                const instResult = await client_1.default.query(`INSERT INTO installments (user_id, nome, valor_total, valor_parcela, total_parcelas, parcelas_pagas, categoria)
           VALUES ($1, $2, $3, $4, $5, 1, $6) RETURNING id`, [user.id, descricao, total, valor, totalParcelas, categoria]);
                const dbId = instResult.rows[0].id;
                (0, conversationEngine_1.setLastInstallment)(user.id, { item: descricao, valor, totalParcelas, parcelaAtual: 1, dbId, valorTotal: total });
                (0, conversationEngine_1.recordAction)(user.id, "registered_transaction");
                resultados.push({ descricao: `${descricao} (${totalParcelas}×)`, valor, tipo: "saida", categoria });
                continue;
            }
            // Regular expense / income
            const parsed = (0, parseTransaction_1.parseTransaction)(linha);
            if (!parsed) {
                falhas.push(linha);
                continue;
            }
            // Skip if matches a recurring expense (same check as single-line path)
            if (parsed.tipo === "saida") {
                const recMatch = await (0, recurringDetection_1.checkRecorrenteDuplicado)(user.id, parsed.descricao, parsed.valor);
                if (recMatch !== null) {
                    resultados.push({ descricao: `${recMatch.nome} (recorrente)`, valor: parsed.valor, tipo: "saida", categoria: parsed.categoria });
                    continue;
                }
            }
            await client_1.default.query(`INSERT INTO transactions (user_id, tipo, valor, categoria, descricao) VALUES ($1, $2, $3, $4, $5)`, [user.id, parsed.tipo, parsed.valor, parsed.categoria, parsed.descricao]);
            (0, conversationEngine_1.recordAction)(user.id, "registered_transaction");
            resultados.push({ descricao: parsed.descricao, valor: parsed.valor, tipo: parsed.tipo, categoria: parsed.categoria, textoOriginal: linha });
        }
        catch (err) {
            logger_1.log.error("falha ao processar linha multilinha", err, { linha, userId: user.id });
            falhas.push(linha);
        }
    }
    if (resultados.length === 0) {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: "Não consegui interpretar. Tenta uma linha por vez?" });
        return { success: false, userId: user.id, erro: "multilinha: nenhuma linha processada" };
    }
    const itens = resultados.map(r => {
        const sinal = r.tipo === "entrada" ? "+" : "";
        return `• ${sinal}${(0, formatting_1.fmtValor)(r.valor)} — ${r.descricao}`;
    });
    const header = resultados.length === 1
        ? "✅ Anotado!"
        : `✅ ${resultados.length} anotados:`;
    const partes = [header, "", ...itens];
    if (falhas.length > 0) {
        partes.push("", `Não entendi: ${falhas.join(", ")}`);
    }
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: partes.join("\n") });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar confirmação multilinha", err, { to: telefone });
    }
    // Notifica itens já salvos como recorrentes
    const jaFixos = resultados.filter(r => r.descricao.toLowerCase().includes("(recorrente)"));
    if (jaFixos.length > 0) {
        try {
            const nomes = jaFixos.map(r => (0, formatting_1.capitalizeFirst)(r.descricao.replace(/\s*\(recorrente\)/i, "")));
            const lista = nomes.length === 1 ? nomes[0] : nomes.slice(0, -1).join(", ") + " e " + nomes[nomes.length - 1];
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: `${lista} já está${nomes.length > 1 ? "m" : ""} nas suas contas fixas 🙂` });
        }
        catch (err) {
            logger_1.log.error("falha ao notificar recorrentes já salvos", err, { userId: user.id });
        }
    }
    // Verifica recorrentes nos itens de saída — sem gate de cooldown (lista é sinal explícito)
    const saidas = resultados.filter(r => r.tipo === "saida");
    logger_1.log.webhook("multilinha: saidas detectadas", { userId: user.id, count: saidas.length, descricoes: saidas.map(r => r.descricao) });
    if (saidas.length >= 1) {
        setTimeout(async () => {
            try {
                // Coleta todos os candidatos a recorrente: passam no score e ainda não estão cadastrados
                const candidatos = [];
                for (const r of saidas) {
                    if (r.descricao.toLowerCase().includes("(recorrente)")) {
                        logger_1.log.webhook("multilinha: skip recorrente conhecido", { userId: user.id, desc: r.descricao });
                        continue;
                    }
                    if (recurringDetection_1.NEVER_RECURRING.some(w => r.descricao.toLowerCase().includes(w))) {
                        logger_1.log.webhook("multilinha: skip never recurring", { userId: user.id, desc: r.descricao });
                        continue;
                    }
                    const jaRec = await client_1.default.query(`SELECT 1 FROM recurring_expenses WHERE user_id = $1 AND LOWER(TRIM(nome)) = $2 LIMIT 1`, [user.id, r.descricao.toLowerCase().trim()]);
                    if (jaRec.rows.length > 0) {
                        logger_1.log.webhook("multilinha: skip ja recorrente no db", { userId: user.id, desc: r.descricao });
                        continue;
                    }
                    // Avalia se o item tem perfil de recorrente: por sinal explícito/score ou por padrão histórico
                    const freqSignal = r.textoOriginal != null && (0, recurringDetection_1.detectFrequencyIntent)(r.textoOriginal);
                    const hasScore = (0, recurringDetection_1.isLikelyRecurring)(r.descricao, r.valor, r.categoria) || freqSignal;
                    const hasHistory = await (0, recurringDetection_1.checkHistoricalPattern)(user.id, r.descricao);
                    if (hasScore || hasHistory) {
                        candidatos.push(r);
                    }
                }
                logger_1.log.webhook("multilinha: candidatos confirmados", { userId: user.id, count: candidatos.length, nomes: candidatos.map(r => r.descricao) });
                if (candidatos.length === 1) {
                    // Um candidato — pergunta direta, sem gate de sentinel (lista é sinal explícito)
                    const r = candidatos[0];
                    const descNorm = r.descricao.toLowerCase().trim();
                    const jaRecDB = await client_1.default.query(`SELECT 1 FROM recurring_expenses WHERE user_id = $1 AND LOWER(TRIM(nome)) = $2 LIMIT 1`, [user.id, descNorm]);
                    if (jaRecDB.rows.length === 0) {
                        await client_1.default.query(`INSERT INTO pending_actions (user_id, action, step, tx_ids)
               VALUES ($1, 'confirmar_recorrente', 'waiting_confirmation', $2::jsonb)
               ON CONFLICT (user_id) DO UPDATE
                 SET action = 'confirmar_recorrente', step = 'waiting_confirmation', tx_ids = $2::jsonb,
                     selected_tx_id = NULL, expires_at = NOW() + INTERVAL '48 hours'`, [user.id, JSON.stringify({ nome: r.descricao, valor: r.valor, frequencia: "mensal" })]);
                        await whatsapp_1.whatsapp.sendText({
                            to: telefone,
                            text: `${(0, formatting_1.capitalizeFirst)(r.descricao)} aparece todo mês? 🔁`,
                        });
                        (0, conversationEngine_1.recordInsightSent)(user.id);
                    }
                }
                else if (candidatos.length >= 2) {
                    // Múltiplos candidatos — insere pending e envia pergunta
                    const payload = candidatos.map(r => ({ nome: r.descricao, valor: r.valor, frequencia: "mensal" }));
                    const lista = candidatos.map((r, i) => `${i + 1}. ${(0, formatting_1.capitalizeFirst)(r.descricao)} — ${(0, formatting_1.fmtValor)(r.valor)}`).join("\n");
                    try {
                        await client_1.default.query(`INSERT INTO pending_actions (user_id, action, step, tx_ids)
               VALUES ($1, 'confirmar_recorrente_multi', 'waiting_selection_multi', $2::jsonb)
               ON CONFLICT (user_id) DO UPDATE
                 SET action = 'confirmar_recorrente_multi', step = 'waiting_selection_multi', tx_ids = $2::jsonb,
                     selected_tx_id = NULL, expires_at = NOW() + INTERVAL '48 hours'`, [user.id, JSON.stringify(payload)]);
                        await whatsapp_1.whatsapp.sendText({
                            to: telefone,
                            text: `Algum desses acontece todo mês? 🔁\n\n${lista}\n\n(diz os números ou "todos")`,
                        });
                        (0, conversationEngine_1.recordInsightSent)(user.id);
                    }
                    catch (multiErr) {
                        logger_1.log.error("falha no fluxo recorrente multi", multiErr, { userId: user.id });
                        try {
                            await whatsapp_1.whatsapp.sendText({
                                to: telefone,
                                text: `Algum desses acontece todo mês? 🔁\n\n${lista}\n\n(diz os números ou "todos")`,
                            });
                            (0, conversationEngine_1.recordInsightSent)(user.id);
                        }
                        catch { /* silencioso */ }
                    }
                }
            }
            catch (err) {
                logger_1.log.error("falha ao verificar recorrentes multilinha", err, { userId: user.id });
            }
        }, 1200);
    }
    return {
        success: true,
        userId: user.id,
        transacao: {},
        interpretado: { comando: "multilinha", count: resultados.length },
    };
}
