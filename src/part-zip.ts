import { BlobReader, BlobWriter, ZipReader, ZipWriter, type FileEntry } from '@zip.js/zip.js/lib/zip-core-native.js';
import { canonicalCase, partNumber } from './case-link';

export interface PartIdentity {
  id: string;
  number: string;
}

export interface TitledPart extends PartIdentity {
  title: string;
}

export const zipSizeLimit = 512 * 1024 * 1024;
export const zipTooLarge = 'El ZIP supera el límite de 512 MiB de la extensión.';
const zipOptions = { useWebWorkers: false };

export function internalPartId(value: string) {
  const id = value.trim().replace(/^0+(?=\d)/, '');
  return /^[1-9]\d{0,19}$/.test(id) ? id : null;
}

function entryPart(filename: string, caseId: string): PartIdentity {
  const basename = filename.split(/[/\\]/).pop() ?? '';
  const match = /^(.+)-(\d+)-(\d+)\.pdf$/i.exec(basename);
  const number = partNumber(match?.[2] ?? '');
  const id = internalPartId(match?.[3] ?? '');
  if (!match || !number || !id) throw new Error('El archivo no tiene el formato del ZIP de e-Partes del SGT.');
  if (canonicalCase(match[1]) !== caseId) throw new Error('El ZIP corresponde a otro trámite.');
  return { id, number };
}

function numberedFilename(part: TitledPart, digits: number) {
  const clean = part.title.normalize('NFC').trim().replace(/\.pdf$/i, '')
    .replace(/\p{Cc}/gu, ' ').replace(/\s*[<>:"/\\|?*]+\s*/g, ' - ')
    .replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
  const characters = [...clean].slice(0, 180);
  const encoder = new TextEncoder();
  while (encoder.encode(characters.join('')).length > 180) characters.pop();
  const title = characters.join('').replace(/[\s.]+$/g, '') || 'e-Parte';
  return `${part.number.padStart(digits, '0')} - ${title}.pdf`;
}

export async function renamePartZip(file: Blob, caseId: string,
  findTitles: (parts: readonly PartIdentity[]) => Promise<ReadonlyMap<string, TitledPart>>, signal: AbortSignal) {
  signal.throwIfAborted();
  if (file.size > zipSizeLimit) throw new Error(zipTooLarge);
  const reader = new ZipReader(new BlobReader(file), zipOptions);
  try {
    const entries = new Map<string, FileEntry>();
    const parts: PartIdentity[] = [];
    const numbers = new Set<string>();
    let total = 0;
    const iterator = reader.getEntriesGenerator();
    for (;;) {
      signal.throwIfAborted();
      const { value: entry, done } = await iterator.next().catch(() => {
        throw new Error('No se pudo leer el ZIP. Seleccioná una descarga de e-Partes del SGT.');
      });
      if (done) break;
      if (entry.directory) continue;
      const part = entryPart(entry.filename, caseId);
      if (entries.has(part.id) || numbers.has(part.number)) {
        throw new Error('El ZIP contiene identificadores o números de e-Parte repetidos.');
      }
      if (entry.encrypted || entry.uncompressedSize < 1) throw new Error('El ZIP contiene un PDF vacío o cifrado en el archivo.');
      total += entry.uncompressedSize;
      if (total > zipSizeLimit) throw new Error(zipTooLarge);
      parts.push(part);
      numbers.add(part.number);
      entries.set(part.id, entry);
    }
    if (!parts.length) throw new Error('El ZIP no contiene PDFs de e-Partes.');

    const titles = await findTitles(parts);
    const missing = parts.filter(part => !titles.has(part.id)).length;
    if (missing) {
      throw new Error(`Faltan títulos para ${missing} de ${parts.length} PDFs. Quitá los filtros de e-Partes y volvé a intentarlo.`);
    }
    const ordered = parts.map(part => {
      const row = titles.get(part.id);
      if (!row || row.id !== part.id || row.number !== part.number || !row.title.trim()) {
        throw new Error('Los identificadores o números del ZIP no coinciden con los de la grilla del trámite.');
      }
      return row;
    }).sort((a, b) => Number(a.number) - Number(b.number));

    const digits = Math.max(2, ordered[ordered.length - 1].number.length);
    const writer = new ZipWriter(new BlobWriter('application/zip'), zipOptions);
    try {
      for (const part of ordered) {
        signal.throwIfAborted();
        const pdf = await entries.get(part.id)!.getData(new BlobWriter('application/pdf'), {
          checkSignature: true, checkOverlappingEntry: true, signal,
        });
        await writer.add(numberedFilename(part, digits), new BlobReader(pdf), { level: 0, signal });
      }
      return { zip: await writer.close(), count: ordered.length };
    } catch {
      signal.throwIfAborted();
      throw new Error('No se pudo copiar íntegramente uno de los PDFs del ZIP. Volvé a descargarlo desde el SGT.');
    }
  } finally {
    await reader.close();
  }
}
