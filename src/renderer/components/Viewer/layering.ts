import { useMemo } from "react";
import { useDocumentStore } from "../../stores/document";
import { availableLayerMoves, buriedIds, layerRanks } from "../../lib/layers";
import type { MenuItem } from "../ContextMenu/ContextMenu";

/**
 * V1.0125: id → stacking rank (1 = bottom) for every pending element on one
 * page. Each Pending*Layer uses it as the element's CSS z-index inside the
 * page's shared stacking context (PageCanvas wraps the three layers in one
 * `pending-layer-stack` div), so text, images and shapes interleave in the
 * SAME order the bake draws them.
 */
export function usePageLayerRanks(pageNumber: number): Map<string, number> {
  const text = useDocumentStore((s) => s.activeTab()?.pendingTextEdits);
  const image = useDocumentStore((s) => s.activeTab()?.pendingImageEdits);
  const shape = useDocumentStore((s) => s.activeTab()?.pendingShapeEdits);
  return useMemo(
    () => layerRanks({ text: text ?? [], image: image ?? [], shape: shape ?? [] }, pageNumber),
    [text, image, shape, pageNumber],
  );
}

/** V1.0125: ids of elements hidden under a whiteout/redact higher in the
 *  stack — they get pointer-events:none (see lib/layers.ts buriedIds). */
export function usePageBuried(pageNumber: number): Set<string> {
  const text = useDocumentStore((s) => s.activeTab()?.pendingTextEdits);
  const image = useDocumentStore((s) => s.activeTab()?.pendingImageEdits);
  const shape = useDocumentStore((s) => s.activeTab()?.pendingShapeEdits);
  return useMemo(
    () => buriedIds({ text: text ?? [], image: image ?? [], shape: shape ?? [] }, pageNumber),
    [text, image, shape, pageNumber],
  );
}

/** V1.0125: the four Arrange items, for every pending element's right-click
 *  menu. Items that would do nothing (already on top / bottom) are greyed. */
export function arrangeMenuItems(tabId: string, editId: string): MenuItem[] {
  const store = useDocumentStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  const { up, down } = tab
    ? availableLayerMoves(
        { text: tab.pendingTextEdits, image: tab.pendingImageEdits, shape: tab.pendingShapeEdits },
        editId,
      )
    : { up: false, down: false };
  const move = (op: "front" | "forward" | "backward" | "back") => () =>
    useDocumentStore.getState().moveLayer(tabId, editId, op);
  return [
    { kind: "item", label: "Bring to Front", onClick: move("front"), disabled: !up },
    { kind: "item", label: "Bring Forward", onClick: move("forward"), disabled: !up },
    { kind: "item", label: "Send Backward", onClick: move("backward"), disabled: !down },
    { kind: "item", label: "Send to Back", onClick: move("back"), disabled: !down },
  ];
}
