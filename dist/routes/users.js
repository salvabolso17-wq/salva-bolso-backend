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
exports.default = router;
