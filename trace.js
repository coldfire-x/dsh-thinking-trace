// A public activity projection, not a reasoning or decision inference engine.
// Only the fields explicitly selected below may cross into this JSON state.
export const TRACE_KEY = 'decisionTrace';

const DEFAULT_LIMITS = Object.freeze({ maxEntries: 800, maxDetailChars: 12000 });
// Bound republished snapshots as well as individual fields. A single newest
// row is retained even when it alone exceeds this aggregate string budget.
const MAX_RETAINED_CHARS = 750000;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function string(value) {
  return typeof value === 'string' ? value : '';
}

function index(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function privateChannel(value) {
  if (!record(value) || typeof value.channel !== 'string') return false;
  return ['analysis', 'reasoning', 'thinking'].includes(value.channel.toLowerCase());
}

function publicText(event, data, message) {
  if (privateChannel(event) || privateChannel(data) || privateChannel(message)) return '';
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(block => record(block) && block.type === 'text'
      && typeof block.text === 'string' && !privateChannel(block))
    .map(block => block.text)
    .join('\n');
}

function detail(value, limit) {
  if (value.length <= limit) return { value, truncated: false };
  if (limit === 0) return { value: '', truncated: true };
  // Stay within the UTF-16 length limit without leaving half a surrogate pair.
  let end = limit - 1;
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
  return { value: `${value.slice(0, end)}…`, truncated: true };
}

function entry(state, event, data, kind, fields = {}) {
  const title = detail(string(fields.title), 240);
  const text = detail(string(fields.text), state.limits.maxDetailChars);
  const input = detail(string(fields.input), state.limits.maxDetailChars);
  const output = detail(string(fields.output), state.limits.maxDetailChars);
  const seq = index(event.seq);
  return Object.freeze({
    id: `${kind}:${seq}`,
    seq,
    time: index(event.time),
    turn: index(data.turn, state.turn),
    step: index(data.step, state.step),
    kind,
    title: title.value,
    text: text.value,
    callId: string(fields.callId),
    name: string(fields.name),
    input: input.value,
    output: output.value,
    status: string(fields.status),
    durationMs: fields.durationMs ?? null,
    truncated: fields.truncated === true || title.truncated || text.truncated || input.truncated || output.truncated,
    resultSeq: fields.resultSeq ?? null,
  });
}

function copyEntry(value) {
  // Every entry has the same complete shape; do not copy arbitrary event fields.
  return Object.freeze({
    id: value.id,
    seq: value.seq,
    time: value.time,
    turn: value.turn,
    step: value.step,
    kind: value.kind,
    title: value.title,
    text: value.text,
    callId: value.callId,
    name: value.name,
    input: value.input,
    output: value.output,
    status: value.status,
    durationMs: value.durationMs,
    truncated: value.truncated,
    resultSeq: value.resultSeq,
  });
}

function snapshot(state, patch = {}, entries = state.entries) {
  let overflow = Math.max(0, entries.length - state.limits.maxEntries);
  let retainedChars = 0;
  for (let i = entries.length - 1; i >= overflow; i -= 1) {
    const row = entries[i];
    const chars = row.title.length + row.text.length + row.input.length + row.output.length;
    if (i < entries.length - 1 && retainedChars + chars > MAX_RETAINED_CHARS) {
      overflow = i + 1;
      break;
    }
    retainedChars += chars;
  }
  const retained = overflow > 0 ? entries.slice(overflow) : entries;
  // New rows are frozen when created. Reuse existing immutable rows on the
  // normal incremental path; detach all rows only for an unfrozen checkpoint.
  const ownedEntries = Object.isFrozen(state.entries)
    ? retained : retained.map(copyEntry);
  const ownedLimits = Object.isFrozen(state.limits) ? state.limits : Object.freeze({
    maxEntries: state.limits.maxEntries,
    maxDetailChars: state.limits.maxDetailChars,
  });
  return Object.freeze({
    sessionId: state.sessionId,
    turn: patch.turn ?? state.turn,
    step: patch.step ?? state.step,
    status: patch.status ?? state.status,
    model: patch.model ?? state.model,
    entries: Object.freeze(ownedEntries),
    dropped: state.dropped + overflow,
    totalTools: patch.totalTools ?? state.totalTools,
    totalUpdates: patch.totalUpdates ?? state.totalUpdates,
    totalErrors: patch.totalErrors ?? state.totalErrors,
    limits: ownedLimits,
  });
}

function position(state, data) {
  return { turn: index(data.turn, state.turn), step: index(data.step, state.step) };
}

function elapsed(start, end) {
  return Math.max(0, end - start);
}

function toolTitle(argumentsText, name) {
  try {
    const parsed = JSON.parse(argumentsText);
    if (record(parsed) && typeof parsed.description === 'string') return parsed.description;
  } catch {
    // Malformed argument JSON remains visible verbatim as the tool input.
  }
  return name;
}

function publicError(error) {
  if (!record(error)) return '';
  const identity = [string(error.name), string(error.code)].filter(Boolean).join(' / ');
  const reason = string(error.reason);
  return identity && reason ? `${identity}: ${reason}` : identity || reason;
}

function outcome(kind) {
  switch (kind) {
    case 'completed': return { status: 'completed', title: 'Turn completed' };
    case 'error': return { status: 'error', title: 'Turn failed' };
    case 'aborted': return { status: 'stopped', title: 'Turn stopped' };
    case 'blocked': return { status: 'blocked', title: 'Turn blocked' };
    case 'max-tokens': return { status: 'max-tokens', title: 'Output limit reached' };
    case 'forked': return { status: 'forked', title: 'Turn forked' };
    default: return { status: 'interrupted', title: 'Turn interrupted' };
  }
}

/**
 * Pure, dependency-free projection of public session activity.
 *
 * init accepts the session-reducer inheritedEventCount argument without copying
 * lineage or other header metadata. apply always uses the checkpoint's limits,
 * so a suffix replay does not depend on the reducer's current configuration.
 * totalTools counts call events, including evicted calls; a result cannot add a
 * second count merely because its corresponding call row was evicted.
 */
export function createTraceReducer(options = {}) {
  const limits = {
    maxEntries: index(options?.maxEntries, DEFAULT_LIMITS.maxEntries),
    maxDetailChars: index(options?.maxDetailChars, DEFAULT_LIMITS.maxDetailChars),
  };

  return {
    init(header, _inheritedEventCount = 0) {
      return snapshot({
        sessionId: string(header?.id),
        turn: 0,
        step: 0,
        status: 'idle',
        model: '',
        entries: [],
        dropped: 0,
        totalTools: 0,
        totalUpdates: 0,
        totalErrors: 0,
        limits,
      });
    },

    apply(state, event) {
      if (!record(event) || !record(event.data)) return state;
      const data = event.data;

      switch (event.type) {
        case 'user/message': {
          if (data.source?.kind !== 'user' || (data.role && data.role !== 'user')) return state;
          const text = publicText(event, data, data);
          if (!text) return state;
          const row = entry(state, event, data, 'task', {
            title: 'Task', text, status: 'received',
          });
          return snapshot(state, {}, [...state.entries, row]);
        }

        case 'assistant/message': {
          const message = data.message;
          if (!record(message) || (message.role && message.role !== 'assistant')) return state;
          if (message.source?.kind && message.source.kind !== 'model') return state;
          const text = publicText(event, data, message);
          if (!text) return state;
          const row = entry(state, event, data, 'update', {
            title: 'Public update', text, status: 'published',
          });
          return snapshot(state, {
            ...position(state, data),
            model: typeof message.source?.model === 'string' ? message.source.model : state.model,
            totalUpdates: state.totalUpdates + 1,
          }, [...state.entries, row]);
        }

        case 'tool/call': {
          if (typeof data.callId !== 'string' || typeof data.name !== 'string'
            || typeof data.arguments !== 'string') return state;
          const row = entry(state, event, data, 'tool', {
            title: toolTitle(data.arguments, data.name),
            callId: data.callId,
            name: data.name,
            input: data.arguments,
            status: 'running',
          });
          return snapshot(state, {
            ...position(state, data), totalTools: state.totalTools + 1,
          }, [...state.entries, row]);
        }

        case 'tool/result': {
          const message = data.message;
          if (!record(message) || (message.role && message.role !== 'tool')) return state;
          if (message.source?.kind && message.source.kind !== 'tool') return state;
          const callId = typeof message.toolCallId === 'string' && message.toolCallId
            ? message.toolCallId
            : message.source?.kind === 'tool' ? string(message.source.callId) : '';
          const failed = message.isError === true || record(data.error);
          const output = publicText(event, data, message);
          const text = failed ? publicError(data.error) : '';
          const patch = {
            ...position(state, data), totalErrors: state.totalErrors + (failed ? 1 : 0),
          };
          let match = -1;
          for (let i = state.entries.length - 1; i >= 0; i -= 1) {
            const candidate = state.entries[i];
            if (callId && candidate.kind === 'tool' && candidate.callId === callId
              && candidate.resultSeq === null) {
              match = i;
              break;
            }
          }
          if (match === -1) {
            const row = entry(state, event, data, 'tool', {
              title: 'Tool result', callId, text, output,
              status: failed ? 'error' : 'completed', resultSeq: index(event.seq),
            });
            return snapshot(state, patch, [...state.entries, row]);
          }
          const call = state.entries[match];
          const boundedText = detail(text, state.limits.maxDetailChars);
          const boundedOutput = detail(output, state.limits.maxDetailChars);
          const settled = copyEntry({
            ...call,
            text: boundedText.value,
            output: boundedOutput.value,
            status: failed ? 'error' : 'completed',
            durationMs: elapsed(call.time, index(event.time)),
            truncated: call.truncated || boundedText.truncated || boundedOutput.truncated,
            resultSeq: index(event.seq),
          });
          const entries = state.entries.slice();
          entries[match] = settled;
          return snapshot(state, patch, entries);
        }

        case 'turn/start': {
          const turn = index(data.turn, state.turn);
          if (state.turn === turn && state.step === 0 && state.status === 'running') return state;
          return snapshot(state, { turn, step: 0, status: 'running' });
        }

        case 'step/start': {
          const next = position(state, data);
          if (state.turn === next.turn && state.step === next.step) return state;
          return snapshot(state, next);
        }

        case 'turn/end': {
          const next = position(state, data);
          const end = outcome(data.reason?.kind);
          const pendingStatus = end.status === 'stopped' ? 'stopped' : 'interrupted';
          const entries = state.entries.map(row => row.kind === 'tool'
            && row.turn === next.turn && row.status === 'running'
            ? copyEntry({ ...row, status: pendingStatus, durationMs: elapsed(row.time, index(event.time)) })
            : row);
          entries.push(entry(state, event, data, 'outcome', end));
          return snapshot(state, {
            ...next,
            status: end.status,
            totalErrors: state.totalErrors + (end.status === 'error' ? 1 : 0),
          }, entries);
        }

        default:
          return state;
      }
    },
  };
}
