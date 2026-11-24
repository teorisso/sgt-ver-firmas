import {
  attachmentTabs, dialog, findControls, hasPartColumn, isAttachmentTabActive, isAttachmentOpener, isCaseUrl,
  isPartOpener, isPartPreviewUrl, partPreviewControls, sgtUrl, ATTACHMENT_LABEL, PART_RESULT_LABEL,
} from './sgt';
import { gridCaseLink, isCaseLink, previewCaseLink, type CaseLink } from './case-link';
import { containingFrame, fetchPdf, isRendered, isVisible, sameOriginDocuments, visibleViewers, withinViewerScope, type Viewer } from './viewer';
import { createPanel } from './panel';
import { addPartZipButton } from './part-zip-ui';
import { sha256Hex } from './pki';
import { verifyPdf } from './verify';

const documents = () => sameOriginDocuments(document);
type OriginAction = (signal: AbortSignal) => Promise<URL>;
const observer = new Map<Document, MutationObserver>();
const inserted = new WeakMap<Element, HTMLButtonElement>();
const viewerButtons = new Map<Element, HTMLButtonElement>();
let openPdfButton: HTMLButtonElement | undefined;
let queued = false;
let verifying = false;

function localControl(control: HTMLElement) {
  const href = control.closest('a')?.getAttribute('href')?.trim();
  return !href || /^#|^javascript:/i.test(href) || !!sgtUrl(href, control.ownerDocument.baseURI);
}

function addButton(anchor: Element, label: string, chooseSource: OriginAction, inside = false, resultLabel = label) {
  if (inserted.get(anchor)?.isConnected) return;
  const button = anchor.ownerDocument.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.setAttribute('data-sgt-firmas-action', '');
  Object.assign(button.style, {
    margin: '4px 6px', padding: '4px 9px', cursor: 'pointer', background: '#eaf5fb',
    border: '1px solid #557f9c', color: '#153e58', borderRadius: '5px', fontSize: '13px', whiteSpace: 'nowrap',
  });
  button.addEventListener('click', event => {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    void verify(resultLabel, chooseSource);
  });
  inserted.set(anchor, button);
  if (inside) anchor.prepend(button);
  else anchor.after(button);
  return button;
}

async function verify(label: string, chooseSource: OriginAction) {
  if (verifying) return;
  verifying = true;
  const abort = new AbortController();
  const panel = createPanel(document, label, () => {
    abort.abort();
    verifying = false;
  });
  try {
    const url = await chooseSource(abort.signal);
    abort.signal.throwIfAborted();
    panel.bringToFront();
    panel.status('Verificando las firmas en el navegador…');
    const pdf = await fetchPdf(url, AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]));
    const results = await verifyPdf(pdf).catch(error => {
      if (error instanceof Error && /^El PDF (está cifrado|tiene una estructura)/.test(error.message)) throw error;
      throw new Error('No se pudo analizar la estructura de firmas del PDF.');
    });
    if (abort.signal.aborted) return;
    const fingerprint = await sha256Hex(pdf);
    if (!abort.signal.aborted) panel.results(results, fingerprint);
  } catch (error) {
    if (!abort.signal.aborted) panel.status(error instanceof Error ? error.message : 'No se pudo verificar el PDF.');
  }
}

function dialogs() {
  return documents().flatMap(doc => Array.from(doc.querySelectorAll(dialog))
    .filter(node => !node.hasAttribute('data-sgt-firmas-panel') && isVisible(node)));
}

