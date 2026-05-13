"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const client_1 = __importDefault(require("../db/client"));
const router = (0, express_1.Router)();
router.post("/register", async (req, res) => {
    try {
        const { telefone, nome, senha, renda, renda_extra } = req.body;
        if (!telefone || !senha) {
            res.status(400).json({ error: "Campos obrigatórios: telefone, senha" });
            return;
        }
        const senhaHash = await bcryptjs_1.default.hash(senha, 10);
        const result = await client_1.default.query(`INSERT INTO users (telefone, nome, senha, renda, renda_extra)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, telefone, nome, renda, renda_extra, criado_em`, [telefone, nome ?? null, senhaHash, renda ?? 0, renda_extra ?? 0]);
        const user = result.rows[0];
        const token = jsonwebtoken_1.default.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
        res.status(201).json({ message: "Usuário registrado", data: { user, token } });
    }
    catch (error) {
        if (error.code === "23505") {
            res.status(400).json({ error: "Telefone já cadastrado" });
            return;
        }
        console.error(error);
        res.status(500).json({ error: "Erro ao registrar usuário" });
    }
});
router.post("/login", async (req, res) => {
    try {
        const { telefone, senha } = req.body;
        if (!telefone || !senha) {
            res.status(400).json({ error: "Campos obrigatórios: telefone, senha" });
            return;
        }
        const result = await client_1.default.query("SELECT * FROM users WHERE telefone = $1", [telefone]);
        const user = result.rows[0];
        if (!user || !user.senha) {
            res.status(401).json({ error: "Credenciais inválidas" });
            return;
        }
        const senhaValida = await bcryptjs_1.default.compare(senha, user.senha);
        if (!senhaValida) {
            res.status(401).json({ error: "Credenciais inválidas" });
            return;
        }
        const token = jsonwebtoken_1.default.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
        const { senha: _senha, ...userSemSenha } = user;
        res.json({ message: "Login realizado", data: { user: userSemSenha, token } });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao realizar login" });
    }
});
exports.default = router;
