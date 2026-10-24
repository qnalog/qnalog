/**
 * Stand-in for the `obsidian` module when the plugin's transcription code runs in Node
 * (accuracy baseline runner). esbuild aliases `obsidian` to this file.
 *
 * Only what the transcription path touches is provided: requestUrl, normalizePath and
 * the few classes and flags the imported modules reference at load time. Nothing here
 * ships in the plugin bundle.
 */
export interface ShimRequestParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
  throw?: boolean;
}

export interface ShimRequestResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
}

export type ShimFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | ArrayBuffer }) => Promise<{
  status: number;
  headers: { forEach(callback: (value: string, key: string) => void): void };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * Builds a requestUrl with the shape Obsidian returns: status, lower-case headers, text,
 * json and arrayBuffer. As in Obsidian, a non-2xx status rejects unless `throw` is false.
 */
export function createRequestUrl(fetchImpl: ShimFetch): (request: ShimRequestParam | string) => Promise<ShimRequestResponse> {
  return async (request) => {
    const param: ShimRequestParam = typeof request === "string" ? { url: request } : request;
    const headers: Record<string, string> = { ...(param.headers ?? {}) };
    if (param.contentType) headers["Content-Type"] = param.contentType;
    const response = await fetchImpl(param.url, { method: param.method ?? "GET", headers, body: param.body });
    const arrayBuffer = await response.arrayBuffer();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key.toLowerCase()] = value; });
    const text = new TextDecoder().decode(arrayBuffer);
    const result: ShimRequestResponse = {
      status: response.status,
      headers: responseHeaders,
      text,
      arrayBuffer,
      get json(): unknown { return JSON.parse(text); },
    };
    if (param.throw !== false && (response.status < 200 || response.status >= 300)) {
      throw new Error(`Request failed, status ${response.status}`);
    }
    return result;
  };
}

export const requestUrl = createRequestUrl((url, init) => fetch(url, init));

export function normalizePath(path: string): string {
  return String(path).replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "") || "/";
}

export class TFile {}
export class Notice {
  constructor(_message?: string, _timeout?: number) { /* the runner has no UI */ }
}
export const Platform = { isMobile: false, isMobileApp: false, isDesktop: true, isDesktopApp: true };
