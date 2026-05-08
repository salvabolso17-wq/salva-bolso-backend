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
info "=== 1. DNS do backend ==="
DNS=$(docker exec "$CID" nslookup salva-bolso_backend-salvabolso 2>&1 | grep "Address:" | grep -v "127.0.0.11")
echo "$DNS"
IP_COUNT=$(echo "$DNS" | grep -c "Address:" || true)
[ "$IP_COUNT" -gt 1 ] && warn "Ghost DNS detectado ($IP_COUNT IPs) — pode causar falha intermitente"
[ "$IP_COUNT" -eq 1 ] && ok "DNS limpo — 1 IP apenas"

echo ""
info "=== 2. Conectividade backend ==="
HTTP=$(docker exec "$CID" wget -SO- -T5 \
  "http://salva-bolso_backend-salvabolso/webhooks/whatsapp?provider=evolution" 2>&1 | grep "HTTP/" | head -1)
if echo "$HTTP" | grep -qE "403|200|400|422"; then
  ok "Backend alcancavel: $HTTP"
else
  fail "Backend inacessivel: $HTTP"
  warn "Aguarde 2 minutos para o ghost DNS expirar e rode novamente"
  exit 1
fi

echo ""
info "=== 3. Enviando webhook de teste ==="
RESP=$(docker exec "$CID" wget -qO- -T10 \
  --post-data='{"event":"MESSAGES_UPSERT","instance":"salva-bolso","data":{"key":{"remoteJid":"5568992383325@s.whatsapp.net","fromMe":false,"id":"TESTE_'$(date +%s)'"},"message":{"conversation":"50 uber"},"messageTimestamp":'$(date +%s)'}}' \
  --header="Content-Type: application/json" \
  "http://salva-bolso_backend-salvabolso/webhooks/whatsapp?provider=evolution" 2>&1)
echo "Resposta: $RESP"

echo ""
info "=== 4. Logs backend (ultimos 10s) ==="
sleep 2
LOGS=$(docker service logs --since 15s salva-bolso_backend-salvabolso 2>&1 | grep -v "^$")
echo "$LOGS"

echo ""
if echo "$LOGS" | grep -q "\[WEBHOOK\]"; then
  ok "WEBHOOK RECEBIDO PELO BACKEND"
  echo "$LOGS" | grep -E "\[WEBHOOK\]|\[USER\]|\[PARSER\]|\[DB\]|\[WHATSAPP\]|\[ERROR\]"
elif echo "$LOGS" | grep -q "unreachable\|ECONNREFUSED"; then
  fail "Backend nao alcancou destino — verificar rede"
else
  warn "Nenhuma entrada de webhook nos logs — possivelmente caiu no ghost IP"
  warn "Aguarde 2 minutos e rode novamente"
fi
