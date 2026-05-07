export interface SendTextParams {
  to: string;
  text: string;
}

export interface SendTemplateParams {
  to: string;
  templateName: string;
  language: string;
  components: Array<{
    type: "body" | "header" | "button";
    parameters: Array<{ type: "text"; text: string }>;
  }>;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  provider: string;
  error?: string;
}

export interface IWhatsAppProvider {
  readonly name: string;
  sendText(params: SendTextParams): Promise<SendResult>;
  sendTemplate(params: SendTemplateParams): Promise<SendResult>;
}
