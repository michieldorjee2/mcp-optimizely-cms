import type { Template } from "../types.js";
import { kvCreds } from "./env.js";

// In-memory fallback store (used when Redis is not configured)
const memoryStore = new Map<string, Template>();

function hasRedis(): boolean {
  return kvCreds() !== null;
}

async function getRedis() {
  const creds = kvCreds();
  if (!creds) throw new Error("KV credentials not configured");
  const { Redis } = await import("@upstash/redis");
  return new Redis({ url: creds.url, token: creds.token });
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
