import { Config } from "../core/config.js";
import { RateLimiter } from "../core/rate-limiter.js";
import { CircuitBreaker, CircuitOpenError } from "../core/circuit-breaker.js";

/** Default fetch timeout: 60 seconds */
const FETCH_TIMEOUT_MS = 60_000;

/** Parameters that carry a file: a file_id, an http(s) URL, or a data: URI. */
const FILE_FIELDS = [
  "photo", "audio", "document", "video", "animation", "voice",
  "video_note", "sticker", "thumbnail", "certificate", "cover", "live_photo",
] as const;

const INPUT_MEDIA_FILE_FIELDS = ["media", "thumbnail", "cover"] as const;

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isDataUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

/**
 * Every InputMedia object reachable from a call's params, wherever it hides:
 * sendMediaGroup's `media` array, editMessageMedia's single `media` object, and the
 * InputRichMessageMedia entries in `rich_message.media` (each of which wraps its own
 * InputMedia under `.media`). Returned objects are the live ones, so callers can rewrite
 * their `media` / `thumbnail` / `cover` fields in place.
 */
function inputMediaObjects(params: Record<string, unknown>): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];

  const push = (value: unknown) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      objects.push(value as Record<string, unknown>);
    }
  };

  if (typeof params.media === "object" && params.media !== null) {
    const entries = Array.isArray(params.media) ? params.media : [params.media];
    entries.forEach(push);
  }

  const rich = params.rich_message;
  if (typeof rich === "object" && rich !== null) {
    const entries = (rich as Record<string, unknown>).media;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null) continue;
        // InputRichMessageMedia = { id, media: InputMedia }; tolerate a bare InputMedia too
        const inner = (entry as Record<string, unknown>).media;
        if (typeof inner === "object" && inner !== null) push(inner);
        else push(entry);
      }
    }
  }

  return objects;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
};

/** A sane filename for an upload — Telegram infers the file type from it. */
function filenameFor(name: string, contentType: string | null): string {
  if (/\.[A-Za-z0-9]+$/.test(name)) return name;
  const ext = contentType && MIME_EXTENSIONS[contentType.split(";")[0].trim().toLowerCase()];
  return `${name || "file"}${ext ?? ".bin"}`;
}

function urlBasename(url: string): string {
  try {
    return new URL(url).pathname.split("/").pop() ?? "";
  } catch {
    return "";
  }
}

/**
 * Decode `data:[<mime>][;name=<filename>][;base64],<data>`. The `name` parameter is our
 * extension (data URIs carry no filename) so callers can control what Telegram sees.
 */
export function parseDataUri(uri: string): { bytes: Uint8Array; contentType: string | null; name: string } {
  const comma = uri.indexOf(",");
  if (comma < 0) throw new TelegramApiError("Malformed data: URI (no comma)", 400);
  const meta = uri.slice("data:".length, comma).split(";");
  const data = uri.slice(comma + 1);

  const contentType = meta[0] || null;
  const base64 = meta.includes("base64");
  const nameParam = meta.find((p) => p.startsWith("name="));
  const name = nameParam ? decodeURIComponent(nameParam.slice("name=".length)) : "";

  let bytes: Uint8Array;
  if (base64) {
    let binary: string;
    try {
      binary = atob(data.replace(/\s+/g, ""));
    } catch {
      throw new TelegramApiError("Malformed data: URI (invalid base64)", 400);
    }
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(data));
  }
  return { bytes, contentType, name };
}

interface Upload {
  blob: Blob;
  name: string;
}

/** A file field that must be uploaded as multipart, and how to point the request at it. */
interface UploadTarget {
  value: string;
  /** Top-level fields are multipart parts under their own name; InputMedia uses attach://. */
  topLevelField?: string;
  setAttach?: (ref: string) => void;
}

interface TelegramResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

