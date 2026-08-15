import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { verifyJWT } from "@utils/auth";
import {
  FileType,
  FileMetadata,
  FileItem,
  MAX_CHUNK_SIZE,
  MAX_CHUNK_NUM,
  MAX_FILE_SIZE,
  MAX_FILENAME_LENGTH,
  chunkPrefix,
} from "@shared/types";
import { DBAdapterFactory } from "@utils/db-adapter";
import { deleteFileCache } from "@utils/cache";
import {
  buildKeyId,
  getFileExt,
  getUniqueFileId,
  getContentTypeByExt,
} from "@utils/file";
import { TEMP_CHUNK_TTL } from "types";
import type { Env } from "../types/hono";

// ==========================================
// WebDAV 服务
// 挂载于 /dav，将网盘文件暴露为标准 WebDAV 资源
// 目录结构为虚拟目录：/img /video /audio /doc 对应四种 FileType
// 认证：HTTP Basic（密码 = 登录密码 PASSWORD 或 API_TOKEN，用户名任意）
// ==========================================

const DAV_BASE = "/dav";
const REALM = "OtterHub WebDAV";
const DAV_CLASS = "1, 2";
const DAV_ALLOW =
  "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK";

const TYPE_DIRS = [
  { dir: "img", type: FileType.Image },
  { dir: "video", type: FileType.Video },
  { dir: "audio", type: FileType.Audio },
  { dir: "doc", type: FileType.Document },
] as const;

const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>';

// ==========================================
// 认证中间件
// ==========================================

export const webdavAuth = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const env = c.env;

    // OPTIONS 用于能力发现（Windows/macOS 挂载前会先无凭据探测），无需认证
    if (c.req.method === "OPTIONS") {
      await next();
      return;
    }

    const authHeader = c.req.header("Authorization") ?? "";

    if (authHeader.startsWith("Basic ")) {
      const pass = extractBasicPassword(authHeader.slice(6));
      if (
        (env.PASSWORD && pass === env.PASSWORD) ||
        (env.API_TOKEN && pass === env.API_TOKEN)
      ) {
        await next();
        return;
      }
    } else if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      if (env.API_TOKEN && token === env.API_TOKEN) {
        await next();
        return;
      }
    } else {
      // 兼容浏览器已登录场景：Cookie 中的 JWT
      const authCookie = c.req
        .header("Cookie")
        ?.match(/(?:^|;\s*)auth=([^;]+)/)?.[1];
      if (authCookie) {
        try {
          await verifyJWT(
            authCookie,
            env.JWT_SECRET || env.PASSWORD || "secret"
          );
          await next();
          return;
        } catch {
          // fallthrough 到 401
        }
      }
    }

    if (!env.PASSWORD && !env.API_TOKEN) {
      return textResponse(
        503,
        "WebDAV disabled: neither PASSWORD nor API_TOKEN is configured"
      );
    }

    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
);

function extractBasicPassword(encoded: string): string {
  try {
    const bytes = Uint8Array.from(atob(encoded.trim()), (ch) =>
      ch.charCodeAt(0)
    );
    const decoded = new TextDecoder().decode(bytes);
    const idx = decoded.indexOf(":");
    return idx >= 0 ? decoded.slice(idx + 1) : decoded;
  } catch {
    return "";
  }
}

// ==========================================
// 路径解析
// ==========================================

type DavPath =
  | { kind: "root" }
  | { kind: "collection"; type: FileType; dir: string }
  | { kind: "file"; type: FileType; dir: string; fileName: string };

