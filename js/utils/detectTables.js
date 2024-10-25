/**
 *
 * @param {Array<bbox>} boundingBoxes
 */
export function calcColumnBounds(boundingBoxes) {
  const tolerance = 5; // Adjust as needed

  /** @type {Array<{left: number, right: number}>} */
  const columnBounds = [];

  // Sort bounding boxes by their left edge
  boundingBoxes.sort((a, b) => a.left - b.left);

  boundingBoxes.forEach((box) => {
    let addedToColumn = false;

    for (const column of columnBounds) {
      // Check if the bounding box overlaps horizontally with the column
      if (
        box.left <= column.right + tolerance
              && box.right >= column.left - tolerance
      ) {
        // Update column bounds
        column.left = Math.min(column.left, box.left);
        column.right = Math.max(column.right, box.right);
        addedToColumn = true;
        break;
      }
    }

    // If not added to any existing column, create a new column
    if (!addedToColumn) {
      columnBounds.push({
        left: box.left,
        right: box.right,
      });
    }
  });

  return columnBounds;
}
