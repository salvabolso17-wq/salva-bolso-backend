import { Router } from "express";
import pool from "../db/client";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const { telefone, nome, renda } = req.body;

    const result = await pool.query(
      `
      INSERT INTO users (telefone, nome, renda)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [telefone, nome, renda]
    );

    res.status(201).json({
      message: "Usuário criado com sucesso ✅",
      user: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro ao criar usuário ❌",
    });
  }
});

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM users
      ORDER BY id DESC
    `);

    res.json({
      users: result.rows,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro ao buscar usuários ❌",
    });
  }
});

export default router;
