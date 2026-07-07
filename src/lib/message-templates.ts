export type TemplateCategory = "decline" | "advice" | "plan" | "handover";

export const TEMPLATE_CATEGORIES: TemplateCategory[] = ["decline", "advice", "plan", "handover"];

export const TEMPLATE_CATEGORY_LABEL: Record<TemplateCategory, string> = {
  decline: "Decline",
  advice: "Advice",
  plan: "Plan",
  handover: "Handover",
};

export type MessageChannel = "phone" | "bleep" | "email" | "secure_msg" | "in_person";
export type MessageDirection = "outbound" | "inbound";

export const MESSAGE_CHANNELS: MessageChannel[] = ["phone", "bleep", "email", "secure_msg", "in_person"];

export const MESSAGE_CHANNEL_LABEL: Record<MessageChannel, string> = {
  phone: "Phone",
  bleep: "Bleep",
  email: "Email",
  secure_msg: "Secure message",
  in_person: "In person",
};
