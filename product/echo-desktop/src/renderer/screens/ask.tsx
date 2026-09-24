import { useState } from 'preact/hooks';
import { clock } from '../format.js';
import { message } from '../messages.js';
import { ask, closeSource, copyAnswer, openCompose, openSource, widenScope, type State } from '../store.js';
import { Close, Plus, Up } from './icons.js';

/** The one bar on every page: ⊕ writes, Return asks. */
export function Bar({ state }: { state: State }) {
  const [text, setText] = useState('');
  const scope = state.barScope;
  const projectName = state.route.page === 'project' && scope.kind === 'project' ? state.route.project.name : null;
  const submit = () => {
    if (text.trim() === '') return;
    void ask(text, scope);
    setText('');
  };
  return (
    <div class="bar-wrap">
      <form class="bar" onSubmit={event => { event.preventDefault(); submit(); }}>
        <button type="button" class="circle" aria-label="Write" data-testid="write-button" onClick={() => openCompose()}><Plus /></button>
        {projectName && (
          <span class="chip" data-testid="scope-chip">
            <span>{projectName}</span>
            <button type="button" aria-label="Ask all accessible context instead" data-testid="scope-clear" onClick={widenScope}><Close /></button>
          </span>
        )}
        <label for="ask-field" class="sr-only">Ask ECHO</label>
        <input
          id="ask-field" data-testid="ask-field" type="text" autocomplete="off" spellcheck maxLength={240}
          placeholder={projectName ? `Ask about ${projectName}` : 'Ask ECHO'}
          value={text} onInput={event => setText((event.target as HTMLInputElement).value)}
        />
        <button type="submit" class="circle primary" aria-label="Ask" data-testid="ask-send" disabled={text.trim() === ''}><Up /></button>
      </form>
    </div>
  );
}

/** The latest question, its answer, and the sources it came from. */
export function AskView({ state }: { state: State }) {
  const current = state.ask!;
  const evidence = state.evidence;
  if (evidence) {
    return (
      <article class="reader" data-testid="evidence" aria-busy={evidence.loading}>
        <h1>{evidence.label}</h1>
        {evidence.failure && <div class="error">{message(evidence.failure)}</div>}
        {evidence.text !== undefined && <div class="body selectable" data-testid="evidence-text">{evidence.text}</div>}
        <div class="actions"><button type="button" class="link-button" onClick={closeSource}>Back to answer</button></div>
      </article>
    );
  }
  return (
    <section class="ask" data-testid="ask-view" aria-live="polite">
      <div class="question selectable" data-testid="question">{current.question}</div>
      <div class="asked">{current.scopeName} · Asked at {clock(current.askedAt)}</div>
      {current.status === 'loading' && <div class="asking" data-testid="asking"><i /><i /><i /><span>Asking</span></div>}
      {current.status === 'error' && current.failure && (
        <div>
          <div class="error" data-testid="ask-error">{message(current.failure)}</div>
          <button type="button" class="link-button" onClick={() => void ask(current.question, current.scope)}>Ask again</button>
        </div>
      )}
      {current.status === 'answer' && current.answer && (
        <>
          <div class="answer selectable" data-testid="answer">{current.answer.text}</div>
          <div class="actions">
            <button type="button" class="link-button" onClick={() => void copyAnswer()}>Copy</button>
            <button type="button" class="link-button" onClick={() => void ask(current.question, current.scope)}>Ask again</button>
          </div>
          {current.answer.sources.length > 0 && (
            <div class="sources">
              <h2>Sources</h2>
              {current.answer.sources.map((source, index) => (
                <button type="button" key={`${source.label}-${index}`} class="source-row" data-testid="source-row"
                  disabled={!source.ref} onClick={() => void openSource(index)}>{source.label}</button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
