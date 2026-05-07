# Evolution API — Guia de Instalação e Integração

## O que é a Evolution API

Evolution API é uma solução **self-hosted** que conecta o WhatsApp via protocolo WhatsApp Web (Baileys),
expondo uma API REST para envio e recebimento de mensagens.
Não exige conta WhatsApp Business API — funciona com qualquer número de WhatsApp.

> Repositório oficial: https://github.com/EvolutionAPI/evolution-api
> Docs oficiais: https://doc.evolution-api.com

---

## Arquitetura no Projeto Salva Bolso

```
┌─────────────────────────────────────────────────────┐
│                    EasyPanel                         │
│                                                      │
│  ┌──────────────────┐    webhook     ┌────────────┐  │
│  │  Evolution API   │ ─────────────► │  Backend   │  │
│  │  :8080           │                │  :80       │  │
│  └──────────────────┘                └────────────┘  │
│           ▲                                ▲         │
│           │ QR Code / WhatsApp Web         │ JWT API │
│           │                                │         │
│  ┌────────┴───┐                   ┌────────┴──────┐  │
│  │  WhatsApp  │                   │  App Mobile   │  │
│  │  (celular) │                   │  (futuro)     │  │
│  └────────────┘                   └───────────────┘  │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  PostgreSQL (compartilhado)                  │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**Fluxo de mensagem:**
1. Usuário envia mensagem no WhatsApp
2. Evolution API recebe e dispara webhook para o backend
3. Backend identifica o usuário pelo telefone
4. `parseTransaction()` interpreta o texto
5. Transação é salva no PostgreSQL
6. Backend chama `whatsapp.sendText()` → Evolution API envia confirmação ao usuário

---

## Pré-requisitos

- EasyPanel com o projeto Salva Bolso em execução
- Acesso ao painel do EasyPanel para criar novo serviço
- Número de WhatsApp disponível para conectar (pode ser pessoal)
- PostgreSQL já provisionado (o mesmo do projeto)

---

## Instalação no EasyPanel

### 1. Criar novo serviço

No EasyPanel, dentro do projeto `salva-bolso`:

1. Clique em **+ Create Service**
2. Selecione **Docker Image**
3. Nome do serviço: `evolution-api`
4. Imagem: `atendai/evolution-api:latest`
5. Porta: `8080`

### 2. Configurar variáveis de ambiente do serviço Evolution API

No painel de variáveis do serviço `evolution-api`, adicione:

```env
# Servidor
SERVER_PORT=8080
SERVER_URL=https://evolution.seu-dominio.com

# Autenticação global
AUTHENTICATION_TYPE=apikey
AUTHENTICATION_API_KEY=SUA_CHAVE_SECRETA_AQUI
AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true

# Banco de dados (usa o PostgreSQL existente)
DATABASE_ENABLED=true
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=postgresql://usuario:senha@salva-bolso_postgres-salvabolso:5432/evolution
DATABASE_CONNECTION_CLIENT_NAME=evolution_api
DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_MESSAGE_UPDATE=true
DATABASE_SAVE_DATA_CONTACTS=true
DATABASE_SAVE_DATA_CHATS=true

# Webhook global — aponta para o backend Salva Bolso
WEBHOOK_GLOBAL_URL=https://api.seu-dominio.com/webhooks/whatsapp?provider=evolution
WEBHOOK_GLOBAL_ENABLED=true
WEBHOOK_GLOBAL_WEBHOOK_BY_EVENTS=false
WEBHOOK_EVENTS_MESSAGES_UPSERT=true
WEBHOOK_EVENTS_CONNECTION_UPDATE=false
WEBHOOK_EVENTS_QRCODE_UPDATED=false

# Redis (opcional — melhora performance)
# REDIS_ENABLED=true
# REDIS_URI=redis://redis:6379

# Logs
LOG_LEVEL=ERROR
LOG_COLOR=true
```

> **Atenção:** Use uma chave forte em `AUTHENTICATION_API_KEY`.
> Nunca versione esse valor no repositório.

### 3. Configurar domínio

No EasyPanel, em **Domains** do serviço `evolution-api`:
- Adicione o domínio: `evolution.seu-dominio.com`
- Ative HTTPS (Let's Encrypt automático)

### 4. Configurar variáveis no serviço Backend

Adicione as variáveis abaixo ao serviço `salva-bolso-backend` no EasyPanel:

```env
WHATSAPP_PROVIDER=evolution
WHATSAPP_EVOLUTION_URL=https://evolution.seu-dominio.com
WHATSAPP_EVOLUTION_KEY=SUA_CHAVE_SECRETA_AQUI
WHATSAPP_EVOLUTION_INSTANCE=salva-bolso
```

> `WHATSAPP_EVOLUTION_INSTANCE` é o nome da instância que você vai criar no próximo passo.

---

## Criando e Conectando uma Instância

Após o serviço Evolution API estar em execução, siga os passos abaixo usando a API REST:

### 1. Criar instância

```http
POST https://evolution.seu-dominio.com/instance/create
Content-Type: application/json
apikey: SUA_CHAVE_SECRETA_AQUI

