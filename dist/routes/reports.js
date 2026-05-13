"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = __importDefault(require("../db/client"));
const auth_1 = require("../middleware/auth");
const reportService_1 = require("../services/reportService");
const router = (0, express_1.Router)();
router.use(auth_1.authMiddleware);
// GET /reports/:userId/monthly?mes=2026-05
router.get("/:userId/monthly", async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const mesParam = req.query.mes ?? new Date().toISOString().slice(0, 7);
        const match = mesParam.match(/^(\d{4})-(\d{2})$/);
        if (!match) {
            res.status(400).json({ error: "Parâmetro mes deve estar no formato YYYY-MM" });
            return;
        }
        const userResult = await client_1.default.query("SELECT id FROM users WHERE id = $1", [userId]);
        if (userResult.rows.length === 0) {
            res.status(404).json({ error: "Usuário não encontrado" });
            return;
        }
        const ano = parseInt(match[1]);
        const mes = parseInt(match[2]);
        const inicioPeriodo = new Date(Date.UTC(ano, mes - 1, 1));
        const fimPeriodo = new Date(Date.UTC(ano, mes, 1));
        const inicioAnterior = new Date(Date.UTC(ano, mes - 2, 1));
        const fimAnterior = new Date(Date.UTC(ano, mes - 1, 1));
        const report = await (0, reportService_1.buildReport)(userId, inicioPeriodo, fimPeriodo, inicioAnterior, fimAnterior, "mensal");
        res.json({ message: "Relatório mensal", data: report });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao gerar relatório mensal" });
    }
});
// GET /reports/:userId/weekly?inicio=2026-04-28
router.get("/:userId/weekly", async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        let inicioPeriodo;
        if (req.query.inicio) {
            const parsed = new Date(`${req.query.inicio}T00:00:00Z`);
            if (isNaN(parsed.getTime())) {
                res.status(400).json({ error: "Parâmetro inicio deve estar no formato YYYY-MM-DD" });
                return;
            }
            inicioPeriodo = parsed;
        }
        else {
            const hoje = new Date();
            // Recua até a segunda-feira da semana atual (ISO: semana começa na segunda)
            const diaSemana = hoje.getUTCDay();
            const diasAteSegunda = diaSemana === 0 ? 6 : diaSemana - 1;
            inicioPeriodo = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - diasAteSegunda));
        }
        const fimPeriodo = new Date(inicioPeriodo);
        fimPeriodo.setUTCDate(inicioPeriodo.getUTCDate() + 7);
        const inicioAnterior = new Date(inicioPeriodo);
        inicioAnterior.setUTCDate(inicioPeriodo.getUTCDate() - 7);
        const fimAnterior = new Date(inicioPeriodo);
        const userResult = await client_1.default.query("SELECT id FROM users WHERE id = $1", [userId]);
        if (userResult.rows.length === 0) {
            res.status(404).json({ error: "Usuário não encontrado" });
            return;
        }
        const report = await (0, reportService_1.buildReport)(userId, inicioPeriodo, fimPeriodo, inicioAnterior, fimAnterior, "semanal");
        res.json({ message: "Relatório semanal", data: report });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao gerar relatório semanal" });
    }
});
exports.default = router;
