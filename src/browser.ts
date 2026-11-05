import type { Deps } from "./core/types";
// http(s) URLs in chat text, first two; trailing punctuation is not part of the URL.
export function extractUrls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]}]/gi) ?? []).slice(0, 2);
}

const SNAPSHOT_PATH = "browser-rendering/snapshot";
const MAX_MARKDOWN = 12_000;

// null on any failure (non-2xx, success:false, missing fields, timeout): the model is simply told the page could not be opened.
export function makeSnapshot(cfg: { accountId: string; token: string; fetch?: typeof fetch; timeoutMs?: number; log?: (e: Record<string, unknown>) => void }): Deps["snapshot"] {
  const f = cfg.fetch ?? fetch, log = cfg.log ?? console.log;
  return async (url) => {
    try {
      const res = await f(`https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/${SNAPSHOT_PATH}?cacheTTL=0`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          url, formats: ["screenshot", "markdown"],
          viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
          screenshotOptions: { type: "jpeg", quality: 80 }, gotoOptions: { waitUntil: "networkidle2", timeout: 20000 }, bestAttempt: true,
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 25_000),
      });
      if (!res.ok) {
        log({ event: "snapshot_failed", status: res.status, retryAfter: res.headers.get("Retry-After") });
        return null;
      }
      const body = (await res.json()) as { success?: boolean; result?: { screenshot?: string; markdown?: string }; meta?: { title?: string; status?: number; finalUrl?: string } };
      const { screenshot, markdown } = body.result ?? {};
      if (body.success === false || !screenshot || markdown === undefined) {
        log({ event: "snapshot_failed", reason: "bad_body" });
        return null;
      }
      return {
        url, finalUrl: body.meta?.finalUrl ?? url, title: body.meta?.title ?? "", status: body.meta?.status ?? 0,
        markdown: markdown.replace(/^---\r?\n[\s\S]*?\r?\n?---\r?\n/, "").slice(0, MAX_MARKDOWN),
        jpeg: Uint8Array.from(atob(screenshot), (c) => c.charCodeAt(0)),
      };
    } catch (e) {
      log({ event: "snapshot_failed", error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };
}
