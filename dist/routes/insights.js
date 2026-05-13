"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = __importDefault(require("../db/client"));
const auth_1 = require("../middleware/auth");
const insightService_1 = require("../services/insightService");
const router = (0, express_1.Router)();
router.use(auth_1.authMiddleware);
// GET /insights/:userId?mes=2026-05
router.get("/:userId", async (req, res) => {
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
        const insights = await (0, insightService_1.generateInsights)(userId, inicioPeriodo, fimPeriodo, inicioAnterior, fimAnterior);
        res.json({ message: "Insights financeiros", data: insights });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao gerar insights" });
    }
});
exports.default = router;
