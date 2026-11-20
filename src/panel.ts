import type { SignatureResult } from './verify';
import manifest from '../manifest.json';

const labels = {
  valid: 'Verificado', invalid: 'Inválido', good: 'No revocado según las listas verificadas',
  revoked: 'Revocado', unknown: 'No se pudo comprobar',
};

export function createPanel(doc: Document, title: string, onClose: () => void) {
  const host = doc.createElement('dialog');
  host.setAttribute('data-sgt-firmas-panel', '');
  host.setAttribute('aria-label', title);
  Object.assign(host.style, {
    position: 'fixed', inset: '0', width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none',
    margin: '0', border: '0', padding: '0', background: 'transparent',
  });
  const surface = doc.createElement('div');
  const shadow = surface.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host{all:initial;position:absolute;inset:0;font-family:system-ui,sans-serif;color:#152535}
    .backdrop{position:absolute;inset:0;display:grid;place-items:center;background:#10243988;padding:16px;box-sizing:border-box}
    section{box-sizing:border-box;width:min(100%,620px);max-height:90vh;overflow:auto;background:#fff;border-radius:12px;
      box-shadow:0 12px 42px #10243955;padding:22px}
    header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border-bottom:1px solid #d8e4eb;padding-bottom:14px}
    h2,h3,p,dl,dd{margin:0;overflow-wrap:anywhere} h2{font-size:20px} h3{font-size:16px}
    button{font:inherit;cursor:pointer;color:#164668;background:#f3f8fb;border:1px solid #9bb9cd;border-radius:6px;padding:4px 9px}
    button:focus-visible{outline:2px solid #0075b7;outline-offset:2px}
    article{border:1px solid #d8e4eb;background:#f7fafc;border-radius:8px;margin-top:12px;padding:14px}
    p{margin-top:12px;line-height:1.45;font-size:14px} dl{font-size:14px;display:grid;grid-template-columns:minmax(110px,auto) 1fr;
      gap:6px 12px;margin-top:10px} dt{font-weight:600}
    .fingerprint,.version{color:#344c5e;font-size:12px} code{display:block;margin-top:4px;user-select:all}
  `);
  shadow.adoptedStyleSheets = [sheet];

  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const backdrop = element('div');
  backdrop.className = 'backdrop';
  const section = element('section');
  const heading = element('h2', title);
  const close = element('button', 'Cerrar');
  close.type = 'button';

  const previous = doc.activeElement;
  const dismiss = () => {
    host.close();
    host.remove();
    onClose();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  };
  close.addEventListener('click', dismiss);
  host.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  section.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      dismiss();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      close.focus();
    }
  });

  const header = element('header');
  header.append(heading, close);
  const status = element('p', 'Buscando el PDF…');
  status.setAttribute('role', 'status');
  const list = element('div');
  const fingerprint = element('p');
  fingerprint.className = 'fingerprint';
  const version = element('p', `SGT · Ver firmas ${manifest.version}`);
  version.className = 'version';
  section.append(header, status, list, fingerprint, version);
  backdrop.append(section);
  shadow.append(backdrop);
  host.append(surface);
  doc.body.append(host);
  host.showModal();
  close.focus();

  return {
    bringToFront() {
      host.close();
      host.showModal();
      close.focus();
    },
    status(text: string) { status.textContent = text; },
    results(signatures: SignatureResult[], sha256: string) {
      const count = signatures.filter(signature => signature.kind === 'signature').length;
      const stamps = signatures.length - count;
      status.textContent = signatures.length === 0 ? 'No se encontraron firmas digitales en el PDF.'
        : `${count} ${count === 1 ? 'firma digital' : 'firmas digitales'}${stamps ? ` · ${stamps} sello(s) documental(es)` : ''}`;
      list.replaceChildren(...signatures.map((signature, index) => {
        const details = element('dl');
        const changes = signature.laterChanges === null ? labels.unknown
          : signature.laterChanges ? 'Sí, hay bytes posteriores a la revisión firmada.' : 'No se detectaron bytes posteriores.';
        const date = signature.verifiedTimestamp
          ? new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'long', timeZone: 'America/Argentina/Buenos_Aires' })
            .format(new Date(signature.verifiedTimestamp)) : '';
        for (const [key, value] of [
          ['Emisor del certificado', signature.issuer],
          ['Integridad de la revisión', labels[signature.integrity]],
          ['Confianza de la cadena', labels[signature.confidence]],
          ['Revocación', labels[signature.revocation]],
          ['Cambios posteriores', changes],
          ['Sello de tiempo', date ? `${labels[signature.timestamp]} · ${date}` : labels[signature.timestamp]],
        ]) details.append(element('dt', key), element('dd', value));
        const card = element('article');
        const kind = signature.kind === 'document-timestamp' ? 'Sello documental' : 'Firma';
        card.append(element('h3', `${kind} ${index + 1} · ${signature.signer}`), details);
        return card;
      }));
      fingerprint.replaceChildren(doc.createTextNode('Huella SHA-256 del PDF'), element('code', sha256));
    },
  };
}
