"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = __importDefault(require("../db/client"));
const cronState_1 = require("../utils/cronState");
const router = (0, express_1.Router)();
const BUILD = "20260509-producao-publica";
// Verifica token via header ou query param
function isAuthorized(req) {
    const token = process.env.HEALTH_TOKEN;
    if (!token)
        return false; // sem token configurado = bloqueado por padrão
    const header = req.headers["x-health-token"];
    const query = req.query["token"];
    return header === token || query === token;
}
async function checkDatabase() {
    const start = Date.now();
    try {
        const r = await client_1.default.query(`SELECT current_database() AS db, inet_server_addr()::text AS host`);
        return {
            ok: true,
            latencyMs: Date.now() - start,
            database: r.rows[0]?.db,
            host: r.rows[0]?.host,
        };
    }
    catch (err) {
        return { ok: false, latencyMs: Date.now() - start, erro: String(err) };
    }
}
async function checkPlans() {
    try {
        const r = await client_1.default.query(`SELECT nome, duration_days, ativo FROM plans ORDER BY id`);
        return { ok: r.rows.length > 0, planos: r.rows };
    }
    catch (err) {
        return { ok: false, planos: [], erro: String(err) };
    }
}
async function checkColumns() {
    try {
        const r = await client_1.default.query(`SELECT column_name FROM information_schema.columns
       WHERE table_name = 'users'
         AND column_name IN ('subscription_expires_at', 'current_plan', 'subscription_status', 'trial_ends_at')
       ORDER BY column_name`);
        const cols = r.rows.map(row => row.column_name);
        const required = ["current_plan", "subscription_expires_at"];
        const ok = required.every(c => cols.includes(c));
        return { ok, colunas: cols };
    }
    catch (err) {
        return { ok: false, colunas: [] };
    }
}
async function checkLastAsaas() {
    try {
        const r = await client_1.default.query(`SELECT telefone, current_plan, subscription_expires_at
       FROM users
       WHERE subscription_status = 'active' AND subscription_expires_at IS NOT NULL
       ORDER BY subscription_expires_at DESC
       LIMIT 1`);
        if (r.rows.length === 0)
            return { ultimoAtivado: null, plano: null, expiraEm: null };
        const row = r.rows[0];
        // Oculta dígitos do meio do telefone
        const tel = row.telefone.replace(/(\d{2})(\d{2})\d+(\d{4})/, "$1$2****$3");
        return {
            ultimoAtivado: tel,
            plano: row.current_plan,
            expiraEm: row.subscription_expires_at?.toISOString() ?? null,
        };
    }
    catch {
        return { ultimoAtivado: null, plano: null, expiraEm: null };
    }
}
async function checkAssinaturasExpiradas() {
    try {
        const r = await client_1.default.query(`SELECT COUNT(*)::text AS total FROM users WHERE subscription_status = 'expired'`);
        return { total: parseInt(r.rows[0]?.total ?? "0", 10) };
    }
    catch {
        return { total: 0 };
    }
}
async function checkEvolution() {
    const url = process.env.WHATSAPP_EVOLUTION_URL;
    const key = process.env.WHATSAPP_EVOLUTION_KEY;
    const instance = process.env.WHATSAPP_EVOLUTION_INSTANCE;
    if (!url || !key || !instance)
        return { ok: false, erro: "env não configurada" };
    try {
        const resp = await fetch(`${url}/instance/connectionState/${instance}`, {
            headers: { apikey: key },
            signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok)
            return { ok: false, erro: `HTTP ${resp.status}` };
        const data = await resp.json();
        const estado = data.instance?.state ?? String(data.state ?? "desconhecido");
        return { ok: estado === "open", estado };
    }
    catch (err) {
        return { ok: false, erro: String(err) };
    }
}
async function checkWebhookEvolution() {
    const url = process.env.WHATSAPP_EVOLUTION_URL;
    const key = process.env.WHATSAPP_EVOLUTION_KEY;
    const instance = process.env.WHATSAPP_EVOLUTION_INSTANCE;
    if (!url || !key || !instance)
        return { ok: false, erro: "env não configurada" };
    try {
        const resp = await fetch(`${url}/webhook/find/${instance}`, {
            headers: { apikey: key },
            signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok)
            return { ok: false, erro: `HTTP ${resp.status}` };
        const data = await resp.json();
        // Evolution API v2 pode retornar {webhook:{url,enabled}} ou {url,enabled} diretamente
        const inner = data.webhook ?? data;
        const webhookUrl = inner.url;
        const enabled = inner.enabled;
        // Se a URL está registrada (qualquer valor), considerar ok — enabled pode ser null na v2
        const ok = !!webhookUrl;
        return { ok, url: webhookUrl, ...(enabled !== undefined ? {} : { nota: "enabled não retornado pela API" }) };
    }
    catch (err) {
        return { ok: false, erro: String(err) };
    }
}
router.get("/", async (req, res) => {
    if (!isAuthorized(req)) {
        res.status(401).json({ erro: "Não autorizado" });
        return;
    }
    const [db, plans, columns, lastAsaas, expiradas, evolution, webhook] = await Promise.all([
        checkDatabase(),
        checkPlans(),
        checkColumns(),
        checkLastAsaas(),
        checkAssinaturasExpiradas(),
        checkEvolution(),
        checkWebhookEvolution(),
    ]);
    const tudo_ok = db.ok && plans.ok && columns.ok && evolution.ok && webhook.ok;
    res.json({
        status: tudo_ok ? "ok" : "degradado",
        build: BUILD,
        timestamp: new Date().toISOString(),
        checks: {
            banco: { ok: db.ok, latencyMs: db.latencyMs, database: db.database, host: db.host, ...(db.erro ? { erro: db.erro } : {}) },
            plans: { ok: plans.ok, planos: plans.planos, ...(plans.erro ? { erro: plans.erro } : {}) },
            colunas_users: { ok: columns.ok, colunas: columns.colunas },
            cron_expiracao: {
                registrado: cronState_1.cronState.expiracao.registrado,
                ultimaExecucao: cronState_1.cronState.expiracao.ultimaExecucao?.toISOString() ?? null,
                ultimoExpiredCount: cronState_1.cronState.expiracao.ultimoExpiredCount,
                erroUltimo: cronState_1.cronState.expiracao.erroUltimo,
            },
            assinaturas: {
                ultimoAtivado: lastAsaas,
                totalExpiradas: expiradas.total,
            },
            evolution: { ok: evolution.ok, estado: evolution.estado, ...(evolution.erro ? { erro: evolution.erro } : {}) },
            webhook_whatsapp: { ok: webhook.ok, url: webhook.url, ...(webhook.erro ? { erro: webhook.erro } : {}) },
        },
    });
});
exports.default = router;
