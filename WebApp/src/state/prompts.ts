import { signal } from '@preact/signals';

/** A decision the user must make (account switching, sign-out). Rendered by <PromptHost/>. */
export type ChoiceOption = {
  id: string;
  label: string;
  detail?: string;
  tone?: 'primary' | 'danger' | 'plain';
  recommended?: boolean;
};
export type ChoicePrompt = {
  title: string;
  body: string;
  options: ChoiceOption[];
  cancelLabel?: string;
  resolve: (id: string | null) => void;
};

export const activePrompt = signal<ChoicePrompt | null>(null);

/** Resolves with the chosen option id, or null when cancelled / dismissed. */
export function askChoice(p: Omit<ChoicePrompt, 'resolve'>): Promise<string | null> {
  activePrompt.value?.resolve(null);
  return new Promise((resolve) => {
    activePrompt.value = {
      ...p,
      resolve: (id) => {
        activePrompt.value = null;
        resolve(id);
      }
    };
  });
}
