// eslint-disable-next-line import/no-cycle
import { ScribeViewer } from '../viewer.js';

/** @param {import('../viewer.js').ScribeViewer} viewer */
export const deleteSelectedLayoutDataTable = (viewer) => {
  const _viewer = viewer || ScribeViewer.getDefault();
  const selectedColumns = _viewer.CanvasSelection.getUiDataColumns();
  if (selectedColumns.length === 0) return;

  _viewer.doc.deleteLayoutDataTable(selectedColumns[0].uiTable.layoutDataTable, _viewer.state.cp.n);

  selectedColumns[0].uiTable.destroy();
  _viewer.destroyControls();
};

/** @param {import('../viewer.js').ScribeViewer} viewer */
export const deleteSelectedLayoutRegion = (viewer) => {
  const _viewer = viewer || ScribeViewer.getDefault();
  const selectedRegions = _viewer.CanvasSelection.getUiRegions();
  if (selectedRegions.length === 0) return;

  selectedRegions.forEach((region) => {
    _viewer.doc.deleteLayoutRegion(region.layoutBox, _viewer.state.cp.n);
    region.destroy();
  });
  _viewer.destroyControls();
};
