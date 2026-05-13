"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTables = createTables;
const client_1 = __importDefault(require("./db/client"));
async function createTables() {
    try {
        console.log("Tentando conectar no banco...");
        await client_1.default.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telefone VARCHAR(20) UNIQUE NOT NULL,
        nome VARCHAR(100),
        renda NUMERIC(10,2) DEFAULT 0,
        renda_extra NUMERIC(10,2) DEFAULT 0,
        subscription_status VARCHAR(20) NOT NULL DEFAULT 'trial',
        trial_ends_at TIMESTAMPTZ,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
        await client_1.default.query(`
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
        await client_1.default.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS senha VARCHAR(255);
    `);
        await client_1.default.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) NOT NULL DEFAULT 'trial';
    `);
        await client_1.default.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
    `);
        // Usuários existentes antes da migração: 90 dias de graça a partir do cadastro
        await client_1.default.query(`
      UPDATE users
      SET trial_ends_at = criado_em + INTERVAL '90 days'
      WHERE trial_ends_at IS NULL;
    `);
        await client_1.default.query(`
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
        await client_1.default.query(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id  TEXT        PRIMARY KEY,
        telefone    TEXT        NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
        await client_1.default.query(`
      CREATE TABLE IF NOT EXISTS sent_insights (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        categoria     VARCHAR(100) NOT NULL,
        marco         INTEGER NOT NULL,
        mes_referencia DATE NOT NULL,
        criado_em     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, categoria, marco, mes_referencia)
      );
    `);
        await client_1.default.query(`
      CREATE TABLE IF NOT EXISTS user_goals (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
        nome         VARCHAR(100) NOT NULL,
        valor_meta   NUMERIC(10,2) NOT NULL,
        valor_atual  NUMERIC(10,2) NOT NULL DEFAULT 0,
        criado_em    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, nome)
      );
    `);
        await client_1.default.query(`
      CREATE TABLE IF NOT EXISTS category_limits (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
        categoria    VARCHAR(100) NOT NULL,
        valor_limite NUMERIC(10,2) NOT NULL,
        criado_em    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, categoria)
      );
    `);
        await client_1.default.query(`
      CREATE TABLE IF NOT EXISTS recurring_expenses (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
        nome        VARCHAR(100) NOT NULL,
        valor       NUMERIC(10,2) NOT NULL,
        frequencia  VARCHAR(20) NOT NULL DEFAULT 'mensal',
        ativo       BOOLEAN NOT NULL DEFAULT TRUE,
        criado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, nome)
      );
    `);
        await client_1.default.query(`
      CREATE TABLE IF NOT EXISTS pending_actions (
        user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        action         VARCHAR(30)  NOT NULL,
        step           VARCHAR(30)  NOT NULL,
        tx_ids         JSONB        NOT NULL DEFAULT '[]',
        selected_tx_id INTEGER,
        expires_at     TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
      );
    `);
        await client_1.default.query(`
      CREATE TABLE IF NOT EXISTS installments (
        id             SERIAL PRIMARY KEY,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        nome           TEXT NOT NULL,
        valor_total    NUMERIC(10,2) NOT NULL DEFAULT 0,
        valor_parcela  NUMERIC(10,2) NOT NULL,
        total_parcelas INTEGER NOT NULL,
        parcelas_pagas INTEGER NOT NULL DEFAULT 0,
        categoria      TEXT NOT NULL DEFAULT 'Outros',
        criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ativo          BOOLEAN NOT NULL DEFAULT TRUE
      );
    `);
        await client_1.default.query(`
      CREATE INDEX IF NOT EXISTS installments_user_id_idx ON installments(user_id);
    `);
        await client_1.default.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id           SERIAL PRIMARY KEY,
        nome         VARCHAR(50) UNIQUE NOT NULL,
        duration_days INTEGER NOT NULL,
        ativo        BOOLEAN NOT NULL DEFAULT TRUE
      );
    `);
        await client_1.default.query(`
      INSERT INTO plans (nome, duration_days) VALUES
        ('mensal', 30),
        ('anual', 365)
      ON CONFLICT (nome) DO NOTHING;
    `);
        await client_1.default.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;
    `);
        await client_1.default.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS current_plan VARCHAR(50);
    `);
        console.log("Tabelas criadas/verificadas ✅");
    }
    catch (error) {
        console.error("ERRO REAL DO BANCO:");
        console.error(error);
    }
}
