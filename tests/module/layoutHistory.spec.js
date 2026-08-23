// History coverage for layout mutations: the DocHistory snapshotLayout and recordLayout pair, the recorded doc-level table delete, and the `default` flip at record time.
// It also covers exact-state restoration across repeated undo and redo cycles.
// Every test restores the document to its pristine state, so all of the conditions share one import.
import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

/** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
let doc;

describe('Layout-table history', () => {
  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/border_patrol_tables.pdf`]);
  });

  afterAll(async () => {
    await doc.close();
    await scribe.terminate();
  });

  test('a recorded geometry edit restores the exact coordinate on undo and re-applies on redo', () => {
    const table = doc.layoutDataTables.pages[0].tables[0];
    expect(table, 'the fixture page carries a table for these history tests to edit').toBeTruthy();
    expect(doc.layoutDataTables.pages[0].default, 'an untouched page keeps its default flag').toBe(true);
    // The starting coordinate is read rather than hard-coded, because what detection produces for this document is pinned in extractTables.spec.js.
    // These tests own one question only: whether an edit to that coordinate survives undo and redo intact.
    const original = table.boxes[0].coords.right;
    const edited = original + 50;

    const snap = doc.docHistory.snapshotLayout(doc, [0]);
    table.boxes[0].coords.right = edited;
    doc.docHistory.recordLayout(snap, 'Resized table column');

    const top = doc.docHistory.undoStack[doc.docHistory.undoStack.length - 1];
    expect(top.surface, 'the entry lands on the layout surface').toBe('layout');
    expect(top.label, 'the entry carries the edit\'s label').toBe('Resized table column');
    expect(doc.layoutDataTables.pages[0].default, 'a recorded edit flips the page\'s default flag').toBe(false);

    doc.undo();
    expect(doc.layoutDataTables.pages[0].tables[0].boxes[0].coords.right, 'undo restores the exact original coordinate').toBe(original);
    expect(doc.layoutDataTables.pages[0].default, 'undoing the only edit restores the default flag').toBe(true);

    doc.redo();
    expect(doc.layoutDataTables.pages[0].tables[0].boxes[0].coords.right, 'redo re-applies the exact edited coordinate').toBe(edited);
    expect(doc.layoutDataTables.pages[0].default, 'redo re-flips the default flag').toBe(false);

    doc.undo();
    expect(doc.layoutDataTables.pages[0].tables[0].boxes[0].coords.right, 'a second undo cycle still restores the exact original coordinate').toBe(original);
    expect(doc.layoutDataTables.pages[0].default, 'a second undo cycle still restores the default flag').toBe(true);
    doc.docHistory.redoStack.length = 0;
  });

  test('an unchanged snapshot records nothing', () => {
    const depth = doc.docHistory.undoStack.length;
    const snap = doc.docHistory.snapshotLayout(doc, [0]);
    doc.docHistory.recordLayout(snap, 'No-op');
    expect(doc.docHistory.undoStack.length, 'recording an unchanged snapshot adds no history entry').toBe(depth);
    expect(doc.layoutDataTables.pages[0].default, 'an unchanged snapshot leaves the default flag alone').toBe(true);
  });

  test('deleteLayoutDataTable records one layout entry and undo restores the table exactly', () => {
    const page = doc.layoutDataTables.pages[0];
    const original = page.tables[0];
    const originalId = original.id;
    const originalBoxIds = original.boxes.map((b) => b.id);
    const countBefore = page.tables.length;
    const depth = doc.docHistory.undoStack.length;

    doc.deleteLayoutDataTable(original);
    expect(page.tables.length, 'the delete removes exactly one table from the page').toBe(countBefore - 1);
    expect(doc.docHistory.undoStack.length, 'the delete records exactly one history entry').toBe(depth + 1);
    expect(doc.docHistory.undoStack[depth].label, 'the entry is labeled as a table deletion').toBe('Deleted table');
    expect(page.default, 'the delete flips the page\'s default flag').toBe(false);

    doc.undo();
    expect(page.tables.length, 'undo restores the deleted table').toBe(countBefore);
    expect(page.tables[0].id, 'the restored table keeps its id').toBe(originalId);
    expect(page.tables[0].boxes.map((b) => b.id), 'the restored table keeps every column id').toEqual(originalBoxIds);
    expect(page.tables[0].page, 'the restored table points back at the live page wrapper').toBe(page);
    expect(page.tables[0].boxes[0].table, 'the restored column points back at the restored table').toBe(page.tables[0]);
    expect(page.default, 'undoing the delete restores the default flag').toBe(true);

    doc.redo();
    expect(page.tables.length, 'redo re-deletes the table').toBe(countBefore - 1);
    doc.undo();
    expect(page.tables[0].boxes.length, 'a second undo cycle restores every column of the table').toBe(originalBoxIds.length);
    doc.docHistory.redoStack.length = 0;
  });
});
