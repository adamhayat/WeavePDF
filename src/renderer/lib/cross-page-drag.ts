const PAGE_MARGIN_PT = 36;
const DEFAULT_RESISTANCE_PX = 18;

export type CrossPageTopLeft = {
  page: number;
  pageWidthPt: number;
  pageHeightPt: number;
  xPt: number;
  topPt: number;
  yPt: number;
};

type PageTarget = {
  page: number;
  rect: DOMRect;
  pageWidthPt: number;
  pageHeightPt: number;
};

type ResolveTopLeftArgs = {
  currentPage: number;
  clientX: number;
  clientY: number;
  zoom: number;
  pointerOffsetXPx: number;
  pointerOffsetYPx: number;
  widthPt: number;
  heightPt: number;
  marginsEnabled: boolean;
  resistancePx?: number;
};

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function pageTargets(zoom: number): PageTarget[] {
  if (zoom <= 0) return [];
  return Array.from(document.querySelectorAll<HTMLElement>("[data-page]"))
    .map((el) => {
      const page = Number(el.dataset.page ?? el.getAttribute("data-page"));
      const rect = el.getBoundingClientRect();
      if (!Number.isFinite(page) || page <= 0 || rect.width <= 0 || rect.height <= 0) {
        return null;
      }
      return {
        page,
        rect,
        pageWidthPt: rect.width / zoom,
        pageHeightPt: rect.height / zoom,
      };
    })
    .filter((target): target is PageTarget => target != null)
    .sort((a, b) => a.page - b.page);
}

function nearestVerticalTarget(targets: PageTarget[], clientY: number): PageTarget | null {
  let best: PageTarget | null = null;
  let bestDistance = Infinity;
  for (const target of targets) {
    const distance =
      clientY < target.rect.top
        ? target.rect.top - clientY
        : clientY > target.rect.bottom
          ? clientY - target.rect.bottom
          : 0;
    if (distance < bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

function resolveTargetForTopLeft({
  currentPage,
  clientY,
  zoom,
  pointerOffsetYPx,
  heightPt,
  resistancePx = DEFAULT_RESISTANCE_PX,
}: ResolveTopLeftArgs): PageTarget | null {
  const targets = pageTargets(zoom);
  if (targets.length === 0) return null;

  const current = targets.find((target) => target.page === currentPage);
  if (!current) return nearestVerticalTarget(targets, clientY);

  const topPx = clientY - pointerOffsetYPx;
  const bottomPx = topPx + heightPt * zoom;
  const previous = [...targets].reverse().find((target) => target.page < current.page);
  const next = targets.find((target) => target.page > current.page);

  if (previous && topPx < current.rect.top - resistancePx) {
    return previous;
  }
  if (next && bottomPx > current.rect.bottom + resistancePx) {
    return next;
  }

  if (bottomPx >= current.rect.top && topPx <= current.rect.bottom) {
    return current;
  }

  return nearestVerticalTarget(targets, clientY);
}

export function resolveCrossPageTopLeft(args: ResolveTopLeftArgs): CrossPageTopLeft | null {
  const target = resolveTargetForTopLeft(args);
  if (!target) return null;

  const marginPt = args.marginsEnabled ? PAGE_MARGIN_PT : 0;
  const rawXPt = (args.clientX - args.pointerOffsetXPx - target.rect.left) / args.zoom;
  const rawTopPt = (args.clientY - args.pointerOffsetYPx - target.rect.top) / args.zoom;
  const resistancePt = (args.resistancePx ?? DEFAULT_RESISTANCE_PX) / args.zoom;
  const rawBottomPt = rawTopPt + args.heightPt;
  let minTopPt = marginPt;
  let maxTopPt = target.pageHeightPt - marginPt - args.heightPt;
  if (target.page === args.currentPage && marginPt > 0) {
    if (rawTopPt < marginPt - resistancePt) minTopPt = 0;
    if (rawBottomPt > target.pageHeightPt - marginPt + resistancePt) {
      maxTopPt = target.pageHeightPt - args.heightPt;
    }
  }
  const xPt = clamp(rawXPt, marginPt, target.pageWidthPt - marginPt - args.widthPt);
  const topPt = clamp(rawTopPt, minTopPt, maxTopPt);

  return {
    page: target.page,
    pageWidthPt: target.pageWidthPt,
    pageHeightPt: target.pageHeightPt,
    xPt,
    topPt,
    yPt: target.pageHeightPt - topPt - args.heightPt,
  };
}
