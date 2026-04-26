import { checkArgument, check } from './types.js';
import { Glyph } from './glyph.js';
import { DefaultEncoding } from './encoding.js';

const fsSelectionValues = {
  ITALIC: 0x001,
  UNDERSCORE: 0x002,
  NEGATIVE: 0x004,
  OUTLINED: 0x008,
  STRIKEOUT: 0x010,
  BOLD: 0x020,
  REGULAR: 0x040,
  USER_TYPO_METRICS: 0x080,
  WWS: 0x100,
  OBLIQUE: 0x200,
};

const usWidthClasses = {
  ULTRA_CONDENSED: 1,
  EXTRA_CONDENSED: 2,
  CONDENSED: 3,
  SEMI_CONDENSED: 4,
  MEDIUM: 5,
  SEMI_EXPANDED: 6,
  EXPANDED: 7,
  EXTRA_EXPANDED: 8,
  ULTRA_EXPANDED: 9,
};

const usWeightClasses = {
  THIN: 100,
  EXTRA_LIGHT: 200,
  LIGHT: 300,
  NORMAL: 400,
  MEDIUM: 500,
  SEMI_BOLD: 600,
  BOLD: 700,
  EXTRA_BOLD: 800,
  BLACK: 900,
};

// --- pure utility functions ---

function searchTag(arr, tag) {
  let imin = 0;
  let imax = arr.length - 1;
  while (imin <= imax) {
    const imid = (imin + imax) >>> 1;
    const val = arr[imid].tag;
    if (val === tag) {
      return imid;
    } if (val < tag) {
      imin = imid + 1;
    } else { imax = imid - 1; }
  }
  return -imin - 1;
}

function binSearch(arr, value) {
  let imin = 0;
  let imax = arr.length - 1;
  while (imin <= imax) {
    const imid = (imin + imax) >>> 1;
    const val = arr[imid];
    if (val === value) {
      return imid;
    } if (val < value) {
      imin = imid + 1;
    } else { imax = imid - 1; }
  }
  return -imin - 1;
}

function searchRange(ranges, value) {
  let range;
  let imin = 0;
  let imax = ranges.length - 1;
  while (imin <= imax) {
    const imid = (imin + imax) >>> 1;
    range = ranges[imid];
    const start = range.start;
    if (start === value) {
      return range;
    } if (start < value) {
      imin = imid + 1;
    } else { imax = imid - 1; }
  }
  if (imin > 0) {
    range = ranges[imin - 1];
    if (value > range.end) return 0;
    return range;
  }
}

function getGlyphClass(classDefTable, glyphIndex) {
  switch (classDefTable.format) {
    case 1:
      if (classDefTable.startGlyph <= glyphIndex && glyphIndex < classDefTable.startGlyph + classDefTable.classes.length) {
        return classDefTable.classes[glyphIndex - classDefTable.startGlyph];
      }
      return 0;
    case 2: {
      const range = searchRange(classDefTable.ranges, glyphIndex);
      return range ? range.classId : 0;
    }
  }
}

function getCoverageIndex(coverageTable, glyphIndex) {
  switch (coverageTable.format) {
    case 1: {
      const index = binSearch(coverageTable.glyphs, glyphIndex);
      return index >= 0 ? index : -1;
    }
    case 2: {
      const range = searchRange(coverageTable.ranges, glyphIndex);
      return range ? range.index + glyphIndex - range.start : -1;
    }
  }
}

function expandCoverage(coverageTable) {
  if (coverageTable.format === 1) {
    return coverageTable.glyphs;
  }
  const glyphs = [];
  const ranges = coverageTable.ranges;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    const start = range.start;
    const end = range.end;
    for (let j = start; j <= end; j++) {
      glyphs.push(j);
    }
  }
  return glyphs;
}

function arraysEqual(ar1, ar2) {
  const n = ar1.length;
  if (n !== ar2.length) { return false; }
  for (let i = 0; i < n; i++) {
    if (ar1[i] !== ar2[i]) { return false; }
  }
  return true;
}