/** 从任意 URL / 路径解析出 WebDAV 资源，非法路径返回 null */
function parseDavTarget(target: string): DavPath | null {
  let pathname: string;
  try {
    pathname = target.startsWith("/") ? target : new URL(target).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(DAV_BASE)) return null;

  let segments: string[];
  try {
    segments = pathname
      .slice(DAV_BASE.length)
      .split("/")
      .filter((s) => s.length > 0)
      .map(decodeURIComponent);
  } catch {
    return null;
  }

  // 安全校验：拒绝路径穿越与控制字符
  for (const seg of segments) {
    if (
      seg === "." ||
      seg === ".." ||
      seg.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(seg)
    ) {
      return null;
    }
  }

  if (segments.length === 0) return { kind: "root" };

  const entry = TYPE_DIRS.find((d) => d.dir === segments[0]);
  if (!entry) return null;

  if (segments.length === 1) {
    return { kind: "collection", type: entry.type, dir: entry.dir };
  }
  if (segments.length === 2) {
    return {
      kind: "file",
      type: entry.type,
      dir: entry.dir,
      fileName: segments[1],
    };
  }
  return null; // 暂不支持嵌套目录
}

// ==========================================
// KV 查询辅助
// ==========================================

/** 分片是否已上传完整（未完成的上传不在 WebDAV 中可见） */
function isCompleteFile(md: FileMetadata | null | undefined): boolean {
  if (!md) return false;
  if (md.chunkInfo) {
    return (md.chunkInfo.uploadedIndices?.length ?? 0) >= md.chunkInfo.total;
  }
  return true;
}

/** 列出某类型下所有已完成文件（自动翻页） */
async function listFilesOfType(kv: any, type: FileType): Promise<FileItem[]> {
  const out: FileItem[] = [];
  let cursor: string | undefined;
  let guard = 0;
  do {
    const res = await kv.list({ prefix: `${type}:`, limit: 1000, cursor });
    for (const k of res.keys ?? []) {
      if (isCompleteFile(k.metadata)) {
        out.push({ name: k.name, metadata: k.metadata });
      }
    }
    cursor = res.list_complete ? undefined : res.cursor;
    guard += 1;
  } while (cursor && guard < 100);
  return out;
}

/** 仅在指定类型目录内按文件名精确查找（不做跨类型兜底），用于 MOVE/COPY 目标占位检查 */
async function findFileInType(
  kv: any,
  type: FileType,
  fileName: string
): Promise<{ key: string; metadata: FileMetadata } | null> {
  let cursor: string | undefined;
  let guard = 0;
  do {
    const res = await kv.list({ prefix: `${type}:`, limit: 1000, cursor });
    for (const k of res.keys ?? []) {
      if (k.metadata?.fileName === fileName && isCompleteFile(k.metadata)) {
        return { key: k.name, metadata: k.metadata as FileMetadata };
      }
    }
    cursor = res.list_complete ? undefined : res.cursor;
    guard += 1;
  } while (cursor && guard < 100);
  return null;
}

/** 按文件名查找文件：优先在指定类型中找，找不到则全局兜底（跨目录 MOVE 后仍可访问） */
async function findFileByName(
  kv: any,
  fileName: string,
  preferredType?: FileType
): Promise<{ key: string; metadata: FileMetadata } | null> {
  const allTypes = TYPE_DIRS.map((d) => d.type);
  const order = preferredType
    ? [preferredType, ...allTypes.filter((t) => t !== preferredType)]
    : allTypes;

  for (const type of order) {
    let cursor: string | undefined;
    let guard = 0;
    do {
      const res = await kv.list({ prefix: `${type}:`, limit: 1000, cursor });
      for (const k of res.keys ?? []) {
        if (k.metadata?.fileName === fileName && isCompleteFile(k.metadata)) {
          return { key: k.name, metadata: k.metadata as FileMetadata };
        }
      }
      cursor = res.list_complete ? undefined : res.cursor;
      guard += 1;
    } while (cursor && guard < 100);
  }
  return null;
}

// ==========================================
// XML 构建
// ==========================================

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function encodeHrefPath(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg === "" ? "" : encodeURIComponent(seg)))
    .join("/");
}

const LOCK_SUPPORT =
  "<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>";

