import scribe from '../../scribe.js';
// eslint-disable-next-line import/no-cycle
import { ScribeViewer } from '../viewer.js';

export const deleteSelectedLayoutDataTable = () => {
  const selectedColumns = ScribeViewer.CanvasSelection.getKonvaDataColumns();
  if (selectedColumns.length === 0) return;

  scribe.data.layoutDataTables.deleteLayoutDataTable(selectedColumns[0].konvaTable.layoutDataTable, ScribeViewer.state.cp.n);

  selectedColumns[0].konvaTable.destroy();
  ScribeViewer.destroyControls();
  ScribeViewer.layerOverlay.batchDraw();
};

export const deleteSelectedLayoutRegion = () => {
  const selectedRegions = ScribeViewer.CanvasSelection.getKonvaRegions();
  if (selectedRegions.length === 0) return;

  selectedRegions.forEach((region) => {
    scribe.data.layoutRegions.deleteLayoutRegion(region.layoutBox, ScribeViewer.state.cp.n);
    region.destroy();
  });
  ScribeViewer.destroyControls();
  ScribeViewer.layerOverlay.batchDraw();
};
