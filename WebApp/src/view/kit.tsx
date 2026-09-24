import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { haptic } from '../lib/haptics';
import { isWide } from '../state/viewport';
import { Icon, type IconName } from './icons';
import { animate, BOUNCY, ENTER, EXIT, STANDARD, useEnterExit } from './motion';

// ─── Layers ────────────────────────────────────────────────────────────────────

type LayerProps = { leaving: boolean; onExited: () => void; onDismiss: () => void };

/**
 * Bottom sheet (NexusSheet): scrim, 28dp top corners, drag the handle down to dismiss
 * (> 120px), otherwise it springs back.
 */
export function Sheet({
  leaving,
  onExited,
  onDismiss,
  children,
  scrim = 0.55,
  class: cls = '',
  radius = 28,
  handle = true,
  maxHeight = '92%'
}: LayerProps & {
  children: ComponentChildren;
  scrim?: number;
  class?: string;
  radius?: number;
  handle?: boolean;
  maxHeight?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLDivElement>(null);
  // Phone: slides up from the bottom edge. Desktop: fades and zooms in, centred.
  const wide = isWide.value;
  useEnterExit(
    panel,
    leaving,
    onExited,
    wide
      ? [{ transform: 'scale(0.96)', opacity: 0 }, { transform: 'none', opacity: 1 }]
      : [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }],
    wide
      ? [{ transform: 'none', opacity: 1 }, { transform: 'scale(0.97)', opacity: 0 }]
      : [{ transform: getComputedTransform(panel.current) }, { transform: 'translateY(100%)' }],
    wide ? { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' } : undefined,
    wide ? { duration: 170, easing: 'cubic-bezier(0.4, 0, 1, 1)' } : undefined
  );
  useEnterExit(shade, leaving, () => {}, [{ opacity: 0 }, { opacity: 1 }], [{ opacity: 1 }, { opacity: 0 }],
    { duration: 200, easing: 'linear' }, { duration: 200, easing: 'linear' });
  const drag = useSheetDrag(panel, onDismiss, 120);
  return (
    <div class="nx-layer" data-leaving={leaving || undefined}>
      <div ref={shade} class="nx-scrim" style={{ background: `rgba(0,0,0,${scrim})` }} onClick={onDismiss} />
      <div
        ref={panel}
        class={`nx-sheet ${cls}`}
        style={{ borderTopLeftRadius: radius, borderTopRightRadius: radius, maxHeight }}
        role="dialog"
        aria-modal="true"
      >
        {handle && (
          <div class="nx-sheet-handle" {...drag}>
            <span />
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function getComputedTransform(el: HTMLElement | null): string {
  if (!el) return 'translateY(0)';
  const t = getComputedStyle(el).transform;
  return t && t !== 'none' ? t : 'translateY(0)';
}

/** Pointer handlers that let a panel follow the finger down and dismiss past [threshold]. */
export function useSheetDrag(panel: { current: HTMLElement | null }, onDismiss: () => void, threshold: number, factor = 1) {
  const start = useRef<{ y: number; id: number } | null>(null);
  const dy = useRef(0);
  return {
    onPointerDown: (e: PointerEvent) => {
      start.current = { y: e.clientY, id: e.pointerId };
      dy.current = 0;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      panel.current?.getAnimations().forEach((a) => a.cancel());
    },
    onPointerMove: (e: PointerEvent) => {
      if (!start.current || e.pointerId !== start.current.id) return;
      dy.current = Math.max(0, (e.clientY - start.current.y) * factor);
      if (panel.current) panel.current.style.transform = `translateY(${dy.current}px)`;
    },
    onPointerUp: () => {
      if (!start.current) return;
      start.current = null;
      const el = panel.current;
      if (!el) return;
      if (dy.current > threshold) {
        onDismiss();
      } else {
        const from = el.style.transform;
        el.style.transform = '';
        animate(el, [{ transform: from }, { transform: 'translateY(0)' }], { duration: 320, easing: BOUNCY, fill: 'none' });
      }
    },
    onPointerCancel: () => {
      start.current = null;
      if (panel.current) panel.current.style.transform = '';
    }
  };
}

/** Full-screen page that slides in from the right (Settings, Vault). */
export function Page({ leaving, onExited, children, class: cls = '' }: LayerProps & { children: ComponentChildren; class?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEnterExit(
    ref,
    leaving,
    onExited,
    [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }],
    [{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }],
    ENTER,
    { duration: 240, easing: STANDARD }
  );
  return (
    <div ref={ref} class={`nx-page ${cls}`} data-leaving={leaving || undefined}>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, onBack, trailing }: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  trailing?: ComponentChildren;
}) {
  return (
    <header class="nx-page-header">
      <IconButton icon="back" label="Back" onClick={onBack} />
      <div class="nx-page-title">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {trailing}
    </header>
  );
}

/** Keeps content mounted while it animates out. */
export function usePresence(open: boolean, exitMs = 200): [mounted: boolean, leaving: boolean] {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
    else if (mounted) {
      const t = setTimeout(() => setMounted(false), exitMs);
      return () => clearTimeout(t);
    }
  }, [open]);
  return [mounted || open, mounted && !open];
}

/** AlertDialog, radius 24, surfaceEl. */
export function Dialog({ open, onClose, title, children, actions, wide }: {
  open: boolean;
  onClose: () => void;
  title?: ComponentChildren;
  children?: ComponentChildren;
  actions?: ComponentChildren;
  wide?: boolean;
}) {
  const [mounted, leaving] = usePresence(open, 180);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open && box.current)
      animate(box.current, [{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 260, easing: BOUNCY });
    if (leaving && box.current)
      animate(box.current, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.96)' }], { duration: 160, easing: STANDARD });
  }, [open, leaving]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [open]);
  if (!mounted) return null;
  return (
    <div class="nx-dialog-wrap" data-leaving={leaving || undefined}>
      <div class="nx-scrim" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose} />
      <div ref={box} class={`nx-dialog ${wide ? 'wide' : ''}`} role="alertdialog">
        {title && <h2 class="nx-dialog-title">{title}</h2>}
        {children && <div class="nx-dialog-body">{children}</div>}
        {actions && <div class="nx-dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function TextButton({ children, onClick, color, disabled }: {
  children: ComponentChildren;
  onClick: () => void;
  color?: string;
  disabled?: boolean;
}) {
  return (
    <button class="nx-text-btn press" style={color ? { color } : undefined} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

// ─── Menus ─────────────────────────────────────────────────────────────────────

export type MenuItem = { label: string; icon?: IconName; danger?: boolean; onSelect: () => void } | 'divider';

/** Dropdown anchored to its trigger; opens upward when there is no room below. */
export function Menu({ trigger, items, align = 'end' }: {
  trigger: (open: () => void) => ComponentChildren;
  items: MenuItem[];
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !wrap.current || !pop.current) return;
    const r = wrap.current.getBoundingClientRect();
    const need = pop.current.offsetHeight + 12;
    setUp(r.bottom + need > window.innerHeight && r.top > need);
    animate(pop.current, [{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 160, easing: STANDARD });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  return (
    <div class="nx-menu-wrap" ref={wrap}>
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div ref={pop} class={`nx-menu ${align} ${up ? 'up' : ''}`} role="menu">
          {items.map((it, i) =>
            it === 'divider' ? (
              <div key={i} class="nx-menu-divider" />
            ) : (
              <button
                key={i}
                role="menuitem"
                class={`nx-menu-item ${it.danger ? 'danger' : ''}`}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {it.icon && <Icon name={it.icon} size={18} />}
                <span>{it.label}</span>
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

// ─── Controls ──────────────────────────────────────────────────────────────────

export function IconButton({ icon, label, onClick, size = 24, color, class: cls = '' }: {
  icon: IconName;
  label: string;
  onClick: (e: MouseEvent) => void;
  size?: number;
  color?: string;
  class?: string;
}) {
  return (
    <button class={`nx-icon-btn press ${cls}`} aria-label={label} title={label} onClick={onClick} style={color ? { color } : undefined}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function SectionHeader({ children }: { children: ComponentChildren }) {
  return <h3 class="nx-section-header">{children}</h3>;
}

export function SettingsGroup({ children }: { children: ComponentChildren }) {
  return <div class="nx-group">{children}</div>;
}

export function GroupDivider() {
  return <div class="nx-group-divider" />;
}

export function IconTile({ icon, tint, size = 32 }: { icon: IconName; tint: string; size?: number }) {
  return (
    <span class="nx-icon-tile" style={{ width: size, height: size, background: `color-mix(in srgb, ${tint} 14%, transparent)` }}>
      <Icon name={icon} size={Math.round(size * 0.56)} color={tint} />
    </span>
  );
}

export function SettingsRow({ icon, title, subtitle, tint = 'var(--nx-accent)', titleColor, onClick, trailing }: {
  icon: IconName;
  title: string;
  subtitle?: string | null;
  tint?: string;
  titleColor?: string;
  onClick?: () => void;
  trailing?: ComponentChildren;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag class={`nx-row ${onClick ? 'press clickable' : ''}`} onClick={onClick}>
      <IconTile icon={icon} tint={tint} />
      <span class="nx-row-text">
        <span class="nx-row-title" style={titleColor ? { color: titleColor } : undefined}>{title}</span>
        {subtitle && <span class="nx-row-sub">{subtitle}</span>}
      </span>
      {trailing !== undefined ? trailing : onClick ? <Chevron /> : null}
    </Tag>
  );
}

export function Chevron({ badge }: { badge?: string | null }) {
  return (
    <span class="nx-chevron">
      {badge && <span>{badge}</span>}
      <Icon name="chevronRight" size={20} />
    </span>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      class={`nx-switch ${checked ? 'on' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        haptic('CHECK');
        onChange(!checked);
      }}
    >
      <span class="thumb" />
    </button>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange }: {
  options: Array<[T, string]>;
  value: T;
  onChange: (v: T) => void;
}) {
  const idx = Math.max(0, options.findIndex(([v]) => v === value));
  return (
    <div class="nx-segmented" style={{ '--n': options.length, '--i': idx } as JSX.CSSProperties}>
      <span class="pill" />
      {options.map(([v, label]) => (
        <button
          key={String(v)}
          class={v === value ? 'sel' : ''}
          onClick={() => {
            if (v !== value) {
              haptic('DRAG_TICK');
              onChange(v);
            }
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({ value, min, max, format, onChange }: {
  value: number;
  min: number;
  max: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const step = (d: number) => {
    const v = Math.min(max, Math.max(min, value + d));
    if (v !== value) {
      haptic('DRAG_TICK');
      onChange(v);
    }
  };
  return (
    <span class="nx-stepper">
      <button disabled={value <= min} onClick={() => step(-1)} aria-label="Decrease">−</button>
      <span class="val">{format(value)}</span>
      <button disabled={value >= max} onClick={() => step(1)} aria-label="Increase">+</button>
    </span>
  );
}

/** Slider that only commits on release (no write per frame), like the Android sliders. */
export function Slider({ value, min, max, step = 1, onInput, onCommit, label }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onInput: (v: number) => void;
  onCommit: (v: number) => void;
  label?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      class="nx-slider"
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ '--pct': `${pct}%` } as JSX.CSSProperties}
      onInput={(e) => onInput(Number((e.target as HTMLInputElement).value))}
      onChange={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
    />
  );
}

export function PrimaryButton({ children, icon, onClick, color = 'var(--nx-accent)', disabled, class: cls = '' }: {
  children: ComponentChildren;
  icon?: IconName;
  onClick: () => void;
  color?: string;
  disabled?: boolean;
  class?: string;
}) {
  return (
    <button
      class={`nx-primary press ${cls}`}
      style={{ background: color }}
      disabled={disabled}
      onClick={() => {
        haptic('FAB_TAP');
        onClick();
      }}
    >
      {icon && <Icon name={icon} size={18} />}
      {children}
    </button>
  );
}

/** Count that rolls up/down when it changes (Compose AnimatedContent). */
export function CountBadge({ count, color, bg }: { count: number; color: string; bg?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(count);
  useLayoutEffect(() => {
    if (prev.current !== count && ref.current) {
      const up = count > prev.current;
      animate(ref.current, [
        { transform: `translateY(${up ? 8 : -8}px)`, opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 }
      ], { duration: 220, easing: STANDARD });
    }
    prev.current = count;
  }, [count]);
  if (count <= 0) return null;
  return (
    <span class="nx-count" style={{ color, background: bg ?? `color-mix(in srgb, ${color} 14%, transparent)` }}>
      <span ref={ref}>{count}</span>
    </span>
  );
}

export function Checkbox({ checked, color, size = 28, onChange, dim }: {
  checked: boolean;
  color: string;
  size?: number;
  onChange: (v: boolean) => void;
  dim?: boolean;
}) {
  return (
    <button
      role="checkbox"
      aria-checked={checked}
      class={`nx-check ${checked ? 'on' : ''}`}
      style={{ '--c': color, width: size, height: size, opacity: dim ? 0.55 : 1 } as JSX.CSSProperties}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span class="box">
        <svg viewBox="0 0 24 24" width="70%" height="70%">
          <path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="var(--nx-bg)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </button>
  );
}

export { EXIT };