{
  "instanceName": "salva-bolso",
  "token": "token-opcional",
  "qrcode": true,
  "integration": "WHATSAPP-BAILEYS"
}
```

### 2. Obter QR Code

```http
GET https://evolution.seu-dominio.com/instance/connect/salva-bolso
apikey: SUA_CHAVE_SECRETA_AQUI
```

Retorna um QR Code em base64. Escaneie com o WhatsApp no celular:
- WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho

### 3. Verificar status da conexão

```http
GET https://evolution.seu-dominio.com/instance/connectionState/salva-bolso
apikey: SUA_CHAVE_SECRETA_AQUI
```

Resposta esperada: `"state": "open"` indica conectado com sucesso.

### 4. Configurar webhook na instância

```http
POST https://evolution.seu-dominio.com/webhook/set/salva-bolso
Content-Type: application/json
apikey: SUA_CHAVE_SECRETA_AQUI

{
  "url": "https://api.seu-dominio.com/webhooks/whatsapp?provider=evolution",
  "webhook_by_events": false,
  "webhook_base64": false,
  "events": ["MESSAGES_UPSERT"]
}
```

---

## Estrutura do Payload Recebido

O backend já possui o adapter `EvolutionProvider` que normaliza este payload:

```json
{
  "event": "messages.upsert",
  "instance": "salva-bolso",
  "data": {
    "key": {
      "remoteJid": "5511999999999@s.whatsapp.net",
      "fromMe": false,
      "id": "MESSAGE_ID"
    },
    "pushName": "Nome do Usuário",
    "message": {
      "conversation": "120 mercado"
    },
    "messageType": "conversation",
    "messageTimestamp": 1234567890
  }
}
```

O campo `data.key.remoteJid` é normalizado para extrair o telefone (remove `@s.whatsapp.net`).

---

## Ativando o Provider no Backend

O `EvolutionProvider` já está implementado em `src/services/whatsapp/providers/EvolutionProvider.ts`.

Para ativá-lo:

1. Configure as variáveis de ambiente no EasyPanel (seção acima)
2. Abra `src/services/whatsapp/providers/EvolutionProvider.ts`
3. Descomente o bloco `// Implementação real` em `sendText()`
4. Faça commit e redeploy

---

## Checklist de Ativação

- [ ] Serviço `evolution-api` criado no EasyPanel
- [ ] Variáveis de ambiente configuradas em `evolution-api`
- [ ] Domínio `evolution.seu-dominio.com` configurado com HTTPS
- [ ] Variáveis `WHATSAPP_PROVIDER`, `WHATSAPP_EVOLUTION_URL`, `WHATSAPP_EVOLUTION_KEY`, `WHATSAPP_EVOLUTION_INSTANCE` adicionadas ao backend
- [ ] Instância `salva-bolso` criada via API
- [ ] QR Code escaneado e conexão estabelecida (`state: open`)
- [ ] Webhook configurado na instância
- [ ] `EvolutionProvider.ts` descomentado e redeploy realizado
- [ ] Teste: enviar `"120 mercado"` pelo WhatsApp e verificar transação criada

---

## Testando a Integração

### Teste manual do webhook

```http
POST https://api.seu-dominio.com/webhooks/whatsapp?provider=evolution
Content-Type: application/json

{
  "event": "messages.upsert",
  "instance": "salva-bolso",
  "data": {
    "key": {
      "remoteJid": "5511999999999@s.whatsapp.net",
      "fromMe": false,
      "id": "TEST_001"
    },
    "message": { "conversation": "150 uber" }
  }
}
```

Resposta esperada:
```json
{
  "received": true,
  "processed": true,
  "provider": "evolution",
  "data": {
    "usuario_id": 1,
    "interpretado": {
      "valor": 150,
      "categoria": "Transporte",
      "tipo": "saida"
    }
  }
}
```

---

## Segurança

- Nunca exponha `AUTHENTICATION_API_KEY` no código ou logs
- Configure firewall para aceitar webhooks apenas do IP do Evolution API
- Use HTTPS em todos os endpoints
- Considere adicionar verificação de IP de origem no middleware do webhook futuramente
- A instância conecta via WhatsApp Web — se o celular ficar offline por muito tempo, pode desconectar; monitore `connectionState`

---

## Troubleshooting

| Problema | Causa provável | Solução |
|----------|---------------|---------|
| QR Code expirou | Timeout de 60s | Gerar novo QR via `GET /instance/connect/salva-bolso` |
| `state: close` | Celular desconectado | Reconectar via QR Code |
| Webhook não chega | URL errada ou HTTPS inválido | Verificar URL e certificado |
| `processed: false` — usuário não encontrado | Telefone não cadastrado no banco | Cadastrar usuário com o telefone correto |
| Mensagem não interpretada | Texto fora do padrão | Testar com `parseTransaction()` direto |
