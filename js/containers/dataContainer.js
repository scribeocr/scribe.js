// This file contains various objects that are imported by other modules.
// Everything here is essentially a global variable; none of them are technically "containers".

export class layoutRegions {
  /** @type {Array<LayoutPage>} */
  static pages = [];

  /**
   *
   * @param {LayoutRegion} region - Region to delete.
   * @param {number} n - Page number.
   */
  static deleteLayoutRegion(region, n) {
    for (const [key, value] of Object.entries(this.pages[n].boxes)) {
      if (value.id === region.id) {
        delete this.pages[n].boxes[key];
        break;
      }
    }
  }
}

export class layoutDataTables {
  /** @type {Array<LayoutDataTablePage>} */
  static pages = [];

  /**
   * Serialize the layout data tables as JSON.
   * A special function is needed to remove circular references.
   */
  static serialize() {
    const pages = structuredClone(this.pages);
    pages.forEach((page) => {
      page.tables.forEach((table) => {
        // @ts-ignore
        delete table.page;
        table.boxes.forEach((box) => {
          // @ts-ignore
          delete box.table;
        });
      });
    });
    return JSON.stringify(pages);
  }

  /**
   *
   * @param {LayoutDataTable} table - Table to delete.
   * @param {number} n - Page number.
   */
  static deleteLayoutDataTable(table, n) {
    const idx = this.pages[n].tables.findIndex((t) => t.id === table.id);
    if (idx >= 0) {
      this.pages[n].tables.splice(idx, 1);
    }
  }
}

/** @type {Object<string, Array<import('../objects/ocrObjects.js').OcrPage>>} */
export const ocrAll = { active: [] };

/** @type {Object<string, Array<string>>} */
export const ocrAllRaw = { active: [] };

/** @type {Array<PageMetrics>} */
export const pageMetricsAll = [];

/**
 * Class that stores various debug data.
 * Although this object contains useful information, it should not be referenced directly in code,
 * except for debugging features.
 */
export class DebugData {
  /** @type {{[key: string]: Array<Array<CompDebugBrowser|CompDebugNode>> | undefined}} */
  static debugImg = {};
}

/** @type {Array<Awaited<ReturnType<typeof import('../../scrollview-web/scrollview/ScrollView.js').ScrollView.prototype.getAll>>>} */
export const visInstructions = [];

/** @type {Array<Object<string, string>>} */
export const convertPageWarn = [];