function collectionResponse(href: string, displayName: string): string {
  return (
    `<D:response><D:href>${xmlEscape(encodeHrefPath(href))}</D:href>` +
    `<D:propstat><D:prop>` +
    `<D:displayname>${xmlEscape(displayName)}</D:displayname>` +
    `<D:resourcetype><D:collection/></D:resourcetype>` +
    `<D:getcontenttype>httpd/unix-directory</D:getcontenttype>` +
    `<D:getcontentlength>0</D:getcontentlength>` +
    `<D:getlastmodified>${new Date(0).toUTCString()}</D:getlastmodified>` +
    `<D:creationdate>1970-01-01T00:00:00.000Z</D:creationdate>` +
    LOCK_SUPPORT +
    `<D:lockdiscovery/>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

function fileResponse(href: string, item: FileItem): string {
  const md = item.metadata;
  return (
    `<D:response><D:href>${xmlEscape(encodeHrefPath(href))}</D:href>` +
    `<D:propstat><D:prop>` +
    `<D:displayname>${xmlEscape(md.fileName)}</D:displayname>` +
    `<D:resourcetype/>` +
    `<D:getcontentlength>${md.fileSize}</D:getcontentlength>` +
    `<D:getcontenttype>${xmlEscape(
      getContentTypeByExt(getFileExt(md.fileName))
    )}</D:getcontenttype>` +
    `<D:getlastmodified>${new Date(md.uploadedAt).toUTCString()}</D:getlastmodified>` +
    `<D:creationdate>${new Date(md.uploadedAt).toISOString()}</D:creationdate>` +
    `<D:getetag>"${xmlEscape(item.name)}"</D:getetag>` +
    LOCK_SUPPORT +
    `<D:lockdiscovery/>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

function multistatusResponse(responses: string[]): Response {
  const body = `${XML_HEADER}<D:multistatus xmlns:D="DAV:">${responses.join(
    ""
  )}</D:multistatus>`;
  return new Response(body, {
    status: 207,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Allow: DAV_ALLOW,
    },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

// ==========================================
// 流式读取辅助：按需精确读取 N 字节（处理读取过量保留问题）
// ==========================================

class ChunkReader {
  private queue: Uint8Array<ArrayBufferLike>[] = [];
  private queued = 0;

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async read(n: number): Promise<Uint8Array<ArrayBuffer>> {
    while (this.queued < n) {
      const { done, value } = await this.reader.read();
      if (done) break;
      this.queue.push(value);
      this.queued += value.byteLength;
    }
    const available = Math.min(this.queued, n);
    const out = new Uint8Array(available);
    let off = 0;
    while (off < available && this.queue.length > 0) {
      const head = this.queue[0];
      const take = Math.min(head.byteLength, available - off);
      out.set(head.subarray(0, take), off);
      off += take;
      this.queued -= take;
      if (take === head.byteLength) this.queue.shift();
      else this.queue[0] = head.subarray(take);
    }
    return out;
  }
}

// ==========================================
// 上传辅助
// ==========================================

function buildMetadata(
  fileName: string,
  fileSize: number,
  totalChunks?: number
): FileMetadata {
  return {
    fileName,
    fileSize,
    uploadedAt: Date.now(),
    liked: false,
    ...(totalChunks
      ? { chunkInfo: { total: totalChunks, uploadedIndices: [] } }
      : {}),
  };
}

/** 初始化分片上传记录（与 /upload/chunk/init 逻辑一致） */
async function initChunkedKey(
  kv: any,
  type: FileType,
  fileName: string,
  fileSize: number,
  totalChunks: number
): Promise<string> {
  const key = buildKeyId(
    type,
    `${chunkPrefix}${getUniqueFileId()}`,
    getFileExt(fileName)
  );
  await kv.put(key, "", {
    metadata: buildMetadata(fileName, fileSize, totalChunks),
    expirationTtl: TEMP_CHUNK_TTL,
  });
  return key;
}

interface PutResult {
  key: string;
}

/** 小文件直接上传 */
async function putSmall(
  c: Context<{ Bindings: Env }>,
  fileName: string,
  mime: string,
  buf: ArrayBuffer
): Promise<PutResult> {
  const db = DBAdapterFactory.getAdapter(c.env);
  const file = new File([buf], fileName, { type: mime });
  const metadata = buildMetadata(fileName, file.size);
  return db.uploadFile(file, metadata, (p) => c.executionCtx.waitUntil(p));
}

/**
 * 大文件分片上传：按 MAX_CHUNK_SIZE 切片，逐片同步等待落库
 * （不传 waitUntil，uploadChunk 会 await 完成，保证返回时文件已可读）
 */
async function putChunked(
  c: Context<{ Bindings: Env }>,
  type: FileType,
  fileName: string,
  mime: string,
  reader: ChunkReader,
  size: number
): Promise<PutResult> {
  const db = DBAdapterFactory.getAdapter(c.env);
  const kv = c.env.oh_file_url;
  const totalChunks = Math.ceil(size / MAX_CHUNK_SIZE);
  if (totalChunks > MAX_CHUNK_NUM) {
    throw new Error(`Too many chunks: ${totalChunks} > ${MAX_CHUNK_NUM}`);
  }

  const key = await initChunkedKey(kv, type, fileName, size, totalChunks);
  try {
    let received = 0;
    for (let i = 0; i < totalChunks; i++) {
      const target = Math.min(MAX_CHUNK_SIZE, size - i * MAX_CHUNK_SIZE);
      const part = await reader.read(target);
      received += part.byteLength;
      if (part.byteLength === 0) {
        throw new Error(`Unexpected EOF at chunk ${i}`);
      }
      await db.uploadChunk(key, i, new Blob([part], { type: mime }));
    }
    if (received !== size) {
      throw new Error(`Size mismatch: received ${received}, expected ${size}`);
    }
    return { key };
  } catch (e) {
    await kv.delete(key).catch(() => {});
    throw e;
  }
}

// ==========================================
// 各方法处理器
// ==========================================

function handleOptions(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      DAV: DAV_CLASS,
      Allow: DAV_ALLOW,
      "MS-Author-Via": "DAV",
      "Accept-Ranges": "bytes",
      "Content-Length": "0",
    },
  });
}

async function handlePropfind(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target) return textResponse(404, "Not Found");

  const depthHeader = (c.req.header("Depth") ?? "1").toLowerCase();
  const depth = depthHeader === "0" ? 0 : 1; // infinity 按 1 处理
  const kv = c.env.oh_file_url;
  const responses: string[] = [];

  if (target.kind === "root") {
    responses.push(collectionResponse(`${DAV_BASE}/`, "dav"));
    if (depth === 1) {
      for (const d of TYPE_DIRS) {
        responses.push(collectionResponse(`${DAV_BASE}/${d.dir}/`, d.dir));
      }
    }
  } else if (target.kind === "collection") {
    responses.push(
      collectionResponse(`${DAV_BASE}/${target.dir}/`, target.dir)
    );
    if (depth === 1) {
      const files = await listFilesOfType(kv, target.type);
      for (const f of files) {
        responses.push(
          fileResponse(`${DAV_BASE}/${target.dir}/${f.metadata.fileName}`, f)
        );
      }
    }
  } else {
    const found = await findFileByName(kv, target.fileName, target.type);
    if (!found) return textResponse(404, "Not Found");
    responses.push(
      fileResponse(`${DAV_BASE}/${target.dir}/${found.metadata.fileName}`, {
        name: found.key,
        metadata: found.metadata,
      })
    );
  }

  return multistatusResponse(responses);
}

