"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectGoalIntent = detectGoalIntent;
exports.handleMetaCommand = handleMetaCommand;
exports.handleMetasCommand = handleMetasCommand;
exports.handleGuardarCommand = handleGuardarCommand;
exports.handleAddToGoal = handleAddToGoal;
exports.handleGoalProgress = handleGoalProgress;
exports.handleCreateGoalNoValue = handleCreateGoalNoValue;
exports.handleGoalPercentage = handleGoalPercentage;
exports.handleGoalAmountSaved = handleGoalAmountSaved;
const client_1 = __importDefault(require("../../db/client"));
const whatsapp_1 = require("../whatsapp");
const logger_1 = require("../../utils/logger");
const formatting_1 = require("../../utils/formatting");
const parseTransaction_1 = require("../../utils/parseTransaction");
const conversationEngine_1 = require("../conversationEngine");
const insightsEngine_1 = require("../modules/insightsEngine");
function detectGoalIntent(texto) {
    const t = texto.trim();
    const tl = t.toLowerCase();
    // ── criar sem valor ────────────────────────────────────────────────────
    // "guardar dinheiro pro carro", "juntar dinheiro pra viagem"
    let m = tl.match(/^(?:quero\s+)?(?:guard|poup|junt)(?:ar|a)\s+dinheiro\s+(?:na?|no|pra?|para|pro?s?)\s+(.+)$/);
    if (m)
        return { type: "criar_sem_valor", nome: m[1].trim() };
    // "quero uma meta pro videogame", "criar meta pra carro"
    m = tl.match(/^(?:quero\s+)?(?:criar\s+)?uma?\s+meta\s+(?:pra?|para|pro?)\s+(.+)$/);
    if (m)
        return { type: "criar_sem_valor", nome: m[1].trim() };
    // ── progresso ──────────────────────────────────────────────────────────
    // "quanto falta?", "quanto falta pra viagem?"
    m = tl.match(/^quanto\s+falta\s*(?:(?:pra?|para|pro?)\s+(.+?))?[?!.]*$/);
    if (m)
        return { type: "progresso", nome: m[1]?.trim() || undefined };
    // "como tá minha meta?", "como tá a meta de viagem?"
    m = tl.match(/^como\s+t[aá]\s+(?:(?:a|minha?)\s+)?meta(?:\s+(?:de|do?a?)\s+(.+?))?[?!.]*$/);
    if (m)
        return { type: "progresso", nome: m[1]?.trim() || undefined };
    if (/^como\s+t[aá]\s+(?:o\s+)?meu?\s+objetivo[?!.]*$/.test(tl))
        return { type: "progresso" };
    // ── adicionar ─────────────────────────────────────────────────────────
    // "consegui guardar mais 50 pra viagem"
    m = t.match(/^consegui\s+(?:guard|poup|junt|separ|coloc)(?:ar|a)\s+(?:mais\s+)?([\d,.]+)\s*(?:(?:na?|no|pra?|para|pro?|em)\s+(.+))?$/i);
    if (m)
        return { type: "adicionar", valor: (0, parseTransaction_1.parseValor)(m[1]), nome: m[2]?.trim() || undefined };
    // "quero guardar 200", "separa 100 pra viagem", "poupa 150", "guardar 300 na meta viagem"
    m = t.match(/^(?:quero\s+)?(?:guard|poup|junt|separ|coloc|bot|adicion)(?:ar|a)\s+([\d,.]+)\s*(?:(?:na?|no|pra?|para|pro?|em)\s+(.+))?$/i);
    if (m)
        return { type: "adicionar", valor: (0, parseTransaction_1.parseValor)(m[1]), nome: m[2]?.trim() || undefined };
    // "já juntei 300", "guardei 200", "juntei 150 pra viagem"
    m = t.match(/^(?:j[aá]\s+)?(?:guard|poup|junt|separ|coloc)ei\s+([\d,.]+)\s*(?:(?:na?|no|pra?|para|em)\s+(.+))?$/i);
    if (m)
        return { type: "adicionar", valor: (0, parseTransaction_1.parseValor)(m[1]), nome: m[2]?.trim() || undefined };
    // ── consultas de progresso / contexto ─────────────────────────────────
    // "qual porcentagem?", "que percentual?", "qual o percentual?"
    if (/\b(qual\s+(é\s+|é\s+a\s+|a\s+)?porcentagem|que\s+porcentagem|qual\s+o\s+percentual|que\s+percentual)\b[?!.]*/.test(tl)) {
        return { type: "porcentagem" };
    }
    // "quanto já juntei?", "quanto eu já guardei?", "quanto tenho guardado?", "quanto já guardei?"
    if (/^quanto\s+(?:j[aá]\s+)?(juntei|guardei|poupei)[?!.]*$/.test(tl) ||
        /^quanto\s+tenho\s+guardado[?!.]*$/.test(tl) ||
        /^quanto\s+eu\s+j[aá]\s+(juntei|guardei|poupei)[?!.]*$/.test(tl)) {
        return { type: "juntei" };
    }
    return null;
}
async function handleMetaCommand(user, telefone, texto) {
    logger_1.log.webhook("comando meta", { userId: user.id, texto });
    const match = texto.match(/^meta\s+(.+?)\s+([\d,.]+)$/i);
    if (!match) {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: "💡 Ex:\nmeta viagem 5000" });
        return { success: false, userId: user.id, erro: "Formato inválido" };
    }
    const nome = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
    const valorMeta = (0, parseTransaction_1.parseValor)(match[2]);
    await client_1.default.query(`INSERT INTO user_goals (user_id, nome, valor_meta)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, nome)
     DO UPDATE SET valor_meta = $3`, [user.id, nome, valorMeta]);
    await whatsapp_1.whatsapp.sendText({
        to: telefone,
        text: `🎯 Meta criada: ${nome}\nObjetivo: ${(0, formatting_1.fmtValor)(valorMeta)}`,
    });
    (0, conversationEngine_1.setLastGoal)(user.id, { nome, valorMeta });
    (0, conversationEngine_1.recordAction)(user.id, "created_goal");
    setTimeout(() => {
        (0, insightsEngine_1.checkAndSendOnboardingTip)(user.id, telefone, "meta_criada").catch(err => logger_1.log.error("falha ao verificar onboarding tip", err, { userId: user.id }));
    }, 800);
    return {
        success: true,
        userId: user.id,
        transacao: {},
        interpretado: { comando: "meta", nome, valorMeta },
    };
}
async function handleMetasCommand(user, telefone) {
    logger_1.log.webhook("comando metas", { userId: user.id });
    const result = await client_1.default.query(`SELECT nome, valor_meta, valor_atual
     FROM user_goals
     WHERE user_id = $1
     ORDER BY criado_em ASC`, [user.id]);
    if (result.rows.length === 0) {
        await whatsapp_1.whatsapp.sendText({
            to: telefone,
            text: "Você ainda não tem metas.\n\n💡 Ex:\nmeta viagem 5000",
        });
        return {
            success: true,
            userId: user.id,
            transacao: {},
            interpretado: { comando: "metas", count: 0 },
        };
    }
    const linhas = ["🎯 Suas metas", ""];
    for (const row of result.rows) {
        const meta = Number(row.valor_meta);
        const atual = Number(row.valor_atual);
        const percent = meta > 0 ? Math.round((atual / meta) * 100) : 0;
        linhas.push(`${row.nome} — ${(0, formatting_1.fmtValor)(atual)} / ${(0, formatting_1.fmtValor)(meta)} (${percent}%)`);
    }
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
        logger_1.log.whatsapp("metas enviado", { to: telefone, count: result.rows.length });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar metas", err, { to: telefone });
    }
    return {
        success: true,
        userId: user.id,
        transacao: {},
        interpretado: { comando: "metas", count: result.rows.length },
    };
}
async function handleGuardarCommand(user, telefone, texto) {
    logger_1.log.webhook("comando guardar", { userId: user.id, texto });
    const match = texto.match(/^guardar\s+([\d,.]+)\s+(.+)$/i);
    if (!match) {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: "Quando quiser adicionar dinheiro, pode falar algo como:\nguardar 200 viagem 🎯" });
        return { success: false, userId: user.id, erro: "Formato inválido" };
    }
    const valor = (0, parseTransaction_1.parseValor)(match[1]);
    const rawNome = match[2].replace(/^(?:na?|no|em|pra?|para|pro?)\s+/i, "").trim();
    const nome = rawNome.charAt(0).toUpperCase() + rawNome.slice(1).toLowerCase();
    const result = await client_1.default.query(`UPDATE user_goals
     SET valor_atual = valor_atual + $1
     WHERE user_id = $2 AND LOWER(nome) = LOWER($3)
     RETURNING nome, valor_meta, valor_atual`, [valor, user.id, nome]);
    if (result.rows.length === 0) {
        await whatsapp_1.whatsapp.sendText({
            to: telefone,
            text: `Meta "${nome}" não encontrada.\nCrie com: meta ${nome.toLowerCase()} <valor>`,
        });
        return { success: false, userId: user.id, erro: "Meta não encontrada" };
    }
    const row = result.rows[0];
    const meta = Number(row.valor_meta);
    const atual = Number(row.valor_atual);
    const percent = meta > 0 ? Math.round((atual / meta) * 100) : 0;
    const acabouAgora = (atual - valor) < meta && atual >= meta;
    (0, conversationEngine_1.setLastGoal)(user.id, { nome: row.nome, valorMeta: meta });
    const linhas = [
        `🎯 ${(0, formatting_1.fmtValor)(valor)} adicionados à meta ${row.nome}`,
        "",
        "Progresso:",
        `${(0, formatting_1.fmtValor)(atual)} / ${(0, formatting_1.fmtValor)(meta)} (${percent}%)`,
    ];
    if (atual >= meta && !acabouAgora)
        linhas.push("", "✅ Meta já concluída!");
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
        logger_1.log.whatsapp("guardar enviado", { to: telefone, nome: row.nome, atual, meta });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar guardar", err, { to: telefone });
    }
    if (acabouAgora) {
        setTimeout(async () => {
            try {
                const celebracao = [
                    `🏆 Meta "${row.nome}" concluída!`,
                    "",
                    `${(0, formatting_1.fmtValor)(meta)} guardados.`,
                ].join("\n");
                await whatsapp_1.whatsapp.sendText({ to: telefone, text: celebracao });
                logger_1.log.whatsapp("celebracao meta enviada", { to: telefone, nome: row.nome, meta });
            }
            catch (err) {
                logger_1.log.error("falha ao enviar celebracao meta", err, { to: telefone });
            }
        }, 1500);
    }
    return {
        success: true,
        userId: user.id,
        transacao: {},
        interpretado: { comando: "guardar", nome: row.nome, valor, atual, meta },
    };
}
async function handleAddToGoal(user, telefone, valor, nomeHint) {
    let goalRow = null;
    if (nomeHint) {
        const r = await client_1.default.query(`SELECT nome, valor_meta, valor_atual FROM user_goals
       WHERE user_id = $1 AND LOWER(nome) ILIKE '%' || LOWER($2) || '%'
       ORDER BY criado_em ASC LIMIT 1`, [user.id, nomeHint]);
        goalRow = r.rows[0] ?? null;
        if (!goalRow) {
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: `Meta "${nomeHint}" não encontrada.\nCrie assim: meta ${nomeHint} 5000` });
            return { success: false, userId: user.id, erro: "Meta não encontrada" };
        }
    }
    else {
        // No name given — check how many goals the user has before assuming anything
        const r = await client_1.default.query(`SELECT nome, valor_meta, valor_atual FROM user_goals WHERE user_id = $1 ORDER BY criado_em ASC`, [user.id]);
        if (r.rows.length === 0) {
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: `Você não tem metas ainda.\nCrie assim: meta viagem 5000 🎯` });
            return { success: false, userId: user.id, erro: "Sem metas" };
        }
        if (r.rows.length === 1) {
            goalRow = r.rows[0];
        }
        else {
            // Multiple goals — always ask to avoid adding to the wrong one
            const lista = r.rows.map(row => `• ${row.nome}`).join("\n");
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: `Para qual meta?\n${lista}\n\nEx: guardar ${Math.round(valor)} ${r.rows[0].nome.toLowerCase()}` });
            return { success: false, userId: user.id, erro: "ambiguous goal" };
        }
    }
    const result = await client_1.default.query(`UPDATE user_goals SET valor_atual = valor_atual + $1
     WHERE user_id = $2 AND LOWER(nome) = LOWER($3)
     RETURNING nome, valor_meta, valor_atual`, [valor, user.id, goalRow.nome]);
    if (result.rows.length === 0) {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: "Algo deu errado. Tenta de novo?" });
        return { success: false, userId: user.id, erro: "Goal update failed" };
    }
    const row = result.rows[0];
    const meta = Number(row.valor_meta);
    const atual = Number(row.valor_atual);
    const percent = meta > 0 ? Math.round((atual / meta) * 100) : 0;
    const concluiu = meta > 0 && (atual - valor) < meta && atual >= meta;
    (0, conversationEngine_1.setLastGoal)(user.id, { nome: row.nome, valorMeta: meta });
    (0, conversationEngine_1.recordAction)(user.id, "created_goal");
    const linhas = [`✅ ${(0, formatting_1.fmtValor)(valor)} adicionados — ${row.nome}`];
    if (meta > 0) {
        linhas.push("", `${(0, formatting_1.fmtValor)(atual)} de ${(0, formatting_1.fmtValor)(meta)} (${percent}%)`);
    }
    else {
        linhas.push("", `Total guardado: ${(0, formatting_1.fmtValor)(atual)}`);
    }
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: linhas.join("\n") });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar add to goal", err, { to: telefone });
    }
    if (concluiu) {
        setTimeout(async () => {
            try {
                await whatsapp_1.whatsapp.sendText({ to: telefone, text: `🏆 Meta "${row.nome}" concluída!\n\n${(0, formatting_1.fmtValor)(meta)} guardados.` });
            }
            catch (err) {
                logger_1.log.error("falha ao enviar celebracao meta", err, { to: telefone });
            }
        }, 1500);
    }
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "adicionar_meta", nome: row.nome, valor, atual, meta } };
}
async function handleGoalProgress(user, telefone, nomeHint) {
    const showGoal = (row) => {
        const meta = Number(row.valor_meta);
        const atual = Number(row.valor_atual);
        const percent = meta > 0 ? Math.round((atual / meta) * 100) : 0;
        const falta = meta > atual ? meta - atual : 0;
        if (meta > 0) {
            return `${row.nome} — ${(0, formatting_1.fmtValor)(atual)} de ${(0, formatting_1.fmtValor)(meta)} (${percent}%)\n${falta > 0 ? `Faltam ${(0, formatting_1.fmtValor)(falta)}` : "Concluída ✅"}`;
        }
        return `${row.nome} — ${(0, formatting_1.fmtValor)(atual)} guardados`;
    };
    if (nomeHint) {
        const r = await client_1.default.query(`SELECT nome, valor_meta, valor_atual FROM user_goals
       WHERE user_id = $1 AND LOWER(nome) ILIKE '%' || LOWER($2) || '%'
       ORDER BY criado_em ASC LIMIT 1`, [user.id, nomeHint]);
        if (!r.rows[0]) {
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: `Meta "${nomeHint}" não encontrada.` });
            return { success: false, userId: user.id, erro: "Meta não encontrada" };
        }
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: showGoal(r.rows[0]) });
        return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "progresso_meta", nome: r.rows[0].nome } };
    }
    // Try lastGoal in session
    const last = (0, conversationEngine_1.getLastGoal)(user.id);
    if (last) {
        const r = await client_1.default.query(`SELECT nome, valor_meta, valor_atual FROM user_goals WHERE user_id = $1 AND LOWER(nome) = LOWER($2) LIMIT 1`, [user.id, last.nome]);
        if (r.rows[0]) {
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: showGoal(r.rows[0]) });
            return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "progresso_meta", nome: r.rows[0].nome } };
        }
    }
    // Fallback: show all metas
    return await handleMetasCommand(user, telefone);
}
async function handleCreateGoalNoValue(user, telefone, nome) {
    const nomeFormatado = nome.charAt(0).toUpperCase() + nome.slice(1).toLowerCase();
    const txt = `Perfeito 🙂\nQual o valor que quer guardar pro ${nomeFormatado}?\n\nEx: meta ${nome.toLowerCase()} 15000`;
    await whatsapp_1.whatsapp.sendText({ to: telefone, text: txt });
    return { success: false, userId: user.id, erro: "goal without value" };
}
async function handleGoalPercentage(user, telefone) {
    const last = (0, conversationEngine_1.getLastGoal)(user.id);
    if (!last)
        return await handleMetasCommand(user, telefone);
    const r = await client_1.default.query(`SELECT nome, valor_meta, valor_atual FROM user_goals WHERE user_id = $1 AND LOWER(nome) = LOWER($2) LIMIT 1`, [user.id, last.nome]);
    if (!r.rows[0])
        return await handleMetasCommand(user, telefone);
    const row = r.rows[0];
    const meta = Number(row.valor_meta);
    const atual = Number(row.valor_atual);
    const percent = meta > 0 ? Math.round((atual / meta) * 100) : 0;
    const txt = meta > 0
        ? `${row.nome} — ${percent}% concluída\n${(0, formatting_1.fmtValor)(atual)} de ${(0, formatting_1.fmtValor)(meta)}`
        : `${row.nome} — ${(0, formatting_1.fmtValor)(atual)} guardados (sem valor-alvo definido)`;
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: txt });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar porcentagem meta", err, { to: telefone });
    }
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "porcentagem_meta", nome: row.nome } };
}
async function handleGoalAmountSaved(user, telefone) {
    const last = (0, conversationEngine_1.getLastGoal)(user.id);
    if (!last)
        return await handleMetasCommand(user, telefone);
    const r = await client_1.default.query(`SELECT nome, valor_meta, valor_atual FROM user_goals WHERE user_id = $1 AND LOWER(nome) = LOWER($2) LIMIT 1`, [user.id, last.nome]);
    if (!r.rows[0])
        return await handleMetasCommand(user, telefone);
    const row = r.rows[0];
    const meta = Number(row.valor_meta);
    const atual = Number(row.valor_atual);
    const percent = meta > 0 ? Math.round((atual / meta) * 100) : 0;
    const txt = meta > 0
        ? `${row.nome} — ${(0, formatting_1.fmtValor)(atual)} guardados (${percent}%)`
        : `${row.nome} — ${(0, formatting_1.fmtValor)(atual)} guardados`;
    try {
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: txt });
    }
    catch (err) {
        logger_1.log.error("falha ao enviar juntei meta", err, { to: telefone });
    }
    return { success: true, userId: user.id, transacao: {}, interpretado: { comando: "juntei_meta", nome: row.nome } };
}
