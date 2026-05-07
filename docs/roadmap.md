# Roadmap do Salva Bolso

## Legenda

- [x] Concluído
- [ ] Pendente

---

## Fase 1 — Fundação (Backend)

- [x] Configuração do projeto Node.js + TypeScript
- [x] Configuração do Express
- [x] Conexão com PostgreSQL via pool
- [x] Criação automática das tabelas (`users` e `transactions`)
- [x] Rota `POST /users` — criar usuário
- [x] Rota `GET /users` — listar usuários
- [x] Deploy via Docker no EasyPanel
- [x] Conexão da VPS ao GitHub via SSH

---

## Fase 2 — CRUD Completo

- [ ] `GET /users/:id` — buscar usuário por ID
- [ ] `PUT /users/:id` — atualizar dados do usuário (nome, renda, renda_extra)
- [ ] `POST /transactions` — registrar nova transação (entrada ou saída)
- [ ] `GET /transactions/:userId` — listar transações do usuário
- [ ] `DELETE /transactions/:id` — remover transação
- [ ] Validação dos campos obrigatórios nas rotas

---

## Fase 3 — Lógica Financeira

- [x] `GET /transactions/:userId/resumo` — total_entradas, total_saidas, saldo, quantidade_transacoes, ultimas_transacoes
- [ ] Filtro de transações por período (mês/ano)
- [ ] Filtro de transações por categoria
- [ ] Cálculo de saldo disponível (renda + renda_extra - saídas do mês)

---

## Fase 4 — Autenticação

- [x] `POST /auth/register` — cadastro com senha (bcrypt)
- [x] `POST /auth/login` — login retorna JWT (7 dias)
- [x] Middleware JWT nas rotas de transactions
- [ ] Autenticação via telefone (OTP por SMS)

---

## Fase 5 — Relatórios e Melhorias

- [x] `POST /transactions/quick-add` — registro por texto simples com categorização automática
- [x] CRUD `/financial-goals` — metas mensais por categoria com progresso e alertas
- [x] `GET /financial-goals/:userId/resumo` — percentual utilizado, status e alertas
- [x] `GET /reports/:userId/monthly` — relatório mensal com comparativo, categoria top e graph_data
- [x] `GET /reports/:userId/weekly` — relatório semanal com mesma estrutura
- [ ] Resumo mensal agrupado por categoria
- [ ] Endpoint de exportação de dados (CSV ou JSON)
- [ ] Paginação nas listagens
- [ ] Logs estruturados de erros

---

## Fase 5.5 — Integração WhatsApp

- [x] `POST /webhooks/whatsapp` — recebe mensagens e salva transações automaticamente
- [x] `GET /webhooks/whatsapp` — verificação de webhook (Meta Cloud API)
- [x] Adapter Meta WhatsApp Cloud API
- [x] Adapter Evolution API
- [x] Adapter 360dialog
- [x] Busca de usuário por telefone (normalização de número)
- [x] Abstração `IWhatsAppProvider` com MockProvider, MetaProvider, EvolutionProvider, Dialog360Provider
- [x] Envio de confirmação automático após salvar transação via webhook
- [ ] Onboarding via WhatsApp (cadastro pelo chat)

---

## Fase 6 — Frontend / Mobile

- [ ] Definir tecnologia do frontend (React Native / Flutter / etc.)
- [ ] Tela de cadastro/login
- [ ] Tela de dashboard (saldo + últimas transações)
- [ ] Tela de nova transação
- [ ] Tela de histórico com filtros
