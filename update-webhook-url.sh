#!/bin/bash
# update-webhook-url.sh — Atualiza URL do webhook da Evolution para o IP real do backend

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[1;34m'; N='\033[0m'
ok()   { echo -e "${G}[OK]${N} $1"; }
info() { echo -e "${B}[>>]${N} $1"; }
warn() { echo -e "${Y}[!!]${N} $1"; }
fail() { echo -e "${R}[XX]${N} $1"; }

CID=$(docker ps -q --filter "name=evolution" | head -1)
[ -z "$CID" ] && fail "Container Evolution nao encontrado" && exit 1

BACKEND_CID=$(docker ps -q --filter "name=backend-salvabolso" | head -1)
[ -z "$BACKEND_CID" ] && fail "Container backend nao encontrado" && exit 1

# Pegar IP do backend na rede interna
BACKEND_IP=$(docker inspect "$BACKEND_CID" \
  --format '{{range $net, $cfg := .NetworkSettings.Networks}}{{if eq $net "easypanel-salva-bolso"}}{{$cfg.IPAddress}}{{end}}{{end}}')
[ -z "$BACKEND_IP" ] && BACKEND_IP=$(docker inspect "$BACKEND_CID" \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' | awk '{print $1}')

NEW_URL="http://$BACKEND_IP/webhooks/whatsapp?provider=evolution"
info "Backend IP: $BACKEND_IP"
info "Nova URL: $NEW_URL"

echo ""
info "=== Webhook atual ==="
docker exec "$CID" wget -qO- -T5 \
  --header="apikey: salvabolsoevolution123456" \
  http://localhost:8080/webhook/find/salva-bolso 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin); print('URL atual:', d.get('url','?'))" 2>/dev/null

echo ""
info "=== Atualizando webhook (formato v2) ==="
RESP=$(docker exec "$CID" node -e "
var http = require('http');
var body = JSON.stringify({
  webhook: {
    url: '$NEW_URL',
    enabled: true,
    byEvents: false,
    base64: false,
    events: ['MESSAGES_UPSERT']
  }
});
var opts = {
  hostname: 'localhost', port: 8080,
  path: '/webhook/set/salva-bolso',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'apikey': 'salvabolsoevolution123456'
  }
};
var req = http.request(opts, function(res) {
  var d = '';
  res.on('data', function(c){ d += c; });
  res.on('end', function(){ console.log(d); });
});
req.on('error', function(e){ console.error('ERRO:', e.message); });
req.write(body);
req.end();
" 2>&1)
echo "Resposta: $RESP"

echo ""
info "=== Verificando nova URL ==="
docker exec "$CID" wget -qO- -T5 \
  --header="apikey: salvabolsoevolution123456" \
  http://localhost:8080/webhook/find/salva-bolso 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin); print('URL agora:', d.get('url','?'))" 2>/dev/null

echo ""
info "=== Teste rapido de conectividade com nova URL ==="
HTTP=$(docker exec "$CID" wget -SO- -T5 \
  "http://$BACKEND_IP/webhooks/whatsapp?provider=evolution" 2>&1 | grep "HTTP/" | head -1)
if echo "$HTTP" | grep -qE "403|200|400|422"; then
  ok "Backend alcancavel em $BACKEND_IP — sistema pronto"
  echo ""
  ok "Agora envie uma mensagem real pelo WhatsApp para o numero do bot"
  ok "O numero cadastrado no banco e: 5568992383325"
else
  fail "Conectividade falhou: $HTTP"
fi
