// Secrets set via `wrangler secret`; not in wrangler.jsonc so `wrangler types` does not emit them.
declare namespace Cloudflare {
  interface Env {
    WHATSAPP_TOKEN: string;
    WHATSAPP_PHONE_NUMBER_ID: string;
    WHATSAPP_APP_SECRET: string;
    WHATSAPP_VERIFY_TOKEN: string;
    OPENROUTER_API_KEY: string;
    CLOUDFLARE_API_TOKEN: string;
    ALLOWED_PHONES: string;
  }
}

// Optional model overrides (wrangler vars); unset means the JOBS default. The global Env does not extend Cloudflare.Env.
interface Env {
  MODEL_REPLY?: string;
  MODEL_VISION?: string;
  MODEL_EXTRACT?: string;
  MODEL_DERIVE?: string;
  MODEL_PAGE?: string;
  REPLY_EFFORT?: string; // low | medium | high; unset = the reply model's cheapest reasoning setting
  // Telegram secrets: here, not in Cloudflare.Env above, because only this interface reaches `env`; unset at runtime keeps /telegram dark.
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_TELEGRAM: string;
}
