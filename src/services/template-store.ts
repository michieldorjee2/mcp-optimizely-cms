import { Redis } from "@upstash/redis";
import type { Template } from "../types";

const TEMPLATE_PREFIX = "template:";
const TEMPLATE_INDEX_KEY = "templates:index";

// In-memory fallback used when Redis env vars are not configured.
// Note: in-memory templates are NOT persisted across cold starts.
const inMemoryTemplates = new Map<string, Template>();

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function saveTemplate(template: Template): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.set(`${TEMPLATE_PREFIX}${template.name}`, JSON.stringify(template));
    await redis.sadd(TEMPLATE_INDEX_KEY, template.name);
  } else {
    inMemoryTemplates.set(template.name, template);
  }
}

export async function getTemplate(name: string): Promise<Template | null> {
  const redis = getRedis();
  if (redis) {
    const data = await redis.get<string>(`${TEMPLATE_PREFIX}${name}`);
    if (!data) return null;
    return typeof data === "string" ? (JSON.parse(data) as Template) : (data as unknown as Template);
  } else {
    return inMemoryTemplates.get(name) ?? null;
  }
}

export async function listTemplates(): Promise<Template[]> {
  const redis = getRedis();
  if (redis) {
    const names = await redis.smembers(TEMPLATE_INDEX_KEY);
    if (!names.length) return [];
    const templates: Template[] = [];
    for (const name of names) {
      const t = await getTemplate(name);
      if (t) templates.push(t);
    }
    return templates;
  } else {
    return Array.from(inMemoryTemplates.values());
  }
}

export async function deleteTemplate(name: string): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    const deleted = await redis.del(`${TEMPLATE_PREFIX}${name}`);
    await redis.srem(TEMPLATE_INDEX_KEY, name);
    return deleted > 0;
  } else {
    return inMemoryTemplates.delete(name);
  }
}
