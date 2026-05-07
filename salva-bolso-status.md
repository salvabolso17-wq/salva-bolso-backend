# Salva Bolso — Status da Infraestrutura
**Última atualização:** 2026-05-07

---

## Diagnóstico Confirmado

| Componente | Status | Observação |
|---|---|---|
| Backend (Node.js/Express) | ✅ OK | Porta 80, IP direto funciona |
| Evolution API | ✅ OK | v2.3.7, instância conectada via QR |
| PostgreSQL | ✅ OK | DB `evolution`, usuário id=3 cadastrado |
| Webhook route `/webhooks/whatsapp` | ✅ OK | Processa e salva transações |
| Processamento de mensagens | ✅ OK | Teste manual POST → received=true, processed=true |
| Docker Swarm VIP/IPVS | ❌ QUEBRADO | `ipvsadm -Ln` vazio, VIP `10.11.0.88` unreachable |
| DNS interno (service name) | ⚠️ DEPENDE | Funciona se endpoint_mode=dnsrr |
| IP direto do backend | ✅ FUNCIONA | `http://10.0.1.253/webhooks/whatsapp?provider=evolution` |

---

## Usuário de Teste

- **ID:** 3
- **Telefone (DB):** `5568992383325`
- **Telefone (Evolution LID):** `556892383325` (sem o 9 — normalizado via RIGHT(8))
- **Database:** `evolution`

---

## Problema Raiz: Docker Swarm IPVS Vazio

O Docker Swarm cria um VIP (Virtual IP) para cada serviço e roteia via IPVS (kernel). No servidor, o IPVS está completamente vazio (`ipvsadm -Ln` não lista nenhuma entrada), o que faz o VIP ser unreachable. O bypass é usar o IP direto do container ou mudar o endpoint_mode para `dnsrr`.

---

## Fix Temporário Aplicado

Webhook da Evolution atualizado para usar IP direto:
```
http://10.0.1.253/webhooks/whatsapp?provider=evolution
```

**Problema:** O IP `10.0.1.253` é do container e pode mudar se o serviço for recriado/atualizado.

---

## Correções de Código Aplicadas (commit a1656a3)

### 1. LID Addressing Mode (Evolution API v2.3.7)
Com contas WhatsApp novas, a Evolution API usa LID (Linked Device ID) em vez de número de telefone no `remoteJid`. O número real fica em `remoteJidAlt`.

**Arquivo:** `src/adapters/whatsappAdapters.ts`
- Detecta `remoteJid` terminando em `@lid`
- Extrai telefone de `key.remoteJidAlt` nesses casos
- Filtra mensagens de grupos (`@g.us`) e mensagens próprias (`fromMe`)

### 2. Dígito 9 Brasileiro (12 vs 13 dígitos)
Evolution API retorna `556892383325` (12 dígitos) mas o DB tem `5568992383325` (13 dígitos com o 9 extra do padrão novo). O `RIGHT(11)` não resolve — adicionado `RIGHT(8)` como fallback.

**Arquivo:** `src/services/whatsappService.ts`

### 3. Logging de Webhook
**Arquivo:** `src/routes/webhooks.ts`  
Log de `event`, `remoteJid`, `remoteJidAlt`, `fromMe`, `text` para cada requisição recebida.

---

## Solução Definitiva — Opções

### Opção A: endpoint_mode dnsrr (RECOMENDADO)

Muda o modo de roteamento do serviço de VIP (quebrado) para DNS round-robin (funciona).
O nome `salva-bolso_backend-salvabolso` passa a resolver diretamente para o IP do container.

```bash
# Aplicar na VPS
docker service update --endpoint-mode dnsrr salva-bolso_backend-salvabolso

# Verificar se resolveu
docker exec $(docker ps -q -f name=evolution) \
  nslookup salva-bolso_backend-salvabolso

# Atualizar webhook para usar service name (não mais IP fixo)
docker exec $(docker ps -q -f name=evolution) \
  wget -qO- --post-data='{"url":"http://salva-bolso_backend-salvabolso/webhooks/whatsapp?provider=evolution","enabled":true,"events":["MESSAGES_UPSERT"]}' \
  --header='Content-Type: application/json' \
  --header='apikey: TROQUE_PELA_SUA_CHAVE' \
  http://localhost:8080/webhook/set/NOME_DA_INSTANCIA
```

**Vantagem:** Permanente, sem IP fixo, sem alterar infraestrutura.  
**Risco:** Baixo — dnsrr é suportado nativamente pelo Docker Swarm.

---

### Opção B: Rede Attachable

Cria uma overlay network em modo `attachable` que containers standalone (como Evolution API) podem usar para se comunicar com serviços Swarm.

```bash
# Criar rede attachable
docker network create --driver overlay --attachable salva-bolso-shared

# Conectar o container da Evolution API à rede
docker network connect salva-bolso-shared $(docker ps -q -f name=evolution)

# Adicionar a rede ao serviço backend no Swarm
docker service update \
  --network-add salva-bolso-shared \
  salva-bolso_backend-salvabolso

# Agora usar o service name normalmente no webhook
```

**Vantagem:** Funciona mesmo se o VIP estiver quebrado, pois a comunicação não passa pelo IPVS.  
**Risco:** Médio — requer reconectar containers e pode afetar outras integrações do EasyPanel.

---

### Opção C: Corrigir o VIP/IPVS do Swarm

O IPVS fica vazio provavelmente por problema no `docker-proxy` ou no módulo `ip_vs` do kernel.

```bash
# Verificar módulos do kernel
lsmod | grep ip_vs

# Recarregar módulos se necessário
modprobe ip_vs
modprobe ip_vs_rr
modprobe ip_vs_wrr

# Forçar o Swarm a recriar as entradas IPVS
docker service update --force salva-bolso_backend-salvabolso

# Verificar se IPVS foi populado
ipvsadm -Ln
```

**Vantagem:** Corrige o problema na raiz sem mudar arquitetura.  
**Risco:** Alto — pode exigir restart do Docker daemon ou do nó Swarm, derrubando todos os serviços temporariamente.

---

## Configuração Atual do Webhook (Evolution)

```json
{
  "url": "http://10.0.1.253/webhooks/whatsapp?provider=evolution",
  "enabled": true,
  "events": ["MESSAGES_UPSERT"]
}
```

Para atualizar via API da Evolution:
```bash
curl -X PUT http://localhost:8080/webhook/set/<INSTANCIA> \
  -H "apikey: <SUA_CHAVE>" \
  -H "Content-Type: application/json" \
  -d '{"url":"http://URL_AQUI/webhooks/whatsapp?provider=evolution","enabled":true,"events":["MESSAGES_UPSERT"]}'
```

---

## Próximos Passos

1. [ ] Aplicar Opção A (dnsrr) na VPS
2. [ ] Atualizar webhook para usar service name novamente
3. [ ] Fazer `git pull` na VPS + restart do backend
4. [ ] Enviar mensagem real pelo WhatsApp e confirmar resposta < 3s
5. [ ] Remover log de debug do webhook após confirmação
