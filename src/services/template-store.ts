import { Redis } from "@upstash/redis";
import type { Template } from "../types.js";

const TEMPLATE_PREFIX = "template:";
const TEMPLATE_INDEX_KEY = "templates:index";

function getRedis(): Redis {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("Missing KV_REST_API_URL or KV_REST_API_TOKEN environment variables");
  }
  return new Redis({ url, token });
}

export async function saveTemplate(template: Template): Promise<void> {
  const redis = getRedis();
  const key = `${TEMPLATE_PREFIX}${template.name}`;
  await redis.set(key, JSON.stringify(template));
  await redis.sadd(TEMPLATE_INDEX_KEY, template.name);
}

export async function getTemplate(name: string): Promise<Template | null> {
  const redis = getRedis();
  const key = `${TEMPLATE_PREFIX}${name}`;
  const data = await redis.get<string>(key);
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data as unknown as Template;
}

export async function listTemplates(): Promise<Template[]> {
  const redis = getRedis();
  const names = await redis.smembers(TEMPLATE_INDEX_KEY);
  if (!names.length) return [];

  const templates: Template[] = [];
  for (const name of names) {
    const template = await getTemplate(name);
    if (template) templates.push(template);
  }
  return templates;
}

export async function deleteTemplate(name: string): Promise<boolean> {
  const redis = getRedis();
  const key = `${TEMPLATE_PREFIX}${name}`;
  const deleted = await redis.del(key);
  await redis.srem(TEMPLATE_INDEX_KEY, name);
  return deleted > 0;
}
