import { inputData } from './containers/app.js';
import {
  convertPageWarn,
  layoutDataTables,
  layoutRegions,
  ocrAll,
  ocrAllRaw,
  pageMetricsAll,
} from './containers/dataContainer.js';
import { FontCont } from './containers/fontContainer.js';
import { ImageCache } from './containers/imageContainer.js';
import { clearObjectProperties } from './utils/miscUtils.js';

export function clearData() {
  inputData.clear();
  clearObjectProperties(ocrAll);
  ocrAll.active = [];
  clearObjectProperties(ocrAllRaw);
  ocrAllRaw.active = [];
  layoutRegions.pages.length = 0;
  layoutDataTables.pages.length = 0;
  pageMetricsAll.length = 0;
  convertPageWarn.length = 0;
  ImageCache.clear();
  FontCont.clear();
}
