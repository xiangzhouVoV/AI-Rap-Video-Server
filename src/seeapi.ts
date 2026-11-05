import type { AppEnv } from "./env";

export class ProviderError extends Error {
  constructor(public status: number, public uncertain: boolean, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ProviderTask = {
  id: string;
  status: string;
  estimated_credits?: number;
  consumed_credits?: number;
  refunded_credits?: number;
  result?: { assets?: Array<{ type?: string; url?: string; mime_type?: string }> };
};

export async function providerRequest(env: AppEnv, path: string, options: { body?: string; key?: string } = {}): Promise<ProviderTask> {
  if (!env.SEEAPI_API_KEY) throw new ProviderError(503, false, "Video generation is not configured.");
  const base = new URL(env.SEEAPI_API_BASE_URL || "https://api.seeapi.com");
  if (base.protocol !== "https:" || base.username || base.password) throw new ProviderError(503, false, "The video provider address is invalid.");
  const headers = new Headers({ Authorization: `Bearer ${env.SEEAPI_API_KEY}` });
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.key) headers.set("Idempotency-Key", options.key);
  let response: Response;
  try {
    response = await fetch(new URL(path, base), {
      method: options.body ? "POST" : "GET", headers, body: options.body,
      redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ProviderError(502, true, "The provider has not confirmed this request. Resume this task instead of starting another.");
  }
  if (!response.ok) {
    const uncertain = response.status >= 500 || [408, 409, 425, 429].includes(response.status);
    const message = response.status === 402 ? "The video provider balance or daily limit is insufficient."
      : response.status === 401 || response.status === 403 ? "The video provider rejected the configured credentials or model access."
      : uncertain ? "The provider is temporarily unavailable. This task can be resumed safely."
      : "The provider rejected these inputs. Check the image and reference-video requirements before creating another task.";
    throw new ProviderError(response.status, uncertain, message);
  }
  let payload: { generation?: ProviderTask };
  try { payload = await response.json(); } catch {
    throw new ProviderError(502, true, "The provider returned an unreadable response. Resume this task to check its status.");
  }
  if (!payload || typeof payload.generation?.id !== "string" || !payload.generation.id || typeof payload.generation.status !== "string") {
    throw new ProviderError(502, true, "The provider did not return a task identifier. Resume this task safely.");
  }
  return payload.generation;
}

export function publicHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) throw new Error("Use a direct HTTPS media URL.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Use a direct HTTPS media URL."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443"
    || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    throw new Error("Use a public HTTPS media URL without credentials or a fragment.");
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com") || host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") {
    throw new Error("Use the video file URL, not a TikTok or YouTube webpage.");
  }
  return url.href;
}
