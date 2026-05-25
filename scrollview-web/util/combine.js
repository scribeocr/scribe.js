/**
 * Utility function that combines arrays while maintaining element order.
 * Assumes that element order is the same between all arrays, however some elements appear in only certain arrays.
 * This is useful for creating an ordered listing of visualizations that are created when there are multiple pages,
 * and not all pages and not all pages contain the same visualizations.
 *
 * @param {Array} arr1
 * @param {Array} arr2
 * @returns
 */
export function combineOrderedArrays(arr1, arr2) {
  const combined = [];

  const positions = new Map();
  let i = 0;

  // Add elements from arr1
  arr1.forEach((item) => {
    if (!positions.has(item)) {
      combined.push(item);
      positions.set(item, i++);
    }
  });

  // Iterate through arr2, adjusting positions as necessary
  arr2.forEach((item) => {
    if (!positions.has(item)) {
      // If the item doesn't exist, it's added to the end
      combined.push(item);
      positions.set(item, i++);
    } else {
      // If the item exists but its order relative to the next item in arr2 is incorrect, adjust
      const pos = positions.get(item);
      const nextItemIndex = arr2.indexOf(item) + 1;
      if (nextItemIndex < arr2.length) {
        const nextItem = arr2[nextItemIndex];
        const nextPos = positions.get(nextItem);
        if (nextPos <= pos) {
          // Need to move the item to the correct position
          combined.splice(pos, 1); // Remove item from its current position
          combined.splice(nextPos, 0, item); // Insert item before the nextItem
          // Update positions for all items
          combined.forEach((item, index) => positions.set(item, index));
        }
      }
    }
  });

  return combined;
}
