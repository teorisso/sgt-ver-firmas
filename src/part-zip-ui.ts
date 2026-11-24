import { caseIdFromTitle, partNumber } from './case-link';
import { createPanel } from './panel';
import { internalPartId, renamePartZip, type PartIdentity, type TitledPart } from './part-zip';
import { getSgtPartZip } from './part-zip-source';
import { isVisible } from './viewer';

const label = 'Descargar ZIP con títulos';
const gridMissing = 'No se pudo leer la grilla de e-Partes. Abrí esa pestaña y volvé a intentarlo.';
const stoppedPaging = 'No se pudo recorrer toda la grilla de e-Partes. Quitá los filtros y volvé a intentarlo.';
const nativeButton = 'input[id$="BTNIMPRIMIRCOMPLETO"][value="Descargar E-Partes (ZIP)" i]';

function readPage(doc: Document, caseId: string, prefix: string) {
  if (caseIdFromTitle(doc.title) !== caseId) throw new Error('El trámite cambió durante la operación.');
  const wrapper = doc.getElementById(prefix + 'GRIDTABLEWITHPAGINATIONBAR');
  const table = doc.getElementById(prefix + 'GridContainerTbl');
  if (!wrapper || !table || !wrapper.contains(table) || !isVisible(table)) return;

  const pagination = wrapper.querySelector('ul.pagination');
  const page = /Página\s+(\d+)\s+de\s+(\d+)/i.exec(wrapper.innerText);
  const current = Number(page?.[1]);
  const total = Number(page?.[2]);
  if (!page || current < 1 || current > total || Number(pagination?.querySelector('.active')?.textContent) !== current) return;

  const fieldPrefix = 'span_' + prefix + 'TRAMITEPARTE';
  const rows: TitledPart[] = [];
  for (const field of table.querySelectorAll<HTMLElement>(`span[id^="${fieldPrefix}ID_"]`)) {
    const suffix = field.id.slice((fieldPrefix + 'ID_').length);
    if (!/^\d+$/.test(suffix)) continue;
    const row = field.closest('tr');
    const id = internalPartId(field.textContent ?? '');
    const number = partNumber(row?.querySelector(`#${fieldPrefix}ORDEN_${suffix}`)?.textContent ?? '');
    const title = row?.querySelector(`#${fieldPrefix}NOMBRE_${suffix}`)?.textContent?.trim();
    if (id && number && title) rows.push({ id, number, title });
  }
  return { current, total, rows, pagination, key: rows.map(row => row.id).join(',') };
}

async function collectTitles(doc: Document, caseId: string, prefix: string, parts: readonly PartIdentity[],
  status: (text: string) => void, signal: AbortSignal) {
  const initial = readPage(doc, caseId, prefix);
  if (!initial) throw new Error(gridMissing);
  let page = initial;
  const titles = new Map<string, TitledPart>();
  const wanted = new Set(parts.map(part => part.id));

  const readTitles = () => {
    status(`Leyendo títulos de e-Partes · página ${page.current} de ${page.total}…`);
    for (const row of page.rows) {
      if (!wanted.has(row.id)) continue;
      const previous = titles.get(row.id);
      if (previous && (previous.number !== row.number || previous.title !== row.title)) {
        throw new Error('La grilla muestra datos distintos para el mismo identificador de e-Parte.');
      }
      titles.set(row.id, row);
    }
  };

  const step = async (direction: 1 | -1) => {
    signal.throwIfAborted();
    const expected = page.current + direction;
    const side = direction === 1 ? 'next' : 'prev';
    const link = page.pagination?.querySelector<HTMLAnchorElement>(`li.${side}:not(.disabled) > a`);
    const href = link?.getAttribute('href')?.trim();
    if (!link?.isConnected || (href && !href.startsWith('#'))) throw new Error(stoppedPaging);
    link.click();
    const deadline = performance.now() + 8_000;
    while (performance.now() < deadline) {
      signal.throwIfAborted();
      const next = readPage(doc, caseId, prefix);
      if (next?.current === expected && next.total === page.total && next.key && next.key !== page.key) {
        page = next;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(stoppedPaging);
  };

  readTitles();
  try {
    // Search from the visible page first. If needed, walk back through the preceding pages.
    while (titles.size < wanted.size && page.current < page.total) {
      await step(1);
      readTitles();
    }
    while (titles.size < wanted.size && page.current > 1) {
      await step(-1);
      if (page.current < initial.current) readTitles();
    }
  } finally {
    while (!signal.aborted && page.current !== initial.current) {
      await step(page.current > initial.current ? -1 : 1);
    }
  }
  status('Armando el ZIP con los títulos del SGT…');
  return titles;
}

async function downloadPartZip(native: HTMLInputElement, caseId: string, prefix: string) {
  const doc = native.ownerDocument;
  const controller = new AbortController();
  const { signal } = controller;
  const panel = createPanel(doc, label, () => controller.abort());
  panel.status('Esperando que el SGT prepare las e-Partes…');
  try {
    if (!readPage(doc, caseId, prefix)) throw new Error(gridMissing);
    const file = await getSgtPartZip(native, signal);
    panel.status('Leyendo el ZIP del SGT…');
    const result = await renamePartZip(file, caseId,
      parts => collectTitles(doc, caseId, prefix, parts, panel.status, signal), signal);
    signal.throwIfAborted();
    const url = URL.createObjectURL(result.zip);
    const link = doc.createElement('a');
    link.href = url;
    link.download = `${caseId} - e-Partes.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    panel.status(`Descarga iniciada · ${result.count} ${result.count === 1 ? 'PDF' : 'PDFs'}`);
  } catch (error) {
    if (!signal.aborted) panel.status(error instanceof Error ? error.message : 'No se pudo preparar el ZIP.');
  }
}

export function addPartZipButton(doc: Document) {
  for (const native of doc.querySelectorAll<HTMLInputElement>(nativeButton)) {
    const prefix = /^(W\d+)BTNIMPRIMIRCOMPLETO$/.exec(native.id)?.[1];
    if (!prefix || native.nextElementSibling?.hasAttribute('data-sgt-part-zip')) continue;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = native.className;
    button.textContent = label;
    button.setAttribute('data-sgt-part-zip', '');
    button.style.marginInlineStart = '6px';
    button.addEventListener('click', event => {
      if (!event.isTrusted || doc.querySelector('[data-sgt-firmas-panel]')) return;
      event.preventDefault();
      event.stopPropagation();
      const caseId = caseIdFromTitle(doc.title);
      if (caseId) void downloadPartZip(native, caseId, prefix);
      else createPanel(doc, label, () => undefined).status('No se pudo identificar el número del trámite abierto.');
    });
    native.after(button);
  }
}