function log(level: "info" | "warn" | "error", msg: string): void {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

function maskToken(str: string, token: string): string {
  return str.replaceAll(token, "***");
}

export class TelegramClient {
  private baseUrl: string;
  private token: string;
  private rateLimiter: RateLimiter;
  private circuitBreaker: CircuitBreaker;
  private config: Config;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(config: Config) {
    this.config = config;
    this.token = config.botToken;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    this.rateLimiter = new RateLimiter(config.globalRateLimit, config.perChatRateLimit);
    this.circuitBreaker = new CircuitBreaker(
      config.circuitBreakerThreshold,
      config.circuitBreakerCooldown
    );
    this.cleanupInterval = setInterval(() => this.rateLimiter.cleanup(), 60_000);
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const resolvedParams = this.applyDefaults(params);

    // media / rich_message may arrive as a JSON string (tool schema is untyped) — parse so
    // attach:// rewriting sees the InputMedia inside them
    for (const key of ["media", "rich_message"]) {
      const value = resolvedParams[key];
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try {
          resolvedParams[key] = JSON.parse(trimmed);
        } catch {
          // leave as-is (could be a bare file_id/URL for editMessageMedia misuse)
        }
      }
    }

    const chatId = resolvedParams.chat_id as string | undefined;

    this.circuitBreaker.check();
    await this.rateLimiter.acquire(chatId);

    // URLs are fetched here and uploaded as bytes rather than handed to Telegram: its own
    // fetching caps at 5 MB for photos / 20 MB otherwise and rejects many MIME types
    // (sendDocument by URL only takes PDF and ZIP). Uploads lift that to 10 MB / 50 MB.
    const formParams = structuredClone(resolvedParams);
    const targets = this.collectUploadTargets(formParams);
    if (targets.length === 0) {
      return this.callWithRetry(method, () => this.postJson(method, resolvedParams));
    }
    const form = await this.buildForm(formParams, targets);
    return this.callWithRetry(method, () => this.postForm(method, form));
  }

  /** Every URL / data: URI in a file field. buildForm rewrites `params` in place. */
  private collectUploadTargets(params: Record<string, unknown>): UploadTarget[] {
    const targets: UploadTarget[] = [];
    const needsUpload = (v: unknown): v is string => isHttpUrl(v) || isDataUri(v);

    for (const field of FILE_FIELDS) {
      const value = params[field];
      if (needsUpload(value)) targets.push({ value, topLevelField: field });
    }
    for (const item of inputMediaObjects(params)) {
      for (const field of INPUT_MEDIA_FILE_FIELDS) {
        const value = item[field];
        if (needsUpload(value)) targets.push({ value, setAttach: (ref) => { item[field] = ref; } });
      }
    }
    return targets;
  }

  private async buildForm(params: Record<string, unknown>, targets: UploadTarget[]): Promise<FormData> {
    const form = new FormData();
    let n = 0;
    for (const target of targets) {
      const upload = await this.loadUpload(target.value);
      if (target.topLevelField) {
        form.append(target.topLevelField, upload.blob, upload.name);
        delete params[target.topLevelField];
      } else {
        const part = `file${n++}`;
        form.append(part, upload.blob, upload.name);
        target.setAttach!(`attach://${part}`);
      }
    }
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    return form;
  }

  private async loadUpload(value: string): Promise<Upload> {
    let bytes: Uint8Array | ArrayBuffer;
    let contentType: string | null;
    let name: string;
    let label: string;

    if (isDataUri(value)) {
      ({ bytes, contentType, name } = parseDataUri(value));
      label = "data: URI";
    } else {
      let response: Response;
      try {
        response = await fetch(value, { redirect: "follow" });
      } catch (error) {
        throw new TelegramApiError(
          `Could not download ${value}: ${(error as Error).message}. The link must be directly reachable from the Worker.`,
          0
        );
      }
      if (!response.ok) {
        throw new TelegramApiError(
          `Could not download ${value} — HTTP ${response.status}. The link must point straight at the file, with no login or hotlink protection.`,
          response.status
        );
      }
      bytes = await response.arrayBuffer();
      contentType = response.headers.get("content-type");
      name = urlBasename(value);
      label = value;
    }

    if (bytes.byteLength > this.config.maxFileSize) {
      throw new TelegramApiError(
        `${label} is ${(bytes.byteLength / 1048576).toFixed(1)} MB — Telegram accepts at most ` +
          `${Math.round(this.config.maxFileSize / 1048576)} MB per upload. Send a smaller file or a shorter clip.`,
        413
      );
    }
    const type = contentType ?? "application/octet-stream";
    return { blob: new Blob([bytes], { type }), name: filenameFor(name, contentType) };
  }

  private applyDefaults(params: Record<string, unknown>): Record<string, unknown> {
    const result = { ...params };
    if (!result.chat_id && this.config.defaultChatId) {
      result.chat_id = this.config.defaultChatId;
    }
    if (!result.message_thread_id && this.config.defaultThreadId) {
      result.message_thread_id = this.config.defaultThreadId;
    }
    return result;
  }

  private async callWithRetry(
    method: string,
    send: () => Promise<unknown>,
    attempt = 1
  ): Promise<unknown> {
    try {
      const result = await send();
      this.circuitBreaker.recordSuccess();
      return result;
    } catch (error) {
      if (error instanceof CircuitOpenError) throw error;

      const err = error as TelegramApiError;

      // Don't retry 4xx (except 429)
      if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429) {
        throw error;
      }

      // 429: respect retry_after (or default 5s if not provided)
      if (err.statusCode === 429) {
        if (attempt <= this.config.maxRetries) {
          const retryAfter = err.retryAfter ?? 5;
          log("warn", `Rate limited on ${method}, waiting ${retryAfter}s (attempt ${attempt}/${this.config.maxRetries})`);
          await sleep(retryAfter * 1000);
          return this.callWithRetry(method, send, attempt + 1);
        }
        throw error;
      }

      const justOpened = this.circuitBreaker.recordFailure(err.statusCode);
      if (justOpened) {
        log("error", `Circuit breaker OPENED after ${this.config.circuitBreakerThreshold} failures`);
      }

      // Retry on transient errors (5xx, network)
      if (attempt < this.config.maxRetries) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
        log("warn", `Retrying ${method} in ${backoffMs}ms (attempt ${attempt + 1}/${this.config.maxRetries})`);
        await sleep(backoffMs);
        return this.callWithRetry(method, send, attempt + 1);
      }

      throw error;
    }
  }

  private postJson(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.post(method, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  }

  private postForm(method: string, form: FormData): Promise<unknown> {
    return this.post(method, { body: form });
  }

  private async post(method: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}/${method}`, {
        ...init,
        method: "POST",
        signal: controller.signal,
      });
      return await this.handleResponse(method, response);
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      // fetch errors can echo the request URL, which contains the token
      throw new Error(maskToken((error as Error).message, this.token));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleResponse(method: string, response: Response): Promise<unknown> {
    let data: TelegramResponse;
    try {
      data = (await response.json()) as TelegramResponse;
    } catch {
      throw new TelegramApiError(
        `Failed to parse response from ${method} (HTTP ${response.status})`,
        response.status
      );
    }

    if (!data.ok) {
      const description = data.description
        ? maskToken(data.description, this.token)
        : "Unknown error";

      throw new TelegramApiError(
        `${method}: ${description}`,
        data.error_code || response.status,
        data.parameters?.retry_after
      );
    }

    return data.result;
  }

  /** Fetch a file's bytes by file_id (getFile + download). */
  async fetchFile(fileId: string): Promise<{ fileName: string; data: ArrayBuffer }> {
    const fileInfo = (await this.call("getFile", { file_id: fileId })) as {
      file_id: string;
      file_path?: string;
      file_size?: number;
    };

    if (!fileInfo.file_path) {
      throw new Error("Telegram returned no file_path — file may be too large (>20MB)");
    }

    const url = `https://api.telegram.org/file/bot${this.token}/${fileInfo.file_path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
      }
      const fileName = fileInfo.file_path.split("/").pop() || `file_${fileId}`;
      return { fileName, data: await response.arrayBuffer() };
    } catch (error) {
      // fetch errors can echo the request URL, which contains the token
      throw new Error(maskToken((error as Error).message, this.token));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class TelegramApiError extends Error {
  statusCode?: number;
  retryAfter?: number;

  constructor(message: string, statusCode?: number, retryAfter?: number) {
    super(message);
    this.name = "TelegramApiError";
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
