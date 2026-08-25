import { calcBboxUnion, calcBoxOverlap, getRandomAlphanum } from '../utils/miscUtils.js';

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
 * A page rectangle that exports draw as an image.
 */
export class LayoutImageRegion extends LayoutBoxBase {
  /**
   * Create a layout image region.
   * @param {LayoutPage} page
   * @param {bbox} coords - The coordinates of the layout image region.
   */
  constructor(page, coords) {
    super(coords);
    this.page = page;
    this.type = 'image';
    /** @type {boolean} Whether the text under this region is dropped from exported text. */
    this.excludeText = true;
    /** @type {number} Rotation in degrees applied when the region is drawn. */
    this.rotation = 0;
    /**
     * Where the region's pixels come from.
     * `null` means the exporter crops the page raster at `coords`.
     * Other values are reserved for producers that supply pixels another way.
     * @type {?{kind: string}}
     */
    this.source = null;
  }
}

/**
 * Whether a layout box includes the item with the given bounding box, per the box's inclusion rule.
 * Item bounding boxes must be in the same frame as the box coordinates (the deskew-adjusted page).
 * @param {bbox} itemBbox - Bounding box of the word or line tested for membership.
 * @param {LayoutBoxBase} box
 * @param {string} [rule] - Overrides the box's own `inclusionRule`.
 */
export const layoutBoxIncludes = (itemBbox, box, rule = undefined) => {
  const ruleFinal = rule ?? box.inclusionRule ?? 'majority';
  const testBox = ruleFinal === 'left'
    ? {
      left: itemBbox.left, top: itemBbox.top, right: itemBbox.left + 1, bottom: itemBbox.bottom,
    } : itemBbox;
  return calcBoxOverlap(testBox, box.coords) > 0.5;
};

/**
 * @param {number} n - Page number.
 */
export function LayoutPage(n) {
  /** @type {number} */
  this.n = n;
  /** @type {boolean} */
  this.default = true;
  /** @type {Object<string, LayoutRegion|LayoutImageRegion>} */
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
    /** @type {?Array<number>} Bottom y-coordinate of each row. Rows will be detected automatically if not set. */
    this.rowBounds = null;
    /** @type {'text' | 'grid-strong' | 'segmented-hline' | 'header-rule' | 'row-band' | 'textract' | 'azure_doc_intel' | 'abbyy'} */
    this.detectionMethod = 'text';
    /** @type {{ text: string, bbox: {left: number, top: number, right: number, bottom: number} } | null} */
    this.title = null;
    /**
     * Whether this table continues the immediately preceding table in document order, pages ascending and top to bottom within a page.
     * The fragments of one logical table split across a page break form a chain of these links.
     * @type {boolean}
     */
    this.continuesPrev = false;
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
 * Copy the layout region pages with each region's `page` back-reference removed, so the result can be JSON-serialized.
 * @param {Array<LayoutPage>} pages - Layout region pages.
 */
export const removeCircularRefsRegions = (pages) => {
  const pagesClone = structuredClone(pages);
  pagesClone.forEach((page) => {
    Object.values(page.boxes).forEach((box) => {
      // @ts-ignore
      delete box.page;
    });
  });
  return pagesClone;
};

/**
 * Restores circular references to an array of deserialized layout region pages.
 * @param {*} pages
 * @returns {Array<LayoutPage>}
 */
export const addCircularRefsRegions = (pages) => {
  pages.forEach((page) => {
    if (!page?.boxes) return;
    Object.values(page.boxes).forEach((box) => {
      box.page = page;
    });
  });
  return pages;
};

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
  return pagesClone;
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
  LayoutImageRegion,
  LayoutRegion,
  removeCircularRefsDataTables,
  addCircularRefsDataTables,
  removeCircularRefsRegions,
  addCircularRefsRegions,
  calcTableBbox,
};

export default layout;
