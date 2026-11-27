/**
 * The HTTP client tests drive a server with. It keeps cookies the way a
 * browser tab would, so an admin login carries over to the requests after
 * it, and it never follows redirects, so a test sees the redirect itself.
 * Farm sessions are bearer tokens, not cookies: the client holds an
 * optional `Authorization: Bearer <token>`, set by the Apple sign-in
 * helper or by seeded-session helpers.
 */
import { nextSeq, record, type HttpRecord } from "./transcript";

export interface RequestOptions {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | Array<string | number>>;
  /** Sent as JSON, with a JSON content type, unless `rawBody` is given. */
  body?: unknown;
  /** Sent as is; set the content type through `headers`. */
  rawBody?: string | Uint8Array;
  /** Leave the stored cookies out of this request. */
  noCookies?: boolean;
  /** Leave the bearer token out of this request. */
  noBearer?: boolean;
  /** Keep this exchange out of the cross-server comparison (its answer is not deterministic). */
  noCompare?: boolean;
  signal?: AbortSignal;
}

export interface ApiResult<T = any> {
  status: number;
  headers: Headers;
  /** The response body parsed as JSON; `undefined` when it is not JSON. */
  json: Record<string, unknown> | undefined;
  /**
   * The whole parsed JSON body: the farm has no `{status, body}` envelope.
   * `any` by default on purpose — tests read ad-hoc shapes off it, and the
   * runtime `toEqual` assertions are the real check on field names. Pass
   * an explicit type argument when a test wants the shape checked.
   */
  body: T;
  text: string;
  /** The `Set-Cookie` headers of the response. */
  setCookies: string[];
}

const HEADERS_NOT_COMPARED = new Set(["date", "content-length", "transfer-encoding", "connection", "keep-alive", "server"]);

export class ApiClient {
  readonly cookies = new Map<string, string>();
  bearer: string | undefined;

  constructor(
    readonly origin: string,
    private readonly file: string,
    private readonly stackIndex: number,
  ) {}

  /** A client on the same server with no cookies and no bearer token: another browser. */
  fresh(): ApiClient {
    return new ApiClient(this.origin, this.file, this.stackIndex);
  }

  /** A client on the same server carrying `Authorization: Bearer <token>`. */
  withBearer(token: string): ApiClient {
    const client = this.fresh();
    client.bearer = token;
    return client;
  }

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private storeCookies(setCookies: string[]): void {
    for (const cookie of setCookies) {
      const [pair, ...attributes] = cookie.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const maxAge = attributes.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith("max-age="));
      if (value === "" || maxAge === "max-age=0") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  url(path: string, query?: RequestOptions["query"]): string {
    // `path` is under /api unless it starts with "//", which means "exactly this path".
    const full = path.startsWith("//") ? path.slice(1) : `/api${path}`;
    if (!query) return this.origin + full;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
      else params.append(key, String(value));
    }
    const search = params.toString();
    return this.origin + full + (search ? (full.includes("?") ? "&" : "?") + search : "");
  }

  async request<T = any>(method: string, path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const seq = nextSeq(this.file);
    const headers: Record<string, string> = { ...options.headers };
    let body: string | Uint8Array | undefined;
    if (options.rawBody !== undefined) body = options.rawBody;
    else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }
    const hasCookieHeader = Object.keys(headers).some((h) => h.toLowerCase() === "cookie");
    if (!options.noCookies && !hasCookieHeader && this.cookies.size > 0) headers.Cookie = this.cookieHeader();
    const hasAuthHeader = Object.keys(headers).some((h) => h.toLowerCase() === "authorization");
    if (!options.noBearer && !hasAuthHeader && this.bearer !== undefined) headers.Authorization = `Bearer ${this.bearer}`;

    const response = await fetch(this.url(path, options.query), {
      method,
      headers,
      body,
      redirect: "manual",
      signal: options.signal,
    });
    const text = await response.text();
    let json: ApiResult<T>["json"];
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const setCookies = response.headers.getSetCookie();
    if (!options.noCookies) this.storeCookies(setCookies);

    if (!options.noCompare) {
      const recorded: HttpRecord["headers"] = {};
      response.headers.forEach((value, key) => {
        if (!HEADERS_NOT_COMPARED.has(key) && key !== "set-cookie") recorded[key] = value;
      });
      if (setCookies.length > 0) recorded["set-cookie"] = setCookies;
      record(this.file, {
        kind: "http",
        seq,
        stack: this.stackIndex,
        method,
        path: this.url(path, options.query).slice(this.origin.length),
        requestBody: options.rawBody !== undefined ? String(options.rawBody).slice(0, 2000) : options.body,
        status: response.status,
        headers: recorded,
        body: json === undefined ? text.slice(0, 20000) : json,
      });
    }

    return {
      status: response.status,
      headers: response.headers,
      json,
      body: json as T,
      text,
      setCookies,
    };
  }

  get<T = any>(path: string, options?: RequestOptions): Promise<ApiResult<T>> {
    return this.request<T>("GET", path, options);
  }

  post<T = any>(path: string, body?: unknown, options: RequestOptions = {}): Promise<ApiResult<T>> {
    return this.request<T>("POST", path, { ...options, body });
  }

  put<T = any>(path: string, body?: unknown, options: RequestOptions = {}): Promise<ApiResult<T>> {
    return this.request<T>("PUT", path, { ...options, body });
  }

  delete<T = any>(path: string, options?: RequestOptions): Promise<ApiResult<T>> {
    return this.request<T>("DELETE", path, options);
  }
}