function getSubstFormat(lookupTable, format, defaultSubtable) {
  const subtables = lookupTable.subtables;
  for (let i = 0; i < subtables.length; i++) {
    const subtable = subtables[i];
    if (subtable.substFormat === format) {
      return subtable;
    }
  }
  if (defaultSubtable) {
    subtables.push(defaultSubtable);
    return defaultSubtable;
  }
  return undefined;
}

function defineDependentProperty(glyph, externalName, internalName) {
  Object.defineProperty(glyph, externalName, {
    get() {
      glyph.path; // jshint ignore:line
      return glyph[internalName];
    },
    set(newValue) {
      glyph[internalName] = newValue;
    },
    enumerable: true,
    configurable: true,
  });
}

// --- Layout ---

class Layout {
  constructor(font, tableName) {
    this.font = font;
    this.tableName = tableName;
  }

  getTable(create) {
    let layout = this.font.tables[this.tableName];
    if (!layout && create) {
      layout = this.font.tables[this.tableName] = this.createDefaultTable();
    }
    return layout;
  }

  getScriptNames() {
    const layout = this.getTable();
    if (!layout) { return []; }
    return layout.scripts.map((script) => script.tag);
  }

  getDefaultScriptName() {
    const layout = this.getTable();
    if (!layout) { return; }
    let hasLatn = false;
    for (let i = 0; i < layout.scripts.length; i++) {
      const name = layout.scripts[i].tag;
      if (name === 'DFLT') return name;
      if (name === 'latn') hasLatn = true;
    }
    if (hasLatn) return 'latn';
  }

  getScriptTable(script, create) {
    const layout = this.getTable(create);
    if (layout) {
      script = script || 'DFLT';
      const scripts = layout.scripts;
      const pos = searchTag(layout.scripts, script);
      if (pos >= 0) {
        return scripts[pos].script;
      } if (create) {
        const scr = {
          tag: script,
          script: {
            defaultLangSys: { reserved: 0, reqFeatureIndex: 0xffff, featureIndexes: [] },
            langSysRecords: [],
          },
        };
        scripts.splice(-1 - pos, 0, scr);
        return scr.script;
      }
    }
  }

  getLangSysTable(script, language, create) {
    const scriptTable = this.getScriptTable(script, create);
    if (scriptTable) {
      if (!language || language === 'dflt' || language === 'DFLT') {
        return scriptTable.defaultLangSys;
      }
      const pos = searchTag(scriptTable.langSysRecords, language);
      if (pos >= 0) {
        return scriptTable.langSysRecords[pos].langSys;
      } if (create) {
        const langSysRecord = {
          tag: language,
          langSys: { reserved: 0, reqFeatureIndex: 0xffff, featureIndexes: [] },
        };
        scriptTable.langSysRecords.splice(-1 - pos, 0, langSysRecord);
        return langSysRecord.langSys;
      }
    }
  }

  getFeatureTable(script, language, feature, create) {
    const langSysTable = this.getLangSysTable(script, language, create);
    if (langSysTable) {
      let featureRecord;
      const featIndexes = langSysTable.featureIndexes;
      const allFeatures = this.font.tables[this.tableName].features;
      for (let i = 0; i < featIndexes.length; i++) {
        featureRecord = allFeatures[featIndexes[i]];
        if (featureRecord.tag === feature) {
          return featureRecord.feature;
        }
      }
      if (create) {
        const index = allFeatures.length;
        check.assert(index === 0 || feature >= allFeatures[index - 1].tag, 'Features must be added in alphabetical order.');
        featureRecord = {
          tag: feature,
          feature: { params: 0, lookupListIndexes: [] },
        };
        allFeatures.push(featureRecord);
        featIndexes.push(index);
        return featureRecord.feature;
      }
    }
  }

  getLookupTables(script, language, feature, lookupType, create) {
    const featureTable = this.getFeatureTable(script, language, feature, create);
    const tables = [];
    if (featureTable) {
      let lookupTable;
      const lookupListIndexes = featureTable.lookupListIndexes;
      const allLookups = this.font.tables[this.tableName].lookups;
      for (let i = 0; i < lookupListIndexes.length; i++) {
        lookupTable = allLookups[lookupListIndexes[i]];
        if (lookupTable.lookupType === lookupType) {
          tables.push(lookupTable);
        }
      }
      if (tables.length === 0 && create) {
        lookupTable = {
          lookupType,
          lookupFlag: 0,
          subtables: [],
          markFilteringSet: undefined,
        };
        const index = allLookups.length;
        allLookups.push(lookupTable);
        lookupListIndexes.push(index);
        return [lookupTable];
      }
    }
    return tables;
  }
}

