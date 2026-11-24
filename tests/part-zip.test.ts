import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BlobReader, BlobWriter, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js/lib/zip-core-native.js';
import { renamePartZip } from '../src/part-zip';

const caseId = 'E 19-2026-10042-AE';
const base = 'var/lib/tomcat8/webapps/tramites/PublicTempStorage/E 19-2026-10042-Ae';
const pdfA = new Blob(['%PDF-1.7\nContenido de la parte 1\n%%EOF']);
const pdfB = new Blob(['%PDF-1.7\nContenido de la parte 12\n%%EOF']);

async function inputZip(files: [string, Blob][]) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [path, pdf] of files) await writer.add(path, new BlobReader(pdf));
  return writer.close();
}

test('renombra por ID y número, ordena por número y preserva los bytes de cada PDF', async () => {
  const archive = await inputZip([[base + '-12-81234568.pdf', pdfB], [base + '-1-81234567.pdf', pdfA]]);
  const signal = new AbortController().signal;
  const result = await renamePartZip(archive, caseId, async parts => {
    assert.deepEqual(parts, [{ id: '81234568', number: '12' }, { id: '81234567', number: '1' }]);
    return new Map([
      ['81234568', { id: '81234568', number: '12', title: 'Medición: obra / anexo.pdf' }],
      ['81234567', { id: '81234567', number: '1', title: 'Medición: obra / anexo.pdf' }],
    ]);
  }, signal);
  const output = new ZipReader(new BlobReader(result.zip), { useWebWorkers: false });
  try {
    const entries = await output.getEntries();
    assert.deepEqual(entries.map(entry => entry.filename), ['01 - Medición - obra - anexo.pdf', '12 - Medición - obra - anexo.pdf']);
    for (const [index, entry] of entries.entries()) {
      assert.equal(entry.directory, false);
      assert.deepEqual(await entry.getData(new Uint8ArrayWriter()), new Uint8Array(await [pdfA, pdfB][index].arrayBuffer()));
    }
  } finally {
    await output.close();
  }
});

test('rechaza un ZIP de otro trámite antes de buscar títulos', async () => {
  const archive = await inputZip([[base.replace('10042', '10043') + '-1-81234567.pdf', pdfA]]);
  await assert.rejects(renamePartZip(archive, caseId, async () => {
    assert.fail('No corresponde consultar la grilla.');
  }, new AbortController().signal), /otro trámite/i);
});

test('rechaza un ZIP con un mismo identificador en dos entradas', async () => {
  const archive = await inputZip([[base + '-1-81234567.pdf', pdfA], [base + '-2-81234567.pdf', pdfB]]);
  await assert.rejects(renamePartZip(archive, caseId, async () => {
    assert.fail('No corresponde consultar la grilla.');
  }, new AbortController().signal), /repetid/i);
});

test('rechaza un número distinto para el mismo identificador', async () => {
  const archive = await inputZip([[base + '-1-81234567.pdf', pdfA]]);
  await assert.rejects(renamePartZip(archive, caseId, async () => new Map([
    ['81234567', { id: '81234567', number: '2', title: 'Documento de prueba' }],
  ]), new AbortController().signal), /no coinciden/i);
});
