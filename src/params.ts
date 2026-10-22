import { z } from 'zod';
import { ApiError } from './errors.js';

export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * Cloudinary-style crop modes, mapped to sharp's `fit`:
 *   fit   – scale to fit inside the box, keep aspect ratio (default)
 *   fill  – cover the box exactly, cropping the overflow (centre)
 *   scale – stretch to the exact box, ignoring aspect ratio
 *   pad   – fit inside the box, pad the rest
 */
export const CROP_MODES = ['fit', 'fill', 'scale', 'pad'] as const;
export type CropMode = (typeof CROP_MODES)[number];

export interface ProcessParams {
  url: string;
  width?: number;
  height?: number;
  format?: OutputFormat;
  quality?: number;
  crop: CropMode;
}

const intParam = (name: string, min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, `${name} must be a whole number`)
    .transform(Number)
    .pipe(z.number().min(min, `${name} must be at least ${min}`).max(max, `${name} must be at most ${max}`));

export function processParamsSchema(maxDimension: number) {
  return z
    .object({
      url: z.string({ error: 'url is required' }).min(1, 'url is required'),
      width: intParam('width', 1, maxDimension).optional(),
      height: intParam('height', 1, maxDimension).optional(),
      format: z
        .string()
        .toLowerCase()
        .transform((f) => (f === 'jpg' ? 'jpeg' : f))
        .pipe(z.enum(OUTPUT_FORMATS, { error: `format must be one of: ${OUTPUT_FORMATS.join(', ')}` }))
        .optional(),
      quality: intParam('quality', 1, 100).optional(),
      crop: z.enum(CROP_MODES, { error: `crop must be one of: ${CROP_MODES.join(', ')}` }).optional(),
    })
    .strict() // unknown params are almost always typos; say so instead of ignoring them
    .superRefine((p, ctx) => {
      if (p.crop && p.width === undefined && p.height === undefined) {
        ctx.addIssue({ code: 'custom', path: ['crop'], message: 'crop requires width and/or height' });
      }
    })
    .transform((p): ProcessParams => ({ ...p, crop: p.crop ?? 'fit' }));
}

export function parseProcessParams(query: unknown, maxDimension: number): ProcessParams {
  const result = processParamsSchema(maxDimension).safeParse(query);
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => ({
    param: issue.code === 'unrecognized_keys' ? issue.keys.join(', ') : issue.path.join('.') || null,
    message: issue.code === 'unrecognized_keys' ? `Unknown parameter(s): ${issue.keys.join(', ')}` : issue.message,
  }));
  throw new ApiError('INVALID_PARAMS', details.map((d) => d.message).join('; '), details);
}

/** Stable cache key: same transformation => same key regardless of query-string order. */
export function cacheKey(p: ProcessParams): string {
  return JSON.stringify([p.url, p.width ?? null, p.height ?? null, p.format ?? null, p.quality ?? null, p.crop]);
}
