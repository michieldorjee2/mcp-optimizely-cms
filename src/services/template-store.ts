import type { Template } from "../types.js";

// In-memory fallback store (used when Redis is not configured)
const memoryStore = new Map<string, Template>();

// Try to use Upstash Redis if configured, otherwise fall back to in-memory
function hasRedis(): boolean {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function getRedis() {
  const { Redis } = await import("@upstash/redis");
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  });
}

export async function saveTemplate(template: Template): Promise<void> {
  if (hasRedis()) {
    const redis = await getRedis();
    await redis.set(`template:${template.name}`, JSON.stringify(template));
    await redis.sadd("templates:index", template.name);
  } else {
    memoryStore.set(template.name, template);
  }
}

export async function getTemplate(name: string): Promise<Template | null> {
  if (hasRedis()) {
    const redis = await getRedis();
    const data = await redis.get<string>(`template:${name}`);
    if (!data) return null;
    return typeof data === "string" ? JSON.parse(data) : data as unknown as Template;
  } else {
    return memoryStore.get(name) || null;
  }
}

export async function listTemplates(): Promise<Template[]> {
  if (hasRedis()) {
    const redis = await getRedis();
    const names = await redis.smembers("templates:index");
    if (!names.length) return [];
    const templates: Template[] = [];
    for (const name of names) {
      const template = await getTemplate(name);
      if (template) templates.push(template);
    }
    return templates;
  } else {
    return Array.from(memoryStore.values());
  }
}

export async function deleteTemplate(name: string): Promise<boolean> {
  if (hasRedis()) {
    const redis = await getRedis();
    const deleted = await redis.del(`template:${name}`);
    await redis.srem("templates:index", name);
    return deleted > 0;
  } else {
    return memoryStore.delete(name);
  }
}
