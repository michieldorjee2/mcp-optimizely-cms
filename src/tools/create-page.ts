import { z } from "zod";
import { createContent } from "../services/cms-api.js";
import { getTemplate } from "../services/template-store.js";
import { createTemplate } from "./create-template.js";
import type { Template, TemplateProperty } from "../types.js";

export const createPageSchema = z.object({
  contentType: z.string().describe("The content type key (e.g. 'CompetitorComparisonPage')"),
  name: z.string().describe("Display name for the page"),
  locale: z.string().default("en").describe("Content locale (default: 'en')"),
  parentId: z.string().optional().describe("Parent container content ID"),
  status: z.string().default("draft").describe("Content status: 'draft' or 'published'"),
  routeSegment: z.string().optional().describe("URL route segment for the page"),
  properties: z.record(z.unknown()).default({}).describe("Key-value map of content properties"),
});

export type CreatePageInput = z.infer<typeof createPageSchema>;

// ---------------------------------------------------------------------------
// Deep validation — checks required, enums, array bounds, string lengths
// ---------------------------------------------------------------------------

interface ValidationError {
  key: string;
  message: string;
}

function validateProperties(
  properties: Record<string, unknown>,
  templateProps: TemplateProperty[]
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const prop of templateProps) {
    const value = properties[prop.key];

    // Required check
    if (prop.required && (value === undefined || value === null)) {
      errors.push({ key: prop.key, message: `Required property '${prop.key}' is missing.` });
      continue; // skip further checks if missing
    }

    // Skip further validation if not provided and not required
    if (value === undefined || value === null) continue;

    // Enum validation
    if (prop.enumValues && prop.enumValues.length > 0) {
      const strVal = String(value);
      if (!prop.enumValues.includes(strVal)) {
        errors.push({
          key: prop.key,
          message: `'${prop.key}' value '${strVal}' is not allowed. Must be one of: ${prop.enumValues.join(", ")}`,
        });
      }
    }

    // Array constraints
    if (Array.isArray(value)) {
      if (prop.minItems != null && value.length < prop.minItems) {
        errors.push({
          key: prop.key,
          message: `'${prop.key}' has ${value.length} items but requires at least ${prop.minItems}.`,
        });
      }
      if (prop.maxItems != null && value.length > prop.maxItems) {
        errors.push({
          key: prop.key,
          message: `'${prop.key}' has ${value.length} items but allows at most ${prop.maxItems}.`,
        });
      }
    }

    // String constraints
    if (typeof value === "string") {
      if (prop.minLength != null && value.length < prop.minLength) {
        errors.push({
          key: prop.key,
          message: `'${prop.key}' is ${value.length} chars but requires at least ${prop.minLength}.`,
        });
      }
      if (prop.maxLength != null && value.length > prop.maxLength) {
        errors.push({
          key: prop.key,
          message: `'${prop.key}' is ${value.length} chars but allows at most ${prop.maxLength}.`,
        });
      }
      if (prop.pattern) {
        try {
          const re = new RegExp(prop.pattern);
          if (!re.test(value)) {
            errors.push({
              key: prop.key,
              message: `'${prop.key}' does not match required pattern: ${prop.pattern}`,
            });
          }
        } catch { /* skip invalid regex */ }
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Main create_page handler
// ---------------------------------------------------------------------------

export async function createPage(
  input: CreatePageInput,
  clientId: string,
  clientSecret: string,
  graphKey?: string
) {
  // Try to load existing template, or auto-create one from CMS content type API
  let template: Template | null = await getTemplate(input.contentType).catch(() => null);

  if (!template && graphKey) {
    try {
      const result = await createTemplate(
        { contentTypeName: input.contentType, force: false },
        graphKey,
        clientId,
        clientSecret
      );
      if (result.success) {
        template = await getTemplate(input.contentType).catch(() => null);
      }
    } catch {
      // If auto-introspection fails, proceed without template
    }
  }

  // Validate against template
  if (template) {
    const errors = validateProperties(input.properties, template.properties);
    if (errors.length > 0) {
      return {
        success: false,
        error: `Validation failed for ${input.contentType}: ${errors.map((e) => e.message).join("; ")}`,
        validationErrors: errors,
        template: template.properties,
      };
    }
  }

  const body = {
    contentType: input.contentType,
    displayName: input.name,
    locale: input.locale,
    status: input.status || "draft",
    ...(input.parentId && { container: input.parentId }),
    ...(input.routeSegment && { routeSegment: input.routeSegment }),
    ...(Object.keys(input.properties).length > 0 && { properties: input.properties }),
  };

  const result = await createContent(clientId, clientSecret, body);
  return {
    success: true,
    contentId: result.key,
    displayName: result.displayName,
    contentType: result.contentType,
    status: result.status,
    ...(template ? { templateUsed: true } : {}),
  };
}
