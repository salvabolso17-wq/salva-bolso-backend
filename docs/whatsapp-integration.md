# Integração WhatsApp — Arquitetura

## Visão Geral

A camada de comunicação WhatsApp é totalmente desacoplada via interface `IWhatsAppProvider`.
Trocar de provedor exige apenas alterar a variável de ambiente `WHATSAPP_PROVIDER`.

## Estrutura

```
src/services/whatsapp/
├── index.ts                    # Factory: instancia o provider via env var
├── types.ts                    # Interfaces: IWhatsAppProvider, SendTextParams, SendResult
└── providers/
    ├── MockProvider.ts         # Log local, sem chamada real (padrão em dev)
    ├── MetaProvider.ts         # Stub Meta WhatsApp Cloud API
    ├── EvolutionProvider.ts    # Stub Evolution API (self-hosted)
    └── Dialog360Provider.ts    # Stub 360dialog
```

## Interface

```typescript
interface IWhatsAppProvider {
  readonly name: string;
  sendText(params: SendTextParams): Promise<SendResult>;
  sendTemplate(params: SendTemplateParams): Promise<SendResult>;
}
```

Qualquer novo provider só precisa implementar essa interface.

## Seleção de Provider

A variável de ambiente `WHATSAPP_PROVIDER` define o provider ativo:

| Valor         | Provider            | Status     |
|---------------|---------------------|------------|
| `mock`        | MockProvider        | Pronto     |
| `meta`        | MetaProvider        | Stub       |
| `evolution`   | EvolutionProvider   | Stub       |
| `360dialog`   | Dialog360Provider   | Stub       |

Se não definida, usa `mock` por padrão.

## Variáveis de Ambiente

| Variável                       | Provider    | Descrição                          |
|--------------------------------|-------------|-------------------------------------|
| `WHATSAPP_PROVIDER`            | todos       | Provider ativo                      |
| `WHATSAPP_VERIFY_TOKEN`        | meta        | Token de verificação do webhook     |
| `WHATSAPP_META_TOKEN`          | meta        | Bearer token da Cloud API           |
| `WHATSAPP_META_PHONE_ID`       | meta        | ID do número de telefone na Meta    |
| `WHATSAPP_EVOLUTION_URL`       | evolution   | URL base da Evolution API           |
| `WHATSAPP_EVOLUTION_KEY`       | evolution   | API Key da instância                |
| `WHATSAPP_EVOLUTION_INSTANCE`  | evolution   | Nome da instância                   |
| `WHATSAPP_360_API_KEY`         | 360dialog   | API Key da 360dialog                |

## Como Ativar um Provider Real

1. Configure as variáveis de ambiente no EasyPanel
2. Abra o arquivo do provider em `src/services/whatsapp/providers/`
3. Descomente o bloco `// Implementação real` dentro dos métodos
4. Altere `WHATSAPP_PROVIDER` para o provider desejado e faça redeploy

## Fluxo de uma Mensagem

```
WhatsApp → POST /webhooks/whatsapp
         → normalizePayload()         [adapters/whatsappAdapters.ts]
         → findUserByTelefone()       [services/whatsappService.ts]
         → parseTransaction()         [utils/parseTransaction.ts]
         → INSERT transactions        [PostgreSQL]
         → whatsapp.sendText()        [services/whatsapp/index.ts → provider ativo]
         → resposta de confirmação ao usuário
```

## Adicionar Novo Provider

1. Criar `src/services/whatsapp/providers/NovoProvider.ts` implementando `IWhatsAppProvider`
2. Importar e adicionar o case em `src/services/whatsapp/index.ts`
3. Documentar as variáveis de ambiente necessárias aqui
