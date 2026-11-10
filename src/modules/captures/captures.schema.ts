import { z } from 'zod';

export const MAX_CAPTURE_ITEMS = 50;

// Postgres text cannot store U+0000; a body can carry it as the JSON escape \u0000, so it is refused here with a 400
// instead of surfacing as a 500 from the insert.
const noNul = (value: string) => !value.includes('\u0000');
const NUL_MESSAGE = 'Must not contain NUL characters';

export const captureItemSchema = z.object({
  package: z.string().min(1, 'package is required').max(150).refine(noNul, NUL_MESSAGE),
  title: z.string().max(300).refine(noNul, NUL_MESSAGE).nullish(),
  text: z.string().min(1, 'text is required').max(2000).refine(noNul, NUL_MESSAGE),
  // ISO 8601 with a zone ("2026-11-09T14:03:21.000Z" or "...-03:00"): a local time without zone is ambiguous.
  postedAt: z.string().datetime({ offset: true }),
});

export const createCapturesSchema = z.object({
  items: z.array(captureItemSchema).min(1, 'At least one item').max(MAX_CAPTURE_ITEMS, `At most ${MAX_CAPTURE_ITEMS} items`),
});

export type CaptureItemInput = z.infer<typeof captureItemSchema>;
export type CreateCapturesInput = z.infer<typeof createCapturesSchema>;