function dialogTitle(node: Element) {
  const heading = node.querySelector('.modal-title,.ui-dialog-title,.k-window-title,.x-window-header-text,h1,h2,h3,h4,[role=heading]');
  const labelledBy = node.getAttribute('aria-labelledby');
  return (node.getAttribute('aria-label') ?? (labelledBy ? node.ownerDocument.getElementById(labelledBy)?.textContent : null)
    ?? heading?.textContent ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

function attachmentDialog(node: Element) {
  return /^(?:ver )?documentacion adjunta[.!…]?$/.test(dialogTitle(node));
}

function approvalDialog(node: Element) {
  return /(?:detalle.*aprobacion|aprobacion.*firma digital)/.test(dialogTitle(node));
}

const modalClose = '[data-dismiss=modal],[data-bs-dismiss=modal],.close,.ui-dialog-titlebar-close,' +
  '.gx-popup-close,button[aria-label="cerrar" i],a[aria-label="cerrar" i],button[aria-label="close" i],button[title="cerrar" i]';

function attachmentHeader(node: Element) {
  return node.querySelector('.modal-header,.ui-dialog-titlebar,.k-window-titlebar,.x-window-header,.dx-popup-title,.gx-popup-header')
    ?? node.querySelector(modalClose)?.parentElement ?? node.querySelector('.modal-content,.modal-dialog') ?? node;
}

function floatingViewerWindow(element: Element) {
  for (let current: Element | null = element; current; current = containingFrame(current)) {
    const { body, defaultView } = current.ownerDocument;
    if (!defaultView) continue;
    for (let ancestor = current.parentElement; ancestor && ancestor !== body; ancestor = ancestor.parentElement) {
      const position = defaultView.getComputedStyle(ancestor).position;
      if ((position === 'fixed' || position === 'absolute') &&
        ancestor.querySelectorAll(modalClose).length === 1 && isVisible(ancestor)) return ancestor;
    }
  }
  return null;
}

function watchPartPreview(doc: Document) {
  if (!doc.body || doc.querySelector('[data-sgt-firmas-preview]')) return;
  const controls = partPreviewControls(doc);
  if (!controls) return;
  const backs = controls.backs.filter(isVisible);
  const anchor = (backs.length === 1 ? backs[0] : controls.heading) ?? controls.main ?? doc.body;
  addButton(anchor, 'Ver firmas', signal => openPartPdf(doc, signal),
    anchor === doc.body || anchor === controls.main, PART_RESULT_LABEL)?.setAttribute('data-sgt-firmas-preview', '');
}

const partViewerMissing = 'No se encontró el PDF de la e-Parte. Abrí su vista previa con la lupa y pulsá «Ver firmas» junto a «Volver».';

function openPartPdf(doc: Document, signal: AbortSignal) {
  return waitForViewer(() => isPartPreviewUrl(doc.URL)
    ? visibleViewers(sameOriginDocuments(doc)).filter(viewer => viewer.labelledPdf)
    : [], signal, partViewerMissing);
}

async function openPartFromRow(control: HTMLElement, signal: AbortSignal) {
  if (!control.isConnected || !isVisible(control) || !localControl(control)) throw new Error(partViewerMissing);
  const link = gridCaseLink(control, document);
  if (link) {
    // A missing acknowledgement must not prevent the SGT from opening its own preview.
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const queued = await chrome.runtime.sendMessage({ kind: 'queue-part', link }).catch(() => false);
      if (queued === true) break;
    }
  }
  signal.throwIfAborted();
  if (!control.isConnected) throw new Error(partViewerMissing);
  const before = new Map(visibleViewers(documents()).map(viewer => [viewer.element, viewer.url.href]));
  control.click();
  // The current SGT navigates to a dedicated preview. A viewer embedded in this page can resolve here.
  return waitForViewer(() => visibleViewers(documents()).filter(viewer =>
    viewer.labelledPdf && before.get(viewer.element) !== viewer.url.href), signal, partViewerMissing);
}

interface NativeAction {
  before: Set<Element>;
  at: number;
  dialog?: Element;
}
let nativeAction: NativeAction | undefined;

function rememberNative(event: Event) {
  const control = event.composedPath().find((node): node is HTMLElement => !!node && 'matches' in node &&
    (node as Element).matches('button,a,input,img[onclick],img[data-gx-evt],[role=button]') &&
    isAttachmentOpener(node as Element));
  if (!control) return;
  nativeAction = { before: new Set(dialogs()), at: Date.now() };
  queueScan();
}

function nativeContext(visible: Element[]) {
  if (!nativeAction) return;
  if (nativeAction.dialog && !visible.includes(nativeAction.dialog)) nativeAction = undefined;
  else if (!nativeAction.dialog && Date.now() - nativeAction.at < 10_000) {
    const opened = visible.filter(node => !nativeAction!.before.has(node));
    // Nested wrappers can describe the same window. Use the innermost new dialog.
    const isolated = opened.filter(node => !opened.some(other => other !== node && withinViewerScope(other, node)));
    if (isolated.length === 1) nativeAction.dialog = isolated[0];
  } else if (!nativeAction.dialog) nativeAction = undefined;
}

function scan() {
  const docs = documents();
  for (const [doc, watcher] of observer) {
    if (docs.includes(doc)) continue;
    watcher.disconnect();
    doc.removeEventListener('click', rememberNative, true);
    doc.removeEventListener('load', queueScan, true);
    observer.delete(doc);
  }
  for (const doc of docs) {
    if (!observer.has(doc)) {
      const watcher = new MutationObserver(queueScan);
      watcher.observe(doc, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['src', 'data', 'title', 'aria-label', 'class', 'style', 'hidden', 'open', 'aria-hidden',
          'aria-selected', 'aria-current', 'data-original-title', 'data-bs-original-title'] });
      observer.set(doc, watcher);
      doc.addEventListener('click', rememberNative, true);
      doc.addEventListener('load', queueScan, true);
    }
    watchPartPreview(doc);
  }
  for (const control of findControls(docs, isAttachmentOpener)) {
    addButton(control, ATTACHMENT_LABEL, signal => openAttachment(control, signal));
  }
  const onCase = isCaseUrl(document.URL);
  if (onCase) {
    addPartZipButton(document);
    for (const control of findControls(docs, isPartOpener)) {
      addButton(control, 'Ver firmas', signal => openPartFromRow(control, signal), false, PART_RESULT_LABEL);
    }
  }
  // The SGT also opens an untitled PDF window while Documentación Adjunta is active.
  const attachmentDocs = new Set(attachmentTabs(docs).filter(isAttachmentTabActive).map(tab => tab.ownerDocument));
  if (onCase && docs.some(doc => hasPartColumn(doc, isRendered))) attachmentDocs.add(document);
  const viewers = onCase || attachmentDocs.size ? visibleViewers(docs) : [];
  const visible = dialogs();
  for (const viewer of viewers) {
    if (![...attachmentDocs].some(doc => doc.body && withinViewerScope(viewer.element, doc.body)) ||
      visible.some(node => withinViewerScope(viewer.element, node))) continue;
    const window = floatingViewerWindow(viewer.element);
    if (window) visible.push(window);
  }
  nativeContext(visible);
  const possible = visible.filter(node => attachmentDocs.has(node.ownerDocument) && !dialogTitle(node) &&
    viewers.some(viewer => withinViewerScope(viewer.element, node)));
  const innermost = possible.filter(node => !possible.some(other => other !== node && withinViewerScope(other, node)));
  const unlabelled = innermost.length === 1 ? innermost[0] : null;
  const verifiedViewerScopes = new Set<Element>();
  for (const node of visible) {
    if (!approvalDialog(node) && (attachmentDialog(node) || nativeAction?.dialog === node || node === unlabelled)) {
      verifiedViewerScopes.add(node);
      const button = addButton(attachmentHeader(node), ATTACHMENT_LABEL, signal => {
        if (!isVisible(node)) throw new Error('Volvé a abrir el PDF desde la fila de Documentación Adjunta.');
        return waitForViewer(() => visibleViewers(documents()).filter(viewer => withinViewerScope(viewer.element, node)), signal);
      }, true);
      if (button) viewerButtons.set(node, button);
    }
  }
  for (const [node, button] of viewerButtons) {
    if (!verifiedViewerScopes.has(node)) {
      button.remove();
      viewerButtons.delete(node);
    }
  }
  const needsOpenPdf = onCase && !viewerButtons.size &&
    viewers.some(viewer => viewer.labelledPdf || floatingViewerWindow(viewer.element));
  if (needsOpenPdf && !openPdfButton?.isConnected) {
    openPdfButton = addButton(document.body, 'Ver firmas del PDF abierto', openDisplayedPdf, true);
    if (openPdfButton) Object.assign(openPdfButton.style, {
      position: 'fixed', right: '18px', top: '80px', zIndex: '2147483647', padding: '8px 12px',
    });
  } else if (!needsOpenPdf) {
    openPdfButton?.remove();
  }
}

