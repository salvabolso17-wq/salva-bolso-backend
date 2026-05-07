import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "../db/client";

const router = Router();

router.post("/register", async (req, res) => {
  try {
    const { telefone, nome, senha, renda, renda_extra } = req.body;

    if (!telefone || !senha) {
      res.status(400).json({ error: "Campos obrigatórios: telefone, senha" });
      return;
    }

    const senhaHash = await bcrypt.hash(senha, 10);

    const result = await pool.query(
      `INSERT INTO users (telefone, nome, senha, renda, renda_extra)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, telefone, nome, renda, renda_extra, criado_em`,
      [telefone, nome ?? null, senhaHash, renda ?? 0, renda_extra ?? 0]
    );

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: "7d" });

    res.status(201).json({ message: "Usuário registrado", data: { user, token } });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
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

    const result = await pool.query(
      "SELECT * FROM users WHERE telefone = $1",
      [telefone]
    );

    const user = result.rows[0];

    if (!user || !user.senha) {
      res.status(401).json({ error: "Credenciais inválidas" });
      return;
    }

    const senhaValida = await bcrypt.compare(senha, user.senha);

    if (!senhaValida) {
      res.status(401).json({ error: "Credenciais inválidas" });
      return;
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: "7d" });

    const { senha: _senha, ...userSemSenha } = user;

    res.json({ message: "Login realizado", data: { user: userSemSenha, token } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao realizar login" });
  }
});

export default router;
