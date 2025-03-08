import { calcBboxUnion, getRandomAlphanum } from '../utils/miscUtils.js';

/**
 * Class representing a layout box.
 */
export class LayoutBoxBase {
  /**
   * Create a layout box.
   * @param {bbox} coords - The coordinates of the layout box.
   */
  constructor(coords) {
    /** @type {string} */
    this.id = getRandomAlphanum(10);
    /** @type {bbox} */
    this.coords = coords;
    /** @type {string} */
    this.inclusionRule = 'majority';
    /** @type {string} */
    this.inclusionLevel = 'word';
  }
}

export class LayoutDataColumn extends LayoutBoxBase {
  /**
   * Create a layout data column.
   * @param {bbox} coords - The coordinates of the layout data column.
   * @param {LayoutDataTable} table - The layout data table to which the column belongs.
   */
  constructor(coords, table) {
    super(coords);
    this.type = 'dataColumn';
    this.table = table;
  }
}

export class LayoutRegion extends LayoutBoxBase {
  /**
   * Create a layout data column.
   * @param {LayoutPage} page
   * @param {number} priority - The priority of the layout data column.
   * @param {bbox} coords - The coordinates of the layout data column.
   * @param {('order'|'exclude')} type - The type of the layout region.
   */
  constructor(page, priority, coords, type) {
    super(coords);
    this.page = page;
    this.type = type;
    this.order = priority;
  }
}

/**
 * @param {number} n - Page number.
 */
export function LayoutPage(n) {
  /** @type {number} */
  this.n = n;
  /** @type {boolean} */
  this.default = true;
  /** @type {Object<string, LayoutRegion>} */
  this.boxes = {};
}

/**
 *
 * @param {LayoutDataTable} table
 */
export const calcTableBbox = (table) => {
  const boxesBboxArr = table.boxes.map((box) => box.coords);
  return calcBboxUnion(boxesBboxArr);
};

/**
 * Class representing a layout data table.
 */
export class LayoutDataTable {
  /**
   * Create a layout data table.
   * @param {LayoutDataTablePage} page - The layout data table page to which the table belongs.
   */
  constructor(page) {
    this.page = page;
    this.id = getRandomAlphanum(10);
    /** @type {Array<LayoutDataColumn>} */
    this.boxes = [];
  }
}

/**
 * @param {number} n - Page number.
 */
export function LayoutDataTablePage(n) {
  /** @type {number} */
  this.n = n;
  /** @type {boolean} */
  this.default = true;
  /** @type {Array<LayoutDataTable>} */
  this.tables = [];
}

/**
 * Serialize the layout data tables as JSON.
 * A special function is needed to remove circular references.
 * @param {Array<LayoutDataTablePage>} pages - Layout data tables.
 */
export const removeCircularRefsDataTables = (pages) => {
  const pagesClone = structuredClone(pages);
  pagesClone.forEach((page) => {
    page.tables.forEach((table) => {
    // @ts-ignore
      delete table.page;
      table.boxes.forEach((box) => {
        // @ts-ignore
        delete box.table;
      });
    });
  });
};

/**
 * Restores circular references to array of OcrPage objects.
 * Used to restore circular references after deserializing.
 * @param {*} pages
 * @returns {Array<OcrPage>}
 */
export const addCircularRefsDataTables = (pages) => {
  pages.forEach((page) => {
    page.tables.forEach((table) => {
      table.page = page;
      table.boxes.forEach((box) => {
        box.table = table;
      });
    });
  });
  return pages;
};

const layout = {
  LayoutDataColumn,
  LayoutDataTable,
  LayoutRegion,
};

export default layout;
