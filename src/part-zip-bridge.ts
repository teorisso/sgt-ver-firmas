import { partArchiveUrl, zipConfirmEvent, zipGenerationTimeout, zipPopupLevel, zipPopupPath, zipResultEvent } from './part-zip-route';
import { ORIGIN } from './sgt';

type Redirect = (url: unknown, ...args: unknown[]) => unknown;
const page = window as Window & { gx?: { http?: { redirect?: Redirect } } };
let pending = false;

// This script runs in the page's JavaScript world, only inside the SGT's ZIP confirmation.
if (location.origin === ORIGIN && location.pathname.toLowerCase() === zipPopupPath && window !== window.top) {
  document.addEventListener(zipConfirmEvent, () => {
    if (pending) return;
    const popup = new URL(location.href);
    const respond = (url = '') => document.dispatchEvent(new CustomEvent(zipResultEvent, { detail: url }));
    const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      'input[type="button"],input[type="submit"],button',
    )).filter(control => !control.disabled && control.getClientRects().length &&
      (control.getAttribute('value') ?? control.textContent)?.trim() === 'Confirmar');
    const http = page.gx?.http;
    const original = http?.redirect;
    if (!http || typeof original !== 'function' || controls.length !== 1) {
      respond();
      return;
    }

    // Only this confirmation's redirect is intercepted. The ordinary SGT download is unaffected.
    pending = true;
    const settle = (url = '') => {
      clearTimeout(timer);
      if (http.redirect === intercept) http.redirect = original;
      pending = false;
      respond(url);
    };
    const intercept: Redirect = value => {
      const archive = typeof value === 'string' ? partArchiveUrl(value, popup.href) : null;
      const level = zipPopupLevel(popup);
      if (archive && !archive.search && level) archive.search = level;
      settle(archive?.href);
    };
    const timer = setTimeout(settle, zipGenerationTimeout);
    http.redirect = intercept;
    try {
      controls[0].click();
    } catch {
      settle();
    }
  });
}
