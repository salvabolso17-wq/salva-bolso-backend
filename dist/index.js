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
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const node_cron_1 = __importDefault(require("node-cron"));
const client_1 = __importDefault(require("./db/client"));
const database_1 = require("./database");
const webhookSelfRegister_1 = require("./services/webhookSelfRegister");
const notificationService_1 = require("./services/notificationService");
const cronState_1 = require("./utils/cronState");
const users_1 = __importDefault(require("./routes/users"));
const transactions_1 = __importDefault(require("./routes/transactions"));
const auth_1 = __importDefault(require("./routes/auth"));
const financial_goals_1 = __importDefault(require("./routes/financial-goals"));
const reports_1 = __importDefault(require("./routes/reports"));
const webhooks_1 = __importDefault(require("./routes/webhooks"));
const insights_1 = __importDefault(require("./routes/insights"));
const healthDeep_1 = __importDefault(require("./routes/healthDeep"));
const path = __importStar(require("path"));
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: "10mb" }));
// Serve static files from the 'public' directory
app.use(express_1.default.static(path.join(__dirname, '../public')));
app.use("/auth", auth_1.default);
app.use("/users", users_1.default);
app.use("/transactions", transactions_1.default);
app.use("/financial-goals", financial_goals_1.default);
app.use("/reports", reports_1.default);
app.use("/webhooks", webhooks_1.default);
app.use("/insights", insights_1.default);
app.use("/healthz/deep", healthDeep_1.default);
// Global error handler — catches sync throws and next(err) calls
app.use((err, req, res, _next) => {
    console.error("[GLOBAL ERROR]", err);
    res.status(200).json({ received: true });
});
// Health check sem dependência de banco — para validar que o proxy alcança o container
app.get("/healthz", (_req, res) => {
    res.status(200).send("ok");
});
app.get("/", async (req, res) => {
    try {
        const result = await client_1.default.query("SELECT NOW()");
        res.json({
            message: "Salva Bolso API online 🚀",
            database: "Conectado com sucesso ✅",
            time: result.rows[0],
        });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao conectar no banco ❌" });
    }
});
const PORT = Number(process.env.PORT ?? 3000);
(async () => {
    await (0, database_1.createTables)();
    console.log(`[STARTUP] tentando ouvir em 0.0.0.0:${PORT} | build=20260509-producao-publica`);
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`[STARTUP] Servidor ouvindo em 0.0.0.0:${PORT}`);
        // Auto-registra webhook na Evolution após a rede overlay estabilizar
        setTimeout(() => (0, webhookSelfRegister_1.selfRegisterWebhook)(), 5000);
        // Expiração de assinaturas — a cada hora
        cronState_1.cronState.expiracao.registrado = true;
        node_cron_1.default.schedule("0 * * * *", async () => {
            cronState_1.cronState.expiracao.ultimaExecucao = new Date();
            cronState_1.cronState.expiracao.erroUltimo = null;
            try {
                const r = await client_1.default.query(`UPDATE users SET subscription_status = 'expired'
           WHERE subscription_status = 'active'
             AND subscription_expires_at IS NOT NULL
             AND subscription_expires_at < NOW()`);
                cronState_1.cronState.expiracao.ultimoExpiredCount = r.rowCount ?? 0;
                if ((r.rowCount ?? 0) > 0) {
                    console.log(`[CRON] ${r.rowCount} assinatura(s) expirada(s)`);
                }
            }
            catch (err) {
                cronState_1.cronState.expiracao.erroUltimo = String(err);
                console.error("[CRON] falha na expiracao de assinaturas:", err);
            }
            // Migra trial vencido para expired — mantém banco consistente
            try {
                const t = await client_1.default.query(`UPDATE users SET subscription_status = 'expired'
           WHERE subscription_status = 'trial'
             AND trial_ends_at IS NOT NULL
             AND trial_ends_at < NOW()`);
                if ((t.rowCount ?? 0) > 0) {
                    console.log(`[CRON] ${t.rowCount} trial(s) expirado(s)`);
                }
            }
            catch (err) {
                console.error("[CRON] falha na expiracao de trials:", err);
            }
        });
        // Notificações de retenção — diariamente às 9h horário de Brasília
        cronState_1.cronState.notificacoes.registrado = true;
        node_cron_1.default.schedule("0 9 * * *", () => {
            cronState_1.cronState.notificacoes.ultimaExecucao = new Date();
            (0, notificationService_1.runDailyNotifications)().catch(err => console.error("cron diario falhou:", err));
        }, { timezone: "America/Sao_Paulo" });
        // Push semanal comparativo — segunda-feira 9h Brasília
        cronState_1.cronState.relatorioSemanal.registrado = true;
        node_cron_1.default.schedule("0 9 * * 1", () => {
            cronState_1.cronState.relatorioSemanal.ultimaExecucao = new Date();
            (0, notificationService_1.runWeeklyNotifications)().catch(err => console.error("cron semanal falhou:", err));
        }, { timezone: "America/Sao_Paulo" });
    });
})();