async function handleGetHead(c: Context<{ Bindings: Env }>): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target) return textResponse(404, "Not Found");

  const kv = c.env.oh_file_url;
  const db = DBAdapterFactory.getAdapter(c.env);

  if (target.kind === "file") {
    const found = await findFileByName(kv, target.fileName, target.type);
    if (!found) return textResponse(404, "Not Found");

    const resp = await db.get(found.key, c.req.raw);
    const headers = new Headers(resp.headers);
    headers.set("ETag", `"${found.key}"`);
    headers.set(
      "Last-Modified",
      new Date(found.metadata.uploadedAt).toUTCString()
    );
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "private, no-store");
    return new Response(c.req.method === "HEAD" ? null : resp.body, {
      status: resp.status,
      headers,
    });
  }

  // 目录：返回简单 HTML 索引（便于浏览器快速验证）
  const parts: string[] = [];
  if (target.kind === "root") {
    for (const d of TYPE_DIRS) {
      parts.push(`<li><a href="${d.dir}/">${d.dir}/</a></li>`);
    }
  } else {
    const files = await listFilesOfType(kv, target.type);
    for (const f of files) {
      const href = encodeHrefPath(
        `${DAV_BASE}/${target.dir}/${f.metadata.fileName}`
      );
      parts.push(
        `<li><a href="${xmlEscape(href)}">${xmlEscape(
          f.metadata.fileName
        )}</a> (${f.metadata.fileSize} bytes)</li>`
      );
    }
  }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OtterHub WebDAV</title></head><body><h1>OtterHub WebDAV</h1><ul>${parts.join(
    ""
  )}</ul></body></html>`;
  return c.html(html);
}

async function handlePut(c: Context<{ Bindings: Env }>): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target || target.kind !== "file") {
    return textResponse(405, "PUT only supported on file paths");
  }
  const fileName = target.fileName;
  if (!fileName.trim() || fileName.length > MAX_FILENAME_LENGTH) {
    return textResponse(400, "Invalid file name");
  }

  const kv = c.env.oh_file_url;
  const db = DBAdapterFactory.getAdapter(c.env);

  // 覆盖语义：旧文件移入回收站
  const existing = await findFileByName(kv, fileName, target.type);
  if (existing) {
    await db.moveToTrash(existing.key);
    const origin = new URL(c.req.url).origin;
    c.executionCtx.waitUntil(
      deleteFileCache(origin, existing.key).catch(() => {})
    );
  }

  const mime = getContentTypeByExt(getFileExt(fileName));
  const clHeader = c.req.header("Content-Length");
  const contentLength = clHeader ? parseInt(clHeader, 10) : NaN;

  try {
    if (!c.req.raw.body) {
      // 空body（无流）：按0字节处理
      await putSmall(c, fileName, mime, new ArrayBuffer(0));
    } else if (!isNaN(contentLength)) {
      if (contentLength > MAX_FILE_SIZE) {
        return textResponse(507, "Insufficient Storage");
      }
      if (contentLength <= MAX_CHUNK_SIZE) {
        const buf = await c.req.raw.arrayBuffer();
        await putSmall(c, fileName, mime, buf);
      } else {
        const reader = new ChunkReader(c.req.raw.body.getReader());
        await putChunked(c, target.type, fileName, mime, reader, contentLength);
      }
    } else {
      // 未知长度：全部缓冲后再决定（WebDAV 客户端几乎都会带 Content-Length）
      const buf = await c.req.raw.arrayBuffer();
      if (buf.byteLength > MAX_FILE_SIZE) {
        return textResponse(507, "Insufficient Storage");
      }
      if (buf.byteLength <= MAX_CHUNK_SIZE) {
        await putSmall(c, fileName, mime, buf);
      } else {
        // 用内存块构造流式分片
        const parts: Uint8Array[] = [];
        let off = 0;
        while (off < buf.byteLength) {
          parts.push(
            new Uint8Array(
              buf,
              off,
              Math.min(MAX_CHUNK_SIZE, buf.byteLength - off)
            )
          );
          off += MAX_CHUNK_SIZE;
        }
        const stream = new ReadableStream({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        });
        const reader = new ChunkReader(stream.getReader());
        await putChunked(
          c,
          target.type,
          fileName,
          mime,
          reader,
          buf.byteLength
        );
      }
    }
    return emptyResponse(existing ? 204 : 201);
  } catch (e: any) {
    console.error("[WebDAV] PUT error:", e);
    return textResponse(500, `PUT failed: ${e?.message ?? e}`);
  }
}

async function handleDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target) return textResponse(404, "Not Found");
  if (target.kind !== "file") {
    return textResponse(405, "Collections cannot be deleted");
  }

  const kv = c.env.oh_file_url;
  const db = DBAdapterFactory.getAdapter(c.env);
  const found = await findFileByName(kv, target.fileName, target.type);
  if (!found) return textResponse(404, "Not Found");

  await db.moveToTrash(found.key);
  const origin = new URL(c.req.url).origin;
  c.executionCtx.waitUntil(deleteFileCache(origin, found.key).catch(() => {}));
  return emptyResponse(204);
}

function parseDestination(
  c: Context<{ Bindings: Env }>
): DavPath | null | "missing" {
  const dest = c.req.header("Destination");
  if (!dest) return "missing";
  return parseDavTarget(dest);
}

async function resolveMoveCopyContext(
  c: Context<{ Bindings: Env }>,
  target: DavPath & { kind: "file" }
): Promise<
  | { error: Response }
  | {
      src: { key: string; metadata: FileMetadata };
      dest: { type: FileType; dir: string; fileName: string };
      replacedExisting: boolean;
    }
> {
  const kv = c.env.oh_file_url;
  const db = DBAdapterFactory.getAdapter(c.env);

  const src = await findFileByName(kv, target.fileName, target.type);
  if (!src) return { error: textResponse(404, "Source Not Found") };

  const destParsed = parseDestination(c);
  if (destParsed === "missing") {
    return { error: textResponse(400, "Missing Destination header") };
  }
  if (!destParsed || destParsed.kind !== "file") {
    return { error: textResponse(400, "Invalid Destination") };
  }
  if (
    destParsed.fileName === target.fileName &&
    destParsed.type === target.type
  ) {
    return {
      error: textResponse(403, "Source and destination are the same resource"),
    };
  }

  const overwrite = (c.req.header("Overwrite") ?? "F").toUpperCase() === "T";
  // 目标占位检查必须精确限定在目标类型目录内：
  // 全局兜底解析会把“仍留在原类型目录下的源文件自身”误判为目标已存在，导致源文件被误删
  const destExisting = await findFileInType(
    kv,
    destParsed.type,
    destParsed.fileName
  );
  let replacedExisting = false;
  if (destExisting) {
    if (destExisting.key === src.key) {
      // 目标位置解析到的正是源文件自身（跨目录移动），直接重命名即可
      return {
        src,
        dest: destParsed,
        replacedExisting: false,
      };
    }
    if (!overwrite) {
      return {
        error: textResponse(412, "Destination exists and Overwrite is not T"),
      };
    }
    await db.moveToTrash(destExisting.key);
    const origin = new URL(c.req.url).origin;
    c.executionCtx.waitUntil(
      deleteFileCache(origin, destExisting.key).catch(() => {})
    );
    replacedExisting = true;
  }

  return {
    src,
    dest: destParsed,
    replacedExisting,
  };
}

/**
 * MOVE = 重命名（仅更新 metadata.fileName，KV key 与物理存储不变）
 * 跨类型目录移动时文件仍归属原类型，但可通过目标路径访问（全局兜底解析）
 */
async function handleMove(c: Context<{ Bindings: Env }>): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target || target.kind !== "file") {
    return textResponse(400, "MOVE only supported on file paths");
  }

  const ctx = await resolveMoveCopyContext(c, target);
  if ("error" in ctx) return ctx.error;

  const kv = c.env.oh_file_url;
  const { value, metadata } = await kv.getWithMetadata<FileMetadata>(
    ctx.src.key
  );
  metadata.fileName = ctx.dest.fileName;
  await kv.put(ctx.src.key, value, { metadata });

  return emptyResponse(ctx.replacedExisting ? 204 : 201);
}

/** COPY = 读取源文件内容后作为新文件上传 */
async function handleCopy(c: Context<{ Bindings: Env }>): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target || target.kind !== "file") {
    return textResponse(400, "COPY only supported on file paths");
  }

  const ctx = await resolveMoveCopyContext(c, target);
  if ("error" in ctx) return ctx.error;

  const db = DBAdapterFactory.getAdapter(c.env);
  const srcResp = await db.get(ctx.src.key);
  if (!srcResp.body || srcResp.status !== 200) {
    return textResponse(502, "Failed to read source file");
  }

  const size = ctx.src.metadata.fileSize;
  const mime =
    srcResp.headers.get("Content-Type") ??
    getContentTypeByExt(getFileExt(ctx.dest.fileName));

  try {
    if (size <= MAX_CHUNK_SIZE) {
      const buf = await srcResp.arrayBuffer();
      await putSmall(c, ctx.dest.fileName, mime, buf);
    } else {
      const reader = new ChunkReader(srcResp.body.getReader());
      await putChunked(c, ctx.dest.type, ctx.dest.fileName, mime, reader, size);
    }
    return emptyResponse(ctx.replacedExisting ? 204 : 201);
  } catch (e: any) {
    console.error("[WebDAV] COPY error:", e);
    return textResponse(500, `COPY failed: ${e?.message ?? e}`);
  }
}

function handleMkcol(): Response {
  return textResponse(
    405,
    "Collections are virtual (img, video, audio, doc) and cannot be created"
  );
}

async function handleProppatch(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target) return textResponse(404, "Not Found");

  // 回显请求中的属性并全部标记为成功（属性不持久化）
  const body = await c.req.text().catch(() => "");
  const propMatch = body.match(
    /<(?:[A-Za-z0-9_.-]+:)?prop[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?prop>/
  );
  const propsXml = propMatch?.[1] ?? "";

  const href =
    target.kind === "root"
      ? `${DAV_BASE}/`
      : target.kind === "collection"
        ? `${DAV_BASE}/${target.dir}/`
        : `${DAV_BASE}/${target.dir}/${encodeHrefPath(target.fileName)}`;

  const xml =
    `${XML_HEADER}<D:multistatus xmlns:D="DAV:">` +
    `<D:response><D:href>${xmlEscape(href)}</D:href>` +
    `<D:propstat><D:prop>${propsXml}</D:prop>` +
    `<D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
    `</D:response></D:multistatus>`;
  return new Response(xml, {
    status: 207,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

function handleLock(c: Context<{ Bindings: Env }>): Response {
  const target = parseDavTarget(c.req.url);
  if (!target) return textResponse(404, "Not Found");

  const token = `opaquelocktoken:${crypto.randomUUID()}`;
  const timeout = c.req.header("Timeout") ?? "Second-3600";

  const xml =
    `${XML_HEADER}<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
    `<D:locktype><D:write/></D:locktype>` +
    `<D:lockscope><D:exclusive/></D:lockscope>` +
    `<D:depth>infinity</D:depth>` +
    `<D:timeout>${xmlEscape(timeout)}</D:timeout>` +
    `<D:locktoken><D:href>${token}</D:href></D:locktoken>` +
    `</D:activelock></D:lockdiscovery></D:prop>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Lock-Token": `<${token}>`,
    },
  });
}

