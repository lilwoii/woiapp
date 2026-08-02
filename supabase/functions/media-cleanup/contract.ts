import { HttpError } from "../_shared/http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_PATH = /^(?:quarantine|published)\/[A-Za-z0-9/_-]+\.(?:jpg|jpeg|png|webp)$/;

export type CleanupBatch = {
  batchId: string;
  paths: string[];
};

export function parseCleanupBatch(value: unknown): CleanupBatch {
  if (!value || typeof value !== "object") {
    throw new HttpError(502, "INVALID_MEDIA_CLEANUP_MANIFEST");
  }
  const record = value as Record<string, unknown>;
  if (!UUID.test(String(record.batch_id ?? "")) || !Array.isArray(record.storage_paths)) {
    throw new HttpError(502, "INVALID_MEDIA_CLEANUP_MANIFEST");
  }
  const paths = record.storage_paths;
  if (
    paths.length > 500 ||
    paths.some((path) => typeof path !== "string" || path.length > 512 || !STORAGE_PATH.test(path)) ||
    new Set(paths).size !== paths.length
  ) {
    throw new HttpError(502, "INVALID_MEDIA_CLEANUP_MANIFEST");
  }
  return { batchId: record.batch_id as string, paths: paths as string[] };
}

export function parseLegacyCleanupPaths(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const paths = (value as Record<string, unknown>).storage_paths;
  if (!Array.isArray(paths) || paths.length > 500) {
    throw new HttpError(502, "INVALID_MEDIA_CLEANUP_MANIFEST");
  }
  if (
    paths.some((path) => typeof path !== "string" || path.length > 512 || !STORAGE_PATH.test(path)) ||
    new Set(paths).size !== paths.length
  ) {
    throw new HttpError(502, "INVALID_MEDIA_CLEANUP_MANIFEST");
  }
  return paths as string[];
}

export function chunkPaths(paths: string[], size = 100): string[][] {
  const chunks: string[][] = [];
  for (let offset = 0; offset < paths.length; offset += size) {
    chunks.push(paths.slice(offset, offset + size));
  }
  return chunks;
}