// --- Position ---

class Position extends Layout {
  constructor(font) {
    super(font, 'gpos');
  }

  init() {
    const script = this.getDefaultScriptName();
    this.defaultKerningTables = this.getKerningTables(script);
  }

  getKerningValue(kerningLookups, leftIndex, rightIndex) {
    for (let i = 0; i < kerningLookups.length; i++) {
      const subtables = kerningLookups[i].subtables;
      for (let j = 0; j < subtables.length; j++) {
        const subtable = subtables[j];
        const covIndex = getCoverageIndex(subtable.coverage, leftIndex);
        if (covIndex < 0) continue;
        switch (subtable.posFormat) {
          case 1: {
            const pairSet = subtable.pairSets[covIndex];
            for (let k = 0; k < pairSet.length; k++) {
              const pair = pairSet[k];
              if (pair.secondGlyph === rightIndex) {
                return pair.value1 && pair.value1.xAdvance || 0;
              }
            }
            break;
          }
          case 2: {
            const class1 = getGlyphClass(subtable.classDef1, leftIndex);
            const class2 = getGlyphClass(subtable.classDef2, rightIndex);
            const pair = subtable.classRecords[class1][class2];
            return pair.value1 && pair.value1.xAdvance || 0;
          }
        }
      }
    }
    return 0;
  }

  getKerningTables(script, language) {
    if (this.font.tables.gpos) {
      return this.getLookupTables(script, language, 'kern', 2);
    }
  }
}

// --- Substitution ---

class Substitution extends Layout {
  constructor(font) {
    super(font, 'gsub');
  }

  createDefaultTable() {
    return {
      version: 1,
      scripts: [{
        tag: 'DFLT',
        script: {
          defaultLangSys: { reserved: 0, reqFeatureIndex: 0xffff, featureIndexes: [] },
          langSysRecords: [],
        },
      }],
      features: [],
      lookups: [],
    };
  }

  getSingle(feature, script, language) {
    const substitutions = [];
    const lookupTables = this.getLookupTables(script, language, feature, 1);
    for (let idx = 0; idx < lookupTables.length; idx++) {
      const subtables = lookupTables[idx].subtables;
      for (let i = 0; i < subtables.length; i++) {
        const subtable = subtables[i];
        const glyphs = expandCoverage(subtable.coverage);
        let j;
        if (subtable.substFormat === 1) {
          const delta = subtable.deltaGlyphId;
          for (j = 0; j < glyphs.length; j++) {
            const glyph = glyphs[j];
            substitutions.push({ sub: glyph, by: glyph + delta });
          }
        } else {
          const substitute = subtable.substitute;
          for (j = 0; j < glyphs.length; j++) {
            substitutions.push({ sub: glyphs[j], by: substitute[j] });
          }
        }
      }
    }
    return substitutions;
  }

  getMultiple(feature, script, language) {
    const substitutions = [];
    const lookupTables = this.getLookupTables(script, language, feature, 2);
    for (let idx = 0; idx < lookupTables.length; idx++) {
      const subtables = lookupTables[idx].subtables;
      for (let i = 0; i < subtables.length; i++) {
        const subtable = subtables[i];
        const glyphs = expandCoverage(subtable.coverage);
        for (let j = 0; j < glyphs.length; j++) {
          const glyph = glyphs[j];
          const replacements = subtable.sequences[j];
          substitutions.push({ sub: glyph, by: replacements });
        }
      }
    }
    return substitutions;
  }