function handleUnlock(): Response {
  return emptyResponse(204);
}

function methodNotAllowed(): Response {
  return textResponse(405, "Method Not Allowed");
}

// ==========================================
// 分发与路由注册
// ==========================================

async function davHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    switch (c.req.method) {
      case "OPTIONS":
        return handleOptions();
      case "PROPFIND":
        return await handlePropfind(c);
      case "PROPPATCH":
        return await handleProppatch(c);
      case "MKCOL":
        return handleMkcol();
      case "GET":
      case "HEAD":
        return await handleGetHead(c);
      case "PUT":
        return await handlePut(c);
      case "DELETE":
        return await handleDelete(c);
      case "MOVE":
        return await handleMove(c);
      case "COPY":
        return await handleCopy(c);
      case "LOCK":
        return handleLock(c);
      case "UNLOCK":
        return handleUnlock();
      default:
        return methodNotAllowed();
    }
  } catch (e: any) {
    console.error("[WebDAV] Unhandled error:", e);
    return textResponse(500, `WebDAV error: ${e?.message ?? e}`);
  }
}

const DAV_METHODS = [
  "OPTIONS",
  "PROPFIND",
  "PROPPATCH",
  "MKCOL",
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "MOVE",
  "COPY",
  "LOCK",
  "UNLOCK",
] as const;

export const webdavRoutes = new Hono<{ Bindings: Env }>();

webdavRoutes.use("*", webdavAuth);

for (const method of DAV_METHODS) {
  webdavRoutes.on(method, "/", davHandler);
  webdavRoutes.on(method, "/*", davHandler);
}
