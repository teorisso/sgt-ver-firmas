import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { gridCaseLink, previewCaseLink } from '../src/case-link';

const path = 'https://app.chaco.gob.ar/tramites/servlet/com.ecom.';

function fixture(view: string, title: string, html: string) {
  const window = new Window({ url: path + view + '?opaco' });
  window.document.title = title;
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
}

test('identifica la e-Parte que abre la lupa por campo de GeneXus y título del trámite', () => {
  const doc = fixture('vertramites', 'E 19-2026-10042-Ae', `<table><tbody><tr>
    <td><img id="lupa" title="Ver e-Parte"></td><td><span id="span_W0003TRAMITEPARTEORDEN_0001">3</span></td>
    <td><span id="span_W0003TRAMITEPARTEORDENPRINCIPAL_0001">73</span></td></tr></tbody></table>`);
  const preview = fixture('verpartedigital', 'Trámite: E 19-2026-10042-Ae e-Parte Nro 3 - Documento de prueba', '');
  const observed = gridCaseLink(doc.querySelector('#lupa')!, doc);
  assert.deepEqual(observed, { caseId: 'E 19-2026-10042-AE', part: '3' });
  assert.deepEqual(previewCaseLink(preview), observed);
});

test('no infiere la e-Parte de los botones de navegación ni de un campo sin nombre', () => {
  const preview = fixture('verpartedigital', 'Trámite: E 19-2026-10042-Ae', '<nav><a>3</a></nav>');
  const doc = fixture('vertramites', 'E 19-2026-10042-Ae',
    '<table><tr><td><img id="lupa" title="Ver e-Parte"></td><td>3</td></tr></table>');
  assert.equal(previewCaseLink(preview), null);
  assert.equal(gridCaseLink(doc.querySelector('#lupa')!, doc), null);
});
