import { nexusLogoHtml } from './nexus-logo';

const VERSION = '3.5';

export function showSplash(onDone: () => void): void {
  const el = document.createElement('div');
  el.className = 'nx-splash';
  el.innerHTML = `
    <div class="nx-splash-center">
      <div class="nx-splash-logo">${nexusLogoHtml(110)}</div>
      <h1 class="nx-splash-letters">NEXUS</h1>
      <p class="nx-splash-sub">priority matrix</p>
    </div>
    <div class="nx-splash-foot">
      <p>Developed by Priyanshu Pradhan</p>
      <p>v${VERSION} · 2025 – 2026</p>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('nx-splash--in'));

  window.setTimeout(() => {
    el.classList.add('nx-splash--out');
    window.setTimeout(() => {
      el.remove();
      onDone();
    }, 360);
  }, 1650);
}
