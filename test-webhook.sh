#!/bin/bash
# test-webhook.sh — Testa e valida o fluxo completo Evolution → backend

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[1;34m'; N='\033[0m'
ok()   { echo -e "${G}[OK]${N} $1"; }
info() { echo -e "${B}[>>]${N} $1"; }
warn() { echo -e "${Y}[!!]${N} $1"; }
fail() { echo -e "${R}[XX]${N} $1"; }

CID=$(docker ps -q --filter "name=evolution" | head -1)
[ -z "$CID" ] && fail "Container Evolution nao encontrado" && exit 1
info "Container Evolution: $CID"

echo ""
info "=== 1. Status do backend ==="
BACKEND_CID=$(docker ps -q --filter "name=backend-salvabolso" | head -1)
if [ -z "$BACKEND_CID" ]; then
  fail "Container backend NAO esta rodando!"
  docker service ps salva-bolso_backend-salvabolso --no-trunc | head -5
  exit 1
fi
ok "Backend container: $BACKEND_CID"

echo ""
info "=== 2. IPs reais do backend ==="
docker inspect "$BACKEND_CID" \
  --format '{{range $net, $cfg := .NetworkSettings.Networks}}  {{$net}}: {{$cfg.IPAddress}}{{"\n"}}{{end}}'

BACKEND_IP=$(docker inspect "$BACKEND_CID" \
  --format '{{range $net, $cfg := .NetworkSettings.Networks}}{{if eq $net "easypanel-salva-bolso"}}{{$cfg.IPAddress}}{{end}}{{end}}')
[ -z "$BACKEND_IP" ] && BACKEND_IP=$(docker inspect "$BACKEND_CID" \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' | awk '{print $1}')
info "Usando IP: $BACKEND_IP"

echo ""
info "=== 3. DNS do backend (do container Evolution) ==="
docker exec "$CID" nslookup salva-bolso_backend-salvabolso 2>&1 | grep -E "Address|Name"

echo ""
info "=== 4. Conectividade via IP direto ==="
HTTP=$(docker exec "$CID" wget -SO- -T5 \
  "http://$BACKEND_IP/webhooks/whatsapp?provider=evolution" 2>&1 | grep "HTTP/" | head -1)
if echo "$HTTP" | grep -qE "403|200|400|422"; then
  ok "Backend alcancavel via IP direto: $HTTP"
  WEBHOOK_TARGET="http://$BACKEND_IP/webhooks/whatsapp?provider=evolution"
else
  warn "IP direto falhou ($HTTP), tentando via service name..."
  HTTP2=$(docker exec "$CID" wget -SO- -T5 \
    "http://salva-bolso_backend-salvabolso/webhooks/whatsapp?provider=evolution" 2>&1 | grep "HTTP/" | head -1)
  if echo "$HTTP2" | grep -qE "403|200|400|422"; then
    ok "Backend alcancavel via service name: $HTTP2"
    WEBHOOK_TARGET="http://salva-bolso_backend-salvabolso/webhooks/whatsapp?provider=evolution"
  else
    fail "Backend inacessivel por IP e por service name"
    fail "IP direto: $HTTP | Service name: $HTTP2"
    exit 1
  fi
fi

echo ""
info "=== 5. Enviando webhook de teste para: $WEBHOOK_TARGET ==="
RESP=$(docker exec "$CID" wget -qO- -T10 \
  --post-data='{"event":"MESSAGES_UPSERT","instance":"salva-bolso","data":{"key":{"remoteJid":"5568992383325@s.whatsapp.net","fromMe":false,"id":"TESTE_'$(date +%s)'"},"message":{"conversation":"50 uber"},"messageTimestamp":'$(date +%s)'}}' \
  --header="Content-Type: application/json" \
  "$WEBHOOK_TARGET" 2>&1)
echo "Resposta: $RESP"

echo ""
info "=== 6. Logs backend ==="
sleep 2
LOGS=$(docker service logs --since 20s salva-bolso_backend-salvabolso 2>&1 | grep -v "^$")
echo "$LOGS"

echo ""
if echo "$LOGS" | grep -q "\[WEBHOOK"; then
  ok "WEBHOOK PROCESSADO COM SUCESSO"
  echo "$LOGS" | grep -E "WEBHOOK|USER|PARSER|DB |WHATSAPP|ERROR"
  echo ""
  # Atualizar webhook da Evolution para usar IP direto (fix ghost DNS)
  CURRENT_WEBHOOK=$(docker exec "$CID" wget -qO- -T5 \
    --header="apikey: salvabolsoevolution123456" \
    http://localhost:8080/webhook/find/salva-bolso 2>/dev/null | grep -o '"url":"[^"]*"' | head -1)
  if echo "$CURRENT_WEBHOOK" | grep -q "$BACKEND_IP"; then
    ok "Webhook ja aponta para IP correto: $BACKEND_IP"
  else
    warn "Atualizando webhook da Evolution: service name → IP direto $BACKEND_IP"
    UPDATE=$(docker exec "$CID" wget -qO- -T10 \
      --post-data="{\"url\":\"http://$BACKEND_IP/webhooks/whatsapp?provider=evolution\",\"enabled\":true,\"events\":[\"MESSAGES_UPSERT\"]}" \
      --header="apikey: salvabolsoevolution123456" \
      --header="Content-Type: application/json" \
      http://localhost:8080/webhook/set/salva-bolso 2>&1)
    echo "  $UPDATE"
    ok "Webhook atualizado — Evolution agora envia direto para $BACKEND_IP"
  fi
else
  warn "Webhook nao apareceu nos logs"
  echo "$LOGS" | tail -5
fi
