import { sgtUrl } from './sgt';

export const zipPopupPath = '/tramites/servlet/com.ecom.bajar10partes';
const zipArchivePath = '/tramites/servlet/com.ecom.abajardeavariaspartes';
export const zipConfirmEvent = 'sgt-part-zip-confirm';
export const zipResultEvent = 'sgt-part-zip-result';
export const zipGenerationTimeout = 90_000;

export function partArchiveUrl(value: string, popupUrl: string) {
  const url = sgtUrl(value, popupUrl);
  if (url?.pathname.toLowerCase() !== zipArchivePath) return null;
  return url;
}

export function zipPopupLevel(popupUrl: URL) {
  // GeneXus carries this setting in the popup navigation, separate from its opaque case parameters.
  return popupUrl.search.slice(1).split(',').find(value => /^gxPopupLevel%3D\d+%3B$/i.test(value));
}
