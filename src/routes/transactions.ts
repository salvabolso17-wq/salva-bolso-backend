import { Router } from "express";
import pool from "../db/client";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const { user_id, tipo, valor, categoria, descricao } = req.body;

    if (!user_id || !tipo || !valor) {
      res.status(400).json({ error: "Campos obrigatórios: user_id, tipo, valor" });
      return;
    }

    if (tipo !== "entrada" && tipo !== "saida") {
      res.status(400).json({ error: "tipo deve ser 'entrada' ou 'saida'" });
      return;
    }

    const result = await pool.query(
      `INSERT INTO transactions (user_id, tipo, valor, categoria, descricao)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [user_id, tipo, valor, categoria ?? null, descricao ?? null]
    );

    res.status(201).json({ message: "Transação criada", data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao criar transação" });
  }
});

router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id = $1
       ORDER BY criado_em DESC`,
      [userId]
    );

    res.json({ message: "Transações encontradas", data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao buscar transações" });
  }
});

router.get("/:userId/resumo", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN valor ELSE 0 END), 0) AS total_entradas,
         COALESCE(SUM(CASE WHEN tipo = 'saida'   THEN valor ELSE 0 END), 0) AS total_saidas
       FROM transactions
       WHERE user_id = $1`,
      [userId]
    );

    const { total_entradas, total_saidas } = result.rows[0];
    const saldo = Number(total_entradas) - Number(total_saidas);

    res.json({
      message: "Resumo financeiro",
      data: {
        total_entradas: Number(total_entradas),
        total_saidas: Number(total_saidas),
        saldo,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao calcular resumo" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "DELETE FROM transactions WHERE id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Transação não encontrada" });
      return;
    }

    res.json({ message: "Transação removida", data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao remover transação" });
  }
});

export default router;
