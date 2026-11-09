window.__ModuleLoader__.load({
  id: '@local/dsh-decision-trace',
  factory(require) {
    const NS = 'localDecisionTrace';
    const KEY = 'decisionTrace';
    const EMPTY = Object.freeze([]);
    const en = {
      title: 'Decision trace',
      intro: 'Public task notes. Related actions open in Trajectory.',
      turn: 'Turn', step: 'Step',
      related: 'View related actions in Trajectory', loading: 'Opening Trajectory…',
      openError: 'Could not load the related action. Please try again.',
      empty: 'No public task notes yet.',
      unavailable: 'Task notes are not available yet. Reopen this session to retry.',
      truncated: 'This note has been shortened to the preview limit.',
      retained: 'Only recent notes are retained here. Full history is available in Trajectory.',
      showEarlier: 'Show earlier notes',
    };
    const zh = {
      title: '思路说明',
      intro: '模型公开的思路说明；相关行动可在 Trajectory 中查看。',
      turn: '轮次', step: '步骤',
      related: '在 Trajectory 查看关联执行', loading: '正在打开 Trajectory…',
      openError: '未能加载关联执行，请重试。',
      empty: '还没有公开的思路说明。',
      unavailable: '暂时无法读取思路说明，请重新打开此会话。',
      truncated: '这段说明已按预览长度上限缩短。',
      retained: '这里保留近期说明，完整历史可在 Trajectory 中查看。',
      showEarlier: '查看更早的说明',
    };
    const css = `
.dt-notes{width:100%;min-width:0;box-sizing:border-box;padding:24px 24px 40px;color:var(--dsw-alias-label-primary);font:inherit}
.dt-notes *{box-sizing:border-box}.dt-notes-inner{max-width:760px;margin:0 auto}
.dt-notes-intro{margin:0 0 28px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.dt-notes-list{list-style:none;margin:0;padding:0}.dt-note{padding:0 0 24px;margin:0 0 24px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dt-note:last-child{margin-bottom:0;border-bottom:0}
.dt-note-meta{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:9px;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.dt-note-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.85;tab-size:2}
.dt-note-link{display:inline-flex;align-items:center;gap:5px;margin-top:12px;padding:3px 0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;line-height:1.6;text-align:left;cursor:pointer;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:3px}
.dt-note-link:hover{ text-decoration-color:currentColor}.dt-note-link:disabled{opacity:.65;cursor:wait}.dt-note-link:focus-visible,.dt-notes-earlier:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:3px}
.dt-note-link svg{flex:none}.dt-note-error{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dt-notes-muted{margin:10px 0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}.dt-notes-empty{padding:30px 0}
.dt-notes-earlier{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:4px 0;margin:0 0 22px;cursor:pointer}.dt-notes-earlier:hover{color:var(--dsw-alias-label-primary)}
@media(max-width:500px){.dt-notes{padding:20px 16px 28px}.dt-note-text{font-size:14px}.dt-notes-intro{margin-bottom:24px}}
`;

    // Read the Host's completed projection, never the raw event stream. A link
    // means only that the note and call share recorded Turn/Step coordinates.
    function selectNotes(entries) {
      if (!Array.isArray(entries)) return EMPTY;
      const callsByStep = new Map();
      for (const entry of entries) {
        if (entry.kind !== 'tool' || !entry.callId || !entry.name) continue;
        const key = `${entry.turn}:${entry.step}`;
        const previous = callsByStep.get(key);
        if (!previous || entry.seq < previous.seq) {
          callsByStep.set(key, { callId: entry.callId, seq: entry.seq });
        }
      }
      const notes = [];
      for (const entry of entries) {
        if (entry.kind !== 'update' || typeof entry.text !== 'string' || !entry.text.trim()) continue;
        const related = callsByStep.get(`${entry.turn}:${entry.step}`);
        notes.push({
          id: entry.id, seq: entry.seq, time: entry.time,
          turn: entry.turn, step: entry.step, text: entry.text,
          truncated: entry.truncated, action: related || null,
        });
      }
      return notes;
    }

    async function openRelatedAction(action, loadAction, openView, isCurrent) {
      if (!action || typeof loadAction !== 'function' || typeof openView !== 'function') return false;
      await loadAction(action.seq);
      if (!isCurrent()) return false;
      openView('trajectory', action.callId);
      return true;
    }

    function NotesBody(props) {
      const React = require('react');
      const h = React.createElement;
      const { t, loadAction, openView, inspectCall, viewRequest, completeViewRequest } = props;
      const entries = props.useProjection(KEY, value => value?.entries);
      const dropped = props.useProjection(KEY, value => value?.dropped || 0);
      const notes = React.useMemo(() => selectNotes(entries), [entries]);
      const [limit, setLimit] = React.useState(80);
      const [pending, setPending] = React.useState(null);
      const [error, setError] = React.useState(null);
      const alive = React.useRef(false);
      const request = React.useRef(0);
      React.useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; request.current++; };
      }, []);
      React.useEffect(() => {
        if (viewRequest?.view === 'decision-trace') completeViewRequest();
      }, [viewRequest, completeViewRequest]);
      const showAction = async note => {
        const ticket = ++request.current;
        const current = () => alive.current && ticket === request.current;
        setPending(note.id);
        setError(null);
        try {
          await openRelatedAction(note.action, loadAction, openView, current);
        } catch {
          if (current()) setError(note.id);
        } finally {
          if (current()) setPending(null);
        }
      };
      const start = Math.max(0, notes.length - limit);
      return h('section', { className: 'dt-notes', 'aria-label': t('title') },
        h('style', null, css),
        h('div', { className: 'dt-notes-inner' },
          h('p', { className: 'dt-notes-intro' }, t('intro')),
          dropped > 0 && h('p', { className: 'dt-notes-muted' }, t('retained')),
          start > 0 && h('button', { type: 'button', className: 'dt-notes-earlier', onClick: () => setLimit(value => value + 80) }, t('showEarlier')),
          !entries ? h('p', { className: 'dt-notes-muted dt-notes-empty', role: 'status' }, t('unavailable')) :
            notes.length === 0 ? h('p', { className: 'dt-notes-muted dt-notes-empty' }, t('empty')) :
              h('ol', { className: 'dt-notes-list' }, ...notes.slice(start).map(note => h('li', { className: 'dt-note', key: note.id },
                h('div', { className: 'dt-note-meta' },
                  h('span', null, `${t('turn')} ${note.turn} · ${t('step')} ${note.step}`),
                  h('time', { dateTime: new Date(note.time).toISOString(), title: new Date(note.time).toLocaleString() }, new Date(note.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))),
                h('div', { className: 'dt-note-text' }, note.text),
                note.truncated && h('p', { className: 'dt-notes-muted' }, t('truncated')),
                note.action && inspectCall && h('button', { type: 'button', className: 'dt-note-link', disabled: pending !== null, onClick: () => showAction(note) },
                  pending === note.id ? t('loading') : t('related'),
                  h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M4 12 12 4M5 4h7v7' }))),
                error === note.id && h('p', { className: 'dt-note-error', role: 'alert' }, t('openError')),
              ))),
        ),
      );
    }
    function NotesView(props) {
      const React = require('react');
      return React.createElement(NotesBody, { ...props, key: props.sessionId });
    }
    return {
      // Pure helpers allow regression checks without a browser or React/DOM emulation.
      selectNotes, openRelatedAction,
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', en));
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh));
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'decision-trace', order: 20,
          label: () => t('title'), locale: NS,
          inject: sessionId => ({
            // The visible view already owns this binding. Borrow it only for a
            // user-initiated history read, without opening another event source.
            loadAction: async seq => {
              const binding = ctx.sessions.binding(sessionId);
              if (!binding) throw new Error('Session is no longer open');
              await binding.session.loadThrough(Math.max(0, seq - 1));
              const snapshot = binding.session.getSnapshot();
              if (snapshot.openError || snapshot.removed) throw new Error('Related history is unavailable');
            },
          }),
        }, NotesView));
      },
    };
  },
});
