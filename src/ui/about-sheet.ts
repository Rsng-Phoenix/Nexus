import { nexusLogoHtml } from './nexus-logo';

const DEVELOPER = 'Priyanshu Pradhan';
const APP_YEAR = '2025 - 2026';
const VERSION = '3.5';

export function showAboutSheet(onOpenSettings: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'nx-overlay nx-overlay-sheet';
  overlay.innerHTML = `
    <div class="nx-bottom-sheet nx-about-sheet" role="dialog">
      <div class="nx-sheet-grab"></div>
      <div class="nx-about-logo">${nexusLogoHtml(72)}</div>
      <h2 class="nx-about-title">NEXUS</h2>
      <p class="nx-about-sub">priority matrix</p>
      <hr class="nx-about-rule" />
      <p class="nx-about-by">Developed by</p>
      <p class="nx-about-name">${DEVELOPER}</p>
      <a class="nx-about-email" href="mailto:priyanshupradhan0204@gmail.com">priyanshupradhan0204@gmail.com</a>
      <div class="nx-about-pills">
        <span class="nx-pill accent">v${VERSION}</span>
        <span class="nx-pill">© ${APP_YEAR}</span>
      </div>
      <button type="button" class="nx-about-settings" data-settings>
        <span>⚙</span> Settings
      </button>
      <a class="nx-about-github" href="https://github.com/Rsng-Phoenix/Nexus" target="_blank" rel="noopener">
        Github : Rsng-Phoenix
      </a>
    </div>`;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector('[data-settings]')?.addEventListener('click', () => {
    overlay.remove();
    onOpenSettings();
  });
}
