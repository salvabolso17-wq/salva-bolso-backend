import type { IWhatsAppProvider } from "./types";
import { MockProvider }     from "./providers/MockProvider";
import { MetaProvider }     from "./providers/MetaProvider";
import { EvolutionProvider } from "./providers/EvolutionProvider";
import { Dialog360Provider } from "./providers/Dialog360Provider";

export type { IWhatsAppProvider, SendTextParams, SendTemplateParams, SendResult } from "./types";

function createProvider(): IWhatsAppProvider {
  const provider = (process.env.WHATSAPP_PROVIDER ?? "mock").toLowerCase();

  switch (provider) {
    case "meta":      return new MetaProvider();
    case "evolution": return new EvolutionProvider();
    case "360dialog": return new Dialog360Provider();
    default:          return new MockProvider();
  }
}

export const whatsapp: IWhatsAppProvider = createProvider();
