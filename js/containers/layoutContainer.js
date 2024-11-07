export class LayoutRegions {
  constructor() {
  /** @type {Array<LayoutPage>} */
    this.pages = [];

    /** @type {Object<string, LayoutRegion>} */
    this.defaultRegions = {};

    /**
     *
     * @param {LayoutRegion} region - Region to delete.
     * @param {number} n - Page number.
     */
    this.deleteLayoutRegion = (region, n) => {
      for (const [key, value] of Object.entries(this.pages[n].boxes)) {
        if (value.id === region.id) {
          delete this.pages[n].boxes[key];
          break;
        }
      }
    };
  }
}

export class LayoutDataTables {
  constructor() {
    /** @type {Array<LayoutDataTablePage>} */
    this.pages = [];

    /** @type {Array<LayoutDataTable>} */
    this.defaultTables = [];

    /**
     * Serialize the layout data tables as JSON.
     * A special function is needed to remove circular references.
     */
    this.serialize = () => {
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
    };

    /**
     *
     * @param {LayoutDataTable} table - Table to delete.
     * @param {number} n - Page number.
     */
    this.deleteLayoutDataTable = (table, n) => {
      const idx = this.pages[n].tables.findIndex((t) => t.id === table.id);
      if (idx >= 0) {
        this.pages[n].tables.splice(idx, 1);
      }
    };
  }
}

/**
 * Class that stores various debug data.
 * Although this object contains useful information, it should not be referenced directly in code,
 * except for debugging features.
 */
export class DebugData {
  /** @type {{[key: string]: Array<Array<CompDebugBrowser|CompDebugNode>> | undefined}} */
  static debugImg = {};
}