  getAlternates(feature, script, language) {
    const alternates = [];
    const lookupTables = this.getLookupTables(script, language, feature, 3);
    for (let idx = 0; idx < lookupTables.length; idx++) {
      const subtables = lookupTables[idx].subtables;
      for (let i = 0; i < subtables.length; i++) {
        const subtable = subtables[i];
        const glyphs = expandCoverage(subtable.coverage);
        const alternateSets = subtable.alternateSets;
        for (let j = 0; j < glyphs.length; j++) {
          alternates.push({ sub: glyphs[j], by: alternateSets[j] });
        }
      }
    }
    return alternates;
  }

  getLigatures(feature, script, language) {
    const ligatures = [];
    const lookupTables = this.getLookupTables(script, language, feature, 4);
    for (let idx = 0; idx < lookupTables.length; idx++) {
      const subtables = lookupTables[idx].subtables;
      for (let i = 0; i < subtables.length; i++) {
        const subtable = subtables[i];
        const glyphs = expandCoverage(subtable.coverage);
        const ligatureSets = subtable.ligatureSets;
        for (let j = 0; j < glyphs.length; j++) {
          const startGlyph = glyphs[j];
          const ligSet = ligatureSets[j];
          for (let k = 0; k < ligSet.length; k++) {
            const lig = ligSet[k];
            ligatures.push({
              sub: [startGlyph].concat(lig.components),
              by: lig.ligGlyph,
            });
          }
        }
      }
    }
    return ligatures;
  }

  addSingle(feature, substitution, script, language) {
    const lookupTable = this.getLookupTables(script, language, feature, 1, true)[0];
    const subtable = getSubstFormat(lookupTable, 2, {
      substFormat: 2,
      coverage: { format: 1, glyphs: [] },
      substitute: [],
    });
    check.assert(subtable.coverage.format === 1, `Single: unable to modify coverage table format ${subtable.coverage.format}`);
    const coverageGlyph = substitution.sub;
    let pos = binSearch(subtable.coverage.glyphs, coverageGlyph);
    if (pos < 0) {
      pos = -1 - pos;
      subtable.coverage.glyphs.splice(pos, 0, coverageGlyph);
      subtable.substitute.splice(pos, 0, 0);
    }
    subtable.substitute[pos] = substitution.by;
  }

  addMultiple(feature, substitution, script, language) {
    check.assert(substitution.by instanceof Array && substitution.by.length > 1, 'Multiple: "by" must be an array of two or more ids');
    const lookupTable = this.getLookupTables(script, language, feature, 2, true)[0];
    const subtable = getSubstFormat(lookupTable, 1, {
      substFormat: 1,
      coverage: { format: 1, glyphs: [] },
      sequences: [],
    });
    check.assert(subtable.coverage.format === 1, `Multiple: unable to modify coverage table format ${subtable.coverage.format}`);
    const coverageGlyph = substitution.sub;
    let pos = binSearch(subtable.coverage.glyphs, coverageGlyph);
    if (pos < 0) {
      pos = -1 - pos;
      subtable.coverage.glyphs.splice(pos, 0, coverageGlyph);
      subtable.sequences.splice(pos, 0, 0);
    }
    subtable.sequences[pos] = substitution.by;
  }

  addAlternate(feature, substitution, script, language) {
    const lookupTable = this.getLookupTables(script, language, feature, 3, true)[0];
    const subtable = getSubstFormat(lookupTable, 1, {
      substFormat: 1,
      coverage: { format: 1, glyphs: [] },
      alternateSets: [],
    });
    check.assert(subtable.coverage.format === 1, `Alternate: unable to modify coverage table format ${subtable.coverage.format}`);
    const coverageGlyph = substitution.sub;
    let pos = binSearch(subtable.coverage.glyphs, coverageGlyph);
    if (pos < 0) {
      pos = -1 - pos;
      subtable.coverage.glyphs.splice(pos, 0, coverageGlyph);
      subtable.alternateSets.splice(pos, 0, 0);
    }
    subtable.alternateSets[pos] = substitution.by;
  }

