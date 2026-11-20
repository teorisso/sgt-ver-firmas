import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium, type CDPSession } from 'playwright';
import { createFixtures } from './fixtures';

const fixtures = await createFixtures();
const pdf = Buffer.from(fixtures.single);
const partPdf = Buffer.from(fixtures.multiple);
const partHash = createHash('sha256').update(partPdf).digest('hex');
const hash = createHash('sha256').update(pdf).digest('hex');
const temp = await realpath(tmpdir());
const profile = await realpath(await mkdtemp(join(temp, 'sgt-firmas-brave-')));
assert.equal(dirname(profile), temp);
assert.match(basename(profile), /^sgt-firmas-brave-[a-z0-9]+$/i);
const dist = resolve('dist');
const executablePath = process.env.SGT_BROWSER_PATH ?? process.env.BRAVE_PATH ??
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const loadViaCdp = process.env.SGT_CDP_LOAD === '1';
const origin = 'https://app.chaco.gob.ar';
const original = '/sgt/recursos/visor?temporal=sintetico';
const previewPath = '/tramites/servlet/com.ecom.verpartedigital';
const casePath = '/tramites/servlet/com.ecom.vertramites';
const caseCode = 'E 19-2026-10042-Ae';
const fetches: string[] = [];
const partPath = '/sgt/parte.pdf';
const otherPdfPath = '/sgt/otro.pdf';

const fixture = `<!doctype html><html lang="es"><meta charset="utf-8"><title>SGT de prueba</title>
  <button title="Ver Documentación Adjunta"
    onclick="document.querySelector('#adjunto').hidden=false">Abrir</button>
  <div id="adjunto" hidden role="dialog" aria-label="Ver Documentación Adjunta">
    <object type="application/pdf" data="${original}" width="230" height="180"></object>
  </div>`;

function previewFixture(part: string, multiple: boolean) {
  return `<!doctype html><html lang="es"><meta charset="utf-8">
    <title>Trámite: ${caseCode} e-Parte Nro ${part} - Documento de prueba</title>
    <div>Trámite: ${caseCode} e-Parte Nro ${part} - Documento de prueba</div>
    <nav><a>1</a><a>2</a><strong>3</strong><a>4</a>
      <input id="volver" type="button" value="Volver"></nav>
    <object type="application/pdf" data="${partPath}" width="240" height="180"></object>
    ${multiple ? `<object type="application/pdf" data="${otherPdfPath}" width="240" height="180"></object>` : ''}`;
}

function ePartGridFixture(mode: string) {
  const target = previewPath + '?nro=' + (mode === 'distinta' ? '4' : '3');
  return `<!doctype html><html lang="es"><meta charset="utf-8"><title>${caseCode}</title>
    <table id="W003GridContainerTbl"><thead><tr><th></th><th>Nro.</th><th>Nombre</th><th></th></tr></thead>
      <tbody><tr><td><img title="Ver e-Parte" data-gx-evt="synthetic" width="24" height="24"
        src="/sgt/lupa.png" onclick="setTimeout(() => location.href='${target}',150)"></td>
        <td><span id="span_W003TRAMITEPARTEORDEN_0001">3</span></td>
        <td>Nombre de prueba</td>
        <td><img title="Ver detalle de la Aprobación y/o Firma Digital" data-gx-evt="synthetic" width="24" height="24" src="/sgt/lupa.png"></td></tr></tbody>
    </table>`;
}

const attachmentViewerFixture = (active: boolean, custom: boolean) => `<!doctype html><html lang="es"><meta charset="utf-8">
  <title>Trámite de prueba</title>
  <ul class="nav nav-tabs"><li ${active ? '' : 'class="active"'}><a role="tab" href="#partes"
    onclick="document.querySelector('.nav-tabs .active')?.classList.remove('active'); this.parentElement.classList.add('active')">e-Partes</a></li>
    <li ${active ? 'class="active"' : ''}><a href="#adjuntos">Documentación Adjunta</a></li></ul>
  <div ${custom ? 'style="position:fixed;left:150px;top:100px;background:white"' : 'class="modal" role="dialog" aria-label=""'}>
    <div class="modal-dialog"><div class="modal-content">
      <div class="${custom ? 'franja-superior' : 'modal-header'}"><button aria-label="Cerrar">×</button><h4 class="modal-title"></h4></div>
      <div class="modal-body"><object type="application/pdf" data="${original}" width="240" height="180"></object></div>
    </div></div>
  </div>`;

const toolbarFixture = `<!doctype html><html lang="es"><meta charset="utf-8"><title>${caseCode}</title>
  <div><object type="application/pdf" data="${original}" width="240" height="180"></object></div>`;

