import sharp, { type FitEnum, type Metadata, type SharpOptions } from 'sharp';
import { ApiError } from './errors.js';
import type { CropMode, OutputFormat, ProcessParams } from './params.js';

// SVG is deliberately excluded: it is a document format (scripts, external refs), not a bitmap.
// sharp reports AVIF/HEIC input as "heif".
const SUPPORTED_INPUT = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff']);
const LOSSY = new Set<OutputFormat>(['jpeg', 'webp', 'avif']);

const FIT: Record<CropMode, keyof FitEnum> = {
  fit: 'inside',
  fill: 'cover',
  scale: 'fill',
  pad: 'contain',
};

export interface ImageInfo {
  format: string;
  width: number;
  height: number;
  bytes: number;
}

export interface TransformResult {
  data: Buffer;
  output: ImageInfo;
  source: ImageInfo;
}

export async function transformImage(
  input: Buffer,
  params: Omit<ProcessParams, 'url'>,
  limits: { maxInputPixels: number },
): Promise<TransformResult> {
  const opts: SharpOptions = { limitInputPixels: limits.maxInputPixels, failOn: 'error' };

  let meta: Metadata;
  try {
    meta = await sharp(input, opts).metadata();
  } catch {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Source is not a recognised image');
  }
  if (!meta.format || !SUPPORTED_INPUT.has(meta.format)) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', `Source format "${meta.format ?? 'unknown'}" is not supported`, {
      supported: [...SUPPORTED_INPUT],
    });
  }
  if ((meta.width ?? 0) * (meta.height ?? 0) > limits.maxInputPixels) {
    throw new ApiError('SOURCE_TOO_LARGE', `Source is ${meta.width}x${meta.height}; max is ${limits.maxInputPixels} pixels`);
  }

  const outFormat: OutputFormat = params.format ?? defaultOutputFormat(meta.format);
  let img = sharp(input, opts).rotate(); // honour EXIF orientation

  if (params.width !== undefined || params.height !== undefined) {
    img = img.resize({
      width: params.width,
      height: params.height,
      fit: FIT[params.crop],
      background: { r: 255, g: 255, b: 255, alpha: outFormat === 'jpeg' ? 1 : 0 },
    });
  }
  if (outFormat === 'jpeg' && meta.hasAlpha) img = img.flatten({ background: '#ffffff' });

  img = img.toFormat(outFormat, LOSSY.has(outFormat) && params.quality ? { quality: params.quality } : {});

  try {
    const { data, info } = await img.timeout({ seconds: 10 }).toBuffer({ resolveWithObject: true });
    return {
      data,
      output: { format: outFormat, width: info.width, height: info.height, bytes: data.length },
      source: { format: meta.format === 'heif' ? 'avif' : meta.format, width: meta.width ?? 0, height: meta.height ?? 0, bytes: input.length },
    };
  } catch (err) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', `Image could not be processed: ${(err as Error).message}`);
  }
}

function defaultOutputFormat(input: string): OutputFormat {
  if (input === 'jpeg' || input === 'png' || input === 'webp') return input;
  if (input === 'heif' || input === 'avif') return 'avif';
  return 'png'; // gif, tiff
}

export const MIME: Record<OutputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};
