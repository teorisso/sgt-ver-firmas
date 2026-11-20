import { isCaseLink, type CaseLink } from './case-link';
import { isCaseUrl, isPartPreviewUrl, ORIGIN, sgtUrl } from './sgt';

const pending = new Map<number, { link: CaseLink; expires: number }>();
const ttl = 25_000;

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const id = sender.tab?.id;
  const url = sender.url;
  if (id === undefined || !url || sender.frameId !== 0) return;
  if (message?.kind === 'queue-part' && isCaseUrl(url) && isCaseLink(message.link)) {
    const { caseId, part } = message.link;
    const item = { link: { caseId, part }, expires: Date.now() + ttl };
    pending.set(id, item);
    setTimeout(() => { if (pending.get(id) === item) pending.delete(id); }, ttl);
    respond(true);
  } else if (message?.kind === 'take-part' && isPartPreviewUrl(url)) {
    const item = pending.get(id);
    pending.delete(id);
    respond(item && item.expires > Date.now() ? item.link : null);
  }
});

chrome.tabs.onRemoved.addListener(tabId => pending.delete(tabId));

chrome.action.onClicked.addListener(tab => {
  if (tab.id === undefined || !tab.url || !sgtUrl(tab.url, ORIGIN)) return;
  void chrome.tabs.sendMessage(tab.id, { kind: 'verify-open-sgt' }, { frameId: 0 }).catch(() => undefined);
});
