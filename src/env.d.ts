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