  addLigature(feature, ligature, script, language) {
    const lookupTable = this.getLookupTables(script, language, feature, 4, true)[0];
    let subtable = lookupTable.subtables[0];
    if (!subtable) {
      subtable = {
        substFormat: 1,
        coverage: { format: 1, glyphs: [] },
        ligatureSets: [],
      };
      lookupTable.subtables[0] = subtable;
    }
    check.assert(subtable.coverage.format === 1, `Ligature: unable to modify coverage table format ${subtable.coverage.format}`);
    const coverageGlyph = ligature.sub[0];
    const ligComponents = ligature.sub.slice(1);
    const ligatureTable = {
      ligGlyph: ligature.by,
      components: ligComponents,
    };
    let pos = binSearch(subtable.coverage.glyphs, coverageGlyph);
    if (pos >= 0) {
      const ligatureSet = subtable.ligatureSets[pos];
      for (let i = 0; i < ligatureSet.length; i++) {
        if (arraysEqual(ligatureSet[i].components, ligComponents)) {
          return;
        }
      }
      ligatureSet.push(ligatureTable);
    } else {
      pos = -1 - pos;
      subtable.coverage.glyphs.splice(pos, 0, coverageGlyph);
      subtable.ligatureSets.splice(pos, 0, [ligatureTable]);
    }
  }

  add(feature, sub, script, language) {
    if (/ss\d\d/.test(feature)) {
      return this.addSingle(feature, sub, script, language);
    }
    switch (feature) {
      case 'aalt':
      case 'salt':
        if (typeof sub.by === 'number') {
          return this.addSingle(feature, sub, script, language);
        }
        return this.addAlternate(feature, sub, script, language);
      case 'dlig':
      case 'liga':
      case 'rlig':
        return this.addLigature(feature, sub, script, language);
      case 'ccmp':
        if (sub.by instanceof Array) {
          return this.addMultiple(feature, sub, script, language);
        }
        return this.addLigature(feature, sub, script, language);
    }
    return undefined;
  }
}

// --- GlyphSet ---

class GlyphSet {
  constructor(font, glyphs) {
    this.font = font;
    this.glyphs = {};
    if (Array.isArray(glyphs)) {
      for (let i = 0; i < glyphs.length; i++) {
        const glyph = glyphs[i];
        glyph.path.unitsPerEm = font.unitsPerEm;
        this.glyphs[i] = glyph;
      }
    }

    this.length = (glyphs && glyphs.length) || 0;
  }

  get(index) {
    if (typeof this.glyphs[index] === 'function') {
      this.glyphs[index] = this.glyphs[index]();
    }

    return this.glyphs[index];
  }

  push(index, loader) {
    this.glyphs[index] = loader;
    this.length++;
  }
}

function ttfGlyphLoader(font, index, parseGlyph, data, position, buildPath) {
  return function () {
    const glyph = new Glyph({ index, font });

    glyph.path = function () {
      parseGlyph(glyph, data, position);
      const path = buildPath(font.glyphs, glyph);
      path.unitsPerEm = font.unitsPerEm;
      return path;
    };

    return glyph;
  };
}

function cffGlyphLoader(font, index, parseCFFCharstring, charstring) {
  return function () {
    const glyph = new Glyph({ index, font });

    glyph.path = function () {
      const path = parseCFFCharstring(font, glyph, charstring);
      path.unitsPerEm = font.unitsPerEm;
      return path;
    };

    return glyph;
  };
}

// --- Font ---

