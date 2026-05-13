"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkAndSendOnboardingTip = checkAndSendOnboardingTip;
exports.checkAndSendInsights = checkAndSendInsights;
exports.checkAndSendSmartInsights = checkAndSendSmartInsights;
exports.sendContextualMicroInsight = sendContextualMicroInsight;
const client_1 = __importDefault(require("../../db/client"));
const whatsapp_1 = require("../whatsapp");
const logger_1 = require("../../utils/logger");
const formatting_1 = require("../../utils/formatting");
const reportService_1 = require("../reportService");
const ONBOARDING_TIPS = {
    10: `Para guardar na meta: guardar 200 viagem 🎯`,
    11: `A previsão mostra como o mês vai fechar.`,
    12: `As próximas listam tudo que vence em breve.`,
};
async function checkAndSendOnboardingTip(userId, telefone, evento) {
    // mes_referencia fixo como sentinel de lifetime (não se repete mensalmente)
    const LIFETIME = new Date("2000-01-01");
    let tipId = null;
    if (evento === "saida") {
        const countRow = await client_1.default.query(`SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`, [userId]);
        const n = Number(countRow.rows[0].count);
        if (n === 1) {
            tipId = 1;
        }
        else if (n >= 7) {
            // Aha moment: só dispara com contexto real (3+ categorias distintas)
            const catRow = await client_1.default.query(`SELECT COUNT(DISTINCT categoria) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`, [userId]);
            if (Number(catRow.rows[0].count) < 3)
                return false; // contexto fraco → silêncio
            const now = new Date();
            const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
            const fimMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
            const metrics = await (0, reportService_1.fetchPeriodMetrics)(userId, inicioMes, fimMes);
            if (!metrics.total_saidas || !metrics.gastos_por_categoria[0])
                return false;
            const inserted = await client_1.default.query(`INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
         VALUES ($1, 'aha_moment', 4, $2)
         ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`, [userId, LIFETIME]);
            if ((inserted.rowCount ?? 0) === 0)
                return false;
            const top = metrics.gastos_por_categoria[0];
            const texto = `${(0, formatting_1.capitalizeFirst)(top.categoria)} liderou o mês até agora 🙂`;
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: texto });
            logger_1.log.whatsapp("aha moment enviado", { to: telefone, userId, totalSaidas: metrics.total_saidas });
            return true;
        }
    }
    else if (evento === "recorrente_criado") {
        tipId = 12; // criou recorrente → próximas
    }
    else if (evento === "meta_criada") {
        tipId = 10;
    }
    else if (evento === "limite_criado") {
        tipId = 11;
    }
    if (tipId === null)
        return false;
    const tipText = ONBOARDING_TIPS[tipId];
    if (!tipText)
        return false;
    const inserted = await client_1.default.query(`INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
     VALUES ($1, 'onboarding', $2, $3)
     ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`, [userId, tipId, LIFETIME]);
    if ((inserted.rowCount ?? 0) === 0)
        return false;
    await whatsapp_1.whatsapp.sendText({ to: telefone, text: tipText });
    logger_1.log.whatsapp("onboarding tip enviado", { to: telefone, tipId });
    return true;
}
async function checkAndSendInsights(userId, telefone, categoria) {
    const countRow = await client_1.default.query(`SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`, [userId]);
    const insightThreshold = 10;
    if (Number(countRow.rows[0].count) < insightThreshold)
        return false;
    const now = new Date();
    const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const fimMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const metrics = await (0, reportService_1.fetchPeriodMetrics)(userId, inicioMes, fimMes);
    if (metrics.total_saidas === 0)
        return false;
    const catRow = metrics.gastos_por_categoria.find(c => c.categoria.toLowerCase() === categoria.toLowerCase());
    if (!catRow)
        return false;
    const percentual = Math.round((catRow.total / metrics.total_saidas) * 100);
    if (percentual < 50)
        return false;
    const marco = 50;
    const mesRef = inicioMes;
    const inserted = await client_1.default.query(`INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`, [userId, categoria, marco, mesRef]);
    if ((inserted.rowCount ?? 0) === 0)
        return false;
    const insightTexto = percentual >= 65
        ? `${categoria} tá puxando bastante esse mês 👀`
        : `${categoria} tá acima da metade dos gastos este mês.`;
    await whatsapp_1.whatsapp.sendText({ to: telefone, text: insightTexto });
    logger_1.log.whatsapp("insight enviado", { to: telefone, categoria, percentual, marco });
    return true;
}
// Insights inteligentes baseados em comparação de períodos e padrões de frequência
async function checkAndSendSmartInsights(userId, telefone, descricao, categoria) {
    try {
        const now = new Date();
        const ano = now.getUTCFullYear();
        const mes = now.getUTCMonth();
        const dia = now.getUTCDate();
        const LIFETIME = new Date("2000-01-01");
        const inicioMesAtual = new Date(Date.UTC(ano, mes, 1));
        const inicioMesAnterior = new Date(Date.UTC(ano, mes - 1, 1));
        const mesmoPeriodoAnterior = new Date(Date.UTC(ano, mes - 1, dia));
        // Precisa de ao menos 5 saídas para comparações fazerem sentido
        const totalRow = await client_1.default.query(`SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida'`, [userId]);
        if (Number(totalRow.rows[0].count) < 5)
            return false;
        function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
        async function tryInsight(sentinel, mesRef, texto) {
            const ins = await client_1.default.query(`INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`, [userId, sentinel, mesRef]);
            if ((ins.rowCount ?? 0) === 0)
                return false;
            await whatsapp_1.whatsapp.sendText({ to: telefone, text: texto });
            logger_1.log.whatsapp("smart insight enviado", { to: telefone, userId, sentinel });
            return true;
        }
        // ── 1. Frequência: mesma descrição 3+ vezes nos últimos 30 dias ──────────
        const descNorm = descricao.toLowerCase().trim();
        const freqRow = await client_1.default.query(`SELECT COUNT(*) AS count FROM transactions
       WHERE user_id = $1 AND tipo = 'saida' AND LOWER(descricao) = $2
         AND criado_em >= NOW() - INTERVAL '30 days'`, [userId, descNorm]);
        if (Number(freqRow.rows[0].count) >= 3) {
            const jaRec = await client_1.default.query(`SELECT 1 FROM recurring_expenses WHERE user_id = $1 AND LOWER(nome) = $2 AND ativo = TRUE LIMIT 1`, [userId, descNorm]);
            if (jaRec.rows.length === 0) {
                const sentinel = `smart_freq_${descNorm.replace(/\W+/g, "_").slice(0, 40)}`;
                const texto = `${(0, formatting_1.capitalizeFirst)(descricao)} aparece bastante nos seus gastos recentes.`;
                if (await tryInsight(sentinel, inicioMesAtual, texto))
                    return true;
            }
        }
        // ── 2–5. Comparação de períodos — só a partir do dia 5 do mês ────────────
        if (dia < 5)
            return false;
        const [curRow, prevRow, catCurRow, catPrevRow] = await Promise.all([
            client_1.default.query(`SELECT COALESCE(SUM(valor), 0) AS total FROM transactions
         WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2`, [userId, inicioMesAtual]),
            client_1.default.query(`SELECT COALESCE(SUM(valor), 0) AS total FROM transactions
         WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2 AND criado_em < $3`, [userId, inicioMesAnterior, mesmoPeriodoAnterior]),
            client_1.default.query(`SELECT COALESCE(SUM(valor), 0) AS total FROM transactions
         WHERE user_id = $1 AND tipo = 'saida' AND LOWER(categoria) = LOWER($2) AND criado_em >= $3`, [userId, categoria, inicioMesAtual]),
            client_1.default.query(`SELECT COALESCE(SUM(valor), 0) AS total FROM transactions
         WHERE user_id = $1 AND tipo = 'saida' AND LOWER(categoria) = LOWER($2)
           AND criado_em >= $3 AND criado_em < $4`, [userId, categoria, inicioMesAnterior, mesmoPeriodoAnterior]),
        ]);
        const spendAtual = Number(curRow.rows[0].total);
        const spendAnterior = Number(prevRow.rows[0].total);
        const catAtual = Number(catCurRow.rows[0].total);
        const catAnterior = Number(catPrevRow.rows[0].total);
        // ── 2. Mês mais pesado ────────────────────────────────────────────────────
        if (spendAnterior > 80 && spendAtual > spendAnterior * 1.25) {
            const sentinel = `smart_mes_alto_${mes}_${ano}`;
            const texto = pick([
                "Esse mês está mais pesado que o anterior até aqui.",
                "Esse mês está mais apertado que o anterior.",
            ]);
            if (await tryInsight(sentinel, inicioMesAtual, texto))
                return true;
        }
        // ── 3. Mês mais leve ──────────────────────────────────────────────────────
        if (spendAnterior > 80 && spendAtual > 20 && spendAtual < spendAnterior * 0.75) {
            const sentinel = `smart_mes_baixo_${mes}_${ano}`;
            const texto = "Esse mês você está gastando menos que no anterior 🙂";
            if (await tryInsight(sentinel, inicioMesAtual, texto))
                return true;
        }
        // ── 4. Categoria subindo ──────────────────────────────────────────────────
        if (catAnterior > 40 && catAtual > catAnterior * 1.35) {
            const catKey = categoria.replace(/\s+/g, "_").toLowerCase().slice(0, 30);
            const sentinel = `smart_cat_alta_${catKey}_${mes}_${ano}`;
            const texto = `${categoria} está mais alto esse mês em comparação ao anterior.`;
            if (await tryInsight(sentinel, inicioMesAtual, texto))
                return true;
        }
        // ── 5. Categoria melhorando ───────────────────────────────────────────────
        if (catAnterior > 40 && catAtual > 0 && catAtual < catAnterior * 0.65) {
            const catKey = categoria.replace(/\s+/g, "_").toLowerCase().slice(0, 30);
            const sentinel = `smart_cat_baixa_${catKey}_${mes}_${ano}`;
            const texto = pick([
                `Esse mês você gastou menos com ${categoria.toLowerCase()} 🙂`,
                `${categoria} mais controlado esse mês 🙂`,
            ]);
            if (await tryInsight(sentinel, inicioMesAtual, texto))
                return true;
        }
        return false;
    }
    catch (err) {
        logger_1.log.error("falha smart insights", err, { userId });
        return false;
    }
}
// Micro insight contextual — raro, leve, observações de hoje apenas
async function sendContextualMicroInsight(userId, telefone, categoria) {
    try {
        const now = new Date();
        const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const tomorrowUTC = new Date(todayUTC.getTime() + 86400000);
        const twoMinsAgo = new Date(now.getTime() - 120000);
        const twoHoursAgo = new Date(now.getTime() - 7200000);
        // Rapid-fire: 2+ tx nos últimos 2 min → silêncio total
        const rapidRow = await client_1.default.query(`SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2`, [userId, twoMinsAgo]);
        if (Number(rapidRow.rows[0].count) > 1)
            return false;
        // Máx 1 micro insight por dia por usuário
        const alreadySent = await client_1.default.query(`SELECT COUNT(*) AS count FROM sent_insights WHERE user_id = $1 AND categoria = 'micro_dia' AND mes_referencia = $2`, [userId, todayUTC]);
        if (Number(alreadySent.rows[0].count) > 0)
            return false;
        function pick(opts) { return opts[Math.floor(Math.random() * opts.length)]; }
        let insight = null;
        // Condição 1: 3+ gastos na mesma categoria hoje
        const catRow = await client_1.default.query(`SELECT COUNT(*) AS count FROM transactions
       WHERE user_id = $1 AND LOWER(categoria) = LOWER($2) AND tipo = 'saida'
         AND criado_em >= $3 AND criado_em < $4`, [userId, categoria, todayUTC, tomorrowUTC]);
        if (Number(catRow.rows[0].count) >= 4) {
            insight = pick([
                `${categoria} apareceu bastante hoje.`,
                `Bastante ${categoria.toLowerCase()} hoje.`,
            ]);
        }
        // Condição 2: 5+ gastos nas últimas 2h (ritmo acelerado)
        if (!insight) {
            const paceRow = await client_1.default.query(`SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1 AND tipo = 'saida' AND criado_em >= $2`, [userId, twoHoursAgo]);
            if (Number(paceRow.rows[0].count) >= 5) {
                insight = pick([
                    "Bastante saída concentrada hoje 👀",
                    "Hoje teve bastante movimento.",
                ]);
            }
        }
        if (!insight)
            return false;
        // Registra dedup — só envia se foi o primeiro a inserir
        const ins = await client_1.default.query(`INSERT INTO sent_insights (user_id, categoria, marco, mes_referencia)
       VALUES ($1, 'micro_dia', 1, $2)
       ON CONFLICT (user_id, categoria, marco, mes_referencia) DO NOTHING`, [userId, todayUTC]);
        if ((ins.rowCount ?? 0) === 0)
            return false;
        await whatsapp_1.whatsapp.sendText({ to: telefone, text: insight });
        logger_1.log.whatsapp("micro insight enviado", { to: telefone, userId, insight });
        return true;
    }
    catch (err) {
        logger_1.log.error("falha micro insight", err, { userId });
        return false;
    }
}
