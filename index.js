import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { TRACE_KEY, createTraceReducer } from './trace.js';

export const name = 'decision-trace';
export const inject = ['sessionProjections'];

export const Config = Schema.object({
  maxEntries: Schema.number().min(100).max(2000).step(1).default(800)
    .description('Maximum recent activity entries retained per session.'),
  maxDetailChars: Schema.number().min(1000).max(24000).step(1).default(12000)
    .description('Maximum characters per public text, tool input, or tool output preview.'),
});

const entrySchema = z.object({
  id: z.string(), seq: z.number().int(), time: z.number(),
  turn: z.number().int(), step: z.number().int(),
  kind: z.enum(['task', 'update', 'tool', 'outcome']),
  title: z.string(), text: z.string(), callId: z.string(), name: z.string(),
  input: z.string(), output: z.string(), status: z.string(),
  durationMs: z.number().nonnegative().nullable(),
  truncated: z.boolean(), resultSeq: z.number().int().nullable(),
});

export const traceSchema = z.object({
  sessionId: z.string(), turn: z.number().int(), step: z.number().int(),
  status: z.string(), model: z.string(), entries: z.array(entrySchema),
  dropped: z.number().int().nonnegative(), totalTools: z.number().int().nonnegative(),
  totalUpdates: z.number().int().nonnegative(), totalErrors: z.number().int().nonnegative(),
  limits: z.object({ maxEntries: z.number().int().positive(), maxDetailChars: z.number().int().positive() }),
});

// The registry owns replay, checkpointing, change publication, and disposal.
// No model hooks, prompts, raw reasoning streams, or additional session events.
export async function apply(ctx, config) {
  const reducer = createTraceReducer(config);
  const handle = await ctx.sessionProjections.register({
    key: TRACE_KEY,
    stateVersion: 1,
    stateSchema: traceSchema,
    init: reducer.init,
    apply: reducer.apply,
    wire: { summary: false, viewSchema: traceSchema, view: state => state },
  });
  ctx.effect(() => () => handle.dispose());
}