class Font {
  constructor(options) {
    options = options || {};
    options.tables = options.tables || {};

    if (!options.empty) {
      checkArgument(options.familyName, 'When creating a new Font object, familyName is required.');
      checkArgument(options.styleName, 'When creating a new Font object, styleName is required.');
      checkArgument(options.unitsPerEm, 'When creating a new Font object, unitsPerEm is required.');
      checkArgument(options.ascender, 'When creating a new Font object, ascender is required.');
      checkArgument(options.descender <= 0, 'When creating a new Font object, negative descender value is required.');

      this.names = {
        fontFamily: { en: options.familyName || ' ' },
        fontSubfamily: { en: options.styleName || ' ' },
        fullName: { en: options.fullName || `${options.familyName} ${options.styleName}` },
        postScriptName: { en: options.postScriptName || (options.familyName + options.styleName).replace(/\s/g, '') },
        designer: { en: options.designer || ' ' },
        designerURL: { en: options.designerURL || ' ' },
        manufacturer: { en: options.manufacturer || ' ' },
        manufacturerURL: { en: options.manufacturerURL || ' ' },
        license: { en: options.license || ' ' },
        licenseURL: { en: options.licenseURL || ' ' },
        version: { en: options.version || 'Version 0.1' },
        description: { en: options.description || ' ' },
        copyright: { en: options.copyright || ' ' },
        trademark: { en: options.trademark || ' ' },
      };
      this.unitsPerEm = options.unitsPerEm || 1000;
      this.ascender = options.ascender;
      this.descender = options.descender;
      this.createdTimestamp = options.createdTimestamp;
      this.tables = Object.assign(options.tables, {
        os2: {
          usWeightClass: options.weightClass || usWeightClasses.MEDIUM,
          usWidthClass: options.widthClass || usWidthClasses.MEDIUM,
          fsSelection: options.fsSelection || fsSelectionValues.REGULAR,
          ...options.tables.os2,
        },
      });
    }

    this.supported = true;
    this.glyphs = new GlyphSet(this, options.glyphs || []);
    this.encoding = new DefaultEncoding(this);
    this.position = new Position(this);
    this.substitution = new Substitution(this);
    this.tables = this.tables || {};
    this.outlinesFormat = undefined;
    this.numGlyphs = undefined;
    this.numberOfHMetrics = undefined;
    this.kerningPairs = {};
    this.glyphNames = undefined;

    // CFF-specific properties, set during CFF parsing.
    /** @type {import('./encoding.js').CffEncoding|undefined} */
    this.cffEncoding = undefined;
    /** @type {boolean|undefined} */
    this.isCIDFont = undefined;
  }

  hasChar(c) {
    return this.encoding.charToGlyphIndex(c) !== null;
  }

  charToGlyphIndex(s) {
    return this.encoding.charToGlyphIndex(s);
  }

  charToGlyph(c) {
    const glyphIndex = this.charToGlyphIndex(c);
    let glyph = this.glyphs.get(glyphIndex);
    if (!glyph) {
      glyph = this.glyphs.get(0);
    }

    return glyph;
  }

  nameToGlyphIndex(name) {
    return this.glyphNames.names.indexOf(name);
  }

  nameToGlyph(name) {
    const glyphIndex = this.nameToGlyphIndex(name);
    let glyph = this.glyphs.get(glyphIndex);
    if (!glyph) {
      glyph = this.glyphs.get(0);
    }

    return glyph;
  }

  glyphIndexToName(gid) {
    if (!this.glyphNames.names) {
      return '';
    }

    return this.glyphNames.names[gid];
  }

  getKerningValue(leftGlyph, rightGlyph) {
    leftGlyph = leftGlyph.index || leftGlyph;
    rightGlyph = rightGlyph.index || rightGlyph;
    const gposKerning = this.position.defaultKerningTables;
    if (gposKerning) {
      return this.position.getKerningValue(gposKerning, leftGlyph, rightGlyph);
    } if (this.kerningPairs) {
      return this.kerningPairs[`${leftGlyph},${rightGlyph}`] || 0;
    }

    return 0;
  }

  getEnglishName(name) {
    const translations = this.names[name];
    if (translations) {
      return translations.en;
    }
  }

  validate() {
    const warnings = [];
    const _this = this;

    function assert(predicate, message) {
      if (!predicate) {
        warnings.push(message);
      }
    }

    function assertNamePresent(name) {
      const englishName = _this.getEnglishName(name);
      assert(englishName && englishName.trim().length > 0,
        `No English ${name} specified.`);
    }

    assertNamePresent('fontFamily');
    assertNamePresent('weightName');
    assertNamePresent('manufacturer');
    assertNamePresent('copyright');
    assertNamePresent('version');

    assert(this.unitsPerEm > 0, 'No unitsPerEm specified.');
  }

  /** @returns {*} */
  toTables() { return null; }

  /** @returns {ArrayBuffer} */
  toArrayBuffer() { return this.toTables().buffer; }
}

export {
  Font, GlyphSet, ttfGlyphLoader, cffGlyphLoader, Layout, getGlyphClass, getCoverageIndex,
};
