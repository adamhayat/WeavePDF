/**
 * V1.0126: where each old page's editable elements go after a page-ORDER
 * operation (pass to `applyEdit(..., { remapPages })`). Pages are 1-based.
 *
 * WeavePDF's editable elements (text boxes, images, shapes) are stored by page
 * NUMBER, apart from the page bytes. Before V1.0126 no page operation told
 * them anything moved: delete page 1 and page 2's elements sat on page 3's
 * content. Since V1.0126 elements stay editable after save/reopen, so this
 * matters for every saved file, not just unsaved work.
 */

export type PageRemap = (oldPage: number) => number[];

/** deletePages: elements on a deleted page go; later pages shift up. */
export function remapForDelete(deleted: number[]): PageRemap {
  const gone = new Set(deleted);
  return (p) => (gone.has(p) ? [] : [p - deleted.filter((d) => d < p).length]);
}

/** reorderPages: `order[newIndex] = oldIndex` (both 0-based). */
export function remapForOrder(order: number[]): PageRemap {
  return (p) => {
    const i = order.indexOf(p - 1);
    return i < 0 ? [] : [i + 1];
  };
}

/** insertBlankPageAfter / drop-to-merge: `count` pages land after page
 *  `after`; later pages shift down by `count`. */
export function remapForInsertAfter(after: number, count = 1): PageRemap {
  return (p) => (p <= after ? [p] : [p + count]);
}

/** duplicatePage(page): the copy lands right after it, WITH its elements. */
export function remapForDuplicate(page: number): PageRemap {
  return (p) => (p < page ? [p] : p === page ? [p, p + 1] : [p + 1]);
}
