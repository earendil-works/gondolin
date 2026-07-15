export type InternalHttpRequestBody =
  | { kind: "none" }
  | { kind: "buffered"; bytes: Buffer }
  | {
      kind: "stream";
      stream: ReadableStream<Uint8Array>;
      /** trusted body length in `bytes` */
      byteLength: number;
    }
  | {
      kind: "metadata-only";
      /** trusted body length in `bytes` */
      byteLength: number;
    };

export type InternalHttpRequest = {
  /** http method */
  method: string;
  /** request url */
  url: string;
  /** canonical request headers without body framing */
  headers: Record<string, string>;
  /** request body and trusted framing metadata */
  body: InternalHttpRequestBody;
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
