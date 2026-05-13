"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = __importDefault(require("../db/client"));
const router = (0, express_1.Router)();
router.post("/", async (req, res) => {
    try {
        const { telefone, nome, renda } = req.body;
        const result = await client_1.default.query(`
      INSERT INTO users (telefone, nome, renda)
      VALUES ($1, $2, $3)
      RETURNING *
      `, [telefone, nome, renda]);
        res.status(201).json({
            message: "Usuário criado com sucesso ✅",
            user: result.rows[0],
        });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Erro ao criar usuário ❌",
        });
    }
});
router.get("/", async (req, res) => {
    try {
        const result = await client_1.default.query(`
      SELECT * FROM users
      ORDER BY id DESC
    `);
        res.json({
            users: result.rows,
        });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Erro ao buscar usuários ❌",
        });
    }
});
router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await client_1.default.query("SELECT * FROM users WHERE id = $1", [id]);
        if (result.rows.length === 0) {
            res.status(404).json({ error: "Usuário não encontrado" });
            return;
        }
        res.json({ message: "Usuário encontrado", data: result.rows[0] });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao buscar usuário" });
    }
});
router.put("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, renda, renda_extra } = req.body;
        if (nome === undefined && renda === undefined && renda_extra === undefined) {
            res.status(400).json({ error: "Informe ao menos um campo para atualizar" });
            return;
        }
        const result = await client_1.default.query(`UPDATE users
       SET
         nome       = COALESCE($1, nome),
         renda      = COALESCE($2, renda),
         renda_extra = COALESCE($3, renda_extra)
       WHERE id = $4
       RETURNING *`, [nome ?? null, renda ?? null, renda_extra ?? null, id]);
        if (result.rows.length === 0) {
            res.status(404).json({ error: "Usuário não encontrado" });
            return;
        }
        res.json({ message: "Usuário atualizado", data: result.rows[0] });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao atualizar usuário" });
    }
});
exports.default = router;
