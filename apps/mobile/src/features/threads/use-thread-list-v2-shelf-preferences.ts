import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/**
 * Shared persisted shelf state for the compact Home list and iPad sidebar.
 * Refs advance before persistence starts so consecutive presses always toggle
 * the latest value, even if React has not rendered the optimistic patch yet.
 */
const EMPTY_WORKER_GROUPS: readonly string[] = [];

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const snoozedShelfExpandedRef = useRef(snoozedShelfExpanded);
  const settledShelfExpandedRef = useRef(settledShelfExpanded);
  snoozedShelfExpandedRef.current = snoozedShelfExpanded;
  settledShelfExpandedRef.current = settledShelfExpanded;
  const expandedWorkerGroupList = loaded
    ? (preferencesResult.value.threadListExpandedWorkerGroups ?? EMPTY_WORKER_GROUPS)
    : EMPTY_WORKER_GROUPS;
  const expandedWorkerGroups = useMemo(
    () => new Set(expandedWorkerGroupList),
    [expandedWorkerGroupList],
  );
  const expandedWorkerGroupListRef = useRef(expandedWorkerGroupList);
  useEffect(() => {
    expandedWorkerGroupListRef.current = expandedWorkerGroupList;
  }, [expandedWorkerGroupList]);

  const toggleSnoozedShelf = useCallback(() => {
    if (!loaded) return;
    const expanded = !snoozedShelfExpandedRef.current;
    snoozedShelfExpandedRef.current = expanded;
    savePreferences({ threadListSnoozedShelfExpanded: expanded });
  }, [loaded, savePreferences]);
  const toggleSettledShelf = useCallback(() => {
    if (!loaded) return;
    const expanded = !settledShelfExpandedRef.current;
    settledShelfExpandedRef.current = expanded;
    savePreferences({ threadListSettledShelfExpanded: expanded });
  }, [loaded, savePreferences]);

  // `liveCoordinatorKeys` prunes keys of coordinators that no longer have
  // workers, so the stored list cannot grow without bound.
  const toggleWorkerGroup = useCallback(
    (coordinatorKey: string, liveCoordinatorKeys: ReadonlySet<string>) => {
      if (!loaded) return;
      const current = expandedWorkerGroupListRef.current;
      const kept = current.filter((key) => key !== coordinatorKey && liveCoordinatorKeys.has(key));
      const next = current.includes(coordinatorKey) ? kept : [...kept, coordinatorKey];
      expandedWorkerGroupListRef.current = next;
      savePreferences({ threadListExpandedWorkerGroups: next });
    },
    [loaded, savePreferences],
  );

  return {
    loaded,
    expandedWorkerGroups,
    settledShelfExpanded,
    snoozedShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkerGroup,
  } as const;
}
