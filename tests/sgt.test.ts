import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { findControls, isAttachmentOpener, isPartOpener, sgtUrl } from '../src/sgt';

const origin = 'https://app.chaco.gob.ar';

test('acepta el origen exacto y bloquea credenciales, subdominios y otros esquemas', () => {
  for (const url of ['https://otro.gob.ar/archivo.pdf', 'http://app.chaco.gob.ar/a.pdf',
    'https://x@app.chaco.gob.ar/a.pdf', 'https://app.chaco.gob.ar.ejemplo.org/a.pdf', 'blob:https://app.chaco.gob.ar/id']) {
    assert.equal(sgtUrl(url, origin), null);
  }
  assert.equal(sgtUrl('/tramites/temporal.pdf#page=2', origin)?.href, origin + '/tramites/temporal.pdf');
});

test('reconoce las lupas nativas y distingue el icono del detalle de aprobación', () => {
  const window = new Window({ url: origin });
  window.document.body.innerHTML = `<img id="part" data-gx-evt="synthetic" title="Ver e-Parte">
    <img id="approval" data-gx-evt="synthetic" title="Ver detalle de la Aprobación y/o Firma Digital">
    <img id="attachment" data-gx-evt="synthetic" title="Ver Documentación Adjunta">`;
  const doc = window.document as unknown as Document;
  assert.deepEqual(findControls([doc], isPartOpener).map(node => node.id), ['part']);
  assert.deepEqual(findControls([doc], isAttachmentOpener).map(node => node.id), ['attachment']);
});
