import { useEffect } from "react";
import { useUIStore } from "../stores/ui";

// Subscribes to the Electron main process's nativeTheme broadcasts
// and applies `data-theme` on the root element.
export function useTheme(): void {
  const setTheme = useUIStore((s) => s.setTheme);

  useEffect(() => {
    let unsub: (() => void) | null = null;

    void window.weavepdf.getTheme().then(setTheme);
    unsub = window.weavepdf.onThemeUpdated(setTheme);

    return () => {
      unsub?.();
    };
  }, [setTheme]);
}