function queueScan() {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    scan();
  }, 50);
}

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 120));

async function waitForViewer(find: () => Viewer[], signal: AbortSignal,
  missing = 'No se encontró un visor de PDF del adjunto. Volvé a abrir «Ver Documentación Adjunta».') {
  const ends = performance.now() + 9_000;
  let stableSince = 0;
  let prior = '';
  while (performance.now() < ends) {
    signal.throwIfAborted();
    const urls = [...new Map(find().map(viewer => [viewer.url.href, viewer.url])).values()];
    if (urls.length > 1) throw new Error(`Hay ${urls.length} visores posibles. Dejá abierto solo el PDF que querés verificar.`);
    if (urls.length === 1) {
      if (prior !== urls[0].href) {
        prior = urls[0].href;
        stableSince = performance.now();
      } else if (performance.now() - stableSince >= 480) return urls[0];
    } else {
      prior = '';
    }
    await pause();
  }
  throw new Error(missing);
}

async function openAttachment(control: HTMLElement, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!control.isConnected || !isVisible(control) || !localControl(control)) {
    throw new Error('Volvé a abrir la fila de Documentación Adjunta.');
  }
  const before = new Map(visibleViewers(documents()).map(viewer => [viewer.element, viewer.url.href]));
  control.click();
  return waitForViewer(() => {
    const active = nativeAction?.dialog;
    return visibleViewers(documents()).filter(viewer => before.get(viewer.element) !== viewer.url.href &&
      (!active || withinViewerScope(viewer.element, active)));
  }, signal);
}