const pendingFixture = `<!doctype html><html lang="es"><meta charset="utf-8"><title>${caseCode}</title>
  <div><span>Documentación Adjunta</span></div>
  <table><thead><tr><th></th><th>Descripción</th><th>Estado</th><th>E-parte</th></tr></thead>
    <tbody><tr><td><button type="button" aria-label="Abrir PDF de prueba"
      onclick="document.querySelector('#visor').hidden=false">🔍</button></td>
      <td>Adjunto sintético pendiente</td><td>Pendiente</td><td></td></tr></tbody>
  </table><p>Página 1 de 2</p>
  <div id="visor" hidden style="position:fixed;left:180px;top:30px;background:white">
    <div id="franja"><button aria-label="Cerrar" onclick="document.querySelector('#visor').hidden=true">×</button></div>
    <iframe src="/sgt/envoltorio" width="360" height="230"></iframe>
  </div>`;

const geneXusViewer = `<!doctype html><html lang="es"><meta charset="utf-8"><title>${caseCode}</title>
  <div class="gx-popup">
    <div class="gx-popup-header"><span class="gx-popup-close">×</span></div>
    <div class="gx-popup-pdf"><iframe width="260" height="220" src="${original}"></iframe></div>
  </div>
  <table><thead><tr><th>Estado</th><th>E-parte</th></tr></thead><tbody><tr><td>Pendiente</td><td></td></tr></tbody></table>`;

async function accessibleNames(cdp: CDPSession) {
  return (await cdp.send('Accessibility.getFullAXTree')).nodes
    .flatMap(node => typeof node.name?.value === 'string' ? [node.name.value] : []).join('\n');
}

