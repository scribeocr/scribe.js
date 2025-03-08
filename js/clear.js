import { inputData } from './containers/app.js';
import {
  convertPageWarn,
  layoutDataTables,
  layoutRegions,
  ocrAll,
  ocrAllRaw,
  pageMetricsArr,
} from './containers/dataContainer.js';
import { FontCont } from './containers/fontContainer.js';
import { ImageCache } from './containers/imageContainer.js';
import { replaceObjectProperties } from './utils/miscUtils.js';

export function clearData() {
  inputData.clear();
  replaceObjectProperties(ocrAll, { active: [] });
  replaceObjectProperties(ocrAllRaw, { active: [] });
  layoutRegions.pages.length = 0;
  layoutDataTables.pages.length = 0;
  pageMetricsArr.length = 0;
  convertPageWarn.length = 0;
  ImageCache.clear();
  FontCont.clear();
}
