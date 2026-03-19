import { z } from "zod";
import { listTemplates as listTemplatesFromStore } from "../services/template-store";

export const listTemplatesSchema = z.object({
  filter: z.string().optional().describe("Optional filter string to match template names"),
});

export type ListTemplatesInput = z.infer<typeof listTemplatesSchema>;

export async function listTemplatesHandler(input: ListTemplatesInput) {
  const templates = await listTemplatesFromStore();

  const filtered = input.filter
    ? templates.filter((t) => t.name.toLowerCase().includes(input.filter!.toLowerCase()))
    : templates;

  return {
    success: true,
    count: filtered.length,
    templates: filtered.map((t) => ({
      name: t.name,
      contentType: t.contentType,
      fieldCount: t.fields.length,
      fields: t.fields,
      createdAt: t.createdAt,
    })),
  };
}
