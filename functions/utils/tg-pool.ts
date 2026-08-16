// functions/utils/tg-pool.ts
// 多 Bot/多频道池化：分摊 Telegram API 流控（同 bot 同 chat 约 1 msg/s）
//
// 配置格式（环境变量 TG_BOT_POOLS，JSON 数组，可选）：
//   [{"token":"111:AAA","chatId":"-100xxx"},{"token":"222:BBB","chatId":"-100yyy"}]
// 也支持简化写法（用 | 分隔，顺序 token|chatId，多项用逗号或换行）：
//   TG_BOT_POOLS=111:AAA|-100xxx,222:BBB|-100yyy
// 未配置时回退为单槽位池 [{token: TG_BOT_TOKEN, chatId: TG_CHAT_ID}]，行为与旧版完全一致。
//
// 关键约束：Telegram 的 file_id 与 bot 绑定——哪个 bot 上传的文件，
// 只能用该 bot 的 token 调 getFile / 下载。因此：
// - 上传时把所用槽位写入 FileMetadata.tgSlot（单文件）/ Chunk.slot（分片）
// - 下载时按记录的槽位取 token；旧数据无记录 → 槽位 0（主 bot）

import { getTextFromCache, putTextToCache } from "@utils/cache";
import { getTgFilePath } from "@utils/db-adapter/tg-tools";

export type TgBotSlot = {
  token: string;
  chatId: string;
};

const PATH_CACHE_NAMESPACE = "tgpath";
const PATH_CACHE_TTL = 3300; // Telegram file_path 有效期 1 小时，缓存 55 分钟

/** 解析 TG_BOT_POOLS 配置，回退单槽位（TG_BOT_TOKEN/TG_CHAT_ID） */
export function getTgPool(env: any): TgBotSlot[] {
  const raw = env?.TG_BOT_POOLS;
  const pool: TgBotSlot[] = [];

  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const slot = normalizeSlot(item);
          if (slot) pool.push(slot);
        }
      }
    } catch {
      // 简化格式：token|chatId,token|chatId（逗号或换行分隔）
      for (const part of raw.split(/[,\n]/)) {
        const seg = part.trim();
        if (!seg) continue;
        const [token, chatId] = seg.split("|").map((s) => s?.trim());
        if (token && chatId) pool.push({ token, chatId });
      }
    }
  }

  if (pool.length === 0) {
    const token = env?.TG_BOT_TOKEN;
    const chatId = env?.TG_CHAT_ID;
    if (token && chatId) {
      pool.push({ token: String(token), chatId: String(chatId) });
    }
  }

  return pool;
}

function normalizeSlot(item: any): TgBotSlot | null {
  if (!item || typeof item !== "object") return null;
  const token = typeof item.token === "string" ? item.token.trim() : "";
  const chatId =
    typeof item.chatId === "string" || typeof item.chatId === "number"
      ? String(item.chatId).trim()
      : "";
  if (!token || !chatId) return null;
  return { token, chatId };
}

/** 取指定槽位，越界回退槽位 0 */
export function getTgSlot(env: any, index?: number): TgBotSlot | null {
  const pool = getTgPool(env);
  if (!pool.length) return null;
  const idx = normalizeIndex(index, pool.length);
  return pool[idx];
}

function normalizeIndex(index: number | undefined, size: number): number {
  if (!Number.isInteger(index) || index! < 0) return 0;
  return index! % size;
}

/**
 * 上传槽位选择（单文件/小文件路径）：
 * 秒级时间片轮询。Worker 无实例状态，这是零 KV 写入的均匀分摊方式，
 * 相邻秒的请求必然落到不同槽位。
 */
export function pickTgSlotIndex(poolSize: number): number {
  if (poolSize <= 1) return 0;
  return Math.floor(Date.now() / 1000) % poolSize;
}

/**
 * 分片上传槽位选择：
 * 同一文件内按分片序号轮询（0→bot0, 1→bot1, ...），分摊效果最均匀。
 */
export function pickChunkSlotIndex(
  poolSize: number,
  chunkIndex: number
): number {
  if (poolSize <= 1) return 0;
  return chunkIndex % poolSize;
}

/**
 * 解析 Telegram 文件路径（getFile），带缓存并支持跨槽位探测。
 *
 * - 优先尝试 preferSlot（文件元数据记录的上传槽位）
 * - preferSlot 失败（旧数据 / 记录缺失）时按顺序遍历其余槽位
 * - 成功结果缓存为 "slot|filePath"（旧格式纯 filePath 视为槽位 0）
 *
 * @returns { filePath, slot } 或 null
 */
export async function resolveTgFilePath(
  env: any,
  fileId: string,
  opts: { preferSlot?: number; forceRefresh?: boolean } = {}
): Promise<{ filePath: string; slot: number } | null> {
  const pool = getTgPool(env);
  if (!pool.length) return null;

  const preferSlot = normalizeIndex(opts.preferSlot, pool.length);

  // 1. 缓存命中（forceRefresh 时跳过）
  if (!opts.forceRefresh) {
    try {
      const cached = await getTextFromCache(PATH_CACHE_NAMESPACE, fileId);
      if (cached) {
        const parsed = parsePathCache(cached, pool.length);
        if (parsed) return parsed;
      }
    } catch (error) {
      console.warn(`[tg-pool] Cache read failed for ${fileId}`, error);
    }
  }

  // 2. 依次尝试槽位：preferSlot 优先，其余按顺序
  const order = [
    preferSlot,
    ...pool.map((_, i) => i).filter((i) => i !== preferSlot),
  ];
  for (const slotIndex of order) {
    const filePath = await getTgFilePath(fileId, pool[slotIndex].token);
    if (filePath) {
      try {
        await putTextToCache(
          PATH_CACHE_NAMESPACE,
          fileId,
          `${slotIndex}|${filePath}`,
          PATH_CACHE_TTL
        );
      } catch (error) {
        console.warn(`[tg-pool] Cache write failed for ${fileId}`, error);
      }
      return { filePath, slot: slotIndex };
    }
  }

  return null;
}

/** 解析缓存值："slot|filePath" 新格式 / 纯 filePath 旧格式（槽位 0） */
function parsePathCache(
  cached: string,
  poolSize: number
): { filePath: string; slot: number } | null {
  const sep = cached.indexOf("|");
  if (sep > 0) {
    const slot = Number(cached.slice(0, sep));
    if (Number.isInteger(slot) && slot >= 0 && slot < poolSize) {
      return { slot, filePath: cached.slice(sep + 1) };
    }
    return null; // 槽位越界（池规模缩小过）：视为未命中，重新探测
  }
  // 旧格式缓存：历史文件必属主 bot（槽位 0）
  return { slot: 0, filePath: cached };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
