# Salva Bolso — Assistente Financeiro via WhatsApp

**Objetivo Principal:** Transformar o bot em um produto vendável, moderno, elegante e com alta conversão de assinatura Premium (experiência SaaS Premium).

## Stack & Infraestrutura
* **Tecnologias:** Node.js, TypeScript, PostgreSQL, Evolution API, Docker
* **Infra:** Hospedado no Easypanel, deploy via GitHub
* **Integrações:** Webhook Evolution e Pagamentos Asaas funcionais

## Domínios e Links
* **Página Premium:** https://salva-bolso-backend-salvabolso.h5prml.easypanel.host/premium-checkout.html
* **Links Asaas:**
  * Mensal (R$ 14,90): https://www.asaas.com/c/rf9q457jxjxyipbt
  * Anual (R$ 99,90): https://www.asaas.com/c/0ekcdmk3zjjcl5e1

## Modelo Premium & UX de Expiração (Freemium/Paywall)
* **Trial:** Teste grátis de 7 dias com acesso total.
* **Pós-expiração (Strict-Mode Absoluto):**
  * 🔴 Bloqueado: Registrar novos gastos (tanto comandos quanto intenções naturais via IA), recursos premium, metas, relatórios.
  * 🟢 Liberado: Consultar saldo e visualizar registros do mês (exclusivamente comandos estritos de leitura: `saldo`, `resumo`, `hoje`, `semana`, `extrato`, `menu`, `ajuda`).
* **Mensagens Pós-expiração:**
  * *Primeira Interação (Controlada por state tracking V4 no banco para não repetir):* 
    ```
    ✨ Seu teste grátis terminou.

    Você ainda pode:
    👀 consultar saldo
    📊 visualizar registros do mês

    Desbloqueie todos os recursos:
    https://salva-bolso-backend-salvabolso.h5prml.easypanel.host/premium-checkout.html
    ```
  * *Interações Seguintes (Curtas):*
    * Tentativa de gasto: `🔒 Registro de novos gastos disponível no Premium.\n\n[link]`
    * Tentativa de comando premium: `🔒 Função exclusiva do Premium.\n\n[link]`
* **Regra de UX:** Evitar spam rigorosamente. Primeira mensagem é longa e contextualizada; as seguintes são secas e diretas.

## Página Premium (SaaS UX)
* **Design:** Moderno, minimalista, otimizado para mobile (Fintech/SaaS).
* **Dinâmica:** Abre no Mensal (R$ 14,90). Toggle permite alternar para Anual (R$ 99,90).
* **Upsell Anual:** Destaque "Mais vantajoso", exibição de economia visual (-44%), mostra equivalente mensal. Troca link e textos dinamicamente sem reload.

## Ativação Premium (Asaas)
* **Mensagem de Ativação:**
  ```
  🎉 Premium ativado com sucesso!

  Agora você tem acesso completo ao Salva Bolso:
  💰 registro ilimitado de gastos
  📊 relatórios financeiros detalhados
  🎯 metas personalizadas
  🔄 controle de gastos recorrentes
  📅 acompanhamento mensal completo
  👀 consulta de saldo e histórico
  ⚡ acesso total aos recursos Premium

  Pode continuar usando normalmente ✨
  ```
* **Idempotência (Webhook):** Trava via banco de dados (`processed_messages` usando `paymentId`) descarta eventos duplicados do Asaas, garantindo que o usuário receba a ativação e a mensagem comemorativa **apenas uma vez**.

## Diretrizes de UX e Desenvolvimento
* Visual premium, limpo e sofisticado.
* Mensagens curtas, diretas e sem textos enormes.
* Evitar repetição e spam.
* Bloquear funções sem irritar o usuário (UX amigável).
* Aumentar retenção e percepção de valor.
* **Execução:** Responder sempre de forma objetiva e seguir uma etapa por vez para evitar retrabalho e bugs.

## Histórico de Ajustes Concluídos
✅ Bug preço inicial mensal
✅ Deploys quebrando (erros de TS corrigidos)
✅ Cannot GET premium-checkout
✅ Problemas de assets/logo
✅ Placeholders quebrados
✅ Links premium quebrados
✅ UX agressiva (spam de mensagens repetidas eliminado via tracking de estado `expiracao_aviso_v4`)
✅ Bloqueio pós-expiração (Restaurado **Strict-Mode**: trava comandos e IA natural, liberando apenas "read-only")
✅ Experiência mobile e Visual premium (tons esmeralda/dourado)
✅ Sincronização toggle mensal/anual e upsell inteligente
✅ **Idempotência no webhook do Asaas (evitar múltiplas ativações confirmadas)**
✅ **Short-lived Contextual Memory:** Bot não perde o fio da meada após ações como cadastro de múltiplos recorrentes.
