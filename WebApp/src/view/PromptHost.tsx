import { activePrompt } from '../state/prompts';
import { Dialog, TextButton } from './kit';

export function PromptHost() {
  const p = activePrompt.value;
  return (
    <Dialog
      open={!!p}
      onClose={() => p?.resolve(null)}
      title={p?.title}
      wide
      actions={
        <TextButton color="var(--nx-textSec)" onClick={() => p?.resolve(null)}>
          {p?.cancelLabel ?? 'Cancel'}
        </TextButton>
      }
    >
      {p && (
        <>
          <p class="nx-choice-body">{p.body}</p>
          <div class="nx-choice-list">
            {p.options.map((o) => (
              <button key={o.id} class={`nx-choice press ${o.tone ?? 'plain'}`} onClick={() => p.resolve(o.id)}>
                <span class="label">
                  {o.label}
                  {o.recommended && <em>Recommended</em>}
                </span>
                {o.detail && <span class="detail">{o.detail}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </Dialog>
  );
}
