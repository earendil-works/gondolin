export type InternalHttpRequest = {
  /** http method */
  method: string;
  /** request url */
  url: string;
  /** request headers */
  headers: Record<string, string>;
  /** request body (null for empty) */
  body: Buffer | null;
};

export type InternalHeaderValue = string | string[];
export type InternalHttpResponseHeaders = Record<string, InternalHeaderValue>;

export type InternalHttpResponse = {
  /** http status code */
  status: number;
  /** http status text */
  statusText: string;
  /** response headers */
  headers: InternalHttpResponseHeaders;
  /** response body */
  body: Buffer;
};
