export const ORIGIN = 'https://app.chaco.gob.ar';
export const ATTACHMENT_LABEL = 'Ver firmas';
export const PART_RESULT_LABEL = 'Firmas del PDF de e-Parte';
const partPreviewPath = '/tramites/servlet/com.ecom.verpartedigital';
const casePath = '/tramites/servlet/com.ecom.vertramites';

const controls = 'button,a,input[type=button],input[type=submit],input[type=image],[role=button],[role=tab],' +
  'img[onclick],img[data-gx-evt]';
export const dialog = 'dialog,[role=dialog],.modal,.ui-dialog,.k-window,.x-window,.dx-popup-content,.swal2-popup,.gx-popup';

export function sgtUrl(value: string, base: string): URL | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value, base);
    if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

export function normalized(value: string) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function labels(node: Element) {
  const icon = node.querySelector('[title],[aria-label],img[alt]');
  return [node.getAttribute('title'), node.getAttribute('aria-label'), node.getAttribute('data-original-title'),
    node.getAttribute('data-bs-original-title'), node.getAttribute('data-bs-title'), node.getAttribute('value'),
    node.getAttribute('alt'), node.textContent, icon?.getAttribute('title'), icon?.getAttribute('aria-label'), icon?.getAttribute('alt')]
    .map(value => normalized(value ?? ''));
}

export function isAttachmentOpener(node: Element) {
  return labels(node).some(value => /^ver documentacion adjunta[.!…]?$/.test(value));
}

export function isPartOpener(node: Element) {
  return labels(node).some(value => /^ver (?:la )?e[ -]?parte[.!…]?$/.test(value));
}

export function findControls(documents: Document[], predicate: (node: Element) => boolean) {
  return documents.flatMap(doc => Array.from(doc.querySelectorAll<HTMLElement>(controls)).filter(predicate));
}

export function hasPartColumn(doc: Document, rendered: (element: Element) => boolean) {
  return Array.from(doc.querySelectorAll('th')).some(header =>
    /^e\s*[-–]?\s*parte$/.test(normalized(header.textContent ?? '')) && rendered(header));
}

export function attachmentTabs(documents: Document[]) {
  const possible = documents.flatMap(doc => Array.from(doc.querySelectorAll<HTMLElement>(
    controls + ',[onclick],[data-gx-evt],[data-toggle=tab],[data-bs-toggle=tab]',
  )).filter(node => !isAttachmentOpener(node) && labels(node).includes('documentacion adjunta')));
  return possible.filter(node => !possible.some(other => other !== node && other.contains(node)));
}

export function isAttachmentTabActive(control: Element) {
  const active = '[aria-selected="true"],[aria-current="page"],.active,.selected,.ui-tabs-active,.ui-tabs-selected,.ui-state-active';
  if (control.matches(active) || control.parentElement?.closest('li,[role=tab]')?.matches(active)) return true;
  const target = control.getAttribute('aria-controls') ??
    (control.getAttribute('data-bs-target') ?? control.getAttribute('data-target') ?? control.getAttribute('href'))
      ?.match(/^#([^#]+)$/)?.[1];
  return Boolean(target && control.ownerDocument.getElementById(target)?.matches(active));
}

export function isPartPreviewUrl(url: string) {
  return sgtUrl(url, ORIGIN)?.pathname.toLowerCase() === partPreviewPath;
}

export function isCaseUrl(url: string) {
  return sgtUrl(url, ORIGIN)?.pathname.toLowerCase() === casePath;
}

export function partPreviewControls(doc: Document) {
  if (!isPartPreviewUrl(doc.URL)) return null;
  const backs = findControls([doc], node => labels(node).includes('volver'));
  const heading = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]'))
    .find(node => /^tramite\b.*\be-parte\b/.test(normalized(node.textContent ?? '')));
  const main = doc.querySelector('main,[role=main]');
  return { backs, heading, main };
}
