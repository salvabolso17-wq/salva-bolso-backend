import pool from "./db/client";

export async function createTables() {
  try {
    console.log("Tentando conectar no banco...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telefone VARCHAR(20) UNIQUE NOT NULL,
        nome VARCHAR(100),
        renda NUMERIC(10,2) DEFAULT 0,
        renda_extra NUMERIC(10,2) DEFAULT 0,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        tipo VARCHAR(20) NOT NULL,
        valor NUMERIC(10,2) NOT NULL,
        categoria VARCHAR(100),
        descricao TEXT,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS senha VARCHAR(255);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS financial_goals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        categoria VARCHAR(100) NOT NULL,
        valor_meta NUMERIC(10,2) NOT NULL,
        mes_referencia DATE NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, categoria, mes_referencia)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id  TEXT        PRIMARY KEY,
        telefone    TEXT        NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    console.log("Tabelas criadas/verificadas ✅");
  } catch (error) {
    console.error("ERRO REAL DO BANCO:");
    console.error(error);
  }
}