function openDisplayedPdf(signal: AbortSignal) {
  return waitForViewer(() => {
    const visibleDialogs = dialogs();
    const approvals = visibleDialogs.filter(approvalDialog);
    const viewers = visibleViewers(documents()).filter(viewer => !approvals.some(node => withinViewerScope(viewer.element, node)));
    const scopes = visibleDialogs.filter(node => !approvalDialog(node));
    const scoped = viewers.filter(viewer => scopes.some(node => withinViewerScope(viewer.element, node)) ||
      floatingViewerWindow(viewer.element));
    return scoped.length ? scoped : viewers;
  }, signal);
}

scan();

if (isPartPreviewUrl(document.URL)) {
  void chrome.runtime.sendMessage({ kind: 'take-part' }).then((link: unknown) => {
    if (!isCaseLink(link)) return;
    void verify(PART_RESULT_LABEL, signal => {
      const current = previewCaseLink(document);
      if (current?.caseId !== link.caseId || current.part !== link.part) {
        throw new Error('El visor abrió una e-Parte distinta. Revisá el número y pulsá «Ver firmas» en la vista correcta.');
      }
      return openPartPdf(document, signal);
    });
  }).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || message?.kind !== 'verify-open-sgt') return;
  if (isPartPreviewUrl(document.URL)) {
    void verify(PART_RESULT_LABEL, signal => openPartPdf(document, signal));
  } else if (isCaseUrl(document.URL) || viewerButtons.size) {
    void verify('Ver firmas del PDF abierto', openDisplayedPdf);
  }
});