async function waitForText(cdp: CDPSession, expected: RegExp) {
  const deadline = Date.now() + 14_000;
  let observed = '';
  while (Date.now() < deadline) {
    observed = await accessibleNames(cdp);
    if (expected.test(observed)) return observed;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(observed, expected);
  return observed;
}

try {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true,
    args: loadViaCdp ? ['--enable-unsafe-extension-debugging'] :
      [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--disable-brave-rewards', '--no-first-run'],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  try {
    if (loadViaCdp) {
      const browser = context.browser();
      if (!browser) throw new Error('El perfil de prueba no expone DevTools.');
      const session = await browser.newBrowserCDPSession();
      await session.send('Extensions.loadUnpacked', { path: dist });
      await session.detach();
    }
    await context.addCookies([{ name: 'sesion_sintetica', value: 'activa', url: origin }]);
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/sgt/prueba') {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
      }
      if (url.pathname === previewPath) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8',
          body: previewFixture(url.searchParams.get('nro') === '4' ? '4' : '3', url.searchParams.has('varios')) });
      }
      if (url.pathname === casePath) {
        const mode = url.searchParams.get('grilla');
        if (mode) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: ePartGridFixture(mode) });
        if (url.searchParams.has('visor-gx')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: geneXusViewer });
        if (url.searchParams.has('pendiente')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: pendingFixture });
        if (url.searchParams.has('boton-brave')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: toolbarFixture });
        return route.fulfill({ contentType: 'text/html; charset=utf-8',
          body: attachmentViewerFixture(!url.searchParams.has('epartes'), url.searchParams.has('flotante')) });
      }
      if (url.pathname === '/sgt/envoltorio') {
        return route.fulfill({ contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><object type="application/pdf" data="${original}" width="300" height="200"></object>` });
      }
      if (url.pathname === '/sgt/recursos/visor') {
        if (request.resourceType() === 'fetch') {
          fetches.push(url.pathname + url.search);
          const headers = await request.allHeaders();
          if (!headers.cookie?.includes('sesion_sintetica=activa')) return route.fulfill({ status: 403 });
        }
        return route.fulfill({ contentType: 'application/pdf', body: pdf });
      }
      if (url.pathname === partPath || url.pathname === otherPdfPath) {
        if (request.resourceType() === 'fetch') fetches.push(url.pathname);
        return route.fulfill({ contentType: 'application/pdf', body: url.pathname === partPath ? partPdf : pdf });
      }
      return route.fulfill({ status: 404 });
    });

    const page = context.pages()[0] ?? await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await page.goto(origin + '/sgt/prueba?vista=adjuntos');
    await page.getByRole('button', { name: 'Ver firmas', exact: true }).click({ timeout: 12_000 });
    const fromAttachment = await waitForText(cdp, /Firma 1 · Empresa sintética 1/);
    assert.match(fromAttachment, /Integridad de la revisión/);
    assert.match(fromAttachment, /Verificado/);
    assert.match(fromAttachment, /No se pudo comprobar/);
    assert.ok(fromAttachment.includes(hash));
    assert.deepEqual(fetches, [original]);

    await page.goto(origin + casePath + '?navegacion-sintetica');
    const viewerButton = page.locator('.modal-header').getByRole('button', { name: 'Ver firmas', exact: true });
    await viewerButton.click({ timeout: 5_000 });
    const unlabelledViewer = await waitForText(cdp, /Firma 1 · Empresa sintética 1/);
    assert.ok(unlabelledViewer.includes(hash));
    assert.deepEqual(fetches, [original, original]);

    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'e-Partes' }).click();
    await viewerButton.waitFor({ state: 'detached', timeout: 5_000 });

    await page.goto(origin + casePath + '?epartes');
    await page.waitForLoadState('load');
    assert.equal(await viewerButton.count(), 0);

    await page.goto(origin + casePath + '?flotante');
    const customButton = page.locator('.franja-superior').getByRole('button', { name: 'Ver firmas', exact: true });
    await customButton.click({ timeout: 5_000 });
    const customViewer = await waitForText(cdp, /Firma 1 · Empresa sintética 1/);
    assert.ok(customViewer.includes(hash));
    assert.deepEqual(fetches, [original, original, original]);

    const previewButton = page.locator('#volver + button').and(page.getByRole('button', { name: 'Ver firmas', exact: true }));
    await page.goto(origin + previewPath + '?nro=3');
    await previewButton.click({ timeout: 5_000 });
    const previewPdf = await waitForText(cdp, /Firma 2 · Empresa sintética 2/);
    assert.match(previewPdf, /Firmas del PDF de e-Parte/);
    assert.ok(previewPdf.includes(partHash));
    assert.deepEqual(fetches, [original, original, original, partPath]);

    await page.goto(origin + casePath + '?grilla=normal');
    await page.locator('img[title="Ver e-Parte"] + button').click({ timeout: 5_000 });
    await page.waitForURL('**' + previewPath + '?nro=3');
    const rowPdf = await waitForText(cdp, /Firma 2 · Empresa sintética 2/);
    assert.ok(rowPdf.includes(partHash));
    assert.deepEqual(fetches, [original, original, original, partPath, partPath]);

    await page.goto(origin + casePath + '?grilla=distinta');
    await page.locator('img[title="Ver e-Parte"] + button').click({ timeout: 5_000 });
    await page.waitForURL('**' + previewPath + '?nro=4');
    await waitForText(cdp, /El visor abrió una e-Parte distinta/);
    assert.deepEqual(fetches, [original, original, original, partPath, partPath]);

    await page.goto(origin + previewPath + '?nro=3&varios');
    await previewButton.click({ timeout: 5_000 });
    await waitForText(cdp, /Hay 2 visores posibles/);
    assert.deepEqual(fetches, [original, original, original, partPath, partPath]);

    await page.goto(origin + casePath + '?pendiente');
    await page.getByRole('button', { name: 'Abrir PDF de prueba' }).click();
    await page.locator('#franja').getByRole('button', { name: 'Ver firmas', exact: true }).click({ timeout: 5_000 });
    const fromPending = await waitForText(cdp, /Firma 1 · Empresa sintética 1/);
    assert.ok(fromPending.includes(hash));
    assert.equal(page.url(), origin + casePath + '?pendiente');
    assert.deepEqual(fetches, [original, original, original, partPath, partPath, original]);

    await page.goto(origin + casePath + '?boton-brave');
    await page.getByRole('button', { name: 'Ver firmas del PDF abierto' }).waitFor({ timeout: 5_000 });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(candidate => candidate.url === url);
      if (tab?.id === undefined) throw new Error('No se encontró la pestaña simulada.');
      await chrome.tabs.sendMessage(tab.id, { kind: 'verify-open-sgt' }, { frameId: 0 });
    }, page.url());
    const fromToolbar = await waitForText(cdp, /Firma 1 · Empresa sintética 1/);
    assert.ok(fromToolbar.includes(hash));
    assert.deepEqual(fetches, [original, original, original, partPath, partPath, original, original]);

    await page.goto(origin + casePath + '?visor-gx');
    const gxButton = page.locator('.gx-popup-header').getByRole('button', { name: 'Ver firmas', exact: true });
    await gxButton.click({ timeout: 5_000 });
    const gxPdf = await waitForText(cdp, /Firma 1 · Empresa sintética 1/);
    assert.ok(gxPdf.includes(hash));
    assert.deepEqual(fetches, [original, original, original, partPath, partPath, original, original, original]);

    assert.deepEqual(errors, []);
    console.log('Manifest V3: PDF de e-Parte desde fila y visor, adjunto pendiente y visor GeneXus comprobados.');
  } finally {
    await context.close();
  }
} finally {
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
